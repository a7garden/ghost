use ghost::judge::{JudgeInput, LocalJudge, MockJudge};
use ghost::provider::{MockProvider, Provider, ProviderRequest};
use ghost::run_cycle;
use ghost::store::ProfileStore;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::thread;

fn root_in(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join("g")
}

fn setup(dir: &tempfile::TempDir, name: &str) -> ProfileStore {
    ProfileStore::create_profile(&root_in(dir), name, "a careful ghost").unwrap()
}

#[test]
fn identities_independent_and_persistent() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    let (u1, u2) = {
        let a = ProfileStore::create_profile(&root, "alpha", "alpha persona").unwrap();
        let b = ProfileStore::create_profile(&root, "beta", "beta persona").unwrap();
        (a.uuid.clone(), b.uuid.clone())
    };
    let a = ProfileStore::open_profile(&root, "alpha").unwrap();
    let b = ProfileStore::open_profile(&root, "beta").unwrap();
    assert_eq!(a.uuid, u1);
    assert_eq!(b.uuid, u2);
    assert_ne!(a.uuid, b.uuid);
    assert_eq!(a.persona, "alpha persona"); // persona persists immutable across reopen
    assert_ne!(a.persona, b.persona);
    // a cannot see b's inbox
    let s = a.create_session().unwrap();
    a.submit(&s.uuid, "m1", "hi", None, None, None).unwrap();
    assert!(b.task("m1").unwrap().is_none());
}

#[test]
fn session_and_task_persistence_with_duplicate_semantics() {
    let dir = tempfile::tempdir().unwrap();
    let store = setup(&dir, "p");
    let session = store.create_session().unwrap();
    let (t1, created) = store
        .submit(&session.uuid, "msg-1", "question", None, None, None)
        .unwrap();
    assert!(created);
    drop(store);
    let store = ProfileStore::open_profile(&root_in(&dir), "p").unwrap();
    let session2 = store.session(&session.uuid).unwrap().unwrap();
    assert_eq!(session2.id, session.id);
    let (t2, created) = store
        .submit(&session.uuid, "msg-1", "question", None, None, None)
        .unwrap();
    assert!(!created); // identical duplicate returns the same task
    assert_eq!(t1.uuid, t2.uuid);
    let e = store
        .submit(&session.uuid, "msg-1", "different prompt", None, None, None)
        .unwrap_err();
    assert!(e.to_string().contains("mismatched duplicate"));
    let e = store
        .submit(
            &store.create_session().unwrap().uuid,
            "msg-1",
            "question",
            None,
            None,
            None,
        )
        .unwrap_err();
    assert!(e.to_string().contains("mismatched duplicate"));
}

#[test]
fn concurrent_threads_distinct_correlation() {
    let dir = tempfile::tempdir().unwrap();
    let root = Arc::new(root_in(&dir));
    let mut handles = vec![];
    for i in 0..4 {
        let root = root.clone();
        handles.push(thread::spawn(move || {
            let s = ProfileStore::create_profile(&root, &format!("g{}", i), "p").unwrap();
            let sess = s.create_session().unwrap();
            let mid = format!("m-{}", i);
            let prompt = format!("question {}", i);
            s.submit(&sess.uuid, &mid, &prompt, None, None, None)
                .unwrap();
            run_cycle(&s, &MockProvider).unwrap();
            let ob = s.outbox().unwrap();
            assert_eq!(ob.len(), 1);
            (mid, prompt, sess.uuid, ob[0].clone())
        }));
    }
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    for (i, r) in results.iter().enumerate() {
        assert_eq!(r.0, format!("m-{}", i));
        assert!(r.3.content.as_deref().unwrap().contains(&r.1));
        assert_eq!(r.3.session_id, r.2);
        assert!(r.3.content.as_deref().unwrap().contains(&r.3.message_id));
    }
    // distinct messages never cross-correlate
    for a in &results {
        for b in &results {
            if a.3.message_id != b.3.message_id {
                assert_ne!(a.3.task_uuid, b.3.task_uuid);
                assert_ne!(a.3.profile_uuid, b.3.profile_uuid);
            }
        }
    }
}

