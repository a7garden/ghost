use crate::lifetime_contract::{canonical_digest, Artifact, Response, WorkerSpec};
use anyhow::{anyhow, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::{self, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

pub(crate) const DEFAULT_PROGRESS_LIMIT: u64 = 128 * 1024 * 1024;
pub(crate) const INLINE_FRAME_LIMIT: usize = 1_048_576;
const EVENT_PAGE_LIMIT: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProcessIdentity {
    pub pid: u32,
    pub process_group: i32,
    pub start_identity: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ExecutionRecord {
    pub spec: WorkerSpec,
    pub spec_digest: String,
    pub state: String,
    pub pid: Option<u32>,
    pub process_group: Option<i32>,
    pub process_start_identity: Option<String>,
    pub session_locator: String,
    pub last_sequence: u64,
    pub acknowledged_sequence: u64,
    pub progress_bytes: u64,
    pub prompt_intent: bool,
    pub prompt_acknowledged: bool,
    pub prompt_result: Option<Value>,
    pub session_settled: bool,
    pub process_exited: bool,
    pub process_exit_code: Option<i32>,
    pub collected: bool,
}

#[derive(Debug)]
pub(crate) enum CommandLookup {
    Missing,
    Pending(Response),
    Complete(Response),
}

#[derive(Debug)]
pub(crate) enum Admission {
    New { response: Response, session_locator: String },
    Existing { response: Response, start_admitted: bool, session_locator: String },
    Cached(Response),
}

#[derive(Debug)]
pub(crate) enum AppendOutcome {
    Stored,
    SpoolFull,
}

#[derive(Debug, Clone)]
pub(crate) struct ToolReceipt {
    pub authority_epoch: u64,
    pub tool_name: String,
    pub arguments: Value,
    pub intent: Value,
    pub status: String,
    pub result: Option<Value>,
    pub is_error: bool,
    pub artifact: Option<Artifact>,
}

#[derive(Debug)]
pub(crate) enum ToolAdmission {
    New,
    Existing(ToolReceipt),
    Conflict,
}

pub(crate) struct Journal {
    conn: Connection,
    root: PathBuf,
}

impl Journal {
    pub(crate) fn open(root: &Path) -> Result<Self> {
        let database = root.join("worker.db");
        if let Ok(metadata) = fs::symlink_metadata(&database) {
            ensure!(!metadata.file_type().is_symlink(), "refusing a symlink worker database");
            ensure!(metadata.is_file(), "worker database path is not a file");
        }
        let conn = Connection::open(&database).context("opening worker.db")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        ensure!(version == 0 || version == 1, "unsupported worker journal schema version {version}");
        if version == 0 {
            conn.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE executions (
                    execution_id TEXT PRIMARY KEY,
                    spec_json TEXT NOT NULL,
                    spec_digest TEXT NOT NULL,
                    authority_epoch INTEGER NOT NULL CHECK(authority_epoch > 0),
                    state TEXT NOT NULL,
                    pid INTEGER,
                    process_group INTEGER,
                    process_start_identity TEXT,
                    session_locator TEXT NOT NULL,
                    last_sequence INTEGER NOT NULL DEFAULT 0,
                    acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
                    progress_bytes INTEGER NOT NULL DEFAULT 0,
                    progress_limit INTEGER NOT NULL,
                    prompt_intent INTEGER NOT NULL DEFAULT 0,
                    prompt_acknowledged INTEGER NOT NULL DEFAULT 0,
                    prompt_result_json TEXT,
                    session_settled INTEGER NOT NULL DEFAULT 0,
                    process_exited INTEGER NOT NULL DEFAULT 0,
                    process_exit_code INTEGER,
                    collected INTEGER NOT NULL DEFAULT 0,
                    created_ms INTEGER NOT NULL,
                    updated_ms INTEGER NOT NULL
                 );
                 CREATE TABLE commands (
                    command_id TEXT PRIMARY KEY,
                    request_digest TEXT NOT NULL,
                    execution_id TEXT,
                    state TEXT NOT NULL CHECK(state IN ('pending','complete')),
                    response_json TEXT NOT NULL,
                    created_ms INTEGER NOT NULL,
                    updated_ms INTEGER NOT NULL
                 );
                 CREATE TABLE events (
                    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
                    sequence INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    payload_bytes INTEGER NOT NULL,
                    critical INTEGER NOT NULL,
                    created_ms INTEGER NOT NULL,
                    PRIMARY KEY(execution_id, sequence)
                 );
                 CREATE TABLE worker_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO worker_meta(key,value) VALUES('authority_epoch','1');
                 PRAGMA user_version=1;
                 COMMIT;"
            )?;
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tool_receipts (
                execution_id TEXT NOT NULL REFERENCES executions(execution_id),
                tool_call_id TEXT NOT NULL,
                authority_epoch INTEGER NOT NULL CHECK(authority_epoch > 0),
                tool_name TEXT NOT NULL,
                arguments_digest TEXT NOT NULL,
                arguments_json TEXT NOT NULL,
                intent_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','complete','unknown')),
                result_json TEXT,
                is_error INTEGER NOT NULL DEFAULT 0,
                artifact_json TEXT,
                created_ms INTEGER NOT NULL,
                updated_ms INTEGER NOT NULL,
                PRIMARY KEY(execution_id, tool_call_id)
             );"
        )?;

        Ok(Self { conn, root: root.to_path_buf() })
    }

    pub(crate) fn current_epoch(&self) -> Result<u64> {
        let value: String = self.conn.query_row("SELECT value FROM worker_meta WHERE key='authority_epoch'", [], |row| row.get(0))?;
        Ok(value.parse()?)
    }

    pub(crate) fn lookup_command(&self, command_id: &str, request_digest: &str) -> Result<CommandLookup> {
        let row: Option<(String, String, String)> = self.conn.query_row(
            "SELECT request_digest,state,response_json FROM commands WHERE command_id=?1",
            [command_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((stored_digest, state, response)) = row else { return Ok(CommandLookup::Missing); };
        ensure!(stored_digest == request_digest, "command_id was reused with a different envelope");
        let response = serde_json::from_str(&response).context("decoding stored worker response")?;
        Ok(if state == "complete" { CommandLookup::Complete(response) } else { CommandLookup::Pending(response) })
    }

    pub(crate) fn reserve_command(&mut self, command_id: &str, request_digest: &str, execution_id: Option<&str>, pending: &Response) -> Result<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO commands(command_id,request_digest,execution_id,state,response_json,created_ms,updated_ms)
             VALUES(?1,?2,?3,'pending',?4,?5,?5)",
            params![command_id, request_digest, execution_id, serde_json::to_string(pending)?, now_ms()?],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn finish_command(&mut self, command_id: &str, response: &Response) -> Result<()> {
        self.conn.execute(
            "UPDATE commands SET state='complete',response_json=?2,updated_ms=?3 WHERE command_id=?1",
            params![command_id, serde_json::to_string(response)?, now_ms()?],
        )?;
        Ok(())
    }

    pub(crate) fn cache_command(&mut self, command_id: &str, request_digest: &str, execution_id: Option<&str>, response: &Response) -> Result<()> {
        self.conn.execute(
            "INSERT INTO commands(command_id,request_digest,execution_id,state,response_json,created_ms,updated_ms)
             VALUES(?1,?2,?3,'complete',?4,?5,?5)",
            params![command_id, request_digest, execution_id, serde_json::to_string(response)?, now_ms()?],
        )?;
        Ok(())
    }

    pub(crate) fn admit(&mut self, command_id: &str, request_digest: &str, spec: &WorkerSpec, spec_digest: &str, session_locator: &str, response_for_new: &Response) -> Result<Admission> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some((stored_digest, state, response_json)) = tx.query_row(
            "SELECT request_digest,state,response_json FROM commands WHERE command_id=?1",
            [command_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?))
        ).optional()? {
            ensure!(stored_digest == request_digest, "command_id was reused with a different envelope");
            let response = serde_json::from_str(&response_json)?;
            tx.commit()?;
            return Ok(if state == "complete" { Admission::Cached(response) } else { Admission::Cached(response) });
        }
        let existing: Option<(String,String,String)> = tx.query_row(
            "SELECT spec_digest,state,session_locator FROM executions WHERE execution_id=?1",
            [&spec.execution_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))
        ).optional()?;
        let (response, start_admitted, locator, is_new) = if let Some((existing_digest,state,locator)) = existing {
            ensure!(existing_digest == spec_digest, "execution_id was reused with a different worker spec");
            let record: (i64,i64,i64,i64) = tx.query_row(
                "SELECT last_sequence,acknowledged_sequence,prompt_acknowledged,session_settled FROM executions WHERE execution_id=?1",
                [&spec.execution_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))
            )?;
            let mut response = response_for_new.clone();
            response.summary = "Existing execution handle recovered".into();
            response.data = json!({"execution_id":spec.execution_id,"spec_digest":spec_digest,"state":state,
                "session_locator":locator,"last_sequence":record.0,"acknowledged_sequence":record.1,
                "prompt_acknowledged":record.2 != 0,"session_settled":record.3 != 0});
            (response, state == "admitted", locator, false)
        } else {
            let now = now_ms()?;
            let spec_json = serde_json::to_string(spec)?;
            let progress_limit = spec.max_progress_bytes.min(DEFAULT_PROGRESS_LIMIT);
            let progress_limit = i64::try_from(progress_limit).context("progress limit is out of range")?;
            let authority_epoch = i64::try_from(spec.authority_epoch).context("authority epoch is out of range")?;
            tx.execute(
                "INSERT INTO executions(execution_id,spec_json,spec_digest,authority_epoch,state,session_locator,progress_limit,created_ms,updated_ms)
                 VALUES(?1,?2,?3,?4,'admitted',?5,?6,?7,?7)",
                params![spec.execution_id,spec_json,spec_digest,authority_epoch,session_locator,progress_limit,now],
            )?;
            let sequence = 1i64;
            tx.execute(
                "INSERT INTO events(execution_id,sequence,kind,payload_json,payload_bytes,critical,created_ms)
                 VALUES(?1,?2,'admitted',?3,0,1,?4)",
                params![spec.execution_id,sequence,json!({"spec_digest":spec_digest,"authority_epoch":spec.authority_epoch}).to_string(),now],
            )?;
            tx.execute("UPDATE executions SET last_sequence=1 WHERE execution_id=?1", [&spec.execution_id])?;
            (response_for_new.clone(), true, session_locator.to_owned(), true)
        };
        tx.execute(
            "INSERT INTO commands(command_id,request_digest,execution_id,state,response_json,created_ms,updated_ms)
             VALUES(?1,?2,?3,'complete',?4,?5,?5)",
            params![command_id,request_digest,spec.execution_id,serde_json::to_string(&response)?,now_ms()?],
        )?;
        tx.commit()?;
        Ok(if is_new { Admission::New { response, session_locator: locator } } else { Admission::Existing { response, start_admitted, session_locator: locator } })
    }

    pub(crate) fn record_process(&mut self, execution_id: &str, identity: &ProcessIdentity, session_locator: &str) -> Result<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE executions SET state='running',pid=?2,process_group=?3,process_start_identity=?4,session_locator=?5,updated_ms=?6
             WHERE execution_id=?1 AND state='starting'",
            params![execution_id,identity.pid,identity.process_group,identity.start_identity,session_locator,now_ms()?],
        )?;
        ensure!(changed == 1, "worker execution left starting state before process identity commit");
        append_event_tx(&tx, execution_id, "process_started", &json!({"pid":identity.pid,"process_group":identity.process_group,"start_identity":identity.start_identity,"session_locator":session_locator}), 0, true, None)?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn mark_starting(&mut self, execution_id: &str) -> Result<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // A resumed execution relaunches its runtime for the same-identity
        // continuation after an owner decision; its receipt and budget are
        // already committed, so `starting` (and the no-prompt barrier event)
        // is legal from `resumed` exactly as from `admitted`.
        let changed = tx.execute("UPDATE executions SET state='starting',updated_ms=?2 WHERE execution_id=?1 AND state IN ('admitted','resumed')", params![execution_id,now_ms()?])?;
        ensure!(changed == 1, "worker execution is not admitted or resumed");
        append_event_tx(&tx, execution_id, "process_starting", &json!({"barrier":"no prompt is sent before durable process identity"}), 0, true, None)?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn append_event(&mut self, execution_id: &str, kind: &str, payload: &Value, payload_bytes: usize, critical: bool, next_state: Option<&str>) -> Result<AppendOutcome> {
        let payload_json = serde_json::to_string(payload)?;
        self.append_event_json(execution_id, kind, payload, &payload_json, payload_bytes, critical, next_state)
    }

    fn append_event_json(&mut self, execution_id: &str, kind: &str, payload: &Value, payload_json: &str, payload_bytes: usize, critical: bool, next_state: Option<&str>) -> Result<AppendOutcome> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (current_bytes, limit, state): (i64,i64,String) = tx.query_row(
            "SELECT progress_bytes,progress_limit,state FROM executions WHERE execution_id=?1",
            [execution_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))
        ).optional()?.ok_or_else(|| anyhow!("unknown execution_id"))?;
        let payload_size = i64::try_from(payload_bytes).unwrap_or(i64::MAX);
        if !critical && current_bytes.saturating_add(payload_size) > limit {
            if state != "spool_full" {
                append_event_tx(&tx, execution_id, "spool_limit_reached", &json!({"limit_bytes":limit}), 0, true, Some("spool_full"))?;
            }
            tx.commit()?;
            return Ok(AppendOutcome::SpoolFull);
        }
        append_event_json_tx(&tx, execution_id, kind, payload, payload_json, payload_bytes, critical, next_state)?;
        tx.commit()?;
        Ok(AppendOutcome::Stored)
    }

    pub(crate) fn store_frame(&mut self, execution_id: &str, frame: &Value, raw: &[u8]) -> Result<AppendOutcome> {
        let frame_type = frame["type"].as_str().unwrap_or("unknown");
        let command = frame["command"].as_str().unwrap_or("");
        let (kind, critical, state) = match frame_type {
            "ready" => ("rpc_ready", true, None),
            "prompt_result" => ("prompt_result", true, Some("yielded")),
            "session_settled" => ("session_settled", true, Some("settled")),
            "response" if command == "prompt" && frame["success"] == true => ("prompt_ack", true, Some("running")),
            "response" if command == "abort" && frame["success"] == true => ("cancel_acknowledged", true, Some("cancel_acknowledged")),
            "response" => ("rpc_response", true, None),
            _ => ("progress", false, None),
        };
        if let Some(payload) = visible_agent_progress(frame, frame_type) {
            let payload_json = serde_json::to_string(&payload)?;
            return self.append_event_json(execution_id, kind, &payload, &payload_json, payload_json.len(), critical, state);
        }
        let payload = if raw.len() > INLINE_FRAME_LIMIT {
            let artifact = self.write_artifact(execution_id, raw)?;
            json!({"type":frame_type,"artifact":artifact,"byte_length":raw.len()})
        } else {
            frame.clone()
        };
        self.append_event(execution_id, kind, &payload, raw.len(), critical, state)
    }

    pub(crate) fn write_artifact(&self, execution_id: &str, bytes: &[u8]) -> Result<Artifact> {
        let digest = format!("{:x}", Sha256::digest(bytes));
        let artifact_root = self.root.join("artifacts");
        create_private_dir(&artifact_root)?;
        let execution_dir = artifact_root.join(path_key(execution_id));
        create_private_dir(&execution_dir)?;
        let path = execution_dir.join(format!("{digest}.json"));
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            ensure!(!metadata.file_type().is_symlink() && metadata.is_file(), "worker artifact path is not a regular file");
        } else {
            let temporary = execution_dir.join(format!(".{digest}.{}.tmp", uuid::Uuid::new_v4()));
            let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            if let Err(error) = fs::rename(&temporary, &path) {
                let _ = fs::remove_file(&temporary);
                return Err(error.into());
            }
        }
        #[cfg(unix)]
        {
            fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
            fs::File::open(&execution_dir)?.sync_all()?;
        }
        self.verify_artifact(execution_id, &digest, &path)?;
        Ok(Artifact {
            digest,
            locator: path.to_string_lossy().into_owned(),
            privacy: "local_only".into(),
            producing_attempt: execution_id.to_owned(),
        })
    }

    fn verify_artifact(&self, execution_id: &str, expected_digest: &str, locator: &Path) -> Result<()> {
        read_verified_artifact(&self.root, execution_id, expected_digest, locator).map(|_| ())
    }

    pub(crate) fn begin_tool_call(
        &mut self,
        execution_id: &str,
        tool_call_id: &str,
        authority_epoch: u64,
        tool_name: &str,
        arguments_digest: &str,
        arguments: &Value,
    ) -> Result<ToolAdmission> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(i64, String, String, String, String, String, Option<String>, i64, Option<String>)> = tx.query_row(
            "SELECT authority_epoch,tool_name,arguments_digest,arguments_json,intent_json,status,result_json,is_error,artifact_json
             FROM tool_receipts WHERE execution_id=?1 AND tool_call_id=?2",
            params![execution_id,tool_call_id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?)),
        ).optional()?;
        if let Some((epoch,name,digest,args,intent,status,result,is_error,artifact)) = existing {
            if epoch as u64 != authority_epoch || name != tool_name || digest != arguments_digest {
                tx.commit()?;
                return Ok(ToolAdmission::Conflict);
            }
            let receipt = ToolReceipt {
                authority_epoch: epoch as u64,
                tool_name: name,
                arguments: serde_json::from_str(&args)?,
                intent: serde_json::from_str(&intent)?,
                status,
                result: result.map(|value| serde_json::from_str(&value)).transpose()?,
                is_error: is_error != 0,
                artifact: artifact.map(|value| serde_json::from_str(&value)).transpose()?,
            };
            tx.commit()?;
            return Ok(ToolAdmission::Existing(receipt));
        }

        let current_epoch: String = tx.query_row("SELECT value FROM worker_meta WHERE key='authority_epoch'", [], |row| row.get(0))?;
        let current_epoch: u64 = current_epoch.parse()?;
        let execution_epoch: i64 = tx.query_row("SELECT authority_epoch FROM executions WHERE execution_id=?1", [execution_id], |row| row.get(0))?;
        let fenced = current_epoch != authority_epoch || execution_epoch as u64 != authority_epoch;
        let status = if fenced { "complete" } else { "pending" };
        let result = fenced.then(|| json!({"error_code":"authority_fenced"}));
        let intent = json!({"phase":"reserved"});
        let epoch = i64::try_from(authority_epoch).context("tool authority epoch is out of range")?;
        let now = now_ms()?;
        tx.execute(
            "INSERT INTO tool_receipts(execution_id,tool_call_id,authority_epoch,tool_name,arguments_digest,arguments_json,intent_json,status,result_json,is_error,created_ms,updated_ms)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)",
            params![execution_id,tool_call_id,epoch,tool_name,arguments_digest,arguments.to_string(),intent.to_string(),status,result.as_ref().map(Value::to_string),if fenced {1i64} else {0i64},now],
        )?;
        if fenced {
            append_event_tx(&tx,execution_id,"tool_call_result",&json!({"tool_call_id":tool_call_id,"authority_epoch":authority_epoch,"tool_name":tool_name,"arguments_digest":arguments_digest,"status":"complete","error_code":"authority_fenced"}),0,true,None)?;
        } else {
            append_event_tx(&tx,execution_id,"tool_call_intent",&json!({"tool_call_id":tool_call_id,"authority_epoch":authority_epoch,"tool_name":tool_name,"arguments_digest":arguments_digest}),0,true,None)?;
        }
        tx.commit()?;
        if fenced {
            Ok(ToolAdmission::Existing(ToolReceipt {
                authority_epoch,
                tool_name: tool_name.to_owned(),
                arguments: arguments.clone(),
                intent,
                status: "complete".into(),
                result,
                is_error: true,
                artifact: None,
            }))
        } else {
            Ok(ToolAdmission::New)
        }
    }

    pub(crate) fn update_tool_intent(&mut self, execution_id: &str, tool_call_id: &str, authority_epoch: u64, intent: &Value) -> Result<()> {
        let epoch = i64::try_from(authority_epoch).context("tool authority epoch is out of range")?;
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE tool_receipts SET intent_json=?4,updated_ms=?5
             WHERE execution_id=?1 AND tool_call_id=?2 AND authority_epoch=?3 AND status='pending'",
            params![execution_id,tool_call_id,epoch,intent.to_string(),now_ms()?],
        )?;
        ensure!(changed == 1, "tool receipt left pending state before intent commit");
        tx.commit()?;
        Ok(())
    }

    /// Persists the pending owner question into a still-pending receipt so a
    /// replay of the identical call can re-drive the SAME action.
    pub(crate) fn stage_tool_receipt_result(
        &mut self,
        execution_id: &str,
        tool_call_id: &str,
        authority_epoch: u64,
        result: &Value,
    ) -> Result<()> {
        let epoch = i64::try_from(authority_epoch).context("tool authority epoch is out of range")?;
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE tool_receipts SET result_json=?4,updated_ms=?5
             WHERE execution_id=?1 AND tool_call_id=?2 AND authority_epoch=?3 AND status='pending'",
            params![execution_id,tool_call_id,epoch,result.to_string(),now_ms()?],
        )?;
        ensure!(changed == 1, "tool receipt left pending state before result staging");
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn finish_tool_call(
        &mut self,
        execution_id: &str,
        tool_call_id: &str,
        authority_epoch: u64,
        result: &Value,
        is_error: bool,
        artifact: Option<&Artifact>,
        unknown: bool,
    ) -> Result<()> {
        let epoch = i64::try_from(authority_epoch).context("tool authority epoch is out of range")?;
        let status = if unknown { "unknown" } else { "complete" };
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE tool_receipts SET status=?4,result_json=?5,is_error=?6,artifact_json=?7,updated_ms=?8
             WHERE execution_id=?1 AND tool_call_id=?2 AND authority_epoch=?3 AND status='pending'",
            params![execution_id,tool_call_id,epoch,status,result.to_string(),if is_error {1i64} else {0i64},artifact.map(serde_json::to_string).transpose()?,now_ms()?],
        )?;
        ensure!(changed == 1, "tool receipt left pending state before result commit");
        append_event_tx(&tx,execution_id,"tool_call_result",&json!({
            "tool_call_id":tool_call_id,
            "authority_epoch":authority_epoch,
            "status":status,
            "is_error":is_error,
            "result":result,
            "artifact":artifact,
        }),0,true,None)?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn pending_tool_calls(&self, execution_id: &str) -> Result<Vec<(String, ToolReceipt)>> {
        let mut statement = self.conn.prepare(
            "SELECT tool_call_id,authority_epoch,tool_name,arguments_json,intent_json,status,result_json,is_error,artifact_json
             FROM tool_receipts WHERE execution_id=?1 AND status='pending' ORDER BY created_ms,tool_call_id"
        )?;
        let rows = statement.query_map([execution_id], |row| Ok((
            row.get::<_,String>(0)?,
            row.get::<_,i64>(1)?,
            row.get::<_,String>(2)?,
            row.get::<_,String>(3)?,
            row.get::<_,String>(4)?,
            row.get::<_,String>(5)?,
            row.get::<_,Option<String>>(6)?,
            row.get::<_,i64>(7)?,
            row.get::<_,Option<String>>(8)?,
        )))?;
        let mut pending = Vec::new();
        for row in rows {
            let (tool_call_id,epoch,tool_name,arguments,intent,status,result,is_error,artifact) = row?;
            pending.push((tool_call_id,ToolReceipt {
                authority_epoch:epoch as u64,
                tool_name,
                arguments:serde_json::from_str(&arguments)?,
                intent:serde_json::from_str(&intent)?,
                status,
                result:result.map(|value| serde_json::from_str(&value)).transpose()?,
                is_error:is_error != 0,
                artifact:artifact.map(|value| serde_json::from_str(&value)).transpose()?,
            }));
        }
        Ok(pending)
    }


    /// One durable receipt regardless of status. The resume answer replays the
    /// committed owner decision from this row — the SAME tool-call identity the
    /// SDK re-executes after a reopen.
    pub(crate) fn tool_receipt(&self, execution_id: &str, tool_call_id: &str) -> Result<Option<ToolReceipt>> {
        let mut statement = self.conn.prepare(
            "SELECT authority_epoch,tool_name,arguments_json,intent_json,status,result_json,is_error,artifact_json
             FROM tool_receipts WHERE execution_id=?1 AND tool_call_id=?2",
        )?;
        let row = statement.query_row([execution_id, tool_call_id], |row| {
            Ok((
                row.get::<_,i64>(0)?,
                row.get::<_,String>(1)?,
                row.get::<_,String>(2)?,
                row.get::<_,String>(3)?,
                row.get::<_,String>(4)?,
                row.get::<_,Option<String>>(5)?,
                row.get::<_,i64>(6)?,
                row.get::<_,Option<String>>(7)?,
            ))
        }).optional()?;
        let Some((epoch,tool_name,arguments,intent,status,result,is_error,artifact)) = row else { return Ok(None); };
        Ok(Some(ToolReceipt {
            authority_epoch: epoch as u64,
            tool_name,
            arguments:serde_json::from_str(&arguments)?,
            intent:serde_json::from_str(&intent)?,
            status,
            result:result.map(|value| serde_json::from_str(&value)).transpose()?,
            is_error:is_error != 0,
            artifact:artifact.map(|value| serde_json::from_str(&value)).transpose()?,
        }))
    }

    pub(crate) fn record_intent(&mut self, execution_id: &str, rpc_id: &str, method: &str, request_digest: &str) -> Result<()> {
        let kind = if method == "prompt" { "prompt_intent" } else if method == "abort" { "cancel_intent" } else { "rpc_command_intent" };
        let state = if method == "abort" { Some("cancel_requested") } else { None };
        self.append_event(execution_id, kind, &json!({"rpc_id":rpc_id,"method":method,"request_digest":request_digest}), 0, true, state)?;
        Ok(())
    }

    /// Known no-effect owner-question pause: the execution stays NONterminal
    /// in state waiting_owner with the exact question recorded. This is never
    /// an unknown-effect or failure state.
    pub(crate) fn mark_waiting_owner(
        &mut self,
        execution_id: &str,
        action_id: &str,
        detail: &Value,
        remaining_budget_ms: u64,
    ) -> Result<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE executions SET state='waiting_owner',updated_ms=?2 WHERE execution_id=?1",
            params![execution_id, now_ms()?],
        )?;
        ensure!(changed == 1, "worker execution cannot pause from its current state");
        append_event_tx(
            &tx,
            execution_id,
            "owner_question_pending",
            &json!({"action_id": action_id, "question": detail, "effects": "none dispatched", "remaining_budget_ms": remaining_budget_ms}),
            0,
            true,
            None,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The pending known-pause browser question for an execution, when the
    /// staged receipt names an action (known no-effect pause). The LATEST
    /// staged question wins — a consent refresh replaces the open question.
    pub(crate) fn pending_browser_question(
        &self,
        execution_id: &str,
    ) -> Result<Option<(String, ToolReceipt)>> {
        let mut latest: Option<(String, ToolReceipt)> = None;
        for (tool_call_id, receipt) in self.pending_tool_calls(execution_id)? {
            if receipt.tool_name == "browser"
                && receipt
                    .result
                    .as_ref()
                    .and_then(|result| result["status"].as_str())
                    == Some("pending_owner_approval")
            {
                latest = Some((tool_call_id, receipt));
            }
        }
        Ok(latest)
    }

    /// The pending question staged for one EXACT action: the resume path keys
    /// the owner decision by action identity, so a second open question never
    /// consumes another action's decision.
    pub(crate) fn pending_browser_question_for_action(
        &self,
        execution_id: &str,
        action_id: &str,
    ) -> Result<Option<(String, ToolReceipt)>> {
        for (tool_call_id, receipt) in self.pending_tool_calls(execution_id)? {
            if receipt.tool_name == "browser"
                && receipt
                    .result
                    .as_ref()
                    .and_then(|result| result["action_id"].as_str())
                    == Some(action_id)
            {
                return Ok(Some((tool_call_id, receipt)));
            }
        }
        Ok(None)
    }

    /// A question alone is not proof that parallel SDK work has stopped.
    /// Only the actor's measured all-owner wait is resumable after a crash.
    pub(crate) fn seal_owner_budget(&mut self, execution_id: &str, remaining_ms: u64) -> Result<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE executions SET state='waiting_owner',updated_ms=?2
             WHERE execution_id=?1 AND state IN ('starting','running','resumed','waiting_owner')",
            params![execution_id, now_ms()?],
        )?;
        ensure!(changed == 1, "worker cannot seal an owner budget from its current state");
        append_event_tx(&tx, execution_id, "owner_budget_sealed",
            &json!({"remaining_budget_ms":remaining_ms}), 0, true, None)?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn charge_owner_budget(&mut self, execution_id: &str, remaining_ms: u64) -> Result<()> {
        self.append_event(execution_id, "owner_budget_charging",
            &json!({"remaining_budget_ms":remaining_ms}), 0, true, None)?;
        Ok(())
    }

    /// Persisted monotonic budget at the last known pause. Owner waiting time
    /// never replenishes or spends this budget; historical unmeasured pauses
    /// deliberately have no resumable budget.
    pub(crate) fn paused_remaining_budget_ms(&self, execution_id: &str) -> Result<Option<u64>> {
        let checkpoint: Option<(String, String)> = self.conn.query_row(
            "SELECT kind,payload_json FROM events WHERE execution_id=?1
             AND kind IN ('owner_budget_sealed','owner_budget_charging')
             ORDER BY sequence DESC LIMIT 1",
            [execution_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((kind, payload)) = checkpoint else { return Ok(None); };
        if kind != "owner_budget_sealed" { return Ok(None); }
        Ok(serde_json::from_str::<Value>(&payload)?["remaining_budget_ms"].as_u64())
    }

    /// Known pause resolved: the execution moves to resumed with the exact
    /// decision evidence. The SDK session directory is untouched.
    pub(crate) fn mark_resumed(&mut self, execution_id: &str, detail: &Value) -> Result<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE executions SET state='resumed',updated_ms=?2 WHERE execution_id=?1 AND state='waiting_owner'",
            params![execution_id, now_ms()?],
        )?;
        ensure!(changed == 1, "worker execution is not in its known pause");
        append_event_tx(&tx, execution_id, "owner_decision_resumed", detail, 0, true, None)?;
        tx.commit()?;
        Ok(())
    }

    /// A known pause leaves waiting_owner only through an owner decision or
    /// an explicit cancel — never a timeout or process death.
    pub(crate) fn execution_state(&self, execution_id: &str) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT state FROM executions WHERE execution_id=?1",
                [execution_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub(crate) fn set_failure(&mut self, execution_id: &str, code: &str, detail: &str, uncertain: bool) -> Result<()> {
        let state = if uncertain { "unknown" } else { "failed" };
        self.append_event(execution_id, "runner_failure", &json!({"error_code":code,"detail":detail}), 0, true, Some(state))?;
        Ok(())
    }

    pub(crate) fn get_execution(&self, execution_id: &str) -> Result<Option<ExecutionRecord>> {
        let row: Option<(String,String,String,Option<i64>,Option<i64>,Option<String>,String,i64,i64,i64,i64,i64,Option<String>,i64,i64,Option<i64>,i64)> = self.conn.query_row(
            "SELECT spec_json,spec_digest,state,pid,process_group,process_start_identity,session_locator,last_sequence,acknowledged_sequence,progress_bytes,prompt_intent,prompt_acknowledged,prompt_result_json,session_settled,process_exited,process_exit_code,collected
             FROM executions WHERE execution_id=?1",
            [execution_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,row.get(12)?,row.get(13)?,row.get(14)?,row.get(15)?,row.get(16)?))
        ).optional()?;
        let Some((spec_json,spec_digest,state,pid,group,start,locator,last,acked,progress,prompt_intent,prompt_ack,prompt_result,settled,exited,exit_code,collected)) = row else { return Ok(None); };
        Ok(Some(ExecutionRecord {
            spec: serde_json::from_str(&spec_json).context("decoding worker spec")?,
            spec_digest,
            state,
            pid: pid.map(|value| value as u32),
            process_group: group.map(|value| value as i32),
            process_start_identity: start,
            session_locator: locator,
            last_sequence: last as u64,
            acknowledged_sequence: acked as u64,
            progress_bytes: progress as u64,
            prompt_intent: prompt_intent != 0,
            prompt_acknowledged: prompt_ack != 0,
            prompt_result: prompt_result.map(|value| serde_json::from_str(&value)).transpose()?,
            session_settled: settled != 0,
            process_exited: exited != 0,
            process_exit_code: exit_code.map(|value| value as i32),
            collected: collected != 0,
        }))
    }

    pub(crate) fn active_records(&self) -> Result<Vec<ExecutionRecord>> {
        let ids = {
            let mut statement = self.conn.prepare("SELECT execution_id FROM executions WHERE process_exited=0 AND state IN ('admitted','starting','running','yielded','cancel_requested','cancel_acknowledged','spool_full','fenced','settled','waiting_owner','resumed') ORDER BY created_ms")?;
            let rows = statement.query_map([], |row| row.get::<_,String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        ids.into_iter().map(|id| self.get_execution(&id)?.ok_or_else(|| anyhow!("execution disappeared during recovery"))).collect()
    }

    pub(crate) fn mark_recovery_unknown(&mut self, execution_id: &str, reason: &str) -> Result<()> {
        self.append_event(execution_id, "recovery_unknown", &json!({"reason":reason,"automatic_respawn":false}), 0, true, Some("unknown"))?;
        Ok(())
    }

    pub(crate) fn mark_admitted_for_recovery(&mut self, execution_id: &str) -> Result<()> {
        self.conn.execute("UPDATE executions SET state='admitted',updated_ms=?2 WHERE execution_id=?1", params![execution_id,now_ms()?])?;
        Ok(())
    }

    pub(crate) fn events(&self, execution_id: &str, after_sequence: u64) -> Result<Value> {
        let record = self.get_execution(execution_id)?.ok_or_else(|| anyhow!("unknown execution_id"))?;
        ensure!(after_sequence <= record.last_sequence, "after_sequence is ahead of the durable high-water mark");
        let first: Option<i64> = self.conn.query_row("SELECT MIN(sequence) FROM events WHERE execution_id=?1 AND sequence>?2", params![execution_id,after_sequence as i64], |row| row.get(0))?;
        let gap = after_sequence < record.acknowledged_sequence || first.map(|value| value as u64 > after_sequence.saturating_add(1)).unwrap_or(false);
        let mut statement = self.conn.prepare(
            "SELECT sequence,kind,payload_json,created_ms FROM events WHERE execution_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3"
        )?;
        let rows = statement.query_map(params![execution_id,after_sequence as i64,EVENT_PAGE_LIMIT as i64], |row| {
            let payload: String = row.get(2)?;
            Ok(json!({"sequence":row.get::<_,i64>(0)?,"kind":row.get::<_,String>(1)?,"payload":serde_json::from_str::<Value>(&payload).unwrap_or(Value::Null),"created_ms":row.get::<_,i64>(3)?}))
        })?;
        let events = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let through = events.last().and_then(|value| value["sequence"].as_u64()).unwrap_or(after_sequence);
        let has_more = through < record.last_sequence;
        let snapshot = json!({"execution_id":execution_id,"state":record.state,"last_sequence":record.last_sequence,
            "acknowledged_sequence":record.acknowledged_sequence,"prompt_acknowledged":record.prompt_acknowledged,
            "prompt_result":record.prompt_result,"session_settled":record.session_settled,
            "process_exited":record.process_exited,"process_exit_code":record.process_exit_code});
        Ok(json!({"execution_id":execution_id,"after_sequence":after_sequence,"through_sequence":through,
            "high_water":record.last_sequence,"gap":gap,"missing_from":if gap {Some(after_sequence.saturating_add(1))} else {None},
            "events":events,"has_more":has_more,"authoritative_snapshot":if gap {Some(snapshot)} else {None}}))
    }

    pub(crate) fn acknowledge(&mut self, execution_id: &str, through_sequence: u64) -> Result<u64> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (last,acked): (i64,i64) = tx.query_row("SELECT last_sequence,acknowledged_sequence FROM executions WHERE execution_id=?1", [execution_id], |row| Ok((row.get(0)?,row.get(1)?))).optional()?.ok_or_else(|| anyhow!("unknown execution_id"))?;
        ensure!(through_sequence <= last as u64, "acknowledge sequence is ahead of the durable high-water mark");
        ensure!(through_sequence >= acked as u64, "acknowledge sequence cannot move backwards");
        tx.execute("UPDATE executions SET acknowledged_sequence=?2,updated_ms=?3 WHERE execution_id=?1", params![execution_id,through_sequence as i64,now_ms()?])?;
        tx.execute("DELETE FROM events WHERE execution_id=?1 AND sequence<=?2 AND critical=0", params![execution_id,through_sequence as i64])?;
        tx.commit()?;
        Ok(through_sequence)
    }

    pub(crate) fn fence(&mut self, new_epoch: u64) -> Result<Vec<String>> {
        let new_value = i64::try_from(new_epoch).context("authority epoch is out of range")?;
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old: String = tx.query_row("SELECT value FROM worker_meta WHERE key='authority_epoch'", [], |row| row.get(0))?;
        let old_epoch: u64 = old.parse()?;
        ensure!(new_epoch >= old_epoch, "authority fence cannot move backwards");
        if new_epoch == old_epoch {
            tx.commit()?;
            return Ok(Vec::new());
        }
        tx.execute("UPDATE worker_meta SET value=?1 WHERE key='authority_epoch'", [new_value.to_string()])?;
        let ids = {
            let mut statement = tx.prepare("SELECT execution_id FROM executions WHERE authority_epoch<?1 AND state IN ('admitted','starting','running','yielded','cancel_requested','cancel_acknowledged','spool_full') ORDER BY created_ms")?;
            let rows = statement.query_map([new_value], |row| row.get::<_,String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for id in &ids {
            append_event_tx(&tx, id, "fenced", &json!({"new_epoch":new_epoch,"automatic_retry":false}), 0, true, Some("fenced"))?;
        }
        tx.commit()?;
        Ok(ids)
    }

    pub(crate) fn ensure_unknown_tools_reconciled(&self, execution_id: &str) -> Result<()> {
        let mut statement = self.conn.prepare(
            "SELECT tool_name,arguments_json,arguments_digest FROM tool_receipts
             WHERE execution_id=?1 AND status IN ('pending','unknown')",
        )?;
        let mut rows = statement.query([execution_id])?;
        while let Some(row) = rows.next()? {
            let tool_name = row.get_ref(0)?.as_str()?;
            ensure!(tool_name == super::process::BROWSER_TOOL,
                "unknown host tool effects require reconciliation before cleanup");
            let arguments: Value = serde_json::from_str(row.get_ref(1)?.as_str()?)?;
            let digest = row.get_ref(2)?.as_str()?;
            ensure!(canonical_digest(&arguments)? == digest
                && matches!(super::process::browser_operation_from_arguments(&arguments),
                    Some(crate::adapters::computer::BrowserOperation::Read
                        | crate::adapters::computer::BrowserOperation::Snapshot
                        | crate::adapters::computer::BrowserOperation::Screenshot)),
                "unknown host tool effects require reconciliation before cleanup");
        }
        Ok(())
    }

    pub(crate) fn unsettled_forensic_receipt(&self, execution_id: &str) -> Result<Option<(Value, Vec<Artifact>)>> {
        // The event kind is immutable audit history; preserve it for original receipts.
        let payload: Option<String> = self.conn.query_row(
            "SELECT payload_json FROM events WHERE execution_id=?1 AND kind='native_unknown_forensics' ORDER BY sequence LIMIT 1",
            [execution_id], |row| row.get(0),
        ).optional()?;
        let Some(payload) = payload else { return Ok(None); };
        let data: Value = serde_json::from_str(&payload)?;
        ensure!(data["execution_id"] == execution_id && data["collection_kind"] == "native_unknown_forensics",
            "unsettled forensic receipt scope mismatch");
        let artifact: Artifact = serde_json::from_value(data["artifact"].clone())?;
        ensure!(artifact.producing_attempt == execution_id && artifact.privacy == "local_only",
            "unsettled forensic artifact scope mismatch");
        self.verify_artifact(execution_id, &artifact.digest, Path::new(&artifact.locator))?;
        Ok(Some((data, vec![artifact])))
    }

    pub(crate) fn collect_unsettled_forensics(&mut self, record: &ExecutionRecord, proof: Value) -> Result<(Value, Vec<Artifact>)> {
        let execution_id = &record.spec.execution_id;
        ensure!(matches!(record.state.as_str(), "unknown" | "failed") && !record.session_settled && !record.collected,
            "producer outcome is not eligible for a new unsettled forensic receipt");
        self.ensure_unknown_tools_reconciled(execution_id)?;
        ensure!(record.session_locator == execution_session_locator(&self.root, execution_id),
            "unsettled SDK session locator differs from its original execution");
        let directory = Path::new(&record.session_locator);
        ensure!(directory.canonicalize()? == directory, "unsettled SDK session directory is not canonical");
        let directory_metadata = fs::symlink_metadata(directory)?;
        ensure!(directory_metadata.is_dir() && directory_metadata.uid() == unsafe { libc::geteuid() }
            && directory_metadata.mode() & 0o077 == 0, "unsettled SDK session directory is not private");
        let path = directory.join("worker-session.jsonl");
        let mut file = OpenOptions::new().read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC).open(&path)?;
        let before = file.metadata()?;
        ensure!(before.is_file() && before.nlink() == 1 && before.uid() == unsafe { libc::geteuid() }
            && before.len() > 0 && before.len() <= INLINE_FRAME_LIMIT as u64, "unsettled SDK session is not a bounded owned file");
        let mut bytes = Vec::with_capacity(before.len() as usize);
        (&mut file).take(INLINE_FRAME_LIMIT as u64 + 1).read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        ensure!(bytes.len() as u64 == before.len() && bytes.len() <= INLINE_FRAME_LIMIT && before.dev() == after.dev() && before.ino() == after.ino()
            && after.nlink() == 1 && before.len() == after.len() && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec(), "unsettled SDK session changed after physical quiescence");
        let artifact = self.write_artifact(execution_id, &bytes)?;
        let data = json!({
            "execution_id":execution_id,"state":record.state,"collection_kind":"native_unknown_forensics",
            "producer_outcome":record.state,"collected":true,"process_exited":true,
            "session_settled":record.session_settled,"prompt_result":record.prompt_result,
            "process_exit_code":record.process_exit_code,"session_locator":record.session_locator,
            "spec_digest":record.spec_digest,"quiescence":proof,"artifact":artifact,
        });
        self.append_event(execution_id, "native_unknown_forensics", &data, 0, true, None)?;
        Ok((data, vec![artifact]))
    }

    pub(crate) fn collect(&mut self, execution_id: &str) -> Result<(Value, Vec<Artifact>, bool)> {
        let record = self.get_execution(execution_id)?.ok_or_else(|| anyhow!("unknown execution_id"))?;
        if !record.session_settled || !record.process_exited {
            return Ok((json!({"execution_id":execution_id,"state":record.state,"session_settled":record.session_settled,
                "process_exited":record.process_exited,"prompt_result":record.prompt_result,"session_locator":record.session_locator}),Vec::new(),false));
        }
        let mut artifacts = {
            let mut statement = self.conn.prepare("SELECT payload_json FROM events WHERE execution_id=?1 ORDER BY sequence")?;
            let rows = statement.query_map([execution_id], |row| row.get::<_,String>(0))?;
            let mut artifacts = Vec::new();
            for row in rows {
                let value: Value = serde_json::from_str(&row?)?;
                if let Some(artifact) = value.get("artifact").and_then(|item| serde_json::from_value::<Artifact>(item.clone()).ok()) {
                    if !artifacts.iter().any(|existing: &Artifact| existing.digest == artifact.digest) { artifacts.push(artifact); }
                }
            }
            artifacts
        };
        let tool_receipts = {
            let mut statement = self.conn.prepare(
                "SELECT tool_call_id,authority_epoch,tool_name,arguments_digest,status,result_json,is_error,artifact_json
                 FROM tool_receipts WHERE execution_id=?1 ORDER BY created_ms,tool_call_id"
            )?;
            let rows = statement.query_map([execution_id], |row| Ok((
                row.get::<_,String>(0)?,
                row.get::<_,i64>(1)?,
                row.get::<_,String>(2)?,
                row.get::<_,String>(3)?,
                row.get::<_,String>(4)?,
                row.get::<_,Option<String>>(5)?,
                row.get::<_,i64>(6)?,
                row.get::<_,Option<String>>(7)?,
            )))?;
            let mut receipts = Vec::new();
            for row in rows {
                let (tool_call_id,epoch,tool_name,arguments_digest,status,result,is_error,artifact) = row?;
                let result = result.map(|value| serde_json::from_str::<Value>(&value)).transpose()?;
                let artifact = artifact.map(|value| serde_json::from_str::<Artifact>(&value)).transpose()?;
                if let Some(artifact) = &artifact {
                    if !artifacts.iter().any(|existing: &Artifact| existing.digest == artifact.digest) { artifacts.push(artifact.clone()); }
                }
                receipts.push(json!({
                    "tool_call_id":tool_call_id,
                    "authority_epoch":epoch,
                    "tool_name":tool_name,
                    "arguments_digest":arguments_digest,
                    "status":status,
                    "result":result,
                    "is_error":is_error != 0,
                    "artifact":artifact,
                }));
            }
            receipts
        };
        ensure!(!tool_receipts.iter().any(|receipt| matches!(receipt["status"].as_str(), Some("pending" | "unknown"))), "tool effects require reconciliation before collection");
        for artifact in &artifacts {
            ensure!(artifact.producing_attempt == execution_id && artifact.privacy == "local_only", "artifact scope mismatch");
            self.verify_artifact(execution_id, &artifact.digest, Path::new(&artifact.locator))?;
        }
        if !record.collected {
            self.append_event(execution_id, "collected", &json!({"terminal_receipt_preserved":true}), 0, true, Some("collected"))?;
        }
        let record = self.get_execution(execution_id)?.ok_or_else(|| anyhow!("execution disappeared while collecting"))?;
        let data = json!({"execution_id":execution_id,"state":record.state,"session_locator":record.session_locator,
            "prompt_acknowledged":record.prompt_acknowledged,"prompt_result":record.prompt_result,
            "session_settled":record.session_settled,"process_exited":record.process_exited,
            "process_exit_code":record.process_exit_code,"last_sequence":record.last_sequence,"tool_receipts":tool_receipts});
        Ok((data,artifacts,true))
    }

}

// Provider signatures and cumulative message snapshots belong in the canonical
// SDK session, not in the bounded observer spool. Unknown frames retain the
// original fail-closed byte accounting below.
fn visible_agent_progress(frame: &Value, frame_type: &str) -> Option<Value> {
    if !matches!(frame_type, "agent_start" | "agent_end" | "turn_start" | "turn_end"
        | "message_start" | "message_update" | "message_end"
        | "tool_execution_start" | "tool_execution_update" | "tool_execution_end") {
        return None;
    }
    let event = &frame["assistantMessageEvent"];
    let message = &frame["message"];
    if matches!(frame_type, "message_start" | "message_update" | "message_end" | "turn_end")
        && !message["role"].is_string() {
        return None;
    }
    if frame_type == "message_update" && !event["type"].is_string() {
        return None;
    }
    let delta = match event["type"].as_str() {
        Some("text_delta" | "toolcall_delta") => event["delta"].as_str(),
        _ => None,
    };
    let text = message["content"].as_array().and_then(|content| content.iter()
        .find(|block| block["type"] == "text").and_then(|block| block["text"].as_str()));
    let result = &frame["result"];
    let result_text = result["content"].as_array().and_then(|content| content.iter()
        .find(|block| block["type"] == "text").and_then(|block| block["text"].as_str()));
    Some(json!({
        "type": frame_type,
        "projection": "visible-agent-progress/1",
        "message_id": frame["messageId"].as_str(),
        "role": message["role"].as_str(),
        "stop_reason": message["stopReason"].as_str(),
        "event_type": event["type"].as_str(),
        "delta": delta.map(|text| progress_prefix(text, 1024)),
        "text": text.map(|text| progress_prefix(text, 1024)),
        "tool_call_id": frame["toolCallId"].as_str(),
        "tool_name": frame["toolName"].as_str(),
        "is_error": frame["isError"].as_bool().or_else(|| result["isError"].as_bool()),
        "result_preview": result_text.map(|text| progress_prefix(text, 2048)),
        "error": message["errorMessage"].as_str().or_else(|| frame["error"].as_str())
            .map(|text| progress_prefix(text, 2048)),
    }))
}

fn progress_prefix(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) { end -= 1; }
    &text[..end]
}

