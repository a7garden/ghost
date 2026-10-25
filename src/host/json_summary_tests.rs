// Included in provisioning tests to exercise real Host scope, effect ledger,
// original task contracts and verified evaluation origins with simulated files.
#[tokio::test]
async fn json_summary_owner_schema_is_original_root_scoped_and_never_echoes_instance_or_verifier() {
    let f=host_fixture();
    let mut registration=task_template_body(&f,"json-inspection","# HIDDEN_VERIFIER_SENTINEL\nexit 0\n");
    registration["content"]["output_schema"]=json!({"$defs":{"answer":{"type":"string","enum":["HIDDEN_SCHEMA_ENUM_SENTINEL"]}},"$ref":"#/$defs/answer"});
    let registered=f.host.lifetime_action(&env("json-summary-register",registration.clone())).unwrap();assert_eq!(registered["result"]["status"],"success","{registered}");
    assert_eq!(task_input(&f,"json-summary-input",registered["result"]["data"]["template_ref"].clone(),"direct",json!({"value":"alpha"}))["result"]["status"],"success");
    let (_,work)=task_goal(&f,"json-summary-input","json-summary-goal").await;
    let content="\"HIDDEN_INSTANCE_VALUE_SENTINEL\"";
    assert_eq!(task_execute(&f,&work,"json-summary-write",10,"write",json!({"path":"answer.json","content":content})).await.status,ResponseStatus::Success);
    let invalid=task_execute(&f,&work,"json-summary-invalid",11,"read",json!({"path":"answer.json","view":"json_summary"})).await;
    assert_eq!(invalid.status,ResponseStatus::Error);assert_eq!(invalid.error_code.as_deref(),Some("json_contract_invalid"));
    assert_eq!(invalid.data["receipt"]["state"],"complete");assert_eq!(invalid.data["output"]["parse"]["status"],"complete");assert_eq!(invalid.data["output"]["schema"]["status"],"invalid");
    for secret in ["HIDDEN_INSTANCE_VALUE_SENTINEL","HIDDEN_SCHEMA_ENUM_SENTINEL","HIDDEN_VERIFIER_SENTINEL"] {assert!(!serde_json::to_string(&invalid).unwrap().contains(secret));}
    assert_eq!(task_execute(&f,&work,"json-summary-fix",12,"write",json!({"path":"answer.json","content":"\"HIDDEN_SCHEMA_ENUM_SENTINEL\""})).await.status,ResponseStatus::Success,"known invalid read must not fence correction as an unknown mutation");
    let valid=task_execute(&f,&work,"json-summary-valid",13,"read",json!({"path":"answer.json","view":"json_summary"})).await;
    assert_eq!(valid.status,ResponseStatus::Success);assert_eq!(valid.data["output"]["schema"]["status"],"valid");assert_eq!(valid.data["output"]["semantic_correctness"],"not_checked");
    assert!(!valid.data["output"].to_string().contains("HIDDEN_SCHEMA_ENUM_SENTINEL"));
    registration["content"]["output_schema"]=json!({"type":"boolean"});let mut update=env("json-summary-register-new",registration);update.expected_revision=Some(1);
    assert_eq!(f.host.lifetime_action(&update).unwrap()["result"]["status"],"success");
    let after=task_execute(&f,&work,"json-summary-original-template",14,"read",json!({"path":"answer.json","view":"json_summary"})).await;
    assert_eq!(after.data["output"]["schema"],valid.data["output"]["schema"],"active pointer does not substitute the original output schema");
    task_execute(&f,&work,"json-summary-other-write",15,"write",json!({"path":"other.json","content":"true"})).await;
    let other=task_execute(&f,&work,"json-summary-other",16,"read",json!({"path":"other.json","view":"json_summary"})).await;
    assert_eq!(other.data["output"]["schema"]["status"],"unavailable");assert_eq!(other.data["output"]["schema"]["source"],"path_not_declared_output");
    let state=f.host.lock().unwrap();assert_eq!(state.journal.0.query_row("SELECT count(*) FROM lifetime_acceptances",[],|r|r.get::<_,u64>(0)).unwrap(),0);
    assert_eq!(state.journal.0.query_row("SELECT state FROM lifetime_work WHERE id=?1",[work.id],|r|r.get::<_,String>(0)).unwrap(),"running");
}

