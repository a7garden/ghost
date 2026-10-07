//! Ghost host for oxicode's durable control plane. New conversations use a
//! per-profile durable.db; legacy task/outbox commands keep their v1 contract.
use crate::{store::ProfileStore, tools};
use durable::{
    ai, AgentConfig, Host, HostFuture, Phase, Providers, Runtime, Session, Task, ToolOutput,
    ToolPlan, ToolStatus,
};
pub use oxicode_sdk::durable;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub struct GhostHost {
    pub store: Arc<Mutex<ProfileStore>>,
    services: Mutex<Option<Arc<dyn Host>>>,
    file_fence: Mutex<Option<Arc<dyn FileEffectFence>>>,
}
/// Workspace code pins current work authority before synchronous file I/O.
/// Standalone durable hosts retain their existing file capability behavior.
pub trait FileEffectFence: Send + Sync {
    fn execute_file(
        &self,
        task: &Task,
        call: &ai::ToolCall,
        effect: &mut dyn FnMut() -> durable::Result<ToolOutput>,
    ) -> durable::Result<ToolOutput>;
}
impl GhostHost {
    pub fn new(store: Arc<Mutex<ProfileStore>>) -> Self {
        Self {
            store,
            services: Mutex::new(None),
            file_fence: Mutex::new(None),
        }
    }
    pub fn install_file_fence(&self, fence: Arc<dyn FileEffectFence>) -> durable::Result<()> {
        let mut current = self
            .file_fence
            .lock()
            .map_err(|_| durable::Error::Host("file fence unavailable".into()))?;
        if current.is_some() {
            return Err(durable::Error::Host("file fence already installed".into()));
        }
        *current = Some(fence);
        Ok(())
    }
    pub fn install_services(&self, services: Arc<dyn Host>) -> durable::Result<()> {
        let mut current = self
            .services
            .lock()
            .map_err(|_| durable::Error::Host("services unavailable".into()))?;
        if current.is_some() {
            return Err(durable::Error::Host("services already installed".into()));
        }
        *current = Some(services);
        Ok(())
    }
    fn services(&self) -> durable::Result<Arc<dyn Host>> {
        self.services
            .lock()
            .map_err(|_| durable::Error::Host("services unavailable".into()))?
            .clone()
            .ok_or_else(|| durable::Error::Host("workspace service is not connected".into()))
    }
    fn lock(&self) -> durable::Result<std::sync::MutexGuard<'_, ProfileStore>> {
        self.store
            .lock()
            .map_err(|_| durable::Error::Host("profile lock poisoned".into()))
    }
    pub(crate) fn target(
        store: &ProfileStore,
        call: &ai::ToolCall,
        executing: bool,
    ) -> durable::Result<(PathBuf, i64)> {
        let op = match call.name.as_str() {
            "read_file" => "read",
            "write_file" => "write",
            _ => return Err(durable::Error::Host("unknown tool".into())),
        };
        let raw = call
            .arguments
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| durable::Error::Host("path required".into()))?;
        let abs = tools::lexical_abs(Path::new(raw))
            .map_err(|_| durable::Error::Host("invalid path".into()))?;
        let root = store
            .root
            .canonicalize()
            .map_err(|_| durable::Error::Host("root unavailable".into()))?;
        if abs.starts_with(&root) {
            return Err(durable::Error::Host("Ghost state is protected".into()));
        }
        let grant = store
            .grant_for(op, &abs)
            .ok_or_else(|| durable::Error::Host("no current capability grant".into()))?;
        // Planning may inspect an existing target to reuse a committed receipt.
        // Actual writes always use create_new and refuse an existing file.
        let write = op == "write" && (executing || !abs.exists());
        let target = tools::resolve(Path::new(&grant.path), &abs, write).map_err(|_| {
            durable::Error::Host("target outside capability or overwrite refused".into())
        })?;
        if target.starts_with(&root) {
            return Err(durable::Error::Host("Ghost state is protected".into()));
        }
        Ok((target, grant.id))
    }
}
impl Host for GhostHost {
    fn admit_tool(&self, task: &Task, call: &ai::ToolCall) -> durable::Result<()> {
        let services = self
            .services
            .lock()
            .map_err(|_| durable::Error::Host("services lock poisoned".into()))?
            .clone();
        match services {
            Some(s) => s.admit_tool(task, call),
            None => Ok(()),
        }
    }
    fn waits_for_owner(&self, call: &ai::ToolCall) -> bool {
        self.services().is_ok_and(|s| s.waits_for_owner(call))
    }
    fn admit_model(&self, task: &Task, config: &AgentConfig) -> durable::Result<()> {
        let services = self
            .services
            .lock()
            .map_err(|_| durable::Error::Host("services lock poisoned".into()))?
            .clone();
        match services {
            Some(s) => s.admit_model(task, config),
            None => Ok(()),
        }
    }
    fn prepare(&self, task: &Task, call: &ai::ToolCall) -> durable::Result<ToolPlan> {
        self.admit_tool(task, call)?;
        if !matches!(call.name.as_str(), "read_file" | "write_file") {
            return self.services()?.prepare(task, call);
        }
        let store = self.lock()?;
        let (target, _) = Self::target(&store, call, false)?;
        Ok(ToolPlan {
            effect_key: if call.name == "write_file" {
                format!("{}:create:{}", store.uuid, target.display())
            } else {
                format!("{}:read:{}", store.uuid, task.id)
            },
            replay_safe: call.name == "read_file",
        })
    }
    fn execute<'a>(
        &'a self,
        task: &'a Task,
        call: &'a ai::ToolCall,
        plan: &'a ToolPlan,
    ) -> HostFuture<'a, ToolOutput> {
        if !matches!(call.name.as_str(), "read_file" | "write_file") {
            return Box::pin(async move { self.services()?.execute(task, call, plan).await });
        }
        let store = self.store.clone();
        let task = task.clone();
        let call = call.clone();
        let plan = plan.clone();
        Box::pin(async move {
            self.admit_tool(&task, &call)?;
            let services = self
                .services
                .lock()
                .map_err(|_| durable::Error::Host("services unavailable".into()))?
                .clone();
            let file_fence = self
                .file_fence
                .lock()
                .map_err(|_| durable::Error::Host("file fence unavailable".into()))?
                .clone();
            tokio::task::spawn_blocking(move || {
                if services.as_ref().is_some_and(|s| s.admit_tool(&task, &call).is_err()) {
                    return Ok(ToolOutput::error(ToolStatus::Denied, "authority revoked before file dispatch"));
                }
                let mut effect=|| {
                let store = store.lock().map_err(|_| durable::Error::Host("profile lock poisoned".into()))?;
                let (target, grant) = match Self::target(&store, &call, true) { Ok(t) => t, Err(_) => return Ok(ToolOutput::error(ToolStatus::Denied, "current grant denied or target already exists")) };
                let expected = if call.name=="write_file" { format!("{}:create:{}", store.uuid, target.display()) } else { format!("{}:read:{}", store.uuid, task.id) };
                if expected != plan.effect_key { return Ok(ToolOutput::error(ToolStatus::Denied, "target changed since durable intent")); }
                store.audit(None, "durable_effect_started", &serde_json::json!({"task": task.id, "effect_key": plan.effect_key, "grant_id": grant}).to_string()).map_err(|_| durable::Error::Host("audit commit failed before effect".into()))?;
                let io = if call.name=="read_file" { tools::read_bounded(&target).map(|s| serde_json::json!({"text": s})) } else {
                    let content = call.arguments.get("content").and_then(|x| x.as_str()).ok_or_else(|| durable::Error::Host("content missing".into()))?;
                    tools::write_new(&target, content).map(|_| serde_json::json!({"path": target}))
                };
                let mut output = match io {
                    Ok(value) => ToolOutput::success(if call.name=="read_file" { "File read" } else { "File created" }, value),
                    Err(_) if call.name=="read_file" => ToolOutput::error(ToolStatus::Failed, "file read failed; no external write occurred"),
                    Err(_) => ToolOutput::error(ToolStatus::Uncertain, "file creation may have partially completed; inspect the file and reconcile the effect"),
                };
                output.artifacts.push(target.to_string_lossy().into());
                store.audit(None, "durable_effect_result", &serde_json::json!({"task": task.id,"effect_key":plan.effect_key,"status":output.status}).to_string()).map_err(|_| durable::Error::Host("audit failed after possible effect".into()))?;
                drop(store);
                Ok(output)
                };
                let output=if let Some(fence)=file_fence { fence.execute_file(&task,&call,&mut effect)? } else { effect()? };
                // Recheck after releasing the profile lock to preserve lock order
                // and prevent revoked read content from reaching a delegator.
                if services.as_ref().is_some_and(|s| s.admit_tool(&task, &call).is_err()) {
                    return Ok(ToolOutput::error(if call.name == "read_file" { ToolStatus::Denied } else { ToolStatus::Uncertain }, "authority revoked during file execution; inspect any write before reconciliation"));
                }
                Ok(output)
            }).await.map_err(|_| durable::Error::Host("host worker interrupted".into()))?
        })
    }
    fn child_config(&self, parent: &Task, _: &ai::ToolCall) -> durable::Result<AgentConfig> {
        let durable::TaskKind::Generation { config, .. } = &parent.kind else {
            return Err(durable::Error::Host("generation required".into()));
        };
        let store = self.lock()?;
        // Child is analysis-only. An owner can explicitly configure a separate
        // root conversation with host tools; delegation never inherits them.
        Ok(AgentConfig::new(
            config.model.clone(),
            format!(
                "Ghost {}. {}. Complete the delegated analysis and report a concise result.",
                store.uuid, store.persona
            ),
        ))
    }
}
pub fn tool_definitions() -> Vec<ai::Tool> {
    vec![
        ai::Tool::new("read_file", "Read a bounded UTF-8 file inside an owner-granted directory.", serde_json::json!({"type":"object","properties":{"path":{"type":"string","minLength":1}},"required":["path"],"additionalProperties":false})),
        ai::Tool::new("write_file", "Create a new UTF-8 file inside an owner-granted directory. Existing files cannot be overwritten. An uncertain result requires owner reconciliation.", serde_json::json!({"type":"object","properties":{"path":{"type":"string","minLength":1},"content":{"type":"string","maxLength":524288}},"required":["path","content"],"additionalProperties":false})),
        ai::Tool::new("durable_delegate", "Delegate an analysis-only task. Owned children are joined before continuing; background children persist independently. Children have no filesystem tools.", serde_json::json!({"type":"object","properties":{"prompt":{"type":"string","minLength":1,"maxLength":32768},"background":{"type":"boolean"}},"required":["prompt"],"additionalProperties":false})),
    ]
}

