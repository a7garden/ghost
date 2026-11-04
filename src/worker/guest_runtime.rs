use crate::computers::PINNED_TASK_IMAGE;
use super::native_tools::is_exact_worker_tool_scope;
use crate::worker::guest_broker::{
    GuestBrokerAuthorizationCheck, GuestBrokerConfig, GuestBrokerError, GuestModelBackend, GuestModelBroker,
};
use crate::worker::subscription_bridge::SubscriptionReady;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const CONTRACT_VERSION: u32 = 1;
const OMP_VERSION: &str = "18.8.6";
const BUN_VERSION: &str = "1.4.2";
const GUEST_UID: &str = "501";
const GUEST_GID: &str = "20";
const GUEST_SESSION_PATH: &str = "/session";
const GUEST_WORKSPACE_PATH: &str = "/workspace";
const GUEST_HOME_PATH: &str = "/home/ghost";
const GUEST_REQUEST_PATH: &str = "/requests";
const GUEST_RESPONSE_PATH: &str = "/responses";
const CONTROL_CONFIG_NAME: &str = "model.json";
const RESERVATION_NAME: &str = "launch-reservation.jsonl";
const MAX_OVERLAY_BYTES: usize = 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_SOURCE_FILE_BYTES: usize = 1024 * 1024;
const MAX_GUEST_CONFIG_BYTES: usize = 16 * 1024;
const MAX_CLI_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_RESERVATION_BYTES: u64 = 4096;
const CLI_POLL_INTERVAL: Duration = Duration::from_millis(25);
const CLI_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const CONTAINER_STOP_SECONDS: &str = "180";
const CONTAINER_STOP_TIMEOUT: Duration = Duration::from_secs(185);
const CONTAINER_QUERY_TIMEOUT: Duration = Duration::from_secs(10);
const CONTAINER_START_TIMEOUT: Duration = Duration::from_secs(30);
const CONTAINER_START_POLL_INTERVAL: Duration = Duration::from_millis(100);
const PRIVATE_CLI_PATH: &str = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const SOURCE_FILES: [&str; 6] = ["scoped-rpc.ts", "guest-model.ts", "completion-codec.mjs",
    "guest-broker-client.ts", "subscription-guest-model.ts", "native-tool-policy.ts"];

pub type GuestRuntimeResult<T> = Result<T, GuestRuntimeError>;

pub struct GuestRuntimeConfig {
    pub container_cli: PathBuf,
    pub linux_runtime_root: PathBuf,
    pub source_directory: PathBuf,
    pub overlay_file: PathBuf,
    pub session_directory: PathBuf,
    pub workspace_directory: PathBuf,
    pub home_directory: PathBuf,
    pub control_directory: PathBuf,
    /// Optional prepared pinned-skill snapshot (`<name>/SKILL.md` entries).
    /// Staged into the guest home and advertised through
    /// `GHOST_WORKER_SKILLS_MANIFEST`; absent keeps the session `skills: []`
    /// exactly as the historical native proof requires.
    pub skills_snapshot: Option<PathBuf>,
    pub broker: Arc<GuestBrokerConfig>,
}

pub struct GuestLaunch {
    pub child: Child,
    pub lease: GuestRuntimeLease,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuestRuntimeError {
    Retired,
    InvalidConfig,
    Unauthorized,
    ContainerProbe,
    PinnedImageUnavailable,
    ContainerNameConflict,
    Reservation,
    Broker(GuestBrokerError),
    Launch,
    CleanupUnknown,
    CliOutput,
    CliTimeout,
}
impl fmt::Display for GuestRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Retired => formatter.write_str("legacy_execution_retired: Guest OMP reasoning admission is retired"),
            Self::InvalidConfig => formatter.write_str("guest runtime configuration rejected"),
            Self::Unauthorized => formatter.write_str("guest runtime authority check failed"),
            Self::ContainerProbe => formatter.write_str("Apple Container CLI operation failed"),
            Self::PinnedImageUnavailable => {
                formatter.write_str("pinned guest runtime image is not available locally")
            }
            Self::ContainerNameConflict => formatter.write_str("guest runtime name is already in use"),
            Self::Reservation => formatter.write_str("guest runtime launch reservation failed"),
            Self::Broker(error) => write!(formatter, "guest model broker failed: {error}"),
            Self::Launch => formatter.write_str("guest runtime launch failed"),
            Self::CleanupUnknown => formatter.write_str("guest runtime cleanup is effect_unknown"),
            Self::CliOutput => formatter.write_str("Apple Container CLI output exceeded its limit"),
            Self::CliTimeout => formatter.write_str("Apple Container CLI operation timed out"),
        }
    }
}

impl std::error::Error for GuestRuntimeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Broker(error) => Some(error),
            _ => None,
        }
    }
}

pub struct GuestRuntimeLease {
    container_cli: PathBuf,
    container_name: String,
    reservation_path: PathBuf,
    revoked: Arc<AtomicBool>,
    broker: Option<GuestModelBroker>,
    cleanup_attempted: bool,
    cleanup_result: Option<GuestRuntimeResult<()>>,
}

impl GuestRuntimeLease {
    pub fn container_name(&self) -> &str {
        &self.container_name
    }

    pub fn guest_session_directory(&self) -> &Path {
        Path::new(GUEST_SESSION_PATH)
    }

    pub fn stop(&mut self) -> GuestRuntimeResult<()> {
        if self.cleanup_attempted {
            return self.cleanup_result.unwrap_or(Ok(()));
        }
        self.cleanup_attempted = true;
        self.revoked.store(true, Ordering::Release);

        let broker_result = match self.broker.take() {
            Some(mut broker) => broker.stop().map_err(GuestRuntimeError::Broker),
            None => Ok(()),
        };
        let container_result = stop_exact_container(&self.container_cli, &self.container_name);
        let mut result = if container_result.is_ok() && broker_result.is_ok() {
            Ok(())
        } else {
            Err(GuestRuntimeError::CleanupUnknown)
        };
        let state = if result.is_ok() { "stopped" } else { "effect_unknown" };
        if record_reservation_event(&self.reservation_path, state).is_err() {
            result = Err(GuestRuntimeError::CleanupUnknown);
        }
        self.cleanup_result = Some(result);
        result
    }
}

impl Drop for GuestRuntimeLease {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[derive(Serialize)]
struct GuestModelConfig<'a> {
    version: u32,
    execution_id: &'a str,
    authority_epoch: u64,
    request_directory: &'static str,
    response_directory: &'static str,
    model_id: &'a str,
    max_tokens: u32,
    context_window: u32,
    allowed_tools: &'a [String],
    deadline_ms: u64,
    max_requests: u32,
}

#[derive(Serialize)]
#[serde(untagged)]
enum GuestConfig<'a> {
    Local(GuestModelConfig<'a>),
    Subscription {
        kind: &'static str,
        provider: &'static str,
        thinking: &'static str,
        resolved_reasoning: &'a str,
        #[serde(flatten)]
        base: GuestModelConfig<'a>,
    },
}

