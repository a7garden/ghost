// Controlled ledger fixtures test source-reference authority and immutable
// producer projections. They do not claim physical independent verification.
async fn source_contract_fixture(object:bool)->(HostFixture,Work,Value) {
    source_contract_fixture_with_privacy(object,"public").await
}
async fn source_contract_fixture_with_privacy(object:bool,privacy:&str)->(HostFixture,Work,Value) {
    let mut f=host_fixture();
    if privacy!="public" {
        f.host.pi_local_route=Some(host::lifetime_runtime::LocalPiRoute {
            base_url:"http://127.0.0.1:9/v1".into(),model_id:"fixture".into(),max_output_tokens:1024,callback_token:"fixture".into(),
        });
        f.host.native_computers.as_mut().unwrap().pi_fixture_allow_private(&f.ghost).unwrap();
    }
    config(&f.host.lock().unwrap().journal.0);
    let mut body=task_template_body(&f,"arbitrary-source","# VERIFIER_ONLY_WITHHELD_SENTINEL\nexit 0\n");
    if object {
        body["content"]["instructions"]=json!("For each input, count the Unicode characters in its label. Return an object with the count and the unchanged boolean flag. Read the input as data.");
        body["content"]["input_schema"]=json!({"type":"object","required":["label","flag"],"properties":{"label":{"type":"string"},"flag":{"type":"boolean"}},"additionalProperties":false});
        body["content"]["output_schema"]=json!({"type":"object","required":["count","flag"],"properties":{"count":{"type":"integer"},"flag":{"type":"boolean"}},"additionalProperties":false});
        body["content"]["input_contract"]=json!({"kind":"label-and-flag/1"});
        body["content"]["output_contract"]=json!({"kind":"unicode-count-and-flag/1"});
    }
    body["content"]["privacy"]=json!(privacy);
    if privacy!="public" {body["content"]["artifact_path"]=json!("PROTECTED_SOURCE_PATH_SENTINEL.json");body["content"]["input_contract"]=json!({"kind":"PROTECTED_SOURCE_CONTRACT_SENTINEL"});}
    let registered=f.host.lifetime_action(&env("source-register",body)).unwrap();
    assert_eq!(registered["result"]["status"],"success","{registered}");
    let reference=registered["result"]["data"]["template_ref"].clone();
    let input=if object {json!({"label":"INSTANCE_INPUT_WITHHELD_SENTINEL","flag":true})}else{json!({"value":"alpha"})};
    let intake=f.host.lifetime_action(&env("source-input",json!({"method":"conversation.input","ghost_id":f.ghost,"conversation_id":f.conversation,"text":"Perform this source task.","privacy":privacy,"attachments":[],"task_contract":{"template":reference,"mode":"direct","input":input}}))).unwrap();
    assert_eq!(intake["result"]["status"],"success","{intake}");
    let work=if privacy=="public" {task_goal(&f,"source-input","source-goal").await.1}else{
        let descriptor=lifetime::task_contracts::turn_descriptor(&f.host.lock().unwrap().journal.0,"source-input",&f.ghost,&f.conversation).unwrap().unwrap();
        let mut command=env("source-goal",json!({"method":"goal.create","turn_id":"source-input","ghost_id":f.ghost,"conversation_id":f.conversation,"task_contract_ref":descriptor["task_contract_ref"]}));command.actor_ref=f.ghost.clone();
        let created=f.host.lifetime_pi_action(&lifetime::PiToolRequest{context_ref:None,ghost_id:f.ghost.clone(),conversation_id:f.conversation.clone(),envelope:command},lifetime::PiInferenceScope::Local).await.unwrap();
        assert_eq!(created["result"]["status"],"success","{created}");serde_json::from_value(created["result"]["data"]["work"].clone()).unwrap()
    };
    let output=if object {"{\"count\":32,\"flag\":true}"}else{"\"ALPHA\""};
    if privacy=="public" {task_complete_output(&f,&work,output).await;}else{source_complete_protected(&f,&work,output).await;}
    {
        let state=f.host.lock().unwrap();
        let raw:String=state.journal.0.query_row("SELECT payload FROM lifetime_goals WHERE id=?1",[&work.goal_id],|r|r.get(0)).unwrap();
        let goal:crate::lifetime_contract::Goal=serde_json::from_str(&raw).unwrap();
        let (verifier,revision)=policy(&state.journal.0).unwrap();
        let checks=goal.acceptance_spec["required_checks"].as_array().unwrap().iter().map(|id|json!({"id":id,"passed":true,"evidence":"Controlled ledger-fixture independent approval; no native verification claimed"})).collect::<Vec<_>>();
        let command=env("source-independent-accept",json!({"method":"work.accept","acceptance":{"work_id":work.id,"goal_revision":work.goal_revision,"requirement_digest":goal.requirement_digest,"artifact_digest":format!("{:x}",Sha256::digest(output.as_bytes())),"verifier_revision":verifier,"policy_revision":revision,"checks":checks}}));
        let accepted=lifetime::apply(&state.journal.0,&command,"owner").unwrap();
        assert_eq!(accepted.status,ResponseStatus::Success,"{accepted:?}");
    }
    owner_create_turn(&f,"방금 우리가 수행한 작업을 봇으로 만들어줘");
    (f,work,reference)
}
fn source_offer(f:&HostFixture)->Value {
    creation_descriptor(&f.host.lock().unwrap().journal.0,"create-turn",&f.ghost,&f.conversation,1).unwrap().unwrap()
}
fn source_ref_args(offer:&Value)->Value {
    json!({"display_name":"reusable source","purpose":"Apply the accepted procedure to a fresh input","source_contract_ref":offer["source_contract_ref"]})
}
async fn prepare_source(f:&HostFixture,id:&str,args:Value)->Value {
    f.host.lifetime_pi_action(&scoped(f,id,"bot.prepare",args),lifetime::PiInferenceScope::Public).await.unwrap()
}
#[tokio::test]
async fn source_contract_reference_resolves_two_arbitrary_templates_without_instance_or_verifier_copy() {
    for object in [false,true] {
        let (f,work,reference)=source_contract_fixture(object).await;
        let descriptor=source_offer(&f);
        assert_eq!(descriptor["source_contracts"].as_array().unwrap().len(),1);
        let offer=&descriptor["source_contracts"][0];
        assert_eq!(offer["source_work_id"],work.id);
        assert_eq!(offer["template_ref"],reference);
        let public=serde_json::to_string(&descriptor).unwrap();
        assert!(!public.contains("VERIFIER_ONLY_WITHHELD_SENTINEL") && !public.contains("INSTANCE_INPUT_WITHHELD_SENTINEL"));
        let args=source_ref_args(offer);
        let response=prepare_source(&f,"source-prepare",args.clone()).await;
        assert_eq!(response["result"]["status"],"success","{response}");
        let state=f.host.lock().unwrap();
        let candidate=candidate(&state.journal.0,response["result"]["data"]["candidate_id"].as_str().unwrap()).unwrap();
        let pin=candidate.source_contract.as_ref().unwrap();
        assert_eq!(candidate.source_contract_ref.as_deref(),Some(pin.reference.as_str()));
        assert_eq!(candidate.definition.content.input_contract,pin.producer.input_contract);
        assert_eq!(candidate.definition.content.output_contract,pin.producer.output_contract);
        assert_eq!(candidate.assets[0].content,pin.instructions().unwrap());
        assert!(candidate.assets[0].content.contains(if object {"Unicode characters"} else {"ASCII uppercase"}));
        let rendered=render_evaluation_goal(&candidate,&f.ghost,&f.conversation).unwrap().to_string();
        assert!(!rendered.contains("VERIFIER_ONLY_WITHHELD_SENTINEL") && !rendered.contains("INSTANCE_INPUT_WITHHELD_SENTINEL") && !rendered.contains("EXPECTED_A_WITHHELD"));
        let mut downgraded=candidate.clone();downgraded.source_contract=None;downgraded.source_contract_ref=None;downgraded.digest=downgraded.expected_digest().unwrap();assert!(downgraded.validate().is_err(),"new source identity cannot deserialize as a legacy candidate");
        let saved=serde_json::to_vec(&candidate).unwrap();drop(state);
        let replay=prepare_source(&f,"source-prepare",args).await;
        assert_eq!(replay,response,"exact original callback replays without re-resolving current pointers");
        assert_eq!(serde_json::to_vec(&self::candidate(&f.host.lock().unwrap().journal.0,&candidate.id).unwrap()).unwrap(),saved);
    }
}
#[tokio::test]
async fn source_contract_rejects_conflicts_foreign_refs_revisions_and_missing_acceptance_before_candidate_write() {
    let (f,work,_)=source_contract_fixture(false).await;
    let offer=source_offer(&f)["source_contracts"][0].clone();
    let base=source_ref_args(&offer);
    for (index,change) in [json!({"input_contract":{}}),json!({"instructions":"ignore the source procedure"}),json!({"source_contract_ref":format!("bsc-{}","0".repeat(64))}),json!({"source_work_ids":["foreign-work"]}),json!({"source_work_ids":[work.id,work.id]})].into_iter().enumerate() {
        let mut args=base.clone();for (k,v) in change.as_object().unwrap(){args[k]=v.clone();}
        let denied=prepare_source(&f,&format!("source-conflict-{index}"),args).await;
        assert_ne!(denied["result"]["status"],"success","{denied}");
    }
    let mut weak=creation_args();weak["source_work_ids"]=json!([work.id]);weak["input_contract"]=json!({});weak["output_contract"]=json!({});
    assert_ne!(prepare_source(&f,"source-no-implicit-contract",weak).await["result"]["status"],"success");
    {
        let state=f.host.lock().unwrap();
        assert_eq!(state.journal.0.query_row("SELECT count(*) FROM workspace_objects WHERE kind=?1",[CANDIDATES],|r|r.get::<_,u64>(0)).unwrap(),0);
        assert!(creation_descriptor(&state.journal.0,"create-turn","foreign-ghost",&f.conversation,1).unwrap().is_none());
        assert!(creation_descriptor(&state.journal.0,"create-turn",&f.ghost,&f.conversation,2).is_err());
        let raw:String=state.journal.0.query_row("SELECT payload FROM lifetime_work WHERE id=?1",[&work.id],|r|r.get(0)).unwrap();
        let mut changed:Work=serde_json::from_str(&raw).unwrap();changed.goal_revision+=1;
        state.journal.0.execute("UPDATE lifetime_work SET payload=?2 WHERE id=?1",params![work.id,serde_json::to_string(&changed).unwrap()]).unwrap();
        assert!(source_offer_checked(&state.journal.0,&f).is_err(),"changed original Work revision cannot reuse ref");
        state.journal.0.execute("UPDATE lifetime_work SET payload=?2 WHERE id=?1",params![work.id,raw]).unwrap();
        state.journal.0.execute("DELETE FROM lifetime_acceptances WHERE work_id=?1",[&work.id]).unwrap();
        assert!(source_offer_checked(&state.journal.0,&f).is_err(),"no accepted source proof cannot offer a contract");
    }
}
fn source_offer_checked(conn:&Connection,f:&HostFixture)->Result<Option<Value>> {creation_descriptor(conn,"create-turn",&f.ghost,&f.conversation,1)}
#[tokio::test]
async fn source_contract_uses_original_template_revision_after_pointer_changes_and_binds_owner_intent() {
    let (f,_work,old_ref)=source_contract_fixture(false).await;
    let old=source_offer(&f);
    let mut registration=task_template_body(&f,"arbitrary-source",TASK_SCRIPT);
    registration["content"]["instructions"]=json!("A different future procedure selected only for new Owner tasks.");
    let mut update=env("source-register-later",registration);update.expected_revision=Some(1);
    let registered=f.host.lifetime_action(&update).unwrap();
    assert_eq!(registered["result"]["status"],"success","{registered}");
    assert_ne!(registered["result"]["data"]["template_ref"],old_ref);
    assert_eq!(source_offer(&f),old,"latest pointer never substitutes original immutable template");
    let other=f.host.lifetime_action(&env("other-create-turn",json!({"method":"conversation.input","ghost_id":f.ghost,"conversation_id":f.conversation,"text":"방금 우리가 수행한 작업을 봇으로 만들어줘","privacy":"public","attachments":[]}))).unwrap();assert_eq!(other["result"]["status"],"success");
    let mut request=scoped(&f,"source-ref-other-owner-turn","bot.prepare",source_ref_args(&old["source_contracts"][0]));request.envelope.body["turn_id"]=json!("other-create-turn");request.envelope.payload_digest=canonical_digest(&request.envelope.body).unwrap();
    let denied=f.host.lifetime_pi_action(&request,lifetime::PiInferenceScope::Public).await.unwrap();assert_ne!(denied["result"]["status"],"success");
    assert_eq!(prepare_source(&f,"source-prepare-original",source_ref_args(&old["source_contracts"][0])).await["result"]["status"],"success");
}
#[test]
fn source_contract_legacy_candidate_optional_fields_preserve_bytes_and_inline_goal() {
    let dir=tempfile::tempdir().unwrap();let journal=Journal::open(&dir.path().join("workspace.db")).unwrap();
    let mut candidate=prepare_fixture(&journal.0);candidate.evaluation_inputs=None;candidate.digest=candidate.expected_digest().unwrap();
    let bytes=serde_json::to_vec(&candidate).unwrap();
    let decoded:Candidate=serde_json::from_slice(&bytes).unwrap();decoded.validate().unwrap();
    assert_eq!(serde_json::to_vec(&decoded).unwrap(),bytes);
    let value=serde_json::to_value(&decoded).unwrap();for key in ["source_contract_ref","source_contract","evaluation_inputs"] {assert!(value.get(key).is_none());}
    let old=render_evaluation_goal(&decoded,"ghost","conversation").unwrap();
    let mut new=decoded.clone();new.evaluation_inputs=Some(lifetime::evaluation_inputs::pin(&new.evaluation_profile).unwrap());new.digest=new.expected_digest().unwrap();
    let current=render_evaluation_goal(&new,"ghost","conversation").unwrap();
    let inputs=decoded.evaluation_profile.fixtures.iter().map(|f|json!({"id":f.id,"input":f.input,"input_digest":canonical_digest(&f.input).unwrap()})).collect::<Vec<_>>();
    assert!(old["prompt"].as_str().unwrap().ends_with(&format!("Held-out inputs: {}",serde_json::to_string(&inputs).unwrap())));
    assert!(current["prompt"].as_str().unwrap().contains(&new.evaluation_inputs.as_ref().unwrap().path));
    assert!(!current["prompt"].as_str().unwrap().contains("EXPECTED_A_WITHHELD"));
    assert_eq!(render_evaluation_goal(&decoded,"ghost","conversation").unwrap(),old);
}
#[tokio::test]
async fn source_contract_repairs_and_owner_lifecycle_keep_baseline_provenance_and_new_input_pins() {
    let (f,_work,_)=source_contract_fixture(false).await;
    let response=prepare_source(&f,"source-repair-prepare",source_ref_args(&source_offer(&f)["source_contracts"][0])).await;
    assert_eq!(response["result"]["status"],"success","{response}");
    let old=candidate(&f.host.lock().unwrap().journal.0,response["result"]["data"]["candidate_id"].as_str().unwrap()).unwrap();
    let original=serde_json::to_vec(&old).unwrap();
    let evaluated=f.host.lifetime_pi_action(&scoped(&f,"source-repair-evaluate","bot.evaluate",json!({"candidate_id":old.id,"candidate_digest":old.digest})),lifetime::PiInferenceScope::Public).await.unwrap();
    assert_eq!(evaluated["result"]["status"],"success","{evaluated}");
    complete_repair_evaluation(&f,&old,false).await;
    let report=candidate_report(&f,&old);
    let repaired=f.host.lifetime_pi_action(&repair_call(&f,&old,&report,"source-repair-one"),lifetime::PiInferenceScope::Public).await.unwrap();
    assert_eq!(repaired["result"]["status"],"success","{repaired}");
    let new=candidate(&f.host.lock().unwrap().journal.0,repaired["result"]["data"]["candidate_id"].as_str().unwrap()).unwrap();
    assert_eq!(new.source_contract,old.source_contract);assert_eq!(new.source_contract_ref,old.source_contract_ref);
    assert_eq!(new.evaluation_inputs,old.evaluation_inputs);
    assert!(new.assets[0].content.starts_with(&old.assets[0].content));
    assert!(new.assets[0].content.contains("Implementation notes"));
    assert_eq!(new.definition.content.input_contract,old.definition.content.input_contract);
    assert_eq!(new.definition.content.output_contract,old.definition.content.output_contract);
    assert_eq!(serde_json::to_vec(&candidate(&f.host.lock().unwrap().journal.0,&old.id).unwrap()).unwrap(),original);
    for missing in ["source_contract","source_contract_ref"] {
        let mut broken=serde_json::to_value(&new).unwrap();broken.as_object_mut().unwrap().remove(missing);
        let mut broken:Candidate=serde_json::from_value(broken).unwrap();broken.digest=broken.expected_digest().unwrap();assert!(broken.validate().is_err());
    }
    complete_repair_evaluation(&f,&new,true).await;lifecycle_finish_ready(&f,&new).await;
    let mut update=env("source-new-evaluation-profile",json!({"method":"bot.evaluation_profile.configure","fixtures":[{"id":"fresh-one","input":{"value":"one"},"expected_output":"ONE"},{"id":"fresh-two","input":{"value":"two"},"expected_output":"TWO"}]}));update.expected_revision=Some(1);
    let changed=f.host.lifetime_action(&update).unwrap();assert_eq!(changed["result"]["status"],"success","{changed}");
    for (id,clone) in [("source-clone",true),("source-update",false)] {
        let (_,_,next)=lifecycle_prepare(&f,&new,id,clone);
        assert_eq!(next.source_contract,new.source_contract);assert_eq!(next.source_contract_ref,new.source_contract_ref);
        assert_ne!(next.evaluation_inputs,new.evaluation_inputs);
        lifetime::evaluation_inputs::validate_pin(&next.evaluation_profile,next.evaluation_inputs.as_ref().unwrap()).unwrap();
        assert_eq!(next.source_contract.as_ref().unwrap().owner_turn_id,"create-turn");
        assert!(next.intent_turn_id.is_none(),"new lifecycle authority does not impersonate original source intent");
        if clone {assert!(next.source_work_ids.is_empty() && next.source_acceptances.is_empty());}
        assert!(next.assets[0].content.starts_with(&old.assets[0].content));
    }
    assert_eq!(serde_json::to_vec(&candidate(&f.host.lock().unwrap().journal.0,&old.id).unwrap()).unwrap(),original);
}
async fn source_complete_protected(f:&HostFixture,work:&Work,output:&str) {
    let privacy:String=f.host.lock().unwrap().journal.0.query_row("SELECT privacy FROM lifetime_goals WHERE id=?1",[&work.goal_id],|r|r.get(0)).unwrap();
    let assignment:String=f.host.lock().unwrap().journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1",[&work.id],|r|r.get(0)).unwrap();
    for (task,operation,args) in [(10,"write",json!({"path":"PROTECTED_SOURCE_PATH_SENTINEL.json","content":output})),(11,"publish_artifact",json!({"path":"PROTECTED_SOURCE_PATH_SENTINEL.json","privacy":privacy}))] {
        let mut command=env(&format!("protected-source-{operation}"),json!({"method":"work.execute","assignment_id":assignment,"work_id":work.id,"generation_task_id":7,"task_id":task,"call_id":operation,"operation":operation,"input_digest":canonical_digest(&json!({"operation":operation,"arguments":args})).unwrap(),"arguments":args}));command.actor_ref=f.ghost.clone();
        let result=f.host.lifetime_pi_execution_action(&lifetime::PiToolRequest{context_ref:None,ghost_id:f.ghost.clone(),conversation_id:f.conversation.clone(),envelope:command},lifetime::PiInferenceScope::Local).await.unwrap();assert_eq!(result.status,ResponseStatus::Success,"{result:?}");
    }
    let mut command=env("protected-source-complete",json!({"method":"work.execution.complete","assignment_id":assignment,"work_id":work.id,"task_id":7,"summary":"Controlled protected source output"}));command.actor_ref=f.ghost.clone();
    let result=f.host.lifetime_pi_execution_action(&lifetime::PiToolRequest{context_ref:None,ghost_id:f.ghost.clone(),conversation_id:f.conversation.clone(),envelope:command},lifetime::PiInferenceScope::Local).await.unwrap();assert_eq!(result.status,ResponseStatus::Success,"{result:?}");
}
#[tokio::test]
async fn source_contract_turn_inspection_enforces_private_and_local_only_disclosure_before_projection() {
    for privacy in ["private","local_only"] {
        let (f,_,_)=source_contract_fixture_with_privacy(false,privacy).await;
        for (name,scope,allowed) in [("public",lifetime::PiInferenceScope::Public,false),("selected-without-consent",lifetime::PiInferenceScope::Selected,false),("local",lifetime::PiInferenceScope::Local,true)] {
            let mut command=env(&format!("protected-inspect-{name}"),json!({"method":"conversation.turn.inspect","turn_id":"create-turn","ghost_id":f.ghost,"conversation_id":f.conversation}));command.actor_ref=f.ghost.clone();
            let response=f.host.lifetime_pi_action(&lifetime::PiToolRequest{context_ref:None,ghost_id:f.ghost.clone(),conversation_id:f.conversation.clone(),envelope:command},scope).await.unwrap();
            assert_eq!(response["result"]["status"]=="success",allowed,"{privacy}/{name}: {response}");
            let bytes=response.to_string();
            if allowed {
                assert_eq!(response["result"]["data"]["bot_creation"]["source_contracts"].as_array().unwrap().len(),1);
                assert!(bytes.contains("PROTECTED_SOURCE_CONTRACT_SENTINEL") && bytes.contains("PROTECTED_SOURCE_PATH_SENTINEL"));
                assert!(!bytes.contains("VERIFIER_ONLY_WITHHELD_SENTINEL"));
            }else {
                assert_eq!(response["result"]["error_code"],"disclosure_blocked");
                assert!(!bytes.contains("PROTECTED_SOURCE_CONTRACT_SENTINEL") && !bytes.contains("PROTECTED_SOURCE_PATH_SENTINEL") && !bytes.contains("bsc-"));
            }
        }
    }
}
#[tokio::test]
async fn source_contract_scalar_and_legacy_array_resolve_identically_without_coercion() {
    let (f,work,_)=source_contract_fixture(false).await;
    let offer=source_offer(&f)["source_contracts"][0].clone();let scalar=source_ref_args(&offer);
    let state=f.host.lock().unwrap();
    let intent=live_creation_intent(&state.journal.0,"create-turn",&f.ghost,&f.conversation,1).unwrap();
    let resolved=source_contracts::normalize(&state.journal.0,&intent,&scalar).unwrap();
    assert_eq!(resolved.0["source_work_ids"],json!([work.id]));
    let mut legacy=scalar.clone();legacy["source_work_ids"]=json!([work.id]);
    assert_eq!(source_contracts::normalize(&state.journal.0,&intent,&legacy).unwrap(),resolved);
    for bad in [json!(format!("[\"{}\"]",work.id)),Value::Null,json!([]),json!(["foreign-work"]),json!([work.id,work.id])] {
        let mut malformed=scalar.clone();malformed["source_work_ids"]=bad;
        assert!(source_contracts::normalize(&state.journal.0,&intent,&malformed).is_err());
    }
    let mut missing=scalar.clone();missing.as_object_mut().unwrap().remove("source_contract_ref");
    assert!(source_contracts::normalize(&state.journal.0,&intent,&missing).is_err());
    assert_eq!(state.journal.0.query_row("SELECT count(*) FROM workspace_objects WHERE kind=?1",[CANDIDATES],|r|r.get::<_,u64>(0)).unwrap(),0);
}

