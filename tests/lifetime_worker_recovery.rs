#![cfg(all(feature = "lifetime", unix))]

use ghost::{lifetime_contract::{canonical_digest,Envelope,ResponseStatus,VERSION,WorkerSpec},worker::Supervisor};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},process::{Child,Command,Stdio},thread,time::{Duration,Instant}};
use tempfile::TempDir;

fn envelope(command_id:&str,body:serde_json::Value)->Envelope {
    Envelope { protocol_version:VERSION.into(),command_id:command_id.into(),payload_digest:canonical_digest(&body).unwrap(),
        actor_ref:"fixture-owner".into(),authority_epoch:1,expected_revision:None,correlation_id:command_id.into(),body }
}
fn workspace(root:&Path,id:&str)->PathBuf {
    let cwd=root.join("workspaces").join(id);
    std::fs::create_dir_all(&cwd).unwrap();
    cwd.canonicalize().unwrap()
}
fn spec(root:&Path,id:&str)->WorkerSpec {
    WorkerSpec { execution_id:id.into(),work_id:"work-recovery".into(),work_revision:1,authority_epoch:1,
        computer_id:"canary-computer".into(),cwd:workspace(root,id).to_string_lossy().into_owned(),prompt:"sleep inside fake RPC until cancelled".into(),
        model:"fixture/test-model".into(),thinking:"off".into(),allowed_tools:vec!["canary_read".into(),"canary_write".into()],deadline_ms:20_000,max_progress_bytes:1024*1024,skills:None,input_artifacts:None }
}
fn runner()->(PathBuf,Vec<String>) {
    let fixture=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lifetime_worker/fake_omp.py");
    (PathBuf::from("/usr/bin/env"),vec!["python3".into(),fixture.to_string_lossy().into_owned(),"yield_then_settle".into()])
}

#[test]
fn event_gap_returns_snapshot_and_ack_never_deletes_terminal_receipt() {
    let root=TempDir::new().unwrap();
    let (runner,args)=runner();
    let mut worker=Supervisor::open_with_canary_runner(root.path(),&runner,&args).unwrap();
    let work=spec(root.path(),"execution-recovery-events");
    let submitted=worker.handle(&envelope("submit-events",json!({"method":"submit","spec":work}))).unwrap();
    assert_eq!(submitted.status,ResponseStatus::Success);
    let deadline=Instant::now()+Duration::from_secs(5);
    let mut inspect;
    loop {
        inspect=worker.handle(&envelope(&format!("inspect-{}",uuid::Uuid::new_v4()),json!({"method":"inspect","execution_id":"execution-recovery-events"}))).unwrap().data;
        if inspect["process_exited"]==true { break; }
        assert!(Instant::now()<deadline,"fake OMP did not exit");
        thread::sleep(Duration::from_millis(20));
    }
    let high=inspect["last_sequence"].as_u64().unwrap();
    let ack=worker.handle(&envelope("ack-events",json!({"method":"acknowledge","execution_id":"execution-recovery-events","through_sequence":high}))).unwrap();
    assert_eq!(ack.status,ResponseStatus::Success);
    let gap=worker.handle(&envelope("events-after-ack",json!({"method":"events","execution_id":"execution-recovery-events","after_sequence":0}))).unwrap();
    assert_eq!(gap.status,ResponseStatus::Warning);
    assert_eq!(gap.data["gap"],true);
    assert!(gap.data["authoritative_snapshot"].is_object());
    assert_eq!(gap.data["authoritative_snapshot"]["session_settled"],true);
}

#[test]
#[ignore = "subprocess helper used by worker restart recovery test"]
fn canary_supervisor_child_for_recovery() {
    let Some(root)=std::env::var_os("GHOST_C1_CANARY_ROOT").map(PathBuf::from) else { return; };
    let Some(marker)=std::env::var_os("GHOST_C1_CANARY_MARKER").map(PathBuf::from) else { return; };
    let (runner,args)=orphan_runner(&marker);
    let mut worker=Supervisor::open_with_canary_runner(&root,&runner,&args).unwrap();
    let submitted=worker.handle(&envelope("submit-orphan",json!({"method":"submit","spec":spec(&root,"execution-orphan-recovery")}))).unwrap();
    assert_eq!(submitted.status,ResponseStatus::Success);
    let deadline=Instant::now()+Duration::from_secs(5);
    let inspect=loop {
        let inspect=worker.handle(&envelope(&format!("inspect-{}",uuid::Uuid::new_v4()),json!({"method":"inspect","execution_id":"execution-orphan-recovery"}))).unwrap().data;
        if inspect["prompt_acknowledged"]==true { break inspect; }
        assert!(Instant::now()<deadline,"fake OMP did not acknowledge the prompt");
        thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(inspect["session_settled"],false);
    std::fs::write(root.join("helper-ready.json"),serde_json::to_vec(&inspect).unwrap()).unwrap();
    loop { thread::sleep(Duration::from_secs(60)); }
}

fn orphan_runner(marker:&Path)->(PathBuf,Vec<String>) {
    let fixture=Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lifetime_worker/fake_omp.py");
    (PathBuf::from("/usr/bin/env"),vec!["python3".into(),fixture.to_string_lossy().into_owned(),"orphan_on_eof".into(),marker.to_string_lossy().into_owned()])
}

struct HelperProcess(Child);

impl HelperProcess {
    fn stop(&mut self) {
        let _=self.0.kill();
        let _=self.0.wait();
    }
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(),Ok(None)) { self.stop(); }
    }
}

