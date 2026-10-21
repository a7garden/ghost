//! Owned per-Ghost browser runtime bound to the durable ComputerRegistry.
//!
//! The browser control service owns exactly one Chromium-family process per
//! computer, launches it against the registry manifest's `browser-profile`
//! root (never a user profile, never a parallel path), holds the registry's
//! single browser-writer lease while it runs, and gates every operation on
//! that lease plus the owner-controlled handoff state machine. Agent traffic
//! and human takeover are fenced by control epochs: observations taken before
//! a takeover or recreate are refused, never replayed.
//!
//! Configuration is operator-supplied and probed, never model- or page-
//! supplied. The executable pin is verified against its actual sha256 digest
//! before the backend is configured, and the profile directory is created and
//! owned by the ComputerRegistry.
use super::registry::{BrowserServiceBinding, ComputerRegistry, RuntimeFacts};
use crate::adapters::computer::{
    Authorize, BrowserOperation, ComputerBackend, ComputerCapabilities, ComputerFuture,
    ComputerOperation,
};
use anyhow::{anyhow, bail, ensure, Result};
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::net::ToSocketAddrs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

/// Fixed backend identity for the registry-attached browser service.
pub const OWNED_BROWSER_BACKEND_ID: &str = "ghost-owned-browser";
/// The only browser runtime kind this backend accepts.
pub const OWNED_BROWSER_RUNTIME_KIND: &str = "local-chromium";

const LAUNCH_TIMEOUT: Duration = Duration::from_secs(20);
const CDP_TIMEOUT: Duration = Duration::from_secs(15);
const NAVIGATION_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_SCREENSHOT_CHARS: usize = 4_000_000;
const MAX_TEXT_CHARS: usize = 20_000;
const MAX_SNAPSHOT_NODES: usize = 2_000;
const MAX_SNAPSHOT_ELEMENTS: usize = 300;

/// Operator-pinned, probed browser runtime for one computer. The profile
/// scope declares whether this computer's browser serves the login-less
/// public research profile or the authenticated private profile; the two
/// scopes are separate directories under the same registry home.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OwnedBrowserComputer {
    pub ghost_id: String,
    pub computer_id: String,
    pub executable: PathBuf,
    pub executable_sha256: String,
    #[serde(default)]
    pub headless: bool,
    pub profile_scope: String,
}

impl OwnedBrowserComputer {
    pub fn validate(&self) -> Result<()> {
        BrowserServiceBinding::validate_profile_scope(&self.profile_scope)
    }
}

/// Validated owned-browser configuration. Construction probes every pin so
/// `configured()` reflects observed facts, never configuration alone.
#[derive(Clone)]
pub struct OwnedBrowserConfig {
    computers: BTreeMap<String, OwnedBrowserComputer>,
    by_computer: BTreeMap<String, String>,
}

impl OwnedBrowserConfig {
    pub fn from_computers(computers: Vec<OwnedBrowserComputer>) -> Result<Self> {
        ensure!(
            !computers.is_empty(),
            "owned browser requires at least one computer"
        );
        let mut map = BTreeMap::new();
        let mut by_computer = BTreeMap::new();
        for computer in computers {
            ensure!(
                !map.contains_key(&computer.ghost_id)
                    && !by_computer.contains_key(&computer.computer_id),
                "owned browser Ghost and computer identities must be distinct"
            );
            computer.validate()?;
            probe_executable(&computer.executable, &computer.executable_sha256)?;
            by_computer.insert(computer.computer_id.clone(), computer.ghost_id.clone());
            map.insert(computer.ghost_id.clone(), computer);
        }
        Ok(Self {
            computers: map,
            by_computer,
        })
    }

    pub fn computers(&self) -> Vec<OwnedBrowserComputer> {
        self.computers.values().cloned().collect()
    }

    fn computer_for(&self, owner: &str) -> Result<&OwnedBrowserComputer> {
        self.computers
            .get(owner)
            .ok_or_else(|| anyhow!("this Ghost has no owned browser computer"))
    }

    fn ghost_for(&self, computer_id: &str) -> Result<String> {
        self.by_computer
            .get(computer_id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown owned browser computer"))
    }

    /// Probed runtime facts for registry registration. Every computer in one
    /// backend must share one pinned executable identity.
    pub fn runtime_facts(&self) -> Result<RuntimeFacts> {
        let first = self
            .computers
            .values()
            .next()
            .ok_or_else(|| anyhow!("owned browser requires at least one computer"))?;
        for computer in self.computers.values() {
            ensure!(
                computer.executable == first.executable
                    && computer.executable_sha256 == first.executable_sha256,
                "owned browser computers must share one pinned executable per backend"
            );
        }
        RuntimeFacts::new(OWNED_BROWSER_RUNTIME_KIND, first.executable_sha256.clone())
    }
}

/// Boolean probe used by operator registration paths.
pub fn probe_is_configured(executable: &Path, pinned_sha256: &str) -> bool {
    probe_executable(executable, pinned_sha256).is_ok()
}

pub(crate) fn file_sha256(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path)?;
    ensure!(
        bytes.len() <= 512 * 1024 * 1024,
        "file exceeds the probe size limit"
    );
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

/// Bounded plain-HTTP(S) check for a validated LOCAL private profile: any
/// http(s) origin without embedded credentials, including localhost and
/// private local apps. Length-bounded; the local model route is the privacy
/// boundary, not the URL.
pub fn url_is_bounded_http(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else { return false };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    parsed.host_str().is_some() && url.len() <= 8192
}

/// True when a URL names a publicly routable http(s) origin with no embedded
/// credentials: the worker relay refuses every other navigation target and
/// the request interceptor re-applies the same policy to every request the
/// page issues, including redirects.
pub fn url_host_is_publicly_routable(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else { return false };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    let Some(host) = parsed.host_str() else { return false };
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<std::net::IpAddr>() {
        return ip_is_globally_routable(ip);
    }
    let lower = host.to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
        || lower.ends_with(".home.arpa")
    {
        return false;
    }
    let port = parsed.port_or_known_default().unwrap_or(if parsed.scheme() == "https" { 443 } else { 80 });
    match (host, port).to_socket_addrs() {
        Ok(mut addrs) => std::iter::Iterator::all(&mut addrs, |addr| ip_is_globally_routable(addr.ip())),
        Err(_) => false,
    }
}

fn ip_is_globally_routable(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let octets = v4.octets();
            let cgnat = octets[0] == 100 && (octets[1] & 0xC0) == 64;
            let benchmarking = octets[0] == 198 && (octets[1] == 18 || octets[1] == 19);
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.is_documentation()
                || cgnat
                || benchmarking)
        }
        std::net::IpAddr::V6(v6) => {
            let segments = v6.segments();
            let unique_local = (segments[0] & 0xfe00) == 0xfc00;
            let link_local = (segments[0] & 0xffc0) == 0xfe80;
            let ipv4_mapped = segments[0] == 0 && segments[1] == 0 && segments[2] == 0
                && segments[3] == 0 && segments[4] == 0 && segments[5] == 0xffff;
            if ipv4_mapped {
                return ip_is_globally_routable(std::net::IpAddr::V4(std::net::Ipv4Addr::new(
                    (segments[6] >> 8) as u8,
                    (segments[6] & 0xff) as u8,
                    (segments[7] >> 8) as u8,
                    (segments[7] & 0xff) as u8,
                )));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || unique_local
                || link_local
                || v6.is_multicast())
        }
    }
}

