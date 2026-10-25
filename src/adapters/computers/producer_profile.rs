//! An explicitly accepted producer plan. Image names and model output are not
//! evidence that an interpreter exists. The Host authenticates Owner acceptance
//! or private Owner configuration and retains the original probe receipt before
//! constructing the sealed type.
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(crate) const PRODUCER_JSON_PROBE_COMMAND: &str = r#"exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/workspace TMPDIR=/workspace /usr/local/bin/python3 -I -S -c '
import decimal,errno,hashlib,json,os,platform,sys,tempfile
value={"unicode":"\u03bb","nested":[None,True,False,0,-7,1.25,{"text":"literal"}]}
assert json.loads(json.dumps(value,ensure_ascii=False))==value
assert decimal.Decimal("1.25")*4==5
assert len(hashlib.sha256(b"ghost-json-probe").hexdigest())==64
with tempfile.TemporaryFile(dir="/workspace") as f:
    f.write(b"work-scope-readback"); f.seek(0); work_ok=f.read()==b"work-scope-readback"
outside_denied=True
for path in ["/ghost-producer-profile-probe-forbidden","/tmp/ghost-producer-profile-probe-forbidden"]:
    try:
        with open(path,"xb") as f: f.write(b"")
        os.unlink(path); outside_denied=False
    except OSError as error:
        if error.errno not in (errno.EROFS,errno.EACCES,errno.EPERM): raise
