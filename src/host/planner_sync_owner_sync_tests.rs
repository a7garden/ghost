//! Production connected-planner entrypoint boundaries: explicit lease-store
//! gating, adapter identity, connection states, and the read-only sync rule.
//! No test here reaches Google or any remote network; transport-level loops
//! remain covered by the loopback fixture suites.
use super::{production_adapter, pending_operation_ids, record_sync_ledger, sync_ledger};
use crate::control::api::{Action, Command, OwnerAction};
use crate::host::planner_sync::{
    fixtures::{configure_fixture, ics, mutation, Synthetic},
    google_test_support::{configure_google, enqueue, host},
    CollectionInput, Host, Kind, SyncPhase, Verb, WireFormat,
};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

static STORE_ENV_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

struct StoreEnvGuard {
    _lock: parking_lot::MutexGuard<'static, ()>,
    previous: Option<std::ffi::OsString>,
}

impl StoreEnvGuard {
    fn set(path: Option<std::ffi::OsString>) -> Self {
        let _lock = STORE_ENV_LOCK.lock();
        let previous = std::env::var_os(crate::adapters::personal_connectors::google_oauth::TOKEN_STORE_ENV);
        match path {
            Some(path) => std::env::set_var(
                crate::adapters::personal_connectors::google_oauth::TOKEN_STORE_ENV,
                path,
            ),
            None => std::env::remove_var(
                crate::adapters::personal_connectors::google_oauth::TOKEN_STORE_ENV,
            ),
        }
        Self { _lock, previous }
    }
}

impl Drop for StoreEnvGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var(
                crate::adapters::personal_connectors::google_oauth::TOKEN_STORE_ENV,
                value,
            ),
            None => std::env::remove_var(
                crate::adapters::personal_connectors::google_oauth::TOKEN_STORE_ENV,
            ),
        }
    }
}

fn valid_store_bytes(account: &str) -> String {
    let expires = (SystemTime::now() + Duration::from_secs(3600))
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    format!(
        r#"{{"schema":"ghost-google-lease/1","account_ref":"{account}","access_token":"t","expires_at_ms":{expires},"scopes":["https://www.googleapis.com/auth/calendar.events.readonly"],"refresh_token":"r"}}"#
    )
}

fn write_store(root: &std::path::Path, account: &str) -> std::path::PathBuf {
    let path = root.join("google-lease.json");
    std::fs::write(&path, valid_store_bytes(account)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    path
}

fn ical_collection(binding: &str) -> CollectionInput {
    CollectionInput {
        id: "c".into(),
        binding: binding.into(),
        kind: Kind::Event,
        wire_format: WireFormat::ICalendar,
        phase: SyncPhase::ExplicitActive,
        account_ref: None,
        collection_ref: None,
        profiles: vec![],
        enabled: true,
    }
}

#[test]
fn production_adapter_requires_a_https_ical_binding_and_exact_google_identity() {
    assert!(production_adapter(&ical_collection("fixture:c"), None).is_err());
    let adapter = production_adapter(&ical_collection("https://cal.example.com/dav/"), None)
        .unwrap();
    let collection = crate::host::planner_sync::Collection {
        input: ical_collection("https://cal.example.com/dav/"),
        generation: 1,
    };
    super::verify_adapter_identity(&collection, adapter.as_ref()).unwrap();
}

#[test]
fn production_adapter_requires_exact_google_references() {
    let leases = Arc::new(FixtureLeases);
    let mut input = ical_collection("binding");
    input.wire_format = WireFormat::GoogleCalendar;
    input.kind = Kind::Event;
    assert!(
        production_adapter(&input, Some(leases.clone()))
            .err()
            .unwrap()
            .to_string()
            .contains("exact account reference")
    );
    input.account_ref = Some("account".into());
    assert!(
        production_adapter(&input, Some(leases.clone()))
            .err()
            .unwrap()
            .to_string()
            .contains("exact collection reference")
    );
    input.collection_ref = Some("cal-1".into());
    input.phase = SyncPhase::ReadOnlyImport;
    let adapter = production_adapter(&input, Some(leases)).unwrap();
    let collection = crate::host::planner_sync::Collection {
        input,
        generation: 3,
    };
    super::verify_adapter_identity(&collection, adapter.as_ref()).unwrap();
}

struct FixtureLeases;

impl crate::adapters::personal_connectors::google_oauth::GoogleTokenLeaseProvider for FixtureLeases {
    fn lease<'a>(
        &'a self,
        _account_ref: &'a str,
        _required_scopes: &'a [crate::adapters::personal_connectors::google_oauth::GoogleScope],
    ) -> crate::adapters::personal_connectors::google_oauth::GoogleTokenLeaseFuture<'a> {
        Box::pin(async move {
            Err(anyhow::anyhow!("fixture lease provider never grants"))
        })
    }
}

