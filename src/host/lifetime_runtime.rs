//! One process owns the Pi JSONL transport; no Host state lock spans process I/O.
use crate::lifetime_contract::{Envelope, Response, VERSION, REVISION};
use anyhow::{anyhow, bail, Result};
use serde_json::Value;
use std::path::Path;
use tokio::{io::{AsyncBufReadExt, AsyncWriteExt, BufReader}, process::{Child, ChildStdin, ChildStdout, Command}};

pub(crate) struct PiProcess {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

pub(crate) struct LocalPiRoute {
    pub(crate) base_url: String,
    pub(crate) model_id: String,
    pub(crate) callback_token: String,
}

impl LocalPiRoute {
    pub(crate) fn from_environment() -> Result<Option<Self>> {
        let base_url = std::env::var("GHOST_LIFETIME_LOCAL_MODEL_URL").ok();
        let model_id = std::env::var("GHOST_LIFETIME_LOCAL_MODEL_ID").ok();
        let (base_url, model_id) = match (base_url, model_id) {
            (None, None) => return Ok(None),
            (Some(url), Some(model)) => (url, model),
            _ => bail!("local Pi routing requires both explicit endpoint and model"),
        };
        let url = reqwest::Url::parse(&base_url)?;
        let authority = base_url.split_once("://").and_then(|(_, rest)| rest.split('/').next()).unwrap_or("");
        let literal = authority.strip_prefix("127.0.0.1").or_else(|| authority.strip_prefix("[::1]"));
        let literal = literal.is_some_and(|suffix| suffix.is_empty()
            || suffix.strip_prefix(':').is_some_and(|port| !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit())));
        anyhow::ensure!(base_url.len() <= 512 && matches!(url.scheme(), "http" | "https")
            && literal && url.username().is_empty() && url.password().is_none()
            && url.path() == "/v1" && url.query().is_none() && url.fragment().is_none(),
            "local Pi endpoint must be an explicit literal-loopback HTTP(S) /v1 URL");
        anyhow::ensure!(!model_id.is_empty() && model_id.len() <= 256
            && !model_id.chars().any(|value| value.is_whitespace() || value.is_control()),
            "local Pi model must be explicitly pinned");
        Ok(Some(Self { base_url, model_id,
            callback_token: format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()) }))
    }
}
impl PiProcess {
    pub(crate) async fn start(entry: &Path, root: &Path, host_root: &Path, mode: &str, callback_token: &str, authority_epoch: u64, local_route: Option<&LocalPiRoute>) -> Result<Self> {
        anyhow::ensure!(entry.is_absolute() && entry.is_file() && !entry.is_symlink(), "invalid Pi entry path");
        anyhow::ensure!(matches!(mode, "fixture" | "broker"), "invalid Pi runtime mode");
        let mut command = Command::new("node");
        command.arg(entry).arg("--root").arg(root).arg("--mode").arg(mode)
            .env("GHOST_LIFETIME_HOST_ROOT", host_root)
            .env("GHOST_PI_CALLBACK_TOKEN", callback_token)
            .env("GHOST_PI_AUTHORITY_EPOCH", authority_epoch.to_string())
            .env_remove("GHOST_PI_LOCAL_CALLBACK_TOKEN")
            .env_remove("GHOST_LIFETIME_LOCAL_MODEL_URL")
            .env_remove("GHOST_LIFETIME_LOCAL_MODEL_ID");
        if let Some(route) = local_route {
            command.env("GHOST_PI_LOCAL_CALLBACK_TOKEN", &route.callback_token)
                .env("GHOST_LIFETIME_LOCAL_MODEL_URL", &route.base_url)
                .env("GHOST_LIFETIME_LOCAL_MODEL_ID", &route.model_id);
        }
        let mut child = command
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit()).kill_on_drop(true).spawn()?;
        let input = child.stdin.take().ok_or_else(|| anyhow!("Pi stdin missing"))?;
        let output = child.stdout.take().ok_or_else(|| anyhow!("Pi stdout missing"))?;
        let mut process = Self { child, input, output: BufReader::new(output) };
        let handshake = process.frame().await?;
        anyhow::ensure!(handshake["protocol_version"] == VERSION && handshake["contract_revision"] == REVISION,
            "incompatible Pi runtime handshake");
        anyhow::ensure!(handshake["mode"] == mode
            && handshake["runtime_identity"]["durable"] == "@earendil-works/pi-durable@1.1.0",
            "Pi runtime identity or mode is not accepted");
        Ok(process)
    }
    pub(crate) fn has_exited(&mut self) -> Result<bool> {
        Ok(self.child.try_wait()?.is_some())
    }
    async fn frame(&mut self) -> Result<Value> {
        let mut bytes = Vec::new();
        // Bound while reading: read_line's post-read check alone allows unbounded allocation.
        loop {
            let buffer = self.output.fill_buf().await?;
            if buffer.is_empty() { bail!("Pi process closed before durable response"); }
            let end = buffer.iter().position(|b| *b == b'\n').map(|i| i + 1).unwrap_or(buffer.len());
            anyhow::ensure!(bytes.len() + end <= 1_048_576, "Pi frame limit");
            let terminal = buffer[end - 1] == b'\n';
            bytes.extend_from_slice(&buffer[..end]);
            self.output.consume(end);
            if terminal { return Ok(serde_json::from_slice(&bytes)?); }
        }
    }
    pub(crate) async fn request(&mut self, envelope: &Envelope) -> Result<Response> {
        envelope.validate()?;
        if self.child.try_wait()?.is_some() { bail!("Pi process exited; inspect same command after reopen"); }
        let mut bytes = serde_json::to_vec(envelope)?;
        anyhow::ensure!(bytes.len() < 1_048_576, "Pi request limit");
        bytes.push(b'\n');
        self.input.write_all(&bytes).await?;
        self.input.flush().await?;
        let response: Response = serde_json::from_value(self.frame().await?)?;
        anyhow::ensure!(response.data.get("command_id").and_then(Value::as_str) == Some(envelope.command_id.as_str()),
            "Pi response does not correlate to the pending command");
        Ok(response)
    }
    pub(crate) async fn close(mut self) -> Result<()> {
        // EOF closes the SDK cleanly and leaves unfinished durable turns pending.
        drop(self.input);
        match tokio::time::timeout(std::time::Duration::from_secs(10), self.child.wait()).await {
            Ok(status) => { anyhow::ensure!(status?.success(), "Pi runtime failed during close"); }
            Err(_) => {
                self.child.kill().await?;
                self.child.wait().await?;
            }
        }
        Ok(())
    }
}
