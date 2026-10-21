//! Host-owned Pi controller ingress. Model arguments never confer owner authority.
use super::{apply::{self}, authority, db};
use crate::lifetime_contract::{Envelope, Goal, Response, ResponseStatus, RetryClass, Work};
use anyhow::{anyhow, Result};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PiToolRequest {
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
    let method = apply::string_field(&envelope.body, "method")?;
    let draining: bool = conn.query_row(
        "SELECT mode='draining' FROM lifetime_registry WHERE ghost_id=?1",
        [&request.ghost_id], |row| row.get(0),
    ).optional()?.unwrap_or(false);
    if draining && !authority::read_only(Some(method)) && !matches!(method, "work.cancel" | "conversation.reply" | "conversation.report.reply" | "conversation.turn_status") {
        return Ok(Some(denied("waiting_host", "Ghost is draining; new model-owned admission is disabled")));
    }
    if scope == PiInferenceScope::Public
        && !super::conversation_is_public(conn, &request.ghost_id, &request.conversation_id)? {
        return Ok(Some(denied("disclosure_blocked", "Non-public conversation requires an accepted local model route")));
    }
    if scope == PiInferenceScope::Selected && method != "inference.settings"
        && !super::conversation_is_public(conn, &request.ghost_id, &request.conversation_id)?
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
    if method == "inference.settings" && scope == PiInferenceScope::Selected {
        apply::exact_fields(body,&["method"])?;
        return Ok(apply::success("Current registered model selection",vec![],
            super::super::inference::selection_view(conn,&request.ghost_id,&request.conversation_id)?));
    }
    if method == "inference.inspect" {
        apply::exact_fields(body, &["method"])?;
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
        "work.submit" | "work.inspect" | "work.steer" | "work.cancel" | "work.wait" | "work.children" => {
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
    let mut response = super::apply_with_admission(conn, envelope, &request.ghost_id, |_| {
        if matches!(method, "work.submit" | "work.steer") {
            let goal = goal_scope.as_ref().ok_or_else(|| anyhow!("Native Work admission has no authenticated Goal scope"))?;
            let current = computers.map(|computers| computers.grant(&request.ghost_id, envelope.authority_epoch)).transpose()?.flatten();
            let Some(grant) = current.filter(|grant| grant.permits_privacy(&goal.privacy)) else {
                return Ok(Some(denied("worker_grant_unavailable", "No current accepted native computer route permits this Goal; no Worker admission occurred")));
            };
            if method == "work.submit" && !grant.permits_spec(apply::value_field(body, "spec")?) {
                return Ok(Some(denied("unauthorized", "Worker spec exceeds its current Host-issued Ghost/computer/workspace grant")));
            }
        }
        Ok(None)
    })?;
    if method == "work.inspect" && response.status == ResponseStatus::Success {
        let current = computers.map(|computers| computers.grant(&request.ghost_id, envelope.authority_epoch)).transpose()?.flatten()
            .filter(|grant| goal_scope.as_ref().is_some_and(|goal| grant.permits_privacy(&goal.privacy)));
        response.data.as_object_mut().ok_or_else(|| anyhow!("Work inspection response is not an object"))?
            .insert("worker_grant".into(), serde_json::to_value(current)?);
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
