use super::{api::Action, metadata};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::Path,
    time::Duration,
};

const RESPONSE_LIMIT: usize = 8 * 1_048_576;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const IO_TIMEOUT: Duration = Duration::from_secs(60);

/// Authenticated client for a local Ghost host. Credentials are read from the
/// protected discovery file; they never appear in CLI arguments or URLs.
pub struct ControlClient {
    endpoint: String,
    host_header: String,
    origin: String,
    address: SocketAddr,
    token: String,
}

impl ControlClient {
    /// Locate and authenticate to the host currently serving `root`.
    pub fn discover(root: &Path) -> Result<Self> {
        let root = metadata::canonical_root(root, false)?;
        let discovery = metadata::read(&root)?;
        let host_header = format!("{}:{}", discovery.host, discovery.port);
        let endpoint = discovery.endpoint();
        let address = format!("{}:{}", discovery.host, discovery.port)
            .parse::<SocketAddr>()
            .context("invalid Ghost host endpoint")?;
        let client = Self {
            origin: endpoint.clone(),
            endpoint,
            host_header,
            address,
            token: discovery.token,
        };
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let bootstrap = client.request_bootstrap(&format!("/api/v1/bootstrap/{nonce}"))?;
        if bootstrap["protocol"].as_str() != Some(metadata::PROTOCOL)
            || bootstrap["version"].as_u64() != Some(metadata::VERSION as u64)
            || !equal(
                bootstrap["proof"].as_str().unwrap_or_default(),
                &crate::local_http::control_proof(&client.token, &nonce),
            )
        {
            bail!("control endpoint is stale or does not support authenticated protocol v1");
        }
        Ok(client)
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn snapshot(&self) -> Result<Value> {
        self.request("GET", "/api/v1/snapshot", None)
    }

    pub fn events(&self, profile_id: &str, after: u64) -> Result<Value> {
        uuid::Uuid::parse_str(profile_id).context("profile id must be a UUID")?;
        self.request("GET", &format!("/api/v1/events/{profile_id}/{after}"), None)
    }

    pub fn action(&self, action: Action) -> Result<Value> {
        let body = serde_json::to_vec(&json!({
            "request_id": action.request_id,
            "command": action.command,
        }))?;
        if body.len() > RESPONSE_LIMIT {
            bail!("control action exceeds the request size limit");
        }
        self.request("POST", "/api/v1/action", Some(&body))
    }

    fn request(&self, method: &str, target: &str, body: Option<&[u8]>) -> Result<Value> {
        self.send_request(method, target, body, true)
    }

    fn request_bootstrap(&self, target: &str) -> Result<Value> {
        self.send_request("GET", target, None, false)
    }

    fn send_request(
        &self,
        method: &str,
        target: &str,
        body: Option<&[u8]>,
        authenticated: bool,
    ) -> Result<Value> {
        let mut stream = TcpStream::connect_timeout(&self.address, CONNECT_TIMEOUT)
            .context("cannot reach the local Ghost host (discovery endpoint may be stale)")?;
        stream.set_read_timeout(Some(IO_TIMEOUT))?;
        stream.set_write_timeout(Some(IO_TIMEOUT))?;
        let mut request = format!(
            "{method} {target} HTTP/1.1\r\nHost: {}\r\nOrigin: {}\r\nSec-Fetch-Site: same-origin\r\nConnection: close\r\n",
            self.host_header, self.origin
        );
        if authenticated {
            request.push_str(&format!(
                "Authorization: Bearer {}\r\nX-Ghost-CSRF: {}\r\n",
                self.token, self.token
            ));
        }
        if let Some(body) = body {
            request.push_str("Content-Type: application/json\r\n");
            request.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes())?;
        if let Some(body) = body {
            stream.write_all(body)?;
        }
        let (status, response) = read_response(stream)?;
        if !matches!(status, 200 | 202 | 204 | 409) {
            bail!(
                "Ghost control request failed with HTTP {status}: {}",
                response["error"]
            );
        }
        Ok(response)
    }
}

fn equal(left: &str, right: &str) -> bool {
    let mut diff = left.len() ^ right.len();
    for (a, b) in left.bytes().zip(right.bytes()) {
        diff |= (a ^ b) as usize;
    }
    diff == 0
}

fn read_response(stream: TcpStream) -> Result<(u16, Value)> {
    let mut reader = BufReader::new(stream);
    let mut line = read_line_limited(&mut reader, 4096)?;
    let mut parts = line.trim_end_matches("\r\n").split(' ');
    if parts.next() != Some("HTTP/1.1") {
        bail!("invalid Ghost host HTTP response");
    }
    let status = parts
        .next()
        .ok_or_else(|| anyhow!("missing HTTP status"))?
        .parse::<u16>()?;
    let mut used = line.len();
    let mut content_length = None;
    loop {
        if used > 8192 {
            bail!("Ghost host response headers are too large");
        }
        line = read_line_limited(&mut reader, 8192 - used)?;
        used += line.len();
        if line == "\r\n" {
            break;
        }
        let (key, value) = line
            .trim_end_matches("\r\n")
            .split_once(':')
            .ok_or_else(|| anyhow!("malformed Ghost host response header"))?;
        if key.eq_ignore_ascii_case("transfer-encoding") {
            bail!("unsupported Ghost host response encoding");
        }
        if key.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                bail!("duplicate Ghost host content length");
            }
            content_length = Some(value.trim().parse::<usize>()?);
        }
    }
    let size = content_length.ok_or_else(|| anyhow!("missing Ghost host content length"))?;
    if size > RESPONSE_LIMIT {
        bail!("Ghost host response is too large");
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes)?;
    if status == 204 || bytes.is_empty() {
        return Ok((status, Value::Null));
    }
    let value = serde_json::from_slice(&bytes).context("invalid Ghost host JSON response")?;
    Ok((status, value))
}

