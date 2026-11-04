//! A fresh Pi process reviews one immutable public result. This continuation
//! owns no Work effects or conversation history, and transport is never replayed.
use super::{apply, authority, conversation, db, orchestra, pi_execution};
use crate::{
    host::{
        inference::Selection,
        lifetime_runtime::{PiLauncher, PiProcess},
        Host,
    },
    lifetime_contract::{
        canonical_digest, Artifact, Check, Envelope, Goal, Response, ResponseStatus, Work, VERSION,
    },
    worker::journal::read_verified_pi_artifact,
};
use anyhow::{anyhow, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path, sync::atomic::Ordering, time::Duration};

const KIND: &str = "orchestra_review_v1";
const ACTOR: &str = "host:orchestra-review";
const CHECK: &str = "orchestra_review";
const INPUT_LIMIT: usize = 48 * 1024;

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Scope {
    goal_id: String,
    work_id: String,
    execution_id: String,
    epoch: u64,
    goal_revision: u64,
    owner_revision: u64,
    requirement_digest: String,
    producer: Selection,
    reviewer: Selection,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Proof {
    artifact_digest: String,
    result_digest: String,
    result_sequence: u64,
    verifier_revision: String,
    policy_revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Verdict {
    Started,
    Passed,
    Failed,
    Blocked,
    Unknown,
}

#[derive(Debug, Serialize, Deserialize)]
struct Receipt {
    scope: Scope,
    proof: Option<Proof>,
    input_digest: Option<String>,
    verdict: Verdict,
    finalized: bool,
}

fn scope(conn: &Connection, goal: &Goal, work: &Work) -> Result<Option<Scope>> {
    let Some(pin) = orchestra::assignment(conn, work)? else {
        return Ok(None);
    };
    let Some(reviewer) = pin.reviewer else {
        return Ok(None);
    };
    let execution = work
        .execution_id
        .as_ref()
        .ok_or_else(|| anyhow!("Orchestra Work has no execution"))?;
    Ok(Some(Scope {
        goal_id: goal.id.clone(),
        work_id: work.id.clone(),
        execution_id: execution.clone(),
        epoch: authority::current(conn)?.epoch,
        goal_revision: goal.revision,
        owner_revision: work.owner_revision,
        requirement_digest: goal.requirement_digest.clone(),
        producer: pin.selection,
        reviewer,
    }))
}

/// Reuse the result currency checks used by work.accept and verify the exact
/// completed Pi binding independently. All checks run again after review I/O.
fn proof(conn: &Connection, goal: &Goal, work: &Work, scope: &Scope) -> Result<(Proof, Artifact)> {
    let authority = authority::current(conn)?;
    ensure!(
        authority.dispatch_enabled && authority.epoch == scope.epoch,
        "Review authority fenced"
    );
    ensure!(
        goal.id == work.goal_id
            && work.goal_revision == goal.revision
            && work.owner == goal.accountable_ghost
            && matches!(work.state.as_str(), "completed" | "accepted")
            && work.cancellation == "none",
        "Review Work scope changed"
    );
    ensure!(
        scope.producer.provider != scope.reviewer.provider
            && orchestra::reviewer_current(conn, goal, work, &scope.reviewer)?,
        "Review provider is unavailable or its Owner approval changed"
    );
    ensure!(
        goal.privacy == "public"
            && pi_execution::privacy(conn, work)? == "public"
            && conversation::conversation_privacy(
                conn,
                &goal.accountable_ghost,
                &goal.reply_conversation
            )? == "public",
        "Review Work is protected"
    );
    let pi: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM lifetime_pi_executions WHERE work_id=?1 AND execution_id=?2
         AND ghost_id=?3 AND conversation_id=?4 AND authority_epoch=?5 AND goal_revision=?6 AND privacy='public' AND state='completed')",
        params![work.id, scope.execution_id, work.owner, goal.reply_conversation, scope.epoch, goal.revision], |row| row.get(0),
    )?;
    ensure!(
        pi,
        "Review requires a current completed public Pi execution"
    );
    let record = apply::result_record(conn, &scope.execution_id)?
        .ok_or_else(|| anyhow!("Review result missing"))?;
    ensure!(
        record.epoch == scope.epoch
            && record.producer == format!("pi-result:{}:{}", work.owner, scope.execution_id)
            && record.event["execution_id"] == scope.execution_id
            && record.event["state"] == "completed"
            && apply::result_is_current(conn, &record)?.0,
        "Review requires an authenticated current Pi result"
    );
    let artifacts: Vec<Artifact> = serde_json::from_value(record.event["artifacts"].clone())?;
    let [artifact] = artifacts.as_slice() else {
        return Err(anyhow!("Review requires exactly one immutable artifact"));
    };
    ensure!(
        artifact.privacy == "public" && artifact.producing_attempt == scope.execution_id,
        "Review artifact is protected or stale"
    );
    let (verifier_revision, policy_revision) = conn.query_row(
        "SELECT verifier_revision,policy_revision FROM lifetime_verification_policy WHERE singleton=1", [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok((
        Proof {
            artifact_digest: artifact.digest.clone(),
            result_digest: canonical_digest(&record.event)?,
            result_sequence: record.sequence,
            verifier_revision,
            policy_revision,
        },
        artifact.clone(),
    ))
}

fn receipt(conn: &Connection, execution: &str) -> Result<Option<Receipt>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
            params![KIND, execution],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .transpose()
}

/// Returns Host-generated evidence only. Inference prose has no path to the
/// final reporting prompt, to a tool invocation, or to the acceptance check.
pub(super) fn require_pass(
    conn: &Connection,
    goal: &Goal,
    work: &Work,
    artifact_digest: &str,
) -> Result<Option<String>> {
    let Some(scope) = scope(conn, goal, work)? else {
        return Ok(None);
    };
    let saved = receipt(conn, &scope.execution_id)?
        .ok_or_else(|| apply::conflict("Independent Orchestra review is pending"))?;
    if saved.verdict != Verdict::Passed || saved.scope != scope {
        return Err(apply::conflict(
            "Independent Orchestra review has no current passing verdict",
        ));
    }
    let (proof, _) = proof(conn, goal, work, &scope)
        .map_err(|_| apply::conflict("Independent Orchestra review scope is no longer current"))?;
    if saved.proof.as_ref() != Some(&proof)
        || proof.artifact_digest != artifact_digest
        || saved.input_digest.is_none()
    {
        return Err(apply::conflict(
            "Independent Orchestra review does not match this result",
        ));
    }
    Ok(Some(format!(
        "Independent Orchestra Pi review passed: {} / {} ({}) for immutable artifact {}",
        scope.reviewer.provider, scope.reviewer.model, scope.reviewer.effort, proof.artifact_digest
    )))
}

pub(super) fn acceptance_evidence(
    conn: &Connection,
    goal: &Goal,
    work: &Work,
    artifact_digest: &str,
    principal: &str,
) -> Result<(Option<String>, bool)> {
    match require_pass(conn, goal, work, artifact_digest) {
        Ok(evidence) => Ok((evidence, false)),
        Err(error)
            if principal == conversation::OWNER_PRINCIPAL
                && error.downcast_ref::<apply::Rejected>().is_some() =>
        {
            Ok((None, true))
        }
        Err(error) => Err(error),
    }
}

pub(super) fn passing_check(evidence: String) -> Check {
    Check {
        id: CHECK.into(),
        passed: true,
        evidence,
    }
}

pub(super) fn acceptance_check(
    conn: &Connection,
    goal: &Goal,
    work: &Work,
    artifact_digest: &str,
) -> Result<Option<Check>> {
    Ok(require_pass(conn, goal, work, artifact_digest)?.map(passing_check))
}

pub(super) fn ready_for_verifier(conn: &Connection, work: &Work) -> Result<bool> {
    let Some(pin) = orchestra::assignment(conn, work)? else {
        return Ok(true);
    };
    if pin.reviewer.is_none() {
        return Ok(true);
    }
    let Some(execution) = &work.execution_id else {
        return Ok(false);
    };
    let Some(saved) = receipt(conn, execution)? else {
        return Ok(false);
    };
    Ok(saved.verdict == Verdict::Passed)
}

fn envelope(actor: &str, id: String, epoch: u64, body: Value) -> Result<Envelope> {
    Ok(Envelope {
        protocol_version: VERSION.into(),
        command_id: id.clone(),
        actor_ref: actor.into(),
        payload_digest: canonical_digest(&body)?,
        authority_epoch: epoch,
        expected_revision: None,
        correlation_id: id,
        body,
    })
}

fn prepare(
    host: &Host,
    conn: &Connection,
    goal: &Goal,
    work: &Work,
    scope: &Scope,
) -> Result<(Proof, Envelope)> {
    let (proof, artifact) = proof(conn, goal, work, scope)?;
    host.work_memory_verification_conn(conn, work)?;
    host.publication_work_conn(conn, work)?;
    let bytes = read_verified_pi_artifact(
        &host.root,
        conn,
        &scope.execution_id,
        &artifact.digest,
        Path::new(&artifact.locator),
    )?;
    ensure!(
        bytes.len() <= INPUT_LIMIT,
        "Review artifact exceeds the input bound"
    );
    // Preserve the exact UTF-8 artifact. No locator, Work context, verifier
    // command, transcript, or producer response summary is disclosed.
    let artifact = json!({"sha256":proof.artifact_digest,"text":std::str::from_utf8(&bytes)?});
    let mut required_checks = apply::required_checks(&goal.acceptance_spec)?;
    required_checks.remove(CHECK);
    let requirements = json!({"prompt":goal.prompt,"required_checks":required_checks});
    ensure!(
        serde_json::to_vec(&json!({"requirements":requirements,"artifact":artifact}))?.len()
            <= INPUT_LIMIT,
        "Review requirements and artifact exceed the input bound"
    );
    let body = json!({"method":"orchestra.review","selection":scope.reviewer,"requirements":requirements,"artifact":artifact});
    Ok((
        proof,
        envelope(
            ACTOR,
            format!("orchestra-review:{}", scope.execution_id),
            scope.epoch,
            body,
        )?,
    ))
}

fn current(host: &Host, conn: &Connection, saved: &Receipt) -> Result<()> {
    let work =
        db::work(conn, &saved.scope.work_id)?.ok_or_else(|| anyhow!("Review Work missing"))?;
    let goal =
        db::goal(conn, &saved.scope.goal_id)?.ok_or_else(|| anyhow!("Review Goal missing"))?;
    ensure!(
        !host.stopping.load(Ordering::Acquire)
            && host.authority_epoch == saved.scope.epoch
            && scope(conn, &goal, &work)?.as_ref() == Some(&saved.scope),
        "Review scope changed"
    );
    host.work_memory_verification_conn(conn, &work)?;
    host.publication_work_conn(conn, &work)?;
    ensure!(
        saved.proof.as_ref() == Some(&proof(conn, &goal, &work, &saved.scope)?.0),
        "Review result changed"
    );
    Ok(())
}

fn review_verdict(response: &Response) -> Verdict {
    if response.status != ResponseStatus::Success
        || response.error_code.is_some()
        || !response.artifacts.is_empty()
        || response.data.as_object().is_none_or(|data| data.len() != 3)
        || response.data["summary"]
            .as_str()
            .is_none_or(|text| text.trim().is_empty() || text.len() > 2000)
    {
        return Verdict::Unknown;
    }
    match response.data["verdict"].as_str() {
        Some("pass") => Verdict::Passed,
        Some("fail") => Verdict::Failed,
        _ => Verdict::Unknown,
    }
}

fn notice(conn: &Connection, saved: &Receipt, text: &str) -> Result<()> {
    let Some(goal) = db::goal(conn, &saved.scope.goal_id)? else {
        return Ok(());
    };
    let Some(work) = db::work(conn, &saved.scope.work_id)? else {
        return Ok(());
    };
    if goal.revision != saved.scope.goal_revision
        || work.owner_revision != saved.scope.owner_revision
        || work.execution_id.as_deref() != Some(saved.scope.execution_id.as_str())
        || work.state != "completed"
        || work.cancellation != "none"
    {
        return Ok(());
    }
    let privacy = conversation::conversation_privacy(
        conn,
        &goal.accountable_ghost,
        &goal.reply_conversation,
    )?;
    let id = format!("host-orchestra-review:{}", saved.scope.execution_id);
    conversation::append_turn(
        conn,
        &id,
        &goal.accountable_ghost,
        &goal.reply_conversation,
        "host",
        "host",
        &format!("Work {}. {text}", work.id),
        &privacy,
        "host_fact",
        None,
        &[],
    )?;
    Ok(())
}

enum Notice<'a> {
    Fact(&'a str),
    Report(&'a str),
}

fn enqueue_report(conn: &Connection, saved: &Receipt, text: &str) -> Result<()> {
    let goal =
        db::goal(conn, &saved.scope.goal_id)?.ok_or_else(|| anyhow!("Review Goal missing"))?;
    let source_id = format!("pi-result:{}", saved.scope.execution_id);
    let raw: String = conn.query_row(
        "SELECT request FROM lifetime_commands WHERE command_id=?1 AND json_extract(response,'$.status')='success'",
        [&source_id], |row| row.get(0),
    )?;
    let source: Envelope = serde_json::from_str(&raw)?;
    source.validate()?;
    ensure!(
        source.command_id == source_id
            && source.authority_epoch == saved.scope.epoch
            && source.body["method"] == "work.result"
            && source.body["execution_id"] == saved.scope.execution_id,
        "Review report has no original Pi result source"
    );
    let receiver = apply::outgoing(
        &source,
        &source.actor_ref,
        Some(goal.revision),
        json!({
            "method":"conversation.submit","ghost_id":goal.accountable_ghost,"conversation_id":goal.reply_conversation,
            "privacy":goal.privacy,"goal_id":goal.id,"goal_revision":goal.revision,
            "prompt":format!("Authenticated Host status for work_id={}. {text} Report the recorded review and pending acceptance to the Owner. Do not execute, delegate, or claim acceptance.", saved.scope.work_id),
        }),
    )?;
    conn.execute(
        "INSERT INTO lifetime_outbox(command_id,target,delivery_ref,payload) VALUES(?1,'pi',?2,?3)",
        params![
            source_id,
            receiver["command_id"].as_str(),
            receiver.to_string()
        ],
    )?;
    Ok(())
}

fn finalize(conn: &Connection, saved: &mut Receipt, message: Option<Notice<'_>>) -> Result<()> {
    saved.finalized = true;
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let updated = tx.execute(
        "UPDATE workspace_objects SET payload=?3 WHERE kind=?1 AND id=?2",
        params![
            KIND,
            saved.scope.execution_id,
            serde_json::to_string(saved)?
        ],
    )?;
    ensure!(updated == 1, "Original Orchestra review receipt missing");
    match message {
        Some(Notice::Fact(text)) => notice(&tx, saved, text)?,
        Some(Notice::Report(text)) => enqueue_report(&tx, saved, text)?,
        None => {}
    }
    tx.commit()?;
    Ok(())
}

fn finish_pass(host: &Host, conn: &Connection, saved: &mut Receipt) -> Result<()> {
    // On shutdown keep the confirmed verdict available for local continuation.
    if host.stopping.load(Ordering::Acquire) {
        return Ok(());
    }
    if current(host, conn, saved).is_err() {
        return finalize(
            conn,
            saved,
            Some(Notice::Fact(
                "Independent Orchestra review is stale. Host acceptance is pending.",
            )),
        );
    }
    let goal =
        db::goal(conn, &saved.scope.goal_id)?.ok_or_else(|| anyhow!("Review Goal missing"))?;
    let verifier = &goal.acceptance_spec["verifier"];
    if verifier["kind"] == "owner-task-verifier/1" {
        return finalize(conn, saved, None);
    }
    if verifier["kind"] == "pi-artifact/1" {
        let source = envelope(
            ACTOR,
            format!("orchestra-review-accept:{}", saved.scope.execution_id),
            saved.scope.epoch,
            Value::Null,
        )?;
        if host
            .verify_pi_work(conn, &source, &saved.scope.work_id)
            .is_ok_and(|response| response.status == ResponseStatus::Success)
        {
            return finalize(conn, saved, None);
        }
    }
    let proof = saved
        .proof
        .as_ref()
        .ok_or_else(|| anyhow!("Orchestra review proof missing"))?;
    let report = format!(
        "Independent Orchestra Pi review passed: {} / {} ({}) for immutable artifact {}. Owner acceptance or additional checks are pending.",
        saved.scope.reviewer.provider, saved.scope.reviewer.model, saved.scope.reviewer.effort, proof.artifact_digest,
    );
    finalize(conn, saved, Some(Notice::Report(&report)))
}

fn next_work(conn: &Connection) -> Result<Option<String>> {
    conn.query_row(
        "SELECT w.id FROM lifetime_work w JOIN lifetime_goals g ON g.id=w.goal_id AND g.revision=w.goal_revision
         JOIN workspace_objects pin ON pin.kind='orchestra_work_v1' AND pin.id=w.id||'/'||w.goal_revision||'/'||w.owner_revision
         LEFT JOIN workspace_objects r ON r.kind=?1 AND r.id=w.execution_id
         WHERE w.state='completed' AND w.cancellation='none' AND w.execution_id IS NOT NULL
         AND json_type(pin.payload,'$.reviewer')='object' AND (r.id IS NULL OR json_extract(r.payload,'$.finalized')=0)
         ORDER BY w.id LIMIT 1", [KIND], |row| row.get(0),
    ).optional().map_err(Into::into)
}

impl Host {
    pub(crate) async fn advance_orchestra_reviews(&self, launcher: &PiLauncher) -> Result<()> {
        let (mut saved, command) = {
            let state = self.lock()?;
            let conn = &state.journal.0;
            let authority = authority::current(conn)?;
            if self.stopping.load(Ordering::Acquire)
                || !authority.dispatch_enabled
                || authority.epoch != self.authority_epoch
            {
                return Ok(());
            }
            let Some(id) = next_work(conn)? else {
                return Ok(());
            };
            let work = db::work(conn, &id)?.ok_or_else(|| anyhow!("Review Work missing"))?;
            let goal =
                db::goal(conn, &work.goal_id)?.ok_or_else(|| anyhow!("Review Goal missing"))?;
            let scope =
                scope(conn, &goal, &work)?.ok_or_else(|| anyhow!("Review assignment missing"))?;
            if let Some(mut saved) = receipt(conn, &scope.execution_id)? {
                if saved.verdict == Verdict::Passed {
                    return finish_pass(self, conn, &mut saved);
                }
                // This continuation has a single in-flight job. Encountering a
                // started receipt means its original transport was interrupted.
                let message = if saved.verdict == Verdict::Blocked {
                    "Independent Orchestra review was blocked by the current disclosure, artifact, or provider requirements. Host acceptance is pending."
                } else {
                    saved.verdict = Verdict::Unknown;
                    "Independent Orchestra review is unconfirmed. Host acceptance is pending."
                };
                return finalize(conn, &mut saved, Some(Notice::Fact(message)));
            }
            let prepared = prepare(self, conn, &goal, &work, &scope);
            let mut saved = Receipt {
                scope,
                proof: None,
                input_digest: None,
                verdict: Verdict::Started,
                finalized: false,
            };
            let command = match prepared {
                Ok((proof, command)) => {
                    saved.proof = Some(proof);
                    saved.input_digest = Some(command.payload_digest.clone());
                    Some(command)
                }
                Err(_) => {
                    saved.verdict = Verdict::Blocked;
                    None
                }
            };
            conn.execute(
                "INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3)",
                params![
                    KIND,
                    saved.scope.execution_id,
                    serde_json::to_string(&saved)?
                ],
            )?;
            let Some(command) = command else {
                return finalize(conn, &mut saved, Some(Notice::Fact("Independent Orchestra review was blocked by the current disclosure, artifact, or provider requirements. Host acceptance is pending.")));
            };
            (saved, command)
        };
        let outcome = tokio::time::timeout(Duration::from_secs(90), async {
            let mut process =
                PiProcess::launch_orchestra_review(launcher, &self.root, saved.scope.epoch).await?;
            {
                let state = self.lock()?;
                current(self, &state.journal.0, &saved)?;
            }
            let response = process.request(&command).await?;
            process.close().await?;
            Ok::<_, anyhow::Error>(review_verdict(&response))
        })
        .await;
        let state = self.lock()?;
        let conn = &state.journal.0;
        saved.verdict = if current(self, conn, &saved).is_ok() {
            outcome
                .ok()
                .and_then(Result::ok)
                .unwrap_or(Verdict::Unknown)
        } else {
            Verdict::Unknown
        };
        match saved.verdict {
            Verdict::Passed => {
                // Persist the verdict first. On interruption only downstream
                // local acceptance resumes, without another reviewer request.
                conn.execute(
                    "UPDATE workspace_objects SET payload=?3 WHERE kind=?1 AND id=?2",
                    params![
                        KIND,
                        saved.scope.execution_id,
                        serde_json::to_string(&saved)?
                    ],
                )?;
                finish_pass(self, conn, &mut saved)
            }
            Verdict::Failed => finalize(
                conn,
                &mut saved,
                Some(Notice::Fact(
                    "Independent Orchestra review failed. Host acceptance is pending.",
                )),
            ),
            _ => finalize(
                conn,
                &mut saved,
                Some(Notice::Fact(
                    "Independent Orchestra review is unconfirmed. Host acceptance is pending.",
                )),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::pi_execution::tests::{publish_complete, setup_with_spec, Fixture};
    use super::*;

    async fn completed_fixture() -> Fixture {
        let f = setup_with_spec(json!({}));
        assert_eq!(
            publish_complete(&f, "Controlled artifact, line one.\nLine two.\n")
                .await
                .status,
            ResponseStatus::Success
        );
        let reviewer = Selection {
            provider: "zai-coding".into(),
            model: "glm-5.3".into(),
            effort: "high".into(),
        };
        f.host
            .configure_inference(
                &json!({"operation":"set_api_key","version":0,"provider":reviewer.provider,
            "api_key":"test-only-no-network"}),
            )
            .unwrap();
        let approved = f
            .host
            .configure_inference(&json!({"operation":"set_orchestra","version":1,
            "ghost_id":f.ghost,"conversation_id":f.conversation,"profile":{"reviewer":reviewer}}))
            .unwrap();
        let version = approved["settings"]["version"].as_u64().unwrap();
        {
            let state = f.host.lock().unwrap();
            let conn = &state.journal.0;
            let work = db::work(conn, &f.work).unwrap().unwrap();
            // The broader Host canary covers actual Owner turn/assignment
            // admission. These fixtures isolate the continuation and receipt.
            let pin = json!({"task":"direct","selection":Selection::default(),"reviewer":reviewer,"review_grant_version":version}).to_string();
            for (kind, id) in [
                ("orchestra_goal_v1", work.goal_id),
                ("orchestra_work_v1", format!("{}/1/1", f.work)),
            ] {
                conn.execute(
                    "INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3)",
                    params![kind, id, pin],
                )
                .unwrap();
            }
        }
        f
    }

    fn prepare_receipt(f: &Fixture, verdict: Verdict) -> (String, String) {
        let state = f.host.lock().unwrap();
        let conn = &state.journal.0;
        let work = db::work(conn, &f.work).unwrap().unwrap();
        let goal = db::goal(conn, &work.goal_id).unwrap().unwrap();
        let scope = scope(conn, &goal, &work).unwrap().unwrap();
        let (proof, command) = prepare(&f.host, conn, &goal, &work, &scope).unwrap();
        assert_eq!(
            command.body["artifact"],
            json!({"sha256":proof.artifact_digest,"text":"Controlled artifact, line one.\nLine two.\n"})
        );
        assert_eq!(
            command.body["requirements"],
            json!({"prompt":goal.prompt,"required_checks":[]})
        );
        assert!(!command.body.to_string().contains("Published fixture"));
        assert!(!command.body.to_string().contains("answer.txt"));
        let id = scope.execution_id.clone();
        let digest = proof.artifact_digest.clone();
        let saved = Receipt {
            scope,
            proof: Some(proof),
            input_digest: Some(command.payload_digest),
            verdict,
            finalized: false,
        };
        conn.execute(
            "INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3)",
            params![KIND, id, serde_json::to_string(&saved).unwrap()],
        )
        .unwrap();
        (id, digest)
    }

    #[tokio::test]
    async fn interrupted_attempt_becomes_unknown_once_without_launching_reviewer() {
        let f = completed_fixture().await;
        let (execution, _) = prepare_receipt(&f, Verdict::Started);
        let script = f.host.root.join("review-marker.mjs");
        let marker = f.host.root.join("unexpected-launch");
        std::fs::write(
            &script,
            format!(
                "import {{writeFileSync}} from 'node:fs'; writeFileSync({}, 'launched');",
                serde_json::to_string(&marker).unwrap()
            ),
        )
        .unwrap();
        let launcher = PiLauncher::NodeEntry(script);
        f.host.advance_orchestra_reviews(&launcher).await.unwrap();
        f.host.advance_orchestra_reviews(&launcher).await.unwrap();
        assert!(!marker.exists());
        let state = f.host.lock().unwrap();
        let conn = &state.journal.0;
        let saved = receipt(conn, &execution).unwrap().unwrap();
        assert_eq!(saved.verdict, Verdict::Unknown);
        assert!(saved.finalized);
        let facts:u64 = conn.query_row("SELECT COUNT(*) FROM lifetime_turns WHERE id=?1 AND kind='host_fact' AND text LIKE '%unconfirmed%'", [format!("host-orchestra-review:{execution}")], |r| r.get(0)).unwrap();
        assert_eq!(facts, 1);
        assert!(db::acceptance(conn, &f.work).unwrap().is_none());
    }

    #[tokio::test]
    async fn pass_is_bound_to_current_artifact_policy_and_conversation_privacy() {
        let f = completed_fixture().await;
        let (_, digest) = prepare_receipt(&f, Verdict::Passed);
        let state = f.host.lock().unwrap();
        let conn = &state.journal.0;
        let work = db::work(conn, &f.work).unwrap().unwrap();
        let goal = db::goal(conn, &work.goal_id).unwrap().unwrap();
        assert!(require_pass(conn, &goal, &work, &digest).unwrap().is_some());
        assert!(require_pass(conn, &goal, &work, &"0".repeat(64)).is_err());
        conn.execute(
            "UPDATE lifetime_verification_policy SET policy_revision=policy_revision+1",
            [],
        )
        .unwrap();
        assert!(require_pass(conn, &goal, &work, &digest).is_err());
        conn.execute(
            "UPDATE lifetime_verification_policy SET policy_revision=policy_revision-1",
            [],
        )
        .unwrap();
        assert!(require_pass(conn, &goal, &work, &digest).unwrap().is_some());
        conversation::persist_disclosure(conn, &f.ghost, &f.conversation, "private").unwrap();
        assert!(require_pass(conn, &goal, &work, &digest).is_err());
    }

    #[tokio::test]
    async fn failed_review_blocks_automatic_acceptance_but_preserves_owner_acceptance() {
        let f = completed_fixture().await;
        let (execution, digest) = prepare_receipt(&f, Verdict::Failed);
        let state = f.host.lock().unwrap();
        let conn = &state.journal.0;
        let saved = receipt(conn, &execution).unwrap().unwrap();
        let proof = saved.proof.unwrap();
        let acceptance = crate::lifetime_contract::Acceptance {
            work_id: f.work.clone(),
            goal_revision: saved.scope.goal_revision,
            requirement_digest: saved.scope.requirement_digest,
            artifact_digest: digest,
            verifier_revision: proof.verifier_revision,
            policy_revision: proof.policy_revision,
            checks: vec![Check {
                id: "owner_inspected".into(),
                passed: true,
                evidence: "Owner inspected this artifact.".into(),
            }],
        };
        let body = json!({"method":"work.accept","acceptance":acceptance});
        let automatic = envelope(
            "host-pi-verifier",
            "automatic-accept-after-fail".into(),
            1,
            body.clone(),
        )
        .unwrap();
        assert_eq!(
            super::super::apply(conn, &automatic, "host-pi-verifier")
                .unwrap()
                .status,
            ResponseStatus::Error
        );
        let owner = envelope("owner", "owner-accept-after-fail".into(), 1, body).unwrap();
        assert_eq!(
            super::super::apply(conn, &owner, "owner").unwrap().status,
            ResponseStatus::Success
        );
        let prompt: String = conn.query_row(
            "SELECT json_extract(payload,'$.body.prompt') FROM lifetime_outbox WHERE command_id=?1",
            [&owner.command_id], |r| r.get(0),
        ).unwrap();
        assert!(prompt.contains(
            "The Owner accepted this result. There is no current passing Orchestra review."
        ));
        assert!(!prompt.contains("Independent Orchestra Pi review passed"));
    }

    #[tokio::test]
    async fn revoked_reviewer_cannot_review_old_work_and_is_removed_on_revision() {
        let f = completed_fixture().await;
        let (execution, digest) = prepare_receipt(&f, Verdict::Passed);
        let version = f.host.inference_settings().unwrap()["settings"]["version"]
            .as_u64()
            .unwrap();
        f.host
            .configure_inference(&json!({"operation":"set_orchestra","version":version,
            "ghost_id":f.ghost,"conversation_id":f.conversation,"profile":null}))
            .unwrap();
        let state = f.host.lock().unwrap();
        let conn = &state.journal.0;
        let work = db::work(conn, &f.work).unwrap().unwrap();
        let goal = db::goal(conn, &work.goal_id).unwrap().unwrap();
        assert!(require_pass(conn, &goal, &work, &digest).is_err());
        assert!(receipt(conn, &execution).unwrap().is_some());
        let mut update = envelope("owner", "orchestra-revised-after-revocation".into(), 1,
            json!({"method":"goal.update","goal_id":goal.id,"prompt":"Publish the revised public artifact.","acceptance_spec":{}})).unwrap();
        update.expected_revision = Some(1);
        let revised = super::super::apply(conn, &update, "owner").unwrap();
        assert_eq!(revised.status, ResponseStatus::Success, "{revised:?}");
        let current = db::works_for_goal(conn, &goal.id)
            .unwrap()
            .into_iter()
            .find(|work| work.goal_revision == 2)
            .unwrap();
        assert!(orchestra::assignment(conn, &current)
            .unwrap()
            .unwrap()
            .reviewer
            .is_none());
    }
}
