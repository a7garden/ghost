use super::{apply as host_apply, conversation, graph};
use crate::lifetime_contract::{canonical_digest, Envelope, Goal, Response, RetryClass, Work};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

struct AssignmentSource {
    source_command_id: String,
    receiver: Envelope,
    goal: Goal,
    work: Work,
    privacy: String,
    origin_kind: &'static str,
    parent_work_id: Option<String>,
    root_goal_id: String,
}

struct SourceCommand {
    envelope: Envelope,
    response: Value,
}

enum SourcePurpose {
    Dispatch,
    Report(Goal),
}

pub(super) fn inspect(
    conn: &Connection,
    envelope: &Envelope,
    principal: &str,
) -> Result<Response> {
    let (assignment_id, ghost_id, conversation_id) = request_scope(envelope, principal)?;
    let source = load_source(conn, assignment_id, ghost_id, conversation_id, SourcePurpose::Dispatch)?;
    let prompt = host_apply::string_field(&source.receiver.body, "prompt")?;
    Ok(host_apply::success(
        "canonical Goal assignment inspected",
        vec![
            assignment_id.to_owned(),
            source.goal.id.clone(),
            source.work.id.clone(),
        ],
        json!({
            "assignment": {
                "id": assignment_id,
                "source_command_id": source.source_command_id,
                "ghost_id": source.goal.accountable_ghost,
                "conversation_id": source.goal.reply_conversation,
                "goal_id": source.goal.id,
                "goal_revision": source.goal.revision,
                "work_id": source.work.id,
                "privacy": source.privacy,
                "prompt": prompt,
                "origin_kind": source.origin_kind,
                "parent_work_id": source.parent_work_id,
                "root_goal_id": source.root_goal_id,
            }
        }),
    ))
}

pub(super) fn delivery_is_public(conn: &Connection, receiver: &Envelope) -> Result<bool> {
    if receiver.validate().is_err()
        || host_apply::string_field(&receiver.body, "method")? != "conversation.assignment"
    {
        return Err(host_apply::not_found(
            "Pi assignment envelope is not a valid canonical delivery",
        ));
    }
    let assignment_id = receiver.command_id.as_str();
    let ghost_id = host_apply::string_field(&receiver.body, "ghost_id")?;
    let conversation_id = host_apply::string_field(&receiver.body, "conversation_id")?;
    let source = load_source(conn, assignment_id, ghost_id, conversation_id, SourcePurpose::Dispatch)?;
    if &source.receiver != receiver {
        return Err(host_apply::conflict(
            "Pi assignment envelope differs from its committed delivery",
        ));
    }
    Ok(source.privacy == "public")
}

pub(super) fn report_origin(
    conn: &Connection,
    goal: Goal,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<(Goal, String)> {
    let assignment_id: Option<String> = conn.query_row(
        "SELECT delivery_ref FROM lifetime_outbox
         WHERE target='pi'
           AND json_extract(payload,'$.body.method')='conversation.assignment'
           AND json_extract(payload,'$.body.goal_id')=?1
           AND json_extract(payload,'$.body.goal_revision')=?2
         ORDER BY id DESC LIMIT 1",
        params![goal.id, goal.revision],
        |row| row.get(0),
    ).optional()?;
    let assignment_id = assignment_id.ok_or_else(|| {
        host_apply::not_found("work report Goal has no committed admission or delegation")
    })?;
    let source = load_source(
        conn, &assignment_id, ghost_id, conversation_id, SourcePurpose::Report(goal),
    )?;
    Ok((source.goal, source.privacy))
}

fn request_scope<'a>(
    envelope: &'a Envelope,
    principal: &str,
) -> Result<(&'a str, &'a str, &'a str)> {
    host_apply::exact_fields(
        &envelope.body,
        &["method", "assignment_id", "ghost_id", "conversation_id"],
    )?;
    if host_apply::string_field(&envelope.body, "method")? != "conversation.assignment.inspect" {
        return Err(host_apply::invalid("unexpected Goal assignment method"));
    }
    let assignment_id = host_apply::string_field(&envelope.body, "assignment_id")?;
    let ghost_id = host_apply::string_field(&envelope.body, "ghost_id")?;
    let conversation_id = host_apply::string_field(&envelope.body, "conversation_id")?;
    host_apply::validate_identity("assignment_id", assignment_id)?;
    host_apply::validate_identity("ghost_id", ghost_id)?;
    host_apply::validate_identity("conversation_id", conversation_id)?;
    if principal != ghost_id {
        return Err(host_apply::reject(
            "unauthorized",
            "Goal assignments require the authenticated target Ghost",
            RetryClass::Never,
        ));
    }
    Ok((assignment_id, ghost_id, conversation_id))
}
fn ensure_active_pair(conn: &Connection, ghost_id: &str, conversation_id: &str) -> Result<()> {
    if conversation::registered_mode(conn, ghost_id, conversation_id)? != "active" {
        return Err(host_apply::reject(
            "waiting_host",
            "draining Ghosts cannot admit or dispatch new Goal assignments",
            RetryClass::ReconcileFirst,
        ));
    }
    conversation::require_pi_binding(conn, ghost_id, conversation_id)
}

