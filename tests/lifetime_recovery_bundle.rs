#![cfg(feature = "lifetime")]

use ghost::operations::recovery_bundle::{
    create_bundle, restore_bundle, verify_bundle, BundleRequest, ComputerHomeBrowser,
    HomeBrowserManifest, ReleaseIdentity, RootPresence, RootSpec,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

const ABSENT_PID: i32 = i32::MAX;

struct Fixture {
    _temporary: TempDir,
    base: PathBuf,
    request: BundleRequest,
    destination: PathBuf,
    _open_source_databases: Vec<Connection>,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let base = temporary.path().canonicalize().unwrap();
        let host = base.join("source/host");
        let worker = base.join("source/worker");
        let home = base.join("source/home");
        fs::create_dir_all(&host).unwrap();
        fs::create_dir_all(&worker).unwrap();
        fs::create_dir_all(home.join("provider")).unwrap();

        let host_connection = create_host_database(&host.join("workspace.db"));
        let worker_connection = create_worker_database(&worker.join("worker.db"));
        fs::write(home.join("preferences.bin"), [0, 255, 1, 254, 2]).unwrap();
        fs::write(home.join(".ghost-control.json"), br#"{"token":"must-not-enter-bundle"}"#).unwrap();
        fs::write(home.join("workspace.lock"), b"ephemeral-lock").unwrap();
        fs::write(home.join("provider/auth.json"), br#"{"token":"credential-value-must-not-enter-bundle"}"#).unwrap();

        let request = BundleRequest {
            roots: vec![
                root("host", "host", host, vec![], vec![]),
                root("worker", "worker", worker, vec![], vec![]),
                root(
                    "home",
                    "home",
                    home,
                    vec![PathBuf::from("provider/auth.json")],
                    vec!["omp-subscription".to_owned()],
                ),
            ],
            host_label: "host".to_owned(),
            release: ReleaseIdentity {
                source_revision: "fixture-source-revision".to_owned(),
                dirty_snapshot_digest: "a".repeat(64),
                component_digests: BTreeMap::from([("ghost".to_owned(), "b".repeat(64))]),
                schema_min: 9,
                schema_max: 10,
                protocol_revision: "ghost-lifetime/1".to_owned(),
                pinned_runtime_versions: BTreeMap::from([("pi".to_owned(), "1.1.0".to_owned())]),
                image_references: vec![format!("registry.invalid/ghost@sha256:{}", "c".repeat(64))],
                config_digest: "d".repeat(64),
            },
            home_browser_manifest: HomeBrowserManifest {
                computers: vec![ComputerHomeBrowser {
                    computer_id: "comp-a".to_owned(),
                    home: RootPresence::Present { root_label: "home".to_owned(), relative_path: String::new() },
                    browser: RootPresence::Unallocated,
                }],
            },
            external_document_references: vec!["oxibrain:space-fixture".to_owned(), "pdc:vault-fixture".to_owned()],
        };
        Self {
            destination: base.join("bundle"),
            _temporary: temporary,
            base,
            request,
            _open_source_databases: vec![host_connection, worker_connection],
        }
    }

    fn capture(&self) {
        create_bundle(&self.request, &self.destination).unwrap();
    }
}

fn root(
    label: &str,
    role: &str,
    path: PathBuf,
    excluded_credential_paths: Vec<PathBuf>,
    credential_references: Vec<String>,
) -> RootSpec {
    RootSpec {
        label: label.to_owned(),
        role: role.to_owned(),
        path,
        stopped_owner_pids: vec![ABSENT_PID],
        excluded_credential_paths,
        credential_references,
    }
}

fn create_host_database(path: &Path) -> Connection {
    let connection = Connection::open(path).unwrap();
    connection.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA wal_autocheckpoint=0;
         PRAGMA foreign_keys=ON;
         CREATE TABLE lifetime_authority(singleton INTEGER PRIMARY KEY CHECK(singleton=1), authority_epoch INTEGER NOT NULL, dispatch_enabled INTEGER NOT NULL);
         INSERT INTO lifetime_authority VALUES(1,3,1);
         CREATE TABLE lifetime_goals(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, requirement_digest TEXT NOT NULL, accountable_ghost TEXT NOT NULL, reply_conversation TEXT NOT NULL, privacy TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL);
         CREATE TABLE lifetime_work(id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES lifetime_goals(id), goal_revision INTEGER NOT NULL, owner TEXT NOT NULL, owner_revision INTEGER NOT NULL, state TEXT NOT NULL, execution_id TEXT, cancellation TEXT NOT NULL, payload TEXT NOT NULL);
         CREATE TABLE lifetime_commands(command_id TEXT PRIMARY KEY, payload_digest TEXT NOT NULL, actor_ref TEXT NOT NULL, authority_epoch INTEGER NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL);
         CREATE TABLE lifetime_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL REFERENCES lifetime_commands(command_id), target TEXT NOT NULL, payload TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, UNIQUE(command_id,target));
         CREATE TABLE lifetime_inbox(producer TEXT NOT NULL, epoch INTEGER NOT NULL, sequence INTEGER NOT NULL, payload_digest TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(producer,epoch,sequence));
         CREATE TABLE lifetime_delivery_receipts(outbox_id INTEGER PRIMARY KEY REFERENCES lifetime_outbox(id), receiver_command_id TEXT NOT NULL UNIQUE, receipt_digest TEXT NOT NULL, payload TEXT NOT NULL);
         INSERT INTO lifetime_goals VALUES('goal-kept',1,'req-digest','ghost-a','conversation-a','public','open','{}');
         INSERT INTO lifetime_work VALUES('work-queued','goal-kept',1,'ghost-a',1,'queued',NULL,'none','{\"task\":\"preserve\"}');
         INSERT INTO lifetime_commands VALUES('command-kept','payload','owner',3,'{}','{}');
         INSERT INTO lifetime_outbox VALUES(41,'command-kept','worker','{}',0);
         INSERT INTO lifetime_inbox VALUES('worker',3,17,'digest','{}');
         INSERT INTO lifetime_delivery_receipts VALUES(41,'receiver-command','receipt-digest','{}');
         PRAGMA user_version=9;",
    ).unwrap();
    connection
}

