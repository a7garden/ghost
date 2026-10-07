//! Versioned execution metadata. Messages never grant recipient authority.
use crate::durable::durable::Phase;
use serde::{Deserialize, Serialize};
pub const VERSION: &str = "ghost-collaboration/1";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub protocol: String,
    pub message_id: String,
    pub correlation_id: String,
    pub sequence: u64,
    pub from: String,
    pub to: String,
    pub created_ms: u64,
    pub event: Event,
}
impl Message {
    pub fn validate(&self) -> anyhow::Result<()> {
        let uuid =
            |value: &str| uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value);
        if self.protocol != VERSION
            || self.sequence == 0
            || !uuid(&self.message_id)
            || !uuid(&self.correlation_id)
            || !uuid(&self.from)
            || !uuid(&self.to)
            || self.from == self.to
        {
            anyhow::bail!("invalid or unsupported collaboration envelope");
        }
        self.event.validate()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    Requested {
        prompt: String,
        background: bool,
    },
    Accepted {
        conversation_id: String,
        task_id: String,
    },
    Progress {
        task_id: String,
        revision: u64,
        phase: Phase,
        summary: String,
        artifacts: Vec<String>,
    },
    Result {
        conversation_id: String,
        task_id: String,
        phase: Phase,
        summary: String,
        artifacts: Vec<String>,
    },
    CancelRequested {
        reason: String,
    },
    CancelReceipt {
        task_id: Option<String>,
        phase: Option<Phase>,
        uncertain_effects: Vec<String>,
    },
}
impl Event {
    pub fn validate(&self) -> anyhow::Result<()> {
        let valid = match self {
            Self::Requested { prompt, .. } => !prompt.trim().is_empty() && prompt.len() <= 8192,
            Self::Progress {
                summary, artifacts, ..
            }
            | Self::Result {
                summary, artifacts, ..
            } => {
                summary.len() <= 32768
                    && artifacts.len() <= 32
                    && artifacts.iter().all(|a| a.len() <= 4096)
            }
            Self::CancelRequested { reason } => !reason.is_empty() && reason.len() <= 2048,
            Self::Accepted {
                conversation_id,
                task_id,
            } => valid_id(conversation_id) && valid_id(task_id),
            Self::CancelReceipt {
                task_id,
                phase,
                uncertain_effects,
            } => {
                task_id.as_ref().is_none_or(|id| valid_id(id))
                    && (phase.is_none() || task_id.is_some())
                    && uncertain_effects.len() <= 65536
                    && uncertain_effects
                        .iter()
                        .all(|key| !key.is_empty() && key.len() <= 4096)
            }
        };
        let valid = valid
            && match self {
                Self::Progress { task_id, .. } => valid_id(task_id),
                Self::Result {
                    conversation_id,
                    task_id,
                    phase,
                    ..
                } => valid_id(conversation_id) && valid_id(task_id) && phase.terminal(),
                _ => true,
            };
        if !valid {
            anyhow::bail!("invalid collaboration message payload");
        }
        Ok(())
    }
    pub fn reply(&self) -> bool {
        !matches!(self, Self::Requested { .. } | Self::CancelRequested { .. })
    }
}
fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id)
}
