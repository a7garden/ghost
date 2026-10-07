//! Fixed-route loopback transport; never a filesystem document root.
use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};
#[cfg_attr(not(feature = "ui-fixtures"), allow(dead_code))]
pub(crate) const BODY_LIMIT: usize = 16_384;
pub(crate) struct Request {
    pub method: String,
    pub target: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}
// A per-read socket timeout alone permits an indefinitely dribbled request.
// Apply a total wall-clock budget to every underlying read as well.
struct DeadlineReader<'a> {
    stream: &'a mut TcpStream,
    end: Instant,
}
impl Read for DeadlineReader<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let remaining = self.end.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "request deadline",
            ));
        }
        self.stream
            .set_read_timeout(Some(remaining.min(Duration::from_millis(200))))?;
        self.stream.read(bytes)
    }
}
#[cfg_attr(not(feature = "ui-fixtures"), allow(dead_code))]
pub(crate) fn read(stream: &mut TcpStream) -> Result<Request> {
    read_with_limit(stream, BODY_LIMIT)
}
pub(crate) fn read_with_limit(stream: &mut TcpStream, body_limit: usize) -> Result<Request> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_millis(200)))?;
    stream.set_write_timeout(Some(Duration::from_millis(500)))?;
    let mut r = std::io::BufReader::new(DeadlineReader {
        stream,
        end: Instant::now() + Duration::from_millis(600),
    });
    let mut used = 0;
    let mut line = Vec::new();
    r.by_ref().take(4097).read_until(b'\n', &mut line)?;
    used += line.len();
    let first = std::str::from_utf8(&line)?
        .strip_suffix("\r\n")
        .ok_or_else(|| anyhow!("request line"))?;
    let parts: Vec<_> = first.split(' ').collect();
    if parts.len() != 3
        || parts[2] != "HTTP/1.1"
        || !matches!(parts[0], "GET" | "POST")
        || !parts[1].starts_with('/')
        || parts[1].contains(['\r', '\n', '%', '?', '#'])
    {
        bail!("request shape");
    }
    let method = parts[0].to_string();
    let target = parts[1].to_string();
    let mut headers = HashMap::new();
    loop {
        line.clear();
        r.by_ref().take(4097).read_until(b'\n', &mut line)?;
        used += line.len();
        if used > 8192 || line.is_empty() {
            bail!("header bound");
        }
        if line == b"\r\n" {
            break;
        }
        let raw = std::str::from_utf8(&line)?
            .strip_suffix("\r\n")
            .ok_or_else(|| anyhow!("header ending"))?;
        let (key, value) = raw.split_once(':').ok_or_else(|| anyhow!("header"))?;
        if key.is_empty()
            || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || value.contains(['\r', '\n'])
        {
            bail!("header shape");
        }
        if headers
            .insert(key.to_ascii_lowercase(), value.trim().to_string())
            .is_some()
        {
            bail!("duplicate header");
        }
    }
    if headers.contains_key("transfer-encoding")
        || headers
            .get("connection")
            .is_some_and(|v| v.eq_ignore_ascii_case("upgrade"))
    {
        bail!("unsupported transfer");
    }
    let size = headers
        .get("content-length")
        .map(|v| v.parse::<usize>())
        .transpose()?
        .unwrap_or(0);
    if size > body_limit || method == "GET" && size != 0 || method == "POST" && size == 0 {
        bail!("body bound");
    }
    let mut body = vec![0; size];
    r.read_exact(&mut body)?;
    Ok(Request {
        method,
        target,
        headers,
        body,
    })
}
const CSP:&str="default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
pub(crate) fn respond(
    stream: &mut TcpStream,
    status: u16,
    kind: &str,
    body: &[u8],
    cookie: Option<&str>,
) -> Result<()> {
    let label = match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        _ => "Internal Server Error",
    };
    let extra = cookie
        .map(|v| format!("Set-Cookie: {v}\r\n"))
        .unwrap_or_default();
    write!(stream,"HTTP/1.1 {status} {label}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: {CSP}\r\n{extra}\r\n",body.len())?;
    stream.write_all(body)?;
    Ok(())
}
pub(crate) struct Session {
    pub host: String,
    pub origin: String,
    #[cfg(any(feature = "workspace-ui", feature = "ui-fixtures"))]
    csrf: String,
    #[cfg(any(feature = "workspace-ui", feature = "ui-fixtures"))]
    sid: String,
    #[cfg(any(feature = "workspace-ui", feature = "ui-fixtures"))]
    cookie_name: String,
    #[cfg(feature = "host")]
    control_token: String,
}
impl Session {
    #[cfg(feature = "ui-fixtures")]
    pub fn new(port: u16, cookie_name: &str) -> Self {
        let host = format!("127.0.0.1:{port}");
        Self {
            origin: format!("http://{host}"),
            host,
            csrf: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            sid: uuid::Uuid::new_v4().simple().to_string(),
            cookie_name: cookie_name.into(),
            #[cfg(feature = "host")]
            control_token: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
        }
    }

