#![cfg(all(feature = "host", feature = "lifetime", unix))]

use anyhow::{anyhow, Result};
use ghost::{
    adapters::computer::{
        Authorize, ComputerBackend, ComputerCapabilities, ComputerFuture, ComputerOperation,
    },
    computers::ComputerRegistry,
    lifetime_contract::{canonical_digest, ComputerBinding, Envelope, ResponseStatus, RetryClass, VERSION},
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
use tempfile::TempDir;

// Deliberately test-local and non-executing; never registered by product defaults.
struct FixtureBackend {
    capabilities: ComputerCapabilities,
    configured: bool,
}

impl ComputerBackend for FixtureBackend {
    fn identity(&self) -> &'static str {
        "fixture-computer"
    }

    fn capabilities(&self) -> ComputerCapabilities {
        self.capabilities
    }

    fn configured(&self) -> bool {
        self.configured
    }

    fn execute<'a>(
        &'a self,
        _owner: &'a str,
        _operation: ComputerOperation,
        _authorize: Authorize<'a>,
    ) -> ComputerFuture<'a, Result<Value>> {
        Box::pin(async { Err(anyhow!("fixture backend never executes product work")) })
    }

    fn control<'a>(&'a self, _owner: &'a str, _verb: &'a str) -> ComputerFuture<'a, Result<Value>> {
        Box::pin(async { Err(anyhow!("fixture backend has no runtime control")) })
    }
}

fn full_capabilities() -> ComputerCapabilities {
    ComputerCapabilities {
        browser: true,
        shell: true,
        human_control: false,
        persistent_filesystem: true,
    }
}

fn backend(capabilities: ComputerCapabilities) -> Arc<dyn ComputerBackend> {
    Arc::new(FixtureBackend {
        capabilities,
        configured: true,
    })
}

fn register(registry: &mut ComputerRegistry) {
    registry
        .register_backend(
            backend(full_capabilities()),
            true,
            vec![
                "browser".into(),
                "persistent_filesystem".into(),
                "shell".into(),
            ],
        )
        .unwrap();
}

