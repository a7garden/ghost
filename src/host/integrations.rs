//! Owner-configured MCP connections. No global config discovery or model-issued setup.
use super::{now_ms, text, Host, State};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
};

const LIMIT: usize = 1_048_576;
const DEADLINE: Duration = Duration::from_secs(25);
const PROTOCOL: &str = "2025-06-18";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Transport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        /// Values are host environment variable names, never credentials.
        #[serde(default)]
        env_refs: BTreeMap<String, String>,
        cwd: Option<String>,
    },
    Http {
        url: String,
        bearer_env: Option<String>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntegrationInput {
    pub name: String,
    pub transport: Transport,
    #[serde(default)]
    pub profiles: Vec<String>,
    #[serde(default)]
    pub enabled: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Integration {
    pub id: String,
    #[serde(flatten)]
    pub data: IntegrationInput,
    pub version: u64,
    pub tools: Vec<Value>,
    pub checked_ms: Option<u64>,
    pub error: Option<String>,
}
fn env_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || i > 0 && b.is_ascii_digit())
}
pub(crate) fn save(
    s: &State,
    key: &str,
    id: Option<&str>,
    version: Option<u64>,
    data: IntegrationInput,
) -> Result<Value> {
    text(&data.name, 200)?;
    if data.profiles.len() > 64 || data.profiles.iter().any(|p| !s.profiles.contains_key(p)) {
        bail!("연동을 사용할 Dot을 확인해 주세요.");
    }
    match &data.transport {
        Transport::Stdio {
            command,
            args,
            env_refs,
            cwd,
        } => {
            text(command, 2048)?;
            if args.len() > 64
                || args.iter().any(|a| a.len() > 4096)
                || env_refs.len() > 64
                || env_refs.iter().any(|(k, v)| !env_name(k) || !env_name(v))
            {
                bail!("실행 인자와 환경 변수 이름을 확인해 주세요.");
            }
            if let Some(cwd) = cwd {
                if !std::path::Path::new(cwd).is_absolute() || !std::path::Path::new(cwd).is_dir() {
                    bail!("작업 폴더는 존재하는 절대 경로여야 합니다.");
                }
            }
        }
        Transport::Http { url, bearer_env } => {
            text(url, 4096)?;
            let url = reqwest::Url::parse(url).map_err(|_| anyhow!("MCP 주소를 확인해 주세요."))?;
            let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
            if !(url.scheme() == "https" || url.scheme() == "http" && local)
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
                || url.query().is_some()
            {
                bail!("HTTPS MCP 주소를 입력하세요. 로컬 호스트는 HTTP도 지원합니다. 인증은 환경 변수로 지정하세요.");
            }
            if bearer_env.as_ref().is_some_and(|e| !env_name(e)) {
                bail!("토큰 대신 환경 변수 이름을 입력해 주세요.");
            }
        }
    }
    let old: Option<Integration> = s.journal.get("integration", id.unwrap_or(key))?;
    if id.is_some() && (old.is_none() || old.as_ref().map(|i| i.version) != version) {
        bail!("연동 설정이 변경되었습니다. 다시 열어 수정해 주세요.");
    }
    let integration = Integration {
        id: id.unwrap_or(key).into(),
        data,
        version: old.map_or(1, |i| i.version + 1),
        tools: vec![],
        checked_ms: None,
        error: None,
    };
    s.journal
        .put("integration", &integration.id, &integration)?;
    Ok(json!(integration))
}
pub(crate) fn allowed(s: &State, id: &str, owner: Option<&str>) -> Result<Integration> {
    let item: Integration = s
        .journal
        .get("integration", id)?
        .ok_or_else(|| anyhow!("연동을 찾지 못했습니다."))?;
    if !item.data.enabled || owner.is_some_and(|o| !item.data.profiles.iter().any(|p| p == o)) {
        bail!("이 Dot에 대한 연동이 꺼져 있습니다.");
    }
    Ok(item)
}
pub(crate) fn visible(s: &State, owner: &str) -> Result<Value> {
    Ok(
        json!({"integrations":s.journal.objects::<Integration>("integration")?.into_iter()
        .filter(|i|i.data.enabled && i.data.profiles.iter().any(|p|p==owner))
        .map(|i|json!({"id":i.id,"name":i.data.name,"tool_count":i.tools.len(),"checked_ms":i.checked_ms,"error":i.error})).collect::<Vec<_>>()}),
    )
}

