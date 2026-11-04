//! Host-owned Pi controller ingress. Model arguments never confer owner authority.
use super::{apply::{self}, authority, db};
use crate::lifetime_contract::{Envelope, Goal, Response, ResponseStatus, RetryClass, Work};
use anyhow::{anyhow, ensure, Result};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PiToolRequest {
    #[serde(default)]
    pub(crate) context_ref: Option<String>,
    pub(crate) ghost_id: String,
    pub(crate) conversation_id: String,
    pub(crate) envelope: Envelope,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum PiInferenceScope { Public, Local, Selected }

fn denied(code: &str, summary: &str) -> Response {
    Response {
        status: ResponseStatus::Error, summary: summary.into(), object_refs: vec![],
        artifacts: vec![], next_actions: vec!["inspect_authenticated_scope".into()],
        error_code: Some(code.into()), retry_class: RetryClass::Never, data: Value::Null,
    }
}

fn owned_goal(conn: &Connection, request: &PiToolRequest, id: &str) -> Result<Option<Goal>> {
    Ok(db::goal(conn, id)?.filter(|goal| {
        goal.accountable_ghost == request.ghost_id && goal.reply_conversation == request.conversation_id
    }))
}

fn owned_work(conn: &Connection, request: &PiToolRequest, id: &str) -> Result<Option<(Work, Goal)>> {
    let Some(work) = db::work(conn, id)? else { return Ok(None); };
    if work.owner != request.ghost_id { return Ok(None); }
    let Some(goal) = owned_goal(conn, request, &work.goal_id)? else { return Ok(None); };
    Ok(Some((work, goal)))
}

pub(crate) fn guard(conn: &Connection, request: &PiToolRequest, scope: PiInferenceScope) -> Result<Option<Response>> {
    let envelope = &request.envelope;
    // Reusable after I/O: the captured immutable envelope is validated once at ingress.
    if let Some(response) = authority::guard(conn, envelope)? { return Ok(Some(response)); }
    if envelope.actor_ref != request.ghost_id {
        return Ok(Some(denied("unauthorized", "Pi controller scope does not match envelope actor")));
    }
    let Some(binding) = db::binding(conn, &request.conversation_id)? else {
        return Ok(Some(denied("unauthorized", "Pi conversation scope is not bound")));
    };
    if binding.ghost_id != request.ghost_id || binding.runtime_kind != "pi-durable" {
        return Ok(Some(denied("unauthorized", "Pi conversation scope is not bound to this Ghost")));
    }
    let isolated=match super::work_context::validate(conn,request) {
        Ok(work)=>work,
        Err(_error)=>{
            #[cfg(test)]
            crate::control::server::pi_test_http::observe_context_error(request,&_error);
            return Ok(Some(denied("execution_context_fenced", "Original isolated Pi context authority is unavailable")));
        }
    };
    if super::super::shared_skills::request_guard(conn,request,scope).is_err() {
        return Ok(Some(denied("shared_skill_scope_blocked", "Current shared skill reader or assignment authority is unavailable")));
    }
    let method = apply::string_field(&envelope.body, "method")?;
    let draining: bool = conn.query_row(
        "SELECT mode='draining' FROM lifetime_registry WHERE ghost_id=?1",
        [&request.ghost_id], |row| row.get(0),
    ).optional()?.unwrap_or(false);
    if draining && !authority::read_only(Some(method)) && !matches!(method, "work.cancel" | "conversation.reply" | "conversation.report.reply" | "conversation.turn_status") {
        return Ok(Some(denied("waiting_host", "Ghost is draining; new model-owned admission is disabled")));
    }
    let public=if let Some(work)=&isolated {super::pi_execution::privacy(conn,work)?=="public"}else{super::conversation_is_public(conn, &request.ghost_id, &request.conversation_id)?};
    if scope == PiInferenceScope::Public && !public {
        return Ok(Some(denied("disclosure_blocked", "Non-public conversation requires an accepted local model route")));
    }
    if scope == PiInferenceScope::Selected && method != "inference.settings"
        && !public
        && !super::super::inference::external_allowed(conn, &request.ghost_id, &request.conversation_id)? {
        return Ok(Some(denied("disclosure_blocked", "This provider has no Owner consent for the protected conversation history")));
    }
    Ok(None)
}

pub(crate) fn apply(conn: &Connection, request: &PiToolRequest, scope: PiInferenceScope,
    computers: Option<&super::super::lifetime_computers::NativeComputers>) -> Result<Response> {
    let envelope = &request.envelope;
    envelope.validate()?;
    // Fence precedes scope inspection and cached command replay.
    if let Some(response) = guard(conn, request, scope)? { return Ok(response); }
    let body = &envelope.body;
    let method = apply::string_field(body, "method")?;
    if method=="work.context.claim" {return super::work_context::claim(conn,request);}
    if method == "inference.settings" && scope == PiInferenceScope::Selected {
        apply::exact_fields(body, if body.get("assignment_id").is_some() || body.get("work_id").is_some(){ &["method","assignment_id","work_id"] }else{ &["method"] })?;
        return Ok(apply::success("Current registered model selection",vec![],
            super::super::inference::selection_view(conn,&request.ghost_id,&request.conversation_id)?));
    }
    if method == "inference.inspect" {
        apply::exact_fields(body, if body.get("assignment_id").is_some() || body.get("work_id").is_some(){ &["method","assignment_id","work_id"] }else{ &["method"] })?;
        return Ok(apply::success("Current Host permits the captured inference scope", vec![],
            serde_json::json!({ "inference_scope": match scope { PiInferenceScope::Local=>"local", PiInferenceScope::Public=>"public", PiInferenceScope::Selected=>"selected" },
                "authority_epoch": envelope.authority_epoch })));
    }
    let mut goal_scope: Option<Goal> = None;
    let mut inspect_work: Option<Work> = None;
    match method {
        "goal.create" | "conversation.reply" | "conversation.inspect" | "conversation.turn.inspect" | "conversation.turn_status" | "conversation.assignment.inspect" | "conversation.report.inspect" | "conversation.report.reply" => {
            if apply::string_field(body, "ghost_id")? != request.ghost_id
                || apply::string_field(body, "conversation_id")? != request.conversation_id {
                return Ok(denied("unauthorized", "Canonical callback exceeds the authenticated Pi conversation"));
            }
            // Owner replies verify their immutable originating turn. Work-report
            // callbacks separately verify the authoritative original Pi outbox.
        }
        "goal.inspect" | "goal.update" => {
            goal_scope = owned_goal(conn, request, apply::string_field(body, "goal_id")?)?;
            if goal_scope.is_none() {
                return Ok(denied("not_found", "Goal is outside the authenticated Pi conversation"));
            }
        }
        "work.pi.admit" | "work.submit" | "work.inspect" | "work.steer" | "work.cancel" | "work.wait" | "work.wait.inspect" | "work.children" => {
            let Some((work, goal)) = owned_work(conn, request, apply::string_field(body, "work_id")?)? else {
                return Ok(denied("not_found", "Work is outside the authenticated Pi conversation"));
            };
            if method == "work.inspect" { inspect_work = Some(work); }
            goal_scope = Some(goal);
        }
        "work.delegate" => {
            let Some((_, goal)) = owned_work(conn, request, apply::string_field(body, "parent_work_id")?)? else {
                return Ok(denied("not_found", "Parent work is outside the authenticated Pi conversation"));
            };
            goal_scope = Some(goal);
        }
        "registry.inspect" => {}
        "mailbox.send" => {
            if apply::string_field(body, "sender_id")? != request.ghost_id
                || apply::string_field(body, "privacy")? != if scope == PiInferenceScope::Local || (scope == PiInferenceScope::Selected && !super::conversation_is_public(conn,&request.ghost_id,&request.conversation_id)?) { "local_only" } else { "public" }
            {
                return Ok(denied("unauthorized", "Mailbox sender and disclosure exceed the authenticated Pi scope"));
            }
        }
        "mailbox.inspect" => {
            if apply::string_field(body, "recipient_id")? != request.ghost_id {
                return Ok(denied("unauthorized", "Mailbox recipient exceeds the authenticated Pi scope"));
            }
            let after = apply::value_field(body, "after_sequence")?.as_u64()
                .ok_or_else(|| anyhow!("mailbox cursor must be an unsigned integer"))?;
            let protected: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM lifetime_mailbox WHERE recipient_id=?1 AND sequence>?2 AND privacy<>'public')",
                rusqlite::params![request.ghost_id, db::revision(after)?], |row| row.get(0),
            )?;
            if protected && scope != PiInferenceScope::Local {
                return Ok(denied("disclosure_blocked", "Protected mailbox records were not returned to the external model"));
            }
        }
        _ => return Ok(denied("unauthorized", "Method is not in the Pi controller action space")),
    }
    if scope == PiInferenceScope::Public && goal_scope.as_ref().is_some_and(|goal| goal.privacy != "public") {
        return Ok(denied("disclosure_blocked", "Protected goal was not returned to the external model"));
    }
    if matches!(method,"work.submit"|"work.steer") {
        return Ok(denied("legacy_execution_retired", "Ghost executes directly in Pi; new OMP admission and steering are retired"));
    }
    if method == "work.pi.admit" && super::pi_execution::offer(conn, computers, &request.ghost_id, apply::string_field(body,"work_id")?, envelope.authority_epoch)?.is_none() {
        return Ok(denied("computer_unavailable", "No accepted direct Pi environment permits this Work"));
    }
    if method=="work.wait.inspect" || (method=="work.wait" && body.get("assignment_id").is_some()) {
        let work=db::work(conn,apply::string_field(body,"work_id")?)?.ok_or_else(||anyhow!("Pi wait Work missing"))?;
        let privacy=super::pi_execution::privacy(conn,&work)?;
        let computers=computers.ok_or_else(||anyhow!("Pi wait computer unavailable"))?;
        anyhow::ensure!(computers.pi_available(&request.ghost_id,envelope.authority_epoch,&privacy)?,"Pi wait computer grant revoked");
        if let Some(execution)=&work.execution_id {
            let computer=computers.pi_computer(&request.ghost_id).ok_or_else(||anyhow!("Pi wait route unavailable"))?;
            anyhow::ensure!(computers.pi_current(&request.ghost_id,execution,&computer,envelope.authority_epoch,&privacy)?,"Pi wait original environment grant revoked");
        }
        if method=="work.wait.inspect" {return super::pi_wait::inspect(conn,request); }
    }
    let mut response=super::apply_with_admission(conn,envelope,&request.ghost_id,|_|Ok(None))?;
    if method=="conversation.turn.inspect" && response.status==ResponseStatus::Success {
        let descriptor=super::super::bots_provisioning::creation_descriptor(conn,apply::string_field(body,"turn_id")?,&request.ghost_id,&request.conversation_id,envelope.authority_epoch)?;
        response.data.as_object_mut().unwrap().insert("bot_creation".into(),descriptor.unwrap_or(Value::Null));
    }
    if method == "goal.create" && response.status == ResponseStatus::Success {
        if let Some(work_id) = response.data["work"]["id"].as_str() {
            if let Some(admission) = automatic_admission(conn, request, work_id)? {
                response.data.as_object_mut().unwrap().insert("automatic_admission".into(), admission);
            }
        }
    }
    if method=="conversation.assignment.inspect" && response.status==ResponseStatus::Success {
        if let Some(work_id)=response.data["assignment"]["work_id"].as_str().map(str::to_owned) {
            let work=db::work(conn,&work_id)?.ok_or_else(||anyhow!("Assignment Work missing"))?;
            if let Some(context)=super::work_context::view(conn,apply::string_field(body,"assignment_id")?)? {
                response.data.as_object_mut().unwrap().insert("execution_context".into(),context);
            }
            let inputs=super::pi_execution::artifact_inputs(conn,&work)?;
            response.data.as_object_mut().unwrap().insert("input_artifacts".into(),serde_json::to_value(inputs)?);
            if let Some(offer)=super::pi_execution::offer(conn,computers,&request.ghost_id,&work_id,envelope.authority_epoch)? {
                response.data.as_object_mut().unwrap().insert("execution".into(),offer);
            }
        }
    }
    if method=="work.inspect" && response.status==ResponseStatus::Success {
        // NativeWorkerGrant contains Host storage roots and historical OMP
        // fields. Pi receives only its current guest capability facts.
        response.data.as_object_mut().unwrap().remove("worker_grant");
        if let Some(work)=inspect_work.as_ref() {
            response.data.as_object_mut().unwrap().insert("independent_verification".into(),serde_json::to_value(super::task_verification::view(conn,work)?)?);
            response.data.as_object_mut().unwrap().insert("command_recipes".into(),serde_json::to_value(super::pi_execution::command_recipe_views(conn,work)?)?);
            let leaf = db::goal(conn, &work.goal_id)?
                .is_some_and(|goal| goal.acceptance_spec["delegation_allowed"] == false);
            let (contracts, templates) = if leaf {
                response.data["delegation_allowed"] = Value::Bool(false);
                (vec![], vec![])
            } else {
                (super::delegation_contracts::views(conn, work)?, super::task_contracts::delegation_views(conn, work)?)
            };
            response.data["delegation_contracts"] = Value::Array(contracts);
            response.data["delegation_templates"] = Value::Array(templates);
            let task_input=super::task_contracts::work_input_descriptor(conn,work)?;
            let evaluation_input=super::evaluation_inputs::work_input_descriptor(conn,work)?;
            ensure!(task_input.is_none() || evaluation_input.is_none(),"Work has conflicting immutable input sources");
            response.data.as_object_mut().unwrap().insert("task_input".into(),serde_json::to_value(task_input.or(evaluation_input))?);
            if let Some(binding)=super::pi_execution::offer(conn,computers,&request.ghost_id,&work.id,envelope.authority_epoch)? {
                response.data.as_object_mut().unwrap().insert("execution".into(),binding);
            }
        }
        // Authoritative Host-derived child artifact metadata snapshot. Exposed
        // only while the inspected Work is current and the graph derivation
        // succeeds; a stale/terminal inspection still returns its normal
        // status, just without an input snapshot — inspection never fails
        // because future admission inputs are unavailable.
        if let Some(work) = inspect_work {
            match super::graph::native_artifact_inputs(conn, &work) {
                Ok(inputs) => {
                    response.data.as_object_mut().ok_or_else(|| anyhow!("Work inspection response is not an object"))?
                        .insert("input_artifacts".into(), serde_json::to_value(inputs)?);
                }
                Err(_) => {}
            }
        }
    }
    Ok(response)
}

