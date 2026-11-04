//! Scoped owner read of one immutable work artifact (`work.artifact`).
//!
//! This is an owner-surface read: it never creates effects and never enters
//! the command receipt table (large payloads must not be retained in
//! receipts). Bytes are returned only when every binding holds: the execution
//! is the Work's current attempt, the Work carries the current requirement
//! revision, the execution's stored ledger result is CURRENT under that
//! revision (same currency rules the Host applies to results), and the exact
//! digest/locator pair appears in that current result. The bytes themselves
//! are read through the worker journal's verified artifact primitive, which
//! enforces the existing publication bound and hash discipline.

use super::apply::{exact_fields, string_field, validate_identity};
use super::db;
use crate::lifetime_contract::{Artifact, Response, ResponseStatus, RetryClass};
use anyhow::{bail, Result, anyhow};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

pub(super) fn read_work_artifact(
    conn: &Connection,
    computers: Option<&super::super::lifetime_computers::NativeComputers>,
    pi_root: &Path,
    body: &Value,
) -> Result<Response> {
    exact_fields(body, &["method", "work_id", "execution_id", "digest", "locator"])?;
    let work_id = string_field(body, "work_id")?;
    let execution_id = string_field(body, "execution_id")?;
    let digest = string_field(body, "digest")?;
    let locator = string_field(body, "locator")?;
    validate_identity("work_id", work_id)?;
    validate_identity("execution_id", execution_id)?;
    let unavailable = |summary: String| {
        Ok(Response {
            status: ResponseStatus::Error,
            summary,
            object_refs: vec![],
            artifacts: vec![],
            next_actions: vec!["inspect_current_work_state".to_owned()],
            error_code: Some("artifact_unavailable".to_owned()),
            retry_class: RetryClass::Never,
            data: Value::Null,
        })
    };
    // Same ledger projection the Host's own result currency check uses: one
    // work row per committed execution attempt.
    let work: Option<crate::lifetime_contract::Work> = conn
        .query_row(
            "SELECT payload FROM lifetime_work WHERE execution_id=?1",
            [execution_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|raw| serde_json::from_str(&raw))
        .transpose()?;
    let Some(work) = work else {
        return unavailable("execution has no admitted work in the Host ledger".into());
    };
    if work.id != work_id {
        return unavailable("the requested Work does not hold this execution".into());
    }
    if work.execution_id.as_deref() != Some(execution_id) {
        return unavailable("the execution is not this Work's current attempt".into());
    }
    let Some(goal) = db::goal(conn, &work.goal_id)? else {
        bail!("lifetime work references a missing Goal");
    };
    if work.goal_revision != goal.revision {
        return unavailable("the Work requirement revision is stale; open the artifact of the current requirement instead".into());
    }
    // The execution's latest stored result, current only under the same rules
    // the Host applies to results (revisions, cancellation, graph scope).
    let record: Option<String> = conn
        .query_row(
            "SELECT payload FROM lifetime_results WHERE execution_id=?1",
            [execution_id],
            |row| row.get(0),
        )
        .optional()?;
    let record: Value = match record.map(|raw| serde_json::from_str(&raw)).transpose() {
        Ok(record) => record.unwrap_or(Value::Null),
        Err(error) => return unavailable(format!("the stored result could not be read: {error}")),
    };
    if record.get("current") != Some(&Value::Bool(true)) {
        return unavailable("the execution has a stored result, but it is not current".into());
    }
    let event = &record["event"];
    let result_revision = event.get("goal_revision").and_then(Value::as_u64).unwrap_or_default();
    if result_revision != goal.revision {
        return unavailable("the stored result belongs to a superseded requirement revision".into());
    }
    if work.cancellation != "none" || event.get("state").and_then(Value::as_str) == Some("cancelled") {
        return unavailable("the execution was cancelled; its artifacts stay metadata-only".into());
    }
    if !super::graph::current_result_scope(conn, &work)? {
        return unavailable("the work's delegation graph scope is no longer current".into());
    }
    let Some(items) = event.get("artifacts").and_then(Value::as_array) else {
        return unavailable("the current result reported no artifacts".into());
    };
    let artifact = items.iter().find(|item| {
        item.get("digest").and_then(Value::as_str) == Some(digest)
            && item.get("locator").and_then(Value::as_str) == Some(locator)
            && item.get("producing_attempt").and_then(Value::as_str) == Some(execution_id)
    });
    let Some(artifact) = artifact.and_then(|value| serde_json::from_value::<Artifact>(value.clone()).ok()) else {
        return unavailable("the digest/locator pair does not name an artifact of the current result".into());
    };
    let pi: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_pi_executions WHERE work_id=?1 AND execution_id=?2)",
        params![work_id, execution_id], |row| row.get(0))?;
    if pi {
        let bytes = match crate::worker::journal::read_verified_pi_artifact(pi_root.parent().ok_or_else(||anyhow!("Pi Host root missing"))?,conn,execution_id,digest,Path::new(locator)) {
            Ok(bytes)=>bytes, Err(error)=>return unavailable(format!("Pi immutable artifact verification refused this read: {error}")),
        };
        return Ok(Response { status:ResponseStatus::Success,summary:"Current Pi artifact verified".into(),object_refs:vec![work.id,goal.id],artifacts:vec![artifact.clone()],next_actions:vec![],error_code:None,retry_class:RetryClass::SameId,
            data:json!({"work_id":work_id,"execution_id":execution_id,"goal_revision":goal.revision,"digest":digest,"privacy":artifact.privacy,"byte_length":bytes.len(),"encoding":"base64","data":STANDARD.encode(bytes)}) });
    }
    let Some(computers) = computers else {
        return unavailable("owner artifact reads require the native worker route on this host".into());
    };
    let socket = computers
        .socket_for_execution(conn, work_id, &work.owner, execution_id)
        .map_err(|error| anyhow!("worker route provenance is ambiguous: {error}"))?;
    let worker_root = match socket {
        Some(socket) => socket.parent().map(Path::to_path_buf),
        None => None,
    };
    let Some(worker_root) = worker_root else {
        return unavailable("the producing worker route is not registered on this host".into());
    };
    let bytes = match crate::worker::journal::read_verified_artifact(&worker_root, execution_id, digest, Path::new(locator)) {
        Ok(bytes) => bytes,
        Err(error) => return unavailable(format!("immutable artifact verification refused this read: {error}")),
    };
    Ok(Response {
        status: ResponseStatus::Success,
        summary: "current work artifact verified and returned".into(),
        object_refs: vec![work.id.clone(), goal.id.clone()],
        next_actions: vec![],
        error_code: None,
        retry_class: RetryClass::SameId,
        data: json!({
            "work_id": work.id,
            "goal_id": goal.id,
            "goal_revision": goal.revision,
            "execution_id": execution_id,
            "digest": digest,
            "privacy": artifact.privacy,
            "byte_length": bytes.len(),
            "encoding": "base64",
            "data": STANDARD.encode(bytes),
        }),
        artifacts: vec![artifact],
    })
}
