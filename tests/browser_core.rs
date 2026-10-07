#![cfg(feature = "browser-fixtures")]
use ghost::browser::{
    self, BrowserCommand as C, BrowserHost, BrowserOp as Op, TrustedFixtureControl,
};
use ghost::provider_control::RunControl;
use ghost::store::{ProfileStore, Task};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tempfile::TempDir;
const OPS: &[Op] = &[
    Op::New,
    Op::Tabs,
    Op::Navigate,
    Op::Snapshot,
    Op::Click,
    Op::Fill,
    Op::Close,
];
fn exe() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_ghost-browser-fixture"))
}
fn setup() -> (
    TempDir,
    ProfileStore,
    String,
    TrustedFixtureControl,
    i64,
    PathBuf,
) {
    let dir = TempDir::new().unwrap();
    let store = ProfileStore::create_profile(dir.path(), "a", "assistant").unwrap();
    let session = store.create_session().unwrap().uuid;
    let trusted = TrustedFixtureControl::local_fixture_host(&store);
    let grant = trusted.approve(&store, &session, OPS).unwrap();
    let log = dir.path().join("fake.jsonl");
    (dir, store, session, trusted, grant, log)
}
fn task(store: &ProfileStore, session: &str, id: &str) -> Task {
    store.submit(session, id, id, None, None, None).unwrap().0
}
fn rows(log: &Path) -> Vec<Value> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}
fn count(log: &Path, kind: &str) -> usize {
    rows(log).iter().filter(|r| r["kind"] == kind).count()
}
fn effects(store: &ProfileStore) -> i64 {
    store
        .conn
        .query_row("SELECT COUNT(*) FROM effects", [], |r| r.get(0))
        .unwrap()
}
fn open(host: &mut BrowserHost, store: &ProfileStore, session: &str, id: &str) -> String {
    let task = task(store, session, id);
    host.execute(store, task.id, id, C::New, &Default::default())
        .unwrap()
        .untrusted_data
        .unwrap()["tab_id"]
        .as_str()
        .unwrap()
        .to_string()
}
fn snap(
    host: &mut BrowserHost,
    store: &ProfileStore,
    session: &str,
    tab: &str,
    id: &str,
) -> String {
    let task = task(store, session, id);
    host.execute(
        store,
        task.id,
        id,
        C::Snapshot { tab_id: tab.into() },
        &Default::default(),
    )
    .unwrap()
    .untrusted_data
    .unwrap()["elements"][0]["ref"]
        .as_str()
        .unwrap()
        .to_string()
}
fn click(tab: &str, r: &str) -> C {
    C::Click {
        tab_id: tab.into(),
        r#ref: r.into(),
    }
}

