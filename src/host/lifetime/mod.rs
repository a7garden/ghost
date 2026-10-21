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
mod db;
mod graph;
mod mailbox;
mod pi_tools;
mod outbox;
mod receipts;
mod reports;
mod snapshot;
mod turn_runs;

pub use outbox::OutboxItem;
pub(crate) use pi_tools::{PiToolRequest, PiInferenceScope};
pub(crate) use pi_tools::guard as pi_tool_guard;

pub(crate) fn artifact_read(conn: &Connection, computers: Option<&super::lifetime_computers::NativeComputers>,
    body: &Value) -> Result<Response> {
    artifact::read_work_artifact(conn, computers, body)
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

pub(crate) fn assignment_is_public_for_delivery(
    conn: &Connection,
    receiver: &Envelope,
) -> Result<bool> {
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

/// Apply one authenticated lifetime command atomically to the existing Host DB.
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
