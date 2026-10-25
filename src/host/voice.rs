//! Ephemeral local speech transport. Audio never enters durable receipts or
//! journals; transcribed text is submitted through the ordinary durable API.
//! Ending microphone/playback does not cancel durable tasks.
use super::{models, Host, State};
use crate::{
    domain::Policy,
    durable::durable::{ai, EntryKind, Phase, TaskKind},
};
use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    net::{Ipv4Addr, SocketAddr},
    time::Duration,
};

pub const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_INPUT_SECONDS: u64 = 120;
pub const MAX_REQUEST_BYTES: usize = 6 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 8192;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Context {
    pub profile_id: String,
    pub conversation_id: String,
    pub settings_version: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TranscribeInput {
    #[serde(flatten)]
    pub context: Context,
    pub audio_base64: String,
    pub mime: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SynthesizeInput {
    #[serde(flatten)]
    pub context: Context,
    pub task_id: String,
}
pub struct Audio {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}
struct Target {
    url: reqwest::Url,
    model: String,
    auth: models::Auth,
}

fn identity(state: &State, context: &Context) -> Result<()> {
    let profile = state
        .profiles
        .get(&context.profile_id)
        .ok_or_else(|| anyhow!("Ghost를 선택해 주세요."))?;
    if !profile
        .runtime
        .session
        .committed()?
        .conversations
        .contains_key(&context.conversation_id)
    {
        bail!("현재 대화를 다시 선택해 주세요.");
    }
    let policy: Policy = state
        .journal
        .get("policy", &context.profile_id)?
        .unwrap_or_default();
    if !policy.voice {
        bail!("이 Ghost의 음성 사용을 먼저 허용해 주세요.");
    }
    Ok(())
}
fn target(settings: &models::Settings, role: models::Role, operation: &str) -> Result<Target> {
    let selected = match role {
        models::Role::Stt => &settings.roles.stt,
        models::Role::Tts => &settings.roles.tts,
        models::Role::Llm => bail!("음성 역할을 선택해 주세요."),
    }
    .as_deref()
    .ok_or_else(|| anyhow!("설정에서 로컬 STT와 TTS 모델을 선택해 주세요."))?;
    let (provider_id, model_id) = selected
        .split_once('/')
        .ok_or_else(|| anyhow!("음성 모델 선택을 확인해 주세요."))?;
    let provider = settings
        .providers
        .iter()
        .find(|p| p.id == provider_id && p.enabled)
        .ok_or_else(|| anyhow!("선택한 음성 제공자가 비활성 상태입니다."))?;
    models::validate(provider)?;
    if !provider.roles.contains(&role)
        || !provider
            .models
            .iter()
            .any(|m| m.id == model_id && m.roles.contains(&role))
    {
        bail!("선택한 모델이 이 음성 역할을 지원하지 않습니다.");
    }
    let mut url = reqwest::Url::parse(&provider.endpoint)
        .map_err(|_| anyhow!("로컬 음성 서버 주소를 확인해 주세요."))?;
    if !matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    ) || !matches!(url.scheme(), "http" | "https")
    {
        bail!("음성은 로컬 서버에만 전송합니다. 외부 음성 제공자는 별도 승인이 필요합니다.");
    }
    if matches!(provider.auth, models::Auth::Sdk) {
        bail!("로컬 음성 서버에는 외부 제공자의 저장된 인증을 사용할 수 없습니다.");
    }
    url.set_path(&format!(
        "{}/audio/{operation}",
        url.path().trim_end_matches('/')
    ));
    Ok(Target {
        url,
        model: model_id.into(),
        auth: provider.auth.clone(),
    })
}
fn checked(app: &Host, context: &Context, role: models::Role, operation: &str) -> Result<Target> {
    let state = app.lock()?;
    identity(&state, context)?;
    let settings = models::settings(&state)?;
    if settings.version != context.settings_version {
        bail!("음성 모델 설정이 바뀌었습니다. 통화를 다시 시작해 주세요.");
    }
    target(&settings, role, operation)
}
/// Safe preflight before getUserMedia. No server request and no persistent call.
pub fn config(app: &Host, profile_id: &str, conversation_id: &str) -> Result<Value> {
    if !app.dispatch_enabled { bail!("dispatch_off"); }
    let state = app.lock()?;
    let settings = models::settings(&state)?;
    let context = Context {
        profile_id: profile_id.into(),
        conversation_id: conversation_id.into(),
        settings_version: settings.version,
    };
    let available = identity(&state, &context)
        .and_then(|()| target(&settings, models::Role::Stt, "transcriptions").map(|_| ()))
        .and_then(|()| target(&settings, models::Role::Tts, "speech").map(|_| ()));
    Ok(
        json!({"available":available.is_ok(),"reason":available.err().map(|e|e.to_string()),
        "settings_version":settings.version,"stt_model":settings.roles.stt,"tts_model":settings.roles.tts,
        "transport":"local_audio","input_mime":"audio/wav","max_input_bytes":MAX_INPUT_BYTES,"max_input_seconds":MAX_INPUT_SECONDS,
        "cancel_requires_task_id":true,"end_cancels_tasks":false}),
    )
}
fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(120))
        // Never let a customized hosts/DNS resolution send localhost audio away.
        .resolve("localhost", SocketAddr::from((Ipv4Addr::LOCALHOST, 80)))
        .build()
        .map_err(|_| anyhow!("로컬 음성 연결을 준비할 수 없습니다."))
}
fn authorization(
    request: reqwest::RequestBuilder,
    auth: &models::Auth,
) -> Result<reqwest::RequestBuilder> {
    match auth {
        models::Auth::None => Ok(request),
        models::Auth::Env { variable } => {
            let key = std::env::var(variable)
                .ok()
                .filter(|key| !key.is_empty())
                .ok_or_else(|| anyhow!("기존 로컬 서버 인증 환경 변수를 확인해 주세요."))?;
            Ok(request.bearer_auth(key))
        }
        models::Auth::Sdk => bail!("로컬 음성 인증 설정을 확인해 주세요."),
    }
}
async fn bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if !response.status().is_success() {
        bail!(
            "로컬 음성 서버가 요청을 처리하지 못했습니다 (HTTP {}).",
            response.status().as_u16()
        );
    }
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        bail!("음성 응답 크기 제한을 초과했습니다.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow!("로컬 음성 응답이 중단됐습니다."))?
    {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            bail!("음성 응답 크기 제한을 초과했습니다.");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
/// Validate RIFF PCM16 and duration before forwarding microphone audio. All
/// arithmetic is checked. Unknown chunks are ignored, data must be present.
fn wav(bytes: &[u8], max_seconds: u64) -> Result<()> {
    let invalid = || anyhow!("PCM16 WAV 음성 파일을 사용해 주세요.");
    if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(invalid());
    }
    let u32_at = |at| -> Result<u32> {
        Ok(u32::from_le_bytes(
            bytes.get(at..at + 4).ok_or_else(invalid)?.try_into()?,
        ))
    };
    if u32_at(4)? as usize != bytes.len() - 8 {
        return Err(invalid());
    }
    let mut at = 12usize;
    let mut rate = None;
    let mut data_len = 0usize;
    let mut align = 0u16;
    while at < bytes.len() {
        let tag = bytes.get(at..at + 4).ok_or_else(invalid)?;
        let len = u32_at(at + 4)? as usize;
        let begin = at.checked_add(8).ok_or_else(invalid)?;
        let end = begin.checked_add(len).ok_or_else(invalid)?;
        let chunk = bytes.get(begin..end).ok_or_else(invalid)?;
        if tag == b"fmt " {
            if rate.is_some() || chunk.len() < 16 {
                return Err(invalid());
            }
            let field = |n| u16::from_le_bytes([chunk[n], chunk[n + 1]]);
            let channels = field(2);
            let sample_rate = u32::from_le_bytes(chunk[4..8].try_into()?);
            let byte_rate = u32::from_le_bytes(chunk[8..12].try_into()?);
            align = field(12);
            if field(0) != 1
                || !(1..=2).contains(&channels)
                || field(14) != 16
                || !(8000..=48000).contains(&sample_rate)
                || align != channels * 2
                || byte_rate != sample_rate * u32::from(align)
            {
                return Err(invalid());
            }
            rate = Some(byte_rate);
        } else if tag == b"data" {
            data_len = data_len.checked_add(len).ok_or_else(invalid)?;
        }
        at = end.checked_add(len % 2).ok_or_else(invalid)?;
    }
    let byte_rate = rate.ok_or_else(invalid)?;
    if at != bytes.len() || data_len == 0 || !data_len.is_multiple_of(usize::from(align)) {
        return Err(invalid());
    }
    if data_len as u64 > u64::from(byte_rate) * max_seconds {
        bail!("한 번에 보낼 수 있는 음성 길이를 초과했습니다.");
    }
    Ok(())
}
pub async fn transcribe(app: &Host, context: &Context, audio: Vec<u8>) -> Result<Value> {
    if !app.dispatch_enabled { bail!("dispatch_off"); }
    if audio.len() > MAX_INPUT_BYTES {
        bail!("마이크 음성 크기 제한을 초과했습니다.");
    }
    wav(&audio, MAX_INPUT_SECONDS)?;
    let destination = checked(app, context, models::Role::Stt, "transcriptions")?;
    let part = reqwest::multipart::Part::bytes(audio)
        .file_name("utterance.wav")
        .mime_str("audio/wav")?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", destination.model);
    let response = authorization(
        client()?.post(destination.url).multipart(form),
        &destination.auth,
    )?
    .send()
    .await
    .map_err(|_| anyhow!("로컬 STT 서버에 연결할 수 없습니다. 서버 상태를 확인해 주세요."))?;
    let body = bounded(response, 32768).await?;
    let value: Value = serde_json::from_slice(&body)
        .map_err(|_| anyhow!("로컬 STT 응답 형식을 확인해 주세요."))?;
    let text = value["text"]
        .as_str()
        .ok_or_else(|| anyhow!("로컬 STT 응답에 인식된 텍스트가 없습니다."))?
        .trim();
    super::text(text, MAX_TEXT_BYTES)
        .map_err(|_| anyhow!("인식된 텍스트가 비어 있거나 너무 깁니다."))?;
    // Recheck after network I/O: no stale settings, revoked policy or deleted chat.
    checked(app, context, models::Role::Stt, "transcriptions")?;
    Ok(json!({"text":text,"settings_version":context.settings_version}))
}
pub async fn transcribe_command(app: &Host, input: TranscribeInput) -> Result<Value> {
    if input.mime != "audio/wav" {
        bail!("PCM16 WAV 음성 파일을 사용해 주세요.");
    }
    if input.audio_base64.len() > MAX_INPUT_BYTES.div_ceil(3) * 4 {
        bail!("마이크 음성 크기 제한을 초과했습니다.");
    }
    let audio = STANDARD
        .decode(input.audio_base64)
        .map_err(|_| anyhow!("음성 전송 형식을 확인해 주세요."))?;
    transcribe(app, &input.context, audio).await
}
fn task_text(app: &Host, input: &SynthesizeInput) -> Result<String> {
    let state = app.lock()?;
    identity(&state, &input.context)?;
    let profile = &state.profiles[&input.context.profile_id];
    let snapshot = profile.runtime.session.committed()?;
    let task = snapshot
        .tasks
        .get(&input.task_id)
        .ok_or_else(|| anyhow!("읽어 줄 과업 결과가 없습니다."))?;
    if task.conversation_id != input.context.conversation_id
        || task.phase != Phase::Complete
        || !matches!(task.kind, TaskKind::Generation { .. })
    {
        bail!("이 대화의 완료된 응답만 읽어 줄 수 있습니다.");
    }
    let conversation = &snapshot.conversations[&input.context.conversation_id];
    // text_content excludes thinking blocks. Do not read tool outputs, partial
    // generations or arbitrary renderer-supplied text.
    let text = conversation
        .entries
        .iter()
        .rev()
        .filter(|entry| entry.task_id.as_deref() == Some(&input.task_id))
        .find_map(|entry| match &entry.kind {
            EntryKind::Message(message @ ai::Message::Assistant(_)) => message.text_content().ok(),
            _ => None,
        })
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| anyhow!("완료된 음성 응답 텍스트가 없습니다."))?;
    super::text(&text, MAX_TEXT_BYTES)
        .map_err(|_| anyhow!("음성 응답이 너무 깁니다. 텍스트로 확인해 주세요."))?;
    Ok(text)
}
pub async fn synthesize(app: &Host, input: &SynthesizeInput) -> Result<Audio> {
    if !app.dispatch_enabled { bail!("dispatch_off"); }
    let destination = checked(app, &input.context, models::Role::Tts, "speech")?;
    let text = task_text(app, input)?;
    let response = authorization(client()?.post(destination.url)
        .json(&json!({"model":destination.model,"input":text,"voice":"default","response_format":"wav"})), &destination.auth)?
        .send().await.map_err(|_| anyhow!("로컬 TTS 서버에 연결할 수 없습니다. 서버 상태를 확인해 주세요."))?;
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !matches!(
        mime.split(';').next().unwrap_or("").trim(),
        "audio/wav" | "audio/x-wav" | "audio/wave"
    ) && response.status().is_success()
    {
        bail!("로컬 TTS 서버에서 WAV 응답을 받지 못했습니다.");
    }
    let bytes = bounded(response, MAX_OUTPUT_BYTES).await?;
    wav(&bytes, 60)?;
    checked(app, &input.context, models::Role::Tts, "speech")?;
    Ok(Audio {
        mime: "audio/wav",
        bytes,
    })
}
pub async fn synthesize_command(app: &Host, input: SynthesizeInput) -> Result<Value> {
    let audio = synthesize(app, &input).await?;
    Ok(json!({"mime":audio.mime,"audio_base64":STANDARD.encode(audio.bytes)}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::api::{Action, Command};
    use std::{path::Path, sync::Arc};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn owner(root: &Path, endpoint: &str) -> (Arc<Host>, Context) {
        let app = Host::open_legacy_fixture(root, tokio::runtime::Handle::current(), Some("mock")).unwrap();
        let profile = app
            .action(Action {
                request_id: uuid::Uuid::new_v4().to_string(),
                command: Command::CreateProfile {
                    name: "voice-fixture".into(),
                    persona: "Helper".into(),
                },
            })
            .unwrap();
        let profile_id = profile["result"]["profile_id"]
            .as_str()
            .unwrap()
            .to_string();
        let conversation = app
            .action(Action {
                request_id: uuid::Uuid::new_v4().to_string(),
                command: Command::CreateConversation {
                    profile_id: profile_id.clone(),
                    model: "mock".into(),
                    tools: false,
                },
            })
            .unwrap();
        let conversation_id = conversation["result"]["conversation_id"]
            .as_str()
            .unwrap()
            .to_string();
        let provider = models::Provider {
            id: "voice-fixture".into(),
            name: "Fixture".into(),
            kind: models::Kind::OpenaiCompatible,
            endpoint: endpoint.into(),
            auth: models::Auth::None,
            roles: vec![models::Role::Stt, models::Role::Tts],
            models: vec![
                models::Model {
                    id: "whisper".into(),
                    name: "Whisper".into(),
                    roles: vec![models::Role::Stt],
                },
                models::Model {
                    id: "voice".into(),
                    name: "Voice".into(),
                    roles: vec![models::Role::Tts],
                },
            ],
            enabled: true,
            checked_ms: None,
            error: None,
        };
        {
            let state = app.lock().unwrap();
            state
                .journal
                .put(
                    "policy",
                    &profile_id,
                    &Policy {
                        voice: true,
                        ..Policy::default()
                    },
                )
                .unwrap();
            models::save(&state, provider, 0).unwrap();
            models::select(
                &state,
                models::Role::Stt,
                Some("voice-fixture/whisper".into()),
                1,
            )
            .unwrap();
            models::select(
                &state,
                models::Role::Tts,
                Some("voice-fixture/voice".into()),
                2,
            )
            .unwrap();
        }
        (
            app,
            Context {
                profile_id,
                conversation_id,
                settings_version: 3,
            },
        )
    }
    fn sample_wav(seconds: usize) -> Vec<u8> {
        let samples = 8000 * seconds;
        let size = (samples * 2) as u32;
        let mut bytes = Vec::new();
        bytes.extend(b"RIFF");
        bytes.extend((36 + size).to_le_bytes());
        bytes.extend(b"WAVEfmt ");
        bytes.extend(16u32.to_le_bytes());
        bytes.extend(1u16.to_le_bytes());
        bytes.extend(1u16.to_le_bytes());
        bytes.extend(8000u32.to_le_bytes());
        bytes.extend(16000u32.to_le_bytes());
        bytes.extend(2u16.to_le_bytes());
        bytes.extend(16u16.to_le_bytes());
        bytes.extend(b"data");
        bytes.extend(size.to_le_bytes());
        bytes.resize(bytes.len() + size as usize, 1);
        bytes
    }
    async fn binary_server(
        bytes: Vec<u8>,
    ) -> (
        String,
        tokio::sync::oneshot::Receiver<Vec<u8>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![];
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
                assert!(request.len() < 16384);
            }
            let length = String::from_utf8_lossy(&request)
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")?
                        .trim()
                        .parse::<usize>()
                        .ok()
                })
                .unwrap();
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            request.extend(body);
            tx.send(request).unwrap();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len()).as_bytes()).await.unwrap();
            socket.write_all(&bytes).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        (endpoint, rx, task)
    }
    async fn submit_and_wait(app: &Arc<Host>, context: &Context, text: &str) -> String {
        let reply = app
            .action(Action {
                request_id: uuid::Uuid::new_v4().to_string(),
                command: Command::Submit {
                    profile_id: context.profile_id.clone(),
                    conversation_id: context.conversation_id.clone(),
                    prompt: text.into(),
                    kind: crate::durable::durable::InputKind::Prompt,
                },
            })
            .unwrap();
        let task_id = reply["result"]["task_id"].as_str().unwrap().to_string();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let phase = app.lock().unwrap().profiles[&context.profile_id]
                .runtime
                .session
                .committed()
                .unwrap()
                .tasks[&task_id]
                .phase;
            if phase.terminal() {
                assert_eq!(phase, Phase::Complete);
                break;
            }
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        task_id
    }
    #[test]
    fn wav_duration_and_invalid_audio_are_bounded() {
        assert!(wav(&sample_wav(120), MAX_INPUT_SECONDS).is_ok());
        assert!(sample_wav(120).len() < MAX_INPUT_BYTES);
        assert!(wav(&sample_wav(121), MAX_INPUT_SECONDS).is_err());
        let mut bytes = sample_wav(1);
        bytes[22] = 4;
        assert!(wav(&bytes, 20).is_err());
        assert!(wav(b"not-audio", 20).is_err());
        let mut bytes = sample_wav(1);
        bytes[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(wav(&bytes, 20).is_err());
        let input:TranscribeInput=serde_json::from_value(json!({"profile_id":"p","conversation_id":"c","settings_version":1,"audio_base64":"","mime":"audio/wav"})).unwrap();
        assert_eq!(input.context.profile_id, "p");
        assert!(serde_json::from_value::<TranscribeInput>(json!({"profile_id":"p","conversation_id":"c","settings_version":1,"audio_base64":"","mime":"audio/wav","unexpected":true})).is_err());
    }
    #[tokio::test]
    async fn preflight_blocks_remote_stale_config_and_revoked_voice() {
        let root = tempfile::tempdir().unwrap();
        let (app, mut context) = owner(root.path(), "https://external.example/v1");
        let result = config(&app, &context.profile_id, &context.conversation_id).unwrap();
        assert_eq!(result["available"], false);
        assert!(result["reason"].as_str().unwrap().contains("외부"));
        assert!(transcribe(&app, &context, sample_wav(1)).await.is_err());
        context.settings_version = 0;
        assert!(checked(&app, &context, models::Role::Stt, "transcriptions")
            .err()
            .unwrap()
            .to_string()
            .contains("설정이 바뀌"));
        app.lock()
            .unwrap()
            .journal
            .put("policy", &context.profile_id, &Policy::default())
            .unwrap();
        assert!(
            config(&app, &context.profile_id, &context.conversation_id).unwrap()["reason"]
                .as_str()
                .unwrap()
                .contains("허용")
        );
        app.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn local_transcription_uses_multipart_and_never_persists_audio() {
        let (url, request, server) = crate::test_http::once(Some(crate::test_http::reply(
            "200 OK",
            "Content-Type: application/json\r\n",
            r#"{"text":"fixture instruction"}"#,
        )))
        .await;
        let root = tempfile::tempdir().unwrap();
        let (app, context) = owner(root.path(), &format!("{url}/v1"));
        let configuration = config(&app, &context.profile_id, &context.conversation_id).unwrap();
        assert_eq!(configuration["available"], true);
        assert_eq!(configuration["max_input_seconds"], 120);
        assert_eq!(configuration["max_input_bytes"], 4 * 1024 * 1024);
        let before = app
            .lock()
            .unwrap()
            .journal
            .0
            .query_row("SELECT COUNT(*) FROM workspace_commands", [], |r| {
                r.get::<_, u64>(0)
            })
            .unwrap();
        let result = transcribe(&app, &context, sample_wav(1)).await.unwrap();
        assert_eq!(result["text"], "fixture instruction");
        let request = request.await.unwrap();
        let headers = String::from_utf8_lossy(&request);
        assert!(headers.starts_with("POST /v1/audio/transcriptions "));
        assert!(headers.contains("filename=\"utterance.wav\""));
        assert!(headers.contains("name=\"model\"\r\n\r\nwhisper"));
        server.await.unwrap();
        let after = app
            .lock()
            .unwrap()
            .journal
            .0
            .query_row("SELECT COUNT(*) FROM workspace_commands", [], |r| {
                r.get::<_, u64>(0)
            })
            .unwrap();
        assert_eq!(before, after);
        let task = submit_and_wait(&app, &context, result["text"].as_str().unwrap()).await;
        let input = SynthesizeInput {
            context: context.clone(),
            task_id: task,
        };
        assert!(!task_text(&app, &input).unwrap().is_empty());
        let mut foreign = Context {
            conversation_id: "foreign".into(),
            ..context
        };
        foreign.settings_version = 3;
        assert!(task_text(
            &app,
            &SynthesizeInput {
                context: foreign,
                task_id: input.task_id
            }
        )
        .is_err());
        app.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn speech_reads_same_committed_task_only_and_cancel_is_real() {
        let bytes = sample_wav(1);
        let (url, request, server) = binary_server(bytes.clone()).await;
        let root = tempfile::tempdir().unwrap();
        let (app, context) = owner(root.path(), &url);
        let task = submit_and_wait(&app, &context, "fixture response").await;
        let input = SynthesizeInput {
            context: context.clone(),
            task_id: task,
        };
        let text = task_text(&app, &input).unwrap();
        let result = synthesize(&app, &input).await.unwrap();
        assert_eq!(result.bytes, bytes);
        assert_eq!(result.mime, "audio/wav");
        let request = request.await.unwrap();
        let request = String::from_utf8(request).unwrap();
        assert!(request.starts_with("POST /v1/audio/speech "));
        let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["input"], text);
        assert_eq!(body["model"], "voice");
        assert_eq!(body["response_format"], "wav");
        server.await.unwrap();
        let runtime = app.lock().unwrap().profiles[&context.profile_id]
            .runtime
            .clone();
        let queued = runtime
            .session
            .submit(
                &context.conversation_id,
                "voice-cancel-fixture",
                crate::durable::durable::InputKind::FollowUp,
                "cancel fixture",
            )
            .unwrap();
        let cancellation = app
            .action(Action {
                request_id: uuid::Uuid::new_v4().to_string(),
                command: Command::Cancel {
                    profile_id: context.profile_id.clone(),
                    task_id: queued.task_id.clone(),
                },
            })
            .unwrap();
        assert_eq!(cancellation["ok"], true);
        assert_eq!(
            runtime.session.committed().unwrap().tasks[&queued.task_id].phase,
            Phase::Cancelled
        );
        assert!(task_text(
            &app,
            &SynthesizeInput {
                context: context.clone(),
                task_id: queued.task_id
            }
        )
        .is_err());
        assert_eq!(
            config(&app, &context.profile_id, &context.conversation_id).unwrap()
                ["end_cancels_tasks"],
            false
        );
        app.shutdown().await.unwrap();
        drop(runtime);
        drop(app);
        let reopened =
            Host::open_legacy_fixture(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
        assert_eq!(
            config(&reopened, &context.profile_id, &context.conversation_id).unwrap()["available"],
            true
        );
        assert_eq!(task_text(&reopened, &input).unwrap(), text);
        reopened.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn upstream_failures_are_redacted_and_redirects_never_followed() {
        let (url, request, server) = crate::test_http::once(Some(crate::test_http::reply(
            "302 Found",
            "Location: https://external.example/audio\r\n",
            "secret-provider-body",
        )))
        .await;
        let root = tempfile::tempdir().unwrap();
        let (app, context) = owner(root.path(), &url);
        let error = transcribe(&app, &context, sample_wav(1))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("302"));
        assert!(!error.contains("secret-provider-body"));
        assert!(!error.contains("external.example"));
        request.await.unwrap();
        server.await.unwrap();
        app.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn policy_revocation_during_stt_discards_the_transcript() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![];
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            let length = String::from_utf8_lossy(&request)
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")?
                        .trim()
                        .parse::<usize>()
                        .ok()
                })
                .unwrap();
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            ready_tx.send(()).unwrap();
            release_rx.await.unwrap();
            socket
                .write_all(
                    crate::test_http::reply(
                        "200 OK",
                        "Content-Type: application/json\r\n",
                        r#"{"text":"must be discarded"}"#,
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            socket.shutdown().await.unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let (app, context) = owner(root.path(), &endpoint);
        let pending_app = app.clone();
        let pending_context = context.clone();
        let pending =
            tokio::spawn(
                async move { transcribe(&pending_app, &pending_context, sample_wav(1)).await },
            );
        ready_rx.await.unwrap();
        app.lock()
            .unwrap()
            .journal
            .put("policy", &context.profile_id, &Policy::default())
            .unwrap();
        release_tx.send(()).unwrap();
        let error = pending.await.unwrap().unwrap_err().to_string();
        assert!(error.contains("허용"));
        assert!(app.lock().unwrap().profiles[&context.profile_id]
            .runtime
            .session
            .committed()
            .unwrap()
            .submissions
            .is_empty());
        server.await.unwrap();
        app.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn oversized_response_is_rejected_before_body_read() {
        let (url,request,server)=crate::test_http::once(Some("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 10485760\r\nConnection: close\r\n\r\n".into())).await;
        let root = tempfile::tempdir().unwrap();
        let (app, context) = owner(root.path(), &url);
        let error = transcribe(&app, &context, sample_wav(1))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("크기 제한"));
        request.await.unwrap();
        server.await.unwrap();
        app.shutdown().await.unwrap();
    }
}
