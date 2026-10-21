use super::native_tools::is_exact_worker_tool_scope;

use std::collections::BTreeSet;
use std::ffi::{CStr, CString};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::IpAddr;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::subscription_bridge::{SubscriptionBridge, SubscriptionBridgeConfig, SubscriptionReady};

use reqwest::{Client, Url};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::runtime::Builder;
use tokio::time::{sleep, Instant};
use uuid::Uuid;

const CONTRACT_VERSION: u32 = 1;
const MAX_PAYLOAD_BYTES: usize = 1_048_576;
const MAX_COMPLETION_BYTES: usize = 4_194_304;
const MAX_REQUEST_FILE_BYTES: usize = 2 * MAX_PAYLOAD_BYTES + 65_536;
const MAX_RESPONSE_FILE_BYTES: usize = 2 * MAX_COMPLETION_BYTES + 65_536;
const MAX_REQUEST_SPOOL_BYTES: u64 = 40 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 128;
const POLL_INTERVAL: Duration = Duration::from_millis(25);
const MAX_JOURNAL_ROWS: i64 = 128;
const SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;

pub type GuestBrokerAuthorizationCheck = Arc<dyn Fn(&str, u64) -> bool + Send + Sync + 'static>;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GuestModelBackend {
    LocalHttp { endpoint: String },
    SubscriptionNative(Arc<SubscriptionBridgeConfig>),
}

#[derive(Clone)]
pub struct GuestBrokerConfig {
    pub version: u32,
    pub execution_id: String,
    pub authority_epoch: u64,
    pub request_directory: PathBuf,
    pub response_directory: PathBuf,
    pub journal_path: PathBuf,
    pub backend: GuestModelBackend,
    pub model_id: String,
    pub model_pin: String,
    pub max_tokens: u32,
    pub context_window: u32,
    pub allowed_tools: Vec<String>,
    pub deadline_ms: u64,
    pub max_requests: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuestBrokerError {
    InvalidConfig,
    Unauthorized,
    AlreadyRunning,
    UnsafeFilesystem,
    SpoolLimit,
    Journal,
    HttpClient,
    Runtime,
    ThreadStart,
    ThreadPanicked,
    SubscriptionBridge,
}

impl fmt::Display for GuestBrokerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidConfig => "guest broker configuration rejected",
            Self::Unauthorized => "guest broker authority check failed",
            Self::AlreadyRunning => "guest broker is already running",
            Self::UnsafeFilesystem => "guest broker filesystem boundary rejected",
            Self::SpoolLimit => "guest broker spool limit reached",
            Self::Journal => "guest broker journal operation failed",
            Self::HttpClient => "guest broker loopback transport unavailable",
            Self::Runtime => "guest broker runtime failed",
            Self::ThreadStart => "guest broker thread failed to start",
            Self::ThreadPanicked => "guest broker thread panicked",
            Self::SubscriptionBridge => "owned native subscription bridge failed",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for GuestBrokerError {}

type BrokerResult<T> = Result<T, GuestBrokerError>;

pub struct GuestModelBroker {
    stopping: Arc<AtomicBool>,
    native_ready: Option<Arc<SubscriptionReady>>,
    thread: Option<JoinHandle<BrokerResult<()>>>,
}

impl GuestModelBroker {
    pub fn start(
        config: Arc<GuestBrokerConfig>,
        authorization_check: GuestBrokerAuthorizationCheck,
    ) -> BrokerResult<Self> {
        if !authorized(&authorization_check, &config) {
            return Err(GuestBrokerError::Unauthorized);
        }
        validate_config(&config)?;

        let stopping = Arc::new(AtomicBool::new(false));
        let thread_stopping = Arc::clone(&stopping);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("ghost-guest-model-broker".to_owned())
            .spawn(move || broker_thread(config, authorization_check, thread_stopping, ready_tx))
            .map_err(|_| GuestBrokerError::ThreadStart)?;

        let startup = match ready_rx.recv() {
            Ok(startup) => startup,
            Err(_) => {
                stopping.store(true, Ordering::Release);
                let _ = thread.join();
                return Err(GuestBrokerError::ThreadStart);
            }
        };
        match startup {
            Ok(native_ready) => Ok(Self {
                stopping,
                thread: Some(thread),
                native_ready,
            }),
            Err(error) => {
                let _ = thread.join();
                Err(error)
            }
        }
    }

    pub fn native_ready(&self) -> Option<&SubscriptionReady> {
        self.native_ready.as_deref()
    }

    pub fn stop(&mut self) -> BrokerResult<()> {
        self.stopping.store(true, Ordering::Release);
        let Some(thread) = self.thread.take() else {
            return Ok(());
        };
        match thread.join() {
            Ok(result) => result,
            Err(_) => Err(GuestBrokerError::ThreadPanicked),
        }
    }
}

impl Drop for GuestModelBroker {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GuestRequest {
    version: u32,
    request_id: String,
    execution_id: String,
    authority_epoch: u64,
    payload_json: String,
    payload_sha256: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ResponseStatus {
    Completed,
    Rejected,
    EffectUnknown,
}

#[derive(Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct GuestResponse {
    version: u32,
    request_id: String,
    payload_sha256: String,
    status: ResponseStatus,
    http_status: Option<u16>,
    completion_json: Option<String>,
    response_sha256: Option<String>,
    reason_code: Option<String>,
}

struct ExistingReceipt {
    payload_sha256: String,
    execution_id: String,
    authority_epoch: i64,
    status: String,
    response_json: Option<String>,
}

struct DirectoryHandle {
    file: File,
}

struct BrokerResources {
    request: DirectoryHandle,
    response: DirectoryHandle,
    _journal_lock: File,
}


struct CallOutcome {
    response: GuestResponse,
    publish: bool,
}

fn validate_config(config: &GuestBrokerConfig) -> BrokerResult<()> {
    if config.version != CONTRACT_VERSION
        || config.execution_id.is_empty()
        || config.execution_id.len() > 128
        || config.authority_epoch == 0
        || config.authority_epoch > SAFE_JS_INTEGER
        || config.model_id.is_empty()
        || config.model_id.len() > 128
        || config.model_id.chars().any(|value| value.is_whitespace() || value.is_control())
        || config.model_id != config.model_pin
        || !is_exact_worker_tool_scope(&config.allowed_tools)
    {
        return Err(GuestBrokerError::InvalidConfig);
    }
    validate_registered_route(
        &config.backend,
        &config.model_id,
        config.max_tokens,
        config.context_window,
        config.deadline_ms,
        config.max_requests,
    )?;
    validate_canonical_directory(&config.request_directory)?;
    validate_canonical_directory(&config.response_directory)?;
    if config.request_directory == config.response_directory
        || config.request_directory.starts_with(&config.response_directory)
        || config.response_directory.starts_with(&config.request_directory)
    {
        return Err(GuestBrokerError::InvalidConfig);
    }
    validate_journal_path(&config.journal_path, config)?;
    Ok(())
}

pub(crate) fn validate_registered_route(
    backend: &GuestModelBackend,
    model_id: &str,
    max_tokens: u32,
    context_window: u32,
    deadline_ms: u64,
    max_requests: u32,
) -> BrokerResult<()> {
    if model_id.is_empty()
        || model_id.len() > 128
        || model_id.chars().any(|value| value.is_whitespace() || value.is_control())
        || max_tokens == 0
        || context_window < max_tokens
        || deadline_ms == 0
        || deadline_ms > 180_000
        || !(1..=16).contains(&max_requests)
    {
        return Err(GuestBrokerError::InvalidConfig);
    }
    match backend {
        GuestModelBackend::LocalHttp { endpoint } => {
            if max_tokens > 4096 || context_window > 16_384 {
                return Err(GuestBrokerError::InvalidConfig);
            }
            validate_loopback_endpoint(endpoint)
        }
        GuestModelBackend::SubscriptionNative(bridge) => {
            if model_id != "gpt-6-luna"
                || max_tokens != 1024
                || context_window != 272000
                || deadline_ms != 180_000
                || max_requests != 16
            {
                return Err(GuestBrokerError::InvalidConfig);
            }
            bridge.validate()
        }
    }
}

fn validate_loopback_endpoint(endpoint: &str) -> BrokerResult<()> {
    let url = Url::parse(endpoint).map_err(|_| GuestBrokerError::InvalidConfig)?;
    let host = url
        .host_str()
        .and_then(|value| value.parse::<IpAddr>().ok())
        .ok_or(GuestBrokerError::InvalidConfig)?;
    if !host.is_loopback()
        || !matches!(url.scheme(), "http" | "https")
        || url.port().is_none()
        || url.path() != "/v1"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(GuestBrokerError::InvalidConfig);
    }
    Ok(())
}

fn validate_canonical_directory(path: &Path) -> BrokerResult<()> {
    if !path.is_absolute() {
        return Err(GuestBrokerError::InvalidConfig);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| GuestBrokerError::InvalidConfig)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(GuestBrokerError::InvalidConfig);
    }
    let canonical = fs::canonicalize(path).map_err(|_| GuestBrokerError::InvalidConfig)?;
    if canonical != path {
        return Err(GuestBrokerError::InvalidConfig);
    }
    Ok(())
}