fn envelope(
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

fn binding(
    epoch: u64,
    grant_revision: u64,
    capabilities: &[&str],
    accepted_capabilities: &[&str],
) -> ComputerBinding {
    binding_for("computer-main", epoch, grant_revision, capabilities, accepted_capabilities)
}

fn binding_for(
    computer_id: &str,
    epoch: u64,
    grant_revision: u64,
    capabilities: &[&str],
    accepted_capabilities: &[&str],
) -> ComputerBinding {
    ComputerBinding {
        computer_id: computer_id.into(),
        ghost_id: "ghost-owner".into(),
        backend: "fixture-computer".into(),
        host_id: "host-fixture".into(),
        epoch,
        capabilities: capabilities.iter().map(|value| (*value).into()).collect(),
        accepted_capabilities: accepted_capabilities
            .iter()
            .map(|value| (*value).into())
            .collect(),
        grant_revision,
    }
}

fn bind_request(command_id: &str, accepted: &[&str]) -> Envelope {
    bind_request_for(command_id, "computer-main", accepted)
}

fn bind_request_for(command_id: &str, computer_id: &str, accepted: &[&str]) -> Envelope {
    envelope(
        command_id,
        "ghost-owner",
        1,
        None,
        json!({
            "method": "bind",
            "binding": binding_for(
                computer_id,
                1,
                1,
                &["browser", "persistent_filesystem", "shell"],
                accepted,
            ),
        }),
    )
}

fn lease_request(command_id: &str, execution_id: &str, kind: &str, epoch: u64) -> Envelope {
    lease_request_for(command_id, "computer-main", execution_id, kind, epoch)
}

fn lease_request_for(
    command_id: &str,
    computer_id: &str,
    execution_id: &str,
    kind: &str,
    epoch: u64,
) -> Envelope {
    envelope(
        command_id,
        "ghost-owner",
        epoch,
        None,
        json!({
            "method": "lease",
            "computer_id": computer_id,
            "execution_id": execution_id,
            "kind": kind,
        }),
    )
}

fn release_request(command_id: &str, execution_id: &str, kind: &str, epoch: u64) -> Envelope {
    envelope(
        command_id,
        "ghost-owner",
        epoch,
        None,
        json!({
            "method": "release",
            "computer_id": "computer-main",
            "execution_id": execution_id,
            "kind": kind,
        }),
    )
}

#[test]
fn binding_dedup_survives_reopen_and_manifests_are_separate_rooted_paths() {
    let root = TempDir::new().unwrap();
    let request = bind_request("bind-durable", &["browser", "persistent_filesystem", "shell"]);
    let first = {
        let mut registry = ComputerRegistry::open(root.path()).unwrap();
        register(&mut registry);
        let response = registry.handle(&request, "ghost-owner").unwrap();
        assert_eq!(response.status, ResponseStatus::Success);
        assert_eq!(response.retry_class, RetryClass::SameId);
        let process_lease = registry
            .handle(
                &lease_request("lease-durable", "execution-durable", "process", 1),
                "ghost-owner",
            )
            .unwrap();
        assert_eq!(process_lease.status, ResponseStatus::Success);
        response
    };

    let home = first.data["home_manifest"]["home_volume"].as_str().unwrap();
    let tasks = first.data["home_manifest"]["task_snapshot_root"].as_str().unwrap();
    let browser = first.data["home_manifest"]["browser_profile"].as_str().unwrap();
    let canonical_root = root.path().canonicalize().unwrap();
    assert!(Path::new(home).starts_with(&canonical_root));
    assert!(Path::new(tasks).starts_with(&canonical_root));
    assert!(Path::new(browser).starts_with(&canonical_root));
    assert!(Path::new(home).is_dir());
    assert!(Path::new(tasks).is_dir());
    assert!(Path::new(browser).is_dir());
    assert_ne!(home, tasks);
    assert_ne!(home, browser);
    assert_ne!(tasks, browser);
    assert_eq!(Path::new(home).parent(), Path::new(tasks).parent());
    assert_eq!(Path::new(tasks).parent(), Path::new(browser).parent());
    assert!(first.data["home_manifest"]["credential_broker"].is_null());

    let mut reopened = ComputerRegistry::open(root.path()).unwrap();
    register(&mut reopened);
    let replay = reopened.handle(&request, "ghost-owner").unwrap();
    assert_eq!(replay, first, "durable command replay returns its immutable response");

    let inspect = reopened
        .handle(
            &envelope(
                "inspect-persisted-lease",
                "ghost-owner",
                1,
                None,
                json!({"method": "inspect", "computer_id": "computer-main"}),
            ),
            "ghost-owner",
        )
        .unwrap();
    assert_eq!(inspect.data["leases"].as_array().unwrap().len(), 1);

    let actor_conflict = envelope(
        "bind-durable",
        "another-ghost",
        1,
        None,
        request.body.clone(),
    );
    assert_eq!(
        reopened
            .handle(&actor_conflict, "another-ghost")
            .unwrap()
            .error_code
            .as_deref(),
        Some("conflict")
    );
    let epoch_conflict = envelope(
        "bind-durable",
        "ghost-owner",
        2,
        None,
        request.body.clone(),
    );
    assert_eq!(
        reopened
            .handle(&epoch_conflict, "ghost-owner")
            .unwrap()
            .error_code
            .as_deref(),
        Some("conflict")
    );

    let changed = envelope(
        "bind-durable",
        "ghost-owner",
        1,
        None,
        json!({"method": "list"}),
    );
    let conflict = reopened.handle(&changed, "ghost-owner").unwrap();
    assert_eq!(conflict.status, ResponseStatus::Error);
    assert_eq!(conflict.error_code.as_deref(), Some("conflict"));
}

#[test]
fn accepted_capabilities_are_backend_trusted_not_caller_self_attested() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register(&mut registry);
    let response = registry
        .handle(&bind_request("bind-untrusted-cap", &["human_control"]), "ghost-owner")
        .unwrap();
    assert_eq!(response.status, ResponseStatus::Error);
    assert_eq!(response.error_code.as_deref(), Some("capability_not_accepted"));
    assert_eq!(
        response.data["trusted_accepted_capabilities"],
        json!(["browser", "persistent_filesystem", "shell"])
    );
}

#[test]
fn authenticated_actor_and_binding_ghost_are_enforced() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register(&mut registry);

    let wrong_actor = envelope(
        "actor-mismatch",
        "another-ghost",
        1,
        None,
        json!({"method": "list"}),
    );
    let actor_response = registry.handle(&wrong_actor, "ghost-owner").unwrap();
    assert_eq!(actor_response.error_code.as_deref(), Some("unauthorized"));

    let mut wrong_binding = binding(
        1,
        1,
        &["browser", "persistent_filesystem", "shell"],
        &["shell"],
    );
    wrong_binding.ghost_id = "another-ghost".into();
    let binding_response = registry
        .handle(
            &envelope(
                "binding-ghost-mismatch",
                "ghost-owner",
                1,
                None,
                json!({"method": "bind", "binding": wrong_binding}),
            ),
            "ghost-owner",
        )
        .unwrap();
    assert_eq!(binding_response.error_code.as_deref(), Some("unauthorized"));

    let list = registry
        .handle(
            &envelope(
                "list-after-denials",
                "ghost-owner",
                1,
                None,
                json!({"method": "list"}),
            ),
            "ghost-owner",
        )
        .unwrap();
    assert_eq!(list.status, ResponseStatus::Success);
    assert_eq!(list.data["computers"], json!([]));
}

