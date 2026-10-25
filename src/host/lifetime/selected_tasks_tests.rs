use super::*;
use crate::host::{lifetime, scheduler::Journal};
use crate::lifetime_contract::{canonical_digest, ResponseStatus, VERSION};
use rusqlite::params;

const GHOST: &str="01930000-0000-7000-8000-000000000001";
const CONVERSATION: &str="01930000-0000-7000-8000-000000000002";
const TURN: &str="selected-owner-turn";

fn request(id:&str,body:Value)->Envelope {
    Envelope {protocol_version:VERSION.into(),command_id:id.into(),payload_digest:canonical_digest(&body).unwrap(),
        actor_ref:"owner".into(),authority_epoch:1,expected_revision:None,correlation_id:id.into(),body}
}
fn body(method:&str)->Value {
    let mut value=json!({"method":method,"ghost_id":GHOST,"conversation_id":CONVERSATION,"turn_id":TURN});
    if method==RECONCILE {value["operation_id"]=json!(format!("selected-task:{}","a".repeat(64)));}
    value
}
fn apply_owner(conn:&Connection,command:&Envelope)->Response {lifetime::apply(conn,command,"owner").unwrap()}
fn receiver_for(conn:&Connection,id:&str)->(i64,Envelope) {
    let (outbox,raw):(i64,String)=conn.query_row("SELECT id,payload FROM lifetime_outbox WHERE command_id=?1 AND target='pi'",[id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    (outbox,serde_json::from_str(&raw).unwrap())
}
fn receipt(receiver:&Envelope)->Value {
    json!({"status":"success","summary":"Controlled correlated Pi receipt","object_refs":[],"artifacts":[],"next_actions":[],
        "error_code":null,"retry_class":"same_id","data":{"command_id":receiver.command_id,"ghost_id":GHOST,
            "conversation_id":CONVERSATION,"runtime_kind":"pi-durable","runtime_release":"1.1.0","storage_ref":"fixture-sdk-storage"}})
}
fn unknown()->Value {json!({"state":"unknown","operation_id":body(RECONCILE)["operation_id"],"command_id":"original-callback","body_digest":"b".repeat(64)})}
fn selected_receipt(receiver:&Envelope)->Value {
    let mut value=receipt(receiver);
    if receiver.body["method"]=="runtime.reconcile" {
        let mut evidence=unknown();evidence["turn_id"]=json!(TURN);
        value["data"]["selected_task_recoveries"]=json!([evidence]);
    } else {
        value["data"]["selected_task_inspection"]=json!({"kind":"ghost.selected-task-admission-observation/1","turn_id":TURN,
            "exists":true,"operation_id":body(RECONCILE)["operation_id"],"command_id":"original-callback","body_digest":"b".repeat(64),
            "dispatch_started":true,"original_task_id":7,"outcome":unknown(),"recoveries":[]});
    }
    value
}
fn fixture()->(tempfile::TempDir,Journal) {
    let root=tempfile::tempdir().unwrap();let journal=Journal::open(&root.path().join("workspace.db")).unwrap();
    let conn=&journal.0;
    let register=request("register",json!({"method":"registry.ensure","ghost_id":GHOST,"conversation_id":CONVERSATION,"kind":"primary","roles":["coordination"]}));
    assert_eq!(apply_owner(conn,&register).status,ResponseStatus::Success);
    // Host intake derives the canonical turn ID from its source command ID;
    // only the outgoing Pi frame carries turn_id/prompt.
    let intake=request(TURN,json!({"method":"conversation.input","ghost_id":GHOST,"conversation_id":CONVERSATION,
        "text":"PRIVATE OWNER INPUT MUST NEVER ENTER RECOVERY OBSERVATION","privacy":"public","attachments":[]}));
    let intake_result=apply_owner(conn,&intake);
    assert_eq!(intake_result.status,ResponseStatus::Success,"Owner intake status={:?} code={:?} retry={:?} summary={}",
        intake_result.status,intake_result.error_code,intake_result.retry_class,intake_result.summary);
    assert_eq!(intake_result.data["turn_id"],TURN);
    let (id,command)=receiver_for(conn,TURN);
    lifetime::ack_outbox(conn,id,&receipt(&command)).unwrap();
    (root,journal)
}
fn inspect_command(conn:&Connection,id:&str)->Value {
    serde_json::to_value(apply_owner(conn,&request("receipt-observation",json!({"method":"command.inspect","command_id":id})))).unwrap()
}
fn queue(conn:&Connection,id:&str,method:&str)->(Response,i64,Envelope) {
    let response=apply_owner(conn,&request(id,body(method)));
    assert_eq!(response.status,ResponseStatus::Success,"{response:?}");
    let (outbox,receiver)=receiver_for(conn,id);(response,outbox,receiver)
}

#[test]
fn owner_selected_task_requests_have_stable_exact_outbox_identity_and_body_conflicts() {
    let (_root,journal)=fixture();let conn=&journal.0;
    for (id,method) in [("observe",INSPECT),("recover",RECONCILE)] {
        let (response,_,receiver)=queue(conn,id,method);
        assert_eq!(receiver.actor_ref,"owner");assert_eq!(receiver.authority_epoch,1);
        assert_eq!(receiver.body,frame(&request(id,body(method))).unwrap());
        assert_eq!(response.data["receiver_command_id"],receiver.command_id);
        assert_eq!(response.data["receiver_payload_digest"],canonical_digest(&receiver.body).unwrap());
        assert_eq!(delivery_allowed(conn,&receiver).unwrap(),Some(true));
        let before=conn.query_row("SELECT COUNT(*) FROM lifetime_outbox",[],|r|r.get::<_,i64>(0)).unwrap();
        assert_eq!(apply_owner(conn,&request(id,body(method))),response);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),before);
        let mut changed=body(method);changed["turn_id"]=json!("other-owner-turn");
        assert_eq!(apply_owner(conn,&request(id,changed)).error_code.as_deref(),Some("conflict"));
        assert_eq!(receiver_for(conn,id).1,receiver);
        let mut forged=receiver.clone();forged.command_id="uncommitted-receiver".into();
        assert_eq!(delivery_allowed(conn,&forged).unwrap(),Some(false));
        let mut changed_receiver=receiver.clone();changed_receiver.body["ghost_id"]=json!("foreign-ghost");
        changed_receiver.payload_digest=canonical_digest(&changed_receiver.body).unwrap();
        assert!(delivery_allowed(conn,&changed_receiver).is_err());
        let observed=inspect_command(conn,id);
        assert_eq!(observed["data"]["response"],serde_json::to_value(response).unwrap());
        assert_eq!(observed["data"]["deliveries"][0]["delivery_state"],"pending");
        assert_eq!(observed["data"]["deliveries"][0]["receiver_evidence"],Value::Null);
    }
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_goals",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_work",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}

