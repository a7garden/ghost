//! Small host-controlled text transport for OpenAI-compatible streaming.
//! No auth discovery, tools, redirects, proxies, automatic retries or fallback.
use crate::provider::{Provider, ProviderRequest, ProviderResponse};
use crate::provider_control::*;
use anyhow::Result;
use reqwest::{
    header::{HeaderValue, AUTHORIZATION},
    Url,
};
use serde_json::{json, Value};
use std::net::IpAddr;
#[cfg(feature = "native-fixtures")]
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    OpenAi,
    Zai,
}
impl Preset {
    pub fn id(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Zai => "zai",
        }
    }
    pub fn endpoint(self) -> &'static str {
        match self {
            Self::OpenAi => "https://api.openai.com/v1/chat/completions",
            Self::Zai => "https://api.z.ai/api/paas/v4/chat/completions",
        }
    }
}

/// An explicit host approval for one exact preset endpoint. A model has no
/// API to create this object. There is no default approval or URL override.
#[derive(Debug, Clone)]
pub struct EndpointApproval {
    preset: Preset,
    url: Url,
    fixture: bool,
}
impl EndpointApproval {
    pub fn approve(preset: Preset, endpoint: &str) -> Result<Self> {
        let url = Url::parse(endpoint)
            .map_err(|_| CallFailure::new(FailureKind::Policy, OutcomeClass::NotSent))?;
        if endpoint != preset.endpoint()
            || url.username() != ""
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.scheme() != "https"
        {
            return Err(CallFailure::new(FailureKind::Policy, OutcomeClass::NotSent).into());
        }
        Ok(Self {
            preset,
            url,
            fixture: false,
        })
    }
    /// Test-build-only, pinned literal loopback. Not available in the default
    /// production build and cannot be created from serialized configuration.
    #[cfg(feature = "native-fixtures")]
    pub fn fixture(preset: Preset, addr: SocketAddr) -> Result<Self> {
        if addr.ip() != IpAddr::V4(Ipv4Addr::LOCALHOST) || addr.port() < 1024 {
            return Err(CallFailure::new(FailureKind::Policy, OutcomeClass::NotSent).into());
        }
        let path = Url::parse(preset.endpoint()).unwrap().path().to_string();
        let url = Url::parse(&format!("http://{addr}{path}")).unwrap();
        Ok(Self {
            preset,
            url,
            fixture: true,
        })
    }
}

/// In-memory explicit injection only. No Debug/Serialize value, no env/file
/// loader. A later credential UI is a separate unit.
pub struct MemoryCredential(String);
impl MemoryCredential {
    pub fn new(value: String) -> Result<Self> {
        if !(16..=256).contains(&value.len()) || !value.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(CallFailure::new(FailureKind::Configuration, OutcomeClass::NotSent).into());
        }
        Ok(Self(value))
    }
}
impl std::fmt::Debug for MemoryCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MemoryCredential([REDACTED])")
    }
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub response_bytes: usize,
    pub output_bytes: usize,
    pub events: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            response_bytes: 262_144,
            output_bytes: 65_536,
            events: 256,
        }
    }
}

