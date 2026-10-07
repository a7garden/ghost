//! Host browser boundary. The current executable constructor is fixture-only.
//! Page data never creates policy, identity, trusted control or replay authority.
use crate::provider_control::RunControl;
use crate::store::{ProfileStore, Task};
use anyhow::{anyhow, bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};

const MAX_LINE: usize = 65_536;
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS browser_grants(grant_id INTEGER PRIMARY KEY REFERENCES grants(id),session_uuid TEXT NOT NULL REFERENCES sessions(uuid),ops_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS browser_control(session_uuid TEXT PRIMARY KEY REFERENCES sessions(uuid),suspended INTEGER NOT NULL DEFAULT 0,blocked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS browser_children(scope TEXT PRIMARY KEY,session_uuid TEXT NOT NULL,host_instance TEXT NOT NULL,pid INTEGER NOT NULL,active INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS browser_local_launch(grant_id INTEGER PRIMARY KEY REFERENCES grants(id),origin TEXT NOT NULL,executable TEXT NOT NULL,exe_sha TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS browser_calls(request_id TEXT PRIMARY KEY,task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id),task_uuid TEXT NOT NULL,profile_uuid TEXT NOT NULL,session_uuid TEXT NOT NULL,child_scope TEXT NOT NULL,command_json TEXT NOT NULL,effect_id INTEGER NOT NULL REFERENCES effects(id),state TEXT NOT NULL,response_json TEXT,problem TEXT,review TEXT);
"#;
fn host_instance() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| uuid::Uuid::new_v4().to_string())
}
fn schema(store: &ProfileStore) -> Result<()> {
    store.conn.execute_batch(SCHEMA)?;
    Ok(())
}

/// A trusted local host capability, deliberately not Deserialize/Serialize and
/// not available in tool/page input. Current authority is fake-fixture only;
/// this is API separation, not a completed human authentication UI.
pub struct TrustedFixtureControl {
    owner: String,
    dir: PathBuf,
}
impl TrustedFixtureControl {
    #[cfg(feature = "browser-fixtures")]
    pub fn local_fixture_host(store: &ProfileStore) -> Self {
        Self {
            owner: store.uuid.clone(),
            dir: store.dir.clone(),
        }
    }
    fn check(&self, store: &ProfileStore) -> Result<()> {
        if self.owner != store.uuid || self.dir != store.dir {
            bail!("trusted control belongs to another Ghost");
        }
        Ok(())
    }
    pub fn approve(&self, store: &ProfileStore, session: &str, ops: &[BrowserOp]) -> Result<i64> {
        self.check(store)?;
        if store.session(session)?.is_none() || ops.is_empty() || ops.len() > 7 {
            bail!("invalid fixture grant");
        }
        schema(store)?;
        let tx = store.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO grants(path,operation,created_at) VALUES(?1,'browser_fixture',?2)",
            params![format!("fixture://local/{session}"), now()],
        )?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO browser_grants(grant_id,session_uuid,ops_json) VALUES(?1,?2,?3)",
            params![id, session, serde_json::to_string(ops)?],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO browser_control(session_uuid) VALUES(?1)",
            params![session],
        )?;
        tx.execute(
            "INSERT INTO audit(event,detail,at) VALUES('browser_fixture_granted',?1,?2)",
            params![id.to_string(), now()],
        )?;
        tx.commit()?;
        Ok(id)
    }
    pub fn revoke(&self, store: &ProfileStore, grant: i64) -> Result<()> {
        self.check(store)?;
        store.revoke(grant)?;
        Ok(())
    }
    /// Explicit manual acknowledgement keeps old unknown effects terminal and
    /// prohibits their replay. It allows a fresh empty child after handoff.
    pub fn reconcile_without_replay(
        &self,
        store: &ProfileStore,
        session: &str,
        reason: &str,
    ) -> Result<()> {
        self.check(store)?;
        if reason.trim().is_empty() || reason.len() > 512 {
            bail!("trusted reconciliation reason required");
        }
        schema(store)?;
        let active: bool = store.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM browser_children WHERE session_uuid=?1 AND active=1)",
            params![session],
            |r| r.get(0),
        )?;
        if active {
            bail!("stop owned child before trusted reconciliation");
        }
        store.recover_interrupted()?;
        recover(store)?;
        let tx = store.conn.unchecked_transaction()?;
        let n = tx.execute(
            "UPDATE browser_control SET suspended=0,blocked=0 WHERE session_uuid=?1",
            params![session],
        )?;
        if n != 1 {
            bail!("unknown browser session");
        }
        tx.execute("UPDATE browser_calls SET review='do_not_replay' WHERE session_uuid=?1 AND state='uncertain'",params![session])?;
        // Reason is trusted user data, never extracted from a tool result.
        tx.execute(
            "INSERT INTO audit(event,detail,at) VALUES('browser_trusted_reconcile',?1,?2)",
            params![reason, now()],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserOp {
    New,
    Tabs,
    Navigate,
    Snapshot,
    Click,
    Fill,
    Close,
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum BrowserCommand {
    New,
    Tabs,
    Navigate {
        tab_id: String,
        url: String,
    },
    Snapshot {
        tab_id: String,
    },
    Click {
        tab_id: String,
        r#ref: String,
    },
    Fill {
        tab_id: String,
        r#ref: String,
        value: String,
    },
    Close {
        tab_id: String,
    },
}
// Serde's internally tagged unit variants ignore extra fields even with
// deny_unknown_fields. Validate the whole map for every command shape.
impl<'de> Deserialize<'de> for BrowserCommand {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        use serde::de::Error;
        let value = Value::deserialize(deserializer)?;
        let obj = value
            .as_object()
            .ok_or_else(|| D::Error::custom("browser command must be an object"))?;
        let string = |key: &str| -> std::result::Result<String, D::Error> {
            obj.get(key)
                .and_then(Value::as_str)
                .map(String::from)
                .ok_or_else(|| D::Error::custom("browser command string field missing"))
        };
        let operation = string("operation")?;
        let allowed: &[&str] = match operation.as_str() {
            "new" | "tabs" => &["operation"],
            "navigate" => &["operation", "tab_id", "url"],
            "snapshot" | "close" => &["operation", "tab_id"],
            "click" => &["operation", "tab_id", "ref"],
            "fill" => &["operation", "tab_id", "ref", "value"],
            _ => return Err(D::Error::custom("unknown browser operation")),
        };
        if obj.len() != allowed.len() || obj.keys().any(|k| !allowed.contains(&k.as_str())) {
            return Err(D::Error::custom("browser command fields invalid"));
        }
        Ok(match operation.as_str() {
            "new" => Self::New,
            "tabs" => Self::Tabs,
            "navigate" => Self::Navigate {
                tab_id: string("tab_id")?,
                url: string("url")?,
            },
            "snapshot" => Self::Snapshot {
                tab_id: string("tab_id")?,
            },
            "close" => Self::Close {
                tab_id: string("tab_id")?,
            },
            "click" => Self::Click {
                tab_id: string("tab_id")?,
                r#ref: string("ref")?,
            },
            "fill" => Self::Fill {
                tab_id: string("tab_id")?,
                r#ref: string("ref")?,
                value: string("value")?,
            },
            _ => unreachable!(),
        })
    }
}
impl BrowserCommand {
    fn op(&self) -> BrowserOp {
        match self {
            Self::New => BrowserOp::New,
            Self::Tabs => BrowserOp::Tabs,
            Self::Navigate { .. } => BrowserOp::Navigate,
            Self::Snapshot { .. } => BrowserOp::Snapshot,
            Self::Click { .. } => BrowserOp::Click,
            Self::Fill { .. } => BrowserOp::Fill,
            Self::Close { .. } => BrowserOp::Close,
        }
    }
    fn wire(&self) -> (&'static str, Value) {
        match self {
            Self::New => ("browser_new", json!({})),
            Self::Tabs => ("browser_tabs", json!({})),
            Self::Navigate { tab_id, url } => {
                ("browser_navigate", json!({"tab_id":tab_id,"url":url}))
            }
            Self::Snapshot { tab_id } => ("browser_snapshot", json!({"tab_id":tab_id})),
            Self::Click { tab_id, r#ref } => {
                ("browser_click", json!({"tab_id":tab_id,"ref":r#ref}))
            }
            Self::Fill {
                tab_id,
                r#ref,
                value,
            } => (
                "browser_fill",
                json!({"tab_id":tab_id,"ref":r#ref,"value":value}),
            ),
            Self::Close { tab_id } => ("browser_close", json!({"tab_id":tab_id})),
        }
    }
    fn tab(&self) -> Option<&str> {
        match self {
            Self::New | Self::Tabs => None,
            Self::Navigate { tab_id, .. }
            | Self::Snapshot { tab_id }
            | Self::Click { tab_id, .. }
            | Self::Fill { tab_id, .. }
            | Self::Close { tab_id } => Some(tab_id),
        }
    }
}

fn policy(
    store: &ProfileStore,
    session: &str,
    grant: i64,
    op: Option<BrowserOp>,
    kind: &str,
) -> Result<()> {
    let row:Option<(String,String)>=store.conn.query_row("SELECT b.session_uuid,b.ops_json FROM browser_grants b JOIN grants g ON g.id=b.grant_id WHERE g.id=?1 AND g.revoked_at IS NULL AND g.operation=?2",params![grant,kind],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((bound, ops)) = row else {
        bail!("browser capability denied");
    };
    if bound != session {
        bail!("browser grant belongs to another session");
    }
    let ops: Vec<BrowserOp> = serde_json::from_str(&ops)?;
    if op.is_some_and(|op| !ops.contains(&op)) {
        bail!("browser operation denied");
    }
    let blocked: bool = store.conn.query_row(
        "SELECT suspended OR blocked FROM browser_control WHERE session_uuid=?1",
        params![session],
        |r| r.get(0),
    )?;
    if blocked {
        bail!("browser session requires trusted reconciliation; no automatic replay");
    }
    Ok(())
}
fn now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string()
}

/// Reconcile interrupted rows using existing canonical task/effect recovery.
/// A historical PID is never used to attach or signal any process.
pub fn recover(store: &ProfileStore) -> Result<()> {
    schema(store)?;
    let tx = store.conn.unchecked_transaction()?;
    tx.execute("UPDATE browser_control SET blocked=1 WHERE session_uuid IN (SELECT b.session_uuid FROM browser_calls b JOIN tasks t ON t.id=b.task_id WHERE b.state='pending' AND t.status='uncertain')",[])?;
    tx.execute("UPDATE browser_calls SET state='uncertain',problem='interrupted; no automatic replay' WHERE state='pending' AND task_id IN (SELECT id FROM tasks WHERE status='uncertain')",[])?;
    tx.execute(
        "UPDATE browser_children SET active=0 WHERE host_instance<>?1",
        params![host_instance()],
    )?;
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserReceipt {
    pub request_id: String,
    pub profile_uuid: String,
    pub session_uuid: String,
    pub task_uuid: String,
    pub child_scope: String,
    pub effect_id: i64,
    pub status: String,
    pub problem: Option<String>,
    /// Entire structured result is quarantined as page/tool data, not authority.
    pub untrusted_data: Option<Value>,
    pub review: Option<String>,
}
pub fn receipt(store: &ProfileStore, id: &str) -> Result<Option<BrowserReceipt>> {
    let exists: bool = store.conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='browser_calls')",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(None);
    }
    let row=store.conn.query_row("SELECT b.request_id,b.profile_uuid,b.session_uuid,b.task_uuid,b.child_scope,b.effect_id,t.status,b.problem,b.response_json,b.review FROM browser_calls b JOIN tasks t ON t.id=b.task_id WHERE b.request_id=?1 AND b.profile_uuid=?2",params![id,store.uuid],|r|Ok((BrowserReceipt {request_id:r.get(0)?,profile_uuid:r.get(1)?,session_uuid:r.get(2)?,task_uuid:r.get(3)?,child_scope:r.get(4)?,effect_id:r.get(5)?,status:r.get(6)?,problem:r.get(7)?,untrusted_data:None,review:r.get(9)?},r.get::<_,Option<String>>(8)?))).optional()?;
    row.map(|(mut out, data)| {
        out.untrusted_data = data.map(|d| serde_json::from_str(&d)).transpose()?;
        Ok(out)
    })
    .transpose()
}

struct OwnedChild {
    child: Child,
    #[cfg(feature = "browser-local-e2e")]
    kill_after_write: bool,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl OwnedChild {
    async fn exchange(&mut self, request: &Value, control: &RunControl) -> Result<Value> {
        let mut line = serde_json::to_vec(request)?;
        line.push(b'\n');
        if line.len() > MAX_LINE {
            bail!("browser request limit");
        }
        tokio::select! {biased;
            _=control.cancellation.cancelled()=>{self.cancel(request["id"].clone()).await;Err(anyhow!("cancelled; outcome unknown"))},
            _=tokio::time::sleep(control.timeout)=>{self.cancel(request["id"].clone()).await;Err(anyhow!("timeout; outcome unknown"))},
            result=async {
                self.input.write_all(&line).await?;self.input.flush().await?;
                #[cfg(feature="browser-local-e2e")]
                if self.kill_after_write {self.kill_after_write=false;self.child.start_kill()?;}
                let mut bytes=Vec::new();(&mut self.output).take((MAX_LINE+1) as u64).read_until(b'\n',&mut bytes).await?;
                if bytes.is_empty() || bytes.len()>MAX_LINE || bytes.last()!=Some(&b'\n') {bail!("browser transport ended or exceeded limit");}
                let response:Value=serde_json::from_slice(&bytes).map_err(|_|anyhow!("browser invalid JSON"))?;
                if response["jsonrpc"]!="2.0" || response["id"]!=request["id"] {bail!("browser response correlation mismatch");}Ok(response)
            }=>result,
        }
    }
    async fn cancel(&mut self, id: Value) {
        let line = format!(
            "{}\n",
            json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id}})
        );
        let _ = tokio::time::timeout(
            Duration::from_millis(50),
            self.input.write_all(line.as_bytes()),
        )
        .await;
    }
    async fn stop(&mut self) {
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(1), self.child.wait()).await;
    }
}

/// Exactly one owned child per Ghost/session. This host borrows its writer
/// store so cleanup cannot outlive it. No PID-based attach or global shutdown.
pub struct BrowserHost<'a> {
    store: &'a ProfileStore,
    session: String,
    grant: i64,
    scope: String,
    runtime: tokio::runtime::Runtime,
    child: OwnedChild,
    alive: bool,
    kind: &'static str,
    local_origin: Option<String>,
    tabs: HashSet<String>,
    retired: HashSet<String>,
    refs: HashMap<String, HashMap<String, bool>>,
}
impl<'a> BrowserHost<'a> {
    /// Test feature only: explicit fixture executable and fixture mode. No
    /// shell, environment auth, arbitrary browser options or live-site launch.
    #[cfg(feature = "browser-fixtures")]
    pub fn start_fixture(
        store: &'a ProfileStore,
        session: &str,
        grant: i64,
        executable: &std::path::Path,
        mode: &str,
        log: &std::path::Path,
    ) -> Result<Self> {
        if tokio::runtime::Handle::try_current().is_ok() {
            bail!("browser host requires a blocking worker");
        }
        if ![
            "normal",
            "crash",
            "late",
            "very_late",
            "unknown",
            "forged",
            "huge",
            "wrong_id",
            "child_error",
            "bad_content",
            "bad_snapshot",
        ]
        .contains(&mode)
        {
            bail!("invalid fixture mode");
        }
        Self::start_child(
            store,
            session,
            grant,
            executable,
            vec![
                "--ghost".into(),
                store.uuid.clone(),
                "--mode".into(),
                mode.into(),
                "--log".into(),
                log.to_str().ok_or_else(|| anyhow!("fixture path"))?.into(),
            ],
            "browser_fixture",
            None,
        )
    }
    #[cfg(feature = "browser-fixtures")]
    fn start_child(
        store: &'a ProfileStore,
        session: &str,
        grant: i64,
        executable: &std::path::Path,
        args: Vec<String>,
        kind: &'static str,
        local_origin: Option<String>,
    ) -> Result<Self> {
        if tokio::runtime::Handle::try_current().is_ok() {
            bail!("browser host requires a blocking worker");
        }
        recover(store)?;
        policy(store, session, grant, None, kind)?;
        let active: bool = store.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM browser_children WHERE session_uuid=?1 AND active=1)",
            params![session],
            |r| r.get(0),
        )?;
        if active {
            bail!("browser child already owned by this session");
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let mut owned = runtime.block_on(async {
            let mut child = tokio::process::Command::new(executable)
                .args(args)
                .env_clear()
                .current_dir(&store.dir)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .map_err(|_| anyhow!("fixture spawn failed"))?;
            let input = child.stdin.take().ok_or_else(|| anyhow!("child stdin"))?;
            let output =
                BufReader::new(child.stdout.take().ok_or_else(|| anyhow!("child stdout"))?);
            Ok::<_, anyhow::Error>(OwnedChild {
                child,
                #[cfg(feature = "browser-local-e2e")]
                kill_after_write: false,
                input,
                output,
            })
        })?;
        let id = uuid::Uuid::new_v4().to_string();
        let init = json!({"jsonrpc":"2.0","id":id,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ghost-fixture-host","version":"0.1"}}});
        let response = runtime.block_on(owned.exchange(
            &init,
            &RunControl {
                timeout: Duration::from_secs(3),
                ..Default::default()
            },
        ));
        let scope = match response.and_then(|v| {
            v["result"]["_meta"]["browserSessionId"]
                .as_str()
                .filter(|s| uuid::Uuid::parse_str(s).is_ok())
                .map(str::to_string)
                .ok_or_else(|| anyhow!("invalid initialize scope"))
        }) {
            Ok(scope) => scope,
            Err(error) => {
                runtime.block_on(owned.stop());
                return Err(error);
            }
        };
        if let Err(error)=store.conn.execute("INSERT INTO browser_children(scope,session_uuid,host_instance,pid,active) VALUES(?1,?2,?3,?4,1)",params![scope,session,host_instance(),owned.child.id().unwrap_or(0)]) {runtime.block_on(owned.stop());return Err(error.into());}
        Ok(Self {
            store,
            session: session.into(),
            grant,
            scope,
            runtime,
            child: owned,
            alive: true,
            kind,
            local_origin,
            tabs: HashSet::new(),
            retired: HashSet::new(),
            refs: HashMap::new(),
        })
    }
    pub fn scope(&self) -> &str {
        &self.scope
    }
    pub fn pid(&self) -> Option<u32> {
        self.child.child.id()
    }
    pub fn is_alive(&self) -> bool {
        self.alive
    }
    fn owner(&self, store: &ProfileStore) -> Result<()> {
        if store.uuid != self.store.uuid || store.dir != self.store.dir {
            bail!("browser child belongs to another Ghost");
        }
        Ok(())
    }
    fn validate_command(&self, cmd: &BrowserCommand) -> Result<()> {
        if let Some(tab) = cmd.tab() {
            if !self.tabs.contains(tab) {
                bail!("unknown or closed browser tab");
            }
        }
        match cmd {
            BrowserCommand::Navigate { url, .. } if url != "about:blank" => {
                let parsed =
                    reqwest::Url::parse(url).map_err(|_| anyhow!("local browser target denied"))?;
                if self.local_origin.as_deref()
                    != Some(parsed.origin().ascii_serialization().as_str())
                    || parsed.scheme() != "http"
                    || parsed.host_str() != Some("127.0.0.1")
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || parsed.fragment().is_some()
                {
                    bail!("local browser target denied");
                }
            }
            BrowserCommand::Click { tab_id, r#ref }
            | BrowserCommand::Fill { tab_id, r#ref, .. } => {
                let fillable = self
                    .refs
                    .get(tab_id)
                    .and_then(|refs| refs.get(r#ref))
                    .ok_or_else(|| anyhow!("stale or cross-child snapshot ref"))?;
                if matches!(cmd, BrowserCommand::Fill { .. }) && !fillable {
                    bail!("snapshot ref is not fillable");
                }
            }
            _ => {}
        }
        if let BrowserCommand::Fill { value, .. } = cmd {
            if value.len() > 4096 {
                bail!("fixture fill value exceeds limit");
            }
        }
        Ok(())
    }
    fn data(&self, response: Value, id: &str, task: &Task) -> Result<(Value, bool)> {
        let result = response
            .get("result")
            .ok_or_else(|| anyhow!("browser RPC error"))?;
        let meta = &result["_meta"];
        if meta["ghostId"] != self.store.uuid
            || meta["ghostTaskId"] != task.uuid
            || meta["requestId"] != id
            || meta["browserSessionId"] != self.scope
            || meta["trust"] != "untrusted_tool_data"
        {
            bail!("browser response correlation mismatch");
        }
        let data = result
            .get("structuredContent")
            .filter(|d| d.is_object())
            .ok_or_else(|| anyhow!("browser missing structured data"))?
            .clone();
        let content = result["content"]
            .as_array()
            .filter(|a| a.len() == 1)
            .ok_or_else(|| anyhow!("browser content mismatch"))?;
        if content[0]["type"] != "text"
            || content[0]["text"]
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .as_ref()
                != Some(&data)
        {
            bail!("browser content mismatch");
        }
        let failed = result["isError"]
            .as_bool()
            .ok_or_else(|| anyhow!("browser missing result state"))?;
        if failed
            && (data["mayHaveActed"].as_bool() != Some(false)
                || data["restartRequired"].as_bool() != Some(false))
        {
            bail!("browser may have acted; outcome unknown");
        }
        Ok((data, failed))
    }
    fn observations(&mut self, cmd: &BrowserCommand, data: &Value) -> Result<()> {
        match cmd {
            BrowserCommand::New => {
                let tab = data["tab_id"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 128)
                    .ok_or_else(|| anyhow!("browser invalid new tab"))?;
                if self.tabs.contains(tab) || self.retired.contains(tab) || self.tabs.len() >= 64 {
                    bail!("browser tab reuse or limit");
                }
                self.tabs.insert(tab.into());
            }
            BrowserCommand::Snapshot { tab_id } => {
                if data["browser_session_id"] != self.scope
                    || data["tab_id"] != *tab_id
                    || data["generation"].as_u64().is_none()
                    || data["trust"] != "untrusted_page_data"
                {
                    bail!("browser invalid snapshot scope");
                }
                let elements = data["elements"]
                    .as_array()
                    .filter(|a| a.len() <= 64)
                    .ok_or_else(|| anyhow!("browser snapshot bound"))?;
                let mut refs = HashMap::new();
                for element in elements {
                    let r = element["ref"]
                        .as_str()
                        .filter(|s| {
                            s.len() <= 256 && s.starts_with(&format!("{}:{tab_id}:", self.scope))
                        })
                        .ok_or_else(|| anyhow!("browser invalid snapshot ref"))?;
                    let fillable = element["fillable"]
                        .as_bool()
                        .ok_or_else(|| anyhow!("browser invalid fillable flag"))?;
                    if refs.insert(r.into(), fillable).is_some() {
                        bail!("duplicate snapshot ref");
                    }
                }
                self.refs.insert(tab_id.clone(), refs);
            }
            BrowserCommand::Close { tab_id } => {
                self.tabs.remove(tab_id);
                self.retired.insert(tab_id.clone());
            }
            _ => {}
        }
        Ok(())
    }
    pub fn execute(
        &mut self,
        store: &ProfileStore,
        task_id: i64,
        id: &str,
        cmd: BrowserCommand,
        control: &RunControl,
    ) -> Result<BrowserReceipt> {
        self.owner(store)?;
        if id.is_empty() || id.len() > 128 {
            bail!("invalid browser request ID");
        }
        let task = store
            .task_by_id(task_id)?
            .ok_or_else(|| anyhow!("browser task not found"))?;
        let encoded = serde_json::to_string(&cmd)?;
        let existing: Option<(String, String)> = store
            .conn
            .query_row(
                "SELECT task_uuid,command_json FROM browser_calls WHERE request_id=?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((old_task, old_cmd)) = existing {
            if old_task != task.uuid || old_cmd != encoded {
                bail!("browser request ID conflict");
            }
            // Durable duplicates never forward, even after grants/child expire.
            return receipt(store, id)?.ok_or_else(|| anyhow!("missing browser receipt"));
        }
        let attempted: bool = store.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM browser_calls WHERE task_id=?1)",
            params![task.id],
            |r| r.get(0),
        )?;
        if attempted || task.status != "queued" {
            bail!("browser task already attempted; no automatic replay");
        }
        if task.session_id != self.session || task.read_path.is_some() || task.write_path.is_some()
        {
            bail!("browser task session or capability mismatch");
        }
        if !self.alive {
            bail!("browser owned child is closed");
        }
        policy(store, &self.session, self.grant, Some(cmd.op()), self.kind)?;
        self.validate_command(&cmd)?;
        if control.timeout.is_zero() || control.timeout > Duration::from_secs(30) {
            bail!("invalid browser deadline");
        }
        if control.cancellation.is_cancelled() {
            store.cancel(&task.uuid)?;
            bail!("browser cancelled before dispatch");
        }
        let (name, args) = cmd.wire();
        let request = json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":args,"_meta":{"ghostTaskId":task.uuid,"timeoutMs":control.timeout.as_millis().max(1)}}});
        if serde_json::to_vec(&request)?.len() + 1 > MAX_LINE {
            bail!("browser request exceeds limit");
        }
        let tx = store.conn.unchecked_transaction()?;
        let changed = tx.execute(
            "UPDATE tasks SET status='running',updated_at=?1 WHERE id=?2 AND status='queued'",
            params![now(), task.id],
        )?;
        if changed != 1 {
            bail!("browser task not queued");
        }
        tx.execute("INSERT INTO effects(task_id,action,target,grant_id,status,started_at) VALUES(?1,'browser',?2,?3,'started',?4)",params![task.id,encoded,self.grant,now()])?;
        let effect = tx.last_insert_rowid();
        tx.execute("INSERT INTO browser_calls(request_id,task_id,task_uuid,profile_uuid,session_uuid,child_scope,command_json,effect_id,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'pending')",params![id,task.id,task.uuid,store.uuid,self.session,self.scope,encoded,effect])?;
        tx.execute(
            "INSERT INTO audit(task_id,event,detail,at) VALUES(?1,'browser_intent',?2,?3)",
            params![task.id, id, now()],
        )?;
        tx.commit()?;
        // Observations are invalidated before every forwarded attempt.
        if let Some(tab) = cmd.tab() {
            self.refs.remove(tab);
        }
        let outcome = self
            .runtime
            .block_on(self.child.exchange(&request, control))
            .and_then(|response| self.data(response, id, &task))
            .and_then(|(data, failed)| {
                if !failed {
                    self.observations(&cmd, &data)?;
                }
                Ok((data, failed))
            });
        let (status, data, problem) = match outcome {
            Ok((data, false)) => ("completed", Some(data), None),
            Ok((data, true)) => ("failed", Some(data), Some("browser rejected operation")),
            Err(_) => (
                "uncertain",
                None,
                Some(
                    "browser interrupted or invalid receipt; outcome unknown; no automatic replay",
                ),
            ),
        };
        if status == "uncertain" {
            self.shutdown();
            store.conn.execute(
                "UPDATE browser_control SET blocked=1 WHERE session_uuid=?1",
                params![self.session],
            )?;
        }
        if let Err(error) = finish(store, &task, id, effect, status, data.as_ref(), problem) {
            self.shutdown();
            let _ = store.conn.execute(
                "UPDATE browser_control SET blocked=1 WHERE session_uuid=?1",
                params![self.session],
            );
            return Err(error);
        }
        receipt(store, id)?.ok_or_else(|| anyhow!("browser receipt missing"))
    }
    pub fn handoff(&mut self, store: &ProfileStore, trusted: &TrustedFixtureControl) -> Result<()> {
        self.owner(store)?;
        trusted.check(store)?;
        self.shutdown();
        store.conn.execute(
            "UPDATE browser_control SET suspended=1 WHERE session_uuid=?1",
            params![self.session],
        )?;
        store.audit(
            None,
            "browser_trusted_handoff",
            "owned child stopped; observations invalidated",
        )?;
        Ok(())
    }
    pub fn shutdown(&mut self) {
        if self.alive {
            self.runtime.block_on(self.child.stop());
            self.alive = false;
            self.tabs.clear();
            self.refs.clear();
            let _ = self.store.conn.execute(
                "UPDATE browser_children SET active=0 WHERE scope=?1 AND host_instance=?2",
                params![self.scope, host_instance()],
            );
        }
    }
}
impl Drop for BrowserHost<'_> {
    fn drop(&mut self) {
        self.shutdown();
    }
}
fn finish(
    store: &ProfileStore,
    task: &Task,
    id: &str,
    effect: i64,
    status: &str,
    data: Option<&Value>,
    problem: Option<&str>,
) -> Result<()> {
    let tx = store.conn.unchecked_transaction()?;
    finish_transaction(&tx, &store.uuid, task, id, effect, status, data, problem)?;
    tx.commit()?;
    Ok(())
}
#[allow(clippy::too_many_arguments)]
fn finish_transaction(
    tx: &rusqlite::Transaction,
    profile_uuid: &str,
    task: &Task,
    id: &str,
    effect: i64,
    status: &str,
    data: Option<&Value>,
    problem: Option<&str>,
) -> Result<()> {
    let payload = serde_json::to_string(
        &json!({"request_id":id,"trust":"untrusted_tool_data","data":data,"problem":problem}),
    )?;
    let changed = tx.execute(
        "UPDATE tasks SET status=?1,output=?2,updated_at=?3 WHERE id=?4 AND status='running'",
        params![status, payload, now(), task.id],
    )?;
    if changed != 1 {
        bail!("browser completion state mismatch");
    }
    let changed = tx.execute(
        "UPDATE effects SET status=?1,finished_at=?2 WHERE id=?3 AND status='started'",
        params![status, now(), effect],
    )?;
    if changed != 1 {
        bail!("browser effect ledger mismatch");
    }
    let changed=tx.execute("UPDATE browser_calls SET state=?1,response_json=?2,problem=?3 WHERE request_id=?4 AND effect_id=?5 AND state='pending'",params![status,data.map(serde_json::to_string).transpose()?,problem,id,effect])?;
    if changed != 1 {
        bail!("browser receipt ledger mismatch");
    }
    tx.execute("INSERT INTO outbox(task_id,task_uuid,message_id,session_id,profile_uuid,content,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![task.id,task.uuid,task.message_id,task.session_id,profile_uuid,payload,status,now()])?;
    tx.execute(
        "INSERT INTO audit(task_id,event,detail,at) VALUES(?1,'browser_receipt',?2,?3)",
        params![task.id, status, now()],
    )?;
    Ok(())
}

/// Explicit trusted test-harness pin. Never Deserialize or auto-discover a
/// browser/profile. The only admitted network origin is a literal loopback port.
#[cfg(feature = "browser-local-e2e")]
#[derive(Clone)]
pub struct ApprovedLocalBrowser {
    executable: PathBuf,
    sha: String,
    origin: String,
}
#[cfg(feature = "browser-local-e2e")]
impl ApprovedLocalBrowser {
    pub fn local_origin(&self) -> &str {
        &self.origin
    }
    pub fn pin(executable: &std::path::Path, expected_sha: &str, origin: &str) -> Result<Self> {
        let url =
            reqwest::Url::parse(origin).map_err(|_| anyhow!("local fixture origin required"))?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none_or(|p| p < 1024)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("local fixture origin required");
        }
        if expected_sha.len() != 64
            || !expected_sha.bytes().all(|b| b.is_ascii_hexdigit())
            || executable.symlink_metadata()?.file_type().is_symlink()
        {
            bail!("invalid browser artifact pin");
        }
        let out = Self {
            executable: executable.canonicalize()?,
            sha: expected_sha.into(),
            origin: url.origin().ascii_serialization(),
        };
        out.verify()?;
        Ok(out)
    }
    fn verify(&self) -> Result<()> {
        use sha2::{Digest, Sha256};
        use std::sync::Mutex;
        // In-process test cache is keyed by path, size and modification time.
        // The caller owns the pinned fixture copy. This is not a complete
        // hostile-file TOCTOU solution or a production signature verifier.
        type Entry = (PathBuf, u64, std::time::SystemTime, String);
        static CACHE: OnceLock<Mutex<Option<Entry>>> = OnceLock::new();
        let meta = self.executable.metadata()?;
        if !meta.is_file() || meta.len() > 500_000_000 {
            bail!("browser artifact bounds");
        }
        let modified = meta.modified()?;
        let mut cache = CACHE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| anyhow!("browser pin cache"))?;
        if let Some((path, len, time, sha)) = &*cache {
            if path == &self.executable && *len == meta.len() && *time == modified {
                if sha != &self.sha {
                    bail!("browser artifact SHA mismatch");
                }
                return Ok(());
            }
        }
        let mut file = std::fs::File::open(&self.executable)?;
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut hash = Sha256::new();
        loop {
            let n = std::io::Read::read(&mut file, &mut buffer)?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        let actual = format!("{:x}", hash.finalize());
        if actual != self.sha {
            bail!("browser artifact SHA mismatch");
        }
        *cache = Some((self.executable.clone(), meta.len(), modified, actual));
        Ok(())
    }
}
#[cfg(feature = "browser-local-e2e")]
impl TrustedFixtureControl {
    pub fn approve_local_browser(
        &self,
        store: &ProfileStore,
        session: &str,
        ops: &[BrowserOp],
        pin: &ApprovedLocalBrowser,
    ) -> Result<i64> {
        self.check(store)?;
        pin.verify()?;
        if store.session(session)?.is_none() || ops.is_empty() || ops.len() > 7 {
            bail!("invalid local browser grant");
        }
        schema(store)?;
        let tx = store.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO grants(path,operation,created_at) VALUES(?1,'browser_local_fixture',?2)",
            params![pin.origin, now()],
        )?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO browser_grants(grant_id,session_uuid,ops_json) VALUES(?1,?2,?3)",
            params![id, session, serde_json::to_string(ops)?],
        )?;
        tx.execute("INSERT INTO browser_local_launch(grant_id,origin,executable,exe_sha) VALUES(?1,?2,?3,?4)",params![id,pin.origin,pin.executable.to_str(),pin.sha])?;
        tx.execute(
            "INSERT OR IGNORE INTO browser_control(session_uuid) VALUES(?1)",
            params![session],
        )?;
        tx.execute(
            "INSERT INTO audit(event,detail,at) VALUES('browser_local_fixture_granted',?1,?2)",
            params![id.to_string(), now()],
        )?;
        tx.commit()?;
        Ok(id)
    }
}
#[cfg(feature = "browser-local-e2e")]
impl<'a> BrowserHost<'a> {
    pub fn start_local_oxibrowser(
        store: &'a ProfileStore,
        session: &str,
        grant: i64,
        pin: &ApprovedLocalBrowser,
    ) -> Result<Self> {
        recover(store)?;
        policy(store, session, grant, None, "browser_local_fixture")?;
        let binding: (String, String, String) = store.conn.query_row(
            "SELECT origin,executable,exe_sha FROM browser_local_launch WHERE grant_id=?1",
            params![grant],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if binding
            != (
                pin.origin.clone(),
                pin.executable
                    .to_str()
                    .ok_or_else(|| anyhow!("browser path"))?
                    .into(),
                pin.sha.clone(),
            )
        {
            bail!("local browser launch scope mismatch");
        }
        pin.verify()?;
        if !cfg!(target_os = "macos") {
            bail!("local browser sandbox is verified only on macOS");
        }
        let profile = local_sandbox(store, pin)?;
        let args = vec![
            "-f".into(),
            profile.to_str().unwrap().into(),
            pin.executable.to_str().unwrap().into(),
            "serve".into(),
            "--mcp".into(),
            "--ghost".into(),
            store.uuid.clone(),
            "--allow-private-ips".into(),
        ];
        let result = Self::start_child(
            store,
            session,
            grant,
            std::path::Path::new("/usr/bin/sandbox-exec"),
            args,
            "browser_local_fixture",
            Some(pin.origin.clone()),
        );
        let _ = std::fs::remove_file(profile);
        result
    }
    /// Fault injection targets only this owned real child after next stdin write.
    pub fn kill_after_next_write_for_test(&mut self) {
        self.child.kill_after_write = true;
    }
}

#[cfg(feature = "browser-local-e2e")]
fn local_sandbox(store: &ProfileStore, pin: &ApprovedLocalBrowser) -> Result<PathBuf> {
    let profile = store
        .dir
        .join(format!("browser-local-{}.sb", uuid::Uuid::new_v4()));
    let port = reqwest::Url::parse(&pin.origin)?.port().unwrap();
    let quote = |s: &str| serde_json::to_string(s).unwrap();
    let mut policy_text=format!("(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote ip \"localhost:{port}\"))\n");
    // Ephemeral per-child containment, never a persistent security change.
    policy_text
        .push_str("(deny file-write* (subpath \"/Users/garden/Documents/Workspace/Projects\"))\n");
    for path in [
        "/Users/garden/.config",
        "/Users/garden/.codex",
        "/Users/garden/.omp",
        "/Users/garden/.aws",
        "/Users/garden/.ssh",
        "/Users/garden/Library/Keychains",
        "/Users/garden/Library/Cookies",
        "/Users/garden/Library/WebKit",
        "/Users/garden/Library/Application Support",
        "/Users/garden/Library/Containers",
    ] {
        policy_text += &format!("(deny file-read* file-write* (subpath {}))\n", quote(path));
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&profile)?;
    std::io::Write::write_all(&mut file, policy_text.as_bytes())?;
    drop(file);
    Ok(profile)
}

#[cfg(all(feature = "browser-handoff-fixtures", unix))]
pub mod handoff;