#[test]
fn selected_task_scope_denies_foreign_owner_pair_epoch_and_unacknowledged_binding() {
    for variant in ["actor","ghost","conversation","turn","advisory","epoch","binding","unacknowledged","operation","extra"] {
        let (_root,journal)=fixture();let conn=&journal.0;let mut value=body(RECONCILE);
        match variant {
            "ghost"=>value["ghost_id"]=json!("foreign-ghost"),
            "conversation"=>value["conversation_id"]=json!("foreign-conversation"),
            "turn"=>value["turn_id"]=json!("foreign-owner-turn"),
            "advisory"=>{conn.execute("UPDATE lifetime_turns SET sender_kind='ghost',sender_ref=?1 WHERE id=?2",params![GHOST,TURN]).unwrap();},
            "binding"=>{conn.execute("UPDATE lifetime_bindings SET ghost_id='foreign-ghost'",[]).unwrap();},
            "unacknowledged"=>{conn.execute("UPDATE lifetime_bindings SET runtime_release='unresolved'",[]).unwrap();},
            "operation"=>value["operation_id"]=json!("invented-operation"),
            "extra"=>value["raw_frame"]=json!({"prompt":"must not become a tunnel"}),
            _=>{}
        }
        let mut command=request("denied",value);
        if variant=="actor" {command.actor_ref="ghost".into();}
        if variant=="epoch" {command.authority_epoch=2;}
        let result=lifetime::apply(conn,&command,&command.actor_ref).unwrap();
        assert_eq!(result.status,ResponseStatus::Error,"{variant}: {result:?}");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE command_id='denied'",[],|r|r.get::<_,i64>(0)).unwrap(),0, "{variant}");
    }
}