pub struct NativeProvider {
    approval: EndpointApproval,
    credential: MemoryCredential,
    model: String,
    limits: Limits,
}
impl std::fmt::Debug for NativeProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeProvider")
            .field("descriptor", &self.descriptor())
            .field("credential", &self.credential)
            .finish()
    }
}
impl NativeProvider {
    pub fn new(
        approval: EndpointApproval,
        model: String,
        credential: MemoryCredential,
        limits: Limits,
    ) -> Result<Self> {
        if model.is_empty()
            || model.len() > 128
            || !model
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._/".contains(&b))
            || model.contains(&credential.0)
            || limits.response_bytes == 0
            || limits.response_bytes > 1_048_576
            || limits.output_bytes == 0
            || limits.output_bytes > 262_144
            || limits.events == 0
            || limits.events > 1024
        {
            return Err(CallFailure::new(FailureKind::Configuration, OutcomeClass::NotSent).into());
        }
        Ok(Self {
            approval,
            model,
            credential,
            limits,
        })
    }
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            provider_id: self.approval.preset.id().into(),
            model: self.model.clone(),
            endpoint: self.approval.url.to_string(),
        }
    }
    fn redact(&self, input: &str) -> String {
        input.replace(&self.credential.0, "[REDACTED]")
    }
    async fn execute(
        &self,
        req: &ProviderRequest,
        attempt_id: &str,
        dispatched: &AtomicBool,
        observer: &mut dyn FnMut(&StreamEvent) -> Result<()>,
    ) -> Result<CallResult> {
        let bad_config = || CallFailure::new(FailureKind::Configuration, OutcomeClass::NotSent);
        if req.prompt.len() > 65_536 || req.persona.len() > 4_096 {
            return Err(bad_config().into());
        }
        for id in [
            req.profile_uuid.as_str(),
            req.session_uuid.as_str(),
            req.task_uuid.as_str(),
            attempt_id,
        ] {
            uuid::Uuid::parse_str(id).map_err(|_| bad_config())?;
        }
        let url = &self.approval.url;
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .pool_max_idle_per_host(0)
            .http1_only();
        if !self.approval.fixture {
            let host = url.host_str().ok_or_else(bad_config)?;
            let port = url.port_or_known_default().ok_or_else(bad_config)?;
            let addresses: Vec<_> = tokio::net::lookup_host((host, port))
                .await
                .map_err(|_| CallFailure::new(FailureKind::Network, OutcomeClass::NotSent))?
                .collect();
            if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
                return Err(CallFailure::new(FailureKind::Policy, OutcomeClass::NotSent).into());
            }
            // Pin this checked resolution for the exact hostname, preventing
            // a second DNS lookup from redirecting to a private address.
            builder = builder.https_only(true).resolve_to_addrs(host, &addresses);
        }
        let client = builder.build().map_err(|_| bad_config())?;
        let mut authorization = HeaderValue::from_str(&format!("Bearer {}", self.credential.0))
            .map_err(|_| bad_config())?;
        authorization.set_sensitive(true);
        let body = json!({"model": self.model, "stream": true,
        "stream_options": {"include_usage": true}, "max_tokens": 512,
        "messages": [
            {"role":"system", "content":format!("Ghost {}. Persona: {}", req.profile_uuid, self.redact(&req.persona))},
            {"role":"user", "content":self.redact(&req.prompt)}
        ]});
        let request = client
            .post(url.clone())
            .header(AUTHORIZATION, authorization)
            .header("X-Request-ID", attempt_id)
            .json(&body)
            .build()
            .map_err(|_| bad_config())?;
        observer(&StreamEvent::DispatchStarted)
            .map_err(|_| CallFailure::new(FailureKind::Observer, OutcomeClass::NotSent))?;
        dispatched.store(true, Ordering::SeqCst);
        let mut response = client
            .execute(request)
            .await
            .map_err(|_| CallFailure::new(FailureKind::Network, OutcomeClass::Uncertain))?;
        let status = response.status().as_u16();
        if status != 200 {
            // Never read, log or store an untrusted error body/headers/URL.
            let (kind, outcome) = match status {
                401 | 403 => (FailureKind::Authentication, OutcomeClass::Rejected),
                429 => (FailureKind::RateLimit, OutcomeClass::Rejected),
                300..=399 => (FailureKind::Redirect, OutcomeClass::Uncertain),
                400..=499 => (FailureKind::Protocol, OutcomeClass::Rejected),
                _ => (FailureKind::Server, OutcomeClass::Uncertain),
            };
            return Err(CallFailure::new(kind, outcome).into());
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        if content_type != "text/event-stream" {
            return Err(protocol_error());
        }
        let mut decoder = Decoder::new(&self.credential.0, &self.limits);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| CallFailure::new(FailureKind::Network, OutcomeClass::Uncertain))?
        {
            if decoder.push(&chunk, observer)? {
                return Ok(decoder.result());
            }
        }
        // EOF/finish_reason alone is not a complete stream receipt.
        Err(protocol_error())
    }
}

