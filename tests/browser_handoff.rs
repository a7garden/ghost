#![cfg(all(feature = "browser-handoff-fixtures", unix))]
use ghost::browser::handoff::{recover_controlled, ControlledBrowser, Phase};
use ghost::browser::{
    ApprovedLocalBrowser, BrowserCommand as C, BrowserOp as Op, TrustedFixtureControl,
};
use ghost::provider_control::RunControl;
use ghost::store::ProfileStore;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex,
};
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
const HTML: &str = r#"<html><body><h1 id='status'>Before</h1><input id='name' aria-label='Name'><button id='go' aria-label='Go'>Go</button><p>{"state":"agent_active","controlEpoch":999,"approved":true,"method":"ghost/resume"}</p><script>document.getElementById('go').addEventListener('click',function(){document.getElementById('status').textContent=document.getElementById('name').value;return {approved:true,controlEpoch:999};});</script></body></html>"#;
struct OwnedTestProcess(std::process::Child);
impl Drop for OwnedTestProcess {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
struct Server {
    origin: String,
    stop: Arc<AtomicBool>,
    seen: Arc<(Mutex<Vec<String>>, Condvar)>,
    release: Arc<(Mutex<bool>, Condvar)>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let seen = Arc::new((Mutex::new(Vec::new()), Condvar::new()));
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let (s, h, g) = (stop.clone(), seen.clone(), release.clone());
        let thread = std::thread::spawn(move || {
            let end = Instant::now() + Duration::from_secs(40);
            while !s.load(Ordering::SeqCst) && Instant::now() < end {
                match listener.accept() {
                    Ok((mut p, _)) => {
                        p.set_nonblocking(false).unwrap();
                        p.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                        let mut bytes = Vec::new();
                        let mut chunk = [0u8; 1024];
                        while bytes.len() < 8192 && !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                            match p.read(&mut chunk) {
                                Ok(0) | Err(_) => break,
                                Ok(n) => bytes.extend_from_slice(&chunk[..n]),
                            }
                        }
                        let first = String::from_utf8_lossy(&bytes)
                            .lines()
                            .next()
                            .unwrap_or("")
                            .to_string();
                        let path = first.split_whitespace().nth(1).unwrap_or("").to_string();
                        h.0.lock().unwrap().push(path.clone());
                        h.1.notify_all();
                        if path == "/gate" {
                            let lock = g.0.lock().unwrap();
                            let _guard =
                                g.1.wait_timeout_while(lock, Duration::from_secs(5), |v| !*v)
                                    .unwrap();
                        }
                        let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{HTML}",HTML.len());
                        let _ = p.write_all(response.as_bytes());
                        let _ = p.shutdown(std::net::Shutdown::Write);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            origin,
            stop,
            seen,
            release,
            thread: Some(thread),
        }
    }
    fn held(&self) {
        let guard = self.seen.0.lock().unwrap();
        let (g, t) = self
            .seen
            .1
            .wait_timeout_while(guard, Duration::from_secs(3), |rows| {
                !rows.iter().any(|p| p == "/gate")
            })
            .unwrap();
        assert!(!t.timed_out() && g.iter().any(|p| p == "/gate"));
    }
    fn release(&self) {
        *self.release.0.lock().unwrap() = true;
        self.release.1.notify_all();
    }
    fn count(&self, path: &str) -> usize {
        self.seen
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.as_str() == path)
            .count()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.release();
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn pin(origin: &str) -> ApprovedLocalBrowser {
    let file =
        std::env::var("GHOST_HANDOFF_PIN").expect("explicit controlled runtime pin required");
    let p: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    ApprovedLocalBrowser::pin(
        std::path::Path::new(p["pinnedBinary"].as_str().unwrap()),
        p["binarySha256"].as_str().unwrap(),
        origin,
    )
    .unwrap()
}
fn setup(
    origin: &str,
) -> (
    TempDir,
    ProfileStore,
    String,
    String,
    TrustedFixtureControl,
    i64,
    ApprovedLocalBrowser,
) {
    let dir = TempDir::new().unwrap();
    let store = ProfileStore::create_profile(dir.path(), "a", "fixture").unwrap();
    let session = store.create_session().unwrap().uuid;
    let anchor = store
        .submit(
            &session,
            "anchor",
            "fixture ownership anchor",
            None,
            None,
            None,
        )
        .unwrap()
        .0
        .uuid;
    let trusted = TrustedFixtureControl::local_fixture_host(&store);
    let pin = pin(origin);
    let grant = trusted
        .approve_controlled(&store, &session, &anchor, OPS, &pin)
        .unwrap();
    (dir, store, session, anchor, trusted, grant, pin)
}
fn task(store: &ProfileStore, s: &str, id: &str) -> i64 {
    store.submit(s, id, id, None, None, None).unwrap().0.id
}
fn agent(h: &mut ControlledBrowser, store: &ProfileStore, s: &str, id: &str, cmd: C) -> Value {
    let t = task(store, s, id);
    let q = h.start_agent(t, id, cmd, &Default::default()).unwrap();
    let r = h.wait(&q).unwrap();
    assert_eq!(r.status, "completed", "{id}: {r:?}");
    r.historical_data.unwrap()
}
fn new(h: &mut ControlledBrowser, store: &ProfileStore, s: &str, id: &str) -> String {
    agent(h, store, s, id, C::New)["tab_id"]
        .as_str()
        .unwrap()
        .into()
}
fn snap(h: &mut ControlledBrowser, store: &ProfileStore, s: &str, id: &str, tab: &str) -> Value {
    agent(h, store, s, id, C::Snapshot { tab_id: tab.into() })
}
fn navigate(
    h: &mut ControlledBrowser,
    store: &ProfileStore,
    s: &str,
    id: &str,
    tab: &str,
    url: String,
) {
    agent(
        h,
        store,
        s,
        id,
        C::Navigate {
            tab_id: tab.into(),
            url,
        },
    );
}
fn target(v: &Value, name: &str) -> String {
    v["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == name)
        .unwrap()["ref"]
        .as_str()
        .unwrap()
        .into()
}
fn take(h: &mut ControlledBrowser, t: &TrustedFixtureControl, id: &str, lease: &str) {
    let q = h.begin_handoff(t, id, lease, &Default::default()).unwrap();
    assert_eq!(h.wait(&q).unwrap().status, "completed");
    assert_eq!(h.state().unwrap().state, Phase::Human);
}
fn resume(h: &mut ControlledBrowser, t: &TrustedFixtureControl, id: &str, lease: &str) {
    let q = h.begin_resume(t, id, lease, &Default::default()).unwrap();
    assert_eq!(h.wait(&q).unwrap().status, "completed");
    assert_eq!(h.state().unwrap().state, Phase::Refresh);
}
#[test]
fn real_private_handoff_human_fixture_and_all_tab_fresh_barrier() {
    let server = Server::new();
    let (_dir, store, s, a, t, g, p) = setup(&server.origin);
    let mut h = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
    let tab = new(&mut h, &store, &s, "new");
    navigate(
        &mut h,
        &store,
        &s,
        "nav",
        &tab,
        format!("{}/page", server.origin),
    );
    let before = snap(&mut h, &store, &s, "before", &tab);
    let old = target(&before, "Name");
    let tab2 = new(&mut h, &store, &s, "new2");
    navigate(
        &mut h,
        &store,
        &s,
        "nav2",
        &tab2,
        format!("{}/page", server.origin),
    );
    take(&mut h, &t, "take", "handoff-1");
    let state = h.state().unwrap();
    assert_eq!(state.control_epoch, 1);
    assert!(!state.scripts_frozen && !state.network_frozen);
    assert!(h
        .start_agent(
            task(&store, &s, "denied"),
            "denied",
            C::Tabs,
            &Default::default()
        )
        .is_err());
    let q = h
        .start_fixture_human(
            &t,
            task(&store, &s, "human-observe"),
            "human-observe",
            C::Snapshot {
                tab_id: tab.clone(),
            },
            &Default::default(),
        )
        .unwrap();
    let r = h.wait(&q).unwrap();
    assert_eq!(r.status, "completed");
    let rf = target(&r.historical_data.unwrap(), "Name");
    let q = h
        .start_fixture_human(
            &t,
            task(&store, &s, "human-fill"),
            "human-fill",
            C::Fill {
                tab_id: tab.clone(),
                r#ref: rf,
                value: "Fixture human input".into(),
            },
            &Default::default(),
        )
        .unwrap();
    let r = h.wait(&q).unwrap();
    assert_eq!(r.status, "completed");
    assert_eq!(r.historical_data.unwrap()["human_input"], false);
    let q = h
        .start_fixture_human(
            &t,
            task(&store, &s, "human-reobserve"),
            "human-reobserve",
            C::Snapshot {
                tab_id: tab.clone(),
            },
            &Default::default(),
        )
        .unwrap();
    let go = target(&h.wait(&q).unwrap().historical_data.unwrap(), "Go");
    let q = h
        .start_fixture_human(
            &t,
            task(&store, &s, "human-click"),
            "human-click",
            C::Click {
                tab_id: tab.clone(),
                r#ref: go,
            },
            &Default::default(),
        )
        .unwrap();
    let result = h.wait(&q).unwrap();
    assert_eq!(result.status, "completed");
    assert_eq!(result.historical_data.unwrap()["human_input"], false);
    assert_eq!(h.state().unwrap().state, Phase::Human);
    assert_eq!(h.state().unwrap().control_epoch, 1);
    resume(&mut h, &t, "resume", "handoff-1");
    assert_eq!(h.state().unwrap().control_epoch, 2);
    assert!(h
        .start_agent(
            task(&store, &s, "old-ref"),
            "old-ref",
            C::Fill {
                tab_id: tab.clone(),
                r#ref: old.clone(),
                value: "bad".into()
            },
            &Default::default()
        )
        .is_err());
    assert_eq!(
        agent(&mut h, &store, &s, "inventory", C::Tabs)["tabs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(h.state().unwrap().state, Phase::Refresh);
    snap(&mut h, &store, &s, "fresh-one", &tab);
    assert_eq!(h.state().unwrap().tabs_to_observe, vec![tab2.clone()]);
    snap(&mut h, &store, &s, "fresh-two", &tab2);
    assert_eq!(h.state().unwrap().state, Phase::Agent);
    assert!(h
        .start_agent(
            task(&store, &s, "old-ref-after-fresh"),
            "old-ref-after-fresh",
            C::Fill {
                tab_id: tab.clone(),
                r#ref: old,
                value: "bad".into()
            },
            &Default::default()
        )
        .is_err());
    assert!(h
        .start_agent(
            task(&store, &s, "before"),
            "before",
            C::Snapshot {
                tab_id: tab.clone()
            },
            &Default::default()
        )
        .is_err());
    let no_effect:i64=store.conn.query_row("SELECT COUNT(*) FROM effects WHERE task_id IN (SELECT id FROM tasks WHERE message_id IN ('denied','old-ref','old-ref-after-fresh'))",[],|r|r.get(0)).unwrap();
    assert_eq!(no_effect, 0);
    h.shutdown().unwrap();
}
#[test]
fn historical_control_duplicates_never_roll_epoch_back_or_repeat_effects() {
    let server = Server::new();
    let (_d, store, s, a, t, g, p) = setup(&server.origin);
    let mut h = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
    take(&mut h, &t, "take-1", "lease-1");
    resume(&mut h, &t, "resume-1", "lease-1");
    // Zero tabs still require a new inventory observation.
    assert_eq!(h.state().unwrap().state, Phase::Refresh);
    agent(&mut h, &store, &s, "fresh-empty", C::Tabs);
    assert_eq!(h.state().unwrap().state, Phase::Agent);
    take(&mut h, &t, "take-2", "lease-2");
    let before = h.state().unwrap();
    assert_eq!(before.control_epoch, 3);
    let q = h
        .begin_resume(&t, "resume-1", "lease-1", &Default::default())
        .unwrap();
    let old = h.wait(&q).unwrap();
    assert_eq!(old.status, "completed");
    assert_eq!(old.historical_data.unwrap()["hostState"]["controlEpoch"], 2);
    assert_eq!(h.state().unwrap().control_epoch, 3);
    assert_eq!(h.state().unwrap().state, Phase::Human);
    assert!(h
        .begin_resume(&t, "resume-1", "lease-2", &Default::default())
        .is_err());
    resume(&mut h, &t, "resume-2", "lease-2");
    agent(&mut h, &store, &s, "empty-again", C::Tabs);
    assert!(h
        .begin_handoff(&t, "new-take", "lease-1", &Default::default())
        .is_err());
    let count: i64 = store
        .conn
        .query_row(
            "SELECT COUNT(*) FROM hc_requests WHERE request_id='resume-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}
#[test]
fn pending_agent_handoff_waits_for_effect_and_blocks_new_admission() {
    let server = Server::new();
    let (_d, store, s, a, t, g, p) = setup(&server.origin);
    let mut h = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
    let tab = new(&mut h, &store, &s, "new");
    let op = task(&store, &s, "held");
    let cmd = C::Navigate {
        tab_id: tab,
        url: format!("{}/gate", server.origin),
    };
    let q = h
        .start_agent(op, "held", cmd.clone(), &Default::default())
        .unwrap();
    server.held();
    let hand = h
        .begin_handoff(&t, "take", "lease", &Default::default())
        .unwrap();
    assert_eq!(h.state().unwrap().state, Phase::Pausing);
    let dup = h.start_agent(op, "held", cmd, &Default::default()).unwrap();
    assert!(h
        .start_agent(
            task(&store, &s, "denied"),
            "denied",
            C::Tabs,
            &Default::default()
        )
        .is_err());
    assert!(h
        .begin_resume(&t, "early-resume", "lease", &Default::default())
        .is_err());
    assert_eq!(store.task_by_id(op).unwrap().unwrap().status, "running");
    server.release();
    // Waiting for host control continuously drains and settles agent stdout first.
    assert_eq!(h.wait(&hand).unwrap().status, "completed");
    assert_eq!(h.wait(&q).unwrap().status, "completed");
    assert_eq!(h.wait(&dup).unwrap().status, "completed");
    assert_eq!(h.state().unwrap().state, Phase::Human);
    assert_eq!(server.count("/gate"), 1);
}
#[test]
fn human_operation_blocks_resume_race_and_duplicate_shares_one_effect() {
    let server = Server::new();
    let (_d, store, s, a, t, g, p) = setup(&server.origin);
    let mut h = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
    let tab = new(&mut h, &store, &s, "new");
    take(&mut h, &t, "take", "lease");
    let op = task(&store, &s, "human-held");
    let cmd = C::Navigate {
        tab_id: tab.clone(),
        url: format!("{}/gate", server.origin),
    };
    let q = h
        .start_fixture_human(&t, op, "human-held", cmd.clone(), &Default::default())
        .unwrap();
    server.held();
    let duplicate = h
        .start_fixture_human(&t, op, "human-held", cmd, &Default::default())
        .unwrap();
    assert!(h
        .begin_resume(&t, "too-early", "lease", &Default::default())
        .is_err());
    assert!(h
        .start_fixture_human(
            &t,
            task(&store, &s, "second-human"),
            "second-human",
            C::Tabs,
            &Default::default()
        )
        .is_err());
    server.release();
    assert_eq!(h.wait(&q).unwrap().status, "completed");
    assert_eq!(h.wait(&duplicate).unwrap().status, "completed");
    assert_eq!(server.count("/gate"), 1);
    resume(&mut h, &t, "resume", "lease");
    snap(&mut h, &store, &s, "fresh", &tab);
    assert_eq!(h.state().unwrap().state, Phase::Agent);
}
#[test]
fn independent_watchdog_ends_actual_child_before_child_deadline() {
    let server = Server::new();
    let (_d, store, s, a, t, g, p) = setup(&server.origin);
    let mut h = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
    let tab = new(&mut h, &store, &s, "new");
    h.longer_child_deadline_for_test();
    let op = task(&store, &s, "timeout");
    let ctl = RunControl {
        timeout: Duration::from_millis(200),
        ..Default::default()
    };
    let q = h
        .start_agent(
            op,
            "timeout",
            C::Navigate {
                tab_id: tab,
                url: format!("{}/gate", server.origin),
            },
            &ctl,
        )
        .unwrap();
    server.held();
    let start = Instant::now();
    while h.is_alive() && start.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!h.is_alive());
    assert_eq!(
        h.termination_cause_for_test(),
        "owned watchdog deadline or cancellation"
    );
    assert!(start.elapsed() < Duration::from_secs(2));
    assert_eq!(h.wait(&q).unwrap().status, "uncertain");
    server.release();
    assert!(ControlledBrowser::start(&store, &s, g, &a, &p).is_err());
    assert_eq!(h.wait(&q).unwrap().status, "uncertain");
    assert_eq!(server.count("/gate"), 1);
    drop(h);
    t.reconcile_without_replay(&store, &s, "fixture acknowledged unknown")
        .unwrap();
    let mut fresh = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
    agent(&mut fresh, &store, &s, "fresh-inventory", C::Tabs);
    assert_eq!(store.task_by_id(op).unwrap().unwrap().status, "uncertain");
    assert!(fresh
        .start_agent(op, "timeout", C::Tabs, &Default::default())
        .is_err());
}
#[test]
fn cancellation_kills_only_owned_child_and_keeps_other_ghost_usable() {
    let server = Server::new();
    let (_d, store, s, a, _t, g, p) = setup(&server.origin);
    let (_d2, other, s2, a2, _t2, g2, p2) = setup(&server.origin);
    let mut h = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
    let mut b = ControlledBrowser::start(&other, &s2, g2, &a2, &p2).unwrap();
    let tab = new(&mut h, &store, &s, "new");
    h.longer_child_deadline_for_test();
    let ctl = RunControl::default();
    let q = h
        .start_agent(
            task(&store, &s, "cancel"),
            "cancel",
            C::Navigate {
                tab_id: tab,
                url: format!("{}/gate", server.origin),
            },
            &ctl,
        )
        .unwrap();
    server.held();
    ctl.cancellation.cancel();
    assert_eq!(h.wait(&q).unwrap().status, "uncertain");
    assert!(!h.is_alive());
    agent(&mut b, &other, &s2, "other-inventory", C::Tabs);
    assert!(b.is_alive());
    server.release();
}
#[test]
fn private_control_eof_idle_and_pending_fail_closed() {
    for busy in [false, true] {
        let server = Server::new();
        let (_d, store, s, a, _t, g, p) = setup(&server.origin);
        let mut h = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
        let pending = if busy {
            let tab = new(&mut h, &store, &s, "new");
            let q = h
                .start_agent(
                    task(&store, &s, "busy"),
                    "busy",
                    C::Navigate {
                        tab_id: tab,
                        url: format!("{}/gate", server.origin),
                    },
                    &Default::default(),
                )
                .unwrap();
            server.held();
            Some(q)
        } else {
            None
        };
        h.disconnect_control_for_test();
        let deadline = Instant::now() + Duration::from_secs(2);
        while h.is_alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!h.is_alive());
        if let Some(q) = pending {
            assert_eq!(h.wait(&q).unwrap().status, "uncertain");
        } else {
            assert_eq!(h.state().unwrap().state, Phase::Closed);
        }
        assert!(ControlledBrowser::start(&store, &s, g, &a, &p).is_err());
        server.release();
    }
}
#[test]
fn actual_owned_child_crash_keeps_effect_unknown_after_fresh_restart() {
    let server = Server::new();
    let (_d, store, s, a, t, g, p) = setup(&server.origin);
    let mut h = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
    let old_scope = h.state().unwrap().browser_session_id;
    let tab = new(&mut h, &store, &s, "new");
    let op = task(&store, &s, "crash");
    let cmd = C::Navigate {
        tab_id: tab.clone(),
        url: format!("{}/gate", server.origin),
    };
    let q = h
        .start_agent(op, "crash", cmd.clone(), &Default::default())
        .unwrap();
    server.held();
    h.kill_owned_child_for_test();
    assert_eq!(h.wait(&q).unwrap().status, "uncertain");
    server.release();
    drop(h);
    t.reconcile_without_replay(&store, &s, "fixture crash acknowledged without replay")
        .unwrap();
    let mut fresh = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
    assert_ne!(fresh.state().unwrap().browser_session_id, old_scope);
    assert!(fresh.wait(&q).is_err());
    assert!(fresh
        .start_agent(op, "crash", cmd, &Default::default())
        .is_err());
    assert_eq!(server.count("/gate"), 1);
    agent(&mut fresh, &store, &s, "empty", C::Tabs);
}
#[test]
fn revoke_is_enforced_by_watchdog_idle_and_during_handoff() {
    for busy in [false, true] {
        let server = Server::new();
        let (_d, store, s, a, t, g, p) = setup(&server.origin);
        let mut h = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
        let pending = if busy {
            let tab = new(&mut h, &store, &s, "new");
            let q = h
                .start_agent(
                    task(&store, &s, "busy"),
                    "busy",
                    C::Navigate {
                        tab_id: tab,
                        url: format!("{}/gate", server.origin),
                    },
                    &Default::default(),
                )
                .unwrap();
            server.held();
            let hand = h
                .begin_handoff(&t, "take", "lease", &Default::default())
                .unwrap();
            Some((q, hand))
        } else {
            take(&mut h, &t, "take", "lease");
            None
        };
        t.revoke(&store, g).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while h.is_alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!h.is_alive());
        assert_eq!(
            h.termination_cause_for_test(),
            "control grant or anchor revoked"
        );
        if let Some((q, hand)) = pending {
            assert_eq!(h.wait(&q).unwrap().status, "uncertain");
            assert_eq!(h.wait(&hand).unwrap().status, "uncertain");
        } else {
            assert!(h
                .begin_resume(&t, "resume", "lease", &Default::default())
                .is_err());
        }
        server.release();
    }
}
#[test]
fn late_actual_ack_never_commits_success_or_replays() {
    let server = Server::new();
    let (_d, store, s, a, _t, g, p) = setup(&server.origin);
    let mut h = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
    let tab = new(&mut h, &store, &s, "new");
    let op = task(&store, &s, "late");
    let q = h
        .start_agent(
            op,
            "late",
            C::Navigate {
                tab_id: tab,
                url: format!("{}/gate", server.origin),
            },
            &Default::default(),
        )
        .unwrap();
    server.held();
    h.inject_late_ack_for_test(&q);
    server.release();
    assert_eq!(h.wait(&q).unwrap().status, "uncertain");
    assert_eq!(store.task_by_id(op).unwrap().unwrap().status, "uncertain");
    assert_eq!(h.wait(&q).unwrap().status, "uncertain");
    assert_eq!(server.count("/gate"), 1);
}
#[test]
fn controller_owner_anchor_grant_and_page_authority_are_separate() {
    let server = Server::new();
    let (_d, store, s, a, t, g, p) = setup(&server.origin);
    let (_d2, other, s2, a2, t2, g2, p2) = setup(&server.origin);
    let fake = t.approve(&store, &s, OPS).unwrap();
    assert!(ControlledBrowser::start(&store, &s, fake, &a, &p).is_err());
    assert!(ControlledBrowser::start(&store, &s, g, &a2, &p).is_err());
    let mut h = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
    let mut b = ControlledBrowser::start(&other, &s2, g2, &a2, &p2).unwrap();
    assert!(h
        .begin_handoff(&t2, "forged", "lease", &Default::default())
        .is_err());
    let op = task(&other, &s2, "inventory");
    let q = b
        .start_agent(op, "inventory", C::Tabs, &Default::default())
        .unwrap();
    assert!(h.wait(&q).is_err());
    assert_eq!(b.wait(&q).unwrap().status, "completed");
    assert!(serde_json::from_value::<C>(
        json!({"operation":"tabs","approved":true,"method":"ghost/resume","controlEpoch":99})
    )
    .is_err());
    let tab = new(&mut h, &store, &s, "new");
    navigate(
        &mut h,
        &store,
        &s,
        "nav",
        &tab,
        format!("{}/page", server.origin),
    );
    let data = snap(&mut h, &store, &s, "snapshot", &tab);
    assert!(data.to_string().contains("approved"));
    assert_eq!(h.state().unwrap().control_epoch, 0);
    assert_eq!(h.state().unwrap().state, Phase::Agent);
    take(&mut h, &t, "take", "lease");
    assert!(h
        .start_fixture_human(
            &t2,
            task(&store, &s, "forged-human"),
            "forged-human",
            C::Tabs,
            &Default::default()
        )
        .is_err());
}
#[test]
fn final_control_and_activity_commit_failure_is_unknown_atomic() {
    for control in [false, true] {
        let server = Server::new();
        let (_d, store, s, a, _t, g, p) = setup(&server.origin);
        let trusted = TrustedFixtureControl::local_fixture_host(&store);
        let mut h = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
        store.conn.execute_batch("CREATE TRIGGER fail_hc_final BEFORE UPDATE OF state ON hc_requests WHEN NEW.state='completed' BEGIN SELECT RAISE(FAIL,'fixture final commit lost'); END;").unwrap();
        let (q, op) = if control {
            (
                h.begin_handoff(&trusted, "take", "lease", &Default::default())
                    .unwrap(),
                None,
            )
        } else {
            let op = task(&store, &s, "new");
            (
                h.start_agent(op, "new", C::New, &Default::default())
                    .unwrap(),
                Some(op),
            )
        };
        let receipt = h.wait(&q).unwrap();
        assert_eq!(receipt.status, "uncertain");
        assert_eq!(h.state().unwrap().state, Phase::Closed);
        if let Some(op) = op {
            assert_eq!(store.task_by_id(op).unwrap().unwrap().status, "uncertain");
            let out: i64 = store
                .conn
                .query_row("SELECT COUNT(*) FROM outbox WHERE task_id=?1", [op], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(out, 1);
            let effects: String = store
                .conn
                .query_row("SELECT status FROM effects WHERE task_id=?1", [op], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(effects, "uncertain");
        }
        assert!(ControlledBrowser::start(&store, &s, g, &a, &p).is_err());
    }
}
#[test]
fn actual_host_process_crash_recovers_control_and_effect_without_retransmit() {
    if let Ok(raw) = std::env::var("GHOST_HC_HELPER") {
        let cfg: Value = serde_json::from_str(&raw).unwrap();
        let root = std::path::Path::new(cfg["root"].as_str().unwrap());
        let origin = cfg["origin"].as_str().unwrap();
        let store = ProfileStore::create_profile(root, "a", "crash fixture").unwrap();
        let s = store.create_session().unwrap().uuid;
        let a = store
            .submit(&s, "anchor", "anchor", None, None, None)
            .unwrap()
            .0
            .uuid;
        let t = TrustedFixtureControl::local_fixture_host(&store);
        let p = pin(origin);
        let g = t.approve_controlled(&store, &s, &a, OPS, &p).unwrap();
        let mut h = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
        let tab = new(&mut h, &store, &s, "new");
        let op = task(&store, &s, "interrupted");
        let _q = h
            .start_agent(
                op,
                "interrupted",
                C::Navigate {
                    tab_id: tab,
                    url: format!("{origin}/gate"),
                },
                &Default::default(),
            )
            .unwrap();
        let _control = h
            .begin_handoff(&t, "take", "lease", &Default::default())
            .unwrap();
        std::fs::write(
            root.join("ready.json"),
            json!({"session":s,"anchor":a,"grant":g,"op":op}).to_string(),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("owned crash fixture must be killed by parent");
    }
    let server = Server::new();
    let dir = TempDir::new().unwrap();
    let cfg = json!({"root":dir.path(),"origin":server.origin});
    let exe = std::env::current_exe().unwrap();
    let mut child = OwnedTestProcess(
        std::process::Command::new(exe)
            .args([
                "--exact",
                "actual_host_process_crash_recovers_control_and_effect_without_retransmit",
                "--test-threads=1",
            ])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C")
            .env(
                "GHOST_HANDOFF_PIN",
                std::env::var("GHOST_HANDOFF_PIN").unwrap(),
            )
            .env("GHOST_HC_HELPER", cfg.to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let ready = dir.path().join("ready.json");
    // Cold WebKit startup can exceed twelve seconds under parallel fixtures.
    // Keep this startup gate bounded and independent of operation deadlines.
    let end = Instant::now() + Duration::from_secs(30);
    while !ready.exists() && Instant::now() < end {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "fixture exited before intent"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(ready.exists());
    server.held();
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    server.release();
    let v: Value = serde_json::from_str(&std::fs::read_to_string(ready).unwrap()).unwrap();
    let store = ProfileStore::open_profile(dir.path(), "a").unwrap();
    recover_controlled(&store).unwrap();
    let s = v["session"].as_str().unwrap();
    let a = v["anchor"].as_str().unwrap();
    let g = v["grant"].as_i64().unwrap();
    let op = v["op"].as_i64().unwrap();
    assert_eq!(store.task_by_id(op).unwrap().unwrap().status, "uncertain");
    let t = TrustedFixtureControl::local_fixture_host(&store);
    let p = pin(&server.origin);
    assert!(ControlledBrowser::start(&store, s, g, a, &p).is_err());
    let closed: String = store
        .conn
        .query_row("SELECT state_json FROM hc_state", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&closed).unwrap()["state"],
        "closed"
    );
    let pending: i64 = store
        .conn
        .query_row(
            "SELECT COUNT(*) FROM hc_requests WHERE state='pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 0);
    t.reconcile_without_replay(&store, s, "fixture host crash acknowledged do_not_replay")
        .unwrap();
    let mut fresh = ControlledBrowser::start(&store, s, g, a, &p).unwrap();
    agent(&mut fresh, &store, s, "fresh-tabs", C::Tabs);
    assert_eq!(server.count("/gate"), 1);
    let out: i64 = store
        .conn
        .query_row("SELECT COUNT(*) FROM outbox WHERE task_id=?1", [op], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(out, 1);
}
#[test]
fn phase_persistence_loss_before_control_bytes_closes_and_reconciles() {
    let server = Server::new();
    let (_d, store, s, a, t, g, p) = setup(&server.origin);
    let mut h = ControlledBrowser::start(&store, &s, g, &a, &p).unwrap();
    store.conn.execute_batch("CREATE TRIGGER fail_phase BEFORE UPDATE ON hc_state BEGIN SELECT RAISE(FAIL,'fixture phase write failed'); END;").unwrap();
    assert!(h
        .begin_handoff(&t, "take", "lease", &Default::default())
        .is_err());
    assert!(!h.is_alive());
    let status: String = store
        .conn
        .query_row(
            "SELECT state FROM hc_requests WHERE request_id='take'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "uncertain");
    store
        .conn
        .execute_batch("DROP TRIGGER fail_phase;")
        .unwrap();
    drop(h);
    recover_controlled(&store).unwrap();
    let state: String = store
        .conn
        .query_row("SELECT state_json FROM hc_state", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&state).unwrap()["state"],
        "closed"
    );
    assert!(ControlledBrowser::start(&store, &s, g, &a, &p).is_err());
}
