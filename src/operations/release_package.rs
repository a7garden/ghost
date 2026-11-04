use super::recovery_bundle::{
    self, BundleRequest, CapturedSelectedComponents, HomeBrowserManifest, ReleaseIdentity,
    RootPresence, SelectedComponentInventory, SelectedInventoryEntry, SelectedInventoryKind,
};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

const CONTRACT_REVISION: &str = "ghost-release-package-v1";
const COMPONENT_DIGEST_REVISION: &[u8] = b"ghost-release-component-inventory/1\0";
const REQUIRED_COMPONENTS: [&str; 9] = [
    "host",
    "pi",
    "bridge",
    "image",
    "ui",
    "gateway",
    "extensions",
    "config",
    "schema",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReleasePackageReceipt {
    pub release: ReleaseIdentity,
    pub manifest_sha256: String,
    pub package_path: PathBuf,
    pub component_digests: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ReleasePackageManifest {
    contract_revision: String,
    complete: bool,
    host_label: String,
    release_provenance: ReleaseIdentity,
    component_inventory: SelectedComponentInventory,
    roots: Vec<PackageRoot>,
    home_browser_manifest: HomeBrowserManifest,
    external_document_references: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct PackageRoot {
    label: String,
    role: String,
    excluded_credential_paths: Vec<String>,
    credential_references: Vec<String>,
    stopped_owner_pid_checks: usize,
}

#[derive(Serialize)]
struct ReleasePackageManifestRef<'a> {
    contract_revision: &'static str,
    complete: bool,
    host_label: &'a str,
    release_provenance: &'a ReleaseIdentity,
    component_inventory: &'a SelectedComponentInventory,
    roots: &'a [PackageRoot],
    home_browser_manifest: &'a HomeBrowserManifest,
    external_document_references: &'a [String],
}

/// Creates a new, private, read-only selected release package. Source roots and
/// owner PIDs are caller-selected; the bundle layer never discovers or stops them.
pub fn create_release_package(
    request: &BundleRequest,
    destination: &Path,
) -> Result<ReleasePackageReceipt> {
    validate_request(request)?;
    let mut observed_release = None;
    let capture = recovery_bundle::capture_selected_components(request, destination, |inventory| {
        let component_digests = observed_component_digests(inventory)?;
        for component in REQUIRED_COMPONENTS {
            let declared = request
                .release
                .component_digests
                .get(component)
                .context("declared component digest is missing")?;
            ensure!(
                component_digests.get(component) == Some(declared),
                "selected component differs from its declared digest"
            );
        }
        let observed_config_digest = observed_config_digest(inventory, &component_digests)?;
        ensure!(
            observed_config_digest == request.release.config_digest,
            "selected redacted configuration differs from its declared digest"
        );

        let mut release = request.release.clone();
        release.component_digests = component_digests;
        let roots = package_roots(request)?;
        let manifest = ReleasePackageManifestRef {
            contract_revision: CONTRACT_REVISION,
            complete: true,
            host_label: &request.host_label,
            release_provenance: &release,
            component_inventory: inventory,
            roots: &roots,
            home_browser_manifest: &request.home_browser_manifest,
            external_document_references: &request.external_document_references,
        };
        let bytes = serde_json::to_vec(&manifest)?;
        observed_release = Some(release);
        Ok(bytes)
    })?;
    let release = observed_release.context("release package manifest was not committed")?;
    Ok(receipt(capture, release))
}

/// Verifies an immutable package against a caller-supplied manifest pin. The
/// package's own manifest is never treated as its own authenticity proof.
pub fn verify_release_package(
    source: &Path,
    expected_manifest_sha256: &str,
) -> Result<ReleasePackageReceipt> {
    ensure!(valid_digest(expected_manifest_sha256), "external manifest SHA256 is missing or malformed");
    let (package_path, bytes) = recovery_bundle::read_selected_manifest(source)?;
    let manifest_sha256 = sha256(&bytes);
    ensure!(
        manifest_sha256 == expected_manifest_sha256,
        "release package manifest differs from the external SHA256 pin"
    );
    let manifest: ReleasePackageManifest = serde_json::from_slice(&bytes)?;
    ensure!(
        serde_json::to_vec(&manifest)? == bytes,
        "release package manifest is not in canonical serialized form"
    );
    let component_digests = validate_manifest(&manifest)?;
    recovery_bundle::verify_selected_components(
        &package_path,
        &manifest.component_inventory,
        bytes.len(),
    )?;
    Ok(ReleasePackageReceipt {
        release: manifest.release_provenance,
        manifest_sha256,
        package_path,
        component_digests,
    })
}

fn receipt(capture: CapturedSelectedComponents, release: ReleaseIdentity) -> ReleasePackageReceipt {
    ReleasePackageReceipt {
        component_digests: release.component_digests.clone(),
        release,
        manifest_sha256: capture.manifest_sha256,
        package_path: capture.package_path,
    }
}

fn validate_request(request: &BundleRequest) -> Result<()> {
    let required = required_component_set();
    let roots = request
        .roots
        .iter()
        .map(|root| root.label.as_str())
        .collect::<BTreeSet<_>>();
    ensure!(roots == required, "release request must select exactly the nine named components");
    ensure!(request.release.schema_min == request.release.schema_max && matches!(request.release.schema_min, 12 | 13 | 14), "release package requires one supported schema, 12, 13, or 14");
    ensure!(
        request.release.component_digests.keys().map(String::as_str).collect::<BTreeSet<_>>() == required,
        "release request must declare one digest for every required component"
    );
    ensure!(!request.release.pinned_runtime_versions.is_empty(), "release runtime pins are missing");
    ensure!(!request.release.image_references.is_empty(), "release image digest pins are missing");
    for version in request.release.pinned_runtime_versions.values() {
        ensure!(is_exact_runtime_pin(version), "runtime version is not an exact pin");
    }
    let mut images = BTreeSet::new();
    for image in &request.release.image_references {
        ensure!(
            is_immutable_image_reference(image) && images.insert(image.as_str()),
            "image reference is unpinned or duplicated"
        );
    }
    for digest in request.release.component_digests.values() {
        ensure!(valid_digest(digest), "declared component digest is malformed");
    }
    ensure!(valid_digest(&request.release.config_digest), "configuration digest is malformed");
    Ok(())
}

fn validate_manifest(manifest: &ReleasePackageManifest) -> Result<BTreeMap<String, String>> {
    ensure!(
        manifest.contract_revision == CONTRACT_REVISION && manifest.complete,
        "release package manifest is incomplete or has an unsupported contract revision"
    );
    let required = required_component_set();
    let components = manifest.component_inventory.keys().map(String::as_str).collect::<BTreeSet<_>>();
    ensure!(components == required, "release package component inventory is incomplete or unexpected");
    ensure!(required.contains(manifest.host_label.as_str()), "release package Host label is missing");
    validate_release_identity(&manifest.release_provenance)?;
    ensure!(
        manifest.release_provenance.component_digests.keys().map(String::as_str).collect::<BTreeSet<_>>() == required,
        "release provenance is missing a required component digest"
    );
    ensure!(
        manifest.roots.len() == REQUIRED_COMPONENTS.len(),
        "release package source-root provenance is incomplete"
    );
    let mut root_labels = BTreeSet::new();
    for root in &manifest.roots {
        ensure!(
            root_labels.insert(root.label.as_str()) && required.contains(root.label.as_str()),
            "release package source-root label is invalid or duplicated"
        );
        ensure!(safe_name(&root.role) && root.stopped_owner_pid_checks > 0, "source-root provenance is invalid");
        validate_root_exclusions(root, &manifest.component_inventory[&root.label])?;
    }
    ensure!(root_labels == required, "release package source-root provenance is incomplete");
    ensure!(
        manifest.roots.windows(2).all(|pair| pair[0].label < pair[1].label),
        "release package source roots are not canonically ordered"
    );
    validate_presence(&manifest.home_browser_manifest, &required, &manifest.component_inventory)?;
    for reference in &manifest.external_document_references {
        ensure!(
            !reference.trim().is_empty()
                && reference.len() <= 4096
                && !reference.chars().any(char::is_control)
                && !contains_url_userinfo(reference),
            "release provenance reference is invalid"
        );
    }

    let observed = observed_component_digests(&manifest.component_inventory)?;
    ensure!(
        observed == manifest.release_provenance.component_digests,
        "release component digests differ from the declared copied inventory"
    );
    ensure!(
        observed_config_digest(&manifest.component_inventory, &observed)? == manifest.release_provenance.config_digest,
        "release configuration digest differs from its selected component"
    );
    Ok(observed)
}

fn validate_release_identity(release: &ReleaseIdentity) -> Result<()> {
    ensure!(!release.source_revision.trim().is_empty() && release.source_revision.len() <= 512 && !release.source_revision.chars().any(char::is_control), "source revision provenance is invalid");
    ensure!(valid_digest(&release.dirty_snapshot_digest), "dirty snapshot digest is malformed");
    ensure!(release.schema_min == release.schema_max && matches!(release.schema_min, 12 | 13 | 14), "release package requires one supported schema, 12, 13, or 14");
    ensure!(!release.protocol_revision.trim().is_empty() && release.protocol_revision.len() <= 128 && !release.protocol_revision.chars().any(char::is_control), "protocol revision pin is invalid");
    ensure!(!release.pinned_runtime_versions.is_empty(), "release runtime pins are missing");
    for (name, version) in &release.pinned_runtime_versions {
        ensure!(safe_name(name) && is_exact_runtime_pin(version), "runtime version pin is invalid");
    }
    ensure!(!release.image_references.is_empty(), "release image digest pins are missing");
    let mut images = BTreeSet::new();
    for image in &release.image_references {
        ensure!(is_immutable_image_reference(image) && images.insert(image), "image digest pin is invalid or duplicated");
    }
    ensure!(valid_digest(&release.config_digest), "configuration digest is malformed");
    Ok(())
}

fn validate_root_exclusions(root: &PackageRoot, entries: &[SelectedInventoryEntry]) -> Result<()> {
    let mut exclusions = BTreeSet::new();
    for exclusion in &root.excluded_credential_paths {
        ensure!(safe_relative(exclusion), "credential exclusion path is unsafe");
        ensure!(exclusions.insert(exclusion.as_str()), "credential exclusion path is duplicated");
        ensure!(
            !entries.iter().any(|entry| {
                !entry.path.is_empty()
                    && (entry.path == *exclusion
                        || entry
                            .path
                            .strip_prefix(exclusion)
                            .is_some_and(|remainder| remainder.starts_with('/')))
            }),
            "excluded credential path appears in the package inventory"
        );
    }
    ensure!(
        root.excluded_credential_paths.windows(2).all(|pair| pair[0] < pair[1]),
        "credential exclusions are not canonically ordered"
    );
    let mut references = BTreeSet::new();
    for reference in &root.credential_references {
        ensure!(safe_name(reference) && references.insert(reference.as_str()), "credential reference is invalid or duplicated");
    }
    ensure!(
        root.excluded_credential_paths.is_empty() || !root.credential_references.is_empty(),
        "credential exclusions lack source-owner references"
    );
    Ok(())
}

fn validate_presence(manifest: &HomeBrowserManifest, labels: &BTreeSet<&str>, inventory: &SelectedComponentInventory) -> Result<()> {
    for entry in &manifest.computers {
        for state in [&entry.home, &entry.browser] {
            if let RootPresence::Present { root_label, relative_path } = state {
                ensure!(labels.contains(root_label.as_str()), "home/browser provenance names an unknown component");
                ensure!(relative_path.is_empty() || safe_relative(relative_path), "home/browser relative path is unsafe");
                ensure!(relative_path.is_empty() || inventory[root_label].iter().any(|entry|
                    entry.path == *relative_path && matches!(entry.kind, SelectedInventoryKind::Directory)),
                    "home/browser path is absent from the selected directory inventory");
            }
        }
    }
    Ok(())
}

fn package_roots(request: &BundleRequest) -> Result<Vec<PackageRoot>> {
    let mut roots = request
        .roots
        .iter()
        .map(|root| {
            let mut excluded_credential_paths = root
                .excluded_credential_paths
                .iter()
                .map(|path| {
                    path.to_str()
                        .map(str::to_owned)
                        .context("credential exclusion path is not UTF-8")
                })
                .collect::<Result<Vec<_>>>()?;
            excluded_credential_paths.sort();
            Ok(PackageRoot {
                label: root.label.clone(),
                role: root.role.clone(),
                excluded_credential_paths,
                credential_references: root.credential_references.clone(),
                stopped_owner_pid_checks: root.stopped_owner_pids.len(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    roots.sort_by(|left, right| left.label.cmp(&right.label));
    Ok(roots)
}

fn observed_component_digests(
    inventory: &SelectedComponentInventory,
) -> Result<BTreeMap<String, String>> {
    ensure!(
        inventory.keys().map(String::as_str).collect::<BTreeSet<_>>() == required_component_set(),
        "copied component inventory is incomplete"
    );
    inventory
        .iter()
        .map(|(component, entries)| Ok((component.clone(), component_inventory_digest(component, entries)?)))
        .collect()
}

fn component_inventory_digest(component: &str, entries: &[SelectedInventoryEntry]) -> Result<String> {
    ensure!(!entries.is_empty(), "component inventory is empty");
    ensure!(
        entries.windows(2).all(|pair| pair[0].path < pair[1].path),
        "component inventory rows are not uniquely sorted"
    );
    let mut hash = Sha256::new();
    hash.update(COMPONENT_DIGEST_REVISION);
    hash_field(&mut hash, component.as_bytes());
    hash.update((entries.len() as u64).to_be_bytes());
    for entry in entries {
        hash_field(&mut hash, entry.path.as_bytes());
        hash.update([match &entry.kind {
            SelectedInventoryKind::Directory => 1,
            SelectedInventoryKind::File => 2,
        }]);
        hash.update(entry.size.to_be_bytes());
        hash.update(entry.mode.to_be_bytes());
        match &entry.sha256 {
            Some(digest) => {
                ensure!(valid_digest(digest), "component file digest is malformed");
                hash.update([1]);
                hash_field(&mut hash, digest.as_bytes());
            }
            None => hash.update([0]),
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// A single selected config file keeps its raw byte digest (the v1 contract's
/// golden form); multi-file config sets use their complete component inventory digest.
fn observed_config_digest(
    inventory: &SelectedComponentInventory,
    component_digests: &BTreeMap<String, String>,
) -> Result<String> {
    let entries = inventory
        .get("config")
        .context("copied configuration component is missing")?;
    let mut files = entries
        .iter()
        .filter(|entry| matches!(entry.kind, SelectedInventoryKind::File));
    let first = files.next().context("selected redacted configuration has no files")?;
    if files.next().is_none() {
        return first
            .sha256
            .clone()
            .context("selected configuration file digest is missing");
    }
    component_digests
        .get("config")
        .cloned()
        .context("selected configuration inventory digest is missing")
}

fn hash_field(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}

fn required_component_set() -> BTreeSet<&'static str> {
    REQUIRED_COMPONENTS.into_iter().collect()
}

fn is_exact_runtime_pin(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= 512
        && !value.chars().any(char::is_control)
        && !value.chars().any(char::is_whitespace)
        && !value.eq_ignore_ascii_case("latest")
        && !value.eq_ignore_ascii_case("stable")
        && !matches!(value, "*" | "any")
        && !value.chars().any(|character| matches!(character, '^' | '~' | '<' | '>' | '*' | '|' | ','))
        && !value
            .split(|character| matches!(character, '.' | '-' | '+'))
            .any(|part| part.eq_ignore_ascii_case("x"))
}

fn is_immutable_image_reference(value: &str) -> bool {
    if value.trim() != value || value.chars().any(char::is_control) || value.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((name, digest)) = value.rsplit_once("@sha256:") else {
        return false;
    };
    if name.is_empty()
        || name.contains('@')
        || !valid_digest(digest)
        || contains_url_userinfo(value)
    {
        return false;
    }
    !name
        .rsplit('/')
        .next()
        .and_then(|last| last.rsplit_once(':').map(|(_, tag)| tag))
        .is_some_and(|tag| tag.eq_ignore_ascii_case("latest"))
}

fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && value.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn safe_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn contains_url_userinfo(value: &str) -> bool {
    value
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or_default().contains('@'))
        .unwrap_or(false)
}
