// Acceptance harness integration for the real private Owner configuration.
// This module does not select an image without an explicit genuine receipt.
use super::*;
use crate::host::lifetime::producer_profiles::OwnerAcceptedProfile;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

const CONFIG: &str = "a04-owner-pi-config.json";
const RECEIPT: &str = "a04-producer-profile.json";
const REGISTRY: &str = "a04-accepted-producer-registry";
const METADATA: &str = "a04-producer-configuration.json";
const CONSUMPTION: &str = "a04-producer-consumption.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct ConfigurationPin {
    kind: String,
    receipt_sha256: String,
    receipt_file: String,
    profile_ref: RevisionRef,
    configuration_sha256: String,
    configuration_file: String,
    registry_directory: String,
    initial_work_count: u64,
    loader: String,
    workspace_id: String,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn bounded_file(path: &Path) -> Result<Vec<u8>> {
    use std::io::Read;
    ensure!(
        path.is_absolute() && path.canonicalize()? == path,
        "A04 receipt/configuration path must be canonical and absolute"
    );
    let declared = std::fs::symlink_metadata(path)?;
    ensure!(
        declared.is_file()
            && !declared.file_type().is_symlink()
            && declared.uid() == unsafe { libc::geteuid() }
            && declared.nlink() == 1
            && declared.len() <= 65_536,
        "A04 bounded owned regular receipt/configuration required"
    );
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let before = file.metadata()?;
    ensure!(
        declared.dev() == before.dev() && declared.ino() == before.ino(),
        "A04 receipt/configuration identity changed"
    );
    let mut bytes = vec![];
    file.by_ref().take(65_537).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    ensure!(
        bytes.len() as u64 == before.len()
            && before.len() == after.len()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec(),
        "A04 receipt/configuration changed during read"
    );
    Ok(bytes)
}
fn receipt(bytes: &[u8], expected: &str) -> Result<OwnerAcceptedProfile> {
    ensure!(
        bytes.len() <= 65_536 && sha256(expected) && digest(bytes) == expected,
        "A04 accepted profile receipt byte digest mismatch"
    );
    let profile: OwnerAcceptedProfile = serde_json::from_slice(bytes)?;
    ensure!(
        profile.runtime_facts.evidence == "owned_container_probe",
        "A04 requires genuine owned-container probe evidence"
    );
    profile
        .runtime_facts
        .validate_for_profile(&profile.manifest)?;
    ensure!(
        profile.runtime_facts.sandbox_uid == unsafe { libc::geteuid() }
            && profile.runtime_facts.sandbox_gid == unsafe { libc::getegid() },
        "A04 probe belongs to another sandbox identity"
    );
    Ok(profile)
}
fn private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

pub(super) fn install_from_environment(f: &mut HostFixture) -> Result<Option<ConfigurationPin>> {
    let path = std::env::var_os("GHOST_PI_A04_PRODUCER_PROFILE_RECEIPT");
    let expected = std::env::var_os("GHOST_PI_A04_PRODUCER_PROFILE_SHA256")
        .map(|value| {
            value
                .into_string()
                .map_err(|_| anyhow!("A04 profile SHA256 must be UTF-8"))
        })
        .transpose()?;
    match (path, expected) {
        (None, None) => Ok(None),
        (Some(path), Some(expected)) => install(f, &PathBuf::from(path), &expected).map(Some),
        _ => Err(anyhow!(
            "A04 accepted profile requires both receipt path and exact SHA256"
        )),
    }
}

