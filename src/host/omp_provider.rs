//! OMP's authenticated stdio gateway as a Ghost model provider.
//!
//! Requests use OMP's existing local credential store. No API key is copied
//! into Ghost, no gateway port is opened, and retry/fallback chains are off.

use crate::durable::durable::ai;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    time::timeout,
};

pub(crate) const MODEL_ENV: &str = "GHOST_OMP_SUBSCRIPTION_MODELS";
pub(crate) const ENDPOINT: &str = "omp+stdio://local";
const EXECUTABLE_ENV: &str = "GHOST_OMP_EXECUTABLE";
const MAX_CATALOG_BYTES: usize = 4 * 1024;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;
const DEADLINE: Duration = Duration::from_secs(180);

fn allowed_provider(provider: &str) -> bool {
    matches!(provider, "zai" | "minimax-code")
}

fn valid_model_id(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 300
        && model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

/// Explicit model allowlist. The OMP CLI still performs authentication and
/// model routing; Ghost exposes only these named provider/model pairs.
pub(crate) fn model_specs() -> Vec<(String, String)> {
    let Some(raw) = std::env::var_os(MODEL_ENV) else {
        return Vec::new();
    };
    let Some(raw) = raw
        .to_str()
        .filter(|value| value.len() <= MAX_CATALOG_BYTES)
    else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for item in raw.split(',') {
        let Some((provider, model)) = item.trim().split_once('/') else {
            continue;
        };
        if !allowed_provider(provider) || !valid_model_id(model) {
            continue;
        }
        let pair = (provider.to_owned(), model.to_owned());
        if !result.contains(&pair) && result.len() < 32 {
            result.push(pair);
        }
    }
    result
}

fn executable() -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os(EXECUTABLE_ENV)?);
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
    executable().is_some() && !model_specs().is_empty()
}

pub(crate) fn is_allowed(provider: &str, model: &str) -> bool {
    model_specs()
        .iter()
        .any(|(candidate_provider, candidate_model)| {
            candidate_provider == provider && candidate_model == model
        })
}

pub(crate) fn subscription_providers() -> Vec<super::models::Provider> {
    if executable().is_none() {
        return Vec::new();
    }
    let mut by_provider = BTreeMap::<String, Vec<super::models::Model>>::new();
    for (provider, id) in model_specs() {
        let name = match id.as_str() {
            "glm-5.1" => "GLM-5.1".to_owned(),
            _ => id.clone(),
        };
        by_provider
            .entry(provider)
            .or_default()
            .push(super::models::Model {
                id,
                name,
                roles: vec![super::models::Role::Llm],
            });
    }
    by_provider
        .into_iter()
        .map(|(id, mut models)| {
            models.sort_by(|a, b| a.name.cmp(&b.name));
            super::models::Provider {
                name: match id.as_str() {
                    "zai" => "Z.AI · OMP 구독".into(),
                    "minimax-code" => "MiniMax · OMP 구독".into(),
                    _ => id.clone(),
                },
                id,
                kind: super::models::Kind::OmpSubscription,
                endpoint: ENDPOINT.into(),
                auth: super::models::Auth::None,
                roles: vec![super::models::Role::Llm],
                models,
                enabled: true,
                checked_ms: None,
                error: None,
            }
        })
        .collect()
}

pub(crate) fn probe(provider: &str) -> Result<Vec<super::models::Model>> {
    if executable().is_none() {
        bail!("OMP CLI를 사용할 수 없습니다.");
    }
    let Some(entry) = subscription_providers()
        .into_iter()
        .find(|entry| entry.id == provider)
    else {
        bail!("OMP 구독 모델이 허용 목록에 없습니다.");
    };
    Ok(entry.models)
}

pub(crate) fn create(provider: &str) -> Result<Arc<dyn ai::Provider>> {
    if !allowed_provider(provider) || !subscription_providers().iter().any(|p| p.id == provider) {
        bail!("OMP 구독 제공자를 사용할 수 없습니다.");
    }
    let executable = executable().ok_or_else(|| anyhow!("OMP 실행 파일이 없습니다."))?;
    Ok(Arc::new(OmpSubscriptionProvider {
        executable,
        provider: provider.to_owned(),
    }))
}

struct OmpSubscriptionProvider {
    executable: PathBuf,
    provider: String,
}

