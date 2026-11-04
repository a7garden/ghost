use super::*;
use crate::host::lifetime::pi_execution::tests as pi;

fn capability(owner: &str) -> engine::PublicationCapability {
    engine::PublicationCapability { id: "publish-to-common".into(), ghost_id: owner.into(), origin_space: "own".into(), destination_space: "common".into(), origin_token_env: "TEST_PUBLICATION_ORIGIN".into(), destination_token_env: "TEST_PUBLICATION_DESTINATION".into(), policy_revision: 1 }
}
fn intent(owner: &str, conversation: &str, id: &str) -> Intent {
    Intent { id:id.into(), owner:owner.into(), conversation:conversation.into(), capability_id:"publish-to-common".into(), capability:capability(owner), source:Source::Episode{episode_id:"private-episode".into(),source_sha256:"a".repeat(64)}, source_ref:"opaque-source".into(),bytes:"selected view".into(),start:0,end:13,created_ms:1,dispatch_epoch:1,revision:1,generation:1,operation:"publish".into(),state:"confirmed".into(),attempts:1,next_attempt_ms:0,authorization:None,request:None,receipt:Some(json!({"publication_id":id,"view_revision":"b".repeat(64)})) }
}

#[test]
fn source_handles_do_not_disclose_origin_locator_or_owner() {
    let reference=source_ref("owner","private-owner:private-locator:source").unwrap();
    assert!(reference.starts_with("source-"));
    assert!(!reference.contains("private"));
    assert_ne!(reference,source_ref("owner","different-source").unwrap());
}
#[test]
fn owner_source_handles_bind_revision_episode_and_digest_and_exclude_redacted_rows() {
    let original=json!({"origin":{"source_id":"private-source","revision":"1","content_sha256":"a".repeat(64)},"receipt":{"status":"recorded","episode_id":"original-episode"}});
    let first=owner_source(&original).unwrap().unwrap().0;
    for (field,value) in [("revision",json!("2")),("content_sha256",json!("b".repeat(64)))] {
        let mut corrected=original.clone();corrected["origin"][field]=value;
        assert_ne!(owner_source(&corrected).unwrap().unwrap().0,first);
    }
    let mut corrected=original.clone();corrected["receipt"]["episode_id"]=json!("replacement-episode");
    assert_ne!(owner_source(&corrected).unwrap().unwrap().0,first);
    corrected["redaction_state"]=json!("complete");assert!(owner_source(&corrected).unwrap().is_some(),"standing corrected source remains active");
    corrected["receipt"]["status"]=json!("redacted");assert!(owner_source(&corrected).unwrap().is_none());
}
#[test]
fn every_source_handle_binds_actual_variant_identity_revision_and_locator() {
    let publication=Source::Publication{publication_id:"view".into(),revision:"a".repeat(64)};
    let edited=Source::Publication{publication_id:"view".into(),revision:"b".repeat(64)};
    for kind in ["publication","reference"] {assert_ne!(exact_source_ref(kind,"same-Host-id",&publication).unwrap(),exact_source_ref(kind,"same-Host-id",&edited).unwrap());}
    let document=Source::Document{document_uuid:"canonical-uuid".into(),raw_sha256:"a".repeat(64),path:"/private/root/a.md".into()};
    let edited=Source::Document{document_uuid:"canonical-uuid".into(),raw_sha256:"b".repeat(64),path:"/private/root/a.md".into()};
    let moved=Source::Document{document_uuid:"canonical-uuid".into(),raw_sha256:"a".repeat(64),path:"/private/root/b.md".into()};
    let original=exact_source_ref("experience","same-experience",&document).unwrap();
    assert_ne!(original,exact_source_ref("experience","same-experience",&edited).unwrap());assert_ne!(original,exact_source_ref("experience","same-experience",&moved).unwrap());assert!(!original.contains("private"));
}

#[tokio::test]
async fn foreign_private_publications_do_not_enumerate_or_exhaust_local_limit() {
    let f=pi::setup_with_spec(pi::verifier_spec("expected"));
    let state=f.host.lock().unwrap();let conn=&state.journal.0;
    for n in 0..70 {let id=format!("foreign-private-{n}");put(conn,INTENTS,&id,&intent("foreign-ghost","foreign-conversation",&id)).unwrap();}
    let own=intent(&f.ghost,&f.conversation,"own-publication");put(conn,INTENTS,&own.id,&own).unwrap();
    let elsewhere=intent(&f.ghost,"another-conversation","other-publication");put(conn,INTENTS,&elsewhere.id,&elsewhere).unwrap();
    let sources=own_publication_sources(conn,&f.ghost,&f.conversation).unwrap();
    assert_eq!(sources.len(),1);
    assert!(matches!(&sources[0].1,Source::Publication{publication_id,..} if publication_id=="own-publication"));
    assert!(!serde_json::to_string(&sources).unwrap().contains("foreign"));
}