#[test]
fn writer_contention_then_reacquisition() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    ProfileStore::create_profile(&root, "p", "").unwrap();
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(root.join("profiles/p.lock"))
        .unwrap();
    use fs2::FileExt;
    lock.try_lock_exclusive().unwrap();
    let err = ProfileStore::open_profile(&root, "p")
        .err()
        .expect("open must fail while another writer holds the lock");
    assert!(err.to_string().contains("locked"));
    drop(lock); // guard released on drop
    ProfileStore::open_profile(&root, "p").unwrap();
}

#[test]
fn default_deny_and_policy_lifecycle() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    let store = ProfileStore::create_profile(&root, "p", "").unwrap();
    let work = dir.path().join("work");
    fs::create_dir(&work).unwrap();
    let target = work.join("out.txt");
    let sess = store.create_session().unwrap();
    store
        .submit(
            &sess.uuid,
            "m1",
            "write it",
            None,
            Some(target.to_str().unwrap()),
            Some("hello"),
        )
        .unwrap();
    let s = run_cycle(&store, &MockProvider).unwrap();
    assert_eq!(s.denied, 1);
    assert!(!target.exists());

    let g = store.allow(&work, "write").unwrap();
    let (t, _) = store
        .submit(
            &sess.uuid,
            "m2",
            "write it",
            None,
            Some(target.to_str().unwrap()),
            Some("hello"),
        )
        .unwrap();
    let s = run_cycle(&store, &MockProvider).unwrap();
    assert_eq!(s.completed, 1);
    assert_eq!(fs::read_to_string(&target).unwrap(), "hello");

    // grant persisted across reopen; revoke cancels eligibility
    drop(store);
    let store = ProfileStore::open_profile(&root, "p").unwrap();
    let target2 = work.join("out2.txt");
    store
        .submit(
            &sess.uuid,
            "m3",
            "write again",
            None,
            Some(target2.to_str().unwrap()),
            Some("x"),
        )
        .unwrap();
    store.revoke(g.id).unwrap();
    let s = run_cycle(&store, &MockProvider).unwrap();
    assert_eq!(s.denied, 1);
    assert!(!target2.exists());
    assert_eq!(store.task("m2").unwrap().unwrap().uuid, t.uuid);
}

#[test]
fn symlink_traversal_sibling_and_overwrite_denied() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    let store = ProfileStore::create_profile(&root, "p", "").unwrap();
    let allowed = dir.path().join("allowed");
    let outside = dir.path().join("outside");
    fs::create_dir(&allowed).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "s").unwrap();
    // symlink inside allowed dir pointing outside
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, allowed.join("link")).unwrap();
    store.allow(&allowed, "read").unwrap();
    store.allow(&allowed, "write").unwrap();
    let sess = store.create_session().unwrap();

    #[cfg(unix)]
    {
        store
            .submit(
                &sess.uuid,
                "sl",
                "read",
                Some(allowed.join("link/secret.txt").to_str().unwrap()),
                None,
                None,
            )
            .unwrap();
    }
    // sibling escape via ..
    store
        .submit(
            &sess.uuid,
            "sib",
            "read",
            Some(allowed.join("../outside/secret.txt").to_str().unwrap()),
            None,
            None,
        )
        .unwrap();
    // overwrite refusal: pre-existing file (fixture write)
    let existing = allowed.join("exists.txt");
    fs::write(&existing, "keep").unwrap();
    store
        .submit(
            &sess.uuid,
            "ow",
            "write",
            None,
            Some(existing.to_str().unwrap()),
            Some("new"),
        )
        .unwrap();
    let s = run_cycle(&store, &MockProvider).unwrap();
    assert_eq!(s.denied, 3);
    assert_eq!(fs::read_to_string(&existing).unwrap(), "keep");
}

