//! Deterministic regressions for the parent review's three correctness gaps.
use super::fixtures::*;
use super::*;
use crate::control::api::OwnerAction;
use std::sync::atomic::Ordering;

fn setup() -> (tempfile::TempDir, Arc<Host>) {
    let root = tempfile::tempdir().unwrap();
    let app = Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    configure_fixture(&app, "todos", Kind::Todo, vec![]);
    (root, app)
}
fn row(app: &Arc<Host>, uid: &str) -> Resource {
    resource(&app.lock().unwrap().journal.0, "todos", uid)
        .unwrap()
        .unwrap()
}
fn op(app: &Arc<Host>, id: &str) -> Operation {
    load(&app.lock().unwrap().journal.0, "planner_operations", id)
        .unwrap()
        .unwrap()
}
fn queue(app: &Arc<Host>, m: Mutation) -> Value {
    let v = owner(app, OwnerAction::PlannerMutation { mutation: m });
    assert_eq!(v["ok"], true, "{v}");
    v["result"].clone()
}
async fn entered(gate: &ReadGate) {
    tokio::time::timeout(std::time::Duration::from_secs(5), gate.entered.notified())
        .await
        .unwrap();
}
fn dispatch(app: Arc<Host>, remote: Arc<Controlled>, id: String) -> tokio::task::JoinHandle<Value> {
    tokio::spawn(async move { app.planner_dispatch(&id, &*remote).await.unwrap() })
}
async fn uncertain(
    app: &Arc<Host>,
    remote: &Controlled,
) -> (String, RemoteResource, RemoteResource) {
    remote.remote.seed("plain", ics("plain", Kind::Todo, ""));
    app.planner_pull("todos", remote).await.unwrap();
    let base = remote.remote.items.lock().unwrap()["plain"].clone();
    let r = row(app, "plain");
    let admission = queue(
        app,
        mutation(
            "todos",
            Some("plain"),
            Some(r.version),
            Verb::Patch,
            json!({"title":"desired"}),
        ),
    );
    let id = admission["operation_id"].as_str().unwrap().to_string();
    remote.remote.lose_reply.store(true, Ordering::SeqCst);
    remote.remote.fail_read.store(true, Ordering::SeqCst);
    assert_eq!(
        app.planner_dispatch(&id, remote).await.unwrap()["phase"],
        "uncertain"
    );
    let desired = remote.remote.items.lock().unwrap()["plain"].clone();
    (id, base, desired)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn caldav_review_late_desired_reply_cannot_overwrite_newer_412_conflict() {
    let (_root, app) = setup();
    let remote = Arc::new(Controlled::new("fixture:todos"));
    let (id, base, desired) = uncertain(&app, &remote).await;
    // U1 captures B/E and U2 captures D/E2; both replies are withheld.
    let u1 = remote.gate(Some(base.clone()), false);
    let t1 = dispatch(app.clone(), remote.clone(), id.clone());
    entered(&u1).await;
    let u2 = remote.gate(Some(desired.clone()), false);
    let t2 = dispatch(app.clone(), remote.clone(), id.clone());
    entered(&u2).await;
    let latest_claim = op(&app, &id).attempt;
    u1.release.notify_one();
    assert_eq!(
        t1.await.unwrap()["phase"],
        "uncertain",
        "older U1 cannot requeue after U2 claimed"
    );
    assert_eq!(op(&app, &id).attempt, latest_claim);
    // A newer authoritative observation sees a genuine B/E again, then the
    // remote changes back to D/E2 before its conditional retry executes.
    remote
        .remote
        .items
        .lock()
        .unwrap()
        .insert("plain".into(), base.clone());
    assert_eq!(
        app.planner_dispatch(&id, &*remote).await.unwrap()["phase"],
        "queued"
    );
    remote
        .remote
        .items
        .lock()
        .unwrap()
        .insert("plain".into(), desired.clone());
    let conflict = app.planner_dispatch(&id, &*remote).await.unwrap();
    assert_eq!(conflict["phase"], "conflict");
    assert_eq!(conflict["write_outcome"], "precondition_failed");
    let before = serde_json::to_value(op(&app, &id)).unwrap();
    let before_row = serde_json::to_value(row(&app, "plain")).unwrap();
    u2.release.notify_one();
    assert_eq!(
        t2.await.unwrap(),
        conflict,
        "late U2 returns current receipt without committing its snapshot"
    );
    assert_eq!(serde_json::to_value(op(&app, &id)).unwrap(), before);
    assert_eq!(
        serde_json::to_value(row(&app, "plain")).unwrap(),
        before_row
    );
    assert_eq!(conflict["remote_applied"], false);
    assert_eq!(remote.remote.requests.lock().unwrap().len(), 2);
    app.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn caldav_review_late_read_error_cannot_revert_newer_synced_receipt() {
    let (_root, app) = setup();
    let remote = Arc::new(Controlled::new("fixture:todos"));
    let (id, base, desired) = uncertain(&app, &remote).await;
    let u1 = remote.gate(Some(base), true);
    let t1 = dispatch(app.clone(), remote.clone(), id.clone());
    entered(&u1).await;
    let u2 = remote.gate(Some(desired), false);
    let t2 = dispatch(app.clone(), remote.clone(), id.clone());
    entered(&u2).await;
    u2.release.notify_one();
    let synced = t2.await.unwrap();
    assert_eq!(synced["phase"], "synced");
    let before = serde_json::to_value(op(&app, &id)).unwrap();
    u1.release.notify_one();
    assert_eq!(t1.await.unwrap(), synced);
    assert_eq!(serde_json::to_value(op(&app, &id)).unwrap(), before);
    assert_eq!(remote.remote.requests.lock().unwrap().len(), 1);
    app.shutdown().await.unwrap();
}

struct PausedInventory {
    remote: Arc<Controlled>,
    captured: Inventory,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
impl Adapter for PausedInventory {
    fn binding(&self) -> &str {
        self.remote.binding()
    }
    fn inventory(&self) -> AdapterFuture<'_, Inventory> {
        Box::pin(async move {
            self.entered.notify_one();
            self.release.notified().await;
            Ok(Inventory {
                complete: self.captured.complete,
                items: self.captured.items.clone(),
            })
        })
    }
    fn observe_uid<'a>(&'a self, uid: &'a str) -> AdapterFuture<'a, Option<RemoteResource>> {
        self.remote.observe_uid(uid)
    }
    fn write(&self, request: ConditionalWrite) -> AdapterFuture<'_, WriteOutcome> {
        self.remote.write(request)
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn caldav_review_stale_full_inventory_cannot_roll_back_dispatch_confirmation() {
    let (_root, app) = setup();
    let remote = Arc::new(Controlled::new("fixture:todos"));
    remote.remote.seed("plain", ics("plain", Kind::Todo, ""));
    app.planner_pull("todos", &*remote).await.unwrap();
    let r = row(&app, "plain");
    let queued = queue(
        &app,
        mutation(
            "todos",
            Some("plain"),
            Some(r.version),
            Verb::Patch,
            json!({"title":"desired"}),
        ),
    );
    let id = queued["operation_id"].as_str().unwrap();
    let inventory = Arc::new(PausedInventory {
        captured: remote.inventory().await.unwrap(),
        remote: remote.clone(),
        entered: Default::default(),
        release: Default::default(),
    });
    let pull = {
        let app = app.clone();
        let inventory = inventory.clone();
        tokio::spawn(async move { app.planner_pull("todos", &*inventory).await })
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        inventory.entered.notified(),
    )
    .await
    .unwrap();
    assert_eq!(
        app.planner_dispatch(id, &*remote).await.unwrap()["phase"],
        "synced"
    );
    let before = serde_json::to_value(row(&app, "plain")).unwrap();
    inventory.release.notify_one();
    assert!(pull
        .await
        .unwrap()
        .unwrap_err()
        .to_string()
        .contains("state changed during inventory"));
    assert_eq!(serde_json::to_value(row(&app, "plain")).unwrap(), before);
    assert_eq!(op(&app, id).state, "synced");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn caldav_review_href_reuse_uid_moves_and_pending_writes_keep_history_and_conflict() {
    let (_root, app) = setup();
    let remote = Synthetic::new("fixture:todos");
    remote.seed("a", ics("a", Kind::Todo, ""));
    app.planner_pull("todos", &remote).await.unwrap();
    let a = row(&app, "a");
    let pending_a = queue(
        &app,
        mutation(
            "todos",
            Some("a"),
            Some(a.version),
            Verb::Patch,
            json!({"title":"pending a"}),
        ),
    );
    remote.items.lock().unwrap().remove("a");
    remote.seed("b", ics("b", Kind::Todo, ""));
    remote.items.lock().unwrap().get_mut("b").unwrap().href = "a.ics".into();
    app.planner_pull("todos", &remote).await.unwrap();
    assert!(row(&app, "a").tombstone);
    assert_eq!(row(&app, "a").href, "a.ics");
    assert_eq!(row(&app, "a").raw, a.raw, "historical source retained");
    assert_eq!(
        locator_uid(&app.lock().unwrap().journal.0, "todos", "a.ics").unwrap(),
        Some("b".into())
    );
    let id_a = pending_a["operation_id"].as_str().unwrap();
    assert_eq!(op(&app, id_a).state, "conflict");
    assert_eq!(op(&app, id_a).conflict_remote.unwrap().uid, "b");
    app.planner_dispatch(id_a, &remote).await.unwrap();
    let b = row(&app, "b");
    let pending_b = queue(
        &app,
        mutation(
            "todos",
            Some("b"),
            Some(b.version),
            Verb::Complete,
            json!({}),
        ),
    );
    remote.items.lock().unwrap().get_mut("b").unwrap().href = "moved.ics".into();
    app.planner_pull("todos", &remote).await.unwrap();
    assert_eq!(row(&app, "b").uid, "b");
    assert_eq!(row(&app, "b").href, "moved.ics");
    assert!(row(&app, "b").version > b.version);
    let id_b = pending_b["operation_id"].as_str().unwrap();
    assert_eq!(op(&app, id_b).state, "conflict");
    app.planner_dispatch(id_b, &remote).await.unwrap();
    assert!(remote.requests.lock().unwrap().is_empty());
    // Two live UIDs may exchange locators in one validated full inventory.
    remote.seed("c", ics("c", Kind::Todo, ""));
    remote.items.lock().unwrap().get_mut("c").unwrap().href = "a.ics".into();
    app.planner_pull("todos", &remote).await.unwrap();
    {
        let mut items = remote.items.lock().unwrap();
        items.get_mut("b").unwrap().href = "a.ics".into();
        items.get_mut("c").unwrap().href = "moved.ics".into();
    }
    app.planner_pull("todos", &remote).await.unwrap();
    assert_eq!(
        locator_uid(&app.lock().unwrap().journal.0, "todos", "a.ics").unwrap(),
        Some("b".into())
    );
    assert_eq!(
        locator_uid(&app.lock().unwrap().journal.0, "todos", "moved.ics").unwrap(),
        Some("c".into())
    );
    assert!(row(&app, "a").tombstone);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn caldav_review_pending_create_locator_taken_by_different_uid_never_writes() {
    let (_root, app) = setup();
    let remote = Synthetic::new("fixture:todos");
    let pending = queue(
        &app,
        mutation(
            "todos",
            None,
            None,
            Verb::Create,
            json!({"title":"pending"}),
        ),
    );
    let id = pending["operation_id"].as_str().unwrap();
    remote.seed("other", ics("other", Kind::Todo, ""));
    remote.items.lock().unwrap().get_mut("other").unwrap().href = op(&app, id).href;
    app.planner_pull("todos", &remote).await.unwrap();
    assert_eq!(op(&app, id).state, "conflict");
    assert_eq!(
        app.planner_dispatch(id, &remote).await.unwrap()["remote_applied"],
        false
    );
    assert!(remote.requests.lock().unwrap().is_empty());
    assert_eq!(remote.items.lock().unwrap().len(), 1);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn caldav_review_admission_is_immutable_and_commits_atomically_with_operation() {
    let (_root, app) = setup();
    let request = uuid::Uuid::new_v4().to_string();
    let m = mutation(
        "todos",
        None,
        None,
        Verb::Create,
        json!({"title":"atomic receipt"}),
    );
    let payload = json!({"fixture":"admission"}).to_string();
    {
        let s = app.lock().unwrap();
        s.journal.0.execute_batch("CREATE TRIGGER reject_immutable_receipt BEFORE INSERT ON planner_admissions BEGIN SELECT RAISE(ABORT,'admission insert fault'); END;").unwrap();
        assert!(enqueue_owner(&s, &request, &payload, m.clone()).is_err());
        for table in [
            "planner_operations",
            "planner_resources",
            "planner_admissions",
            "planner_locators",
        ] {
            assert_eq!(
                s.journal
                    .0
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                        .get::<_, u64>(0))
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            s.journal
                .0
                .query_row(
                    "SELECT COUNT(*) FROM workspace_commands WHERE id=?",
                    [&request],
                    |r| r.get::<_, u64>(0)
                )
                .unwrap(),
            0
        );
        s.journal
            .0
            .execute_batch("DROP TRIGGER reject_immutable_receipt;")
            .unwrap();
    }
    let admitted = enqueue_owner(&app.lock().unwrap(), &request, &payload, m.clone()).unwrap();
    let id = admitted["result"]["operation_id"].as_str().unwrap();
    let remote = Synthetic::new("fixture:todos");
    assert_eq!(
        app.planner_dispatch(id, &remote).await.unwrap()["phase"],
        "synced"
    );
    {
        let s = app.lock().unwrap();
        assert_eq!(
            admission_receipt(&s.journal.0, id).unwrap(),
            admitted["result"]
        );
        assert_eq!(enqueue_owner(&s, &request, &payload, m).unwrap(), admitted);
        assert!(s
            .journal
            .0
            .execute(
                "UPDATE planner_admissions SET payload='{}' WHERE operation_id=?",
                [id]
            )
            .is_err());
        assert!(s
            .journal
            .0
            .execute(
                "INSERT OR REPLACE INTO planner_admissions VALUES(?,'{}')",
                [id]
            )
            .is_err());
        assert!(s
            .journal
            .0
            .execute("DELETE FROM planner_admissions WHERE operation_id=?", [id])
            .is_err());
        assert_eq!(
            admission_receipt(&s.journal.0, id).unwrap()["remote_applied"],
            false
        );
        assert_eq!(status(&s, id, "todos").unwrap()["remote_applied"], true);
    }
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn caldav_review_previous_v4_href_constraint_migrates_without_erasing_history() {
    let root = tempfile::tempdir().unwrap();
    let conn = Connection::open(root.path().join("workspace.db")).unwrap();
    conn.execute_batch("CREATE TABLE planner_collections(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE planner_resources(collection_id TEXT NOT NULL,uid TEXT NOT NULL,href TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(collection_id,uid),UNIQUE(collection_id,href));PRAGMA user_version=4;").unwrap();
    let c = Collection {
        input: CollectionInput {
            id: "todos".into(),
            binding: "fixture:todos".into(),
            kind: Kind::Todo,
            profiles: vec![],
            enabled: true,
        },
        generation: 1,
    };
    conn.execute(
        "INSERT INTO planner_collections VALUES('todos',?)",
        [serde_json::to_string(&c).unwrap()],
    )
    .unwrap();
    let mut history = remote_resource(
        "todos",
        &RemoteResource {
            uid: "a".into(),
            href: "a.ics".into(),
            etag: "\"a\"".into(),
            raw: ics("a", Kind::Todo, ""),
        },
        None,
        &Kind::Todo,
    )
    .unwrap();
    history.tombstone = true;
    put_resource(&conn, &history).unwrap();
    conn.execute_batch("CREATE TABLE planner_operations(id TEXT PRIMARY KEY,identity TEXT NOT NULL UNIQUE,collection_id TEXT NOT NULL,uid TEXT NOT NULL,payload TEXT NOT NULL);").unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let identity = format!("owner:{request}");
    let legacy = Operation {
        id: uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, identity.as_bytes()).to_string(),
        identity,
        mutation: mutation("todos", Some("a"), Some(1), Verb::Delete, json!({})),
        actor: Actor::Owner,
        uid: "a".into(),
        href: "a.ics".into(),
        generation: 1,
        base_etag: history.etag.clone(),
        base_raw: history.raw.clone(),
        desired_raw: None,
        desired_view: history.view.clone(),
        state: "synced".into(),
        remote_applied: true,
        diagnostic: None,
        conflict_remote: None,
        write_outcome: "applied".into(),
        attempt: 0,
    };
    let mut old_payload = serde_json::to_value(&legacy).unwrap();
    old_payload.as_object_mut().unwrap().remove("attempt");
    conn.execute(
        "INSERT INTO planner_operations VALUES(?1,?2,'todos','a',?3)",
        params![legacy.id, legacy.identity, old_payload.to_string()],
    )
    .unwrap();
    drop(conn);
    let app = Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    assert_eq!(
        serde_json::to_value(row(&app, "a")).unwrap(),
        serde_json::to_value(&history).unwrap()
    );
    let remote = Synthetic::new("fixture:todos");
    remote.seed("b", ics("b", Kind::Todo, ""));
    remote.items.lock().unwrap().get_mut("b").unwrap().href = "a.ics".into();
    app.planner_pull("todos", &remote).await.unwrap();
    assert!(row(&app, "a").tombstone);
    assert_eq!(row(&app, "b").href, "a.ics");
    assert_eq!(
        locator_uid(&app.lock().unwrap().journal.0, "todos", "a.ics").unwrap(),
        Some("b".into())
    );
    {
        let s = app.lock().unwrap();
        assert!(admission_receipt(&s.journal.0, &legacy.id).is_err());
        assert_eq!(status(&s, &legacy.id, "todos").unwrap()["phase"], "synced");
        let error =
            enqueue_owner(&s, &request, "legacy replay", legacy.mutation.clone()).unwrap_err();
        assert!(error
            .to_string()
            .contains("immutable admission receipt missing"));
        assert_eq!(
            load::<Operation>(&s.journal.0, "planner_operations", &legacy.id)
                .unwrap()
                .unwrap()
                .attempt,
            0
        );
    }
    assert_eq!(
        app.lock()
            .unwrap()
            .journal
            .0
            .query_row("PRAGMA user_version", [], |r| r.get::<_, u64>(0))
            .unwrap(),
        4
    );
    app.shutdown().await.unwrap();
    drop(app);
    let app = Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    assert!(row(&app, "a").tombstone);
    assert_eq!(
        locator_uid(&app.lock().unwrap().journal.0, "todos", "a.ics").unwrap(),
        Some("b".into())
    );
    app.shutdown().await.unwrap();
}
