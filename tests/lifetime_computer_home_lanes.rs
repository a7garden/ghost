#![cfg(all(feature = "host", feature = "lifetime", unix))]

use ghost::computers::{ComputerRegistry, HomeManifest, NativeWorkerBackendFacts};
use ghost::lifetime_contract::{canonical_digest, ComputerBinding, Envelope, ResponseStatus};
use ghost::operations::home_lanes::{open_layout_by_marker_at_root, HomeLayout};
use serde_json::{json, Value};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use tempfile::TempDir;

const NATIVE_BACKEND: &str = "apple-native-omp";
const HOME_CAPABILITIES: [&str; 2] = ["persistent_filesystem", "shell"];

fn request(
    command_id: &str,
    actor: &str,
    epoch: u64,
    expected_revision: Option<u64>,
    body: Value,
) -> Envelope {
    Envelope {
        protocol_version: ghost::lifetime_contract::VERSION.into(),
        payload_digest: canonical_digest(&body).unwrap(),
        actor_ref: actor.into(),
        authority_epoch: epoch,
        expected_revision,
        correlation_id: format!("correlation-{command_id}"),
        command_id: command_id.into(),
        body,
    }
}

fn native_capabilities() -> Vec<String> {
    HOME_CAPABILITIES.iter().map(|capability| (*capability).into()).collect()
}

fn register_native(registry: &mut ComputerRegistry) {
    registry
        .register_native_worker_backend(
            NativeWorkerBackendFacts {
                configured: true,
                available: true,
            },
            native_capabilities(),
        )
        .unwrap();
}

fn bind(registry: &mut ComputerRegistry, computer_id: &str, ghost_id: &str) -> HomeManifest {
    let binding = ComputerBinding {
        computer_id: computer_id.into(),
        ghost_id: ghost_id.into(),
        backend: NATIVE_BACKEND.into(),
        host_id: "host-test".into(),
        epoch: 1,
        capabilities: native_capabilities(),
        accepted_capabilities: native_capabilities(),
        grant_revision: 1,
    };
    let response = registry
        .handle(
            &request(
                &format!("bind-{computer_id}"),
                ghost_id,
                1,
                None,
                json!({"method": "bind", "binding": binding}),
            ),
            ghost_id,
        )
        .unwrap();
    assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    serde_json::from_value(response.data["home_manifest"].clone()).unwrap()
}

fn migrate(registry: &mut ComputerRegistry, command: &str, computer: &str, ghost: &str) -> ghost::lifetime_contract::Response {
    let body = json!({"method": "migrate_home", "computer_id": computer});
    registry
        .migrate_home(&request(command, ghost, 1, None, body), ghost)
        .unwrap()
}

fn layout(home: &std::path::Path, computer: &str) -> HomeLayout {
    open_layout_by_marker_at_root(home, computer).unwrap()
}

#[test]
fn fresh_bindings_provision_both_lanes_and_admission_tracks_the_root_exactly() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut registry);
    let manifest = bind(&mut registry, "computer-lanes", "ghost-lanes");

    let lanes = layout(&manifest.home_volume, "computer-lanes");
    let public = lanes.public;
    let private = lanes.private;
    for lane in [&public, &private] {
        let metadata = std::fs::symlink_metadata(lane).unwrap();
        assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
        assert_eq!(metadata.mode() & 0o777, 0o700);
    }
    registry
        .acquire_worker_home("computer-lanes", "ghost-lanes", "execution-lanes", 1)
        .unwrap();
    assert!(registry
        .worker_home_is_current("computer-lanes", "ghost-lanes", "execution-lanes", 1)
        .unwrap());

    // A single stray original at the root is legacy state: every worker
    // grant and currency check fails closed until the operator migration.
    std::fs::write(manifest.home_volume.join("leftover-notes"), b"private").unwrap();
    let error = registry
        .acquire_worker_home("computer-lanes", "ghost-lanes", "execution-next", 1)
        .unwrap_err();
    assert!(error.to_string().contains("migrate-home"), "{error}");
    assert!(!registry
        .worker_home_is_current("computer-lanes", "ghost-lanes", "execution-lanes", 1)
        .unwrap());

    std::fs::remove_file(manifest.home_volume.join("leftover-notes")).unwrap();
    // The first execution still holds its lease pair, so a second execution
    // cannot acquire: the refused admission error above must not corrupt the
    // lease bookkeeping either.
    registry
        .acquire_worker_home("computer-lanes", "ghost-lanes", "execution-next", 1)
        .unwrap_err();
    registry
        .release_worker_home("computer-lanes", "ghost-lanes", "execution-lanes", 1)
        .unwrap();
    registry
        .acquire_worker_home("computer-lanes", "ghost-lanes", "execution-next", 1)
        .unwrap();
}