    #[cfg(feature = "host")]
    pub fn new_with_control_token(port: u16, _cookie_name: &str, control_token: String) -> Self {
        let host = format!("127.0.0.1:{port}");
        Self {
            origin: format!("http://{host}"),
            host,
            #[cfg(any(feature = "workspace-ui", feature = "ui-fixtures"))]
            csrf: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            #[cfg(any(feature = "workspace-ui", feature = "ui-fixtures"))]
            sid: uuid::Uuid::new_v4().simple().to_string(),
            #[cfg(any(feature = "workspace-ui", feature = "ui-fixtures"))]
            cookie_name: _cookie_name.into(),
            control_token,
        }
    }

    #[cfg(any(feature = "workspace-ui", feature = "ui-fixtures"))]
    pub fn root(&self, template: &str) -> String {
        template.replace("{{CSRF}}", &self.csrf)
    }

    #[cfg(any(feature = "workspace-ui", feature = "ui-fixtures"))]
    pub fn cookie(&self, seconds: u64) -> String {
        format!(
            "{}={}; HttpOnly; SameSite=Strict; Path=/; Max-Age={seconds}",
            self.cookie_name, self.sid
        )
    }
    pub fn host_ok(&self, r: &Request) -> bool {
        r.headers.get("host") == Some(&self.host)
    }

    #[cfg(any(feature = "workspace-ui", feature = "ui-fixtures"))]
    pub fn authorized(&self, r: &Request, write: bool) -> bool {
        if !self.host_ok(r)
            || !r
                .headers
                .get("x-ghost-csrf")
                .is_some_and(|s| equal(s, &self.csrf))
        {
            return false;
        }
        if write && r.headers.get("origin") != Some(&self.origin) {
            return false;
        }
        if r.headers.get("origin").is_some_and(|v| v != &self.origin) {
            return false;
        }
        if r.headers
            .get("sec-fetch-site")
            .is_some_and(|v| v != "same-origin" && v != "none")
        {
            return false;
        }
        let Some(cookie) = r.headers.get("cookie") else {
            return false;
        };
        let mut matches = 0;
        for pair in cookie.split(';') {
            if let Some((k, v)) = pair.trim().split_once('=') {
                if k == self.cookie_name {
                    if !equal(v, &self.sid) {
                        return false;
                    }
                    matches += 1;
                }
            }
        }
        matches == 1
            && (!write
                || r.headers
                    .get("content-type")
                    .is_some_and(|v| v == "application/json"))
    }

    #[cfg(feature = "host")]
    pub fn bootstrap_proof(&self, nonce: &str) -> String {
        control_proof(&self.control_token, nonce)
    }

    /// Authenticates a native local control client independently from the UI
    /// cookie. Exact Host and same-origin checks are still applied so this
    /// bearer credential is accepted only on the bound loopback endpoint.
    #[cfg(feature = "host")]
    pub fn control_authorized(&self, r: &Request, write: bool) -> bool {
        if !self.host_ok(r)
            || !r.headers.get("authorization").is_some_and(|value| {
                value
                    .strip_prefix("Bearer ")
                    .is_some_and(|token| equal(token, &self.control_token))
            })
            || r.headers.get("origin") != Some(&self.origin)
            || !r
                .headers
                .get("x-ghost-csrf")
                .is_some_and(|token| equal(token, &self.control_token))
        {
            return false;
        }
        if r.headers
            .get("sec-fetch-site")
            .is_some_and(|v| v != "same-origin" && v != "none")
        {
            return false;
        }
        !write
            || r.headers
                .get("content-type")
                .is_some_and(|v| v == "application/json")
    }
}
#[cfg(feature = "host")]
pub(crate) fn control_proof(token: &str, nonce: &str) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let mut mac =
        Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("HMAC accepts any key length");
    mac.update(b"ghost-control-bootstrap-v1\0");
    mac.update(nonce.as_bytes());
    let bytes = mac.finalize().into_bytes();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}
fn equal(a: &str, b: &str) -> bool {
    let mut diff = a.len() ^ b.len();
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= (x ^ y) as usize;
    }
    diff == 0
}
