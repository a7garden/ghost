#![cfg(all(feature = "lifetime", unix))]

use crate::{
    lifetime_contract::{canonical_digest,Envelope,ResponseStatus,WorkerSpec,VERSION},
    worker::Supervisor,
};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{path::{Path,PathBuf},thread,time::{Duration,Instant}};
use tempfile::TempDir;

fn envelope(command_id:&str,body:Value)->Envelope {
    Envelope {
        protocol_version:VERSION.into(),command_id:command_id.into(),payload_digest:canonical_digest(&body).unwrap(),
        actor_ref:"fixture-owner".into(),authority_epoch:1,expected_revision:None,correlation_id:command_id.into(),body,
    }
}

fn scoped_spec(root:&Path,execution_id:&str)->WorkerSpec {
    let cwd=root.join("workspaces").join("attempt");
    std::fs::create_dir_all(&cwd).unwrap();
    let cwd = cwd.canonicalize().unwrap();
    WorkerSpec {
        execution_id:execution_id.into(),work_id:"work-scoped-tools".into(),work_revision:1,authority_epoch:1,
        computer_id:"fixture-computer".into(),cwd:cwd.to_string_lossy().into_owned(),prompt:"Write and read the synthetic file".into(),
        model:"fixture/test-model".into(),thinking:"off".into(),allowed_tools:vec!["canary_read".into(),"canary_write".into()],
        deadline_ms:10_000,max_progress_bytes:1024*1024,skills:None,input_artifacts:None,
    }
}

fn fixture_runner(mode:&str)->(PathBuf,Vec<String>) {
    let fixture=Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lifetime_worker/fake_omp.py");
    (PathBuf::from("/usr/bin/env"),vec!["python3".into(),fixture.to_string_lossy().into_owned(),mode.into()])
}

#[test]
fn host_tool_receipts_conflicts_and_artifact_are_collected_independently() {
    let root=TempDir::new().unwrap();
    let spec=scoped_spec(root.path(),"execution-scoped-tools");
    let cwd=PathBuf::from(&spec.cwd);
    let (runner,args)=fixture_runner("tool_conflict_flow");
    let mut worker=Supervisor::open_legacy_fixture(root.path(),&runner,&args).unwrap();
    let submitted=worker.handle(&envelope("submit-scoped-tools",json!({"method":"submit","spec":spec}))).unwrap();
    assert_eq!(submitted.status,ResponseStatus::Success);

    let deadline=Instant::now()+Duration::from_secs(5);
    loop {
        let inspect=worker.handle(&envelope(&format!("inspect-{}",uuid::Uuid::new_v4()),json!({"method":"inspect","execution_id":"execution-scoped-tools"}))).unwrap();
        if inspect.data["process_exited"]==true { break; }
        assert!(Instant::now()<deadline,"scoped fake OMP did not settle");
        thread::sleep(Duration::from_millis(20));
    }

    let collected=worker.handle(&envelope("collect-scoped-tools",json!({"method":"collect","execution_id":"execution-scoped-tools"}))).unwrap();
    assert_eq!(collected.status,ResponseStatus::Success);
    assert_eq!(std::fs::read_to_string(cwd.join("answer.txt")).unwrap(),"C2 scoped artifact");
    let receipts=collected.data["tool_receipts"].as_array().unwrap();
    let write=receipts.iter().find(|receipt|receipt["tool_call_id"]=="fixture-tool-write").unwrap();
    let read=receipts.iter().find(|receipt|receipt["tool_call_id"]=="fixture-tool-read").unwrap();
    let digest=format!("{:x}",Sha256::digest(b"C2 scoped artifact"));
    assert_eq!(write["status"],"complete");
    assert_eq!(write["result"]["sha256"],digest);
    assert_eq!(read["result"]["content"],"C2 scoped artifact");
    assert_eq!(read["result"]["sha256"],digest);
    assert_eq!(collected.artifacts.len(),1);
    assert_eq!(collected.artifacts[0].digest,digest);
    assert_eq!(collected.artifacts[0].privacy,"local_only");
    assert_eq!(std::fs::read_to_string(&collected.artifacts[0].locator).unwrap(),"C2 scoped artifact");

    let events=worker.handle(&envelope("events-scoped-tools",json!({"method":"events","execution_id":"execution-scoped-tools","after_sequence":0}))).unwrap();
    let kinds:Vec<&str>=events.data["events"].as_array().unwrap().iter().filter_map(|event|event["kind"].as_str()).collect();
    assert!(kinds.contains(&"tool_call_intent"));
    assert!(kinds.contains(&"tool_call_result"));
    assert!(kinds.contains(&"tool_call_conflict"));

    std::fs::write(&collected.artifacts[0].locator, "Corrupted after the immutable tool receipt").unwrap();
    let corrupted = worker.handle(&envelope("collect-corrupted-artifact", json!({"method":"collect","execution_id":"execution-scoped-tools"}))).unwrap();
    assert_eq!(corrupted.status, ResponseStatus::Error);
    assert_eq!(corrupted.error_code.as_deref(), Some("collection_unverified"));
}

