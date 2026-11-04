//! Independent deterministic Owner verifier, isolated from the producing Pi
//! execution. Pending/unknown receipts are never automatically re-executed.
use super::{db, graph, task_contracts};
use crate::{
    adapters::computer::{ComputerBackend, ComputerOperation},
    host::Host,
    lifetime_contract::{
        canonical_digest, Acceptance, Artifact, Check, Envelope, Response, ResponseStatus, VERSION,
    },
    worker::{native_tools::NativeWorkspace, scoped_tools::ScopedWorkspace},
};
use anyhow::{anyhow, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
const RECEIPTS: &str = "owner_task_verification_v1";
const NOTICES: &str = "owner_task_verification_notice_v1";
#[cfg(test)]
#[path="task_verification_diagnostics.rs"]
mod test_diagnostics;
#[cfg(test)]
pub(crate) use test_diagnostics::with_verifier_test_diagnostics;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Plan {
    work_id: String,
    source_execution: String,
    verification_execution: String,
    ghost_id: String,
    computer_id: String,
    authority_epoch: u64,
    goal_revision: u64,
    owner_revision: u64,
    requirement_digest: String,
    publication_revision: String,
    verifier_revision: String,
    policy_revision: u64,
    template_digest: String,
    script_sha256: String,
    input_sha256: String,
    output: Artifact,
    privacy: String,
    interpreter: String,
    image: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    plan: Plan,
    state: String,
    passed: bool,
    observation: Value,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn key(work: &str, output: &str) -> String {
    format!("{work}:{output}")
}
fn receipt(conn: &Connection, id: &str) -> Result<Option<Receipt>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
            params![RECEIPTS, id],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(Into::into))
        .transpose()
}
fn write_receipt(conn: &Connection, value: &Receipt) -> Result<()> {
    conn.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",params![RECEIPTS,key(&value.plan.work_id,&value.plan.output.digest),serde_json::to_string(value)?])?;
    Ok(())
}
// Private Host provenance, not a model-callable command. The report resolver
// follows this exact saved receipt instead of guessing a Work from its Goal.
pub(super) fn report_work(conn:&Connection,source:&str,report:&str)->Result<Option<crate::lifetime_contract::Work>> {
    let raw:Option<String>=conn.query_row("SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",params![NOTICES,source],|r|r.get(0)).optional()?;
    let Some(raw)=raw else{return Ok(None)};let notice:Value=serde_json::from_str(&raw)?;
    ensure!(notice["report_id"]==report,"Verifier notice report identity changed");
    let saved=receipt(conn,notice["receipt_ref"].as_str().ok_or_else(||anyhow!("Verifier notice receipt missing"))?)?.ok_or_else(||anyhow!("Verifier notice receipt lost"))?;
    ensure!(hash(serde_json::to_string(&saved)?.as_bytes())==notice["receipt_digest"].as_str().unwrap_or(""),"Verifier notice receipt changed");
    let work=db::work(conn,&saved.plan.work_id)?.ok_or_else(||anyhow!("Verifier notice Work lost"))?;
    ensure!(work.execution_id.as_deref()==Some(saved.plan.source_execution.as_str()) && work.goal_revision==saved.plan.goal_revision && work.owner_revision==saved.plan.owner_revision && work.owner==saved.plan.ghost_id,"Verifier notice producer changed");
    Ok(Some(work))
}
fn enqueue_terminal_notice(host:&Host,conn:&Connection,saved:&Receipt)->Result<()> {
    if saved.passed || !matches!(saved.state.as_str(),"complete"|"unknown") {return Ok(())}
    ensure!(!host.stopping.load(std::sync::atomic::Ordering::Acquire) && host.authority_epoch==saved.plan.authority_epoch,"Verifier notice Host stopped or fenced");
    ensure!(receipt(conn,&key(&saved.plan.work_id,&saved.plan.output.digest))?.is_some_and(|actual|serde_json::to_value(actual).ok()==serde_json::to_value(saved).ok()),"Verifier notice receipt changed before enqueue");
    let work=db::work(conn,&saved.plan.work_id)?.ok_or_else(||anyhow!("Verifier notice Work missing"))?;
    if work.execution_id.as_deref()!=Some(saved.plan.source_execution.as_str()) || work.owner!=saved.plan.ghost_id
        || work.goal_revision!=saved.plan.goal_revision || work.owner_revision!=saved.plan.owner_revision
        || super::authority::current(conn)?.epoch!=saved.plan.authority_epoch {return Ok(())}
    if view(conn,&work)?.is_none_or(|v|v["current_scope"]!=true) {return Ok(())}
    host.work_memory_verification_conn(conn,&work)?;host.publication_work_conn(conn,&work)?;
    ensure!(host.publication_work_revision(conn,&work)?==saved.plan.publication_revision,"Verifier notice publication lineage changed");
    crate::host::shared_skills::work_current(conn,&work)?;
    let receipt_digest=hash(serde_json::to_string(saved)?.as_bytes());
    let source_id=format!("host-verification-notice:{receipt_digest}");
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM workspace_objects WHERE kind=?1 AND id=?2)",params![NOTICES,source_id],|r|r.get(0))?;
    if exists{return Ok(())}
    let goal=db::goal(conn,&work.goal_id)?.ok_or_else(||anyhow!("Verifier notice Goal missing"))?;
    super::conversation::registered_mode(conn,&goal.accountable_ghost,&goal.reply_conversation)?;
    super::conversation::require_pi_binding(conn,&goal.accountable_ghost,&goal.reply_conversation)?;
    let mut privacy=super::conversation::conversation_privacy(conn,&goal.accountable_ghost,&goal.reply_conversation)?;
    super::conversation::raise_privacy(&mut privacy,&super::pi_execution::privacy(conn,&work)?)?;
    super::conversation::persist_disclosure(conn,&goal.accountable_ghost,&goal.reply_conversation,&privacy)?;
    let status=if saved.state=="complete" {"failed"}else{"unknown"};
    let body=json!({"method":"conversation.submit","ghost_id":goal.accountable_ghost,"conversation_id":goal.reply_conversation,
        "privacy":privacy,"goal_id":goal.id,"goal_revision":goal.revision,
        "prompt":format!("Authoritative Host independent verification for Work {} and producer execution {}: verdict={status}; receipt={}. This output has not been accepted. Report this verdict honestly and finish; no execution retry or exact diagnostic cause is authorized by this metadata.",work.id,saved.plan.source_execution,key(&work.id,&saved.plan.output.digest))});
    // lifetime_outbox has a source-command FK. This private Host receipt is
    // deliberately not a dispatched/public command or a model capability.
    let provenance=json!({"method":"host.verification.notice","work_id":work.id,"execution_id":saved.plan.source_execution,"receipt_ref":key(&work.id,&saved.plan.output.digest),"receipt_digest":receipt_digest});
    let source=Envelope{command_id:source_id.clone(),payload_digest:canonical_digest(&provenance)?,body:provenance,..acceptance_source(&saved.plan)};
    let outgoing=super::apply::outgoing(&source,"host-pi-verifier",Some(goal.revision),body)?;
    let report_id=outgoing["command_id"].as_str().ok_or_else(||anyhow!("Verifier report ID missing"))?;
    ensure!(!host.stopping.load(std::sync::atomic::Ordering::Acquire) && host.authority_epoch==super::authority::current(conn)?.epoch,"Verifier notice Host stopped or fenced before publication");
    conn.execute("INSERT INTO lifetime_commands(command_id,payload_digest,actor_ref,authority_epoch,request,response) VALUES(?1,?2,?3,?4,?5,?6)",params![source.command_id,source.payload_digest,source.actor_ref,source.authority_epoch,serde_json::to_string(&source)?,serde_json::to_string(&super::apply::success("private independent verification delivery receipt",vec![work.id.clone()],json!({"receipt_digest":receipt_digest})))?])?;
    conn.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3)",params![NOTICES,source_id,json!({"receipt_ref":key(&work.id,&saved.plan.output.digest),"receipt_digest":receipt_digest,"report_id":report_id,"work_id":work.id}).to_string()])?;
    conn.execute("INSERT INTO lifetime_outbox(command_id,target,delivery_ref,payload) VALUES(?1,'pi',?2,?3)",params![source.command_id,report_id,outgoing.to_string()])?;
    Ok(())
}
/// Read-only evidence for this exact producing Work. A completed producer or
/// a verifier pass is not itself acceptance, and unknown/failed runs never
/// acquire automatic retry authority from this projection.
pub(crate) fn view(conn:&Connection,work:&crate::lifetime_contract::Work)->Result<Option<Value>> {
    let mut query=conn.prepare("SELECT payload FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.plan.work_id')=?2 AND json_extract(payload,'$.plan.source_execution') IS ?3 ORDER BY id LIMIT 2")?;
    let rows=query.query_map(params![RECEIPTS,work.id,work.execution_id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(rows.len()<=1,"Independent verification receipt is ambiguous");
    let saved=rows.first().map(|raw|serde_json::from_str::<Receipt>(raw)).transpose()?;
    if saved.is_none() && task_contracts::work_source(conn,work)?.is_none() {return Ok(None);}
    let historical_status=saved.as_ref().map_or("pending",|r|match(r.state.as_str(),r.passed){("complete",true)=>"passed",("complete",false)=>"failed",("pending",_)=>"pending",_=>"unknown"});
    let authority=super::authority::current(conn)?;
    let policy:(String,u64)=conn.query_row("SELECT verifier_revision,policy_revision FROM lifetime_verification_policy WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let goal=db::goal(conn,&work.goal_id)?;
    let current_scope=authority.dispatch_enabled && work.cancellation=="none" && graph::current_result_scope(conn,work)?
        && goal.is_some_and(|goal|goal.revision==work.goal_revision)
        && saved.as_ref().is_none_or(|r|r.plan.ghost_id==work.owner && r.plan.authority_epoch==authority.epoch && r.plan.goal_revision==work.goal_revision && r.plan.owner_revision==work.owner_revision && r.plan.verifier_revision==policy.0 && r.plan.policy_revision==policy.1);
    let status=if saved.is_some()&&!current_scope {"unknown"}else{historical_status};
    Ok(Some(json!({"version":"ghost-independent-verification/1","work_id":work.id,"execution_id":work.execution_id,
        "status":status,"historical_status":historical_status,"current_scope":current_scope,
        "accepted":current_scope&&work.state=="accepted","historically_accepted":work.state=="accepted",
        "authorizes_inference_or_effects":false,"live_source_authentication":"not_performed_by_inspection","automatic_retry":false,
        "receipt_ref":saved.as_ref().map(|r|key(&work.id,&r.plan.output.digest)),
        "output_sha256":saved.as_ref().map(|r|&r.plan.output.digest),
        "verifier_execution_id":saved.as_ref().map(|r|&r.plan.verification_execution),
        "observation":saved.as_ref().map(|r|json!({"exit_code":r.observation["exit_code"],"compartment_stopped":r.observation["state"]=="stopped"||r.observation["compartment_stopped"]==true,"current_scope":r.observation["current_scope"]}))
    })))
}
fn published(
    conn: &Connection,
    work: &crate::lifetime_contract::Work,
    path: &str,
) -> Result<Artifact> {
    let execution = work
        .execution_id
        .as_deref()
        .ok_or_else(|| anyhow!("Task verifier has no producer execution"))?;
    let mut query=conn.prepare("SELECT arguments_json,response_json FROM lifetime_pi_effects WHERE execution_id=?1 AND operation='publish_artifact' AND state='complete'")?;
    let mut found = None;
    for row in query.query_map([execution], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (args, response) = row?;
        let args: Value = serde_json::from_str(&args)?;
        let response: Response = serde_json::from_str(&response)?;
        if args["path"] == path && response.status == ResponseStatus::Success {
            for artifact in response.artifacts {
                ensure!(
                    artifact.producing_attempt == execution,
                    "Verifier output producer changed"
                );
                if let Some(old) = &found {
                    ensure!(old == &artifact, "Multiple different task verifier outputs");
                }
                found = Some(artifact);
            }
        }
    }
    found.ok_or_else(|| anyhow!("Task verifier output was not published"))
}
fn plan(host: &Host, conn: &Connection, work_id: &str) -> Result<(Plan, Vec<u8>, Vec<u8>, String)> {
    let work = db::work(conn, work_id)?.ok_or_else(|| anyhow!("Task verification Work missing"))?;
    ensure!(
        work.state == "completed" && work.cancellation == "none",
        "Independent verifier requires completed uncancelled Work"
    );
    ensure!(
        graph::current_result_scope(conn, &work)?,
        "Task result scope changed"
    );
    let (input, t) = task_contracts::work_source(conn, &work)?
        .ok_or_else(|| anyhow!("Work has no Owner task contract"))?;
    ensure!(
        task_contracts::root_dependency_ready(conn, &work)?,
        "Required eligible child has not been independently accepted"
    );
    let goal =
        db::goal(conn, &work.goal_id)?.ok_or_else(|| anyhow!("Task verification Goal missing"))?;
    let artifact = published(conn, &work, &t.content.artifact_path)?;
    super::orchestra_review::require_pass(conn, &goal, &work, &artifact.digest)?;
    let bytes = crate::worker::journal::read_verified_pi_artifact(
        &host.root,
        conn,
        work.execution_id.as_deref().unwrap(),
        &artifact.digest,
        Path::new(&artifact.locator),
    )?;
    task_contracts::validate_output(&t, &bytes)?;
    let input_bytes = serde_json::to_vec(&input.selection.input)?;
    ensure!(
        hash(&input_bytes) == input.input_digest,
        "Immutable Owner input digest changed"
    );
    let computer_id = host
        .native_computers
        .as_ref()
        .and_then(|c| c.pi_computer(&work.owner))
        .ok_or_else(|| anyhow!("Independent verifier has no accepted native computer"))?;
    let verification_execution = canonical_digest(
        &json!({"kind":"owner-task-verification/1","work_id":work.id,"source_execution":work.execution_id,"goal_revision":work.goal_revision,"owner_revision":work.owner_revision,"template_digest":t.digest,"input_digest":input.input_digest,"script_sha256":t.content.verifier.sha256,"output_digest":artifact.digest,"epoch":host.authority_epoch,"policy_revision":t.policy_revision}),
    )?;
    let publication_revision = host.publication_work_revision(conn, &work)?;
    Ok((
        Plan {
            work_id: work.id,
            source_execution: work.execution_id.unwrap(),
            verification_execution,
            ghost_id: work.owner,
            computer_id,
            authority_epoch: host.authority_epoch,
            goal_revision: work.goal_revision,
            owner_revision: work.owner_revision,
            requirement_digest: goal.requirement_digest,
            publication_revision,
            verifier_revision: t.verifier_revision,
            policy_revision: t.policy_revision,
            template_digest: t.digest,
            script_sha256: t.content.verifier.sha256,
            input_sha256: input.input_digest,
            output: artifact,
            privacy: goal.privacy,
            interpreter: t.content.verifier.interpreter,
            image: t.content.verifier.image,
        },
        input_bytes,
        bytes,
        t.content.verifier.source,
    ))
}
fn current(host: &Host, state: &crate::host::State, p: &Plan) -> Result<()> {
    let conn = &state.journal.0;
    let work = db::work(conn, &p.work_id)?.ok_or_else(|| anyhow!("Verifier Work missing"))?;
    host.work_memory_verification_current(state, &work)?;
    host.publication_work_current(state, &work)?;
    current_conn(host, conn, p)
}
fn current_conn(host: &Host, conn: &Connection, p: &Plan) -> Result<()> {
    ensure!(
        !host.stopping.load(std::sync::atomic::Ordering::Acquire),
        "Verifier Host stopping"
    );
    let authority = super::authority::current(conn)?;
    ensure!(
        authority.epoch == p.authority_epoch
            && host.authority_epoch == p.authority_epoch
            && authority.dispatch_enabled,
        "Independent verifier authority fenced"
    );
    let work = db::work(conn, &p.work_id)?.ok_or_else(|| anyhow!("Verifier Work missing"))?;
    let goal = db::goal(conn, &work.goal_id)?.ok_or_else(|| anyhow!("Verifier Goal missing"))?;
    ensure!(
        host.publication_work_revision(conn, &work)? == p.publication_revision,
        "Verifier publication dependencies changed"
    );
    ensure!(
        work.cancellation == "none"
            && work.state == "completed"
            && work.owner == p.ghost_id
            && work.execution_id.as_deref() == Some(p.source_execution.as_str())
            && work.goal_revision == p.goal_revision
            && work.owner_revision == p.owner_revision
            && goal.requirement_digest == p.requirement_digest
            && graph::current_result_scope(conn, &work)?,
        "Independent verifier source was cancelled, replaced or closed"
    );
    super::orchestra_review::require_pass(conn, &goal, &work, &p.output.digest)?;
    let (_, t) = task_contracts::work_source(conn, &work)?
        .ok_or_else(|| anyhow!("Verifier source grant missing"))?;
    ensure!(
        t.digest == p.template_digest
            && t.verifier_revision == p.verifier_revision
            && t.policy_revision == p.policy_revision
            && t.content.verifier.sha256 == p.script_sha256
            && t.content.verifier.image == p.image
            && t.content.verifier.interpreter == p.interpreter,
        "Pinned verifier template changed"
    );
    ensure!(
        host.native_computers
            .as_ref()
            .is_some_and(
                |c| c.pi_computer(&p.ghost_id).as_deref() == Some(p.computer_id.as_str())
                    && c.pi_available(&p.ghost_id, p.authority_epoch, &p.privacy)
                        .unwrap_or(false)
            ),
        "Independent verifier environment unavailable"
    );
    Ok(())
}
fn acceptance_source(p: &Plan) -> Envelope {
    Envelope {
        protocol_version: VERSION.into(),
        command_id: format!("owner-task-verifier:{}", p.verification_execution),
        payload_digest: String::new(),
        actor_ref: "host-pi-verifier".into(),
        authority_epoch: p.authority_epoch,
        expected_revision: None,
        correlation_id: p.work_id.clone(),
        body: Value::Null,
    }
}
fn next_work(conn: &Connection) -> Result<Option<String>> {
    // Every attempted item advances a durable round-robin cursor before any
    // guard or I/O. A permanently stale Work cannot monopolize driver ticks.
    let selected:Option<String>=conn.query_row("SELECT w.id FROM lifetime_work w JOIN lifetime_goals g ON g.id=w.goal_id WHERE w.state='completed' AND json_extract(g.payload,'$.acceptance_spec.verifier.kind')='owner-task-verifier/1' AND (NOT EXISTS(SELECT 1 FROM workspace_objects r WHERE r.kind=?1 AND json_extract(r.payload,'$.plan.work_id')=w.id) OR EXISTS(SELECT 1 FROM workspace_objects r WHERE r.kind=?1 AND json_extract(r.payload,'$.plan.work_id')=w.id AND json_extract(r.payload,'$.state')='complete' AND json_extract(r.payload,'$.passed')=1)) ORDER BY CASE WHEN w.id>COALESCE((SELECT json_extract(payload,'$.after') FROM workspace_objects WHERE kind='owner_task_verifier_cursor_v1' AND id='workspace'),'') THEN 0 ELSE 1 END,w.id LIMIT 1",[RECEIPTS],|row|row.get(0)).optional()?;
    if let Some(id) = &selected {
        conn.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES('owner_task_verifier_cursor_v1','workspace',?1) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",[json!({"after":id}).to_string()])?;
    }
    Ok(selected)
}

impl Host {
    /// The existing lifetime driver calls this; it is not another scheduler or
    /// AI worker. At most one completed Work is inspected per bounded tick.
    pub(crate) async fn advance_task_verifications(&self) -> Result<()> {
        self.reconcile_task_verification_notice().await?;
        let work_id = {
            let state = self.lock()?;
            next_work(&state.journal.0)?
        };
        let Some(work_id) = work_id else {
            return Ok(());
        };
        let source_work = {
            let state = self.lock()?;
            let work = db::work(&state.journal.0, &work_id)?.ok_or_else(|| anyhow!("Verifier Work missing"))?;
            if !super::orchestra_review::ready_for_verifier(&state.journal.0, &work)? {
                return Ok(());
            }
            work
        };
        self.work_memory_verification_guard(&source_work).await?;
        let verified_publication = self.publication_work_guard(&source_work).await?;
        let (p, input, output, script) = {
            let state = self.lock()?;
            let prepared = plan(self, &state.journal.0, &work_id)?;
            ensure!(
                prepared.0.publication_revision == verified_publication,
                "Verifier publication context changed after fresh validation"
            );
            current(self, &state, &prepared.0)?;
            if let Some(saved) =
                receipt(&state.journal.0, &key(&work_id, &prepared.0.output.digest))?
            {
                ensure!(
                    saved.plan == prepared.0 && saved.state == "complete" && saved.passed,
                    "Original verifier receipt is not eligible for acceptance recovery"
                );
                // Fresh external guards above and the same current writer
                // permit only acceptance recovery, never another guest run.
                let source = acceptance_source(&prepared.0);
                self.accept_task_verification(&state.journal.0, &source, &prepared.0)?;
                return Ok(());
            }
            write_receipt(
                &state.journal.0,
                &Receipt {
                    plan: prepared.0.clone(),
                    state: "pending".into(),
                    passed: false,
                    observation: json!({"host_effect_class":"verification_pending"}),
                },
            )?;
            prepared
        };
        let mut lease_acquired = false;
        let mut confirmed_stopped = false;
        let mut execution_attempted = false;
        let outcome=async {
            let computers=self.native_computers.as_ref().ok_or_else(||anyhow!("Verifier computer missing"))?;
            let environment=computers.pi_acquire(&p.ghost_id,&p.verification_execution,p.authority_epoch,&p.privacy)?;
            lease_acquired = true;
            let authorize=||->Result<()>{let state=self.lock()?;current(self,&state,&p)?;ensure!(computers.pi_current(&p.ghost_id,&p.verification_execution,&p.computer_id,p.authority_epoch,&p.privacy)?,"Verifier lease fenced");Ok(())};
            let workspace=ScopedWorkspace::for_task(&environment.directory)?;
            let readonly=NativeWorkspace::open(&environment.directory).map_err(|e|anyhow!(e.code))?;
            for (name,bytes) in [("verifier.sh",script.as_bytes()),("input.json",input.as_slice()),("output.json",output.as_slice())] {authorize()?;workspace.create_input(name,bytes).map_err(|e|anyhow!(e.code))?;}
            let backend=crate::computers::AppleContainerBackend::for_verification(&environment.container_cli,&environment.manifest,&p.verification_execution,&p.image,unsafe{libc::geteuid()},unsafe{libc::getegid()})?;
            // Absolute interpreter and a cleared guest environment. The mount
            // exposes only these three read-only files; /tmp is disposable.
            let command="exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp TMPDIR=/tmp LANG=C /bin/sh -eu /inputs/verifier.sh /inputs/input.json /inputs/output.json";
            execution_attempted = true;
            let executed=backend.execute("host-independent-verifier",ComputerOperation::Shell{command:command.into(),timeout_ms:30_000},&authorize).await;
            #[cfg(test)]
            test_diagnostics::record(&self.root,&p,command,&executed);
            let result = match executed {
                Ok(result) => {
                    confirmed_stopped = result["state"] == "stopped";
                    result
                }
                Err(error) => {
                    // An error can mean the guest stop is unknown. Retain its
                    // native lease unless the same backend proves cleanup.
                    confirmed_stopped = backend.control("host-independent-verifier", "kill").await
                        .is_ok_and(|status| status["state"] == "stopped");
                    return Err(error);
                }
            };
            authorize()?;
            for (name,bytes) in [("verifier.sh",script.as_bytes()),("input.json",input.as_slice()),("output.json",output.as_slice())] {ensure!(readonly.read_artifact(name).map_err(|e|anyhow!(e.code))?==bytes,"Independent verifier input/script/output bytes changed");}
            ensure!(result["state"]=="stopped","Independent verifier compartment stop is unconfirmed");
            Ok::<_,anyhow::Error>(result)
        }.await;
        if lease_acquired && (confirmed_stopped || !execution_attempted) {
            if let Some(c) = &self.native_computers {
                c.pi_release(&p.ghost_id, &p.verification_execution, p.authority_epoch)?;
            }
        }
        let fresh_sources = async {
            self.work_memory_verification_guard(&source_work).await?;
            self.publication_work_guard(&source_work).await
        }
        .await;
        let state = self.lock()?;
        let still_current = fresh_sources.is_ok_and(|revision| revision == p.publication_revision)
            && current(self, &state, &p).is_ok();
        let value = match outcome {
            Ok(observed) => Receipt {
                plan: p.clone(),
                state: "complete".into(),
                passed: still_current && observed["success"] == true && observed["exit_code"] == 0,
                observation: json!({"success":observed["success"],"exit_code":observed["exit_code"],"state":observed["state"],"stdout_sha256":hash(observed["stdout"].as_str().unwrap_or("").as_bytes()),"stderr_sha256":hash(observed["stderr"].as_str().unwrap_or("").as_bytes()),"current_scope":still_current}),
            },
            Err(error) => Receipt {
                plan: p.clone(),
                state: "unknown".into(),
                passed: false,
                observation: json!({"reason":error.to_string(),"automatic_retry":false,"compartment_stopped":confirmed_stopped,"lease_retained":lease_acquired && execution_attempted && !confirmed_stopped}),
            },
        };
        let tx=Transaction::new_unchecked(&state.journal.0,TransactionBehavior::Immediate)?;
        write_receipt(&tx, &value)?;
        // A delivery guard failure must retain the terminal verdict. The
        // durable missing-notice query will reconcile it after fresh guards;
        // it never reruns the verifier.
        tx.execute_batch("SAVEPOINT verifier_notice;")?;
        let notice=if still_current {enqueue_terminal_notice(self,&tx,&value)}else{Ok(())};
        if notice.is_err(){tx.execute_batch("ROLLBACK TO verifier_notice;")?;}
        tx.execute_batch("RELEASE verifier_notice;")?;
        tx.commit()?;
        notice?;
        if value.passed {
            let source = acceptance_source(&p);
            self.accept_task_verification(&state.journal.0, &source, &p)?;
        }
        Ok(())
    }
    async fn reconcile_task_verification_notice(&self)->Result<()> {
        // Bounded existing-driver reconciliation only. No verifier/effect rerun.
        let selected={let state=self.lock()?;let conn=&state.journal.0;
            let row:Option<(String,String)>=conn.query_row("SELECT r.id,r.payload FROM workspace_objects r WHERE r.kind=?1 AND json_extract(r.payload,'$.state') IN ('complete','unknown') AND json_extract(r.payload,'$.passed')=0 AND NOT EXISTS(SELECT 1 FROM workspace_objects n WHERE n.kind=?2 AND json_extract(n.payload,'$.receipt_ref')=r.id) ORDER BY CASE WHEN r.id>COALESCE((SELECT json_extract(payload,'$.after') FROM workspace_objects WHERE kind='owner_task_notice_cursor_v1' AND id='workspace'),'') THEN 0 ELSE 1 END,r.id LIMIT 1",params![RECEIPTS,NOTICES],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((id,_))=&row {conn.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES('owner_task_notice_cursor_v1','workspace',?1) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",[json!({"after":id}).to_string()])?;}row};
        let Some((_,raw))=selected else{return Ok(())};let saved:Receipt=serde_json::from_str(&raw)?;
        let work={let state=self.lock()?;let Some(work)=db::work(&state.journal.0,&saved.plan.work_id)? else{return Ok(())};if view(&state.journal.0,&work)?.is_none_or(|v|v["current_scope"]!=true){return Ok(())}work};
        if self.work_memory_verification_guard(&work).await.is_err(){return Ok(())}
        let Ok(revision)=self.publication_work_guard(&work).await else{return Ok(())};
        let state=self.lock()?;if self.publication_work_revision(&state.journal.0,&work)?!=revision{return Ok(())}
        let tx=Transaction::new_unchecked(&state.journal.0,TransactionBehavior::Immediate)?;
        enqueue_terminal_notice(self,&tx,&saved)?;tx.commit()?;Ok(())
    }
    fn accept_task_verification(
        &self,
        conn: &Connection,
        source: &Envelope,
        guarded_plan: &Plan,
    ) -> Result<Response> {
        let work_id = &guarded_plan.work_id;
        let (p, _, _, _) = plan(self, conn, work_id)?;
        ensure!(&p == guarded_plan, "Fresh verifier acceptance plan changed");
        // Caller holds the Host writer lock. The guards validate against the
        // exact connection used to derive and accept this immutable plan.
        self.work_memory_verification_conn(
            conn,
            &db::work(conn, work_id)?.ok_or_else(|| anyhow!("Verifier Work missing"))?,
        )?;
        self.publication_work_conn(
            conn,
            &db::work(conn, work_id)?.ok_or_else(|| anyhow!("Verifier Work missing"))?,
        )?;
        current_conn(self, conn, &p)?;
        let saved = receipt(conn, &key(work_id, &p.output.digest))?
            .ok_or_else(|| anyhow!("Independent Owner verifier has not run"))?;
        ensure!(
            saved.plan == p && saved.state == "complete" && saved.passed,
            "Independent verifier receipt is pending, unknown, failed or stale"
        );
        let mut checks=vec![Check{id:"artifact_sha256".into(),passed:true,evidence:format!("Host independently reopened immutable producer artifact {}",p.output.digest)},Check{id:"owner_verifier".into(),passed:true,evidence:format!("Independent isolated verifier {} under image {} interpreter {} accepted script {} input {} output {}; producer self-check is not acceptance authority",p.verification_execution,p.image,p.interpreter,p.script_sha256,p.input_sha256,p.output.digest)}];
        let work = db::work(conn, &p.work_id)?.ok_or_else(|| anyhow!("Verifier Work missing"))?;
        let goal = db::goal(conn, &work.goal_id)?.ok_or_else(|| anyhow!("Verifier Goal missing"))?;
        checks.extend(super::orchestra_review::acceptance_check(conn, &goal, &work, &p.output.digest)?);
        let acceptance = Acceptance {
            work_id: p.work_id,
            goal_revision: p.goal_revision,
            requirement_digest: p.requirement_digest,
            artifact_digest: p.output.digest,
            verifier_revision: p.verifier_revision,
            policy_revision: p.policy_revision,
            checks,
        };
        let body = json!({"method":"work.accept","acceptance":acceptance});
        let command = Envelope {
            command_id: format!("pi-independent-accept:{}", p.source_execution),
            actor_ref: "host-pi-verifier".into(),
            payload_digest: canonical_digest(&body)?,
            body,
            ..source.clone()
        };
        super::apply(conn, &command, "host-pi-verifier")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sixteen_failed_or_unknown_receipts_do_not_starve_fresh_completed_work() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE lifetime_work(id TEXT PRIMARY KEY,goal_id TEXT,state TEXT);CREATE TABLE lifetime_goals(id TEXT PRIMARY KEY,payload TEXT);CREATE TABLE workspace_objects(kind TEXT,id TEXT,payload TEXT,PRIMARY KEY(kind,id));").unwrap();
        for index in 0..17 {
            let id = format!("work-{index:02}");
            conn.execute(
                "INSERT INTO lifetime_goals VALUES(?1,?2)",
                params![
                    id,
                    json!({"acceptance_spec":{"verifier":{"kind":"owner-task-verifier/1"}}})
                        .to_string()
                ],
            )
            .unwrap();
            conn.execute("INSERT INTO lifetime_work VALUES(?1,?1,'completed')", [&id])
                .unwrap();
            if index < 16 {
                let status = if index % 2 == 0 {
                    "unknown"
                } else {
                    "complete"
                };
                conn.execute(
                    "INSERT INTO workspace_objects VALUES(?1,?2,?3)",
                    params![
                        RECEIPTS,
                        id,
                        json!({"plan":{"work_id":id},"state":status,"passed":false}).to_string()
                    ],
                )
                .unwrap();
            }
        }
        assert_eq!(next_work(&conn).unwrap().as_deref(), Some("work-16"));
        conn.execute(
            "INSERT INTO workspace_objects VALUES(?1,'last',?2)",
            params![
                RECEIPTS,
                json!({"plan":{"work_id":"work-16"},"state":"pending","passed":false}).to_string()
            ],
        )
        .unwrap();
        assert_eq!(
            next_work(&conn).unwrap(),
            None,
            "pending/unknown attempts must not be retried"
        );
        conn.execute(
            "UPDATE workspace_objects SET payload=?1 WHERE id='last'",
            [json!({"plan":{"work_id":"work-16"},"state":"complete","passed":true}).to_string()],
        )
        .unwrap();
        assert_eq!(
            next_work(&conn).unwrap().as_deref(),
            Some("work-16"),
            "known stopped success remains eligible for acceptance-only recovery"
        );
        conn.execute(
            "DELETE FROM workspace_objects WHERE kind=?1 AND id='work-00'",
            [RECEIPTS],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO lifetime_goals VALUES('work-17',?1)",
            [
                json!({"acceptance_spec":{"verifier":{"kind":"owner-task-verifier/1"}}})
                    .to_string(),
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO lifetime_work VALUES('work-17','work-17','completed')",
            [],
        )
        .unwrap();
        assert_eq!(next_work(&conn).unwrap().as_deref(), Some("work-17"));
        assert_eq!(next_work(&conn).unwrap().as_deref(), Some("work-00"));
        assert_eq!(next_work(&conn).unwrap().as_deref(), Some("work-16"));
        assert_eq!(
            next_work(&conn).unwrap().as_deref(),
            Some("work-17"),
            "preflight/recovery blockers cannot starve later work"
        );
    }
}

#[cfg(test)]
pub(crate) fn fixture_terminal_receipt(host:&Host,work_id:&str,state:&str)->Result<()> {
    // Controlled projection/driver fixture only: no guest verifier or
    // acceptance. Production writes receipts solely after independent I/O.
    ensure!(matches!(state,"complete"|"unknown"),"fixture terminal state invalid");
    let locked=host.lock()?;let conn=&locked.journal.0;
    let work=db::work(conn,work_id)?.ok_or_else(||anyhow!("fixture Work missing"))?;
    let mut plan=projection_tests::fixture_plan(conn,&work);
    plan.publication_revision=host.publication_work_revision(conn,&work)?;
    plan.authority_epoch=super::authority::current(conn)?.epoch;
    write_receipt(conn,&Receipt{plan,state:state.into(),passed:false,observation:json!({"state":"stopped","exit_code":255,"current_scope":true})})
}
#[cfg(test)]
mod projection_tests {
    use super::*;
    pub(super) fn fixture_plan(conn:&Connection,work:&crate::lifetime_contract::Work)->Plan {
        let goal=db::goal(conn,&work.goal_id).unwrap().unwrap();
        let policy:(String,u64)=conn.query_row("SELECT verifier_revision,policy_revision FROM lifetime_verification_policy WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        Plan{work_id:work.id.clone(),source_execution:work.execution_id.clone().unwrap(),verification_execution:"independent-verifier-execution".into(),ghost_id:work.owner.clone(),computer_id:"pi-fixture".into(),authority_epoch:1,goal_revision:work.goal_revision,owner_revision:work.owner_revision,requirement_digest:goal.requirement_digest,publication_revision:"a".repeat(64),verifier_revision:policy.0,policy_revision:policy.1,template_digest:"b".repeat(64),script_sha256:"c".repeat(64),input_sha256:"d".repeat(64),output:Artifact{digest:"e".repeat(64),locator:"opaque-output".into(),privacy:"public".into(),producing_attempt:work.execution_id.clone().unwrap()},privacy:"public".into(),interpreter:"/bin/sh".into(),image:crate::computers::PINNED_TASK_IMAGE.into()}
    }
    #[tokio::test]
    async fn terminal_notice_is_durable_once_after_pending_reply_and_rechecks_receipt_on_every_new_reply() {
        use super::super::pi_execution::tests::{setup_with_spec,publish_complete,envelope};
        let f=setup_with_spec(json!({}));publish_complete(&f,"original producer output").await;
        let (original,mut saved)={let state=f.host.lock().unwrap();let conn=&state.journal.0;let work=db::work(conn,&f.work).unwrap().unwrap();
            let original:String=conn.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE json_extract(payload,'$.body.method')='conversation.submit' ORDER BY id DESC LIMIT 1",[],|r|r.get(0)).unwrap();
            let mut plan=fixture_plan(conn,&work);plan.publication_revision=f.host.publication_work_revision(conn,&work).unwrap();
            let saved=Receipt{plan,state:"pending".into(),passed:false,observation:json!({})};write_receipt(conn,&saved).unwrap();(original,saved)};
        // The original report can inspect pending, then the verifier can finish
        // before its advisory reply commits. A separate exact terminal report
        // closes that race without changing the old reply protocol.
        {let state=f.host.lock().unwrap();let conn=&state.journal.0;
            let inspect=envelope(&f.ghost,json!({"method":"conversation.report.inspect","report_id":original,"ghost_id":f.ghost,"conversation_id":f.conversation}));
            assert_eq!(super::super::apply(conn,&inspect,&f.ghost).unwrap().data["independent_verification"]["status"],"pending");
            saved.state="complete".into();saved.observation=json!({"exit_code":255,"state":"stopped","current_scope":true});write_receipt(conn,&saved).unwrap();
            let reply=envelope(&f.ghost,json!({"method":"conversation.report.reply","report_id":original,"ghost_id":f.ghost,"conversation_id":f.conversation,"text":"The producer completed; independent verification is pending."}));
            let first=super::super::apply(conn,&reply,&f.ghost).unwrap();assert_eq!(first.status,ResponseStatus::Success);
            assert_eq!(serde_json::to_value(super::super::apply(conn,&reply,&f.ghost).unwrap()).unwrap(),serde_json::to_value(first).unwrap(),"legacy omitted observation preserves exact command replay");}
        f.host.reconcile_task_verification_notice().await.unwrap();
        let (notice,report)={let state=f.host.lock().unwrap();let conn=&state.journal.0;
            let raw:String=conn.query_row("SELECT payload FROM workspace_objects WHERE kind=?1",[NOTICES],|r|r.get(0)).unwrap();let notice:Value=serde_json::from_str(&raw).unwrap();
            let report=notice["report_id"].as_str().unwrap().to_owned();assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE delivery_ref=?1",[&report],|r|r.get::<_,u64>(0)).unwrap(),1);(notice,report)};
        f.host.reconcile_task_verification_notice().await.unwrap();
        {let state=f.host.lock().unwrap();let conn=&state.journal.0;
            let inspect=envelope(&f.ghost,json!({"method":"conversation.report.inspect","report_id":report,"ghost_id":f.ghost,"conversation_id":f.conversation}));let projected=super::super::apply(conn,&inspect,&f.ghost).unwrap();assert_eq!(projected.data["independent_verification"]["status"],"failed");
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM workspace_objects WHERE kind=?1",[NOTICES],|r|r.get::<_,u64>(0)).unwrap(),1);
            // Reopen the durable journal as a distinct connection. No new
            // model, verifier, producer effect, notice or delivery identity.
            let reopened=Connection::open(f.host.root.join("workspace.db")).unwrap();
            let tx=Transaction::new_unchecked(&reopened,TransactionBehavior::Immediate).unwrap();enqueue_terminal_notice(&f.host,&tx,&saved).unwrap();tx.commit().unwrap();
            assert_eq!(report_work(&reopened,&format!("host-verification-notice:{}",notice["receipt_digest"].as_str().unwrap()),&report).unwrap().unwrap().id,f.work);
            let reply=envelope(&f.ghost,json!({"method":"conversation.report.reply","report_id":report,"ghost_id":f.ghost,"conversation_id":f.conversation,"text":"The verifier failed; this result was not accepted."}));
            let first=super::super::apply(conn,&reply,&f.ghost).unwrap();assert_eq!(first.status,ResponseStatus::Success);
            assert_eq!(serde_json::to_value(super::super::apply(&reopened,&reply,&f.ghost).unwrap()).unwrap(),serde_json::to_value(first).unwrap(),"lost ACK replays the same terminal notice reply across journal connection reopen");
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_report_replies WHERE report_id=?1",[&report],|r|r.get::<_,u64>(0)).unwrap(),1);
            let advisory_before:u64=conn.query_row("SELECT COUNT(*) FROM lifetime_turns WHERE kind='assistant_advisory'",[],|r|r.get(0)).unwrap();
            // A new reply cannot use a previously inspected but mutated receipt.
            saved.observation["exit_code"]=json!(9);write_receipt(conn,&saved).unwrap();
            let reply=envelope(&f.ghost,json!({"method":"conversation.report.reply","report_id":report,"ghost_id":f.ghost,"conversation_id":f.conversation,"text":"The verifier failed; this result was not accepted."}));
            assert!(super::super::apply(conn,&reply,&f.ghost).is_err());
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_turns WHERE kind='assistant_advisory'",[],|r|r.get::<_,u64>(0)).unwrap(),advisory_before);
            assert!(db::acceptance(conn,&f.work).unwrap().is_none());}
    }
    #[tokio::test]
    async fn terminal_notice_unknown_is_metadata_only_and_wrong_source_or_late_owner_change_cannot_reply() {
        use super::super::pi_execution::tests::{setup_with_spec,publish_complete,envelope};
        let f=setup_with_spec(json!({}));publish_complete(&f,"producer output").await;
        fixture_terminal_receipt(&f.host,&f.work,"unknown").unwrap();f.host.reconcile_task_verification_notice().await.unwrap();
        let state=f.host.lock().unwrap();let conn=&state.journal.0;
        let (id,raw):(String,String)=conn.query_row("SELECT id,payload FROM workspace_objects WHERE kind=?1",[NOTICES],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();let mut notice:Value=serde_json::from_str(&raw).unwrap();let report=notice["report_id"].as_str().unwrap().to_owned();
        let inspect=envelope(&f.ghost,json!({"method":"conversation.report.inspect","report_id":report,"ghost_id":f.ghost,"conversation_id":f.conversation}));
        let projected=super::super::apply(conn,&inspect,&f.ghost).unwrap();assert_eq!(projected.data["independent_verification"]["status"],"unknown");assert_eq!(projected.data["independent_verification"]["automatic_retry"],false);assert!(!projected.data.to_string().contains("stderr"));
        let reply=envelope(&f.ghost,json!({"method":"conversation.report.reply","report_id":report,"ghost_id":f.ghost,"conversation_id":f.conversation,"text":"Independent verification is unresolved; this output was not accepted."}));
        notice["receipt_digest"]=json!("0".repeat(64));conn.execute("UPDATE workspace_objects SET payload=?1 WHERE kind=?2 AND id=?3",params![notice.to_string(),NOTICES,id]).unwrap();assert!(super::super::apply(conn,&reply,&f.ghost).is_err(),"forged private source digest cannot produce an advisory");
        conn.execute("UPDATE workspace_objects SET payload=?1 WHERE kind=?2 AND id=?3",params![raw,NOTICES,id]).unwrap();
        let mut work=db::work(conn,&f.work).unwrap().unwrap();work.owner_revision+=1;db::update_work(conn,&work).unwrap();
        let changed_reply=envelope(&f.ghost,reply.body.clone());assert_ne!(changed_reply.command_id,reply.command_id);
        let denied=super::super::apply(conn,&changed_reply,&f.ghost);eprintln!("controlled changed-owner reply denial: {denied:?}");
        match denied {Ok(response)=>{assert_eq!(response.status,ResponseStatus::Error);assert_eq!(response.data["host_effect_class"],"no_effect");},Err(error)=>assert!(error.to_string().contains("producer changed"))}
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_report_replies WHERE report_id=?1",[&report],|r|r.get::<_,u64>(0)).unwrap(),0);
    }
    #[tokio::test]
    async fn terminal_notice_rejects_old_execution_epoch_and_owner_revision_without_new_delivery() {
        use super::super::pi_execution::tests::{setup_with_spec,publish_complete};
        for changed in ["epoch","owner_revision","execution"] {
            let f=setup_with_spec(json!({}));publish_complete(&f,"original producer output").await;
            fixture_terminal_receipt(&f.host,&f.work,"unknown").unwrap();
            {let state=f.host.lock().unwrap();let conn=&state.journal.0;let mut work=db::work(conn,&f.work).unwrap().unwrap();
                match changed {"epoch"=>{conn.execute("UPDATE lifetime_authority SET authority_epoch=2",[]).unwrap();},"owner_revision"=>{work.owner_revision+=1;db::update_work(conn,&work).unwrap();},_=>{work.execution_id=Some("replacement-execution".into());db::update_work(conn,&work).unwrap();}}
            }
            f.host.reconcile_task_verification_notice().await.unwrap();let state=f.host.lock().unwrap();assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM workspace_objects WHERE kind=?1",[NOTICES],|r|r.get::<_,u64>(0)).unwrap(),0,"{changed}");
        }
    }
    #[tokio::test]
    async fn terminal_notice_privacy_escalation_persists_join_and_blocks_public_inspection_and_new_reply() {
        use super::super::pi_execution::tests::{setup_with_spec,publish_complete,envelope};
        use super::super::{PiInferenceScope,PiToolRequest};
        // Cover both races: a public notice already queued, and a terminal
        // receipt awaiting its first notice when authenticated private input
        // raises the conversation/source floor. No model or verifier runs.
        for notice_already_queued in [false,true] {
            let mut f=setup_with_spec(json!({}));
            // An accepted local route is explicit Host configuration. This
            // unused fixture endpoint is never contacted by metadata ingress.
            f.host.pi_local_route=Some(crate::host::lifetime_runtime::LocalPiRoute{base_url:"http://127.0.0.1:9/v1".into(),model_id:"fixture".into(),max_output_tokens:1024,callback_token:"fixture".into()});
            assert_eq!(publish_complete(&f,"controlled producer artifact").await.status,ResponseStatus::Success);
            fixture_terminal_receipt(&f.host,&f.work,"complete").unwrap();
            let mut request_ids=std::collections::HashSet::new();
            let mut request=|body:Value|{let envelope=envelope(&f.ghost,body);assert!(request_ids.insert(envelope.command_id.clone()),"new scope probes must not replay a cached command ID");PiToolRequest{context_ref:None,ghost_id:f.ghost.clone(),conversation_id:f.conversation.clone(),envelope}};
            let eligible=f.host.lifetime_pi_action(&request(json!({"method":"inference.inspect"})),PiInferenceScope::Public).await.unwrap();assert_eq!(eligible["result"]["status"],"success","positive public control before escalation");
            if notice_already_queued {f.host.reconcile_task_verification_notice().await.unwrap();}
            let effects=|conn:&Connection|{let mut query=conn.prepare("SELECT json_array(execution_id,task_id,call_id,input_digest,operation,arguments_json,state,response_json) FROM lifetime_pi_effects ORDER BY execution_id,task_id,call_id").unwrap();let rows=query.query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();rows};
            let (saved_receipt,saved_effects,last_outbox)={let state=f.host.lock().unwrap();let conn=&state.journal.0;
                assert_eq!(super::super::conversation::conversation_privacy(conn,&f.ghost,&f.conversation).unwrap(),"public");
                let raw:String=conn.query_row("SELECT payload FROM workspace_objects WHERE kind=?1",[RECEIPTS],|r|r.get(0)).unwrap();
                (raw,effects(conn),conn.query_row("SELECT COALESCE(MAX(id),0) FROM lifetime_outbox",[],|r|r.get::<_,i64>(0)).unwrap())};
            if notice_already_queued {
                let report:String=f.host.lock().unwrap().journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE command_id LIKE 'host-verification-notice:%'",[],|r|r.get(0)).unwrap();
                let before=f.host.lifetime_pi_action(&request(json!({"method":"conversation.report.inspect","report_id":report,"ghost_id":f.ghost,"conversation_id":f.conversation})),PiInferenceScope::Public).await.unwrap();assert_eq!(before["result"]["status"],"success");assert_eq!(before["result"]["data"]["report"]["privacy"],"public");
            }
            let private=envelope("owner",json!({"method":"conversation.input","ghost_id":f.ghost,"conversation_id":f.conversation,"text":"Controlled private source input; keep this conversation local.","privacy":"private","attachments":[]}));
            let escalated=f.host.lifetime_action(&private).unwrap();assert_eq!(escalated["result"]["status"],"success","actual authenticated private ingress must establish the floor");
            f.host.reconcile_task_verification_notice().await.unwrap();
            let report={let state=f.host.lock().unwrap();let conn=&state.journal.0;
                assert_eq!(super::super::conversation::conversation_privacy(conn,&f.ghost,&f.conversation).unwrap(),"private");
                let persisted:String=conn.query_row("SELECT privacy FROM lifetime_conversation_disclosure WHERE ghost_id=?1 AND conversation_id=?2",params![f.ghost,f.conversation],|r|r.get(0)).unwrap();assert_eq!(persisted,"private");
                assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE id>?1 AND command_id LIKE 'host-verification-notice:%' AND json_extract(payload,'$.body.privacy')='public'",[last_outbox],|r|r.get::<_,u64>(0)).unwrap(),0,"escalation cannot enqueue a new public verdict");
                let (id,payload):(String,String)=conn.query_row("SELECT delivery_ref,payload FROM lifetime_outbox WHERE command_id LIKE 'host-verification-notice:%'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
                if !notice_already_queued {assert_eq!(serde_json::from_str::<Value>(&payload).unwrap()["body"]["privacy"],"private","first enqueue joins the actual protected floor");}id};
            for body in [json!({"method":"inference.inspect"}),json!({"method":"conversation.report.inspect","report_id":report,"ghost_id":f.ghost,"conversation_id":f.conversation}),json!({"method":"conversation.report.reply","report_id":report,"ghost_id":f.ghost,"conversation_id":f.conversation,"text":"This public advisory must never commit."})] {
                let blocked=f.host.lifetime_pi_action(&request(body),PiInferenceScope::Public).await.unwrap();assert_eq!(blocked["result"]["status"],"error");assert_eq!(blocked["result"]["error_code"],"disclosure_blocked");assert!(!blocked.to_string().contains("Controlled private source input"));
            }
            let protected=f.host.lifetime_pi_action(&request(json!({"method":"conversation.report.inspect","report_id":report,"ghost_id":f.ghost,"conversation_id":f.conversation})),PiInferenceScope::Local).await.unwrap();assert_eq!(protected["result"]["status"],"success","metadata remains available on its accepted local scope: {protected}");assert_eq!(protected["result"]["data"]["report"]["privacy"],"private");
            let state=f.host.lock().unwrap();let conn=&state.journal.0;
            assert_eq!(conn.query_row("SELECT payload FROM workspace_objects WHERE kind=?1",[RECEIPTS],|r|r.get::<_,String>(0)).unwrap(),saved_receipt,"historical independent verdict unchanged");assert_eq!(effects(conn),saved_effects,"no producer effect or verifier retry");
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_report_replies WHERE report_id=?1",[report],|r|r.get::<_,u64>(0)).unwrap(),0);assert!(db::acceptance(conn,&f.work).unwrap().is_none());
        }
    }
    #[tokio::test]
    async fn independent_verification_projection_keeps_historical_verdict_but_fences_epoch_cancel_and_revisions() {
        let f=super::super::pi_execution::tests::setup_with_spec(json!({}));
        let state=f.host.lock().unwrap();let conn=&state.journal.0;
        let mut work=db::work(conn,&f.work).unwrap().unwrap();work.state="completed".into();work.execution_id=Some("projection-source-execution".into());db::update_work(conn,&work).unwrap();
        let plan=fixture_plan(conn,&work);
        for (state,passed,expected) in [("pending",false,"pending"),("unknown",false,"unknown"),("complete",false,"failed"),("complete",true,"passed")] {
            write_receipt(conn,&Receipt{plan:plan.clone(),state:state.into(),passed,observation:json!({"exit_code":if passed{0}else{255},"state":"stopped","current_scope":true,"stderr":"PRIVATE-VERIFIER-DETAIL-MUST-NOT-LEAK"})}).unwrap();
            let result=view(conn,&work).unwrap().unwrap();assert_eq!(result["status"],expected);assert_eq!(result["historical_status"],expected);assert_eq!(result["accepted"],false);assert_eq!(result["authorizes_inference_or_effects"],false);assert!(!result.to_string().contains("PRIVATE-VERIFIER"));
        }
        conn.execute("UPDATE lifetime_authority SET authority_epoch=2 WHERE singleton=1",[]).unwrap();
        let fenced=view(conn,&work).unwrap().unwrap();assert_eq!(fenced["status"],"unknown");assert_eq!(fenced["historical_status"],"passed");assert_eq!(fenced["current_scope"],false);
        conn.execute("UPDATE lifetime_authority SET authority_epoch=1,dispatch_enabled=0 WHERE singleton=1",[]).unwrap();assert_eq!(view(conn,&work).unwrap().unwrap()["status"],"unknown");
        conn.execute("UPDATE lifetime_authority SET dispatch_enabled=1 WHERE singleton=1",[]).unwrap();
        work.cancellation="requested".into();db::update_work(conn,&work).unwrap();assert_eq!(view(conn,&work).unwrap().unwrap()["historical_status"],"passed");assert_eq!(view(conn,&work).unwrap().unwrap()["status"],"unknown");
        work.cancellation="none".into();work.owner_revision+=1;db::update_work(conn,&work).unwrap();assert_eq!(view(conn,&work).unwrap().unwrap()["status"],"unknown");
        work.owner_revision-=1;work.goal_revision+=1;db::update_work(conn,&work).unwrap();let changed=view(conn,&work).unwrap().unwrap();assert_eq!(changed["historical_status"],"passed");assert_eq!(changed["status"],"unknown");
        work.goal_revision-=1;db::update_work(conn,&work).unwrap();let mut wrong=plan;wrong.ghost_id="wrong-producer".into();write_receipt(conn,&Receipt{plan:wrong,state:"complete".into(),passed:true,observation:json!({"current_scope":true})}).unwrap();assert_eq!(view(conn,&work).unwrap().unwrap()["status"],"unknown");
    }
    #[tokio::test]
    async fn independent_verification_projection_accepts_real_delegated_work_identity() {
        use super::super::pi_execution::tests::{setup_with_spec,envelope};
        let child=uuid::Uuid::new_v4().to_string();let conversation=uuid::Uuid::new_v4().to_string();let prompt="Produce child evidence";
        let spec=json!({"verifier":{"kind":"pi-artifact/1","expected_sha256":"e".repeat(64)}});
        let f=setup_with_spec(json!({"delegation_verifiers":[{"target_ghost_id":child,"prompt_digest":hash(prompt.as_bytes()),"verifier":spec["verifier"]}]}));
        let state=f.host.lock().unwrap();let conn=&state.journal.0;
        let registered=super::super::apply(conn,&envelope("owner",json!({"method":"registry.ensure","ghost_id":child,"conversation_id":conversation,"kind":"specialist","roles":["researcher"]})),"owner").unwrap();assert_eq!(registered.status,ResponseStatus::Success);
        let mut delegation=envelope(&f.ghost,json!({"method":"work.delegate","parent_work_id":f.work,"target_ghost_id":child,"summary":prompt,"artifact_refs":[],"acceptance_spec":spec}));delegation.expected_revision=Some(1);
        let delegated=super::super::apply(conn,&delegation,&f.ghost).unwrap();assert_eq!(delegated.status,ResponseStatus::Success,"{delegated:?}");
        let mut work:crate::lifetime_contract::Work=serde_json::from_value(delegated.data["work"].clone()).unwrap();assert_ne!(work.owner,f.ghost);assert_eq!(work.owner,child);
        work.state="completed".into();work.execution_id=Some("child-projection-source".into());db::update_work(conn,&work).unwrap();
        let plan=fixture_plan(conn,&work);write_receipt(conn,&Receipt{plan:plan.clone(),state:"complete".into(),passed:true,observation:json!({"exit_code":0,"state":"stopped","current_scope":true})}).unwrap();
        assert_eq!(view(conn,&work).unwrap().unwrap()["status"],"passed");
        let mut wrong=plan;wrong.ghost_id=f.ghost;write_receipt(conn,&Receipt{plan:wrong,state:"complete".into(),passed:true,observation:json!({"current_scope":true})}).unwrap();
        let rejected=view(conn,&work).unwrap().unwrap();assert_eq!(rejected["status"],"unknown");assert_eq!(rejected["historical_status"],"passed");
    }

    #[tokio::test]
    async fn failed_verification_projection_settles_actual_owner_and_report_runtime_without_acceptance_or_source_retries() {
        use super::super::pi_execution::tests::{setup_with_spec,publish_complete,envelope};
        use tokio::io::{AsyncBufReadExt,AsyncWriteExt};
        let f=setup_with_spec(json!({}));let produced=publish_complete(&f,"controlled output").await;assert_eq!(produced.status,ResponseStatus::Success);
        {
            let state=f.host.lock().unwrap();let conn=&state.journal.0;let work=db::work(conn,&f.work).unwrap().unwrap();assert_eq!(work.state,"completed");
            write_receipt(conn,&Receipt{plan:fixture_plan(conn,&work),state:"complete".into(),passed:false,observation:json!({"exit_code":255,"state":"stopped","current_scope":true})}).unwrap();
        }
        let owner=envelope("owner",json!({"method":"conversation.input","ghost_id":f.ghost,"conversation_id":f.conversation,"text":"Inspect this completed task and report its independent verification honestly.","privacy":"public","attachments":[]}));let owner_turn=owner.command_id.clone();
        assert_eq!(f.host.lifetime_action(&owner).unwrap()["result"]["status"],"success");
        let (owner_command,report_command)={let state=f.host.lock().unwrap();let conn=&state.journal.0;
            let load=|method:&str|->Value{serde_json::from_str(&conn.query_row("SELECT payload FROM lifetime_outbox WHERE json_extract(payload,'$.body.method')=?1 ORDER BY id DESC LIMIT 1",[method],|r|r.get::<_,String>(0)).unwrap()).unwrap()};(load("conversation.input"),load("conversation.submit"))};
        let mut process=tokio::process::Command::new("/opt/homebrew/bin/node").arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pi-verification-failure.mjs")).arg(f.host.root.join("projection-runtime")).arg(&f.host.root).arg(&f.work).env_clear().env("PATH","/opt/homebrew/bin:/usr/bin:/bin").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::inherit()).kill_on_drop(true).spawn().unwrap();
        let mut input=process.stdin.take().unwrap();let mut output=tokio::io::BufReader::new(process.stdout.take().unwrap()).lines();
        let configured:Value=serde_json::from_str(&output.next_line().await.unwrap().unwrap()).unwrap();assert_eq!(configured["type"],"configured");let mut methods=vec![];
        for (command,expected_calls) in [(owner_command,2),(report_command,1)] {
            input.write_all(format!("{}\n",json!({"type":"command","command":command})).as_bytes()).await.unwrap();input.flush().await.unwrap();
            for index in 0..64 {
                let line=tokio::time::timeout(std::time::Duration::from_secs(5),output.next_line()).await.unwrap().unwrap().unwrap();let frame:Value=serde_json::from_str(&line).unwrap();
                if frame["type"]=="command_result" {assert_eq!(frame["receipt"]["status"],"success","{frame}");assert_eq!(frame["model_calls"],expected_calls);break;}
                assert_eq!(frame["type"],"callback","{frame}");let request:super::super::PiToolRequest=serde_json::from_value(frame["request"].clone()).unwrap();methods.push(request.envelope.body["method"].as_str().unwrap().to_owned());
                let result=f.host.lifetime_pi_action(&request,super::super::PiInferenceScope::Public).await.unwrap();input.write_all(format!("{}\n",json!({"type":"callback_result","id":frame["id"],"frame":result})).as_bytes()).await.unwrap();input.flush().await.unwrap();assert!(index<63);
            }
        }
        input.write_all(b"{\"type\":\"stop\"}\n").await.unwrap();input.flush().await.unwrap();let stopped:Value=serde_json::from_str(&output.next_line().await.unwrap().unwrap()).unwrap();assert_eq!(stopped["type"],"stopped");assert!(process.wait().await.unwrap().success());
        assert_eq!(methods.iter().filter(|method|method.as_str()=="work.inspect").count(),1);assert!(!methods.iter().any(|method|method.starts_with("memory.publication.")));
        let state=f.host.lock().unwrap();let conn=&state.journal.0;assert_eq!(db::work(conn,&f.work).unwrap().unwrap().state,"completed");assert!(db::acceptance(conn,&f.work).unwrap().is_none());assert_eq!(conn.query_row("SELECT state FROM lifetime_turn_runs WHERE turn_id=?1",[owner_turn],|r|r.get::<_,String>(0)).unwrap(),"answered");assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_report_replies",[],|r|r.get::<_,u64>(0)).unwrap(),1);
    }

}
