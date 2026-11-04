#![cfg(all(feature = "lifetime", unix))]

use crate::worker::guest_broker::{GuestBrokerAuthorizationCheck, GuestBrokerConfig, GuestModelBackend};
use crate::worker::guest_runtime::{spawn_guest_legacy_fixture as spawn_guest, GuestRuntimeConfig, GuestRuntimeError};
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};
use tempfile::TempDir;

fn container_cli() -> PathBuf {
    PathBuf::from("/usr/bin/true").canonicalize().unwrap()
}

fn config(root: &Path) -> GuestRuntimeConfig {
    let root = root.canonicalize().unwrap();
    GuestRuntimeConfig {
        container_cli: container_cli(),
        linux_runtime_root: root.join("runtime"),
        source_directory: root.join("source"),
        overlay_file: root.join("omp.json"),
        session_directory: root.join("session"),
        workspace_directory: root.join("workspace"),
        home_directory: root.join("home"),
        control_directory: root.join("control"),
        skills_snapshot: None,
        broker: Arc::new(GuestBrokerConfig {
            version: 1,
            execution_id: "guest-runtime-fixture".into(),
            authority_epoch: 7,
            request_directory: root.join("requests"),
            response_directory: root.join("responses"),
            journal_path: root.join("guest-broker.sqlite"),
            backend: GuestModelBackend::LocalHttp { endpoint: "http://127.0.0.1:9/v1".into() },
            model_id: "fixture/model".into(),
            model_pin: "fixture/model".into(),
            max_tokens: 64,
            context_window: 1024,
            allowed_tools: vec!["read".into(), "write".into(), "edit".into(), "bash".into(), "grep".into(),
                "glob".into(), "ast_grep".into(), "ast_edit".into(), "eval".into(), "todo".into(), "publish_artifact".into()],
            deadline_ms: 1_000,
            max_requests: 2,
        }),
    }
}

fn authorization(config: &GuestRuntimeConfig) -> GuestBrokerAuthorizationCheck {
    let execution_id = config.broker.execution_id.clone();
    let epoch = config.broker.authority_epoch;
    Arc::new(move |candidate, candidate_epoch| {
        candidate == execution_id.as_str() && candidate_epoch == epoch
    })
}

fn private_directory(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn prepare_paths(root: &TempDir, config: &GuestRuntimeConfig) {
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    private_directory(&config.linux_runtime_root);
    fs::create_dir(&config.source_directory).unwrap();
    fs::set_permissions(&config.source_directory, fs::Permissions::from_mode(0o555)).unwrap();
    fs::write(&config.overlay_file, b"{}").unwrap();
    fs::set_permissions(&config.overlay_file, fs::Permissions::from_mode(0o600)).unwrap();
    private_directory(&config.session_directory);
    private_directory(&config.workspace_directory);
    private_directory(&config.home_directory);
    private_directory(&config.control_directory);
    private_directory(&config.broker.request_directory);
    private_directory(&config.broker.response_directory);
}

#[test]
fn authorization_is_checked_before_any_runtime_path_access() {
    let root = TempDir::new().unwrap();
    let mut config = config(root.path());
    config.container_cli = root.path().join("missing-container-cli");
    let denied: GuestBrokerAuthorizationCheck = Arc::new(|_, _| false);

    let result = spawn_guest(config, denied);

    assert!(matches!(result, Err(GuestRuntimeError::Unauthorized)));
}

#[test]
fn symlink_runtime_root_is_rejected_before_container_probe() {
    let root = TempDir::new().unwrap();
    let target = root.path().join("runtime-target");
    fs::create_dir(&target).unwrap();
    let linked = root.path().join("runtime-link");
    symlink(target, &linked).unwrap();
    let mut config = config(root.path());
    config.linux_runtime_root = linked;

    let authorization = authorization(&config);
    let result = spawn_guest(config, authorization);

    assert!(matches!(result, Err(GuestRuntimeError::InvalidConfig)));
}

#[test]
fn occupied_control_directory_is_not_reused_or_overwritten() {
    let root = TempDir::new().unwrap();
    let mut config = config(root.path());
    let broker = Arc::get_mut(&mut config.broker).unwrap();
    broker.max_tokens = 4096;
    broker.context_window = 16_384;
    prepare_paths(&root, &config);
    let marker = config.control_directory.join("existing-state.json");
    fs::write(&marker, b"preserve this state").unwrap();

    let authorization = authorization(&config);
    let result = spawn_guest(config, authorization);

    assert!(matches!(result, Err(GuestRuntimeError::Reservation)));
    assert_eq!(fs::read(&marker).unwrap(), b"preserve this state");
}
