use super::registry::HomeManifest;
use super::producer_profile::{AcceptedProducerProfile, ProducerProfileManifest, ProducerRuntimeFactsReceipt,
    ProducerRuntimeObservation, PRODUCER_JSON_PROBE_COMMAND, producer_json_probe_sha256};
use crate::adapters::computer::{
    Authorize, ComputerBackend, ComputerCapabilities, ComputerFuture, ComputerOperation,
};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Command as StdCommand, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::Notify,
    task::JoinHandle,
    time::{sleep, timeout},
};

pub const APPLE_CONTAINER_CLI_VERSION: &str = "1.4.1";
pub const APPLE_CONTAINER_OUTPUT_LIMIT: usize = 64 * 1024;
const MAX_COMMAND_BYTES: usize = 8192;
pub const PINNED_TASK_IMAGE: &str =
    "docker.io/library/ubuntu@sha256:08571ca13e00ca07a2a84eab83a959b4242e22cceb16486a11bef1428c9e93a7";
// Configured producer policy, shared with the actual task argv below. These
// describe a plan, not installed software, runtime health or a probed inventory.
const TASK_GUEST_OS:&str="linux";
const TASK_GUEST_ARCH:&str="arm64";
const TASK_SHELL:&str="/bin/sh";
const TASK_SHELL_ARGUMENT:&str="-lc";
const TASK_ROOT_READ_ONLY:bool=true;
const TASK_NETWORK:&str="none";
const PRODUCER_WORK_MOUNT:&str="/workspace";
const PRODUCER_WORK_WRITABLE:bool=true;
const PRODUCER_TMPFS_TMP:bool=false;
const MAX_EXECUTION_TIMEOUT: Duration = Duration::from_secs(300);
const CLI_TIMEOUT: Duration = Duration::from_secs(10);
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const STOP_CONFIRM_TIMEOUT: Duration = Duration::from_secs(12);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const MINIMUM_MACOS_MAJOR: u32 = 26;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppleCliOutcome {
    Success,
    ServiceUnavailable,
    Failed,
}

/// A direct argv/stdin plan. D1 deliberately never marks a plan executable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleContainerCliPlan {
    pub program: PathBuf,
    pub argv: Vec<OsString>,
    pub stdin: Option<Vec<u8>>,
    pub execution_allowed: bool,
    pub blocked_reasons: Vec<String>,
}

pub struct AppleContainerBackend {
    cli_path: PathBuf,
    available: bool,
    task: Option<Arc<TaskContext>>,
    runtime: Arc<TaskRuntime>,
}

struct TaskContext {
    manifest: HomeManifest,
    execution_id: String,
    image_ref: String,
    guest_uid: u32,
    guest_gid: u32,
    container_name: String,
    verification_only: bool,
    producer_profile: Option<ProducerProfileManifest>,
    producer_cli_sha256: Option<String>,
}

struct TaskRuntime {
    attempted: AtomicBool,
    active: AtomicBool,
    control_request: AtomicU8,
    last_state: Mutex<Option<&'static str>>,
    finished: Notify,
}

impl TaskRuntime {
    fn new() -> Self {
        Self {
            attempted: AtomicBool::new(false),
            active: AtomicBool::new(false),
            control_request: AtomicU8::new(0),
            last_state: Mutex::new(None),
            finished: Notify::new(),
        }
    }

    fn begin(&self) -> Result<()> {
        let mut last_state = self
            .last_state
            .lock()
            .map_err(|_| anyhow!("task runtime state is poisoned"))?;
        if self.attempted.load(Ordering::Acquire) && last_state.is_none() {
            bail!("prior task effect is uncertain; reconcile before another tool invocation");
        }
        self.control_request.store(0, Ordering::Release);
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| anyhow!("task execution is already active"))?;
        self.attempted.store(true, Ordering::Release);
        *last_state = None;
        Ok(())
    }

    fn begin_control(&self) -> Result<()> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| anyhow!("task execution is already active"))?;
        self.attempted.store(true, Ordering::Release);
        Ok(())
    }

    fn finish(&self, state: Option<&'static str>) {
        if let Ok(mut last_state) = self.last_state.lock() {
            *last_state = state;
        }
        self.active.store(false, Ordering::Release);
        self.finished.notify_waiters();
    }

    fn last_state(&self) -> Result<Option<&'static str>> {
        self.last_state
            .lock()
            .map(|state| *state)
            .map_err(|_| anyhow!("task runtime state is poisoned"))
    }
}

impl AppleContainerBackend {
    /// Public guest coordinates only. In particular, the pinned image does not
    /// assert that any language, package, executable or service is available.
    pub(crate) fn configured_producer_environment()->Value {
        serde_json::json!({
            "version":"ghost-execution-environment/1","evidence":"configured_policy","backend":"apple_container",
            "image_ref":PINNED_TASK_IMAGE,"os":TASK_GUEST_OS,"architecture":TASK_GUEST_ARCH,
            "shell":{"program":TASK_SHELL,"args":[TASK_SHELL_ARGUMENT]},"cwd":PRODUCER_WORK_MOUNT,
            "filesystem":{"root_read_only":TASK_ROOT_READ_ONLY,"work_mount":{"target":PRODUCER_WORK_MOUNT,"writable":PRODUCER_WORK_WRITABLE},"tmpfs_mounts":if PRODUCER_TMPFS_TMP {vec!["/tmp"]}else{vec![]}},
            "network":TASK_NETWORK
        })
    }
    /// Probe only the installed binary and read-only service status. Never starts
    /// the container service or changes launchd/global configuration.
    pub fn probe(cli_path: &Path) -> Result<Self> {
        ensure_supported_host()?;
        let cli_path = cli_path.canonicalize()?;
        if !cli_path.is_file() {
            bail!("Apple container CLI path is not a regular file");
        }

        let version = StdCommand::new(&cli_path)
            .arg("--version")
            .stdin(Stdio::null())
            .output()?;
        let version_outcome = parse_cli_result(
            version.status.code().unwrap_or(-1),
            &version.stdout,
            &version.stderr,
        )?;
        if version_outcome != AppleCliOutcome::Success {
            bail!("Apple container CLI version probe failed");
        }
        let version_text = String::from_utf8_lossy(&version.stdout);
        let observed_version = version_text
            .split("container CLI version ")
            .nth(1)
            .and_then(|value| value.split_whitespace().next())
            .ok_or_else(|| anyhow!("Apple container CLI version output was unrecognized"))?;
        if observed_version != APPLE_CONTAINER_CLI_VERSION {
            bail!("unsupported Apple container CLI version");
        }

        let status = StdCommand::new(&cli_path)
            .args(["system", "status"])
            .stdin(Stdio::null())
            .output()?;
        let status_outcome = parse_cli_result(
            status.status.code().unwrap_or(-1),
            &status.stdout,
            &status.stderr,
        )?;
        Ok(Self {
            cli_path,
            available: status_outcome == AppleCliOutcome::Success,
            task: None,
            runtime: Arc::new(TaskRuntime::new()),
        })
    }