fn install(f: &mut HostFixture, source: &Path, expected: &str) -> Result<ConfigurationPin> {
    let bytes = bounded_file(source)?;
    let profile = receipt(&bytes, expected)?;
    let root = f.host.root.canonicalize()?;
    let registry = root.join(REGISTRY);
    ensure!(
        !registry.exists(),
        "A04 accepted profile registry must be fresh"
    );
    std::fs::create_dir(&registry)?;
    std::fs::set_permissions(&registry, std::fs::Permissions::from_mode(0o700))?;
    let profile_ref = RevisionRef {
        namespace: "host".into(),
        id: profile.manifest.profile_id.clone(),
        revision: profile.manifest.revision,
        digest: profile.manifest.digest()?,
    };
    let config = json!({"registry_root":registry,"container_cli":"/opt/homebrew/bin/container","accepted_capabilities":["persistent_filesystem","shell"],"accepted_producer_profiles":[profile],"routes":[{"ghost_id":f.ghost,"computer_id":"a04-owner-pi-primary","privacy_classes":["public"],"deadline_ms":300_000,"producer_profile_ref":profile_ref}]});
    let config_bytes = serde_json::to_vec_pretty(&config)?;
    let state = f.host.lock()?;
    let work_count: u64 =
        state
            .journal
            .0
            .query_row("SELECT COUNT(*) FROM lifetime_work", [], |r| r.get(0))?;
    ensure!(
        work_count == 0,
        "A04 producer configuration must precede every Work admission"
    );
    let workspace_id = match state.journal.get::<String>("meta", "workspace_id")? {
        Some(id) => id,
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            state.journal.put("meta", "workspace_id", &id)?;
            id
        }
    };
    private_file(&root.join(RECEIPT), &bytes)?;
    private_file(&root.join(CONFIG), &config_bytes)?;
    let computers = host::lifetime_computers::NativeComputers::from_pi_configuration(
        &state.journal,
        &state.profiles,
        1,
        &root.join(CONFIG),
    )?;
    ensure!(
        computers.pi_profile_ref(&f.ghost)? == profile_ref,
        "A04 production loader selected a different profile"
    );
    drop(state);
    f.host.native_computers = Some(computers);
    let pin = ConfigurationPin {
        kind: "ghost-a04-producer-configuration/1".into(),
        receipt_sha256: expected.into(),
        receipt_file: RECEIPT.into(),
        profile_ref,
        configuration_sha256: digest(&config_bytes),
        configuration_file: CONFIG.into(),
        registry_directory: REGISTRY.into(),
        initial_work_count: work_count,
        loader: "production-private-owner-config".into(),
        workspace_id,
    };
    private_file(&root.join(METADATA), &serde_json::to_vec_pretty(&pin)?)?;
    pin.verify(&root)?;
    capture_for_host(&f.host)?;
    Ok(pin)
}

impl ConfigurationPin {
    pub(super) fn metadata(&self) -> Value {
        serde_json::to_value(self).expect("bounded typed A04 configuration pin")
    }
    pub(super) fn verify(&self, root: &Path) -> Result<()> {
        ensure!(
            self.kind == "ghost-a04-producer-configuration/1"
                && self.receipt_file == RECEIPT
                && self.configuration_file == CONFIG
                && self.registry_directory == REGISTRY
                && self.initial_work_count == 0
                && self.loader == "production-private-owner-config",
            "A04 configuration pin identity changed"
        );
        let root = root.canonicalize()?;
        for name in [RECEIPT, CONFIG, METADATA] {
            ensure!(
                std::fs::symlink_metadata(root.join(name))?
                    .permissions()
                    .mode()
                    & 0o077
                    == 0,
                "A04 retained Owner configuration must remain private"
            );
        }
        let registry = std::fs::symlink_metadata(root.join(REGISTRY))?;
        ensure!(
            registry.is_dir()
                && !registry.file_type().is_symlink()
                && registry.uid() == unsafe { libc::geteuid() }
                && registry.permissions().mode() & 0o077 == 0,
            "A04 accepted registry privacy changed"
        );
        let bytes = bounded_file(&root.join(RECEIPT))?;
        let profile = receipt(&bytes, &self.receipt_sha256)?;
        ensure!(
            profile.manifest.digest()? == self.profile_ref.digest
                && profile.manifest.profile_id == self.profile_ref.id
                && profile.manifest.revision == self.profile_ref.revision
                && self.profile_ref.namespace == "host",
            "A04 profile reference changed"
        );
        ensure!(
            digest(&bounded_file(&root.join(CONFIG))?) == self.configuration_sha256,
            "A04 private Owner configuration bytes changed"
        );
        let stored: Self = serde_json::from_slice(&bounded_file(&root.join(METADATA))?)?;
        ensure!(
            stored == *self,
            "A04 retained configuration metadata changed"
        );
        Ok(())
    }
    pub(super) fn reload(
        &self,
        root: &Path,
        journal: &Journal,
        profiles: &BTreeMap<String, host::Profile>,
        ghost: &str,
    ) -> Result<host::lifetime_computers::NativeComputers> {
        self.verify(root)?;
        let computers = host::lifetime_computers::NativeComputers::from_pi_configuration(
            journal,
            profiles,
            1,
            &root.canonicalize()?.join(CONFIG),
        )?;
        ensure!(
            journal.get::<String>("meta", "workspace_id")?.as_deref()
                == Some(self.workspace_id.as_str()),
            "A04 workspace identity changed on cold reopen"
        );
        ensure!(
            computers.pi_profile_ref(ghost)? == self.profile_ref,
            "A04 cold reopen selected another profile"
        );
        Ok(computers)
    }
}

