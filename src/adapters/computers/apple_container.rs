use super::registry::HomeManifest;
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
        let image_args = [
            OsString::from("image"),
            OsString::from("inspect"),
            OsString::from(task.image_ref.as_str()),
        ];
        let image = self.run_cli(&image_args, CLI_TIMEOUT).await?;
        ensure_cli_success(&image, "pinned image inspection")?;

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
        })
    }

    fn snapshot(&self) -> Result<PathBuf> {
        let snapshot = resolve_task_snapshot(&self.manifest, &self.execution_id)?;
        if task_container_name(&snapshot, &self.execution_id)? != self.container_name {
            bail!("task container name no longer matches its rooted task context");
        }
        Ok(snapshot)
    }

    fn run_argv(&self, snapshot: &Path, command: &str) -> Result<Vec<OsString>> {
        let source = snapshot
            .to_str()
            .ok_or_else(|| anyhow!("task snapshot path is not UTF-8"))?;
        if source.contains(',') {
            bail!("task snapshot path cannot be represented by Apple container --mount");
        }
        Ok(vec![
            OsString::from("run"),
            OsString::from("--name"),
            OsString::from(self.container_name.as_str()),
            OsString::from("--os"),
            OsString::from("linux"),
            OsString::from("--arch"),
            OsString::from("arm64"),
            OsString::from("--uid"),
            OsString::from(self.guest_uid.to_string()),
            OsString::from("--gid"),
            OsString::from(self.guest_gid.to_string()),
            OsString::from("--cap-drop"),
            OsString::from("ALL"),
            OsString::from("--read-only"),
            OsString::from("--no-dns"),
            OsString::from("--network"),
            OsString::from("none"),
            OsString::from("--cpus"),
            OsString::from("1"),
            OsString::from("--memory"),
            OsString::from("256m"),
            OsString::from("--init"),
            OsString::from("--workdir"),
            OsString::from("/workspace"),
            OsString::from("--mount"),
            OsString::from(format!(
                "type=bind,source={source},target=/workspace"
            )),
            OsString::from(self.image_ref.as_str()),
            OsString::from("/bin/sh"),
            OsString::from("-lc"),
            OsString::from(command),
        ])
    }
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
