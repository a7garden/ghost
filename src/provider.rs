//! Provider abstraction. The default `MockProvider` is deterministic, offline,
//! and never loads credentials or performs network access. The optional
//! `oxicode-engine` feature adds an adapter; no engine tools are registered,
//! host tools remain the sole capability enforcement.

use crate::provider_control::{CallResult, ProviderDescriptor, RunControl, StreamEvent};
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct ProviderRequest {
    pub profile_uuid: String,
    pub persona: String,
    pub session_uuid: String,
    pub task_uuid: String,
    pub message_id: String,
    pub prompt: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderResponse {
    pub content: String,
}

pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;
    fn run(&self, req: &ProviderRequest) -> Result<ProviderResponse>;
    /// Native transports opt into host journal/control; legacy engines retain
    /// their existing behavior and do not claim these controls.
    fn native_descriptor(&self) -> Option<ProviderDescriptor> {
        None
    }
    fn run_controlled(
        &self,
        req: &ProviderRequest,
        _attempt_id: &str,
        _control: &RunControl,
        _observer: &mut dyn FnMut(&StreamEvent) -> Result<()>,
    ) -> Result<CallResult> {
        let response = self.run(req)?;
        Ok(CallResult {
            content: response.content,
            usage: None,
        })
    }
}

/// Deterministic echo provider: returns identity/session/correlation context
/// as JSON. Suitable for offline tests and default operation.
pub struct MockProvider;

impl Provider for MockProvider {
    fn name(&self) -> &'static str {
        "mock"
    }
    fn run(&self, req: &ProviderRequest) -> Result<ProviderResponse> {
        let content = serde_json::json!({
            "provider": "mock",
            "identity": req.profile_uuid,
            "persona": req.persona,
            "session": req.session_uuid,
            "task": req.task_uuid,
            "message_id": req.message_id,
            "prompt": req.prompt,
        })
        .to_string();
        Ok(ProviderResponse { content })
    }
}

#[cfg(feature = "oxicode-engine")]
pub struct OxicodeProvider {
    pub model_id: String,
}

#[cfg(feature = "oxicode-engine")]
impl Provider for OxicodeProvider {
    fn name(&self) -> &'static str {
        "oxicode"
    }
    fn run(&self, req: &ProviderRequest) -> Result<ProviderResponse> {
        use oxicode_sdk::{AgentConfig, OxicodeBuilder};
        let system_prompt = format!(
            "You are a ghost identity {} with persona {:?}. Session {} task {} message {}. \
             Host-enforced filesystem tools are the only capability; you have no engine tools.",
            req.profile_uuid, req.persona, req.session_uuid, req.task_uuid, req.message_id
        );
        // OxicodeBuilder::build returns Oxicode directly; keep engine alive in binding.
        let oxicode = OxicodeBuilder::new()
            .with_builtins()
            .with_mcp(false)
            .build(); // build() returns Oxicode directly (not a Result). Ghost owns persistence; SDK Supervisor persistence is intentionally unused.
        let agent = oxicode
            .agent(AgentConfig {
                model_id: self.model_id.clone(),
                ..Default::default()
            })
            .system_prompt(system_prompt)
            .build()?;
        let prompt = format!("{}\n\n[{}]", req.prompt, req.message_id);
        let rt = tokio::runtime::Runtime::new()?;
        let (response, _events) = rt.block_on(agent.run(prompt))?;
        Ok(ProviderResponse {
            content: response.content,
        })
    }
}