fn validate_journal_path(path: &Path, config: &GuestBrokerConfig) -> BrokerResult<()> {
    if !path.is_absolute() {
        return Err(GuestBrokerError::InvalidConfig);
    }
    let parent = path.parent().ok_or(GuestBrokerError::InvalidConfig)?;
    validate_canonical_directory(parent)?;
    let parent_metadata = fs::metadata(parent).map_err(|_| GuestBrokerError::InvalidConfig)?;
    if parent_metadata.mode() & 0o077 != 0 {
        return Err(GuestBrokerError::UnsafeFilesystem);
    }
    let file_name = path.file_name().ok_or(GuestBrokerError::InvalidConfig)?;
    if file_name.is_empty()
        || path.starts_with(&config.request_directory)
        || path.starts_with(&config.response_directory)
    {
        return Err(GuestBrokerError::InvalidConfig);
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.nlink() != 1 {
                return Err(GuestBrokerError::UnsafeFilesystem);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(GuestBrokerError::InvalidConfig),
    }
    Ok(())
}

fn authorized(check: &GuestBrokerAuthorizationCheck, config: &GuestBrokerConfig) -> bool {
    catch_unwind(AssertUnwindSafe(|| check(&config.execution_id, config.authority_epoch)))
        .unwrap_or(false)
}

fn broker_thread(
    config: Arc<GuestBrokerConfig>,
    authorization_check: GuestBrokerAuthorizationCheck,
    stopping: Arc<AtomicBool>,
    ready: mpsc::SyncSender<BrokerResult<Option<Arc<SubscriptionReady>>>>,
) -> BrokerResult<()> {
    let startup = (|| {
        let resources = open_resources(&config)?;
        let mut journal = open_journal(&config)?;
        recover_pending(&mut journal)?;
        let client = match &config.backend {
            GuestModelBackend::LocalHttp { .. } => Some(Client::builder()
                .no_proxy().redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(3)).build()
                .map_err(|_| GuestBrokerError::HttpClient)?),
            GuestModelBackend::SubscriptionNative(_) => None,
        };
        let runtime = Builder::new_current_thread().enable_all().build()
            .map_err(|_| GuestBrokerError::Runtime)?;
        Ok((resources, journal, client, runtime))
    })();
    let (resources, mut journal, client, runtime) = match startup {
        Ok(resources) => resources,
        Err(error) => {
            let _ = ready.send(Err(error));
            return Err(error);
        }
    };
    runtime.block_on(async {
        let mut native = match &config.backend {
            GuestModelBackend::SubscriptionNative(bridge) => {
                match SubscriptionBridge::start(bridge, config.deadline_ms).await {
                    Ok(bridge) => Some(bridge),
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return Err(error);
                    }
                }
            }
            GuestModelBackend::LocalHttp { .. } => None,
        };
        if !authorized(&authorization_check, &config) || stopping.load(Ordering::Acquire) {
            if let Some(bridge) = native.as_mut() { bridge.stop().await?; }
            let _ = ready.send(Err(GuestBrokerError::Unauthorized));
            return Err(GuestBrokerError::Unauthorized);
        }
        let native_ready = native.as_ref().map(|bridge| Arc::clone(&bridge.ready));
        if ready.send(Ok(native_ready)).is_err() {
            if let Some(bridge) = native.as_mut() { bridge.stop().await?; }
            return Err(GuestBrokerError::ThreadStart);
        }
        let processing = async {
            while !stopping.load(Ordering::Acquire) {
                let names = list_names(&resources.request)?;
                for name in names {
                    if stopping.load(Ordering::Acquire) { break; }
                    if !name.ends_with(".request.json") { continue; }
                    handle_request(&config, &authorization_check, &stopping, &resources,
                        &mut journal, client.as_ref(), native.as_mut(), &name).await?;
                }
                if !stopping.load(Ordering::Acquire) { sleep(POLL_INTERVAL).await; }
            }
            Ok(())
        }.await;
        let reaped = match native.as_mut() {
            Some(bridge) => bridge.stop().await,
            None => Ok(()),
        };
        processing.and(reaped)
    })
}

fn open_resources(config: &GuestBrokerConfig) -> BrokerResult<BrokerResources> {
    let request = open_directory(&config.request_directory)?;
    let response = open_directory(&config.response_directory)?;
    if response.file.metadata().map_err(|_| GuestBrokerError::UnsafeFilesystem)?.mode() & 0o077 != 0 {
        return Err(GuestBrokerError::UnsafeFilesystem);
    }
    let lock_path = append_suffix(&config.journal_path, ".lock");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(lock_path)
        .map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
    let metadata = lock
        .metadata()
        .map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(GuestBrokerError::UnsafeFilesystem);
    }
    lock.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
    let locked = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if locked != 0 {
        return Err(GuestBrokerError::AlreadyRunning);
    }
    Ok(BrokerResources {
        request,
        response,
        _journal_lock: lock,
    })
}

fn open_directory(path: &Path) -> BrokerResult<DirectoryHandle> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
    if !file.metadata().map_err(|_| GuestBrokerError::UnsafeFilesystem)?.is_dir() {
        return Err(GuestBrokerError::UnsafeFilesystem);
    }
    Ok(DirectoryHandle { file })
}

fn open_journal(config: &GuestBrokerConfig) -> BrokerResult<Connection> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&config.journal_path)
        .map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
    let metadata = file
        .metadata()
        .map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(GuestBrokerError::UnsafeFilesystem);
    }
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
    drop(file);

    let connection = Connection::open_with_flags(
        &config.journal_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| GuestBrokerError::Journal)?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=DELETE;
             PRAGMA synchronous=FULL;
             PRAGMA foreign_keys=ON;
             PRAGMA trusted_schema=OFF;
             PRAGMA max_page_count=40960;
             CREATE TABLE IF NOT EXISTS requests (
                 request_id TEXT PRIMARY KEY NOT NULL,
                 payload_sha256 TEXT NOT NULL,
                 execution_id TEXT NOT NULL,
                 authority_epoch INTEGER NOT NULL,
                 status TEXT NOT NULL CHECK(status IN ('pending','completed','rejected','effect_unknown')),
                 response_json TEXT
             );",
        )
        .map_err(|_| GuestBrokerError::Journal)?;
    Ok(connection)
}