#[test]
fn browser_writer_is_exclusive_and_active_leases_block_lifecycle_plans() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register(&mut registry);
    let bound = registry
        .handle(
            &bind_request("bind-leases", &["browser", "persistent_filesystem", "shell"]),
            "ghost-owner",
        )
        .unwrap();
    assert_eq!(bound.status, ResponseStatus::Success);
    let attached = registry.handle(&attach_request("attach-leases", 1, 1, None), "ghost-owner").unwrap();
    assert_eq!(attached.status, ResponseStatus::Success, "{}", attached.summary);
    let home_volume = std::path::PathBuf::from(
        bound.data["home_manifest"]["home_volume"]
            .as_str()
            .unwrap(),
    );

    let persistent_marker = home_volume.join("must-survive-recreate");
    std::fs::write(&persistent_marker, b"persistent home data").unwrap();

    let first_browser = registry
        .handle(&lease_request("browser-first", "execution-a", "browser", 1), "ghost-owner")
        .unwrap();
    assert_eq!(first_browser.status, ResponseStatus::Success);
    let second_browser = registry
        .handle(&lease_request("browser-second", "execution-b", "browser", 1), "ghost-owner")
        .unwrap();
    assert_eq!(second_browser.status, ResponseStatus::Error);
    assert_eq!(second_browser.error_code.as_deref(), Some("lease_conflict"));

    for (command, execution, kind) in [
        ("process-active", "execution-a", "process"),
        ("collect-active", "execution-a", "collect"),
    ] {
        let lease = registry
            .handle(&lease_request(command, execution, kind, 1), "ghost-owner")
            .unwrap();
        assert_eq!(lease.status, ResponseStatus::Success);
    }
    for (command, method) in [("idle-active", "idle_stop"), ("recreate-active", "recreate")] {
        let response = registry
            .handle(
                &envelope(
                    command,
                    "ghost-owner",
                    1,
                    Some(1),
                    json!({"method": method, "computer_id": "computer-main"}),
                ),
                "ghost-owner",
            )
            .unwrap();
        assert_eq!(response.status, ResponseStatus::Error);
        assert_eq!(response.error_code.as_deref(), Some("leases_active"));
    }

    for (command, execution, kind) in [
        ("release-browser", "execution-a", "browser"),
        ("release-process", "execution-a", "process"),
        ("release-collect", "execution-a", "collect"),
    ] {
        let response = registry
            .handle(
                &release_request(command, execution, kind, 1),
                "ghost-owner",
            )
            .unwrap();
        assert_eq!(response.status, ResponseStatus::Success);
        assert_eq!(response.data["released"], true);
    }

    for (command, method) in [("idle-plan", "idle_stop"), ("recreate-plan", "recreate")] {
        let response = registry
            .handle(
                &envelope(
                    command,
                    "ghost-owner",
                    1,
                    Some(1),
                    json!({"method": method, "computer_id": "computer-main"}),
                ),
                "ghost-owner",
            )
            .unwrap();
        assert_eq!(response.status, ResponseStatus::Warning);
        assert_eq!(response.error_code.as_deref(), Some("runtime_not_accepted"));
        assert_eq!(response.data["executed"], false);
        assert_eq!(
            std::fs::read(&persistent_marker).unwrap(),
            b"persistent home data".to_vec(),
            "runtime planning must preserve home contents",
        );
    }
    assert!(home_volume.is_dir());
}

#[test]
fn revoke_fences_leases_advances_epoch_and_clears_acceptance() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register(&mut registry);
    registry
        .handle(
            &bind_request("bind-revoke", &["browser", "persistent_filesystem", "shell"]),
            "ghost-owner",
        )
        .unwrap();
    assert_eq!(
        registry
            .handle(&lease_request("process-before-revoke", "execution-r", "process", 1), "ghost-owner")
            .unwrap()
            .status,
        ResponseStatus::Success
    );

    let revoked = registry
        .handle(
            &envelope(
                "revoke-computer",
                "ghost-owner",
                1,
                Some(1),
                json!({"method": "revoke", "computer_id": "computer-main"}),
            ),
            "ghost-owner",
        )
        .unwrap();
    assert_eq!(revoked.status, ResponseStatus::Success);
    assert_eq!(revoked.data["binding"]["epoch"], 2);
    assert_eq!(revoked.data["binding"]["grant_revision"], 2);
    assert_eq!(revoked.data["accepted_capabilities"], json!([]));
    assert_eq!(revoked.data["leases"], json!([]));
    assert_eq!(revoked.data["revoked"], true);

    let stale = registry
        .handle(&lease_request("process-after-revoke", "execution-r2", "process", 1), "ghost-owner")
        .unwrap();
    assert_eq!(stale.status, ResponseStatus::Error);
    assert_eq!(stale.error_code.as_deref(), Some("revoked"));
}

