#![cfg(all(feature = "lifetime", unix))]

use ghost::{lifetime_contract::{canonical_digest,Envelope,ResponseStatus,WorkerSpec,VERSION},worker::Supervisor};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},thread,time::{Duration,Instant}};
use tempfile::TempDir;

fn fixture_runner() -> (PathBuf,Vec<String>) {
    let fixture=Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lifetime_worker/fake_omp.py");
    (PathBuf::from("/usr/bin/env"),vec!["python3".into(),fixture.to_string_lossy().into_owned(),"normal".into()])
}

fn envelope(command_id:&str,actor_epoch:u64,body:Value)->Envelope {
    Envelope {
        protocol_version:VERSION.into(),command_id:command_id.into(),payload_digest:canonical_digest(&body).unwrap(),
        actor_ref:"fixture-owner".into(),authority_epoch:actor_epoch,expected_revision:None,
        correlation_id:format!("correlation-{command_id}"),body,
    }
}

fn workspace(root:&Path,execution_id:&str)->PathBuf {
    let cwd=root.join("workspaces").join(execution_id);
    std::fs::create_dir_all(&cwd).unwrap();
    cwd.canonicalize().unwrap()
}

fn spec(root:&Path,execution_id:&str,max_progress_bytes:u64)->WorkerSpec {
    WorkerSpec {
        execution_id:execution_id.into(),work_id:"work-fixture".into(),work_revision:1,authority_epoch:1,
        computer_id:"fixture-computer".into(),cwd:workspace(root,execution_id).to_string_lossy().into_owned(),prompt:"Emit one fixture result".into(),
        model:"fixture/test-model".into(),thinking:"off".into(),allowed_tools:vec!["canary_read".into(),"canary_write".into()],deadline_ms:10_000,max_progress_bytes,skills:None,input_artifacts:None,
    }
}

fn open(root:&TempDir)->Supervisor {
    let (runner,args)=fixture_runner();
    Supervisor::open_with_canary_runner(root.path(),&runner,&args).unwrap()
}

fn submit(worker:&mut Supervisor,command_id:&str,worker_spec:WorkerSpec)->ghost::lifetime_contract::Response {
    let body=json!({"method":"submit","spec":worker_spec});
    worker.handle(&envelope(command_id,1,body)).unwrap()
}

