//! Durable identity policy and responsibility records. No presentation or transport state.
use crate::durable::durable::AgentConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub mod protocol;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Policy {
    pub browser: bool,
    pub shell: bool,
    pub memory: bool,
    pub delegation: bool,
    pub voice: bool,
    pub daily_requests: u64,
    pub daily_tokens: u64,
    pub daily_cost_usd: f64,
    pub concurrency: usize,
    pub model: Option<String>,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            browser: false,
            shell: false,
            memory: false,
            delegation: true,
            voice: false,
            daily_requests: 100,
            daily_tokens: 1_000_000,
            daily_cost_usd: 10.0,
            concurrency: 4,
            model: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Review {
    pub id: String,
    pub profile_id: String,
    pub conversation_id: String,
    pub task_id: String,
    pub space_id: String,
    pub page_id: String,
    pub title: String,
    pub body: String,
    pub profile: String,
    pub expected_hash: Option<String>,
    pub created: String,
    pub expires_ms: u64,
    pub state: String,
    pub result: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Delegation {
    pub id: String,
    pub owner: String,
    pub owner_task: String,
    pub target: String,
    pub conversation_id: String,
    pub task_id: String,
    pub background: bool,
    pub state: String,
    #[serde(default)]
    pub config: Option<AgentConfig>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Spend {
    pub day: u64,
    pub requests: u64,
    #[serde(default)]
    pub baseline_tokens: u64,
    #[serde(default)]
    pub baseline_cost: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Goal {
    pub id: String,
    pub profile_id: String,
    pub title: String,
    pub criteria: String,
    pub instruction: String,
    pub state: String,
    pub dependencies: Vec<String>,
    pub event: Option<String>,
    pub task_id: Option<String>,
    pub evidence: Vec<String>,
    pub note: String,
    #[serde(default)]
    pub run: u64,
    #[serde(default)]
    pub created_ms: u64,
    #[serde(default)]
    pub last_event_ms: u64,
}