#[test]
fn capability_downgrade_is_visible_and_requires_an_explicit_rebind() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    register(&mut registry);
    registry
        .handle(&bind_request("bind-downgrade", &["persistent_filesystem", "shell"]), "ghost-owner")
        .unwrap();

    registry
        .register_backend(
            backend(ComputerCapabilities {
                browser: true,
                shell: false,
                human_control: false,
                persistent_filesystem: true,
            }),
            true,
            vec!["browser".into(), "persistent_filesystem".into()],
        )
        .unwrap();
    let inspect = registry
        .handle(
            &envelope(
                "inspect-downgrade",
                "ghost-owner",
                1,
                None,
                json!({"method": "inspect", "computer_id": "computer-main"}),
            ),
            "ghost-owner",
        )
        .unwrap();
    assert_eq!(inspect.status, ResponseStatus::Warning);
    assert_eq!(inspect.error_code.as_deref(), Some("capability_downgrade"));
    assert_eq!(inspect.data["capability_downgrade"], true);
    assert_eq!(inspect.data["binding"]["capabilities"], json!(["browser", "persistent_filesystem"]));
    assert_eq!(inspect.data["binding"]["accepted_capabilities"], json!(["persistent_filesystem"]));

    let stale_capability = registry
        .handle(&lease_request("lease-downgraded-shell", "execution-d", "process", 1), "ghost-owner")
        .unwrap();
    assert_eq!(stale_capability.status, ResponseStatus::Error);
    assert_eq!(stale_capability.error_code.as_deref(), Some("capability_downgrade"));

    let rebound = registry
        .handle(
            &envelope(
                "rebind-after-downgrade",
                "ghost-owner",
                1,
                Some(1),
                json!({
                    "method": "bind",
                    "binding": binding(
                        2,
                        2,
                        &["browser", "persistent_filesystem"],
                        &["persistent_filesystem"],
                    ),
                }),
            ),
            "ghost-owner",
        )
        .unwrap();
    assert_eq!(rebound.status, ResponseStatus::Success);
    assert_eq!(rebound.data["binding"]["epoch"], 2);
    assert_eq!(rebound.data["capability_downgrade"], false);
}

#[test]
fn unavailable_runtime_and_trusted_acceptance_are_reported_separately() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(root.path()).unwrap();
    registry
        .register_backend(backend(full_capabilities()), false, Vec::new())
        .unwrap();

    let bound = registry
        .handle(
            &envelope(
                "bind-offline-backend",
                "ghost-owner",
                1,
                None,
                json!({
                    "method": "bind",
                    "binding": binding(
                        1,
                        1,
                        &["browser", "persistent_filesystem", "shell"],
                        &[],
                    ),
                }),
            ),
            "ghost-owner",
        )
        .unwrap();
    assert_eq!(bound.status, ResponseStatus::Warning);
    assert_eq!(bound.error_code.as_deref(), Some("backend_unavailable"));
    assert_eq!(bound.data["configured"], true);
    assert_eq!(bound.data["available"], false);
    assert_eq!(bound.data["accepted_capabilities"], json!([]));

    let lease = registry
        .handle(
            &lease_request("lease-offline-backend", "execution-offline", "process", 1),
            "ghost-owner",
        )
        .unwrap();
    assert_eq!(lease.status, ResponseStatus::Error);
    assert_eq!(lease.error_code.as_deref(), Some("backend_unavailable"));
}

// ---------------------------------------------------------------------------
// Owned browser gate: attached service, single-writer lease, fencing,
// runtime-accepted lifecycle, and the owner-approved action path.
// ---------------------------------------------------------------------------

fn browser_service(epoch: u64, revision: u64) -> Value {
    browser_service_for("computer-main", epoch, revision)
}

fn browser_service_for(computer_id: &str, epoch: u64, revision: u64) -> Value {
    json!({
        "computer_id": computer_id,
        "ghost_id": "ghost-owner",
        "backend": "fixture-computer",
        "host_id": "host-fixture",
        "epoch": epoch,
        "grant_revision": revision,
        "profile_scope": "public",
        "capabilities": ["browser", "persistent_filesystem", "shell"],
        "accepted_capabilities": ["browser", "persistent_filesystem", "shell"],
    })
}

fn attach_request(command_id: &str, epoch: u64, revision: u64, expected_revision: Option<u64>) -> Envelope {
    attach_request_for(command_id, "computer-main", epoch, revision, expected_revision)
}

fn attach_request_for(
    command_id: &str,
    computer_id: &str,
    epoch: u64,
    revision: u64,
    expected_revision: Option<u64>,
) -> Envelope {
    envelope(
        command_id,
        "ghost-owner",
        epoch,
        expected_revision,
        json!({
            "method": "attach_browser",
            "computer_id": computer_id,
            "service": browser_service_for(computer_id, epoch, revision),
        }),
    )
}