fn wait_for<F>(worker:&mut Supervisor,execution_id:&str,mut predicate:F)->Value
where F:FnMut(&Value)->bool {
    let deadline=Instant::now()+Duration::from_secs(5);
    loop {
        let response=worker.handle(&envelope(&format!("inspect-{}",uuid::Uuid::new_v4()),1,json!({"method":"inspect","execution_id":execution_id}))).unwrap();
        let data=response.data;
        if predicate(&data) { return data; }
        assert!(Instant::now()<deadline,"fixture execution did not reach its durable state");
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn same_execution_id_and_spec_reconnect_without_a_second_child() {
    let root=TempDir::new().unwrap();
    let mut worker=open(&root);
    let first=submit(&mut worker,"submit-1",spec(root.path(),"execution-idempotent",1024*1024));
    assert_eq!(first.status,ResponseStatus::Success);
    let duplicate=submit(&mut worker,"submit-1",spec(root.path(),"execution-idempotent",1024*1024));
    assert_eq!(first,duplicate,"same command id returns the immutable receipt");
    let rebound=submit(&mut worker,"submit-2",spec(root.path(),"execution-idempotent",1024*1024));
    assert_eq!(rebound.data["execution_id"],"execution-idempotent");
    assert_eq!(rebound.data["spec_digest"],first.data["spec_digest"]);
    let changed=submit(&mut worker,"submit-3",{let mut changed=spec(root.path(),"execution-idempotent",1024*1024);changed.prompt="different immutable prompt".into();changed});
    assert_eq!(changed.status,ResponseStatus::Error);
    assert_eq!(changed.error_code.as_deref(),Some("conflict"));
    let final_state=wait_for(&mut worker,"execution-idempotent",|data| data["process_exited"]==true);
    assert_eq!(final_state["prompt_acknowledged"],true);
    assert_eq!(final_state["session_settled"],true);
    let events=worker.handle(&envelope("events-idempotent",1,json!({"method":"events","execution_id":"execution-idempotent","after_sequence":0}))).unwrap();
    let kinds:Vec<&str>=events.data["events"].as_array().unwrap().iter().filter_map(|event|event["kind"].as_str()).collect();
    assert!(kinds.contains(&"prompt_ack"));
    assert!(kinds.contains(&"prompt_result"));
    assert!(kinds.contains(&"session_settled"));
    assert!(kinds.contains(&"process_exit"));
}

#[test]
fn command_receipt_deduplicates_envelope_but_rejects_changed_body() {
    let root=TempDir::new().unwrap();
    let mut worker=open(&root);
    let body=json!({"method":"submit","spec":spec(root.path(),"execution-command-dedup",1024*1024)});
    let first=worker.handle(&envelope("stable-command",1,body.clone())).unwrap();
    let replay=worker.handle(&envelope("stable-command",1,body)).unwrap();
    assert_eq!(first,replay);
    let changed=worker.handle(&envelope("stable-command",1,json!({"method":"inspect","execution_id":"execution-command-dedup"}))).unwrap();
    assert_eq!(changed.status,ResponseStatus::Error);
    assert_eq!(changed.error_code.as_deref(),Some("conflict"));
}

#[test]
fn progress_limit_never_drops_terminal_receipts() {
    let root=TempDir::new().unwrap();
    let (runner,args)=fixture_runner();
    let mut args=args;
    *args.last_mut().unwrap()="large_progress".into();
    let mut worker=Supervisor::open_with_canary_runner(root.path(),&runner,&args).unwrap();
    let response=submit(&mut worker,"submit-spool",spec(root.path(),"execution-spool",32));
    assert_eq!(response.status,ResponseStatus::Success);
    let data=wait_for(&mut worker,"execution-spool",|data|data["process_exited"]==true);
    assert_eq!(data["session_settled"],true);
    let events=worker.handle(&envelope("events-spool",1,json!({"method":"events","execution_id":"execution-spool","after_sequence":0}))).unwrap();
    let kinds:Vec<&str>=events.data["events"].as_array().unwrap().iter().filter_map(|event|event["kind"].as_str()).collect();
    assert!(kinds.contains(&"spool_limit_reached"));
    assert!(kinds.contains(&"prompt_result"));
    assert!(kinds.contains(&"session_settled"));
}

#[test]
fn process_eof_before_settled_is_unknown_not_success() {
    let root=TempDir::new().unwrap();
    let (runner,args)=fixture_runner();
    let mut args=args;
    *args.last_mut().unwrap()="eof_before_settled".into();
    let mut worker=Supervisor::open_with_canary_runner(root.path(),&runner,&args).unwrap();
    let response=submit(&mut worker,"submit-eof",spec(root.path(),"execution-eof",1024*1024));
    assert_eq!(response.status,ResponseStatus::Success);
    let data=wait_for(&mut worker,"execution-eof",|data|data["process_exited"]==true && matches!(data["state"].as_str(),Some("unknown"|"failed")));
    assert_ne!(data["state"],"settled");
    assert_eq!(data["session_settled"],false);
    assert!(matches!(data["state"].as_str(),Some("unknown"|"failed")));
}

#[test]
fn fence_is_monotonic_and_rejects_old_authority() {
    let root=TempDir::new().unwrap();
    let mut worker=open(&root);
    let response=worker.handle(&envelope("fence-2",2,json!({"method":"fence","new_epoch":2}))).unwrap();
    assert_eq!(response.status,ResponseStatus::Success);
    let stale=submit(&mut worker,"submit-old-epoch",spec(root.path(),"execution-old-epoch",1024*1024));
    assert_eq!(stale.status,ResponseStatus::Error);
    assert_eq!(stale.error_code.as_deref(),Some("fenced"));
}

#[test]
fn fence_rejects_cached_mutations_before_and_after_supervisor_reopen() {
    let root=TempDir::new().unwrap();
    let mut worker=open(&root);
    let requests=[
        envelope("cached-steer",1,json!({"method":"steer","execution_id":"absent","prompt":"bounded control"})),
        envelope("cached-cancel",1,json!({"method":"cancel","execution_id":"absent"})),
        envelope("cached-ack",1,json!({"method":"acknowledge","execution_id":"absent","through_sequence":0})),
    ];
    for request in &requests {
        let first=worker.handle(request).unwrap();
        assert!(matches!(first.error_code.as_deref(),Some("not_found"|"invalid_acknowledgement")));
    }
    let fence=envelope("advance-fence",2,json!({"method":"fence","new_epoch":2}));
    assert_eq!(worker.handle(&fence).unwrap().status,ResponseStatus::Success);
    for request in &requests {
        let stale=worker.handle(request).unwrap();
        assert_eq!(stale.error_code.as_deref(),Some("fenced"));
        assert_eq!(stale.retry_class,ghost::lifetime_contract::RetryClass::Never);
    }
    drop(worker);
    let mut reopened=open(&root);
    for request in &requests {
        assert_eq!(reopened.handle(request).unwrap().error_code.as_deref(),Some("fenced"));
    }
    assert_eq!(reopened.handle(&envelope("current-cancel",2,json!({"method":"cancel","execution_id":"absent"}))).unwrap().error_code.as_deref(),Some("not_found"));
    assert_eq!(reopened.handle(&envelope("advance-again",3,json!({"method":"fence","new_epoch":3}))).unwrap().status,ResponseStatus::Success);
    assert_eq!(reopened.handle(&fence).unwrap().error_code.as_deref(),Some("fenced"));
}

#[test]
fn collection_requires_settlement_and_exit_and_preserves_artifacts() {
    let root=TempDir::new().unwrap();
    let mut worker=open(&root);
    let response=submit(&mut worker,"submit-collect",spec(root.path(),"execution-collect",1024*1024));
    assert_eq!(response.status,ResponseStatus::Success);
    let _=wait_for(&mut worker,"execution-collect",|data|data["process_exited"]==true);
    let collected=worker.handle(&envelope("collect-1",1,json!({"method":"collect","execution_id":"execution-collect"}))).unwrap();
    assert_eq!(collected.status,ResponseStatus::Success);
    assert_eq!(collected.data["session_settled"],true);
    assert_eq!(collected.data["process_exited"],true);
    assert_eq!(collected.data["execution_id"],"execution-collect");
}

#[test]
fn steer_and_cancel_acknowledgements_do_not_claim_settlement_or_process_exit() {
    let root=TempDir::new().unwrap();
    let (runner,args)=fixture_runner();
    let mut args=args;
    *args.last_mut().unwrap()="wait_control".into();
    let mut worker=Supervisor::open_with_canary_runner(root.path(),&runner,&args).unwrap();
    let response=submit(&mut worker,"submit-control",spec(root.path(),"execution-control",1024*1024));
    assert_eq!(response.status,ResponseStatus::Success);
    let _=wait_for(&mut worker,"execution-control",|data|data["prompt_acknowledged"]==true);

    let steered=worker.handle(&envelope("steer-control",1,json!({"method":"steer","execution_id":"execution-control","prompt":"Keep the result bounded"}))).unwrap();
    assert_eq!(steered.status,ResponseStatus::Success);
    assert_eq!(steered.data["rpc_acknowledged"],true);
    assert_eq!(steered.data["prompt_result_pending"],true);
    assert_eq!(steered.data["session_settled"],false);

    let canceled=worker.handle(&envelope("cancel-control",1,json!({"method":"cancel","execution_id":"execution-control"}))).unwrap();
    assert_eq!(canceled.status,ResponseStatus::Success);
    assert_eq!(canceled.data["cancel_acknowledged"],true);
    assert_eq!(canceled.data["process_exited"],false);
    assert_eq!(canceled.data["effects_reconciled"],false);
    let settled=wait_for(&mut worker,"execution-control",|data|data["session_settled"]==true && data["process_exited"]==true);
    assert_eq!(settled["prompt_acknowledged"],true);
}
