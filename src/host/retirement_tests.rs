//! Source retirement checks; never use installed services or credentials.
use super::*;
use crate::durable::durable::{ai,Host as ToolHost,Task,TaskKind,Phase,ToolPlan};

#[tokio::test]
async fn pi_mode_never_starts_the_separate_profile_runtime_or_scheduler() {
    let fixture=lifetime::pi_execution::tests::setup_with_spec(json!({}));
    let app=Arc::new(fixture.host);
    let runtime=app.lock().unwrap().profiles[&fixture.ghost].runtime.clone();
    app.start_worker(fixture.ghost,runtime,1);
    assert!(app.workers.lock().unwrap().is_empty());
    assert!(app.profile_workers.lock().unwrap().is_empty());
}
#[tokio::test]
async fn retired_agent_tools_reject_prepare_and_direct_dispatch_without_host_or_spawn() {
    let bridge=services::Bridge{owner:"retired-fixture".into(),host:std::sync::Weak::new()};
    for name in ["worker_analyze","code_worker"] {
        let call=ai::ToolCall::new("retired-call",name,json!({"prompt":"fixture","project":"fixture"}));
        let task=Task{id:"fixture-task".into(),ordinal:1,conversation_id:"fixture-conversation".into(),parent_id:None,background:false,phase:Phase::Tools,kind:TaskKind::Tool{call:call.clone(),plan:None,child:None},output:None,usage:Default::default(),not_before_ms:0};
        assert!(bridge.prepare(&task,&call).unwrap_err().to_string().contains("legacy_execution_retired"));
        let plan=ToolPlan{effect_key:"forged-retired-plan".into(),replay_safe:false};
        assert!(bridge.execute(&task,&call,&plan).await.unwrap_err().to_string().contains("legacy_execution_retired"));
    }
    let fixture=lifetime::pi_execution::tests::setup_with_spec(json!({}));
    for role in [services::ToolRole::Ordinary,services::ToolRole::DurableWork,services::ToolRole::AssignedDelegation] {
        assert!(!services::role_tool_definitions(&fixture.host,role).iter().any(|tool|matches!(tool.name.as_str(),"worker_analyze"|"code_worker")));
    }
}
#[test]
fn retired_omp_provider_and_service_spec_have_no_inference_or_worker_configuration_path() {
    for provider in ["minimax-code","zai"] {
        assert!(omp_provider::create(provider).err().unwrap().to_string().contains("legacy_inference_retired"));
        assert!(omp_provider::probe(provider).err().unwrap().to_string().contains("legacy_inference_retired"));
    }
    let no_omp=operations::service_spec_with_tools(std::path::Path::new("/tmp/pi-source-fixture"),std::path::Path::new("/tmp/pi-source-fixture/ghost"),62062,"mock","launchd",true,None,None,None).unwrap();
    assert!(!no_omp.contains("GHOST_OMP"));
    assert!(operations::service_spec_with_tools(std::path::Path::new("/tmp/pi-source-fixture"),std::path::Path::new("/tmp/pi-source-fixture/ghost"),62062,"mock","launchd",true,None,Some(std::path::Path::new("/tmp/retired-omp")),Some("minimax-code/fixture")).unwrap_err().to_string().contains("legacy_execution_retired"));
}

#[tokio::test]
async fn ordinary_host_legacy_submit_is_unavailable_without_explicit_fixture_mode() {
    let fixture=lifetime::pi_execution::tests::setup_with_spec(json!({}));
    let app=Arc::new(fixture.host);
    let mut state=app.lock().unwrap();
    let result=app.apply(&mut state,"legacy-submit",Command::Submit{profile_id:fixture.ghost,conversation_id:"unused-legacy-conversation".into(),prompt:"do not start another agent".into(),kind:host::durable::InputKind::Prompt});
    assert!(result.unwrap_err().to_string().contains("pi_execution_prerequisite"));
    assert!(app.workers.lock().unwrap().is_empty());
}
