//! Known no-effect browser waits may resume exactly once after an Owner decision.
use super::*;
impl Host {
    pub(super) fn reconcile_revoked_pi_wait(&self,request:&PiToolRequest,scope:PiInferenceScope)->Result<Option<(Response,String)>> {
        let body=&request.envelope.body;
        if body["method"]!="work.execute" {return Ok(None);}
        let state=self.lock()?;let conn=&state.journal.0;
        let binding:Option<(String,String,u64,String,u64)>=conn.query_row("SELECT e.execution_id,e.privacy,e.authority_epoch,e.computer_id,e.generation_task_id FROM lifetime_pi_executions e JOIN lifetime_pi_effects f ON f.execution_id=e.execution_id WHERE e.work_id=?1 AND e.ghost_id=?2 AND e.conversation_id=?3 AND e.assignment_id=?4 AND f.task_id=?5 AND f.call_id=?6 AND f.state='waiting_owner'",params![body["work_id"].as_str(),request.ghost_id,request.conversation_id,body["assignment_id"].as_str(),body["task_id"].as_u64(),body["call_id"].as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
        let Some((execution,privacy,epoch,computer,generation))=binding else {return Ok(None);};
        if privacy!="public" && scope!=PiInferenceScope::Local {return Ok(None);}
        ensure!(body["generation_task_id"]==generation,"Pi generation identity conflict");
        let digest=canonical_digest(&json!({"operation":body["operation"],"arguments":body["arguments"]}))?;
        let original:String=conn.query_row("SELECT input_digest FROM lifetime_pi_effects WHERE execution_id=?1 AND task_id=?2 AND call_id=?3",params![execution,body["task_id"].as_u64(),body["call_id"].as_str()],|r|r.get(0))?;
        ensure!(body["input_digest"]==digest && original==digest,"Pi waiting call input changed");
        let work=db::work(conn,apply::string_field(body,"work_id")?)?.ok_or_else(||anyhow!("Pi Work missing"))?;
        let revoked=self.check_pi_host_scope(&state,request,scope)?.is_some() || pi_tools::guard(conn,request,scope)?.is_some()
            || work.cancellation!="none" || work.state!="running" || !graph::current_result_scope(conn,&work)?
            || !self.native_computers.as_ref().is_some_and(|c|c.pi_current(&request.ghost_id,&execution,&computer,epoch,&privacy).unwrap_or(false));
        if !revoked {return Ok(None);}
        let response=browser_denied(body,&execution,"Original browser wait was revoked before any mutation dispatch");
        let tx=conn.unchecked_transaction()?;
        pause_finished(&tx,&execution,body)?;
        tx.execute("UPDATE lifetime_pi_effects SET state='complete',response_json=?1 WHERE execution_id=?2 AND task_id=?3 AND call_id=?4 AND state='waiting_owner'",params![serde_json::to_string(&response)?,execution,body["task_id"].as_u64(),body["call_id"].as_str()])?;tx.commit()?;
        Ok(Some((response,execution)))
    }

    pub(super) async fn prepare_pi_browser_effect(&self,request:&PiToolRequest,scope:PiInferenceScope,execution:&str,authorize:&(dyn Fn()->Result<()>+Send+Sync))->Result<Option<Response>> {
        let body=&request.envelope.body;
        let computers=self.native_computers.as_ref().ok_or_else(||anyhow!("Pi browser missing"))?;
        authorize()?;
        let approval_digest=canonical_digest(&json!({"execution_id":execution,"task_id":body["task_id"],"call_id":body["call_id"],"input_digest":body["input_digest"]}))?;
        let action=match computers.pi_browser_proposal(&request.ghost_id,execution,&approval_digest,&body["arguments"]).await {
            Ok(action)=>action,
            Err(error)=>return Ok(Some(browser_denied(body,execution,&format!("Exact browser approval unavailable: {error}")))),
        };
        ensure!(action.arguments_digest==approval_digest && action.execution_id==execution && action.requested_epoch==request.envelope.authority_epoch,"Browser proposal identity conflict");
        if action.state=="pending" {
            let mut response=apply::success("Waiting for Owner decision on this exact observed browser action",vec![action.action_id.clone()],json!({"receipt":receipt(body,execution,"waiting_owner"),"action_id":action.action_id,"host_effect_class":"no_effect"}));
            response.status=ResponseStatus::Warning;
            return Ok(Some(response));
        }
        if action.state!="approved" {return Ok(Some(browser_denied(body,execution,"Owner action was denied, expired, or already consumed")));}
        if !computers.pi_browser_approval_current(&request.ghost_id,execution,&action).await? {
            return Ok(Some(browser_denied(body,execution,"Approved browser target changed; a fresh observation and new exact question are required")));
        }
        // Durable reservation precedes approval consumption and all raw effects.
        // A crash from this point leaves pending/unknown and can never replay.
        {
            let state=self.lock()?;
            ensure!(self.work_memory_effect_current(&state,request,scope)?.is_none(),"Work memory authorization changed");
            let tx=state.journal.0.unchecked_transaction()?;
            let changed=tx.execute("UPDATE lifetime_pi_effects SET state='pending' WHERE execution_id=?1 AND task_id=?2 AND call_id=?3 AND input_digest=?4 AND state='waiting_owner'",params![execution,body["task_id"].as_u64(),body["call_id"].as_str(),body["input_digest"].as_str()])?;
            ensure!(changed==1,"Browser effect was already reserved; outcome must reconcile without replay");
            pause_finished(&tx,execution,body)?;
            tx.commit()?;
        }
        authorize()?;
        computers.pi_browser_claim(&action.action_id,&action.arguments_digest)?;
        authorize()?;
        Ok(None)
    }
}
fn browser_denied(body:&Value,execution:&str,reason:&str)->Response {
    let mut response=failure("browser_action_denied",reason);
    response.data=json!({"receipt":receipt(body,execution,"denied"),"host_effect_class":"no_effect"});response
}

pub(super) fn pause_finished(conn:&Connection,execution:&str,body:&Value)->Result<()> {
    conn.execute("UPDATE lifetime_pi_executions SET paused_ms=paused_ms+COALESCE((SELECT ?2-wait_started_ms FROM lifetime_pi_effects WHERE execution_id=?1 AND task_id=?3 AND call_id=?4),0) WHERE execution_id=?1",params![execution,crate::host::now_ms(),body["task_id"].as_u64(),body["call_id"].as_str()])?;
    conn.execute("UPDATE lifetime_pi_effects SET wait_started_ms=NULL WHERE execution_id=?1 AND task_id=?2 AND call_id=?3",params![execution,body["task_id"].as_u64(),body["call_id"].as_str()])?;Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn schema_sixteen_preserves_original_complete_receipts_on_upgrade()->Result<()> {
        let f=super::super::tests::setup_with_spec(json!({}));
        let call=super::super::tests::request(&f,10,"old-complete","write",json!({"path":"retained.txt","content":"retained"}));
        f.host.lifetime_pi_execution_action(&call,PiInferenceScope::Public).await?;
        let original:String={let state=f.host.lock()?;let conn=&state.journal.0;
            let original:String=conn.query_row("SELECT response_json FROM lifetime_pi_effects",[],|r|r.get(0))?;
            conn.execute_batch("ALTER TABLE lifetime_pi_effects RENAME TO pi_effects_tmp;")?;
            conn.execute_batch(include_str!("../../../../contracts/lifetime/migration-015.sql"))?;
            conn.execute_batch("INSERT INTO lifetime_pi_effects SELECT execution_id,task_id,call_id,input_digest,operation,arguments_json,state,response_json FROM pi_effects_tmp; DROP TABLE pi_effects_tmp; ALTER TABLE lifetime_pi_executions DROP COLUMN paused_ms; PRAGMA user_version=15;")?;
            original};
        let reopened=crate::host::scheduler::Journal::open(&f.host.root.join("workspace.db"))?;
        let retained:String=reopened.0.query_row("SELECT response_json FROM lifetime_pi_effects",[],|r|r.get(0))?;
        ensure!(original==retained,"Additive upgrade rewrote a historical receipt");
        reopened.0.execute("UPDATE lifetime_pi_effects SET state='waiting_owner',wait_started_ms=1",[])?;
        Ok(())
    }
}

#[cfg(test)]
mod input_tests {
    use super::*;
    #[tokio::test]
    async fn pi_invalid_file_input_is_known_no_effect_and_inspection_hides_host_paths()->Result<()> {
        let f=super::super::tests::setup_with_spec(json!({}));
        for (task,path) in [(10,"/private/host/secret.txt"),(11,"../outside.txt")] {
            let denied=f.host.lifetime_pi_execution_action(&super::super::tests::request(&f,task,"invalid","write",json!({"path":path,"content":"never"})),PiInferenceScope::Public).await?;
            ensure!(denied.data["receipt"]["state"]=="denied" && denied.data["host_effect_class"]=="no_effect","Bad path became ambiguous: {denied:?}");
        }
        let missing=f.host.lifetime_pi_execution_action(&super::super::tests::request(&f,12,"missing","read",json!({"path":"missing.txt"})),PiInferenceScope::Public).await?;
        ensure!(missing.data["receipt"]["state"]=="denied","Missing read became unknown: {missing:?}");
        let write=f.host.lifetime_pi_execution_action(&super::super::tests::request(&f,13,"valid","write",json!({"path":"answer.txt","content":"valid"})),PiInferenceScope::Public).await?;
        ensure!(write.status==ResponseStatus::Success,"Known refusal blocked correction: {write:?}");
        let inspected=PiToolRequest {context_ref: None, ghost_id:f.ghost.clone(),conversation_id:f.conversation.clone(),envelope:super::super::tests::envelope(&f.ghost,json!({"method":"work.inspect","work_id":f.work}))};
        let state=f.host.lock()?;
        let response=pi_tools::apply(&state.journal.0,&inspected,PiInferenceScope::Public,f.host.native_computers.as_ref())?;
        ensure!(response.data.get("worker_grant").is_none() && response.data["execution"]["cwd"]=="/workspace","Pi inspection exposed legacy grant: {response:?}");
        ensure!(!serde_json::to_string(&response)?.contains(f.host.root.to_str().unwrap()),"Pi inspection leaked Host storage path");
        Ok(())
    }
}