    /// Pin this backend to one validated task and the single D2 image.
    pub fn for_task(
        cli_path: &Path,
        manifest: &HomeManifest,
        execution_id: &str,
        image_ref: &str,
        guest_uid: u32,
        guest_gid: u32,
    ) -> Result<Self> {
        if image_ref != PINNED_TASK_IMAGE {
            bail!("Apple container task image is not the D2 pinned digest");
        }
        if guest_uid == 0 || guest_gid == 0 {
            bail!("Apple container guest UID and GID must be explicitly non-root");
        }
        let task = TaskContext::new(
            manifest,
            execution_id,
            image_ref,
            guest_uid,
            guest_gid,
        )?;
        let mut backend = Self::probe(cli_path)?;
        backend.task = Some(Arc::new(task));
        Ok(backend)
    }

    /// Producer-only route. A model cannot supply an image or construct the
    /// sealed profile. The exact cached image is rechecked before each shell
    /// spawn; absent/mismatching references never reach `container run`.
    pub(crate) fn for_accepted_producer(
        cli_path: &Path, manifest: &HomeManifest, execution_id: &str,
        profile: &AcceptedProducerProfile, guest_uid: u32, guest_gid: u32,
    ) -> Result<Self> {
        if guest_uid != profile.runtime_facts().sandbox_uid || guest_gid != profile.runtime_facts().sandbox_gid {
            bail!("Accepted producer probe UID/GID differs from this task");
        }
        if producer_cli_sha256(cli_path)? != profile.runtime_facts().container_cli_sha256 {
            bail!("Accepted producer probe executable differs from this CLI");
        }
        let mut task = TaskContext::producer(manifest, execution_id, profile.manifest(), guest_uid, guest_gid)?;
        task.producer_cli_sha256 = Some(profile.runtime_facts().container_cli_sha256.clone());
        let mut backend = Self::probe(cli_path)?;
        if producer_cli_sha256(&backend.cli_path)? != profile.runtime_facts().container_cli_sha256 {
            bail!("Accepted producer CLI changed during validation");
        }
        backend.task = Some(Arc::new(task));
        Ok(backend)
    }

    /// Bootstrap capability evidence only. This accepts a proposed immutable
    /// plan but can execute ONLY the fixed general JSON/stdlib probe. The
    /// returned real receipt is not Owner acceptance or a Work grant.
    pub(crate) async fn probe_producer_profile(
        cli_path: &Path, manifest: &HomeManifest, execution_id: &str,
        profile: &ProducerProfileManifest, guest_uid: u32, guest_gid: u32,
        authorize: Authorize<'_>,
    ) -> Result<ProducerRuntimeFactsReceipt> {
        let mut task = TaskContext::producer(manifest, execution_id, profile, guest_uid, guest_gid)?;
        let cli_sha256 = producer_cli_sha256(cli_path)?;
        let mut backend = Self::probe(cli_path)?;
        if producer_cli_sha256(&backend.cli_path)? != cli_sha256 {
            bail!("Producer probe CLI changed during version/service validation");
        }
        task.producer_cli_sha256 = Some(cli_sha256.clone());
        backend.task = Some(Arc::new(task));
        let result = backend.execute_shell(PRODUCER_JSON_PROBE_COMMAND, 30_000, authorize).await?;
        let cli_identity = match producer_cli_sha256(&backend.cli_path) {
            Ok(observed) if observed == cli_sha256 => ProbeCliIdentity::Matched,
            Ok(_) => ProbeCliIdentity::Changed,
            Err(_) => ProbeCliIdentity::Unavailable,
        };
        let observation = producer_probe_observation(&result, cli_identity)?;
        let facts = ProducerRuntimeFactsReceipt { kind: "ghost-producer-runtime-facts/1".into(),
            profile_digest: profile.digest()?, image_ref: profile.image_ref.clone(),
            platform_manifest_digest: profile.platform_manifest_digest.clone(),
            probe_sha256: producer_json_probe_sha256(), observation_sha256: observation.digest()?, exit_code: 0,
            evidence: "owned_container_probe".into(), container_cli_sha256: cli_sha256, container_cli_version: APPLE_CONTAINER_CLI_VERSION.into(),
            sandbox_uid: guest_uid, sandbox_gid: guest_gid, observation };
        facts.validate_for_profile(profile).map_err(|_| producer_probe_rejection("runtime_facts_rejected", &result, cli_identity))?;
        Ok(facts)
    }

    /// Deterministic Host verification only: the selected snapshot is mounted
    /// read-only at /inputs, with disposable tmpfs scratch and no producer home.
    pub(crate) fn for_verification(cli_path:&Path,manifest:&HomeManifest,execution_id:&str,image_ref:&str,guest_uid:u32,guest_gid:u32)->Result<Self> {
        let mut backend=Self::for_task(cli_path,manifest,execution_id,image_ref,guest_uid,guest_gid)?;
        Arc::get_mut(backend.task.as_mut().ok_or_else(||anyhow!("verification task missing"))?).ok_or_else(||anyhow!("verification task unexpectedly shared"))?.verification_only=true;
        Ok(backend)
    }

    pub fn available(&self) -> bool {
        self.available
    }

    /// Build a pinned Linux/arm64 shell plan mounting only the selected task
    /// snapshot. Home, browser profile, host sockets, and credentials are omitted.
    /// The plan remains non-executable until D2 accepts runtime and egress policy.
    pub fn plan_shell(
        &self,
        manifest: &HomeManifest,
        execution_id: &str,
        image_ref: &str,
        guest_uid: u32,
        guest_gid: u32,
        network_name: &str,
        command: &str,
        stdin: Option<Vec<u8>>,
    ) -> Result<AppleContainerCliPlan> {
        let mut plan = AppleContainerCliPlan::shell(
            &self.cli_path,
            manifest,
            execution_id,
            image_ref,
            guest_uid,
            guest_gid,
            network_name,
            command,
            stdin,
        )?;
        if !self.available {
            plan.blocked_reasons
                .push("container API server is not currently available".to_owned());
        }
        Ok(plan)
    }
}

impl AppleContainerCliPlan {
    /// Pure argv/stdin construction for coordinator planning and isolated tests.
    pub fn shell(
        cli_path: &Path,
        manifest: &HomeManifest,
        execution_id: &str,
        image_ref: &str,
        guest_uid: u32,
        guest_gid: u32,
        network_name: &str,
        command: &str,
        stdin: Option<Vec<u8>>,
    ) -> Result<Self> {
        if !valid_component(execution_id) {
            bail!("execution ID is not a safe task-snapshot component");
        }
        if !is_pinned_image(image_ref) {
            bail!("Apple container task image must be pinned by sha256 digest");
        }
        if guest_uid == 0 || guest_gid == 0 {
            bail!("Apple container guest UID and GID must be explicitly non-root");
        }
        if !valid_network_name(network_name) {
            bail!("Apple container network name is invalid");
        }
        if command.is_empty() || command.len() > MAX_COMMAND_BYTES || command.contains('\0') {
            bail!("shell command is empty or exceeds its bounded plan size");
        }
        if stdin
            .as_ref()
            .is_some_and(|bytes| bytes.len() > APPLE_CONTAINER_OUTPUT_LIMIT)
        {
            bail!("Apple container stdin plan exceeds the bounded input size");
        }

        let snapshot = resolve_task_snapshot(manifest, execution_id)?;
        let source = snapshot
            .to_str()
            .ok_or_else(|| anyhow!("task snapshot path is not UTF-8"))?;

        let mut argv = vec![
            OsString::from("run"),
            OsString::from("--rm"),
            OsString::from("--os"),
            OsString::from("linux"),
            OsString::from("--arch"),
            OsString::from("arm64"),
            OsString::from("--uid"),
            OsString::from(guest_uid.to_string()),
            OsString::from("--gid"),
            OsString::from(guest_gid.to_string()),
            OsString::from("--cap-drop"),
            OsString::from("ALL"),
            OsString::from("--read-only"),
            OsString::from("--network"),
            OsString::from(network_name),
            OsString::from("--mount"),
            OsString::from(format!("source={source},target=/workspace")),
        ];
        if stdin.is_some() {
            argv.push(OsString::from("--interactive"));
        }
        argv.extend([
            OsString::from(image_ref),
            OsString::from("/bin/sh"),
            OsString::from("-lc"),
            OsString::from(command),
        ]);

        Ok(Self {
            program: cli_path.to_path_buf(),
            argv,
            stdin,
            execution_allowed: false,
            blocked_reasons: vec![
                "D1 prepares plans only; actual container invocation is not accepted".to_owned(),
                "network egress enforcement has not passed the D2 gate".to_owned(),
            ],
        })
    }
}