struct OrphanGroup { group:i32, armed:bool }

impl Drop for OrphanGroup {
    fn drop(&mut self) {
        if self.armed { unsafe { libc::kill(-self.group,libc::SIGKILL); } }
    }
}

fn process_group_exists(group:i32)->bool {
    let result=unsafe { libc::kill(-group,0) };
    result==0 || std::io::Error::last_os_error().raw_os_error()==Some(libc::EPERM)
}

#[test]
fn worker_restart_kills_orphan_and_never_replays_after_prompt_intent() {
    assert_restart_preserves_unknown(None);
}

#[test]
fn worker_restart_preserves_unsettled_resumed_execution_without_respawn() {
    assert_restart_preserves_unknown(Some("resumed"));
}

#[test]
fn worker_restart_does_not_treat_unsealed_owner_decision_as_a_resumable_wait() {
    assert_restart_preserves_unknown(Some("waiting_owner"));
}

fn assert_restart_preserves_unknown(crashed_state: Option<&str>) {
    let root=TempDir::new().unwrap();
    let ready_path=root.path().join("helper-ready.json");
    let marker=root.path().join("orphan-terminated");
    let mut helper=HelperProcess(Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("canary_supervisor_child_for_recovery")
        .arg("--ignored")
        .arg("--nocapture")
        .env("GHOST_C1_CANARY_ROOT",root.path())
        .env("GHOST_C1_CANARY_MARKER",&marker)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn().unwrap());
    let deadline=Instant::now()+Duration::from_secs(5);
    while !ready_path.exists() {
        assert!(Instant::now()<deadline,"canary worker subprocess did not reach the prompt boundary");
        thread::sleep(Duration::from_millis(20));
    }
    let ready:Value=serde_json::from_slice(&std::fs::read(&ready_path).unwrap()).unwrap();
    let group=ready["process_group"].as_i64().unwrap() as i32;
    let mut orphan=OrphanGroup { group,armed:true };
    helper.stop();
    if let Some(state) = crashed_state {
        // Crash after decision charging, before the new actor records its
        // identity. No sealed owner budget remains; recovery must not replay.
        let journal = rusqlite::Connection::open(root.path().join("worker.db")).unwrap();
        journal.execute(
            "UPDATE executions SET state=?1 WHERE execution_id=?2",
            [state, "execution-orphan-recovery"],
        ).unwrap();
    }

    let (runner,args)=orphan_runner(&marker);
    let mut recovered=Supervisor::open_with_canary_runner(root.path(),&runner,&args).unwrap();
    let inspect=recovered.handle(&envelope("inspect-recovered",json!({"method":"inspect","execution_id":"execution-orphan-recovery"}))).unwrap();
    assert_eq!(inspect.status,ResponseStatus::Success);
    assert_eq!(inspect.data["state"],"unknown");
    assert_eq!(inspect.data["prompt_intent"],true);
    assert_eq!(inspect.data["process_exited"],false);
    assert!(marker.exists(),"recovery did not signal the orphan process group");
    let events=recovered.handle(&envelope("events-recovered",json!({"method":"events","execution_id":"execution-orphan-recovery","after_sequence":0}))).unwrap();
    let rows=events.data["events"].as_array().unwrap();
    assert_eq!(rows.iter().filter(|event|event["kind"]=="process_started").count(),1);
    assert!(rows.iter().any(|event|event["kind"]=="recovery_unknown"));
    let deadline=Instant::now()+Duration::from_secs(5);
    while process_group_exists(group) {
        assert!(Instant::now()<deadline,"recovery left the orphan process group running");
        thread::sleep(Duration::from_millis(20));
    }
    orphan.armed=false;
}