#[derive(Serialize)]
struct Reservation<'a> {
    version: u32,
    execution_id: &'a str,
    authority_epoch: u64,
    container_name: &'a str,
    status: &'static str,
}

/// Reconcile only the private, durably reserved original VM; no inference is started.
pub(crate) fn reconcile_owned_launch(
    cli: &Path,
    reservation_path: &Path,
    execution_id: &str,
    authority_epoch: u64,
) -> GuestRuntimeResult<String> {
    let directory = reservation_path.parent().ok_or(GuestRuntimeError::Reservation)?;
    let canonical = directory.canonicalize().map_err(|_| GuestRuntimeError::Reservation)?;
    let directory_metadata = fs::symlink_metadata(directory).map_err(|_| GuestRuntimeError::Reservation)?;
    if canonical != directory || !directory_metadata.is_dir()
        || directory_metadata.uid() != unsafe { libc::geteuid() }
        || directory_metadata.mode() & 0o077 != 0
    {
        return Err(GuestRuntimeError::Reservation);
    }
    let mut file = open_no_follow(reservation_path, false).map_err(|_| GuestRuntimeError::Reservation)?;
    let before = file.metadata().map_err(|_| GuestRuntimeError::Reservation)?;
    if !before.is_file() || before.nlink() != 1 || before.len() > MAX_RESERVATION_BYTES
        || before.uid() != unsafe { libc::geteuid() } || before.mode() & 0o077 != 0
    {
        return Err(GuestRuntimeError::Reservation);
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file).take(MAX_RESERVATION_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|_| GuestRuntimeError::Reservation)?;
    let after = file.metadata().map_err(|_| GuestRuntimeError::Reservation)?;
    if bytes.len() as u64 > MAX_RESERVATION_BYTES || before.len() != after.len()
        || before.mtime() != after.mtime() || before.mtime_nsec() != after.mtime_nsec()
    {
        return Err(GuestRuntimeError::Reservation);
    }
    let mut lines = bytes.split(|byte| *byte == b'\n').filter(|line| !line.is_empty());
    let original: Value = serde_json::from_slice(lines.next().ok_or(GuestRuntimeError::Reservation)?)
        .map_err(|_| GuestRuntimeError::Reservation)?;
    let original = original.as_object().ok_or(GuestRuntimeError::Reservation)?;
    if original.len() != 5
        || original.get("version").and_then(Value::as_u64) != Some(CONTRACT_VERSION as u64)
        || original.get("execution_id").and_then(Value::as_str) != Some(execution_id)
        || original.get("authority_epoch").and_then(Value::as_u64) != Some(authority_epoch)
        || original.get("status").and_then(Value::as_str) != Some("reserved")
    {
        return Err(GuestRuntimeError::Reservation);
    }
    let name = original.get("container_name").and_then(Value::as_str)
        .ok_or(GuestRuntimeError::Reservation)?;
    let suffix = name.strip_prefix("ghost-c2c-").ok_or(GuestRuntimeError::Reservation)?;
    if suffix.len() != 32 || !suffix.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err(GuestRuntimeError::Reservation);
    }
    for line in lines {
        let event: Value = serde_json::from_slice(line).map_err(|_| GuestRuntimeError::Reservation)?;
        if event.as_object().map(|object| object.len()) != Some(1)
            || !matches!(event.get("status").and_then(Value::as_str),
                Some("configuration_rejected" | "broker_start_failed" | "authorization_revoked"
                    | "launch_failed" | "starting" | "running" | "stopped" | "effect_unknown"))
        {
            return Err(GuestRuntimeError::Reservation);
        }
    }
    stop_exact_container(cli, name)?;
    record_reservation_event(reservation_path, "stopped").map_err(|_| GuestRuntimeError::CleanupUnknown)?;
    Ok(name.to_owned())
}

struct ValidatedPaths {
    container_cli: PathBuf,
    runtime_root: PathBuf,
    source_directory: PathBuf,
    overlay_file: PathBuf,
    session_directory: PathBuf,
    workspace_directory: PathBuf,
    home_directory: PathBuf,
    control_directory: PathBuf,
    request_directory: PathBuf,
    response_directory: PathBuf,
    journal_path: PathBuf,
    skills_snapshot: Option<PathBuf>,
}

/// Historical public API remains typed, but never starts an OMP container.
pub fn spawn_guest(_config:GuestRuntimeConfig,_authorization_check:GuestBrokerAuthorizationCheck)->GuestRuntimeResult<GuestLaunch> {
    Err(GuestRuntimeError::Retired)
}