/// Read the actual Host-sealed context/profile lineage after committed Host
/// callbacks. This is diagnostic proof of consumption, never admission authority.
pub(super) fn capture_for_host(host: &Host) -> Result<Option<Value>> {
    let root = host.root.canonicalize()?;
    if !root.join(METADATA).exists() {
        return Ok(None);
    }
    let pin: ConfigurationPin = serde_json::from_slice(&bounded_file(&root.join(METADATA))?)?;
    pin.verify(&root)?;
    let state = host.lock()?;
    let conn = &state.journal.0;
    let mut query = conn.prepare("SELECT payload FROM lifetime_work ORDER BY id LIMIT 65")?;
    let works = query
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(
        works.len() <= 64,
        "A04 producer consumption Work bound exceeded"
    );
    let mut producers = vec![];
    for raw in works {
        let work: Work = serde_json::from_str(&raw)?;
        let profile = lifetime::work_context::producer_profile(conn, &work)?
            .ok_or_else(|| anyhow!("A04 Work did not consume its accepted producer profile"))?;
        ensure!(
            profile.manifest().profile_id == pin.profile_ref.id
                && profile.manifest().revision == pin.profile_ref.revision
                && profile.digest()? == pin.profile_ref.digest,
            "A04 Work consumed another producer profile"
        );
        let context_raw:String=conn.query_row("SELECT payload FROM workspace_objects WHERE kind='ghost_work_context_v1' AND json_extract(payload,'$.work_id')=?1 AND json_extract(payload,'$.goal_revision')=?2 AND json_extract(payload,'$.owner_revision')=?3",params![work.id,work.goal_revision,work.owner_revision],|row|row.get(0))?;
        let context: Value = serde_json::from_str(&context_raw)?;
        let profile_pin = context["producer_profile_pin"]
            .as_str()
            .ok_or_else(|| anyhow!("A04 Work lacks its required admission profile pin"))?;
        let pin_raw:String=conn.query_row("SELECT payload FROM workspace_objects WHERE kind='pi_producer_profile_pin_v1' AND id=?1",[profile_pin],|row|row.get(0))?;
        let binding: Option<String> = if let Some(execution) = work.execution_id.as_deref() {
            conn.query_row("SELECT payload FROM workspace_objects WHERE kind='pi_execution_profile_binding_v1' AND id=?1",[execution],|row|row.get(0)).optional()?
        } else {
            None
        };
        producers.push(json!({"work_id":work.id,"goal_revision":work.goal_revision,"owner_revision":work.owner_revision,"owner":work.owner,"state":work.state,"assignment_id":context["assignment_id"],"assignment_digest":context["assignment_digest"],"context_ref":context["reference"],"producer_profile_pin":profile_pin,"planned_execution_id":context["execution_id"],"execution_id":work.execution_id,"profile_ref":pin.profile_ref,"facts_receipt_digest":profile.runtime_facts().digest()?,"pin_payload_sha256":digest(pin_raw.as_bytes()),"pin_payload":serde_json::from_str::<Value>(&pin_raw)?,"execution_binding":binding.map(|raw|serde_json::from_str::<Value>(&raw)).transpose()?}));
    }
    let mut query=conn.prepare("SELECT work_id,execution_id,assignment_id,ghost_id FROM lifetime_pi_executions ORDER BY work_id LIMIT 65")?;
    let executions = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(
        executions.len() <= 64,
        "A04 producer execution bound exceeded"
    );
    for (work, execution, assignment, ghost) in &executions {
        ensure!(
            producers.iter().any(|p| p["work_id"] == *work
                && p["execution_id"] == *execution
                && p["assignment_id"] == *assignment
                && p["owner"] == *ghost
                && p["execution_binding"].is_object()),
            "A04 actual producer execution lacks matching accepted profile lineage"
        );
    }
    let observed = json!({"kind":"ghost-a04-producer-consumption/1","observation":"committed-host-callback-or-driver-checkpoint","expected_profile_ref":pin.profile_ref,"receipt_sha256":pin.receipt_sha256,"configuration_sha256":pin.configuration_sha256,"workspace_id":pin.workspace_id,"work_count":producers.len(),"execution_count":executions.len(),"producers":producers,"all_producers_match":true,"all_executions_match":true});
    write_consumption(&root, &observed)?;
    Ok(Some(observed))
}