fn read_line_limited(reader: &mut BufReader<TcpStream>, limit: usize) -> Result<String> {
    let mut bytes = Vec::with_capacity(limit.min(4096));
    let read = reader
        .by_ref()
        .take(limit as u64 + 1)
        .read_until(b'\n', &mut bytes)?;
    if read == 0 || read > limit || !bytes.ends_with(b"\r\n") {
        bail!("incomplete or oversized Ghost host response line");
    }
    Ok(String::from_utf8(bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_http;
    use std::net::TcpListener;

    fn rejected_endpoint(replay_valid_proof: bool) {
        let dir = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = "a".repeat(64);
        metadata::write(dir.path(), port, token.clone(), 1).unwrap();
        let peer = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = local_http::read_with_limit(&mut stream, 1024).unwrap();
            assert!(request.target.starts_with("/api/v1/bootstrap/"));
            assert!(!request.headers.contains_key("authorization"));
            assert!(!request.headers.contains_key("x-ghost-csrf"));
            assert!(!request.target.contains(&token));
            let proof = if replay_valid_proof {
                // This is a valid proof for an older challenge, not the fresh
                // nonce sent by this discovery attempt.
                local_http::control_proof(&token, &"0".repeat(32))
            } else {
                "0".repeat(64)
            };
            let response = json!({"protocol": metadata::PROTOCOL, "version": metadata::VERSION, "proof": proof});
            local_http::respond(
                &mut stream,
                200,
                "application/json",
                response.to_string().as_bytes(),
                None,
            )
            .unwrap();
            listener
        });
        let result = ControlClient::discover(dir.path());
        assert!(result.is_err(), "a stale endpoint must fail authentication");
        let listener = peer.join().unwrap();
        listener.set_nonblocking(true).unwrap();
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
            "no authenticated request may follow a failed proof"
        );
    }

    #[test]
    fn stale_endpoint_cannot_collect_the_control_bearer() {
        rejected_endpoint(false);
    }

    #[test]
    fn bootstrap_proof_from_another_nonce_is_rejected() {
        rejected_endpoint(true);
    }
}