#[test]
fn scoped_tools_deny_parent_absolute_uri_symlink_and_hardlink_escape() {
    let root=TempDir::new().unwrap();
    let spec=scoped_spec(root.path(),"execution-escape-boundary");
    let cwd=PathBuf::from(&spec.cwd);
    let outside=cwd.parent().unwrap().join("sentinel.txt");
    std::fs::write(&outside,b"Preserved scoped boundary").unwrap();
    std::os::unix::fs::symlink(&outside,cwd.join("outside-link")).unwrap();
    std::fs::hard_link(&outside,cwd.join("hard-link")).unwrap();
    let (runner,args)=fixture_runner("tool_escape_flow");
    let mut worker=Supervisor::open_legacy_fixture(root.path(),&runner,&args).unwrap();
    let response=worker.handle(&envelope("submit-escape-boundary",json!({"method":"submit","spec":spec}))).unwrap();
    assert_eq!(response.status,ResponseStatus::Success);
    let deadline=Instant::now()+Duration::from_secs(5);
    loop {
        let inspection=worker.handle(&envelope(&format!("inspect-escape-{}",uuid::Uuid::new_v4()),json!({"method":"inspect","execution_id":"execution-escape-boundary"}))).unwrap();
        if inspection.data["process_exited"]==true { break; }
        assert!(Instant::now()<deadline,"escape boundary fixture did not exit");
        thread::sleep(Duration::from_millis(20));
    }
    let collected=worker.handle(&envelope("collect-escape-boundary",json!({"method":"collect","execution_id":"execution-escape-boundary"}))).unwrap();
    assert_eq!(collected.status,ResponseStatus::Success);
    assert_eq!(collected.data["process_exit_code"],0);
    assert_eq!(std::fs::read(&outside).unwrap(),b"Preserved scoped boundary");
    assert_eq!(std::fs::read_to_string(cwd.join("answer.txt")).unwrap(),"C2 scoped artifact");
}

#[test]
fn cancelled_execution_rejects_late_host_write_and_records_rejection() {
    let root=TempDir::new().unwrap();
    let spec=scoped_spec(root.path(),"execution-late-cancel");
    let cwd=PathBuf::from(&spec.cwd);
    let (runner,args)=fixture_runner("late_tool_after_cancel");
    let mut worker=Supervisor::open_legacy_fixture(root.path(),&runner,&args).unwrap();
    assert_eq!(worker.handle(&envelope("submit-late-cancel",json!({"method":"submit","spec":spec}))).unwrap().status,ResponseStatus::Success);
    let deadline=Instant::now()+Duration::from_secs(5);
    loop {
        let inspect=worker.handle(&envelope(&format!("before-cancel-{}",uuid::Uuid::new_v4()),json!({"method":"inspect","execution_id":"execution-late-cancel"}))).unwrap();
        if inspect.data["prompt_acknowledged"]==true { break; }
        assert!(Instant::now()<deadline,"fixture did not enter its cancellable prompt");
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(worker.handle(&envelope("cancel-late-effect",json!({"method":"cancel","execution_id":"execution-late-cancel"}))).unwrap().status,ResponseStatus::Success);
    loop {
        let inspect=worker.handle(&envelope(&format!("after-cancel-{}",uuid::Uuid::new_v4()),json!({"method":"inspect","execution_id":"execution-late-cancel"}))).unwrap();
        if inspect.data["process_exited"]==true { break; }
        assert!(Instant::now()<deadline,"cancelled fixture did not exit");
        thread::sleep(Duration::from_millis(20));
    }
    assert!(!cwd.join("after-cancel.txt").exists(),"late cancelled tool must not create a filesystem effect");
    let collected=worker.handle(&envelope("collect-late-rejection",json!({"method":"collect","execution_id":"execution-late-cancel"}))).unwrap();
    assert_eq!(collected.status,ResponseStatus::Success);
    let receipt=collected.data["tool_receipts"].as_array().unwrap().iter().find(|receipt|receipt["tool_call_id"]=="late-cancel-write").unwrap();
    assert_eq!(receipt["result"]["error_code"],"execution_revoked");
    assert_eq!(receipt["is_error"],true);
    assert!(collected.artifacts.is_empty(),"rejected late write cannot produce a spool artifact");
}