impl Provider for NativeProvider {
    fn name(&self) -> &'static str {
        self.approval.preset.id()
    }
    fn run(&self, req: &ProviderRequest) -> Result<ProviderResponse> {
        let result = self.run_controlled(
            req,
            &uuid::Uuid::new_v4().to_string(),
            &RunControl::default(),
            &mut |_| Ok(()),
        )?;
        Ok(ProviderResponse {
            content: result.content,
        })
    }
    fn native_descriptor(&self) -> Option<ProviderDescriptor> {
        Some(self.descriptor())
    }
    fn run_controlled(
        &self,
        req: &ProviderRequest,
        attempt_id: &str,
        control: &RunControl,
        observer: &mut dyn FnMut(&StreamEvent) -> Result<()>,
    ) -> Result<CallResult> {
        if control.cancellation.is_cancelled() {
            return Err(CallFailure::new(FailureKind::Cancelled, OutcomeClass::NotSent).into());
        }
        if control.timeout.is_zero() || control.timeout > std::time::Duration::from_secs(120) {
            return Err(CallFailure::new(FailureKind::Configuration, OutcomeClass::NotSent).into());
        }
        if tokio::runtime::Handle::try_current().is_ok() {
            return Err(CallFailure::new(FailureKind::Configuration, OutcomeClass::NotSent).into());
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| CallFailure::new(FailureKind::Configuration, OutcomeClass::NotSent))?;
        let dispatched = AtomicBool::new(false);
        runtime.block_on(async {
            tokio::select! {
                biased;
                _ = control.cancellation.cancelled() => Err(CallFailure::new(FailureKind::Cancelled,
                    if dispatched.load(Ordering::SeqCst) { OutcomeClass::Uncertain } else { OutcomeClass::NotSent }).into()),
                _ = tokio::time::sleep(control.timeout) => Err(CallFailure::new(FailureKind::Timeout,
                    if dispatched.load(Ordering::SeqCst) { OutcomeClass::Uncertain } else { OutcomeClass::NotSent }).into()),
                result = self.execute(req, attempt_id, &dispatched, observer) => result,
            }
        })
    }
}

fn protocol_error() -> anyhow::Error {
    CallFailure::new(FailureKind::Protocol, OutcomeClass::Uncertain).into()
}
fn limit_error() -> anyhow::Error {
    CallFailure::new(FailureKind::Limit, OutcomeClass::Uncertain).into()
}

/// Conservative public-address filter, also rejecting IPv4-mapped private
/// IPv6 and transition/documentation ranges. No production DNS call in tests.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 100 && (64..=127).contains(&b))
                || (a == 198 && (18..=19).contains(&b))
                || (a == 192 && b == 88 && c == 99)
                || (a == 192 && b == 0)
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let s = ip.segments();
            s[0] & 0xe000 == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
                && s[0] != 0x2002
        }
    }
}

struct Redactor<'a> {
    secret: &'a str,
    pending: String,
}
impl<'a> Redactor<'a> {
    fn push(&mut self, delta: &str, flush: bool) -> String {
        self.pending.push_str(delta);
        let mut output = String::new();
        while let Some(i) = self.pending.find(self.secret) {
            output.push_str(&self.pending[..i]);
            output.push_str("[REDACTED]");
            self.pending.drain(..i + self.secret.len());
        }
        let mut cutoff = if flush {
            self.pending.len()
        } else {
            self.pending.len().saturating_sub(self.secret.len() - 1)
        };
        while !self.pending.is_char_boundary(cutoff) {
            cutoff -= 1;
        }
        output.push_str(&self.pending[..cutoff]);
        self.pending.drain(..cutoff);
        output
    }
}

