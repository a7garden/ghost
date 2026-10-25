//! Optional Host-owned multi-space policy. Secrets are resolved only into a
//! fresh caller-owned engine session and never serialized or logged.
use super::*;
use crate::adapters::memory_bindings::MemoryCapability;
use serde::de::{Error, MapAccess, Visitor};
use std::collections::BTreeSet;

const MAX_BINDINGS: usize = 8;
const MAX_SPACES: usize = 8;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Configuration {
    version: u64,
    #[serde(deserialize_with = "unique_map")]
    owners: BTreeMap<String, Vec<Binding>>,
    #[serde(deserialize_with = "unique_map")]
    grants: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Binding {
    pub id: String,
    grant_ref: String,
    pub kind: BindingKind,
    pub spaces: Vec<String>,
    pub capabilities: BTreeSet<MemoryCapability>,
    pub policy_revision: u64,
}
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum BindingKind {
    Own,
    Shared,
}

// Deliberately not Debug or Serialize: this contains a credential.
pub(super) struct ScopeSnapshot {
    pub bindings: Vec<Binding>,
    secrets: BTreeMap<String, String>,
    pub revision: String,
}

pub(super) fn enabled() -> bool {
    std::env::var_os("GHOST_BRAIN_BINDINGS").is_some()
}

fn unique_map<'de, D, V>(deserializer: D) -> std::result::Result<BTreeMap<String, V>, D::Error>
where
    D: serde::Deserializer<'de>,
    V: Deserialize<'de>,
{
    struct Unique<V>(std::marker::PhantomData<V>);
    impl<'de, V: Deserialize<'de>> Visitor<'de> for Unique<V> {
        type Value = BTreeMap<String, V>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("unique string keys")
        }
        fn visit_map<A: MapAccess<'de>>(
            self,
            mut access: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut values = BTreeMap::new();
            while let Some((key, value)) = access.next_entry::<String, V>()? {
                if values.insert(key, value).is_some() {
                    return Err(A::Error::custom("duplicate memory policy key"));
                }
            }
            Ok(values)
        }
    }
    deserializer.deserialize_map(Unique(std::marker::PhantomData))
}

fn safe_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.".contains(&byte))
}
fn safe_env(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.starts_with("GHOST_BRAIN_")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

pub(super) fn snapshot(owner: &str) -> Result<Option<ScopeSnapshot>> {
    use sha2::{Digest, Sha256};
    let Some(path) = std::env::var_os("GHOST_BRAIN_BINDINGS") else {
        return Ok(None);
    };
    let path = Path::new(&path);
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 65_536,
        "memory bindings must be a small regular file"
    );
    let configuration: Configuration = serde_json::from_slice(&fs::read(path)?)
        .map_err(|_| anyhow!("memory binding configuration is invalid"))?;
    ensure!(
        configuration.version == 1
            && configuration.owners.len() <= 1024
            && configuration.grants.len() <= 64,
        "memory binding configuration version or bounds are invalid"
    );
    let bindings = configuration.owners.get(owner).cloned().unwrap_or_default();
    ensure!(bindings.len() <= MAX_BINDINGS, "too many memory bindings");
    let own_space = Brain::space_for_owner(owner)?;
    let mut ids = BTreeSet::new();
    let mut spaces = BTreeSet::new();
    let mut secrets = BTreeMap::new();
    let mut roles = BTreeMap::new();
    for binding in &bindings {
        ensure!(
            safe_ref(&binding.id)
                && safe_ref(&binding.grant_ref)
                && ids.insert(&binding.id)
                && binding.policy_revision > 0
                && !binding.spaces.is_empty()
                && binding.spaces.len() <= MAX_SPACES,
            "memory binding identity or bounds are invalid"
        );
        ensure!(
            !binding.capabilities.is_empty()
                && binding.capabilities.contains(&MemoryCapability::Read),
            "memory bindings require explicit read capability"
        );
        if binding.kind == BindingKind::Shared {
            ensure!(
                binding.capabilities == BTreeSet::from([MemoryCapability::Read]),
                "shared memory binding must be read-only"
            );
        } else {
            ensure!(
                binding.spaces.len() == 1 && own_space.as_ref() == binding.spaces.first(),
                "own memory binding must preserve the scalar mapped write destination"
            );
        }
        let mut local = BTreeSet::new();
        for space in &binding.spaces {
            ensure!(
                !space.is_empty()
                    && space.len() <= 80
                    && space
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
                    && local.insert(space),
                "memory binding space is invalid or repeated"
            );
            ensure!(
                spaces.insert(space.clone()),
                "memory space has ambiguous bindings"
            );
        }
        let token_env = configuration
            .grants
            .get(&binding.grant_ref)
            .filter(|value| safe_env(value))
            .ok_or_else(|| anyhow!("memory binding grant reference is unavailable"))?;
        let secret = std::env::var(token_env)
            .map_err(|_| anyhow!("memory binding credential is unavailable"))?;
        ensure!(
            !secret.is_empty(),
            "memory binding credential is unavailable"
        );
        let secret_hash = format!("{:x}", Sha256::digest(secret.as_bytes()));
        if let Some(previous) = roles.insert(secret_hash, binding.kind) {
            ensure!(
                previous == binding.kind,
                "shared read and own contribution require distinct credentials"
            );
        }
        secrets.insert(binding.grant_ref.clone(), secret);
    }
    ensure!(spaces.len() <= MAX_SPACES, "too many memory spaces");
    // Endpoint and token changes fence in-flight data, without exposing secret
    // material or a token's individual hash to callers.
    let secret_digests: BTreeMap<_, _> = secrets
        .iter()
        .map(|(id, secret)| (id, format!("{:x}", Sha256::digest(secret.as_bytes()))))
        .collect();
    let revision = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(
            &json!({"owner":owner,"bindings":bindings,
        "secret_digests":secret_digests,"own_space":own_space,
        "executable":std::env::var_os("GHOST_BRAIN_EXECUTABLE").map(|value|value.to_string_lossy().into_owned()),
        "directory":std::env::var_os("GHOST_BRAIN_DIR").map(|value|value.to_string_lossy().into_owned())})
        )?)
    );
    Ok(Some(ScopeSnapshot {
        bindings,
        secrets,
        revision,
    }))
}