fn load_source(
    conn: &Connection,
    assignment_id: &str,
    ghost_id: &str,
    conversation_id: &str,
    purpose: SourcePurpose,
) -> Result<AssignmentSource> {
    let dispatch = matches!(&purpose, SourcePurpose::Dispatch);
    if dispatch {
        ensure_active_pair(conn, ghost_id, conversation_id)?;
    } else {
        conversation::registered_mode(conn, ghost_id, conversation_id)?;
        conversation::require_pi_binding(conn, ghost_id, conversation_id)?;
    }
    let (source_command_id, target, payload) = {
        let mut statement = conn.prepare(
            "SELECT command_id,target,payload FROM lifetime_outbox WHERE delivery_ref=?1 LIMIT 2",
        )?;
        let mut rows = statement.query([assignment_id])?;
        let Some(first) = rows.next()? else {
            return Err(host_apply::not_found("Goal assignment source not found"));
        };
        let source = (
            first.get::<_, String>(0)?,
            first.get::<_, String>(1)?,
            first.get::<_, String>(2)?,
        );
        if rows.next()?.is_some() {
            return Err(host_apply::conflict(
                "Goal assignment delivery reference is ambiguous",
            ));
        }
        source
    };
    if target != "pi" {
        return Err(host_apply::not_found(
            "Goal assignment is not a Pi delivery",
        ));
    }
    host_apply::validate_identity("source_command_id", &source_command_id)?;

    let receiver: Envelope = serde_json::from_str(&payload)
        .map_err(|_| host_apply::not_found("Goal assignment source envelope is invalid"))?;
    if receiver.validate().is_err() || receiver.command_id != assignment_id {
        return Err(host_apply::not_found(
            "Goal assignment source envelope does not match its delivery reference",
        ));
    }
    host_apply::exact_fields(
        &receiver.body,
        &[
            "method",
            "ghost_id",
            "conversation_id",
            "goal_id",
            "goal_revision",
            "work_id",
            "prompt",
            "privacy",
        ],
    )?;
    if host_apply::string_field(&receiver.body, "method")? != "conversation.assignment" {
        return Err(host_apply::not_found(
            "delivery reference is not a canonical Goal assignment",
        ));
    }
    if host_apply::string_field(&receiver.body, "ghost_id")? != ghost_id
        || host_apply::string_field(&receiver.body, "conversation_id")? != conversation_id
    {
        return Err(host_apply::not_found(
            "Goal assignment is outside this registered Ghost pair",
        ));
    }
    let goal_id = host_apply::string_field(&receiver.body, "goal_id")?;
    let work_id = host_apply::string_field(&receiver.body, "work_id")?;
    host_apply::validate_identity("goal_id", goal_id)?;
    host_apply::validate_identity("work_id", work_id)?;
    let receiver_revision = host_apply::number_field(&receiver.body, "goal_revision")?;
    let receiver_privacy = host_apply::string_field(&receiver.body, "privacy")?;
    let receiver_prompt = host_apply::string_field(&receiver.body, "prompt")?;
    if !valid_privacy(receiver_privacy) {
        return Err(host_apply::not_found(
            "Goal assignment privacy is invalid",
        ));
    }
    host_apply::validate_text("prompt", receiver_prompt)?;

    let authority = super::authority::current(conn)?;
    if dispatch && !authority.dispatch_enabled {
        return Err(host_apply::reject(
            "dispatch_off",
            "restored Host is read-only; Goal assignment inference is disabled",
            RetryClass::Never,
        ));
    }
    if receiver.authority_epoch != authority.epoch {
        return Err(host_apply::reject(
            "authority_fenced",
            "Goal assignment was created under a fenced Host authority epoch",
            RetryClass::Never,
        ));
    }

    let goal = match purpose {
        SourcePurpose::Dispatch => load_goal(conn, goal_id)?,
        SourcePurpose::Report(goal) => {
            if goal.id != goal_id {
                return Err(host_apply::not_found("work report admission targets another Goal"));
            }
            goal
        }
    };
    if receiver_revision != goal.revision {
        return Err(host_apply::conflict(
            "Goal assignment targets a stale Goal revision",
        ));
    }
    if receiver_prompt != goal.prompt.as_str() {
        return Err(host_apply::conflict(
            "Goal assignment prompt differs from the current Goal requirement",
        ));
    }
    if receiver.expected_revision != Some(goal.revision)
        || goal.accountable_ghost != ghost_id
        || goal.reply_conversation != conversation_id
        || (dispatch && goal.state != "open")
        || goal.privacy != receiver_privacy
        || !valid_privacy(&goal.privacy)
    {
        return Err(host_apply::not_found(
            "Goal assignment does not match the current target Goal",
        ));
    }
    let work = load_work(conn, work_id)?;
    let can_start = work.state == "queued" && work.execution_id.is_none();
    let can_continue = work.execution_id.is_some() && is_continuation_state(&work.state);
    if work.goal_id != goal.id
        || work.goal_revision != goal.revision
        || work.owner != ghost_id
        || (dispatch && (work.cancellation != "none"
            || work.blocker.is_some()
            || (!can_start && !can_continue)))
    {
        return Err(host_apply::conflict(
            "Goal assignment Work is no longer current, uncancelled, and admissible",
        ));
    }
    if dispatch && !graph::current_result_scope(conn, &work)? {
        return Err(host_apply::conflict(
            "Goal assignment ancestry, revision, or graph deadline is no longer current",
        ));
    }
    if dispatch && can_continue && !has_matching_work_submit(conn, &receiver, &goal, &work, ghost_id)? {
        return Err(host_apply::conflict(
            "Goal assignment continuation has no matching committed target work.submit",
        ));
    }

    let source = load_source_command(conn, &source_command_id)?;
    if source.envelope.authority_epoch != receiver.authority_epoch
        || source.envelope.actor_ref != receiver.actor_ref
        || source.envelope.correlation_id != receiver.correlation_id
    {
        return Err(host_apply::not_found(
            "Goal assignment source command does not match its committed delivery",
        ));
    }

    let link = load_link(conn, &work.id)?;
    let has_link_history = graph::has_goal_link_history(conn, &goal.id)?;
    let (origin_kind, parent_work_id, root_goal_id, parent_context) =
        match source.envelope.body["method"].as_str() {
            Some("goal.submit") => {
                verify_current_goal_work_receipt(&source, &goal, &work)?;
                if link.is_some() || has_link_history {
                    return Err(host_apply::not_found(
                        "Owner Goal assignment has delegated ancestry and cannot be treated as a root",
                    ));
                }
                verify_owner_goal_source(&source, &goal, &work, ghost_id, conversation_id)?;
                ("owner_goal", None, goal.id.clone(), None)
            }
            Some("goal.create") => {
                verify_current_goal_work_receipt(&source, &goal, &work)?;
                if link.is_some() || has_link_history {
                    return Err(host_apply::not_found(
                        "Owner Goal assignment has delegated ancestry and cannot be treated as a root",
                    ));
                }
                verify_owner_turn_goal_origin(
                    conn,
                    &source,
                    &goal,
                    &work,
                    ghost_id,
                    conversation_id,
                )?;
                ("owner_goal", None, goal.id.clone(), None)
            }
            Some("work.delegate") => {
                verify_current_goal_work_receipt(&source, &goal, &work)?;
                if !has_link_history {
                    return Err(host_apply::not_found(
                        "delegated Goal assignment has no durable ancestry history",
                    ));
                }
                let link = link.as_ref().ok_or_else(|| {
                    host_apply::not_found("delegated Goal assignment ancestry link is missing")
                })?;
                let (parent_work, parent_goal) =
                    verify_delegated_source(conn, &source, &goal, &work, link, ghost_id, dispatch)?;
                (
                    "delegated_goal",
                    Some(link.parent_work_id.clone()),
                    link.root_goal_id.clone(),
                    Some((parent_work, parent_goal)),
                )
            }
            Some("goal.update") => {
                verify_goal_update_source(
                    &source,
                    &goal,
                    &work,
                    ghost_id,
                    conversation_id,
                )?;
                let origin = load_goal_origin(conn, &goal.id)?;
                match (
                    origin.envelope.body["method"].as_str(),
                    link.as_ref(),
                    has_link_history,
                ) {
                    (Some("goal.submit"), None, false) => {
                        verify_owner_goal_origin(
                            &origin,
                            &goal,
                            &work,
                            ghost_id,
                            conversation_id,
                        )?;
                        ("owner_goal", None, goal.id.clone(), None)
                    }
                    (Some("goal.create"), None, false) => {
                        verify_owner_turn_goal_origin(
                            conn,
                            &origin,
                            &goal,
                            &work,
                            ghost_id,
                            conversation_id,
                        )?;
                        ("owner_goal", None, goal.id.clone(), None)
                    }
                    (Some("work.delegate"), Some(link), true) => {
                        let (parent_work, parent_goal) = verify_delegated_origin(
                            conn,
                            &origin,
                            &goal,
                            &work,
                            link,
                            ghost_id,
                            dispatch,
                        )?;
                        (
                            "delegated_goal",
                            Some(link.parent_work_id.clone()),
                            link.root_goal_id.clone(),
                            Some((parent_work, parent_goal)),
                        )
                    }
                    _ => {
                        return Err(host_apply::not_found(
                            "Goal update source has missing or contradictory original ancestry",
                        ));
                    }
                }
            }
            _ => {
                return Err(host_apply::not_found(
                    "Goal assignment source is neither a direct Owner Goal, committed delegation, nor revision",
                ));
            }
        };

    let mut privacy =
        conversation::conversation_privacy(conn, ghost_id, conversation_id)?;
    let root_is_current = if let Some((parent_work, parent_goal)) = parent_context {
        let root_goal = raise_ancestor_privacy(
            conn,
            &mut privacy,
            parent_work,
            parent_goal,
            &root_goal_id,
            dispatch,
        )?;
        root_goal.id == root_goal_id
            && (!dispatch || root_goal.state == "open")
            && valid_privacy(&root_goal.privacy)
    } else {
        goal.id == root_goal_id
            && (!dispatch || goal.state == "open")
            && valid_privacy(&goal.privacy)
    };
    if !root_is_current {
        return Err(host_apply::conflict(
            "Goal assignment root is no longer current and open",
        ));
    }
    Ok(AssignmentSource {
        source_command_id,
        receiver,
        goal,
        work,
        privacy,
        origin_kind,
        parent_work_id,
        root_goal_id,
    })
}

