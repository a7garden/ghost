//! Fixture-only trusted supervisor. Private descriptor is never an agent tool.
use super::*;
use crate::provider_control::Cancellation;
use std::io::{BufRead, Read, Write};
use std::net::Shutdown;
use std::os::fd::AsRawFd;
use std::os::unix::{net::UnixStream, process::CommandExt};
use std::process::{Child as StdChild, ChildStdin as StdIn, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::Instant;

const SQL: &str = r#"
CREATE TABLE IF NOT EXISTS hc_grants(grant_id INTEGER PRIMARY KEY REFERENCES grants(id),anchor_uuid TEXT NOT NULL REFERENCES tasks(uuid));
CREATE TABLE IF NOT EXISTS hc_state(scope TEXT PRIMARY KEY,session_uuid TEXT NOT NULL,anchor_uuid TEXT NOT NULL,grant_id INTEGER NOT NULL,host_instance TEXT NOT NULL,state_json TEXT NOT NULL,active INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hc_requests(key TEXT PRIMARY KEY,scope TEXT NOT NULL,channel TEXT NOT NULL,request_id TEXT NOT NULL,spec_json TEXT NOT NULL,wire_json TEXT NOT NULL,epoch INTEGER NOT NULL,phase TEXT NOT NULL,task_id INTEGER, state TEXT NOT NULL,receipt_json TEXT);
"#;
fn init(store: &ProfileStore) -> Result<()> {
    schema(store)?;
    store.conn.execute_batch(SQL)?;
    Ok(())
}
/// Run after canonical ProfileStore recovery. Never reconstruct an old child.
pub fn recover_controlled(store: &ProfileStore) -> Result<()> {
    init(store)?;
    super::recover(store)?;
    let tx = store.conn.unchecked_transaction()?;
    tx.execute("UPDATE browser_control SET blocked=1 WHERE session_uuid IN (SELECT session_uuid FROM hc_state WHERE active=1 AND (host_instance<>?1 OR scope IN (SELECT scope FROM browser_children WHERE active=0)))",params![host_instance()])?;
    tx.execute("UPDATE hc_requests SET state='uncertain' WHERE state='pending' AND scope IN (SELECT scope FROM hc_state WHERE host_instance<>?1 OR active=0 OR scope IN (SELECT scope FROM browser_children WHERE active=0))",params![host_instance()])?;
    let rows: Vec<(String, String)> = {
        let mut q = tx
            .prepare("SELECT scope,state_json FROM hc_state WHERE host_instance<>?1 OR active=0 OR scope IN (SELECT scope FROM browser_children WHERE active=0)")?;
        let rows = q.query_map(params![host_instance()], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (scope, data) in rows {
        let mut state: HostState = serde_json::from_str(&data)?;
        state.state = Phase::Closed;
        state.fresh_observation_required = false;
        state.tabs_to_observe.clear();
        tx.execute(
            "UPDATE hc_state SET active=0,state_json=?1 WHERE scope=?2",
            params![serde_json::to_string(&state)?, scope],
        )?;
    }
    tx.commit()?;
    Ok(())
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Phase {
    #[serde(rename = "agent_active")]
    Agent,
    #[serde(rename = "pause_requested")]
    Pausing,
    #[serde(rename = "human_owned")]
    Human,
    #[serde(rename = "resume_pending")]
    Refresh,
    #[serde(rename = "closed")]
    Closed,
}
impl Phase {
    fn label(self) -> &'static str {
        match self {
            Self::Agent => "agent_active",
            Self::Pausing => "pause_requested",
            Self::Human => "human_owned",
            Self::Refresh => "resume_pending",
            Self::Closed => "closed",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostState {
    pub browser_session_id: String,
    pub ghost_task_id: String,
    pub control_epoch: u64,
    pub state: Phase,
    pub handoff_id: Option<String>,
    pub control_available: bool,
    pub fresh_observation_required: bool,
    pub tabs_to_observe: Vec<String>,
    pub scripts_frozen: bool,
    pub network_frozen: bool,
    pub trust: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ControlReceipt {
    pub request_id: String,
    pub channel: String,
    pub child_scope: String,
    pub anchor_uuid: String,
    pub activity_uuid: Option<String>,
    pub admitted_epoch: u64,
    pub status: String,
    /// Historical data only. Current authority is state(), never this payload.
    pub historical_data: Option<Value>,
}
#[derive(Clone, Debug)]
pub struct RequestHandle {
    key: String,
    scope: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Channel {
    Agent,
    Host,
}
impl Channel {
    fn label(self) -> &'static str {
        if self == Self::Agent {
            "agent"
        } else {
            "host"
        }
    }
}
struct Arm {
    end: Instant,
    cancel: Cancellation,
}
struct Life {
    closed: AtomicBool,
    reaped: AtomicBool,
    stop: AtomicBool,
    arms: Mutex<HashMap<String, Arm>>,
    reason: Mutex<&'static str>,
}
impl Life {
    fn fail(&self, why: &'static str) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            *self.reason.lock().unwrap() = why;
        }
    }
    fn arm(&self, c: Channel, id: &str, ctl: &RunControl) {
        self.arms.lock().unwrap().insert(
            format!("{}:{id}", c.label()),
            Arm {
                end: Instant::now() + ctl.timeout,
                cancel: ctl.cancellation.clone(),
            },
        );
    }
    fn received(&self, c: Channel, v: &Value) {
        let id = if v["method"] == "ghost/ready" {
            Some("@ready")
        } else {
            v["id"].as_str()
        };
        if let Some(id) = id {
            self.arms
                .lock()
                .unwrap()
                .remove(&format!("{}:{id}", c.label()));
        }
    }
}
struct Frame {
    channel: Channel,
    value: Value,
    at: Instant,
}
struct Process {
    profile: PathBuf,
    child: Arc<Mutex<StdChild>>,
    input: StdIn,
    writer: Option<UnixStream>,
    life: Arc<Life>,
    incoming: Receiver<Frame>,
    threads: Vec<JoinHandle<()>>,
}
fn reader<R: Read + Send + 'static>(
    source: R,
    channel: Channel,
    tx: mpsc::SyncSender<Frame>,
    life: Arc<Life>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut r = std::io::BufReader::new(source);
        loop {
            let mut line = Vec::new();
            match r
                .by_ref()
                .take((MAX_LINE + 1) as u64)
                .read_until(b'\n', &mut line)
            {
                Ok(n) if n > 0 && line.len() <= MAX_LINE && line.last() == Some(&b'\n') => {}
                _ => {
                    life.fail("channel EOF or bound violation");
                    break;
                }
            }
            let Ok(v) = serde_json::from_slice::<Value>(&line) else {
                life.fail("invalid JSON frame");
                break;
            };
            life.received(channel, &v);
            if tx
                .try_send(Frame {
                    channel,
                    value: v,
                    at: Instant::now(),
                })
                .is_err()
            {
                life.fail("channel queue limit");
                break;
            }
        }
    })
}
impl Process {
    fn spawn(
        store: &ProfileStore,
        grant: i64,
        anchor: &str,
        pin: &ApprovedLocalBrowser,
    ) -> Result<Self> {
        let (local, remote) = UnixStream::pair()?;
        let fd = remote.as_raw_fd();
        local.set_write_timeout(Some(Duration::from_millis(200)))?;
        let profile = super::local_sandbox(store, pin)?;
        let mut cmd = Command::new("/usr/bin/sandbox-exec");
        cmd.args([
            "-f",
            profile.to_str().unwrap(),
            pin.executable.to_str().unwrap(),
            "serve",
            "--mcp",
            "--ghost",
            &store.uuid,
            "--ghost-task",
            anchor,
            "--ghost-control-fd",
            &fd.to_string(),
            "--allow-private-ips",
        ])
        .env_clear()
        .current_dir(&store.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
        // Only the child endpoint changes CLOEXEC, in the post-fork child.
        unsafe {
            cmd.pre_exec(move || {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let spawned = cmd.spawn();
        drop(remote);
        let mut child = match spawned {
            Ok(child) => child,
            Err(_) => {
                let _ = std::fs::remove_file(&profile);
                bail!("controlled fixture spawn failed");
            }
        };
        let input = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("stdout unavailable"))?;
        let child = Arc::new(Mutex::new(child));
        let life = Arc::new(Life {
            closed: AtomicBool::new(false),
            reaped: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            arms: Mutex::new(HashMap::new()),
            reason: Mutex::new("closed"),
        });
        life.arm(
            Channel::Host,
            "@ready",
            &RunControl {
                timeout: Duration::from_secs(3),
                ..Default::default()
            },
        );
        let (tx, incoming) = mpsc::sync_channel(32);
        let mut threads = vec![
            reader(stdout, Channel::Agent, tx.clone(), life.clone()),
            reader(local.try_clone()?, Channel::Host, tx, life.clone()),
        ];
        let watched = child.clone();
        let signal = life.clone();
        let db = store.dir.join("ghost.db");
        let anchor = anchor.to_string();
        threads.push(std::thread::spawn(move|| {
            let db=rusqlite::Connection::open_with_flags(db,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY);
            if let Ok(db)=&db {let _=db.busy_timeout(Duration::from_millis(50));}
            loop {
                if signal.stop.load(Ordering::SeqCst) {signal.fail("owned host shutdown");}
                let expired=signal.arms.lock().unwrap().values().any(|a|Instant::now()>=a.end || a.cancel.is_cancelled());
                if expired {signal.fail("owned watchdog deadline or cancellation");}
                let approved=db.as_ref().ok().and_then(|db| db.query_row("SELECT EXISTS(SELECT 1 FROM grants g JOIN hc_grants h ON h.grant_id=g.id JOIN tasks t ON t.uuid=h.anchor_uuid WHERE g.id=?1 AND g.revoked_at IS NULL AND g.operation='browser_control_fixture' AND t.uuid=?2 AND t.status='queued')",params![grant,anchor],|r|r.get::<_,bool>(0)).ok()).unwrap_or(false);
                if !approved {signal.fail("control grant or anchor revoked");}
                if signal.closed.load(Ordering::SeqCst) {
                    let mut p=watched.lock().unwrap();let _=p.kill();
                    let end=Instant::now()+Duration::from_millis(500);
                    while Instant::now()<end {if matches!(p.try_wait(),Ok(Some(_))) {signal.reaped.store(true,Ordering::SeqCst);break;}std::thread::sleep(Duration::from_millis(5));}
                    break;
                }
                match watched.lock().unwrap().try_wait() {Ok(Some(_))=>{signal.reaped.store(true,Ordering::SeqCst);signal.fail("owned child exited")},Err(_)=>signal.fail("owned child state unavailable"),_=>{}}
                std::thread::sleep(Duration::from_millis(10));
            }
        }));
        Ok(Self {
            profile,
            child,
            input,
            writer: Some(local),
            life,
            incoming,
            threads,
        })
    }
    fn send(&mut self, channel: Channel, request: &Value, ctl: &RunControl) -> Result<()> {
        if self.life.closed.load(Ordering::SeqCst) {
            bail!("owned child closed");
        }
        let mut bytes = serde_json::to_vec(request)?;
        bytes.push(b'\n');
        if bytes.len() > MAX_LINE {
            bail!("frame limit");
        }
        self.life.arm(channel, request["id"].as_str().unwrap(), ctl);
        let r = if channel == Channel::Agent {
            self.input.write_all(&bytes)
        } else {
            self.writer
                .as_mut()
                .ok_or_else(|| anyhow!("host channel closed"))?
                .write_all(&bytes)
        };
        if r.is_err() {
            self.life.fail("write failure");
        }
        r.map_err(|_| anyhow!("owned channel write failure"))
    }
    fn stop(&mut self) {
        self.life.stop.store(true, Ordering::SeqCst);
        self.life.fail("owned shutdown");
        if let Some(w) = self.writer.take() {
            let _ = w.shutdown(Shutdown::Both);
        }
        let end = Instant::now() + Duration::from_secs(1);
        for t in self.threads.drain(..) {
            while !t.is_finished() && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(2));
            }
            if t.is_finished() {
                let _ = t.join();
            }
        }
        let _ = std::fs::remove_file(&self.profile);
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        self.stop();
    }
}
struct Pending {
    key: String,
    id: String,
    channel: Channel,
    epoch: u64,
    end: Instant,
    task: Option<Task>,
    cmd: Option<BrowserCommand>,
    kind: String,
    handoff: Option<String>,
}
/// Host capability requires a trusted fixture object and a separate grant.
impl TrustedFixtureControl {
    pub fn approve_controlled(
        &self,
        store: &ProfileStore,
        session: &str,
        anchor: &str,
        ops: &[BrowserOp],
        pin: &ApprovedLocalBrowser,
    ) -> Result<i64> {
        self.check(store)?;
        init(store)?;
        pin.verify()?;
        let task = store
            .task(anchor)?
            .ok_or_else(|| anyhow!("anchor absent"))?;
        if task.session_id != session
            || task.status != "queued"
            || task.read_path.is_some()
            || task.write_path.is_some()
            || ops.is_empty()
            || ops.len() > 7
        {
            bail!("invalid control grant");
        }
        let tx = store.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO grants(path,operation,created_at) VALUES(?1,'browser_control_fixture',?2)",
            params![pin.origin, now()],
        )?;
        let g = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO browser_grants(grant_id,session_uuid,ops_json) VALUES(?1,?2,?3)",
            params![g, session, serde_json::to_string(ops)?],
        )?;
        tx.execute("INSERT INTO browser_local_launch(grant_id,origin,executable,exe_sha) VALUES(?1,?2,?3,?4)",params![g,pin.origin,pin.executable.to_str(),pin.sha])?;
        tx.execute(
            "INSERT INTO hc_grants(grant_id,anchor_uuid) VALUES(?1,?2)",
            params![g, anchor],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO browser_control(session_uuid) VALUES(?1)",
            params![session],
        )?;
        tx.execute(
            "INSERT INTO audit(event,detail,at) VALUES('browser_control_fixture_granted',?1,?2)",
            params![g.to_string(), now()],
        )?;
        tx.commit()?;
        Ok(g)
    }
}
pub struct ControlledBrowser<'a> {
    store: &'a ProfileStore,
    session: String,
    grant: i64,
    anchor: String,
    scope: String,
    state: HostState,
    process: Process,
    tabs: HashSet<String>,
    retired: HashSet<String>,
    refs: HashMap<String, HashMap<String, bool>>,
    pending: HashMap<String, Pending>,
    deferred: Vec<Frame>,
    closed_persisted: bool,
    wire_timeout: Option<Duration>,
}
impl<'a> ControlledBrowser<'a> {
    pub fn start(
        store: &'a ProfileStore,
        session: &str,
        grant: i64,
        anchor: &str,
        pin: &ApprovedLocalBrowser,
    ) -> Result<Self> {
        recover_controlled(store)?;
        policy(store, session, grant, None, "browser_control_fixture")?;
        pin.verify()?;
        let binding:(String,String,String,String)=store.conn.query_row("SELECT l.origin,l.executable,l.exe_sha,h.anchor_uuid FROM browser_local_launch l JOIN hc_grants h ON h.grant_id=l.grant_id WHERE l.grant_id=?1",params![grant],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        if binding
            != (
                pin.origin.clone(),
                pin.executable.to_str().unwrap().into(),
                pin.sha.clone(),
                anchor.into(),
            )
        {
            bail!("control launch binding mismatch");
        }
        let active: bool = store.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM browser_children WHERE session_uuid=?1 AND active=1)",
            params![session],
            |r| r.get(0),
        )?;
        if active {
            bail!("session already owns a child");
        }
        if !cfg!(target_os = "macos") {
            bail!("controlled sandbox verified only on macOS");
        }
        let mut process = Process::spawn(store, grant, anchor, pin)?;
        let ready = process
            .incoming
            .recv_timeout(Duration::from_secs(4))
            .map_err(|_| anyhow!("ready deadline: {}", *process.life.reason.lock().unwrap()))?;
        if ready.channel != Channel::Host
            || ready.value["jsonrpc"] != "2.0"
            || ready.value["method"] != "ghost/ready"
        {
            bail!("private ready missing");
        }
        let state: HostState = serde_json::from_value(ready.value["params"].clone())?;
        let scope = state.browser_session_id.clone();
        validate_state(&state, &scope, anchor)?;
        if state.state != Phase::Agent
            || state.control_epoch != 0
            || state.handoff_id.is_some()
            || !state.tabs_to_observe.is_empty()
        {
            bail!("initial control state invalid");
        }
        let request = json!({"jsonrpc":"2.0","id":"@init","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ghost-controlled-fixture","version":"0.1"}}});
        process.send(
            Channel::Agent,
            &request,
            &RunControl {
                timeout: Duration::from_secs(3),
                ..Default::default()
            },
        )?;
        let init = process
            .incoming
            .recv_timeout(Duration::from_secs(4))
            .map_err(|_| anyhow!("initialize deadline"))?;
        if init.channel != Channel::Agent
            || init.value["id"] != "@init"
            || init.value["result"]["_meta"]["browserSessionId"] != scope
            || init.value["result"]["_meta"]["ownership"] != serde_json::to_value(&state)?
        {
            bail!("initialize control binding mismatch");
        }
        let tx = store.conn.unchecked_transaction()?;
        tx.execute("INSERT INTO browser_children(scope,session_uuid,host_instance,pid,active) VALUES(?1,?2,?3,?4,1)",params![scope,session,host_instance(),process.child.lock().unwrap().id()])?;
        tx.execute("INSERT INTO hc_state(scope,session_uuid,anchor_uuid,grant_id,host_instance,state_json,active) VALUES(?1,?2,?3,?4,?5,?6,1)",params![scope,session,anchor,grant,host_instance(),serde_json::to_string(&state)?])?;
        tx.commit()?;
        Ok(Self {
            store,
            session: session.into(),
            grant,
            anchor: anchor.into(),
            scope,
            state,
            process,
            tabs: HashSet::new(),
            retired: HashSet::new(),
            refs: HashMap::new(),
            pending: HashMap::new(),
            deferred: Vec::new(),
            closed_persisted: false,
            wire_timeout: None,
        })
    }
    fn persist(&self) -> Result<()> {
        self.store.conn.execute(
            "UPDATE hc_state SET state_json=?1,active=?2 WHERE scope=?3",
            params![
                serde_json::to_string(&self.state)?,
                self.state.state != Phase::Closed,
                self.scope
            ],
        )?;
        Ok(())
    }
    fn trusted(&self, t: &TrustedFixtureControl) -> Result<()> {
        t.check(self.store)?;
        self.allowed(None)
    }
    fn allowed(&self, op: Option<BrowserOp>) -> Result<()> {
        policy(
            self.store,
            &self.session,
            self.grant,
            op,
            "browser_control_fixture",
        )
    }
    pub fn state(&mut self) -> Result<HostState> {
        self.tick()?;
        Ok(self.state.clone())
    }
    pub fn is_alive(&self) -> bool {
        !self.process.life.closed.load(Ordering::SeqCst)
    }
    fn spec(
        &self,
        kind: &str,
        cmd: Option<&BrowserCommand>,
        task: Option<&Task>,
        handoff: Option<&str>,
    ) -> Value {
        json!({"scope":self.scope,"anchor":self.anchor,"kind":kind,"command":cmd,"activity":task.map(|t|&t.uuid),"handoff":handoff})
    }
    fn duplicate(&self, key: &str, spec: &Value, agent: bool) -> Result<bool> {
        let row: Option<(String, u64, String)> = self
            .store
            .conn
            .query_row(
                "SELECT spec_json,epoch,state FROM hc_requests WHERE key=?1",
                params![key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((old, epoch, status)) = row {
            if old != serde_json::to_string(spec)? {
                bail!("control request ID conflict");
            }
            if agent && status != "uncertain" && epoch != self.state.control_epoch {
                bail!("historical agent receipt cannot cross epoch");
            }
            return Ok(true);
        }
        Ok(false)
    }
    fn key(channel: Channel, id: &str) -> Result<String> {
        if id.is_empty() || id.len() > 128 || id.starts_with('@') {
            bail!("invalid request ID");
        }
        Ok(format!("hc/{}/{id}", channel.label()))
    }
    fn validate_command(&self, cmd: &BrowserCommand) -> Result<()> {
        if let Some(tab) = cmd.tab() {
            if !self.tabs.contains(tab) {
                bail!("unknown or closed tab");
            }
        }
        match cmd {
            BrowserCommand::Navigate { url, .. } if url != "about:blank" => {
                let u = reqwest::Url::parse(url)?;
                let origin: String = self.store.conn.query_row(
                    "SELECT origin FROM browser_local_launch WHERE grant_id=?1",
                    params![self.grant],
                    |r| r.get(0),
                )?;
                if u.origin().ascii_serialization() != origin
                    || u.scheme() != "http"
                    || u.host_str() != Some("127.0.0.1")
                    || !u.username().is_empty()
                    || u.password().is_some()
                    || u.fragment().is_some()
                {
                    bail!("target denied");
                }
            }
            BrowserCommand::Click { tab_id, r#ref }
            | BrowserCommand::Fill { tab_id, r#ref, .. } => {
                let fill = self
                    .refs
                    .get(tab_id)
                    .and_then(|r| r.get(r#ref))
                    .ok_or_else(|| anyhow!("stale ref"))?;
                if let BrowserCommand::Fill { value, .. } = cmd {
                    if !fill || value.len() > 4096 {
                        bail!("fill denied");
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    pub fn start_agent(
        &mut self,
        task_id: i64,
        id: &str,
        cmd: BrowserCommand,
        ctl: &RunControl,
    ) -> Result<RequestHandle> {
        self.begin_activity(Channel::Agent, None, task_id, id, cmd, ctl)
    }
    pub fn start_fixture_human(
        &mut self,
        trusted: &TrustedFixtureControl,
        task_id: i64,
        id: &str,
        cmd: BrowserCommand,
        ctl: &RunControl,
    ) -> Result<RequestHandle> {
        self.trusted(trusted)?;
        self.begin_activity(Channel::Host, Some(trusted), task_id, id, cmd, ctl)
    }
    fn begin_activity(
        &mut self,
        ch: Channel,
        _trusted: Option<&TrustedFixtureControl>,
        task_id: i64,
        id: &str,
        cmd: BrowserCommand,
        ctl: &RunControl,
    ) -> Result<RequestHandle> {
        self.tick()?;
        let key = Self::key(ch, id)?;
        let task = self
            .store
            .task_by_id(task_id)?
            .ok_or_else(|| anyhow!("activity absent"))?;
        let kind = if ch == Channel::Agent {
            "agent"
        } else {
            "human"
        };
        let spec = self.spec(
            kind,
            Some(&cmd),
            Some(&task),
            if ch == Channel::Host {
                self.state.handoff_id.as_deref()
            } else {
                None
            },
        );
        if self.duplicate(&key, &spec, ch == Channel::Agent)? {
            return Ok(RequestHandle {
                key,
                scope: self.scope.clone(),
            });
        }
        self.allowed(Some(cmd.op()))?;
        if self.state.state == Phase::Closed {
            bail!("closed");
        }
        if task.uuid == self.anchor
            || task.status != "queued"
            || task.session_id != self.session
            || task.read_path.is_some()
            || task.write_path.is_some()
        {
            bail!("activity task scope invalid");
        }
        if self.pending.values().any(|p| p.task.is_some()) {
            bail!("operation busy");
        }
        match (ch, self.state.state) {
            (Channel::Agent, Phase::Agent) => {}
            (Channel::Agent, Phase::Refresh)
                if matches!(cmd, BrowserCommand::Snapshot { .. } | BrowserCommand::Tabs) => {}
            (Channel::Host, Phase::Human) => {}
            _ => bail!("ownership admission denied"),
        }
        self.validate_command(&cmd)?;
        check_control(ctl)?;
        if ctl.cancellation.is_cancelled() {
            self.store.cancel(&task.uuid)?;
            bail!("cancelled before intent");
        }
        let (name, args) = cmd.wire();
        let wire_timeout = self.wire_timeout.unwrap_or(ctl.timeout);
        let params = if ch == Channel::Agent {
            json!({"name":name,"arguments":args,"_meta":{"ghostTaskId":self.anchor,"browserSessionId":self.scope,"controlEpoch":self.state.control_epoch,"timeoutMs":wire_timeout.as_millis()}})
        } else {
            let mut p = self.host_params();
            p["handoff_id"] = json!(self.state.handoff_id);
            p["name"] = json!(name);
            p["arguments"] = args;
            p["timeoutMs"] = json!(wire_timeout.as_millis());
            p
        };
        let wire = json!({"jsonrpc":"2.0","id":id,"method":if ch==Channel::Agent{"tools/call"}else{"ghost/human"},"params":params});
        if serde_json::to_vec(&wire)?.len() + 1 > MAX_LINE {
            bail!("frame limit");
        }
        let tx = self.store.conn.unchecked_transaction()?;
        self.limit(&tx)?;
        if tx.execute(
            "UPDATE tasks SET status='running',updated_at=?1 WHERE id=?2 AND status='queued'",
            params![now(), task.id],
        )? != 1
        {
            bail!("activity not queued");
        }
        let encoded = serde_json::to_string(&cmd)?;
        tx.execute("INSERT INTO effects(task_id,action,target,grant_id,status,started_at) VALUES(?1,'browser',?2,?3,'started',?4)",params![task.id,serde_json::to_string(&spec)?,self.grant,now()])?;
        let effect = tx.last_insert_rowid();
        tx.execute("INSERT INTO browser_calls(request_id,task_id,task_uuid,profile_uuid,session_uuid,child_scope,command_json,effect_id,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'pending')",params![key,task.id,task.uuid,self.store.uuid,self.session,self.scope,encoded,effect])?;
        self.intent(&tx, &key, id, ch, &spec, &wire, Some(task.id))?;
        tx.commit()?;
        if let Some(t) = cmd.tab() {
            self.refs.remove(t);
        }
        self.pending.insert(
            key.clone(),
            Pending {
                key: key.clone(),
                id: id.into(),
                channel: ch,
                epoch: self.state.control_epoch,
                end: Instant::now() + ctl.timeout,
                task: Some(task),
                cmd: Some(cmd),
                kind: kind.into(),
                handoff: self.state.handoff_id.clone(),
            },
        );
        if self.process.send(ch, &wire, ctl).is_err() {
            self.abort("activity write failure")?;
        }
        Ok(RequestHandle {
            key,
            scope: self.scope.clone(),
        })
    }
    fn host_params(&self) -> Value {
        json!({"session_id":self.scope,"task_id":self.anchor,"epoch":self.state.control_epoch,"expected_state":self.state.state.label()})
    }
    fn limit(&self, tx: &rusqlite::Transaction) -> Result<()> {
        let count: u64 = tx.query_row(
            "SELECT COUNT(*) FROM hc_requests WHERE scope=?1",
            params![self.scope],
            |r| r.get(0),
        )?;
        if count >= 1024 {
            bail!("request bound");
        }
        Ok(())
    }
    // Explicit fields preserve the fixed durable browser-intent contract.
    #[allow(clippy::too_many_arguments)]
    fn intent(
        &self,
        tx: &rusqlite::Transaction,
        key: &str,
        id: &str,
        ch: Channel,
        spec: &Value,
        wire: &Value,
        task: Option<i64>,
    ) -> Result<()> {
        tx.execute("INSERT INTO hc_requests(key,scope,channel,request_id,spec_json,wire_json,epoch,phase,task_id,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'pending')",params![key,self.scope,ch.label(),id,serde_json::to_string(spec)?,serde_json::to_string(wire)?,self.state.control_epoch,self.state.state.label(),task])?;
        tx.execute(
            "INSERT INTO audit(task_id,event,detail,at) VALUES(?1,'browser_private_intent',?2,?3)",
            params![task, key, now()],
        )?;
        Ok(())
    }
    pub fn begin_handoff(
        &mut self,
        t: &TrustedFixtureControl,
        id: &str,
        handoff: &str,
        ctl: &RunControl,
    ) -> Result<RequestHandle> {
        self.begin_host(t, id, "handoff", handoff, ctl)
    }
    pub fn begin_resume(
        &mut self,
        t: &TrustedFixtureControl,
        id: &str,
        handoff: &str,
        ctl: &RunControl,
    ) -> Result<RequestHandle> {
        self.begin_host(t, id, "resume", handoff, ctl)
    }
    fn begin_host(
        &mut self,
        t: &TrustedFixtureControl,
        id: &str,
        kind: &str,
        handoff: &str,
        ctl: &RunControl,
    ) -> Result<RequestHandle> {
        self.tick()?;
        t.check(self.store)?;
        let key = Self::key(Channel::Host, id)?;
        let spec = self.spec(kind, None, None, Some(handoff));
        if self.duplicate(&key, &spec, false)? {
            return Ok(RequestHandle {
                key,
                scope: self.scope.clone(),
            });
        }
        self.trusted(t)?;
        check_control(ctl)?;
        if ctl.cancellation.is_cancelled() {
            bail!("cancel before intent");
        }
        if handoff.is_empty() || handoff.len() > 128 {
            bail!("handoff ID bound");
        }
        if self.pending.values().any(|p| p.task.is_none()) {
            bail!("host transition busy");
        }
        if kind == "handoff" {
            if !matches!(self.state.state, Phase::Agent | Phase::Refresh) {
                bail!("handoff phase denied");
            }
            let mut stmt = self
                .store
                .conn
                .prepare("SELECT spec_json FROM hc_requests WHERE scope=?1")?;
            let rows = stmt.query_map(params![self.scope], |r| r.get::<_, String>(0))?;
            for row in rows {
                let old: Value = serde_json::from_str(&row?)?;
                if old["kind"] == "handoff" && old["handoff"] == handoff {
                    bail!("handoff ID reused");
                }
            }
        } else if self.state.state != Phase::Human
            || self.state.handoff_id.as_deref() != Some(handoff)
            || self.pending.values().any(|p| p.task.is_some())
        {
            bail!("resume scope or busy");
        }
        let mut p = self.host_params();
        p["handoff_id"] = json!(handoff);
        let wire = json!({"jsonrpc":"2.0","id":id,"method":format!("ghost/{kind}"),"params":p});
        let tx = self.store.conn.unchecked_transaction()?;
        self.limit(&tx)?;
        self.intent(&tx, &key, id, Channel::Host, &spec, &wire, None)?;
        tx.commit()?;
        self.pending.insert(
            key.clone(),
            Pending {
                key: key.clone(),
                id: id.into(),
                channel: Channel::Host,
                epoch: self.state.control_epoch,
                end: Instant::now() + ctl.timeout,
                task: None,
                cmd: None,
                kind: kind.into(),
                handoff: Some(handoff.into()),
            },
        );
        self.refs.clear();
        if kind == "handoff" {
            self.state.state = Phase::Pausing;
            self.state.handoff_id = Some(handoff.into());
            self.state.fresh_observation_required = false;
            self.state.tabs_to_observe.clear();
        }
        if let Err(error) = self.persist() {
            let _ = self.abort("control phase persistence failed before bytes");
            return Err(error);
        }
        if self.process.send(Channel::Host, &wire, ctl).is_err() {
            self.abort("host write failure")?;
        }
        Ok(RequestHandle {
            key,
            scope: self.scope.clone(),
        })
    }
    fn parse_activity(&self, p: &Pending, v: &Value) -> Result<(Value, bool, HostState)> {
        let (data, failed, state) = if p.channel == Channel::Agent {
            let result = &v["result"];
            let m = &result["_meta"];
            if m["ghostId"] != self.store.uuid
                || m["ghostTaskId"] != self.anchor
                || m["browserSessionId"] != self.scope
                || m["requestId"] != p.id
                || m["controlEpoch"].as_u64() != Some(p.epoch)
                || m["trust"] != "untrusted_tool_data"
            {
                bail!("agent correlation invalid");
            }
            let d = result["structuredContent"].clone();
            let content = result["content"]
                .as_array()
                .filter(|a| a.len() == 1)
                .ok_or_else(|| anyhow!("content bound"))?;
            if !d.is_object()
                || content[0]["type"] != "text"
                || serde_json::from_str::<Value>(content[0]["text"].as_str().unwrap_or(""))
                    .ok()
                    .as_ref()
                    != Some(&d)
            {
                bail!("content mismatch");
            }
            (
                d,
                result["isError"]
                    .as_bool()
                    .ok_or_else(|| anyhow!("error state"))?,
                serde_json::from_value(m["ownership"].clone())?,
            )
        } else {
            let state: HostState = serde_json::from_value(v["result"]["hostState"].clone())?;
            if v["result"]["data"]["trust"] != "untrusted_tool_data"
                || !v["result"]["data"]["toolResult"].is_object()
            {
                bail!("human result invalid");
            }
            (v["result"]["data"]["toolResult"].clone(), false, state)
        };
        validate_state(&state, &self.scope, &self.anchor)?;
        if state.control_epoch != p.epoch || state.state == Phase::Closed {
            bail!("activity ownership uncertain");
        }
        if failed
            && (data["mayHaveActed"].as_bool() != Some(false)
                || data["restartRequired"].as_bool() != Some(false))
        {
            bail!("may have acted");
        }
        Ok((data, failed, state))
    }
    fn observations(&mut self, cmd: &BrowserCommand, data: &Value) -> Result<()> {
        match cmd {
            BrowserCommand::New => {
                let tab = data["tab_id"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 128)
                    .ok_or_else(|| anyhow!("tab bound"))?;
                if self.tabs.len() >= 64
                    || self.retired.contains(tab)
                    || !self.tabs.insert(tab.into())
                {
                    bail!("tab reuse");
                }
            }
            BrowserCommand::Close { tab_id } => {
                self.tabs.remove(tab_id);
                self.retired.insert(tab_id.clone());
            }
            BrowserCommand::Tabs => {
                let tabs = data["tabs"]
                    .as_array()
                    .ok_or_else(|| anyhow!("inventory invalid"))?;
                let actual: HashSet<String> = tabs
                    .iter()
                    .map(|t| {
                        t.as_str()
                            .map(String::from)
                            .ok_or_else(|| anyhow!("inventory tab missing"))
                    })
                    .collect::<Result<_>>()?;
                if actual != self.tabs {
                    bail!("inventory mismatch");
                }
            }
            BrowserCommand::Snapshot { tab_id } => {
                if data["browser_session_id"] != self.scope
                    || data["tab_id"] != *tab_id
                    || data["generation"].as_u64().is_none()
                    || data["trust"] != "untrusted_page_data"
                {
                    bail!("snapshot invalid");
                }
                let a = data["elements"]
                    .as_array()
                    .filter(|a| a.len() <= 64)
                    .ok_or_else(|| anyhow!("snapshot limit"))?;
                let mut refs = HashMap::new();
                for e in a {
                    let r = e["ref"]
                        .as_str()
                        .filter(|s| {
                            s.len() <= 256 && s.starts_with(&format!("{}:{tab_id}:", self.scope))
                        })
                        .ok_or_else(|| anyhow!("ref scope"))?;
                    let fill = e["fillable"]
                        .as_bool()
                        .ok_or_else(|| anyhow!("fillable missing"))?;
                    if refs.insert(r.into(), fill).is_some() {
                        bail!("duplicate ref");
                    }
                }
                self.refs.insert(tab_id.clone(), refs);
            }
            _ => {}
        }
        Ok(())
    }
    fn apply_activity(
        &mut self,
        p: &Pending,
        data: &Value,
        remote: &HostState,
        failed: bool,
    ) -> Result<()> {
        let mut expected = self.state.clone();
        if !failed {
            self.observations(p.cmd.as_ref().unwrap(), data)?;
            if expected.state == Phase::Refresh {
                match p.cmd.as_ref().unwrap() {
                    BrowserCommand::Snapshot { tab_id } => {
                        expected.tabs_to_observe.retain(|t| t != tab_id)
                    }
                    BrowserCommand::Tabs => {}
                    _ => bail!("refresh violation"),
                }
                if expected.tabs_to_observe.is_empty() {
                    expected.state = Phase::Agent;
                    expected.fresh_observation_required = false;
                }
            }
        }
        if serde_json::to_value(&expected)? != serde_json::to_value(remote)? {
            bail!("unexpected ownership transition");
        }
        self.state = expected;
        Ok(())
    }
    fn terminal(&self, p: &Pending, status: &str, data: Option<Value>) -> Result<ControlReceipt> {
        let r = ControlReceipt {
            request_id: p.id.clone(),
            channel: p.channel.label().into(),
            child_scope: self.scope.clone(),
            anchor_uuid: self.anchor.clone(),
            activity_uuid: p.task.as_ref().map(|t| t.uuid.clone()),
            admitted_epoch: p.epoch,
            status: status.into(),
            historical_data: data,
        };
        self.store.conn.execute(
            "UPDATE hc_requests SET state=?1,receipt_json=?2 WHERE key=?3 AND state='pending'",
            params![status, serde_json::to_string(&r)?, p.key],
        )?;
        Ok(r)
    }
    fn process_frame(&mut self, f: Frame) -> Result<()> {
        if f.value["method"] == "ghost/closed" && f.channel == Channel::Host {
            self.process.life.fail("child ownership closed");
            return Ok(());
        }
        let id = f.value["id"]
            .as_str()
            .ok_or_else(|| anyhow!("frame ID missing"))?;
        let key = Self::key(f.channel, id)?;
        let Some(p) = self.pending.remove(&key) else {
            bail!("unsolicited or duplicate wire acknowledgement");
        };
        if f.at > p.end || f.value["jsonrpc"] != "2.0" {
            self.pending.insert(key, p);
            bail!("late or invalid acknowledgement");
        }
        if p.task.is_none()
            && p.kind == "handoff"
            && self.pending.values().any(|a| a.task.is_some())
        {
            self.pending.insert(key, p);
            self.deferred.push(f);
            return Ok(());
        }
        let result = (|| {
            if let Some(task) = &p.task {
                let (data, failed, remote) = self.parse_activity(&p, &f.value)?;
                self.apply_activity(&p, &data, &remote, failed)?;
                let effect: i64 = self.store.conn.query_row(
                    "SELECT effect_id FROM browser_calls WHERE request_id=?1",
                    params![p.key],
                    |r| r.get(0),
                )?;
                let status = if failed { "failed" } else { "completed" };
                let tx = self.store.conn.unchecked_transaction()?;
                super::finish_transaction(
                    &tx,
                    &self.store.uuid,
                    task,
                    &p.key,
                    effect,
                    status,
                    Some(&data),
                    None,
                )?;
                self.terminal(&p, status, Some(data))?;
                self.persist()?;
                tx.commit()?;
            } else {
                let remote: HostState =
                    serde_json::from_value(f.value["result"]["hostState"].clone())?;
                validate_state(&remote, &self.scope, &self.anchor)?;
                if remote.control_epoch != p.epoch + 1
                    || remote.handoff_id != p.handoff
                    || (p.kind == "handoff" && remote.state != Phase::Human)
                    || (p.kind == "resume" && remote.state != Phase::Refresh)
                {
                    bail!("host transition invalid");
                }
                let mut expected = self.state.clone();
                expected.control_epoch += 1;
                expected.handoff_id = p.handoff.clone();
                expected.state = if p.kind == "handoff" {
                    Phase::Human
                } else {
                    Phase::Refresh
                };
                expected.fresh_observation_required = p.kind == "resume";
                expected.tabs_to_observe = if p.kind == "resume" {
                    self.tabs.iter().cloned().collect()
                } else {
                    Vec::new()
                };
                expected.tabs_to_observe.sort();
                if serde_json::to_value(&expected)? != serde_json::to_value(&remote)? {
                    bail!("host phase/tab barrier mismatch");
                }
                let tx = self.store.conn.unchecked_transaction()?;
                self.state = expected;
                self.terminal(&p, "completed", Some(f.value["result"].clone()))?;
                self.persist()?;
                tx.commit()?;
                self.refs.clear();
            }
            Ok(())
        })();
        if result.is_err() {
            self.pending.insert(key, p);
        }
        result
    }
    pub fn tick(&mut self) -> Result<()> {
        let mut frames = std::mem::take(&mut self.deferred);
        while let Ok(f) = self.process.incoming.try_recv() {
            frames.push(f);
        }
        // Agent completion settles before an ownership acknowledgement is applied.
        frames.sort_by_key(|f| if f.channel == Channel::Agent { 0 } else { 1 });
        for f in frames {
            if self.process_frame(f).is_err() {
                self.abort("invalid or lost receipt")?;
                return Ok(());
            }
        }
        if self.process.life.closed.load(Ordering::SeqCst) && !self.closed_persisted {
            self.abort("watchdog/channel closed")?;
        }
        Ok(())
    }
    /// Nonblocking writer-loop receipt collection; snapshots do not call it.
    pub fn poll(&mut self, h: &RequestHandle) -> Result<Option<ControlReceipt>> {
        if h.scope != self.scope {
            bail!("handle belongs to another child");
        }
        self.tick()?;
        let row: Option<(String, Option<String>)> = self
            .store
            .conn
            .query_row(
                "SELECT state,receipt_json FROM hc_requests WHERE key=?1 AND scope=?2",
                params![h.key, self.scope],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((status, json)) = row else {
            bail!("request handle absent");
        };
        if status != "pending" {
            if let Some(json) = json {
                return Ok(Some(serde_json::from_str(&json)?));
            }
            let (id,ch,epoch,activity):(String,String,u64,Option<String>)=self.store.conn.query_row("SELECT request_id,channel,epoch,(SELECT uuid FROM tasks WHERE id=hc_requests.task_id) FROM hc_requests WHERE key=?1",params![h.key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
            return Ok(Some(ControlReceipt {
                request_id: id,
                channel: ch,
                child_scope: self.scope.clone(),
                anchor_uuid: self.anchor.clone(),
                activity_uuid: activity,
                admitted_epoch: epoch,
                status,
                historical_data: None,
            }));
        }
        Ok(None)
    }
    pub fn wait(&mut self, h: &RequestHandle) -> Result<ControlReceipt> {
        loop {
            if let Some(receipt) = self.poll(h)? {
                return Ok(receipt);
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    fn abort(&mut self, _why: &str) -> Result<()> {
        self.process.stop();
        self.state.state = Phase::Closed;
        self.state.fresh_observation_required = false;
        self.state.tabs_to_observe.clear();
        self.refs.clear();
        let mut error = None;
        for (_, p) in self.pending.drain() {
            if let Some(task) = &p.task {
                let effect = self.store.conn.query_row(
                    "SELECT effect_id FROM browser_calls WHERE request_id=?1",
                    params![p.key],
                    |r| r.get::<_, i64>(0),
                );
                if let Ok(effect) = effect {
                    if let Err(e) = super::finish(
                        self.store,
                        task,
                        &p.key,
                        effect,
                        "uncertain",
                        None,
                        Some("controlled browser unknown; no automatic replay"),
                    ) {
                        error = Some(e);
                    }
                }
            }
            let r = ControlReceipt {
                request_id: p.id.clone(),
                channel: p.channel.label().into(),
                child_scope: self.scope.clone(),
                anchor_uuid: self.anchor.clone(),
                activity_uuid: p.task.as_ref().map(|t| t.uuid.clone()),
                admitted_epoch: p.epoch,
                status: "uncertain".into(),
                historical_data: None,
            };
            let _=self.store.conn.execute("UPDATE hc_requests SET state='uncertain',receipt_json=?1 WHERE key=?2 AND state='pending'",params![serde_json::to_string(&r)?,p.key]);
        }
        self.store.conn.execute(
            "UPDATE browser_control SET blocked=1 WHERE session_uuid=?1",
            params![self.session],
        )?;
        self.store.conn.execute(
            "UPDATE browser_children SET active=?3 WHERE scope=?1 AND host_instance=?2",
            params![
                self.scope,
                host_instance(),
                !self.process.life.reaped.load(Ordering::SeqCst)
            ],
        )?;
        self.persist()?;
        self.closed_persisted = true;
        if let Some(e) = error {
            return Err(e);
        }
        Ok(())
    }
    pub fn shutdown(&mut self) -> Result<()> {
        self.abort("explicit owned shutdown")
    }
    // Faults use only the held fixture's handles, never a PID supplied by input.
    /// Hold the child's deadline longer to prove the independent host watchdog.
    pub fn longer_child_deadline_for_test(&mut self) {
        self.wire_timeout = Some(Duration::from_secs(30));
    }
    pub fn termination_cause_for_test(&self) -> &'static str {
        *self.process.life.reason.lock().unwrap()
    }
    pub fn disconnect_control_for_test(&mut self) {
        if let Some(w) = self.process.writer.take() {
            let _ = w.shutdown(Shutdown::Both);
        }
    }
    pub fn kill_owned_child_for_test(&mut self) {
        let _ = self.process.child.lock().unwrap().kill();
    }
    pub fn inject_late_ack_for_test(&mut self, h: &RequestHandle) {
        if let Some(p) = self.pending.get_mut(&h.key) {
            p.end = Instant::now() - Duration::from_secs(1);
        }
    }
}
impl Drop for ControlledBrowser<'_> {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}
fn check_control(c: &RunControl) -> Result<()> {
    if c.timeout.is_zero() || c.timeout > Duration::from_secs(30) {
        bail!("deadline bound");
    }
    Ok(())
}
fn validate_state(s: &HostState, scope: &str, anchor: &str) -> Result<()> {
    if s.browser_session_id != scope
        || uuid::Uuid::parse_str(scope).is_err()
        || s.ghost_task_id != anchor
        || !s.control_available
        || s.scripts_frozen
        || s.network_frozen
        || s.trust != "trusted_host_state"
        || s.fresh_observation_required != (s.state == Phase::Refresh)
        || s.tabs_to_observe.len() > 64
        || s.tabs_to_observe
            .iter()
            .any(|t| t.is_empty() || t.len() > 128)
    {
        bail!("host state binding invalid");
    }
    Ok(())
}