#[cfg(test)]
pub(crate) fn spawn_guest_legacy_fixture(
    config: GuestRuntimeConfig,
    authorization_check: GuestBrokerAuthorizationCheck,
) -> GuestRuntimeResult<GuestLaunch> {
    validate_binding(&config)?;
    if !authorized(&authorization_check, &config.broker.execution_id, config.broker.authority_epoch) {
        return Err(GuestRuntimeError::Unauthorized);
    }

    let paths = validate_paths(&config)?;
    if !authorized(&authorization_check, &config.broker.execution_id, config.broker.authority_epoch) {
        return Err(GuestRuntimeError::Unauthorized);
    }
    ensure_pinned_image(&paths.container_cli)?;
    if !authorized(&authorization_check, &config.broker.execution_id, config.broker.authority_epoch) {
        return Err(GuestRuntimeError::Unauthorized);
    }

    let container_name = format!("ghost-c2c-{}", Uuid::new_v4().simple());
    if list_contains_name(&paths.container_cli, &container_name)? {
        return Err(GuestRuntimeError::ContainerNameConflict);
    }
    let reservation_path = paths.control_directory.join(RESERVATION_NAME);
    create_reservation(&reservation_path, &config.broker, &container_name)?;

    let revoked = Arc::new(AtomicBool::new(false));
    let broker_authorization = bound_authorization(Arc::clone(&revoked), Arc::clone(&authorization_check),
        config.broker.execution_id.clone(), config.broker.authority_epoch);
    // Resolve the real native effort before sealing the guest configuration.
    // This guard owns/reaps the bridge even if later payload/VM setup fails.
    let broker = match GuestModelBroker::start_legacy_fixture(Arc::clone(&config.broker), broker_authorization) {
        Ok(broker) => broker,
        Err(error) => {
            record_reservation_event(&reservation_path, "configuration_rejected")
                .map_err(|_| GuestRuntimeError::Reservation)?;
            return Err(GuestRuntimeError::Broker(error));
        }
    };
    let payload_directory = paths.control_directory.join("payload");
    fs::create_dir(&payload_directory).map_err(|_| GuestRuntimeError::Reservation)?;
    let settings_path = payload_directory.join("omp.json");
    let settings = read_bounded_file(&paths.overlay_file, MAX_OVERLAY_BYTES)?;
    create_private_file(&settings_path, &settings)
        .map_err(|_| GuestRuntimeError::Reservation)?;
    let guest_config_path = payload_directory.join(CONTROL_CONFIG_NAME);
    let guest_config = guest_model_config(&config.broker, broker.native_ready())?;
    let guest_config_bytes =
        serde_json::to_vec(&guest_config).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if guest_config_bytes.len() > MAX_GUEST_CONFIG_BYTES {
        record_reservation_event(&reservation_path, "configuration_rejected")
            .map_err(|_| GuestRuntimeError::Reservation)?;
        return Err(GuestRuntimeError::InvalidConfig);
    }
    create_private_file(&guest_config_path, &guest_config_bytes)
        .map_err(|_| GuestRuntimeError::Reservation)?;
    for file in [&settings_path, &guest_config_path] {
        fs::set_permissions(file, fs::Permissions::from_mode(0o444))
            .map_err(|_| GuestRuntimeError::Reservation)?;
    }
    sync_directory(&payload_directory).map_err(|_| GuestRuntimeError::Reservation)?;
    fs::set_permissions(&payload_directory, fs::Permissions::from_mode(0o555))
        .map_err(|_| GuestRuntimeError::Reservation)?;
    sync_directory(&paths.control_directory).map_err(|_| GuestRuntimeError::Reservation)?;
    let mount_sources = match validate_mount_sources(&paths) {
        Ok(mounts) => mounts,
        Err(error) => {
            let _ = record_reservation_event(&reservation_path, "configuration_rejected");
            return Err(error);
        }
    };
    // Stage the pinned skill snapshot into the guest home before launch. An
    // absent or empty snapshot keeps the guest session `skills: []`.
    let skills_env = match &paths.skills_snapshot {
        Some(snapshot) => match stage_skills_snapshot(snapshot, &paths.home_directory) {
            Ok(env) => env,
            Err(_) => {
                let _ = record_reservation_event(&reservation_path, "configuration_rejected");
                return Err(GuestRuntimeError::InvalidConfig);
            }
        },
        None => Vec::new(),
    };
    let mut command = Command::new(&paths.container_cli);
    configure_run_command(&mut command, &container_name, &mount_sources, &skills_env)?;
    command
        .current_dir("/")
        .env_clear()
        .env("PATH", PRIVATE_CLI_PATH)
        .env("NO_COLOR", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in ["HOME", "TMPDIR", "LANG", "LC_ALL"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.process_group(0);

    let child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            record_reservation_event(&reservation_path, "launch_failed")
                .map_err(|_| GuestRuntimeError::CleanupUnknown)?;
            return Err(GuestRuntimeError::Launch);
        }
    };
    let mut child = child;
    let mut lease = GuestRuntimeLease {
        container_cli: paths.container_cli,
        container_name,
        reservation_path,
        revoked,
        broker: Some(broker),
        cleanup_attempted: false,
        cleanup_result: None,
    };
    if record_reservation_event(&lease.reservation_path, "starting").is_err() {
        let reaped = reap_child(&mut child, CONTAINER_QUERY_TIMEOUT);
        let cleanup = lease.stop();
        return if reaped.is_ok() && cleanup.is_ok() {
            Err(GuestRuntimeError::Reservation)
        } else {
            Err(GuestRuntimeError::CleanupUnknown)
        };
    }
    if let Err(error) = wait_for_container_start(
        &lease.container_cli,
        &lease.container_name,
        &mut child,
        &authorization_check,
        &config.broker,
    ) {
        let reaped = reap_child(&mut child, CONTAINER_QUERY_TIMEOUT);
        let cleanup = lease.stop();
        return if reaped.is_ok() && cleanup.is_ok() {
            Err(error)
        } else {
            Err(GuestRuntimeError::CleanupUnknown)
        };
    }
    if !authorized(&authorization_check, &config.broker.execution_id, config.broker.authority_epoch) {
        let reaped = reap_child(&mut child, CONTAINER_QUERY_TIMEOUT);
        let cleanup = lease.stop();
        return if reaped.is_ok() && cleanup.is_ok() {
            Err(GuestRuntimeError::Unauthorized)
        } else {
            Err(GuestRuntimeError::CleanupUnknown)
        };
    }

    if record_reservation_event(&lease.reservation_path, "running").is_err() {
        lease.revoked.store(true, Ordering::Release);
        let reaped = reap_child(&mut child, CONTAINER_QUERY_TIMEOUT);
        let cleanup = lease.stop();
        return if reaped.is_ok() && cleanup.is_ok() {
            Err(GuestRuntimeError::Reservation)
        } else {
            Err(GuestRuntimeError::CleanupUnknown)
        };
    }
    Ok(GuestLaunch { child, lease })
}

fn validate_binding(config: &GuestRuntimeConfig) -> GuestRuntimeResult<()> {
    let broker = &config.broker;
    if broker.version != CONTRACT_VERSION
        || !safe_execution_id(&broker.execution_id)
        || broker.authority_epoch == 0
        || broker.authority_epoch > 9_007_199_254_740_991
        || broker.model_id != broker.model_pin
        || !is_exact_worker_tool_scope(&broker.allowed_tools)
    {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    super::guest_broker::validate_registered_route(
        &broker.backend,
        &broker.model_id,
        broker.max_tokens,
        broker.context_window,
        broker.deadline_ms,
        broker.max_requests,
    )
    .map_err(|_| GuestRuntimeError::InvalidConfig)?;
    for path in [
        &config.container_cli,
        &config.linux_runtime_root,
        &config.source_directory,
        &config.overlay_file,
        &config.session_directory,
        &config.workspace_directory,
        &config.home_directory,
        &config.control_directory,
        &broker.request_directory,
        &broker.response_directory,
        &broker.journal_path,
    ] {
        if !path.is_absolute() {
            return Err(GuestRuntimeError::InvalidConfig);
        }
    }
    Ok(())
}
fn validate_paths(config: &GuestRuntimeConfig) -> GuestRuntimeResult<ValidatedPaths> {
    let container_cli =
        fs::canonicalize(&config.container_cli).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    let container_cli = canonical_regular_file(&container_cli, 64 * 1024 * 1024, true)?;
    let runtime_root = canonical_directory(&config.linux_runtime_root)?;
    let source_directory = canonical_directory(&config.source_directory)?;
    let overlay_file = canonical_regular_file(&config.overlay_file, MAX_OVERLAY_BYTES, false)?;
    let overlay_metadata = fs::metadata(&overlay_file).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if overlay_metadata.mode() & 0o077 != 0 {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let session_directory = canonical_private_directory(&config.session_directory)?;
    let workspace_directory = canonical_private_directory(&config.workspace_directory)?;
    let home_directory = canonical_private_directory(&config.home_directory)?;
    let control_directory = canonical_private_directory(&config.control_directory)?;
    let request_directory = canonical_private_directory(&config.broker.request_directory)?;
    let response_directory = canonical_private_directory(&config.broker.response_directory)?;
    let journal_path = canonical_file_location(&config.broker.journal_path)?;
    let skills_snapshot = config
        .skills_snapshot
        .as_ref()
        .map(|path| canonical_directory(path))
        .transpose()?;
    reject_host_configuration_roots(
        &[
            &runtime_root,
            &source_directory,
            &overlay_file,
            &session_directory,
            &workspace_directory,
            &home_directory,
            &control_directory,
            &request_directory,
            &response_directory,
            &journal_path,
        ],
        &[&workspace_directory, &home_directory],
    )?;
    if let Some(snapshot) = &skills_snapshot {
        reject_host_configuration_roots(&[snapshot], &[])?;
    }
    if fs::read_dir(&control_directory)
        .map_err(|_| GuestRuntimeError::InvalidConfig)?
        .next()
        .is_some()
    {
        return Err(GuestRuntimeError::Reservation);
    }
    validate_source_snapshot(&source_directory)?;
    validate_linux_runtime(&runtime_root)?;
    reject_mount_overlaps(&[
        &runtime_root,
        &source_directory,
        &overlay_file,
        &session_directory,
        &workspace_directory,
        &home_directory,
        &request_directory,
        &response_directory,
        &control_directory,
        &journal_path,
    ])?;
    validate_mount_syntax(&[
        &runtime_root,
        &source_directory,
        &overlay_file,
        &session_directory,
        &workspace_directory,
        &home_directory,
        &request_directory,
        &response_directory,
        &control_directory,
    ])?;

    Ok(ValidatedPaths {
        container_cli,
        runtime_root,
        source_directory,
        overlay_file,
        session_directory,
        workspace_directory,
        home_directory,
        control_directory,
        request_directory,
        response_directory,
        journal_path,
        skills_snapshot,
    })
}

fn safe_execution_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes().iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b':')
        })
        && value != "."
        && value != ".."
}