#[tokio::test]
async fn publication_owner_rejects_forged_conversation_before_source_discovery() {
    let f=pi::setup_with_spec(pi::verifier_spec("expected"));
    for method in ["memory.publication.sources","memory.publication.prepare"] {
        let envelope=pi::envelope("owner",json!({"method":method,"ghost_id":f.ghost,"conversation_id":"forged-private-conversation"}));
        let error=f.host.memory_publication_owner(&envelope).unwrap_err();
        assert!(error.to_string().contains("not registered"));
        assert!(!error.to_string().contains("foreign-private"));
    }
}

#[tokio::test]
async fn shared_only_source_discovery_skips_absent_own_mapping_but_preserves_mapped_errors() {
    let f=pi::setup_with_spec(pi::verifier_spec("expected"));
    let (_, _env, _, _)=crate::adapters::memory::tests::scoped_fixture(f._root.path(),&f.ghost).await;
    {let state=f.host.lock().unwrap();state.journal.put("policy",&f.ghost,&Policy{memory:true,..Default::default()}).unwrap();let entry=intent(&f.ghost,&f.conversation,"own-confirmed-view");put(&state.journal.0,INTENTS,&entry.id,&entry).unwrap();}
    let map=std::env::var_os("GHOST_BRAIN_SPACE_MAP").unwrap();
    std::fs::write(&map,b"{}").unwrap();
    // Broken personal ledger proves the absent-mapping branch does not open it.
    std::fs::write(std::env::var_os("GHOST_BRAIN_SOURCE_LEDGER").unwrap(),b"not a SQLite database").unwrap();
    let request=pi::envelope("owner",json!({"method":"memory.publication.sources","ghost_id":f.ghost,"conversation_id":f.conversation}));
    assert_eq!(f.host.memory_publication_owner(&request).unwrap()["result"]["data"]["sources"].as_array().unwrap().len(),1);
    std::fs::write(map,serde_json::to_vec(&json!({&f.ghost:"fixture-space"})).unwrap()).unwrap();
    let mapped=pi::envelope("owner",json!({"method":"memory.publication.sources","ghost_id":f.ghost,"conversation_id":f.conversation}));
    assert!(f.host.memory_publication_owner(&mapped).is_err(),"a mapped personal source error must remain visible");
}

#[tokio::test]
async fn missing_child_grant_blocks_empty_parent_dependencies_and_all_consumers() {
    let f=pi::setup_with_spec(pi::verifier_spec("expected"));
    let request=pi::request(&f,12,"blocked-effect","write",json!({"path":"answer.txt","content":"unsafe"}));
    {
        let state=f.host.lock().unwrap();let conn=&state.journal.0;
        let parent=work(conn,&f.work).unwrap();let mut child=parent.clone();child.id="child-work".into();
        let reference=Reference{reference:"child-reference".into(),publication_id:"private-source-view".into(),view_revision:"c".repeat(64),space:"common".into(),binding_id:"child-only".into(),profile:crate::adapters::memory_bindings::WorkMemoryProfile{configuration_revision:"d".repeat(64),bindings:vec![]}};
        put(conn,DEPENDENCIES,&work_key(&child),&Dependencies{references:vec![reference],blocked:false}).unwrap();
        absorb_child_dependencies(conn,&child,&parent).unwrap();
        let deps:Dependencies=load(conn,DEPENDENCIES,&work_key(&parent)).unwrap().unwrap();
        assert!(deps.blocked);assert!(deps.references.is_empty());
        assert!(has_work_dependencies(conn,&parent).unwrap());assert!(has_work_references(conn,&parent).unwrap());
        assert_eq!(assignment_view(conn,&parent).unwrap()["required"],true);
        assert_eq!(experience_dependencies(conn,&parent).unwrap(),vec![json!({"blocked":true})]);
        scope_locked(&state,&request).unwrap();
        assert!(current_locked(&state,&request,PiInferenceScope::Local).is_err());
        assert!(validate_delegation_target(conn,&parent,"another-target").is_err());
        assert!(child_dependencies(conn,&parent,&child).is_err());
        assert!(f.host.publication_effect_current(&state,&request,PiInferenceScope::Local).unwrap().is_some());
    }
    let response=f.host.publication_effect_guard(&request,PiInferenceScope::Local).await.unwrap().unwrap();
    assert_eq!(response.error_code.as_deref(),Some("publication_context_unavailable"));
}

