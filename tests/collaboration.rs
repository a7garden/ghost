//! Collaboration unit tests: real SQLite + unique tempfile fixtures, offline
//! mock providers only, and real CLI subprocesses. No fixed /tmp paths, no
//! shared state between tests, no user files touched. The Ghost root lives at
//! `<tempdir>/state` and the scratch grant directory is a SIBLING outside the
//! root, so a write grant can never cover Ghost self-state.

use anyhow::Result;
use ghost::collaboration::{self, namespaced_message_key, Coordinator, ParentSpec, WorkerSpec};
use ghost::protocol::{self, DelegationEnvelope};
use ghost::provider::{Provider, ProviderRequest, ProviderResponse};
use ghost::store::ProfileStore;
use rusqlite::params;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

struct SelectiveProvider {
    fail: HashSet<String>,
    counts: Arc<Mutex<HashMap<String, usize>>>,
}

impl SelectiveProvider {
    fn ok(counts: Arc<Mutex<HashMap<String, usize>>>) -> Self {
        SelectiveProvider {
            fail: HashSet::new(),
            counts,
        }
    }
}

impl Provider for SelectiveProvider {
    fn name(&self) -> &'static str {
        "selective"
    }
    fn run(&self, req: &ProviderRequest) -> Result<ProviderResponse> {
        {
            let mut c = self.counts.lock().unwrap();
            *c.entry(req.profile_uuid.clone()).or_insert(0) += 1;
        }
        if self.fail.contains(&req.profile_uuid) {
            anyhow::bail!("selective failure for {}", req.profile_uuid);
        }
        Ok(ProviderResponse {
            content: format!("result:{}:{}", req.profile_uuid, req.message_id),
        })
    }
}

fn setup() -> (tempfile::TempDir, PathBuf) {
    let td = tempfile::tempdir().unwrap();
    let root = td.path().join("state");
    std::fs::create_dir_all(&root).unwrap();
    (td, root)
}

/// alpha has a preexisting write grant on a scratch SIBLING outside the Ghost
/// root (a grant inside the root must be rejected by self-state protection);
/// beta has none. Personas differ.
fn mk_profiles(root: &Path) -> (String, String, PathBuf) {
    let scratch = root.parent().unwrap().join("scratch");
    std::fs::create_dir_all(&scratch).unwrap();
    let a = ProfileStore::create_profile(root, "alpha", "research persona").unwrap();
    a.allow(&scratch, "write").unwrap();
    let b = ProfileStore::create_profile(root, "beta", "review persona").unwrap();
    (a.uuid.clone(), b.uuid.clone(), scratch)
}

fn spec() -> ParentSpec {
    ParentSpec {
        request_id: "req-1".into(),
        owner_profile: "alpha".into(),
        title: "shared objective".into(),
        workers: vec![
            WorkerSpec {
                profile: "alpha".into(),
                role: "research".into(),
            },
            WorkerSpec {
                profile: "beta".into(),
                role: "review".into(),
            },
        ],
    }
}

fn counts() -> Arc<Mutex<HashMap<String, usize>>> {
    Arc::new(Mutex::new(HashMap::new()))
}

fn total_calls(c: &Arc<Mutex<HashMap<String, usize>>>) -> usize {
    c.lock().unwrap().values().sum()
}

/// Deterministic journal fault injection: mutate the persisted envelope of
/// one child (by seq) directly in the coordinator journal.
fn corrupt_envelope(c: &Coordinator, wid: &str, seq: i64, f: impl FnOnce(&mut serde_json::Value)) {
    let env: String = c
        .journal_conn()
        .query_row(
            "SELECT envelope FROM children WHERE parent_id=(SELECT id FROM parents WHERE uuid=?1) AND seq=?2",
            params![wid, seq],
            |r| r.get(0),
        )
        .unwrap();
    let mut v: serde_json::Value = serde_json::from_str(&env).unwrap();
    f(&mut v);
    c.journal_conn()
        .execute(
            "UPDATE children SET envelope=?1 WHERE parent_id=(SELECT id FROM parents WHERE uuid=?2) AND seq=?3",
            params![v.to_string(), wid, seq],
        )
        .unwrap();
}

fn reset_beta_child_and_parent(c: &Coordinator) {
    c.journal_conn()
        .execute(
            "UPDATE children SET worker_status=NULL, artifact=NULL WHERE worker_profile='beta'",
            [],
        )
        .unwrap();
    c.journal_conn()
        .execute("UPDATE parents SET status='running', aggregate=NULL", [])
        .unwrap();
}