fn authorized(check: &GuestBrokerAuthorizationCheck, execution_id: &str, authority_epoch: u64) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        check(execution_id, authority_epoch)
    }))
    .unwrap_or(false)
}

fn bound_authorization(
    revoked: Arc<AtomicBool>,
    upstream: GuestBrokerAuthorizationCheck,
    execution_id: String,
    authority_epoch: u64,
) -> GuestBrokerAuthorizationCheck {
    Arc::new(move |candidate, epoch| {
        if revoked.load(Ordering::Acquire)
            || candidate != execution_id.as_str()
            || epoch != authority_epoch
        {
            return false;
        }
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| upstream(candidate, epoch)))
            .unwrap_or(false)
    })
}


fn validate_mount_sources(
    paths: &ValidatedPaths,
) -> GuestRuntimeResult<[(PathBuf, &'static str, bool); 8]> {
    let runtime_root = canonical_directory(&paths.runtime_root)?;
    let source_directory = canonical_directory(&paths.source_directory)?;
    let overlay_file = canonical_regular_file(&paths.overlay_file, MAX_OVERLAY_BYTES, false)?;
    if fs::metadata(&overlay_file)
        .map_err(|_| GuestRuntimeError::InvalidConfig)?
        .mode()
        & 0o077
        != 0
    {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let session_directory = canonical_private_directory(&paths.session_directory)?;
    let workspace_directory = canonical_private_directory(&paths.workspace_directory)?;
    let home_directory = canonical_private_directory(&paths.home_directory)?;
    let control_directory = canonical_private_directory(&paths.control_directory)?;
    let request_directory = canonical_private_directory(&paths.request_directory)?;
    let response_directory = canonical_private_directory(&paths.response_directory)?;
    let journal_path = canonical_file_location(&paths.journal_path)?;
    if runtime_root != paths.runtime_root
        || source_directory != paths.source_directory
        || overlay_file != paths.overlay_file
        || session_directory != paths.session_directory
        || workspace_directory != paths.workspace_directory
        || home_directory != paths.home_directory
        || control_directory != paths.control_directory
        || request_directory != paths.request_directory
        || response_directory != paths.response_directory
        || journal_path != paths.journal_path
    {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let payload = canonical_directory(&control_directory.join("payload"))?;
    if fs::metadata(&payload).map_err(|_| GuestRuntimeError::InvalidConfig)?.mode() & 0o222 != 0 {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let mut found = 0_u8;
    for entry in fs::read_dir(&payload).map_err(|_| GuestRuntimeError::InvalidConfig)? {
        let entry = entry.map_err(|_| GuestRuntimeError::InvalidConfig)?;
        let (flag, maximum) = match entry.file_name().to_str() {
            Some("omp.json") => (1, MAX_OVERLAY_BYTES),
            Some(CONTROL_CONFIG_NAME) => (2, MAX_GUEST_CONFIG_BYTES),
            _ => return Err(GuestRuntimeError::InvalidConfig),
        };
        let file = canonical_regular_file(&entry.path(), maximum, false)?;
        if fs::metadata(file).map_err(|_| GuestRuntimeError::InvalidConfig)?.mode() & 0o222 != 0 {
            return Err(GuestRuntimeError::InvalidConfig);
        }
        found |= flag;
    }
    if found != 3 {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    reject_host_configuration_roots(
        &[
            &runtime_root,
            &source_directory,
            &overlay_file,
            &payload,
            &session_directory,
            &workspace_directory,
            &home_directory,
            &request_directory,
            &response_directory,
            &paths.control_directory,
            &journal_path,
        ],
        &[&workspace_directory, &home_directory],
    )?;
    reject_mount_overlaps(&[
        &runtime_root,
        &source_directory,
        &payload,
        &session_directory,
        &request_directory,
        &response_directory,
        &workspace_directory,
        &home_directory,
        &journal_path,
    ])?;
    validate_mount_syntax(&[
        &runtime_root,
        &source_directory,
        &payload,
        &session_directory,
        &request_directory,
        &response_directory,
        &workspace_directory,
        &home_directory,
        &paths.control_directory,
    ])?;
    Ok([
        (runtime_root, "/runtime", true),
        (source_directory, "/source", true),
        (payload, "/control", true),
        (session_directory, GUEST_SESSION_PATH, false),
        (request_directory, GUEST_REQUEST_PATH, false),
        (response_directory, GUEST_RESPONSE_PATH, true),
        (workspace_directory, GUEST_WORKSPACE_PATH, false),
        (home_directory, GUEST_HOME_PATH, false),
    ])
}

fn canonical_file_location(path: &Path) -> GuestRuntimeResult<PathBuf> {
    let parent = path.parent().ok_or(GuestRuntimeError::InvalidConfig)?;
    let parent = canonical_directory(parent)?;
    let file_name = path.file_name().ok_or(GuestRuntimeError::InvalidConfig)?;
    let canonical = parent.join(file_name);
    if &canonical != path {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    match fs::symlink_metadata(&canonical) {
        Ok(metadata)
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.nlink() != 1 =>
        {
            Err(GuestRuntimeError::InvalidConfig)
        }
        Ok(_) => Ok(canonical),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(canonical),
        Err(_) => Err(GuestRuntimeError::InvalidConfig),
    }
}

fn canonical_directory(path: &Path) -> GuestRuntimeResult<PathBuf> {
    let metadata = fs::symlink_metadata(path).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let canonical = fs::canonicalize(path).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if canonical != path {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&canonical)
        .map_err(|_| GuestRuntimeError::InvalidConfig)?;
    let opened = directory
        .metadata()
        .map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if !opened.is_dir() || metadata.dev() != opened.dev() || metadata.ino() != opened.ino() {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    Ok(canonical)
}

fn canonical_private_directory(path: &Path) -> GuestRuntimeResult<PathBuf> {
    let canonical = canonical_directory(path)?;
    let metadata = fs::metadata(&canonical).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if metadata.mode() & 0o777 != 0o700 {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    Ok(canonical)
}

fn canonical_regular_file(
    path: &Path,
    maximum: usize,
    executable: bool,
) -> GuestRuntimeResult<PathBuf> {
    let metadata = fs::symlink_metadata(path).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.len() > maximum as u64
    {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let canonical = fs::canonicalize(path).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if canonical != path {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let file = open_no_follow(&canonical, false).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    let opened = file
        .metadata()
        .map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if !opened.is_file()
        || opened.nlink() != 1
        || opened.len() > maximum as u64
        || metadata.dev() != opened.dev()
        || metadata.ino() != opened.ino()
        || (executable && opened.mode() & 0o111 == 0)
    {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    Ok(canonical)
}

fn open_no_follow(path: &Path, write: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(!write).write(write);
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    options.open(path)
}

fn validate_source_snapshot(source: &Path) -> GuestRuntimeResult<()> {
    let metadata = fs::metadata(source).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if metadata.mode() & 0o222 != 0 {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let mut found = 0_u8;
    for entry in fs::read_dir(source).map_err(|_| GuestRuntimeError::InvalidConfig)? {
        let entry = entry.map_err(|_| GuestRuntimeError::InvalidConfig)?;
        let name = entry.file_name();
        let name = name.to_str().ok_or(GuestRuntimeError::InvalidConfig)?;
        let Some(index) = SOURCE_FILES.iter().position(|expected| *expected == name) else {
            return Err(GuestRuntimeError::InvalidConfig);
        };
        let file = canonical_regular_file(&entry.path(), MAX_SOURCE_FILE_BYTES, false)?;
        let info = fs::metadata(&file).map_err(|_| GuestRuntimeError::InvalidConfig)?;
        if info.mode() & 0o222 != 0 {
            return Err(GuestRuntimeError::InvalidConfig);
        }
        found |= 1_u8 << index;
    }
    if found != (1_u8 << SOURCE_FILES.len()) - 1 {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    Ok(())
}

pub(crate) fn validate_guest_runner_assets(
    runtime_root: &Path,
    source_directory: &Path,
) -> GuestRuntimeResult<()> {
    let runtime_root = canonical_directory(runtime_root)?;
    let source_directory = canonical_directory(source_directory)?;
    validate_linux_runtime(&runtime_root)?;
    validate_source_snapshot(&source_directory)
}

fn validate_linux_runtime(runtime_root: &Path) -> GuestRuntimeResult<()> {
    if fs::metadata(runtime_root).map_err(|_| GuestRuntimeError::InvalidConfig)?.mode() & 0o222 != 0 {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let bun = canonical_regular_file(&runtime_root.join("bun-bin/bun"), 256 * 1024 * 1024, true)?;
    let mut bun_file = open_no_follow(&bun, false).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    let mut elf_header = [0u8; 20];
    bun_file.read_exact(&mut elf_header).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if elf_header[0] != 0x7f
        || elf_header[1] != b'E'
        || elf_header[2] != b'L'
        || elf_header[3] != b'F'
        || elf_header[4] != 2
        || elf_header[5] != 1
        || elf_header[6] != 1
        || elf_header[18] != 183
        || elf_header[19] != 0
    {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let root_package = canonical_regular_file(&runtime_root.join("package.json"), MAX_MANIFEST_BYTES, false)?;
    let bytes = read_bounded_file(&root_package, MAX_MANIFEST_BYTES)?;
    let root_manifest: Value = serde_json::from_slice(&bytes).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    let dependencies = root_manifest.get("dependencies").and_then(Value::as_object)
        .ok_or(GuestRuntimeError::InvalidConfig)?;
    if dependencies.get("@oh-my-pi/pi-coding-agent").and_then(Value::as_str) != Some(OMP_VERSION)
        || dependencies.get("@oh-my-pi/pi-natives-linux-arm64").and_then(Value::as_str) != Some(OMP_VERSION)
    {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let package = canonical_regular_file(
        &runtime_root.join("node_modules/@oh-my-pi/pi-coding-agent/package.json"),
        MAX_MANIFEST_BYTES,
        false,
    )?;
    let bytes = read_bounded_file(&package, MAX_MANIFEST_BYTES)?;
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if manifest.get("version").and_then(Value::as_str) != Some(OMP_VERSION) {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let pi_ai = canonical_regular_file(
        &runtime_root.join("node_modules/@oh-my-pi/pi-ai/package.json"),
        MAX_MANIFEST_BYTES,
        false,
    )?;
    let bytes = read_bounded_file(&pi_ai, MAX_MANIFEST_BYTES)?;
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if manifest.get("version").and_then(Value::as_str) != Some(OMP_VERSION) {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let native_package = canonical_regular_file(
        &runtime_root.join("node_modules/@oh-my-pi/pi-natives-linux-arm64/package.json"),
        MAX_MANIFEST_BYTES,
        false,
    )?;
    let bytes = read_bounded_file(&native_package, MAX_MANIFEST_BYTES)?;
    let native_manifest: Value = serde_json::from_slice(&bytes).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    let linux_os = native_manifest.get("os").and_then(Value::as_array)
        .is_some_and(|values| values.len() == 1 && values[0].as_str() == Some("linux"));
    let arm64_cpu = native_manifest.get("cpu").and_then(Value::as_array)
        .is_some_and(|values| values.len() == 1 && values[0].as_str() == Some("arm64"));
    if native_manifest.get("version").and_then(Value::as_str) != Some(OMP_VERSION)
        || !linux_os
        || !arm64_cpu
        || native_manifest.get("main").and_then(Value::as_str) != Some("./pi_natives.linux-arm64.node")
    {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    canonical_regular_file(
        &runtime_root.join("node_modules/@oh-my-pi/pi-natives-linux-arm64/pi_natives.linux-arm64.node"),
        256 * 1024 * 1024,
        false,
    )?;
    let provenance = canonical_regular_file(&runtime_root.join("provenance.json"), MAX_MANIFEST_BYTES, false)?;
    let bytes = read_bounded_file(&provenance, MAX_MANIFEST_BYTES)?;
    let provenance: Value = serde_json::from_slice(&bytes).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if provenance.pointer("/bun/version").and_then(Value::as_str) != Some(BUN_VERSION)
        || provenance.pointer("/bun/os").and_then(Value::as_str) != Some("linux")
        || provenance.pointer("/bun/cpu").and_then(Value::as_str) != Some("arm64")
        || provenance.pointer("/bun/libc").and_then(Value::as_str) != Some("glibc")
        || provenance.pointer("/omp/version").and_then(Value::as_str) != Some(OMP_VERSION)
    {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    Ok(())
}

fn read_bounded_file(path: &Path, maximum: usize) -> GuestRuntimeResult<Vec<u8>> {
    let file = open_no_follow(path, false).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    let metadata = file
        .metadata()
        .map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > maximum as u64 {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| GuestRuntimeError::InvalidConfig)?;
    if bytes.len() > maximum {
        return Err(GuestRuntimeError::InvalidConfig);
    }
    Ok(bytes)
}

fn reject_mount_overlaps(paths: &[&Path]) -> GuestRuntimeResult<()> {
    for left in 0..paths.len() {
        for right in left + 1..paths.len() {
            if paths[left].starts_with(paths[right]) || paths[right].starts_with(paths[left]) {
                return Err(GuestRuntimeError::InvalidConfig);
            }
        }
    }
    Ok(())
}

fn validate_mount_syntax(paths: &[&Path]) -> GuestRuntimeResult<()> {
    for path in paths {
        let text = path.to_str().ok_or(GuestRuntimeError::InvalidConfig)?;
        if text
            .bytes()
            .any(|byte| matches!(byte, b',' | b'=' | b'\\' | b'\n' | b'\r' | 0))
        {
            return Err(GuestRuntimeError::InvalidConfig);
        }
    }
    Ok(())
}

fn reject_host_configuration_roots(paths: &[&Path], registered_home_mounts: &[&Path]) -> GuestRuntimeResult<()> {
    let home = std::env::var_os("HOME").ok_or(GuestRuntimeError::InvalidConfig)?;
    let home = fs::canonicalize(PathBuf::from(home)).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    let protected = [
        home.join(".config"),
        home.join(".omp"),
        home.join(".oh-my-pi"),
        home.join("Library/Application Support"),
    ];
    // Only these exact registry-granted mounts may reside under the host's app-support root.
    for path in paths {
        if registered_home_mounts.iter().any(|mount| *mount == *path) {
            continue;
        }
        if protected
            .iter()
            .any(|root| path.starts_with(root) || root.starts_with(path))
        {
            return Err(GuestRuntimeError::InvalidConfig);
        }
    }
    Ok(())
}

fn guest_model_config<'a>(config: &'a GuestBrokerConfig, ready: Option<&'a SubscriptionReady>) -> GuestRuntimeResult<GuestConfig<'a>> {
    let base = GuestModelConfig {
        version: CONTRACT_VERSION,
        execution_id: &config.execution_id,
        authority_epoch: config.authority_epoch,
        request_directory: GUEST_REQUEST_PATH,
        response_directory: GUEST_RESPONSE_PATH,
        model_id: &config.model_id,
        max_tokens: config.max_tokens,
        context_window: config.context_window,
        allowed_tools: &config.allowed_tools,
        deadline_ms: config.deadline_ms,
        max_requests: config.max_requests,
    };
    match &config.backend {
        GuestModelBackend::LocalHttp { .. } => Ok(GuestConfig::Local(base)),
        GuestModelBackend::SubscriptionNative(_) => {
            let ready = ready.ok_or(GuestRuntimeError::InvalidConfig)?;
            Ok(GuestConfig::Subscription { kind: "subscription_native", provider: "openai-codex",
                thinking: "max", resolved_reasoning: &ready.resolved_reasoning, base })
        }
    }
}

/// Stage a prepared pinned-skill snapshot into the guest home. Each snapshot
/// entry is `<name>/SKILL.md` with a validated name; bytes are copied verbatim
/// and their SHA-256 digests recorded in `skills-manifest.json`, which the
/// scoped entry point re-verifies before building the session. Returns the
/// container environment pairs, or an empty vector for an empty snapshot.
fn stage_skills_snapshot(
    snapshot: &Path,
    home: &Path,
) -> GuestRuntimeResult<Vec<(String, String)>> {
    let mut entries: Vec<(String, String, Vec<u8>)> = Vec::new();
    let reader = fs::read_dir(snapshot).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    for entry in reader {
        let entry = entry.map_err(|_| GuestRuntimeError::InvalidConfig)?;
        let name = entry.file_name();
        let name = name.to_str().ok_or(GuestRuntimeError::InvalidConfig)?;
        if !name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
            || name.is_empty()
            || name.len() > 64
        {
            return Err(GuestRuntimeError::InvalidConfig);
        }
        let skill_file = entry.path().join("SKILL.md");
        let metadata = fs::symlink_metadata(&skill_file).map_err(|_| GuestRuntimeError::InvalidConfig)?;
        if metadata.is_symlink() || !metadata.is_file() || metadata.len() > 262_144 {
            return Err(GuestRuntimeError::InvalidConfig);
        }
        let bytes = fs::read(&skill_file).map_err(|_| GuestRuntimeError::InvalidConfig)?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        entries.push((name.to_owned(), digest, bytes));
    }
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let skills_root = home.join("skills");
    let mut manifest_skills = Vec::with_capacity(entries.len());
    for (name, digest, bytes) in &entries {
        let target = skills_root.join(name).join("SKILL.md");
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| GuestRuntimeError::InvalidConfig)?;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|_| GuestRuntimeError::InvalidConfig)?;
        }
        fs::write(&target, bytes).map_err(|_| GuestRuntimeError::InvalidConfig)?;
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600))
            .map_err(|_| GuestRuntimeError::InvalidConfig)?;
        manifest_skills.push(serde_json::json!({
            "name": name,
            "sha256": digest,
            "file": format!("/home/ghost/skills/{name}/SKILL.md"),
        }));
    }
    let manifest = serde_json::json!({"schema": "ghost-worker-skills/1", "skills": manifest_skills});
    let manifest_bytes = serde_json::to_vec(&manifest).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    let manifest_path = home.join("skills-manifest.json");
    fs::write(&manifest_path, manifest_bytes).map_err(|_| GuestRuntimeError::InvalidConfig)?;
    fs::set_permissions(&manifest_path, fs::Permissions::from_mode(0o600))
        .map_err(|_| GuestRuntimeError::InvalidConfig)?;
    Ok(vec![
        ("GHOST_WORKER_SKILLS_MANIFEST".to_owned(), "/home/ghost/skills-manifest.json".to_owned()),
        ("GHOST_WORKER_SKILLS_ROOT".to_owned(), "/home/ghost/skills".to_owned()),
    ])
}

fn configure_run_command(
    command: &mut Command,
    container_name: &str,
    mounts: &[(PathBuf, &'static str, bool)],
    skills_env: &[(String, String)],
) -> GuestRuntimeResult<()> {
    command.args([
        "run", "--rm", "--interactive", "--progress", "none", "--platform", "linux/arm64",
        "--uid", GUEST_UID, "--gid", GUEST_GID, "--cap-drop", "ALL", "--read-only",
        "--network", "none", "--no-dns", "--tmpfs", "/tmp",
        "--workdir", GUEST_WORKSPACE_PATH, "--env", "HOME=/home/ghost",
        "--env", "PATH=/runtime/bun-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "--env", "GHOST_OMP_SESSION_DIR=/session", "--name", container_name,
    ]);
    for (key, value) in skills_env {
        // Keys and values come from the trusted staging path below, never from
        // skill content; guest-side skill bytes are validated by digest in the
        // scoped entry point before any session is created.
        if key.is_empty()
            || value.is_empty()
            || !key.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
            || value.contains('\n')
        {
            return Err(GuestRuntimeError::InvalidConfig);
        }
        command.arg("--env").arg(format!("{key}={value}"));
    }
    for (source, target, read_only) in mounts {
        let source = source.to_str().ok_or(GuestRuntimeError::InvalidConfig)?;
        let mount = if *read_only {
            format!("type=bind,source={source},target={target},readonly")
        } else {
            format!("type=bind,source={source},target={target}")
        };
        command.arg("--mount").arg(mount);
    }
    command.args([
        PINNED_TASK_IMAGE, "/runtime/bun-bin/bun", "/source/scoped-rpc.ts",
        "--package-root", "/runtime/node_modules/@oh-my-pi/pi-coding-agent",
        "--config", "/control/omp.json", "--broker-config", "/control/model.json",
    ]);
    Ok(())
}

fn create_reservation(
    path: &Path,
    config: &GuestBrokerConfig,
    container_name: &str,
) -> GuestRuntimeResult<()> {
    let reservation = Reservation {
        version: CONTRACT_VERSION,
        execution_id: &config.execution_id,
        authority_epoch: config.authority_epoch,
        container_name,
        status: "reserved",
    };
    let mut bytes = serde_json::to_vec(&reservation).map_err(|_| GuestRuntimeError::Reservation)?;
    bytes.push(b'\n');
    create_private_file(path, &bytes).map_err(|_| GuestRuntimeError::Reservation)?;
    sync_directory(path.parent().ok_or(GuestRuntimeError::Reservation)?)
        .map_err(|_| GuestRuntimeError::Reservation)
}

fn create_private_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(())
}

fn record_reservation_event(path: &Path, status: &str) -> io::Result<()> {
    if !matches!(
        status,
        "configuration_rejected"
            | "broker_start_failed"
            | "authorization_revoked"
            | "launch_failed"
            | "starting"
            | "running"
            | "stopped"
            | "effect_unknown"
    ) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid runtime event"));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .append(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > MAX_RESERVATION_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "runtime reservation rejected"));
    }
    file.write_all(format!("{{\"status\":\"{status}\"}}\n").as_bytes())?;
    file.sync_all()
}

fn sync_directory(path: &Path) -> io::Result<()> {
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    directory.sync_all()
}

fn ensure_pinned_image(cli: &Path) -> GuestRuntimeResult<()> {
    let output = run_cli_capture(
        cli,
        &["image", "inspect", PINNED_TASK_IMAGE],
        CONTAINER_QUERY_TIMEOUT,
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(GuestRuntimeError::PinnedImageUnavailable)
    }
}

fn list_contains_name(cli: &Path, name: &str) -> GuestRuntimeResult<bool> {
    list_contains_name_with_timeout(cli, name, CONTAINER_QUERY_TIMEOUT)
}

fn list_contains_name_with_timeout(
    cli: &Path,
    name: &str,
    timeout: Duration,
) -> GuestRuntimeResult<bool> {
    let output = run_cli_capture(cli, &["list", "--all", "--format", "json"], timeout)?;
    if !output.status.success() {
        return Err(GuestRuntimeError::ContainerProbe);
    }
    let records: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| GuestRuntimeError::ContainerProbe)?;
    let records = records.as_array().ok_or(GuestRuntimeError::ContainerProbe)?;
    for record in records {
        if container_id(record)? == name {
            return Ok(true);
        }
    }
    Ok(false)
}

fn container_id(record: &Value) -> GuestRuntimeResult<&str> {
    let nested = record.pointer("/configuration/id").and_then(Value::as_str);
    let direct = record.get("id").and_then(Value::as_str);
    match (nested, direct) {
        (Some(left), Some(right)) if left != right => Err(GuestRuntimeError::ContainerProbe),
        (Some(value), _) | (_, Some(value)) if !value.is_empty() => Ok(value),
        _ => Err(GuestRuntimeError::ContainerProbe),
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum GuestContainerState {
    Starting,
    Running,
    Stopped,
}

fn inspect_guest_container(
    cli: &Path,
    name: &str,
    timeout: Duration,
) -> GuestRuntimeResult<Option<GuestContainerState>> {
    let deadline = Instant::now() + timeout;
    if !list_contains_name_with_timeout(cli, name, timeout)? {
        return Ok(None);
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Ok(None);
    }
    let output = run_cli_capture(cli, &["inspect", name], remaining)?;
    if !output.status.success() {
        return Err(GuestRuntimeError::ContainerProbe);
    }
    let records: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| GuestRuntimeError::ContainerProbe)?;
    let records = records.as_array().ok_or(GuestRuntimeError::ContainerProbe)?;
    if records.len() != 1 || container_id(&records[0])? != name {
        return Err(GuestRuntimeError::ContainerProbe);
    }
    let state = records[0]
        .pointer("/status/state")
        .and_then(Value::as_str)
        .ok_or(GuestRuntimeError::ContainerProbe)?;
    match state {
        "created" | "starting" => Ok(Some(GuestContainerState::Starting)),
        "running" => Ok(Some(GuestContainerState::Running)),
        "stopped" => Ok(Some(GuestContainerState::Stopped)),
        _ => Err(GuestRuntimeError::ContainerProbe),
    }
}

fn wait_for_container_start(
    cli: &Path,
    name: &str,
    child: &mut Child,
    authorization_check: &GuestBrokerAuthorizationCheck,
    config: &GuestBrokerConfig,
) -> GuestRuntimeResult<()> {
    let deadline = Instant::now() + CONTAINER_START_TIMEOUT;
    loop {
        if !authorized(authorization_check, &config.execution_id, config.authority_epoch) {
            return Err(GuestRuntimeError::Unauthorized);
        }
        match child.try_wait() {
            Ok(Some(_)) => return Err(GuestRuntimeError::Launch),
            Ok(None) => {}
            Err(_) => return Err(GuestRuntimeError::CleanupUnknown),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(GuestRuntimeError::Launch);
        }
        match inspect_guest_container(cli, name, remaining.min(CONTAINER_QUERY_TIMEOUT))? {
            Some(GuestContainerState::Running) => {
                if !authorized(authorization_check, &config.execution_id, config.authority_epoch) {
                    return Err(GuestRuntimeError::Unauthorized);
                }
                return match child.try_wait() {
                    Ok(None) => Ok(()),
                    Ok(Some(_)) => Err(GuestRuntimeError::Launch),
                    Err(_) => Err(GuestRuntimeError::CleanupUnknown),
                };
            }
            // A newly reserved CLI-owned container is initially reported as
            // stopped while its foreground run process is still booting.
            // Only running + a live owned child is ready; child exit or the
            // original startup deadline decides failure.
            Some(GuestContainerState::Starting | GuestContainerState::Stopped) | None => {}
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(GuestRuntimeError::Launch);
        }
        thread::sleep(CONTAINER_START_POLL_INTERVAL.min(remaining));
    }
}

fn stop_exact_container(cli: &Path, name: &str) -> GuestRuntimeResult<()> {
    let _ = run_cli_capture(
        cli,
        &["stop", "--time", CONTAINER_STOP_SECONDS, name],
        CONTAINER_STOP_TIMEOUT,
    );
    if !list_contains_name(cli, name).map_err(|_| GuestRuntimeError::CleanupUnknown)? {
        return Ok(());
    }
    let inspect = run_cli_capture(cli, &["inspect", name], CONTAINER_QUERY_TIMEOUT)
        .map_err(|_| GuestRuntimeError::CleanupUnknown)?;
    if !inspect.status.success() {
        return Err(GuestRuntimeError::CleanupUnknown);
    }
    let records: Value = serde_json::from_slice(&inspect.stdout)
        .map_err(|_| GuestRuntimeError::CleanupUnknown)?;
    let records = records.as_array().ok_or(GuestRuntimeError::CleanupUnknown)?;
    if records.len() != 1
        || container_id(&records[0]).map_err(|_| GuestRuntimeError::CleanupUnknown)? != name
    {
        return Err(GuestRuntimeError::CleanupUnknown);
    }
    let state = records[0]
        .pointer("/status/state")
        .and_then(Value::as_str)
        .ok_or(GuestRuntimeError::CleanupUnknown)?;
    if state == "stopped" {
        Ok(())
    } else {
        Err(GuestRuntimeError::CleanupUnknown)
    }
}

struct CliOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
}

struct BoundedPipe<R: AsRawFd> {
    reader: R,
    bytes: Vec<u8>,
    overflow: bool,
    eof: bool,
}

impl<R: AsRawFd> BoundedPipe<R> {
    fn new(reader: R) -> GuestRuntimeResult<Self> {
        let descriptor = reader.as_raw_fd();
        let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
        if flags < 0
            || unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
        {
            return Err(GuestRuntimeError::ContainerProbe);
        }
        Ok(Self {
            reader,
            bytes: Vec::new(),
            overflow: false,
            eof: false,
        })
    }

    fn drain(&mut self, remaining_bytes: &mut usize) -> GuestRuntimeResult<()> {
        if self.eof {
            return Ok(());
        }
        let descriptor = self.reader.as_raw_fd();
        let mut buffer = [0_u8; 8192];
        loop {
            let count = unsafe {
                libc::read(
                    descriptor,
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                )
            };
            if count > 0 {
                let count = count as usize;
                let captured = count.min(*remaining_bytes);
                self.bytes.extend_from_slice(&buffer[..captured]);
                *remaining_bytes -= captured;
                self.overflow |= captured < count;
                continue;
            }
            if count == 0 {
                self.eof = true;
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            if error.raw_os_error() == Some(libc::EAGAIN)
                || error.raw_os_error() == Some(libc::EWOULDBLOCK)
            {
                return Ok(());
            }
            return Err(GuestRuntimeError::ContainerProbe);
        }
    }
}

struct CliChildGuard {
    child: Child,
    armed: bool,
}

impl Drop for CliChildGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = terminate_cli_process(&mut self.child);
        }
    }
}

fn terminate_cli_process(child: &mut Child) -> bool {
    let Ok(process_group) = i32::try_from(child.id()) else {
        return false;
    };
    let signal_result = unsafe { libc::kill(-process_group, libc::SIGKILL) };
    let group_signal_failed = signal_result < 0
        && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
    let _ = child.kill();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(CLI_POLL_INTERVAL),
            Ok(None) | Err(_) => return false,
        }
    }
    if group_signal_failed {
        return false;
    }
    loop {
        let result = unsafe { libc::kill(-process_group, 0) };
        if result < 0 {
            return io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(CLI_POLL_INTERVAL);
    }
}

fn reap_child(child: &mut Child, timeout: Duration) -> GuestRuntimeResult<()> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {}
            Err(_) => return Err(GuestRuntimeError::CleanupUnknown),
        }
        if Instant::now() >= deadline {
            return if terminate_cli_process(child) {
                Ok(())
            } else {
                Err(GuestRuntimeError::CleanupUnknown)
            };
        }
        thread::sleep(CLI_POLL_INTERVAL);
    }
}

fn run_cli_capture(
    cli: &Path,
    args: &[&str],
    timeout: Duration,
) -> GuestRuntimeResult<CliOutput> {
    let mut command = Command::new(cli);
    command
        .args(args)
        .current_dir("/")
        .env_clear()
        .env("PATH", PRIVATE_CLI_PATH)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in ["HOME", "TMPDIR", "LANG", "LC_ALL"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.process_group(0);
    let child = command.spawn().map_err(|_| GuestRuntimeError::ContainerProbe)?;
    let mut child = CliChildGuard { child, armed: true };
    let stdout = child
        .child
        .stdout
        .take()
        .ok_or(GuestRuntimeError::ContainerProbe)?;
    let stderr = child
        .child
        .stderr
        .take()
        .ok_or(GuestRuntimeError::ContainerProbe)?;
    let mut stdout = BoundedPipe::new(stdout)?;
    let mut stderr = BoundedPipe::new(stderr)?;
    let mut remaining_bytes = MAX_CLI_OUTPUT_BYTES;
    let deadline = Instant::now() + timeout;
    let status = loop {
        stdout.drain(&mut remaining_bytes)?;
        stderr.drain(&mut remaining_bytes)?;
        if let Some(status) = child
            .child
            .try_wait()
            .map_err(|_| GuestRuntimeError::ContainerProbe)?
        {
            break status;
        }
        if Instant::now() >= deadline {
            child.armed = !terminate_cli_process(&mut child.child);
            let drain_deadline = Instant::now() + CLI_DRAIN_TIMEOUT;
            while Instant::now() < drain_deadline && (!stdout.eof || !stderr.eof) {
                stdout.drain(&mut remaining_bytes)?;
                stderr.drain(&mut remaining_bytes)?;
                thread::sleep(CLI_POLL_INTERVAL);
            }
            return Err(GuestRuntimeError::CliTimeout);
        }
        thread::sleep(CLI_POLL_INTERVAL);
    };
    let drain_deadline = Instant::now() + CLI_DRAIN_TIMEOUT;
    while Instant::now() < drain_deadline && (!stdout.eof || !stderr.eof) {
        stdout.drain(&mut remaining_bytes)?;
        stderr.drain(&mut remaining_bytes)?;
        thread::sleep(CLI_POLL_INTERVAL);
    }
    if !stdout.eof || !stderr.eof {
        return Err(GuestRuntimeError::CliTimeout);
    }
    if stdout.overflow || stderr.overflow {
        return Err(GuestRuntimeError::CliOutput);
    }
    child.armed = false;
    Ok(CliOutput {
        status,
        stdout: stdout.bytes,
    })
}