#[test]
fn migrate_home_moves_legacy_originals_into_the_private_lane_without_loss() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut registry);
    let manifest = bind(&mut registry, "computer-migrate", "ghost-migrate");
    let home = &manifest.home_volume;
    std::fs::write(home.join("dotfile"), b"original bytes").unwrap();
    std::fs::create_dir(home.join("project-dir")).unwrap();
    std::fs::write(home.join("project-dir").join("inside"), b"nested").unwrap();
    std::os::unix::fs::symlink("dotfile", home.join("linked")).unwrap();

    let response = migrate(&mut registry, "migrate-1", "computer-migrate", "ghost-migrate");
    assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    let outcome = response.data["outcome"].clone();
    assert_eq!(outcome["status"], "migrated");
    assert_eq!(outcome["preserved_identity"], true);
    let moved = outcome["moved"].as_array().unwrap();
    let moved_names: Vec<&str> = moved.iter().map(|name| name.as_str().unwrap()).collect();
    assert_eq!(moved_names, vec!["dotfile", "linked", "project-dir"]);

    let private = layout(home, "computer-migrate").private;
    assert_eq!(std::fs::read(private.join("dotfile")).unwrap(), b"original bytes");
    assert_eq!(
        std::fs::read_to_string(private.join("project-dir").join("inside")).unwrap(),
        "nested"
    );
    assert_eq!(
        std::fs::read_link(private.join("linked")).unwrap(),
        std::path::Path::new("dotfile")
    );
    registry
        .acquire_worker_home("computer-migrate", "ghost-migrate", "execution-migrated", 1)
        .unwrap();
}

#[test]
fn migrate_home_refuses_busy_leases_until_the_original_is_settled() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut registry);
    let manifest = bind(&mut registry, "computer-busy", "ghost-busy");

    registry
        .acquire_worker_home("computer-busy", "ghost-busy", "execution-busy", 1)
        .unwrap();
    std::fs::write(manifest.home_volume.join("legacy"), b"x").unwrap();
    let busy = migrate(&mut registry, "migrate-busy", "computer-busy", "ghost-busy");
    assert_eq!(busy.status, ResponseStatus::Error);
    assert_eq!(busy.error_code.as_deref(), Some("home_lease_held"));
    assert!(manifest.home_volume.join("legacy").exists(), "refused migration must not move anything");

    // A revoked reservation is a cleanup tombstone: it blocks migration the
    // same way until the original worker's cleanup is proven and released.
    let revoked = registry.handle(
        &request(
            "revoke-busy",
            "ghost-busy",
            1,
            Some(1),
            json!({"method": "revoke", "computer_id": "computer-busy"}),
        ),
        "ghost-busy",
    ).unwrap();
    assert_eq!(revoked.status, ResponseStatus::Success, "{revoked:?}");
    let binding = ComputerBinding {
        computer_id: "computer-busy".into(),
        ghost_id: "ghost-busy".into(),
        backend: NATIVE_BACKEND.into(),
        host_id: "host-test".into(),
        epoch: 3,
        capabilities: native_capabilities(),
        accepted_capabilities: native_capabilities(),
        grant_revision: 3,
    };
    let rebind = registry.handle(
        &request(
            "rebind-busy",
            "ghost-busy",
            2,
            Some(2),
            json!({"method": "bind", "binding": binding}),
        ),
        "ghost-busy",
    ).unwrap();
    assert_eq!(rebind.status, ResponseStatus::Success, "{rebind:?}");
    let tombstone = registry
        .migrate_home(
            &request(
                "migrate-tombstone",
                "ghost-busy",
                3,
                None,
                json!({"method": "migrate_home", "computer_id": "computer-busy"}),
            ),
            "ghost-busy",
        )
        .unwrap();
    assert_eq!(tombstone.status, ResponseStatus::Error);
    assert_eq!(tombstone.error_code.as_deref(), Some("home_lease_held"));

    registry
        .release_worker_home("computer-busy", "ghost-busy", "execution-busy", 1)
        .unwrap();
    let settled = registry
        .migrate_home(
            &request(
                "migrate-settled",
                "ghost-busy",
                3,
                None,
                json!({"method": "migrate_home", "computer_id": "computer-busy"}),
            ),
            "ghost-busy",
        )
        .unwrap();
    assert_eq!(settled.status, ResponseStatus::Success, "{settled:?}");
    assert!(layout(&manifest.home_volume, "computer-busy").private.join("legacy").is_file());
}

#[test]
fn forged_lane_roots_refuse_migration_and_worker_grants() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut registry);
    let manifest = bind(&mut registry, "computer-forged", "ghost-forged");
    let private = layout(&manifest.home_volume, "computer-forged").private;
    std::fs::remove_dir(&private).unwrap();
    let outside = root.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, &private).unwrap();

    let forged = migrate(&mut registry, "migrate-forged", "computer-forged", "ghost-forged");
    assert_eq!(forged.status, ResponseStatus::Error);
    assert_eq!(forged.error_code.as_deref(), Some("home_root_forged"));
    assert!(registry
        .acquire_worker_home("computer-forged", "ghost-forged", "execution-forged", 1)
        .is_err());
}

