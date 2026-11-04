//! Shared v1 wire types. The JSON schema and golden fixture are the cross-language authority.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const VERSION: &str = "ghost-lifetime/1";
pub const REVISION: u64 = 1;
pub const MIGRATION: u64 = 5;
pub const SCHEMA: &str = include_str!("../contracts/lifetime/schema.json");
pub const GOLDEN: &str = include_str!("../contracts/lifetime/golden.json");

/// Sorted object keys, no whitespace, UTF-8, integer revisions; no floating-point payloads.
pub fn canonical_digest(value: &Value) -> anyhow::Result<String> {
    fn check(value: &Value) -> anyhow::Result<()> {
        match value {
            Value::Number(n) if !n.is_i64() && !n.is_u64() => anyhow::bail!("floating-point payloads are unsupported"),
            Value::Array(items) => { for item in items { check(item)?; } }
            Value::Object(items) => { for item in items.values() { check(item)?; } }
            _ => {}
        }
        Ok(())
    }
    check(value)?;
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub protocol_version: String,
    pub command_id: String,
    pub payload_digest: String,
    pub actor_ref: String,
    pub authority_epoch: u64,
    pub expected_revision: Option<u64>,
    pub correlation_id: String,
    pub body: Value,
}
impl Envelope {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(self.protocol_version == VERSION, "unsupported_version");
        anyhow::ensure!(self.authority_epoch > 0, "invalid authority epoch");
        anyhow::ensure!(!self.command_id.is_empty() && self.command_id.len() <= 400, "invalid command ID");
        anyhow::ensure!(!self.actor_ref.is_empty() && !self.correlation_id.is_empty(), "invalid principal or correlation");
        anyhow::ensure!(self.expected_revision != Some(0), "invalid revision");
        anyhow::ensure!(self.payload_digest == canonical_digest(&self.body)?, "payload digest mismatch");
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RetryClass { SameId, ReconcileFirst, NewRevision, Never }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ResponseStatus { Success, Warning, Error }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub status: ResponseStatus,
    pub summary: String,
    pub object_refs: Vec<String>,
    pub artifacts: Vec<Artifact>,
    pub next_actions: Vec<String>,
    pub error_code: Option<String>,
    pub retry_class: RetryClass,
    pub data: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub digest: String,
    pub locator: String,
    pub privacy: String,
    pub producing_attempt: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Goal {
    pub id: String,
    pub revision: u64,
    pub requirement_digest: String,
    pub prompt: String,
    pub accountable_ghost: String,
    pub reply_conversation: String,
    pub privacy: String,
    pub state: String,
    pub acceptance_spec: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Work {
    pub id: String,
    pub goal_id: String,
    pub goal_revision: u64,
    pub owner: String,
    pub owner_revision: u64,
    pub state: String,
    pub execution_id: Option<String>,
    pub cancellation: String,
    pub blocker: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RuntimeBinding {
    pub conversation_id: String,
    pub ghost_id: String,
    pub runtime_kind: String,
    pub runtime_release: String,
    pub storage_ref: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WorkerSkillRef {
    pub name: String,
    pub sha256: String,
    pub privacy: String,
}
/// Host-derived per-child metadata record binding a current direct child work's
/// result artifact references. Metadata only: never raw outputs, file contents,
/// or byte lengths. A record exists only when at least one artifact reference is
/// visible to the parent route; if every reference is withheld, the record is
/// omitted entirely (never an invented placeholder Artifact).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WorkerArtifactInput {
    pub work_id: String,
    pub goal_id: String,
    pub goal_revision: u64,
    pub execution_id: String,
    pub state: String,
    pub artifacts: Vec<Artifact>,
    pub protected_artifacts_withheld: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WorkerSpec {
    pub execution_id: String,
    pub work_id: String,
    pub work_revision: u64,
    pub authority_epoch: u64,
    pub computer_id: String,
    pub cwd: String,
    pub prompt: String,
    pub model: String,
    pub thinking: String,
    pub allowed_tools: Vec<String>,
    pub deadline_ms: u64,
    pub max_progress_bytes: u64,
    /// Host-derived pinned skill refs from the authenticated Ghost skill store.
    /// Absent keeps historical specs byte-equivalent; never caller-authored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<WorkerSkillRef>>,
    /// Host-derived OPTIONAL metadata-only snapshot of current direct-child
    /// result artifact references (see WorkerArtifactInput). Absent keeps
    /// historical specs byte-equivalent; admission and acceptance revalidate the
    /// entire snapshot against the current authoritative graph. Never
    /// caller-authored; never raw outputs or byte lengths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_artifacts: Option<Vec<WorkerArtifactInput>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Acceptance {
    pub work_id: String,
    pub goal_revision: u64,
    pub requirement_digest: String,
    pub artifact_digest: String,
    pub verifier_revision: String,
    pub policy_revision: u64,
    pub checks: Vec<Check>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Check { pub id: String, pub passed: bool, pub evidence: String }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ComputerBinding {
    pub computer_id: String,
    pub ghost_id: String,
    pub backend: String,
    pub host_id: String,
    pub epoch: u64,
    pub capabilities: Vec<String>,
    pub accepted_capabilities: Vec<String>,
    pub grant_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub protocol_version: String,
    pub contract_revision: u64,
    pub mode: String,
    pub goals: Vec<Goal>,
    pub work: Vec<Work>,
    pub bindings: Vec<RuntimeBinding>,
    pub artifacts: Vec<Artifact>,
    pub acceptances: Vec<Acceptance>,
}