/// Verifies an executable pin against the actual file bytes.
fn probe_executable(executable: &Path, pinned_sha256: &str) -> Result<String> {
    ensure!(
        executable.is_absolute(),
        "owned browser executable must be an absolute path"
    );
    let metadata = std::fs::symlink_metadata(executable)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "owned browser executable must be a real file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        ensure!(
            metadata.uid() == unsafe { libc::geteuid() }
                && metadata.permissions().mode() & 0o111 != 0,
            "owned browser executable must be owned and executable by the current user"
        );
    }
    let canonical = executable.canonicalize()?;
    ensure!(
        canonical == executable,
        "owned browser executable must be a canonical path"
    );
    let digest = file_sha256(&canonical)?;
    ensure!(
        digest == pinned_sha256.to_ascii_lowercase(),
        "owned browser executable pin does not match its probed sha256"
    );
    Ok(digest)
}

/// Owner-gated takeover state, fenced by the registry browser lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ControlPhase {
    Agent,
    Human,
    Refresh,
}

/// One snapshot observation: geometry plus the exact role/name the owner
/// approval surface shows, and the page URL the question was asked on.
#[derive(Debug, Clone)]
struct RefTarget {
    backend: i64,
    x: f64,
    y: f64,
    role: String,
    name: String,
}

#[derive(Debug)]
struct ControlState {
    phase: ControlPhase,
    control_epoch: u64,
    last_snapshot_id: u64,
    last_url: String,
    refs: HashMap<String, RefTarget>,
    handoff_id: Option<String>,
}

impl ControlState {
    fn new() -> Self {
        Self {
            phase: ControlPhase::Agent,
            control_epoch: 0,
            last_snapshot_id: 0,
            last_url: String::new(),
            refs: HashMap::new(),
            handoff_id: None,
        }
    }

    fn invalidate_observations(&mut self) {
        self.refs.clear();
        self.last_snapshot_id = 0;
    }
}

struct SessionInner {
    cdp: Cdp,
    target_id: String,
    session_id: String,
    execution_id: String,
    control: Mutex<ControlState>,
    profile_dir: PathBuf,
    child: Mutex<Option<tokio::process::Child>>,
}

impl SessionInner {
    /// Graceful stop: ask the browser to close, wait briefly, then kill.
    /// Sync locks are never held across the awaits below.
    async fn stop(&self) {
        let _ = self.cdp.request(None, "Browser.close", json!({})).await;
        let child = self.child.lock().take();
        if let Some(mut child) = child {
            let waited = tokio::time::timeout(SHUTDOWN_TIMEOUT, child.wait()).await;
            if waited.is_err() {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
        }
        for stale in [
            "DevToolsActivePort",
            "SingletonLock",
            "SingletonSocket",
            "SingletonCookie",
        ] {
            let _ = std::fs::remove_file(self.profile_dir.join(stale));
        }
        let mut control = self.control.lock();
        control.phase = ControlPhase::Human;
        control.invalidate_observations();
    }
}

/// One owned browser per computer, bound to the same durable registry as the
/// worker home. Every operation revalidates the browser lease through it.
pub struct OwnedBrowser {
    config: OwnedBrowserConfig,
    registry: Arc<Mutex<ComputerRegistry>>,
    authority_epoch: AtomicU64,
    sessions: Mutex<BTreeMap<String, Arc<SessionInner>>>,
    /// Request-level egress confinement for public research sessions: every
    /// in-browser request is intercepted and hosts that are not publicly
    /// routable are denied before connecting.
    confinement: bool,
    /// Registers each launched browser instance in the registry so another
    /// process (the Host) can stop the exact instance by verified identity.
    instance_recorder: bool,
}

impl OwnedBrowser {
    pub fn new(
        config: OwnedBrowserConfig,
        registry: Arc<Mutex<ComputerRegistry>>,
        authority_epoch: u64,
    ) -> Self {
        Self {
            config,
            registry,
            authority_epoch: AtomicU64::new(authority_epoch),
            sessions: Mutex::new(BTreeMap::new()),
            confinement: false,
            instance_recorder: false,
        }
    }

    /// Enables request interception confinement for sessions this instance
    /// creates. The worker relay always confines; the owner-driven Host
    /// session does not (the owner may reach local apps during takeover).
    pub fn with_confinement(mut self, confinement: bool) -> Self {
        self.confinement = confinement;
        self
    }

    /// Registers launched instances durably; the worker relay enables this so
    /// exactly one registered Chrome instance per computer is stoppable from
    /// the Host by verified identity.
    pub fn with_instance_recording(mut self, enabled: bool) -> Self {
        self.instance_recorder = enabled;
        self
    }

    /// The current page URL of this owner's session, when a snapshot exists.
    pub fn page_url(&self, owner: &str, execution_id: &str) -> Option<String> {
        let session = self.sessions.lock().get(&self.config.computer_for(owner).ok()?.computer_id).cloned()?;
        (session.execution_id == execution_id)
            .then(|| session.control.lock().last_url.clone())
            .filter(|url| !url.is_empty())
    }

    /// The exact observed target (ref, role, name, geometry presence) for the
    /// owner approval surface.
    pub fn target_label(
        &self,
        owner: &str,
        execution_id: &str,
        reference: &str,
        snapshot_id: u64,
    ) -> Option<Value> {
        let session = self.sessions.lock().get(&self.config.computer_for(owner).ok()?.computer_id).cloned()?;
        if session.execution_id != execution_id {
            return None;
        }
        let control = session.control.lock();
        if control.last_snapshot_id != snapshot_id {
            return None;
        }
        let target = control.refs.get(reference)?;
        Some(json!({
            "ref": reference,
            "role": target.role,
            "name": target.name,
            "snapshot_id": snapshot_id,
            "url": control.last_url,
        }))
    }

