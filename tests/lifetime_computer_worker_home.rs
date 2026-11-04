#![cfg(all(feature = "host", feature = "lifetime", unix))]

use anyhow::{anyhow, Result};
use ghost::{
    adapters::computer::{
        Authorize, ComputerBackend, ComputerCapabilities, ComputerFuture, ComputerOperation,
    },
    computers::{ComputerRegistry, HomeManifest, NativeWorkerBackendFacts},
    lifetime_contract::{canonical_digest, ComputerBinding, Envelope, ResponseStatus, VERSION},
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
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
        protocol_version: VERSION.into(),
        command_id: command_id.into(),
        payload_digest: canonical_digest(&body).unwrap(),
        actor_ref: actor.into(),
        authority_epoch: epoch,
        expected_revision,
        correlation_id: format!("correlation-{command_id}"),
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

fn bind(
    registry: &mut ComputerRegistry,
    computer_id: &str,
    ghost_id: &str,
    backend: &str,
) -> HomeManifest {
    let binding = ComputerBinding {
        computer_id: computer_id.into(),
        ghost_id: ghost_id.into(),
        backend: backend.into(),
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

fn rebind(
    registry: &mut ComputerRegistry,
    computer_id: &str,
    ghost_id: &str,
    backend: &str,
    current_epoch: u64,
    current_revision: u64,
) -> HomeManifest {
    let binding = ComputerBinding {
        computer_id: computer_id.into(),
        ghost_id: ghost_id.into(),
        backend: backend.into(),
        host_id: "host-test".into(),
        epoch: current_epoch + 1,
        capabilities: native_capabilities(),
        accepted_capabilities: native_capabilities(),
        grant_revision: current_revision + 1,
    };
    let response = registry
        .handle(
            &request(
                &format!("rebind-{computer_id}-{}", current_epoch + 1),
                ghost_id,
                current_epoch,
                Some(current_revision),
                json!({"method": "bind", "binding": binding}),
            ),
            ghost_id,
        )
        .unwrap();
    assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    serde_json::from_value(response.data["home_manifest"].clone()).unwrap()
}

struct FixtureBackend;

impl ComputerBackend for FixtureBackend {
    fn identity(&self) -> &'static str {
        "fixture-computer"
    }

    fn capabilities(&self) -> ComputerCapabilities {
        ComputerCapabilities {
            browser: false,
            shell: true,
            human_control: false,
            persistent_filesystem: true,
        }
    }

    fn configured(&self) -> bool {
        true
    }

    fn execute<'a>(
        &'a self,
        _owner: &'a str,
        _operation: ComputerOperation,
        _authorize: Authorize<'a>,
    ) -> ComputerFuture<'a, Result<Value>> {
        Box::pin(async { Err(anyhow!("test fixture never executes work")) })
    }

    fn control<'a>(&'a self, _owner: &'a str, _verb: &'a str) -> ComputerFuture<'a, Result<Value>> {
        Box::pin(async { Err(anyhow!("test fixture has no runtime control")) })
    }
}

fn bind_execution(
    registry: &mut ComputerRegistry,
    computer_id: &str,
    ghost_id: &str,
    execution_id: &str,
) -> HomeManifest {
    registry
        .acquire_worker_home(computer_id, ghost_id, execution_id, 1)
        .unwrap()
}

