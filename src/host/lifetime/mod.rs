//! Durable host ledger for the lifetime contract.
//!
//! The coordinator owns migrations 005–013 and calls these functions with the
//! existing workspace connection. This module never opens a database or does
//! runtime I/O while a SQLite transaction is held.

mod apply;
mod artifact;
mod assignments;
pub(crate) mod authority;
mod conversation;
mod delegation_contracts;
pub(crate) mod evaluation_inputs;
mod pi_wait;
mod db;
mod graph;
mod mailbox;
mod pi_tools;
pub(crate) mod work_context;
pub(crate) mod producer_profiles;
pub(crate) mod pi_execution;
mod outbox;
mod receipts;
mod selected_tasks;
mod reports;
mod snapshot;
mod turn_runs;

pub use outbox::OutboxItem;
pub(crate) use outbox::recoverable_assignment_blocker;
pub(crate) use selected_tasks::delivery_allowed as selected_task_delivery_allowed;
pub(crate) use pi_tools::{PiToolRequest, PiInferenceScope};
pub(crate) use pi_tools::guard as pi_tool_guard;

/// Opt-in live bridges honor the runtime's committed inference route exactly
/// like the production HTTP endpoints do (`/api/v1/pi/{,selected-,local-}action`):
/// the Pi runtime chooses the scope, and the callback frame carries it.
#[cfg(test)]
pub(crate) fn test_callback_inference_scope(frame: &serde_json::Value) -> PiInferenceScope {
    match frame["inference_scope"].as_str() {
        Some("selected") => PiInferenceScope::Selected,
        Some("local") => PiInferenceScope::Local,
        _ => PiInferenceScope::Public,
    }
}

/// A creation result is a Host fact, independent of the model's earlier
/// evaluating reply. Caller writes the verified state and this fact together.
pub(crate) fn record_bot_status(conn: &Connection, candidate_id: &str) -> Result<()> {
    use anyhow::ensure;
    use rusqlite::params;
    let candidate=super::bots_provisioning::candidate(conn,candidate_id)?;
    let progress=super::bots_provisioning::progress(conn,candidate_id)?;
    let (Some(source),Some(issuer))=(&candidate.intent_turn_id,&candidate.issuer_ghost) else {return Ok(())};
    let text=match progress.state.as_str() {
        "failed" if progress.receipts["blocker"]=="independent_evaluation_failed"=>"The bot failed its independent evaluation and has not been activated.",
        "failed"=>"The bot could not finish preparation and has not been activated.",
        "reconcile_required"=>"The original bot preparation result requires reconciliation before it can continue.",
        "ready"=>"The bot passed its independent evaluation and is ready for new work.",
        _=>return Ok(()),
    };
    let (ghost,conversation,sender,reference,kind,source_privacy)=conversation::turn_scope(conn,source)?
        .ok_or_else(||anyhow::anyhow!("bot status has no original Owner turn"))?;
    ensure!(ghost==*issuer && sender=="owner" && reference=="owner" && kind=="user",
        "bot status source is not the original authenticated Owner");
    let id=format!("host-bot-status/1:{candidate_id}:{}",progress.state);
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_turns WHERE id=?1)",[&id],|r|r.get(0))?;
    if exists {
        let exact:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_turns WHERE id=?1 AND ghost_id=?2 AND conversation_id=?3 AND source_turn_id=?4 AND sender_kind='host' AND sender_ref='host' AND kind='host_fact' AND text=?5)",params![id,ghost,conversation,source,text],|r|r.get(0))?;
        ensure!(exact,"bot status fact conflicts with its original receipt");return Ok(());
    }
    let mut privacy=conversation::conversation_privacy(conn,&ghost,&conversation)?;
    conversation::raise_privacy(&mut privacy,&source_privacy)?;
    conversation::raise_privacy(&mut privacy,&candidate.privacy)?;
    conversation::persist_disclosure(conn,&ghost,&conversation,&privacy)?;
    conversation::append_turn(conn,&id,&ghost,&conversation,"host","host",text,&privacy,"host_fact",Some(source),&[])?;
    Ok(())
}

pub(crate) fn bot_repair_report_goal(conn:&Connection,report_id:&str,ghost:&str,conversation:&str)->Result<crate::lifetime_contract::Goal> {
    reports::bot_repair_goal(conn,report_id,ghost,conversation)
}

pub(crate) fn artifact_read(conn: &Connection, computers: Option<&super::lifetime_computers::NativeComputers>, pi_root: &std::path::Path,
    body: &Value) -> Result<Response> {
    artifact::read_work_artifact(conn, computers, pi_root, body)
}

