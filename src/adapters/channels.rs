//! Durable channel adapters. Inbound work uses the ordinary conversation
//! runtime. Slack replies require an owner-approved outbox send.
use crate::durable::durable::AgentConfig;
#[cfg(not(feature = "channels"))]
use crate::host::Host;
#[cfg(not(feature = "channels"))]
use anyhow::anyhow;
#[cfg(not(feature = "channels"))]
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(not(feature = "channels"))]
use std::sync::Arc;

#[derive(Clone, Serialize, Deserialize)]
pub struct SlackBinding {
    pub id: String,
    pub profile_id: String,
    pub team: String,
    pub channel: String,
    pub users: Vec<String>,
    pub enabled: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Incoming {
    pub id: String,
    pub profile_id: String,
    pub team: String,
    pub channel: String,
    pub user: String,
    pub thread: String,
    pub text: String,
    pub conversation_id: String,
    pub task_id: Option<String>,
    pub config: AgentConfig,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Outbox {
    pub id: String,
    pub profile_id: String,
    pub team: String,
    pub channel: String,
    pub thread: String,
    pub text: String,
    pub state: String,
    pub receipt: Option<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Call {
    pub id: String,
    pub profile_id: String,
    pub conversation_id: String,
    pub remote_id: Option<String>,
    pub started_ms: u64,
    pub expires_ms: u64,
    pub state: String,
}

#[cfg(feature = "channels")]
#[path = "channels_impl.rs"]
mod enabled;

pub fn available() -> bool {
    cfg!(feature = "channels")
}

#[cfg(feature = "channels")]
pub use enabled::{prepare_outbox, receive, send_slack, start, voice_end, voice_start};

#[cfg(not(feature = "channels"))]
fn unavailable<T>() -> Result<T> {
    Err(anyhow!(
        "channel adapters unavailable; enable the `channels` feature"
    ))
}

#[cfg(not(feature = "channels"))]
pub fn receive(_host: &Host, _envelope: &Value) -> Result<()> {
    unavailable()
}
#[cfg(not(feature = "channels"))]
pub fn prepare_outbox(_host: &Host) -> Result<()> {
    unavailable()
}
#[cfg(not(feature = "channels"))]
pub async fn send_slack(_host: &Host, _id: &str) -> Result<Value> {
    unavailable()
}
#[cfg(not(feature = "channels"))]
pub fn start(_host: &Arc<Host>) -> Vec<tokio::task::JoinHandle<()>> {
    Vec::new()
}
#[cfg(not(feature = "channels"))]
pub async fn voice_start(
    _host: &Host,
    _request: &str,
    _profile: &str,
    _conversation: &str,
    _sdp: &str,
) -> Result<Value> {
    unavailable()
}
#[cfg(not(feature = "channels"))]
pub async fn voice_end(_host: &Host, _id: &str) -> Result<Value> {
    unavailable()
}