#[test]
fn two_ghosts_vertical_end_to_end() {
    let (_td, root) = setup();
    let (au, bu, _scratch) = mk_profiles(&root);
    let c = Coordinator::open(&root).unwrap();
    let wid = c.create(&spec()).unwrap();
    let cnt = counts();
    let p = SelectiveProvider::ok(cnt.clone());
    let snap = c.run(&wid, &p).unwrap();

    assert_eq!(snap["status"], "completed");
    let kids = snap["children"].as_array().unwrap();
    assert_eq!(kids.len(), 2);
    assert_eq!(kids[0]["role"], "research");
    assert_eq!(kids[1]["role"], "review");
    assert_eq!(kids[0]["worker_uuid"], au.as_str());
    assert_eq!(kids[1]["worker_uuid"], bu.as_str());
    assert_ne!(au, bu);
    // Separate sessions, tasks, attempts, process ids; none equal to ghost ids.
    let s0 = kids[0]["session_uuid"].as_str().unwrap();
    let s1 = kids[1]["session_uuid"].as_str().unwrap();
    let t0 = kids[0]["task_uuid"].as_str().unwrap();
    let t1 = kids[1]["task_uuid"].as_str().unwrap();
    let a0 = kids[0]["attempt_id"].as_str().unwrap();
    let pi0 = kids[0]["process_instance_id"].as_str().unwrap();
    assert_ne!(s0, s1);
    assert_ne!(t0, t1);
    let mut ids = vec![s0, s1, t0, t1, a0, pi0, au.as_str(), bu.as_str()];
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 8);
    // Artifacts: text/plain, correct sha256, validated lineage.
    for k in kids {
        let a = &k["artifact"];
        assert_eq!(a["media_type"], "text/plain");
        assert_eq!(a["profile_uuid"], k["worker_uuid"]);
        assert_eq!(a["task_uuid"], k["task_uuid"]);
        let content = a["content"].as_str().unwrap();
        assert_eq!(a["sha256"], protocol::sha256_hex(content));
    }
    let agg = snap["aggregate"].clone();
    assert_eq!(agg["owner_uuid"], au.as_str());
    assert_eq!(agg["results"].as_array().unwrap().len(), 2);

    // Reopen: stable ghost/task ids; idempotent repeated run.
    let before = collaboration::snapshot(&root, &wid).unwrap();
    assert_eq!(before["children"][0]["task_uuid"], t0);
    drop(c);
    let c2 = Coordinator::open(&root).unwrap();
    let cnt2 = counts();
    let p2 = SelectiveProvider::ok(cnt2.clone());
    let snap2 = c2.run(&wid, &p2).unwrap();
    assert_eq!(snap2["status"], "completed");
    assert_eq!(snap2["children"][0]["task_uuid"], t0);
    assert_eq!(snap2["children"][1]["task_uuid"], t1);
    assert_eq!(snap2["children"][0]["attempt_id"], a0);
    assert!(cnt2.lock().unwrap().values().all(|v| *v == 0));
}

#[test]
fn protocol_validation_and_sender_message_namespace() {
    let (_td, root) = setup();
    mk_profiles(&root);
    let c = Coordinator::open(&root).unwrap();
    let wid = c.create(&spec()).unwrap();
    // Journal envelope is text-only regardless of arbitrary prompt text.
    let snap = collaboration::snapshot(&root, &wid).unwrap();
    assert_eq!(snap["children"].as_array().unwrap().len(), 2);

    let mut e = DelegationEnvelope {
        version: 1,
        workflow_id: "w".into(),
        root_task_id: "r".into(),
        parent_task_id: "r".into(),
        delegation_id: "d".into(),
        sender_uuid: "s".into(),
        recipient_uuid: "rc".into(),
        message_id: "m".into(),
        role: "role".into(),
        capability_ceiling: protocol::text_only_ceiling(),
        objective: "o".into(),
        task_prompt: "p".into(),
    };
    assert!(protocol::validate(&e).is_ok());
    e.version = 2;
    assert!(protocol::validate(&e).is_err());
    e.version = 1;
    e.capability_ceiling = vec!["text".into(), "filesystem".into()];
    assert!(protocol::validate(&e).is_err());
    e.capability_ceiling = vec!["write".into()];
    assert!(protocol::validate(&e).is_err());
    e.capability_ceiling = protocol::text_only_ceiling();
    e.role = "  ".into();
    assert!(protocol::validate(&e).is_err());

    // Same message_id from two senders must not collide.
    let k1 = namespaced_message_key("sender-a", "m1");
    let k2 = namespaced_message_key("sender-b", "m1");
    assert_ne!(k1, k2);
    let v: serde_json::Value = serde_json::from_str(&k1).unwrap();
    assert_eq!(v["sender"], "sender-a");
    assert_eq!(v["message_id"], "m1");
}

#[test]
fn unrelated_write_task_not_executed_or_cancelled() {
    let (_td, root) = setup();
    let (_au, _bu, scratch) = mk_profiles(&root);
    let a = ProfileStore::open_profile(&root, "alpha").unwrap();
    let sess = a.create_session().unwrap();
    let target = scratch.join("unrelated.txt");
    a.submit(
        &sess.uuid,
        "unrelated-1",
        "write something",
        None,
        Some(target.to_string_lossy().as_ref()),
        Some("payload"),
    )
    .unwrap();
    drop(a);

    let c = Coordinator::open(&root).unwrap();
    let wid = c.create(&spec()).unwrap();
    let p = SelectiveProvider::ok(counts());
    let snap = c.run(&wid, &p).unwrap();
    assert_eq!(snap["status"], "completed");
    assert!(!target.exists());

    let a = ProfileStore::open_profile(&root, "alpha").unwrap();
    let unrelated = a.task("unrelated-1").unwrap().unwrap();
    assert_eq!(unrelated.status, "queued"); // not executed, not cancelled
    assert_eq!(a.grants().unwrap().len(), 1); // native grant unchanged
    assert_eq!(a.tasks().unwrap().len(), 2); // one unrelated + one delegated
}

