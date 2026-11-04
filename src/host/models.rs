//! Owner-selected model endpoints and roles. Configuration contains credential
//! references only; secret values never enter command receipts or snapshots.
use super::{now_ms, State};
use anyhow::{anyhow, bail, Result};
use oxicode_sdk::{CatalogConfig, FileModelCatalog, ModelCatalog};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Llm,
    Stt,
    Tts,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Auth {
    Sdk,
    None,
    Env { variable: String },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Builtin,
    OpenaiCompatible,
    OmpSubscription,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub roles: Vec<Role>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub endpoint: String,
    pub auth: Auth,
    pub roles: Vec<Role>,
    pub models: Vec<Model>,
    pub enabled: bool,
    #[serde(default)]
    pub checked_ms: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
}
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Roles {
    pub llm: Option<String>,
    pub stt: Option<String>,
    pub tts: Option<String>,
}
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub version: u64,
    pub providers: Vec<Provider>,
    pub roles: Roles,
    pub catalog_updated_ms: Option<u64>,
}
pub(crate) fn settings(state: &State) -> Result<Settings> {
    let settings = state
        .journal
        .get("model_settings", "workspace")?
        .unwrap_or_default();
    Ok(with_subscription_providers(settings))
}
fn with_subscription_providers(mut settings: Settings) -> Settings {
    for provider in super::omp_provider::subscription_providers() {
        if !settings.providers.iter().any(|saved| saved.id == provider.id) {
            settings.providers.push(provider);
        }
    }
    settings
}
pub(crate) fn selected_llm(state: &State, fallback: &str) -> Result<String> {
    Ok(settings(state)?
        .roles
        .llm
        .unwrap_or_else(|| fallback.into()))
}
// This owner preference is independent of global role defaults and the SDK's
// committed conversation config. The SDK only permits config changes when idle.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConversationSelection {
    model: String,
}
fn selection_key(profile_id: &str, conversation_id: &str) -> String {
    format!("{profile_id}/{conversation_id}")
}
fn model_key(model: &crate::durable::durable::ai::Model) -> String {
    if model.provider == "mock" {
        "mock".into()
    } else {
        format!("{}/{}", model.provider, model.id)
    }
}
fn registered_llm(settings: &Settings, key: &str) -> Result<()> {
    if key == "mock" {
        return Ok(());
    }
    let (provider, id) = key
        .split_once('/')
        .ok_or_else(|| anyhow!("등록된 응답 모델을 선택해 주세요."))?;
    let p = settings
        .providers
        .iter()
        .find(|p| p.id == provider)
        .ok_or_else(|| {
            anyhow!("선택한 제공자가 등록되어 있지 않습니다. 다른 응답 모델을 선택해 주세요.")
        })?;
    validate(p)?;
    if !p.enabled {
        bail!("선택한 제공자가 비활성화되어 있습니다. 다른 응답 모델을 선택해 주세요.");
    }
    if !p.roles.contains(&Role::Llm)
        || !p
            .models
            .iter()
            .any(|m| m.id == id && m.roles.contains(&Role::Llm))
    {
        bail!("선택한 모델은 등록된 응답 모델이 아닙니다. 다른 응답 모델을 선택해 주세요.");
    }
    Ok(())
}
fn desired_model(
    state: &State,
    profile_id: &str,
    conversation_id: &str,
    effective: &str,
) -> Result<String> {
    Ok(state
        .journal
        .get::<ConversationSelection>(
            "conversation_model",
            &selection_key(profile_id, conversation_id),
        )?
        .map(|selection| selection.model)
        .unwrap_or_else(|| effective.into()))
}
pub(crate) fn conversation_selection(
    state: &State,
    profile_id: &str,
    conversation_id: &str,
    effective: &crate::durable::durable::ai::Model,
) -> Result<Value> {
    let effective = model_key(effective);
    let selected = desired_model(state, profile_id, conversation_id, &effective)?;
    let error = registered_llm(&settings(state)?, &selected)
        .err()
        .map(|error| error.to_string());
    Ok(
        json!({"selected_model":selected,"model_pending":selected != effective,
        "model_available":error.is_none(),"model_error":error}),
    )
}
pub(crate) fn select_conversation(
    state: &State,
    profile_id: &str,
    conversation_id: &str,
    model: &str,
) -> Result<Value> {
    super::text(model, 400)?;
    let p = state
        .profiles
        .get(profile_id)
        .ok_or_else(|| anyhow!("Ghost missing"))?;
    let snapshot = p.runtime.session.snapshot()?;
    let conversation = snapshot
        .conversations
        .get(conversation_id)
        .ok_or_else(|| anyhow!("conversation missing for this Ghost"))?;
    registered_llm(&settings(state)?, model)?;
    // Resolve metadata only; selecting a catalog entry never tests inference or
    // inspects credentials. Existing trusted SDK endpoint validation is retained.
    let store = p
        .host
        .store
        .lock()
        .map_err(|_| anyhow!("profile unavailable"))?;
    crate::durable::config(&store, Some(model), false)?;
    state.journal.put(
        "conversation_model",
        &selection_key(profile_id, conversation_id),
        &ConversationSelection {
            model: model.into(),
        },
    )?;
    let mut status = conversation_selection(
        state,
        profile_id,
        conversation_id,
        &conversation.config.model,
    )?;
    status["model"] = json!(model);
    status["applies_to"] = json!("next_response");
    Ok(status)
}
/// Apply an owner-selected model at admission of the next idle response. Each
/// existing generation keeps the config captured by durable Session::submit.
/// Active steering belongs to that existing generation and preserves its model.
pub(crate) fn prepare_conversation(
    state: &State,
    profile_id: &str,
    conversation_id: &str,
    kind: crate::durable::durable::InputKind,
) -> Result<()> {
    use crate::durable::durable::{InputKind, Phase, TaskKind};
    let p = state
        .profiles
        .get(profile_id)
        .ok_or_else(|| anyhow!("Ghost missing"))?;
    let snapshot = p.runtime.session.snapshot()?;
    let conversation = snapshot
        .conversations
        .get(conversation_id)
        .ok_or_else(|| anyhow!("conversation missing for this Ghost"))?;
    if kind == InputKind::Steer
        && snapshot.tasks.values().any(|task| {
            task.conversation_id == conversation_id
                && !task.phase.terminal()
                && matches!(task.kind, TaskKind::Generation { .. })
        })
    {
        return Ok(());
    }
    let effective = model_key(&conversation.config.model);
    let desired = desired_model(state, profile_id, conversation_id, &effective)?;
    registered_llm(&settings(state)?, &desired)?;
    // Re-resolve even the unchanged key so changed endpoints/catalog metadata
    // apply at an idle boundary, without changing a captured task config.
    let store = p
        .host
        .store
        .lock()
        .map_err(|_| anyhow!("profile unavailable"))?;
    let resolved = crate::durable::config(&store, Some(&desired), false)?.model;
    if serde_json::to_value(&resolved)? == serde_json::to_value(&conversation.config.model)? {
        return Ok(());
    }
    if snapshot.tasks.values().any(|task| {
        task.conversation_id == conversation_id
            && (!task.phase.terminal() || task.phase == Phase::Uncertain)
    }) || snapshot
        .submissions
        .iter()
        .any(|input| input.conversation_id == conversation_id && !input.consumed)
    {
        bail!("모델 선택은 저장되었습니다. 현재 응답이 끝난 뒤 다시 보내면 선택한 모델로 새 응답을 시작합니다.");
    }
    let mut config = conversation.config.clone();
    config.model = resolved;
    p.runtime.session.set_config(conversation_id, config)?;
    Ok(())
}
fn load(root: &Path) -> Result<Settings> {
    let path = root.join("workspace.db");
    if !path.exists() {
        return Ok(Settings::default());
    }
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    use rusqlite::OptionalExtension;
    let value: Option<String> = db
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind='model_settings' AND id='workspace'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    value
        .map(|s| serde_json::from_str(&s).map_err(Into::into))
        .transpose()
        .map(Option::unwrap_or_default)
}
fn builtin_endpoint(id: &str) -> Option<String> {
    if id == "zai" {
        return Some("https://api.z.ai/api/coding/paas/v4".into());
    }
    // Some SDK providers use an empty value to mean their built-in default.
    // Resolve that default from the SDK's static model registry; never trust a
    // user-supplied catalog URL as the destination for stored SDK credentials.
    oxicode_sdk::get_provider_base_url(id)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            oxicode_sdk::get_models(id)
                .into_iter()
                .find(|model| endpoint(&model.base_url).is_ok())
                .map(|model| model.base_url.clone())
        })
}
fn endpoint(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value).map_err(|_| anyhow!("서버 주소를 확인해 주세요."))?;
    let loopback = matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    );
    if !(url.scheme() == "https" || url.scheme() == "http" && loopback)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("HTTPS 또는 로컬 HTTP 주소를 사용하고 주소에 인증 정보를 넣지 마세요.");
    }
    Ok(url)
}
pub fn validate(p: &Provider) -> Result<()> {
    if p.id.is_empty()
        || p.id.len() > 80
        || !p
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        bail!("제공자 ID를 확인해 주세요.");
    }
    super::text(&p.name, 240)?;
    if p.kind == Kind::OmpSubscription {
        if !matches!(p.id.as_str(), "zai" | "minimax-code")
            || p.endpoint != super::omp_provider::ENDPOINT
            || !matches!(&p.auth, Auth::None)
            || p.roles != [Role::Llm]
            || p.models.is_empty()
            || p.models.iter().any(|model| {
                !super::omp_provider::is_allowed(&p.id, &model.id)
                    || model.roles != [Role::Llm]
            })
        {
            bail!("OMP 구독 제공자는 로컬 허용 목록에서만 사용할 수 있습니다.");
        }
    } else {
        endpoint(&p.endpoint)?;
    }
    if p.roles.is_empty() || p.models.len() > 2000 {
        bail!("제공자의 역할과 모델 목록을 확인해 주세요.");
    }
    if p.kind == Kind::Builtin && !oxicode_sdk::is_builtin_provider(&p.id) {
        bail!("OxiCode가 지원하는 제공자를 선택해 주세요.");
    }
    if let Auth::Sdk = p.auth {
        if p.kind != Kind::Builtin
            || builtin_endpoint(&p.id).is_none_or(|expected| {
                expected.trim_end_matches('/') != p.endpoint.trim_end_matches('/')
            })
        {
            bail!("저장된 인증은 해당 제공자의 기본 주소에서만 사용할 수 있습니다.");
        }
    }
    if let Auth::Env { ref variable } = p.auth {
        if variable.len() > 100
            || !variable
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            || variable.is_empty()
        {
            bail!("환경 변수 이름을 확인해 주세요.");
        }
    }
    for m in &p.models {
        super::text(&m.id, 300)?;
        super::text(&m.name, 300)?;
        if m.roles.is_empty() || m.roles.iter().any(|role| !p.roles.contains(role)) {
            bail!("모델 역할은 제공자의 역할에 포함돼야 합니다.");
        }
    }
    Ok(())
}
fn commit(state: &State, mut next: Settings, version: u64) -> Result<Value> {
    if settings(state)?.version != version {
        bail!("모델 설정이 다른 곳에서 바뀌었습니다. 최신 설정을 다시 불러오세요.");
    }
    next.version = version
        .checked_add(1)
        .ok_or_else(|| anyhow!("설정 버전 오류"))?;
    next.providers
        .retain(|provider| provider.kind != Kind::OmpSubscription);
    state.journal.put("model_settings", "workspace", &next)?;
    Ok(json!(with_subscription_providers(next)))
}
pub(crate) fn save(state: &State, mut provider: Provider, version: u64) -> Result<Value> {
    if provider.kind == Kind::OmpSubscription {
        bail!("OMP 구독 제공자는 호스트 설정에서 관리합니다.");
    }
    validate(&provider)?;
    let mut next = settings(state)?;
    if next.providers.len() >= 32 && !next.providers.iter().any(|p| p.id == provider.id) {
        bail!("제공자는 최대 32개까지 등록할 수 있습니다.");
    }
    provider.checked_ms = None;
    provider.error = None;
    next.providers.retain(|p| p.id != provider.id);
    next.providers.push(provider);
    next.providers.sort_by(|a, b| a.name.cmp(&b.name));
    commit(state, next, version)
}
pub(crate) fn delete(state: &State, id: &str, version: u64) -> Result<Value> {
    if matches!(id, "zai" | "minimax-code")
        && super::omp_provider::subscription_providers()
            .iter()
            .any(|provider| provider.id == id)
    {
        bail!("OMP 구독 제공자는 호스트 설정에서 관리합니다.");
    }
    let mut next = settings(state)?;
    if [&next.roles.llm, &next.roles.stt, &next.roles.tts]
        .iter()
        .any(|r| r.as_ref().is_some_and(|m| m.starts_with(&format!("{id}/"))))
    {
        bail!("선택된 모델을 먼저 다른 제공자로 바꾸세요.");
    }
    next.providers.retain(|p| p.id != id);
    commit(state, next, version)
}
pub(crate) fn select(
    state: &State,
    role: Role,
    model: Option<String>,
    version: u64,
) -> Result<Value> {
    let mut next = settings(state)?;
    if let Some(ref key) = model {
        if !(role == Role::Llm && key == "mock") {
            let (provider, id) = key
                .split_once('/')
                .ok_or_else(|| anyhow!("모델을 선택해 주세요."))?;
            let p = next
                .providers
                .iter()
                .find(|p| p.id == provider && p.enabled)
                .ok_or_else(|| anyhow!("활성 제공자를 등록해 주세요."))?;
            if !p
                .models
                .iter()
                .any(|m| m.id == id && m.roles.contains(&role))
            {
                bail!("이 역할에 사용할 수 있는 모델을 선택해 주세요.");
            }
        }
    }
    match role {
        Role::Llm => next.roles.llm = model,
        Role::Stt => next.roles.stt = model,
        Role::Tts => next.roles.tts = model,
    }
    commit(state, next, version)
}
pub fn configured_model(
    root: &Path,
    key: &str,
) -> Result<Option<crate::durable::durable::ai::Model>> {
    let Some((provider, id)) = key.split_once('/') else {
        return Ok(None);
    };
    let settings = with_subscription_providers(load(root)?);
    let Some(p) = settings.providers.iter().find(|p| p.id == provider) else {
        return Ok(None);
    };
    validate(p)?;
    if !p.enabled {
        bail!("제공자가 비활성화돼 있습니다.");
    }
    let model = p
        .models
        .iter()
        .find(|m| m.id == id && m.roles.contains(&Role::Llm))
        .ok_or_else(|| anyhow!("등록된 LLM 모델을 선택해 주세요."))?;
    if p.kind == Kind::Builtin {
        // Keep the current catalog's protocol, cost and context metadata usable
        // after restart, including models newer than the compiled SDK snapshot.
        let runtime_path = root.join(".model-catalog/runtime-models.json");
        if let Ok(bytes) = std::fs::read(runtime_path) {
            if bytes.len() <= 16 * 1024 * 1024 {
                if let Ok(mut current) = serde_json::from_slice::<
                    BTreeMap<String, crate::durable::durable::ai::Model>,
                >(&bytes)
                {
                    if let Some(mut current) = current.remove(key) {
                        current.base_url = p.endpoint.trim_end_matches('/').into();
                        return Ok(Some(current));
                    }
                }
            }
        }
        return oxicode_sdk::OxicodeBuilder::new()
            .with_builtins()
            .with_mcp(false)
            .build()
            .resolve_model(key)
            .map(Some)
            .map_err(Into::into);
    }
    Ok(Some(crate::durable::durable::ai::Model::new(
        id,
        &model.name,
        crate::durable::durable::ai::Api::OpenAiCompletions,
        &p.id,
        &p.endpoint,
    )))
}
pub fn configured_provider(
    root: &Path,
    model: &crate::durable::durable::ai::Model,
) -> Result<Option<Arc<dyn crate::durable::durable::ai::Provider>>> {
    let settings = with_subscription_providers(load(root)?);
    let Some(p) = settings.providers.iter().find(|p| p.id == model.provider) else {
        return Ok(None);
    };
    validate(p)?;
    if !p.enabled {
        bail!("제공자가 비활성화돼 있습니다.");
    }
    if p.kind == Kind::OmpSubscription {
        return Ok(Some(super::omp_provider::create(&p.id)?));
    }
    if p.kind == Kind::Builtin && matches!(p.auth, Auth::Sdk) {
        return Ok(None);
    }
    let key = match &p.auth {
        Auth::Env { variable } => Some(
            std::env::var(variable).map_err(|_| anyhow!("설정한 인증 환경 변수가 없습니다."))?,
        ),
        // The SDK requires a nonempty key even for anonymous local OpenAI-compatible servers.
        // This fixed wire marker is not a credential and never reads an existing secret.
        Auth::None => Some("ghost-anonymous".into()),
        Auth::Sdk => None,
    };
    if p.kind == Kind::Builtin && matches!(p.auth, Auth::None) {
        bail!("이 제공자에는 기존 SDK 인증 또는 인증 환경 변수를 지정해 주세요.");
    }
    if p.kind == Kind::Builtin {
        let mut builder = oxicode_sdk::OxicodeBuilder::new()
            .with_builtins()
            .with_mcp(false)
            .base_url(&p.id, &p.endpoint);
        if let Some(key) = key {
            builder = builder.api_key(&p.id, key);
        }
        return builder
            .build()
            .create_provider(&p.id)
            .map(Some)
            .map_err(Into::into);
    }
    Ok(Some(Arc::new(
        crate::durable::durable::ai::OpenAiProvider::with_base_url_and_key(&p.endpoint, key),
    )))
}

