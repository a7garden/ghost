#![cfg(all(feature = "lifetime", unix))]

use ghost::operations::recovery_bundle::{
    BundleRequest, ReleaseIdentity, RootSpec,
};
use ghost::operations::release_package::{create_release_package, verify_release_package};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use tempfile::TempDir;

const COMPONENTS: [&str; 9] = [
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

struct Fixture {
    _temporary: TempDir,
    request: BundleRequest,
    destination: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let base = temporary.path().canonicalize().unwrap();
        let source = base.join("source");
        fs::create_dir(&source).unwrap();
        let golden: Value = serde_json::from_str(include_str!(
            "../contracts/lifetime/release-package-v1.golden.json"
        ))
        .unwrap();
        let mut roots = Vec::with_capacity(COMPONENTS.len());
        let mut component_digests = BTreeMap::new();

        for component in COMPONENTS {
            let root = source.join(component);
            fs::create_dir(&root).unwrap();
            set_mode(&root, 0o755);
            let contents = golden["component_contents"][component]
                .as_str()
                .unwrap()
                .as_bytes();
            let payload = root.join("payload.txt");
            fs::write(&payload, contents).unwrap();
            set_mode(&payload, 0o644);
            let file_sha256 = sha256(contents);
            component_digests.insert(
                component.to_owned(),
                expected_component_digest(component, contents.len() as u64, &file_sha256),
            );

            let (excluded_credential_paths, credential_references) = if component == "config" {
                let credential = root.join("credentials.json");
                fs::write(&credential, b"credential-canary-must-never-be-packaged").unwrap();
                set_mode(&credential, 0o644);
                (
                    vec![PathBuf::from("credentials.json")],
                    vec!["fixture-secret-reference".to_owned()],
                )
            } else {
                (Vec::new(), Vec::new())
            };
            roots.push(RootSpec {
                label: component.to_owned(),
                role: component.to_owned(),
                path: root,
                stopped_owner_pids: vec![i32::MAX],
                excluded_credential_paths,
                credential_references,
            });
        }

        let provenance = &golden["release_provenance"];
        let request = BundleRequest {
            roots,
            host_label: "host".to_owned(),
            release: ReleaseIdentity {
                source_revision: provenance["source_revision"].as_str().unwrap().to_owned(),
                dirty_snapshot_digest: provenance["dirty_snapshot_digest"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
                component_digests,
                schema_min: provenance["schema_min"].as_u64().unwrap() as u32,
                schema_max: provenance["schema_max"].as_u64().unwrap() as u32,
                protocol_revision: provenance["protocol_revision"].as_str().unwrap().to_owned(),
                pinned_runtime_versions: serde_json::from_value(
                    provenance["pinned_runtime_versions"].clone(),
                )
                .unwrap(),
                image_references: serde_json::from_value(
                    provenance["image_references"].clone(),
                )
                .unwrap(),
                config_digest: provenance["config_digest"].as_str().unwrap().to_owned(),
            },
            home_browser_manifest: serde_json::from_value(
                golden["home_browser_manifest"].clone(),
            )
            .unwrap(),
            external_document_references: vec![
                "sibling-path-dependency:fixture/oxibrain@fixture-revision".to_owned(),
                "pdc:fixture-reference".to_owned(),
            ],
        };
        Self {
            _temporary: temporary,
            request,
            destination: base.join("release-package"),
        }
    }
}

#[test]
fn excluded_credentials_do_not_enter_the_selected_package_or_manifest() {
    let fixture = Fixture::new();
    let receipt = create_release_package(&fixture.request, &fixture.destination).unwrap();


    let manifest_bytes = fs::read(receipt.package_path.join("manifest.json")).unwrap();
    assert!(!String::from_utf8_lossy(&manifest_bytes)
        .contains("credential-canary-must-never-be-packaged"));
    assert!(!receipt
        .package_path
        .join("components/config/credentials.json")
        .exists());
}

#[test]
fn external_manifest_pin_rejects_rewritten_manifest_even_if_package_is_rewritable() {
    let fixture = Fixture::new();
    let receipt = create_release_package(&fixture.request, &fixture.destination).unwrap();
    let manifest = receipt.package_path.join("manifest.json");
    let mut bytes = fs::read(&manifest).unwrap();
    bytes.push(b' ');
    let components = receipt.package_path.join("components");
    let pi = components.join("pi");
    let payload = pi.join("payload.txt");
    set_mode(&receipt.package_path, 0o755);
    set_mode(&components, 0o755);
    set_mode(&pi, 0o755);
    set_mode(&payload, 0o644);
    fs::write(&payload, b"rewritten package component").unwrap();
    set_mode(&payload, 0o444);
    set_mode(&pi, 0o555);
    set_mode(&components, 0o555);
    set_mode(&manifest, 0o644);
    fs::write(&manifest, bytes).unwrap();

    assert!(verify_release_package(&receipt.package_path, &receipt.manifest_sha256).is_err());
}

#[test]
fn verifier_rejects_changed_component_content_after_permissions_are_restored() {
    let fixture = Fixture::new();
    let receipt = create_release_package(&fixture.request, &fixture.destination).unwrap();
    let components = receipt.package_path.join("components");
    let component = components.join("pi");
    let payload = component.join("payload.txt");
    set_mode(&receipt.package_path, 0o755);
    set_mode(&components, 0o755);
    set_mode(&component, 0o755);
    set_mode(&payload, 0o644);
    fs::write(&payload, b"changed copied release content").unwrap();
    set_mode(&payload, 0o444);
    set_mode(&component, 0o555);
    set_mode(&components, 0o555);
    set_mode(&receipt.package_path, 0o500);

    assert!(verify_release_package(&receipt.package_path, &receipt.manifest_sha256).is_err());
}

#[test]
fn rejects_missing_pins_source_drift_destination_collision_and_linked_sources() {
    let fixture = Fixture::new();

    let mut missing_component = fixture.request.clone();
    missing_component.release.component_digests.remove("gateway");
    assert!(create_release_package(
        &missing_component,
        &fixture.destination.with_file_name("missing-component")
    )
    .is_err());

    let mut missing_runtime = fixture.request.clone();
    missing_runtime.release.pinned_runtime_versions.clear();
    assert!(create_release_package(
        &missing_runtime,
        &fixture.destination.with_file_name("missing-runtime")
    )
    .is_err());

    let mut missing_image = fixture.request.clone();
    missing_image.release.image_references.clear();
    assert!(create_release_package(
        &missing_image,
        &fixture.destination.with_file_name("missing-image")
    )
    .is_err());

    let mut drifted_source = Fixture::new();
    let pi_payload = drifted_source
        .request
        .roots
        .iter()
        .find(|root| root.label == "pi")
        .unwrap()
        .path
        .join("payload.txt");
    fs::write(&pi_payload, b"source no longer matches its selected digest").unwrap();
    assert!(create_release_package(&drifted_source.request, &drifted_source.destination).is_err());

    let collision = fixture.destination.with_file_name("existing-destination");
    fs::write(&collision, b"preserve existing destination").unwrap();
    assert!(create_release_package(&fixture.request, &collision).is_err());
    assert_eq!(fs::read(collision).unwrap(), b"preserve existing destination");

    let symlinked_source = Fixture::new();
    let pi_root = symlinked_source
        .request
        .roots
        .iter()
        .find(|root| root.label == "pi")
        .unwrap()
        .path
        .clone();
    let outside = pi_root.parent().unwrap().join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, pi_root.join("escape")).unwrap();
    assert!(create_release_package(
        &symlinked_source.request,
        &symlinked_source.destination
    )
    .is_err());

    let hardlinked_source = Fixture::new();
    let pi_payload = hardlinked_source
        .request
        .roots
        .iter()
        .find(|root| root.label == "pi")
        .unwrap()
        .path
        .join("payload.txt");
    let outside_link = pi_payload.parent().unwrap().parent().unwrap().join("outside-link");
    fs::hard_link(&pi_payload, &outside_link).unwrap();
    assert!(create_release_package(
        &hardlinked_source.request,
        &hardlinked_source.destination
    )
    .is_err());
}