#[test]
fn native_backend_facts_are_bounded_and_current_home_requires_trusted_live_capabilities() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    assert!(registry
        .register_native_worker_backend(
            NativeWorkerBackendFacts {
                configured: false,
                available: true,
            },
            native_capabilities(),
        )
        .is_err());
    assert!(registry
        .register_native_worker_backend(
            NativeWorkerBackendFacts {
                configured: true,
                available: true,
            },
            vec!["browser".into()],
        )
        .is_err());

    register_native(&mut registry);
    bind(&mut registry, "computer-native", "ghost-native", NATIVE_BACKEND);
    let manifest = bind_execution(
        &mut registry,
        "computer-native",
        "ghost-native",
        "execution-native",
    );
    assert_ne!(manifest.home_volume, manifest.task_snapshot_root);
    assert_ne!(manifest.home_volume, manifest.browser_profile);
    assert_ne!(manifest.task_snapshot_root, manifest.browser_profile);
    assert!(registry
        .worker_home_is_current(
            "computer-native",
            "ghost-native",
            "execution-native",
            1,
        )
        .unwrap());

    registry
        .register_native_worker_backend(
            NativeWorkerBackendFacts {
                configured: true,
                available: false,
            },
            native_capabilities(),
        )
        .unwrap();
    assert!(!registry
        .worker_home_is_current(
            "computer-native",
            "ghost-native",
            "execution-native",
            1,
        )
        .unwrap());
    assert!(registry
        .acquire_worker_home(
            "computer-native",
            "ghost-native",
            "execution-new",
            1,
        )
        .is_err());
    registry
        .register_native_worker_backend(
            NativeWorkerBackendFacts {
                configured: false,
                available: false,
            },
            native_capabilities(),
        )
        .unwrap();
    assert!(!registry
        .worker_home_is_current(
            "computer-native",
            "ghost-native",
            "execution-native",
            1,
        )
        .unwrap());

    registry
        .register_native_worker_backend(
            NativeWorkerBackendFacts {
                configured: true,
                available: true,
            },
            vec!["shell".into()],
        )
        .unwrap();
    assert!(!registry
        .worker_home_is_current(
            "computer-native",
            "ghost-native",
            "execution-native",
            1,
        )
        .unwrap());
}
#[test]
fn concurrent_cold_open_retains_all_registered_home_writers() {
    let root = TempDir::new().unwrap();
    let barrier = std::sync::Barrier::new(4);
    let homes = std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(4);
        for index in 0..4 {
            let root = root.path();
            let barrier = &barrier;
            handles.push(scope.spawn(move || {
                barrier.wait();
                let mut registry = ComputerRegistry::open(root).unwrap();
                register_native(&mut registry);
                let computer = format!("cold-computer-{index}");
                let ghost = format!("cold-ghost-{index}");
                let execution = format!("cold-execution-{index}");
                bind(&mut registry, &computer, &ghost, NATIVE_BACKEND);
                let home = registry.acquire_worker_home(&computer, &ghost, &execution, 1).unwrap();
                let private = registry.worker_home_lane_directory(&computer, &ghost, &execution, 1, ghost::operations::home_lanes::HomePrivacyLane::Private).unwrap();
                std::fs::write(private.join("persistent-marker"), index.to_string()).unwrap();
                home
            }));
        }
        handles.into_iter().map(|handle| handle.join().unwrap()).collect::<Vec<_>>()
    });
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut registry);
    for (index, home) in homes.into_iter().enumerate() {
        let computer = format!("cold-computer-{index}");
        let ghost = format!("cold-ghost-{index}");
        let execution = format!("cold-execution-{index}");
        assert!(registry.worker_home_is_current(&computer, &ghost, &execution, 1).unwrap());
        assert!(!registry.worker_home_is_current(&computer, "foreign-ghost", &execution, 1).unwrap());
        let private = registry.worker_home_lane_directory(&computer, &ghost, &execution, 1, ghost::operations::home_lanes::HomePrivacyLane::Private).unwrap();
        assert_eq!(std::fs::read_to_string(private.join("persistent-marker")).unwrap(), index.to_string());
    }
}


#[test]
fn home_pair_insert_rolls_back_completely_when_collection_grant_fails() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut registry);
    bind(&mut registry, "computer-atomic", "ghost-atomic", NATIVE_BACKEND);

    {
        let db = rusqlite::Connection::open(root.path().join("computer-registry.sqlite3")).unwrap();
        db.execute_batch(
            "CREATE TRIGGER reject_home_collect BEFORE INSERT ON computer_leases
             WHEN NEW.kind='collect'
             BEGIN
                 SELECT RAISE(ABORT, 'injected collection lease failure');
             END;",
        )
        .unwrap();
    }
    assert!(registry
        .acquire_worker_home("computer-atomic", "ghost-atomic", "execution-atomic", 1)
        .is_err());
    assert!(!registry
        .worker_home_is_current(
            "computer-atomic",
            "ghost-atomic",
            "execution-atomic",
            1,
        )
        .unwrap());
    {
        let db = rusqlite::Connection::open(root.path().join("computer-registry.sqlite3")).unwrap();
        let count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM computer_leases
                 WHERE computer_id='computer-atomic' AND execution_id='execution-atomic'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "the process grant must roll back with collect");
        db.execute_batch("DROP TRIGGER reject_home_collect").unwrap();
    }

    registry
        .acquire_worker_home("computer-atomic", "ghost-atomic", "execution-atomic", 1)
        .unwrap();
    assert!(registry
        .worker_home_is_current(
            "computer-atomic",
            "ghost-atomic",
            "execution-atomic",
            1,
        )
        .unwrap());
}