#[test]
fn default_denial_spawns_nothing_and_writes_no_child_bytes() {
    let (dir, store, s, _, grant, log) = setup();
    store.revoke(grant).unwrap();
    assert!(BrowserHost::start_fixture(&store, &s, grant, exe(), "normal", &log).is_err());
    assert!(!log.exists());
    assert_eq!(effects(&store), 0);
    let other = ProfileStore::create_profile(dir.path(), "b", "b").unwrap();
    let session = other.create_session().unwrap();
    assert!(
        BrowserHost::start_fixture(&other, &session.uuid, grant, exe(), "normal", &log).is_err()
    );
    assert!(!log.exists());
}
#[test]
fn child_has_no_inherited_environment_and_one_owner_per_session() {
    let (_dir, store, s, _, g, log) = setup();
    // A public non-secret sentinel proves the parent's environment was cleared.
    let prior = std::env::var_os("GHOST_FIXTURE_PARENT_ONLY");
    std::env::set_var("GHOST_FIXTURE_PARENT_ONLY", "public-fixture-parent-marker");
    let launched = BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log);
    if let Some(prior) = prior {
        std::env::set_var("GHOST_FIXTURE_PARENT_ONLY", prior);
    } else {
        std::env::remove_var("GHOST_FIXTURE_PARENT_ONLY");
    }
    let host = launched.unwrap();
    assert!(BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).is_err());
    assert_eq!(count(&log, "spawn"), 1);
    let keys = rows(&log)[0]["env_keys"].as_array().unwrap().clone();
    assert!(
        keys.iter()
            .all(|key| cfg!(target_os = "macos") && key == "__CF_USER_TEXT_ENCODING"),
        "unexpected child environment keys: {keys:?}"
    );
    assert!(!keys.iter().any(|key| key == "GHOST_FIXTURE_PARENT_ONLY"));
    assert!(host.pid().is_some());
}
#[test]
fn two_ghosts_keep_child_task_and_receipt_correlation_and_owned_shutdown() {
    let (dir, a, sa, _, ga, la) = setup();
    let b = ProfileStore::create_profile(dir.path(), "b", "b").unwrap();
    let sb = b.create_session().unwrap().uuid;
    let gb = TrustedFixtureControl::local_fixture_host(&b)
        .approve(&b, &sb, OPS)
        .unwrap();
    let lb = dir.path().join("b.jsonl");
    let mut ah = BrowserHost::start_fixture(&a, &sa, ga, exe(), "normal", &la).unwrap();
    let mut bh = BrowserHost::start_fixture(&b, &sb, gb, exe(), "normal", &lb).unwrap();
    assert_ne!(ah.scope(), bh.scope());
    assert_ne!(ah.pid(), bh.pid());
    let at = open(&mut ah, &a, &sa, "same");
    let bt = open(&mut bh, &b, &sb, "same");
    let ar = browser::receipt(&a, "same").unwrap().unwrap();
    let br = browser::receipt(&b, "same").unwrap().unwrap();
    assert_ne!(ar.profile_uuid, br.profile_uuid);
    assert_ne!(ar.session_uuid, br.session_uuid);
    assert_ne!(ar.child_scope, br.child_scope);
    let before = count(&lb, "request");
    let foreign = task(&b, &sb, "foreign");
    assert!(ah
        .execute(&b, foreign.id, "foreign", C::Tabs, &Default::default())
        .is_err());
    assert_eq!(count(&lb, "request"), before);
    assert_eq!(effects(&b), 1);
    ah.shutdown();
    assert!(!ah.is_alive());
    assert!(bh.is_alive());
    let rb = snap(&mut bh, &b, &sb, &bt, "after-a-stopped");
    assert!(!rb.is_empty());
    assert_eq!(at, "t1");
}
#[test]
fn grant_session_and_operation_scope_are_checked_before_forwarding() {
    let (_dir, store, s, _, g, log) = setup();
    let other = store.create_session().unwrap().uuid;
    assert!(BrowserHost::start_fixture(&store, &other, g, exe(), "normal", &log).is_err());
    assert!(!log.exists());
    let trusted = TrustedFixtureControl::local_fixture_host(&store);
    let read = trusted
        .approve(&store, &s, &[Op::New, Op::Snapshot])
        .unwrap();
    let mut host = BrowserHost::start_fixture(&store, &s, read, exe(), "normal", &log).unwrap();
    let tab = open(&mut host, &store, &s, "new");
    let r = snap(&mut host, &store, &s, &tab, "snap");
    let before = count(&log, "request");
    let t = task(&store, &s, "click");
    assert!(host
        .execute(&store, t.id, "click", click(&tab, &r), &Default::default())
        .is_err());
    assert_eq!(count(&log, "request"), before);
    assert_eq!(store.task(&t.uuid).unwrap().unwrap().status, "queued");
    assert_eq!(effects(&store), 2);
}
#[test]
fn revocation_is_rechecked_on_each_request() {
    let (_dir, store, s, trusted, g, log) = setup();
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).unwrap();
    let tab = open(&mut host, &store, &s, "new");
    let r = snap(&mut host, &store, &s, &tab, "snap");
    trusted.revoke(&store, g).unwrap();
    let before = count(&log, "request");
    let t = task(&store, &s, "action");
    assert!(host
        .execute(&store, t.id, "action", click(&tab, &r), &Default::default())
        .is_err());
    assert_eq!(count(&log, "request"), before);
}
#[test]
fn completed_duplicate_replays_receipt_and_changed_payload_fails() {
    let (_dir, store, s, _, g, log) = setup();
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).unwrap();
    let t = task(&store, &s, "new");
    let first = host
        .execute(&store, t.id, "id", C::New, &Default::default())
        .unwrap();
    let before = count(&log, "request");
    let replay = host
        .execute(&store, t.id, "id", C::New, &Default::default())
        .unwrap();
    assert_eq!(
        serde_json::to_value(first).unwrap(),
        serde_json::to_value(replay).unwrap()
    );
    assert!(host
        .execute(&store, t.id, "id", C::Tabs, &Default::default())
        .is_err());
    assert!(host
        .execute(&store, t.id, "changed-id", C::New, &Default::default())
        .is_err());
    assert_eq!(count(&log, "request"), before);
    assert_eq!(store.outbox().unwrap().len(), 1);
}
#[test]
fn stale_closed_cross_tab_and_cross_child_refs_never_forward() {
    let (_dir, store, s, _, g, log) = setup();
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).unwrap();
    let tab = open(&mut host, &store, &s, "new");
    let stale = snap(&mut host, &store, &s, &tab, "s1");
    let fresh = snap(&mut host, &store, &s, &tab, "s2");
    let second = open(&mut host, &store, &s, "second");
    let before = count(&log, "request");
    for (id, cmd) in [
        ("stale", click(&tab, &stale)),
        ("cross-tab", click(&second, &fresh)),
        ("foreign", click(&tab, "other-child:t1:1:input")),
        (
            "non-fillable",
            C::Fill {
                tab_id: tab.clone(),
                r#ref: fresh.replace("input", "button"),
                value: "x".into(),
            },
        ),
    ] {
        let t = task(&store, &s, id);
        assert!(host
            .execute(&store, t.id, id, cmd, &Default::default())
            .is_err());
    }
    assert_eq!(count(&log, "request"), before);
    let close = task(&store, &s, "close");
    host.execute(
        &store,
        close.id,
        "close",
        C::Close {
            tab_id: tab.clone(),
        },
        &Default::default(),
    )
    .unwrap();
    let t = task(&store, &s, "closed");
    assert!(host
        .execute(
            &store,
            t.id,
            "closed",
            click(&tab, &fresh),
            &Default::default()
        )
        .is_err());
}
#[test]
fn actions_invalidate_snapshot_refs_and_require_reobservation() {
    let (_dir, store, s, _, g, log) = setup();
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).unwrap();
    let tab = open(&mut host, &store, &s, "new");
    let r = snap(&mut host, &store, &s, &tab, "snapshot");
    let t = task(&store, &s, "fill");
    assert_eq!(
        host.execute(
            &store,
            t.id,
            "fill",
            C::Fill {
                tab_id: tab.clone(),
                r#ref: r.clone(),
                value: "fixture".into()
            },
            &Default::default()
        )
        .unwrap()
        .status,
        "completed"
    );
    let before = count(&log, "request");
    let t = task(&store, &s, "stale");
    assert!(host
        .execute(&store, t.id, "stale", click(&tab, &r), &Default::default())
        .is_err());
    assert_eq!(count(&log, "request"), before);
    let fresh = snap(&mut host, &store, &s, &tab, "resnapshot");
    let t = task(&store, &s, "click");
    assert_eq!(
        host.execute(
            &store,
            t.id,
            "click",
            click(&tab, &fresh),
            &Default::default()
        )
        .unwrap()
        .status,
        "completed"
    );
    assert_eq!(count(&log, "effect"), 2);
}
#[test]
fn only_blank_fixture_navigation_and_no_mixed_filesystem_capability() {
    let (_dir, store, s, _, g, log) = setup();
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).unwrap();
    let tab = open(&mut host, &store, &s, "new");
    let before = count(&log, "request");
    for (i, url) in [
        "https://example.com",
        "http://127.0.0.1:12345",
        "file:///tmp/x",
        "javascript:run()",
        "https://user:password@example.com",
    ]
    .iter()
    .enumerate()
    {
        let id = format!("nav-{i}");
        let t = task(&store, &s, &id);
        assert!(host
            .execute(
                &store,
                t.id,
                &id,
                C::Navigate {
                    tab_id: tab.clone(),
                    url: (*url).into()
                },
                &Default::default()
            )
            .is_err());
    }
    let t = store
        .submit(
            &s,
            "mixed",
            "mixed",
            None,
            Some("/tmp/should-not-land"),
            Some("x"),
        )
        .unwrap()
        .0;
    assert!(host
        .execute(&store, t.id, "mixed", C::Tabs, &Default::default())
        .is_err());
    assert_eq!(count(&log, "request"), before);
}
#[test]
fn page_claims_are_quarantined_and_cannot_approve_or_resume() {
    let (_dir, store, s, trusted, g, log) = setup();
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).unwrap();
    let tab = open(&mut host, &store, &s, "new");
    let _ = snap(&mut host, &store, &s, &tab, "snapshot");
    let data = browser::receipt(&store, "snapshot")
        .unwrap()
        .unwrap()
        .untrusted_data
        .unwrap();
    assert_eq!(data["approval"]["granted"], true);
    assert_eq!(data["resume"], true);
    assert!(
        serde_json::from_value::<C>(serde_json::json!({"operation":"approve","granted":true}))
            .is_err()
    );
    assert!(serde_json::from_value::<C>(serde_json::json!({"operation":"resume"})).is_err());
    host.handoff(&store, &trusted).unwrap();
    assert!(BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).is_err());
    assert_eq!(count(&log, "spawn"), 1);
}
#[test]
fn cancellation_before_dispatch_has_no_effect_or_child_request() {
    let (_dir, store, s, _, g, log) = setup();
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).unwrap();
    let t = task(&store, &s, "cancel");
    let before = count(&log, "request");
    let control = RunControl::default();
    control.cancellation.cancel();
    assert!(host
        .execute(&store, t.id, "cancel", C::New, &control)
        .is_err());
    assert_eq!(store.task(&t.uuid).unwrap().unwrap().status, "cancelled");
    assert_eq!(count(&log, "request"), before);
    assert_eq!(effects(&store), 0);
}
#[test]
fn cancelled_effect_blocks_restart_and_old_unknown_never_replays_after_trusted_resume() {
    let (_dir, store, s, trusted, g, log) = setup();
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "very_late", &log).unwrap();
    let tab = open(&mut host, &store, &s, "new");
    let r = snap(&mut host, &store, &s, &tab, "snapshot");
    let scope = host.scope().to_string();
    let t = task(&store, &s, "cancelled-effect");
    let control = RunControl::default();
    let cancellation = control.cancellation.clone();
    let path = log.clone();
    let cancel = std::thread::spawn(move || {
        let end = Instant::now() + Duration::from_secs(3);
        while count(&path, "effect") == 0 {
            assert!(Instant::now() < end);
            std::thread::sleep(Duration::from_millis(2));
        }
        cancellation.cancel();
    });
    assert_eq!(
        host.execute(&store, t.id, "cancelled-effect", click(&tab, &r), &control)
            .unwrap()
            .status,
        "uncertain"
    );
    cancel.join().unwrap();
    assert!(!host.is_alive());
    assert_eq!(count(&log, "effect"), 1);
    assert_eq!(
        host.execute(
            &store,
            t.id,
            "cancelled-effect",
            click(&tab, &r),
            &Default::default()
        )
        .unwrap()
        .status,
        "uncertain"
    );
    assert!(host
        .execute(&store, t.id, "new-id", click(&tab, &r), &Default::default())
        .is_err());
    drop(host);
    assert!(BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).is_err());
    trusted
        .reconcile_without_replay(&store, &s, "Reviewed fixture unknown; do not replay")
        .unwrap();
    let mut fresh = BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).unwrap();
    assert_ne!(fresh.scope(), scope);
    let newtab = open(&mut fresh, &store, &s, "fresh-new");
    let newtask = task(&store, &s, "old-ref");
    assert!(fresh
        .execute(
            &store,
            newtask.id,
            "old-ref",
            click(&newtab, &r),
            &Default::default()
        )
        .is_err());
    assert_eq!(
        fresh
            .execute(
                &store,
                t.id,
                "cancelled-effect",
                click(&tab, &r),
                &Default::default()
            )
            .unwrap()
            .status,
        "uncertain"
    );
    assert_eq!(count(&log, "effect"), 1);
    assert_eq!(
        browser::receipt(&store, "cancelled-effect")
            .unwrap()
            .unwrap()
            .review
            .as_deref(),
        Some("do_not_replay")
    );
}
#[test]
fn timeout_discards_late_result_and_terminates_owned_child() {
    let (_dir, store, s, _, g, log) = setup();
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "late", &log).unwrap();
    let tab = open(&mut host, &store, &s, "new");
    let r = snap(&mut host, &store, &s, &tab, "snapshot");
    let t = task(&store, &s, "timeout");
    let control = RunControl {
        timeout: Duration::from_millis(60),
        ..Default::default()
    };
    let result = host
        .execute(&store, t.id, "timeout", click(&tab, &r), &control)
        .unwrap();
    assert_eq!(result.status, "uncertain");
    assert!(result.untrusted_data.is_none());
    assert!(!host.is_alive());
    assert_eq!(count(&log, "effect"), 1);
    let future = task(&store, &s, "late-result");
    assert!(host
        .execute(
            &store,
            future.id,
            "late-result",
            C::Tabs,
            &Default::default()
        )
        .is_err());
    assert_eq!(store.task(&future.uuid).unwrap().unwrap().status, "queued");
}
#[test]
fn crash_and_forged_or_oversized_receipts_are_uncertain_and_never_replayed() {
    for mode in [
        "crash",
        "forged",
        "wrong_id",
        "huge",
        "bad_content",
        "unknown",
    ] {
        let (_dir, store, s, _, g, log) = setup();
        let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), mode, &log).unwrap();
        let tab = open(&mut host, &store, &s, "new");
        let r = snap(&mut host, &store, &s, &tab, "snapshot");
        let t = task(&store, &s, "bad");
        let result = host
            .execute(&store, t.id, "bad", click(&tab, &r), &Default::default())
            .unwrap();
        assert_eq!(result.status, "uncertain", "{mode}");
        assert!(!host.is_alive());
        assert_eq!(
            host.execute(&store, t.id, "bad", click(&tab, &r), &Default::default())
                .unwrap()
                .status,
            "uncertain"
        );
        assert_eq!(count(&log, "effect"), 1);
        let state: String = store
            .conn
            .query_row(
                "SELECT status FROM effects WHERE id=?1",
                [result.effect_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "uncertain");
    }
}
#[test]
fn invalid_snapshot_scope_fails_closed() {
    let (_dir, store, s, _, g, log) = setup();
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "bad_snapshot", &log).unwrap();
    let tab = open(&mut host, &store, &s, "new");
    let t = task(&store, &s, "snapshot");
    assert_eq!(
        host.execute(
            &store,
            t.id,
            "snapshot",
            C::Snapshot { tab_id: tab },
            &Default::default()
        )
        .unwrap()
        .status,
        "uncertain"
    );
    assert!(!host.is_alive());
}
#[test]
fn definitive_child_rejection_is_failed_and_never_repeated() {
    let (_dir, store, s, _, g, log) = setup();
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "child_error", &log).unwrap();
    let tab = open(&mut host, &store, &s, "new");
    let r = snap(&mut host, &store, &s, &tab, "snapshot");
    let t = task(&store, &s, "rejected");
    let result = host
        .execute(
            &store,
            t.id,
            "rejected",
            click(&tab, &r),
            &Default::default(),
        )
        .unwrap();
    assert_eq!(result.status, "failed");
    assert!(host.is_alive());
    assert!(result.untrusted_data.unwrap()["error"]
        .as_str()
        .unwrap()
        .contains("approved"));
    assert_eq!(
        host.execute(
            &store,
            t.id,
            "rejected",
            click(&tab, &r),
            &Default::default()
        )
        .unwrap()
        .status,
        "failed"
    );
    assert_eq!(count(&log, "effect"), 1);
}
#[test]
fn intent_transaction_failure_forwards_zero_bytes_and_leaves_queued() {
    let (_dir, store, s, _, g, log) = setup();
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).unwrap();
    let before = count(&log, "request");
    let t = task(&store, &s, "fault");
    store.conn.execute_batch("CREATE TRIGGER fail_browser_intent BEFORE INSERT ON browser_calls BEGIN SELECT RAISE(FAIL,'fixture'); END;").unwrap();
    assert!(host
        .execute(&store, t.id, "fault", C::New, &Default::default())
        .is_err());
    assert_eq!(store.task(&t.uuid).unwrap().unwrap().status, "queued");
    assert_eq!(effects(&store), 0);
    assert_eq!(count(&log, "request"), before);
    assert!(store.outbox().unwrap().is_empty());
}
#[test]
fn terminal_commit_failure_recovers_task_effect_and_receipt_atomically() {
    let (dir, store, s, _, g, log) = setup();
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).unwrap();
    let tab = open(&mut host, &store, &s, "new");
    let r = snap(&mut host, &store, &s, &tab, "snapshot");
    let t = task(&store, &s, "fault");
    store.conn.execute_batch("CREATE TRIGGER fail_browser_finish BEFORE INSERT ON outbox WHEN NEW.message_id='fault' BEGIN SELECT RAISE(FAIL,'fixture'); END;").unwrap();
    assert!(host
        .execute(&store, t.id, "fault", click(&tab, &r), &Default::default())
        .is_err());
    assert!(!host.is_alive());
    assert_eq!(store.task(&t.uuid).unwrap().unwrap().status, "running");
    assert_eq!(count(&log, "effect"), 1);
    store
        .conn
        .execute_batch("DROP TRIGGER fail_browser_finish;")
        .unwrap();
    drop(host);
    drop(store);
    let store = ProfileStore::open_profile(dir.path(), "a").unwrap();
    browser::recover(&store).unwrap();
    let receipt = browser::receipt(&store, "fault").unwrap().unwrap();
    assert_eq!(receipt.status, "uncertain");
    assert!(receipt.problem.unwrap().contains("interrupted"));
    assert!(BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).is_err());
    assert_eq!(store.outbox().unwrap().len(), 3);
    assert_eq!(count(&log, "effect"), 1);
    browser::recover(&store).unwrap();
    assert_eq!(store.outbox().unwrap().len(), 3);
}
#[test]
fn trusted_handoff_requires_own_ghost_and_new_scope_after_resume() {
    let (dir, store, s, trusted, g, log) = setup();
    let b = ProfileStore::create_profile(dir.path(), "b", "b").unwrap();
    let foreign = TrustedFixtureControl::local_fixture_host(&b);
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).unwrap();
    let scope = host.scope().to_string();
    assert!(host.handoff(&store, &foreign).is_err());
    assert!(host.is_alive());
    host.handoff(&store, &trusted).unwrap();
    assert!(!host.is_alive());
    assert!(BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).is_err());
    assert!(foreign
        .reconcile_without_replay(&store, &s, "forged")
        .is_err());
    trusted
        .reconcile_without_replay(&store, &s, "local fixture reviewed")
        .unwrap();
    drop(host);
    let fresh = BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).unwrap();
    assert_ne!(fresh.scope(), scope);
    assert_eq!(count(&log, "spawn"), 2);
}
#[test]
fn actual_host_process_kill_recovers_pending_intent_without_pid_attach_or_replay() {
    let (dir, store, s, _, g, log) = setup();
    drop(store);
    let mut process = std::process::Command::new(exe())
        .args([
            "--host-crash",
            "--root",
            dir.path().to_str().unwrap(),
            "--session",
            &s,
            "--grant",
            &g.to_string(),
            "--log",
            log.to_str().unwrap(),
        ])
        .env_clear()
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    while count(&log, "effect") == 0 {
        assert!(Instant::now() < deadline);
        assert!(process.try_wait().unwrap().is_none());
        std::thread::sleep(Duration::from_millis(2));
    }
    process.kill().unwrap();
    process.wait().unwrap();
    let store = ProfileStore::open_profile(dir.path(), "a").unwrap();
    browser::recover(&store).unwrap();
    let result = browser::receipt(&store, "host-action").unwrap().unwrap();
    assert_eq!(result.status, "uncertain");
    assert_eq!(count(&log, "effect"), 1);
    assert!(BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).is_err());
    assert_eq!(count(&log, "spawn"), 1);
    let active: i64 = store
        .conn
        .query_row(
            "SELECT COUNT(*) FROM browser_children WHERE active=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(active, 0);
    std::thread::sleep(Duration::from_millis(3200));
    assert_eq!(count(&log, "effect"), 1);
}

#[test]
fn effect_update_mismatch_cannot_commit_a_success_receipt() {
    let (_dir, store, s, _, g, log) = setup();
    let mut host = BrowserHost::start_fixture(&store, &s, g, exe(), "normal", &log).unwrap();
    store.conn.execute_batch("CREATE TRIGGER ignore_effect BEFORE UPDATE ON effects WHEN NEW.action='browser' AND NEW.status='completed' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    let t = task(&store, &s, "ledger-fault");
    assert!(host
        .execute(&store, t.id, "ledger-fault", C::New, &Default::default())
        .is_err());
    assert_eq!(store.task(&t.uuid).unwrap().unwrap().status, "running");
    assert!(store.outbox().unwrap().is_empty());
    assert!(!host.is_alive());
    let state: String = store
        .conn
        .query_row("SELECT status FROM effects WHERE task_id=?1", [t.id], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(state, "started");
}
