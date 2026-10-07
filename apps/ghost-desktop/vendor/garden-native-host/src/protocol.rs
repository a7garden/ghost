use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct QueueHealth {
    pub queued: u64,
    pub leased: u64,
    pub draining: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonHealth {
    pub status: String,
    pub pid: u32,
    pub started_at: u64,
    pub uptime_ms: u64,
    pub queue: QueueHealth,
}

#[cfg(unix)]
fn request(path: &Path, method: &str, timeout: Duration) -> Result<serde_json::Value, String> {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    let mut stream = UnixStream::connect(path).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    let id = format!("native-{method}");
    writeln!(
        stream,
        "{}",
        serde_json::json!({"id":id,"method":method,"params":{}})
    )
    .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + timeout;
    let mut line = Vec::new();
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|value| !value.is_zero())
            .ok_or("Daemon response deadline exceeded")?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|error| error.to_string())?;
        let mut bytes = [0u8; 4096];
        let count = stream.read(&mut bytes).map_err(|error| error.to_string())?;
        if count == 0 {
            return Err("Incomplete daemon frame".into());
        }
        let end = bytes[..count].iter().position(|byte| *byte == b'\n');
        line.extend_from_slice(&bytes[..end.map_or(count, |at| at + 1)]);
        if line.len() > 1_048_576 {
            return Err("Daemon frame exceeds 1 MiB".into());
        }
        if end.is_some() {
            break;
        }
    }
    let response: serde_json::Value =
        serde_json::from_slice(&line).map_err(|error| error.to_string())?;
    if response.get("id").and_then(|value| value.as_str()) != Some(&id)
        || response.get("ok").and_then(|value| value.as_bool()) != Some(true)
    {
        return Err("Daemon rejected request or returned mismatched response".into());
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| "Missing daemon result".into())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixListener,
        sync::atomic::{AtomicU32, Ordering},
        thread,
    };
    static NEXT: AtomicU32 = AtomicU32::new(0);

    // A real socket peer exercises framing and the two-request readiness boundary.
    fn peer(responses: Vec<serde_json::Value>) -> (std::path::PathBuf, thread::JoinHandle<()>) {
        let path = std::env::temp_dir().join(format!(
            "gn-{}-{}.sock",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let listener = UnixListener::bind(&path).unwrap();
        let cleanup = path.clone();
        let handle = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                writeln!(stream, "{response}").unwrap();
            }
            std::fs::remove_file(cleanup).unwrap();
        });
        (path, handle)
    }

    fn handshake(protocol: &str) -> serde_json::Value {
        serde_json::json!({"id":"native-handshake","ok":true,"result":{"protocol":protocol,"pid":42}})
    }

    #[test]
    fn readiness_requires_protocol_and_the_same_process() {
        let health = serde_json::json!({"id":"native-health","ok":true,"result":{"status":"ok","pid":42,"startedAt":100,"uptimeMs":5,"queue":{"queued":0,"leased":1,"draining":false}}});
        let (path, server) = peer(vec![handshake("garden-daemon/1"), health.clone()]);
        assert_eq!(
            daemon_health(&path, Duration::from_secs(1))
                .unwrap()
                .queue
                .leased,
            1
        );
        server.join().unwrap();
        let mut changed = health;
        changed["result"]["pid"] = 43.into();
        let (path, server) = peer(vec![handshake("garden-daemon/1"), changed]);
        assert!(daemon_health(&path, Duration::from_secs(1))
            .unwrap_err()
            .contains("process changed"));
        server.join().unwrap();
    }

    #[test]
    fn wrong_protocol_and_unrelated_responses_are_rejected() {
        for response in [
            handshake("unknown/1"),
            serde_json::json!({"id":"another-request","ok":true,"result":{}}),
        ] {
            let (path, server) = peer(vec![response]);
            assert!(daemon_health(&path, Duration::from_secs(1)).is_err());
            server.join().unwrap();
        }
    }
}

/// An endpoint is ready only when both replies identify the same protocol process.
#[cfg(unix)]
pub fn daemon_health(path: &Path, timeout: Duration) -> Result<DaemonHealth, String> {
    let handshake = request(path, "handshake", timeout)?;
    if handshake.get("protocol").and_then(|value| value.as_str()) != Some("garden-daemon/1") {
        return Err("Unsupported daemon protocol".into());
    }
    let health: DaemonHealth = serde_json::from_value(request(path, "health", timeout)?)
        .map_err(|error| error.to_string())?;
    if health.pid == 0
        || handshake.get("pid").and_then(|value| value.as_u64()) != Some(health.pid as u64)
    {
        return Err("Daemon process changed during health check".into());
    }
    if health.status != "ok" && health.status != "draining" {
        return Err("Unknown daemon health status".into());
    }
    Ok(health)
}

#[cfg(not(unix))]
pub fn daemon_health(_path: &Path, _timeout: Duration) -> Result<DaemonHealth, String> {
    Err("garden-daemon/1 transport requires a Unix host".into())
}