#[test]
fn connection_state_reflects_store_and_binding_without_network() {
    assert_eq!(super::connection_state(&ical_collection("fixture:c")), "unconnected");
    assert_eq!(
        super::connection_state(&ical_collection("https://cal.example.com/dav/")),
        "anonymous_configured"
    );
    let mut google = ical_collection("fixture-google:c");
    google.wire_format = WireFormat::GoogleCalendar;
    google.account_ref = Some("fixture-account".into());
    google.collection_ref = Some("fixture-c".into());
    let _guard = StoreEnvGuard::set(None);
    assert_eq!(super::connection_state(&google), "credential_required");
}

#[test]
fn a_valid_store_lease_marks_the_google_connection_configured() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_store(dir.path(), "fixture-account");
    let _guard = StoreEnvGuard::set(Some(path.into_os_string()));
    let mut google = ical_collection("fixture-google:c");
    google.wire_format = WireFormat::GoogleCalendar;
    google.account_ref = Some("fixture-account".into());
    google.collection_ref = Some("fixture-c".into());
    assert_eq!(super::connection_state(&google), "anonymous_configured");
    let mut other = google.clone();
    other.account_ref = Some("someone-else".into());
    assert_eq!(super::connection_state(&other), "credential_required");
}

#[tokio::test]
async fn sync_ledger_keeps_last_success_across_failures_and_clears_on_success() {
    let (_root, app) = host();
    let state = || app.lock().unwrap();
    record_sync_ledger(&state().journal.0, "c", true, None).unwrap();
    let (attempt, success, error) = sync_ledger(&state().journal.0, "c").unwrap();
    assert!(attempt.is_some() && success.is_some() && error.is_none());
    let first_success = success.unwrap();
    record_sync_ledger(&state().journal.0, "c", false, Some("inventory unavailable")).unwrap();
    let (attempt, success, error) = sync_ledger(&state().journal.0, "c").unwrap();
    assert!(attempt.is_some());
    assert_eq!(success, Some(first_success), "failure keeps the last success");
    assert_eq!(error.as_deref(), Some("inventory unavailable"));
    record_sync_ledger(&state().journal.0, "c", true, None).unwrap();
    let (_, success, error) = sync_ledger(&state().journal.0, "c").unwrap();
    assert!(success.unwrap() >= first_success && error.is_none());
}

#[tokio::test]
async fn pending_operation_selection_is_scoped_ordered_and_terminal_aware() {
    let (_root, app) = host();
    configure_fixture(&app, "todos", Kind::Todo, vec![]);
    let remote = Synthetic::new("fixture:todos");
    remote.seed("a", ics("a", Kind::Todo, ""));
    remote.seed("b", ics("b", Kind::Todo, ""));
    app.planner_pull("todos", &remote).await.unwrap();
    let version = |uid: &str| {
        super::resource(&app.lock().unwrap().journal.0, "todos", uid)
            .unwrap()
            .unwrap()
            .version
    };
    let keep = enqueue(
        &app,
        "owner:a",
        mutation(
            "todos",
            Some("a"),
            Some(version("a")),
            Verb::Patch,
            serde_json::json!({"title":"A2"}),
        ),
    )
    .unwrap();
    let settle = enqueue(
        &app,
        "owner:b",
        mutation(
            "todos",
            Some("b"),
            Some(version("b")),
            Verb::Patch,
            serde_json::json!({"title":"B2"}),
        ),
    )
    .unwrap();
    let pending = pending_operation_ids(&app.lock().unwrap().journal.0, "todos").unwrap();
    assert_eq!(pending, vec![keep.id.clone(), settle.id.clone()]);
    {
        let s = app.lock().unwrap();
        super::set_state(&s, &settle.id, "synced", None).unwrap();
    }
    let pending = pending_operation_ids(&app.lock().unwrap().journal.0, "todos").unwrap();
    assert_eq!(pending, vec![keep.id]);
}