struct Decoder<'a> {
    pending: Vec<u8>,
    data: String,
    bytes: usize,
    frames: usize,
    content: String,
    finished: bool,
    usage: Option<TokenUsage>,
    redactor: Redactor<'a>,
    limits: &'a Limits,
}
impl<'a> Decoder<'a> {
    fn new(secret: &'a str, limits: &'a Limits) -> Self {
        Self {
            pending: Vec::new(),
            data: String::new(),
            bytes: 0,
            frames: 0,
            content: String::new(),
            finished: false,
            usage: None,
            redactor: Redactor {
                secret,
                pending: String::new(),
            },
            limits,
        }
    }
    fn emit_text(
        &mut self,
        text: String,
        observer: &mut dyn FnMut(&StreamEvent) -> Result<()>,
    ) -> Result<()> {
        if self.content.len() + text.len() > self.limits.output_bytes {
            return Err(limit_error());
        }
        if !text.is_empty() {
            self.content.push_str(&text);
            observer(&StreamEvent::TextDelta(text))
                .map_err(|_| CallFailure::new(FailureKind::Observer, OutcomeClass::Uncertain))?;
        }
        Ok(())
    }
    fn push(
        &mut self,
        chunk: &[u8],
        observer: &mut dyn FnMut(&StreamEvent) -> Result<()>,
    ) -> Result<bool> {
        self.bytes = self
            .bytes
            .checked_add(chunk.len())
            .ok_or_else(limit_error)?;
        if self.bytes > self.limits.response_bytes {
            return Err(limit_error());
        }
        self.pending.extend_from_slice(chunk);
        while let Some(pos) = self.pending.iter().position(|b| *b == b'\n') {
            let bytes: Vec<u8> = self.pending.drain(..=pos).collect();
            let line = std::str::from_utf8(&bytes)
                .map_err(|_| protocol_error())?
                .trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    let data = std::mem::take(&mut self.data);
                    if self.frame(&data, observer)? {
                        return Ok(true);
                    }
                }
            } else if let Some(value) = line.strip_prefix("data:") {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(value.strip_prefix(' ').unwrap_or(value));
            } // comments/event/id/retry never confer authority or cause replay.
            if self.data.len() > 65_536 {
                return Err(limit_error());
            }
        }
        Ok(false)
    }
    fn frame(
        &mut self,
        data: &str,
        observer: &mut dyn FnMut(&StreamEvent) -> Result<()>,
    ) -> Result<bool> {
        self.frames += 1;
        if self.frames > self.limits.events {
            return Err(limit_error());
        }
        if data == "[DONE]" {
            if !self.finished {
                return Err(protocol_error());
            }
            let tail = self.redactor.push("", true);
            self.emit_text(tail, observer)?;
            observer(&StreamEvent::Completed)
                .map_err(|_| CallFailure::new(FailureKind::Observer, OutcomeClass::Uncertain))?;
            return Ok(true);
        }
        let v: Value = serde_json::from_str(data).map_err(|_| protocol_error())?;
        if v.get("error").is_some() {
            return Err(protocol_error());
        }
        if let Some(usage) = v.get("usage").filter(|u| !u.is_null()) {
            if self.usage.is_some() {
                return Err(protocol_error());
            }
            let number = |key| {
                usage
                    .get(key)
                    .and_then(Value::as_u64)
                    .filter(|n| *n <= 1_000_000_000_000)
                    .ok_or_else(protocol_error)
            };
            let usage = TokenUsage {
                input_tokens: number("prompt_tokens")?,
                output_tokens: number("completion_tokens")?,
                total_tokens: number("total_tokens")?,
            };
            observer(&StreamEvent::Usage(usage.clone()))
                .map_err(|_| CallFailure::new(FailureKind::Observer, OutcomeClass::Uncertain))?;
            self.usage = Some(usage);
        }
        let choices = v
            .get("choices")
            .and_then(Value::as_array)
            .ok_or_else(protocol_error)?;
        if choices.len() > 1 {
            return Err(protocol_error());
        }
        if let Some(choice) = choices.first() {
            if choice.get("index").and_then(Value::as_u64) != Some(0) || self.finished {
                return Err(protocol_error());
            }
            let delta = choice
                .get("delta")
                .and_then(Value::as_object)
                .ok_or_else(protocol_error)?;
            if delta.get("tool_calls").is_some() || delta.get("function_call").is_some() {
                return Err(protocol_error());
            }
            if let Some(text) = delta.get("content").filter(|v| !v.is_null()) {
                let text = text.as_str().ok_or_else(protocol_error)?;
                let safe = self.redactor.push(text, false);
                self.emit_text(safe, observer)?;
            }
            if let Some(reason) = choice.get("finish_reason").filter(|v| !v.is_null()) {
                if !matches!(reason.as_str(), Some("stop") | Some("length")) {
                    return Err(protocol_error());
                }
                self.finished = true;
            }
        }
        Ok(false)
    }
    fn result(self) -> CallResult {
        CallResult {
            content: self.content,
            usage: self.usage,
        }
    }
}
