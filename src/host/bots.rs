//! Bot definition values only. Persistence, activation and Work admission are
//! Host responsibilities; validating a definition never grants a capability.
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_DEFINITION_BYTES: usize = 65_536;
const MAX_REFS: usize = 32;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RevisionRef {
    pub namespace: String,
    pub id: String,
    pub revision: u64,
    pub digest: String,
}

impl RevisionRef {
    pub fn validate(&self) -> Result<()> {
        label(&self.namespace, 128)?;
        label(&self.id, 256)?;
        ensure!(self.revision > 0, "reference revision must be positive");
        digest(&self.digest)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DefinitionContent {
    pub purpose: String,
    pub input_contract: Value,
    pub output_contract: Value,
    pub instruction_ref: RevisionRef,
    pub skill_refs: Vec<RevisionRef>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub skill_aliases: BTreeMap<String, RevisionRef>,
    pub acceptance_policy_ref: RevisionRef,
    pub required_capabilities: Vec<String>,
    pub memory_profile_ref: Option<RevisionRef>,
    pub execution_profile_ref: RevisionRef,
}

impl DefinitionContent {
    pub fn validate(&self) -> Result<()> {
        label(&self.purpose, 4096)?;
        ensure!(
            self.input_contract.is_object() && self.output_contract.is_object(),
            "input and output contracts must be objects"
        );
        self.instruction_ref.validate()?;
        self.acceptance_policy_ref.validate()?;
        self.execution_profile_ref.validate()?;
        if let Some(reference) = &self.memory_profile_ref {
            reference.validate()?;
        }
        ensure!(
            self.skill_refs.len() <= MAX_REFS,
            "too many skill references"
        );
        let mut names = BTreeSet::new();
        for reference in &self.skill_refs {
            reference.validate()?;
            ensure!(
                names.insert((&reference.namespace, &reference.id)),
                "duplicate or conflicting skill reference"
            );
        }
        let mut aliased = BTreeSet::new();
        for (alias, reference) in &self.skill_aliases {
            ensure!(!alias.is_empty() && alias.len()<=64 && alias.bytes().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||c==b'-'||c==b'_'), "invalid explicit skill alias");
            ensure!(self.skill_refs.contains(reference) && (reference.namespace=="common" || reference.namespace.starts_with("project:")), "skill alias must bind an exact selected shared reference");
            ensure!(aliased.insert((&reference.namespace,&reference.id)),"shared skill has multiple aliases");
        }
        ensure!(
            self.required_capabilities.len() <= MAX_REFS,
            "too many required capabilities"
        );
        let mut capabilities = BTreeSet::new();
        for capability in &self.required_capabilities {
            label(capability, 128)?;
            ensure!(
                capabilities.insert(capability),
                "duplicate required capability"
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BotDefinition {
    pub ghost_id: String,
    pub revision: u64,
    pub digest: String,
    pub content: DefinitionContent,
}

impl BotDefinition {
    pub fn new(ghost_id: String, revision: u64, content: DefinitionContent) -> Result<Self> {
        let mut definition = Self {
            ghost_id,
            revision,
            digest: String::new(),
            content,
        };
        definition.digest = definition.expected_digest()?;
        definition.validate()?;
        Ok(definition)
    }

    fn expected_digest(&self) -> Result<String> {
        let payload =
            json!({"ghost_id":self.ghost_id,"revision":self.revision,"content":self.content});
        ensure!(
            serde_json::to_vec(&payload)?.len() <= MAX_DEFINITION_BYTES,
            "bot definition exceeds its size limit"
        );
        crate::lifetime_contract::canonical_digest(&payload)
    }

    /// Checks serialized values again at every trusted read boundary.
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !uuid::Uuid::parse_str(&self.ghost_id)?.is_nil(),
            "Ghost identity must not be nil"
        );
        ensure!(self.revision > 0, "definition revision must be positive");
        self.content.validate()?;
        digest(&self.digest)?;
        ensure!(
            self.digest == self.expected_digest()?,
            "definition digest mismatch"
        );
        Ok(())
    }

    /// A successor updates the same identity. Cloning requires another Host
    /// operation and must not copy a definition as proof of resource access.
    pub fn validate_successor(&self, previous: &Self) -> Result<()> {
        previous.validate()?;
        self.validate()?;
        ensure!(
            self.ghost_id == previous.ghost_id,
            "definition update changes Ghost identity"
        );
        ensure!(
            previous.revision.checked_add(1) == Some(self.revision),
            "definition update must advance exactly one revision"
        );
        Ok(())
    }
}

fn label(value: &str, maximum: usize) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.len() <= maximum && !value.contains('\0'),
        "definition field is empty, oversized or contains NUL"
    );
    Ok(())
}

fn digest(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "digest must be a lowercase SHA-256 value"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const GHOST: &str = "01930000-0000-7000-8000-000000000001";

    fn reference(id: &str) -> RevisionRef {
        RevisionRef {
            namespace: "owner".into(),
            id: id.into(),
            revision: 1,
            digest: "a".repeat(64),
        }
    }
    fn content() -> DefinitionContent {
        DefinitionContent {
            purpose: "Compare supplied products".into(),
            input_contract: json!({"type":"object"}),
            output_contract: json!({"type":"object"}),
            instruction_ref: reference("instructions"),
            skill_refs: vec![reference("compare")],
                skill_aliases: Default::default(),
            acceptance_policy_ref: reference("independent-review"),
            required_capabilities: vec!["read".into()],
            memory_profile_ref: None,
            execution_profile_ref: reference("isolated"),
        }
    }
    #[test]
    fn definition_roundtrip_binds_identity_revision_and_content() {
        let original = BotDefinition::new(GHOST.into(), 1, content()).unwrap();
        assert_eq!(
            original.digest,
            "7659bceaa882988da22775846121fe9f10e97658a62c65bca4161dca4858997e"
        );
        let restored: BotDefinition =
            serde_json::from_slice(&serde_json::to_vec(&original).unwrap()).unwrap();
        restored.validate().unwrap();
        assert_eq!(restored, original);
        for field in ["ghost", "revision", "content"] {
            let mut changed = original.clone();
            match field {
                "ghost" => changed.ghost_id = uuid::Uuid::now_v7().to_string(),
                "revision" => changed.revision = 2,
                _ => changed.content.purpose.push('!'),
            }
            assert!(changed.validate().is_err());
        }
    }
    #[test]
    fn update_keeps_identity_and_advances_one_revision() {
        let first = BotDefinition::new(GHOST.into(), 1, content()).unwrap();
        let second = BotDefinition::new(GHOST.into(), 2, content()).unwrap();
        second.validate_successor(&first).unwrap();
        assert!(first.validate_successor(&first).is_err());
        assert!(BotDefinition::new(GHOST.into(), 3, content())
            .unwrap()
            .validate_successor(&first)
            .is_err());
        assert!(
            BotDefinition::new(uuid::Uuid::now_v7().to_string(), 2, content())
                .unwrap()
                .validate_successor(&first)
                .is_err()
        );
    }
    #[test]
    fn conflicting_refs_and_unbounded_contracts_are_rejected() {
        let mut invalid = content();
        invalid.skill_refs.push(reference("compare"));
        assert!(BotDefinition::new(GHOST.into(), 1, invalid).is_err());
        let mut invalid = content();
        invalid.execution_profile_ref.revision = 0;
        assert!(BotDefinition::new(GHOST.into(), 1, invalid).is_err());
        let mut invalid = content();
        invalid.input_contract = json!({"description":"x".repeat(MAX_DEFINITION_BYTES)});
        assert!(BotDefinition::new(GHOST.into(), 1, invalid).is_err());
        assert!(BotDefinition::new(GHOST.into(), 0, content()).is_err());
    }
}