#[tokio::test]
async fn json_summary_full_parse_known_failure_and_raw_read_replay_preserve_effect_authority() {
    use super::super::lifetime::pi_execution::tests as pi;
    let f=pi::setup_with_spec(json!({"required_checks":[]}));
    async fn run(f:&pi::Fixture,id:u64,call:&str,op:&str,args:Value)->Response {f.host.lifetime_pi_execution_action(&pi::request(f,id,call,op,args),lifetime::PiInferenceScope::Public).await.unwrap()}
    let content=format!("{{}}{}PRIVATE_TRAILING_SENTINEL","\n".repeat(2001));
    assert_eq!(run(&f,10,"summary-write","write",json!({"path":"answer.json","content":content})).await.status,ResponseStatus::Success);
    let raw=run(&f,11,"raw-prefix","read",json!({"path":"answer.json","limit":1})).await;assert_eq!(raw.data["output"]["content"],"{}");
    let whole=run(&f,12,"full-parse","read",json!({"path":"answer.json","view":"json_summary"})).await;
    assert_eq!(whole.status,ResponseStatus::Error);assert_eq!(whole.error_code.as_deref(),Some("json_parse_invalid"));assert_eq!(whole.data["receipt"]["state"],"complete");
    assert!(whole.data["output"]["parse"]["line"].as_u64().unwrap()>2000);assert!(!whole.data["output"].to_string().contains("PRIVATE_TRAILING_SENTINEL"));
    let mixed=run(&f,13,"mixed-view","read",json!({"path":"answer.json","view":"json_summary","limit":1})).await;assert_eq!(mixed.data["receipt"]["state"],"denied");
    assert_eq!(run(&f,14,"summary-correction","write",json!({"path":"answer.json","content":"{\"label\":\"한글 🐈\"}\r\n"})).await.status,ResponseStatus::Success);
    let raw_again=run(&f,11,"raw-prefix","read",json!({"path":"answer.json","limit":1})).await;assert_eq!(serde_json::to_vec(&raw_again).unwrap(),serde_json::to_vec(&raw).unwrap(),"old raw receipt is exact, not regenerated after file change");
    let replay=run(&f,12,"full-parse","read",json!({"path":"answer.json","view":"json_summary"})).await;assert_eq!(serde_json::to_vec(&replay).unwrap(),serde_json::to_vec(&whole).unwrap());
    let corrected=run(&f,15,"fresh-summary","read",json!({"path":"answer.json","view":"json_summary"})).await;assert_eq!(corrected.data["output"]["parse"]["status"],"complete");assert_eq!(corrected.data["output"]["full_file_bytes"],"{\"label\":\"한글 🐈\"}\r\n".len());
    let actual_raw=run(&f,16,"fresh-raw","read",json!({"path":"answer.json"})).await;assert_eq!(actual_raw.data["output"]["content"],"{\"label\":\"한글 🐈\"}");
    let mut foreign=pi::request(&f,17,"foreign-summary","read",json!({"path":"answer.json","view":"json_summary"}));foreign.ghost_id="foreign-ghost".into();
    let foreign=f.host.lifetime_pi_execution_action(&foreign,lifetime::PiInferenceScope::Public).await.unwrap();assert_eq!(foreign.status,ResponseStatus::Error);assert!(!foreign.data.to_string().contains("full_file_sha256"));
    let cancel=f.host.lifetime_action(&env("summary-cancel-original",json!({"method":"work.cancel","work_id":f.work}))).unwrap();assert_eq!(cancel["result"]["status"],"success","{cancel}");
    let cancelled=f.host.lifetime_pi_execution_action(&pi::request(&f,18,"cancelled-summary","read",json!({"path":"answer.json","view":"json_summary"})),lifetime::PiInferenceScope::Public).await.unwrap_err();
    assert!(cancelled.to_string().contains("Goal assignment Work is no longer current, uncancelled, and admissible"),"{cancelled}");
}