fn typed_runtime(kind: &str, digest: &str) -> ghost::computers::RuntimeFacts {
    ghost::computers::RuntimeFacts::new(kind, digest).unwrap()
}

#[test]
fn browser_service_single_writer_fences_on_revoke_and_reattach() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(&root.path().join("registry")).unwrap();
    register(&mut registry);
    let bound = registry.handle(&bind_request("bind-browser", &["browser", "persistent_filesystem", "shell"]), "ghost-owner").unwrap();
    assert_eq!(bound.status, ResponseStatus::Success, "{:?}", bound.summary);

    // Attach is revision-checked: a replacement must advance one revision.
    assert_eq!(
        registry.handle(&attach_request("attach-1", 1, 1, None), "ghost-owner").unwrap().status,
        ResponseStatus::Success
    );
    let bumped = registry.handle(&attach_request("attach-2", 1, 2, None), "ghost-owner").unwrap();
    assert_eq!(bumped.status, ResponseStatus::Error);
    assert_eq!(bumped.error_code.as_deref(), Some("revision_conflict"));
    assert_eq!(
        registry.handle(&attach_request("attach-3", 1, 2, Some(1)), "ghost-owner").unwrap().status,
        ResponseStatus::Success
    );
    // Browser service revisions advance independently of the computer grant.
    let replaced = registry.handle(&attach_request("attach-independent", 1, 3, Some(2)), "ghost-owner").unwrap();
    assert_eq!(replaced.status, ResponseStatus::Success, "{}", replaced.summary);

    // The scoped profile root always derives from the registry manifest.
    let manifest = registry.browser_service_manifest("computer-main", "ghost-owner", 1).unwrap().unwrap();
    assert!(manifest.browser_profile.ends_with("browser-profile/public"));

    // Single writer: a second execution is refused while the first holds the
    // profile, and a revoked lease can never be resurrected.
    assert!(registry.acquire_browser_lease("computer-main", "ghost-owner", "writer-a", 1).is_ok());
    assert!(registry.acquire_browser_lease("computer-main", "ghost-owner", "writer-b", 1).is_err());
    assert!(registry.browser_lease_is_current("computer-main", "ghost-owner", "writer-a", 1).unwrap());

    // Revoke fences everything: the writer loses its lease mid-flight and a
    // re-attach at the new epoch is the only way back.
    let revoked = registry.handle(
        &envelope("revoke-1", "ghost-owner", 1, Some(1), json!({"method":"revoke","computer_id":"computer-main"})),
        "ghost-owner",
    ).unwrap();
    assert_eq!(revoked.status, ResponseStatus::Success);
    assert!(!registry.browser_lease_is_current("computer-main", "ghost-owner", "writer-a", 1).unwrap());
    assert!(registry.acquire_browser_lease("computer-main", "ghost-owner", "writer-a", 1).is_err());
    assert!(registry.browser_service_manifest("computer-main", "ghost-owner", 1).unwrap().is_none());
    let rebound = registry.handle(
        &envelope("rebind-browser", "ghost-owner", 2, Some(2), json!({
            "method":"bind",
            "binding": binding(3, 3, &["browser", "persistent_filesystem", "shell"], &["browser", "persistent_filesystem", "shell"]),
        })), "ghost-owner",
    ).unwrap();
    assert_eq!(rebound.status, ResponseStatus::Success, "{}", rebound.summary);
    let reattach = registry.handle(&attach_request("attach-4", 3, 5, Some(4)), "ghost-owner").unwrap();
    assert_eq!(reattach.status, ResponseStatus::Success, "{}", reattach.summary);
    assert!(registry.browser_service_manifest("computer-main", "ghost-owner", 3).unwrap().is_some());
}