// This is an observation of the exact committed delivery, not a new admission
// or a claim that the receiver has started an execution.
fn automatic_admission(conn: &Connection, request: &PiToolRequest, work_id: &str) -> Result<Option<Value>> {
    let Some((work, goal)) = owned_work(conn, request, work_id)? else { return Ok(None); };
    if work.goal_revision != goal.revision || !super::graph::current_result_scope(conn, &work)? {
        return Ok(None);
    }
    let mut query = conn.prepare(
        "SELECT o.delivery_ref,o.payload,o.acknowledged,c.command_id FROM lifetime_outbox o
         JOIN lifetime_commands c ON c.command_id=o.command_id
         WHERE o.target='pi' AND json_extract(o.payload,'$.body.method')='conversation.assignment'
           AND json_extract(o.payload,'$.body.work_id')=?1
           AND json_extract(o.payload,'$.body.goal_id')=?2
           AND json_extract(o.payload,'$.body.goal_revision')=?3
           AND json_extract(o.payload,'$.body.ghost_id')=?4
           AND json_extract(o.payload,'$.body.conversation_id')=?5
           AND json_extract(o.payload,'$.authority_epoch')=?6
           AND c.actor_ref=?4 AND c.authority_epoch=?6
           AND json_extract(c.request,'$.body.method')='goal.create'
           AND json_extract(c.request,'$.body.turn_id')=?7
           AND json_extract(c.response,'$.status')='success'
           AND json_extract(c.response,'$.data.work.id')=?1
           AND json_extract(c.response,'$.data.goal.id')=?2
           AND json_extract(c.response,'$.data.goal.revision')=?3
         ORDER BY o.id LIMIT 2",
    )?;
    let rows = query.query_map(
        rusqlite::params![work.id,goal.id,goal.revision,request.ghost_id,request.conversation_id,request.envelope.authority_epoch,request.envelope.body["turn_id"].as_str()],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,bool>(2)?,row.get::<_,String>(3)?)),
    )?.collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() != 1 { return Ok(None); }
    let (assignment_id, raw, acknowledged, source_command_id) = &rows[0];
    let receiver: Envelope = serde_json::from_str(&raw)?;
    receiver.validate()?;
    if receiver.command_id != *assignment_id { return Ok(None); }
    Ok(Some(serde_json::json!({
        "engine":"pi", "work_id":work.id, "assignment_id":assignment_id,
        "source_command_id":source_command_id,
        "delivery_state":if *acknowledged {"acknowledged"} else {"queued"},
        "work_state":work.state, "next_action":"observe"
    })))
}