fn create_worker_database(path: &Path) -> Connection {
    let connection = Connection::open(path).unwrap();
    connection.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA wal_autocheckpoint=0;
         PRAGMA foreign_keys=ON;
         CREATE TABLE executions(execution_id TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL, acknowledged_sequence INTEGER NOT NULL, authority_epoch INTEGER NOT NULL);
         CREATE TABLE events(execution_id TEXT NOT NULL REFERENCES executions(execution_id), sequence INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, payload_bytes INTEGER NOT NULL, critical INTEGER NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY(execution_id,sequence));
         CREATE TABLE tool_receipts(execution_id TEXT NOT NULL REFERENCES executions(execution_id), tool_call_id TEXT NOT NULL, authority_epoch INTEGER NOT NULL, tool_name TEXT NOT NULL, arguments_digest TEXT NOT NULL, arguments_json TEXT NOT NULL, intent_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, is_error INTEGER NOT NULL, artifact_json TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, PRIMARY KEY(execution_id,tool_call_id));
         INSERT INTO executions VALUES('execution-kept',23,21,3);
         INSERT INTO events VALUES('execution-kept',23,'result','{}',2,1,1);
         INSERT INTO tool_receipts VALUES('execution-kept','tool-call-kept',3,'canary_read','args-digest','{}','{}','complete','{}',0,NULL,1,1);
         PRAGMA user_version=1;",
    ).unwrap();
    connection
}

fn read_manifest(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path.join("manifest.json")).unwrap()).unwrap()
}

