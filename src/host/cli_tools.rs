//! Narrow, fixed-command CLI tools exposed to Ghost agents.
//!
//! The model selects a typed operation, never an executable or raw argv. The
//! executable is configured by the host process and is spawned without a shell
//! or inherited environment. All returned web data is untrusted.

use crate::durable::durable::{ai, ToolOutput, ToolStatus};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    task::JoinHandle,
    time::timeout,
};

const EXECUTABLE_ENV: &str = "GHOST_OXIBROWSER_EXECUTABLE";
const MAX_QUERY_BYTES: usize = 2_048;
const MAX_URL_BYTES: usize = 4_096;
const MAX_READ_BYTES: u64 = 24 * 1_024;
const MAX_PROCESS_OUTPUT: usize = 512 * 1_024;
const TOOL_DEADLINE: Duration = Duration::from_secs(20);

/// Resolve only an explicit host-owned executable path. PATH search and model
/// supplied command names are intentionally not supported.
pub(crate) fn executable() -> Option<PathBuf> {
    let configured = std::env::var_os(EXECUTABLE_ENV)?;
    let path = PathBuf::from(configured);
    if !path.is_absolute() {
        return None;
    }
    let resolved = path.canonicalize().ok()?;
    let metadata = resolved.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(resolved)
}

pub(crate) fn configured() -> bool {
    executable().is_some()
}

fn invocation(call: &ai::ToolCall) -> Result<(Vec<String>, Value)> {
    let (args, operation, input) = match call.name.as_str() {
        "web_search" => {
            let query = call.arguments["query"]
                .as_str()
                .ok_or_else(|| anyhow!("query required"))?;
            if query.trim().is_empty() || query.len() > MAX_QUERY_BYTES {
                bail!("query is empty or exceeds the size limit");
            }
            let limit = call.arguments["limit"].as_u64().unwrap_or(5).clamp(1, 8);
            (
                vec![
                    "--no-audit".into(),
                    "search".into(),
                    "--engine".into(),
                    "ddg".into(),
                    "--max-results".into(),
                    limit.to_string(),
                    "--json".into(),
                    "--".into(),
                    query.into(),
                ],
                "oxibrowser.search",
                json!({"query":query,"limit":limit}),
            )
        }
        "web_read" => {
            let raw = call.arguments["url"]
                .as_str()
                .ok_or_else(|| anyhow!("url required"))?;
            if raw.len() > MAX_URL_BYTES {
                bail!("url exceeds the size limit");
            }
            validate_public_url(raw)?;
            (
                vec![
                    "--no-audit".into(),
                    "fetch".into(),
                    raw.into(),
                    "--format".into(),
                    "markdown".into(),
                    "--max-bytes".into(),
                    MAX_READ_BYTES.to_string(),
                    "--json".into(),
                ],
                "oxibrowser.fetch",
                json!({"url":raw,"max_bytes":MAX_READ_BYTES}),
            )
        }
        _ => bail!("unsupported CLI tool"),
    };
    Ok((
        args,
        json!({"schema":"ghost-tool-result/1","tool":operation,"input":input}),
    ))
}

fn validate_public_url(raw: &str) -> Result<()> {
    let url = reqwest::Url::parse(raw).map_err(|_| anyhow!("invalid public URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("only credential-free HTTP(S) URLs are supported");
    }
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.');
    let lower = host.to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
    {
        bail!("local and internal hosts are not available to web_read");
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        let is_private = match ip {
            std::net::IpAddr::V4(ip) => private_v4(ip),
            std::net::IpAddr::V6(ip) => {
                let octets = ip.octets();
                let mapped_v4 = octets[..10] == [0; 10] && octets[10..12] == [0xff, 0xff];
                if mapped_v4 {
                    private_v4(std::net::Ipv4Addr::new(
                        octets[12], octets[13], octets[14], octets[15],
                    ))
                } else {
                    ip.is_loopback()
                        || ip.is_unspecified()
                        || ip.is_unique_local()
                        || ip.is_unicast_link_local()
                        || ip.is_multicast()
                }
            }
        };
        if is_private {
            bail!("private and local IP addresses are not available to web_read");
        }
    }
    Ok(())
}

fn private_v4(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || octets[0] == 0
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || octets[0] >= 224
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
}

async fn read_bounded<R: AsyncRead + Unpin>(reader: R) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_PROCESS_OUTPUT + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    Ok(bytes)
}