#[test]
fn lifecycle_requires_explicit_probe_matched_runtime_acceptance() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(&root.path().join("registry")).unwrap();
    register(&mut registry);
    registry.handle(&bind_request("bind-lc", &["browser", "persistent_filesystem", "shell"]), "ghost-owner").unwrap();

    // Without an accepted runtime the plan stays a warning and nothing executes.
    let planned = registry.handle(
        &envelope("recreate-0", "ghost-owner", 1, None, json!({"method":"recreate","computer_id":"computer-main"})),
        "ghost-owner",
    ).unwrap();
    assert_eq!(planned.status, ResponseStatus::Warning);
    assert_eq!(planned.error_code.as_deref(), Some("runtime_not_accepted"));
    assert_eq!(planned.data["executed"], false);

    registry.register_backend_with_runtime(
        backend(full_capabilities()), true,
        vec!["browser".into(), "persistent_filesystem".into(), "shell".into()],
        Some(typed_runtime("local-chromium", &"b".repeat(64))),
    ).unwrap();
    // A declared runtime that differs from the probed registration is refused.
    let mismatch = registry.handle(
        &envelope("accept-bad", "ghost-owner", 1, None, json!({
            "method":"accept_runtime","computer_id":"computer-main",
            "runtime":{"kind":"other-runtime","executable_sha256":"a".repeat(64)},
        })),
        "ghost-owner",
    ).unwrap();
    assert_eq!(mismatch.status, ResponseStatus::Error);
    assert_eq!(mismatch.error_code.as_deref(), Some("runtime_mismatch"));

    // The probed facts are accepted explicitly for this binding epoch, after
    // which the plan becomes an authorization the executor must confirm.
    let accepted = registry.handle(
        &envelope("accept-good", "ghost-owner", 1, None, json!({
            "method":"accept_runtime","computer_id":"computer-main",
            "runtime":{"kind":"local-chromium","executable_sha256":"b".repeat(64)},
        })),
        "ghost-owner",
    ).unwrap();
    assert_eq!(accepted.status, ResponseStatus::Success, "{}", accepted.summary);
    let authorized = registry.handle(
        &envelope("recreate-1", "ghost-owner", 1, None, json!({"method":"recreate","computer_id":"computer-main"})),
        "ghost-owner",
    ).unwrap();
    assert_eq!(authorized.status, ResponseStatus::Success);
    assert_eq!(authorized.data["authorized"], true);
    assert_eq!(authorized.data["executed"], false);

    // The effect is recorded only against a matching authorization.
    let effect = registry.handle(
        &envelope("recreate-1:effect", "ghost-owner", 1, None, json!({
            "method":"lifecycle_effect","computer_id":"computer-main","operation":"recreate",
            "lifecycle_command_id":"recreate-1","outcome":json!({"recreated":true}),
        })),
        "ghost-owner",
    ).unwrap();
    assert_eq!(effect.status, ResponseStatus::Success, "{}", effect.summary);
    assert_eq!(effect.data["executed"], true);
    assert_eq!(effect.data["authorized"], true);

    // Runtime acceptance is per epoch: a rebound computer must re-accept.
    let rebind = registry.handle(
        &envelope("rebind-lc", "ghost-owner", 1, Some(1), json!({
            "method":"bind",
            "binding": binding(2, 2, &["browser", "persistent_filesystem", "shell"], &["browser", "persistent_filesystem", "shell"]),
        })),
        "ghost-owner",
    ).unwrap();
    assert_eq!(rebind.status, ResponseStatus::Success, "{}", rebind.summary);
    let stale = registry.handle(
        &envelope("recreate-2", "ghost-owner", 2, None, json!({"method":"recreate","computer_id":"computer-main"})),
        "ghost-owner",
    ).unwrap();
    assert_eq!(stale.status, ResponseStatus::Error);
    assert_eq!(stale.error_code.as_deref(), Some("stale_runtime_acceptance"));
}

#[test]
fn browser_action_approval_binds_exact_arguments_and_current_leases() {
    let root = TempDir::new().unwrap();
    let mut registry = ComputerRegistry::open(&root.path().join("registry")).unwrap();
    register(&mut registry);
    registry.handle(&bind_request("bind-act", &["browser", "persistent_filesystem", "shell"]), "ghost-owner").unwrap();
    registry.handle(&attach_request("attach-act", 1, 1, None), "ghost-owner").unwrap();

    // The proposing execution holds its worker compute and the browser lease.
    for kind in ["process", "collect"] {
        let leased = registry.handle(
            &lease_request(&format!("lease-act-{kind}"), "execution-1", kind, 1),
            "ghost-owner",
        ).unwrap();
        assert_eq!(leased.status, ResponseStatus::Success, "{}", leased.summary);
    }
    registry.acquire_browser_lease("computer-main", "ghost-owner", "execution-1", 1).unwrap();

    let arguments = json!({"operation":"click","ref":"e7","snapshot_id":4});
    let digest = canonical_digest(&arguments).unwrap();
    let mut registry = registry;
    let action_id = registry
        .propose_browser_action("computer-main", "ghost-owner", "execution-1", &digest, 1, &json!({"operation":"click","ref":"e7","snapshot_id":4}))
        .unwrap();
    // Proposal dedupe: the same exact arguments reuse the same action.
    assert_eq!(
        registry.propose_browser_action("computer-main", "ghost-owner", "execution-1", &digest, 1, &json!({"operation":"click","ref":"e7","snapshot_id":4})).unwrap(),
        action_id
    );
    assert_eq!(registry.browser_action(&action_id).unwrap().unwrap().state, "pending");

    // Owner approval records provenance; the effect only records against the
    // exact approved digest.
    let approved = registry.decide_browser_action(&action_id, "owner-control", true).unwrap();
    assert_eq!(approved.state, "approved");
    assert_eq!(approved.approved_by.as_deref(), Some("owner-control"));
    assert!(registry.decide_browser_action(&action_id, "owner-control", true).is_err());
    registry.record_browser_action_effect(&action_id, &digest).unwrap();
    assert!(registry.record_browser_action_effect(&action_id, &digest).is_err());

    // A stale proposal cannot be approved: the proposing epoch moved on.
    let stale_id = registry
        .propose_browser_action("computer-main", "ghost-owner", "execution-1", &digest, 1, &json!({"operation":"click","ref":"e7","snapshot_id":4}))
        .unwrap();
    registry.handle(
        &envelope("revoke-act", "ghost-owner", 1, Some(1), json!({"method":"revoke","computer_id":"computer-main"})),
        "ghost-owner",
    ).unwrap();
    let refused = registry.decide_browser_action(&stale_id, "owner-control", true);
    assert!(refused.is_err(), "a fenced proposal must not be approvable");
}