fn recover_pending(connection: &mut Connection) -> BrokerResult<()> {
    let pending = {
        let mut statement = connection
            .prepare(
                "SELECT request_id, payload_sha256
                 FROM requests WHERE status='pending' ORDER BY request_id",
            )
            .map_err(|_| GuestBrokerError::Journal)?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|_| GuestBrokerError::Journal)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| GuestBrokerError::Journal)?;
        rows
    };
    if pending.is_empty() {
        return Ok(());
    }
    let transaction = connection
        .transaction()
        .map_err(|_| GuestBrokerError::Journal)?;
    for (request_id, payload_sha256) in pending {
        let response = make_response(
            &request_id,
            &payload_sha256,
            ResponseStatus::EffectUnknown,
            None,
            None,
            Some("restart_pending"),
        );
        let response_json = serde_json::to_string(&response).map_err(|_| GuestBrokerError::Journal)?;
        transaction
            .execute(
                "UPDATE requests SET status='effect_unknown', response_json=?1
                 WHERE request_id=?2 AND status='pending'",
                params![response_json, request_id],
            )
            .map_err(|_| GuestBrokerError::Journal)?;
    }
    transaction.commit().map_err(|_| GuestBrokerError::Journal)
}

fn list_names(directory: &DirectoryHandle) -> BrokerResult<Vec<String>> {
    let mut names = list_names_without_size(directory)?;
    names.sort_unstable();
    check_request_spool(directory, &names)?;
    Ok(names)
}

