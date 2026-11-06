//! Owner-chosen Ghost names, the main Ghost, and Pi availability in the snapshot.
use crate::{
    control::api::{Action, Command, OwnerAction},
    host::Host,
    store::ProfileStore,
};
use serde_json::Value;

fn command(app: &std::sync::Arc<Host>, action: OwnerAction) -> Value {
    app.action(Action { request_id: uuid::Uuid::new_v4().to_string(), command: Command::Workspace { action } }).unwrap()
}

fn profile<'a>(snapshot: &'a Value, id: &str) -> &'a Value {
    snapshot["profiles"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap()
}

#[tokio::test]
async fn display_name_is_validated_saved_and_cleared() {
    let dir = tempfile::tempdir().unwrap();
    let id = ProfileStore::create_profile(dir.path(), "primary", "").unwrap().uuid;
    let app = Host::open(dir.path(), tokio::runtime::Handle::current(), None).unwrap();
    assert!(profile(&app.snapshot().unwrap(), &id)["display_name"].is_null());

    let saved = command(&app, OwnerAction::ProfileDisplayName { profile_id: id.clone(), display_name: "  조사 담당  ".into() });
    assert_eq!(saved["ok"], true, "{saved}");
    let snapshot = app.snapshot().unwrap();
    assert_eq!(profile(&snapshot, &id)["display_name"], "조사 담당");
    assert_eq!(profile(&snapshot, &id)["name"], "primary", "the profile identifier is unchanged");

    for invalid in ["가".repeat(41), "줄\n바꿈".into()] {
        let rejected = command(&app, OwnerAction::ProfileDisplayName { profile_id: id.clone(), display_name: invalid });
        assert_eq!(rejected["ok"], false, "{rejected}");
    }
    assert_eq!(profile(&app.snapshot().unwrap(), &id)["display_name"], "조사 담당", "a rejected name keeps the saved one");
    assert_eq!(command(&app, OwnerAction::ProfileDisplayName { profile_id: "missing".into(), display_name: "x".into() })["ok"], false);

    assert_eq!(command(&app, OwnerAction::ProfileDisplayName { profile_id: id.clone(), display_name: " ".into() })["ok"], true);
    assert!(profile(&app.snapshot().unwrap(), &id)["display_name"].is_null());
}

#[tokio::test]
async fn main_ghost_is_set_cleared_and_dropped_for_unknown_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let first = ProfileStore::create_profile(dir.path(), "first", "").unwrap().uuid;
    let second = ProfileStore::create_profile(dir.path(), "second", "").unwrap().uuid;
    let app = Host::open(dir.path(), tokio::runtime::Handle::current(), None).unwrap();
    assert!(app.snapshot().unwrap()["default_ghost"].is_null());

    assert_eq!(command(&app, OwnerAction::DefaultGhost { profile_id: Some(second.clone()) })["ok"], true);
    assert_eq!(app.snapshot().unwrap()["default_ghost"], second);
    assert_eq!(command(&app, OwnerAction::DefaultGhost { profile_id: Some("missing".into()) })["ok"], false);
    assert_eq!(app.snapshot().unwrap()["default_ghost"], second, "an invalid choice keeps the current main Ghost");
    assert_eq!(command(&app, OwnerAction::DefaultGhost { profile_id: Some(first.clone()) })["ok"], true);
    assert_eq!(app.snapshot().unwrap()["default_ghost"], first);
    assert_eq!(command(&app, OwnerAction::DefaultGhost { profile_id: None })["ok"], true);
    assert!(app.snapshot().unwrap()["default_ghost"].is_null());

    // A stored choice that no longer names a Ghost is not reported.
    app.lock().unwrap().journal.put("meta", "default_ghost", &"removed-ghost").unwrap();
    assert!(app.snapshot().unwrap()["default_ghost"].is_null());
}

#[cfg(feature = "lifetime")]
#[tokio::test]
async fn snapshot_reports_no_runtime_when_the_host_has_no_pi() {
    let dir = tempfile::tempdir().unwrap();
    ProfileStore::create_profile(dir.path(), "primary", "").unwrap();
    let app = Host::open(dir.path(), tokio::runtime::Handle::current(), None).unwrap();
    // The test binary has no bundled ghost-pi beside it and no Pi entry is configured.
    assert!(std::env::var_os("GHOST_LIFETIME_PI_ENTRY").is_none());
    assert_eq!(app.snapshot().unwrap()["lifetime_authority"]["runtime_available"], false);
}