pub async fn catalog(root: &Path) -> Result<Value> {
    let directory = root.join(".model-catalog");
    let cache_path = directory.join("models.json");
    let config = CatalogConfig {
        cache_path: cache_path.clone(),
        etag_path: directory.join("etag"),
        override_path: directory.join("overrides.toml"),
        local_discovery_urls: vec![],
        ..CatalogConfig::default()
    };
    let catalog = FileModelCatalog::init(config).await?;
    let refresh = catalog.refresh().await?;
    let mut providers = vec![];
    let mut runtime_models = BTreeMap::new();
    for id in catalog.list_providers_sync() {
        if !oxicode_sdk::is_builtin_provider(&id) {
            continue;
        }
        let Some(entry) = catalog.get_provider_sync(&id) else {
            continue;
        };
        let Some(endpoint) = builtin_endpoint(&id).or(entry.base_url) else {
            continue;
        };
        let models = catalog
            .list_models_sync(&id)
            .into_iter()
            .map(|m| {
                let mut runtime = oxicode_sdk::bridge::catalog_entry_to_model(&id, &m);
                runtime.base_url = endpoint.clone();
                runtime_models.insert(format!("{}/{}", id, m.model_id), runtime);
                Model {
                    id: m.model_id,
                    name: m.name,
                    roles: vec![Role::Llm],
                }
            })
            .collect::<Vec<_>>();
        if models.is_empty() {
            continue;
        }
        providers.push(Provider {
            id,
            name: entry.display_name,
            kind: Kind::Builtin,
            endpoint,
            auth: Auth::Sdk,
            roles: vec![Role::Llm],
            models,
            enabled: true,
            checked_ms: None,
            error: None,
        });
    }
    std::fs::create_dir_all(&directory)?;
    let temporary = directory.join(format!("runtime-models-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, serde_json::to_vec(&runtime_models)?)?;
    std::fs::rename(temporary, directory.join("runtime-models.json"))?;
    let updated_ms = std::fs::metadata(cache_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64);
    let status = match refresh {
        oxicode_sdk::RefreshOutcome::Updated { .. } => "updated",
        oxicode_sdk::RefreshOutcome::Unchanged => "cached",
        oxicode_sdk::RefreshOutcome::Offline { .. } => "offline",
        oxicode_sdk::RefreshOutcome::Failed { .. } => "failed_using_fallback",
    };
    Ok(
        json!({"providers":providers,"source":"oxicode-sdk/models.dev","updated_ms":updated_ms,
        "checked_ms":now_ms(),"refresh":status,"inference_verified":false}),
    )
}
async fn probe(p: &Provider) -> Result<Vec<Model>> {
    validate(p)?;
    if p.kind == Kind::OmpSubscription {
        return super::omp_provider::probe(&p.id);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()?;
    let url = format!("{}/models", p.endpoint.trim_end_matches('/'));
    let mut request = client.get(url);
    match &p.auth {
        Auth::Env { variable } => {
            request = request.bearer_auth(
                std::env::var(variable).map_err(|_| anyhow!("인증 환경 변수가 없습니다."))?,
            );
        }
        Auth::Sdk => {
            use oxicode_sdk::ports::AuthProvider;
            let stored = std::env::var_os("GHOST_AUTH_FILE").and_then(|path| {
                oxicode_sdk::ports::fs::FileAuthProvider::new(PathBuf::from(path))
                    .get_api_key_sync(&p.id)
                    .ok()
                    .flatten()
                    .filter(|key| !key.is_empty())
            });
            let key = stored.or_else(|| {
                oxicode_sdk::get_provider_env_keys(&p.id)
                    .into_iter()
                    .find_map(|name| std::env::var(name).ok().filter(|key| !key.is_empty()))
            });
            if let Some(key) = key {
                request = if p.id == "anthropic" {
                    request
                        .header("x-api-key", key)
                        .header("anthropic-version", "2023-06-01")
                } else {
                    request.bearer_auth(key)
                };
            }
        }
        Auth::None => {}
    }
    let response = request
        .send()
        .await
        .map_err(|_| anyhow!("서버에 연결하지 못했습니다."))?;
    if !response.status().is_success() {
        bail!(
            "모델 목록을 확인하지 못했습니다 (HTTP {}).",
            response.status().as_u16()
        );
    }
    if response.content_length().is_some_and(|n| n > 1024 * 1024) {
        bail!("서버의 모델 목록이 너무 큽니다.");
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| anyhow!("모델 목록을 읽지 못했습니다."))?;
    if body.len() > 1024 * 1024 {
        bail!("서버의 모델 목록이 너무 큽니다.");
    }
    let value: Value =
        serde_json::from_slice(&body).map_err(|_| anyhow!("모델 목록 형식을 확인해 주세요."))?;
    let rows = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("OpenAI 호환 모델 목록이 아닙니다."))?;
    let existing = p
        .models
        .iter()
        .map(|m| (&m.id, m))
        .collect::<BTreeMap<_, _>>();
    let mut models = vec![];
    for row in rows.iter().take(2000) {
        if let Some(id) = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 300)
        {
            let roles = listed_roles(row, p, existing.get(&id.to_string()).copied());
            models.push(Model {
                id: id.into(),
                name: row
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .chars()
                    .take(300)
                    .collect(),
                roles,
            });
        }
    }
    Ok(models)
}
fn listed_roles(row: &Value, provider: &Provider, existing: Option<&Model>) -> Vec<Role> {
    let declared: Vec<Role> = row
        .get("roles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| serde_json::from_value(value.clone()).ok())
        .filter(|role| provider.roles.contains(role))
        .collect();
    if !declared.is_empty() {
        declared
    } else {
        existing
            .map(|model| model.roles.clone())
            .unwrap_or_else(|| provider.roles.clone())
    }
}
pub async fn check(app: &super::Host, id: &str) -> Result<Value> {
    let initial = { settings(&*app.lock()?)? };
    let p = initial
        .providers
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| anyhow!("제공자를 찾지 못했습니다."))?;
    let result = probe(p).await;
    let state = app.lock()?;
    let mut next = settings(&state)?;
    if next.version != initial.version {
        bail!("연결 확인 중 설정이 바뀌었습니다. 다시 확인해 주세요.");
    }
    let provider = next.providers.iter_mut().find(|p| p.id == id).unwrap();
    provider.checked_ms = Some(now_ms());
    match result {
        Ok(models) => {
            provider.models = models;
            provider.error = None;
        }
        Err(error) => provider.error = Some(error.to_string()),
    }
    let updated = commit(&state, next, initial.version)?;
    Ok(json!({"settings":updated,"inference_verified":false,"check":"models_endpoint"}))
}
pub async fn discover() -> Result<Value> {
    let mut servers = vec![];
    for (id, name, endpoint) in [
        ("local-ollama", "Ollama", "http://127.0.0.1:11434/v1"),
        ("local-lmstudio", "LM Studio", "http://127.0.0.1:1234/v1"),
        ("local-mlx", "MLX / OpenAI 호환", "http://127.0.0.1:8080/v1"),
        ("local-speech", "로컬 음성 서버", "http://127.0.0.1:8000/v1"),
        (
            "ghost-local-speech",
            "Ghost 로컬 음성",
            "http://127.0.0.1:62076/v1",
        ),
    ] {
        let mut p = Provider {
            id: id.into(),
            name: name.into(),
            kind: Kind::OpenaiCompatible,
            endpoint: endpoint.into(),
            auth: Auth::None,
            roles: if id.contains("speech") {
                vec![Role::Stt, Role::Tts]
            } else {
                vec![Role::Llm]
            },
            models: vec![],
            enabled: true,
            checked_ms: Some(now_ms()),
            error: None,
        };
        match probe(&p).await {
            Ok(models) => p.models = models,
            Err(error) => p.error = Some(error.to_string()),
        };
        servers.push(p);
    }
    Ok(
        json!({"servers":servers,"installed_models":installed_models(),"started_servers":false,"inference_verified":false}),
    )
}

fn role_hint(name: &str) -> Vec<Role> {
    let lower = name.to_ascii_lowercase();
    if lower.contains("whisper") || lower.contains("-asr") || lower.contains("speech-to-text") {
        vec![Role::Stt]
    } else if lower.contains("-tts") || lower.contains("text-to-speech") {
        vec![Role::Tts]
    } else {
        vec![]
    }
}
fn installed_models() -> Vec<Value> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return vec![];
    };
    let mut result = vec![];
    for (source, directory) in [
        ("huggingface", home.join(".cache/huggingface/hub")),
        ("lmstudio", home.join(".lmstudio/models")),
        ("ollama", home.join(".ollama/models/manifests")),
    ] {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten().take(128) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            if source == "huggingface" && !name.starts_with("models--") {
                continue;
            }
            let names = if source == "huggingface" {
                vec![(
                    name.trim_start_matches("models--").replace("--", "/"),
                    entry.path(),
                )]
            } else if source == "lmstudio" {
                std::fs::read_dir(entry.path())
                    .into_iter()
                    .flatten()
                    .flatten()
                    .take(128)
                    .filter(|p| p.file_type().is_ok_and(|t| t.is_dir()))
                    .map(|p| {
                        (
                            format!("{}/{}", name, p.file_name().to_string_lossy()),
                            p.path(),
                        )
                    })
                    .collect()
            } else {
                vec![(name, entry.path())]
            };
            for (name, path) in names {
                let roles = role_hint(&name);
                result.push(json!({"id":name,"name":name,"path":path,"source":source,
                    "role_source":if roles.is_empty(){"unknown"}else{"name_hint"},
                    "roles":roles,"serve_required":true,"installation_verified":false}));
                if result.len() >= 256 {
                    return result;
                }
            }
        }
    }
    result.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    result
}
#[cfg(test)]
mod tests {
    use super::super::scheduler::Journal;
    use super::*;
    fn command(app: &Arc<super::super::Host>, command: Value) -> Value {
        app.action(
            serde_json::from_value(
                json!({"request_id":uuid::Uuid::new_v4().to_string(),"command":command}),
            )
            .unwrap(),
        )
        .unwrap()
    }
    fn owner(app: &Arc<super::super::Host>, name: &str) -> (String, String) {
        let created = command(
            app,
            json!({"type":"create_profile","name":name,"persona":"isolated test"}),
        );
        assert_eq!(created["ok"], true, "{created}");
        let profile = created["result"]["profile_id"].as_str().unwrap().to_owned();
        let created = command(
            app,
            json!({"type":"create_conversation","profile_id":profile,"model":"mock","tools":false}),
        );
        assert_eq!(created["ok"], true, "{created}");
        (
            profile,
            created["result"]["conversation_id"]
                .as_str()
                .unwrap()
                .to_owned(),
        )
    }
    fn select_for(
        app: &Arc<super::super::Host>,
        profile: &str,
        conversation: &str,
        model: &str,
    ) -> Value {
        command(
            app,
            json!({"type":"workspace","action":{"type":"conversation_model",
            "profile_id":profile,"conversation_id":conversation,"model":model}}),
        )
    }
    #[tokio::test(flavor = "current_thread")]
    async fn conversation_selection_restores_without_changing_defaults_or_other_chats() {
        let root = tempfile::tempdir().unwrap();
        let app =
            super::super::Host::open_legacy_fixture(root.path(), tokio::runtime::Handle::current(), Some("mock"))
                .unwrap();
        let (profile, conversation) = owner(&app, "selection-one");
        let (other, other_conversation) = owner(&app, "selection-two");
        save(
            &app.lock().unwrap(),
            provider("http://127.0.0.1:1234/v1"),
            0,
        )
        .unwrap();
        let selected = select_for(&app, &profile, &conversation, "local-test/chat");
        assert_eq!(selected["ok"], true, "{selected}");
        assert_eq!(selected["result"]["model_pending"], true);
        assert_eq!(selected["result"]["applies_to"], "next_response");
        let projected = app.snapshot().unwrap();
        let chat = projected["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == profile)
            .unwrap()["conversations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == conversation)
            .unwrap();
        assert_eq!(chat["selected_model"], "local-test/chat");
        assert_eq!(chat["model_pending"], true);
        assert_eq!(chat["model_available"], true);
        assert!(chat["model_error"].is_null());
        {
            let s = app.lock().unwrap();
            assert!(settings(&s).unwrap().roles.llm.is_none());
            let snap = s.profiles[&other].runtime.session.snapshot().unwrap();
            assert_eq!(
                snap.conversations[&other_conversation]
                    .config
                    .model
                    .provider,
                "mock"
            );
            assert_eq!(
                conversation_selection(
                    &s,
                    &other,
                    &other_conversation,
                    &snap.conversations[&other_conversation].config.model
                )
                .unwrap()["selected_model"],
                "mock"
            );
        }
        app.shutdown().await.unwrap();
        drop(app);
        let restored =
            super::super::Host::open_legacy_fixture(root.path(), tokio::runtime::Handle::current(), Some("mock"))
                .unwrap();
        {
            let s = restored.lock().unwrap();
            let snap = s.profiles[&profile].runtime.session.snapshot().unwrap();
            let status = conversation_selection(
                &s,
                &profile,
                &conversation,
                &snap.conversations[&conversation].config.model,
            )
            .unwrap();
            assert_eq!(status["selected_model"], "local-test/chat");
            assert_eq!(status["model_pending"], true);
            prepare_conversation(
                &s,
                &profile,
                &conversation,
                crate::durable::durable::InputKind::Prompt,
            )
            .unwrap();
            let snap = s.profiles[&profile].runtime.session.snapshot().unwrap();
            assert_eq!(snap.conversations[&conversation].config.model.id, "chat");
            assert_eq!(
                conversation_selection(
                    &s,
                    &profile,
                    &conversation,
                    &snap.conversations[&conversation].config.model
                )
                .unwrap()["model_pending"],
                false
            );
        }
        let submitted = command(
            &restored,
            json!({"type":"submit","profile_id":profile,
            "conversation_id":conversation,"prompt":"registered next response","kind":"prompt"}),
        );
        assert_eq!(submitted["ok"], true, "{submitted}");
        {
            let s = restored.lock().unwrap();
            let snap = s.profiles[&profile].runtime.session.snapshot().unwrap();
            let task_id = submitted["result"]["task_id"].as_str().unwrap();
            let crate::durable::durable::TaskKind::Generation { config, .. } =
                &snap.tasks[task_id].kind
            else {
                panic!("generation expected")
            };
            assert_eq!(config.model.provider, "local-test");
            assert_eq!(config.model.id, "chat");
            // Do not run inference against this deliberately unavailable fixture endpoint.
            s.profiles[&profile]
                .runtime
                .session
                .cancel(task_id)
                .unwrap();
        }
        restored.shutdown().await.unwrap();
    }
    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_joins_tasks_tracked_while_stopping_before_cold_reopen() {
        let root = tempfile::tempdir().unwrap();
        let app =
            super::super::Host::open_legacy_fixture(root.path(), tokio::runtime::Handle::current(), Some("mock"))
                .unwrap();
        let workspace_id = app.snapshot().unwrap()["workspace_id"].clone();
        app.shutdown().await.unwrap();
        let retained = Arc::clone(&app);
        app.spawn(async move {
            let _retained = retained;
            std::future::pending::<()>().await;
        });
        app.shutdown().await.unwrap();
        drop(app);
        let restored =
            super::super::Host::open_legacy_fixture(root.path(), tokio::runtime::Handle::current(), Some("mock"))
                .unwrap();
        assert_eq!(restored.snapshot().unwrap()["workspace_id"], workspace_id);
        restored.shutdown().await.unwrap();
    }
    #[tokio::test(flavor = "current_thread")]
    async fn busy_selection_preserves_captured_task_and_active_steering() {
        use crate::durable::durable::TaskKind;
        let root = tempfile::tempdir().unwrap();
        let app =
            super::super::Host::open_legacy_fixture(root.path(), tokio::runtime::Handle::current(), Some("mock"))
                .unwrap();
        let (profile, conversation) = owner(&app, "selection-busy");
        save(
            &app.lock().unwrap(),
            provider("http://127.0.0.1:1234/v1"),
            0,
        )
        .unwrap();
        let submitted = command(
            &app,
            json!({"type":"submit","profile_id":profile,
            "conversation_id":conversation,"prompt":"offline fixture","kind":"prompt"}),
        );
        let task_id = submitted["result"]["task_id"].as_str().unwrap().to_owned();
        assert_eq!(
            select_for(&app, &profile, &conversation, "local-test/chat")["ok"],
            true
        );
        let rejected = command(
            &app,
            json!({"type":"submit","profile_id":profile,
            "conversation_id":conversation,"prompt":"new response","kind":"follow_up"}),
        );
        assert_eq!(rejected["ok"], false);
        let steered = command(
            &app,
            json!({"type":"submit","profile_id":profile,
            "conversation_id":conversation,"prompt":"keep this thought","kind":"steer"}),
        );
        assert_eq!(steered["ok"], true, "{steered}");
        assert_eq!(steered["result"]["task_id"], task_id);
        {
            let s = app.lock().unwrap();
            let snap = s.profiles[&profile].runtime.session.snapshot().unwrap();
            let TaskKind::Generation { config, .. } = &snap.tasks[&task_id].kind else {
                panic!("generation expected")
            };
            assert_eq!(config.model.provider, "mock");
            assert_eq!(
                snap.conversations[&conversation].config.model.provider,
                "mock"
            );
            assert_eq!(
                snap.submissions.len(),
                2,
                "rejected response must not be admitted"
            );
        }
        app.shutdown().await.unwrap();
    }
    #[tokio::test(flavor = "current_thread")]
    async fn conversation_selection_rejects_foreign_disabled_missing_and_speech_models() {
        use crate::durable::durable::InputKind;
        let root = tempfile::tempdir().unwrap();
        let app =
            super::super::Host::open_legacy_fixture(root.path(), tokio::runtime::Handle::current(), Some("mock"))
                .unwrap();
        let (profile, conversation) = owner(&app, "selection-valid");
        let (foreign, _) = owner(&app, "selection-foreign");
        save(
            &app.lock().unwrap(),
            provider("http://127.0.0.1:1234/v1"),
            0,
        )
        .unwrap();
        for (owner, model) in [
            (&foreign, "local-test/chat"),
            (&profile, "local-test/whisper"),
            (&profile, "local-test/voice"),
            (&profile, "local-test/missing"),
            (&profile, "not-registered/chat"),
        ] {
            assert_eq!(select_for(&app, owner, &conversation, model)["ok"], false);
        }
        assert_eq!(
            select_for(&app, &profile, &conversation, "local-test/chat")["ok"],
            true
        );
        let mut disabled = provider("http://127.0.0.1:1234/v1");
        disabled.enabled = false;
        save(&app.lock().unwrap(), disabled, 1).unwrap();
        assert_eq!(
            select_for(&app, &profile, &conversation, "local-test/chat")["ok"],
            false
        );
        {
            let s = app.lock().unwrap();
            let snap = s.profiles[&profile].runtime.session.snapshot().unwrap();
            let status = conversation_selection(
                &s,
                &profile,
                &conversation,
                &snap.conversations[&conversation].config.model,
            )
            .unwrap();
            assert_eq!(status["selected_model"], "local-test/chat");
            assert_eq!(status["model_available"], false);
            assert!(status["model_error"].as_str().unwrap().contains("비활성화"));
            assert!(prepare_conversation(&s, &profile, &conversation, InputKind::Prompt).is_err());
        }
        assert_eq!(
            select_for(&app, &profile, &conversation, "mock")["ok"],
            true
        );
        app.shutdown().await.unwrap();
    }
    #[test]
    fn sdk_empty_openai_default_resolves_without_redirecting_credentials() {
        let expected = builtin_endpoint("openai").unwrap();
        assert_eq!(expected, "https://api.openai.com/v1");
        let mut p = provider(&expected);
        p.id = "openai".into();
        p.kind = Kind::Builtin;
        p.auth = Auth::Sdk;
        assert!(validate(&p).is_ok());
        p.endpoint = "https://unrelated.example/v1".into();
        assert!(validate(&p).is_err());
    }
    #[test]
    fn listed_speech_roles_keep_stt_and_tts_distinct() {
        let p = provider("http://127.0.0.1:62076/v1");
        assert_eq!(
            listed_roles(&json!({"roles":["stt"]}), &p, None),
            vec![Role::Stt]
        );
        assert_eq!(
            listed_roles(&json!({"roles":["tts"]}), &p, None),
            vec![Role::Tts]
        );
        assert_eq!(
            listed_roles(&json!({}), &p, Some(&p.models[0])),
            vec![Role::Llm]
        );
        let mut limited = p.clone();
        limited.roles = vec![Role::Stt];
        assert_eq!(
            listed_roles(&json!({"roles":["stt","tts"]}), &limited, None),
            vec![Role::Stt]
        );
    }
    fn state(root: &Path) -> State {
        State {
            profiles: BTreeMap::new(),
            journal: Journal::open(&root.join("workspace.db")).unwrap(),
        }
    }
    fn provider(url: &str) -> Provider {
        Provider {
            id: "local-test".into(),
            name: "Local".into(),
            kind: Kind::OpenaiCompatible,
            endpoint: url.into(),
            auth: Auth::None,
            roles: vec![Role::Llm, Role::Stt, Role::Tts],
            models: vec![
                Model {
                    id: "chat".into(),
                    name: "Chat".into(),
                    roles: vec![Role::Llm],
                },
                Model {
                    id: "whisper".into(),
                    name: "Speech recognition".into(),
                    roles: vec![Role::Stt],
                },
                Model {
                    id: "voice".into(),
                    name: "Speech synthesis".into(),
                    roles: vec![Role::Tts],
                },
            ],
            enabled: true,
            checked_ms: None,
            error: None,
        }
    }
    #[test]
    fn roles_restore_and_stale_updates_do_not_overwrite() {
        let root = tempfile::tempdir().unwrap();
        let s = state(root.path());
        save(&s, provider("http://127.0.0.1:1234/v1"), 0).unwrap();
        select(&s, Role::Llm, Some("local-test/chat".into()), 1).unwrap();
        assert!(select(&s, Role::Tts, Some("local-test/chat".into()), 2).is_err());
        assert!(save(&s, provider("http://127.0.0.1:1234/v1"), 0).is_err());
        select(&s, Role::Stt, Some("local-test/whisper".into()), 2).unwrap();
        select(&s, Role::Tts, Some("local-test/voice".into()), 3).unwrap();
        assert!(delete(&s, "local-test", 4).is_err());
        drop(s);
        let saved = load(root.path()).unwrap();
        assert_eq!(saved.version, 4);
        assert_eq!(saved.roles.tts.as_deref(), Some("local-test/voice"));
        let s = state(root.path());
        assert_eq!(selected_llm(&s, "mock").unwrap(), "local-test/chat");
        assert_eq!(
            configured_model(root.path(), "local-test/chat")
                .unwrap()
                .unwrap()
                .base_url,
            "http://127.0.0.1:1234/v1"
        );
        let mut disabled = provider("http://127.0.0.1:1234/v1");
        disabled.enabled = false;
        save(&s, disabled, 4).unwrap();
        assert!(configured_model(root.path(), "local-test/chat").is_err());
    }
    #[test]
    fn credential_references_and_endpoint_boundaries() {
        for url in [
            "http://evil.example/v1",
            "https://user:secret@example.com/v1",
            "https://example.com/v1?token=x",
            "file:///tmp/key",
        ] {
            assert!(validate(&provider(url)).is_err());
        }
        let mut p = provider("https://example.com/v1");
        p.auth = Auth::Sdk;
        assert!(validate(&p).is_err());
        p.id = "zai".into();
        p.kind = Kind::Builtin;
        assert!(validate(&p).is_err());
        p.endpoint = builtin_endpoint("zai").unwrap();
        assert!(validate(&p).is_ok());
        p.auth = Auth::Env {
            variable: "GHOST_EXISTING_AUTH".into(),
        };
        assert!(validate(&p).is_ok());
        let value = serde_json::to_value(p).unwrap();
        assert_eq!(value["auth"]["variable"], "GHOST_EXISTING_AUTH");
        assert!(
            serde_json::from_value::<Provider>(json!({"api_key":"must-not-be-accepted"})).is_err()
        );
        assert_eq!(
            role_hint("mlx-community/whisper-large-asr"),
            vec![Role::Stt]
        );
        assert_eq!(role_hint("mlx-community/Qwen3-TTS"), vec![Role::Tts]);
        assert!(role_hint("image-generation-model").is_empty());
    }
    #[tokio::test]
    async fn local_probe_keeps_roles_and_never_follows_redirects() {
        let body = r#"{"data":[{"id":"chat"},{"id":"whisper"},{"id":"voice"}]}"#;
        let (url, request, task) = crate::test_http::once(Some(crate::test_http::reply(
            "200 OK",
            "Content-Type: application/json\r\n",
            body,
        )))
        .await;
        let result = probe(&provider(&url)).await.unwrap();
        assert_eq!(result[1].roles, vec![Role::Stt]);
        assert!(String::from_utf8(request.await.unwrap())
            .unwrap()
            .starts_with("GET /models "));
        task.await.unwrap();
        let (url, request, task) = crate::test_http::once(Some(crate::test_http::reply(
            "302 Found",
            "Location: https://example.com/\r\n",
            "do not disclose upstream body",
        )))
        .await;
        let error = probe(&provider(&url)).await.unwrap_err().to_string();
        assert!(error.contains("302"));
        assert!(!error.contains("disclose"));
        request.await.unwrap();
        task.await.unwrap();
    }
    #[tokio::test]
    async fn selected_local_model_streams_through_oxicode() {
        use crate::durable::durable::ai;
        use futures::StreamExt;
        let events=concat!(
            "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"local response\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n");
        let (url, request, task) = crate::test_http::once(Some(crate::test_http::reply(
            "200 OK",
            "Content-Type: text/event-stream\r\n",
            events,
        )))
        .await;
        let root = tempfile::tempdir().unwrap();
        let s = state(root.path());
        save(&s, provider(&url), 0).unwrap();
        let model = configured_model(root.path(), "local-test/chat")
            .unwrap()
            .unwrap();
        let runtime = configured_provider(root.path(), &model).unwrap().unwrap();
        let context = ai::Context::from(ai::Message::User(ai::UserMessage::new("hello")));
        let mut stream = runtime.stream(&model, &context, None).await.unwrap();
        let mut output = String::new();
        while let Some(event) = stream.next().await {
            output.push_str(&format!("{event:?}"));
        }
        assert!(output.contains("local response"), "{output}");
        let request = String::from_utf8(request.await.unwrap()).unwrap();
        assert!(request.starts_with("POST /chat/completions "));
        assert!(request.contains("\"model\":\"chat\""));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer ghost-anonymous"));
        task.await.unwrap();
    }
}