#[test]
fn home_grant_replay_conflicts_and_epoch_checks_preserve_the_current_writer() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut registry);
    bind(&mut registry, "computer-lease", "ghost-lease", NATIVE_BACKEND);

    let original = registry
        .acquire_worker_home("computer-lease", "ghost-lease", "execution-a", 1)
        .unwrap();
    let replay = registry
        .acquire_worker_home("computer-lease", "ghost-lease", "execution-a", 1)
        .unwrap();
    assert_eq!(replay, original, "a lost acknowledgement replays the same grant");
    assert!(registry
        .acquire_worker_home("computer-lease", "ghost-lease", "execution-b", 1)
        .is_err());
    assert!(!registry
        .worker_home_is_current("computer-lease", "ghost-lease", "execution-b", 1)
        .unwrap());

    assert!(!registry
        .worker_home_is_current("computer-lease", "other-ghost", "execution-a", 1)
        .unwrap());
    assert!(registry
        .acquire_worker_home("computer-lease", "other-ghost", "execution-a", 1)
        .is_err());
    for epoch in [0, 2] {
        assert!(!registry
            .worker_home_is_current("computer-lease", "ghost-lease", "execution-a", epoch)
            .unwrap());
        assert!(registry
            .acquire_worker_home("computer-lease", "ghost-lease", "execution-a", epoch)
            .is_err());
    }
    assert!(registry
        .release_worker_home("computer-lease", "ghost-lease", "execution-a", 2)
        .is_err());
    assert!(registry
        .worker_home_is_current("computer-lease", "ghost-lease", "execution-a", 1)
        .unwrap());
}

#[test]
fn stable_homes_are_isolated_by_computer_and_survive_reopen_without_execution_resurrection() {
    let root = TempDir::new().unwrap();
    use std::os::unix::fs::MetadataExt;
    let first_marker_identity = {
        let mut registry = ComputerRegistry::open(root.path()).unwrap();
        register_native(&mut registry);
        let first = bind(&mut registry, "computer-a", "ghost-a", NATIVE_BACKEND);
        let second = bind(&mut registry, "computer-b", "ghost-b", NATIVE_BACKEND);
        assert_ne!(first.home_volume, second.home_volume);
        assert_ne!(first.task_snapshot_root, second.task_snapshot_root);
        assert_ne!(first.browser_profile, second.browser_profile);
        registry.acquire_worker_home("computer-a", "ghost-a", "execution-old", 1).unwrap();
        let private_a = registry.worker_home_lane_directory("computer-a", "ghost-a", "execution-old", 1, ghost::operations::home_lanes::HomePrivacyLane::Private).unwrap();
        registry.acquire_worker_home("computer-b", "ghost-b", "execution-other", 1).unwrap();
        let private_b = registry.worker_home_lane_directory("computer-b", "ghost-b", "execution-other", 1, ghost::operations::home_lanes::HomePrivacyLane::Private).unwrap();
        let marker = private_a.join("persistent-marker");
        std::fs::write(&marker, b"survives execution and registry reopen").unwrap();
        std::fs::write(private_b.join("persistent-marker"), b"other computer data").unwrap();
        assert_eq!(std::fs::read(&marker).unwrap(), b"survives execution and registry reopen");
        let identity = std::fs::metadata(&marker).unwrap();
        registry
            .release_worker_home("computer-a", "ghost-a", "execution-old", 1)
            .unwrap();
        assert!(registry
            .acquire_worker_home("computer-a", "ghost-a", "execution-old", 1)
            .is_err());
        (identity.dev(), identity.ino())
    };

    let mut reopened = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut reopened);
    assert!(!reopened
        .worker_home_is_current("computer-a", "ghost-a", "execution-old", 1)
        .unwrap());
    reopened.acquire_worker_home("computer-a", "ghost-a", "execution-new", 1).unwrap();
    let private = reopened.worker_home_lane_directory("computer-a", "ghost-a", "execution-new", 1, ghost::operations::home_lanes::HomePrivacyLane::Private).unwrap();
    let metadata = std::fs::metadata(private.join("persistent-marker")).unwrap();
    assert_eq!((metadata.dev(), metadata.ino()), first_marker_identity);
    assert_eq!(
        std::fs::read(private.join("persistent-marker")).unwrap(),
        b"survives execution and registry reopen"
    );
}