fn append_event_tx(tx: &rusqlite::Transaction<'_>, execution_id: &str, kind: &str, payload: &Value, payload_bytes: usize, critical: bool, next_state: Option<&str>) -> Result<()> {
    let payload_json = serde_json::to_string(payload)?;
    append_event_json_tx(tx, execution_id, kind, payload, &payload_json, payload_bytes, critical, next_state)
}

fn append_event_json_tx(tx: &rusqlite::Transaction<'_>, execution_id: &str, kind: &str, payload: &Value, payload_json: &str, payload_bytes: usize, critical: bool, next_state: Option<&str>) -> Result<()> {
    let last: i64 = tx.query_row("SELECT last_sequence FROM executions WHERE execution_id=?1", [execution_id], |row| row.get(0)).optional()?.ok_or_else(|| anyhow!("unknown execution_id"))?;
    let sequence = last.checked_add(1).context("worker event sequence overflow")?;
    let now = now_ms()?;
    let critical_flag = if critical { 1i64 } else { 0i64 };
    let payload_size = i64::try_from(payload_bytes).unwrap_or(i64::MAX);
    tx.execute(
        "INSERT INTO events(execution_id,sequence,kind,payload_json,payload_bytes,critical,created_ms) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![execution_id,sequence,kind,payload_json,payload_size,critical_flag,now]
    )?;
    let state_sql = next_state.unwrap_or("");
    tx.execute("UPDATE executions SET last_sequence=?2,progress_bytes=progress_bytes+?3,state=CASE WHEN ?4='' THEN state ELSE ?4 END,updated_ms=?5 WHERE execution_id=?1",
        params![execution_id,sequence,if critical {0i64} else {payload_size},state_sql,now])?;
    update_critical_state(tx, execution_id, kind, payload)?;
    Ok(())
}

