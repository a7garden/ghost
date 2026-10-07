//! Native call metadata in the existing profile DB. Task/outbox/final provider
//! receipt commit together. This is activity state, never a credential store.
use crate::provider_control::{ProviderDescriptor, StreamEvent, TokenUsage};
use crate::store::{ProfileStore, Task};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS provider_runs(
 task_id INTEGER PRIMARY KEY REFERENCES tasks(id),
 attempt_id TEXT NOT NULL UNIQUE,
 profile_uuid TEXT NOT NULL, task_uuid TEXT NOT NULL,
 session_uuid TEXT NOT NULL, message_id TEXT NOT NULL,
 provider_id TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL,
 state TEXT NOT NULL, failure TEXT, usage_json TEXT,
 dispatch_started INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS provider_events(
 task_id INTEGER NOT NULL REFERENCES provider_runs(task_id),
 seq INTEGER NOT NULL, event_json TEXT NOT NULL,
 PRIMARY KEY(task_id,seq)
);
"#;

pub(crate) fn begin(
    store: &ProfileStore,
    task: &Task,
    descriptor: &ProviderDescriptor,
    attempt: &str,
) -> Result<()> {
    store.conn.execute_batch(SCHEMA)?;
    store.conn.execute(
        "INSERT INTO provider_runs(task_id,attempt_id,profile_uuid,task_uuid,session_uuid,message_id,provider_id,model,endpoint,state) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'prepared')",
        params![task.id,attempt,store.uuid,task.uuid,task.session_id,task.message_id,descriptor.provider_id,descriptor.model,descriptor.endpoint],
    )?;
    Ok(())
}

pub(crate) fn event(
    store: &ProfileStore,
    task: &Task,
    sequence: &mut usize,
    event: &StreamEvent,
) -> Result<()> {
    if *sequence >= 2050 {
        bail!("provider event journal limit exceeded");
    }
    let encoded = serde_json::to_string(event)?;
    if encoded.len() > 524_288 {
        bail!("provider event size limit exceeded");
    }
    let tx = store.conn.unchecked_transaction()?;
    if matches!(event, StreamEvent::DispatchStarted) {
        let changed=tx.execute("UPDATE provider_runs SET state='dispatched',dispatch_started=1 WHERE task_id=?1 AND state='prepared'",params![task.id])?;
        if changed != 1 {
            bail!("provider dispatch must be recorded exactly once");
        }
    }
    if let StreamEvent::Usage(usage) = event {
        tx.execute(
            "UPDATE provider_runs SET usage_json=?1 WHERE task_id=?2",
            params![serde_json::to_string(usage)?, task.id],
        )?;
    }
    tx.execute(
        "INSERT INTO provider_events(task_id,seq,event_json) VALUES(?1,?2,?3)",
        params![task.id, *sequence as i64, encoded],
    )?;
    tx.commit()?;
    *sequence += 1;
    Ok(())
}

pub(crate) fn finish(
    store: &ProfileStore,
    task: &Task,
    status: &str,
    output: &str,
    usage: Option<&TokenUsage>,
    failure: Option<&str>,
) -> Result<()> {
    if !matches!(
        status,
        "completed" | "failed" | "denied" | "uncertain" | "cancelled"
    ) {
        bail!("invalid provider terminal status");
    }
    let tx = store.conn.unchecked_transaction()?;
    let changed = tx.execute(
        "UPDATE tasks SET status=?1,output=?2,updated_at=?3 WHERE id=?4 AND status='running'",
        params![status, output, now(), task.id],
    )?;
    if changed != 1 {
        bail!("provider task is not running");
    }
    let changed=tx.execute("UPDATE provider_runs SET state=?1,failure=?2,usage_json=COALESCE(?3,usage_json) WHERE task_id=?4 AND task_uuid=?5 AND profile_uuid=?6",
        params![status,failure,usage.map(serde_json::to_string).transpose()?,task.id,task.uuid,store.uuid])?;
    if changed != 1 {
        bail!("provider receipt correlation mismatch");
    }
    tx.execute("INSERT INTO outbox(task_id,task_uuid,message_id,session_id,profile_uuid,content,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![task.id,task.uuid,task.message_id,task.session_id,store.uuid,output,status,now()])?;
    tx.execute(
        "INSERT INTO audit(task_id,event,detail,at) VALUES(?1,?2,?3,?4)",
        params![
            task.id,
            format!("task_{status}"),
            failure.unwrap_or("native completion receipt committed"),
            now()
        ],
    )?;
    tx.commit()?;
    Ok(())
}

fn now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string()
}

#[derive(Debug, Serialize)]
pub struct ProviderRun {
    pub attempt_id: String,
    pub profile_uuid: String,
    pub task_uuid: String,
    pub session_uuid: String,
    pub message_id: String,
    pub provider_id: String,
    pub model: String,
    pub endpoint: String,
    /// Canonical task status, including existing crash recovery's uncertain.
    pub status: String,
    /// Last durable transport phase; dispatched is not completion evidence.
    pub attempt_state: String,
    pub failure: Option<String>,
    pub usage: Option<TokenUsage>,
    pub dispatch_started: bool,
    pub events: Vec<serde_json::Value>,
}

/// Read-only projection. Existing ProfileStore recovery is the authority for
/// interrupted task state; a stale dispatched phase cannot authorize replay.
pub fn receipt(store: &ProfileStore, task_uuid: &str) -> Result<Option<ProviderRun>> {
    let exists: bool = store.conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_runs')",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(None);
    }
    let row=store.conn.query_row(
        "SELECT p.attempt_id,p.profile_uuid,p.task_uuid,p.session_uuid,p.message_id,p.provider_id,p.model,p.endpoint,t.status,p.state,p.failure,p.usage_json,p.dispatch_started,t.id \
         FROM provider_runs p JOIN tasks t ON t.id=p.task_id WHERE p.task_uuid=?1 AND p.profile_uuid=?2",
        params![task_uuid,store.uuid], |r| Ok((ProviderRun {
            attempt_id:r.get(0)?,profile_uuid:r.get(1)?,task_uuid:r.get(2)?,session_uuid:r.get(3)?,message_id:r.get(4)?,
            provider_id:r.get(5)?,model:r.get(6)?,endpoint:r.get(7)?,status:r.get(8)?,attempt_state:r.get(9)?,
            failure:r.get(10)?,usage:None,dispatch_started:r.get(12)?,events:Vec::new(),
        },r.get::<_,Option<String>>(11)?,r.get::<_,i64>(13)?))
    ).optional()?;
    let Some((mut result, usage, task_id)) = row else {
        return Ok(None);
    };
    result.usage = usage.map(|s| serde_json::from_str(&s)).transpose()?;
    if result.status == "uncertain"
        && matches!(result.attempt_state.as_str(), "prepared" | "dispatched")
    {
        result.failure = Some("interrupted; no automatic replay".into());
    }
    let mut statement = store
        .conn
        .prepare("SELECT event_json FROM provider_events WHERE task_id=?1 ORDER BY seq")?;
    let rows = statement.query_map(params![task_id], |r| r.get::<_, String>(0))?;
    for row in rows {
        result.events.push(serde_json::from_str(&row?)?);
    }
    Ok(Some(result))
}