struct CliOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    overflow: bool,
}

struct RunningCli {
    child: Child,
    stdout: JoinHandle<Result<Vec<u8>>>,
    stderr: JoinHandle<Result<Vec<u8>>>,
    overflow: Arc<AtomicBool>,
}

impl RunningCli {
    fn try_wait(&mut self) -> Result<Option<ExitStatus>> {
        self.child.try_wait().map_err(anyhow::Error::from)
    }

    fn output_overflowed(&self) -> bool {
        self.overflow.load(Ordering::Acquire)
    }

    async fn finish(mut self, status: ExitStatus) -> Result<CliOutput> {
        let readers = timeout(PIPE_DRAIN_TIMEOUT, async {
            tokio::join!(&mut self.stdout, &mut self.stderr)
        }).await;
        let (stdout, stderr) = match readers {
            Ok(readers) => readers,
            Err(_) => {
                self.stdout.abort(); self.stderr.abort();
                let _ = tokio::join!(self.stdout, self.stderr);
                bail!("container CLI pipe drain deadline exceeded");
            }
        };
        Ok(CliOutput {
            status,
            stdout: stdout.map_err(|error| anyhow!("stdout reader task failed: {error}"))??,
            stderr: stderr.map_err(|error| anyhow!("stderr reader task failed: {error}"))??,
            overflow: self.overflow.load(Ordering::Acquire),
        })
    }

    async fn reap(mut self, wait: Duration) -> Result<CliOutput> {
        let deadline = Instant::now() + wait;
        loop {
            if let Some(status) = self.try_wait()? {
                return self.finish(status).await;
            }
            if Instant::now() >= deadline {
                let _ = self.child.start_kill();
                let status = self.child.wait().await?;
                return self.finish(status).await;
            }
            sleep(POLL_INTERVAL).await;
        }
    }
}

struct RunGuard {
    runtime: Arc<TaskRuntime>,
    cli_path: PathBuf,
    task: Arc<TaskContext>,
    armed: bool,
}

impl RunGuard {
    fn new(runtime: Arc<TaskRuntime>, cli_path: &Path, task: &Arc<TaskContext>) -> Self {
        Self {
            runtime,
            cli_path: cli_path.to_path_buf(),
            task: task.clone(),
            armed: true,
        }
    }

    fn finish(&mut self, state: Option<&'static str>) {
        if self.armed {
            self.runtime.finish(state);
            self.armed = false;
        }
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.runtime.control_request.store(2, Ordering::Release);
        let runtime = self.runtime.clone();
        let cli_path = self.cli_path.clone();
        let task = self.task.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let backend = AppleContainerBackend {
                    cli_path,
                    available: true,
                    task: Some(task.clone()),
                    runtime: runtime.clone(),
                };
                let result = backend.kill_and_cleanup(&task).await;
                runtime.finish(result.is_ok().then_some("stopped"));
            });
        } else {
            self.runtime.finish(None);
        }
    }
}