fn update_critical_state(tx: &rusqlite::Transaction<'_>, execution_id: &str, kind: &str, payload: &Value) -> Result<()> {
    match kind {
        "prompt_intent" => { tx.execute("UPDATE executions SET prompt_intent=1 WHERE execution_id=?1", [execution_id])?; }
        "prompt_ack" => { tx.execute("UPDATE executions SET prompt_acknowledged=1 WHERE execution_id=?1", [execution_id])?; }
        "prompt_result" => { tx.execute("UPDATE executions SET prompt_result_json=?2,state='yielded' WHERE execution_id=?1", params![execution_id,payload.to_string()])?; }
        "session_settled" => { tx.execute("UPDATE executions SET session_settled=1,state='settled' WHERE execution_id=?1", [execution_id])?; }
        "process_exit" => {
            let code = payload["exit_code"].as_i64();
            tx.execute("UPDATE executions SET process_exited=1,process_exit_code=?2,updated_ms=?3 WHERE execution_id=?1", params![execution_id,code,now_ms()?])?;
        }
        "collected" => { tx.execute("UPDATE executions SET collected=1,state='collected' WHERE execution_id=?1", [execution_id])?; }
        "native_unknown_forensics" => {
            let producer_state = payload["state"].as_str().unwrap_or_default();
            ensure!(matches!(producer_state, "unknown" | "failed"),
                "forensic collection must preserve a failed or unknown producer state");
            let changed = tx.execute(
                "UPDATE executions SET collected=1,process_exited=1 WHERE execution_id=?1 AND state=?2 AND session_settled=0",
                params![execution_id, producer_state],
            )?;
            ensure!(changed == 1, "producer state changed before forensic collection");
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn execution_session_locator(root: &Path, execution_id: &str) -> String {
    root.join("sessions").join(path_key(execution_id)).to_string_lossy().into_owned()
}

/// Host-side read of one worker artifact for the scoped owner result surface.
/// Mirrors `Journal::verify_artifact` exactly: the locator must resolve inside
/// this worker root's immutable artifact store, name the expected digest, be a
/// bounded regular file that was never a symlink, hash to the expected digest,
/// and stay unchanged for the whole read.
pub(crate) fn read_verified_artifact(
    worker_root: &Path,
    execution_id: &str,
    expected_digest: &str,
    locator: &Path,
) -> Result<Vec<u8>> {
    ensure!(
        expected_digest.len() == 64
            && expected_digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "invalid artifact digest"
    );
    let artifact_root = worker_root.join("artifacts");
    let directory = artifact_root.join(path_key(execution_id));
    for parent in [&artifact_root, &directory] {
        let metadata = fs::symlink_metadata(parent)?;
        ensure!(metadata.is_dir() && !metadata.file_type().is_symlink(), "artifact directory is unsafe");
    }
    let path = directory.join(format!("{expected_digest}.json"));
    let relocated = crate::operations::relocation::configured()?
        .map(|relocation| relocation.artifact_locator(worker_root, locator)).transpose()?;
    ensure!(relocated.as_deref().unwrap_or(locator) == path, "artifact locator is outside its immutable store");
    let mut file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC).open(path)?;
    let before = file.metadata()?;
    ensure!(before.is_file() && before.nlink() == 1 && before.len() <= INLINE_FRAME_LIMIT as u64, "artifact is not a bounded private regular file");
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 8192];
    let mut total = 0usize;
    let mut bytes = Vec::new();
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break; }
        total += count;
        ensure!(total <= INLINE_FRAME_LIMIT, "artifact exceeds the collection limit");
        hash.update(&buffer[..count]);
        bytes.extend_from_slice(&buffer[..count]);
    }
    let after = file.metadata()?;
    ensure!(before.dev() == after.dev() && before.ino() == after.ino() && after.nlink() == 1 && before.len() == after.len()
        && before.mtime() == after.mtime() && before.mtime_nsec() == after.mtime_nsec(), "artifact changed while being verified");
    ensure!(format!("{:x}", hash.finalize()) == expected_digest, "immutable artifact digest mismatch");
    Ok(bytes)
}

