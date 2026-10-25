//! Real Chrome in fresh registry-owned profiles, with fixture-only HTTP data.
use super::{tests::{envelope,request,setup_with_privacy,setup_with_spec,Fixture},PiInferenceScope,PiToolRequest};
use anyhow::{ensure,Result};
use crate::{adapters::computer::{ComputerOperation,BrowserOperation},lifetime_contract::ResponseStatus};
use serde_json::{json,Value};
use std::{io::{Read,Write},net::TcpListener,path::Path,sync::{Arc,atomic::{AtomicBool,AtomicU64,Ordering}},time::Duration};

struct Server {url:String,stop:Arc<AtomicBool>,changes:Arc<AtomicU64>,thread:Option<std::thread::JoinHandle<()>>}
impl Server {
    fn new()->Result<Self> {
        let listener=TcpListener::bind("127.0.0.1:0")?;let url=format!("http://{}",listener.local_addr()?);listener.set_nonblocking(true)?;
        let stop=Arc::new(AtomicBool::new(false));let signal=Arc::clone(&stop);let changes=Arc::new(AtomicU64::new(0));let effects=Arc::clone(&changes);
        let thread=std::thread::spawn(move||while !signal.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((mut peer,_))=>{
                    let _=peer.set_read_timeout(Some(Duration::from_secs(2)));let mut bytes=[0;8192];
                    let count=peer.read(&mut bytes).unwrap_or(0);if count==0 {continue;} let request=String::from_utf8_lossy(&bytes[..count]);
                    if request.lines().next().is_some_and(|line|line.contains("/clicked")) {effects.fetch_add(1,Ordering::SeqCst);}
                    let set=request.lines().next().is_some_and(|line|line.contains("/set"));
                    let change=request.lines().next().is_some_and(|line|line.contains("/change"));
                    let body=if change {r#"<html><body><button onclick="document.getElementById('count').innerText=Number(document.getElementById('count').innerText)+1;fetch('/clicked')">Increment</button><span id="count">0</span><label>Name<input aria-label="Name"></label></body></html>"#}
                        else if set {"<html><body><script>localStorage.setItem('workSecret','work-a-only');document.cookie='workSecret=work-a-only; path=/';document.body.innerText='WORK_A '+localStorage.getItem('workSecret');</script></body></html>"}
                        else {"<html><body><script>document.body.innerText='STORAGE '+(localStorage.getItem('workSecret')||'NONE')+' COOKIE '+(document.cookie||'NONE');</script></body></html>"};
                    let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);let _=peer.write_all(response.as_bytes());
                },Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>std::thread::sleep(Duration::from_millis(10)),Err(_)=>break,
            }
        });Ok(Self {url,stop,changes,thread:Some(thread)})
    }
}
impl Drop for Server {fn drop(&mut self){self.stop.store(true,Ordering::Release);if let Some(thread)=self.thread.take(){let _=thread.join();}}}