    /// Stops a registered instance owned by ANOTHER process by verified
    /// identity (pid + process group + start identity + executable + profile).
    /// A reused PID refuses. Returns the verification/stop record.
    pub fn stop_registered_instance(&self, computer_id: &str) -> Result<Value> {
        use crate::worker::process_identity;
        let Some(instance) = self.registry().browser_instance(computer_id)? else {
            return Ok(json!({"registered": false}));
        };
        // Never touch an instance this process owns as a live session.
        for session in self.sessions.lock().values() {
            if let Some(child) = session.child.lock().as_ref() {
                if child.id() == Some(instance.pid) {
                    return Ok(json!({"registered": true, "owned_here": true}));
                }
            }
        }
        let found = process_identity::inspect(instance.pid)?.is_some();
        ensure!(process_identity::reconcile_recorded_absence(
            instance.pid, instance.process_group, &instance.start_identity)?,
            "registered browser process group is not proven absent; reused identity refused");
        self.registry().clear_browser_instance(computer_id, instance.pid)?;
        let _ = self.registry().release_browser_lease(
            computer_id,
            &self.config.ghost_for(computer_id)?,
            &instance.lease_execution_id,
            instance.authority_epoch,
        );
        Ok(json!({
            "registered": true,
            "found": found,
            "verified": true,
            "stopped": true,
            "pid": instance.pid,
            "profile_dir": instance.profile_dir,
        }))
    }

    /// The declared profile scope of this instance's computer configuration.
    pub fn profile_scope_for(&self, owner: &str) -> Result<&str> {
        Ok(&self.config.computer_for(owner)?.profile_scope)
    }

    pub fn computer_id_for(&self, owner: &str) -> Result<String> {
        Ok(self.config.computer_for(owner)?.computer_id.clone())
    }

    pub fn update_authority_epoch(&self, epoch: u64) {
        self.authority_epoch.store(epoch, Ordering::SeqCst);
    }

    fn epoch(&self) -> u64 {
        self.authority_epoch.load(Ordering::SeqCst)
    }

    fn registry(&self) -> parking_lot::MutexGuard<'_, ComputerRegistry> {
        self.registry.lock()
    }

    /// Starts (or reuses) the single owned browser session for a computer
    /// under the Host's conversation writer identity.
    async fn ensure_session(&self, computer_id: &str, ghost_id: &str) -> Result<Arc<SessionInner>> {
        let execution_id = format!("browser-{}", ghost_id);
        self.ensure_scoped_session(computer_id, ghost_id, &execution_id).await
    }

    /// One operator-driven browser action with the same lease, fencing, and
    /// takeover gates as agent traffic. The operator CLI holds the authority
    /// that the Host control plane holds for conversation traffic; the gates
    /// themselves (single writer, phases, fresh observation) are identical.
    pub async fn operator_operation(
        &self,
        owner: &str,
        operation: BrowserOperation,
    ) -> Result<Value> {
        let approve = || Ok(());
        self.execute_browser(owner, operation, &approve).await
    }

    pub fn config_computers(&self) -> Vec<OwnedBrowserComputer> {
        self.config.computers()
    }

    /// Consent freshness check: the approval's exact target (snapshot id,
    /// page URL, target role/name) must match the CURRENT live observation.
    /// A relaunched or mutated session never verifies — a fresh exact
    /// question is required before any effect.
    pub fn verify_target(
        &self,
        owner: &str,
        execution_id: &str,
        detail: &Value,
    ) -> Result<bool> {
        let computer_id = self.config.computer_for(owner)?.computer_id.clone();
        let Some(session) = self.sessions.lock().get(&computer_id).cloned() else {
            return Ok(false);
        };
        if session.execution_id != execution_id {
            return Ok(false);
        }
        let control = session.control.lock();
        if control.last_snapshot_id == 0 {
            return Ok(false);
        }
        if u64::try_from(control.last_snapshot_id).unwrap_or(0) != detail["snapshot_id"].as_u64().unwrap_or(u64::MAX) {
            return Ok(false);
        }
        if control.last_url != detail["url"].as_str().unwrap_or_default() {
            return Ok(false);
        }
        let reference = detail["target"]["ref"].as_str().unwrap_or_default();
        let Some(target) = control.refs.get(reference) else {
            return Ok(false);
        };
        Ok(target.role == detail["target"]["role"].as_str().unwrap_or_default()
            && target.name == detail["target"]["name"].as_str().unwrap_or_default())
    }

    /// Read-only fresh observation of the current page: snapshot + url, for
    /// proposing a fresh exact consent question after a relaunch.
    pub fn refresh_observation(
        &self,
        owner: &str,
        execution_id: &str,
    ) -> Result<Value> {
        let approve = || Ok(());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(async {
            self.scoped_execute(
                owner,
                execution_id,
                BrowserOperation::Snapshot,
                &approve,
            )
            .await
        })?;
        let computer_id = self.config.computer_for(owner)?.computer_id.clone();
        let session = self.sessions.lock().get(&computer_id).cloned();
        let Some(session) = session else { return Ok(Value::Null) };
        let control = session.control.lock();
        Ok(json!({
            "url": control.last_url,
            "snapshot_id": control.last_snapshot_id,
        }))
    }

    /// Known-pause stop: stop the owned browser process and clear its
    /// registered instance record while the execution's browser lease stays
    /// held for same-identity resume. Returns the stopped pid, if any.
    pub async fn stop_for_pause(&self, computer_id: &str) -> Option<u32> {
        let session = self.sessions.lock().remove(computer_id)?;
        let pid: Option<u32> = session.child.lock().as_ref().and_then(|child| child.id());
        session.stop().await;
        if let Some(pid) = pid {
            let _ = self.registry().clear_browser_instance(computer_id, pid);
            return Some(pid);
        }
        None
    }

    /// Identity of the currently owned browser session for this computer, if
    /// any: pid (own process group), profile directory, and lease writer.
    /// Recorded durably before lifecycle effects for crash reconciliation.
    pub fn instance_identity(&self, computer_id: &str) -> Result<Value> {
        let Some(session) = self.sessions.lock().get(computer_id).cloned() else {
            return Ok(Value::Null);
        };
        let child = session.child.lock();
        Ok(json!({
            "pid": child.as_ref().and_then(|child| child.id()),
            "process_group": child.as_ref().and_then(|child| child.id()),
            "profile_dir": session.profile_dir,
            "lease_execution_id": session.execution_id,
        }))
    }

    /// Stops the session if one is running. Idempotent.
    pub async fn idle_stop(&self, computer_id: &str, ghost_id: &str) -> Result<Value> {
        let session = self.sessions.lock().remove(computer_id);
        match session {
            Some(session) => {
                let execution_id = session.execution_id.clone();
                session.stop().await;
                let _ = self.registry().release_browser_lease(
                    computer_id,
                    ghost_id,
                    &execution_id,
                    self.epoch(),
                );
                Ok(json!({"stopped": true}))
            }
            None => Ok(json!({"stopped": true, "already_stopped": true})),
        }
    }

