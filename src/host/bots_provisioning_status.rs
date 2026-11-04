//! Durable provisioning certainty. Never log raw transport errors or replay an
//! interrupted external mutation just because its receipt is missing.
use super::*;
#[derive(Debug)]
pub(super) struct PrerequisiteUnavailable;
impl std::fmt::Display for PrerequisiteUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "provisioning prerequisite unavailable")
    }
}
impl std::error::Error for PrerequisiteUnavailable {}
#[derive(Debug)]
pub(super) struct KnownRejection;
impl std::fmt::Display for KnownRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "provisioning request requires an unsupported capability")
    }
}
impl std::error::Error for KnownRejection {}
#[derive(Debug)]
pub(super) struct EvidenceUnavailable;
impl std::fmt::Display for EvidenceUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "verified evaluation evidence unavailable")
    }
}
impl std::error::Error for EvidenceUnavailable {}
const CURSOR: &str = "bot_provisioning_cursor_v1";
#[derive(Debug)]
pub(super) struct EvaluationRejected;
impl std::fmt::Display for EvaluationRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "independent evaluation rejected verified bytes")
    }
}
impl std::error::Error for EvaluationRejected {}
#[derive(Debug)]
pub(super) struct ReconciliationRequired;
impl std::fmt::Display for ReconciliationRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "original provisioning phase requires reconciliation")
    }
}
impl std::error::Error for ReconciliationRequired {}
fn mutate(
    conn: &Connection,
    c: &Candidate,
    epoch: u64,
    f: impl FnOnce(&mut Progress) -> Result<()>,
) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    ensure!(
        crate::host::lifetime::authority::current(&tx)?.epoch == epoch,
        "provisioning status writer fenced"
    );
    let mut p = progress(&tx, &c.id)?;
    ensure!(
        p.candidate_digest == c.digest,
        "provisioning status candidate changed"
    );
    // A late failure cannot overwrite a completed operation or another revision.
    if p.state == "ready" {
        tx.commit()?;
        return Ok(());
    }
    f(&mut p)?;
    save(&tx, PROGRESS, &c.id, &p)?;
    crate::host::lifetime::record_bot_status(&tx, &c.id)?;
    tx.commit()?;
    Ok(())
}
pub(super) fn blocked(
    conn: &Connection,
    c: &Candidate,
    epoch: u64,
    state: &str,
    code: &str,
    stage: &str,
) -> Result<()> {
    mutate(conn, c, epoch, |p| {
        if matches!(p.state.as_str(), "failed" | "reconcile_required") {
            return Ok(());
        }
        p.state = state.into();
        p.receipts["blocker"] = json!(code);
        p.receipts["status"] = json!({"stage":stage,"code":code,"authority_epoch":epoch});
        Ok(())
    })
}
pub(super) fn phase(conn: &Connection, c: &Candidate, stage: &str) -> Result<Value> {
    Ok(progress(conn, &c.id)?.receipts["phases"][stage].clone())
}
pub(super) fn before_external(
    conn: &Connection,
    c: &Candidate,
    request: &Envelope,
    stage: &str,
    owner_retry: bool,
    observed: Option<Value>,
) -> Result<Option<Value>> {
    let prior = phase(conn, c, stage)?;
    ensure!(
        progress(conn, &c.id)?.state != "ready",
        "completed operation cannot start another phase"
    );
    if prior.is_object() {
        let original_id = prior["command_id"]
            .as_str()
            .ok_or_else(|| anyhow!("original provisioning command missing"))?;
        let raw: String = conn.query_row(
            "SELECT request FROM lifetime_commands WHERE command_id=?1",
            [original_id],
            |r| r.get(0),
        )?;
        let original: Envelope = serde_json::from_str(&raw)?;
        original.validate()?;
        ensure!(
            original.command_id == original_id
                && original.payload_digest == prior["payload_digest"]
                && original.authority_epoch == prior["authority_epoch"]
                && original.body["candidate_id"] == c.id
                && original.body["candidate_digest"] == c.digest,
            "original phase command identity changed"
        );
    }
    if prior["certainty"] == "known_complete" {
        if prior["authority_epoch"] == request.authority_epoch
            && observed.as_ref() == Some(&prior["receipt"])
        {
            return Ok(Some(prior["receipt"].clone()));
        }
        blocked(
            conn,
            c,
            request.authority_epoch,
            "reconcile_required",
            "provisioning_effect_unconfirmed",
            stage,
        )?;
        return Err(ReconciliationRequired.into());
    }
    if matches!(prior["certainty"].as_str(), Some("started" | "unknown")) {
        if owner_retry && prior["authority_epoch"] == request.authority_epoch {
            if let Some(receipt) = observed {
                mutate(conn, c, request.authority_epoch, |p| {
                    ensure!(
                        matches!(p.state.as_str(), "provisioning" | "reconcile_required")
                            && p.receipts["phases"][stage] == prior,
                        "original provisioning phase changed"
                    );
                    p.receipts["phases"][stage]["certainty"] = json!("known_complete");
                    p.receipts["phases"][stage]["receipt"] = receipt;
                    p.receipts["phases"][stage]["reconciled_by"] = json!(request.command_id);
                    p.state = "provisioning".into();
                    p.receipts["blocker"] = Value::Null;
                    Ok(())
                })?;
                return Ok(Some(phase(conn, c, stage)?["receipt"].clone()));
            }
        }
        blocked(
            conn,
            c,
            request.authority_epoch,
            "reconcile_required",
            "provisioning_effect_unconfirmed",
            stage,
        )?;
        return Err(ReconciliationRequired.into());
    }
    if let Some(receipt) = observed {
        mutate(conn, c, request.authority_epoch, |p| {
            ensure!(
                p.state == "provisioning",
                "existing resource proof is not an authorization to resume another state"
            );
            p.receipts["phases"][stage] = json!({"certainty":"known_complete","command_id":request.command_id,"payload_digest":request.payload_digest,"authority_epoch":request.authority_epoch,"receipt":receipt,"observed_existing":true});
            Ok(())
        })?;
        return Ok(Some(phase(conn, c, stage)?["receipt"].clone()));
    }
    mutate(conn, c, request.authority_epoch, |p| {
        ensure!(
            p.state == "provisioning",
            "provisioning is not resumable without original proof"
        );
        p.receipts["phases"][stage] = json!({"certainty":"started","command_id":request.command_id,"payload_digest":request.payload_digest,"authority_epoch":request.authority_epoch});
        p.receipts["blocker"] = Value::Null;
        Ok(())
    })?;
    Ok(None)
}
pub(super) fn complete_external(
    conn: &Connection,
    c: &Candidate,
    request: &Envelope,
    stage: &str,
    receipt: Value,
) -> Result<()> {
    mutate(conn, c, request.authority_epoch, |p| {
        let current = &p.receipts["phases"][stage];
        ensure!(
            current["command_id"] == request.command_id
                && current["payload_digest"] == request.payload_digest
                && current["authority_epoch"] == request.authority_epoch
                && current["certainty"] == "started",
            "provisioning receipt does not match the original phase"
        );
        p.receipts["phases"][stage]["certainty"] = json!("known_complete");
        p.receipts["phases"][stage]["receipt"] = receipt;
        Ok(())
    })
}
pub(super) fn uncertain(
    conn: &Connection,
    c: &Candidate,
    request: &Envelope,
    stage: &str,
) -> Result<()> {
    mutate(conn, c, request.authority_epoch, |p| {
        let current = &p.receipts["phases"][stage];
        if current["command_id"] != request.command_id
            || current["payload_digest"] != request.payload_digest
            || current["certainty"] != "started"
        {
            return Ok(());
        }
        p.receipts["phases"][stage]["certainty"] = json!("unknown");
        p.state = "reconcile_required".into();
        p.receipts["blocker"] = json!("provisioning_effect_unconfirmed");
        p.receipts["status"] = json!({"stage":stage,"code":"provisioning_effect_unconfirmed","authority_epoch":request.authority_epoch});
        Ok(())
    })
}
pub(super) fn driver_result(
    conn: &Connection,
    c: &Candidate,
    epoch: u64,
    stage: &str,
    result: Result<Value>,
) -> Result<()> {
    match result {
        Ok(value) if value["result"]["status"] == "success" => Ok(()),
        Ok(_) => blocked(conn, c, epoch, "failed", "provisioning_rejected", stage),
        Err(error) if error.downcast_ref::<ReconciliationRequired>().is_some() => Ok(()),
        Err(error) if error.downcast_ref::<KnownRejection>().is_some() => {
            blocked(conn, c, epoch, "failed", "unprovisioned_capability", stage)
        }
        Err(error) if error.downcast_ref::<PrerequisiteUnavailable>().is_some() => {
            if progress(conn, &c.id)?.receipts["blocker"].is_string() {
                Ok(())
            } else {
                blocked(
                    conn,
                    c,
                    epoch,
                    "provisioning",
                    "provisioning_prerequisite_unavailable",
                    stage,
                )
            }
        }
        Err(error) => Err(error),
    }
}
pub(super) fn next_ids(conn: &Connection) -> Result<Vec<String>> {
    let cursor: Option<Value> = load(conn, CURSOR, "workspace")?;
    let after = cursor
        .as_ref()
        .and_then(|v| v["after"].as_str())
        .unwrap_or("");
    let query="SELECT id FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.activation_requested')=1 AND json_extract(payload,'$.state') IN ('draft','evaluating','provisioning') AND id>?2 ORDER BY id LIMIT ?3";
    let mut stmt = conn.prepare(query)?;
    let mut ids = stmt
        .query_map(params![PROGRESS, after, 16], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if ids.len() < 16 && !after.is_empty() {
        let mut stmt=conn.prepare("SELECT id FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.activation_requested')=1 AND json_extract(payload,'$.state') IN ('draft','evaluating','provisioning') AND id<=?2 ORDER BY id LIMIT ?3")?;
        ids.extend(
            stmt.query_map(params![PROGRESS, after, 16 - ids.len()], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?,
        );
    }
    if let Some(last) = ids.last() {
        save(conn, CURSOR, "workspace", &json!({"after":last}))?;
    }
    Ok(ids)
}

#[cfg(test)]
pub(super) fn interrupt_after_effect(conn: &Connection, c: &Candidate, stage: &str) -> Result<()> {
    let fault: Option<Value> = load(conn, "bot_provisioning_test_fault", &c.id)?;
    if fault.as_ref().is_some_and(|v| v["stage"] == stage) {
        if let Some(fault) = fault.as_ref().filter(|v| v["behavior"] == "exit-process") {
            let parent = std::env::var_os("GHOST_A03_CRASH_PARENT")
                .map(std::path::PathBuf::from)
                .ok_or_else(|| anyhow!("A03 process exit requires its explicit private child root"))?;
            ensure!(parent.is_absolute() && parent.is_dir()
                && fault["parent_root"].as_str() == parent.to_str(),
                "A03 process exit root differs from its child invocation");
            // No unwinding, status projection, or destructors: the committed
            // phase remains started, as with actual process loss at this point.
            std::process::exit(73);
        }
        conn.execute(
            "DELETE FROM workspace_objects WHERE kind='bot_provisioning_test_fault' AND id=?1",
            [&c.id],
        )?;
        anyhow::bail!("simulated loss after external effect before receipt")
    }
    Ok(())
}

pub(super) fn runtime_ready(conn: &Connection, c: &Candidate, epoch: u64) -> Result<bool> {
    let command = format!("bot-phase/1:{}:{epoch}:bot.runtime.prepare", c.id);
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_bindings b JOIN lifetime_outbox o ON o.command_id=?3 AND o.target='pi' AND o.acknowledged=1 JOIN lifetime_delivery_receipts r ON r.outbox_id=o.id AND r.receiver_command_id=o.delivery_ref WHERE b.ghost_id=?1 AND b.conversation_id=?2 AND b.runtime_kind='pi-durable' AND b.runtime_release='1.1.0' AND length(b.storage_ref)>0 AND b.storage_ref NOT LIKE 'unresolved:%' AND json_extract(o.payload,'$.body.method')='conversation.ensure' AND json_extract(o.payload,'$.body.ghost_id')=b.ghost_id AND json_extract(o.payload,'$.body.conversation_id')=b.conversation_id AND json_extract(r.payload,'$.status')='success' AND json_extract(r.payload,'$.data.storage_ref')=b.storage_ref)",params![c.definition.ghost_id,c.conversation_id,command],|r|r.get(0))?)
}
pub(super) fn pending_runtime(
    conn: &Connection,
    c: &Candidate,
    epoch: u64,
    command: &str,
) -> Result<bool> {
    let response: Option<String> = conn
        .query_row(
            "SELECT response FROM lifetime_commands WHERE command_id=?1",
            [command],
            |r| r.get(0),
        )
        .optional()?;
    let Some(response) = response else {
        return Ok(false);
    };
    let response: Response = serde_json::from_str(&response)?;
    if response.status == ResponseStatus::Error {
        blocked(
            conn,
            c,
            epoch,
            "failed",
            "provisioning_rejected",
            "runtime_prepare",
        )?;
    } else {
        let outbox:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_outbox WHERE command_id=?1 AND target='pi' AND json_extract(payload,'$.body.method')='conversation.ensure' AND json_extract(payload,'$.body.ghost_id')=?2 AND json_extract(payload,'$.body.conversation_id')=?3)",params![command,c.definition.ghost_id,c.conversation_id],|r|r.get(0))?;
        blocked(
            conn,
            c,
            epoch,
            if outbox {
                "provisioning"
            } else {
                "reconcile_required"
            },
            if outbox {
                "runtime_prepare_pending"
            } else {
                "provisioning_effect_unconfirmed"
            },
            "runtime_prepare",
        )?;
    }
    Ok(true)
}