async fn browser(f:&Fixture,task:u64,call:&str,args:Value)->Result<Value> {
    let response=f.host.lifetime_pi_execution_action(&request(f,task,call,"browser",args),PiInferenceScope::Local).await?;
    ensure!(response.status==ResponseStatus::Success,"Browser fixture response: {response:?}");Ok(response.data["output"].clone())
}
async fn complete(f:&Fixture)->Result<()> {
    let response=f.host.lifetime_pi_execution_action(&PiToolRequest {context_ref: None, ghost_id:f.ghost.clone(),conversation_id:f.conversation.clone(),envelope:envelope(&f.ghost,json!({"method":"work.execution.complete","assignment_id":f.assignment,"work_id":f.work,"task_id":7,"summary":"Observed isolated fixture browser"}))},PiInferenceScope::Local).await?;
    ensure!(response.status==ResponseStatus::Success,"Completion: {response:?}");Ok(())
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
#[ignore="real pinned Chrome isolated public/private browser profiles; no user profile"]
async fn real_pi_browser_private_work_profiles_owner_gate_and_birth_fence()->Result<()> {
    ensure!(std::env::var("GHOST_PI_RUN_BROWSER_CANARY").as_deref()==Ok("1"),"Explicit browser canary opt-in required");
    let executable=Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");ensure!(executable.is_file(),"Existing Chrome executable required; no installation attempted");
    let server=Server::new()?;let mut f=setup_with_privacy("Observe private fixture browser",json!({}),"private");
    f.host.pi_local_route=Some(crate::host::lifetime_runtime::LocalPiRoute {base_url:"http://127.0.0.1:9/v1".into(),model_id:"fixture-no-inference".into(),max_output_tokens:1024,callback_token:"fixture".into()});
    f.host.native_computers.as_mut().unwrap().attach_pi_fixture_browser(&f.ghost,executable,true)?;
    let result=async {
        let denied=f.host.lifetime_pi_execution_action(&request(&f,9,"public-denied","browser",json!({"operation":"read"})),PiInferenceScope::Public).await?;
        ensure!(denied.error_code.as_deref()==Some("disclosure_blocked"),"Protected browser was offered to a public model");
        let navigation=browser(&f,10,"navigate-a",json!({"operation":"navigate","url":format!("{}/set",server.url)})).await?;
        ensure!(navigation["load_settled"]==true,"Fast local navigation missed its load event: {navigation}");
        let read=browser(&f,11,"read-a",json!({"operation":"read"})).await?;ensure!(read["text"].as_str().unwrap_or_default().contains("work-a-only"),"Work A fixture marker missing: {read}");
        let first=f.host.native_computers.as_ref().unwrap().pi_fixture_browser_instance(&f.ghost)?.ok_or_else(||anyhow::anyhow!("Work A instance missing"))?;
        let first_execution=first["lease_execution_id"].as_str().unwrap().to_string();
        let owner=f.host.native_computers.as_ref().unwrap().conversation_backend().unwrap();let authorize=||Ok(());
        ensure!(owner.execute(&f.ghost,ComputerOperation::Browser(BrowserOperation::Read),&authorize).await.is_err(),"Owner conversation entered active Work browser");
        let read=browser(&f,12,"read-after-owner-refusal",json!({"operation":"read"})).await?;ensure!(read["text"].as_str().unwrap_or_default().contains("work-a-only"),"Competing owner stopped the Work browser");
        let reopened=f.host.native_computers.as_ref().unwrap().pi_fixture_reopened_browser()?;
        let mut forged=first.clone();forged["start_identity"]=json!("foreign-process-birth");f.host.native_computers.as_ref().unwrap().pi_fixture_replace_browser_instance(&forged)?;
        ensure!(reopened.stop_registered_instance(first["computer_id"].as_str().unwrap()).is_err(),"Reopened cleanup trusted a foreign PID birth");
        f.host.native_computers.as_ref().unwrap().pi_fixture_replace_browser_instance(&first)?;
        let read=browser(&f,13,"read-after-birth-refusal",json!({"operation":"read"})).await?;ensure!(read["text"].as_str().unwrap_or_default().contains("work-a-only"),"Birth fence killed the wrong browser");
        let first_snapshot=browser(&f,14,"snapshot-one",json!({"operation":"snapshot"})).await?;
        let next_snapshot=browser(&f,15,"snapshot-two",json!({"operation":"snapshot"})).await?;
        ensure!(next_snapshot["snapshot_id"].as_u64()>first_snapshot["snapshot_id"].as_u64(),"Browser reused a stale observation identity");
        complete(&f).await?;
        {let state=f.host.lock()?;let admitted=super::super::apply(&state.journal.0,&envelope("owner",json!({"method":"goal.submit","ghost_id":f.ghost,"conversation_id":f.conversation,"prompt":"Observe second private fixture","privacy":"private","acceptance_spec":{}})),"owner")?;
            ensure!(admitted.status==ResponseStatus::Success,"Work B admission failed: {admitted:?}");f.work=admitted.data["work"]["id"].as_str().unwrap().into();
            f.assignment=state.journal.0.query_row("SELECT delivery_ref FROM lifetime_outbox WHERE json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1 ORDER BY id DESC LIMIT 1",[&f.work],|row|row.get(0))?;}
        browser(&f,20,"navigate-b",json!({"operation":"navigate","url":format!("{}/read",server.url)})).await?;
        let read=browser(&f,21,"read-b",json!({"operation":"read"})).await?;ensure!(read["text"]=="STORAGE NONE COOKIE NONE","Work B inherited Work A browser state: {read}");
        let second=f.host.native_computers.as_ref().unwrap().pi_fixture_browser_instance(&f.ghost)?.unwrap();ensure!(first["profile_dir"]!=second["profile_dir"],"Work profiles are shared");
        f.host.native_computers.as_ref().unwrap().pi_browser_stop(&f.ghost,&first_execution).await?;
        let read=browser(&f,22,"read-after-old-cleanup",json!({"operation":"read"})).await?;ensure!(read["text"]=="STORAGE NONE COOKIE NONE","Old Work cleanup touched Work B");
        complete(&f).await?;Ok::<_,anyhow::Error>(())
    }.await;
    // Every test-created instance belongs to this fresh registry and is cleaned
    // by exact recorded execution identity, including a failed assertion path.
    let current=f.host.native_computers.as_ref().unwrap().pi_fixture_browser_instance(&f.ghost)?;
    if let Some(current)=current {let _=f.host.native_computers.as_ref().unwrap().pi_browser_stop(&f.ghost,current["lease_execution_id"].as_str().unwrap()).await;}
    result
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
#[ignore="real pinned Chrome public Work profile and local-network denial; no user profile"]
async fn real_pi_browser_public_snapshot_and_private_network_denial()->Result<()> {
    ensure!(std::env::var("GHOST_PI_RUN_BROWSER_CANARY").as_deref()==Ok("1"),"Explicit browser canary opt-in required");
    let mut f=setup_with_spec(json!({}));
    f.host.native_computers.as_mut().unwrap().attach_pi_fixture_browser(&f.ghost,Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),false)?;
    let result=async {
        let snapshot=f.host.lifetime_pi_execution_action(&request(&f,10,"public-snapshot","browser",json!({"operation":"snapshot"})),PiInferenceScope::Public).await?;
        ensure!(snapshot.status==ResponseStatus::Success,"Public Chrome snapshot failed: {snapshot:?}");
        let record=f.host.native_computers.as_ref().unwrap().pi_fixture_browser_instance(&f.ghost)?.ok_or_else(||anyhow::anyhow!("Public instance missing"))?;
        ensure!(record["profile_dir"].as_str().unwrap().contains("/public/pi-work-"),"Public Work profile was not isolated");
        let denied=f.host.lifetime_pi_execution_action(&request(&f,11,"private-network-refused","browser",json!({"operation":"navigate","url":"http://127.0.0.1:9/private-marker"})),PiInferenceScope::Public).await?;
        ensure!(denied.error_code.as_deref()==Some("effect_unknown"),"Private network access was accepted");
        let state=f.host.lock()?;let raw:String=state.journal.0.query_row("SELECT response_json FROM lifetime_pi_effects WHERE call_id='private-network-refused'",[],|row|row.get(0))?;
        let stored:Value=serde_json::from_str(&raw)?;ensure!(stored["data"]["process_state"]=="stopped","Rejected public browser was not stopped");Ok::<_,anyhow::Error>(())
    }.await;
    if let Some(record)=f.host.native_computers.as_ref().unwrap().pi_fixture_browser_instance(&f.ghost)? {let _=f.host.native_computers.as_ref().unwrap().pi_browser_stop(&f.ghost,record["lease_execution_id"].as_str().unwrap()).await;}
    result
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
#[ignore="real isolated Chrome Owner approval bridge and durable crash windows"]
async fn real_pi_browser_owner_approval_wait_ack_reopen_and_unknown_fence()->Result<()> {
    ensure!(std::env::var("GHOST_PI_RUN_BROWSER_CANARY").as_deref()==Ok("1"),"Explicit browser canary opt-in required");
    let server=Server::new()?;let mut f=setup_with_privacy("Change only approved fixture button",json!({}),"private");
    f.host.pi_local_route=Some(crate::host::lifetime_runtime::LocalPiRoute {base_url:"http://127.0.0.1:9/v1".into(),model_id:"fixture-no-inference".into(),max_output_tokens:1024,callback_token:"fixture".into()});
    f.host.native_computers.as_mut().unwrap().attach_pi_fixture_browser(&f.ghost,Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),true)?;
    let result=async {
        browser(&f,10,"navigate-change",json!({"operation":"navigate","url":format!("{}/change",server.url)})).await?;
        let observed=browser(&f,11,"observe-change",json!({"operation":"snapshot"})).await?;
        let button=observed["elements"].as_array().unwrap().iter().find(|e|e["role"]=="button" && e["name"]=="Increment").ok_or_else(||anyhow::anyhow!("Fixture button missing: {observed}"))?;
        let call=request(&f,12,"approved-click","browser",json!({"operation":"click","ref":button["ref"],"snapshot_id":observed["snapshot_id"]}));
        let first=f.host.lifetime_pi_execution_action(&call,PiInferenceScope::Local).await?;
        ensure!(first.status==ResponseStatus::Warning && first.data["receipt"]["state"]=="waiting_owner","Mutation did not wait: {first:?}");
        let action=first.data["action_id"].as_str().unwrap();let execution=first.data["receipt"]["execution_id"].as_str().unwrap();
        let read=||async {f.host.native_computers.as_ref().unwrap().pi_browser_execute(&f.ghost,execution,BrowserOperation::Read,&||Ok(())).await};
        ensure!(read().await?["text"].as_str().unwrap().contains("0"),"Mutation ran before approval");
        // Lost Host ACK: recover proposal identity from registry, not a new action.
        {let state=f.host.lock()?;state.journal.0.execute("UPDATE lifetime_pi_effects SET response_json=NULL WHERE call_id='approved-click'",[])?;}
        let recovered=f.host.lifetime_pi_execution_action(&call,PiInferenceScope::Local).await?;
        ensure!(recovered.data["action_id"]==action,"ACK loss multiplied approval identity");
        // Owner waiting time exceeds the active budget, but cannot consume it.
        {let state=f.host.lock()?;state.journal.0.execute("UPDATE lifetime_pi_executions SET created_ms=?1,deadline_ms=10000",[crate::host::now_ms()-20000])?;state.journal.0.execute("UPDATE lifetime_pi_effects SET wait_started_ms=?1 WHERE call_id='approved-click'",[crate::host::now_ms()-20000])?;}
        let reopened=crate::host::scheduler::Journal::open(&f.host.root.join("workspace.db"))?;
        f.host.lock()?.journal=reopened;
        let waiting=f.host.lifetime_pi_execution_action(&call,PiInferenceScope::Local).await?;
        ensure!(waiting.data["action_id"]==action,"Cold journal reopen multiplied action identity");
        let decided=crate::adapters::computer::control(&f.host,&f.ghost,"approve_browser_action",Some(action)).await?;
        ensure!(decided["wake"]["status"]=="success","Owner decision missed Pi route: {decided}");
        let done=f.host.lifetime_pi_execution_action(&call,PiInferenceScope::Local).await?;
        ensure!(done.status==ResponseStatus::Success,"Approved effect failed: {done:?}");
        ensure!(f.host.lock()?.journal.0.query_row("SELECT paused_ms>=20000 FROM lifetime_pi_executions",[],|r|r.get::<_,bool>(0))?,"Owner wait consumed active execution budget");
        ensure!(read().await?["text"].as_str().unwrap().contains("1"),"Approved actual click did not execute");
        let replay=f.host.lifetime_pi_execution_action(&call,PiInferenceScope::Local).await?;
        ensure!(serde_json::to_value(replay)?==serde_json::to_value(done)?,"Receipt replay changed");
        ensure!(read().await?["text"].as_str().unwrap().contains("1"),"Same call clicked twice");
        let observed=browser(&f,13,"observe-second",json!({"operation":"snapshot"})).await?;
        let button=observed["elements"].as_array().unwrap().iter().find(|e|e["role"]=="button").unwrap();
        let denied=request(&f,14,"denied-click","browser",json!({"operation":"click","ref":button["ref"],"snapshot_id":observed["snapshot_id"]}));
        let waiting=f.host.lifetime_pi_execution_action(&denied,PiInferenceScope::Local).await?;
        let deny_action=waiting.data["action_id"].as_str().unwrap();
        crate::adapters::computer::control(&f.host,&f.ghost,"deny_browser_action",Some(deny_action)).await?;
        let denied=f.host.lifetime_pi_execution_action(&denied,PiInferenceScope::Local).await?;
        ensure!(denied.data["receipt"]["state"]=="denied" && denied.data["host_effect_class"]=="no_effect","Denial lost identity/no-effect: {denied:?}");
        ensure!(read().await?["text"].as_str().unwrap().contains("1"),"Denied click executed");
        // Reserve after approval then crash before ACK: ambiguity blocks every ID.
        let unknown=request(&f,15,"crashed-click","browser",json!({"operation":"click","ref":button["ref"],"snapshot_id":observed["snapshot_id"]}));
        let waiting=f.host.lifetime_pi_execution_action(&unknown,PiInferenceScope::Local).await?;
        crate::adapters::computer::control(&f.host,&f.ghost,"approve_browser_action",waiting.data["action_id"].as_str()).await?;
        f.host.lock()?.journal.0.execute("UPDATE lifetime_pi_effects SET state='pending',response_json=NULL WHERE call_id='crashed-click'",[])?;
        let response=f.host.lifetime_pi_execution_action(&unknown,PiInferenceScope::Local).await?;
        ensure!(response.data["receipt"]["state"]=="unknown","Reserved effect replayed");
        let changed=request(&f,16,"different-after-crash","browser",json!({"operation":"click","ref":button["ref"],"snapshot_id":observed["snapshot_id"]}));
        let response=f.host.lifetime_pi_execution_action(&changed,PiInferenceScope::Local).await?;
        ensure!(response.error_code.as_deref()==Some("effect_unknown"),"New ID escaped durable unresolved effect");
        ensure!(read().await?["text"].as_str().unwrap().contains("1"),"Unknown effect was replayed");
        ensure!(f.host.lock()?.journal.0.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'",[],|r|r.get::<_,i64>(0))?==0,"Pi approval queued worker traffic");
        Ok::<_,anyhow::Error>(())
    }.await;
    if let Some(record)=f.host.native_computers.as_ref().unwrap().pi_fixture_browser_instance(&f.ghost)? {let _=f.host.native_computers.as_ref().unwrap().pi_browser_stop(&f.ghost,record["lease_execution_id"].as_str().unwrap()).await;}
    result
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
#[ignore="real isolated Chrome waiting mutation cancellation/epoch/grant/stale-target fences"]
async fn real_pi_browser_wait_revocation_never_dispatches_mutation()->Result<()> {
    ensure!(std::env::var("GHOST_PI_RUN_BROWSER_CANARY").as_deref()==Ok("1"),"Explicit browser canary opt-in required");
    let server=Server::new()?;
    for mode in ["cancel","epoch","grant","stale"] {
        let mut f=setup_with_privacy("Wait only on exact approved fixture",json!({}),"private");
        f.host.pi_local_route=Some(crate::host::lifetime_runtime::LocalPiRoute {base_url:"http://127.0.0.1:9/v1".into(),model_id:"fixture-no-inference".into(),max_output_tokens:1024,callback_token:"fixture".into()});
        f.host.native_computers.as_mut().unwrap().attach_pi_fixture_browser(&f.ghost,Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),true)?;
        let result=async {
            browser(&f,10,"navigate",json!({"operation":"navigate","url":format!("{}/change",server.url)})).await?;
            let snapshot=browser(&f,11,"snapshot",json!({"operation":"snapshot"})).await?;
            let button=snapshot["elements"].as_array().unwrap().iter().find(|e|e["role"]=="button").unwrap();
            let call=request(&f,12,"waiting-mutation","browser",json!({"operation":"click","ref":button["ref"],"snapshot_id":snapshot["snapshot_id"]}));
            let waiting=f.host.lifetime_pi_execution_action(&call,PiInferenceScope::Local).await?;
            ensure!(waiting.data["receipt"]["state"]=="waiting_owner","No known wait: {waiting:?}");
            let action=waiting.data["action_id"].as_str().unwrap();let execution=waiting.data["receipt"]["execution_id"].as_str().unwrap();
            match mode {
                "cancel"=>{f.host.lifetime_action(&envelope("owner",json!({"method":"work.cancel","work_id":f.work})))?;},
                "epoch"=>{f.host.lock()?.journal.0.execute("UPDATE lifetime_authority SET authority_epoch=2",[])?;},
                "grant"=>{f.host.native_computers.as_ref().unwrap().pi_release(&f.ghost,execution,1)?;},
                "stale"=>{
                    f.host.native_computers.as_ref().unwrap().pi_browser_execute(&f.ghost,execution,BrowserOperation::Snapshot,&||Ok(())).await?;
                    crate::adapters::computer::control(&f.host,&f.ghost,"approve_browser_action",Some(action)).await?;
                },_=>unreachable!()
            }
            let denied=f.host.lifetime_pi_execution_action(&call,PiInferenceScope::Local).await?;
            ensure!(denied.data["receipt"]["state"]=="denied" && denied.data["host_effect_class"]=="no_effect","{mode} wait was not a known no-effect denial: {denied:?}");
            tokio::time::sleep(Duration::from_millis(100)).await;
            ensure!(server.changes.load(Ordering::SeqCst)==0,"{mode} wait dispatched an actual HTTP-visible button effect");
            let state=f.host.lock()?;let row:(String,String)=state.journal.0.query_row("SELECT state,response_json FROM lifetime_pi_effects WHERE call_id='waiting-mutation'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
            ensure!(row.0=="complete" && serde_json::from_str::<Value>(&row.1)?["data"]["receipt"]["state"]=="denied","Revoked wait did not durably close without effect");
            Ok::<_,anyhow::Error>(())
        }.await;
        if let Some(record)=f.host.native_computers.as_ref().unwrap().pi_fixture_browser_instance(&f.ghost)? {let _=f.host.native_computers.as_ref().unwrap().pi_browser_stop(&f.ghost,record["lease_execution_id"].as_str().unwrap()).await;}
        result?;
    }
    Ok(())
}