/// Deterministic offline model: history is visible in the response. It requests
/// no effects by itself. Tests inject scripted providers to exercise tools.
pub struct MockModel;
impl ai::Provider for MockModel {
    fn stream<'a>(
        &'a self,
        model: &'a ai::Model,
        context: &'a ai::Context,
        _: Option<ai::StreamOptions>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ai::prelude::StreamResult> + Send + 'a>>
    {
        Box::pin(async move {
            let mut m = ai::AssistantMessage::new(model.api, &model.provider, &model.id);
            let text = if context
                .system_prompt
                .as_deref()
                .is_some_and(|s| s.starts_with("Summarize this conversation"))
            {
                context
                    .messages
                    .iter()
                    .filter_map(|m| m.text_content().ok())
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                serde_json::json!({"provider":"mock","history_messages":context.messages.len(),"last_input":context.messages.last().and_then(|m| m.text_content().ok())}).to_string()
            };
            m.content
                .push(ai::ContentBlock::Text(ai::TextContent::new(text)));
            m.usage.input = context.messages.len();
            m.usage.output = 1;
            m.usage.total_tokens = m.usage.input + 1;
            Ok(
                Box::pin(futures::stream::iter(vec![ai::ProviderEvent::Done {
                    reason: ai::StopReason::Stop,
                    message: m,
                }]))
                    as std::pin::Pin<Box<dyn futures::Stream<Item = ai::ProviderEvent> + Send>>,
            )
        })
    }
}
pub fn mock_model() -> ai::Model {
    ai::Model::new(
        "mock",
        "Offline mock",
        ai::Api::OpenAiCompletions,
        "mock",
        "",
    )
}
pub struct GhostProviders {
    engine: oxicode_sdk::Oxicode,
    #[cfg(feature = "host")]
    root: Option<PathBuf>,
}
impl GhostProviders {
    pub fn new() -> Self {
        let mut builder = oxicode_sdk::OxicodeBuilder::new()
            .with_builtins()
            .with_mcp(false)
            // Ghost's static `zai/*` models target Coding Plan. The SDK's
            // provider catalog otherwise overrides their URL with the general
            // pay-as-you-go endpoint, where subscription keys return HTTP 429.
            .base_url("zai", "https://api.z.ai/api/coding/paas/v4");
        if let Some(path) = std::env::var_os("GHOST_AUTH_FILE") {
            builder = builder.with_auth(Arc::new(oxicode_sdk::ports::fs::FileAuthProvider::new(
                PathBuf::from(path),
            )));
        }
        Self {
            engine: builder.build(),
            #[cfg(feature = "host")]
            root: None,
        }
    }
    pub fn for_root(root: PathBuf) -> Self {
        #[allow(unused_mut)]
        let mut providers = Self::new();
        #[cfg(feature = "host")]
        {
            providers.root = Some(root);
        }
        #[cfg(not(feature = "host"))]
        let _ = root;
        providers
    }
    /// Constructor checks do not establish network connectivity or billing.
    /// Secrets are resolved by the SDK and are never included in this report.
    pub fn preflight(&self, model: &str) -> anyhow::Result<serde_json::Value> {
        let model = if model == "mock" {
            mock_model()
        } else {
            self.engine.resolve_model(model)?
        };
        let ready = self.resolve(&model).is_ok();
        Ok(
            serde_json::json!({"provider":model.provider,"model":model.id,"provider_constructor_ready":ready,"offline":model.provider=="mock","live_request_performed":false,"endpoint":if model.provider=="zai" {Some("https://api.z.ai/api/coding/paas/v4")} else {None}}),
        )
    }
}
impl Default for GhostProviders {
    fn default() -> Self {
        Self::new()
    }
}
impl Providers for GhostProviders {
    fn resolve(
        &self,
        model: &ai::Model,
    ) -> durable::Result<(Arc<dyn ai::Provider>, ai::StreamOptions)> {
        if model.provider == "mock" {
            return Ok((Arc::new(MockModel), ai::StreamOptions::default()));
        }
        #[cfg(feature = "host")]
        if let Some(root) = &self.root {
            if let Some(provider) = crate::host::models::configured_provider(root, model)
                .map_err(|_| durable::Error::Host("configured provider unavailable".into()))?
            {
                return Ok((provider, ai::StreamOptions::default()));
            }
        }
        let provider = self
            .engine
            .create_provider(&model.provider)
            .map_err(|_| durable::Error::Host("provider unavailable".into()))?;
        Ok((provider, ai::StreamOptions::default()))
    }
}
fn resolve_model_for_root(root: &std::path::Path, id: &str) -> anyhow::Result<ai::Model> {
    #[cfg(feature = "host")]
    if let Some(model) = crate::host::models::configured_model(root, id)? {
        return Ok(model);
    }
    #[cfg(not(feature = "host"))]
    let _ = root;
    Ok(oxicode_sdk::OxicodeBuilder::new()
        .with_builtins()
        .with_mcp(false)
        .build()
        .resolve_model(id)?)
}
pub fn config(
    store: &ProfileStore,
    model: Option<&str>,
    tools_enabled: bool,
) -> anyhow::Result<AgentConfig> {
    let model = match model {
        None | Some("mock") => mock_model(),
        Some(id) => resolve_model_for_root(&store.root, id)?,
    };
    let mut config = AgentConfig::new(model, format!("You are Ghost {}. Persona: {}. Host grants determine every tool capability. Preserve unresolved work across turns.", store.uuid, store.persona));
    if tools_enabled {
        config.tools = tool_definitions();
    }
    config.compact_after_bytes = 96 * 1024;
    Ok(config)
}
pub fn open(store: ProfileStore) -> anyhow::Result<Runtime> {
    Ok(open_with_host(store)?.0)
}
pub fn open_with_host(store: ProfileStore) -> anyhow::Result<(Runtime, Arc<GhostHost>)> {
    let session = Session::open(store.dir.join("durable.db"))?;
    let provider_root = store.root.clone();
    let store = Arc::new(Mutex::new(store));
    let host = Arc::new(GhostHost::new(store));
    Ok((
        Runtime::new(
            session,
            Arc::new(GhostProviders::for_root(provider_root)),
            host.clone(),
        ),
        host,
    ))
}
pub fn status(runtime: &Runtime, conversation: &str) -> anyhow::Result<serde_json::Value> {
    let s = runtime.session.snapshot()?;
    let c = s
        .conversations
        .get(conversation)
        .ok_or_else(|| anyhow::anyhow!("conversation missing"))?;
    let tasks: Vec<_> = s
        .tasks
        .values()
        .filter(|t| t.conversation_id == conversation)
        .collect();
    Ok(
        serde_json::json!({"revision":s.revision,"conversation":c,"tasks":tasks,"blocked":tasks.iter().any(|t|t.phase==Phase::Uncertain)}),
    )
}