fn check_request_spool(directory: &DirectoryHandle, names: &[String]) -> BrokerResult<()> {
    let mut total = 0_u64;
    for name in names {
        let name = CString::new(name.as_bytes()).map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
        let mut metadata = unsafe { std::mem::zeroed::<libc::stat>() };
        let result = unsafe {
            libc::fstatat(
                directory.file.as_raw_fd(),
                name.as_ptr(),
                &mut metadata,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result != 0 {
            continue;
        }
        if metadata.st_size > 0 {
            total = total.saturating_add(metadata.st_size as u64);
        }
        if total > MAX_REQUEST_SPOOL_BYTES {
            return Err(GuestBrokerError::SpoolLimit);
        }
    }
    Ok(())
}

async fn handle_request(
    config: &GuestBrokerConfig,
    authorization_check: &GuestBrokerAuthorizationCheck,
    stopping: &AtomicBool,
    resources: &BrokerResources,
    journal: &mut Connection,
    client: Option<&Client>,
    native: Option<&mut SubscriptionBridge>,
    filename: &str,
) -> BrokerResult<()> {
    let Some(request_id) = filename.strip_suffix(".request.json") else {
        return Ok(());
    };
    let parsed_id = match Uuid::parse_str(request_id) {
        Ok(id) if id.to_string() == request_id => id,
        _ => return Ok(()),
    };
    let canonical_id = parsed_id.to_string();
    let request_bytes = match read_at(&resources.request, filename, MAX_REQUEST_FILE_BYTES) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(()),
        Err(GuestBrokerError::UnsafeFilesystem) => return Ok(()),
        Err(error) => return Err(error),
    };
    let request: GuestRequest = match serde_json::from_slice(&request_bytes) {
        Ok(request) => request,
        Err(_) => return Ok(()),
    };
    if request.version != CONTRACT_VERSION
        || request.request_id != canonical_id
        || request.execution_id != config.execution_id
        || request.authority_epoch != config.authority_epoch
        || request.payload_json.len() > MAX_PAYLOAD_BYTES
        || !is_sha256(&request.payload_sha256)
        || sha256(request.payload_json.as_bytes()) != request.payload_sha256
    {
        return Ok(());
    }
    if !authorized(authorization_check, config) {
        return Ok(());
    }

    if let Some(existing) = get_receipt(journal, &canonical_id)? {
        if existing.execution_id != config.execution_id
            || existing.authority_epoch != config.authority_epoch as i64
            || existing.payload_sha256 != request.payload_sha256
        {
            return Ok(());
        }
        if existing.status == "pending" {
            let response = make_response(
                &canonical_id,
                &request.payload_sha256,
                ResponseStatus::EffectUnknown,
                None,
                None,
                Some("restart_pending"),
            );
            persist_response(journal, &canonical_id, &request.payload_sha256, &response)?;
            if authorized(authorization_check, config) {
                publish_response(config, resources, &response)?;
                remove_request_files(resources, &canonical_id)?;
            }
            return Ok(());
        }
        let Some(response_json) = existing.response_json else {
            return Err(GuestBrokerError::Journal);
        };
        let response = decode_stored_response(&response_json, &canonical_id, &request.payload_sha256, config)?;
        let stored_status = match response.status {
            ResponseStatus::Completed => "completed",
            ResponseStatus::Rejected => "rejected",
            ResponseStatus::EffectUnknown => "effect_unknown",
        };
        if existing.status != stored_status {
            return Err(GuestBrokerError::Journal);
        }
        if response.status == ResponseStatus::Completed
            && cancellation_matches(resources, &canonical_id, &request.payload_sha256)?
        {
            let unknown = make_response(
                &canonical_id,
                &request.payload_sha256,
                ResponseStatus::EffectUnknown,
                response.http_status,
                None,
                Some("cancelled_in_flight"),
            );
            persist_response(journal, &canonical_id, &request.payload_sha256, &unknown)?;
            if authorized(authorization_check, config) {
                publish_response(config, resources, &unknown)?;
                remove_request_files(resources, &canonical_id)?;
            }
            return Ok(());
        }
        if authorized(authorization_check, config) {
            publish_response(config, resources, &response)?;
            remove_request_files(resources, &canonical_id)?;
        }
        return Ok(());
    }

    let response_filename = format!("{canonical_id}.response.json");
    match read_at(&resources.response, &response_filename, MAX_RESPONSE_FILE_BYTES) {
        Ok(None) => {}
        Ok(Some(_)) | Err(GuestBrokerError::UnsafeFilesystem) => return Ok(()),
        Err(error) => return Err(error),
    }

    if journal_row_count(journal)? >= MAX_JOURNAL_ROWS {
        let response = make_response(
            &canonical_id,
            &request.payload_sha256,
            ResponseStatus::Rejected,
            None,
            None,
            Some("request_limit"),
        );
        if authorized(authorization_check, config) {
            publish_response(config, resources, &response)?;
            remove_request_files(resources, &canonical_id)?;
        }
        return Ok(());
    }
    let validated = match &config.backend {
        GuestModelBackend::LocalHttp { .. } => validate_payload(&request.payload_json, config),
        GuestModelBackend::SubscriptionNative(_) => native.as_ref().ok_or(()).and_then(|bridge|
            validate_native_payload(&request.payload_json, config, &bridge.ready.resolved_reasoning)),
    };
    let payload = match validated {
        Ok(payload) => payload,
        Err(()) => {
            let response = make_response(
                &canonical_id,
                &request.payload_sha256,
                ResponseStatus::Rejected,
                None,
                None,
                Some("invalid_payload"),
            );
            persist_new_response(journal, &request, "rejected", &response)?;
            if authorized(authorization_check, config) {
                publish_response(config, resources, &response)?;
                remove_request_files(resources, &canonical_id)?;
            }
            return Ok(());
        }
    };

    if accepted_count(journal)? >= i64::from(config.max_requests) {
        let response = make_response(
            &canonical_id,
            &request.payload_sha256,
            ResponseStatus::Rejected,
            None,
            None,
            Some("request_limit"),
        );
        persist_new_response(journal, &request, "rejected", &response)?;
        if authorized(authorization_check, config) {
            publish_response(config, resources, &response)?;
            remove_request_files(resources, &canonical_id)?;
        }
        return Ok(());
    }

    persist_pending(journal, &request)?;
    let outcome = call_model(config, authorization_check, stopping, resources, client, native, &request.payload_json, &canonical_id, &request.payload_sha256, payload)
    .await?;
    persist_response(
        journal,
        &canonical_id,
        &request.payload_sha256,
        &outcome.response,
    )?;

    if !outcome.publish || stopping.load(Ordering::Acquire) {
        return Ok(());
    }
    if !authorized(authorization_check, config) {
        let unknown = make_response(
            &canonical_id,
            &request.payload_sha256,
            ResponseStatus::EffectUnknown,
            outcome.response.http_status,
            None,
            Some("scope_revoked"),
        );
        persist_response(journal, &canonical_id, &request.payload_sha256, &unknown)?;
        return Ok(());
    }
    if outcome.response.status == ResponseStatus::Completed
        && cancellation_matches(resources, &canonical_id, &request.payload_sha256)?
    {
        let unknown = make_response(
            &canonical_id,
            &request.payload_sha256,
            ResponseStatus::EffectUnknown,
            outcome.response.http_status,
            None,
            Some("cancelled_in_flight"),
        );
        persist_response(journal, &canonical_id, &request.payload_sha256, &unknown)?;
        if authorized(authorization_check, config) {
            publish_response(config, resources, &unknown)?;
            remove_request_files(resources, &canonical_id)?;
        }
        return Ok(());
    }
    if authorized(authorization_check, config) {
        publish_response(config, resources, &outcome.response)?;
        remove_request_files(resources, &canonical_id)?;
    }
    Ok(())
}

async fn call_model(
    config: &GuestBrokerConfig,
    authorization_check: &GuestBrokerAuthorizationCheck,
    stopping: &AtomicBool,
    resources: &BrokerResources,
    client: Option<&Client>,
    native: Option<&mut SubscriptionBridge>,
    payload_json: &str,
    request_id: &str,
    payload_sha256: &str,
    payload: Value,
) -> BrokerResult<CallOutcome> {
    let deadline = Instant::now() + Duration::from_millis(config.deadline_ms);

    if stopping.load(Ordering::Acquire) {
        return Ok(unknown_outcome(request_id, payload_sha256, None, "broker_stopped", false));
    }
    if cancellation_matches(resources, request_id, payload_sha256)? {
        return Ok(rejected_outcome(request_id, payload_sha256, "cancelled_before_io", true));
    }
    if !authorized(authorization_check, config) {
        return Ok(rejected_outcome(request_id, payload_sha256, "authorization_denied", false));
    }
    if Instant::now() >= deadline {
        return Ok(rejected_outcome(request_id, payload_sha256, "deadline_before_io", true));
    }
    if let Some(bridge) = native {
        let response = bridge.request(request_id, &config.execution_id, config.authority_epoch,
            payload_json, payload_sha256, deadline, stopping, || {
                authorized(authorization_check, config)
                    && !cancellation_matches(resources, request_id, payload_sha256).unwrap_or(true)
            }).await;
        let publish = !stopping.load(Ordering::Acquire) && authorized(authorization_check, config);
        let response = match response {
            Ok(response) => response,
            Err(_) => {
                bridge.stop().await?;
                return Ok(unknown_outcome(request_id, payload_sha256, None, "native_transport_error", publish));
            }
        };
        match response.status.as_str() {
            "completed" => {
                if response.reason_code.is_some() {
                    return Ok(unknown_outcome(request_id, payload_sha256, None, "upstream_invalid_response", publish));
                }
                let Some(message) = response.message_json else {
                    return Ok(unknown_outcome(request_id, payload_sha256, None, "upstream_invalid_response", publish));
                };
                let Some(digest) = response.message_sha256 else {
                    return Ok(unknown_outcome(request_id, payload_sha256, None, "upstream_invalid_response", publish));
                };
                if message.len() > MAX_COMPLETION_BYTES || !is_sha256(&digest)
                    || sha256(message.as_bytes()) != digest
                    || !serde_json::from_str::<Value>(&message).is_ok_and(|value| valid_native_message(&value, config)) {
                    return Ok(unknown_outcome(request_id, payload_sha256, None, "upstream_invalid_response", publish));
                }
                return Ok(CallOutcome { response: make_response(request_id, payload_sha256,
                    ResponseStatus::Completed, None, Some((message, digest)), None), publish });
            }
            "rejected" | "effect_unknown" if response.message_json.is_none()
                && response.message_sha256.is_none() && response.reason_code.is_some() => {
                return Ok(if response.status == "rejected" {
                    rejected_outcome(request_id, payload_sha256, "native_rejected", publish)
                } else {
                    unknown_outcome(request_id, payload_sha256, None, "native_effect_unknown", publish)
                });
            }
            _ => return Ok(unknown_outcome(request_id, payload_sha256, None, "upstream_invalid_response", publish)),
        }
    }
    let GuestModelBackend::LocalHttp { endpoint } = &config.backend else {
        return Err(GuestBrokerError::SubscriptionBridge);
    };
    let client = client.ok_or(GuestBrokerError::HttpClient)?;
    let upstream_body = upstream_body(payload)?;
    let url = upstream_url(endpoint)?;

    let send = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .body(upstream_body)
        .send();
    tokio::pin!(send);
    let mut response = loop {
        tokio::select! {
            result = &mut send => {
                match result {
                    Ok(response) => break response,
                    Err(_) => return Ok(unknown_outcome(request_id, payload_sha256, None, "upstream_transport_error", true)),
                }
            }
            _ = sleep(POLL_INTERVAL) => {
                if let Some(outcome) = in_flight_abort(
                    config, authorization_check, stopping, resources,
                    request_id, payload_sha256, None, deadline,
                )? {
                    return Ok(outcome);
                }
            }
        }
    };

    let status = response.status();
    if !status.is_success() {
        return Ok(unknown_outcome(
            request_id,
            payload_sha256,
            Some(status.as_u16()),
            "upstream_http_error",
            true,
        ));
    }

    let mut body = Vec::new();
    loop {
        tokio::select! {
            chunk = response.chunk() => {
                match chunk {
                    Ok(Some(bytes)) => {
                        if body.len().saturating_add(bytes.len()) > MAX_COMPLETION_BYTES {
                            return Ok(unknown_outcome(request_id, payload_sha256, Some(status.as_u16()), "upstream_invalid_response", true));
                        }
                        body.extend_from_slice(&bytes);
                    }
                    Ok(None) => break,
                    Err(_) => return Ok(unknown_outcome(request_id, payload_sha256, Some(status.as_u16()), "upstream_transport_error", true)),
                }
            }
            _ = sleep(POLL_INTERVAL) => {
                if let Some(outcome) = in_flight_abort(
                    config, authorization_check, stopping, resources,
                    request_id, payload_sha256, Some(status.as_u16()), deadline,
                )? {
                    return Ok(outcome);
                }
            }
        }
    }

    if stopping.load(Ordering::Acquire) {
        return Ok(unknown_outcome(request_id, payload_sha256, Some(status.as_u16()), "broker_stopped", false));
    }
    if cancellation_matches(resources, request_id, payload_sha256)? {
        return Ok(unknown_outcome(request_id, payload_sha256, Some(status.as_u16()), "cancelled_in_flight", true));
    }
    if !authorized(authorization_check, config) {
        return Ok(unknown_outcome(request_id, payload_sha256, Some(status.as_u16()), "scope_revoked", false));
    }

    let completion_json = match String::from_utf8(body) {
        Ok(completion) => completion,
        Err(_) => return Ok(unknown_outcome(request_id, payload_sha256, Some(status.as_u16()), "upstream_invalid_response", true)),
    };
    let completion: Value = match serde_json::from_str(&completion_json) {
        Ok(Value::Object(object)) => Value::Object(object),
        _ => return Ok(unknown_outcome(request_id, payload_sha256, Some(status.as_u16()), "upstream_invalid_response", true)),
    };
    if completion.get("model").and_then(Value::as_str) != Some(config.model_id.as_str()) {
        return Ok(unknown_outcome(request_id, payload_sha256, Some(status.as_u16()), "upstream_invalid_response", true));
    }
    let response_sha256 = sha256(completion_json.as_bytes());
    Ok(CallOutcome {
        response: make_response(
            request_id,
            payload_sha256,
            ResponseStatus::Completed,
            Some(status.as_u16()),
            Some((completion_json, response_sha256)),
            None,
        ),
        publish: true,
    })
}

fn in_flight_abort(
    config: &GuestBrokerConfig,
    authorization_check: &GuestBrokerAuthorizationCheck,
    stopping: &AtomicBool,
    resources: &BrokerResources,
    request_id: &str,
    payload_sha256: &str,
    http_status: Option<u16>,
    deadline: Instant,
) -> BrokerResult<Option<CallOutcome>> {
    if stopping.load(Ordering::Acquire) {
        return Ok(Some(unknown_outcome(request_id, payload_sha256, http_status, "broker_stopped", false)));
    }
    if cancellation_matches(resources, request_id, payload_sha256)? {
        return Ok(Some(unknown_outcome(request_id, payload_sha256, http_status, "cancelled_in_flight", true)));
    }
    if !authorized(authorization_check, config) {
        return Ok(Some(unknown_outcome(request_id, payload_sha256, http_status, "scope_revoked", false)));
    }
    if Instant::now() >= deadline {
        return Ok(Some(unknown_outcome(request_id, payload_sha256, http_status, "upstream_timeout", true)));
    }
    Ok(None)
}

fn upstream_body(mut payload: Value) -> BrokerResult<Vec<u8>> {
    let object = payload
        .as_object_mut()
        .ok_or(GuestBrokerError::InvalidConfig)?;
    object.insert("stream".to_owned(), Value::Bool(false));
    object.remove("stream_options");
    // This protected route accepts only the off descriptor. Dyno's installed
    // OpenAI surface requires an explicit none to disable its thinking template.
    object.insert("reasoning_effort".to_owned(), Value::String("none".to_owned()));
    serde_json::to_vec(&payload).map_err(|_| GuestBrokerError::InvalidConfig)
}

fn upstream_url(endpoint: &str) -> BrokerResult<Url> {
    let mut url = Url::parse(endpoint).map_err(|_| GuestBrokerError::InvalidConfig)?;
    url.set_path("/v1/chat/completions");
    Ok(url)
}

fn validate_native_payload(payload_json: &str, config: &GuestBrokerConfig, reasoning: &str) -> Result<Value, ()> {
    if payload_json.len() > MAX_PAYLOAD_BYTES {
        return Err(());
    }
    let value: Value = serde_json::from_str(payload_json).map_err(|_| ())?;
    let object = value.as_object().ok_or(())?;
    if object.len() != 4
        || object.keys().any(|key| !["modelId", "context", "options", "stream"].contains(&key.as_str()))
        || object.get("modelId").and_then(Value::as_str) != Some("openai-codex/gpt-6-luna")
        || object.get("stream").and_then(Value::as_bool) != Some(true) {
        return Err(());
    }
    let options = object.get("options").and_then(Value::as_object).ok_or(())?;
    if options.len() != 2 || options.get("maxTokens").and_then(Value::as_u64) != Some(1024)
        || options.get("reasoning").and_then(Value::as_str) != Some(reasoning) {
        return Err(());
    }
    let context = object.get("context").and_then(Value::as_object).ok_or(())?;
    if context.keys().any(|key| !["systemPrompt", "messages", "tools"].contains(&key.as_str())) {
        return Err(());
    }
    if context.get("systemPrompt").is_some_and(|prompt|
        prompt.as_array().is_none_or(|rows| rows.iter().any(|row| !row.is_string()))) {
        return Err(());
    }
    let messages = context.get("messages").and_then(Value::as_array).ok_or(())?;
    if messages.is_empty() || messages.len() > 1024 { return Err(()); }
    for message in messages {
        let role = message.get("role").and_then(Value::as_str).ok_or(())?;
        if !["user", "developer", "assistant", "toolResult"].contains(&role) { return Err(()); }
        if role == "assistant" && (message.get("provider").and_then(Value::as_str) != Some("openai-codex")
            || message.get("model").and_then(Value::as_str) != Some("gpt-6-luna")) { return Err(()); }
        if role == "toolResult" && !config.allowed_tools.iter().any(|tool|
            Some(tool.as_str()) == message.get("toolName").and_then(Value::as_str)) { return Err(()); }
        if let Some(content) = message.get("content").and_then(Value::as_array) {
            for block in content {
                if block.get("url").is_some() || block.get("providerFile").is_some()
                    || block.get("providerMetadata").is_some()
                    || block.get("type").and_then(Value::as_str).is_none_or(|kind|
                        !["text", "thinking", "redactedThinking", "image", "toolCall"].contains(&kind)) {
                    return Err(());
                }
                if block.get("type").and_then(Value::as_str) == Some("toolCall")
                    && !config.allowed_tools.iter().any(|tool|
                        Some(tool.as_str()) == block.get("name").and_then(Value::as_str)) { return Err(()); }
            }
        } else if !message.get("content").is_some_and(Value::is_string) { return Err(()); }
    }
    if let Some(tools) = context.get("tools") {
        let tools = tools.as_array().ok_or(())?;
        if tools.len() > config.allowed_tools.len() { return Err(()); }
        for (index, tool) in tools.iter().enumerate() {
            let tool = tool.as_object().ok_or(())?;
            if tool.keys().any(|key| !["name", "description", "parameters", "strict", "deferLoading", "customFormat", "customWireName", "examples"].contains(&key.as_str()))
                || !tool.get("description").is_some_and(Value::is_string)
                || !tool.get("parameters").is_some_and(Value::is_object) { return Err(()); }
            let name = tool.get("name").and_then(Value::as_str).ok_or(())?;
            if let Some(format) = tool.get("customFormat") {
                let format = format.as_object().ok_or(())?;
                if name != "edit" || format.len() != 2
                    || format.get("syntax").and_then(Value::as_str) != Some("lark")
                    || format.get("definition").and_then(Value::as_str).is_none_or(str::is_empty) {
                    return Err(());
                }
            }
            if tool.get("strict").is_some_and(|value| !value.is_boolean())
                || tool.get("deferLoading").is_some_and(|value| !value.is_boolean())
                || tool.get("examples").is_some_and(|value| !value.is_array())
                || tool.get("customWireName").is_some_and(|value| value.as_str() != Some(name)) {
                return Err(());
            }
            if !config.allowed_tools.iter().any(|allowed| allowed == name)
                || tools[..index].iter().any(|prior| prior.get("name").and_then(Value::as_str) == Some(name)) {
                return Err(());
            }
        }
    }
    Ok(value)
}

fn valid_native_message(value: &Value, config: &GuestBrokerConfig) -> bool {
    if value.get("role").and_then(Value::as_str) != Some("assistant")
        || value.get("api").and_then(Value::as_str) != Some("openai-codex-responses")
        || value.get("provider").and_then(Value::as_str) != Some("openai-codex")
        || value.get("model").and_then(Value::as_str) != Some(config.model_id.as_str())
        || value.get("upstreamModel").is_some_and(|model| model.as_str() != Some(config.model_id.as_str()))
        || value.get("stopReason").and_then(Value::as_str).is_none_or(|reason|
            !["stop", "length", "toolUse"].contains(&reason))
        || value.get("errorMessage").is_some() || value.get("fallbackCreditHandle").is_some()
        || value.get("retryRecovery").is_some() || !value.get("usage").is_some_and(Value::is_object) {
        return false;
    }
    let Some(content) = value.get("content").and_then(Value::as_array) else { return false; };
    content.iter().all(|block| match block.get("type").and_then(Value::as_str) {
        Some("text") => block.get("text").is_some_and(Value::is_string),
        Some("thinking") => block.get("thinking").is_some_and(Value::is_string),
        Some("redactedThinking") => block.get("data").is_some_and(Value::is_string),
        Some("toolCall") => block.get("id").is_some_and(Value::is_string)
            && block.get("arguments").is_some_and(Value::is_object)
            && block.get("providerMetadata").is_none()
            && config.allowed_tools.iter().any(|tool| Some(tool.as_str()) == block.get("name").and_then(Value::as_str)),
        _ => false,
    })
}

fn validate_payload(payload_json: &str, config: &GuestBrokerConfig) -> Result<Value, ()> {
    if payload_json.len() > MAX_PAYLOAD_BYTES {
        return Err(());
    }
    let value: Value = serde_json::from_str(payload_json).map_err(|_| ())?;
    let object = value.as_object().ok_or(())?;
    const ALLOWED_FIELDS: &[&str] = &[
        "model",
        "messages",
        "stream",
        "stream_options",
        "max_tokens",
        "tools",
        "tool_choice",
        "preserve_thinking",
        "chat_template_kwargs",
    ];
    if object.keys().any(|key| !ALLOWED_FIELDS.contains(&key.as_str()))
        || object.get("model").and_then(Value::as_str) != Some(config.model_id.as_str())
        || object.get("stream").and_then(Value::as_bool) != Some(true)
        || object.get("max_tokens").and_then(Value::as_u64) != Some(u64::from(config.max_tokens))
    {
        return Err(());
    }
    if let Some(options) = object.get("stream_options") {
        let Some(options) = options.as_object() else {
            return Err(());
        };
        if options.len() != 1 || options.get("include_usage").and_then(Value::as_bool) != Some(true) {
            return Err(());
        }
    }
    // The pinned Qwen3.6 SDK emits this paired tool-history policy. Do not
    // accept arbitrary chat-template switches or a guest-selected downgrade.
    match (object.get("preserve_thinking"), object.get("chat_template_kwargs")) {
        (None, None) => {}
        (Some(Value::Bool(true)), Some(Value::Object(kwargs)))
            if kwargs.len() == 1 && kwargs.get("preserve_thinking") == Some(&Value::Bool(true)) => {}
        _ => return Err(()),
    }
    let allowed_tools = config.allowed_tools.as_slice();
    let messages = object.get("messages").and_then(Value::as_array).ok_or(())?;
    if messages.is_empty() || messages.len() > 256 || messages.iter().any(|message| !valid_message(message, allowed_tools)) {
        return Err(());
    }
    if let Some(tools) = object.get("tools") {
        let tools = tools.as_array().ok_or(())?;
        if tools.len() > allowed_tools.len() {
            return Err(());
        }
        let mut names = BTreeSet::new();
        for tool in tools {
            let tool = tool.as_object().ok_or(())?;
            if tool.keys().any(|key| key != "type" && key != "function")
                || tool.get("type").and_then(Value::as_str) != Some("function")
            {
                return Err(());
            }
            let function = tool.get("function").and_then(Value::as_object).ok_or(())?;
            if function.keys().any(|key| !["name", "description", "parameters", "strict"].contains(&key.as_str())) {
                return Err(());
            }
            let name = function.get("name").and_then(Value::as_str).ok_or(())?;
            if !allowed_tools.iter().any(|allowed| allowed.as_str() == name) || !names.insert(name) {
                return Err(());
            }
            if function.get("parameters").and_then(Value::as_object).is_none() {
                return Err(());
            }
            if function.get("description").is_some_and(|value| !value.is_string())
                || function.get("strict").is_some_and(|value| !value.is_boolean())
            {
                return Err(());
            }
        }
    }
    if let Some(choice) = object.get("tool_choice") {
        let valid = match choice {
            Value::String(value) => ["auto", "none", "required"].contains(&value.as_str()),
            Value::Object(choice) => {
                choice.len() == 2
                    && choice.get("type").and_then(Value::as_str) == Some("function")
                    && choice
                        .get("function")
                        .and_then(Value::as_object)
                        .is_some_and(|function| {
                            function.len() == 1
                                && function
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .is_some_and(|name| allowed_tools.iter().any(|allowed| allowed.as_str() == name))
                        })
            }
            _ => false,
        };
        if !valid {
            return Err(());
        }
    }
    Ok(value)
}

fn valid_message(message: &Value, allowed_tools: &[String]) -> bool {
    let Some(message) = message.as_object() else {
        return false;
    };
    if message.keys().any(|key| !["role", "content", "name", "tool_calls", "tool_call_id"].contains(&key.as_str())) {
        return false;
    }
    let Some(role) = message.get("role").and_then(Value::as_str) else {
        return false;
    };
    if !["system", "developer", "user", "assistant", "tool"].contains(&role) {
        return false;
    }
    if message.get("content").is_some_and(|content| !valid_content(content)) {
        return false;
    }
    if let Some(name) = message.get("name") {
        if !name.as_str().is_some_and(|name| allowed_tools.iter().any(|allowed| allowed.as_str() == name)) {
            return false;
        }
    }
    if let Some(tool_call_id) = message.get("tool_call_id") {
        if !tool_call_id.as_str().is_some_and(|id| !id.is_empty() && id.len() <= 256) {
            return false;
        }
    }
    if let Some(calls) = message.get("tool_calls") {
        let Some(calls) = calls.as_array() else {
            return false;
        };
        if calls.is_empty() || calls.len() > allowed_tools.len() {
            return false;
        }
        for call in calls {
            let Some(call) = call.as_object() else {
                return false;
            };
            if call.keys().any(|key| !["id", "type", "function"].contains(&key.as_str()))
                || call.get("type").and_then(Value::as_str) != Some("function")
                || !call.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty() && id.len() <= 256)
            {
                return false;
            }
            let Some(function) = call.get("function").and_then(Value::as_object) else {
                return false;
            };
            if function.keys().any(|key| key != "name" && key != "arguments")
                || !function
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| allowed_tools.iter().any(|allowed| allowed.as_str() == name))
                || !function.get("arguments").and_then(Value::as_str).is_some_and(|arguments| {
                    serde_json::from_str::<Value>(arguments)
                        .ok()
                        .is_some_and(|value| value.is_object())
                })
            {
                return false;
            }
        }
    }
    true
}