#[test]
fn interrupted_migration_stays_unknown_until_explicit_resolution() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut registry);
    let manifest = bind(&mut registry, "computer-crash", "ghost-crash");
    let home = &manifest.home_volume;
    std::fs::write(home.join("legacy"), b"untouched").unwrap();

    // A crashed predecessor: its attempt is durable but never completed.
    {
        let connection = rusqlite::Connection::open(root.path().join("computer-registry.sqlite3")).unwrap();
        connection
            .execute(
                "INSERT INTO computer_lifecycle_attempts(
                     attempt_id, computer_id, operation, actor_ref, authority_epoch,
                     state, instance_json, outcome_json, started_at_ms)
                 VALUES ('attempt-crash', 'computer-crash', 'migrate_home', 'ghost-crash', 1,
                         'authorized', '{\"entries\":[]}', NULL, 1)",
                [],
            )
            .unwrap();
    }

    let blocked = migrate(&mut registry, "migrate-blocked", "computer-crash", "ghost-crash");
    assert_eq!(blocked.status, ResponseStatus::Warning);
    assert_eq!(blocked.error_code.as_deref(), Some("lifecycle_outcome_unknown"));
    assert!(home.join("legacy").exists(), "a blocked migration must not touch the home");
    assert!(registry
        .acquire_worker_home("computer-crash", "ghost-crash", "execution-crash", 1)
        .is_err());

    registry
        .resolve_lifecycle_attempt(
            "attempt-crash",
            json!({"outcome": "crashed before any movement; home verified unchanged"}),
            "operator",
        )
        .unwrap();
    let resumed = migrate(&mut registry, "migrate-resumed", "computer-crash", "ghost-crash");
    assert_eq!(resumed.status, ResponseStatus::Success, "{resumed:?}");
    assert_eq!(resumed.data["outcome"]["status"], "migrated");
    assert!(layout(home, "computer-crash").private.join("legacy").is_file());
}

#[test]
fn legacy_reserved_names_and_forged_marker_never_declassify_originals() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut registry);
    let manifest = bind(&mut registry, "computer-legacy", "ghost-legacy");
    let old = layout(&manifest.home_volume, "computer-legacy");
    let old_name = old.layout_root.file_name().unwrap().to_owned();
    std::fs::write(old.public.join("original-secret"), b"legacy private bytes").unwrap();
    for name in ["public", "private"] {
        let directory = manifest.home_volume.join(name);
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(directory.join("original"), name.as_bytes()).unwrap();
    }
    // This is an old unclassified home, not a registry-attested layout.
    let connection = rusqlite::Connection::open(root.path().join("computer-registry.sqlite3")).unwrap();
    connection.execute("DELETE FROM computer_home_layouts WHERE computer_id='computer-legacy'", []).unwrap();
    drop(connection);
    assert!(registry.acquire_worker_home("computer-legacy", "ghost-legacy", "refused", 1).is_err());
    let result = migrate(&mut registry, "legacy-migration", "computer-legacy", "ghost-legacy");
    assert_eq!(result.status, ResponseStatus::Success, "{result:?}");
    let migrated = layout(&manifest.home_volume, "computer-legacy");
    assert!(!migrated.public.join(&old_name).exists(), "unregistered legacy layout must not remain public");
    assert_eq!(std::fs::read(migrated.private.join(old_name).join("public/original-secret")).unwrap(), b"legacy private bytes");
    for name in ["public", "private"] {
        assert_eq!(std::fs::read(migrated.private.join(name).join("original")).unwrap(), name.as_bytes());
    }
    registry.acquire_worker_home("computer-legacy", "ghost-legacy", "admitted-after-migration", 1).unwrap();
}

#[test]
fn migration_never_overwrites_private_originals_and_requires_unknown_resolution() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut registry);
    let manifest = bind(&mut registry, "computer-collision", "ghost-collision");
    let lanes = layout(&manifest.home_volume, "computer-collision");
    let incoming = manifest.home_volume.join("original");
    let protected = lanes.private.join("original");
    std::fs::write(&incoming, b"incoming original").unwrap();
    std::fs::write(&protected, b"existing private original").unwrap();
    let incoming_ino = std::fs::symlink_metadata(&incoming).unwrap().ino();
    let protected_ino = std::fs::symlink_metadata(&protected).unwrap().ino();
    let refused = migrate(&mut registry, "collision-first", "computer-collision", "ghost-collision");
    assert_eq!(refused.status, ResponseStatus::Warning, "{refused:?}");
    assert_eq!(refused.error_code.as_deref(), Some("migration_outcome_unknown"));
    assert_eq!(std::fs::read(&incoming).unwrap(), b"incoming original");
    assert_eq!(std::fs::read(&protected).unwrap(), b"existing private original");
    assert_eq!(std::fs::symlink_metadata(&incoming).unwrap().ino(), incoming_ino);
    assert_eq!(std::fs::symlink_metadata(&protected).unwrap().ino(), protected_ino);
    let repeated = migrate(&mut registry, "collision-new", "computer-collision", "ghost-collision");
    assert_eq!(repeated.error_code.as_deref(), Some("lifecycle_outcome_unknown"));
    assert!(registry.acquire_worker_home("computer-collision", "ghost-collision", "refused-work", 1).is_err());
}
