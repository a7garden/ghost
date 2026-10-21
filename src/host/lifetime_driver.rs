//! Explicit per-Ghost transports. Ledger state is committed before I/O.
use super::{lifetime, lifetime_runtime::PiProcess, Host};
use crate::lifetime_contract::{canonical_digest, Envelope, Response, ResponseStatus, VERSION};
use anyhow::{anyhow, bail, Context, Result};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::PathBuf, sync::{Arc, Weak}, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

enum Delivery<'a> { Pi, Worker(&'a std::path::Path, Envelope) }
pub(crate) fn start(host: &Arc<Host>) -> Result<()> {
    let Some(entry) = std::env::var_os("GHOST_LIFETIME_PI_ENTRY") else { return Ok(()); };
    let entry = PathBuf::from(entry).canonicalize()?;
    let mode = std::env::var("GHOST_LIFETIME_MODE").context("GHOST_LIFETIME_MODE must explicitly select fixture or broker")?;
    anyhow::ensure!(matches!(mode.as_str(), "fixture" | "broker"), "invalid lifetime runtime mode");
    let weak = Arc::downgrade(host);
    let root = host.root.join("durable");
    host.spawn(async move { run(weak, entry, root, mode).await; });
    Ok(())
}

async fn run(weak: Weak<Host>, entry: PathBuf, root: PathBuf, mode: String) {
    let mut pi: Option<PiProcess> = None;
    let mut suspended = HashSet::new();
    let mut recovered_pi = false;
    loop {
        let Some(host) = weak.upgrade() else { break; };
        if host.stopping.load(std::sync::atomic::Ordering::Acquire) { break; }
        let authority_epoch = match host.lock().and_then(|state| lifetime::authority::current(&state.journal.0)) {
            Ok(authority) if authority.dispatch_enabled && authority.epoch == host.authority_epoch => authority.epoch,
            Ok(_) => break,
            Err(error) => { eprintln!("lifetime authority unavailable: {error}"); break; }
        };
        let exited = match pi.as_mut() {
            Some(process) => process.has_exited(),
            None => Ok(false),
        };
        match exited {
            Ok(true) => {
                if let Some(process) = pi.take() { let _ = process.close().await; }
                recovered_pi = false;
            }
            Ok(false) => {}
            Err(error) => { eprintln!("Pi child status unavailable: {error}"); break; }
        }
        if let Err(error) = expire_graphs(&host, authority_epoch) {
            eprintln!("lifetime graph maintenance unavailable: {error}");
            break;
        }
        let pending = match host.lock().and_then(|state| lifetime::pending_outbox(&state.journal.0)) {
            Ok(items) => items,
            Err(error) => { eprintln!("lifetime outbox unavailable: {error}"); break; }
        };
        if !recovered_pi {
            let bindings = runnable_bindings(&host);
            match bindings {
                Ok(bindings) => {
                    if !bindings.is_empty() || pending.iter().any(|item| item.target == "pi") {
                        recovered_pi = true;
                        match PiProcess::start(&entry, &root, &host.root, &mode, &host.pi_callback_token, authority_epoch, host.pi_local_route.as_ref()).await {
                            Ok(mut process) => {
                                let mut confirmed_channel = true;
                                for (ghost_id, conversation_id) in bindings {
                                    // Historical receiver ACKs predate canonical report projection.
                                    // Reuse their exact envelopes; Pi imports the original SDK SID
                                    // without admitting replacement inference or changing the ACK.
                                    match unprojected_reports(&host, &ghost_id, &conversation_id) {
                                        Ok(reports) => {
                                            for command in reports {
                                                match delivery_route(&host, &command, "pi", &mode) {
                                                    Ok(Some(_)) => {}
                                                    Ok(None) => continue,
                                                    Err(error) => {
                                                        eprintln!("Pi report recovery scope unavailable: {error}");
                                                        continue;
                                                    }
                                                }
                                                if bounded_pi_request(&mut process, &command).await.is_err() {
                                                    eprintln!("Pi report recovery channel became unconfirmed");
                                                    confirmed_channel = false;
                                                    break;
                                                }
                                            }
                                        }
                                        Err(error) => {
                                            eprintln!("Pi report recovery sources unavailable: {error}");
                                            confirmed_channel = false;
                                        }
                                    }
                                    if !confirmed_channel { break; }
                                    let body = json!({"method":"runtime.reconcile","ghost_id":ghost_id,"conversation_id":conversation_id});
                                    match internal_envelope("host-recovery", authority_epoch, body) {
                                        Ok(command) => if bounded_pi_request(&mut process, &command).await.is_err() {
                                            eprintln!("Pi recovery channel became unconfirmed");
                                            confirmed_channel = false;
                                            break;
                                        },
                                        Err(error) => eprintln!("Pi recovery scope unavailable: {error}"),
                                    }
                                }
                                if confirmed_channel { pi = Some(process); }
                                else { let _ = process.close().await; }
                            }
                            Err(error) => eprintln!("Pi startup unavailable: {error}"),
                        }
                    }
                }
                Err(error) => eprintln!("Pi recovery bindings unavailable: {error}"),
            }
        }
        for item in pending {
            if suspended.contains(&item.id) { continue; }
            let command = match outbox_envelope(item.payload) {
                Ok(command) => command,
                Err(error) => {
                    eprintln!("lifetime intent {} has an invalid contract: {error}", item.id);
                    suspended.insert(item.id);
                    continue;
                }
            };
            let delivery = match delivery_route(&host, &command, &item.target, &mode) {
                Ok(Some(delivery)) => delivery,
                Ok(None) => {
                    block_delivery(&host, &command, "Dispatch blocked by current graph scope or disclosure policy; no new worker/model dispatch");
                    suspended.insert(item.id);
                    continue;
                }
                Err(error) => {
                    block_delivery(&host, &command, "Delivery scope is unresolved; explicit reconciliation required");
                    eprintln!("lifetime delivery scope unavailable: {error}");
                    suspended.insert(item.id);
                    continue;
                }
            };
            let result = match delivery {
                Delivery::Pi => match pi.as_mut() {
                    Some(process) => bounded_pi_request(process, &command).await,
                    None => Err(anyhow!("Pi runtime unavailable; committed intent remains pending")),
                },
                Delivery::Worker(socket, command) => bounded_worker_request(socket, &command).await,
            };
            match result {
                Ok(response) if response.status == ResponseStatus::Success => {
                    let committed = serde_json::to_value(response).map_err(Into::into)
                        .and_then(|receipt| host.lock().and_then(|state| lifetime::ack_outbox(&state.journal.0, item.id, &receipt)));
                    if let Err(error) = committed {
                        block_delivery(&host, &command, "Receiver ACK commit is unconfirmed; reconcile the same command ID");
                        eprintln!("lifetime receiver receipt commit failed: {error}");
                        suspended.insert(item.id);
                    }
                }
                Ok(response) => {
                    block_delivery(&host, &command, response.error_code.as_deref().unwrap_or("Receiver has not durably accepted the command"));
                    suspended.insert(item.id);
                }
                Err(error) => {
                    block_delivery(&host, &command, "Delivery unconfirmed; reconcile the original command and execution IDs");
                    eprintln!("lifetime delivery unconfirmed: {error}");
                    suspended.insert(item.id);
                    if item.target == "pi" {
                        if let Some(process) = pi.take() { let _ = process.close().await; }
                        recovered_pi = false;
                    }
                }
            }
        }
        if let Some(process) = pi.as_mut() {
            if let Err(error) = observe_pi_submissions(&host, process, authority_epoch).await {
                eprintln!("Pi committed submission observation unavailable: {error}");
                if let Some(process) = pi.take() { let _ = process.close().await; }
                recovered_pi = false;
            }
        }
        if let Err(error) = observe_workers(&host, authority_epoch).await {
            eprintln!("worker observation unavailable: {error}");
        }
        drop(host);
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if let Some(process) = pi { if let Err(error) = process.close().await { eprintln!("Pi close unconfirmed: {error}"); } }
}

fn runnable_bindings(host: &Host) -> Result<Vec<(String, String)>> {
    let state = host.lock()?;
    let mut query = state.journal.0.prepare(
        "SELECT b.ghost_id,b.conversation_id FROM lifetime_bindings b
         WHERE b.runtime_kind='pi-durable'
         AND (?1 OR NOT (
           EXISTS(SELECT 1 FROM lifetime_goals g WHERE g.reply_conversation=b.conversation_id AND g.privacy<>'public')
           OR EXISTS(SELECT 1 FROM lifetime_turns t WHERE t.ghost_id=b.ghost_id AND t.conversation_id=b.conversation_id AND t.privacy<>'public')
           OR EXISTS(SELECT 1 FROM lifetime_conversation_disclosure d WHERE d.ghost_id=b.ghost_id AND d.conversation_id=b.conversation_id AND d.privacy<>'public')))
         AND EXISTS(SELECT 1 FROM lifetime_outbox o WHERE o.target='pi'
           AND json_extract(o.payload,'$.body.ghost_id')=b.ghost_id
           AND json_extract(o.payload,'$.body.conversation_id')=b.conversation_id
           AND json_extract(o.payload,'$.authority_epoch')=(SELECT authority_epoch FROM lifetime_authority WHERE singleton=1))"
    )?;
    let rows = query.query_map([host.pi_local_route.is_some()], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect::<std::result::Result<_, _>>().map_err(Into::into)
}
fn unprojected_reports(host: &Host, ghost_id: &str, conversation_id: &str) -> Result<Vec<Envelope>> {
    let state = host.lock()?;
    let mut query = state.journal.0.prepare(
        "SELECT o.payload FROM lifetime_outbox o
         JOIN lifetime_goals g ON g.id=json_extract(o.payload,'$.body.goal_id')
         JOIN lifetime_turn_goals t ON t.goal_id=g.id
         LEFT JOIN lifetime_report_replies r ON r.outbox_id=o.id
         WHERE o.target='pi' AND o.acknowledged=1 AND r.report_id IS NULL
         AND json_extract(o.payload,'$.body.method')='conversation.submit'
         AND json_extract(o.payload,'$.body.ghost_id')=?1
         AND json_extract(o.payload,'$.body.conversation_id')=?2
         AND g.accountable_ghost=?1 AND g.reply_conversation=?2
         AND json_extract(o.payload,'$.body.goal_revision')=g.revision
         AND json_extract(o.payload,'$.authority_epoch')=(SELECT authority_epoch FROM lifetime_authority WHERE singleton=1)
         ORDER BY o.id"
    )?;
    let rows = query.query_map(rusqlite::params![ghost_id, conversation_id], |row| row.get::<_, String>(0))?;
    rows.map(|row| {
        let envelope: Envelope = serde_json::from_str(&row?)?;
        envelope.validate()?;
        Ok(envelope)
    }).collect()
}


fn expire_graphs(host: &Host, epoch: u64) -> Result<()> {
    let state = host.lock()?;
    let now = i64::try_from(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?.as_millis())?;
    let roots = {
        let mut query = state.journal.0.prepare(
            "SELECT root_goal_id,deadline_ms FROM lifetime_graph_budgets
             WHERE expired=0 AND deadline_ms<=?1 ORDER BY root_goal_id LIMIT 256",
        )?;
        let rows = query.query_map([now], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for (root_goal_id, deadline) in roots {
        let mut envelope = internal_envelope("host-maintenance", epoch,
            json!({"method":"work.expire","root_goal_id":root_goal_id}))?;
        // A backward wall-clock step can reject a previously selected deadline.
        // A later observed time is a distinct maintenance intent, not a retry
        // of an unknown external effect; the budget row is the once-only guard.
        envelope.command_id.push_str(&format!(":{deadline}:{now}"));
        envelope.correlation_id = envelope.command_id.clone();
        let response = lifetime::apply(&state.journal.0, &envelope, "host-maintenance")?;
        anyhow::ensure!(response.status == ResponseStatus::Success, "graph expiry was not committed");
    }
    Ok(())
}

fn internal_envelope(principal: &str, epoch: u64, body: Value) -> Result<Envelope> {
    let digest = canonical_digest(&body)?;
    let command_id = if matches!(body["method"].as_str(), Some("runtime.reconcile" | "conversation.status" | "inspect")) {
        format!("host-observe:{}", uuid::Uuid::new_v4())
    } else {
        let mut hash = Sha256::new();
        hash.update(b"ghost-host-observation/1");
        hash.update((principal.len() as u64).to_be_bytes());
        hash.update(principal.as_bytes());
        hash.update(epoch.to_be_bytes());
        hash.update(digest.as_bytes());
        format!("host-observe:{:x}", hash.finalize())
    };
    let envelope = Envelope { protocol_version: VERSION.into(), command_id: command_id.clone(), payload_digest: digest,
        actor_ref: principal.into(), authority_epoch: epoch, expected_revision: None, correlation_id: command_id, body };
    envelope.validate()?;
    Ok(envelope)
}

async fn bounded_pi_request(process: &mut PiProcess, command: &Envelope) -> Result<Response> {
    tokio::time::timeout(Duration::from_secs(30), process.request(command)).await
        .map_err(|_| anyhow!("Pi ACK unavailable; reconcile the same command ID"))?
}

async fn bounded_worker_request(socket: &std::path::Path, command: &Envelope) -> Result<Response> {
    tokio::time::timeout(Duration::from_secs(10), worker_request(socket, command)).await
        .map_err(|_| anyhow!("worker ACK unavailable; inspect the same execution ID"))?
}

fn block_delivery(host: &Host, command: &Envelope, reason: &str) {
    let update = host.lock().and_then(|state| {
        persist_delivery_blocker(&state.journal.0, command, reason)
    });
    if let Err(error) = update { eprintln!("lifetime blocker persistence unavailable: {error}"); }
}

fn persist_delivery_blocker(
    conn: &rusqlite::Connection,
    command: &Envelope,
    reason: &str,
) -> Result<()> {
    let work_id = command.body["spec"]["work_id"].as_str().or_else(|| command.body["work_id"].as_str());
    let execution = command.body["execution_id"].as_str();
    let goal_id = command.body["goal_id"].as_str();
    let revision = command.body["spec"]["work_revision"].as_u64()
        .or_else(|| command.body["goal_revision"].as_u64())
        .or(command.expected_revision);
    let mut query = conn.prepare(
        "SELECT payload FROM lifetime_work
         WHERE ((?1 IS NOT NULL AND id=?1)
             OR (?1 IS NULL AND ?2 IS NOT NULL AND execution_id=?2)
             OR (?1 IS NULL AND ?2 IS NULL AND ?3 IS NOT NULL AND goal_id=?3))
           AND (?4 IS NULL OR goal_revision=?4)",
    )?;
    let rows = query.query_map(rusqlite::params![work_id, execution, goal_id, revision], |row| row.get::<_, String>(0))?;
    let payloads = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    drop(query);
    let tx = conn.unchecked_transaction()?;
    for payload in payloads {
        let mut work: crate::lifetime_contract::Work = serde_json::from_str(&payload)?;
        if matches!(work.state.as_str(), "accepted" | "completed" | "failed" | "cancelled") { continue; }
        work.blocker = Some(reason.into());
        tx.execute("UPDATE lifetime_work SET payload=?1 WHERE id=?2", rusqlite::params![serde_json::to_string(&work)?, work.id])?;
    }
    tx.commit()?;
    Ok(())
}

async fn observe_pi_submissions(host: &Host, process: &mut PiProcess, authority_epoch: u64) -> Result<()> {
    let submissions = {
        let state = host.lock()?;
        let mut query = state.journal.0.prepare(
            "SELECT DISTINCT g.id,b.ghost_id,b.conversation_id,r.receiver_command_id,
             json_extract(r.payload,'$.data.submission_id')
             FROM lifetime_outbox o JOIN lifetime_delivery_receipts r ON r.outbox_id=o.id
             JOIN lifetime_goals g ON g.id=json_extract(o.payload,'$.body.goal_id')
             JOIN lifetime_work w ON w.goal_id=g.id AND w.goal_revision=g.revision
               AND (json_extract(o.payload,'$.body.method')='conversation.submit'
                 OR (w.id=json_extract(o.payload,'$.body.work_id')
                     AND w.owner=g.accountable_ghost AND w.cancellation='none'))
             JOIN lifetime_bindings b ON b.ghost_id=g.accountable_ghost AND b.conversation_id=g.reply_conversation
             WHERE o.target='pi' AND o.acknowledged=1
             AND json_extract(o.payload,'$.body.method') IN ('conversation.submit','conversation.assignment')
             AND json_extract(o.payload,'$.body.goal_revision')=g.revision
             AND json_type(r.payload,'$.data.submission_id')='integer'
             AND g.state='open' AND (g.privacy='public' OR ?1)
             AND json_extract(o.payload,'$.authority_epoch')=(SELECT authority_epoch FROM lifetime_authority WHERE singleton=1)
             AND w.execution_id IS NULL AND w.state='queued'
             AND json_extract(w.payload,'$.blocker') IS NULL"
        )?;
        let rows = query.query_map([host.pi_local_route.is_some()], |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?,
            row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?,
        )))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for (goal_id, ghost_id, conversation_id, request_id, submission_id) in submissions {
        let command = internal_envelope("host-pi-observer", authority_epoch, json!({
            "method":"conversation.status","ghost_id":ghost_id,"conversation_id":conversation_id,
            "goal_id":goal_id,"request_id":request_id,
        }))?;
        let response = bounded_pi_request(process, &command).await?;
        if response.status != ResponseStatus::Success {
            block_delivery(host, &command, "Committed Pi submission status is unresolved; explicit reconciliation required");
            continue;
        }
        anyhow::ensure!(
            response.data["ghost_id"] == ghost_id && response.data["conversation_id"] == conversation_id
            && response.data["request_id"] == request_id
            && response.data["submission_id"].as_i64() == Some(submission_id),
            "Pi status did not match the durable receiver receipt"
        );
        match response.data["status"].as_str() {
            Some("unanswered") => block_delivery(host, &command,
                "Original Pi turn ended unanswered; no automatic model retry or worker execution occurred. Owner direction or a new goal revision is required."),
            Some("done") => block_delivery(host, &command,
                "Original Pi turn ended without assigning this work. Check the original conversation for a result or request for owner direction."),
            Some("queued" | "placed") => {}
            _ => bail!("Pi returned an unsupported durable submission status"),
        }
    }
    Ok(())
}

async fn observe_workers(host: &Host, authority_epoch: u64) -> Result<()> {
    let Some(computers) = host.native_computers.as_ref() else { return Ok(()); };
    let works = host.lock().and_then(|state| lifetime::snapshot(&state.journal.0))?.work;
    for work in works {
        let Some(execution_id) = work.execution_id.as_deref() else { continue; };
        let socket = host.lock().and_then(|state| computers.socket_for_execution(&state.journal.0, &work.id, &work.owner, execution_id))?;
        let Some(socket) = socket else { continue; };
        if let Err(error) = observe_worker(host, socket, &work, authority_epoch).await {
            eprintln!("worker observation unavailable for {}: {error}", work.id);
        }
    }
    Ok(())
}

async fn observe_worker(host: &Host, socket: &std::path::Path, work: &crate::lifetime_contract::Work, authority_epoch: u64) -> Result<()> {
        let Some(execution_id) = work.execution_id.as_deref() else { return Ok(()); };
        if matches!(work.state.as_str(), "accepted" | "completed" | "failed" | "cancelled" | "unknown") { return Ok(()); }
        let inspect = internal_envelope("host-worker-observer", authority_epoch, json!({"method":"inspect","execution_id":execution_id}))?;
        let inspected = match bounded_worker_request(socket, &inspect).await {
            Ok(response) if response.status == ResponseStatus::Success => response,
            _ => return Ok(()),
        };
        let epoch = inspected.data["authority_epoch"].as_u64().ok_or_else(|| anyhow!("worker epoch missing"))?;
        let terminal = inspected.data["session_settled"] == true && inspected.data["process_exited"] == true;
        let receiver_failure = matches!(inspected.data["state"].as_str(), Some("failed" | "unknown"));
        if !terminal && !receiver_failure && inspected.data["prompt_acknowledged"] != true { return Ok(()); }
        if !terminal && !receiver_failure && work.state == "running" { return Ok(()); }
        let mut artifacts = Vec::new();
        let mut publication_receipts = Value::Null;
        let mut sequence = inspected.data["last_sequence"].as_u64().ok_or_else(|| anyhow!("worker sequence missing"))?;
        let state = if terminal {
            let command = internal_envelope("host-worker-observer", epoch, json!({"method":"collect","execution_id":execution_id}))?;
            let mut collected = match bounded_worker_request(socket, &command).await {
                Ok(response) if response.status == ResponseStatus::Success => response,
                _ => return Ok(()),
            };
            if collected.data["tool_receipts"].as_array().is_some_and(|receipts| receipts.iter().any(|receipt| matches!(receipt["status"].as_str(), Some("pending" | "unknown")))) { return Ok(()); }
            sequence = collected.data["last_sequence"].as_u64().unwrap_or(sequence);
            artifacts = collected.artifacts;
            if collected.data["process_exit_code"] == 0 && collected.data["prompt_result"]["status"] == "completed" {
                publication_receipts = collected.data["tool_receipts"].take();
            }
            if work.cancellation != "none" { "cancelled" }
            else if collected.data["process_exit_code"] == 0 && collected.data["prompt_result"]["status"] == "completed" { "completed" }
            else { "failed" }
        } else if receiver_failure { inspected.data["state"].as_str().unwrap_or("unknown") }
        else { "running" };
        let producer = format!("worker:{execution_id}");
        let host_state = host.lock()?;
        if let Some(privacy) = submitted_publication_privacy(&host_state.journal.0, work, epoch)? {
            project_published_artifacts(&mut artifacts, &publication_receipts, execution_id, epoch, &privacy);
        }
        let artifact_count = artifacts.len();
        let body = json!({"method":"work.result","execution_id":execution_id,"producer":producer,
            "sequence":sequence,"goal_revision":work.goal_revision,"state":state,"artifacts":artifacts,
            "summary":format!("Worker {state}; {artifact_count} published artifacts collected. Independent verification and Goal acceptance are separate.")});
        let command = internal_envelope(&producer, epoch, body)?;
        let response = lifetime::apply(&host_state.journal.0, &command, &producer)?;
        if response.status == ResponseStatus::Error { eprintln!("worker result admission rejected: {:?}", response.error_code); }
    Ok(())
}

/// Classify explicit own-execution publications from the committed Host
/// admission. Worker storage, oversized frames and forensic receipts stay
/// local-only; neither the model nor a receiver chooses disclosure.
fn submitted_publication_privacy(
    conn: &rusqlite::Connection,
    work: &crate::lifetime_contract::Work,
    epoch: u64,
) -> Result<Option<String>> {
    let Some(execution_id) = work.execution_id.as_deref() else { return Ok(None); };
    let Some(base) = lifetime::worker_dispatch_privacy(conn, &work.id)? else { return Ok(None); };
    let sources: Option<String> = conn.query_row(
        "SELECT json_object('skills',json_extract(payload,'$.body.spec.skills'),
                            'input_artifacts',json_extract(payload,'$.body.spec.input_artifacts'))
         FROM lifetime_outbox WHERE target='worker'
           AND json_extract(payload,'$.body.method')='submit'
           AND json_extract(payload,'$.body.spec.execution_id')=?1
           AND json_extract(payload,'$.body.spec.authority_epoch')=?2",
        (execution_id, epoch), |row| row.get(0),
    ).optional()?;
    let Some(sources) = sources else { return Ok(None); };
    Ok(Some(join_worker_source_privacy(base, &serde_json::from_str::<Value>(&sources)?)))
}

fn project_published_artifacts(
    artifacts: &mut [crate::lifetime_contract::Artifact],
    receipts: &Value,
    execution_id: &str,
    epoch: u64,
    privacy: &str,
) {
    if !matches!(privacy, "public" | "private") { return; }
    for receipt in receipts.as_array().into_iter().flatten() {
        if receipt["tool_name"] != "publish_artifact"
            || receipt["status"] != "complete"
            || receipt["is_error"] != false
            || receipt["authority_epoch"].as_u64() != Some(epoch)
        { continue; }
        let proof = &receipt["artifact"];
        let Some(artifact) = artifacts.iter_mut().find(|artifact|
            artifact.producing_attempt == execution_id
                && artifact.privacy == "local_only"
                && proof["producing_attempt"] == execution_id
                && proof["privacy"] == "local_only"
                && proof["digest"] == artifact.digest
                && proof["locator"] == artifact.locator
        ) else { continue; };
        artifact.privacy.clear();
        artifact.privacy.push_str(privacy);
    }
}


/// Privacy comes from committed Host state, not a receiver payload's optional label.
fn delivery_route<'a>(host: &'a Host, command: &Envelope, target: &str, mode: &str) -> Result<Option<Delivery<'a>>> {
    let method = command.body["method"].as_str().ok_or_else(|| anyhow!("outbox method missing"))?;
    let state = host.lock()?;
    let conn = &state.journal.0;
    let authority = lifetime::authority::current(conn)?;
    anyhow::ensure!(authority.dispatch_enabled && authority.epoch == host.authority_epoch && command.authority_epoch == authority.epoch,
        "outbox writer authority is fenced or dispatch is disabled");
    if target == "worker" {
        let Some(computers) = host.native_computers.as_ref() else { return Ok(None); };
        let (work_id, ghost_id): (String, String) = if method == "submit" {
            let work_id = command.body["spec"]["work_id"].as_str().ok_or_else(|| anyhow!("worker work scope missing"))?;
            conn.query_row("SELECT w.id,json_extract(w.payload,'$.owner') FROM lifetime_work w WHERE w.id=?1",
                [work_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        } else {
            anyhow::ensure!(matches!(method, "steer" | "cancel"), "unsupported worker delivery method");
            let execution = command.body["execution_id"].as_str().ok_or_else(|| anyhow!("worker execution scope missing"))?;
            conn.query_row("SELECT w.id,json_extract(w.payload,'$.owner') FROM lifetime_work w WHERE w.execution_id=?1",
                [execution], |row| Ok((row.get(0)?, row.get(1)?)))?
        };
        let mut worker_command = command.clone();
        if matches!(method, "submit" | "steer") {
            let Some(privacy) = lifetime::worker_dispatch_privacy(conn, &work_id)? else { return Ok(None); };
            let Some(grant) = computers.grant(&ghost_id, authority.epoch)? else { return Ok(None); };
            // Skill privacy joins the Goal privacy for routing (max rank wins;
            // local_only is preserved over ancestors). The refs are sealed in
            // the Host-admitted spec, so an unknown class fails closed to
            // local_only — a public Goal with a private/default-private skill
            // never reaches a subscription/cloud/public route: the delivery is
            // withheld before any bytes or model context are sent.
            let effective_privacy = if method == "submit" {
                join_worker_source_privacy(privacy, &command.body["spec"])
            } else { privacy };
            if !grant.permits_privacy(&effective_privacy)
                || (method == "submit" && !grant.permits_spec(&command.body["spec"])) {
                return Ok(None);
            }
            // Route admitted: the per-Work dispatcher now attaches the exact
            // Host-owned revision bytes for the sealed refs as a closed private
            // payload on the EXISTING admission RPC. Integrity is the sealed
            // sha256; the payload rides only this loopback worker transport,
            // never model parameters, progress, or reports, and only after the
            // joined-privacy gate above admitted this route.
            if method == "submit" {
                let refs: Vec<crate::lifetime_contract::WorkerSkillRef> =
                    match command.body["spec"]["skills"].as_array() {
                        Some(items) => serde_json::from_value(Value::Array(items.clone()))?,
                        None => Vec::new(),
                    };
                if !refs.is_empty() {
                    let profile_name = state
                        .profiles
                        .get(&ghost_id)
                        .map(|profile| profile.name.clone())
                        .ok_or_else(|| anyhow!("worker Ghost profile is missing"))?;
                    let payloads =
                        crate::host::skills::payloads_for_refs(&host.root, &profile_name, &refs)?;
                    if !payloads.is_empty() {
                        worker_command.body["skill_payloads"] = Value::Array(payloads);
                        worker_command.payload_digest =
                            crate::lifetime_contract::canonical_digest(&worker_command.body)?;
                    }
                }
            }
        }
        let socket = if method == "submit" {
            let computer_id = command.body["spec"]["computer_id"].as_str().ok_or_else(|| anyhow!("worker computer provenance missing"))?;
            computers.socket_for_computer(&ghost_id, computer_id)
        } else {
            let execution_id = command.body["execution_id"].as_str().ok_or_else(|| anyhow!("worker execution provenance missing"))?;
            computers.socket_for_execution(conn, &work_id, &ghost_id, execution_id)?
        };
        if method == "steer" && !socket.is_some_and(|socket| computers.socket_is_current(&ghost_id, socket)) {
            return Ok(None);
        }
        return Ok(socket.map(|socket| Delivery::Worker(socket, worker_command)));
    }
    anyhow::ensure!(target == "pi", "unknown lifetime outbox target");
    let public: bool = match method {
        "conversation.input" if mode == "broker" => {
            let ghost_id = command.body["ghost_id"].as_str().ok_or_else(|| anyhow!("Pi Ghost scope missing"))?;
            let conversation_id = command.body["conversation_id"].as_str().ok_or_else(|| anyhow!("Pi conversation scope missing"))?;
            let turn_id = command.body["turn_id"].as_str().ok_or_else(|| anyhow!("Pi turn scope missing"))?;
            let admitted: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM lifetime_turns WHERE id=?1 AND ghost_id=?2 AND conversation_id=?3 AND kind='user')",
                rusqlite::params![turn_id, ghost_id, conversation_id], |row| row.get(0),
            )?;
            anyhow::ensure!(admitted, "Pi input has no committed owner turn in this pair");
            lifetime::conversation_is_public(conn, ghost_id, conversation_id)?
        }
        "conversation.assignment" if mode == "broker" => {
            lifetime::assignment_is_public_for_delivery(conn, command)?
        }
        "conversation.submit" | "conversation.steer" if mode == "broker" => {
            let goal_id = command.body["goal_id"].as_str().ok_or_else(|| anyhow!("Pi goal scope missing"))?;
            let ghost_id = command.body["ghost_id"].as_str().ok_or_else(|| anyhow!("Pi Ghost scope missing"))?;
            let conversation_id = command.body["conversation_id"].as_str().ok_or_else(|| anyhow!("Pi conversation scope missing"))?;
            let admitted: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM lifetime_goals WHERE id=?1 AND accountable_ghost=?2 AND reply_conversation=?3)",
                rusqlite::params![goal_id, ghost_id, conversation_id], |row| row.get(0),
            )?;
            anyhow::ensure!(admitted, "Pi Goal scope is no longer current");
            lifetime::conversation_is_public(conn, ghost_id, conversation_id)?
        }
        _ => return Ok(Some(Delivery::Pi)),
    };
    Ok((public || host.pi_local_route.is_some()).then_some(Delivery::Pi))
}

