// Included inside the existing actual_sdk fixture: real control/Host HTTP,
// production Pi main/SDK and the existing owned driver. Faults affect only the
// disposable child's transport, after real durable operations have returned.
mod selected_task_recovery {
    use super::*;
    use crate::control::{api::{Action, Command as OwnerCommand}, ControlClient};

    const TURN:&str="operator-selected-owner-turn";
    const RECOVER:&str="operator-explicit-original-recovery";

    fn control(root:&Path,command:Envelope)->Value {
        let client=ControlClient::discover(root).unwrap();
        let result=client.action(Action {request_id:uuid::Uuid::new_v4().to_string(),command:OwnerCommand::Lifetime {envelope:command}}).unwrap();
        assert_eq!(result["ok"],true,"authenticated Owner control failed");
        result["result"].clone()
    }
    fn command(root:&Path,id:&str,body:Value)->Value {control(root,env(id,body))}
    fn successful(value:Value)->Value {assert_eq!(value["status"],"success","{value}");value["data"].clone()}
    fn scoped(ghost:&str,conversation:&str,method:&str,turn:&str)->Value {
        json!({"method":method,"ghost_id":ghost,"conversation_id":conversation,"turn_id":turn})
    }
    fn command_evidence(root:&Path,id:&str)->Value {
        successful(command(root,"operator-original-command-inspection",json!({"method":"command.inspect","command_id":id})))
    }
    fn acknowledged(conn:&Connection,id:&str)->bool {
        conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_outbox WHERE command_id=?1 AND target='pi' AND acknowledged=1)",[id],|r|r.get(0)).unwrap()
    }
    fn callback_calls(root:&Path)->Vec<Value> {
        fs::read_to_string(root.join("selected-callbacks.jsonl")).unwrap_or_default().lines()
            .map(|line|serde_json::from_str(line).unwrap()).collect()
    }
    fn owner_requests(model:&ModelServer)->usize {
        model.requests.lock().unwrap().iter().filter(|body| {
            body["messages"].as_array().is_some_and(|messages|messages.iter().any(|message| {
                (message["role"]=="system" || message["role"]=="developer")
                    && message.to_string().contains("Current authenticated input kind: owner.")
                    && message.to_string().contains(TURN)
            }))
        }).count()
    }
    fn sdk_database(root:&Path,ghost:&str,conversation:&str)->Connection {
        Connection::open_with_flags(root.join("durable").join(format!("{:x}",Sha256::digest(ghost.as_bytes())))
            .join(format!("{:x}",Sha256::digest(conversation.as_bytes()))).join("durable.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
    }
    fn original_sdk_task(root:&Path,ghost:&str,conversation:&str)->String {
        sdk_database(root,ghost,conversation).query_row("SELECT record FROM tasks WHERE kind=?1",
            [serde_json::to_string("ghost.selected-task-admission").unwrap()],|r|r.get(0)).unwrap()
    }
    fn recovered_sdk_task(root:&Path,ghost:&str,conversation:&str)->String {
        sdk_database(root,ghost,conversation).query_row("SELECT record FROM tasks WHERE kind=?1",
            [serde_json::to_string("ghost.selected-task-admission-recovery").unwrap()],|r|r.get(0)).unwrap()
    }
    fn owner_submission(host:&Host,ghost:&str,conversation:&str,id:i64)->String {
        let index=Connection::open_with_flags(index_path(host,ghost),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let request:String=index.query_row("SELECT request_id FROM ghost_canonical_turns WHERE turn_id=?1 AND conversation_id=?2 AND context_ref='owner'",
            params![TURN,conversation],|r|r.get(0)).unwrap();
        let db=sdk_database(&host.root,ghost,conversation);
        let request=serde_json::to_string(&request).unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM submissions WHERE request_id=?1",[&request],|r|r.get::<_,i64>(0)).unwrap(),1,
            "recovery/cancellation cannot replace the original Owner submission");
        db.query_row("SELECT record FROM submissions WHERE id=?1 AND request_id=?2",params![id,request],|r|r.get(0)).unwrap()
    }
    fn owner_generations(root:&Path,ghost:&str,conversation:&str)->Vec<Value> {
        let db=sdk_database(root,ghost,conversation);
        let mut query=db.prepare("SELECT record FROM tasks WHERE kind=?1 ORDER BY id").unwrap();
        let rows=query.query_map([serde_json::to_string("pi.generation").unwrap()],|r|r.get::<_,String>(0)).unwrap();
        let result=rows.map(|row|serde_json::from_str(&row.unwrap()).unwrap()).collect();
        result
    }
    fn projection_conflicts(root:&Path)->Vec<Value> {
        fs::read_to_string(root.join("selected-status-diagnostics.jsonl")).unwrap().lines()
            .map(|line|serde_json::from_str(line).unwrap()).collect()
    }
    fn original_unknown_status_snapshot(host:&Host,ghost:&str)->Option<String> {
        let db=Connection::open_with_flags(index_path(host,ghost),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let v2:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='ghost_turn_status_observations')",[],|r|r.get(0)).unwrap();
        let v2_sql="SELECT json_array(sequence,turn_id,conversation_id,kind,observation_id,status,predecessor_kind,predecessor_id,predecessor_digest,invocation_id,payload_json,payload_digest,delivery_state,receipt_json,observed_json,created_at_ms,updated_at_ms)
             FROM ghost_turn_status_observations WHERE turn_id=?1 AND kind='v2' AND status='effect_unknown'
             AND json_extract(payload_json,'$.submission_id') IS NULL AND json_extract(payload_json,'$.entry_id') IS NULL
             AND delivery_state IN ('acknowledged','observed')";
        let legacy_sql="SELECT json_array(turn_id,status,invocation_id,payload_json,payload_digest,delivery_state,receipt_json,observed_json,created_at_ms,updated_at_ms)
             FROM ghost_turn_status_reports WHERE turn_id=?1 AND status='effect_unknown'
             AND json_extract(payload_json,'$.submission_id') IS NULL AND json_extract(payload_json,'$.entry_id') IS NULL
             AND delivery_state IN ('acknowledged','observed')";
        for (kind,sql) in [("v2",v2_sql),("legacy",legacy_sql)] {
            if kind=="v2" && !v2 {continue;}
            let mut query=db.prepare(sql).unwrap();
            let rows=query.query_map([TURN],|r|r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
            assert!(rows.len()<=1,"original null-SID unknown evidence must have one exact identity");
            if let Some(row)=rows.into_iter().next() {return Some(format!("{kind}:{row}"));}
        }
        None
    }
    fn original_unknown_status(host:&Host,ghost:&str)->String {
        original_unknown_status_snapshot(host,ghost).expect("original acknowledged null-SID unknown status evidence")
    }
    fn assert_original_unknown_status(host:&Host,ghost:&str,original:&str) {
        let (kind,bytes)=original.split_once(':').unwrap();
        let row:Value=serde_json::from_str(bytes).unwrap();
        let db=Connection::open_with_flags(index_path(host,ghost),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let (identity,sql)=if kind=="v2" {
            (row[4].as_str().unwrap(),"SELECT json_array(sequence,turn_id,conversation_id,kind,observation_id,status,predecessor_kind,predecessor_id,predecessor_digest,invocation_id,payload_json,payload_digest,delivery_state,receipt_json,observed_json,created_at_ms,updated_at_ms)
              FROM ghost_turn_status_observations WHERE turn_id=?1 AND observation_id=?2")
        } else {
            assert_eq!(kind,"legacy");
            (row[2].as_str().unwrap(),"SELECT json_array(turn_id,status,invocation_id,payload_json,payload_digest,delivery_state,receipt_json,observed_json,created_at_ms,updated_at_ms)
              FROM ghost_turn_status_reports WHERE turn_id=?1 AND invocation_id=?2")
        };
        let retained:String=db.query_row(sql,params![TURN,identity],|r|r.get(0)).unwrap();
        assert_eq!(retained,bytes,"the exact original unknown observation and delivery evidence changed");
    }
    fn progressed_unknown_status(host:&Host,ghost:&str,conversation:&str,submission:&str,host_command:&str)->bool {
        let db=Connection::open_with_flags(index_path(host,ghost),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut query=db.prepare("SELECT current.invocation_id FROM ghost_turn_status_observations current
          JOIN ghost_turn_status_observations previous ON current.predecessor_kind='v2' AND previous.observation_id=current.predecessor_id
          AND previous.payload_digest=current.predecessor_digest
          WHERE current.turn_id=?1 AND current.kind='v2' AND current.status='effect_unknown'
          AND json_extract(current.payload_json,'$.submission_id')=?2 AND current.delivery_state IN ('acknowledged','observed')
          AND previous.turn_id=current.turn_id AND previous.kind='v2' AND previous.status='running'
          AND json_extract(previous.payload_json,'$.submission_id')=?2 AND current.sequence>previous.sequence").unwrap();
        let invocations=query.query_map(params![TURN,submission],|r|r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        invocations.iter().any(|invocation| {
            let identity=serde_json::to_vec(&json!(["ghost-pi-callback-v2",ghost,conversation,invocation,"conversation.turn_status"])).unwrap();
            format!("pi-tool-v2:{:x}",Sha256::digest(identity))==host_command
        })
    }
    fn completed_effects(host:&Host,work:&str)->Vec<String> {
        let state=host.lock().unwrap();
        let mut query=state.journal.0.prepare("SELECT json_array(execution_id,task_id,call_id,input_digest,operation,state,response_json)
          FROM lifetime_pi_effects WHERE execution_id IN (SELECT execution_id FROM lifetime_pi_executions WHERE work_id=?1)
          AND state='complete' ORDER BY execution_id,task_id,call_id").unwrap();
        let rows=query.query_map([work],|r|r.get(0)).unwrap().collect::<rusqlite::Result<Vec<String>>>().unwrap();
        rows
    }
    fn fixture_entry(root:&Path,ghost:&str,conversation:&str)->PathBuf {
        let entry=production_entry(root);
        let production=fs::read_to_string(&entry).unwrap();
        let guard=json!({"root":root,"ghost":ghost,"conversation":conversation,"turn":TURN});
        let fault=r#"
import * as fixtureFs from 'node:fs';import * as fixturePath from 'node:path';
import {createHash as fixtureHash} from 'node:crypto';import {DatabaseSync as FixtureDatabase} from 'node:sqlite';
const fixture=FIXTURE_CONFIG;
if(!fixtureFs.lstatSync(fixture.root).isDirectory()||fixtureFs.lstatSync(fixture.root).isSymbolicLink()
 ||(fixtureFs.statSync(fixture.root).mode&0o077)!==0)throw Error('Private disposable fixture required');
if(process.env.GHOST_LIFETIME_HOST_ROOT!==fixture.root)throw Error('Disposable Host root mismatch');
const artifact=name=>fixturePath.join(fixture.root,name);
const exists=name=>fixtureFs.existsSync(artifact(name));
const read=name=>JSON.parse(fixtureFs.readFileSync(artifact(name),'utf8'));
const write=(name,value)=>fixtureFs.writeFileSync(artifact(name),JSON.stringify(value),{mode:0o600,flag:'wx'});
if(!exists('selected-status-diagnostics.jsonl'))fixtureFs.writeFileSync(artifact('selected-status-diagnostics.jsonl'),'',{mode:0o600,flag:'wx'});
const fixtureStderr=process.stderr.write.bind(process.stderr);
process.stderr.write=function(chunk,...rest){
 for(const line of String(chunk).split('\n')){
  let diagnostic;try{diagnostic=JSON.parse(line);}catch{continue;}
  for(const code of ['canonical_turn_status_conflict','canonical_submission_conflict'])
   if(diagnostic.code===code||diagnostic.cause_code===code)
    fixtureFs.appendFileSync(artifact('selected-status-diagnostics.jsonl'),JSON.stringify({code})+'\n',{mode:0o600});
 }
 return fixtureStderr(chunk,...rest);
};
const starts=exists('selected-starts.json')?read('selected-starts.json').count:0;
if(starts>=8)throw Error('Controlled restart budget exceeded');
fixtureFs.writeFileSync(artifact('selected-starts.json'),JSON.stringify({count:starts+1}),{mode:0o600});
function exitAfterRealRunningReceipt(){
 if(exists('selected-lost-receiver-frame.json')&&exists('selected-real-running.json')&&!exists('selected-owned-exit.json')){
  const running=read('selected-real-running.json');
  const hash=value=>fixtureHash('sha256').update(value).digest('hex');
  const path=fixturePath.join(fixture.root,'durable',hash(fixture.ghost),hash(fixture.conversation),'durable.sqlite');
  const index=new FixtureDatabase(fixturePath.join(fixture.root,'durable',hash(fixture.ghost),'runtime.sqlite'),{readOnly:true});let requestId;
  try{requestId=index.prepare("SELECT request_id FROM ghost_canonical_turns WHERE turn_id=? AND conversation_id=? AND context_ref='owner'").get(fixture.turn,fixture.conversation)?.request_id;}
  finally{index.close();}
  if(typeof requestId!=='string')return false;
  const db=new FixtureDatabase(path,{readOnly:true});let generation;
  try{
   const submitted=db.prepare('SELECT record FROM submissions WHERE id=? AND request_id=?').get(JSON.parse(running.submission_id),JSON.stringify(requestId));
   if(!submitted||JSON.parse(submitted.record).status!=='placed')return false;
   const rows=db.prepare('SELECT record FROM tasks WHERE kind=?').all(JSON.stringify('pi.generation'));
   if(rows.length===0)return false;
   if(rows.length!==1)throw Error('Original Owner generation is ambiguous before controlled loss');
   generation=JSON.parse(rows[0].record);
   if(generation.state.status!=='running'||generation.state.checkpoint?.phase!=='request')return false;
  }finally{db.close();}
  write('selected-owned-exit.json',{turn_id:fixture.turn,submission_id:running.submission_id,generation_id:generation.id,code:74});
  process.exit(74);
 }
 return false;
}
const fixtureFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=async (...args)=>{
 let request;try{request=JSON.parse(args[1]?.body);}catch{}
 const response=await fixtureFetch(...args),body=request?.envelope?.body;
 if(request?.ghost_id!==fixture.ghost||request?.conversation_id!==fixture.conversation||body?.turn_id!==fixture.turn)return response;
 if(body.method==='goal.create'){
  const actual=await response.clone().json();
  if(!actual.ok||actual.result?.status!=='success')throw Error('Actual Host Goal receipt was not successful');
  const file=artifact('selected-callbacks.jsonl');
  if(fixtureFs.existsSync(file)&&fixtureFs.statSync(file).size>8192)throw Error('Callback evidence budget exceeded');
  fixtureFs.appendFileSync(file,JSON.stringify({command_id:request.envelope.command_id,payload_digest:request.envelope.payload_digest,
   goal_id:actual.result.data.goal.id,work_id:actual.result.data.work.id})+'\n',{mode:0o600});
  if(!exists('selected-lost-goal-ack.json')){
   write('selected-lost-goal-ack.json',{command_id:request.envelope.command_id,payload_digest:request.envelope.payload_digest});
   throw new TypeError('Controlled ACK loss after genuine Host Goal commit');
  }
 }
 if(body.method==='conversation.turn_status'&&body.status==='running'&&body.submission_id!==null){
  const actual=await response.clone().json();
  if(actual.ok&&actual.result?.status==='success'&&!exists('selected-real-running.json')){
   write('selected-real-running.json',{command_id:request.envelope.command_id,submission_id:body.submission_id});
   const checkpointDeadline=Date.now()+5000;
   while(Date.now()<checkpointDeadline){
    exitAfterRealRunningReceipt();
    await new Promise(resolve=>setTimeout(resolve,5));
   }
   throw Error('Controlled loss did not observe the genuine original request checkpoint');
  }
 }
 return response;
};
const fixtureWrite=process.stdout.write.bind(process.stdout);
process.stdout.write=function(chunk,...rest){
 let frame;const wire=String(chunk);try{frame=JSON.parse(wire);}catch{}
 if(exists('selected-expected-receiver.json')&&frame?.data?.command_id===read('selected-expected-receiver.json').command_id){
  const expected=read('selected-expected-receiver.json'),entries=frame.data.selected_task_recoveries;
  if(frame.status!=='success'||frame.data.ghost_id!==fixture.ghost||frame.data.conversation_id!==fixture.conversation
    ||entries?.length!==1||entries[0].turn_id!==fixture.turn||entries[0].operation_id!==expected.operation_id||entries[0].state!=='admitted'
    ||Buffer.byteLength(wire)>65536)throw Error('Unexpected actual targeted receiver evidence');
  if(!exists('selected-lost-receiver-frame.json')){
   fixtureFs.writeFileSync(artifact('selected-lost-receiver-frame.json'),wire,{mode:0o600,flag:'wx'});
   exitAfterRealRunningReceipt();return true;
  }
  if(!exists('selected-replayed-receiver-frame.json'))fixtureFs.writeFileSync(artifact('selected-replayed-receiver-frame.json'),wire,{mode:0o600,flag:'wx'});
 }
 return fixtureWrite(chunk,...rest);
};
"#;
        fs::write(&entry,format!("{}\n{}",fault.replace("FIXTURE_CONFIG",&guard.to_string()),production)).unwrap();
        entry
    }

    #[tokio::test(flavor="multi_thread",worker_threads=2)]
    async fn actual_sdk_authenticated_owner_selected_task_recovery_preserves_original_receipt_after_restart() {
        let mut f=host_fixture();
        let mut template=task_template_body(&f,"selected-recovery",TASK_SCRIPT);
        template["content"]["instructions"]=json!(format!("{SIMPLE}: controlled recovery fixture. Read the immutable input, write and publish answer.txt; acceptance remains independent."));
        template["content"]["artifact_path"]=json!("answer.txt");
        let retained=f.root.keep();fs::set_permissions(&retained,fs::Permissions::from_mode(0o700)).unwrap();
        eprintln!("Selected-task actual SDK fixture root: {}",retained.display());
        let _environment=isolated_environment(&retained,&f.ghost).await;
        let model=ModelServer::start(&retained);
        configure_local(&mut f.host,&model,&[(&f.ghost,&f.conversation)]);
        let ghost=f.ghost.clone();let conversation=f.conversation.clone();
        let entry=fixture_entry(&retained,&ghost,&conversation);
        let host=Arc::new(f.host);
        let http=pi_test_http::Server::start(Arc::clone(&host),"a".repeat(64));
        let reference=successful(command(&retained,"operator-template",template))["template_ref"].clone();
        let intake=successful(command(&retained,TURN,json!({"method":"conversation.input","ghost_id":ghost,"conversation_id":conversation,
            "text":"Perform my selected controlled task.","privacy":"public","attachments":[],
            "task_contract":{"template":reference,"mode":"direct","input":{"value":"fixture"}}})));
        assert_eq!(intake["turn_id"],TURN);
        let driver=Driver::start(&host,entry.clone());
        until(&host,&model,&http,"selected-original-ack-unknown",|conn| {
            conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_turn_runs WHERE turn_id=?1 AND state='effect_unknown' AND submission_id IS NULL AND entry_id IS NULL)",[TURN],|r|r.get(0)).unwrap()
        }).await;
        until(&host,&model,&http,"selected-original-unknown-status-ack",|_|original_unknown_status_snapshot(&host,&ghost).is_some()).await;
        assert_eq!(callback_calls(&retained).len(),1);assert_eq!(owner_requests(&model),0);
        let original=original_sdk_task(&retained,&ghost,&conversation);
        assert_eq!(serde_json::from_str::<Value>(&original).unwrap()["state"]["outcome"]["result"]["state"],"unknown");
        let original_status=original_unknown_status(&host,&ghost);
        let original_source={let state=host.lock().unwrap();state.journal.0.query_row("SELECT request,response FROM lifetime_commands WHERE command_id=?1",
            [callback_calls(&retained)[0]["command_id"].as_str().unwrap()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap()};
        driver.pause(&host).await;
        let driver=Driver::start(&host,entry.clone());
        successful(command(&retained,"operator-selected-inspection",scoped(&ghost,&conversation,"conversation.selected_task.inspect",TURN)));
        until(&host,&model,&http,"selected-authenticated-inspection-ack",|conn|acknowledged(conn,"operator-selected-inspection")).await;
        let inspected=command_evidence(&retained,"operator-selected-inspection");
        let observation=&inspected["deliveries"][0]["receiver_evidence"]["selected_task_inspection"];
        assert_eq!(observation["exists"],true);assert_eq!(observation["outcome"]["state"],"unknown");
        assert_eq!(observation["command_id"],callback_calls(&retained)[0]["command_id"]);
        assert!(observation["recoveries"].as_array().unwrap().is_empty());
        let operation=observation["operation_id"].as_str().unwrap().to_owned();
        assert_eq!(callback_calls(&retained).len(),1,"generic cold startup and inspection cannot resend the Goal callback");
        assert_eq!(owner_requests(&model),0);assert_eq!(original_sdk_task(&retained,&ghost,&conversation),original);
        assert_original_unknown_status(&host,&ghost,&original_status);
        driver.pause(&host).await;
        let mut recovery=scoped(&ghost,&conversation,"conversation.selected_task.reconcile",TURN);recovery["operation_id"]=json!(operation);
        let queued=successful(command(&retained,RECOVER,recovery.clone()));
        let mut expected=fs::OpenOptions::new().write(true).create_new(true).mode(0o600)
            .open(retained.join("selected-expected-receiver.json")).unwrap();
        expected.write_all(&serde_json::to_vec(&json!({"command_id":queued["receiver_command_id"],"operation_id":operation})).unwrap()).unwrap();
        expected.sync_all().unwrap();drop(expected);
        let owner_request_checkpoint=owner_requests(&model);
        let driver=Driver::start(&host,entry.clone());
        until(&host,&model,&http,"selected-lost-receiver-ack-replayed",|conn|acknowledged(conn,RECOVER)).await;
        assert!(retained.join("selected-owned-exit.json").exists());
        assert_eq!(fs::read(retained.join("selected-lost-receiver-frame.json")).unwrap(),fs::read(retained.join("selected-replayed-receiver-frame.json")).unwrap(),
            "cold owned-Pi restart returns the exact genuine original receiver bytes");
        let lost:Value=serde_json::from_slice(&fs::read(retained.join("selected-lost-receiver-frame.json")).unwrap()).unwrap();
        let evidence=command_evidence(&retained,RECOVER);
        assert_eq!(evidence["response"]["data"],queued,"Host queued response remains immutable after remote recovery");
        assert_eq!(evidence["deliveries"][0]["receiver_evidence"],lost["data"]);
        assert_eq!(lost["data"]["selected_task_recoveries"][0]["state"],"admitted");
        assert_eq!(lost["data"]["selected_task_recoveries"][0]["command_id"],observation["command_id"]);
        let running:Value=serde_json::from_slice(&fs::read(retained.join("selected-real-running.json")).unwrap()).unwrap();
        let submission=running["submission_id"].as_str().expect("original serialized SDK submission ID").to_owned();
        let submission_id: i64=serde_json::from_str(&submission).unwrap();
        assert!(submission_id>0);
        let owned_exit:Value=serde_json::from_slice(&fs::read(retained.join("selected-owned-exit.json")).unwrap()).unwrap();
        assert_eq!(owned_exit["submission_id"],running["submission_id"]);
        until(&host,&model,&http,"selected-original-submission-effect-unknown",|conn| {
            if !conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_turn_runs WHERE turn_id=?1 AND state='effect_unknown' AND submission_id=?2 AND entry_id IS NULL)",
                params![TURN,submission],|r|r.get::<_,bool>(0)).unwrap() {return false;}
            let latest=conn.query_row("SELECT latest_status_command_id FROM lifetime_turn_runs WHERE turn_id=?1",[TURN],|r|r.get::<_,String>(0)).unwrap();
            progressed_unknown_status(&host,&ghost,&conversation,&submission,&latest)
        }).await;
        // This disposable provider boundary is controlled. Production request
        // ambiguity before a crash still requires its retained evidence.
        assert_eq!(owner_requests(&model),owner_request_checkpoint,"cold restart cannot add Owner inference after the controlled running-ACK loss");
        assert_eq!(owner_request_checkpoint,0);
        assert!(projection_conflicts(&retained).is_empty(),"later truthful unknown cannot conflict with original status or SDK submission evidence");
        let original_submission=owner_submission(&host,&ghost,&conversation,submission_id);
        let original_submission_value:Value=serde_json::from_str(&original_submission).unwrap();
        let original_entry_id=original_submission_value["entry"].as_i64().expect("original placed Owner input entry");
        let original_entry:String=sdk_database(&retained,&ghost,&conversation).query_row("SELECT record FROM entries WHERE id=?1",[original_entry_id],|r|r.get(0)).unwrap();
        let recovered_sdk=recovered_sdk_task(&retained,&ghost,&conversation);
        let generations=owner_generations(&retained,&ghost,&conversation);
        assert_eq!(generations.len(),1,"one original Owner generation is retained before cancellation");
        let original_generation=generations[0].clone();
        let generation_id=original_generation["id"].as_i64().unwrap();
        assert_eq!(owned_exit["generation_id"].as_i64(),Some(generation_id),"cancellation must retain the exact generation observed before child loss");
        assert_ne!(original_generation["state"]["status"],"terminal");
        private_diagnostic(&retained,"selected-original-owner-sdk",&json!({"submission_id":submission,"generation_id":generation_id,
            "submission_state":original_submission_value["status"],"generation_state":original_generation["state"]["status"],"owner_provider_requests":owner_requests(&model)}));
        let calls=callback_calls(&retained);assert_eq!(calls.len(),2);assert_eq!(calls[0],calls[1]);
        assert_eq!(sdk_database(&retained,&ghost,&conversation).query_row("SELECT COUNT(*) FROM tasks WHERE kind=?1",
            [serde_json::to_string("ghost.selected-task-admission-recovery").unwrap()],|r|r.get::<_,i64>(0)).unwrap(),1,
            "same receiver redelivery cannot create another SDK recovery task");
        {
            let state=host.lock().unwrap();let conn=&state.journal.0;
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_turn_goals WHERE turn_id=?1",[TURN],|r|r.get::<_,i64>(0)).unwrap(),1);
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_work",[],|r|r.get::<_,i64>(0)).unwrap(),1);
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
            assert_eq!(conn.query_row("SELECT submission_id FROM lifetime_turn_runs WHERE turn_id=?1",[TURN],|r|r.get::<_,String>(0)).unwrap(),submission);
            assert_eq!(conn.query_row("SELECT request,response FROM lifetime_commands WHERE command_id=?1",[calls[0]["command_id"].as_str().unwrap()],
                |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap(),original_source);
        }
        assert_eq!(original_sdk_task(&retained,&ghost,&conversation),original);
        assert_original_unknown_status(&host,&ghost,&original_status);
        driver.pause(&host).await;
        assert_eq!(owner_submission(&host,&ghost,&conversation,submission_id),original_submission,
            "cold observation cannot rewrite or replace the original paused SDK submission");
        assert_eq!(owner_generations(&retained,&ghost,&conversation),generations,
            "cold observation cannot replace or resume the original Owner generation");
        let before=callback_calls(&retained);
        assert_eq!(successful(command(&retained,RECOVER,recovery.clone())),queued);
        assert_eq!(command_evidence(&retained,RECOVER),evidence);
        let mut foreign=recovery.clone();foreign["conversation_id"]=json!(uuid::Uuid::new_v4().to_string());
        assert_eq!(command(&retained,"operator-foreign-denied",foreign)["status"],"error");
        let mut stale=env("operator-stale-denied",recovery.clone());stale.authority_epoch=2;
        assert_eq!(control(&retained,stale)["error_code"],"authority_fenced");
        assert_eq!(command(&retained,"operator-submitted-denied",recovery)["error_code"],"selected_task_recovery_blocked");
        let work=calls[0]["work_id"].as_str().unwrap();
        let effects=completed_effects(&host,work);
        let cancellation=successful(command(&retained,"operator-cancel-original-owner",scoped(&ghost,&conversation,"conversation.cancel_turn",TURN)));
        assert_eq!(cancellation["run"]["submission_id"],running["submission_id"]);
        assert_eq!(cancellation["run"]["cancel_requested"],true);
        let driver=Driver::start(&host,entry.clone());
        until(&host,&model,&http,"selected-original-owner-cancellation-settled",|conn| {
            conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_turn_runs WHERE turn_id=?1 AND state='cancelled' AND cancel_requested=1 AND submission_id=?2 AND reason_code='owner_cancelled')",
                params![TURN,submission],|r|r.get::<_,bool>(0)).unwrap() && acknowledged(conn,"operator-cancel-original-owner")
        }).await;
        driver.pause(&host).await;
        let (cancellation_receipt,cancellation_receiver_id)={
            let state=host.lock().unwrap();
            state.journal.0.query_row("SELECT r.payload,r.receiver_command_id FROM lifetime_delivery_receipts r
              JOIN lifetime_outbox o ON o.id=r.outbox_id WHERE o.command_id=?1 AND o.target='pi' AND o.acknowledged=1",
                ["operator-cancel-original-owner"],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap()
        };
        let cancellation_receipt:Value=serde_json::from_str(&cancellation_receipt).unwrap();
        let cancellation_receiver=&cancellation_receipt["data"];
        assert_eq!(cancellation_receiver["command_id"],cancellation_receiver_id);
        assert_eq!(cancellation_receiver["ghost_id"],ghost);assert_eq!(cancellation_receiver["conversation_id"],conversation);
        assert_eq!(cancellation_receiver["runtime_kind"],"pi-durable");assert_eq!(cancellation_receiver["runtime_release"],"1.1.0");
        assert_eq!(cancellation_receiver["turn_id"],TURN);assert_eq!(cancellation_receiver["cancel_requested"],true);
        assert!(cancellation_receiver["storage_ref"].as_str().is_some_and(|value|!value.is_empty()));
        let settled:Value=serde_json::from_str(&owner_submission(&host,&ghost,&conversation,submission_id)).unwrap();
        assert_eq!(settled["status"],"unanswered");assert_eq!(settled["reason"],"aborted");
        for key in ["id","conversationId","requestId","type","entry"] {assert_eq!(settled[key],original_submission_value[key],"original Owner submission identity {key} changed");}
        assert_eq!(sdk_database(&retained,&ghost,&conversation).query_row("SELECT record FROM entries WHERE id=?1",[original_entry_id],|r|r.get::<_,String>(0)).unwrap(),original_entry,
            "exact Owner cancellation cannot rewrite its committed input entry");
        let after_generations=owner_generations(&retained,&ghost,&conversation);
        let original_generation_ids=generations.iter().map(|task|task["id"].as_i64().unwrap()).collect::<Vec<_>>();
        let retained_generation_ids=after_generations.iter().map(|task|task["id"].as_i64().unwrap()).collect::<Vec<_>>();
        assert_eq!(retained_generation_ids,original_generation_ids,"exact Owner cancellation cannot add a replacement SDK generation");
        assert_eq!(after_generations.len(),generations.len(),"exact Owner cancellation must retain the original generation count");
        let cancelled_generation=after_generations.iter().find(|task|task["id"].as_i64()==Some(generation_id)).expect("original Owner generation retained");
        for key in ["id","conversationId","kind","version","input","owner","background"] {assert_eq!(cancelled_generation[key],original_generation[key],"original generation identity {key} changed");}
        assert_eq!(cancelled_generation["abortRequested"],true);assert_eq!(cancelled_generation["state"]["status"],"terminal");
        assert_eq!(cancelled_generation["state"]["outcome"]["status"],"aborted");
        assert_eq!(owner_requests(&model),owner_request_checkpoint,"cancelling the original placed input cannot add inference or admit a replacement Owner run");
        assert!(projection_conflicts(&retained).is_empty(),"exact cancellation must not hide a status or submission projection conflict");
        let after_effects=completed_effects(&host,work);
        for effect in effects {assert!(after_effects.contains(&effect),"Owner cancellation rewrote an admitted Work effect receipt");}
        {
            let state=host.lock().unwrap();let conn=&state.journal.0;
            let retained_work:(String,String)=conn.query_row("SELECT goal_id,cancellation FROM lifetime_work WHERE id=?1",[work],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(retained_work.0,calls[0]["goal_id"].as_str().unwrap());assert_eq!(retained_work.1,"none");
            assert_eq!(conn.query_row("SELECT request,response FROM lifetime_commands WHERE command_id=?1",[calls[0]["command_id"].as_str().unwrap()],
                |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap(),original_source);
        }
        assert_eq!(original_sdk_task(&retained,&ghost,&conversation),original);
        assert_eq!(recovered_sdk_task(&retained,&ghost,&conversation),recovered_sdk);
        assert_original_unknown_status(&host,&ghost,&original_status);
        assert_eq!(command_evidence(&retained,RECOVER),evidence);
        assert_eq!(fs::read(retained.join("selected-lost-receiver-frame.json")).unwrap(),fs::read(retained.join("selected-replayed-receiver-frame.json")).unwrap());
        let mut cancelled=scoped(&ghost,&conversation,"conversation.selected_task.reconcile",TURN);cancelled["operation_id"]=json!(operation);
        assert_eq!(command(&retained,"operator-cancelled-recovery-denied",cancelled)["error_code"],"selected_task_recovery_blocked");
        assert_eq!(callback_calls(&retained),before);
        let reopened=Journal::open(&retained.join("workspace.db")).unwrap();
        let cold=lifetime::apply(&reopened.0,&env("cold-receipt-read",json!({"method":"command.inspect","command_id":RECOVER})),"owner").unwrap();
        assert_eq!(serde_json::to_value(cold).unwrap()["data"],evidence,"fresh Host ledger connection reads the original correlated receiver receipt");
        let host_run=successful(command(&retained,"operator-final-owner-state",scoped(&ghost,&conversation,"conversation.turn.inspect",TURN)))["run"].clone();
        private_diagnostic(&retained,"selected-operator-result",&json!({"scope":"actual_authenticated_control_owned_pi_controlled_provider",
            "goal_callbacks":calls.len(),"owner_provider_requests":owner_requests(&model),"total_provider_requests":model.requests(),
            "original_operation_id":operation,"receiver_command_id":queued["receiver_command_id"],"host_run":host_run,
            "original_submission_id":submission,"original_generation_id":generation_id,
            "p2_submission_completion":"exact_original_owner_submission_cancelled_after_genuine_process_loss"}));
        model.clean();assert!(http.errors().is_empty());
        host.shutdown().await.unwrap();drop(http);
    }
}