fn valid_content(content: &Value) -> bool {
    if content.is_null() || content.is_string() {
        return true;
    }
    let Some(parts) = content.as_array() else {
        return false;
    };
    parts.iter().all(|part| {
        let Some(part) = part.as_object() else {
            return false;
        };
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                part.len() == 2
                    && part.get("text").and_then(Value::as_str).is_some()
            }
            Some("image_url") => {
                if part.keys().any(|key| key != "type" && key != "image_url") {
                    return false;
                }
                let Some(image) = part.get("image_url").and_then(Value::as_object) else {
                    return false;
                };
                if image.keys().any(|key| key != "url" && key != "detail") {
                    return false;
                }
                image
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|url| url.starts_with("data:image/") && url.len() <= MAX_PAYLOAD_BYTES)
                    && image
                        .get("detail")
                        .is_none_or(|detail| ["auto", "low", "high"].contains(&detail.as_str().unwrap_or("")))
            }
            _ => false,
        }
    })
}

fn get_receipt(connection: &Connection, request_id: &str) -> BrokerResult<Option<ExistingReceipt>> {
    connection
        .query_row(
            "SELECT payload_sha256, execution_id, authority_epoch, status, response_json FROM requests WHERE request_id=?1",
            params![request_id],
            |row| {
                Ok(ExistingReceipt {
                    payload_sha256: row.get(0)?,
                    execution_id: row.get(1)?,
                    authority_epoch: row.get(2)?,
                    status: row.get(3)?,
                    response_json: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|_| GuestBrokerError::Journal)
}

fn accepted_count(connection: &Connection) -> BrokerResult<i64> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM requests WHERE status IN ('pending','completed','effect_unknown')",
            [],
            |row| row.get(0),
        )
        .map_err(|_| GuestBrokerError::Journal)
}

fn journal_row_count(connection: &Connection) -> BrokerResult<i64> {
    connection
        .query_row("SELECT COUNT(*) FROM requests", [], |row| row.get(0))
        .map_err(|_| GuestBrokerError::Journal)
}

fn persist_pending(connection: &mut Connection, request: &GuestRequest) -> BrokerResult<()> {
    let epoch = i64::try_from(request.authority_epoch).map_err(|_| GuestBrokerError::InvalidConfig)?;
    connection
        .execute(
            "INSERT INTO requests(request_id,payload_sha256,execution_id,authority_epoch,status,response_json)
             VALUES(?1,?2,?3,?4,'pending',NULL)",
            params![request.request_id, request.payload_sha256, request.execution_id, epoch],
        )
        .map_err(|_| GuestBrokerError::Journal)?;
    Ok(())
}

fn persist_new_response(
    connection: &mut Connection,
    request: &GuestRequest,
    status: &str,
    response: &GuestResponse,
) -> BrokerResult<()> {
    let epoch = i64::try_from(request.authority_epoch).map_err(|_| GuestBrokerError::InvalidConfig)?;
    let response_json = serde_json::to_string(response).map_err(|_| GuestBrokerError::Journal)?;
    connection
        .execute(
            "INSERT INTO requests(request_id,payload_sha256,execution_id,authority_epoch,status,response_json)
             VALUES(?1,?2,?3,?4,?5,?6)",
            params![request.request_id, request.payload_sha256, request.execution_id, epoch, status, response_json],
        )
        .map_err(|_| GuestBrokerError::Journal)?;
    Ok(())
}

fn persist_response(
    connection: &Connection,
    request_id: &str,
    payload_sha256: &str,
    response: &GuestResponse,
) -> BrokerResult<()> {
    let response_json = serde_json::to_string(response).map_err(|_| GuestBrokerError::Journal)?;
    let status = match response.status {
        ResponseStatus::Completed => "completed",
        ResponseStatus::Rejected => "rejected",
        ResponseStatus::EffectUnknown => "effect_unknown",
    };
    let changed = connection
        .execute(
            "UPDATE requests SET status=?1,response_json=?2
             WHERE request_id=?3 AND payload_sha256=?4 AND status IN ('pending','completed','rejected','effect_unknown')",
            params![status, response_json, request_id, payload_sha256],
        )
        .map_err(|_| GuestBrokerError::Journal)?;
    if changed != 1 {
        return Err(GuestBrokerError::Journal);
    }
    Ok(())
}

fn make_response(
    request_id: &str,
    payload_sha256: &str,
    status: ResponseStatus,
    http_status: Option<u16>,
    completion: Option<(String, String)>,
    reason_code: Option<&str>,
) -> GuestResponse {
    let (completion_json, response_sha256) = match completion {
        Some((completion, digest)) => (Some(completion), Some(digest)),
        None => (None, None),
    };
    GuestResponse {
        version: CONTRACT_VERSION,
        request_id: request_id.to_owned(),
        payload_sha256: payload_sha256.to_owned(),
        status,
        http_status,
        completion_json,
        response_sha256,
        reason_code: reason_code.map(str::to_owned),
    }
}

fn rejected_outcome(request_id: &str, payload_sha256: &str, reason: &str, publish: bool) -> CallOutcome {
    CallOutcome {
        response: make_response(request_id, payload_sha256, ResponseStatus::Rejected, None, None, Some(reason)),
        publish,
    }
}

fn unknown_outcome(
    request_id: &str,
    payload_sha256: &str,
    http_status: Option<u16>,
    reason: &str,
    publish: bool,
) -> CallOutcome {
    CallOutcome {
        response: make_response(request_id, payload_sha256, ResponseStatus::EffectUnknown, http_status, None, Some(reason)),
        publish,
    }
}

fn decode_stored_response(
    response_json: &str,
    request_id: &str,
    payload_sha256: &str,
    config: &GuestBrokerConfig,
) -> BrokerResult<GuestResponse> {
    if response_json.len() > MAX_RESPONSE_FILE_BYTES {
        return Err(GuestBrokerError::Journal);
    }
    let response: GuestResponse = serde_json::from_str(response_json).map_err(|_| GuestBrokerError::Journal)?;
    if response.version != CONTRACT_VERSION
        || response.request_id != request_id
        || response.payload_sha256 != payload_sha256
        || !is_sha256(&response.payload_sha256)
    {
        return Err(GuestBrokerError::Journal);
    }
    match response.status {
        ResponseStatus::Completed => {
            let completion = response.completion_json.as_deref().ok_or(GuestBrokerError::Journal)?;
            let digest = response.response_sha256.as_deref().ok_or(GuestBrokerError::Journal)?;
            if response.reason_code.is_some()
                || match &config.backend {
                    GuestModelBackend::LocalHttp { .. } => response.http_status.is_none_or(|status| !(200..300).contains(&status)),
                    GuestModelBackend::SubscriptionNative(_) => response.http_status.is_some(),
                }
                || completion.len() > MAX_COMPLETION_BYTES
                || !is_sha256(digest)
                || sha256(completion.as_bytes()) != digest
            {
                return Err(GuestBrokerError::Journal);
            }
            let parsed: Value = serde_json::from_str(completion).map_err(|_| GuestBrokerError::Journal)?;
            if match &config.backend {
                GuestModelBackend::LocalHttp { .. } => parsed.get("model").and_then(Value::as_str) != Some(config.model_id.as_str()),
                GuestModelBackend::SubscriptionNative(_) => !valid_native_message(&parsed, config),
            } {
                return Err(GuestBrokerError::Journal);
            }
        }
        ResponseStatus::Rejected | ResponseStatus::EffectUnknown => {
            let reason = response.reason_code.as_deref().ok_or(GuestBrokerError::Journal)?;
            if response.completion_json.is_some()
                || response.response_sha256.is_some()
                || !is_reason_code(reason)
                || response.http_status.is_some_and(|status| !(100..600).contains(&status))
            {
                return Err(GuestBrokerError::Journal);
            }
        }
    }
    Ok(response)
}

fn publish_response(config: &GuestBrokerConfig, resources: &BrokerResources, response: &GuestResponse) -> BrokerResult<()> {
    let filename = format!("{}.response.json", response.request_id);
    let response_json = match &config.backend {
        GuestModelBackend::LocalHttp { .. } => serde_json::to_vec(response),
        GuestModelBackend::SubscriptionNative(_) => {
            #[derive(Serialize)]
            struct NativeResponse<'a> {
                version: u32,
                kind: &'static str,
                request_id: &'a str,
                execution_id: &'a str,
                authority_epoch: u64,
                payload_sha256: &'a str,
                status: ResponseStatus,
                message_json: Option<&'a str>,
                message_sha256: Option<&'a str>,
                reason_code: Option<&'a str>,
            }
            serde_json::to_vec(&NativeResponse {
                version: CONTRACT_VERSION, kind: "model_response", request_id: &response.request_id,
                execution_id: &config.execution_id, authority_epoch: config.authority_epoch,
                payload_sha256: &response.payload_sha256, status: response.status,
                message_json: response.completion_json.as_deref(), message_sha256: response.response_sha256.as_deref(),
                reason_code: response.reason_code.as_deref(),
            })
        }
    }.map_err(|_| GuestBrokerError::Journal)?;
    if response_json.len() > MAX_RESPONSE_FILE_BYTES {
        return Err(GuestBrokerError::SpoolLimit);
    }
    match read_at(&resources.response, &filename, MAX_RESPONSE_FILE_BYTES) {
        Ok(Some(existing)) => {
            if existing != response_json {
                return Err(GuestBrokerError::UnsafeFilesystem);
            }
            return Ok(());
        }
        Ok(None) => {}
        Err(error) => return Err(error),
    }
    if directory_size(&resources.response)?
        .saturating_add(response_json.len() as u64)
        > 16_u64.saturating_mul(MAX_RESPONSE_FILE_BYTES as u64)
    {
        return Err(GuestBrokerError::SpoolLimit);
    }
    atomic_write_at(&resources.response, &filename, &response_json)
}