fn outbox_envelope(payload: Value) -> Result<Envelope> {
    let envelope: Envelope = serde_json::from_value(payload)?;
    envelope.validate()?;
    Ok(envelope)
}

#[cfg(unix)]
pub(crate) async fn worker_request(socket: &std::path::Path, envelope: &Envelope) -> Result<Response> {
    let mut peer = tokio::net::UnixStream::connect(socket).await?;
    let mut request = serde_json::to_vec(envelope)?;
    anyhow::ensure!(request.len() < 1_048_576, "worker request limit");
    request.push(b'\n');
    peer.write_all(&request).await?;
    let mut reader = BufReader::new(peer);
    let mut bytes = Vec::new();
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() { bail!("worker response missing; inspect execution before retrying"); }
        let end = buffer.iter().position(|b| *b == b'\n').map(|i| i + 1).unwrap_or(buffer.len());
        anyhow::ensure!(bytes.len() + end <= 1_048_576, "worker response limit");
        let newline = buffer[end - 1] == b'\n';
        bytes.extend_from_slice(&buffer[..end]);
        reader.consume(end);
        if newline { return Ok(serde_json::from_slice(&bytes)?); }
    }
}
#[cfg(not(unix))]
async fn worker_request(_: &std::path::Path, _: &Envelope) -> Result<Response> {
    bail!("local worker UDS transport is unsupported on this platform")
}