    /// Stops and starts the owned browser against the same persistent profile.
    /// `keep_running` is true only for the process that will own the new
    /// session (the Host); verification-only callers stop it again so no
    /// runtime is ever left running unowned.
    pub async fn recreate(
        &self,
        computer_id: &str,
        ghost_id: &str,
        keep_running: bool,
    ) -> Result<Value> {
        self.idle_stop(computer_id, ghost_id).await?;
        let epoch = self.epoch();
        let manifest = self
            .registry()
            .browser_service_manifest(computer_id, ghost_id, epoch)?
            .ok_or_else(|| anyhow!("owned browser has no current registry browser service"))?;
        if !keep_running {
            // Prove the accepted runtime actually launches against the
            // persistent profile, then stop.
            let execution_id = format!("lifecycle-{}", uuid::Uuid::new_v4());
            self.registry().acquire_browser_lease(
                computer_id,
                ghost_id,
                &execution_id,
                epoch,
            )?;
            let computer = self.config.computer_for(ghost_id)?;
            let launched =
                launch_browser(computer, &manifest.browser_profile, &execution_id, self.confinement,
                    self.instance_recorder.then_some((self.registry.as_ref(), epoch))).await;
            let outcome = match launched {
                Ok(session) => {
                    session.stop().await;
                    json!({"recreated": true, "verified": true, "kept_running": false})
                }
                Err(error) => json!({"recreated": false, "error": error.to_string()}),
            };
            let _ = self
                .registry()
                .release_browser_lease(computer_id, ghost_id, &execution_id, epoch);
            ensure!(
                outcome["recreated"] == Value::Bool(true),
                "owned browser recreate failed to launch the pinned runtime: {}",
                outcome["error"].as_str().unwrap_or("unknown error")
            );
            return Ok(outcome);
        }
        let session = self.ensure_session(computer_id, ghost_id).await?;
        let control = session.control.lock();
        Ok(json!({
            "recreated": true,
            "kept_running": true,
            "control_epoch": control.control_epoch,
        }))
    }

    pub fn status(&self, computer_id: &str, ghost_id: &str) -> Result<Value> {
        let headless = self.config.computer_for(ghost_id)?.headless;
        let Some(session) = self.sessions.lock().get(computer_id).cloned() else {
            return Ok(json!({"running": false, "phase": "closed", "headless": headless}));
        };
        let current = self.registry().browser_lease_is_current(
            computer_id,
            ghost_id,
            &session.execution_id,
            self.epoch(),
        )?;
        let control = session.control.lock();
        Ok(json!({
            "running": true,
            "lease_current": current,
            "phase": match control.phase {
                ControlPhase::Agent => "agent_active",
                ControlPhase::Human => "human_owned",
                ControlPhase::Refresh => "resume_pending",
            },
            "control_epoch": control.control_epoch,
            "handoff_id": control.handoff_id,
            "headless": headless,
        }))
    }

    /// Owner-authenticated human takeover. Only the control plane (owner
    /// control token) can reach this; agent traffic is refused while the
    /// phase is human-owned, and prior observations are invalidated.
    async fn take(&self, computer_id: &str, ghost_id: &str) -> Result<Value> {
        let session = self.ensure_session(computer_id, ghost_id).await?;
        let mut control = session.control.lock();
        ensure!(
            control.phase != ControlPhase::Human,
            "browser is already under human control"
        );
        control.phase = ControlPhase::Human;
        control.control_epoch += 1;
        control.invalidate_observations();
        // Conservative sticky-private: a human may log in during takeover; a
        // public-scope profile they touched never silently serves the public
        // again until an explicit operator reset.
        if self.config.computer_for(ghost_id)?.profile_scope == "public" {
            self.registry().mark_browser_profile_contaminated(computer_id)?;
        }
        let handoff_id = uuid::Uuid::new_v4().to_string();
        control.handoff_id = Some(handoff_id.clone());
        Ok(json!({
            "phase": "human_owned",
            "control_epoch": control.control_epoch,
            "handoff_id": handoff_id,
            "observation": "invalidated",
        }))
    }

    /// Owner-authenticated resume. Agent automation stays in resume-pending
    /// until a fresh observation replaces the invalidated one.
    fn release(&self, computer_id: &str) -> Result<Value> {
        let Some(session) = self.sessions.lock().get(computer_id).cloned() else {
            bail!("no running owned browser session to release");
        };
        let mut control = session.control.lock();
        ensure!(
            control.phase == ControlPhase::Human,
            "browser is not under human control"
        );
        control.phase = ControlPhase::Refresh;
        control.control_epoch += 1;
        control.invalidate_observations();
        Ok(json!({
            "phase": "resume_pending",
            "control_epoch": control.control_epoch,
            "fresh_observation_required": true,
        }))
    }

    async fn execute_browser(
        &self,
        owner: &str,
        operation: BrowserOperation,
        authorize: Authorize<'_>,
    ) -> Result<Value> {
        let execution_id = format!("browser-{}", owner);
        self.scoped_execute(owner, &execution_id, operation, authorize).await
    }

    /// One browser operation under an explicit lease writer identity. The
    /// worker relay uses `worker:<execution_id>` so the durable lease binds
    /// the browser to the active work execution and authority epoch.
    pub async fn scoped_execute(
        &self,
        owner: &str,
        execution_id: &str,
        operation: BrowserOperation,
        authorize: Authorize<'_>,
    ) -> Result<Value> {
        let computer = self.config.computer_for(owner)?;
        let computer_id = computer.computer_id.clone();
        let mutating = matches!(
            operation,
            BrowserOperation::Navigate { .. }
                | BrowserOperation::Click { .. }
                | BrowserOperation::Type { .. }
                | BrowserOperation::Key { .. }
                | BrowserOperation::Scroll { .. }
        );
        authorize()?;
        if let BrowserOperation::Navigate { url } = &operation {
            let scope = self.config.computer_for(owner)?.profile_scope.as_str();
            if scope == "public" {
                if self.confinement {
                    ensure!(
                        url_host_is_publicly_routable(url),
                        "navigation target is not a publicly routable http(s) origin"
                    );
                }
                // Sticky-private: human takeover ever touched this public
                // profile — it must not serve public consumption again.
                let contaminated = self.registry().browser_profile_contaminated(&computer_id)?;
                ensure!(
                    !contaminated,
                    "this public profile was touched by human login and is now sticky-private; ask the operator to reset it or attach a private scope"
                );
            } else {
                ensure!(
                    url_is_bounded_http(url),
                    "navigation target must be a bounded http(s) origin without credentials"
                );
            }
        }
        let session = self
            .ensure_scoped_session(&computer_id, owner, execution_id)
            .await?;
        authorize()?;
        {
            let control = session.control.lock();
            match control.phase {
                ControlPhase::Human => bail!(
                    "browser is under human control; the owner must release it before agent work resumes"
                ),
                ControlPhase::Refresh if mutating => bail!(
                    "fresh observation required; snapshot the browser to resume after human control"
                ),
                ControlPhase::Refresh | ControlPhase::Agent => {}
            }
        }
        let result = run_operation(&session, operation).await;
        if result.is_ok() {
            authorize()?;
            let current = self.registry().browser_lease_is_current(
                &computer_id,
                owner,
                execution_id,
                self.epoch(),
            )?;
            ensure!(current, "browser lease was fenced during the operation");
        }
        result
    }