#[test]
fn exact_release_is_idempotent_and_cannot_change_another_binding_or_revive_old_work() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut registry);
    bind(&mut registry, "computer-release-a", "ghost-release-a", NATIVE_BACKEND);
    bind(&mut registry, "computer-release-b", "ghost-release-b", NATIVE_BACKEND);
    registry
        .acquire_worker_home("computer-release-a", "ghost-release-a", "execution-a", 1)
        .unwrap();
    registry
        .acquire_worker_home("computer-release-b", "ghost-release-b", "execution-b", 1)
        .unwrap();

    assert!(registry
        .release_worker_home("computer-release-a", "wrong-ghost", "execution-a", 1)
        .is_err());
    assert!(registry
        .release_worker_home("computer-release-a", "ghost-release-a", "execution-a", 2)
        .is_err());
    assert!(registry
        .worker_home_is_current("computer-release-a", "ghost-release-a", "execution-a", 1)
        .unwrap());
    assert!(registry
        .worker_home_is_current("computer-release-b", "ghost-release-b", "execution-b", 1)
        .unwrap());

    registry
        .release_worker_home("computer-release-a", "ghost-release-a", "execution-a", 1)
        .unwrap();
    registry
        .release_worker_home("computer-release-a", "ghost-release-a", "execution-a", 1)
        .unwrap();
    assert!(!registry
        .worker_home_is_current("computer-release-a", "ghost-release-a", "execution-a", 1)
        .unwrap());
    assert!(registry
        .worker_home_is_current("computer-release-b", "ghost-release-b", "execution-b", 1)
        .unwrap());
    assert!(registry
        .acquire_worker_home("computer-release-a", "ghost-release-a", "execution-a", 1)
        .is_err());

    let revoked = registry
        .handle(
            &request(
                "revoke-computer-release-b",
                "ghost-release-b",
                1,
                Some(1),
                json!({"method": "revoke", "computer_id": "computer-release-b"}),
            ),
            "ghost-release-b",
        )
        .unwrap();
    assert_eq!(revoked.status, ResponseStatus::Success, "{revoked:?}");
    assert!(!registry
        .worker_home_is_current("computer-release-b", "ghost-release-b", "execution-b", 1)
        .unwrap());
    assert!(registry
        .acquire_worker_home("computer-release-b", "ghost-release-b", "execution-new", 1)
        .is_err());
}

#[test]
fn revoked_home_reservation_survives_rebind_until_exact_old_epoch_cleanup() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut registry);
    let original_home = bind(&mut registry, "computer-revoked", "ghost-revoked", NATIVE_BACKEND);
    registry
        .acquire_worker_home("computer-revoked", "ghost-revoked", "execution-old", 1)
        .unwrap();

    let revoked = registry
        .handle(
            &request(
                "revoke-computer-revoked",
                "ghost-revoked",
                1,
                Some(1),
                json!({"method": "revoke", "computer_id": "computer-revoked"}),
            ),
            "ghost-revoked",
        )
        .unwrap();
    assert_eq!(revoked.status, ResponseStatus::Success, "{revoked:?}");
    assert!(registry
        .worker_home_cleanup_is_authorized("computer-revoked", "ghost-revoked", "execution-old", 1)
        .unwrap());
    let rebound_home = rebind(
        &mut registry,
        "computer-revoked",
        "ghost-revoked",
        NATIVE_BACKEND,
        2,
        2,
    );
    assert_eq!(rebound_home, original_home);

    assert!(!registry
        .worker_home_is_current("computer-revoked", "ghost-revoked", "execution-old", 1)
        .unwrap());
    assert!(registry
        .worker_home_cleanup_is_authorized("computer-revoked", "ghost-revoked", "execution-old", 1)
        .unwrap());
    assert!(registry
        .acquire_worker_home("computer-revoked", "ghost-revoked", "execution-new", 3)
        .is_err());
    for (owner, execution, epoch) in [
        ("other-ghost", "execution-old", 1),
        ("ghost-revoked", "execution-old", 2),
        ("ghost-revoked", "execution-missing", 1),
        ("ghost-revoked", "execution-old", 4),
    ] {
        assert!(!registry
            .worker_home_cleanup_is_authorized("computer-revoked", owner, execution, epoch)
            .unwrap());
        assert!(registry
            .release_worker_home("computer-revoked", owner, execution, epoch)
            .is_err());
    }
    assert!(registry
        .acquire_worker_home("computer-revoked", "ghost-revoked", "execution-new", 3)
        .is_err());

    registry
        .release_worker_home("computer-revoked", "ghost-revoked", "execution-old", 1)
        .unwrap();
    registry
        .release_worker_home("computer-revoked", "ghost-revoked", "execution-old", 1)
        .unwrap();
    assert!(registry
        .acquire_worker_home("computer-revoked", "ghost-revoked", "execution-old", 3)
        .is_err());
    registry
        .acquire_worker_home("computer-revoked", "ghost-revoked", "execution-new", 3)
        .unwrap();
    assert!(registry
        .worker_home_is_current("computer-revoked", "ghost-revoked", "execution-new", 3)
        .unwrap());
}