impl ScopeSnapshot {
    pub fn restrict_shared(mut self, ids: &[String]) -> Result<Self> {
        let selected: BTreeSet<_> = ids.iter().collect();
        ensure!(
            !ids.is_empty() && ids.len() <= MAX_BINDINGS && selected.len() == ids.len(),
            "Work memory binding selection is empty, repeated or oversized"
        );
        self.bindings
            .retain(|binding| selected.contains(&binding.id));
        ensure!(
            self.bindings.len() == ids.len()
                && self
                    .bindings
                    .iter()
                    .all(|binding| binding.kind == BindingKind::Shared),
            "Work memory may select only explicitly granted shared read bindings"
        );
        Ok(self)
    }

    pub fn work_profile(&self) -> crate::adapters::memory_bindings::WorkMemoryProfile {
        crate::adapters::memory_bindings::WorkMemoryProfile {
            configuration_revision: self.revision.clone(),
            bindings: self
                .bindings
                .iter()
                .map(
                    |binding| crate::adapters::memory_bindings::SharedMemoryBinding {
                        id: binding.id.clone(),
                        spaces: binding.spaces.clone(),
                        policy_revision: binding.policy_revision,
                    },
                )
                .collect(),
        }
    }
    pub fn check(
        &self,
        owner: &str,
        check: &(impl Fn() -> Result<()> + Send + Sync),
    ) -> Result<()> {
        check()?;
        ensure!(
            snapshot(owner)?.is_some_and(|current| current.revision == self.revision),
            "memory binding authority changed during I/O"
        );
        Ok(())
    }

    pub fn source(&self, required: &[MemoryCapability]) -> Result<Option<&Binding>> {
        let candidates: Vec<_> = self
            .bindings
            .iter()
            .filter(|binding| {
                binding.kind == BindingKind::Own
                    && required
                        .iter()
                        .all(|cap| binding.capabilities.contains(cap))
            })
            .collect();
        ensure!(
            candidates.len() <= 1,
            "own source memory grant is ambiguous"
        );
        Ok(candidates.first().copied())
    }