#[tokio::test]
async fn source_creation_fulfillment_requires_exact_armed_evaluation_and_preserves_historical_answers() {
    async fn invoke(f:&HostFixture,id:&str,body:Value)->Value {
        let mut command=env(id,body);command.actor_ref=f.ghost.clone();
        f.host.lifetime_pi_action(&lifetime::PiToolRequest{context_ref:None,ghost_id:f.ghost.clone(),conversation_id:f.conversation.clone(),envelope:command},lifetime::PiInferenceScope::Public).await.unwrap()
    }
    let (f,_,_)=source_contract_fixture(false).await;
    assert_eq!(source_offer(&f)["fulfillment"]["state"],"unprepared");
    let prepared=prepare_source(&f,"fulfillment-prepare",source_ref_args(&source_offer(&f)["source_contracts"][0])).await;
    let candidate=prepared["result"]["data"]["candidate_id"].as_str().unwrap();
    let digest=prepared["result"]["data"]["candidate_digest"].as_str().unwrap();
    let draft=source_offer(&f)["fulfillment"].clone();
    assert_eq!(draft["candidate_id"],candidate);assert_eq!(draft["candidate_digest"],digest);
    assert_eq!(draft["state"],"draft");assert_eq!(draft["next_action"],"evaluate");
    let status=json!({"method":"conversation.turn_status","ghost_id":f.ghost,"conversation_id":f.conversation,"turn_id":"create-turn","status":"answered","submission_id":"sdk-original","entry_id":"answer-original","reason_code":null});
    let reply=json!({"method":"conversation.reply","ghost_id":f.ghost,"conversation_id":f.conversation,"turn_id":"create-turn","text":"Independent evaluation is pending."});
    let mut running=status.clone();running["status"]=json!("running");running["entry_id"]=Value::Null;
    assert_eq!(invoke(&f,"fulfillment-running",running).await["result"]["status"],"success");
    assert_eq!(invoke(&f,"draft-answer",status.clone()).await["result"]["error_code"],"bot_creation_incomplete");
    assert_eq!(invoke(&f,"draft-reply",reply.clone()).await["result"]["error_code"],"bot_creation_incomplete");
    let evaluated=f.host.lifetime_pi_action(&scoped(&f,"fulfillment-evaluate","bot.evaluate",json!({"candidate_id":candidate,"candidate_digest":digest})),lifetime::PiInferenceScope::Public).await.unwrap();
    assert_eq!(evaluated["result"]["status"],"success","{evaluated}");
    let pending=source_offer(&f)["fulfillment"].clone();assert_eq!(pending["state"],"evaluating");
    assert_eq!(pending["activation_requested"],true);assert!(pending["evaluation_work_id"].is_string());assert_eq!(pending["next_action"],Value::Null);
    {
        let state=f.host.lock().unwrap();let conn=&state.journal.0;
        let original:String=conn.query_row("SELECT text FROM lifetime_turns WHERE id='create-turn'",[],|r|r.get(0)).unwrap();
        conn.execute("UPDATE lifetime_turns SET text='Prepare only a draft' WHERE id='create-turn'",[]).unwrap();
        assert!(creation_reply_admitted(conn,"create-turn",&f.ghost,&f.conversation).is_err(),"armed state cannot authorize a changed Owner source");
        conn.execute("UPDATE lifetime_turns SET text=?1 WHERE id='create-turn'",[original]).unwrap();
        conn.execute("UPDATE lifetime_turn_runs SET state='effect_unknown',reason_code='effect_unconfirmed' WHERE turn_id='create-turn'",[]).unwrap();
        assert!(creation_reply_admitted(conn,"create-turn",&f.ghost,&f.conversation).unwrap(),"read-only terminal reconciliation can prove the existing exact admission");
        assert!(live_creation_intent(conn,"create-turn",&f.ghost,&f.conversation,1).is_err(),"effect_unknown never restores mutation authority");
    }
    assert_eq!(invoke(&f,"armed-answer",status.clone()).await["result"]["status"],"success");
    assert_eq!(invoke(&f,"armed-reply",reply.clone()).await["result"]["status"],"success");
    {
        let state=f.host.lock().unwrap();let conn=&state.journal.0;
        // Historical answered receipts are never reclassified by later progress.
        let mut p=progress(conn,candidate).unwrap();p.state="draft".into();save(conn,PROGRESS,candidate,&p).unwrap();
        assert!(creation_reply_admitted(conn,"create-turn",&f.ghost,&f.conversation).unwrap());
    }
    assert_eq!(invoke(&f,"armed-answer",status).await["result"]["status"],"success");
}
