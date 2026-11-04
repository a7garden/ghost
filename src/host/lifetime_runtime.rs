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
    pub(crate) max_output_tokens: u32,
    pub(crate) callback_token: String,
}

impl LocalPiRoute {
    fn output_tokens(raw: Option<&str>) -> Result<u32> {
        let Some(raw)=raw else { return Ok(1024) };
        anyhow::ensure!(!raw.is_empty() && !raw.starts_with('0') && raw.bytes().all(|v|v.is_ascii_digit()),"invalid explicit local output limit");
        let value=raw.parse::<u32>()?;
        anyhow::ensure!((1..=4096).contains(&value),"local output limit must be in 1..=4096");
        Ok(value)
    }
    pub(crate) fn config_identity(&self) -> Result<String> {
        crate::lifetime_contract::canonical_digest(&serde_json::json!({"base_url":self.base_url,"max_output_tokens":self.max_output_tokens,"model_id":self.model_id,"version":1}))
    }
    pub(crate) fn from_environment() -> Result<Option<Self>> {
        let base_url = std::env::var("GHOST_LIFETIME_LOCAL_MODEL_URL").ok();
        let model_id = std::env::var("GHOST_LIFETIME_LOCAL_MODEL_ID").ok();
        let raw_output=std::env::var("GHOST_LIFETIME_LOCAL_MAX_OUTPUT_TOKENS").ok();
        let max_output_tokens=Self::output_tokens(raw_output.as_deref())?;
        anyhow::ensure!(raw_output.is_none() || (base_url.is_some() && model_id.is_some()),"explicit local output limit requires configured route");
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
        Ok(Some(Self { base_url, model_id, max_output_tokens,
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
            .env_remove("GHOST_LIFETIME_LOCAL_MODEL_ID")
            .env_remove("GHOST_LIFETIME_LOCAL_MAX_OUTPUT_TOKENS")
            .env_remove("GHOST_LIFETIME_LOCAL_ROUTE_IDENTITY");
        if let Some(route) = local_route {
            command.env("GHOST_PI_LOCAL_CALLBACK_TOKEN", &route.callback_token)
                .env("GHOST_LIFETIME_LOCAL_MODEL_URL", &route.base_url)
                .env("GHOST_LIFETIME_LOCAL_MODEL_ID", &route.model_id)
                .env("GHOST_LIFETIME_LOCAL_MAX_OUTPUT_TOKENS", route.max_output_tokens.to_string())
                .env("GHOST_LIFETIME_LOCAL_ROUTE_IDENTITY", route.config_identity()?);
        }
        let mut child = command
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit()).kill_on_drop(true).spawn()?;
        let input = child.stdin.take().ok_or_else(|| anyhow!("Pi stdin missing"))?;
        let output = child.stdout.take().ok_or_else(|| anyhow!("Pi stdout missing"))?;
        let mut process = Self { child, input, output: BufReader::new(output) };
        let handshake = tokio::time::timeout(std::time::Duration::from_secs(10), process.frame()).await
            .map_err(|_| anyhow!("Pi startup handshake timed out"))??;
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

#[cfg(test)]
mod output_limit_tests {
    use super::*;
    #[tokio::test]
    async fn captured_local_output_limit_reaches_the_real_production_entrypoint() {
        let root=tempfile::tempdir().unwrap();
        let entry=Path::new(env!("CARGO_MANIFEST_DIR")).join("apps/ghost-durable/src/main.js");
        let route=LocalPiRoute {base_url:"http://127.0.0.1:8768/v1".into(),model_id:"mlx-community/Qwen3.6-35B-A3B-4bit".into(),max_output_tokens:4096,callback_token:"fixture-only-no-http".into()};
        // No request is submitted: the real main validates the captured digest
        // against its configured provider before it can emit the ready frame.
        let process=PiProcess::start(&entry,&root.path().join("runtime"),root.path(),"broker","fixture-only-no-http",1,Some(&route)).await.unwrap();
        process.close().await.unwrap();
    }
    #[test]
    fn captured_local_output_limit_is_bounded_and_part_of_nonsecret_route_identity() {
        assert_eq!(LocalPiRoute::output_tokens(None).unwrap(),1024);
        assert_eq!(LocalPiRoute::output_tokens(Some("4096")).unwrap(),4096);
        for raw in ["", "0", "01", "-1", "1.5", "4097", "999999999999999999999999"] {
            assert!(LocalPiRoute::output_tokens(Some(raw)).is_err());
        }
        let mut route=LocalPiRoute {base_url:"http://127.0.0.1:8768/v1".into(),model_id:"mlx-community/Qwen3.6-35B-A3B-4bit".into(),max_output_tokens:1024,callback_token:"secret-never-in-config-identity".into()};
        let initial=route.config_identity().unwrap();
        route.callback_token="different-secret".into();
        assert_eq!(route.config_identity().unwrap(),initial);
        route.max_output_tokens=4096;
        assert_ne!(route.config_identity().unwrap(),initial);
        assert_eq!(route.config_identity().unwrap(),"c88c8e149beb4fb6373d350b0bda74d951ca8a01b22b25cce9fbbf644c30c759");
    }
}
