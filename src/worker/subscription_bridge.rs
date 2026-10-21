use super::guest_broker::GuestBrokerError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::time::{sleep, Instant};

const MAX_LINE_BYTES: usize = 2 * 4_194_304 + 65_536;
const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubscriptionBridgeConfig {
    pub executable: PathBuf,
    pub entry: PathBuf,
    pub sdk_package_root: PathBuf,
    pub auth_file: PathBuf,
    pub home_directory: PathBuf,
}

impl SubscriptionBridgeConfig {
    pub(super) fn validate(&self) -> Result<(), GuestBrokerError> {
        use std::os::unix::fs::MetadataExt;
        for path in [&self.executable, &self.entry, &self.sdk_package_root, &self.home_directory] {
            if !path.is_absolute() || path.canonicalize().map_err(|_| GuestBrokerError::InvalidConfig)? != *path {
                return Err(GuestBrokerError::InvalidConfig);
            }
        }
        let executable = std::fs::metadata(&self.executable).map_err(|_| GuestBrokerError::InvalidConfig)?;
        let entry = std::fs::metadata(&self.entry).map_err(|_| GuestBrokerError::InvalidConfig)?;
        let sdk = std::fs::metadata(&self.sdk_package_root).map_err(|_| GuestBrokerError::InvalidConfig)?;
        let home = std::fs::metadata(&self.home_directory).map_err(|_| GuestBrokerError::InvalidConfig)?;
        if !executable.is_file() || executable.mode() & 0o111 == 0 || executable.mode() & 0o022 != 0
            || !entry.is_file() || entry.mode() & 0o022 != 0 || entry.nlink() != 1
            || !sdk.is_dir() || sdk.mode() & 0o022 != 0
            || !home.is_dir() || home.uid() != unsafe { libc::geteuid() } || home.mode() & 0o077 != 0 {
            return Err(GuestBrokerError::InvalidConfig);
        }
        let parent = self.auth_file.parent().ok_or(GuestBrokerError::InvalidConfig)?;
        if !self.auth_file.is_absolute()
            || parent.canonicalize().map_err(|_| GuestBrokerError::InvalidConfig)? != parent {
            return Err(GuestBrokerError::InvalidConfig);
        }
        let auth = std::fs::symlink_metadata(&self.auth_file).map_err(|_| GuestBrokerError::InvalidConfig)?;
        if !auth.is_file() || auth.nlink() != 1 || auth.mode() & 0o077 != 0
            || auth.uid() != unsafe { libc::geteuid() } || auth.len() > 64 * 1024 * 1024 {
            return Err(GuestBrokerError::InvalidConfig);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubscriptionReady {
    pub version: u32,
    pub kind: String,
    pub sdk_version: String,
    pub provider: String,
    pub model_id: String,
    pub thinking: String,
    pub resolved_reasoning: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SubscriptionResponse {
    pub version: u32,
    pub kind: String,
    pub request_id: String,
    pub execution_id: String,
    pub authority_epoch: u64,
    pub payload_sha256: String,
    pub status: String,
    pub message_json: Option<String>,
    pub message_sha256: Option<String>,
    pub reason_code: Option<String>,
}

pub(super) struct SubscriptionBridge {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    pub ready: Arc<SubscriptionReady>,
}

impl SubscriptionBridge {
    pub async fn start(config: &SubscriptionBridgeConfig, deadline_ms: u64) -> Result<Self, GuestBrokerError> {
        let mut command = Command::new(&config.executable);
        command.arg(&config.entry)
            .env_clear().env("HOME", &config.home_directory).env("NO_COLOR", "1")
            .current_dir(&config.home_directory)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        let mut child = command.spawn().map_err(|_| GuestBrokerError::SubscriptionBridge)?;
        let mut stdin = child.stdin.take().ok_or(GuestBrokerError::SubscriptionBridge)?;
        let stdout = child.stdout.take().ok_or(GuestBrokerError::SubscriptionBridge)?;
        let mut stdout = BufReader::with_capacity(8192, stdout);
        #[derive(Serialize)]
        struct Configure<'a> {
            version: u32,
            kind: &'static str,
            sdk_package_root: &'a std::path::Path,
            auth_file: &'a std::path::Path,
            selector: &'static str,
            thinking: &'static str,
            max_tokens: u32,
            deadline_ms: u64,
        }
        let frame = Configure {
            version: 1, kind: "configure", sdk_package_root: &config.sdk_package_root,
            auth_file: &config.auth_file, selector: "openai-codex/gpt-6-luna",
            thinking: "max", max_tokens: 1024, deadline_ms,
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        let startup = async {
            write_frame(&mut stdin, &frame).await?;
            let line = read_line(&mut stdout, 16 * 1024).await?;
            let ready: SubscriptionReady = serde_json::from_slice(&line)
                .map_err(|_| GuestBrokerError::SubscriptionBridge)?;
            if ready.version != 1 || ready.kind != "ready" || ready.sdk_version != "18.8.6"
                || ready.provider != "openai-codex" || ready.model_id != "gpt-6-luna"
                || ready.thinking != "max" || ready.resolved_reasoning != "max" {
                return Err(GuestBrokerError::SubscriptionBridge);
            }
            Ok(ready)
        };
        let ready = match tokio::time::timeout_at(deadline, startup).await {
            Ok(Ok(ready)) => ready,
            _ => {
                let _ = child.kill().await;
                return Err(GuestBrokerError::SubscriptionBridge);
            }
        };
        Ok(Self { child, stdin, stdout, ready: Arc::new(ready) })
    }

    pub async fn request(
        &mut self, request_id: &str, execution_id: &str, authority_epoch: u64,
        payload_json: &str, payload_sha256: &str, deadline: Instant,
        stopping: &AtomicBool, authorized: impl Fn() -> bool,
    ) -> Result<SubscriptionResponse, GuestBrokerError> {
        #[derive(Serialize)]
        struct Request<'a> {
            version: u32,
            kind: &'static str,
            request_id: &'a str,
            execution_id: &'a str,
            authority_epoch: u64,
            payload_json: &'a str,
            payload_sha256: &'a str,
        }
        let frame = Request {
            version: 1, kind: "model_request", request_id, execution_id, authority_epoch,
            payload_json, payload_sha256,
        };
        if stopping.load(Ordering::Acquire) || !authorized() || Instant::now() >= deadline {
            return Err(GuestBrokerError::Unauthorized);
        }
        let exchange = async {
            write_frame(&mut self.stdin, &frame).await?;
            let line = read_line(&mut self.stdout, MAX_LINE_BYTES).await?;
            let response: SubscriptionResponse = serde_json::from_slice(&line)
                .map_err(|_| GuestBrokerError::SubscriptionBridge)?;
            if response.version != 1 || response.kind != "model_response"
                || response.request_id != request_id || response.execution_id != execution_id
                || response.authority_epoch != authority_epoch || response.payload_sha256 != payload_sha256 {
                return Err(GuestBrokerError::SubscriptionBridge);
            }
            Ok(response)
        };
        tokio::pin!(exchange);
        loop {
            tokio::select! {
                result = &mut exchange => return result,
                _ = sleep(POLL_INTERVAL) => {
                    if stopping.load(Ordering::Acquire) || !authorized() || Instant::now() >= deadline {
                        return Err(GuestBrokerError::Unauthorized);
                    }
                }
            }
        }
    }

    pub async fn stop(&mut self) -> Result<(), GuestBrokerError> {
        let _ = self.stdin.shutdown().await;
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            return Ok(());
        }
        // A disconnected remote inference can still have effect. Only the owned
        // bridge process is reaped here; no remote-computation completion claim.
        self.child.kill().await.map_err(|_| GuestBrokerError::SubscriptionBridge)
    }
}

async fn write_frame<T: Serialize>(stdin: &mut ChildStdin, frame: &T) -> Result<(), GuestBrokerError> {
    let mut bytes = serde_json::to_vec(frame).map_err(|_| GuestBrokerError::SubscriptionBridge)?;
    if bytes.len() >= MAX_LINE_BYTES {
        return Err(GuestBrokerError::SubscriptionBridge);
    }
    bytes.push(b'\n');
    stdin.write_all(&bytes).await.map_err(|_| GuestBrokerError::SubscriptionBridge)?;
    stdin.flush().await.map_err(|_| GuestBrokerError::SubscriptionBridge)
}

async fn read_line(stdout: &mut BufReader<ChildStdout>, limit: usize) -> Result<Vec<u8>, GuestBrokerError> {
    let mut line = Vec::with_capacity(8192.min(limit));
    loop {
        let available = stdout.fill_buf().await.map_err(|_| GuestBrokerError::SubscriptionBridge)?;
        if available.is_empty() {
            return Err(GuestBrokerError::SubscriptionBridge);
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map(|index| index + 1).unwrap_or(available.len());
        if line.len().saturating_add(count) > limit {
            return Err(GuestBrokerError::SubscriptionBridge);
        }
        line.extend_from_slice(&available[..count]);
        stdout.consume(count);
        if newline.is_some() {
            line.pop();
            return Ok(line);
        }
    }
}
