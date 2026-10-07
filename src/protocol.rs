//! Internal versioned delegation protocol (v1). This is a small local
//! correlation/lineage format for the Ghosts coordinator. It is explicitly
//! NOT A2A compliant and grants no capabilities: the only permitted
//! capability ceiling is text. Model output text is untrusted content and is
//! never used as metadata, identity, or capability evidence.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MEDIA_TYPE_TEXT: &str = "text/plain";

/// Immutable v1 delegation envelope. One per worker assignment.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct DelegationEnvelope {
    pub version: u32,
    pub workflow_id: String,
    pub root_task_id: String,
    /// Root of this one-level tree: the parent task itself.
    pub parent_task_id: String,
    pub delegation_id: String,
    /// Sender ghost UUID (the authenticated-by-store parent owner).
    pub sender_uuid: String,
    /// Recipient ghost UUID (the authenticated-by-store worker).
    pub recipient_uuid: String,
    /// Stable message id unique per sender.
    pub message_id: String,
    /// Role is context, never permission.
    pub role: String,
    /// Capability ceiling: must be exactly `["text"]`.
    pub capability_ceiling: Vec<String>,
    pub objective: String,
    pub task_prompt: String,
}

/// The only ceiling accepted by v1. Anything broader (file, write, http,
/// shell, mcp, financial, ...) is rejected before enqueue/execute.
pub fn text_only_ceiling() -> Vec<String> {
    vec!["text".to_string()]
}

/// Structural validation: version, nonempty correlation/lineage/identity
/// fields, and an exactly-text capability ceiling.
pub fn validate(e: &DelegationEnvelope) -> Result<()> {
    if e.version != PROTOCOL_VERSION {
        bail!("unsupported delegation protocol version {}", e.version);
    }
    let fields = [
        ("workflow_id", &e.workflow_id),
        ("root_task_id", &e.root_task_id),
        ("parent_task_id", &e.parent_task_id),
        ("delegation_id", &e.delegation_id),
        ("sender_uuid", &e.sender_uuid),
        ("recipient_uuid", &e.recipient_uuid),
        ("message_id", &e.message_id),
        ("role", &e.role),
        ("objective", &e.objective),
        ("task_prompt", &e.task_prompt),
    ];
    for (name, v) in &fields {
        if v.trim().is_empty() {
            bail!("envelope field '{}' must not be empty", name);
        }
    }
    if e.capability_ceiling != text_only_ceiling() {
        bail!("capability ceiling must be exactly [\"text\"]; broader capabilities are rejected");
    }
    Ok(())
}

/// Structured artifact metadata produced from a validated worker result.
/// `content` is untrusted model output; identity and lineage fields come from
/// host-validated durable state, never from model text.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Artifact {
    pub workflow_id: String,
    pub root_task_id: String,
    pub delegation_id: String,
    pub task_uuid: String,
    pub profile_uuid: String,
    pub role: String,
    pub media_type: String,
    pub content: String,
    pub sha256: String,
    pub provenance: String,
}

pub fn sha256_hex(content: &str) -> String {
    let d = Sha256::digest(content.as_bytes());
    d.iter().map(|b| format!("{:02x}", b)).collect()
}

#[allow(clippy::too_many_arguments)] // Fixed protocol fields are explicit at the call site.
pub fn make_artifact(
    workflow_id: &str,
    root_task_id: &str,
    delegation_id: &str,
    task_uuid: &str,
    profile_uuid: &str,
    role: &str,
    content: &str,
    provenance: &str,
) -> Artifact {
    Artifact {
        workflow_id: workflow_id.to_string(),
        root_task_id: root_task_id.to_string(),
        delegation_id: delegation_id.to_string(),
        task_uuid: task_uuid.to_string(),
        profile_uuid: profile_uuid.to_string(),
        role: role.to_string(),
        media_type: MEDIA_TYPE_TEXT.to_string(),
        content: content.to_string(),
        sha256: sha256_hex(content),
        provenance: provenance.to_string(),
    }
}