#[test]
fn native_legacy_wire_process_and_collection_leases_cannot_bypass_atomic_home_grant() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut registry);
    bind(&mut registry, "computer-native-wire", "ghost-native-wire", NATIVE_BACKEND);

    for kind in ["process", "collect"] {
        let execution_id = format!("legacy-{kind}");
        let response = registry
            .handle(
                &request(
                    &format!("legacy-grant-{kind}"),
                    "ghost-native-wire",
                    1,
                    None,
                    json!({
                        "method": "lease",
                        "computer_id": "computer-native-wire",
                        "execution_id": execution_id,
                        "kind": kind,
                    }),
                ),
                "ghost-native-wire",
            )
            .unwrap();
        assert_eq!(response.status, ResponseStatus::Error);
        assert_eq!(
            response.error_code.as_deref(),
            Some("atomic_home_lease_required")
        );
        registry
            .acquire_worker_home(
                "computer-native-wire",
                "ghost-native-wire",
                &execution_id,
                1,
            )
            .unwrap();
        registry
            .release_worker_home(
                "computer-native-wire",
                "ghost-native-wire",
                &execution_id,
                1,
            )
            .unwrap();
    }
}

#[test]
fn dynamic_computer_backend_keeps_the_same_home_lease_guards() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    registry
        .register_backend(
            Arc::new(FixtureBackend),
            true,
            native_capabilities(),
        )
        .unwrap();
    bind(
        &mut registry,
        "computer-dynamic",
        "ghost-dynamic",
        "fixture-computer",
    );
    for kind in ["process", "collect"] {
        let execution_id = format!("wire-{kind}");
        let granted = registry
            .handle(
                &request(
                    &format!("wire-grant-{kind}"),
                    "ghost-dynamic",
                    1,
                    None,
                    json!({
                        "method": "lease",
                        "computer_id": "computer-dynamic",
                        "execution_id": execution_id,
                        "kind": kind,
                    }),
                ),
                "ghost-dynamic",
            )
            .unwrap();
        assert_eq!(granted.status, ResponseStatus::Success, "{granted:?}");
        let released = registry
            .handle(
                &request(
                    &format!("wire-release-{kind}"),
                    "ghost-dynamic",
                    1,
                    None,
                    json!({
                        "method": "release",
                        "computer_id": "computer-dynamic",
                        "execution_id": execution_id,
                        "kind": kind,
                    }),
                ),
                "ghost-dynamic",
            )
            .unwrap();
        assert_eq!(released.status, ResponseStatus::Success, "{released:?}");
    }
    registry
        .acquire_worker_home("computer-dynamic", "ghost-dynamic", "execution-dynamic", 1)
        .unwrap();
    assert!(registry
        .worker_home_is_current(
            "computer-dynamic",
            "ghost-dynamic",
            "execution-dynamic",
            1,
        )
        .unwrap());
    registry
        .register_backend(
            Arc::new(FixtureBackend),
            false,
            native_capabilities(),
        )
        .unwrap();
    assert!(!registry
        .worker_home_is_current(
            "computer-dynamic",
            "ghost-dynamic",
            "execution-dynamic",
            1,
        )
        .unwrap());
    registry
        .release_worker_home("computer-dynamic", "ghost-dynamic", "execution-dynamic", 1)
        .unwrap();
}

#[test]
fn missing_or_symlinked_home_root_is_never_granted_as_current() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register_native(&mut registry);
    let manifest = bind(&mut registry, "computer-root", "ghost-root", NATIVE_BACKEND);
    let outside = root.path().join("outside-home");
    std::fs::create_dir(&outside).unwrap();
    std::fs::rename(&manifest.home_volume, root.path().join("saved-home-original")).unwrap();
    std::os::unix::fs::symlink(&outside, &manifest.home_volume).unwrap();

    assert!(registry
        .acquire_worker_home("computer-root", "ghost-root", "execution-root", 1)
        .is_err());
    assert!(!registry
        .worker_home_is_current("computer-root", "ghost-root", "execution-root", 1)
        .unwrap());
    assert!(Path::new(&manifest.browser_profile).is_dir());
}
