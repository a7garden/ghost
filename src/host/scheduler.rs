//! Host-owned timer metadata. Stable occurrence IDs bridge timer and runtime
//! commits without claiming an atomic transaction across their databases.
use crate::domain::{
    protocol::{self, Event, Message},
    Delegation,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct Schedule {
    pub id: String,
    pub profile_id: String,
    pub conversation_id: String,
    pub prompt: String,
    pub interval_seconds: u64,
    pub next_run_ms: u64,
    pub paused: bool,
    pub last_task_id: Option<String>,
}
pub(crate) struct Journal(pub(crate) Connection);
impl Journal {
    pub fn open(path: &Path) -> Result<Self> {
        if path.is_symlink() {
            bail!("workspace database must not be a symlink");
        }
        let conn = Connection::open(path)?;
        let version: u64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > 4 {
            bail!("unsupported workspace schema version");
        }
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS workspace_commands(id TEXT PRIMARY KEY, payload TEXT NOT NULL, response TEXT);
            CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
                prompt TEXT NOT NULL, interval_seconds INTEGER NOT NULL, next_run_ms INTEGER NOT NULL,
                paused INTEGER NOT NULL DEFAULT 0, last_task_id TEXT);
            CREATE TABLE IF NOT EXISTS workspace_objects(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS collaboration_messages(delegation TEXT NOT NULL,event_key TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(delegation,event_key),UNIQUE(delegation,sequence));
")?;
        #[cfg(feature = "caldav")]
        super::planner_sync::initialize(&conn)?;
        #[cfg(not(feature = "caldav"))]
        if version < 3 {
            conn.execute_batch("PRAGMA user_version=3;")?;
        }
        Ok(Self(conn))
    }
    /// Commit an intent before changing another store. A lost response may be
    /// recovered; an interrupted command never blindly reissues a policy change.
    pub fn begin(&self, id: &str, payload: &str) -> Result<Option<Value>> {
        let old: Option<(String, Option<String>)> = self
            .0
            .query_row(
                "SELECT payload,response FROM workspace_commands WHERE id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((previous, response)) = old {
            if previous != payload {
                bail!("request id collision with different command");
            }
            return match response {
                Some(value) => Ok(Some(serde_json::from_str(&value)?)),
                None => anyhow::bail!(
                    "command interrupted; inspect the saved state before issuing a new request"
                ),
            };
        }
        self.0.execute(
            "INSERT INTO workspace_commands VALUES(?,?,NULL)",
            params![id, payload],
        )?;
        Ok(None)
    }
    pub fn finish(&self, id: &str, response: &Value) -> Result<()> {
        self.0.execute(
            "UPDATE workspace_commands SET response=? WHERE id=? AND response IS NULL",
            params![response.to_string(), id],
        )?;
        Ok(())
    }
    pub fn add(&self, schedule: &Schedule) -> Result<()> {
        if !(60..=31_536_000).contains(&schedule.interval_seconds) {
            bail!("repeat interval must be between 60 seconds and one year");
        }
        self.0.execute("INSERT INTO schedules(id,profile_id,conversation_id,prompt,interval_seconds,next_run_ms) VALUES(?,?,?,?,?,?)",
            params![schedule.id,schedule.profile_id,schedule.conversation_id,schedule.prompt,schedule.interval_seconds,schedule.next_run_ms])?;
        Ok(())
    }
    pub fn list(&self) -> Result<Vec<Schedule>> {
        let mut stmt = self.0.prepare("SELECT id,profile_id,conversation_id,prompt,interval_seconds,next_run_ms,paused,last_task_id FROM schedules ORDER BY rowid")?;
        let rows = stmt.query_map([], |r| {
            Ok(Schedule {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                conversation_id: r.get(2)?,
                prompt: r.get(3)?,
                interval_seconds: r.get(4)?,
                next_run_ms: r.get(5)?,
                paused: r.get(6)?,
                last_task_id: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn pause(&self, id: &str, paused: bool, now: u64) -> Result<()> {
        // Resuming starts a new interval; missed occurrences are not backfilled.
        let n = self.0.execute("UPDATE schedules SET paused=?,next_run_ms=CASE WHEN ?=0 THEN ?+interval_seconds*1000 ELSE next_run_ms END WHERE id=?",
            params![paused,paused,now,id])?;
        if n == 0 {
            bail!("schedule missing");
        }
        Ok(())
    }
    pub fn delivered(&self, schedule: &Schedule, task: &str, now: u64) -> Result<()> {
        self.0.execute("UPDATE schedules SET next_run_ms=?,last_task_id=? WHERE id=? AND next_run_ms=? AND paused=0",
            params![now.saturating_add(schedule.interval_seconds*1000),task,schedule.id,schedule.next_run_ms])?;
        Ok(())
    }
    pub fn get<T: serde::de::DeserializeOwned>(&self, kind: &str, id: &str) -> Result<Option<T>> {
        let value: Option<String> = self
            .0
            .query_row(
                "SELECT payload FROM workspace_objects WHERE kind=? AND id=?",
                params![kind, id],
                |r| r.get(0),
            )
            .optional()?;
        value
            .map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }
    pub fn put(&self, kind: &str, id: &str, value: &impl Serialize) -> Result<()> {
        self.0.execute("INSERT INTO workspace_objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",params![kind,id,serde_json::to_string(value)?])?;
        Ok(())
    }
    pub fn objects<T: serde::de::DeserializeOwned>(&self, kind: &str) -> Result<Vec<T>> {
        let mut q = self
            .0
            .prepare("SELECT payload FROM workspace_objects WHERE kind=? ORDER BY id")?;
        let rows = q.query_map([kind], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn delete(&self, kind: &str, id: &str) -> Result<()> {
        self.0.execute(
            "DELETE FROM workspace_objects WHERE kind=? AND id=?",
            params![kind, id],
        )?;
        Ok(())
    }
    /// Exact retries return the original identity and timestamp. Payload
    /// collisions are rejected; append and sequence allocation are atomic.
    pub fn message(&self, record: &Delegation, key: &str, event: Event) -> Result<Message> {
        event.validate()?;
        if key.is_empty() || key.len() > 400 {
            bail!("invalid collaboration event identity");
        }
        let transaction = self.0.unchecked_transaction()?;
        let old: Option<String> = transaction
            .query_row(
                "SELECT payload FROM collaboration_messages WHERE delegation=? AND event_key=?",
                params![record.id, key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            let old: Message = serde_json::from_str(&old)?;
            old.validate()?;
            let (from, to) = if event.reply() {
                (&record.target, &record.owner)
            } else {
                (&record.owner, &record.target)
            };
            if old.event != event || old.from != *from || old.to != *to {
                bail!("collaboration message identity collision");
            }
            return Ok(old);
        }
        let sequence: u64 = transaction.query_row(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM collaboration_messages WHERE delegation=?",
            [&record.id],
            |r| r.get(0),
        )?;
        let reply = event.reply();
        let message = Message {
            protocol: protocol::VERSION.into(),
            message_id: uuid::Uuid::now_v7().to_string(),
            correlation_id: uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, record.id.as_bytes())
                .to_string(),
            sequence,
            from: if reply {
                record.target.clone()
            } else {
                record.owner.clone()
            },
            to: if reply {
                record.owner.clone()
            } else {
                record.target.clone()
            },
            created_ms: super::now_ms(),
            event,
        };
        message.validate()?;
        transaction.execute(
            "INSERT INTO collaboration_messages VALUES(?,?,?,?)",
            params![record.id, key, sequence, serde_json::to_string(&message)?],
        )?;
        transaction.commit()?;
        Ok(message)
    }
    pub fn messages(&self, delegation: &str, after: u64) -> Result<Vec<Message>> {
        let mut query=self.0.prepare("SELECT payload FROM collaboration_messages WHERE delegation=? AND sequence>? ORDER BY sequence LIMIT 200")?;
        let rows = query.query_map(params![delegation, after], |r| r.get::<_, String>(0))?;
        rows.map(|row| {
            let message: Message = serde_json::from_str(&row?)?;
            message.validate()?;
            Ok(message)
        })
        .collect()
    }
}