/// A fully registered computer scope at epoch 1: binding, attached browser
/// service, worker compute leases, and the browser lease for one execution.
fn registered_scope(
    registry: &mut ComputerRegistry,
    label: &str,
    computer_id: &str,
    execution_id: &str,
) {
    let bound = registry.handle(
        &bind_request_for(&format!("bind-{label}"), computer_id, &["browser", "persistent_filesystem", "shell"]),
        "ghost-owner",
    ).unwrap();
    assert_eq!(bound.status, ResponseStatus::Success, "{}", bound.summary);
    let attached = registry.handle(
        &attach_request_for(&format!("attach-{label}"), computer_id, 1, 1, None),
        "ghost-owner",
    ).unwrap();
    assert_eq!(attached.status, ResponseStatus::Success, "{}", attached.summary);
    for kind in ["process", "collect"] {
        let leased = registry.handle(
            &lease_request_for(&format!("lease-{label}-{kind}"), computer_id, execution_id, kind, 1),
            "ghost-owner",
        ).unwrap();
        assert_eq!(leased.status, ResponseStatus::Success, "{}", leased.summary);
    }
    registry.acquire_browser_lease(computer_id, "ghost-owner", execution_id, 1).unwrap();
}

#[test]
fn proposing_on_one_computer_never_expires_another_and_exact_detail_survives_cold_reopen() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("registry");
    let mut registry = ComputerRegistry::open(&dir).unwrap();
    register(&mut registry);
    registered_scope(&mut registry, "a", "computer-main", "execution-a");
    registered_scope(&mut registry, "b", "computer-second", "execution-b");

    let arguments_a = json!({"operation":"click","ref":"e7","snapshot_id":4});
    let detail_a = json!({
        "operation": "click",
        "target": {"ref": "e7", "label": "Submit order"},
        "snapshot_id": 4,
        "value": null,
        "url": "https://example.test/checkout",
        "arguments": {"operation":"click","ref":"e7","snapshot_id":4},
    });
    let action_a = registry
        .propose_browser_action(
            "computer-main", "ghost-owner", "execution-a",
            &canonical_digest(&arguments_a).unwrap(), 1, &detail_a,
        )
        .unwrap();

    // Proposing on the second computer scope must not touch the first
    // computer's still-current pending action.
    let arguments_b = json!({"operation":"type","ref":"e12","snapshot_id":9,"value":"ghost"});
    let detail_b = json!({
        "operation": "type",
        "target": {"ref": "e12", "label": "Coupon code"},
        "snapshot_id": 9,
        "value": "ghost",
        "url": "https://example.test/cart",
        "arguments": {"operation":"type","ref":"e12","snapshot_id":9,"value":"ghost"},
    });
    let action_b = registry
        .propose_browser_action(
            "computer-second", "ghost-owner", "execution-b",
            &canonical_digest(&arguments_b).unwrap(), 1, &detail_b,
        )
        .unwrap();
    assert_ne!(action_a, action_b);

    let untouched = registry.browser_action(&action_a).unwrap().unwrap();
    assert_eq!(untouched.state, "pending", "a second scope's proposal expired another computer's action");
    assert_eq!(untouched.detail, detail_a);
    let pending_a = registry.pending_browser_actions("computer-main").unwrap();
    assert_eq!(pending_a.len(), 1);
    assert_eq!(pending_a[0].action_id, action_a);
    assert_eq!(pending_a[0].detail, detail_a, "the owner surface must show the exact question, never a digest-only stub");

    // Actionable approval: the exact approved detail drives the recorded effect.
    let approved = registry.decide_browser_action(&action_a, "owner-control", true).unwrap();
    assert_eq!(approved.state, "approved");
    assert_eq!(approved.detail, detail_a);
    registry.record_browser_action_effect(&action_a, &canonical_digest(&arguments_a).unwrap()).unwrap();

    // Refusal transition on the other scope: denied keeps the exact question.
    let denied = registry.decide_browser_action(&action_b, "owner-control", false).unwrap();
    assert_eq!(denied.state, "denied");
    assert_eq!(denied.detail, detail_b);
    drop(registry);

    // Cold reopen: the durable row — not an in-memory cache — must hand back
    // the exact operation/snapshot/target/value/arguments the owner saw.
    let mut registry = ComputerRegistry::open(&dir).unwrap();
    register(&mut registry);
    let reopened_a = registry.browser_action(&action_a).unwrap().unwrap();
    assert_eq!(reopened_a.state, "executed");
    assert_eq!(reopened_a.approved_by.as_deref(), Some("owner-control"));
    assert_eq!(reopened_a.arguments_digest, canonical_digest(&arguments_a).unwrap());
    assert_eq!(reopened_a.detail, detail_a, "exact detail was lost across a cold reopen");
    let reopened_b = registry.browser_action(&action_b).unwrap().unwrap();
    assert_eq!(reopened_b.state, "denied");
    assert_eq!(reopened_b.detail, detail_b);
}