#[test]
fn captures_multiple_wal_backed_stores_raw_artifacts_and_credential_references() {
    let fixture = Fixture::new();
    let worker_root = fixture.request.roots.iter().find(|root| root.label == "worker").unwrap().path.clone();
    fs::create_dir_all(worker_root.join("artifacts")).unwrap();
    fs::write(worker_root.join("artifacts/raw.json"), [0xff, 0, 0xfe, 1]).unwrap();

    fixture.capture();
    assert_eq!(verify_bundle(&fixture.destination).unwrap()["complete"], true);
    let manifest = read_manifest(&fixture.destination);
    assert_eq!(manifest["complete"], true);
    assert!(manifest.to_string().contains("omp-subscription"));
    assert!(!manifest.to_string().contains("provider/auth.json"));
    assert!(!String::from_utf8_lossy(&fs::read(fixture.destination.join("manifest.json")).unwrap()).contains("credential-value-must-not-enter-bundle"));
    assert_eq!(fs::read(fixture.destination.join("roots/worker/artifacts/raw.json")).unwrap(), [0xff, 0, 0xfe, 1]);
    assert_eq!(fs::read(fixture.destination.join("roots/home/preferences.bin")).unwrap(), [0, 255, 1, 254, 2]);
    assert!(!fixture.destination.join("roots/host/workspace.db-wal").exists());
    assert!(!fixture.destination.join("roots/worker/worker.db-wal").exists());

    let host = Connection::open_with_flags(
        fixture.destination.join("roots/host/workspace.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).unwrap();
    let (work_id, state): (String, String) = host.query_row("SELECT id,state FROM lifetime_work", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!((work_id.as_str(), state.as_str()), ("work-queued", "queued"));
    let (outbox_id, sequence, receipt_id): (i64, i64, i64) = host.query_row(
        "SELECT (SELECT MAX(id) FROM lifetime_outbox),(SELECT MAX(sequence) FROM lifetime_inbox),(SELECT MAX(outbox_id) FROM lifetime_delivery_receipts)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!((outbox_id, sequence, receipt_id), (41, 17, 41));
    let (receiver_id, receipt_digest, receipt_payload): (String, String, String) = host.query_row(
        "SELECT receiver_command_id,receipt_digest,payload FROM lifetime_delivery_receipts",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!((receiver_id.as_str(), receipt_digest.as_str(), receipt_payload.as_str()), ("receiver-command", "receipt-digest", "{}"));
    let worker = Connection::open_with_flags(
        fixture.destination.join("roots/worker/worker.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).unwrap();
    let (last, acknowledged, receipt_count): (i64, i64, i64) = worker.query_row(
        "SELECT (SELECT last_sequence FROM executions WHERE execution_id='execution-kept'),(SELECT acknowledged_sequence FROM executions WHERE execution_id='execution-kept'),(SELECT COUNT(*) FROM tool_receipts)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!((last, acknowledged, receipt_count), (23, 21, 1));
}

#[test]
fn captures_closed_wal_mode_databases_without_mutating_source_inventory() {
    let mut fixture = Fixture::new();
    fixture._open_source_databases.clear();
    let host_root = &fixture.request.roots[0].path;
    let source = host_root.join("workspace.db");
    let before = fs::read(&source).unwrap();
    let runtime_root = host_root.join("durable").join("0".repeat(64));
    fs::create_dir_all(&runtime_root).unwrap();
    let lock = Connection::open(runtime_root.join(".runtime-lock.sqlite")).unwrap();
    lock.execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE").unwrap();
    drop(lock);
    // An abrupt process exit can leave the empty lease's rollback journal.
    fs::write(runtime_root.join(".runtime-lock.sqlite-journal"), [0_u8; 512]).unwrap();
    let runtime = Connection::open(runtime_root.join("runtime.sqlite")).unwrap();
    runtime.execute_batch("CREATE TABLE ghost_runtime_identity(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        INSERT INTO ghost_runtime_identity VALUES('ghost_id','ghost-a');").unwrap();
    drop(runtime);
    let directory_before = fs::metadata(host_root).unwrap().modified().unwrap();
    assert!(!host_root.join("workspace.db-wal").exists());
    assert!(!host_root.join("workspace.db-shm").exists());

    fixture.capture();

    assert_eq!(fs::read(&source).unwrap(), before);
    assert_eq!(fs::metadata(host_root).unwrap().modified().unwrap(), directory_before);
    assert!(!host_root.join("workspace.db-wal").exists());
    assert!(!host_root.join("workspace.db-shm").exists());
    let captured = Connection::open_with_flags(
        fixture.destination.join("roots/host/workspace.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).unwrap();
    let state: String = captured.query_row(
        "SELECT state FROM lifetime_work WHERE id='work-queued'", [], |row| row.get(0),
    ).unwrap();
    assert_eq!(state, "queued");
    let runtime = Connection::open_with_flags(
        fixture.destination.join("roots/host/durable").join("0".repeat(64)).join("runtime.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).unwrap();
    let ghost_id: String = runtime.query_row(
        "SELECT value FROM ghost_runtime_identity WHERE key='ghost_id'", [], |row| row.get(0),
    ).unwrap();
    assert_eq!(ghost_id, "ghost-a");
}

#[test]
fn refuses_a_listed_live_owner_before_creating_destination() {
    let mut fixture = Fixture::new();
    fixture.request.roots[0].stopped_owner_pids = vec![std::process::id() as i32];
    assert!(create_bundle(&fixture.request, &fixture.destination).is_err());
    assert!(!fixture.destination.exists());
}

#[test]
fn rejects_a_source_file_over_the_streaming_byte_limit_before_destination_creation() {
    let fixture = Fixture::new();
    let oversized = fixture.request.roots[2].path.join("oversized.bin");
    let file = fs::File::create(oversized).unwrap();
    file.set_len(536_870_913).unwrap();
    assert!(create_bundle(&fixture.request, &fixture.destination).is_err());
    assert!(!fixture.destination.exists());
}

#[test]
fn unsupported_host_schema_never_produces_a_complete_bundle() {
    let mut fixture = Fixture::new();
    fixture.request.release.schema_min = 10;
    fixture.request.release.schema_max = 10;
    assert!(create_bundle(&fixture.request, &fixture.destination).is_err());
    assert_eq!(read_manifest(&fixture.destination)["complete"], false);
    assert!(verify_bundle(&fixture.destination).is_err());
}

#[test]
fn restores_to_a_new_root_with_one_epoch_increment_dispatch_off_and_preserved_work() {
    let fixture = Fixture::new();
    fixture.capture();
    let destination = fixture.base.join("restored");
    let report = restore_bundle(&fixture.destination, &destination).unwrap();
    assert_eq!(report.restored_authority_epoch, 4);
    assert!(!report.dispatch_enabled);
    assert!(report.quarantine_requirements.len() >= 3);
    assert!(report.reconciliation_requirements.len() >= 2);
    assert!(report.digest_facts.iter().any(|fact| fact.path == "workspace.db" && fact.authority_row_adjusted));

    let restored_host = Connection::open_with_flags(
        destination.join("roots/host/workspace.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).unwrap();
    let (epoch, dispatch): (i64, i64) = restored_host.query_row(
        "SELECT authority_epoch,dispatch_enabled FROM lifetime_authority WHERE singleton=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    let (work_id, state): (String, String) = restored_host.query_row("SELECT id,state FROM lifetime_work", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!((epoch, dispatch), (4, 0));
    assert_eq!((work_id.as_str(), state.as_str()), ("work-queued", "queued"));
    let goal_identity: (String, String) = restored_host.query_row(
        "SELECT id,reply_conversation FROM lifetime_goals",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    let receipt_identity: (String, String, String) = restored_host.query_row(
        "SELECT receiver_command_id,receipt_digest,payload FROM lifetime_delivery_receipts",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!((goal_identity.0.as_str(), goal_identity.1.as_str()), ("goal-kept", "conversation-a"));
    assert_eq!(
        (receipt_identity.0.as_str(), receipt_identity.1.as_str(), receipt_identity.2.as_str()),
        ("receiver-command", "receipt-digest", "{}")
    );

    let original_host = Connection::open_with_flags(
        fixture.request.roots[0].path.join("workspace.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).unwrap();
    let original: (i64, i64) = original_host.query_row(
        "SELECT authority_epoch,dispatch_enabled FROM lifetime_authority WHERE singleton=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(original, (3, 1));
}

#[test]
fn refuses_existing_destinations_and_incomplete_or_extra_file_bundles() {
    let fixture = Fixture::new();
    fs::create_dir(&fixture.destination).unwrap();
    fs::write(fixture.destination.join("owner-data"), b"keep").unwrap();
    assert!(create_bundle(&fixture.request, &fixture.destination).is_err());
    assert_eq!(fs::read(fixture.destination.join("owner-data")).unwrap(), b"keep");

    let complete = fixture.base.join("complete-bundle");
    create_bundle(&fixture.request, &complete).unwrap();
    fs::write(complete.join("unlisted.bin"), b"extra").unwrap();
    assert!(verify_bundle(&complete).is_err());
}

#[test]
fn rejects_tampered_files_traversal_and_incomplete_manifest() {
    let fixture = Fixture::new();
    let tampered = fixture.base.join("tampered-bundle");
    create_bundle(&fixture.request, &tampered).unwrap();
    fs::write(tampered.join("roots/home/preferences.bin"), b"changed").unwrap();
    assert!(verify_bundle(&tampered).is_err());

    let traversal = fixture.base.join("traversal-bundle");
    create_bundle(&fixture.request, &traversal).unwrap();
    let mut manifest = read_manifest(&traversal);
    manifest["entries"][0]["path"] = Value::String("../escape".to_owned());
    fs::write(traversal.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(verify_bundle(&traversal).is_err());

    let incomplete = fixture.base.join("incomplete-bundle");
    create_bundle(&fixture.request, &incomplete).unwrap();
    let mut manifest = read_manifest(&incomplete);
    manifest["complete"] = Value::Bool(false);
    fs::write(incomplete.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(verify_bundle(&incomplete).is_err());
}

#[cfg(unix)]
#[test]
fn refuses_symlink_and_hard_link_sources_and_bundle_entries() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let secret = fixture.request.roots[2].path.join("linked.bin");
    let outside = fixture.base.join("outside.bin");
    fs::write(&outside, b"outside").unwrap();
    symlink(&outside, &secret).unwrap();
    let symlink_bundle = fixture.base.join("symlink-source-bundle");
    assert!(create_bundle(&fixture.request, &symlink_bundle).is_err());
    fs::remove_file(&secret).unwrap();

    let linked_source = fixture.request.roots[2].path.join("linked.bin");
    fs::hard_link(&outside, &linked_source).unwrap();
    let hard_link_bundle = fixture.base.join("hardlink-source-bundle");
    assert!(create_bundle(&fixture.request, &hard_link_bundle).is_err());
    fs::remove_file(&linked_source).unwrap();

    let valid = fixture.base.join("valid-bundle");
    create_bundle(&fixture.request, &valid).unwrap();
    let bundle_hard_link = fixture.base.join("bundle-hardlink.bin");
    fs::hard_link(valid.join("roots/home/preferences.bin"), &bundle_hard_link).unwrap();
    assert!(verify_bundle(&valid).is_err());
    fs::remove_file(&bundle_hard_link).unwrap();
    verify_bundle(&valid).unwrap();
    let external = fixture.base.join("external");
    fs::write(&external, b"same name is not authority").unwrap();
    let injected = valid.join("roots/home/injected.bin");
    symlink(external, &injected).unwrap();
    assert!(verify_bundle(&valid).is_err());
}

fn nested_home_fixture() -> Fixture {
    let mut fixture = Fixture::new();
    let original_home = fixture.request.roots[2].path.clone();
    let volume = fixture.base.join("source/registry-volume");
    let relative_home = "computers/comp-a/home";
    let relative_browser = "computers/comp-a/browser-profile";
    fs::create_dir_all(volume.join("computers/comp-a")).unwrap();
    fs::rename(original_home, volume.join(relative_home)).unwrap();
    fs::create_dir(volume.join(relative_browser)).unwrap();
    fs::write(volume.join(relative_browser).join("profile-state.bin"), [17, 0, 255, 42]).unwrap();
    fixture.request.roots[2].path = volume;
    fixture.request.roots[2].excluded_credential_paths =
        vec![PathBuf::from(format!("{relative_home}/provider/auth.json"))];
    fixture.request.home_browser_manifest.computers[0].home = RootPresence::Present {
        root_label: "home".to_owned(),
        relative_path: relative_home.to_owned(),
    };
    fixture.request.home_browser_manifest.computers[0].browser = RootPresence::Present {
        root_label: "home".to_owned(),
        relative_path: relative_browser.to_owned(),
    };
    fixture
}

#[test]
fn restores_nested_home_and_browser_bytes_and_checks_the_actual_nested_marker() {
    use ghost::operations::home_lanes::{layout_dir_name, layout_marker_bytes, LAYOUT_MARKER_NAME};
    let fixture = nested_home_fixture();
    let nested = fixture.request.roots[2].path.join("computers/comp-a/home");
    let forged = nested.join(layout_dir_name("forged"));
    fs::create_dir(&forged).unwrap();
    fs::write(forged.join(LAYOUT_MARKER_NAME), layout_marker_bytes("forged", "foreign-computer")).unwrap();
    fixture.capture();
    verify_bundle(&fixture.destination).unwrap();
    let restored = fixture.base.join("restored-nested");
    let report = restore_bundle(&fixture.destination, &restored).unwrap();
    assert_eq!(fs::read(restored.join("roots/home/computers/comp-a/home/preferences.bin")).unwrap(),
        [0, 255, 1, 254, 2]);
    assert_eq!(fs::read(restored.join("roots/home/computers/comp-a/browser-profile/profile-state.bin")).unwrap(),
        [17, 0, 255, 42]);
    assert!(!restored.join("roots/home/computers/comp-a/home/provider/auth.json").exists());
    // Inspecting the component parent rather than the declared nested home would
    // incorrectly classify this as ordinary legacy instead of rejecting the forgery.
    assert_eq!(report.home_lanes[0].admission, "forged_refused");
    assert!(!report.dispatch_enabled);
    assert_eq!(report.restored_authority_epoch, 4);
}

#[test]
fn refuses_traversal_missing_files_and_excluded_nested_home_roots() {
    for path in [
        "../outside", "/absolute", "computers//comp-a", "computers/missing/home",
        "computers/comp-a/home/preferences.bin", "computers/comp-a/home/provider/auth.json",
    ] {
        let mut fixture = nested_home_fixture();
        fixture.request.home_browser_manifest.computers[0].home = RootPresence::Present {
            root_label: "home".to_owned(),
            relative_path: path.to_owned(),
        };
        assert!(create_bundle(&fixture.request, &fixture.destination).is_err(), "accepted {path}");
        assert!(!fixture.destination.exists(), "allocated destination for {path}");
    }
}

#[test]
fn refuses_manifest_home_retargeting_to_a_directory_not_in_the_capture() {
    let fixture = nested_home_fixture();
    fixture.capture();
    let mut manifest = read_manifest(&fixture.destination);
    manifest["home_browser_manifest"]["computers"][0]["home"]["relative_path"] =
        Value::String("computers/uncaptured/home".to_owned());
    fs::write(fixture.destination.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(verify_bundle(&fixture.destination).is_err());
    let destination = fixture.base.join("refused-restore");
    assert!(restore_bundle(&fixture.destination, &destination).is_err());
    assert!(!destination.exists());
}

#[test]
fn immutable_native_backup_archive_survives_real_bundle_without_sqlite_resnapshot() {
    use ghost::operations::native_backup_artifact;
    use std::os::unix::fs::PermissionsExt;
    let mut fixture=Fixture::new();
    fs::set_permissions(&fixture.base,fs::Permissions::from_mode(0o700)).unwrap();
    let source=fixture.base.join("native-original");fs::create_dir(&source).unwrap();fs::set_permissions(&source,fs::Permissions::from_mode(0o700)).unwrap();
    let db=source.join("brain.db");let conn=Connection::open(&db).unwrap();conn.execute_batch("CREATE TABLE original(id TEXT PRIMARY KEY,value TEXT);INSERT INTO original VALUES('retained-uuid','immutable native bytes');PRAGMA user_version=19;").unwrap();drop(conn);fs::set_permissions(&db,fs::Permissions::from_mode(0o600)).unwrap();let original=fs::read(&db).unwrap();
    let manifest=serde_json::to_vec_pretty(&serde_json::json!({"format":"oxibrain-backup/1","generation":"no-native-preservation","created_at_utc_ms":1,"ledger_schema_version":19,"projection_version":1,"include_projection":false,"include_cache":false,"files":[{"path":"brain.db","bytes":original.len(),"blake3":blake3::hash(&original).to_hex().to_string()}],"exclusions":[]})).unwrap();fs::write(source.join("manifest.json"),&manifest).unwrap();fs::set_permissions(source.join("manifest.json"),fs::Permissions::from_mode(0o600)).unwrap();
    let package=fixture.base.join("native-package");fs::create_dir(&package).unwrap();fs::set_permissions(&package,fs::Permissions::from_mode(0o700)).unwrap();let archive=package.join("native-backup.tar");let pin=native_backup_artifact::pack(&source,&archive).unwrap();
    fixture.request.roots.push(root("native-backup","memory-backup",package.clone(),vec![],vec![]));fixture.capture();
    fs::rename(&source,fixture.base.join("quarantined-native-original")).unwrap();fs::rename(&package,fixture.base.join("quarantined-package")).unwrap();
    let report=restore_bundle(&fixture.destination,&fixture.base.join("restored-generation")).unwrap();let restored_archive=report.restored_roots["native-backup"].join("native-backup.tar");
    let outer:Value=serde_json::from_slice(&fs::read(fixture.destination.join("manifest.json")).unwrap()).unwrap();let entry=outer["entries"].as_array().unwrap().iter().find(|e|e["root_label"]=="native-backup"&&e["path"]=="native-backup.tar").unwrap();assert_eq!(entry["kind"],"file");assert_eq!(entry["sha256"],pin.archive_sha256);
    let restored=fixture.base.join("restored-detached-native");native_backup_artifact::unpack(&restored_archive,entry["sha256"].as_str().unwrap(),&restored).unwrap();assert_eq!(fs::read(restored.join("brain.db")).unwrap(),original);assert_eq!(fs::read(restored.join("manifest.json")).unwrap(),manifest);
}