#[tokio::test]
async fn json_summary_verified_evaluation_checks_safe_identity_and_original_output_schema_without_expected_answers() {
    let (f,_,_)=source_contract_fixture(false).await;
    let prepared=prepare_source(&f,"summary-source-prepare",source_ref_args(&source_offer(&f)["source_contracts"][0])).await;
    let c=candidate(&f.host.lock().unwrap().journal.0,prepared["result"]["data"]["candidate_id"].as_str().unwrap()).unwrap();
    let evaluated=f.host.lifetime_pi_action(&scoped(&f,"summary-source-evaluate","bot.evaluate",json!({"candidate_id":c.id,"candidate_digest":c.digest})),lifetime::PiInferenceScope::Public).await.unwrap();assert_eq!(evaluated["result"]["status"],"success","{evaluated}");
    let work:Work=serde_json::from_value(evaluated["result"]["data"]["work"].clone()).unwrap();
    let mut output=json!({"candidate_digest":c.digest,"cases":c.evaluation_profile.fixtures.iter().map(|fixture|json!({"id":fixture.id,"input_digest":canonical_digest(&fixture.input).unwrap(),"output":"ALPHA"})).collect::<Vec<_>>()});
    assert_eq!(task_execute(&f,&work,"summary-eval-write",10,"write",json!({"path":"bot-evaluation.json","content":output.to_string()})).await.status,ResponseStatus::Success);
    let checked=task_execute(&f,&work,"summary-eval-read",11,"read",json!({"path":"bot-evaluation.json","view":"json_summary"})).await;
    assert_eq!(checked.status,ResponseStatus::Success,"{checked:?}");assert_eq!(checked.data["output"]["schema"]["status"],"valid");assert_eq!(checked.data["output"]["schema"]["identities_valid"],true);
    for secret in ["EXPECTED_A_WITHHELD","EXPECTED_B_WITHHELD","VERIFIER_ONLY_WITHHELD_SENTINEL","ALPHA"] {assert!(!checked.data["output"].to_string().contains(secret));}
    assert_eq!(checked.data["output"]["semantic_correctness"],"not_checked","structurally valid output need not equal hidden expected results");
    output["candidate_digest"]=json!("f".repeat(64));output["cases"][1]["input_digest"]=json!("0".repeat(64));
    task_execute(&f,&work,"summary-eval-wrong-write",12,"write",json!({"path":"bot-evaluation.json","content":output.to_string()})).await;
    let wrong=task_execute(&f,&work,"summary-eval-wrong-read",13,"read",json!({"path":"bot-evaluation.json","view":"json_summary"})).await;
    assert_eq!(wrong.status,ResponseStatus::Error);assert_eq!(wrong.data["output"]["schema"]["identities_valid"],false);assert_eq!(wrong.data["receipt"]["state"],"complete");
    // A changed file does not regenerate the original read result. Existing
    // assignment/origin authority still precedes all receipt delivery.
    let replay=task_execute(&f,&work,"summary-eval-read",11,"read",json!({"path":"bot-evaluation.json","view":"json_summary"})).await;
    assert_eq!(serde_json::to_vec(&replay).unwrap(),serde_json::to_vec(&checked).unwrap());
    let (original,receipt_bytes)={let state=f.host.lock().unwrap();
        let p=progress(&state.journal.0,&c.id).unwrap();let mut bad=p.clone();bad.evaluation_work_id=Some("foreign-work".into());
        let receipt:String=state.journal.0.query_row("SELECT response_json FROM lifetime_pi_effects WHERE execution_id=(SELECT execution_id FROM lifetime_pi_executions WHERE work_id=?1) AND task_id=11 AND call_id='summary-eval-read'",[&work.id],|r|r.get(0)).unwrap();
        save(&state.journal.0,PROGRESS,&c.id,&bad).unwrap();(p,receipt)};
    for (id,task) in [("summary-eval-stale",14),("summary-eval-read",11)] {
        let args=json!({"path":"bot-evaluation.json","view":"json_summary"});
        let assignment:String=f.host.lock().unwrap().journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1",[&work.id],|r|r.get(0)).unwrap();
        let mut envelope=env(id,json!({"method":"work.execute","assignment_id":assignment,"work_id":work.id,"generation_task_id":7,"task_id":task,"call_id":id,"operation":"read","input_digest":canonical_digest(&json!({"operation":"read","arguments":args})).unwrap(),"arguments":args}));envelope.actor_ref=work.owner.clone();
        let refused=f.host.lifetime_pi_execution_action(&lifetime::PiToolRequest{context_ref:None,ghost_id:work.owner.clone(),conversation_id:f.conversation.clone(),envelope},lifetime::PiInferenceScope::Public).await.unwrap_err();
        assert!(refused.to_string().contains("evaluation source receipt identity mismatch"),"{refused}");
    }
    {let state=f.host.lock().unwrap();
        let retained:String=state.journal.0.query_row("SELECT response_json FROM lifetime_pi_effects WHERE execution_id=(SELECT execution_id FROM lifetime_pi_executions WHERE work_id=?1) AND task_id=11 AND call_id='summary-eval-read'",[&work.id],|r|r.get(0)).unwrap();assert_eq!(retained,receipt_bytes);
        assert_eq!(state.journal.0.query_row("SELECT count(*) FROM lifetime_pi_effects WHERE execution_id=(SELECT execution_id FROM lifetime_pi_executions WHERE work_id=?1) AND task_id=14",[&work.id],|r|r.get::<_,u64>(0)).unwrap(),0,"invalid origin cannot admit new file I/O");
        save(&state.journal.0,PROGRESS,&c.id,&original).unwrap();
        assert_eq!(state.journal.0.query_row("SELECT count(*) FROM lifetime_acceptances WHERE work_id=?1",[&work.id],|r|r.get::<_,u64>(0)).unwrap(),0);}
    let restored=task_execute(&f,&work,"summary-eval-read",11,"read",json!({"path":"bot-evaluation.json","view":"json_summary"})).await;
    assert_eq!(serde_json::to_vec(&restored).unwrap(),serde_json::to_vec(&checked).unwrap());
}