impl AppleContainerBackend {
    fn spawn_cli(&self, argv: &[OsString]) -> Result<RunningCli> {
        let mut command = Command::new(&self.cli_path);
        command
            .args(argv)
            .current_dir("/")
            .env_clear()
            .env("PATH", "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for key in ["HOME", "TMPDIR", "LANG", "LC_ALL"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = command.spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Apple container stdout pipe was unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("Apple container stderr pipe was unavailable"))?;
        let budget = Arc::new(AtomicUsize::new(0));
        let overflow = Arc::new(AtomicBool::new(false));
        let stdout = tokio::spawn(read_bounded(stdout, budget.clone(), overflow.clone()));
        let stderr = tokio::spawn(read_bounded(stderr, budget, overflow.clone()));
        Ok(RunningCli {
            child,
            stdout,
            stderr,
            overflow,
        })
    }

    async fn run_cli(&self, argv: &[OsString], wait: Duration) -> Result<CliOutput> {
        self.spawn_cli(argv)?.reap(wait).await
    }

    fn task_context(&self) -> Result<&Arc<TaskContext>> {
        self.task
            .as_ref()
            .ok_or_else(|| anyhow!("Apple container backend is not bound to a task"))
    }

    async fn execute_shell(
        &self,
        command: &str,
        timeout_ms: u64,
        authorize: Authorize<'_>,
    ) -> Result<Value> {
        if command.is_empty() || command.len() > MAX_COMMAND_BYTES || command.contains('\0') {
            bail!("shell command is empty or exceeds its bounded size");
        }
        let timeout = Duration::from_millis(timeout_ms);
        if timeout.is_zero() || timeout > MAX_EXECUTION_TIMEOUT {
            bail!("shell timeout must be between 1 ms and 300000 ms");
        }
        if authorize().is_err() {
            bail!("computer authorization was revoked before guest execution");
        }
        let task = self.task_context()?;
        if let Some(expected) = &task.producer_cli_sha256 {
            if producer_cli_sha256(&self.cli_path)? != *expected { bail!("Accepted producer CLI identity changed before image inspection"); }
        }
        let image_args = [
            OsString::from("image"),
            OsString::from("inspect"),
            OsString::from(task.image_ref.as_str()),
        ];
        let image = self.run_cli(&image_args, CLI_TIMEOUT).await?;
        ensure_cli_success(&image, "pinned image inspection")?;
        if let Some(profile) = &task.producer_profile {
            let inspection: Value = serde_json::from_slice(&image.stdout)
                .map_err(|_| anyhow!("Producer cached image inspection is not valid JSON"))?;
            profile.validate_cached_image(&inspection)?;
            if task.producer_cli_sha256.as_ref().is_none_or(|expected| producer_cli_sha256(&self.cli_path).as_ref().ok() != Some(expected)) {
                bail!("Accepted producer CLI identity changed before guest execution");
            }
        }

        let snapshot = task.snapshot()?;
        let argv = task.run_argv(&snapshot, command)?;
        self.runtime.begin()?;
        let mut guard = RunGuard::new(self.runtime.clone(), &self.cli_path, task);
        if self.runtime.control_request.load(Ordering::Acquire) != 0 {
            guard.finish(Some("not_started"));
            bail!("task control was requested before guest execution");
        }
        if authorize().is_err() {
            guard.finish(Some("not_started"));
            bail!("computer authorization was revoked before guest execution");
        }
        let mut child = match self.spawn_cli(&argv) {
            Ok(child) => child,
            Err(error) => {
                guard.finish(None);
                return Err(error);
            }
        };
        let started = Instant::now();
        let deadline = started + timeout;
        let mut next_authorization_check = started + POLL_INTERVAL;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let output = match child.finish(status).await {
                        Ok(output) => output,
                        Err(_) => {
                            let cleaned = self.kill_and_cleanup(task).await.is_ok();
                            guard.finish(cleaned.then_some("stopped"));
                            bail!("effect_unknown: bounded output collection failed");
                        }
                    };
                    let cleanup = self.cleanup_after_cli(task).await;
                    if output.overflow {
                        if cleanup.is_err() {
                            guard.finish(None);
                            bail!("effect_unknown: output limit exceeded and guest stop was not confirmed");
                        }
                        guard.finish(Some("stopped"));
                        bail!("effect_unknown: guest output exceeded the 64 KiB total limit");
                    }
                    if let Err(error) = cleanup {
                        guard.finish(None);
                        return Err(anyhow!("effect_unknown: stopped guest cleanup failed: {error}"));
                    }
                    guard.finish(Some("stopped"));
                    return Ok(serde_json::json!({
                        "execution_id": task.execution_id,
                        "container_name": task.container_name,
                        "state": "stopped",
                        "exit_code": output.status.code(),
                        "success": output.status.success(),
                        "stdout": into_output_text(output.stdout),
                        "stderr": into_output_text(output.stderr),
                    }));
                }
                Ok(None) => {}
                Err(_) => {
                    return self
                        .abort_run(
                            child,
                            task,
                            "kill",
                            "effect_unknown: container CLI process status was lost",
                            &mut guard,
                        )
                        .await;
                }
            }
            let control = self.runtime.control_request.load(Ordering::Acquire);
            if control != 0 {
                let (action, reason) = if control == 1 {
                    ("stop", "task stopped by computer control")
                } else {
                    ("kill", "task killed by computer control")
                };
                return self
                    .abort_run(child, task, action, reason, &mut guard)
                    .await;
            }
            if child.output_overflowed() {
                return self
                    .abort_run(
                        child,
                        task,
                        "kill",
                        "guest output exceeded the 64 KiB total limit",
                        &mut guard,
                    )
                    .await;
            }
            if Instant::now() >= deadline {
                return self
                    .abort_run(
                        child,
                        task,
                        "kill",
                        "guest execution timed out",
                        &mut guard,
                    )
                    .await;
            }
            if Instant::now() >= next_authorization_check {
                if authorize().is_err() {
                    return self
                        .abort_run(
                            child,
                            task,
                            "kill",
                            "computer authorization was revoked during guest execution",
                            &mut guard,
                        )
                        .await;
                }
                next_authorization_check = Instant::now() + POLL_INTERVAL;
            }
            sleep(POLL_INTERVAL).await;
        }
    }

    async fn abort_run(
        &self,
        child: RunningCli,
        task: &TaskContext,
        action: &str,
        reason: &str,
        guard: &mut RunGuard,
    ) -> Result<Value> {
        let cleanup = self.signal_and_cleanup(task, action).await;
        let reaped = child.reap(STOP_CONFIRM_TIMEOUT).await;
        if cleanup.is_ok() && reaped.is_ok() {
            guard.finish(Some("stopped"));
            bail!("effect_unknown: {reason}; guest stop was confirmed");
        }
        guard.finish(None);
        bail!("effect_unknown: {reason}; guest stop or CLI reap could not be confirmed");
    }

    async fn cleanup_after_cli(&self, task: &TaskContext) -> Result<()> {
        match self.inspect_task_state(task).await {
            Ok(state) if state == "stopped" => self.delete_stopped_task(task).await,
            _ => {
                self.kill_and_cleanup(task).await?;
                bail!("effect_unknown: container CLI exited before a stopped guest was confirmed")
            }
        }
    }

    async fn signal_and_cleanup(&self, task: &TaskContext, action: &str) -> Result<()> {
        let argv = match action {
            "stop" => vec![
                OsString::from("stop"),
                OsString::from("--time"),
                OsString::from("5"),
                OsString::from(task.container_name.as_str()),
            ],
            "kill" => vec![
                OsString::from("kill"),
                OsString::from(task.container_name.as_str()),
            ],
            _ => bail!("unsupported task lifecycle operation"),
        };
        let _ = self.run_cli(&argv, CLI_TIMEOUT).await;
        self.wait_until_stopped(task).await?;
        self.delete_stopped_task(task).await
    }

    async fn wait_until_stopped(&self, task: &TaskContext) -> Result<()> {
        let deadline = Instant::now() + STOP_CONFIRM_TIMEOUT;
        loop {
            if matches!(
                self.inspect_task_state(task).await,
                Ok(state) if state == "stopped"
            ) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                bail!("effect_unknown: task stop could not be confirmed");
            }
            sleep(POLL_INTERVAL).await;
        }
    }

    async fn inspect_task_state(&self, task: &TaskContext) -> Result<String> {
        let argv = [
            OsString::from("inspect"),
            OsString::from(task.container_name.as_str()),
        ];
        let output = self.run_cli(&argv, CLI_TIMEOUT).await?;
        ensure_cli_success(&output, "task inspection")?;
        parse_task_state(&output.stdout)
    }

    async fn delete_stopped_task(&self, task: &TaskContext) -> Result<()> {
        let argv = [
            OsString::from("delete"),
            OsString::from(task.container_name.as_str()),
        ];
        let output = self.run_cli(&argv, CLI_TIMEOUT).await?;
        ensure_cli_success(&output, "stopped task deletion")
    }

    async fn kill_and_cleanup(&self, task: &TaskContext) -> Result<()> {
        self.signal_and_cleanup(task, "kill").await
    }

    async fn control_task(&self, verb: &str) -> Result<Value> {
        let task = self.task_context()?;
        match verb {
            "inspect" => {
                if let Some(state) = self.runtime.last_state()? {
                    if state == "stopped" || state == "not_started" {
                        return Ok(serde_json::json!({
                            "container_name": task.container_name,
                            "state": "stopped",
                            "started": state != "not_started",
                        }));
                    }
                }
                let state = self.inspect_task_state(task).await?;
                Ok(serde_json::json!({
                    "container_name": task.container_name,
                    "state": state,
                }))
            }
            "stop" | "kill" => {
                let request = if verb == "stop" { 1 } else { 2 };
                if self.runtime.active.load(Ordering::Acquire) {
                    match self.runtime.control_request.compare_exchange(
                        0,
                        request,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    ) {
                        Ok(_) => self.runtime.finished.notify_waiters(),
                        Err(existing) if existing == request => {}
                        Err(_) => bail!("a conflicting task lifecycle request is already active"),
                    }
                    self.wait_for_runtime().await?;
                    let state = self.runtime.last_state()?.unwrap_or_default();
                    if state == "stopped" || state == "not_started" {
                        return Ok(serde_json::json!({
                            "container_name": task.container_name,
                            "state": "stopped",
                            "started": state != "not_started",
                        }));
                    }
                    bail!("effect_unknown: task lifecycle request did not reach a confirmed stopped state");
                }
                let last_state = self.runtime.last_state()?;
                if matches!(last_state.as_deref(), Some("stopped" | "not_started")) {
                    let started = last_state.as_deref() != Some("not_started");
                    return Ok(serde_json::json!({
                        "container_name": task.container_name,
                        "state": "stopped",
                        "started": started,
                    }));
                }
                self.runtime.begin_control()?;
                let mut guard = RunGuard::new(self.runtime.clone(), &self.cli_path, task);
                let result = match self.inspect_task_state(task).await {
                    Ok(state) if state == "stopped" => self.delete_stopped_task(task).await,
                    _ => self.signal_and_cleanup(task, verb).await,
                };
                if let Err(error) = result {
                    guard.finish(None);
                    return Err(error);
                }
                guard.finish(Some("stopped"));
                Ok(serde_json::json!({
                    "container_name": task.container_name,
                    "state": "stopped",
                    "action": verb,
                    "started": true,
                }))
            }
            _ => bail!("Apple container supports only inspect, stop, and kill task control"),
        }
    }

    async fn wait_for_runtime(&self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if !self.runtime.active.load(Ordering::Acquire) {
                return Ok(());
            }
            let notified = self.runtime.finished.notified();
            if !self.runtime.active.load(Ordering::Acquire) {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || timeout(remaining, notified).await.is_err() {
                bail!("effect_unknown: task supervisor did not confirm lifecycle completion");
            }
        }
    }
}