#[test]
fn duplicate_request_and_replay_reject_conflicts() {
    let (_td, root) = setup();
    mk_profiles(&root);
    let c = Coordinator::open(&root).unwrap();
    let w1 = c.create(&spec()).unwrap();
    let w2 = c.create(&spec()).unwrap();
    assert_eq!(w1, w2); // exact replay returns same parent
    let mut conflicting = spec();
    conflicting.title = "different objective".into();
    assert!(c.create(&conflicting).is_err());
    let mut swapped = spec();
    swapped.workers.reverse();
    assert!(c.create(&swapped).is_err());

    let p = SelectiveProvider::ok(counts());
    c.run(&w1, &p).unwrap();
    let s1 = collaboration::snapshot(&root, &w1).unwrap();
    c.run(&w1, &p).unwrap();
    let s2 = collaboration::snapshot(&root, &w1).unwrap();
    assert_eq!(s1, s2); // no new task/outbox/attempt/result on repeated run
    for prof in ["alpha", "beta"] {
        let s = ProfileStore::open_profile(&root, prof).unwrap();
        assert_eq!(s.tasks().unwrap().len(), 1);
        assert_eq!(s.outbox().unwrap().len(), 1);
    }
}

#[test]
fn ack_failure_after_inbox_commit_recovers_exactly_once() {
    let (_td, root) = setup();
    mk_profiles(&root);
    let c = Coordinator::open(&root).unwrap();
    // Deterministic fault injection on the EXACT ACK update (task_uuid set).
    c.journal_conn()
        .execute_batch(
            "CREATE TRIGGER fail_ack BEFORE UPDATE OF task_uuid ON children \
             WHEN NEW.delivery_state='acked' \
             BEGIN SELECT RAISE(ABORT, 'ack failure'); END;",
        )
        .unwrap();
    let wid = c.create(&spec()).unwrap();
    let p = SelectiveProvider::ok(counts());
    assert!(c.run(&wid, &p).is_err()); // recoverable error; worker task remains
    drop(c);

    let c2 = Coordinator::open(&root).unwrap();
    c2.journal_conn()
        .execute_batch("DROP TRIGGER fail_ack")
        .unwrap();
    let snap = c2.run(&wid, &p).unwrap();
    assert_eq!(snap["status"], "completed");
    for prof in ["alpha", "beta"] {
        let s = ProfileStore::open_profile(&root, prof).unwrap();
        let tasks = s.tasks().unwrap();
        assert_eq!(tasks.len(), 1, "exactly one task per worker");
        assert_eq!(tasks[0].status, "completed");
        assert_eq!(s.outbox().unwrap().len(), 1); // never duplicated
    }
}

#[test]
fn interrupted_parent_recovers_uncertain_without_rerun() {
    let (_td, root) = setup();
    let (au, bu, _s) = mk_profiles(&root);
    let c = Coordinator::open(&root).unwrap();
    let wid = c.create(&spec()).unwrap();
    let p = SelectiveProvider::ok(counts());
    c.run(&wid, &p).unwrap(); // both completed

    // Simulate a crash mid-flight for beta: its task back to running, outbox
    // row gone, journal child result and parent aggregate rolled back.
    {
        let b = ProfileStore::open_profile(&root, "beta").unwrap();
        let task = b
            .tasks()
            .unwrap()
            .into_iter()
            .find(|t| t.message_id.starts_with('{'))
            .unwrap();
        b.conn
            .execute(
                "UPDATE tasks SET status='running', output=NULL WHERE id=?1",
                params![task.id],
            )
            .unwrap();
        b.conn
            .execute("DELETE FROM outbox WHERE task_id=?1", params![task.id])
            .unwrap();
    }
    c.journal_conn()
        .execute(
            "UPDATE children SET worker_status=NULL, artifact=NULL WHERE worker_profile='beta'",
            [],
        )
        .unwrap();
    c.journal_conn()
        .execute("UPDATE parents SET status='running', aggregate=NULL", [])
        .unwrap();
    drop(c);

    let c2 = Coordinator::open(&root).unwrap();
    let cnt = counts();
    let p2 = SelectiveProvider::ok(cnt.clone());
    let snap = c2.run(&wid, &p2).unwrap();
    assert_eq!(snap["status"], "uncertain");
    // Uncertain worker never invoked; completed worker not re-invoked.
    assert_eq!(cnt.lock().unwrap().get(&bu), None);
    assert_eq!(cnt.lock().unwrap().get(&au), None);
    let kids = snap["children"].as_array().unwrap();
    let alpha = kids
        .iter()
        .find(|k| k["worker_profile"] == "alpha")
        .unwrap();
    let beta = kids.iter().find(|k| k["worker_profile"] == "beta").unwrap();
    assert_eq!(alpha["worker_status"], "completed");
    assert!(!alpha["artifact"].is_null()); // first artifact kept
    assert_eq!(beta["worker_status"], "uncertain");
}

#[test]
fn selective_provider_failure_keeps_partial_artifact() {
    let (_td, root) = setup();
    let (_au, bu, _s) = mk_profiles(&root);
    let c = Coordinator::open(&root).unwrap();
    let wid = c.create(&spec()).unwrap();
    let cnt = counts();
    let p = SelectiveProvider {
        fail: HashSet::from([bu.clone()]),
        counts: cnt.clone(),
    };
    let snap = c.run(&wid, &p).unwrap();
    assert_eq!(snap["status"], "failed");
    let kids = snap["children"].as_array().unwrap();
    let alpha = kids
        .iter()
        .find(|k| k["worker_profile"] == "alpha")
        .unwrap();
    let beta = kids.iter().find(|k| k["worker_profile"] == "beta").unwrap();
    assert_eq!(alpha["worker_status"], "completed");
    assert!(!alpha["artifact"].is_null()); // partial artifact retained
    assert_eq!(beta["worker_status"], "failed");

    // Repeated run: terminal failed is never retried; nothing re-invoked.
    let before = cnt.lock().unwrap().clone();
    let snap2 = c.run(&wid, &p).unwrap();
    assert_eq!(snap2["status"], "failed");
    assert_eq!(*cnt.lock().unwrap(), before);
    let cnt2 = counts();
    let p2 = SelectiveProvider::ok(cnt2.clone());
    c.run(&wid, &p2).unwrap();
    assert_eq!(cnt2.lock().unwrap().get(&bu), None);
}