fn raise_ancestor_privacy(
    conn: &Connection,
    privacy: &mut String,
    mut work: Work,
    mut goal: Goal,
    root_goal_id: &str,
    dispatch: bool,
) -> Result<Goal> {
    loop {
        if work.goal_id != goal.id
            || work.goal_revision != goal.revision
            || work.owner != goal.accountable_ghost
            || (dispatch && goal.state != "open")
        {
            return Err(host_apply::conflict(
                "Goal assignment ancestor Work or Goal is no longer current",
            ));
        }
        conversation::registered_mode(conn, &goal.accountable_ghost, &goal.reply_conversation)?;
        conversation::require_pi_binding(conn, &goal.accountable_ghost, &goal.reply_conversation)?;
        conversation::raise_privacy(privacy, &goal.privacy)?;
        let pair_privacy = conversation::conversation_privacy(
            conn,
            &goal.accountable_ghost,
            &goal.reply_conversation,
        )?;
        conversation::raise_privacy(privacy, &pair_privacy)?;
        if goal.id == root_goal_id {
            return Ok(goal);
        }

        let link = load_link(conn, &work.id)?
            .ok_or_else(|| host_apply::conflict("Goal assignment ancestry link is missing"))?;
        if !link.current || link.child_work_id != work.id || link.root_goal_id != root_goal_id {
            return Err(host_apply::conflict(
                "Goal assignment ancestry link is stale or mismatched",
            ));
        }
        let parent_work = load_work(conn, &link.parent_work_id)?;
        let parent_goal = load_goal(conn, &parent_work.goal_id)?;
        if parent_work.goal_revision != parent_goal.revision
            || link.parent_goal_revision != parent_goal.revision
            || parent_work.owner != parent_goal.accountable_ghost
        {
            return Err(host_apply::conflict(
                "Goal assignment ancestor revision or owner is stale",
            ));
        }
        work = parent_work;
        goal = parent_goal;
    }
}