impl ComputerBackend for AppleContainerBackend {
    fn identity(&self) -> &'static str {
        "apple-container"
    }

    fn capabilities(&self) -> ComputerCapabilities {
        ComputerCapabilities {
            browser: false,
            shell: self.task.is_some(),
            human_control: false,
            persistent_filesystem: self.task.is_some(),
        }
    }

    fn configured(&self) -> bool {
        self.available && self.task.is_some()
    }

    fn execute<'a>(
        &'a self,
        _owner: &'a str,
        operation: ComputerOperation,
        authorize: Authorize<'a>,
    ) -> ComputerFuture<'a, Result<Value>> {
        Box::pin(async move {
            if !self.available {
                bail!("Apple container API server is unavailable");
            }
            match operation {
                ComputerOperation::Shell {
                    command,
                    timeout_ms,
                } => self.execute_shell(&command, timeout_ms, authorize).await,
                ComputerOperation::Browser(_) => {
                    bail!("Apple container backend does not provide browser capability")
                }
            }
        })
    }

    fn control<'a>(&'a self, _owner: &'a str, verb: &'a str) -> ComputerFuture<'a, Result<Value>> {
        Box::pin(async move {
            if !self.available {
                bail!("Apple container API server is unavailable");
            }
            self.control_task(verb).await
        })
    }
}

/// Parse bounded stdout/stderr without echoing arbitrary CLI output into a
/// durable response. The service-unavailable classification matches the
/// installed 1.4.1 status output observed for this workstation.
pub fn parse_cli_result(
    exit_code: i32,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<AppleCliOutcome> {
    if stdout.len().saturating_add(stderr.len()) > APPLE_CONTAINER_OUTPUT_LIMIT {
        bail!("Apple container CLI output exceeded 64 KiB");
    }
    if exit_code == 0 {
        return Ok(AppleCliOutcome::Success);
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    )
    .to_ascii_lowercase();
    if text.contains("apiserver is not running and not registered with launchd") {
        return Ok(AppleCliOutcome::ServiceUnavailable);
    }
    Ok(AppleCliOutcome::Failed)
}

impl TaskContext {
    fn new(
        manifest: &HomeManifest,
        execution_id: &str,
        image_ref: &str,
        guest_uid: u32,
        guest_gid: u32,
    ) -> Result<Self> {
        if !valid_component(execution_id) {
            bail!("execution ID is not a safe task-snapshot component");
        }
        if image_ref != PINNED_TASK_IMAGE || !is_pinned_image(image_ref) {
            bail!("Apple container task image is not the D2 pinned digest");
        }
        if guest_uid == 0 || guest_gid == 0 {
            bail!("Apple container guest UID and GID must be explicitly non-root");
        }
        let snapshot = resolve_task_snapshot(manifest, execution_id)?;
        let container_name = task_container_name(&snapshot, execution_id)?;
        Ok(Self {
            manifest: manifest.clone(),
            execution_id: execution_id.to_owned(),
            image_ref: image_ref.to_owned(),
            guest_uid,
            guest_gid,
            container_name,
            verification_only: false,
            producer_profile: None,
            producer_cli_sha256: None,
        })
    }

    // Private bootstrap for the accepted producer constructor and fixed probe
    // only. The public legacy constructor above retains its exact image gate.
    fn producer(manifest: &HomeManifest, execution_id: &str, profile: &ProducerProfileManifest,
        guest_uid: u32, guest_gid: u32) -> Result<Self> {
        profile.validate()?;
        let mut task = Self::new(manifest, execution_id, PINNED_TASK_IMAGE, guest_uid, guest_gid)?;
        task.image_ref = profile.image_ref.clone();
        task.producer_profile = Some(profile.clone());
        Ok(task)
    }

    fn snapshot(&self) -> Result<PathBuf> {
        let snapshot = resolve_task_snapshot(&self.manifest, &self.execution_id)?;
        if task_container_name(&snapshot, &self.execution_id)? != self.container_name {
            bail!("task container name no longer matches its rooted task context");
        }
        Ok(snapshot)
    }

    fn run_argv(&self, snapshot: &Path, command: &str) -> Result<Vec<OsString>> {
        let profile = self.producer_profile.as_ref();
        if self.verification_only && profile.is_some() { bail!("Producer profile cannot enter the independent verifier route"); }
        let source = snapshot
            .to_str()
            .ok_or_else(|| anyhow!("task snapshot path is not UTF-8"))?;
        if source.contains(',') {
            bail!("task snapshot path cannot be represented by Apple container --mount");
        }
        let mut argv=vec![
            OsString::from("run"),
            OsString::from("--name"),
            OsString::from(self.container_name.as_str()),
            OsString::from("--os"),
            OsString::from(profile.map(|p| p.os.as_str()).unwrap_or(TASK_GUEST_OS)),
            OsString::from("--arch"),
            OsString::from(profile.map(|p| p.architecture.as_str()).unwrap_or(TASK_GUEST_ARCH)),
            OsString::from("--uid"),
            OsString::from(self.guest_uid.to_string()),
            OsString::from("--gid"),
            OsString::from(self.guest_gid.to_string()),
            OsString::from("--cap-drop"),
            OsString::from("ALL"),
        ];
        if profile.map(|p| p.isolation.root_read_only).unwrap_or(TASK_ROOT_READ_ONLY) {argv.push(OsString::from("--read-only"));}
        argv.extend([
            OsString::from("--no-dns"),
            OsString::from("--network"),
            OsString::from(profile.map(|p| p.isolation.network.as_str()).unwrap_or(TASK_NETWORK)),
            OsString::from("--cpus"),
            OsString::from(profile.map(|p| p.isolation.cpus).unwrap_or(1).to_string()),
            OsString::from("--memory"),
            OsString::from(format!("{}m", profile.map(|p| p.isolation.memory_mib).unwrap_or(256))),
            OsString::from("--init"),
            OsString::from("--workdir"),
            OsString::from(if self.verification_only {"/tmp"}else{profile.map(|p| p.isolation.cwd.as_str()).unwrap_or(PRODUCER_WORK_MOUNT)}),
            OsString::from("--mount"),
            OsString::from(format!(
                "type=bind,source={source},target={}{}",if self.verification_only {"/inputs"}else{profile.map(|p| p.isolation.work_mount.as_str()).unwrap_or(PRODUCER_WORK_MOUNT)},if self.verification_only || !profile.map(|p| p.isolation.work_writable).unwrap_or(PRODUCER_WORK_WRITABLE) {",readonly"}else{""}
            )),
            OsString::from(self.image_ref.as_str()),
            OsString::from(profile.map(|p| p.shell.program.as_str()).unwrap_or(TASK_SHELL)),
            OsString::from(profile.map(|p| p.shell.args[0].as_str()).unwrap_or(TASK_SHELL_ARGUMENT)),
            OsString::from(command),
        ]);
        if self.verification_only || PRODUCER_TMPFS_TMP {argv.splice(1..1,[OsString::from("--tmpfs"),OsString::from("/tmp")]);}
        // The new producer route retains strict empty-stderr receipts. Disable
        // CLI progress at its source for both the fixed probe and Work shell.
        // Legacy producer/verifier argv remains byte-for-byte unchanged.
        if profile.is_some() {argv.splice(1..1,[OsString::from("--progress"),OsString::from("none")]);}
        Ok(argv)
    }
}

#[derive(Clone, Copy)]
enum ProbeCliIdentity { Matched, Changed, Unavailable }
impl ProbeCliIdentity {
    fn code(self) -> &'static str {
        match self { Self::Matched => "matched", Self::Changed => "changed", Self::Unavailable => "unavailable" }
    }
}