    pub async fn connect(
        &self,
        binding: &Binding,
        owner: &str,
        check: &(impl Fn() -> Result<()> + Send + Sync),
    ) -> Result<BrainClient> {self.connect_mode(binding,owner,check,false).await}
    pub async fn connect_without_models(&self,binding:&Binding,owner:&str,check:&(impl Fn()->Result<()>+Send+Sync))->Result<BrainClient> {self.connect_mode(binding,owner,check,true).await}
    async fn connect_mode(&self,binding:&Binding,owner:&str,check:&(impl Fn()->Result<()>+Send+Sync),without_models:bool)->Result<BrainClient> {
        self.check(owner, check)?;
        let executable = std::env::var_os("GHOST_BRAIN_EXECUTABLE")
            .ok_or_else(|| anyhow!("brain executable is not configured"))?;
        let directory = std::env::var_os("GHOST_BRAIN_DIR")
            .ok_or_else(|| anyhow!("brain directory is not configured"))?;
        let endpoint=LocalProcessEndpoint::new(executable,directory);
        let mut client=if without_models {BrainClient::spawn_local_without_models(endpoint).await?}else{BrainClient::spawn_local(endpoint).await?};
        let secret = self
            .secrets
            .get(&binding.grant_ref)
            .ok_or_else(|| anyhow!("memory grant unavailable"))?;
        client
            .bring_up(
                Some(secret),
                oxibrain_client::default_client_hello(env!("CARGO_PKG_VERSION")),
            )
            .await
            .map_err(|_| anyhow!("scoped memory authentication failed"))?;
        self.check(owner, check)?;
        let authenticated = client.authenticated_scope().ok_or_else(|| {
            anyhow!("engine did not provide complete authenticated scope metadata")
        })?;
        let caps = authenticated
            .get("caps")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("authenticated scope capability metadata is malformed"))?;
        let actual_caps: BTreeSet<_> = caps
            .iter()
            .map(|cap| {
                cap.as_str()
                    .ok_or_else(|| anyhow!("authenticated scope capability metadata is malformed"))
            })
            .collect::<Result<_>>()?;
        let expected_caps: BTreeSet<_> = binding
            .capabilities
            .iter()
            .map(|cap| match cap {
                MemoryCapability::Read => "read",
                MemoryCapability::Ingest => "ingest",
                MemoryCapability::Redact => "redact",
            })
            .collect();
        ensure!(
            actual_caps == expected_caps,
            "engine token capability set does not match configured binding"
        );
        let visible = client
            .list_spaces()
            .await
            .map_err(|_| anyhow!("scoped memory space verification unavailable"))?;
        self.check(owner, check)?;
        ensure!(
            binding.spaces.iter().all(|space| visible
                .iter()
                .any(|candidate| &candidate.name == space || &candidate.id == space)),
            "configured memory space is unavailable to scoped session"
        );
        ensure!(
            visible.len() == binding.spaces.len(),
            "memory token grants unconfigured spaces"
        );
        let authenticated = client
            .authenticated_scope()
            .ok_or_else(|| anyhow!("authenticated scope metadata unavailable"))?;
        let scope_spaces: BTreeSet<_> = authenticated
            .get("spaces")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("authenticated scope space metadata is malformed"))?
            .iter()
            .map(|space| {
                space
                    .as_str()
                    .ok_or_else(|| anyhow!("authenticated scope space metadata is malformed"))
            })
            .collect::<Result<_>>()?;
        let visible_ids: BTreeSet<_> = visible.iter().map(|space| space.id.as_str()).collect();
        ensure!(
            scope_spaces == visible_ids,
            "authenticated token membership differs from visible spaces"
        );
        // Reject overbroad engine tokens rather than relying only on prompt or
        // client-side routing to keep shared sessions read-only.
        let tools = client.call_rpc_json("tools/list", json!({})).await?;
        self.check(owner, check)?;
        let tools = tools
            .get("tools")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("scoped tools response malformed"))?;
        let names: BTreeSet<_> = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect();
        for tool in ["declare", "remember", "retract", "merge_entities"] {
            ensure!(
                !names.contains(tool),
                "memory token grants unsupported write capability"
            );
        }
        if !binding.capabilities.contains(&MemoryCapability::Ingest) {
            ensure!(
                !names.contains("ingest") && !names.contains("session_record"),
                "read-only memory token grants ingest capability"
            );
        }
        if !binding.capabilities.contains(&MemoryCapability::Redact) {
            ensure!(
                !names.contains("redact"),
                "memory token grants unconfigured redact capability"
            );
        }
        Ok(client)
    }
}