fn write_consumption(root: &Path, observed: &Value) -> Result<()> {
    let encoded = serde_json::to_vec_pretty(observed)?;
    ensure!(
        encoded.len() <= 65_536,
        "A04 producer consumption metadata bound exceeded"
    );
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root.join(CONSUMPTION))?;
    file.write_all(&encoded)?;
    Ok(())
}

pub(super) fn required_consumption(
    host: &Host,
    pin: &ConfigurationPin,
    roles: &[(&str, &str)],
    candidate: &Candidate,
) -> Result<Value> {
    ensure!(
        candidate.definition.content.execution_profile_ref == pin.profile_ref,
        "A04 candidate profile differs from accepted Owner configuration"
    );
    let computers = host
        .native_computers
        .as_ref()
        .ok_or_else(|| anyhow!("A04 producer computer missing"))?;
    ensure!(
        computers.pi_profile_ref(&candidate.definition.ghost_id)? == pin.profile_ref,
        "A04 provisioned bot route profile changed"
    );
    let mut observed = capture_for_host(host)?
        .ok_or_else(|| anyhow!("A04 producer consumption metadata missing"))?;
    let ids = roles
        .iter()
        .map(|(_, id)| *id)
        .collect::<std::collections::BTreeSet<_>>();
    ensure!(
        ids.len() == roles.len(),
        "A04 required stages reused a producer Work identity"
    );
    for (_, id) in roles {
        ensure!(
            observed["producers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["work_id"] == *id
                    && p["execution_id"].is_string()
                    && p["execution_binding"].is_object()),
            "A04 required producer did not execute with its sealed profile"
        );
    }
    observed["required_roles"] = serde_json::to_value(
        roles
            .iter()
            .map(|(role, id)| ((*role).to_owned(), (*id).to_owned()))
            .collect::<BTreeMap<_, _>>(),
    )?;
    write_consumption(&host.root, &observed)?;
    Ok(observed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn a04_private_producer_receipt_rejects_malformed_unaccepted_and_digest_drift() {
        let malformed = b"{}";
        assert!(receipt(malformed, &digest(malformed)).is_err());
        let p = crate::computers::fixture_accepted_producer_profile();
        let entry = OwnerAcceptedProfile {
            manifest: p.manifest().clone(),
            runtime_facts: p.runtime_facts().clone(),
        };
        let encoded = serde_json::to_vec(&entry).unwrap();
        assert!(
            receipt(&encoded, &digest(&encoded)).is_err(),
            "Controlled fixture evidence is never actual A04 acceptance"
        );
        assert!(receipt(&encoded, &"0".repeat(64)).is_err());
        let mut foreign = serde_json::to_value(&entry).unwrap();
        foreign["runtime_facts"]["evidence"] = json!("owned_container_probe");
        foreign["runtime_facts"]["profile_digest"] = json!("0".repeat(64));
        let encoded = serde_json::to_vec(&foreign).unwrap();
        assert!(receipt(&encoded, &digest(&encoded)).is_err());
        assert!(receipt(&vec![b' '; 65_537], &"0".repeat(64)).is_err());
        let mut f = host_fixture();
        let root = f.host.root.canonicalize().unwrap();
        let invalid = root.join("unaccepted.json");
        private_file(&invalid, &encoded).unwrap();
        assert!(install(&mut f, &invalid, &digest(&encoded)).is_err());
        assert!(!root.join(REGISTRY).exists());
        assert!(!root.join(CONFIG).exists());
        assert_eq!(
            f.host
                .lock()
                .unwrap()
                .journal
                .0
                .query_row::<u64, _, _>("SELECT COUNT(*) FROM lifetime_work", [], |r| r.get(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn a04_private_producer_file_guard_refuses_nonregular_and_oversize_inputs() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let file = root.join("receipt.json");
        private_file(&file, b"{}").unwrap();
        assert_eq!(bounded_file(&file).unwrap(), b"{}");
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let alias = root.join("alias.json");
        std::os::unix::fs::symlink(&file, &alias).unwrap();
        assert!(bounded_file(&alias).is_err());
        assert!(bounded_file(&root).is_err());
        let oversized = root.join("oversized.json");
        private_file(&oversized, &vec![b' '; 65_537]).unwrap();
        assert!(bounded_file(&oversized).is_err());
    }
    #[tokio::test]
    #[ignore = "explicit actual CLI preflight/private configuration/reopen only; no model generation"]
    async fn a04_real_private_producer_configuration_precedes_work_and_survives_cold_reopen(
    ) -> Result<()> {
        ensure!(
            std::env::var("GHOST_PI_A04_RUN_CONFIG_PREFLIGHT").as_deref() == Ok("1"),
            "A04 config preflight opt-in missing"
        );
        let mut f = host_fixture();
        let pin = install_from_environment(&mut f)?
            .ok_or_else(|| anyhow!("A04 accepted profile receipt required"))?;
        assert_eq!(
            f.host
                .native_computers
                .as_ref()
                .unwrap()
                .pi_deadline(&f.ghost)?,
            300_000
        );
        let (work, context) = {
            let state = f.host.lock()?;
            let admitted = lifetime::apply(
                &state.journal.0,
                &env(
                    "a04-profile-preflight-work",
                    json!({"method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":"Observe this newly admitted producer environment without starting inference or tools.","privacy":"public","acceptance_spec":{}}),
                ),
                "owner",
            )?;
            ensure!(
                admitted.status == ResponseStatus::Success,
                "A04 no-model preflight Work admission failed"
            );
            let work: Work = serde_json::from_value(admitted.data["work"].clone())?;
            let profile = lifetime::work_context::producer_profile(&state.journal.0, &work)?
                .ok_or_else(|| anyhow!("A04 preflight Work profile missing"))?;
            ensure!(
                profile.digest()? == pin.profile_ref.digest,
                "A04 preflight selected another profile"
            );
            let context:String=state.journal.0.query_row("SELECT payload FROM workspace_objects WHERE kind='ghost_work_context_v1' AND json_extract(payload,'$.work_id')=?1",[&work.id],|r|r.get(0))?;
            (work, context)
        };
        let observed = capture_for_host(&f.host)?.unwrap();
        assert_eq!(observed["work_count"], 1);
        assert!(observed["producers"][0]["execution_id"].is_null());
        let root = f.host.root.clone();
        let ghost = f.ghost.clone();
        let expected = pin.metadata();
        drop(f.host);
        let reopened = super::super::product_reopen(&root, &ghost, Some(&pin))?;
        let state = reopened.lock()?;
        assert_eq!(
            state.journal.0.query_row::<u64, _, _>(
                "SELECT COUNT(*) FROM lifetime_work",
                [],
                |r| r.get(0)
            )?,
            1
        );
        assert_eq!(
            state.journal.0.query_row::<u64, _, _>(
                "SELECT COUNT(*) FROM lifetime_pi_executions",
                [],
                |r| r.get(0)
            )?,
            0
        );
        assert_eq!(
            lifetime::work_context::producer_profile(&state.journal.0, &work)?
                .unwrap()
                .digest()?,
            pin.profile_ref.digest
        );
        assert_eq!(state.journal.0.query_row::<String,_,_>("SELECT payload FROM workspace_objects WHERE kind='ghost_work_context_v1' AND json_extract(payload,'$.work_id')=?1",[&work.id],|r|r.get(0))?,context);
        assert_eq!(
            reopened
                .native_computers
                .as_ref()
                .unwrap()
                .pi_profile_ref(&ghost)?,
            pin.profile_ref
        );
        assert_eq!(pin.metadata(), expected);
        pin.verify(&root)?;
        Ok(())
    }
}