#[derive(Debug)]
struct ProducerProbeRejection { diagnostic: Value }
impl std::fmt::Display for ProducerProbeRejection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Producer fixed JSON probe rejected: {}", self.diagnostic)
    }
}
impl std::error::Error for ProducerProbeRejection {}

fn producer_probe_rejection(code: &'static str, result: &Value, cli_identity: ProbeCliIdentity) -> anyhow::Error {
    // Only the fixed probe reaches this path: no Owner task input, credentials,
    // model command or arbitrary result object is included. Preserve its actual
    // output under the same combined cap used by the original CLI collector.
    let mut remaining = APPLE_CONTAINER_OUTPUT_LIMIT;
    let mut capture = |field: &str| -> (Option<String>, bool) {
        let Some(text) = result[field].as_str() else { return (None, false); };
        let mut end = text.len().min(remaining);
        while !text.is_char_boundary(end) { end -= 1; }
        remaining -= end;
        (Some(text[..end].to_owned()), end != text.len())
    };
    let (stdout, stdout_truncated) = capture("stdout");
    let (stderr, stderr_truncated) = capture("stderr");
    ProducerProbeRejection { diagnostic: serde_json::json!({
        "kind":"ghost-producer-probe-diagnostic/1", "code":code, "cli_identity":cli_identity.code(),
        "result":{"state":result["state"].as_str(),"exit_code":result["exit_code"].as_i64(),"success":result["success"].as_bool(),
            "stdout":stdout,"stderr":stderr,"stdout_truncated":stdout_truncated,"stderr_truncated":stderr_truncated}
    }) }.into()
}

fn producer_probe_observation(result: &Value, cli_identity: ProbeCliIdentity) -> Result<ProducerRuntimeObservation> {
    let reject = |code| producer_probe_rejection(code, result, cli_identity);
    if result["state"] != "stopped" || result["exit_code"] != 0 || result["success"] != true {
        return Err(reject("execution_unsuccessful"));
    }
    match cli_identity {
        ProbeCliIdentity::Changed => return Err(reject("cli_identity_changed")),
        ProbeCliIdentity::Unavailable => return Err(reject("cli_identity_unavailable")),
        ProbeCliIdentity::Matched => {}
    }
    match result["stderr"].as_str() {
        Some("") => {}
        Some(_) => return Err(reject("stderr_nonempty")),
        None => return Err(reject("stderr_invalid")),
    }
    let stdout = result["stdout"].as_str().ok_or_else(|| reject("stdout_invalid"))?;
    serde_json::from_str(stdout).map_err(|_| reject("observation_invalid"))
}

fn producer_cli_sha256(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path.canonicalize()?)?;
    if !file.metadata()?.is_file() { bail!("Producer CLI must be a regular executable file"); }
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break; }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn resolve_task_snapshot(manifest: &HomeManifest, execution_id: &str) -> Result<PathBuf> {
    if !valid_component(execution_id) {
        bail!("execution ID is not a safe task-snapshot component");
    }
    let snapshot_root = validate_manifest(manifest)?;
    let snapshot = manifest.task_snapshot_root.join(execution_id);
    let metadata = std::fs::symlink_metadata(&snapshot)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("task snapshot must be a real directory");
    }
    let snapshot = snapshot.canonicalize()?;
    if !snapshot.starts_with(&snapshot_root) {
        bail!("task snapshot escaped its rooted manifest");
    }
    let source = snapshot
        .to_str()
        .ok_or_else(|| anyhow!("task snapshot path is not UTF-8"))?;
    if source.contains(',') {
        bail!("task snapshot path cannot be represented by Apple container --mount");
    }
    Ok(snapshot)
}

fn task_container_name(snapshot: &Path, execution_id: &str) -> Result<String> {
    let snapshot = snapshot
        .to_str()
        .ok_or_else(|| anyhow!("task snapshot path is not UTF-8"))?;
    let mut digest = Sha256::new();
    digest.update(b"ghost-lifetime-container-v1\0");
    digest.update(snapshot.as_bytes());
    digest.update([0]);
    digest.update(execution_id.as_bytes());
    // Full SHA-256 names exceed the installed CLI's container-ID bound.
    let digest = digest.finalize();
    let mut name = String::with_capacity(47);
    name.push_str("ghost-lifetime-");
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in &digest[..16] {
        name.push(HEX[(byte >> 4) as usize] as char);
        name.push(HEX[(byte & 15) as usize] as char);
    }
    Ok(name)
}

async fn read_bounded<R>(
    mut reader: R,
    budget: Arc<AtomicUsize>,
    overflow: Arc<AtomicBool>,
) -> Result<Vec<u8>>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            return Ok(output);
        }
        let captured = reserve_output(&budget, count);
        if captured != count {
            overflow.store(true, Ordering::Release);
        }
        output.extend_from_slice(&buffer[..captured]);
    }
}

fn reserve_output(budget: &AtomicUsize, requested: usize) -> usize {
    loop {
        let used = budget.load(Ordering::Acquire);
        let captured = requested.min(APPLE_CONTAINER_OUTPUT_LIMIT.saturating_sub(used));
        if budget
            .compare_exchange_weak(
                used,
                used + captured,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
        {
            return captured;
        }
    }
}

fn into_output_text(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|error| String::from_utf8_lossy(&error.into_bytes()).into_owned())
}

fn ensure_cli_success(output: &CliOutput, operation: &str) -> Result<()> {
    if output.overflow {
        bail!("Apple container {operation} output exceeded 64 KiB");
    }
    if !output.status.success() {
        bail!("Apple container {operation} failed");
    }
    Ok(())
}