fn owner_action(app: &Arc<Host>, action: OwnerAction) -> serde_json::Value {
    app.action(Action {
        request_id: uuid::Uuid::new_v4().to_string(),
        command: Command::Workspace { action },
    })
    .unwrap()
}

#[tokio::test]
async fn sync_once_without_a_token_store_is_an_explicit_error_and_writes_nothing() {
    let (_root, app) = host();
    configure_google(&app, "events", WireFormat::GoogleCalendar, SyncPhase::ReadOnlyImport).unwrap();
    let _guard = StoreEnvGuard::set(None);
    let reply = app
        .action_async(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Workspace {
                action: OwnerAction::PlannerSyncOnce {
                    collection_id: "events".into(),
                    write: false,
                },
            },
        })
        .await
        .unwrap();
    assert_eq!(reply["ok"], false, "{reply}");
    assert!(
        reply["error"]
            .as_str()
            .unwrap()
            .contains("token store is not configured"),
        "{reply}"
    );
    let operations: i64 = app
        .lock()
        .unwrap()
        .journal
        .0
        .query_row("SELECT COUNT(*) FROM planner_operations", [], |row| row.get(0))
        .unwrap();
    assert_eq!(operations, 0, "no dispatch attempt was made");
    let ledger = sync_ledger(&app.lock().unwrap().journal.0, "events").unwrap();
    assert!(ledger.0.is_some(), "configuration failures must be durably recorded");
    assert!(ledger.1.is_none(), "no sync succeeded");
    assert!(ledger.2.as_deref().is_some_and(|error| error.contains("token store is not configured")));
}

#[tokio::test]
async fn sync_status_and_snapshot_project_the_connected_surface() {
    let (_root, app) = host();
    configure_fixture(&app, "todos", Kind::Todo, vec![]);
    let remote = Synthetic::new("fixture:todos");
    remote.seed("a", ics("a", Kind::Todo, ""));
    app.planner_pull("todos", &remote).await.unwrap();
    let version = super::resource(&app.lock().unwrap().journal.0, "todos", "a")
        .unwrap()
        .unwrap()
        .version;
    enqueue(
        &app,
        "owner:a",
        mutation(
            "todos",
            Some("a"),
            Some(version),
            Verb::Patch,
            serde_json::json!({"title":"A2"}),
        ),
    )
    .unwrap();
    let status = owner_action(
        &app,
        OwnerAction::PlannerSyncStatus {
            collection_id: "todos".into(),
        },
    );
    assert_eq!(status["ok"], true, "{status}");
    let status = &status["result"];
    assert_eq!(status["collection_id"], "todos");
    assert_eq!(status["connection_state"], "unconnected", "fixture bindings are not production endpoints");
    assert_eq!(status["collection_enabled"], true);
    assert_eq!(status["queued"], 1);
    assert_eq!(status["running"], false);
    assert_eq!(status["last_attempt_ms"], serde_json::Value::Null);
    assert_eq!(status["operations"][0]["phase"], "queued");

    let snapshot = app.snapshot().unwrap();
    let connected = &snapshot["connected_planner"];
    assert_eq!(connected["transport_available"], true);
    assert_eq!(
        connected["sync_status"].as_array().map(Vec::len),
        Some(1),
        "{connected}"
    );
    assert_eq!(
        connected["sync_status"][0]["connection_state"],
        "unconnected"
    );
}

#[tokio::test]
async fn sync_status_is_reachable_through_the_apply_route() {
    let (_root, app) = host();
    configure_fixture(&app, "todos", Kind::Todo, vec![]);
    let reply = owner_action(
        &app,
        OwnerAction::PlannerSyncStatus {
            collection_id: "todos".into(),
        },
    );
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["result"]["binding"], "fixture:todos");
}