    /// Starts (or reuses) the single owned browser session for a computer
    /// under an explicit lease writer identity.
    async fn ensure_scoped_session(
        &self,
        computer_id: &str,
        ghost_id: &str,
        execution_id: &str,
    ) -> Result<Arc<SessionInner>> {
        let epoch = self.epoch();
        let existing = self.sessions.lock().get(computer_id).cloned();
        if let Some(existing) = existing {
            if existing.execution_id == execution_id {
                let current = self.registry().browser_lease_is_current(
                    computer_id,
                    ghost_id,
                    execution_id,
                    epoch,
                )?;
                if current {
                    return Ok(existing);
                }
            }
            // A different writer or a fenced session: stop the child, forget
            // the session, and re-derive from the registry. The other writer's
            // own lease checks will fence its operations.
            let dead = self.sessions.lock().remove(computer_id);
            if let Some(dead) = dead {
                dead.stop().await;
            }
        }
        let manifest = self
            .registry()
            .browser_service_manifest(computer_id, ghost_id, epoch)?
            .ok_or_else(|| {
                anyhow!(
                    "owned browser has no current registry browser service; attach and bind it first"
                )
            })?;
        self.registry().acquire_browser_lease(
            computer_id,
            ghost_id,
            execution_id,
            epoch,
        )?;
        let computer = self.config.computer_for(ghost_id)?;
        let inner =
            launch_browser(computer, &manifest.browser_profile, execution_id, self.confinement,
                self.instance_recorder.then_some((self.registry.as_ref(), epoch))).await;
        let inner = match inner {
            Ok(inner) => inner,
            Err(error) => {
                let _ = self
                    .registry()
                    .release_browser_lease(computer_id, ghost_id, execution_id, epoch);
                return Err(error);
            }
        };
        self.sessions
            .lock()
            .insert(computer_id.to_owned(), Arc::clone(&inner));
        Ok(inner)
    }
}

impl ComputerBackend for OwnedBrowser {
    fn identity(&self) -> &'static str {
        OWNED_BROWSER_BACKEND_ID
    }

    fn profile_scope(&self, owner: &str) -> Option<&str> {
        self.profile_scope_for(owner).ok()
    }

    fn capabilities(&self) -> ComputerCapabilities {
        ComputerCapabilities {
            browser: true,
            shell: false,
            human_control: true,
            persistent_filesystem: false,
        }
    }

    fn configured(&self) -> bool {
        self.config.computers.values().all(|computer| {
            probe_executable(&computer.executable, &computer.executable_sha256).is_ok()
        })
    }

    fn execute<'a>(
        &'a self,
        owner: &'a str,
        operation: ComputerOperation,
        authorize: Authorize<'a>,
    ) -> ComputerFuture<'a, Result<Value>> {
        Box::pin(async move {
            let ComputerOperation::Browser(browser) = operation else {
                bail!(
                    "computer backend `{OWNED_BROWSER_BACKEND_ID}` does not support the shell capability"
                );
            };
            self.execute_browser(owner, browser, authorize).await
        })
    }

    fn control<'a>(&'a self, owner: &'a str, verb: &'a str) -> ComputerFuture<'a, Result<Value>> {
        Box::pin(async move {
            let computer = self.config.computer_for(owner)?;
            match verb {
                "start" => {
                    self.ensure_session(&computer.computer_id, owner).await?;
                    self.status(&computer.computer_id, owner)
                }
                "stop" => self.idle_stop(&computer.computer_id, owner).await,
                "status" => self.status(&computer.computer_id, owner),
                "take" => self.take(&computer.computer_id, owner).await,
                "release" => self.release(&computer.computer_id),
                _ => bail!("unknown owner computer action"),
            }
        })
    }
}

/// Lifecycle executor for the registry's authorized lifecycle operations.
pub struct OwnedBrowserLifecycle<'a> {
    pub browser: &'a OwnedBrowser,
    /// The Host keeps the recreated session; verification-only callers stop it.
    pub keep_running: bool,
}

impl OwnedBrowserLifecycle<'_> {
    fn ghost_for(&self, computer_id: &str) -> Result<String> {
        self.browser.config.ghost_for(computer_id)
    }

    fn instance(&self, computer_id: &str) -> Result<Value> {
        self.browser.instance_identity(computer_id)
    }
}

impl super::registry::ComputerLifecycle for OwnedBrowserLifecycle<'_> {
    fn instance(&self, computer_id: &str) -> Result<Value> {
        OwnedBrowserLifecycle::instance(self, computer_id)
    }

    fn idle_stop(&self, computer_id: &str) -> Result<Value> {
        let ghost_id = self.ghost_for(computer_id)?;
        // Bounded wait on the owning runtime handle; lifecycle effects are
        // local process control, not open-ended I/O.
        let own = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(
                self.browser.idle_stop(computer_id, &ghost_id),
            )
        })?;
        // A worker process may own the registered Chrome instead; stop the
        // exact registered instance by verified identity.
        let foreign = self.browser.stop_registered_instance(computer_id)?;
        Ok(json!({"own": own, "registered_instance": foreign}))
    }

    fn recreate(&self, computer_id: &str) -> Result<Value> {
        let ghost_id = self.ghost_for(computer_id)?;
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current()
                .block_on(self.browser.recreate(computer_id, &ghost_id, self.keep_running))
        })
    }
}