#[test]
fn allowed_read_write_and_double_run_no_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    let store = ProfileStore::create_profile(&root, "p", "persona x").unwrap();
    let work = dir.path().join("work");
    fs::create_dir(&work).unwrap();
    fs::write(work.join("in.txt"), "payload").unwrap();
    store.allow(&work, "read").unwrap();
    let grant = store.allow(&work, "write").unwrap();
    let sess = store.create_session().unwrap();
    store
        .submit(
            &sess.uuid,
            "r1",
            "read this",
            Some(work.join("in.txt").to_str().unwrap()),
            None,
            None,
        )
        .unwrap();
    let out = work.join("out.txt");
    store
        .submit(
            &sess.uuid,
            "w1",
            "write this",
            None,
            Some(out.to_str().unwrap()),
            Some("written"),
        )
        .unwrap();
    let s1 = run_cycle(&store, &MockProvider).unwrap();
    assert_eq!(s1.completed, 2);
    assert_eq!(fs::read_to_string(&out).unwrap(), "written");
    // second run: nothing queued, no duplicate write or outbox rows
    let s2 = run_cycle(&store, &MockProvider).unwrap();
    assert_eq!(s2.completed + s2.denied + s2.failed + s2.uncertain, 0);
    let ob = store.outbox().unwrap();
    assert_eq!(ob.len(), 2);
    let n: i64 = store
        .conn
        .query_row("SELECT COUNT(*) FROM effects", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 2);
    let read_task = store.task("r1").unwrap().unwrap();
    assert!(read_task.output.as_deref().unwrap().contains("payload"));
    // persona influences provider context
    assert!(read_task.output.as_deref().unwrap().contains("persona x"));
    // duplicate submit of completed message: same task, no repeat
    let (dup, created) = store
        .submit(
            &sess.uuid,
            "w1",
            "write this",
            None,
            Some(out.to_str().unwrap()),
            Some("written"),
        )
        .unwrap();
    assert!(!created);
    assert_eq!(dup.status, "completed");
    let s3 = run_cycle(&store, &MockProvider).unwrap();
    assert_eq!(s3.completed, 0);
    assert_eq!(store.outbox().unwrap().len(), 2);
    let _ = grant;
}

#[test]
fn cancel_persists_and_excludes_work() {
    let dir = tempfile::tempdir().unwrap();
    let store = setup(&dir, "p");
    let sess = store.create_session().unwrap();
    let (t, _) = store
        .submit(&sess.uuid, "m1", "q", None, None, None)
        .unwrap();
    let cancelled = store.cancel(&t.uuid).unwrap();
    assert_eq!(cancelled.status, "cancelled");
    // Cancelled task has correlated outbox.
    let ob = store.outbox().unwrap();
    assert_eq!(ob.len(), 1);
    assert_eq!(ob[0].status, "cancelled");
    assert_eq!(ob[0].task_uuid, t.uuid);
    drop(store);
    let store = ProfileStore::open_profile(&root_in(&dir), "p").unwrap();
    let s = run_cycle(&store, &MockProvider).unwrap();
    assert_eq!(s.completed, 0);
    assert_eq!(store.task("m1").unwrap().unwrap().status, "cancelled");
    assert_eq!(store.outbox().unwrap().len(), 1);
}