impl ai::Provider for OmpSubscriptionProvider {
    fn stream<'a>(
        &'a self,
        model: &'a ai::Model,
        context: &'a ai::Context,
        options: Option<ai::StreamOptions>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ai::prelude::StreamResult> + Send + 'a>>
    {
        Box::pin(async move {
            if model.provider != self.provider || !is_allowed(&model.provider, &model.id) {
                return Err(ai::ProviderError::UnknownProvider(model.provider.clone()));
            }
            let request = request_line(model, context, options.as_ref())?;
            let completion = invoke(&self.executable, request).await?;
            let message = parse_completion(model, completion)?;
            let reason = message.stop_reason;
            let start = Arc::new(ai::AssistantMessage::new(
                ai::Api::OpenAiCompletions,
                &model.provider,
                &model.id,
            ));
            let events = vec![
                ai::ProviderEvent::Start { partial: start },
                ai::ProviderEvent::Done { reason, message },
            ];
            let stream: std::pin::Pin<Box<dyn futures::Stream<Item = ai::ProviderEvent> + Send>> =
                Box::pin(futures::stream::iter(events));
            Ok(stream)
        })
    }
}

fn request_line(
    model: &ai::Model,
    context: &ai::Context,
    options: Option<&ai::StreamOptions>,
) -> std::result::Result<Value, ai::ProviderError> {
    let mut messages = Vec::with_capacity(context.messages.len() + 1);
    if let Some(system_prompt) = &context.system_prompt {
        messages.push(json!({"role":"system","content":system_prompt}));
    }
    for message in &context.messages {
        messages.push(message_to_openai(message)?);
    }
    let mut body = json!({
        "model": format!("{}/{}", model.provider, model.id),
        "messages": messages,
        "stream": false,
    });
    if !context.tools.is_empty() {
        body["tools"] = Value::Array(
            context
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "type":"function",
                        "function":{
                            "name":tool.name,
                            "description":tool.description,
                            "parameters":tool.parameters,
                        }
                    })
                })
                .collect(),
        );
    }
    if let Some(options) = options {
        if let Some(temperature) = options.temperature {
            body["temperature"] = json!(temperature);
        }
        if let Some(max_tokens) = options.max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }
        if let Some(choice) = &options.tool_choice {
            body["tool_choice"] = match choice {
                ai::prelude::ToolChoice::Auto => json!("auto"),
                ai::prelude::ToolChoice::Named(name) => {
                    json!({"type":"function","function":{"name":name}})
                }
            };
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let request = json!({
        "id":id,
        "path":"/v1/chat/completions",
        "body":body,
    });
    if serde_json::to_vec(&request)
        .map_err(ai::ProviderError::JsonParse)?
        .len()
        > MAX_REQUEST_BYTES
    {
        return Err(ai::ProviderError::ContextOverflow);
    }
    Ok(request)
}

fn message_to_openai(message: &ai::Message) -> std::result::Result<Value, ai::ProviderError> {
    use ai::{ContentBlock, Message, MessageContent};
    Ok(match message {
        Message::User(user) => {
            let content = match &user.content {
                MessageContent::Text(text) => Value::String(text.clone()),
                MessageContent::Blocks(blocks) => {
                    if blocks.len() == 1 && matches!(blocks.first(), Some(ContentBlock::Text(_))) {
                        Value::String(blocks[0].as_text().unwrap_or_default().to_owned())
                    } else {
                        Value::Array(
                            blocks
                                .iter()
                                .filter_map(block_to_openai)
                                .collect::<Vec<_>>(),
                        )
                    }
                }
            };
            json!({"role":"user","content":content})
        }
        Message::Assistant(assistant) => {
            let mut text = String::new();
            let mut tool_calls = Vec::new();
            for block in &assistant.content {
                match block {
                    ContentBlock::Text(text_block) => text.push_str(&text_block.text),
                    ContentBlock::ToolCall(call) => tool_calls.push(json!({
                        "id":call.id,
                        "type":"function",
                        "function":{
                            "name":call.name,
                            "arguments":call.arguments.to_string(),
                        }
                    })),
                    ContentBlock::Thinking(_)
                    | ContentBlock::Image(_)
                    | ContentBlock::Unknown(_) => {}
                }
            }
            let mut value = json!({"role":"assistant","content":if text.is_empty() { Value::Null } else { json!(text) }});
            if !tool_calls.is_empty() {
                value["tool_calls"] = Value::Array(tool_calls);
            }
            value
        }
        Message::ToolResult(result) => {
            let content = result
                .content
                .iter()
                .filter_map(ContentBlock::as_text)
                .collect::<Vec<_>>()
                .join("");
            json!({"role":"tool","tool_call_id":result.tool_call_id,"content":content})
        }
    })
}