#[test]
fn schema14_is_supported_and_unsupported_schema_is_refused() {
    let schema14 = Fixture::new();
    let mut request = schema14.request.clone();
    request.release.schema_min = 14;
    request.release.schema_max = 14;
    let receipt = create_release_package(
        &request,
        &schema14.destination.with_file_name("schema14-package"),
    )
    .unwrap();
    assert_eq!(receipt.release.schema_min, 14);
    assert!(verify_release_package(
        &receipt.package_path,
        &receipt.manifest_sha256
    )
    .is_ok());

    let mut unsupported = schema14.request.clone();
    unsupported.release.schema_min = 11;
    unsupported.release.schema_max = 11;
    assert!(create_release_package(
        &unsupported,
        &schema14.destination.with_file_name("schema11-package")
    )
    .is_err());
    let mut unsupported_range = schema14.request;
    unsupported_range.release.schema_min = 13;
    unsupported_range.release.schema_max = 14;
    assert!(create_release_package(
        &unsupported_range,
        &schema14.destination.with_file_name("schema-range-package")
    )
    .is_err());
}

fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn expected_component_digest(component: &str, file_size: u64, file_sha256: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"ghost-release-component-inventory/1\0");
    hash_field(&mut hash, component.as_bytes());
    hash.update(2_u64.to_be_bytes());

    hash_field(&mut hash, b"");
    hash.update([1]);
    hash.update(0_u64.to_be_bytes());
    hash.update(0o555_u32.to_be_bytes());
    hash.update([0]);

    hash_field(&mut hash, b"payload.txt");
    hash.update([2]);
    hash.update(file_size.to_be_bytes());
    hash.update(0o444_u32.to_be_bytes());
    hash.update([1]);
    hash_field(&mut hash, file_sha256.as_bytes());
    format!("{:x}", hash.finalize())
}

fn hash_field(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