fn parse_task_state(stdout: &[u8]) -> Result<String> {
    if stdout.len() > APPLE_CONTAINER_OUTPUT_LIMIT {
        bail!("Apple container inspect output exceeded 64 KiB");
    }
    let value: Value = serde_json::from_slice(stdout)
        .map_err(|_| anyhow!("Apple container inspect output was not valid JSON"))?;
    let records = value
        .as_array()
        .ok_or_else(|| anyhow!("Apple container inspect output was not a JSON array"))?;
    if records.len() != 1 {
        bail!("Apple container inspect did not return exactly one task");
    }
    let record = &records[0];
    record
        .pointer("/configuration/id")
        .and_then(Value::as_str)
        .filter(|identifier| !identifier.is_empty())
        .ok_or_else(|| anyhow!("Apple container inspect omitted the task identifier"))?;
    let state = record
        .pointer("/status/state")
        .and_then(Value::as_str)
        .filter(|state| !state.is_empty())
        .ok_or_else(|| anyhow!("Apple container inspect omitted the task state"))?;
    Ok(state.to_owned())
}

fn validate_manifest(manifest: &HomeManifest) -> Result<PathBuf> {
    if manifest.credential_broker.is_some() {
        bail!("Apple container D1 does not mount a credential broker");
    }
    let home = canonical_directory(&manifest.home_volume)?;
    let tasks = canonical_directory(&manifest.task_snapshot_root)?;
    let browser = canonical_directory(&manifest.browser_profile)?;
    let task_parent = tasks
        .parent()
        .ok_or_else(|| anyhow!("task snapshot root has no computer parent"))?;
    if home.parent() != Some(task_parent)
        || browser.parent() != Some(task_parent)
        || home == tasks
        || home == browser
        || tasks == browser
    {
        bail!("home, task snapshots, and browser profile must be separate rooted siblings");
    }
    Ok(tasks)
}

fn canonical_directory(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("computer manifest paths must be absolute");
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("computer manifest path must be a real directory");
    }
    let canonical = path.canonicalize()?;
    if canonical.as_path() != path {
        bail!("computer manifest path contains a symlink or noncanonical component");
    }
    Ok(canonical)
}