fn block_to_openai(block: &ai::ContentBlock) -> Option<Value> {
    match block {
        ai::ContentBlock::Text(text) => Some(json!({"type":"text","text":text.text})),
        ai::ContentBlock::Image(image) => Some(json!({
            "type":"image_url",
            "image_url":{"url":format!("data:{};base64,{}",image.mime_type,image.data)}
        })),
        _ => None,
    }
}

async fn read_bounded<R: AsyncRead + Unpin>(reader: R, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    Ok(bytes)
}

async fn stop(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn invoke(
    executable: &Path,
    request: Value,
) -> std::result::Result<Value, ai::ProviderError> {
    let home = std::env::var_os("HOME").ok_or_else(|| {
        ai::ProviderError::InvalidResponse("OMP credential home is unavailable".into())
    })?;
    let temp = tempfile::Builder::new()
        .prefix("ghost-omp-provider-")
        .tempdir()?;
    let config = temp.path().join("config.yml");
    std::fs::write(
        &config,
        "retry:\n  enabled: false\n  modelFallback: false\n  usageAwareFallback: false\n  waitForUsageReset: false\n",
    )?;
    let mut search_paths = vec![executable
        .parent()
        .unwrap_or_else(|| Path::new("/usr/bin"))
        .to_path_buf()];
    if let Some(parent) = std::env::var_os(EXECUTABLE_ENV)
        .map(PathBuf::from)
        .as_deref()
        .and_then(Path::parent)
    {
        search_paths.push(parent.to_path_buf());
    }
    search_paths.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        .into_iter()
        .map(PathBuf::from),
    );
    let path = std::env::join_paths(search_paths)
        .map_err(|_| ai::ProviderError::InvalidResponse("OMP PATH is invalid".into()))?;
    let mut child = Command::new(executable)
        .args([
            "--no-extensions",
            "--no-rules",
            "--no-skills",
            "--no-session",
            "--config",
        ])
        .arg(config)
        .arg("auth-gateway")
        .arg("stdio")
        .env_clear()
        .env("HOME", home)
        .env("PATH", path)
        .env("TMPDIR", temp.path())
        .env("NO_COLOR", "1")
        .current_dir(temp.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ai::ProviderError::InvalidResponse("OMP stdout is unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ai::ProviderError::InvalidResponse("OMP stderr is unavailable".into()))?;
    let stdout_reader = tokio::spawn(read_bounded(stdout, MAX_RESPONSE_BYTES));
    let stderr_reader = tokio::spawn(read_bounded(stderr, MAX_STDERR_BYTES));
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ai::ProviderError::InvalidResponse("OMP stdin is unavailable".into()))?;
    let mut bytes = serde_json::to_vec(&request).map_err(ai::ProviderError::JsonParse)?;
    bytes.push(b'\n');
    if stdin.write_all(&bytes).await.is_err() || stdin.shutdown().await.is_err() {
        stop(&mut child).await;
        stdout_reader.abort();
        stderr_reader.abort();
        return Err(ai::ProviderError::InvalidResponse(
            "OMP request handoff was interrupted".into(),
        ));
    }
    drop(stdin);
    let status = match timeout(DEADLINE, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            stop(&mut child).await;
            stdout_reader.abort();
            stderr_reader.abort();
            return Err(ai::ProviderError::InvalidResponse(
                "OMP gateway ended before confirming the response".into(),
            ));
        }
        Err(_) => {
            stop(&mut child).await;
            stdout_reader.abort();
            stderr_reader.abort();
            return Err(ai::ProviderError::Timeout);
        }
    };
    let stdout = stdout_reader
        .await
        .map_err(|_| ai::ProviderError::InvalidResponse("OMP stdout reader failed".into()))??;
    let stderr = stderr_reader
        .await
        .map_err(|_| ai::ProviderError::InvalidResponse("OMP stderr reader failed".into()))??;
    if stdout.len() > MAX_RESPONSE_BYTES || stderr.len() > MAX_STDERR_BYTES {
        return Err(ai::ProviderError::InvalidResponse(
            "OMP gateway exceeded its output limit".into(),
        ));
    }
    if !status.success() {
        return Err(ai::ProviderError::InvalidResponse(
            "OMP gateway process failed".into(),
        ));
    }
    let lines = std::str::from_utf8(&stdout)
        .map_err(|_| ai::ProviderError::InvalidResponse("OMP output was not UTF-8".into()))?
        .lines()
        .filter(|line| !line.trim().is_empty());
    let mut parsed = lines
        .map(serde_json::from_str::<Value>)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(ai::ProviderError::JsonParse)?
        .into_iter();
    let ready = parsed.next().ok_or_else(|| {
        ai::ProviderError::InvalidResponse("OMP gateway did not become ready".into())
    })?;
    if ready["ready"] != true {
        return Err(ai::ProviderError::InvalidResponse(
            "OMP gateway readiness response was invalid".into(),
        ));
    }
    let request_id = request["id"].clone();
    let response = parsed
        .find(|response| response.get("id") == Some(&request_id))
        .ok_or_else(|| {
            ai::ProviderError::InvalidResponse("OMP gateway omitted the response".into())
        })?;
    let status = response["status"].as_u64().unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(ai::ProviderError::InvalidResponse(format!(
            "OMP provider returned HTTP {status}"
        )));
    }
    response
        .get("body")
        .cloned()
        .ok_or_else(|| ai::ProviderError::InvalidResponse("OMP response body is missing".into()))
}