#[test]
fn selected_task_fresh_recovery_is_fenced_but_exact_original_delivery_can_retrieve_history() {
    for variant in ["cancel","submission","entry","running","answered","failed","cancelled","epoch","dispatch","binding"] {
        let (_root,journal)=fixture();let conn=&journal.0;
        let (_,_,recovery)=queue(conn,"recover-before-change",RECONCILE);
        match variant {
            "cancel"=>{conn.execute("UPDATE lifetime_turn_runs SET cancel_requested=1,cancel_command_id='cancel-original'",[]).unwrap();},
            "submission"=>{conn.execute("UPDATE lifetime_turn_runs SET submission_id='actual-sdk-submission'",[]).unwrap();},
            "entry"=>{conn.execute("UPDATE lifetime_turn_runs SET entry_id='actual-sdk-entry'",[]).unwrap();},
            "epoch"=>{conn.execute("UPDATE lifetime_authority SET authority_epoch=2",[]).unwrap();},
            "dispatch"=>{conn.execute("UPDATE lifetime_authority SET dispatch_enabled=0",[]).unwrap();},
            "binding"=>{conn.execute("UPDATE lifetime_bindings SET ghost_id='foreign-ghost'",[]).unwrap();},
            state=>{conn.execute("UPDATE lifetime_turn_runs SET state=?1",[state]).unwrap();}
        }
        assert_eq!(delivery_allowed(conn,&recovery).unwrap(),Some(!matches!(variant,"epoch"|"dispatch"|"binding")),"{variant}");
        assert_eq!(apply_owner(conn,&request("fresh-recovery-denied",body(RECONCILE))).status,ResponseStatus::Error,"{variant}");
        if !matches!(variant,"epoch"|"dispatch"|"binding") {
            let (_,_,inspection)=queue(conn,"historical-inspection",INSPECT);
            assert_eq!(delivery_allowed(conn,&inspection).unwrap(),Some(true),"{variant}");
        }
    }
    let (_root,journal)=fixture();journal.0.execute("UPDATE lifetime_turn_runs SET state='effect_unknown',reason_code='effect_unconfirmed'",[]).unwrap();
    queue(&journal.0,"explicit-unknown-recovery",RECONCILE);
}

#[test]
fn selected_task_ack_requires_exact_bounded_receiver_evidence_and_never_exposes_input() {
    for method in [INSPECT,RECONCILE] {
        let (_root,journal)=fixture();let conn=&journal.0;
        let (original,id,receiver)=queue(conn,"targeted",method);
        let valid=selected_receipt(&receiver);
        for variant in ["command","pair","turn","metadata","operation","digest"] {
            let mut invalid=valid.clone();
            match variant {
                "command"=>invalid["data"]["command_id"]=json!("foreign-command"),
                "pair"=>invalid["data"]["conversation_id"]=json!("foreign-conversation"),
                "metadata"=>invalid["data"]["committed_view"]=json!({"prompt":"PRIVATE OWNER INPUT"}),
                _=>{
                    let result=if method==INSPECT {&mut invalid["data"]["selected_task_inspection"]} else {&mut invalid["data"]["selected_task_recoveries"][0]};
                    if variant=="turn" {result["turn_id"]=json!("other-turn");}
                    if variant=="operation" {result["operation_id"]=json!(format!("selected-task:{}","c".repeat(64)));}
                    if variant=="digest" {result["body_digest"]=json!("credential-shaped-raw-text");}
                }
            }
            assert!(lifetime::ack_outbox(conn,id,&invalid).is_err(),"{method}: {variant}");
        }
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_delivery_receipts WHERE outbox_id=?1",[id],|r|r.get::<_,i64>(0)).unwrap(),0);
        lifetime::ack_outbox(conn,id,&valid).unwrap();
        lifetime::ack_outbox(conn,id,&valid).unwrap();
        let projected=inspect_command(conn,"targeted");
        assert_eq!(projected["data"]["response"],serde_json::to_value(original).unwrap());
        assert_eq!(projected["data"]["deliveries"][0]["delivery_state"],"acknowledged");
        assert_eq!(projected["data"]["deliveries"][0]["receiver_evidence"],valid["data"]);
        assert!(!serde_json::to_string(&projected).unwrap().contains("PRIVATE OWNER INPUT"));
        let mut changed=valid;changed["summary"]=json!("different response bytes");
        assert!(lifetime::ack_outbox(conn,id,&changed).is_err());
    }
}