pub(crate) fn pi_tool_apply(conn: &Connection, request: &PiToolRequest, scope: PiInferenceScope,
    computers: Option<&super::lifetime_computers::NativeComputers>) -> Result<Response> {
    pi_tools::apply(conn, request, scope, computers)
}

/// Whether one Work's delegation graph scope is still current. The owner
/// decision resume refuses to wake an execution whose Work is stale.
pub(crate) fn work_scope_current(conn: &Connection, work_id: &str) -> Result<bool> {
    let Some(work) = db::work(conn, work_id)? else { return Ok(false); };
    graph::current_result_scope(conn, &work)
}

/// Every committed protected context fences external inference, including
/// legacy Goal-driven conversations which have no canonical registry row.
pub(crate) fn conversation_is_public(conn: &Connection, ghost_id: &str, conversation_id: &str) -> Result<bool> {
    conn.query_row(
        "SELECT NOT (
          EXISTS(SELECT 1 FROM lifetime_goals WHERE reply_conversation=?2 AND privacy<>'public')
          OR EXISTS(SELECT 1 FROM lifetime_turns WHERE ghost_id=?1 AND conversation_id=?2 AND privacy<>'public')
          OR EXISTS(SELECT 1 FROM lifetime_conversation_disclosure WHERE ghost_id=?1 AND conversation_id=?2 AND privacy<>'public'))",
        rusqlite::params![ghost_id, conversation_id], |row| row.get(0),
    ).map_err(Into::into)
}

/// Admission-time source disclosure persists before any model can read Work
/// context. It never rewrites the Goal's Owner classification or a Work pin.
pub(crate) fn persist_work_disclosure(conn:&Connection,work:&crate::lifetime_contract::Work,privacy:&str)->Result<()> {
    if privacy=="public" {return Ok(());}
    let goal=db::goal(conn,&work.goal_id)?.ok_or_else(||anyhow::anyhow!("Work disclosure Goal missing"))?;
    conversation::persist_disclosure(conn,&goal.accountable_ghost,&goal.reply_conversation,privacy)
}

pub(crate) fn assignment_is_public_for_delivery(
    conn: &Connection,
    receiver: &Envelope,
) -> Result<bool> {
    if let Some(work)=receiver.body["work_id"].as_str() {
        if super::work_memory::requires_private_delivery(conn,work)? {return Ok(false);}
    }
    assignments::delivery_is_public(conn, receiver)
}

pub(crate) fn worker_dispatch_privacy(conn: &Connection, work_id: &str) -> Result<Option<String>> {
    let Some(work) = db::work(conn, work_id)? else { return Ok(None); };
    if work.cancellation != "none"
        || matches!(work.state.as_str(), "accepted" | "failed" | "cancelled" | "stale")
        || !graph::current_result_scope(conn, &work)?
    {
        return Ok(None);
    }
    let goal = db::goal(conn, &work.goal_id)?
        .ok_or_else(|| anyhow::anyhow!("lifetime work references a missing goal"))?;
    let mut privacy = conversation::conversation_privacy(
        conn, &goal.accountable_ghost, &goal.reply_conversation,
    )?;
    conversation::raise_privacy(&mut privacy, &goal.privacy)?;
    Ok(Some(privacy))
}
use crate::lifetime_contract::{Envelope, Response, Snapshot};
use anyhow::Result;
use rusqlite::Connection;
use serde_json::Value;

/// Interpret one lifetime ledger command atomically. Historical `work.submit`
/// is retained here for legacy journal fixtures and reconciliation. Live
/// callers must use the Host façade: both authenticated ingress paths retire
/// fresh OMP admission, and the driver never dispatches old submit intents.
pub fn apply(
    conn: &Connection,
    envelope: &Envelope,
    principal: &str,
) -> Result<Response> {
    apply::apply(conn, envelope, principal, |_| Ok(None))
}

/// Fresh effect admission follows fence and exact cached-receipt checks.
pub(crate) fn apply_with_admission(conn: &Connection, envelope: &Envelope, principal: &str,
    admission: impl FnOnce(&Connection) -> Result<Option<Response>>) -> Result<Response> {
    apply::apply(conn, envelope, principal, admission)
}

/// Return the typed projection of the lifetime ledger.
pub fn snapshot(conn: &Connection) -> Result<Snapshot> {
    snapshot::snapshot(conn)
}

/// Return durable commands not yet acknowledged by their receiver.
pub fn pending_outbox(conn: &Connection) -> Result<Vec<OutboxItem>> {
    outbox::pending_outbox(conn)
}

/// Mark a command delivered only after its receiver has durably accepted it.
pub fn ack_outbox(conn: &Connection, id: i64, receipt: &Value) -> Result<()> {
    outbox::ack_outbox(conn, id, receipt)
}

pub(crate) mod task_contracts;

pub(crate) mod task_verification;