#[test]
fn cancel_before_dispatch_and_busy_reconcile() {
    let (_td, root) = setup();
    mk_profiles(&root);
    // a) Cancel before any dispatch: no worker work is created.
    let c = Coordinator::open(&root).unwrap();
    let w1 = c.create(&spec()).unwrap();
    let snap = c.cancel(&w1).unwrap();
    assert_eq!(snap["status"], "cancelled");
    let p = SelectiveProvider::ok(counts());
    let snap = c.run(&w1, &p).unwrap();
    assert_eq!(snap["status"], "cancelled");
    for k in snap["children"].as_array().unwrap() {
        assert_eq!(k["worker_status"], "cancelled");
        assert!(k["task_uuid"].is_null());
    }
    for prof in ["alpha", "beta"] {
        assert!(ProfileStore::open_profile(&root, prof)
            .unwrap()
            .tasks()
            .unwrap()
            .is_empty());
    }

    // b) Busy worker: beta locked during run -> explicit pending, alpha
    // proceeds; cancel leaves parent cancelled; later run reconciles without
    // creating beta work and never touches unrelated tasks.
    let w2 = c
        .create(&ParentSpec {
            request_id: "req-2".into(),
            ..spec()
        })
        .unwrap();
    let _held = ProfileStore::open_profile(&root, "beta").unwrap();
    let snap = c.run(&w2, &p).unwrap();
    let kids = snap["children"].as_array().unwrap();
    let alpha = kids
        .iter()
        .find(|k| k["worker_profile"] == "alpha")
        .unwrap();
    let beta = kids.iter().find(|k| k["worker_profile"] == "beta").unwrap();
    assert_eq!(alpha["worker_status"], "completed");
    assert!(beta["worker_status"].is_null());
    assert!(!beta["last_error"].is_null());
    let snap = c.cancel(&w2).unwrap();
    assert_eq!(snap["status"], "cancelled");
    drop(_held);
    let snap = c.run(&w2, &p).unwrap();
    assert_eq!(snap["status"], "cancelled");
    let beta = snap["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["worker_profile"] == "beta")
        .unwrap()
        .clone();
    assert_eq!(beta["worker_status"], "cancelled");
    assert!(beta["task_uuid"].is_null());
    assert!(ProfileStore::open_profile(&root, "beta")
        .unwrap()
        .tasks()
        .unwrap()
        .is_empty());
}

#[test]
fn snapshot_is_readonly_and_works_under_writer_lock() {
    let (_td, root) = setup();
    mk_profiles(&root);
    // No journal yet: snapshot errors and creates nothing.
    assert!(collaboration::snapshot(&root, "nope").is_err());
    assert!(!root.join("ghosts").exists());

    let c = Coordinator::open(&root).unwrap();
    let wid = c.create(&spec()).unwrap();
    let p = SelectiveProvider::ok(counts());
    c.run(&wid, &p).unwrap();
    drop(c);

    // Hold the writer lock: read-only snapshot still works and alters nothing.
    let _writer = Coordinator::open(&root).unwrap();
    let snap = collaboration::snapshot(&root, &wid).unwrap();
    assert_eq!(snap["status"], "completed");
    assert!(collaboration::snapshot(&root, "missing").is_err());
    drop(_writer);
    let snap2 = collaboration::snapshot(&root, &wid).unwrap();
    assert_eq!(snap, snap2);
}

fn cli(_root: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_ghost"))
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "args {:?}: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn cli_durable_vertical_path() {
    let (_td, root) = setup();
    let (_td2, scratch_owner) = setup();
    let _ = scratch_owner; // only unique tempdirs used; no fixed /tmp paths
    let root_s = root.to_str().unwrap();
    cli(
        &root,
        &[
            "--root",
            root_s,
            "profile",
            "create",
            "alpha",
            "--persona",
            "research persona",
        ],
    );
    cli(
        &root,
        &[
            "--root",
            root_s,
            "profile",
            "create",
            "beta",
            "--persona",
            "review persona",
        ],
    );
    let sub = cli(
        &root,
        &[
            "--root",
            root_s,
            "ghosts",
            "submit",
            "--request-id",
            "cli-1",
            "--owner",
            "alpha",
            "--title",
            "durable objective",
            "--worker",
            "alpha:research",
            "--worker",
            "beta:review",
        ],
    );
    let v: serde_json::Value = serde_json::from_str(&sub).unwrap();
    let wid = v["workflow"].as_str().unwrap().to_string();

    let run1 = cli(&root, &["--root", root_s, "ghosts", "run", &wid]);
    let r1: serde_json::Value = serde_json::from_str(&run1).unwrap();
    assert_eq!(r1["status"], "completed");
    assert_eq!(r1["aggregate"]["results"].as_array().unwrap().len(), 2);

    // Fresh process reads real durable results.
    let st = cli(&root, &["--root", root_s, "ghosts", "status", &wid]);
    let s: serde_json::Value = serde_json::from_str(&st).unwrap();
    assert_eq!(s["status"], "completed");
    let roles: Vec<&str> = s["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, vec!["research", "review"]);

    // Subsequent run in another fresh process is idempotent.
    let run2 = cli(&root, &["--root", root_s, "ghosts", "run", &wid]);
    let r2: serde_json::Value = serde_json::from_str(&run2).unwrap();
    assert_eq!(r2["status"], "completed");
    assert_eq!(r2["children"], r1["children"]);
    let lst = cli(&root, &["--root", root_s, "ghosts", "list"]);
    assert!(lst.contains(&wid));
}

// ---- regressions: fail-closed prevalidation, identity drift, pointer fraud,
// receipt enforcement, lost-ACK cancellation, provenance, read-only listing ----

#[test]
fn corrupt_second_envelope_means_zero_dispatch() {
    let (_td, root) = setup();
    mk_profiles(&root);
    let c = Coordinator::open(&root).unwrap();
    let cnt = counts();
    let p = SelectiveProvider::ok(cnt.clone());
    type EnvelopeMutation = Box<dyn FnOnce(&mut serde_json::Value)>;
    let variants: Vec<(&str, EnvelopeMutation)> = vec![
        ("version", Box::new(|v| v["version"] = 2u32.into())),
        (
            "sender",
            Box::new(|v| v["sender_uuid"] = "spoof-sender".into()),
        ),
        (
            "recipient",
            Box::new(|v| v["recipient_uuid"] = "spoof-recipient".into()),
        ),
        (
            "lineage",
            Box::new(|v| {
                v["workflow_id"] = "other-workflow".into();
                v["root_task_id"] = "other-workflow".into();
            }),
        ),
        (
            "prompt",
            Box::new(|v| v["task_prompt"] = "tampered prompt".into()),
        ),
        (
            "ceiling",
            Box::new(|v| {
                v["capability_ceiling"] = serde_json::json!(["text", "shell"]);
            }),
        ),
    ];
    for (i, (name, f)) in variants.into_iter().enumerate() {
        let mut s = spec();
        s.request_id = format!("req-c{}", i);
        let wid = c.create(&s).unwrap();
        corrupt_envelope(&c, &wid, 1, f);
        assert!(
            c.run(&wid, &p).is_err(),
            "variant '{}' must fail closed",
            name
        );
    }
    // Zero provider calls and zero worker tasks: nothing was dispatched at all.
    assert_eq!(total_calls(&cnt), 0);
    for prof in ["alpha", "beta"] {
        assert!(ProfileStore::open_profile(&root, prof)
            .unwrap()
            .tasks()
            .unwrap()
            .is_empty());
    }
}

#[test]
fn profile_identity_drift_or_recreate_fails_closed() {
    // Worker identity drift (profile recreated under the same name).
    {
        let (_td, root) = setup();
        mk_profiles(&root);
        let c = Coordinator::open(&root).unwrap();
        let wid = c.create(&spec()).unwrap();
        std::fs::remove_dir_all(root.join("profiles").join("beta")).unwrap();
        ProfileStore::create_profile(&root, "beta", "impostor persona").unwrap();
        let cnt = counts();
        let p = SelectiveProvider::ok(cnt.clone());
        assert!(c.run(&wid, &p).is_err());
        assert_eq!(total_calls(&cnt), 0);
    }
    // Owner identity drift.
    {
        let (_td, root) = setup();
        mk_profiles(&root);
        let c = Coordinator::open(&root).unwrap();
        let wid = c.create(&spec()).unwrap();
        std::fs::remove_dir_all(root.join("profiles").join("alpha")).unwrap();
        ProfileStore::create_profile(&root, "alpha", "impostor owner").unwrap();
        let cnt = counts();
        let p = SelectiveProvider::ok(cnt.clone());
        assert!(c.run(&wid, &p).is_err());
        assert_eq!(total_calls(&cnt), 0);
        // Replay under the new owner identity is refused too.
        assert!(c.create(&spec()).is_err());
    }
}

#[test]
fn spoofed_existing_inbox_payload_rejected_untouched() {
    // Envelope/identity prevalidation is a batch barrier. Receiver inbox
    // payload validation is per worker; an earlier valid sibling may finish.
    // Verify both orders and every actual effect, rather than assuming a
    // cross-profile execution transaction.
    for forged_seq in [0usize, 1] {
        let (_td, root) = setup();
        let (au, bu, scratch) = mk_profiles(&root);
        let (forged_profile, forged_uuid) = if forged_seq == 0 {
            ("alpha", &au)
        } else {
            ("beta", &bu)
        };
        let c = Coordinator::open(&root).unwrap();
        let wid = c.create(&spec()).unwrap();
        let key = collaboration::snapshot(&root, &wid).unwrap()["children"][forged_seq]
            ["message_key"]
            .as_str()
            .unwrap()
            .to_string();
        let target = scratch.join("spoof.txt");
        let forged_task_uuid;
        {
            let worker = ProfileStore::open_profile(&root, forged_profile).unwrap();
            if forged_profile == "beta" {
                worker.allow(&scratch, "write").unwrap();
            }
            // Both variants have a real fixture write grant: rejection must
            // come from payload validation, never from a missing grant.
            assert_eq!(worker.grants().unwrap().len(), 1);
            let sess = worker.create_session().unwrap();
            let (task, _) = worker
                .submit(
                    &sess.uuid,
                    &key,
                    "forged prompt",
                    None,
                    Some(target.to_string_lossy().as_ref()),
                    Some("pwn"),
                )
                .unwrap();
            forged_task_uuid = task.uuid;
        }
        let cnt = counts();
        let p = SelectiveProvider::ok(cnt.clone());
        let error = c.run(&wid, &p).unwrap_err();
        assert!(error.to_string().contains("payload"));
        assert_eq!(cnt.lock().unwrap().get(forged_uuid), None);
        assert_eq!(cnt.lock().unwrap().get(&bu), None);
        assert_eq!(
            cnt.lock().unwrap().get(&au).copied(),
            if forged_seq == 1 { Some(1) } else { None }
        );
        let failed = collaboration::snapshot(&root, &wid).unwrap();
        assert_eq!(failed["status"], "failed");
        assert!(failed["aggregate"].is_null());
        assert_eq!(failed["children"][forged_seq]["delivery_state"], "rejected");
        assert!(!failed["children"][forged_seq]["last_error"].is_null());
        assert!(failed["children"][forged_seq]["task_uuid"].is_null());
        assert!(failed["children"][forged_seq]["artifact"].is_null());
        let retained_artifact = failed["children"][0]["artifact"].clone();
        if forged_seq == 1 {
            assert_eq!(failed["children"][0]["worker_status"], "completed");
            assert_eq!(retained_artifact["profile_uuid"], au);
            assert_eq!(
                retained_artifact["sha256"],
                protocol::sha256_hex(retained_artifact["content"].as_str().unwrap())
            );
        } else {
            assert!(failed["children"][1]["task_uuid"].is_null());
        }
        // The public CLI snapshot works under the coordinator writer lock.
        let public: serde_json::Value = serde_json::from_str(&cli(
            &root,
            &["--root", root.to_str().unwrap(), "ghosts", "status", &wid],
        ))
        .unwrap();
        assert_eq!(public, failed);
        {
            let worker = ProfileStore::open_profile(&root, forged_profile).unwrap();
            let task = worker.task_by_message(&key).unwrap().unwrap();
            assert_eq!(task.uuid, forged_task_uuid);
            assert_eq!(task.status, "queued");
            assert_eq!(worker.tasks().unwrap().len(), 1);
            assert!(worker.outbox().unwrap().is_empty());
            let effects: i64 = worker
                .conn
                .query_row("SELECT COUNT(*) FROM effects", [], |r| r.get(0))
                .unwrap();
            assert_eq!(effects, 0);
            assert_eq!(worker.grants().unwrap().len(), 1);
        } // Release the fixture writer before restart/cancel/reopen.
        assert!(!target.exists());
        let before = cnt.lock().unwrap().clone();
        drop(c);
        let restarted = Coordinator::open(&root).unwrap();
        let replay = restarted.run(&wid, &p).unwrap();
        assert_eq!(replay["status"], "failed");
        assert_eq!(replay["children"][0]["artifact"], retained_artifact);
        assert_eq!(*cnt.lock().unwrap(), before);
        let cancelled = restarted.cancel(&wid).unwrap();
        assert_eq!(cancelled["status"], "cancelled");
        assert_eq!(cancelled["children"][0]["artifact"], retained_artifact);
        assert_eq!(restarted.run(&wid, &p).unwrap()["status"], "cancelled");
        assert_eq!(*cnt.lock().unwrap(), before);
        {
            let worker = ProfileStore::open_profile(&root, forged_profile).unwrap();
            let task = worker.task_by_message(&key).unwrap().unwrap();
            assert_eq!(task.uuid, forged_task_uuid);
            assert_eq!(task.status, "queued");
            assert!(worker.outbox().unwrap().is_empty());
            assert_eq!(worker.grants().unwrap().len(), 1);
        }
        assert!(!target.exists());
    }
}

#[test]
fn acked_unrelated_write_task_pointer_rejected_run_and_cancel() {
    let (_td, root) = setup();
    let (_au, _bu, scratch) = mk_profiles(&root);
    let (t_uuid, t_session) = {
        let a = ProfileStore::open_profile(&root, "alpha").unwrap();
        let sess = a.create_session().unwrap();
        let target = scratch.join("pointer.txt");
        let (t, _) = a
            .submit(
                &sess.uuid,
                "unrelated-1",
                "write something",
                None,
                Some(target.to_string_lossy().as_ref()),
                Some("payload"),
            )
            .unwrap();
        (t.uuid, t.session_id)
    };
    let c = Coordinator::open(&root).unwrap();
    let wid = c.create(&spec()).unwrap();
    c.journal_conn()
        .execute(
            "UPDATE children SET delivery_state='acked', task_uuid=?1, session_uuid=?2 \
             WHERE parent_id=(SELECT id FROM parents WHERE uuid=?3) AND seq=0",
            params![t_uuid, t_session, wid],
        )
        .unwrap();
    let cnt = counts();
    let p = SelectiveProvider::ok(cnt.clone());
    assert!(c.run(&wid, &p).is_err());
    assert_eq!(total_calls(&cnt), 0);
    let snap = c.cancel(&wid).unwrap();
    let alpha = snap["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["worker_profile"] == "alpha")
        .unwrap();
    assert!(!alpha["last_error"].is_null());
    let a = ProfileStore::open_profile(&root, "alpha").unwrap();
    let t = a.task("unrelated-1").unwrap().unwrap();
    assert_eq!(t.status, "queued"); // never cancelled via the corrupt pointer
    assert!(!scratch.join("pointer.txt").exists()); // never executed
    assert_eq!(a.tasks().unwrap().len(), 1); // no delegated task was created
}

#[test]
fn missing_or_mismatched_receipt_blocks_root_completion() {
    let (_td, root) = setup();
    mk_profiles(&root);
    let c = Coordinator::open(&root).unwrap();
    let wid = c.create(&spec()).unwrap();
    let p = SelectiveProvider::ok(counts());
    c.run(&wid, &p).unwrap();

    // a) Receipt missing entirely: rerun must fail closed, no completion.
    {
        let b = ProfileStore::open_profile(&root, "beta").unwrap();
        let task = b
            .tasks()
            .unwrap()
            .into_iter()
            .find(|t| t.message_id.starts_with('{'))
            .unwrap();
        b.conn
            .execute("DELETE FROM outbox WHERE task_id=?1", params![task.id])
            .unwrap();
    }
    reset_beta_child_and_parent(&c);
    let cnt = counts();
    let p2 = SelectiveProvider::ok(cnt.clone());
    assert!(c.run(&wid, &p2).is_err());
    assert_eq!(total_calls(&cnt), 0);
    let snap = collaboration::snapshot(&root, &wid).unwrap();
    assert_ne!(snap["status"], "completed");
    let beta = snap["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["worker_profile"] == "beta")
        .unwrap();
    assert!(beta["artifact"].is_null()); // no artifact without a receipt

    // b) Receipt present but mismatched (wrong profile uuid): same outcome.
    {
        let b = ProfileStore::open_profile(&root, "beta").unwrap();
        let task = b
            .tasks()
            .unwrap()
            .into_iter()
            .find(|t| t.message_id.starts_with('{'))
            .unwrap();
        b.conn
            .execute(
                "INSERT INTO outbox(task_id, task_uuid, message_id, session_id, profile_uuid, content, status, created_at) \
                 VALUES(?1,?2,?3,?4,'spoof-uuid',?5,'completed','0')",
                params![task.id, task.uuid, task.message_id, task.session_id, task.output],
            )
            .unwrap();
    }
    reset_beta_child_and_parent(&c);
    assert!(c.run(&wid, &p2).is_err());
    let snap = collaboration::snapshot(&root, &wid).unwrap();
    assert_ne!(snap["status"], "completed");
    assert!(snap["aggregate"].is_null());
}

#[test]
fn lost_ack_then_cancel_cancels_persisted_receiver_task_no_calls() {
    let (_td, root) = setup();
    mk_profiles(&root);
    let c = Coordinator::open(&root).unwrap();
    c.journal_conn()
        .execute_batch(
            "CREATE TRIGGER fail_ack BEFORE UPDATE OF task_uuid ON children \
             WHEN NEW.delivery_state='acked' \
             BEGIN SELECT RAISE(ABORT, 'ack failure'); END;",
        )
        .unwrap();
    let wid = c.create(&spec()).unwrap();
    let cnt = counts();
    let p = SelectiveProvider::ok(cnt.clone());
    assert!(c.run(&wid, &p).is_err()); // worker tasks persisted, ACK lost
    assert_eq!(total_calls(&cnt), 0);
    drop(c);

    // Remove the fault, then cancel: the durable tasks are adopted via the
    // immutable namespaced key, ACKed, and cancelled exactly.
    let c2 = Coordinator::open(&root).unwrap();
    c2.journal_conn()
        .execute_batch("DROP TRIGGER fail_ack")
        .unwrap();
    drop(c2);
    let c3 = Coordinator::open(&root).unwrap();
    let snap = c3.cancel(&wid).unwrap();
    assert_eq!(snap["status"], "cancelled");
    let kids = snap["children"].as_array().unwrap();
    let alpha = kids
        .iter()
        .find(|k| k["worker_profile"] == "alpha")
        .unwrap();
    let beta = kids.iter().find(|k| k["worker_profile"] == "beta").unwrap();
    assert_eq!(alpha["worker_status"], "cancelled");
    assert_eq!(alpha["cancel_state"], "reconciled");
    assert!(!alpha["task_uuid"].is_null());
    assert_eq!(beta["worker_status"], "cancelled");
    assert_eq!(beta["cancel_state"], "cancelled");
    assert!(beta["task_uuid"].is_null());
    {
        let a = ProfileStore::open_profile(&root, "alpha").unwrap();
        let tasks = a.tasks().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, "cancelled");
        assert_eq!(a.outbox().unwrap().len(), 1);
        assert_eq!(a.outbox().unwrap()[0].status, "cancelled");
    }
    {
        let b = ProfileStore::open_profile(&root, "beta").unwrap();
        assert_eq!(b.tasks().unwrap().len(), 0);
        assert_eq!(b.outbox().unwrap().len(), 0);
    }
    // Zero provider invocations across the whole scenario.
    assert_eq!(total_calls(&cnt), 0);
}

#[test]
fn busy_acked_queued_child_pending_cancel_reconciles_without_calls() {
    let (_td, root) = setup();
    mk_profiles(&root);
    let c = Coordinator::open(&root).unwrap();
    // Fault injection: beta's attempt persist aborts AFTER its ACK, leaving an
    // acked child whose durable worker task is still queued.
    c.journal_conn()
        .execute_batch(
            "CREATE TRIGGER fail_beta_attempt BEFORE UPDATE OF attempt_id ON children \
             WHEN NEW.worker_profile='beta' \
             BEGIN SELECT RAISE(ABORT, 'attempt failure'); END;",
        )
        .unwrap();
    let wid = c.create(&spec()).unwrap();
    let cnt = counts();
    let p = SelectiveProvider::ok(cnt.clone());
    assert!(c.run(&wid, &p).is_err());
    assert_eq!(total_calls(&cnt), 1); // alpha executed, beta never
    drop(c);

    let mid = collaboration::snapshot(&root, &wid).unwrap();
    let alpha = mid["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["worker_profile"] == "alpha")
        .unwrap()
        .clone();
    let beta = mid["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["worker_profile"] == "beta")
        .unwrap()
        .clone();
    assert_eq!(alpha["worker_status"], "completed");
    assert_eq!(beta["delivery_state"], "acked");
    assert!(!beta["task_uuid"].is_null());
    assert!(beta["worker_status"].is_null());

    let c2 = Coordinator::open(&root).unwrap();
    c2.journal_conn()
        .execute_batch("DROP TRIGGER fail_beta_attempt")
        .unwrap();
    drop(c2);

    // Busy beta store during cancellation -> pending_cancel, parent cancelled.
    let _held = ProfileStore::open_profile(&root, "beta").unwrap();
    let c3 = Coordinator::open(&root).unwrap();
    let snap = c3.cancel(&wid).unwrap();
    assert_eq!(snap["status"], "cancelled");
    let beta = snap["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["worker_profile"] == "beta")
        .unwrap()
        .clone();
    assert_eq!(beta["cancel_state"], "pending_cancel");
    drop(_held);
    drop(c3);

    // Later cancelled run reconciles the real acked queued child with zero
    // provider calls: the task is cancelled, never executed.
    let c4 = Coordinator::open(&root).unwrap();
    let cnt2 = counts();
    let p2 = SelectiveProvider::ok(cnt2.clone());
    let snap = c4.run(&wid, &p2).unwrap();
    assert_eq!(snap["status"], "cancelled");
    let beta = snap["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["worker_profile"] == "beta")
        .unwrap()
        .clone();
    assert_eq!(beta["cancel_state"], "reconciled");
    assert_eq!(beta["worker_status"], "cancelled");
    assert_eq!(total_calls(&cnt2), 0);
    let b = ProfileStore::open_profile(&root, "beta").unwrap();
    assert_eq!(b.tasks().unwrap()[0].status, "cancelled");
    let a = ProfileStore::open_profile(&root, "alpha").unwrap();
    assert_eq!(a.tasks().unwrap()[0].status, "completed");
}

#[test]
fn provenance_records_persisted_attempt_and_process_ids() {
    let (_td, root) = setup();
    mk_profiles(&root);
    let c = Coordinator::open(&root).unwrap();
    let wid = c.create(&spec()).unwrap();
    let p = SelectiveProvider::ok(counts());
    let snap = c.run(&wid, &p).unwrap();
    for k in snap["children"].as_array().unwrap() {
        let prov = k["artifact"]["provenance"].as_str().unwrap();
        assert!(prov.contains(&format!("attempt_id={}", k["attempt_id"].as_str().unwrap())));
        assert!(prov.contains(&format!(
            "process_instance_id={}",
            k["process_instance_id"].as_str().unwrap()
        )));
        assert!(prov.contains(&format!(
            "worker_profile={}",
            k["worker_profile"].as_str().unwrap()
        )));
        assert!(prov.contains(&format!("session={}", k["session_uuid"].as_str().unwrap())));
        assert!(prov.contains("message_key="));
    }
}

#[test]
fn public_list_is_readonly_under_writer_lock_and_rejects_symlink_journal() {
    let (_td, root) = setup();
    mk_profiles(&root);
    // No journal: list errors and creates nothing.
    assert!(collaboration::list(&root).is_err());
    assert!(!root.join("ghosts").exists());

    let c = Coordinator::open(&root).unwrap();
    let wid = c.create(&spec()).unwrap();
    let p = SelectiveProvider::ok(counts());
    c.run(&wid, &p).unwrap();
    drop(c);

    // Works while a writer holds the coordinator lock; nothing is created.
    let _writer = Coordinator::open(&root).unwrap();
    let l = collaboration::list(&root).unwrap();
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["workflow"], wid.as_str());
    assert_eq!(l[0]["status"], "completed");
    assert!(collaboration::snapshot(&root, &wid).is_ok());
    drop(_writer);

    // A symlinked journal path is rejected by the read-only APIs and by open.
    let (td2, root2) = setup();
    mk_profiles(&root2);
    {
        let c2 = Coordinator::open(&root2).unwrap();
        let w2 = c2.create(&spec()).unwrap();
        let p2 = SelectiveProvider::ok(counts());
        c2.run(&w2, &p2).unwrap();
    }
    let (td3, root3) = setup();
    std::fs::create_dir_all(root3.join("ghosts")).unwrap();
    std::os::unix::fs::symlink(
        root2.join("ghosts").join("manager.db"),
        root3.join("ghosts").join("manager.db"),
    )
    .unwrap();
    assert!(collaboration::list(&root3).is_err());
    assert!(collaboration::snapshot(&root3, "any").is_err());
    assert!(Coordinator::open(&root3).is_err());
    drop(td2);
    drop(td3);
}
