#![cfg(all(feature="lifetime",unix))]
//! Public library entry points, compiled without private unit-fixture helpers.
use ghost::{worker::Supervisor,lifetime_contract::{canonical_digest,Envelope,Response,ResponseStatus,RetryClass,VERSION,WorkerSpec}};
use serde_json::{json,Value};
use rusqlite::params;
use std::path::Path;
fn envelope(id:&str,body:Value)->Envelope {
    Envelope{protocol_version:VERSION.into(),command_id:id.into(),payload_digest:canonical_digest(&body).unwrap(),actor_ref:"old-owner".into(),authority_epoch:1,expected_revision:None,correlation_id:id.into(),body}
}
#[test]
fn public_worker_constructors_reject_fresh_admission_without_runner_or_process() {
    let root=tempfile::tempdir().unwrap();
    for (index,mut worker) in [Supervisor::open(root.path()).unwrap()].into_iter().enumerate() {
        for method in ["submit","steer","browser.resume"] {
            let response=worker.handle(&envelope(&format!("fresh-{index}-{method}"),json!({"method":method}))).unwrap();
            assert_eq!(response.error_code.as_deref(),Some("legacy_execution_retired"));
        }
    }
    for index in 0..2 {
        let mut worker=if index==0 {Supervisor::open_with_canary_runner(root.path(),Path::new("/nonexistent/omp"),&[])} else {Supervisor::open_with_scoped_omp(root.path(),Path::new("/nonexistent/bun"),Path::new("/nonexistent/entry"),Path::new("/nonexistent/package"),Path::new("/nonexistent/config"))}.unwrap();
        assert_eq!(worker.handle(&envelope("fresh-constructor",json!({"method":"submit"}))).unwrap().error_code.as_deref(),Some("legacy_execution_retired"));
        drop(worker);
    }
    let db=rusqlite::Connection::open(root.path().join("worker.db")).unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM executions",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(db.query_row("SELECT COUNT(*) FROM commands",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}
#[test]
fn public_cold_reopen_preserves_old_receipt_and_inspection_without_respawn() {
    let root=tempfile::tempdir().unwrap();drop(Supervisor::open(root.path()).unwrap());
    let spec=WorkerSpec{execution_id:"old-admitted".into(),work_id:"old-work".into(),work_revision:1,authority_epoch:1,computer_id:"old-computer".into(),cwd:root.path().to_string_lossy().into_owned(),prompt:"retained old task".into(),model:"fixture/old-model".into(),thinking:"off".into(),allowed_tools:vec![],deadline_ms:1000,max_progress_bytes:65536,skills:None,input_artifacts:None};
    let command=envelope("original-submit",json!({"method":"submit","spec":spec}));
    let receipt=Response{status:ResponseStatus::Success,summary:"Original immutable historical receipt".into(),object_refs:vec![spec.execution_id.clone()],artifacts:vec![],next_actions:vec![],error_code:None,retry_class:RetryClass::SameId,data:json!({"execution_id":spec.execution_id,"historical":true})};
    {let db=rusqlite::Connection::open(root.path().join("worker.db")).unwrap();
        db.execute("INSERT INTO executions(execution_id,spec_json,spec_digest,authority_epoch,state,session_locator,progress_limit,created_ms,updated_ms) VALUES(?1,?2,?3,1,'admitted','retained-session',65536,1,1)",params![spec.execution_id,serde_json::to_string(&spec).unwrap(),canonical_digest(&serde_json::to_value(&spec).unwrap()).unwrap()]).unwrap();
        db.execute("INSERT INTO commands(command_id,request_digest,execution_id,state,response_json,created_ms,updated_ms) VALUES(?1,?2,?3,'complete',?4,1,1)",params![command.command_id,canonical_digest(&serde_json::to_value(&command).unwrap()).unwrap(),spec.execution_id,serde_json::to_string(&receipt).unwrap()]).unwrap();
    }
    let mut worker=Supervisor::open(root.path()).unwrap();
    assert_eq!(worker.handle(&command).unwrap(),receipt);
    let inspect=worker.handle(&envelope("inspect-old",json!({"method":"inspect","execution_id":spec.execution_id}))).unwrap();
    assert_eq!(inspect.status,ResponseStatus::Success,"{inspect:?}");assert_eq!(inspect.data["state"],"unknown");
    let db=rusqlite::Connection::open(root.path().join("worker.db")).unwrap();
    assert_eq!(db.query_row("SELECT pid FROM executions WHERE execution_id='old-admitted'",[],|r|r.get::<_,Option<i64>>(0)).unwrap(),None);
    assert_eq!(db.query_row("SELECT COUNT(*) FROM events WHERE kind='process_start'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}

#[tokio::test]
async fn public_host_without_pi_never_falls_back_to_legacy_reasoning() {
    use ghost::{host::Host,control::api::{Action,Command,InputKind}};
    let root=tempfile::tempdir().unwrap();
    let app=Host::open(root.path(),tokio::runtime::Handle::current(),Some("mock")).unwrap();
    let created=app.action(Action{request_id:uuid::Uuid::new_v4().to_string(),command:Command::CreateProfile{name:"retirement-fixture".into(),persona:"Synthetic source retirement fixture".into()}}).unwrap();
    let profile=created["result"]["profile_id"].as_str().unwrap().to_string();
    let create=app.action(Action{request_id:uuid::Uuid::new_v4().to_string(),command:Command::CreateConversation{profile_id:profile.clone(),model:"mock".into(),tools:false}}).unwrap();
    let conversation=create["result"]["conversation_id"].as_str().unwrap().to_string();
    let result=app.action(Action{request_id:uuid::Uuid::new_v4().to_string(),command:Command::Submit{profile_id:profile,conversation_id:conversation,prompt:"Never start a fallback agent".into(),kind:InputKind::Prompt}}).unwrap();
    assert_eq!(result["ok"],false,"{result}");
    assert!(result["error"].as_str().unwrap().contains("pi_execution_prerequisite"),"{result}");
    app.shutdown().await.unwrap();
}

#[test]
fn public_low_level_guest_spawn_is_retired_before_cli_or_filesystem_effects() {
    use ghost::worker::{guest_runtime::{spawn_guest,GuestRuntimeConfig,GuestRuntimeError},guest_broker::{GuestBrokerConfig,GuestModelBackend}};
    use std::sync::Arc;
    let root=tempfile::tempdir().unwrap();let path=root.path();
    let broker=Arc::new(GuestBrokerConfig{version:1,execution_id:"retired-direct-guest".into(),authority_epoch:1,request_directory:path.join("requests"),response_directory:path.join("responses"),journal_path:path.join("broker.sqlite"),backend:GuestModelBackend::LocalHttp{endpoint:"http://127.0.0.1:9/v1".into()},model_id:"fixture/model".into(),model_pin:"fixture/model".into(),max_tokens:64,context_window:1024,allowed_tools:vec![],deadline_ms:1000,max_requests:1});
    let config=GuestRuntimeConfig{container_cli:path.join("never-run-container"),linux_runtime_root:path.join("runtime"),source_directory:path.join("source"),overlay_file:path.join("omp.json"),session_directory:path.join("session"),workspace_directory:path.join("workspace"),home_directory:path.join("home"),control_directory:path.join("control"),skills_snapshot:None,broker};
    assert!(matches!(spawn_guest(config,Arc::new(|_,_|true)),Err(GuestRuntimeError::Retired)));
    assert_eq!(std::fs::read_dir(path).unwrap().count(),0,"No CLI, journal, request pipe or runtime directory may be created");
}

#[test]
fn public_guest_model_broker_is_retired_before_authorization_or_backend_effects() {
    use ghost::worker::{guest_broker::{GuestBrokerConfig,GuestBrokerError,GuestModelBackend,GuestModelBroker},
        subscription_bridge::SubscriptionBridgeConfig};
    use std::sync::{Arc,atomic::{AtomicBool,Ordering}};
    let root=tempfile::tempdir().unwrap();
    let local=GuestModelBackend::LocalHttp {endpoint:"http://127.0.0.1:9/v1".into()};
    let native=GuestModelBackend::SubscriptionNative(Arc::new(SubscriptionBridgeConfig {
        executable:root.path().join("never-run-bun"),entry:root.path().join("never-read-entry.ts"),
        sdk_package_root:root.path().join("never-read-sdk"),auth_file:root.path().join("never-read-auth"),
        home_directory:root.path().join("never-open-home"),
    }));
    for backend in [local,native] {
        let called=Arc::new(AtomicBool::new(false));let authorization_called=Arc::clone(&called);
        let config=Arc::new(GuestBrokerConfig {version:1,execution_id:"retired-broker".into(),authority_epoch:1,
            request_directory:root.path().join("requests"),response_directory:root.path().join("responses"),
            journal_path:root.path().join("broker.sqlite"),backend,model_id:"fixture/model".into(),model_pin:"fixture/model".into(),
            max_tokens:64,context_window:1024,allowed_tools:vec![],deadline_ms:1000,max_requests:1});
        let result=GuestModelBroker::start(config,Arc::new(move|_,_|{authorization_called.store(true,Ordering::SeqCst);true}));
        assert!(matches!(result,Err(GuestBrokerError::Retired)));
        assert!(!called.load(Ordering::SeqCst),"retirement must precede even caller authorization");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(),0,"no spool, journal, native child or runtime files may be created");
    }
}