type Slot = Arc<tokio::sync::Mutex<Option<Session>>>;
type ConnectionScope = (String, Option<String>);

#[derive(Default)]
pub(crate) struct Connections(Mutex<BTreeMap<ConnectionScope, Slot>>);
impl Connections {
    pub(crate) fn remove(&self, id: &str) {
        if let Ok(mut slots) = self.0.lock() {
            slots.retain(|(integration, _), _| integration != id);
        }
    }
    pub(crate) fn clear(&self) {
        if let Ok(mut slots) = self.0.lock() {
            slots.clear();
        }
    }
    fn slot(&self, id: &str, owner: Option<&str>) -> Result<Slot> {
        Ok(self
            .0
            .lock()
            .map_err(|_| anyhow!("연동 상태를 읽지 못했습니다."))?
            .entry((id.into(), owner.map(str::to_owned)))
            .or_default()
            .clone())
    }
}
enum Wire {
    Stdio {
        _child: Child,
        input: ChildStdin,
        output: BufReader<ChildStdout>,
    },
    Http {
        client: reqwest::Client,
        url: String,
        token: Option<String>,
        session: Option<String>,
        protocol: String,
    },
}
struct Session {
    version: u64,
    wire: Wire,
    sequence: u64,
    tools: Vec<Value>,
}
impl Session {
    async fn open(item: &Integration) -> Result<Self> {
        let wire = match &item.data.transport {
            Transport::Stdio {
                command,
                args,
                env_refs,
                cwd,
            } => {
                let mut process = tokio::process::Command::new(command);
                process
                    .args(args)
                    .env_clear()
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .kill_on_drop(true);
                for key in ["PATH", "HOME", "USER", "TMPDIR", "LANG", "XDG_CONFIG_HOME"] {
                    if let Some(v) = std::env::var_os(key) {
                        process.env(key, v);
                    }
                }
                for (key, reference) in env_refs {
                    process.env(
                        key,
                        std::env::var(reference).map_err(|_| {
                            anyhow!("호스트 환경 변수 {reference}를 설정한 뒤 다시 연결해 주세요.")
                        })?,
                    );
                }
                if let Some(cwd) = cwd {
                    process.current_dir(cwd);
                }
                let mut child = process.spawn().map_err(|_| {
                    anyhow!(
                        "MCP 프로그램을 실행하지 못했습니다. 설치 여부와 실행 경로를 확인하세요."
                    )
                })?;
                let input = child.stdin.take().context("MCP stdin unavailable")?;
                let output = BufReader::new(child.stdout.take().context("MCP stdout unavailable")?);
                Wire::Stdio {
                    _child: child,
                    input,
                    output,
                }
            }
            Transport::Http { url, bearer_env } => Wire::Http {
                client: reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(DEADLINE)
                    .build()?,
                url: url.clone(),
                token: bearer_env
                    .as_ref()
                    .map(|key| {
                        std::env::var(key).map_err(|_| {
                            anyhow!("호스트 환경 변수 {key}를 설정한 뒤 다시 연결해 주세요.")
                        })
                    })
                    .transpose()?,
                session: None,
                protocol: PROTOCOL.into(),
            },
        };
        let mut this = Self {
            version: item.version,
            wire,
            sequence: 0,
            tools: vec![],
        };
        let hello = this.rpc("initialize", json!({"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"ghost","version":env!("CARGO_PKG_VERSION")}})).await?;
        let protocol = hello["protocolVersion"]
            .as_str()
            .context("MCP protocolVersion missing")?;
        if !matches!(
            protocol,
            "2024-11-05" | "2025-03-26" | "2025-06-18" | "2025-11-25"
        ) {
            bail!("지원하지 않는 MCP 프로토콜 버전입니다.");
        }
        if let Wire::Http { protocol: p, .. } = &mut this.wire {
            *p = protocol.into();
        }
        this.wire
            .exchange(
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                None,
            )
            .await?;
        this.refresh().await?;
        Ok(this)
    }
    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        self.sequence += 1;
        self.wire
            .exchange(
                json!({"jsonrpc":"2.0","id":self.sequence,"method":method,"params":params}),
                Some(self.sequence),
            )
            .await
    }
    async fn refresh(&mut self) -> Result<()> {
        let mut tools = vec![];
        let mut cursor = Value::Null;
        let mut seen = std::collections::BTreeSet::new();
        for _ in 0..32 {
            let page = self
                .rpc(
                    "tools/list",
                    if cursor.is_null() {
                        json!({})
                    } else {
                        json!({"cursor":cursor})
                    },
                )
                .await?;
            for tool in page["tools"]
                .as_array()
                .context("MCP tools/list 형식이 올바르지 않습니다.")?
            {
                let name = tool["name"].as_str().context("MCP tool name missing")?;
                if name.is_empty()
                    || name.len() > 256
                    || tool["inputSchema"]["type"] != "object"
                    || !seen.insert(name.to_string())
                {
                    bail!("MCP 도구 정의가 잘못되었거나 중복됩니다.");
                }
                tools.push(tool.clone());
            }
            if tools.len() > 1000 || serde_json::to_vec(&tools)?.len() > LIMIT {
                bail!("MCP 도구가 너무 많습니다. 서버에서 사용할 서비스를 줄여 주세요.");
            }
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                self.tools = tools;
                return Ok(());
            }
            if !cursor.is_string() {
                bail!("MCP cursor invalid");
            }
        }
        bail!("MCP 도구 목록 페이지 한도를 초과했습니다.")
    }
}
fn response(value: Value, id: u64) -> Result<Option<Value>> {
    if value["id"].as_u64() != Some(id) || value.get("method").is_some() {
        return Ok(None);
    }
    if value["jsonrpc"] != "2.0" {
        bail!("MCP response version invalid");
    }
    if value.get("error").is_some() {
        bail!("MCP 서버가 요청을 거절했습니다. 서버의 인증 및 도구 설정을 확인하세요.");
    }
    Ok(Some(
        value.get("result").cloned().context("MCP result missing")?,
    ))
}
impl Wire {
    async fn exchange(&mut self, payload: Value, id: Option<u64>) -> Result<Value> {
        match self {
            Self::Stdio { input, output, .. } => {
                let mut bytes = serde_json::to_vec(&payload)?;
                bytes.push(b'\n');
                input.write_all(&bytes).await?;
                input.flush().await?;
                let Some(id) = id else { return Ok(Value::Null) };
                loop {
                    let mut line = Vec::new();
                    let count = (&mut *output)
                        .take((LIMIT + 1) as u64)
                        .read_until(b'\n', &mut line)
                        .await?;
                    if count == 0 {
                        bail!("MCP 프로세스가 종료되었습니다. 실행 설정과 로그인을 확인하세요.");
                    }
                    if count > LIMIT {
                        bail!("MCP 응답 크기 한도를 초과했습니다.");
                    }
                    let message: Value = serde_json::from_slice(&line)
                        .context("MCP stdout에는 JSON-RPC만 출력해야 합니다.")?;
                    if message.get("method").is_some() && message.get("id").is_some() {
                        // Ghost does not give remote servers model execution or host roots.
                        let reply = if message["method"] == "ping" {
                            json!({"jsonrpc":"2.0","id":message["id"],"result":{}})
                        } else {
                            json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32601,"message":"Client capability unavailable"}})
                        };
                        let mut bytes = serde_json::to_vec(&reply)?;
                        bytes.push(b'\n');
                        input.write_all(&bytes).await?;
                        input.flush().await?;
                    } else if let Some(result) = response(message, id)? {
                        return Ok(result);
                    }
                }
            }
            Self::Http {
                client,
                url,
                token,
                session,
                protocol,
            } => {
                let mut request = client
                    .post(url.as_str())
                    .header("Accept", "application/json, text/event-stream")
                    .header("MCP-Protocol-Version", protocol.as_str())
                    .json(&payload);
                if let Some(token) = token {
                    request = request.bearer_auth(token.as_str());
                }
                if let Some(session) = session {
                    request = request.header("Mcp-Session-Id", session.as_str());
                }
                let mut reply = request.send().await.map_err(|_| {
                    anyhow!("MCP 서버에 연결하지 못했습니다. 주소와 인증 설정을 확인하세요.")
                })?;
                if !reply.status().is_success() {
                    bail!(
                        "MCP HTTP {}: 서버 주소와 인증을 확인해 주세요.",
                        reply.status().as_u16()
                    );
                }
                if payload["method"] == "initialize" {
                    if let Some(value) = reply.headers().get("Mcp-Session-Id") {
                        *session = Some(value.to_str()?.into());
                    }
                }
                let Some(id) = id else { return Ok(Value::Null) };
                let sse = reply
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| v.starts_with("text/event-stream"));
                let mut bytes = Vec::new();
                let mut total = 0;
                while let Some(chunk) = reply
                    .chunk()
                    .await
                    .map_err(|_| anyhow!("MCP 응답이 중단되었습니다."))?
                {
                    total += chunk.len();
                    if total > LIMIT {
                        bail!("MCP 응답 크기 한도를 초과했습니다.");
                    }
                    bytes.extend(chunk);
                    if sse {
                        // Frame complete SSE events; handle CRLF and UTF-8 split across chunks.
                        while let Some((end, width)) = event_boundary(&bytes) {
                            let frame = String::from_utf8(bytes[..end].to_vec())?;
                            bytes.drain(..end + width);
                            let data = frame
                                .lines()
                                .filter_map(|l| {
                                    l.strip_prefix("data:")
                                        .map(|d| d.strip_prefix(' ').unwrap_or(d))
                                })
                                .collect::<Vec<_>>()
                                .join("\n");
                            if !data.is_empty() {
                                if let Some(result) = response(serde_json::from_str(&data)?, id)? {
                                    return Ok(result);
                                }
                            }
                        }
                    }
                }
                if !sse {
                    if let Some(result) = response(serde_json::from_slice(&bytes)?, id)? {
                        return Ok(result);
                    }
                }
                bail!("MCP 응답이 완료되지 않았습니다.")
            }
        }
    }
}
fn event_boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    (0..bytes.len()).find_map(|i| {
        if bytes[i..].starts_with(b"\r\n\r\n") {
            Some((i, 4))
        } else if bytes[i..].starts_with(b"\n\n") {
            Some((i, 2))
        } else {
            None
        }
    })
}