pub(crate) fn canonical_spec_digest(spec: &WorkerSpec) -> Result<String> {
    canonical_digest(&serde_json::to_value(spec)?)
}

fn path_key(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn create_private_dir(path: &Path) -> Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        ensure!(!metadata.file_type().is_symlink() && metadata.is_dir(), "refusing unsafe worker artifact directory");
    } else {
        fs::create_dir_all(path)?;
    }
    #[cfg(unix)]
    fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    Ok(())
}

fn now_ms() -> Result<i64> {
    let duration = SystemTime::now().duration_since(UNIX_EPOCH).context("system clock is before Unix epoch")?;
    i64::try_from(duration.as_millis()).context("worker timestamp overflow")
}

#[cfg(test)]
mod progress_projection_tests {
    use super::*;

    #[test]
    fn opaque_sdk_metadata_cannot_exhaust_observer_budget_but_unknown_output_still_can() {
        let root = tempfile::tempdir().unwrap();
        let mut journal = Journal::open(root.path()).unwrap();
        let spec = WorkerSpec {
            execution_id: "projection-execution".into(), work_id: "projection-work".into(),
            work_revision: 1, authority_epoch: 1, computer_id: "projection-computer".into(),
            cwd: root.path().to_string_lossy().into_owned(), prompt: "public fixture".into(),
            model: "fixture/model".into(), thinking: "off".into(), allowed_tools: vec!["read".into()],
            deadline_ms: 10_000, max_progress_bytes: 65_536, skills: None, input_artifacts: None,
        };
        let response: Response = serde_json::from_value(json!({
            "status":"success","summary":"admitted","object_refs":[],"artifacts":[],
            "next_actions":[],"error_code":null,"retry_class":"never","data":{}
        })).unwrap();
        journal.admit("projection-command", "projection-request", &spec, "projection-spec", "fixture-session", &response).unwrap();
        let frame = json!({
            "type":"message_update", "messageId":"fixture-message",
            "message":{"role":"assistant","content":[{"type":"text","text":"Working"}],
                "providerMetadata":{"opaqueSignature":"x".repeat(100_000)}},
            "assistantMessageEvent":{"type":"thinking_delta","delta":"hidden reasoning",
                "partial":{"opaqueSignature":"y".repeat(100_000)}}
        });
        let raw = serde_json::to_vec(&frame).unwrap();
        for _ in 0..20 {
            assert!(matches!(journal.store_frame(&spec.execution_id, &frame, &raw).unwrap(), AppendOutcome::Stored));
        }
        let uncontrolled = json!({"type":"stdout","text":"z".repeat(100_000)});
        assert!(matches!(journal.store_frame(&spec.execution_id, &uncontrolled, &serde_json::to_vec(&uncontrolled).unwrap()).unwrap(), AppendOutcome::SpoolFull));
        let terminal = json!({"type":"prompt_result","status":"completed","sessionSettled":true});
        assert!(matches!(journal.store_frame(&spec.execution_id, &terminal, &serde_json::to_vec(&terminal).unwrap()).unwrap(), AppendOutcome::Stored));
        assert_eq!(journal.get_execution(&spec.execution_id).unwrap().unwrap().prompt_result.unwrap()["status"], "completed");
    }

    #[test]
    fn visible_tool_failure_survives_projection_at_a_multibyte_preview_boundary() {
        let failure = json!({"type":"tool_execution_end","toolName":"read","toolCallId":"failure",
            "isError":true,"result":{"content":[{"type":"text","text":format!("{}한", "x".repeat(2047))}]}});
        let projected = visible_agent_progress(&failure, "tool_execution_end").unwrap();
        assert_eq!(projected["is_error"], true);
        assert_eq!(projected["tool_name"], "read");
        assert_eq!(projected["result_preview"].as_str().unwrap(), "x".repeat(2047));
    }
}
