//! Pure compatibility resolution for the existing owner-to-space map. The
//! Host supplies authenticated grants; this module opens no transport and
//! neither discovers spaces nor grants access to one.
use anyhow::{ensure, Result};
use serde::{
    de::{Error, MapAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use std::collections::{BTreeMap, BTreeSet};

const MAX_MAP_BYTES: usize = 65_536;
const MAX_OWNERS: usize = 1024;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum MemoryCapability {
    Read,
    Ingest,
    Redact,
}

/// A Host-resolved grant snapshot, not a credential and not a model input.
/// The Host must revalidate this policy revision before and after engine I/O.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostGrant {
    pub grant_ref: String,
    /// Canonical space names verified by Host read-only discovery, not raw
    /// token space IDs or names supplied by a model.
    pub spaces: BTreeSet<String>,
    pub capabilities: BTreeSet<MemoryCapability>,
    pub policy_revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MemoryBinding {
    pub owner: String,
    pub grant_ref: String,
    pub spaces: BTreeSet<String>,
    pub capabilities: BTreeSet<MemoryCapability>,
    pub policy_revision: u64,
}

/// Immutable metadata pin for explicit Work read access. Credentials and Own
/// bindings are deliberately absent from this transport-independent value.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkMemoryProfile {
    pub configuration_revision: String,
    pub bindings: Vec<SharedMemoryBinding>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SharedMemoryBinding {
    pub id: String,
    pub spaces: Vec<String>,
    pub policy_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacySpaceMap(BTreeMap<String, String>);

impl LegacySpaceMap {
    pub fn mapped_space(&self, owner: &str) -> Option<&str> {
        self.0.get(owner).map(String::as_str)
    }

    pub fn parse(bytes: &[u8]) -> Result<Self> {
        ensure!(
            bytes.len() <= MAX_MAP_BYTES,
            "brain space map exceeds its size limit"
        );
        let map: Self = serde_json::from_slice(bytes)?;
        ensure!(map.0.len() <= MAX_OWNERS, "too many brain space mappings");
        for (owner, space) in &map.0 {
            valid_ref(owner)?;
            valid_space(space)?;
        }
        Ok(map)
    }

    /// Preserves the mapped space exactly. Requesting fewer capabilities can
    /// narrow an existing grant; it cannot manufacture a missing capability.
    pub fn resolve(
        &self,
        owner: &str,
        grant: &HostGrant,
        requested: &BTreeSet<MemoryCapability>,
    ) -> Result<Option<MemoryBinding>> {
        valid_ref(owner)?;
        valid_ref(&grant.grant_ref)?;
        ensure!(
            grant.policy_revision > 0,
            "memory policy revision must be positive"
        );
        ensure!(
            !requested.is_empty(),
            "memory binding requires a capability"
        );
        ensure!(
            requested.is_subset(&grant.capabilities),
            "memory capability is not granted"
        );
        let Some(space) = self.0.get(owner) else {
            return Ok(None);
        };
        ensure!(
            grant.spaces.contains(space),
            "mapped memory space is not granted"
        );
        Ok(Some(MemoryBinding {
            owner: owner.into(),
            grant_ref: grant.grant_ref.clone(),
            spaces: BTreeSet::from([space.clone()]),
            capabilities: requested.clone(),
            policy_revision: grant.policy_revision,
        }))
    }
}

// A normal BTreeMap deserialize silently accepts repeated keys. A repeated
// owner must be an explicit configuration error instead of a hidden override.
impl<'de> Deserialize<'de> for LegacySpaceMap {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct UniqueMap;
        impl<'de> Visitor<'de> for UniqueMap {
            type Value = LegacySpaceMap;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("an owner-to-space object with unique string keys and values")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut access: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = BTreeMap::new();
                while let Some((owner, space)) = access.next_entry::<String, String>()? {
                    if values.len() >= MAX_OWNERS {
                        return Err(A::Error::custom("too many brain space mappings"));
                    }
                    valid_ref(&owner).map_err(A::Error::custom)?;
                    valid_space(&space).map_err(A::Error::custom)?;
                    if values.insert(owner, space).is_some() {
                        return Err(A::Error::custom("duplicate brain owner mapping"));
                    }
                }
                Ok(LegacySpaceMap(values))
            }
        }
        deserializer.deserialize_map(UniqueMap)
    }
}

fn valid_ref(value: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.len() <= 512 && !value.contains('\0'),
        "memory owner or grant reference is invalid"
    );
    Ok(())
}
fn valid_space(value: &str) -> Result<()> {
    // Same grammar as Brain::space_for_owner; no normalization or aliases.
    ensure!(
        !value.is_empty()
            && value.len() <= 80
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)),
        "configured brain space name is invalid"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn caps(values: &[MemoryCapability]) -> BTreeSet<MemoryCapability> {
        values.iter().copied().collect()
    }
    fn grant(id: &str, space: &str, capabilities: &[MemoryCapability]) -> HostGrant {
        HostGrant {
            grant_ref: id.into(),
            spaces: BTreeSet::from([space.into()]),
            capabilities: caps(capabilities),
            policy_revision: 7,
        }
    }
    #[test]
    fn scalar_fixture_resolves_only_the_original_owner_space() {
        let map = LegacySpaceMap::parse(
            br#"{"01930000-0000-7000-8000-000000000001":"private_one","legacy":"personal"}"#,
        )
        .unwrap();
        let grant = grant(
            "own",
            "private_one",
            &[MemoryCapability::Read, MemoryCapability::Ingest],
        );
        let binding = map
            .resolve(
                "01930000-0000-7000-8000-000000000001",
                &grant,
                &caps(&[MemoryCapability::Read]),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(&binding).unwrap(),
            serde_json::json!({
            "owner":"01930000-0000-7000-8000-000000000001","grant_ref":"own",
            "spaces":["private_one"],"capabilities":["read"],"policy_revision":7})
        );
        assert!(map
            .resolve("missing", &grant, &caps(&[MemoryCapability::Read]))
            .unwrap()
            .is_none());
        assert!(map
            .resolve("legacy", &grant, &caps(&[MemoryCapability::Read]))
            .is_err());
    }
    #[test]
    fn read_grant_never_becomes_write_and_sessions_remain_separate() {
        let map = LegacySpaceMap::parse(br#"{"reader":"common","writer":"own"}"#).unwrap();
        let read = grant("shared-read", "common", &[MemoryCapability::Read]);
        let write = grant(
            "own-contribution",
            "own",
            &[MemoryCapability::Read, MemoryCapability::Ingest],
        );
        assert!(map
            .resolve("reader", &read, &caps(&[MemoryCapability::Ingest]))
            .is_err());
        assert!(map
            .resolve("writer", &read, &caps(&[MemoryCapability::Read]))
            .is_err());
        let own = map
            .resolve("writer", &write, &caps(&[MemoryCapability::Ingest]))
            .unwrap()
            .unwrap();
        let shared = map
            .resolve("reader", &read, &caps(&[MemoryCapability::Read]))
            .unwrap()
            .unwrap();
        assert_ne!(own.grant_ref, shared.grant_ref);
        assert!(!shared.capabilities.contains(&MemoryCapability::Ingest));
        assert!(!own.spaces.contains("common"));
    }
    #[test]
    fn duplicate_malformed_and_oversized_maps_fail_closed() {
        for bytes in [
            br#"{"owner":"one","owner":"two"}"#.as_slice(),
            br#"{"owner":{"spaces":["one"]}}"#,
            br#"{"owner":"../one"}"#,
            br#"{"owner":""}"#,
            br#"{"":"one"}"#,
        ] {
            assert!(LegacySpaceMap::parse(bytes).is_err());
        }
        assert!(LegacySpaceMap::parse(&vec![b' '; MAX_MAP_BYTES + 1]).is_err());
    }
    #[test]
    fn requested_scope_cannot_infer_project_or_common() {
        let map = LegacySpaceMap::parse(br#"{"owner":"own"}"#).unwrap();
        let mut broad = grant(
            "existing",
            "own",
            &[MemoryCapability::Read, MemoryCapability::Ingest],
        );
        broad.spaces.extend(["project".into(), "common".into()]);
        let binding = map
            .resolve("owner", &broad, &caps(&[MemoryCapability::Read]))
            .unwrap()
            .unwrap();
        assert_eq!(binding.spaces, BTreeSet::from(["own".into()]));
        assert_eq!(binding.capabilities, caps(&[MemoryCapability::Read]));
        broad.policy_revision = 0;
        assert!(map
            .resolve("owner", &broad, &caps(&[MemoryCapability::Read]))
            .is_err());
    }
}