#[tokio::test]
async fn verification_stamp_cannot_bless_dependencies_added_after_fresh_guard() {
    let mut f=pi::setup_with_spec(pi::verifier_spec("expected"));
    let (_, _env, _, _)=crate::adapters::memory::tests::scoped_fixture(f._root.path(),&f.ghost).await;
    f.host.pi_local_route=Some(crate::host::lifetime_runtime::LocalPiRoute{base_url:"http://127.0.0.1:9/v1".into(),model_id:"fixture".into(),max_output_tokens:1024,callback_token:"fixture".into()});
    let actual={let state=f.host.lock().unwrap();state.journal.put("policy",&f.ghost,&Policy{memory:true,..Default::default()}).unwrap();work(&state.journal.0,&f.work).unwrap()};
    let verified=f.host.publication_work_guard(&actual).await.unwrap();
    let state=f.host.lock().unwrap();let conn=&state.journal.0;
    let reference=Reference{reference:"late-reference".into(),publication_id:"late-view".into(),view_revision:"c".repeat(64),space:"common".into(),binding_id:"shared".into(),profile:Brain::work_profile(&f.ghost,&["shared".into()]).unwrap()};
    put(conn,PINS,&work_key(&actual),&Profile{revision:1,references:vec![reference.clone()]}).unwrap();
    put(conn,DEPENDENCIES,&work_key(&actual),&Dependencies{references:vec![reference],blocked:false}).unwrap();
    assert_ne!(f.host.publication_work_revision(conn,&actual).unwrap(),verified,"final writer must compare the verified set, not recapture this new set as verified");
    put(conn,DEPENDENCIES,&work_key(&actual),&Dependencies{references:vec![],blocked:true}).unwrap();
    assert!(f.host.publication_work_current(&state,&actual).is_err());
}

#[cfg(feature="memory")]
fn native_cli(binary:&std::path::Path,directory:&std::path::Path,args:&[&str])->String {
    let output=std::process::Command::new(binary).arg("--dir").arg(directory).args(args).output().expect("isolated native engine launch");
    assert!(output.status.success(),"isolated native engine operation failed");
    String::from_utf8(output.stdout).expect("isolated native UTF-8 output")
}
#[cfg(feature="memory")]
fn native_token(binary:&std::path::Path,directory:&std::path::Path,space:&str,caps:&str)->(String,String) {
    let output=native_cli(binary,directory,&["admin","token","issue","--space",space,"--caps",caps]);
    let id=output.lines().find_map(|line|line.strip_prefix("issued token id=")).expect("issued token identity").to_owned();
    let secret=output.lines().find_map(|line|line.strip_prefix("secret (shown once): ")).expect("issued secret").to_owned();(id,secret)
}
fn publication_owner(f:&pi::Fixture,body:Value,revision:Option<u64>)->Value {
    let mut envelope=pi::envelope("owner",body);envelope.expected_revision=revision;
    let response=f.host.memory_publication_owner(&envelope).unwrap();assert_eq!(response["result"]["status"],"success");response["result"]["data"].clone()
}
fn publication_request(ghost:&str,conversation:&str,turn:&str,method:&str,reference:Option<&str>)->PiToolRequest {
    let mut body=json!({"method":method,"ghost_id":ghost,"conversation_id":conversation,"turn_id":turn});if let Some(reference)=reference {body["reference"]=json!(reference);}
    PiToolRequest{context_ref: None, ghost_id:ghost.into(),conversation_id:conversation.into(),envelope:pi::envelope(ghost,body)}
}