fn parse_completion(
    model: &ai::Model,
    body: Value,
) -> std::result::Result<ai::AssistantMessage, ai::ProviderError> {
    let choice = body["choices"]
        .as_array()
        .and_then(|choices| choices.first())
        .ok_or_else(|| ai::ProviderError::InvalidResponse("OMP returned no choices".into()))?;
    let source = choice.get("message").ok_or_else(|| {
        ai::ProviderError::InvalidResponse("OMP completion message is missing".into())
    })?;
    let mut message =
        ai::AssistantMessage::new(ai::Api::OpenAiCompletions, &model.provider, &model.id);
    if let Some(content) = source.get("content") {
        match content {
            Value::String(text) if !text.is_empty() => {
                message
                    .content
                    .push(ai::ContentBlock::Text(ai::TextContent::new(text)));
            }
            Value::Array(parts) => {
                for part in parts {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        message
                            .content
                            .push(ai::ContentBlock::Text(ai::TextContent::new(text)));
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(calls) = source.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let id = call.get("id").and_then(Value::as_str).unwrap_or_default();
            let function = &call["function"];
            let name = function
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = match function.get("arguments") {
                Some(Value::String(arguments)) => {
                    serde_json::from_str(arguments).map_err(ai::ProviderError::JsonParse)?
                }
                Some(arguments @ Value::Object(_)) => arguments.clone(),
                Some(Value::Null) | None => json!({}),
                _ => {
                    return Err(ai::ProviderError::InvalidResponse(
                        "OMP tool arguments were not a JSON object".into(),
                    ));
                }
            };
            if id.is_empty() || name.is_empty() || !arguments.is_object() {
                return Err(ai::ProviderError::InvalidResponse(
                    "OMP returned an invalid tool call".into(),
                ));
            }
            message
                .content
                .push(ai::ContentBlock::ToolCall(ai::ToolCall::new(
                    id, name, arguments,
                )));
        }
    }
    let finish = choice["finish_reason"].as_str().unwrap_or("stop");
    message.stop_reason = match finish {
        "tool_calls" | "function_call" => ai::StopReason::ToolUse,
        "length" => ai::StopReason::Length,
        _ => ai::StopReason::Stop,
    };
    message.response_id = body["id"].as_str().map(str::to_owned);
    message.usage.input = body["usage"]["prompt_tokens"].as_u64().unwrap_or_default() as usize;
    message.usage.output = body["usage"]["completion_tokens"]
        .as_u64()
        .unwrap_or_default() as usize;
    message.usage.total_tokens = body["usage"]["total_tokens"]
        .as_u64()
        .unwrap_or((message.usage.input + message.usage.output) as u64)
        as usize;
    Ok(message)
}