#[test]
fn legacy_registry_without_detail_column_retains_history_and_refuses_uncertifiable_pending() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("registry");
    let mut registry = ComputerRegistry::open(&dir).unwrap();
    register(&mut registry);
    registered_scope(&mut registry, "legacy", "computer-main", "execution-1");
    let arguments = json!({"operation":"click","ref":"e7","snapshot_id":4});
    let detail = json!({
        "operation": "click",
        "target": {"ref": "e7", "label": "Submit order"},
        "snapshot_id": 4,
        "value": null,
        "url": "https://example.test/checkout",
        "arguments": {"operation":"click","ref":"e7","snapshot_id":4},
    });
    let action_id = registry
        .propose_browser_action(
            "computer-main", "ghost-owner", "execution-1",
            &canonical_digest(&arguments).unwrap(), 1, &detail,
        )
        .unwrap();
    drop(registry);

    // Degrade the durable schema to the pre-detail legacy shape: the column
    // (and its stored history) is removed underneath the registry.
    {
        let raw = rusqlite::Connection::open(dir.join("computer-registry.sqlite3")).unwrap();
        raw.execute_batch(
            "PRAGMA wal_checkpoint(TRUNCATE);
             ALTER TABLE computer_browser_actions DROP COLUMN detail_json;",
        ).unwrap();
    }

    // Reopen runs the conservative migration: the column returns with no
    // fabricated default, and the legacy pending row is retained verbatim.
    let mut registry = ComputerRegistry::open(&dir).unwrap();
    register(&mut registry);
    let legacy = registry.browser_action(&action_id).unwrap().unwrap();
    assert_eq!(legacy.state, "pending", "migration must not delete or expire history");
    assert_eq!(legacy.arguments_digest, canonical_digest(&arguments).unwrap());
    assert_eq!(legacy.detail, Value::Null, "legacy missing detail must not be fabricated");
    assert!(registry.pending_browser_actions("computer-main").unwrap().iter().any(|a| a.action_id == action_id));

    // The uncertifiable pending action can be neither approved nor denied;
    // both decisions are refused and the row stays pending (history kept).
    assert!(registry.decide_browser_action(&action_id, "owner-control", true).is_err());
    assert!(registry.decide_browser_action(&action_id, "owner-control", false).is_err());
    assert_eq!(registry.browser_action(&action_id).unwrap().unwrap().state, "pending");

    // Retrying the same proposal must not silently adopt, backfill, or
    // overwrite the legacy row's identity with the new exact detail.
    assert!(registry
        .propose_browser_action(
            "computer-main", "ghost-owner", "execution-1",
            &canonical_digest(&arguments).unwrap(), 1, &detail,
        )
        .is_err(), "a conflicting legacy pending detail must fail closed, not be overwritten");

    // No broad invalidation: a fresh proposal on the same computer at the
    // same epoch is fully actionable, and the legacy row is untouched.
    let fresh_arguments = json!({"operation":"click","ref":"e9","snapshot_id":5});
    let fresh_detail = json!({
        "operation": "click",
        "target": {"ref": "e9", "label": "Review cart"},
        "snapshot_id": 5,
        "value": null,
        "url": "https://example.test/cart",
        "arguments": {"operation":"click","ref":"e9","snapshot_id":5},
    });
    let fresh_id = registry
        .propose_browser_action(
            "computer-main", "ghost-owner", "execution-1",
            &canonical_digest(&fresh_arguments).unwrap(), 1, &fresh_detail,
        )
        .unwrap();
    let approved = registry.decide_browser_action(&fresh_id, "owner-control", true).unwrap();
    assert_eq!(approved.state, "approved");
    assert_eq!(approved.detail, fresh_detail);
    assert_eq!(registry.browser_action(&action_id).unwrap().unwrap().state, "pending");
}