/// Actual native engine sessions, paired credentials, Host command journal and
/// source-view ledger. No model or service installation is part of this test.
#[cfg(feature="memory")]
#[tokio::test]
#[ignore="requires GHOST_OXIBRAIN_TEST_BINARY built from current Oxibrain source"]
async fn actual_native_normal_retain_publication_receiver_reconcile_restore_and_revoked_origin_withdrawal() {
    use crate::{adapters::memory::tests::scoped_fixture,host::scheduler::Journal};
    let binary=std::path::PathBuf::from(std::env::var_os("GHOST_OXIBRAIN_TEST_BINARY").expect("explicit isolated engine executable"));
    let mut f=pi::setup_with_spec(pi::verifier_spec("expected"));
    let (_,mut env,_,bindings)=scoped_fixture(f._root.path(),&f.ghost).await;
    env.capture_extra(&["GHOST_BRAIN_PUBLICATIONS","GHOST_BRAIN_PUBLICATION_ORIGIN","GHOST_BRAIN_PUBLICATION_DESTINATION","GHOST_BRAIN_PUBLICATION_RECEIVER","GHOST_BRAIN_PUBLICATION_PUBLIC_WRITE","GHOST_BRAIN_PUBLICATION_PUBLIC_READ","OXIBRAIN_MODELS_DIR"]);
    std::env::set_var("OXIBRAIN_MODELS_DIR",f._root.path().join("isolated-empty-models"));
    let directory=f._root.path().join("actual-engine");
    native_cli(&binary,&directory,&["admin","init","--space","fixture-space"]);
    native_cli(&binary,&directory,&["admin","init","--space","common"]);
    let (_,own)=native_token(&binary,&directory,"fixture-space","read,ingest,redact");
    let mut initial_bindings:Value=serde_json::from_slice(&std::fs::read(&bindings).unwrap()).unwrap();initial_bindings["owners"][&f.ghost][0]["capabilities"]=json!(["read","ingest","redact"]);std::fs::write(&bindings,serde_json::to_vec(&initial_bindings).unwrap()).unwrap();
    let (origin_id,origin)=native_token(&binary,&directory,"fixture-space","read");
    let (_,destination)=native_token(&binary,&directory,"common","write");
    let (_,reader)=native_token(&binary,&directory,"common","read");
    std::env::set_var("GHOST_BRAIN_EXECUTABLE",&binary);std::env::set_var("GHOST_BRAIN_DIR",&directory);
    std::env::set_var("GHOST_BRAIN_TOKEN_OWN_FIXTURE",&own);std::env::set_var("GHOST_BRAIN_TOKEN_SHARED_FIXTURE",&reader);
    std::env::set_var("GHOST_BRAIN_PUBLICATION_ORIGIN",&origin);std::env::set_var("GHOST_BRAIN_PUBLICATION_DESTINATION",&destination);
    let config=f._root.path().join("publications.json");let mut cap=capability(&f.ghost);cap.origin_space="fixture-space".into();cap.origin_token_env="GHOST_BRAIN_PUBLICATION_ORIGIN".into();cap.destination_token_env="GHOST_BRAIN_PUBLICATION_DESTINATION".into();
    std::fs::write(&config,serde_json::to_vec(&json!({"version":1,"capabilities":[cap]})).unwrap()).unwrap();std::env::set_var("GHOST_BRAIN_PUBLICATIONS",&config);
    f.host.brain=Brain::default();f.host.pi_local_route=Some(crate::host::lifetime_runtime::LocalPiRoute{base_url:"http://127.0.0.1:9/v1".into(),model_id:"fixture-local".into(),max_output_tokens:1024,callback_token:"fixture-local".into()});
    {let state=f.host.lock().unwrap();state.journal.put("policy",&f.ghost,&Policy{memory:true,..Default::default()}).unwrap();}
    let content="Selected public sentence. PRIVATE_SUFFIX_DO_NOT_DISCLOSE";let selected="Selected public sentence.";
    let entered=pi::envelope("owner",json!({"method":"conversation.input","ghost_id":f.ghost,"conversation_id":f.conversation,"text":content,"privacy":"private","attachments":[]}));
    let turn=entered.command_id.clone();assert_eq!(f.host.lifetime_action(&entered).unwrap()["result"]["status"],"success");
    let mut retain=publication_request(&f.ghost,&f.conversation,&turn,"memory.retain",None);retain.envelope.body["text"]=json!(content);retain.envelope.payload_digest=canonical_digest(&retain.envelope.body).unwrap();
    let retained=f.host.lifetime_pi_action(&retain,PiInferenceScope::Local).await.unwrap();assert_eq!(retained["result"]["status"],"success","normal source retain must reach actual engine");
    let authority=tokio::time::timeout(Duration::from_secs(15),engine::authorize(&f.ghost,"publish-to-common",&||Ok(()))).await.expect("native publication authorization deadline").expect("native publication authorization");
    let episode=retained["result"]["data"]["episode_id"].as_str().expect("actual source receipt identity");
    engine::episode_origin(&f.ghost,&authority,episode,&crate::adapters::documents::digest(content.as_bytes()),&||Ok(())).await.expect("native publication source descriptor");
    let sources=publication_owner(&f,json!({"method":"memory.publication.sources","ghost_id":f.ghost,"conversation_id":f.conversation}),None);
    assert_eq!(sources["sources"].as_array().unwrap().len(),1);let source=sources["sources"][0]["source_ref"].as_str().unwrap();
    assert!(!sources.to_string().contains("PRIVATE_SUFFIX"));assert!(!sources.to_string().contains("episode"));
    let prepared=publication_owner(&f,json!({"method":"memory.publication.prepare","ghost_id":f.ghost,"conversation_id":f.conversation,"capability_id":"publish-to-common","source_ref":source,"bytes":selected,"range":{"start":0,"end":selected.len()}}),None);
    let reference=prepared["publication_ref"].as_str().unwrap().to_owned();
    let commit=pi::envelope("owner",json!({"method":"memory.publication.commit","ghost_id":f.ghost,"conversation_id":f.conversation,"publication_ref":reference}));let mut commit=commit;commit.expected_revision=Some(1);
    let accepted=f.host.memory_publication_owner(&commit).unwrap();assert_eq!(accepted["result"]["status"],"success");
    let reconciled=f.host.advance_memory_publications_bounded(Duration::from_secs(30)).await.unwrap();
    if !reconciled {let state=f.host.lock().unwrap();let pending:Intent=load(&state.journal.0,INTENTS,&reference).unwrap().unwrap();panic!("actual publication did not reconcile: state={} authorization_frozen={} request_frozen={}",pending.state,pending.authorization.is_some(),pending.request.is_some());}
    let confirmed:Intent={let state=f.host.lock().unwrap();load(&state.journal.0,INTENTS,&reference).unwrap().unwrap()};let receipt=confirmed.receipt.clone().unwrap();
    let journal=serde_json::to_string(&confirmed).unwrap();for secret in [&own,&origin,&destination,&reader] {assert!(!journal.contains(secret));}
    assert_eq!(receipt["view_revision"],blake3::hash(selected.as_bytes()).to_hex().as_str());
    // Exact lost-ACK request survives a cold Host connection and engine restore.
    {let state=f.host.lock().unwrap();let mut lost=confirmed.clone();lost.state="unknown".into();lost.receipt=None;lost.next_attempt_ms=0;put(&state.journal.0,INTENTS,&reference,&lost).unwrap();}
    f.host.brain=Brain::default();
    let backup=f._root.path().join("engine-backup");native_cli(&binary,&directory,&["admin","backup","--no-projection","--no-cache","--out",backup.to_str().unwrap()]);
    std::fs::rename(&directory,f._root.path().join("old-engine-generation")).unwrap();native_cli(&binary,&directory,&["admin","restore",backup.to_str().unwrap()]);
    {let mut state=f.host.lock().unwrap();state.journal=Journal::open(&f._root.path().join("workspace.db")).unwrap();}
    assert!(f.host.advance_memory_publications_bounded(Duration::from_secs(20)).await.unwrap());
    {let state=f.host.lock().unwrap();let replay:Intent=load(&state.journal.0,INTENTS,&reference).unwrap().unwrap();assert_eq!(replay.receipt.as_ref(),Some(&receipt));assert_eq!(replay.request,confirmed.request);}
    let engine_db=Connection::open_with_flags(directory.join("brain.db"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(engine_db.query_row("SELECT count(*) FROM episodes WHERE kind='primary'",[],|row|row.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(engine_db.query_row("SELECT count(*) FROM publication_views",[],|row|row.get::<_,i64>(0)).unwrap(),1);drop(engine_db);
    // Independent receiver remains Read-only and never receives the root.
    let profile=publication_owner(&f,json!({"method":"memory.publication.profile.configure","ghost_id":f.ghost,"conversation_id":f.conversation,"references":[{"publication_ref":reference,"binding_id":"shared"}]}),None);assert_eq!(profile["revision"],1);
    let read=publication_request(&f.ghost,&f.conversation,&turn,"memory.publication.read",Some(&reference));
    let view=f.host.memory_publication_pi(&read,PiInferenceScope::Local).await.unwrap();assert_eq!(view.data["view"]["bytes"],selected);assert!(!view.data.to_string().contains("PRIVATE_SUFFIX"));assert!(!view.data.to_string().contains("origin"));
    // Separate exact target for the destination-only withdrawal check, so
    // the main root and its re-citation remain current until source correction.
    let withdraw_target=publication_owner(&f,json!({"method":"memory.publication.prepare","ghost_id":f.ghost,"conversation_id":f.conversation,"capability_id":"publish-to-common","source_ref":source,"bytes":selected,"range":{"start":0,"end":selected.len()}}),None);
    let withdraw_reference=withdraw_target["publication_ref"].as_str().unwrap();publication_owner(&f,json!({"method":"memory.publication.commit","ghost_id":f.ghost,"conversation_id":f.conversation,"publication_ref":withdraw_reference}),Some(1));assert!(f.host.advance_memory_publications_bounded(Duration::from_secs(20)).await.unwrap());
    // A second actual Ghost receives an independently issued common Read
    // binding and can only re-cite the accessible parent view into its exact
    // separately approved destination. The private root is never returned.
    let recipient_profile=Host::profile(crate::store::ProfileStore::create_profile(f._root.path(),"publication-recipient","Read-only collaborator").unwrap()).unwrap();let recipient=recipient_profile.id.clone();let recipient_conversation=uuid::Uuid::new_v4().to_string();
    {let mut state=f.host.lock().unwrap();state.profiles.insert(recipient.clone(),recipient_profile);state.journal.put("policy",&recipient,&Policy{memory:true,..Default::default()}).unwrap();}
    let registered=pi::envelope("owner",json!({"method":"registry.ensure","ghost_id":recipient,"conversation_id":recipient_conversation,"kind":"specialist","roles":[]}));assert_eq!(f.host.lifetime_action(&registered).unwrap()["result"]["status"],"success");
    let (_,recipient_read)=native_token(&binary,&directory,"common","read");
    native_cli(&binary,&directory,&["admin","init","--space","public-collaboration"]);
    let (_,public_write)=native_token(&binary,&directory,"public-collaboration","write");let (_,public_read)=native_token(&binary,&directory,"public-collaboration","read");
    std::env::set_var("GHOST_BRAIN_PUBLICATION_RECEIVER",&recipient_read);std::env::set_var("GHOST_BRAIN_PUBLICATION_PUBLIC_WRITE",&public_write);std::env::set_var("GHOST_BRAIN_PUBLICATION_PUBLIC_READ",&public_read);
    let mut scoped:Value=serde_json::from_slice(&std::fs::read(&bindings).unwrap()).unwrap();scoped["owners"][&recipient]=json!([
        {"id":"shared","grant_ref":"recipient-read","kind":"shared","spaces":["common"],"capabilities":["read"],"policy_revision":1},
        {"id":"public-view","grant_ref":"public-read","kind":"shared","spaces":["public-collaboration"],"capabilities":["read"],"policy_revision":1}]);
    scoped["grants"]["recipient-read"]=json!("GHOST_BRAIN_PUBLICATION_RECEIVER");scoped["grants"]["public-read"]=json!("GHOST_BRAIN_PUBLICATION_PUBLIC_READ");std::fs::write(&bindings,serde_json::to_vec(&scoped).unwrap()).unwrap();
    let mut recite_cap=capability(&recipient);recite_cap.id="recite-to-public".into();recite_cap.origin_space="common".into();recite_cap.destination_space="public-collaboration".into();recite_cap.origin_token_env="GHOST_BRAIN_PUBLICATION_RECEIVER".into();recite_cap.destination_token_env="GHOST_BRAIN_PUBLICATION_PUBLIC_WRITE".into();
    let mut caps:Value=serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();caps["capabilities"].as_array_mut().unwrap().push(serde_json::to_value(&recite_cap).unwrap());std::fs::write(&config,serde_json::to_vec(&caps).unwrap()).unwrap();
    let recipient_input=pi::envelope("owner",json!({"method":"conversation.input","ghost_id":recipient,"conversation_id":recipient_conversation,"text":"Read the independently granted publication","privacy":"private","attachments":[]}));let recipient_turn=recipient_input.command_id.clone();assert_eq!(f.host.lifetime_action(&recipient_input).unwrap()["result"]["status"],"success");
    publication_owner(&f,json!({"method":"memory.publication.profile.configure","ghost_id":recipient,"conversation_id":recipient_conversation,"references":[{"publication_ref":reference,"binding_id":"shared"}]}),None);
    let received=f.host.lifetime_pi_action(&publication_request(&recipient,&recipient_conversation,&recipient_turn,"memory.publication.read",Some(&reference)),PiInferenceScope::Local).await.unwrap();assert_eq!(received["result"]["status"],"success");assert_eq!(received["result"]["data"]["view"]["bytes"],selected);assert!(!received.to_string().contains("PRIVATE_SUFFIX"));assert!(!received.to_string().contains(episode));
    let candidates=publication_owner(&f,json!({"method":"memory.publication.sources","ghost_id":recipient,"conversation_id":recipient_conversation}),None);assert_eq!(candidates["sources"].as_array().unwrap().len(),1);
    let recite=publication_owner(&f,json!({"method":"memory.publication.prepare","ghost_id":recipient,"conversation_id":recipient_conversation,"capability_id":"recite-to-public","source_ref":candidates["sources"][0]["source_ref"],"bytes":selected,"range":{"start":0,"end":selected.len()}}),None);let child_reference=recite["publication_ref"].as_str().unwrap();
    publication_owner(&f,json!({"method":"memory.publication.commit","ghost_id":recipient,"conversation_id":recipient_conversation,"publication_ref":child_reference}),Some(1));assert!(f.host.advance_memory_publications_bounded(Duration::from_secs(30)).await.unwrap());
    let child:Intent={let state=f.host.lock().unwrap();load(&state.journal.0,INTENTS,child_reference).unwrap().unwrap()};let child_id=child.receipt.as_ref().unwrap()["publication_id"].as_str().unwrap();
    let recited=engine::read(&recipient,"public-view","public-collaboration",child_id,&||Ok(())).await.unwrap();assert_eq!(recited["bytes"],selected);assert_eq!(recited["extractable"],false);assert_eq!(recited["independent_support"],false);assert!(!recited.to_string().contains(episode));
    let engine_db=Connection::open_with_flags(directory.join("brain.db"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();assert_eq!(engine_db.query_row("SELECT count(*) FROM publication_views",[],|row|row.get::<_,i64>(0)).unwrap(),3);assert_eq!(engine_db.query_row("SELECT count(DISTINCT json_extract(record_json,'$.root_family')) FROM publication_views",[],|row|row.get::<_,i64>(0)).unwrap(),1);assert_eq!(engine_db.query_row("SELECT count(*) FROM episodes WHERE kind='primary'",[],|row|row.get::<_,i64>(0)).unwrap(),1);drop(engine_db);
    // Admit a real Work after its reference pin and prove a completed direct
    // read receipt survives cold reopen but cannot deliver cached bytes after
    // the root is corrected. The direct tools are the fixture sandbox here.
    publication_owner(&f,json!({"method":"memory.publication.profile.configure","ghost_id":f.ghost,"conversation_id":f.conversation,"references":[{"publication_ref":reference,"binding_id":"shared"}]}),Some(1));
    f.host.native_computers.as_mut().unwrap().pi_fixture_allow_private(&f.ghost).unwrap();
    let admitted=f.host.lifetime_action(&pi::envelope("owner",json!({"method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":"Read a generated file under exact published source provenance","privacy":"private","acceptance_spec":pi::verifier_spec("expected")}))).unwrap();assert_eq!(admitted["result"]["status"],"success");f.work=admitted["result"]["data"]["work"]["id"].as_str().unwrap().into();f.assignment=f.host.lock().unwrap().journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1",[&f.work],|row|row.get(0)).unwrap();
    let work_read=PiToolRequest{context_ref: None, ghost_id:f.ghost.clone(),conversation_id:f.conversation.clone(),envelope:pi::envelope(&f.ghost,json!({"method":"memory.publication.read","ghost_id":f.ghost,"conversation_id":f.conversation,"assignment_id":f.assignment,"work_id":f.work,"reference":reference}))};assert_eq!(f.host.lifetime_pi_action(&work_read,PiInferenceScope::Local).await.unwrap()["result"]["status"],"success");
    let write=pi::request(&f,10,"write-derived","write",json!({"path":"derived.txt","content":"COMPLETED_DERIVED_OUTPUT"}));assert_eq!(f.host.lifetime_pi_action(&write,PiInferenceScope::Local).await.unwrap()["result"]["status"],"success");
    let cached_read=pi::request(&f,11,"read-original","read",json!({"path":"derived.txt"}));let original_effect=f.host.lifetime_pi_action(&cached_read,PiInferenceScope::Local).await.unwrap();assert_eq!(original_effect["result"]["data"]["receipt"]["state"],"complete");
    // Revoked origin Read blocks new publication but cannot prevent the
    // independently authorized destination from withdrawing this exact copy.
    native_cli(&binary,&directory,&["admin","token","revoke",&origin_id]);std::env::remove_var("GHOST_BRAIN_PUBLICATION_ORIGIN");
    assert!(engine::authorize(&f.ghost,"publish-to-common",&||Ok(())).await.is_err());
    let withdraw=publication_owner(&f,json!({"method":"memory.publication.withdraw","ghost_id":f.ghost,"conversation_id":f.conversation,"publication_ref":withdraw_reference}),Some(2));assert_eq!(withdraw["operation"],"withdraw");
    assert!(f.host.advance_memory_publications_bounded(Duration::from_secs(20)).await.unwrap());
    // The original root remains readable: only the separate copy withdrew.
    assert_eq!(engine::read(&recipient,"shared","common",receipt["publication_id"].as_str().unwrap(),&||Ok(())).await.unwrap()["bytes"],selected);
    let prior=crate::adapters::memory::TrustedSourceOrigin::new(&f.ghost,retained["result"]["data"]["source_id"].as_str().unwrap(),"1",crate::adapters::memory::SourceDisclosure::Private,crate::adapters::documents::digest(content.as_bytes())).unwrap();
    let correction=f.host.owner_memory_source_correct(&uuid::Uuid::new_v4().to_string(),&f.ghost,&f.conversation,&prior,episode,content,"CORRECTED_SOURCE_WITH_NEW_PRIVATE_SUFFIX").await.unwrap();assert_eq!(correction["status"],"success","correction code: {:?}; source state: {:?}",correction["error_code"],correction["data"]["status"]);
    let corrected=publication_owner(&f,json!({"method":"memory.publication.sources","ghost_id":f.ghost,"conversation_id":f.conversation}),None);assert!(!corrected["sources"].as_array().unwrap().iter().any(|entry|entry["source_ref"]==source),"old source selection must not silently rebind its revised occurrence");
    let stale=pi::envelope("owner",json!({"method":"memory.publication.prepare","ghost_id":f.ghost,"conversation_id":f.conversation,"capability_id":"publish-to-common","source_ref":source,"bytes":selected,"range":{"start":0,"end":selected.len()}}));assert!(f.host.memory_publication_owner(&stale).is_err());
    // Physical source correction redacts copied Declaration bytes, so this
    // receiver may get an opaque unavailable result rather than a closed DTO.
    match engine::read(&recipient,"public-view","public-collaboration",child_id,&||Ok(())).await {Ok(closed)=>{assert_ne!(closed["state"],"current");assert_eq!(closed["bytes"],"");},Err(error)=>assert_eq!(error.to_string(),"source-view publication capability unavailable")}
    let engine_db=Connection::open_with_flags(directory.join("brain.db"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();assert_eq!(engine_db.query_row("SELECT count(*) FROM publication_views",[],|row|row.get::<_,i64>(0)).unwrap(),0);assert_eq!(engine_db.query_row("SELECT count(*) FROM episodes WHERE kind='declaration' AND redacted_at IS NOT NULL",[],|row|row.get::<_,i64>(0)).unwrap(),3);drop(engine_db);
    assert!(f.host.memory_publication_pi(&publication_request(&recipient,&recipient_conversation,&recipient_turn,"memory.publication.context.inspect",None),PiInferenceScope::Local).await.is_err());
    {let mut state=f.host.lock().unwrap();state.journal=Journal::open(&f._root.path().join("workspace.db")).unwrap();}
    let blocked_replay=f.host.lifetime_pi_action(&cached_read,PiInferenceScope::Local).await.unwrap();assert_eq!(blocked_replay["result"]["status"],"error");assert!(!blocked_replay.to_string().contains("COMPLETED_DERIVED_OUTPUT"));
    let next=pi::request(&f,12,"replacement-read","read",json!({"path":"derived.txt"}));assert_eq!(f.host.lifetime_pi_action(&next,PiInferenceScope::Local).await.unwrap()["result"]["status"],"error");
    {let state=f.host.lock().unwrap();assert_eq!(state.journal.0.query_row("SELECT state FROM lifetime_pi_effects WHERE call_id='read-original'",[],|row|row.get::<_,String>(0)).unwrap(),"complete");assert_eq!(state.journal.0.query_row("SELECT count(*) FROM lifetime_pi_effects",[],|row|row.get::<_,i64>(0)).unwrap(),2);}
    let inspect=publication_request(&f.ghost,&f.conversation,&turn,"memory.publication.context.inspect",None);
    assert!(f.host.memory_publication_pi(&inspect,PiInferenceScope::Local).await.is_err());
    assert!(f.host.publication_effect_guard(&publication_request(&f.ghost,&f.conversation,&turn,"conversation.reply",None),PiInferenceScope::Local).await.unwrap().is_some());
    let configured:Value=serde_json::from_slice(&std::fs::read(bindings).unwrap()).unwrap();assert_eq!(configured["owners"][&f.ghost][1]["capabilities"],json!(["read"]));
}