/// Launches the pinned executable against the owned profile and connects CDP.
/// With confinement, every in-browser request is intercepted and non-public
/// hosts are denied before any connection is made.
async fn launch_browser(
    computer: &OwnedBrowserComputer,
    profile_dir: &Path,
    execution_id: &str,
    confinement: bool,
    recorder: Option<(&Mutex<ComputerRegistry>, u64)>,
) -> Result<Arc<SessionInner>> {
    probe_executable(&computer.executable, &computer.executable_sha256)?;
    std::fs::create_dir_all(profile_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(profile_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    // This profile survives cold shutdown. Its previous endpoint is not a
    // startup receipt for the new Chrome process.
    let port_file = profile_dir.join("DevToolsActivePort");
    match std::fs::symlink_metadata(&port_file) {
        Ok(metadata) => {
            ensure!(metadata.is_file() && !metadata.file_type().is_symlink(),
                "owned browser endpoint metadata is not a regular file");
            std::fs::remove_file(&port_file)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut command = tokio::process::Command::new(&computer.executable);
    command
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg("--remote-debugging-port=0")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-background-networking")
        .arg("--disable-component-update")
        .arg("--disable-sync")
        .arg("--disable-crash-report")
        .arg("--metrics-recording-only")
        .arg("--password-store=basic")
        .arg("--use-mock-keychain")
        .arg("--window-size=1440,900");
    if computer.headless {
        command.arg("--headless=new");
    }
    command.arg("about:blank");
    #[cfg(unix)]
    {
        unsafe {
            command.pre_exec(|| {
                // Own process group: terminal signals stay out of the browser.
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    command
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut child = command.spawn().map_err(|error| {
        anyhow!(
            "owned browser failed to launch {}: {error}",
            computer.executable.display()
        )
    })?;
    if let Some((registry, epoch)) = recorder {
        let pid = child.id().ok_or_else(|| anyhow!("owned browser omitted its process ID"))?;
        let identity = crate::worker::process_identity::inspect(pid)?
            .ok_or_else(|| anyhow!("owned browser process birth identity is unavailable"))?;
        ensure!(identity.process_group == pid as i32, "owned browser has no dedicated process group");
        registry.lock().register_browser_instance(&super::registry::BrowserInstance {
            computer_id: computer.computer_id.clone(),
            pid,
            process_group: identity.process_group,
            executable: computer.executable.display().to_string(),
            start_identity: identity.start_identity,
            profile_dir: profile_dir.display().to_string(),
            lease_execution_id: execution_id.to_owned(),
            authority_epoch: epoch,
        })?;
    }
    let deadline = tokio::time::Instant::now() + LAUNCH_TIMEOUT;
    let endpoint = loop {
        if tokio::time::Instant::now() >= deadline {
            let _ = child.start_kill();
            let _ = child.wait().await;
            bail!("owned browser did not publish its DevTools endpoint in time");
        }
        if let Ok(text) = std::fs::read_to_string(&port_file) {
            let mut lines = text.lines();
            let port: Option<u16> = lines.next().and_then(|line| line.trim().parse().ok());
            let path = lines
                .next()
                .unwrap_or("/devtools/browser")
                .trim()
                .to_owned();
            if let Some(port) = port {
                break format!("ws://127.0.0.1:{port}{path}");
            }
        }
        if let Some(status) = child.try_wait()? {
            bail!("owned browser exited during startup with {status}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let (stream, _response) = connect_async(endpoint)
        .await
        .map_err(|error| anyhow!("owned browser DevTools endpoint refused the connection: {error}"))?;
    let cdp = Cdp::spawn(stream);
    let target = cdp
        .request(None, "Target.createTarget", json!({"url": "about:blank"}))
        .await?;
    let target_id = target["targetId"]
        .as_str()
        .ok_or_else(|| anyhow!("DevTools did not return a page target"))?
        .to_owned();
    let attached = cdp
        .request(
            None,
            "Target.attachToTarget",
            json!({"targetId": target_id, "flatten": true}),
        )
        .await?;
    let session_id = attached["sessionId"]
        .as_str()
        .ok_or_else(|| anyhow!("DevTools did not return a flat session"))?
        .to_owned();
    if confinement {
        cdp.request(
            Some(&session_id),
            "Fetch.enable",
            json!({"patterns": [{"urlPattern": "*", "requestStage": "Request"}]}),
        )
        .await?;
        let interceptor = cdp.clone();
        let mut paused = cdp.subscribe("Fetch.requestPaused");
        let interceptor_session = session_id.clone();
        tokio::spawn(async move {
            while let Some(event) = paused.recv().await {
                let request_id = event["params"]["requestId"].as_str().map(str::to_owned);
                let url = event["params"]["request"]["url"].as_str().unwrap_or_default();
                let Some(request_id) = request_id else { continue };
                if url_host_is_publicly_routable(url) {
                    let _ = interceptor
                        .request(
                            Some(&interceptor_session),
                            "Fetch.continueRequest",
                            json!({"requestId": request_id}),
                        )
                        .await;
                } else {
                    let _ = interceptor
                        .request(
                            Some(&interceptor_session),
                            "Fetch.failRequest",
                            json!({"requestId": request_id, "errorReason": "BlockedByClient"}),
                        )
                        .await;
                }
            }
        });
    }
    Ok(Arc::new(SessionInner {
        cdp,
        target_id,
        session_id,
        execution_id: execution_id.to_owned(),
        control: Mutex::new(ControlState::new()),
        profile_dir: profile_dir.to_path_buf(),
        child: Mutex::new(Some(child)),
    }))
}

/// Minimal Chromium DevTools Protocol client over one loopback WebSocket.
/// Requests are demultiplexed by id; events are delivered to registered
/// one-shot waiters registered before the triggering request is sent.
#[derive(Clone)]
struct Cdp {
    next_id: Arc<AtomicU64>,
    sender: mpsc::UnboundedSender<Message>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>>>,
    events: Arc<Mutex<HashMap<String, Vec<oneshot::Sender<Value>>>>>,
    subscribers: Arc<Mutex<HashMap<String, Vec<mpsc::UnboundedSender<Value>>>>>,
}

impl Cdp {
    fn spawn(stream: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>) -> Self {
        let (sender, mut receiver) = mpsc::unbounded_channel::<Message>();
        let (mut sink, mut source) = stream.split();
        // Writer pump: serializes every outgoing frame through one sink.
        tokio::spawn(async move {
            while let Some(message) = receiver.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
        });
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let events: Arc<Mutex<HashMap<String, Vec<oneshot::Sender<Value>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let subscribers: Arc<Mutex<HashMap<String, Vec<mpsc::UnboundedSender<Value>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_reader = pending.clone();
        let events_reader = events.clone();
        let subscribers_reader = subscribers.clone();
        tokio::spawn(async move {
            while let Some(message) = source.next().await {
                let Ok(message) = message else { break };
                let Message::Text(text) = message else { continue };
                let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(id) = value["id"].as_u64() {
                    if let Some(waiter) = pending_reader.lock().remove(&id) {
                        let payload = if let Some(error) = value["error"].as_object() {
                            Err(error["message"]
                                .as_str()
                                .unwrap_or("DevTools error")
                                .to_owned())
                        } else {
                            Ok(value["result"].clone())
                        };
                        let _ = waiter.send(payload);
                    }
                    continue;
                }
                if let Some(method) = value["method"].as_str().map(str::to_owned) {
                    {
                        let mut waiters = events_reader.lock();
                        if let Some(queued) = waiters.remove(&method) {
                            for waiter in queued {
                                let _ = waiter.send(value.clone());
                            }
                        }
                    }
                    let mut listening = subscribers_reader.lock();
                    if let Some(queues) = listening.get_mut(&method) {
                        for queue in queues {
                            let _ = queue.send(value.clone());
                        }
                    }
                }
            }
            let mut waiting = pending_reader.lock();
            for (_, waiter) in waiting.drain() {
                let _ = waiter.send(Err("DevTools connection closed".into()));
            }
        });
        Self {
            next_id: Arc::new(AtomicU64::new(1)),
            sender,
            pending,
            events,
            subscribers,
        }
    }

    /// Continuous event stream for protocol loops such as request
    /// interception. Dropping the receiver unsubscribes.
    fn subscribe(&self, method: &str) -> mpsc::UnboundedReceiver<Value> {
        let (sender, receiver) = mpsc::unbounded_channel();
        self.events
            .lock()
            .remove(method);
        self.subscribers
            .lock()
            .entry(method.to_owned())
            .or_default()
            .push(sender);
        receiver
    }

    async fn request(&self, session: Option<&str>, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut message = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            message["sessionId"] = Value::String(session.to_owned());
        }
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().insert(id, sender);
        if self
            .sender
            .send(Message::Text(serde_json::to_string(&message)?.into()))
            .is_err()
        {
            self.pending.lock().remove(&id);
            bail!("DevTools connection is closed");
        }
        match tokio::time::timeout(CDP_TIMEOUT, receiver).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(error))) => Err(anyhow!("DevTools {method} failed: {error}")),
            Ok(Err(_)) | Err(_) => {
                self.pending.lock().remove(&id);
                Err(anyhow!("DevTools {method} timed out"))
            }
        }
    }

    /// Registers a one-shot event waiter before the triggering request.
    async fn wait_event(&self, method: &str, timeout: Duration) -> Option<Value> {
        let (sender, receiver) = oneshot::channel();
        self.events
            .lock()
            .entry(method.to_owned())
            .or_default()
            .push(sender);
        tokio::time::timeout(timeout, receiver).await.ok()?.ok()
    }
}

/// Dispatches one browser operation against the live session.
async fn run_operation(session: &SessionInner, operation: BrowserOperation) -> Result<Value> {
    let cdp = &session.cdp;
    let sid = session.session_id.as_str();
    match operation {
        BrowserOperation::Navigate { url } => {
            let loaded = cdp.wait_event("Page.loadEventFired", NAVIGATION_TIMEOUT);
            let started = cdp
                .request(Some(sid), "Page.navigate", json!({"url": url}))
                .await?;
            let settled = loaded.await.is_some();
            let title = cdp
                .request(
                    Some(sid),
                    "Runtime.evaluate",
                    json!({"expression": "document.title", "returnByValue": true}),
                )
                .await?;
            Ok(json!({
                "navigated": started["errorText"].is_null(),
                "url": url,
                "load_settled": settled,
                "title": title["result"]["value"].clone(),
            }))
        }
        BrowserOperation::Read => {
            let text = cdp
                .request(
                    Some(sid),
                    "Runtime.evaluate",
                    json!({
                        "expression":
                            format!("document.body ? document.body.innerText.slice(0, {MAX_TEXT_CHARS}) : ''"),
                        "returnByValue": true,
                    }),
                )
                .await?;
            let title = cdp
                .request(
                    Some(sid),
                    "Runtime.evaluate",
                    json!({"expression": "document.title", "returnByValue": true}),
                )
                .await?;
            Ok(json!({
                "title": title["result"]["value"].clone(),
                "text": text["result"]["value"].clone(),
            }))
        }
        BrowserOperation::Snapshot => {
            let tree = cdp
                .request(Some(sid), "Accessibility.getFullAXTree", json!({}))
                .await?;
            let nodes = tree["nodes"].as_array().cloned().unwrap_or_default();
            ensure!(
                nodes.len() <= MAX_SNAPSHOT_NODES,
                "page accessibility tree exceeds its snapshot budget"
            );
            let snapshot_id = {
                let mut control = session.control.lock();
                control.invalidate_observations();
                control.last_snapshot_id += 1;
                control.last_snapshot_id
            };
            let page_url: String = cdp
                .request(
                    Some(sid),
                    "Runtime.evaluate",
                    json!({"expression": "location.href", "returnByValue": true}),
                )
                .await
                .ok()
                .and_then(|value| {
                    value["result"]["value"].as_str().map(str::to_owned)
                })
                .unwrap_or_default();
            session.control.lock().last_url = page_url;
            let mut elements = Vec::new();
            let mut refs: HashMap<String, RefTarget> = HashMap::new();
            for node in &nodes {
                if elements.len() >= MAX_SNAPSHOT_ELEMENTS {
                    break;
                }
                let role = node["role"]["value"].as_str().unwrap_or("generic");
                let name = node["name"]["value"].as_str().unwrap_or_default();
                let ignored = node["ignored"].as_bool().unwrap_or(true);
                let backend = node["backendDOMNodeId"].as_i64();
                let (Some(backend), false, false) = (backend, ignored, name.is_empty()) else {
                    continue;
                };
                let mut center: Option<(f64, f64)> = None;
                if let Ok(box_model) = cdp
                    .request(Some(sid), "DOM.getBoxModel", json!({"backendNodeId": backend}))
                    .await
                {
                    let quad: Vec<f64> = box_model["model"]["content"]
                        .as_array()
                        .map(|points| points.iter().filter_map(Value::as_f64).collect())
                        .unwrap_or_default();
                    if quad.len() >= 8 {
                        center = Some((
                            (quad[0] + quad[2] + quad[4] + quad[6]) / 4.0,
                            (quad[1] + quad[3] + quad[5] + quad[7]) / 4.0,
                        ));
                    }
                }
                let reference = format!("e{}", elements.len() + 1);
                let target = RefTarget {
                    backend,
                    x: center.map(|(x, _)| x).unwrap_or(f64::NAN),
                    y: center.map(|(_, y)| y).unwrap_or(f64::NAN),
                    role: role.to_owned(),
                    name: name.to_owned(),
                };
                refs.insert(reference.clone(), target);
                elements.push(json!({"ref": reference, "role": role, "name": name}));
            }
            session.control.lock().refs = refs;
            Ok(json!({"snapshot_id": snapshot_id, "elements": elements}))
        }
        BrowserOperation::Screenshot => {
            let shot = cdp
                .request(Some(sid), "Page.captureScreenshot", json!({"format": "png"}))
                .await?;
            let data = shot["data"]
                .as_str()
                .ok_or_else(|| anyhow!("DevTools returned no screenshot"))?;
            ensure!(
                data.len() <= MAX_SCREENSHOT_CHARS,
                "screenshot exceeds its size budget"
            );
            Ok(json!({"format": "png", "data_base64": data}))
        }
        BrowserOperation::Click { reference, snapshot_id } => {
            let point = fresh_point(&session.control, &reference, snapshot_id)?;
            dispatch_click(cdp, sid, point.0, point.1).await?;
            Ok(json!({"clicked": reference}))
        }
        BrowserOperation::Type { reference, snapshot_id, text } => {
            let point = fresh_point(&session.control, &reference, snapshot_id)?;
            dispatch_click(cdp, sid, point.0, point.1).await?;
            cdp.request(Some(sid), "Input.insertText", json!({"text": text}))
                .await?;
            Ok(json!({"typed": text.chars().count()}))
        }
        BrowserOperation::Key { key } => {
            dispatch_key(cdp, sid, &key).await?;
            Ok(json!({"key": key}))
        }
        BrowserOperation::Scroll { delta_y } => {
            cdp.request(
                Some(sid),
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseWheel",
                    "x": 720, "y": 450,
                    "deltaX": 0, "deltaY": delta_y,
                }),
            )
            .await?;
            Ok(json!({"scrolled": delta_y}))
        }
    }
}

fn fresh_point(
    control: &Mutex<ControlState>,
    reference: &str,
    snapshot_id: u64,
) -> Result<(f64, f64)> {
    let control = control.lock();
    ensure!(
        control.last_snapshot_id == snapshot_id && snapshot_id > 0,
        "stale observation; take a fresh snapshot before acting"
    );
    let target = control
        .refs
        .get(reference)
        .ok_or_else(|| anyhow!("unknown element reference; take a fresh snapshot"))?;
    let (x, y) = (target.x, target.y);
    ensure!(
        x.is_finite() && y.is_finite(),
        "element has no actionable geometry; take a fresh snapshot"
    );
    Ok((x, y))
}

async fn dispatch_click(cdp: &Cdp, sid: &str, x: f64, y: f64) -> Result<()> {
    for event_type in ["mousePressed", "mouseReleased"] {
        cdp.request(
            Some(sid),
            "Input.dispatchMouseEvent",
            json!({
                "type": event_type,
                "x": x, "y": y,
                "button": "left", "buttons": 1,
                "clickCount": 1,
            }),
        )
        .await?;
    }
    Ok(())
}

async fn dispatch_key(cdp: &Cdp, sid: &str, key: &str) -> Result<()> {
    const NATIVE_KEYS: &[(&str, u32)] = &[
        ("Enter", 13),
        ("Tab", 9),
        ("Escape", 27),
        ("Backspace", 8),
        ("Delete", 46),
        ("ArrowLeft", 37),
        ("ArrowUp", 38),
        ("ArrowRight", 39),
        ("ArrowDown", 40),
        ("Home", 36),
        ("End", 35),
        ("PageUp", 33),
        ("PageDown", 34),
    ];
    ensure!(
        !key.is_empty() && key.chars().count() <= 32,
        "key name is empty or exceeds its size limit"
    );
    let named = NATIVE_KEYS.iter().find(|(name, _)| *name == key).copied();
    let (code, native, text) = match named {
        Some((name, virtual_key)) => (
            name.to_owned(),
            virtual_key,
            if name == "Enter" { "\r".to_owned() } else { String::new() },
        ),
        None => {
            ensure!(
                key.chars().all(|c| c.is_ascii_graphic()),
                "unsupported key name"
            );
            (format!("Key{}", key.to_uppercase()), key.chars().next().unwrap() as u32, key.to_owned())
        }
    };
    for event_type in ["rawKeyDown", "keyUp"] {
        let mut params = json!({
            "type": event_type,
            "key": key, "code": code,
            "windowsVirtualKeyCode": native, "nativeVirtualKeyCode": native,
        });
        if event_type == "rawKeyDown" && !text.is_empty() && named.is_none() {
            params["text"] = Value::String(text.clone());
        }
        cdp.request(Some(sid), "Input.dispatchKeyEvent", params).await?;
    }
    Ok(())
}

/// Registry-side service binding helper for host startup: the service rides
/// the binding epoch, declares its profile scope, and carries exactly the
/// offered browser capabilities.
pub fn browser_service_binding(
    computer_id: &str,
    ghost_id: &str,
    host_id: &str,
    epoch: u64,
    profile_scope: &str,
) -> BrowserServiceBinding {
    let capabilities = vec!["browser".to_owned(), "human_control".to_owned()];
    BrowserServiceBinding {
        computer_id: computer_id.to_owned(),
        ghost_id: ghost_id.to_owned(),
        backend: OWNED_BROWSER_BACKEND_ID.to_owned(),
        host_id: host_id.to_owned(),
        epoch,
        grant_revision: 1,
        profile_scope: profile_scope.to_owned(),
        capabilities: capabilities.clone(),
        accepted_capabilities: capabilities,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_facts_share_one_pinned_executable() {
        let sha = format!("{:x}", Sha256::digest(b"pin"));
        let config = OwnedBrowserConfig::from_computers(vec![OwnedBrowserComputer {
            ghost_id: "11111111-1111-7111-8111-111111111111".into(),
            computer_id: "comp-a".into(),
            executable: "/bin/echo".into(),
            executable_sha256: sha,
            headless: true,
            profile_scope: "public".into(),
        }]);
        assert!(config.is_err(), "/bin/echo digest will not match the pin; config must refuse");
    }

    #[test]
    fn missing_executable_fails_validation() {
        let sha = format!("{:x}", Sha256::digest(b"nope"));
        let missing = std::env::temp_dir().join(format!("ghost-missing-{}", uuid::Uuid::new_v4()));
        let config = OwnedBrowserConfig::from_computers(vec![OwnedBrowserComputer {
            ghost_id: "11111111-1111-7111-8111-111111111111".into(),
            computer_id: "comp-a".into(),
            executable: missing,
            executable_sha256: sha,
            headless: true,
            profile_scope: "public".into(),
        }]);
        assert!(config.is_err(), "a missing pinned executable must fail validation");
    }

    #[test]
    fn service_binding_rides_binding_epoch() {
        let binding = browser_service_binding("comp-a", "ghost", "host", 3, "public");
        assert_eq!(binding.epoch, 3);
        assert_eq!(binding.backend, "ghost-owned-browser");
        assert_eq!(binding.profile_scope, "public");
        assert_eq!(
            binding.accepted_capabilities,
            vec!["browser".to_owned(), "human_control".to_owned()]
        );
    }

}