/// Max-rank privacy join for the Host-admitted child artifact metadata on a
/// native worker submission. Ranks public < private < local_only; only ACTUAL
/// included artifact refs raise the route (the protected_artifacts_withheld
/// flag is a safe masked-status marker, not a private fact — raising from it
/// would self-invalidate immutable inputs after re-derivation). Any artifact
/// whose privacy is not exactly "public" or "private" (including local_only,
/// missing, or unknown classes) fails closed to local_only. Metadata only —
/// never contents; a spec without input metadata returns the base unchanged.
fn join_artifact_input_privacy(mut effective: String, inputs: &Value) -> String {
    let Some(records) = inputs.as_array() else { return effective; };
    for record in records {
        for artifact in record.get("artifacts").and_then(Value::as_array).into_iter().flatten() {
            match artifact.get("privacy").and_then(Value::as_str) {
                Some("public") => {}
                Some("private") => {
                    if effective == "public" {
                        effective = "private".to_owned();
                    }
                }
                _ => return "local_only".to_owned(),
            }
        }
    }
    effective
}

fn join_worker_source_privacy(mut effective: String, sources: &Value) -> String {
    // Only sealed Host skill refs and child metadata enter this join; missing
    // or unknown classes remain local-only, never a public default.
    for skill in sources["skills"].as_array().into_iter().flatten() {
        match skill.get("privacy").and_then(Value::as_str) {
            Some("public") => {}
            Some("private") if effective == "public" => {
                effective.clear();
                effective.push_str("private");
            }
            Some("private") => {}
            _ => {
                effective.clear();
                effective.push_str("local_only");
            }
        }
    }
    join_artifact_input_privacy(effective, &sources["input_artifacts"])
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifetime_contract::Work;
    use rusqlite::{params, Connection};

    #[test]
    fn stale_assignment_failure_cannot_block_a_reused_work_or_other_attempt() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../contracts/lifetime/migration-005.sql")).unwrap();
        conn.execute(
            "INSERT INTO lifetime_goals VALUES('goal',2,'digest','ghost','conversation','public','open','{}')",
            [],
        ).unwrap();
        let current = Work {
            id: "current".into(), goal_id: "goal".into(), goal_revision: 2,
            owner: "ghost".into(), owner_revision: 1, state: "queued".into(),
            execution_id: None, cancellation: "none".into(), blocker: None,
        };
        let historical = Work {
            id: "historical".into(), goal_revision: 1,
            execution_id: Some("old-execution".into()), cancellation: "requested".into(),
            state: "cancel_requested".into(), ..current.clone()
        };
        for work in [&current, &historical] {
            conn.execute(
                "INSERT INTO lifetime_work VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![work.id,work.goal_id,work.goal_revision,work.owner,work.owner_revision,
                    work.state,work.execution_id,work.cancellation,serde_json::to_string(work).unwrap()],
            ).unwrap();
        }
        let body = json!({
            "method":"conversation.assignment","work_id":"current","goal_id":"goal",
            "goal_revision":1,"ghost_id":"ghost","conversation_id":"conversation",
            "prompt":"initial task","privacy":"public",
        });
        let mut command = Envelope {
            protocol_version: VERSION.into(), command_id: "old-assignment".into(),
            payload_digest: canonical_digest(&body).unwrap(), actor_ref: "owner".into(),
            authority_epoch: 1, expected_revision: Some(1),
            correlation_id: "assignment-revision".into(), body,
        };
        persist_delivery_blocker(&conn, &command, "unconfirmed stale delivery").unwrap();
        for expected in [&current, &historical] {
            let stored: String = conn.query_row(
                "SELECT payload FROM lifetime_work WHERE id=?1", [&expected.id], |row| row.get(0),
            ).unwrap();
            assert_eq!(serde_json::from_str::<Work>(&stored).unwrap(), *expected);
        }

        command.body["goal_revision"] = json!(2);
        command.expected_revision = Some(2);
        command.payload_digest = canonical_digest(&command.body).unwrap();
        persist_delivery_blocker(&conn, &command, "current delivery unconfirmed").unwrap();
        let current_payload: String = conn.query_row(
            "SELECT payload FROM lifetime_work WHERE id='current'", [], |row| row.get(0),
        ).unwrap();
        let blocked: Work = serde_json::from_str(&current_payload).unwrap();
        assert_eq!(blocked.blocker.as_deref(), Some("current delivery unconfirmed"));
        assert_eq!(blocked.goal_revision, 2);
        assert_eq!(blocked.execution_id, None);
        let historical_payload: String = conn.query_row(
            "SELECT payload FROM lifetime_work WHERE id='historical'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(serde_json::from_str::<Work>(&historical_payload).unwrap(), historical);
    }

    fn input_record(artifact_privacy: Option<&str>, withheld: bool) -> Value {
        let mut artifact = json!({
            "digest": "a".repeat(64),
            "locator": "file:child/result.bin",
            "producing_attempt": "attempt-child",
        });
        if let Some(privacy) = artifact_privacy {
            artifact["privacy"] = json!(privacy);
        }
        json!({
            "work_id": "work-child",
            "goal_id": "goal-child",
            "goal_revision": 1,
            "execution_id": "execution-child",
            "state": "accepted",
            "artifacts": [artifact],
            "protected_artifacts_withheld": withheld,
        })
    }

    #[test]
    fn artifact_input_privacy_joins_max_rank_and_fails_closed() {
        // Public-only metadata never downgrades or raises a public route.
        assert_eq!(join_artifact_input_privacy("public".into(), &json!([input_record(Some("public"), false)])), "public");
        // A private child reference raises a public route to private.
        assert_eq!(join_artifact_input_privacy("public".into(), &json!([input_record(Some("private"), false)])), "private");
        // The withheld flag is a masked-status marker, NOT a private fact: it
        // never raises routing (actual included refs are the only raise source).
        assert_eq!(join_artifact_input_privacy("public".into(), &json!([input_record(Some("public"), true)])), "public");
        assert_eq!(join_artifact_input_privacy("public".into(), &json!([input_record(None, true)])), "local_only");
        // local_only and unknown/missing classes fail closed to local_only from any base.
        for artifact_privacy in [Some("local_only"), None, Some("secret")] {
            for base in ["public", "private", "local_only"] {
                assert_eq!(
                    join_artifact_input_privacy(base.into(), &json!([input_record(artifact_privacy, false)])),
                    "local_only",
                );
            }
        }
        // No metadata (absent or null) leaves the effective privacy unchanged.
        for base in ["public", "private", "local_only"] {
            assert_eq!(join_artifact_input_privacy(base.into(), &Value::Null), base);
        }
        // local_only is sticky: a private pair cannot dilute it back.
        assert_eq!(join_artifact_input_privacy("local_only".into(), &json!([input_record(Some("private"), false)])), "local_only");
    }

    #[test]
    fn public_publication_does_not_disclose_sdk_diagnostic_artifacts() {
        let published = crate::lifetime_contract::Artifact {
            digest: "a".repeat(64), locator: "owned/output.json".into(),
            privacy: "local_only".into(), producing_attempt: "execution".into(),
        };
        let diagnostic = crate::lifetime_contract::Artifact {
            digest: "b".repeat(64), locator: "owned/sdk-frame.json".into(),
            ..published.clone()
        };
        let receipts = json!([{
            "tool_name":"publish_artifact", "status":"complete", "is_error":false,
            "authority_epoch":7, "artifact":published,
        }]);
        let mut artifacts = [published, diagnostic];
        project_published_artifacts(&mut artifacts, &receipts, "execution", 7, "public");
        assert_eq!(artifacts[0].privacy, "public");
        assert_eq!(artifacts[1].privacy, "local_only");
    }

    #[test]
    fn publication_requires_exact_current_successful_receipt_proof() {
        let artifact = crate::lifetime_contract::Artifact {
            digest: "a".repeat(64), locator: "owned/output.json".into(),
            privacy: "local_only".into(), producing_attempt: "execution".into(),
        };
        let valid = json!({
            "tool_name":"publish_artifact", "status":"complete", "is_error":false,
            "authority_epoch":7, "artifact":artifact,
        });
        for (pointer, replacement) in [
            ("/status", json!("unknown")),
            ("/is_error", json!(true)),
            ("/authority_epoch", json!(6)),
            ("/artifact/producing_attempt", json!("other-execution")),
            ("/artifact/digest", json!("b".repeat(64))),
            ("/artifact/locator", json!("other/output.json")),
        ] {
            let mut receipt = valid.clone();
            *receipt.pointer_mut(pointer).unwrap() = replacement;
            let mut artifacts = [artifact.clone()];
            project_published_artifacts(&mut artifacts, &json!([receipt]), "execution", 7, "public");
            assert_eq!(artifacts[0].privacy, "local_only");
        }
        for privacy in ["local_only", "unknown"] {
            let mut artifacts = [artifact.clone()];
            project_published_artifacts(&mut artifacts, &json!([valid.clone()]), "execution", 7, privacy);
            assert_eq!(artifacts[0].privacy, "local_only");
        }
    }

    #[test]
    fn sealed_skill_and_child_sources_keep_publications_protected() {
        let private = join_worker_source_privacy("public".into(), &json!({
            "skills":[{"privacy":"private"}],
            "input_artifacts":[input_record(Some("public"), false)],
        }));
        assert_eq!(private, "private");
        let unknown = join_worker_source_privacy("public".into(), &json!({
            "skills":[{"privacy":"unknown"}],
            "input_artifacts":[input_record(Some("public"), false)],
        }));
        assert_eq!(unknown, "local_only");
    }
}