fn load_source_command(conn: &Connection, command_id: &str) -> Result<SourceCommand> {
    let Some((digest, actor_ref, authority_epoch, request, response)) = conn
        .query_row(
            "SELECT payload_digest,actor_ref,authority_epoch,request,response
             FROM lifetime_commands WHERE command_id=?1",
            [command_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
    else {
        return Err(host_apply::not_found(
            "Goal assignment source command is not committed",
        ));
    };
    let envelope: Envelope = serde_json::from_str(&request)
        .map_err(|_| host_apply::not_found("Goal assignment source command is invalid"))?;
    let stored_epoch = u64::try_from(authority_epoch)
        .map_err(|_| host_apply::not_found("Goal assignment source authority is invalid"))?;
    if envelope.validate().is_err()
        || envelope.command_id != command_id
        || envelope.payload_digest != digest
        || envelope.actor_ref != actor_ref
        || envelope.authority_epoch != stored_epoch
    {
        return Err(host_apply::not_found(
            "Goal assignment source command does not match its committed record",
        ));
    }
    let response: Value = serde_json::from_str(&response)
        .map_err(|_| host_apply::not_found("Goal assignment source receipt is invalid"))?;
    if response["status"] != "success" {
        return Err(host_apply::not_found(
            "Goal assignment source command did not commit successfully",
        ));
    }
    Ok(SourceCommand { envelope, response })
}
fn verify_current_goal_work_receipt(
    source: &SourceCommand,
    goal: &Goal,
    work: &Work,
) -> Result<()> {
    if source.response["data"]["goal"]["id"] != goal.id
        || source.response["data"]["goal"]["revision"].as_u64() != Some(goal.revision)
        || source.response["data"]["goal"]["requirement_digest"] != goal.requirement_digest
        || source.response["data"]["goal"]["accountable_ghost"] != goal.accountable_ghost
        || source.response["data"]["goal"]["reply_conversation"] != goal.reply_conversation
        || source.response["data"]["goal"]["privacy"] != goal.privacy
        || source.response["data"]["goal"]["state"] != "open"
        || source.response["data"]["goal"]["prompt"] != goal.prompt
        || source.response["data"]["goal"]["acceptance_spec"] != goal.acceptance_spec
        || source.response["data"]["work"]["id"] != work.id
        || source.response["data"]["work"]["goal_id"] != work.goal_id
        || source.response["data"]["work"]["goal_revision"].as_u64() != Some(work.goal_revision)
        || source.response["data"]["work"]["owner"] != work.owner
        || source.response["data"]["work"]["owner_revision"].as_u64() != Some(work.owner_revision)
        || source.response["data"]["work"]["state"] != "queued"
        || source.response["data"]["work"]["cancellation"] != "none"
        || !source.response["data"]["work"]["execution_id"].is_null()
        || !source.response["data"]["work"]["blocker"].is_null()
    {
        return Err(host_apply::not_found(
            "Goal assignment has no matching committed source command",
        ));
    }
    Ok(())
}

fn verify_goal_update_source(
    source: &SourceCommand,
    goal: &Goal,
    work: &Work,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<()> {
    if source.envelope.actor_ref != conversation::OWNER_PRINCIPAL
        && source.envelope.actor_ref != ghost_id
    {
        return Err(host_apply::reject(
            "unauthorized",
            "Goal revision source was not committed by Owner administration or the accountable Ghost",
            RetryClass::Never,
        ));
    }
    host_apply::exact_fields(
        &source.envelope.body,
        &["method", "goal_id", "prompt", "acceptance_spec"],
    )?;
    let previous_revision = source
        .envelope
        .expected_revision
        .ok_or_else(|| host_apply::not_found("Goal revision source omitted expected_revision"))?;
    let prompt = host_apply::string_field(&source.envelope.body, "prompt")?;
    let acceptance_spec = host_apply::value_field(&source.envelope.body, "acceptance_spec")?;
    let requirement_digest = canonical_digest(&json!({
        "prompt": prompt,
        "acceptance_spec": acceptance_spec,
    }))?;
    let response_goal = &source.response["data"]["goal"];
    let response_works = source.response["data"]["work"]
        .as_array()
        .ok_or_else(|| host_apply::not_found("Goal update receipt has no authoritative Work array"))?;
    let mut matching_work = response_works
        .iter()
        .filter(|candidate| candidate["id"].as_str() == Some(work.id.as_str()));
    let Some(response_work) = matching_work.next() else {
        return Err(host_apply::not_found(
            "Goal update receipt does not contain the assigned Work",
        ));
    };
    if matching_work.next().is_some() {
        return Err(host_apply::conflict(
            "Goal update receipt contains duplicate records for the assigned Work",
        ));
    }
    if host_apply::string_field(&source.envelope.body, "method")? != "goal.update"
        || host_apply::string_field(&source.envelope.body, "goal_id")? != goal.id
        || previous_revision.checked_add(1) != Some(goal.revision)
        || prompt != goal.prompt
        || acceptance_spec != &goal.acceptance_spec
        || requirement_digest != goal.requirement_digest
        || goal.accountable_ghost != ghost_id
        || goal.reply_conversation != conversation_id
        || response_goal["id"] != goal.id
        || response_goal["revision"].as_u64() != Some(goal.revision)
        || response_goal["requirement_digest"] != goal.requirement_digest
        || response_goal["accountable_ghost"] != goal.accountable_ghost
        || response_goal["reply_conversation"] != goal.reply_conversation
        || response_goal["privacy"] != goal.privacy
        || response_goal["state"] != "open"
        || response_goal["prompt"] != goal.prompt
        || response_goal["acceptance_spec"] != goal.acceptance_spec
        || response_work["id"] != work.id
        || response_work["goal_id"] != work.goal_id
        || response_work["goal_revision"].as_u64() != Some(work.goal_revision)
        || response_work["owner"] != work.owner
        || response_work["owner_revision"].as_u64() != Some(work.owner_revision)
        || response_work["state"] != "queued"
        || response_work["cancellation"] != "none"
        || !response_work["execution_id"].is_null()
        || !response_work["blocker"].is_null()
    {
        return Err(host_apply::not_found(
            "Goal assignment does not match its committed Goal update and current Work",
        ));
    }
    Ok(())
}

fn load_goal_origin(conn: &Connection, goal_id: &str) -> Result<SourceCommand> {
    let command_id = {
        let mut statement = conn.prepare(
            "SELECT command_id FROM lifetime_commands
             WHERE json_extract(request,'$.body.method') IN ('goal.create','goal.submit','work.delegate')
               AND json_extract(response,'$.status')='success'
               AND json_extract(response,'$.data.goal.id')=?1
             ORDER BY command_id LIMIT 2",
        )?;
        let mut rows = statement.query([goal_id])?;
        let Some(row) = rows.next()? else {
            return Err(host_apply::not_found(
                "Goal has no committed Owner admission or delegation origin",
            ));
        };
        let command_id: String = row.get(0)?;
        if rows.next()?.is_some() {
            return Err(host_apply::conflict(
                "Goal has ambiguous committed origin commands",
            ));
        }
        command_id
    };
    load_source_command(conn, &command_id)
}

fn verify_owner_goal_origin(
    source: &SourceCommand,
    goal: &Goal,
    work: &Work,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<()> {
    host_apply::exact_fields(
        &source.envelope.body,
        &[
            "method",
            "ghost_id",
            "conversation_id",
            "prompt",
            "privacy",
            "acceptance_spec",
        ],
    )?;
    let prompt = host_apply::string_field(&source.envelope.body, "prompt")?;
    let privacy = host_apply::string_field(&source.envelope.body, "privacy")?;
    let acceptance_spec = host_apply::value_field(&source.envelope.body, "acceptance_spec")?;
    let requirement_digest = canonical_digest(&json!({
        "prompt": prompt,
        "acceptance_spec": acceptance_spec,
    }))?;
    let original_goal = &source.response["data"]["goal"];
    let original_work = &source.response["data"]["work"];
    if source.envelope.actor_ref != conversation::OWNER_PRINCIPAL
        || source.envelope.expected_revision.is_some()
        || host_apply::string_field(&source.envelope.body, "method")? != "goal.submit"
        || host_apply::string_field(&source.envelope.body, "ghost_id")? != ghost_id
        || host_apply::string_field(&source.envelope.body, "conversation_id")? != conversation_id
        || original_goal["id"] != goal.id
        || original_goal["revision"].as_u64() != Some(1)
        || original_goal["requirement_digest"] != requirement_digest
        || original_goal["prompt"] != prompt
        || original_goal["accountable_ghost"] != ghost_id
        || original_goal["reply_conversation"] != conversation_id
        || original_goal["privacy"] != privacy
        || privacy != goal.privacy
        || original_goal["state"] != "open"
        || &original_goal["acceptance_spec"] != acceptance_spec
        || original_work["goal_id"] != goal.id
        || original_work["goal_revision"].as_u64() != Some(1)
        || original_work["owner"] != ghost_id
        || original_work["owner_revision"].as_u64() != Some(work.owner_revision)
        || original_work["state"] != "queued"
        || original_work["cancellation"] != "none"
        || !original_work["execution_id"].is_null()
        || !original_work["blocker"].is_null()
        || work.goal_id != goal.id
        || work.owner != ghost_id
    {
        return Err(host_apply::not_found(
            "revised Owner Goal has no matching immutable Owner admission origin",
        ));
    }
    Ok(())
}

fn verify_owner_turn_goal_origin(
    conn: &Connection,
    source: &SourceCommand,
    goal: &Goal,
    work: &Work,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<()> {
    // Model-created root Goal: the committed origin must be a goal.create by
    // the accountable Ghost itself, anchored to a real canonical Owner user
    // turn. The turn identity in the envelope is never trusted on its own.
    host_apply::exact_fields(
        &source.envelope.body,
        &[
            "method",
            "turn_id",
            "ghost_id",
            "conversation_id",
            "prompt",
            "acceptance_spec",
        ],
    )?;
    let body = &source.envelope.body;
    let turn_id = host_apply::string_field(body, "turn_id")?;
    let prompt = host_apply::string_field(body, "prompt")?;
    let acceptance_spec = host_apply::value_field(body, "acceptance_spec")?;
    let requirement_digest = canonical_digest(&json!({
        "prompt": prompt,
        "acceptance_spec": acceptance_spec,
    }))?;
    host_apply::validate_identity("turn_id", turn_id)?;
    let original_goal = &source.response["data"]["goal"];
    let original_work = &source.response["data"]["work"];
    let origin_turn_id = source.response["data"]["origin_turn_id"]
        .as_str()
        .ok_or_else(|| host_apply::not_found("goal.create receipt has no origin turn identity"))?;
    let (turn_ghost, turn_conversation, turn_sender_kind, turn_sender_ref, turn_kind, _) =
        conversation::turn_scope(conn, turn_id)?.ok_or_else(|| {
            host_apply::not_found("goal.create origin Owner turn is not committed")
        })?;
    let bound: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM lifetime_turn_goals WHERE turn_id=?1 AND goal_id=?2)",
        params![turn_id, goal.id],
        |row| row.get(0),
    )?;
    if source.envelope.actor_ref != ghost_id
        || host_apply::string_field(body, "method")? != "goal.create"
        || host_apply::string_field(body, "ghost_id")? != ghost_id
        || host_apply::string_field(body, "conversation_id")? != conversation_id
        || turn_id != origin_turn_id
        || turn_ghost != ghost_id
        || turn_conversation != conversation_id
        || turn_sender_kind != "owner"
        || turn_sender_ref != conversation::OWNER_PRINCIPAL
        || turn_kind != "user"
        || !bound
        || original_goal["id"] != goal.id
        || original_goal["revision"].as_u64() != Some(1)
        || original_goal["requirement_digest"] != requirement_digest
        || original_goal["prompt"] != prompt
        || original_goal["accountable_ghost"] != ghost_id
        || original_goal["reply_conversation"] != conversation_id
        || original_goal["privacy"] != goal.privacy
        || original_goal["state"] != "open"
        || &original_goal["acceptance_spec"] != acceptance_spec
        || original_work["goal_id"] != goal.id
        || original_work["goal_revision"].as_u64() != Some(1)
        || original_work["owner"] != ghost_id
        || original_work["owner_revision"].as_u64() != Some(work.owner_revision)
        || original_work["state"] != "queued"
        || original_work["cancellation"] != "none"
        || !original_work["execution_id"].is_null()
        || !original_work["blocker"].is_null()
        || work.goal_id != goal.id
        || work.owner != ghost_id
    {
        return Err(host_apply::not_found(
            "revised Goal has no matching committed Owner-turn creation origin",
        ));
    }
    Ok(())
}

/// Committed admission provenance for the current Goal revision: the verified
/// revision-1 origin command envelope (`goal.create`, `goal.submit`, or
/// `work.delegate`) or the successful `goal.update` matching this exact
/// revision. Immutable lookup only — it never mutates state, admits work, or
/// authorizes reparenting stale descendants.
pub(super) fn source_for_current_goal(conn: &Connection, goal: &Goal) -> Result<Envelope> {
    let ghost_id = goal.accountable_ghost.as_str();
    let conversation_id = goal.reply_conversation.as_str();
    if goal.revision == 1 {
        let origin = load_goal_origin(conn, &goal.id)?;
        match origin.envelope.body["method"].as_str() {
            Some("goal.create") => {
                let work_id = origin.response["data"]["work"]["id"]
                    .as_str()
                    .ok_or_else(|| {
                        host_apply::not_found("goal.create receipt omitted its Work identity")
                    })?;
                let work = load_work(conn, work_id)?;
                verify_owner_turn_goal_origin(
                    conn, &origin, goal, &work, ghost_id, conversation_id,
                )?;
            }
            Some("goal.submit") => {
                let work_id = origin.response["data"]["work"]["id"]
                    .as_str()
                    .ok_or_else(|| {
                        host_apply::not_found("Goal admission receipt omitted its Work identity")
                    })?;
                let work = load_work(conn, work_id)?;
                verify_owner_goal_origin(&origin, goal, &work, ghost_id, conversation_id)?;
            }
            Some("work.delegate") => {
                let work_id = origin.response["data"]["work"]["id"]
                    .as_str()
                    .ok_or_else(|| {
                        host_apply::not_found("delegation receipt omitted its Work identity")
                    })?;
                let work = load_work(conn, work_id)?;
                let link = load_link(conn, work_id)?.ok_or_else(|| {
                    host_apply::not_found("delegated Goal ancestry link is missing")
                })?;
                verify_delegated_origin(conn, &origin, goal, &work, &link, ghost_id, false)?;
            }
            _ => {
                return Err(host_apply::not_found(
                    "Goal origin command is not a committed admission or delegation",
                ));
            }
        }
        return Ok(origin.envelope);
    }
    let command_id = {
        let mut statement = conn.prepare(
            "SELECT command_id FROM lifetime_commands
             WHERE json_extract(request,'$.body.method')='goal.update'
               AND json_extract(response,'$.status')='success'
               AND json_extract(response,'$.data.goal.id')=?1
               AND json_extract(response,'$.data.goal.revision')=?2
             ORDER BY command_id LIMIT 2",
        )?;
        let mut rows = statement.query(params![goal.id, goal.revision])?;
        let Some(row) = rows.next()? else {
            return Err(host_apply::not_found(
                "Goal revision has no committed successful goal.update source",
            ));
        };
        let command_id: String = row.get(0)?;
        if rows.next()?.is_some() {
            return Err(host_apply::conflict(
                "Goal revision has ambiguous committed goal.update sources",
            ));
        }
        command_id
    };
    let source = load_source_command(conn, &command_id)?;
    verify_revision_source(&source, goal, ghost_id, conversation_id)?;
    Ok(source.envelope)
}

fn verify_revision_source(
    source: &SourceCommand,
    goal: &Goal,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<()> {
    host_apply::exact_fields(
        &source.envelope.body,
        &["method", "goal_id", "prompt", "acceptance_spec"],
    )?;
    let prompt = host_apply::string_field(&source.envelope.body, "prompt")?;
    let acceptance_spec = host_apply::value_field(&source.envelope.body, "acceptance_spec")?;
    let requirement_digest = canonical_digest(&json!({
        "prompt": prompt,
        "acceptance_spec": acceptance_spec,
    }))?;
    let previous_revision = source
        .envelope
        .expected_revision
        .ok_or_else(|| host_apply::not_found("Goal revision source omitted expected_revision"))?;
    let response_goal = &source.response["data"]["goal"];
    if source.envelope.actor_ref != conversation::OWNER_PRINCIPAL
        && source.envelope.actor_ref != ghost_id
    {
        return Err(host_apply::reject(
            "unauthorized",
            "Goal revision source was not committed by Owner administration or the accountable Ghost",
            RetryClass::Never,
        ));
    }
    if host_apply::string_field(&source.envelope.body, "method")? != "goal.update"
        || host_apply::string_field(&source.envelope.body, "goal_id")? != goal.id
        || previous_revision.checked_add(1) != Some(goal.revision)
        || prompt != goal.prompt
        || acceptance_spec != &goal.acceptance_spec
        || requirement_digest != goal.requirement_digest
        || response_goal["id"] != goal.id
        || response_goal["revision"].as_u64() != Some(goal.revision)
        || response_goal["requirement_digest"] != goal.requirement_digest
        || response_goal["accountable_ghost"] != ghost_id
        || response_goal["reply_conversation"] != conversation_id
        || response_goal["privacy"] != goal.privacy
        || response_goal["state"] != "open"
        || response_goal["prompt"] != goal.prompt
        || response_goal["acceptance_spec"] != goal.acceptance_spec
    {
        return Err(host_apply::not_found(
            "Goal revision source does not match the current committed Goal",
        ));
    }
    Ok(())
}

fn verify_delegated_origin(
    conn: &Connection,
    source: &SourceCommand,
    goal: &Goal,
    work: &Work,
    current_link: &WorkLink,
    ghost_id: &str,
    dispatch: bool,
) -> Result<(Work, Goal)> {
    host_apply::exact_fields(
        &source.envelope.body,
        &[
            "method",
            "parent_work_id",
            "target_ghost_id",
            "summary",
            "artifact_refs",
            "acceptance_spec",
        ],
    )?;
    let body = &source.envelope.body;
    let summary = host_apply::string_field(body, "summary")?;
    let acceptance_spec = host_apply::value_field(body, "acceptance_spec")?;
    let artifact_refs = parse_opaque_refs(body)?;
    let summary = validated_delegation_summary(summary)?;
    // The committed child Goal requirement is the canonical summary plus the
    // Opaque artifact references appendix, exactly as admission built it —
    // never the raw summary alone.
    let origin_prompt = graph::delegated_prompt(&summary, &artifact_refs)?;
    let parent_work_id = host_apply::string_field(body, "parent_work_id")?;
    let origin_goal = &source.response["data"]["goal"];
    let origin_work = &source.response["data"]["work"];
    let origin_link = &source.response["data"]["link"];
    let origin_work_id = host_apply::string_field(origin_work, "id")?;
    let origin_root_goal_id = host_apply::string_field(origin_link, "root_goal_id")?;
    let origin_parent_work_id = host_apply::string_field(origin_link, "parent_work_id")?;
    let origin_parent_revision = host_apply::number_field(origin_link, "parent_goal_revision")?;
    let origin_depth = origin_link["depth"]
        .as_i64()
        .ok_or_else(|| host_apply::not_found("original delegation depth is invalid"))?;
    host_apply::validate_identity("original work_id", origin_work_id)?;
    let origin_requirement_digest = canonical_digest(&json!({
        "prompt": origin_prompt,
        "acceptance_spec": acceptance_spec,
    }))?;
    let persisted_origin_link = load_link(conn, origin_work_id)?
        .ok_or_else(|| host_apply::not_found("original delegated Work has no historical link"))?;
    if host_apply::string_field(body, "method")? != "work.delegate"
        || host_apply::string_field(body, "target_ghost_id")? != ghost_id
        || parent_work_id != origin_parent_work_id
        || origin_goal["id"] != goal.id
        || origin_goal["revision"].as_u64() != Some(1)
        || origin_goal["requirement_digest"] != origin_requirement_digest
        || origin_goal["prompt"] != origin_prompt
        || origin_goal["accountable_ghost"] != ghost_id
        || origin_goal["reply_conversation"] != goal.reply_conversation
        || origin_goal["privacy"] != goal.privacy
        || origin_goal["state"] != "open"
        || &origin_goal["acceptance_spec"] != acceptance_spec
        || origin_work["goal_id"] != goal.id
        || origin_work["goal_revision"].as_u64() != Some(1)
        || origin_work["owner"] != ghost_id
        || origin_work["owner_revision"].as_u64() != Some(work.owner_revision)
        || origin_work["state"] != "queued"
        || origin_work["cancellation"] != "none"
        || !origin_work["execution_id"].is_null()
        || !origin_work["blocker"].is_null()
        || source.response["data"]["artifact_refs"] != body["artifact_refs"]
        || source.response["data"]["root_goal_id"] != origin_root_goal_id
        || origin_link["child_work_id"] != origin_work_id
        || origin_link["parent_work_id"] != parent_work_id
        || origin_link["parent_goal_revision"].as_u64() != Some(origin_parent_revision)
        || origin_link["depth"].as_i64() != Some(origin_depth)
        || origin_link["current"] != true
        || persisted_origin_link.child_work_id != origin_work_id
        || persisted_origin_link.parent_work_id != parent_work_id
        || persisted_origin_link.parent_goal_revision != origin_parent_revision
        || persisted_origin_link.root_goal_id != origin_root_goal_id
        || persisted_origin_link.depth != origin_depth
        || !current_link.current
        || current_link.child_work_id != work.id
        || current_link.parent_work_id != parent_work_id
        || current_link.parent_goal_revision != origin_parent_revision
        || current_link.root_goal_id != origin_root_goal_id
        || current_link.depth != origin_depth
        || work.goal_id != goal.id
        || work.owner != ghost_id
    {
        return Err(host_apply::not_found(
            "revised delegated Goal has no matching immutable delegation ancestry",
        ));
    }
    let parent_work = load_work(conn, &current_link.parent_work_id)?;
    let parent_goal = load_goal(conn, &parent_work.goal_id)?;
    if source.envelope.actor_ref != conversation::OWNER_PRINCIPAL
        && source.envelope.actor_ref != parent_work.owner
    {
        return Err(host_apply::reject(
            "unauthorized",
            "delegated Goal origin was not committed by Owner administration or its parent owner",
            RetryClass::Never,
        ));
    }
    let expected_parent_revision = source
        .envelope
        .expected_revision
        .ok_or_else(|| host_apply::conflict("delegation origin omitted its parent revision"))?;
    if parent_work.owner != parent_goal.accountable_ghost
        || parent_work.goal_revision != parent_goal.revision
        || current_link.parent_goal_revision != parent_goal.revision
        || expected_parent_revision != parent_goal.revision
        || (dispatch && (parent_goal.state != "open"
            || graph::remaining_deadline_ms(conn, work)?.is_none()))
    {
        return Err(host_apply::conflict(
            "revised delegated Goal ancestry, parent revision, or deadline is stale",
        ));
    }
    Ok((parent_work, parent_goal))
}


fn is_continuation_state(state: &str) -> bool {
    matches!(
        state,
        "submitted"
            | "steering"
            | "running"
            | "unknown"
            | "accepted"
            | "complete"
            | "completed"
            | "failed"
            | "stopped"
            | "rejected"
    )
}

fn has_matching_work_submit(
    conn: &Connection,
    receiver: &Envelope,
    goal: &Goal,
    work: &Work,
    ghost_id: &str,
) -> Result<bool> {
    let Some(execution_id) = work.execution_id.as_deref() else {
        return Ok(false);
    };
    let authority_epoch = i64::try_from(receiver.authority_epoch)
        .map_err(|_| host_apply::not_found("Goal assignment authority epoch is invalid"))?;
    let mut statement = conn.prepare(
        "SELECT command_id FROM lifetime_commands
         WHERE actor_ref=?1 AND authority_epoch=?2
           AND json_extract(request,'$.body.method')='work.submit'
           AND json_extract(request,'$.body.work_id')=?3
           AND json_extract(request,'$.body.spec.execution_id')=?4
           AND json_extract(response,'$.status')='success'
         ORDER BY command_id",
    )?;
    let mut rows = statement.query(params![ghost_id, authority_epoch, work.id, execution_id])?;
    while let Some(row) = rows.next()? {
        let command_id: String = row.get(0)?;
        let source = load_source_command(conn, &command_id)?;
        if verify_work_submit_source(&source, receiver, goal, work, ghost_id, execution_id)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn verify_work_submit_source(
    source: &SourceCommand,
    receiver: &Envelope,
    goal: &Goal,
    work: &Work,
    ghost_id: &str,
    execution_id: &str,
) -> Result<bool> {
    if source.envelope.actor_ref != ghost_id
        || source.envelope.authority_epoch != receiver.authority_epoch
    {
        return Ok(false);
    }
    host_apply::exact_fields(
        &source.envelope.body,
        &["method", "work_id", "spec"],
    )?;
    if host_apply::string_field(&source.envelope.body, "method")? != "work.submit"
        || host_apply::string_field(&source.envelope.body, "work_id")? != work.id
    {
        return Ok(false);
    }
    let spec = host_apply::value_field(&source.envelope.body, "spec")?;
    if host_apply::string_field(spec, "execution_id")? != execution_id
        || host_apply::string_field(spec, "work_id")? != work.id
        || host_apply::number_field(spec, "work_revision")? != goal.revision
        || host_apply::number_field(spec, "authority_epoch")? != receiver.authority_epoch
        || host_apply::string_field(spec, "prompt")? != goal.prompt
    {
        return Ok(false);
    }
    let submitted_work = &source.response["data"]["work"];
    Ok(source.response["data"]["execution_id"] == execution_id
        && submitted_work["id"] == work.id
        && submitted_work["goal_id"] == goal.id
        && submitted_work["goal_revision"].as_u64() == Some(work.goal_revision)
        && submitted_work["owner"] == ghost_id
        && submitted_work["owner_revision"].as_u64() == Some(work.owner_revision)
        && submitted_work["execution_id"] == execution_id
        && submitted_work["cancellation"] == "none"
        && submitted_work["blocker"].is_null())
}

fn verify_owner_goal_source(
    source: &SourceCommand,
    goal: &Goal,
    work: &Work,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<()> {
    host_apply::exact_fields(
        &source.envelope.body,
        &[
            "method",
            "ghost_id",
            "conversation_id",
            "prompt",
            "privacy",
            "acceptance_spec",
        ],
    )?;
    if source.envelope.actor_ref != conversation::OWNER_PRINCIPAL
        || host_apply::string_field(&source.envelope.body, "method")? != "goal.submit"
        || host_apply::string_field(&source.envelope.body, "ghost_id")? != ghost_id
        || host_apply::string_field(&source.envelope.body, "conversation_id")? != conversation_id
        || host_apply::string_field(&source.envelope.body, "prompt")? != goal.prompt
        || host_apply::string_field(&source.envelope.body, "privacy")? != goal.privacy
        || host_apply::value_field(&source.envelope.body, "acceptance_spec")? != &goal.acceptance_spec
        || work.goal_id != goal.id
        || work.owner != ghost_id
    {
        return Err(host_apply::not_found(
            "Goal assignment is not backed by this authenticated Owner Goal admission",
        ));
    }
    Ok(())
}

fn verify_delegated_source(
    conn: &Connection,
    source: &SourceCommand,
    goal: &Goal,
    work: &Work,
    link: &WorkLink,
    ghost_id: &str,
    dispatch: bool,
) -> Result<(Work, Goal)> {
    host_apply::exact_fields(
        &source.envelope.body,
        &[
            "method",
            "parent_work_id",
            "target_ghost_id",
            "summary",
            "artifact_refs",
            "acceptance_spec",
        ],
    )?;
    let parent_work_id = host_apply::string_field(&source.envelope.body, "parent_work_id")?;
    let summary = validated_delegation_summary(host_apply::string_field(
        &source.envelope.body,
        "summary",
    )?)?;
    let artifact_refs = parse_opaque_refs(&source.envelope.body)?;
    let delegated_prompt = graph::delegated_prompt(&summary, &artifact_refs)?;
    if !link.current
        || link.child_work_id != work.id
        || link.parent_work_id != parent_work_id
        || host_apply::string_field(&source.envelope.body, "method")? != "work.delegate"
        || host_apply::string_field(&source.envelope.body, "target_ghost_id")? != ghost_id
        || delegated_prompt != goal.prompt
        || host_apply::value_field(&source.envelope.body, "acceptance_spec")? != &goal.acceptance_spec
        || source.response["data"]["goal"]["prompt"] != goal.prompt
        || source.response["data"]["link"]["child_work_id"] != work.id
        || source.response["data"]["link"]["parent_work_id"] != link.parent_work_id
        || source.response["data"]["link"]["parent_goal_revision"].as_u64()
            != Some(link.parent_goal_revision)
        || source.response["data"]["link"]["root_goal_id"] != link.root_goal_id
        || source.response["data"]["link"]["depth"].as_i64() != Some(link.depth)
        || source.response["data"]["link"]["current"] != true
        || source.response["data"]["root_goal_id"] != link.root_goal_id
    {
        return Err(host_apply::not_found(
            "Goal assignment does not match its committed parent delegation",
        ));
    }
    let parent_work = load_work(conn, &link.parent_work_id)?;
    let parent_goal = load_goal(conn, &parent_work.goal_id)?;
    if source.envelope.actor_ref != conversation::OWNER_PRINCIPAL
        && source.envelope.actor_ref != parent_work.owner
    {
        return Err(host_apply::reject(
            "unauthorized",
            "delegated assignment source was not committed by its registered parent owner",
            RetryClass::Never,
        ));
    }
    if parent_work.owner != parent_goal.accountable_ghost
        || parent_work.goal_revision != parent_goal.revision
        || link.parent_goal_revision != parent_goal.revision
        || (dispatch && (parent_goal.state != "open"
            || graph::remaining_deadline_ms(conn, work)?.is_none()))
    {
        return Err(host_apply::conflict(
            "delegated Goal assignment has stale, cancelled, or expired ancestry",
        ));
    }
    let expected_parent_revision = source
        .envelope
        .expected_revision
        .ok_or_else(|| host_apply::conflict("delegation source omitted its parent revision"))?;
    if expected_parent_revision != parent_goal.revision {
        return Err(host_apply::conflict(
            "delegated Goal assignment source targets a stale parent revision",
        ));
    }
    Ok((parent_work, parent_goal))
}

fn load_goal(conn: &Connection, goal_id: &str) -> Result<Goal> {
    let Some((column_revision, accountable_ghost, reply_conversation, privacy, payload)) = conn
        .query_row(
            "SELECT revision,accountable_ghost,reply_conversation,privacy,payload
             FROM lifetime_goals WHERE id=?1",
            [goal_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
    else {
        return Err(host_apply::not_found("Goal assignment Goal not found"));
    };
    let column_revision = u64::try_from(column_revision)
        .map_err(|_| host_apply::not_found("Goal assignment Goal revision is invalid"))?;
    if column_revision == 0 {
        return Err(host_apply::not_found("Goal assignment Goal revision is invalid"));
    }
    let goal: Goal = serde_json::from_str(&payload)
        .map_err(|_| host_apply::not_found("Goal assignment Goal record is invalid"))?;
    if goal.id != goal_id
        || goal.revision != column_revision
        || goal.accountable_ghost != accountable_ghost
        || goal.reply_conversation != reply_conversation
        || goal.privacy != privacy
        || !valid_privacy(&goal.privacy)
    {
        return Err(host_apply::not_found(
            "Goal assignment Goal record does not match its Host row",
        ));
    }
    Ok(goal)
}

fn load_work(conn: &Connection, work_id: &str) -> Result<Work> {
    let Some((goal_id, goal_revision, owner, owner_revision, state, execution_id, cancellation, payload)) = conn
        .query_row(
            "SELECT goal_id,goal_revision,owner,owner_revision,state,execution_id,cancellation,payload
             FROM lifetime_work WHERE id=?1",
            [work_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?
    else {
        return Err(host_apply::not_found("Goal assignment Work not found"));
    };
    let goal_revision = u64::try_from(goal_revision)
        .map_err(|_| host_apply::not_found("Goal assignment Work revision is invalid"))?;
    let owner_revision = u64::try_from(owner_revision)
        .map_err(|_| host_apply::not_found("Goal assignment Work owner revision is invalid"))?;
    if goal_revision == 0 || owner_revision == 0 {
        return Err(host_apply::not_found("Goal assignment Work revision is invalid"));
    }
    let work: Work = serde_json::from_str(&payload)
        .map_err(|_| host_apply::not_found("Goal assignment Work record is invalid"))?;
    if work.id != work_id
        || work.goal_id != goal_id
        || work.goal_revision != goal_revision
        || work.owner != owner
        || work.owner_revision != owner_revision
        || work.state != state
        || work.execution_id != execution_id
        || work.cancellation != cancellation
    {
        return Err(host_apply::not_found(
            "Goal assignment Work record does not match its Host row",
        ));
    }
    Ok(work)
}

struct WorkLink {
    child_work_id: String,
    parent_work_id: String,
    parent_goal_revision: u64,
    root_goal_id: String,
    depth: i64,
    current: bool,
}

fn load_link(conn: &Connection, work_id: &str) -> Result<Option<WorkLink>> {
    let row: Option<(String, String, i64, String, i64, i64)> = conn
        .query_row(
            "SELECT child_work_id,parent_work_id,parent_goal_revision,root_goal_id,depth,current
             FROM lifetime_work_links WHERE child_work_id=?1",
            [work_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    row.map(|(child_work_id, parent_work_id, parent_goal_revision, root_goal_id, depth, current)| {
        Ok(WorkLink {
            child_work_id,
            parent_work_id,
            parent_goal_revision: u64::try_from(parent_goal_revision)
                .map_err(|_| host_apply::not_found("Goal assignment parent revision is invalid"))?,
            root_goal_id,
            depth,
            current: current == 1,
        })
    })
    .transpose()
}


fn valid_privacy(privacy: &str) -> bool {
    matches!(privacy, "public" | "private" | "local_only")
}

/// Same admission limits and semantics as the delegation handler in graph.rs:
/// at most `ARTIFACT_REFS_MAX` opaque identity-shaped string references.
const ARTIFACT_REFS_MAX: usize = 32;
const DELEGATION_SUMMARY_MAX_BYTES: usize = 8192;

fn parse_opaque_refs(body: &Value) -> Result<Vec<String>> {
    let Some(items) = body.get("artifact_refs").and_then(Value::as_array) else {
        return Err(host_apply::invalid(
            "artifact_refs must be an array of strings",
        ));
    };
    if items.len() > ARTIFACT_REFS_MAX {
        return Err(host_apply::invalid(format!(
            "artifact_refs exceeds its limit of {ARTIFACT_REFS_MAX}"
        )));
    }
    items
        .iter()
        .map(|item| {
            let value = item.as_str().ok_or_else(|| {
                host_apply::invalid("artifact_refs must contain only strings")
            })?;
            host_apply::validate_identity("artifact_refs", value)?;
            Ok(value.to_owned())
        })
        .collect()
}

fn validated_delegation_summary(summary: &str) -> Result<&str> {
    host_apply::validate_text("summary", summary)?;
    if summary.len() > DELEGATION_SUMMARY_MAX_BYTES {
        return Err(host_apply::invalid(
            "delegation summary exceeds 8192 UTF-8 bytes",
        ));
    }
    Ok(summary)
}