fn start_reader<R: AsyncRead + Unpin + Send + 'static>(
    reader: R,
) -> JoinHandle<io::Result<Vec<u8>>> {
    tokio::spawn(read_bounded(reader))
}

async fn reap_readers(
    stdout: JoinHandle<io::Result<Vec<u8>>>,
    stderr: JoinHandle<io::Result<Vec<u8>>>,
) -> Result<(Vec<u8>, Vec<u8>)> {
    let stdout = stdout.await??;
    let stderr = stderr.await??;
    if stdout.len() > MAX_PROCESS_OUTPUT || stderr.len() > MAX_PROCESS_OUTPUT {
        bail!("web CLI output exceeded its limit");
    }
    Ok((stdout, stderr))
}

async fn stop(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

pub(crate) async fn execute(call: &ai::ToolCall) -> Result<ToolOutput> {
    let Some(executable) = executable() else {
        return Ok(ToolOutput::error(
            ToolStatus::Failed,
            "web CLI is unavailable; configure GHOST_OXIBROWSER_EXECUTABLE with an absolute executable path",
        ));
    };
    let (args, mut envelope) = invocation(call)?;
    let fingerprint_path = executable.clone();
    let revision = tokio::task::spawn_blocking(move || {
        std::fs::read(fingerprint_path).map(|bytes| format!("sha256:{:x}", Sha256::digest(bytes)))
    })
    .await
    .map_err(|_| anyhow!("configured web CLI fingerprint task failed"))?
    .map_err(|_| anyhow!("configured web CLI could not be read"))?;

    let mut child = match Command::new(&executable)
        .args(args)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(_) => {
            return Ok(ToolOutput::error(
                ToolStatus::Failed,
                "configured web CLI could not start",
            ));
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("web CLI stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("web CLI stderr unavailable"))?;
    let stdout_task = start_reader(stdout);
    let stderr_task = start_reader(stderr);
    let status = match timeout(TOOL_DEADLINE, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            stop(&mut child).await;
            let _ = reap_readers(stdout_task, stderr_task).await;
            return Ok(ToolOutput::error(
                ToolStatus::Uncertain,
                "web CLI exited before its result was confirmed; do not assume the request completed",
            ));
        }
        Err(_) => {
            stop(&mut child).await;
            let _ = reap_readers(stdout_task, stderr_task).await;
            return Ok(ToolOutput::error(
                ToolStatus::Uncertain,
                "web CLI timed out; its request may have reached the remote site, so inspect before retrying",
            ));
        }
    };
    let (stdout, _stderr) = match reap_readers(stdout_task, stderr_task).await {
        Ok(output) => output,
        Err(_) => {
            return Ok(ToolOutput::error(
                ToolStatus::Failed,
                "web CLI returned invalid or oversized output",
            ));
        }
    };
    if !status.success() {
        return Ok(ToolOutput::error(
            ToolStatus::Failed,
            format!("web CLI failed with exit code {:?}", status.code()),
        ));
    }
    let result: Value = match serde_json::from_slice(&stdout) {
        Ok(value) => value,
        Err(_) => {
            return Ok(ToolOutput::error(
                ToolStatus::Failed,
                "web CLI returned invalid JSON",
            ));
        }
    };
    if result["ok"] == false || result["success"] == false {
        return Ok(ToolOutput::error(
            ToolStatus::Failed,
            "web CLI reported a request failure",
        ));
    }
    envelope["tool_revision"] = json!(revision);
    envelope["status"] = json!("ok");
    envelope["untrusted"] = json!(true);
    envelope["result"] = if result.get("data").is_some() {
        result["data"].clone()
    } else {
        result
    };
    Ok(ToolOutput::success(
        "Untrusted public web result; verify the source URL and content before relying on it",
        envelope,
    ))
}