result={"kind":"ghost-python-stdlib-observation/1","interpreter":sys.executable,"python_version":platform.python_version(),"implementation":sys.implementation.name,"os":sys.platform,"architecture":platform.machine(),"json_roundtrip":True,"stdlib_imports":["decimal","errno","hashlib","json","os","platform","sys","tempfile"],"cwd":os.getcwd(),"sandbox_uid":os.getuid(),"sandbox_gid":os.getgid(),"root_read_only":bool(os.statvfs("/").f_flag & os.ST_RDONLY),"work_write_readback":work_ok,"outside_writes_denied":outside_denied,"network_interfaces":sorted(os.listdir("/sys/class/net"))}
print(json.dumps(result,sort_keys=True,separators=(",",":")))'"#;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProducerShell {
    pub program: String,
    pub args: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProducerIsolation {
    pub root_read_only: bool,
    pub network: String,
    pub cwd: String,
    pub work_mount: String,
    pub work_writable: bool,
    pub tmpfs_mounts: Vec<String>,
    pub cpus: u32,
    pub memory_mib: u32,
}
impl Default for ProducerIsolation {
    fn default() -> Self {
        Self { root_read_only: true, network: "none".into(), cwd: "/workspace".into(),
            work_mount: "/workspace".into(), work_writable: true, tmpfs_mounts: vec![], cpus: 1, memory_mib: 256 }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProducerJsonRuntime {
    pub kind: String,
    pub interpreter: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProducerProfileManifest {
    pub kind: String,
    pub profile_id: String,
    pub revision: u64,
    pub image_ref: String,
    pub platform_manifest_digest: String,
    /// Owner-declared OCI provenance; decoded cache inspection cannot re-hash the raw config blob.
    pub image_config_digest: String,
    pub os: String,
    pub architecture: String,
    pub platform_variant: String,
    pub shell: ProducerShell,
    pub isolation: ProducerIsolation,
    pub json_runtime: ProducerJsonRuntime,
}
fn sha256(value: &[u8]) -> String { format!("{:x}", Sha256::digest(value)) }
fn hex_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn image_digest(value: &str) -> bool { value.strip_prefix("sha256:").is_some_and(hex_digest) }
fn pinned_image(value: &str) -> bool {
    value.len() <= 512 && !value.chars().any(|c| c.is_whitespace() || c.is_control())
        && value.rsplit_once('@').is_some_and(|(name, digest)| !name.is_empty() && image_digest(digest))
}
// Match the Host's canonical JSON digest independent of struct/map insertion
// order. Only bounded typed integer/string/bool records enter these digests.
fn canonical(value: &Value, output: &mut String) -> Result<()> {
    match value {
        Value::Object(map) => {
            output.push('{');
            let mut keys: Vec<_> = map.keys().collect(); keys.sort();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 { output.push(','); }
                output.push_str(&serde_json::to_string(key)?); output.push(':'); canonical(&map[key], output)?;
            }
            output.push('}');
        }
        Value::Array(items) => {
            output.push('[');
            for (index, item) in items.iter().enumerate() { if index > 0 { output.push(','); } canonical(item, output)?; }
            output.push(']');
        }
        _ => output.push_str(&serde_json::to_string(value)?),
    }
    Ok(())
}
fn record_digest(value: &impl Serialize) -> Result<String> {
    let mut encoded = String::new(); canonical(&serde_json::to_value(value)?, &mut encoded)?; Ok(sha256(encoded.as_bytes()))
}
impl ProducerProfileManifest {
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(self.kind == "ghost-producer-profile/1" && self.revision > 0
            && !self.profile_id.is_empty() && self.profile_id.len() <= 64
            && self.profile_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "Producer profile identity invalid");
        ensure!(pinned_image(&self.image_ref) && image_digest(&self.platform_manifest_digest)
            && image_digest(&self.image_config_digest), "Producer profile requires exact image digests");
        ensure!(self.os == "linux" && self.architecture == "arm64" && self.platform_variant == "v8"
            && self.shell == (ProducerShell { program: "/bin/sh".into(), args: vec!["-lc".into()] })
            && self.isolation == ProducerIsolation::default(), "Producer profile isolation policy is not accepted");
        ensure!(self.json_runtime.kind == "python-stdlib/1" && self.json_runtime.interpreter == "/usr/local/bin/python3",
            "Producer profile JSON runtime is unsupported");
        Ok(())
    }
    pub(crate) fn digest(&self) -> Result<String> { self.validate()?; record_digest(self) }
    /// Exact cached reference lookup, not an image pull or tag-based capability
    /// inference. The OCI child digest binds its config; image inspect exposes
    /// decoded config rather than the raw bytes needed to re-hash that blob.
    pub(crate) fn validate_cached_image(&self, inspection: &Value) -> Result<()> {
        self.validate()?;
        let images = inspection.as_array().ok_or_else(|| anyhow::anyhow!("Producer image inspection is not an array"))?;
        ensure!(images.len() == 1, "Producer image inspection is ambiguous");
        let image = &images[0];
        let digest = self.image_ref.rsplit_once('@').unwrap().1;
        ensure!(image["id"] == digest.strip_prefix("sha256:").unwrap()
            && image["configuration"]["name"] == self.image_ref
            && image["configuration"]["descriptor"]["digest"] == digest,
            "Producer cached reference does not match its exact accepted image");
        let variants = image["variants"].as_array().ok_or_else(|| anyhow::anyhow!("Producer cached variants missing"))?;
        // `container run` selects only OS/arch. Do not hide a second eligible
        // child by first filtering on the digest or a variant argv cannot pin.
        let selected: Vec<_> = variants.iter().filter(|variant| variant["platform"]["os"] == self.os
            && variant["platform"]["architecture"] == self.architecture).collect();
        ensure!(selected.len() == 1, "Producer cached platform manifest does not match its accepted plan");
        ensure!(selected[0]["digest"] == self.platform_manifest_digest && selected[0]["platform"]["variant"] == self.platform_variant,
            "Producer cached platform child digest or variant changed");
        ensure!(selected[0]["config"]["os"] == self.os && selected[0]["config"]["architecture"] == self.architecture
            && selected[0]["config"]["variant"] == self.platform_variant, "Producer cached config platform does not match");
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProducerRuntimeObservation {
    pub kind: String,
    pub interpreter: String,
    pub python_version: String,
    pub implementation: String,
    pub os: String,
    pub architecture: String,
    pub json_roundtrip: bool,
    pub stdlib_imports: Vec<String>,
    pub cwd: String,
    pub sandbox_uid: u32,
    pub sandbox_gid: u32,
    pub root_read_only: bool,
    pub work_write_readback: bool,
    pub outside_writes_denied: bool,
    pub network_interfaces: Vec<String>,
}
impl ProducerRuntimeObservation {
    pub(crate) fn digest(&self) -> Result<String> { record_digest(self) }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProducerRuntimeFactsReceipt {
    pub kind: String,
    pub profile_digest: String,
    pub image_ref: String,
    pub platform_manifest_digest: String,
    pub probe_sha256: String,
    pub observation_sha256: String,
    pub exit_code: i32,
    pub evidence: String,
    pub container_cli_sha256: String,
    pub container_cli_version: String,
    pub sandbox_uid: u32,
    pub sandbox_gid: u32,
    pub observation: ProducerRuntimeObservation,
}
impl ProducerRuntimeFactsReceipt {
    pub(crate) fn digest(&self) -> Result<String> { record_digest(self) }
    pub(crate) fn validate_for_profile(&self, manifest: &ProducerProfileManifest) -> Result<()> {
        manifest.validate()?;
        let facts = self;
        let fixture = cfg!(test) && facts.evidence == "controlled_fixture";
        ensure!(facts.kind == "ghost-producer-runtime-facts/1" && (facts.evidence == "owned_container_probe" || fixture)
            && hex_digest(&facts.container_cli_sha256) && facts.container_cli_version == super::apple_container::APPLE_CONTAINER_CLI_VERSION
            && facts.sandbox_uid > 0 && facts.sandbox_gid > 0
            && facts.profile_digest == manifest.digest()? && facts.image_ref == manifest.image_ref
            && facts.platform_manifest_digest == manifest.platform_manifest_digest
            && facts.exit_code == 0 && facts.probe_sha256 == producer_json_probe_sha256()
            && facts.observation_sha256 == facts.observation.digest()?, "Producer runtime receipt does not bind the accepted profile/probe");
        let observed = &facts.observation;
        let version: Vec<_> = observed.python_version.split('.').collect();
        ensure!(observed.kind == "ghost-python-stdlib-observation/1" && observed.interpreter == manifest.json_runtime.interpreter
            && observed.implementation == "cpython" && observed.os == manifest.os && observed.architecture == "aarch64"
            && observed.json_roundtrip && observed.stdlib_imports == ["decimal", "errno", "hashlib", "json", "os", "platform", "sys", "tempfile"]
            && observed.cwd == manifest.isolation.cwd && observed.sandbox_uid == facts.sandbox_uid && observed.sandbox_gid == facts.sandbox_gid
            && observed.root_read_only && observed.work_write_readback && observed.outside_writes_denied && observed.network_interfaces == ["lo"]
            && observed.python_version.len() <= 32 && version.len() == 3 && version[0] == "3"
            && version.iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())),
            "Producer runtime observation does not confirm the configured JSON runtime");
        Ok(())
    }
}

/// No Deserialize implementation: loading a journal/config value must repeat
/// both authenticated Host provenance checks and this content validation.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(crate) struct AcceptedProducerProfile {
    manifest: ProducerProfileManifest,
    runtime_facts: ProducerRuntimeFactsReceipt,
    owner_acceptance_command_id: String,
}
impl AcceptedProducerProfile {
    /// The Host must first prove this exact provenance identity is an actual
    /// Owner command or private Owner configuration accepting this manifest and
    /// original owned probe receipt. This method
    /// validates its immutable content; it does not authenticate a caller.
    pub(crate) fn from_owner_accepted(manifest: ProducerProfileManifest, runtime_facts: ProducerRuntimeFactsReceipt,
        owner_acceptance_command_id: String) -> Result<Self> {
        manifest.validate()?;
        ensure!(!owner_acceptance_command_id.is_empty() && owner_acceptance_command_id.len() <= 400
            && !owner_acceptance_command_id.chars().any(char::is_control), "Producer profile Owner receipt identity invalid");
        runtime_facts.validate_for_profile(&manifest)?;
        Ok(Self { manifest, runtime_facts, owner_acceptance_command_id })
    }
    pub(crate) fn manifest(&self) -> &ProducerProfileManifest { &self.manifest }
    pub(crate) fn runtime_facts(&self) -> &ProducerRuntimeFactsReceipt { &self.runtime_facts }
    pub(crate) fn owner_acceptance_command_id(&self) -> &str { &self.owner_acceptance_command_id }
    pub(crate) fn digest(&self) -> Result<String> { self.manifest.digest() }
    pub(crate) fn environment(&self) -> Value {
        let manifest = &self.manifest;
        let mut environment = json!({"version":"ghost-execution-environment/1","evidence":"owner_accepted_runtime_facts","backend":"apple_container",
            "profile":{"id":manifest.profile_id,"revision":manifest.revision,"digest":self.runtime_facts.profile_digest},
            "image_ref":manifest.image_ref,"platform_manifest_digest":manifest.platform_manifest_digest,"owner_declared_image_config_digest":manifest.image_config_digest,
            "os":manifest.os,"architecture":manifest.architecture,"platform_variant":manifest.platform_variant,"shell":manifest.shell,"cwd":manifest.isolation.cwd,
            "filesystem":{"root_read_only":manifest.isolation.root_read_only,"work_mount":{"target":manifest.isolation.work_mount,"writable":manifest.isolation.work_writable},"tmpfs_mounts":manifest.isolation.tmpfs_mounts},
            "network":manifest.isolation.network,
            "resources":{"cpus":manifest.isolation.cpus,"memory_mib":manifest.isolation.memory_mib},
            "json_runtime":{"kind":manifest.json_runtime.kind,"interpreter":manifest.json_runtime.interpreter,"python_version":self.runtime_facts.observation.python_version,
                "implementation":self.runtime_facts.observation.implementation,"stdlib_imports":self.runtime_facts.observation.stdlib_imports,
                "invocation":{"program":manifest.json_runtime.interpreter,"args_prefix":["-I","-S"],"script_path":"work-relative"},
                "facts_receipt_digest":self.runtime_facts.digest().expect("validated typed producer facts")}});
        if cfg!(test) && self.runtime_facts.evidence == "controlled_fixture" {
            environment["evidence"] = json!("controlled_fixture");
            environment["backend"] = json!("fixture");
            environment["simulated"] = json!(true);
        }
        environment
    }
}
pub(crate) fn producer_json_probe_sha256() -> String { sha256(PRODUCER_JSON_PROBE_COMMAND.as_bytes()) }

#[cfg(test)]
pub(crate) fn fixture_accepted_producer_profile() -> AcceptedProducerProfile {
    let manifest = ProducerProfileManifest { kind: "ghost-producer-profile/1".into(), profile_id: "fixture-json".into(), revision: 1,
        image_ref: format!("fixture.invalid/python@sha256:{}", "1".repeat(64)), platform_manifest_digest: format!("sha256:{}", "2".repeat(64)),
        image_config_digest: format!("sha256:{}", "3".repeat(64)), os: "linux".into(), architecture: "arm64".into(), platform_variant: "v8".into(),
        shell: ProducerShell { program: "/bin/sh".into(), args: vec!["-lc".into()] }, isolation: ProducerIsolation::default(),
        json_runtime: ProducerJsonRuntime { kind: "python-stdlib/1".into(), interpreter: "/usr/local/bin/python3".into() } };
    let observation = ProducerRuntimeObservation { kind: "ghost-python-stdlib-observation/1".into(), interpreter: "/usr/local/bin/python3".into(),
        python_version: "3.13.1".into(), implementation: "cpython".into(), os: "linux".into(), architecture: "aarch64".into(), json_roundtrip: true,
        stdlib_imports: ["decimal", "errno", "hashlib", "json", "os", "platform", "sys", "tempfile"].into_iter().map(str::to_owned).collect(),
        cwd: "/workspace".into(), sandbox_uid: 501, sandbox_gid: 20, root_read_only: true, work_write_readback: true,
        outside_writes_denied: true, network_interfaces: vec!["lo".into()] };
    let facts = ProducerRuntimeFactsReceipt { kind: "ghost-producer-runtime-facts/1".into(), profile_digest: manifest.digest().unwrap(),
        image_ref: manifest.image_ref.clone(), platform_manifest_digest: manifest.platform_manifest_digest.clone(),
        probe_sha256: producer_json_probe_sha256(), observation_sha256: observation.digest().unwrap(), exit_code: 0,
        evidence: "controlled_fixture".into(), container_cli_sha256: "4".repeat(64), container_cli_version: super::apple_container::APPLE_CONTAINER_CLI_VERSION.into(),
        sandbox_uid: 501, sandbox_gid: 20, observation };
    AcceptedProducerProfile::from_owner_accepted(manifest, facts, "fixture-only-owner-acceptance".into()).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn producer_profile_requires_matching_explicit_runtime_receipt_and_fixed_isolation() {
        let accepted = fixture_accepted_producer_profile();
        let reject = |manifest, facts| assert!(AcceptedProducerProfile::from_owner_accepted(manifest, facts, "fixture-only-owner-acceptance".into()).is_err());
        for field in ["image_ref", "platform_manifest_digest", "profile_digest", "probe_sha256", "observation_sha256", "evidence"] {
            let mut value = serde_json::to_value(accepted.runtime_facts()).unwrap(); value[field] = json!("unconfirmed");
            reject(accepted.manifest().clone(), serde_json::from_value(value).unwrap());
        }
        for field in ["interpreter", "python_version", "implementation", "os", "architecture"] {
            let mut facts = accepted.runtime_facts().clone();
            let mut value = serde_json::to_value(&facts.observation).unwrap(); value[field] = json!("unconfirmed");
            facts.observation = serde_json::from_value(value).unwrap(); facts.observation_sha256 = facts.observation.digest().unwrap();
            reject(accepted.manifest().clone(), facts);
        }
        let mut facts = accepted.runtime_facts().clone(); facts.observation.json_roundtrip = false;
        facts.observation_sha256 = facts.observation.digest().unwrap(); reject(accepted.manifest().clone(), facts);
        let mut facts = accepted.runtime_facts().clone(); facts.exit_code = 1; reject(accepted.manifest().clone(), facts);
        for field in ["container_cli_sha256", "container_cli_version"] {
            let mut value = serde_json::to_value(accepted.runtime_facts()).unwrap(); value[field] = json!("unconfirmed");
            reject(accepted.manifest().clone(), serde_json::from_value(value).unwrap());
        }
        let mut facts = accepted.runtime_facts().clone(); facts.sandbox_uid = 0; reject(accepted.manifest().clone(), facts);
        let mut facts = accepted.runtime_facts().clone(); facts.sandbox_gid = 0; reject(accepted.manifest().clone(), facts);
        for field in ["root_read_only", "work_write_readback", "outside_writes_denied"] {
            let mut facts = accepted.runtime_facts().clone();
            let mut value = serde_json::to_value(&facts.observation).unwrap(); value[field] = json!(false);
            facts.observation = serde_json::from_value(value).unwrap(); facts.observation_sha256 = facts.observation.digest().unwrap();
            reject(accepted.manifest().clone(), facts);
        }
        let mut facts = accepted.runtime_facts().clone(); facts.observation.network_interfaces.push("eth0".into());
        facts.observation_sha256 = facts.observation.digest().unwrap(); reject(accepted.manifest().clone(), facts);
        let mut manifest = accepted.manifest().clone(); manifest.isolation.network = "default".into(); reject(manifest, accepted.runtime_facts().clone());
        let mut manifest = accepted.manifest().clone(); manifest.image_ref = "python:latest".into(); reject(manifest, accepted.runtime_facts().clone());
        assert_eq!(accepted.manifest().digest().unwrap(), accepted.runtime_facts().profile_digest);
        assert_eq!(serde_json::to_value(&accepted).unwrap()["runtime_facts"]["evidence"], "controlled_fixture");
        assert!(!accepted.environment().to_string().contains("fixture-only-owner-acceptance"));
    }

    #[test]
    fn producer_cache_preflight_requires_exact_index_name_child_and_platform() {
        let accepted = fixture_accepted_producer_profile(); let manifest = accepted.manifest();
        let index_digest = manifest.image_ref.rsplit_once('@').unwrap().1;
        let current = json!([{"id":index_digest.strip_prefix("sha256:").unwrap(),
            "configuration":{"name":manifest.image_ref,"descriptor":{"digest":index_digest}},
            "variants":[{"digest":manifest.platform_manifest_digest,"platform":{"os":"linux","architecture":"arm64","variant":"v8"},
                "config":{"os":"linux","architecture":"arm64","variant":"v8"}}]}]);
        manifest.validate_cached_image(&current).unwrap();
        for pointer in ["/0/id", "/0/configuration/name", "/0/configuration/descriptor/digest", "/0/variants/0/digest",
            "/0/variants/0/platform/os", "/0/variants/0/platform/architecture", "/0/variants/0/platform/variant",
            "/0/variants/0/config/os", "/0/variants/0/config/architecture", "/0/variants/0/config/variant"] {
            let mut wrong = current.clone(); *wrong.pointer_mut(pointer).unwrap() = json!("foreign");
            assert!(manifest.validate_cached_image(&wrong).is_err(), "{pointer}");
        }
        for missing in [json!([]), json!({}), json!([current[0].clone(), current[0].clone()]),
            json!([{"id":index_digest.strip_prefix("sha256:").unwrap(),"configuration":current[0]["configuration"],"variants":[]}])] {
            assert!(manifest.validate_cached_image(&missing).is_err());
        }
        let mut ambiguous = current.clone(); let duplicate = ambiguous[0]["variants"][0].clone();
        ambiguous[0]["variants"].as_array_mut().unwrap().push(duplicate);
        assert!(manifest.validate_cached_image(&ambiguous).is_err());
        for alternate_variant in ["v8", "v9"] {
            let mut ambiguous = current.clone(); let mut alternate = ambiguous[0]["variants"][0].clone();
            alternate["digest"] = json!(format!("sha256:{}", "9".repeat(64)));
            alternate["platform"]["variant"] = json!(alternate_variant);
            ambiguous[0]["variants"].as_array_mut().unwrap().push(alternate);
            assert!(manifest.validate_cached_image(&ambiguous).is_err(), "OS/arch selection cannot disambiguate {alternate_variant}");
        }
    }
}