#[test]
fn crash_recovery_marks_uncertain_and_never_replays() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    let store = ProfileStore::create_profile(&root, "p", "").unwrap();
    let work = dir.path().join("work");
    fs::create_dir(&work).unwrap();
    store.allow(&work, "write").unwrap();
    let sess = store.create_session().unwrap();
    let target = work.join("maybe.txt");
    let (t, _) = store
        .submit(
            &sess.uuid,
            "m1",
            "write",
            None,
            Some(target.to_str().unwrap()),
            Some("x"),
        )
        .unwrap();
    // simulate crash mid-effect: task running, effect ledger row 'started'
    store
        .conn
        .execute(
            "UPDATE tasks SET status='running' WHERE id=?1",
            rusqlite::params![t.id],
        )
        .unwrap();
    store
        .start_effect(t.id, "write", target.to_str().unwrap(), 1)
        .unwrap();
    drop(store); // "crash"
    let store = ProfileStore::open_profile(&root, "p").unwrap(); // recovery runs at open
    assert_eq!(store.task("m1").unwrap().unwrap().status, "uncertain");
    // Recovery created correlated uncertain outbox+audit atomically.
    let ob = store.outbox().unwrap();
    assert_eq!(ob.len(), 1);
    assert_eq!(ob[0].status, "uncertain");
    assert_eq!(ob[0].task_uuid, t.uuid);
    let s = run_cycle(&store, &MockProvider).unwrap(); // automatic retry must not happen
    assert_eq!(s.completed + s.denied + s.failed, 0);
    assert!(!target.exists());
    let st: String = store
        .conn
        .query_row(
            "SELECT status FROM effects WHERE task_id=?1",
            rusqlite::params![t.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(st, "uncertain");
}

#[test]
fn task_outbox_atomic_rollback_on_trigger_abort() {
    // TEMP trigger installed on the SAME store connection: the final
    // task/outbox commit in run_cycle aborts, leaving the task 'running'.
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    let store = ProfileStore::create_profile(&root, "p", "").unwrap();
    let work = dir.path().join("work");
    fs::create_dir(&work).unwrap();
    store.allow(&work, "write").unwrap();
    let sess = store.create_session().unwrap();
    let target = work.join("atomic.txt");
    store
        .submit(
            &sess.uuid,
            "m1",
            "write",
            None,
            Some(target.to_str().unwrap()),
            Some("x"),
        )
        .unwrap();
    // Abort any outbox insert while this connection lives.
    store
        .conn
        .execute_batch(
            "CREATE TEMP TRIGGER block_outbox_insert AFTER INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
        )
        .unwrap();
    // run_cycle performs the external write, then the terminal task
    // transaction aborts on the outbox insert.
    let res = run_cycle(&store, &MockProvider);
    assert!(
        res.is_err(),
        "run_cycle must fail while outbox inserts abort"
    );
    // Task stays running; no outbox row survived the rollback.
    let t = store.task("m1").unwrap().unwrap();
    assert_eq!(t.status, "running");
    assert_eq!(store.outbox().unwrap().len(), 0);
    // The external effect happened exactly once.
    assert_eq!(fs::read_to_string(&target).unwrap(), "x");
    // Drop the trigger on the same connection, then drop the store ("crash").
    store
        .conn
        .execute_batch("DROP TRIGGER block_outbox_insert;")
        .unwrap();
    drop(store);
    // Reopen: recovery marks the running task uncertain with a correlated
    // outbox, atomically.
    let store = ProfileStore::open_profile(&root, "p").unwrap();
    let t2 = store.task("m1").unwrap().unwrap();
    assert_eq!(t2.status, "uncertain");
    let ob = store.outbox().unwrap();
    assert_eq!(ob.len(), 1);
    assert_eq!(ob[0].status, "uncertain");
    // No automatic replay: nothing queued, file still written exactly once.
    let s = run_cycle(&store, &MockProvider).unwrap();
    assert_eq!(s.completed + s.denied + s.failed + s.uncertain, 0);
    assert_eq!(fs::read_to_string(&target).unwrap(), "x");
    assert_eq!(store.outbox().unwrap().len(), 1);
}

#[test]
fn recovery_transaction_rollback_on_persistent_trigger_abort() {
    // A PERSISTENT trigger that aborts recovery's outbox insert must make
    // open_profile itself fail with NO status change surviving rollback.
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    let store = ProfileStore::create_profile(&root, "p", "").unwrap();
    let sess = store.create_session().unwrap();
    let (t, _) = store
        .submit(&sess.uuid, "m1", "q", None, None, None)
        .unwrap();
    store.set_status(t.id, "running", None).unwrap();
    store
        .conn
        .execute_batch(
            "CREATE TRIGGER block_recovery_outbox AFTER INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
        )
        .unwrap();
    drop(store);
    // Reopen must fail: the recovery transaction cannot commit.
    assert!(ProfileStore::open_profile(&root, "p").is_err());
    // Inspect with a direct rusqlite connection: status is still 'running'.
    {
        let raw = rusqlite::Connection::open(root.join("profiles/p/ghost.db")).unwrap();
        let status: String = raw
            .query_row(
                "SELECT status FROM tasks WHERE id=?1",
                rusqlite::params![t.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "running");
        raw.execute_batch("DROP TRIGGER block_recovery_outbox;")
            .unwrap();
    }
    // Trigger removed: reopen recovers exactly once.
    let store = ProfileStore::open_profile(&root, "p").unwrap();
    assert_eq!(store.task("m1").unwrap().unwrap().status, "uncertain");
    let ob = store.outbox().unwrap();
    assert_eq!(ob.len(), 1);
    assert_eq!(ob[0].status, "uncertain");
    assert_eq!(ob[0].task_uuid, t.uuid);
}

#[test]
fn grant_id_captured_before_audit_after_multiple_audits() {
    // Ensure allow() captures grant id immediately before audit, not after
    // previous audits might disturb last_insert_rowid.
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    let store = ProfileStore::create_profile(&root, "p", "").unwrap();
    let work = dir.path().join("work");
    fs::create_dir(&work).unwrap();
    // Create multiple sessions/tasks to generate audit entries.
    for i in 0..3 {
        let sess = store.create_session().unwrap();
        store
            .submit(&sess.uuid, &format!("m{}", i), "prompt", None, None, None)
            .unwrap();
    }
    // Now allow - audit entries already exist.
    let g = store.allow(&work, "read").unwrap();
    // Verify grant id is valid and grant is retrievable.
    let retrieved = store
        .grants()
        .unwrap()
        .into_iter()
        .find(|x| x.id == g.id)
        .unwrap();
    assert_eq!(retrieved.id, g.id);
    assert_eq!(
        retrieved.path,
        work.canonicalize().unwrap().to_string_lossy()
    );
    // Audit log should have grant_added event.
    let audit_count: i64 = store
        .conn
        .query_row(
            "SELECT COUNT(*) FROM audit WHERE event='grant_added'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(audit_count, 1);
}

#[test]
fn self_state_write_under_broader_parent_grant() {
    // Self-state writes (inside ghost root) denied even when broader parent grant exists.
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    let store = ProfileStore::create_profile(&root, "p", "").unwrap();
    let work = dir.path().join("work");
    fs::create_dir(&work).unwrap();
    // Grant the parent directory.
    store.allow(&work, "write").unwrap();
    // Try to write to ghost root itself - should be denied.
    let ghost_root_file = root.join("profiles/p/ghost.db");
    let sess = store.create_session().unwrap();
    store
        .submit(
            &sess.uuid,
            "m1",
            "write ghost db",
            None,
            Some(ghost_root_file.to_str().unwrap()),
            Some("hack"),
        )
        .unwrap();
    let s = run_cycle(&store, &MockProvider).unwrap();
    assert_eq!(s.denied, 1);
    // Also deny read of ghost state.
    store
        .submit(
            &sess.uuid,
            "m2",
            "read ghost db",
            Some(ghost_root_file.to_str().unwrap()),
            None,
            None,
        )
        .unwrap();
    let s2 = run_cycle(&store, &MockProvider).unwrap();
    assert_eq!(s2.denied, 1);
}

#[test]
fn oversized_read_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    let store = ProfileStore::create_profile(&root, "p", "").unwrap();
    let work = dir.path().join("work");
    fs::create_dir(&work).unwrap();
    // Create a file larger than MAX_READ_BYTES.
    let big_file = work.join("big.txt");
    let content = "x".repeat(1024 * 1024 + 100); // Just over 1 MiB.
    fs::write(&big_file, &content).unwrap();
    store.allow(&work, "read").unwrap();
    let sess = store.create_session().unwrap();
    store
        .submit(
            &sess.uuid,
            "m1",
            "read big",
            Some(big_file.to_str().unwrap()),
            None,
            None,
        )
        .unwrap();
    let s = run_cycle(&store, &MockProvider).unwrap();
    assert_eq!(s.failed, 1); // Read exceeds limit.
    assert!(store
        .task("m1")
        .unwrap()
        .unwrap()
        .output
        .as_deref()
        .unwrap()
        .contains("limit"));
}

#[test]
#[cfg(unix)]
fn grant_folder_replaced_with_symlink_denied() {
    // The granted directory itself is replaced by a symlink to a different
    // owned directory; the canonical path drift must deny access.
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    let store = ProfileStore::create_profile(&root, "p", "").unwrap();
    let work = dir.path().join("work");
    let outside = dir.path().join("outside");
    fs::create_dir(&work).unwrap();
    fs::create_dir(&outside).unwrap();
    store.allow(&work, "read").unwrap();
    fs::write(work.join("file.txt"), "content").unwrap();
    // Replace the granted folder: move the owned original aside and put a
    // symlink to another owned directory at the previous grant path.
    fs::rename(&work, dir.path().join("work-original")).unwrap();
    std::os::unix::fs::symlink(&outside, &work).unwrap();
    fs::write(outside.join("file.txt"), "content").unwrap();
    let sess = store.create_session().unwrap();
    store
        .submit(
            &sess.uuid,
            "m1",
            "read through replaced grant",
            Some(work.join("file.txt").to_str().unwrap()),
            None,
            None,
        )
        .unwrap();
    let s = run_cycle(&store, &MockProvider).unwrap();
    assert_eq!(s.denied, 1);
}

#[test]
#[cfg(unix)]
fn grant_via_symlink_alias_denied() {
    // Alias denial: a grant on the canonical directory must not be reachable
    // through a sibling symlink path (lexical prefix differs).
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    let store = ProfileStore::create_profile(&root, "p", "").unwrap();
    let real_work = dir.path().join("real_work");
    let symlink_work = dir.path().join("work");
    fs::create_dir(&real_work).unwrap();
    std::os::unix::fs::symlink(&real_work, &symlink_work).unwrap();
    store.allow(&real_work, "read").unwrap();
    fs::write(real_work.join("file.txt"), "content").unwrap();
    let sess = store.create_session().unwrap();
    store
        .submit(
            &sess.uuid,
            "m1",
            "read via symlink",
            Some(symlink_work.join("file.txt").to_str().unwrap()),
            None,
            None,
        )
        .unwrap();
    let s = run_cycle(&store, &MockProvider).unwrap();
    assert_eq!(s.denied, 1);
}

#[test]
fn mac_temp_path_alias_allowed_io() {
    // /tmp on Mac maps to /private/tmp. Use a unique tempfile fixture under
    // /tmp; only the owned fixture is created/cleaned (auto via TempDir), no
    // fixed shared names and no deletion of unrelated files.
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    let store = ProfileStore::create_profile(&root, "p", "").unwrap();
    #[cfg(all(unix, target_os = "macos"))]
    {
        let tmp_dir = tempfile::tempdir_in("/tmp").unwrap();
        let canonical = tmp_dir.path().canonicalize().unwrap();
        assert!(canonical.starts_with("/private/tmp"));
        store.allow(&canonical, "write").unwrap();
        let sess = store.create_session().unwrap();
        // Access via the /tmp alias path (normalized to /private/tmp).
        let target = tmp_dir.path().join("out.txt");
        store
            .submit(
                &sess.uuid,
                "m1",
                "write via /tmp alias",
                None,
                Some(target.to_str().unwrap()),
                Some("hello"),
            )
            .unwrap();
        let s = run_cycle(&store, &MockProvider).unwrap();
        assert_eq!(s.completed, 1);
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
        // Access via the canonical /private/tmp path with the same grant.
        let target2 = canonical.join("out2.txt");
        store
            .submit(
                &sess.uuid,
                "m2",
                "write via /private/tmp",
                None,
                Some(target2.to_str().unwrap()),
                Some("hi"),
            )
            .unwrap();
        let s2 = run_cycle(&store, &MockProvider).unwrap();
        assert_eq!(s2.completed, 1);
        assert_eq!(fs::read_to_string(&target2).unwrap(), "hi");
        // tmp_dir (TempDir) cleans up only the owned fixture directory.
    }
    #[cfg(not(all(unix, target_os = "macos")))]
    {
        // Non-Mac: ordinary unique temp directory, no aliasing expected.
        let tmp_dir = tempfile::tempdir().unwrap();
        store.allow(tmp_dir.path(), "write").unwrap();
        let target = tmp_dir.path().join("out.txt");
        let sess = store.create_session().unwrap();
        store
            .submit(
                &sess.uuid,
                "m1",
                "write to temp",
                None,
                Some(target.to_str().unwrap()),
                Some("hello"),
            )
            .unwrap();
        let s = run_cycle(&store, &MockProvider).unwrap();
        assert_eq!(s.completed, 1);
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
    }
}

#[test]
fn provider_failure_does_not_strand_queue() {
    struct Failing;
    impl Provider for Failing {
        fn name(&self) -> &'static str {
            "failing"
        }
        fn run(&self, _req: &ProviderRequest) -> anyhow::Result<ghost::provider::ProviderResponse> {
            anyhow::bail!("provider exploded")
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let store = setup(&dir, "p");
    let sess = store.create_session().unwrap();
    store
        .submit(&sess.uuid, "a", "1", None, None, None)
        .unwrap();
    store
        .submit(&sess.uuid, "b", "2", None, None, None)
        .unwrap();
    let s = run_cycle(&store, &Failing).unwrap();
    assert_eq!(s.failed, 2);
    for m in ["a", "b"] {
        assert_eq!(store.task(m).unwrap().unwrap().status, "failed");
    }
    assert_eq!(store.outbox().unwrap().len(), 2);
}

#[test]
fn judge_only_chooses_allowed() {
    let j = MockJudge;
    let input = JudgeInput {
        prompt: "pick".into(),
        candidates: vec!["a".into(), "b".into()],
        allowed: vec!["b".into()],
    };
    assert_eq!(j.recommend(&input).unwrap().candidate_id, "b");
    assert!(j
        .recommend(&JudgeInput {
            prompt: "p".into(),
            candidates: vec!["a".into()],
            allowed: vec![],
        })
        .is_none());
    assert!(j
        .recommend(&JudgeInput {
            prompt: "p".into(),
            candidates: vec![],
            allowed: vec!["a".into()],
        })
        .is_none());
}

#[test]
fn invalid_profile_names_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    for bad in ["a/b", "a\\b", "..", ".", "a b", "", "café"] {
        assert!(
            ProfileStore::create_profile(&root, bad, "").is_err(),
            "{bad}"
        );
    }
    // root grant and ghost-root grant refused
    let store = ProfileStore::create_profile(&root, "ok", "").unwrap();
    assert!(store.allow(Path::new("/"), "read").is_err());
    let ghost_dir = root.join("profiles/ok");
    assert!(store.allow(&ghost_dir, "read").is_err());
}

// ---- CLI integration: separate processes ----

fn ghost(root: &Path, args: &[&str]) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_ghost"))
        .arg("--root")
        .arg(root)
        .args(args)
        .output()
        .expect("spawn ghost binary");
    assert!(
        out.status.success(),
        "ghost {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).to_string()
}

#[test]
fn cli_submit_survives_process_exit_and_double_run_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("g");
    let work = dir.path().join("work");
    fs::create_dir(&work).unwrap();
    ghost(&root, &["profile", "create", "p", "--persona", "cli ghost"]);
    let sess = ghost(&root, &["session", "create", "p"]);
    let sess: serde_json::Value = serde_json::from_str(&sess).unwrap();
    let sess_id = sess["uuid"].as_str().unwrap().to_string();
    ghost(
        &root,
        &[
            "task",
            "submit",
            "p",
            &sess_id,
            "--message-id",
            "m-1",
            "--prompt",
            "hello",
        ],
    );
    // submit process exited; status query in a new process sees the durable task
    let status = ghost(&root, &["task", "status", "p", "--task", "m-1"]);
    let v: serde_json::Value = serde_json::from_str(&status).unwrap();
    assert_eq!(v["status"], "queued");
    // duplicate submit in another process: same task, not created again
    let dup = ghost(
        &root,
        &[
            "task",
            "submit",
            "p",
            &sess_id,
            "--message-id",
            "m-1",
            "--prompt",
            "hello",
        ],
    );
    let dup: serde_json::Value = serde_json::from_str(&dup).unwrap();
    assert_eq!(dup["created"], false);
    ghost(&root, &["run", "p"]);
    let run2 = ghost(&root, &["run", "p"]);
    let run2: serde_json::Value = serde_json::from_str(&run2).unwrap();
    assert_eq!(run2["completed"], 0);
    let ob = ghost(&root, &["outbox", "p"]);
    let ob: serde_json::Value = serde_json::from_str(&ob).unwrap();
    assert_eq!(ob.as_array().unwrap().len(), 1);
    assert_eq!(ob[0]["status"], "completed");
}

#[test]
fn cli_two_ghost_isolation_and_policy() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("g");
    let work = dir.path().join("work");
    fs::create_dir(&work).unwrap();
    for name in ["one", "two"] {
        ghost(&root, &["profile", "create", name]);
        ghost(
            &root,
            &[
                "policy",
                "allow",
                name,
                "--path",
                work.to_str().unwrap(),
                "--operation",
                "write",
            ],
        );
        let sess = ghost(&root, &["session", "create", name]);
        let sess: serde_json::Value = serde_json::from_str(&sess).unwrap();
        let sess_id = sess["uuid"].as_str().unwrap().to_string();
        ghost(
            &root,
            &[
                "task",
                "submit",
                name,
                &sess_id,
                "--message-id",
                "m",
                "--prompt",
                "write",
                "--write",
                work.join(format!("{}.txt", name)).to_str().unwrap(),
                "--content",
                name,
            ],
        );
    }
    ghost(&root, &["run", "one"]);
    ghost(&root, &["run", "two"]);
    assert_eq!(fs::read_to_string(work.join("one.txt")).unwrap(), "one");
    assert_eq!(fs::read_to_string(work.join("two.txt")).unwrap(), "two");
    let ob1: serde_json::Value = serde_json::from_str(&ghost(&root, &["outbox", "one"])).unwrap();
    let ob2: serde_json::Value = serde_json::from_str(&ghost(&root, &["outbox", "two"])).unwrap();
    let p1 = ob1[0]["profile_uuid"].as_str().unwrap();
    let p2 = ob2[0]["profile_uuid"].as_str().unwrap();
    assert_ne!(p1, p2);
    // deny without grant: fresh profile
    ghost(&root, &["profile", "create", "three"]);
    ghost(&root, &["run", "three"]); // nothing queued; succeeds with zero summary
    let denied_ob: serde_json::Value =
        serde_json::from_str(&ghost(&root, &["outbox", "three"])).unwrap();
    assert_eq!(denied_ob.as_array().unwrap().len(), 0);
}