fn is_pinned_image(image_ref: &str) -> bool {
    if image_ref.len() > 512
        || image_ref.chars().any(|character| character.is_whitespace())
        || image_ref.contains('\0')
    {
        return false;
    }
    let Some((name, digest)) = image_ref.rsplit_once("@sha256:") else {
        return false;
    };
    !name.is_empty()
        && !name.starts_with('-')
        && !name.contains('@')
        && digest.len() == 64
        && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_network_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 180
        && value != "."
        && value != ".."
        && !value.starts_with('.')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn ensure_supported_host() -> Result<()> {
    let version = StdCommand::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .stdin(Stdio::null())
        .output()?;
    if !version.status.success() {
        bail!("could not read the macOS product version");
    }
    let version_text = std::str::from_utf8(&version.stdout)?.trim();
    let major = version_text
        .split('.')
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| anyhow!("macOS product version output was unrecognized"))?;
    if major < MINIMUM_MACOS_MAJOR {
        bail!("Apple container requires macOS 26 or newer");
    }
    Ok(())
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn ensure_supported_host() -> Result<()> {
    bail!("Apple container requires macOS on Apple silicon")
}


#[cfg(test)]
mod configured_environment_tests {
    use super::*;
    fn task(verification_only:bool)->TaskContext {
        TaskContext {manifest:HomeManifest{home_volume:"/host-only/home".into(),task_snapshot_root:"/host-only/tasks".into(),browser_profile:"/host-only/browser".into(),credential_broker:Some("secret-broker-marker".into())},execution_id:"fixture-execution".into(),image_ref:PINNED_TASK_IMAGE.into(),guest_uid:501,guest_gid:20,container_name:"fixture-container".into(),verification_only,producer_profile:None,producer_cli_sha256:None}
    }
    fn argv(verification_only:bool)->Vec<String> {
        task(verification_only).run_argv(Path::new("/host-only/selected"),"printf fixture").unwrap().into_iter().map(|arg|arg.into_string().unwrap()).collect()
    }
    #[test]
    fn configured_producer_environment_matches_actual_task_argv_without_inventory_claims() {
        let descriptor=AppleContainerBackend::configured_producer_environment();let args=argv(false);
        let option=|name:&str|args[args.iter().position(|value|value==name).unwrap()+1].clone();
        assert_eq!(descriptor["evidence"],"configured_policy");assert_eq!(descriptor["image_ref"],PINNED_TASK_IMAGE);
        assert_eq!(descriptor["os"],option("--os"));assert_eq!(descriptor["architecture"],option("--arch"));assert_eq!(descriptor["cwd"],option("--workdir"));assert_eq!(descriptor["network"],option("--network"));
        assert_eq!(descriptor["filesystem"]["root_read_only"],args.iter().any(|arg|arg=="--read-only"));
        assert_eq!(descriptor["filesystem"]["work_mount"]["target"],"/workspace");assert_eq!(descriptor["filesystem"]["work_mount"]["writable"],true);
        assert_eq!(option("--mount"),"type=bind,source=/host-only/selected,target=/workspace");
        assert_eq!(descriptor["filesystem"]["tmpfs_mounts"],serde_json::json!([]));assert!(!args.iter().any(|arg|arg=="--tmpfs"));
        assert_eq!(args[args.len()-3],descriptor["shell"]["program"].as_str().unwrap());assert_eq!(args[args.len()-2],descriptor["shell"]["args"][0].as_str().unwrap());
        let encoded=descriptor.to_string();for forbidden in ["/host-only","secret-broker-marker","python","perl","languages","packages","available","healthy"] {assert!(!encoded.contains(forbidden));}
    }
    #[test]
    fn verifier_task_argv_remains_distinct_from_the_producer_policy() {
        let expected=vec!["run","--tmpfs","/tmp","--name","fixture-container","--os","linux","--arch","arm64","--uid","501","--gid","20","--cap-drop","ALL","--read-only","--no-dns","--network","none","--cpus","1","--memory","256m","--init","--workdir","/tmp","--mount","type=bind,source=/host-only/selected,target=/inputs,readonly",PINNED_TASK_IMAGE,"/bin/sh","-lc","printf fixture"];
        assert_eq!(argv(true),expected);
        let producer=AppleContainerBackend::configured_producer_environment();assert_eq!(producer["cwd"],"/workspace");assert_eq!(producer["filesystem"]["tmpfs_mounts"],serde_json::json!([]));
    }

    #[test]
    fn accepted_producer_profile_and_actual_argv_share_one_plan_without_changing_legacy_verifier() {
        let accepted = super::super::producer_profile::fixture_accepted_producer_profile();
        let mut selected = task(false);
        selected.image_ref = accepted.manifest().image_ref.clone();
        selected.producer_profile = Some(accepted.manifest().clone());
        selected.producer_cli_sha256 = Some(accepted.runtime_facts().container_cli_sha256.clone());
        let actual: Vec<_> = selected.run_argv(Path::new("/host-only/selected"), "printf fixture").unwrap()
            .into_iter().map(|arg| arg.into_string().unwrap()).collect();
        let mut expected = argv(false);
        assert!(!expected.iter().any(|argument| argument == "--progress"));
        assert!(!argv(true).iter().any(|argument| argument == "--progress"));
        let image = expected.iter().position(|value| value == PINNED_TASK_IMAGE).unwrap();
        expected[image] = accepted.manifest().image_ref.clone();
        expected.splice(1..1, ["--progress".into(), "none".into()]);
        assert_eq!(actual, expected, "only the accepted image and progress transport change; all prior sandbox argv stays exact");
        assert_eq!(&actual[1..3], &["--progress", "none"]);
        let environment = accepted.environment();
        let option = |name: &str| actual[actual.iter().position(|value| value == name).unwrap() + 1].clone();
        assert_eq!(environment["image_ref"], actual[image + 2]);
        assert_eq!(environment["os"], option("--os")); assert_eq!(environment["architecture"], option("--arch"));
        assert_eq!(environment["cwd"], option("--workdir")); assert_eq!(environment["network"], option("--network"));
        assert_eq!(environment["json_runtime"]["interpreter"], "/usr/local/bin/python3");
        assert_eq!(environment["evidence"], "controlled_fixture");
        assert_eq!(environment["backend"], "fixture"); assert_eq!(environment["simulated"], true);
        assert_eq!(environment["filesystem"]["tmpfs_mounts"], serde_json::json!([]));
        assert!(!environment.to_string().contains("/host-only"));
        assert!(TaskContext::new(&selected.manifest, "valid", &accepted.manifest().image_ref, 501, 20).is_err(), "legacy constructor must retain its fixed image gate");
        selected.verification_only = true;
        assert!(selected.run_argv(Path::new("/host-only/selected"), "printf fixture").is_err());
        verifier_task_argv_remains_distinct_from_the_producer_policy();
    }

    #[test]
    fn fixed_producer_probe_rejections_preserve_original_bounded_output_and_distinguish_causes() {
        let accepted = super::super::producer_profile::fixture_accepted_producer_profile();
        let observation = &accepted.runtime_facts().observation;
        let good = serde_json::json!({"state":"stopped","exit_code":0,"success":true,
            "stdout":serde_json::to_string(observation).unwrap(),"stderr":""});
        assert_eq!(producer_probe_observation(&good, ProbeCliIdentity::Matched).unwrap(), *observation);
        for (identity, stderr, expected) in [
            (ProbeCliIdentity::Changed, "original CLI warning", "cli_identity_changed"),
            (ProbeCliIdentity::Unavailable, "original CLI warning", "cli_identity_unavailable"),
            (ProbeCliIdentity::Matched, "original CLI warning", "stderr_nonempty"),
        ] {
            let mut original = good.clone(); original["stderr"] = serde_json::json!(stderr);
            let error = producer_probe_observation(&original, identity).unwrap_err();
            let diagnostic = &error.downcast_ref::<ProducerProbeRejection>().unwrap().diagnostic;
            assert_eq!(diagnostic["code"], expected);
            assert_eq!(diagnostic["cli_identity"], identity.code());
            assert_eq!(diagnostic["result"]["stdout"], original["stdout"]);
            assert_eq!(diagnostic["result"]["stderr"], original["stderr"]);
            assert_eq!(diagnostic["result"]["stdout_truncated"], false);
            assert_eq!(diagnostic["result"]["stderr_truncated"], false);
        }
        let mut malformed = good.clone(); malformed["stdout"] = serde_json::json!("original non-JSON probe output");
        let error = producer_probe_observation(&malformed, ProbeCliIdentity::Matched).unwrap_err();
        let diagnostic = &error.downcast_ref::<ProducerProbeRejection>().unwrap().diagnostic;
        assert_eq!(diagnostic["code"], "observation_invalid");
        assert_eq!(diagnostic["result"]["stdout"], malformed["stdout"]);
        let mut oversized = good; oversized["stdout"] = serde_json::json!("λ".repeat(APPLE_CONTAINER_OUTPUT_LIMIT));
        let error = producer_probe_observation(&oversized, ProbeCliIdentity::Matched).unwrap_err();
        let diagnostic = &error.downcast_ref::<ProducerProbeRejection>().unwrap().diagnostic;
        assert_eq!(diagnostic["result"]["stdout"].as_str().unwrap().len(), APPLE_CONTAINER_OUTPUT_LIMIT);
        assert_eq!(diagnostic["result"]["stdout_truncated"], true);
    }

    #[cfg(all(feature = "lifetime", target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "explicit cached-reference producer probe; no image-pull command, service or default changes"]
    async fn real_owner_producer_profile_fixed_json_probe_writes_genuine_receipt() -> Result<()> {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        use std::io::Write;
        if std::env::var("GHOST_PRODUCER_PROFILE_PROBE").as_deref() != Ok("1") {
            bail!("Explicit fixed producer probe opt-in required");
        }
        let receipt = PathBuf::from(std::env::var_os("GHOST_PRODUCER_PROFILE_PROBE_RECEIPT")
            .ok_or_else(|| anyhow!("Absolute disposable receipt path required"))?);
        if !receipt.is_absolute() || receipt.exists() || !receipt.parent().is_some_and(Path::is_dir) {
            bail!("Probe receipt must be a new absolute file in an existing disposable directory");
        }
        let cli = std::env::var_os("GHOST_PRODUCER_PROFILE_PROBE_CLI").map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/opt/homebrew/bin/container"));
        let retained = tempfile::Builder::new().prefix("ghost-fixed-producer-probe-").tempdir()?.keep().canonicalize()?;
        for name in ["home", "tasks", "browser"] {
            let path = retained.join(name); std::fs::create_dir(&path)?; std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        }
        let execution = format!("{:x}", Sha256::digest(retained.to_string_lossy().as_bytes()));
        let snapshot = retained.join("tasks").join(&execution); std::fs::create_dir(&snapshot)?;
        std::fs::set_permissions(&snapshot, std::fs::Permissions::from_mode(0o700))?;
        let home = HomeManifest { home_volume: retained.join("home"), task_snapshot_root: retained.join("tasks"),
            browser_profile: retained.join("browser"), credential_broker: None };
        let profile = ProducerProfileManifest {
            kind: "ghost-producer-profile/1".into(), profile_id: "python-stdlib".into(), revision: 1,
            image_ref: "docker.io/library/python@sha256:016508ba505da24f7139765bc4bb669df4e88eb2f12eeadd571bf2f88d7533df".into(),
            platform_manifest_digest: "sha256:067d97da25897fa5342cdbef0eeb6a50a527faa965696c7bfa0a3b576ce65c8a".into(),
            image_config_digest: "sha256:c3ac8543171364d1e007f8e053d221c35c72ed2773b46eb2b423b0167f9c2da9".into(),
            os: "linux".into(), architecture: "arm64".into(), platform_variant: "v8".into(),
            shell: super::super::producer_profile::ProducerShell { program: "/bin/sh".into(), args: vec!["-lc".into()] },
            isolation: Default::default(), json_runtime: super::super::producer_profile::ProducerJsonRuntime {
                kind: "python-stdlib/1".into(), interpreter: "/usr/local/bin/python3".into() },
        };
        println!("producer_profile_probe_root={} execution={}", retained.display(), execution);
        let facts = AppleContainerBackend::probe_producer_profile(&cli, &home, &execution, &profile,
            unsafe { libc::geteuid() }, unsafe { libc::getegid() }, &|| Ok(())).await?;
        let encoded = serde_json::to_vec_pretty(&serde_json::json!({"manifest":profile,"runtime_facts":facts}))?;
        let mut output = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&receipt)?;
        output.write_all(&encoded)?; output.sync_all()?;
        println!("producer_profile_probe_receipt={}", receipt.display());
        Ok(())
    }
}