#[test]
fn selected_task_original_receipt_projection_survives_cold_reopen_and_remains_method_scoped() {
    let (root,journal)=fixture();let conn=&journal.0;
    let (original,id,receiver)=queue(conn,"cold-observation",INSPECT);
    lifetime::ack_outbox(conn,id,&selected_receipt(&receiver)).unwrap();
    let before=inspect_command(conn,"cold-observation");
    let source:String=conn.query_row("SELECT response FROM lifetime_commands WHERE command_id='cold-observation'",[],|r|r.get(0)).unwrap();
    assert!(inspect_command(conn,TURN)["data"].get("deliveries").is_none());
    drop(journal);
    let reopened=Journal::open(&root.path().join("workspace.db")).unwrap();
    assert_eq!(inspect_command(&reopened.0,"cold-observation"),before);
    assert_eq!(apply_owner(&reopened.0,&request("cold-observation",body(INSPECT))),original);
    assert_eq!(reopened.0.query_row("SELECT response FROM lifetime_commands WHERE command_id='cold-observation'",[],|r|r.get::<_,String>(0)).unwrap(),source);
    assert_eq!(reopened.0.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE command_id='cold-observation'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}

#[test]
fn selected_task_receipts_bound_history_link_original_intent_and_fence_late_ack() {
    let (_root,journal)=fixture();let conn=&journal.0;
    let (_,id,receiver)=queue(conn,"bounded-observation",INSPECT);
    let valid=selected_receipt(&receiver);
    for variant in ["history-bound","original-link","raw-outcome"] {
        let mut invalid=valid.clone();let observation=&mut invalid["data"]["selected_task_inspection"];
        match variant {
            "history-bound"=>observation["recoveries"]=json!((0..9).map(|i|json!({"request_id":format!("recovery-{i}"),
                "started":true,"task_id":i+1,"outcome":unknown()})).collect::<Vec<_>>()),
            "original-link"=>observation["outcome"]["command_id"]=json!("different-original-callback"),
            "raw-outcome"=>observation["outcome"]["raw_input"]=json!("credential-shaped-private-input"),
            _=>unreachable!()
        }
        assert!(lifetime::ack_outbox(conn,id,&invalid).is_err(),"{variant}");
    }
    let mut absent=receipt(&receiver);
    absent["data"]["selected_task_inspection"]=json!({"kind":"ghost.selected-task-admission-observation/1","turn_id":TURN,"exists":false});
    assert!(receiver_evidence(&receiver,&absent).unwrap().is_some(),"an absent SDK document is observed without creating an intent");
    conn.execute("UPDATE lifetime_authority SET authority_epoch=2",[]).unwrap();
    assert!(lifetime::ack_outbox(conn,id,&valid).is_err());
    assert_eq!(conn.query_row("SELECT acknowledged FROM lifetime_outbox WHERE id=?1",[id],|r|r.get::<_,bool>(0)).unwrap(),false);
}