#[test]
fn unknown_profile_does_not_create_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    assert!(ProfileStore::open_profile(&root, "nope").is_err());
    // Opening a missing profile must not create profiles/ or its directory.
    assert!(!root.join("profiles/nope").exists());
}

#[test]
#[cfg(unix)]
fn profile_directory_symlink_alias_rejected() {
    // A symlink named like another profile pointing at a real profile's state
    // directory must be rejected to avoid alias duplicate writers.
    let dir = tempfile::tempdir().unwrap();
    let root = root_in(&dir);
    let real = dir.path().join("real");
    fs::create_dir(&real).unwrap();
    ProfileStore::create_profile(&root, "p", "").unwrap();
    std::os::unix::fs::symlink(root.join("profiles/p"), root.join("profiles/q")).unwrap();
    assert!(ProfileStore::open_profile(&root, "q").is_err());
    assert!(ProfileStore::create_profile(&root, "q", "").is_err());
}

#[cfg(feature = "oxicode-engine")]
#[test]
fn oxicode_engine_resolves_builtin_models_without_credentials() {
    // Credential-free, offline: only engine construction and model registry
    // resolution. No agents are built and no model/runtime calls are made.
    use oxicode_sdk::OxicodeBuilder;
    let engine = OxicodeBuilder::new().with_builtins().build();
    let openai = engine.resolve_model("openai/gpt-4o").unwrap();
    let anthropic = engine
        .resolve_model("anthropic/claude-sonnet-4-20250514")
        .unwrap();
    // Distinct providers resolved from the builtin registry.
    assert_ne!(format!("{:?}", openai), format!("{:?}", anthropic));
    assert!(engine.resolve_model("no-such-provider/model").is_err());
}