/// `check` is run again immediately before dispatch, including delegation lineage.
pub(crate) async fn run(
    app: &Host,
    id: &str,
    owner: Option<&str>,
    call: Option<(&str, Value)>,
    check: impl Fn() -> Result<()>,
) -> Result<Value> {
    let item = allowed(&*app.lock()?, id, owner)?;
    // Two Ghosts may be granted the same server, but neither inherits the
    // other's stdio process or HTTP session. Owner diagnostics are separate too.
    let slot = app.integrations.slot(id, owner)?;
    let operation = async {
        let mut guard = slot.lock().await;
        // Taking ownership makes cancellation discard the process and any stale response.
        let mut session = match guard.take() {
            Some(s) if s.version == item.version => s,
            _ => Session::open(&item).await?,
        };
        if call.is_none() {
            session.refresh().await?;
        }
        check()?;
        {
            let s = app.lock()?;
            let mut current = allowed(&s, id, owner)?;
            if current.version != item.version {
                bail!("연동 설정이 변경되었습니다. 도구 목록을 다시 확인하세요.");
            }
            current.tools = session.tools.clone();
            current.checked_ms = Some(now_ms());
            current.error = None;
            s.journal.put("integration", id, &current)?;
        }
        let result = if let Some((name, arguments)) = call {
            if !arguments.is_object() || serde_json::to_vec(&arguments)?.len() > 65536 {
                bail!("MCP 도구 입력은 64 KiB 이내의 JSON 객체여야 합니다.");
            }
            if !session.tools.iter().any(|t| t["name"] == name) {
                bail!("해당 MCP 도구가 없습니다. 도구 목록을 다시 확인하세요.");
            }
            let value = session
                .rpc("tools/call", json!({"name":name,"arguments":arguments}))
                .await?;
            if (!value["content"].is_array() && !value["structuredContent"].is_object())
                || value.get("isError").is_some_and(|v| !v.is_boolean())
            {
                bail!("MCP 도구 결과 형식이 잘못되었습니다. 서비스에서 실행 결과를 확인하세요.");
            }
            value
        } else {
            json!({"tools":session.tools})
        };
        *guard = Some(session);
        Ok(result)
    };
    let result=tokio::time::timeout(DEADLINE,operation).await.unwrap_or_else(|_|Err(anyhow!("연동 응답 시간이 초과되었습니다. 변경 작업이었다면 서비스에서 결과를 확인한 뒤 다시 요청하세요.")));
    if let Err(error) = &result {
        let s = app.lock()?;
        if let Some(mut current) = s.journal.get::<Integration>("integration", id)? {
            if current.version == item.version {
                current.checked_ms = Some(now_ms());
                current.error = Some(error.to_string());
                s.journal.put("integration", id, &current)?;
            }
        }
    }
    result
}