fn directory_size(directory: &DirectoryHandle) -> BrokerResult<u64> {
    let names = list_names_without_size(directory)?;
    let mut total = 0_u64;
    for name in names {
        let name = CString::new(name.as_bytes()).map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
        let mut metadata = unsafe { std::mem::zeroed::<libc::stat>() };
        let result = unsafe {
            libc::fstatat(
                directory.file.as_raw_fd(),
                name.as_ptr(),
                &mut metadata,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result == 0 && metadata.st_size > 0 {
            total = total.saturating_add(metadata.st_size as u64);
        }
    }
    Ok(total)
}

fn list_names_without_size(directory: &DirectoryHandle) -> BrokerResult<Vec<String>> {
    // dup shares the directory offset; each scan needs an independent open description.
    let duplicate = unsafe {
        libc::openat(
            directory.file.as_raw_fd(),
            b".\0".as_ptr().cast(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if duplicate < 0 {
        return Err(GuestBrokerError::UnsafeFilesystem);
    }
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        unsafe { libc::close(duplicate) };
        return Err(GuestBrokerError::UnsafeFilesystem);
    }
    let mut names = Vec::new();
    loop {
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        if name == "." || name == ".." {
            continue;
        }
        names.push(name);
        if names.len() > MAX_DIRECTORY_ENTRIES {
            unsafe { libc::closedir(stream) };
            return Err(GuestBrokerError::SpoolLimit);
        }
    }
    unsafe { libc::closedir(stream) };
    Ok(names)
}

fn atomic_write_at(directory: &DirectoryHandle, filename: &str, bytes: &[u8]) -> BrokerResult<()> {
    let final_name = CString::new(filename).map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
    let temp_filename = format!(".broker-{}.tmp", Uuid::new_v4());
    let temp_name = CString::new(temp_filename.as_str()).map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
    let descriptor = unsafe {
        libc::openat(
            directory.file.as_raw_fd(),
            temp_name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(GuestBrokerError::UnsafeFilesystem);
    }
    let mut file = unsafe { File::from_raw_fd(descriptor) };
    let write_result = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if write_result.is_err() {
        unsafe { libc::unlinkat(directory.file.as_raw_fd(), temp_name.as_ptr(), 0) };
        return Err(GuestBrokerError::UnsafeFilesystem);
    }
    let renamed = unsafe {
        libc::renameat(
            directory.file.as_raw_fd(),
            temp_name.as_ptr(),
            directory.file.as_raw_fd(),
            final_name.as_ptr(),
        )
    };
    if renamed != 0 {
        unsafe { libc::unlinkat(directory.file.as_raw_fd(), temp_name.as_ptr(), 0) };
        return Err(GuestBrokerError::UnsafeFilesystem);
    }
    if unsafe { libc::fsync(directory.file.as_raw_fd()) } != 0 {
        return Err(GuestBrokerError::UnsafeFilesystem);
    }
    Ok(())
}

fn read_at(directory: &DirectoryHandle, filename: &str, maximum: usize) -> BrokerResult<Option<Vec<u8>>> {
    let filename = CString::new(filename).map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
    let descriptor = unsafe {
        libc::openat(
            directory.file.as_raw_fd(),
            filename.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )
    };
    if descriptor < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(GuestBrokerError::UnsafeFilesystem);
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    let metadata = file.metadata().map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > maximum as u64 {
        return Err(GuestBrokerError::UnsafeFilesystem);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
    if bytes.len() > maximum {
        return Err(GuestBrokerError::SpoolLimit);
    }
    Ok(Some(bytes))
}

fn cancellation_matches(resources: &BrokerResources, request_id: &str, digest: &str) -> BrokerResult<bool> {
    let filename = format!("{request_id}.cancel.json");
    let bytes = match read_at(&resources.request, &filename, 4096) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(false),
        Err(GuestBrokerError::UnsafeFilesystem) => return Ok(false),
        Err(error) => return Err(error),
    };
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Cancel {
        version: u32,
        request_id: String,
        payload_sha256: String,
    }
    let cancel: Cancel = match serde_json::from_slice(&bytes) {
        Ok(cancel) => cancel,
        Err(_) => return Ok(false),
    };
    Ok(cancel.version == CONTRACT_VERSION && cancel.request_id == request_id && cancel.payload_sha256 == digest)
}

fn remove_request_files(resources: &BrokerResources, request_id: &str) -> BrokerResult<()> {
    for filename in [
        format!("{request_id}.request.json"),
        format!("{request_id}.cancel.json"),
    ] {
        let filename = CString::new(filename).map_err(|_| GuestBrokerError::UnsafeFilesystem)?;
        let result = unsafe { libc::unlinkat(resources.request.file.as_raw_fd(), filename.as_ptr(), 0) };
        if result != 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound {
            return Err(GuestBrokerError::UnsafeFilesystem);
        }
    }
    if unsafe { libc::fsync(resources.request.file.as_raw_fd()) } != 0 {
        return Err(GuestBrokerError::UnsafeFilesystem);
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn is_reason_code(reason: &str) -> bool {
    matches!(
        reason,
        "invalid_payload"
            | "request_limit"
            | "authorization_denied"
            | "cancelled_before_io"
            | "cancelled_in_flight"
            | "deadline_before_io"
            | "upstream_timeout"
            | "upstream_transport_error"
            | "upstream_http_error"
            | "upstream_invalid_response"
            | "restart_pending"
            | "broker_stopped"
            | "scope_revoked"
            | "native_transport_error"
            | "native_rejected"
            | "native_effect_unknown"
    )
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}
