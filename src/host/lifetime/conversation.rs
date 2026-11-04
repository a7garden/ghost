use super::{apply as host_apply, db};
use crate::lifetime_contract::{
    canonical_digest, Artifact, Envelope, Response, ResponseStatus, RetryClass, RuntimeBinding,
};
use anyhow::{anyhow, bail, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_INPUT_TEXT_UTF8_BYTES: usize = 65_536;
const MAX_ATTACHMENTS: usize = 16;
const DEFAULT_PAGE_LIMIT: u64 = 100;
const MAX_PAGE_LIMIT: u64 = 100;
const MAX_DERIVED_GOALS_PER_TURN: i64 = 4;
pub(super) const OWNER_PRINCIPAL: &str = "owner";

pub(super) fn handles(method: &str) -> bool {
    matches!(
        method,
        "conversation.input"
            | "conversation.inspect"
            | "conversation.cancel_turn"
            | "conversation.turn_status"
            | "conversation.turn.inspect"
            | "conversation.assignment.inspect"
            | "conversation.report.inspect"
            | "conversation.report.reply"
            | "goal.create"
            | "conversation.reply"
    )
}

pub(super) fn apply(
    tx: &Transaction<'_>,
    envelope: &Envelope,
    principal: &str,
    context: &mut host_apply::ApplyContext,
) -> Result<Response> {
    let method = host_apply::string_field(&envelope.body, "method")?;
    match method {
        "conversation.input" => {
            require_owner(principal)?;
            conversation_input(tx, envelope, context)
        }
        "conversation.inspect" => {
            if principal != OWNER_PRINCIPAL {
                let ghost_id = host_apply::string_field(&envelope.body, "ghost_id")?;
                let conversation_id = host_apply::string_field(&envelope.body, "conversation_id")?;
                if principal != ghost_id {
                    return Err(host_apply::reject(
                        "unauthorized",
                        "canonical history is outside the authenticated Ghost scope",
                        RetryClass::Never,
                    ));
                }
                require_pi_binding(tx, ghost_id, conversation_id)?;
            }
            conversation_inspect(tx, &envelope.body, principal == OWNER_PRINCIPAL)
        }
        "conversation.cancel_turn" => {
            require_owner(principal)?;
            super::turn_runs::cancel_turn(tx, envelope, context)
        }
        "conversation.turn_status" => {
            super::turn_runs::report_status(tx, envelope, principal)
        }
        "conversation.turn.inspect" => {
            let mut response=super::turn_runs::inspect_turn(tx,&envelope.body,principal)?;
            if response.status==ResponseStatus::Success {
                let descriptor=super::task_contracts::turn_descriptor(tx,host_apply::string_field(&envelope.body,"turn_id")?,host_apply::string_field(&envelope.body,"ghost_id")?,host_apply::string_field(&envelope.body,"conversation_id")?)?;
                response.data["task_contract"]=descriptor.unwrap_or(Value::Null);
                response.data["task_admission"]=super::task_contracts::turn_admission(tx,host_apply::string_field(&envelope.body,"turn_id")?,host_apply::string_field(&envelope.body,"ghost_id")?,host_apply::string_field(&envelope.body,"conversation_id")?)?.unwrap_or(Value::Null);
            }
            Ok(response)
        }
        "conversation.report.inspect" => super::reports::inspect(tx, envelope, principal),
        "conversation.report.reply" => super::reports::reply(tx, envelope, principal),
        "conversation.assignment.inspect" => {
            super::assignments::inspect(tx, envelope, principal)
        }
        "goal.create" => goal_create(tx, envelope, principal, context),
        "conversation.reply" => conversation_reply(tx, envelope, principal),
        _ => Err(host_apply::reject(
            "unsupported_method",
            format!("unsupported canonical conversation method: {method}"),
            RetryClass::Never,
        )),
    }
}


fn require_owner(principal: &str) -> Result<()> {
    if principal != OWNER_PRINCIPAL {
        return Err(host_apply::reject(
            "unauthorized",
            "canonical owner conversation methods require owner authentication",
            RetryClass::Never,
        ));
    }
    Ok(())
}

pub(super) fn registered_mode(
    conn: &Connection,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<String> {
    host_apply::validate_identity("ghost_id", ghost_id)?;
    host_apply::validate_identity("conversation_id", conversation_id)?;
    let registered: Option<(String, String, String)> = conn
        .query_row(
            "SELECT conversation_id,kind,mode FROM lifetime_registry WHERE ghost_id=?1",
            [ghost_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((registered_conversation, kind, mode)) = registered else {
        return Err(host_apply::not_found("Ghost is not registered"));
    };
    if registered_conversation != conversation_id {
        return Err(host_apply::reject(
            "unauthorized",
            "conversation does not match the Ghost's immutable registered pair",
            RetryClass::Never,
        ));
    }
    if !matches!(kind.as_str(), "primary" | "specialist")
        || !matches!(mode.as_str(), "active" | "draining")
    {
        bail!("registered Ghost has an unsupported kind or mode");
    }
    Ok(mode)
}

pub(super) fn require_active(
    conn: &Connection,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<()> {
    if registered_mode(conn, ghost_id, conversation_id)? != "active" {
        return Err(host_apply::reject(
            "waiting_host",
            "Ghost is draining; new conversation or Goal admission is disabled",
            RetryClass::ReconcileFirst,
        ));
    }
    Ok(())
}

fn ensure_pi_binding(
    conn: &Connection,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<()> {
    match db::binding(conn, conversation_id)? {
        Some(binding)
            if binding.ghost_id == ghost_id && binding.runtime_kind == "pi-durable" =>
        {
            Ok(())
        }
        Some(_) => Err(host_apply::reject(
            "unauthorized",
            "registered conversation is bound to a different Ghost or runtime kind",
            RetryClass::Never,
        )),
        None => db::insert_binding(
            conn,
            &RuntimeBinding {
                conversation_id: conversation_id.to_owned(),
                ghost_id: ghost_id.to_owned(),
                runtime_kind: "pi-durable".to_owned(),
                runtime_release: "unresolved".to_owned(),
                storage_ref: format!("durable/{ghost_id}/{conversation_id}"),
            },
        ),
    }
}

pub(super) fn require_pi_binding(
    conn: &Connection,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<()> {
    match db::binding(conn, conversation_id)? {
        Some(binding)
            if binding.ghost_id == ghost_id && binding.runtime_kind == "pi-durable" =>
        {
            Ok(())
        }
        _ => Err(host_apply::reject(
            "unauthorized",
            "Pi callback is outside the canonical durable conversation binding",
            RetryClass::Never,
        )),
    }
}

fn validate_privacy(value: &str) -> Result<()> {
    if !matches!(value, "public" | "private" | "local_only") {
        return Err(host_apply::invalid(
            "privacy must be public, private, or local_only",
        ));
    }
    Ok(())
}

fn privacy_rank(value: &str) -> Option<u8> {
    match value {
        "public" => Some(0),
        "private" => Some(1),
        "local_only" => Some(2),
        _ => None,
    }
}

pub(super) fn raise_privacy(current: &mut String, candidate: &str) -> Result<()> {
    let current_rank = privacy_rank(current)
        .ok_or_else(|| anyhow!("stored conversation disclosure is invalid"))?;
    let candidate_rank = privacy_rank(candidate)
        .ok_or_else(|| anyhow!("stored turn or artifact privacy is invalid"))?;
    if candidate_rank > current_rank {
        current.clear();
        current.push_str(candidate);
    }
    Ok(())
}

pub(super) fn conversation_privacy(
    conn: &Connection,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<String> {
    let mut privacy = "public".to_owned();
    let stored: Option<String> = conn
        .query_row(
            "SELECT privacy FROM lifetime_conversation_disclosure WHERE ghost_id=?1 AND conversation_id=?2",
            params![ghost_id, conversation_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(stored) = stored {
        raise_privacy(&mut privacy, &stored)?;
    }

    let mut statement = conn.prepare(
        "SELECT DISTINCT privacy FROM lifetime_turns WHERE ghost_id=?1 AND conversation_id=?2",
    )?;
    let rows = statement.query_map(params![ghost_id, conversation_id], |row| {
        row.get::<_, String>(0)
    })?;
    for row in rows {
        raise_privacy(&mut privacy, &row?)?;
    }

    let mut statement = conn.prepare(
        "SELECT DISTINCT privacy FROM lifetime_goals WHERE accountable_ghost=?1 AND reply_conversation=?2",
    )?;
    let rows = statement.query_map(params![ghost_id, conversation_id], |row| {
        row.get::<_, String>(0)
    })?;
    for row in rows {
        raise_privacy(&mut privacy, &row?)?;
    }
    Ok(privacy)
}

pub(super) fn persist_disclosure(
    conn: &Connection,
    ghost_id: &str,
    conversation_id: &str,
    privacy: &str,
) -> Result<()> {
    validate_privacy(privacy)?;
    conn.execute(
        "INSERT INTO lifetime_conversation_disclosure(ghost_id,conversation_id,privacy)
         VALUES(?1,?2,?3)
         ON CONFLICT(ghost_id,conversation_id) DO UPDATE SET privacy=CASE
           WHEN lifetime_conversation_disclosure.privacy='local_only' OR excluded.privacy='local_only' THEN 'local_only'
           WHEN lifetime_conversation_disclosure.privacy='private' OR excluded.privacy='private' THEN 'private'
           ELSE 'public' END",
        params![ghost_id, conversation_id, privacy],
    )?;
    Ok(())
}

fn conversation_input(
    tx: &Transaction<'_>,
    envelope: &Envelope,
    context: &mut host_apply::ApplyContext,
) -> Result<Response> {
    host_apply::allowed_fields(
        &envelope.body,
        &[
            "method",
            "ghost_id",
            "conversation_id",
            "text",
            "privacy",
            "attachments", "task_contract",
        ],
        &["method","ghost_id","conversation_id","text","privacy","attachments"],
    )?;
    let ghost_id = host_apply::string_field(&envelope.body, "ghost_id")?;
    let conversation_id = host_apply::string_field(&envelope.body, "conversation_id")?;
    let text = host_apply::string_field(&envelope.body, "text")?;
    let requested_privacy = host_apply::string_field(&envelope.body, "privacy")?;
    host_apply::validate_text("text", text)?;
    if text.len() > MAX_INPUT_TEXT_UTF8_BYTES {
        return Err(host_apply::invalid(
            "conversation input exceeds 65536 UTF-8 bytes",
        ));
    }
    validate_privacy(requested_privacy)?;
    require_active(tx, ghost_id, conversation_id)?;
    ensure_pi_binding(tx, ghost_id, conversation_id)?;

    let task_privacy=super::task_contracts::bind_input(tx,envelope)?;
    let attachments: Vec<Artifact> = serde_json::from_value(
        host_apply::value_field(&envelope.body, "attachments")?.clone(),
    )
    .map_err(|error| host_apply::invalid(format!("invalid Artifact[] attachments: {error}")))?;
    if attachments.len() > MAX_ATTACHMENTS {
        return Err(host_apply::invalid(
            "conversation input exceeds 16 attachments",
        ));
    }
    for attachment in &attachments {
        validate_privacy(&attachment.privacy)?;
        if !artifact_is_in_scope(tx, ghost_id, conversation_id, attachment)? {
            return Err(host_apply::not_found(
                "attachment is not an existing current artifact in this conversation",
            ));
        }
    }

    let mut privacy = conversation_privacy(tx, ghost_id, conversation_id)?;
    raise_privacy(&mut privacy, requested_privacy)?;
    if let Some(task_privacy)=task_privacy {raise_privacy(&mut privacy,&task_privacy)?;}
    for attachment in &attachments {
        raise_privacy(&mut privacy, &attachment.privacy)?;
    }
    persist_disclosure(tx, ghost_id, conversation_id, &privacy)?;
    let sequence = append_turn(
        tx,
        &envelope.command_id,
        ghost_id,
        conversation_id,
        "owner",
        OWNER_PRINCIPAL,
        text,
        &privacy,
        "user",
        None,
        &attachments,
    )?;
    super::turn_runs::create_queued(
        tx,
        &envelope.command_id,
        ghost_id,
        conversation_id,
    )?;

    super::orchestra::admit_turn(tx, &envelope.command_id, ghost_id, conversation_id, &privacy)?;
    let outbox_body = json!({
        "method": "conversation.input",
        "ghost_id": ghost_id,
        "conversation_id": conversation_id,
        "turn_id": envelope.command_id,
        "prompt": text,
        "privacy": privacy,
        "attachments": attachments,
    });
    let outbox = host_apply::outgoing(envelope, ghost_id, None, outbox_body)?;
    context.enqueue("pi", outbox);
    Ok(host_apply::success(
        "owner turn durably recorded and queued",
        vec![envelope.command_id.clone()],
        json!({
            "turn_id": envelope.command_id,
            "sequence": sequence,
            "privacy": privacy,
            "queued": true,
        }),
    ))
}

fn artifact_is_in_scope(
    conn: &Connection,
    ghost_id: &str,
    conversation_id: &str,
    artifact: &Artifact,
) -> Result<bool> {
    let mut statement = conn.prepare(
        "SELECT r.payload FROM lifetime_results r
         JOIN lifetime_work w ON w.id=r.work_id
         JOIN lifetime_goals g ON g.id=w.goal_id
         WHERE g.accountable_ghost=?1 AND g.reply_conversation=?2
           AND r.execution_id=?3 AND r.goal_revision=g.revision
           AND w.goal_revision=g.revision",
    )?;
    let rows = statement.query_map(
        params![ghost_id, conversation_id, artifact.producing_attempt],
        |row| row.get::<_, String>(0),
    )?;
    let candidate = serde_json::to_value(artifact)?;
    for row in rows {
        let payload: Value = serde_json::from_str(&row?)?;
        if payload["current"] != true {
            continue;
        }
        let Some(stored_artifacts) = payload["event"]["artifacts"].as_array() else {
            continue;
        };
        if stored_artifacts.iter().any(|stored| stored == &candidate) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn conversation_inspect(
    tx: &Transaction<'_>,
    body: &Value,
    include_work_threads: bool,
) -> Result<Response> {
    allowed_fields(
        body,
        &["method", "ghost_id", "conversation_id", "before_sequence", "limit"],
        &["method", "ghost_id", "conversation_id"],
    )?;
    let ghost_id = host_apply::string_field(body, "ghost_id")?;
    let conversation_id = host_apply::string_field(body, "conversation_id")?;
    registered_mode(tx, ghost_id, conversation_id)?;
    let privacy = conversation_privacy(tx, ghost_id, conversation_id)?;
    let before_sequence = match body.get("before_sequence") {
        None => None,
        Some(value) => Some(
            value
                .as_u64()
                .ok_or_else(|| host_apply::invalid("before_sequence must be an unsigned integer"))?,
        ),
    };
    let limit = match body.get("limit") {
        None => DEFAULT_PAGE_LIMIT,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| host_apply::invalid("limit must be a positive integer"))?,
    };
    if limit == 0 || limit > MAX_PAGE_LIMIT {
        return Err(host_apply::invalid("conversation page limit must be 1..=100"));
    }
    let before_sql = before_sequence
        .map(|sequence| {
            i64::try_from(sequence)
                .map_err(|_| host_apply::invalid("before_sequence exceeds SQLite range"))
        })
        .transpose()?;
    let limit_sql = i64::try_from(limit)
        .map_err(|_| host_apply::invalid("conversation page limit exceeds SQLite range"))?;

    let mut statement = tx.prepare(
        "SELECT t.id,t.sequence,t.sender_kind,t.sender_ref,t.text,t.privacy,t.kind,t.source_turn_id,t.attachments,t.created_at_ms,r.report_id
         FROM lifetime_turns AS t
         LEFT JOIN lifetime_report_replies AS r ON r.reply_turn_id=t.id
         WHERE t.ghost_id=?1 AND t.conversation_id=?2 AND (?3 IS NULL OR t.sequence<?3)
         ORDER BY t.sequence DESC LIMIT ?4",
    )?;
    let rows = statement.query_map(
        params![ghost_id, conversation_id, before_sql, limit_sql],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, Option<String>>(10)?,
            ))
        },
    )?;
    let mut turns = Vec::new();
    for row in rows {
        let (
            id,
            sequence,
            sender_kind,
            sender_ref,
            text,
            turn_privacy,
            kind,
            source_turn_id,
            attachments,
            created_at_ms,
            origin_report_id,
        ) = row?;
        let sequence = u64::try_from(sequence)
            .map_err(|_| anyhow!("stored conversation sequence is invalid"))?;
        let attachments: Value = serde_json::from_str(&attachments)?;
        if !attachments.is_array() {
            bail!("stored conversation attachments are not an array");
        }
        let mut turn = json!({
            "id": id,
            "sequence": sequence,
            "sender_kind": sender_kind,
            "sender_ref": sender_ref,
            "text": text,
            "privacy": turn_privacy,
            "kind": kind,
            "source_turn_id": source_turn_id,
            "origin_report_id": origin_report_id,
            "attachments": attachments,
            "created_at_ms": created_at_ms,
        });
        if include_work_threads {
            let thread_ids = super::work_threads::turn_goal_ids(tx, &id)?;
            if !thread_ids.is_empty() {
                turn["work_thread_ids"] = json!(thread_ids);
            }
        }
        turns.push(turn);
    }
    turns.reverse();
    let oldest_sequence = turns
        .first()
        .and_then(|turn| turn["sequence"].as_u64());
    let has_older = if let Some(oldest) = oldest_sequence {
        let oldest_sql = i64::try_from(oldest)
            .map_err(|_| anyhow!("stored conversation sequence exceeds SQLite range"))?;
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM lifetime_turns WHERE ghost_id=?1 AND conversation_id=?2 AND sequence<?3)",
            params![ghost_id, conversation_id, oldest_sql],
            |row| row.get::<_, bool>(0),
        )?
    } else {
        false
    };
    let turn_runs =
        super::turn_runs::inspect_page(tx, ghost_id, conversation_id, before_sql, limit_sql)?;
    Ok(host_apply::success(
        "canonical conversation history inspected",
        vec![ghost_id.to_owned(), conversation_id.to_owned()],
        json!({
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
            "privacy": privacy,
            "turns": turns,
            "turn_runs": turn_runs,
            "has_older": has_older,
            "oldest_sequence": oldest_sequence,
        }),
    ))
}

fn goal_create(
    tx: &Transaction<'_>,
    envelope: &Envelope,
    principal: &str,
    context: &mut host_apply::ApplyContext,
) -> Result<Response> {
    let resolved=super::task_contracts::resolve_goal_body(tx,&envelope.body,true)?;
    host_apply::exact_fields(
        &resolved,
        &[
            "method",
            "turn_id",
            "ghost_id",
            "conversation_id",
            "prompt",
            "acceptance_spec",
        ],
    )?;
    let turn_id = host_apply::string_field(&resolved, "turn_id")?;
    let requested_ghost = host_apply::string_field(&resolved, "ghost_id")?;
    let requested_conversation = host_apply::string_field(&resolved, "conversation_id")?;
    let prompt = host_apply::string_field(&resolved, "prompt")?;
    host_apply::validate_text("prompt", prompt)?;
    if principal != requested_ghost {
        return Err(host_apply::reject(
            "unauthorized",
            "goal.create requires the authenticated Ghost conversation scope",
            RetryClass::Never,
        ));
    }
    require_active(tx, requested_ghost, requested_conversation)?;
    require_pi_binding(tx, requested_ghost, requested_conversation)?;
    let (
        turn_ghost,
        turn_conversation,
        turn_sender_kind,
        turn_sender_ref,
        turn_kind,
        turn_privacy,
    ) = turn_scope(tx, turn_id)?.ok_or_else(|| host_apply::not_found("origin owner turn not found"))?;
    if turn_ghost != requested_ghost
        || turn_conversation != requested_conversation
        || turn_sender_kind != "owner"
        || turn_sender_ref != OWNER_PRINCIPAL
        || turn_kind != "user"
    {
        return Err(host_apply::reject(
            "unauthorized",
            "goal origin is not a user turn in the authenticated registered conversation",
            RetryClass::Never,
        ));
    }
    super::turn_runs::ensure_goal_admission(tx, &turn_ghost, &turn_conversation, turn_id)?;
    let acceptance_spec = host_apply::value_field(&resolved, "acceptance_spec")?.clone();
    if !acceptance_spec.is_object() {
        return Err(host_apply::invalid("acceptance_spec must be an object"));
    }

    if let Some(reference)=envelope.body.get("task_contract_ref") {
        let prior:Option<String>=tx.query_row("SELECT response FROM lifetime_commands WHERE actor_ref=?1 AND json_extract(request,'$.body.method')='goal.create' AND json_extract(request,'$.body.turn_id')=?2 AND json_extract(request,'$.body.task_contract_ref')=?3 AND json_extract(response,'$.status')='success' ORDER BY rowid LIMIT 1",params![principal,turn_id,reference.as_str()],|r|r.get(0)).optional()?;
        if let Some(prior)=prior {return Ok(serde_json::from_str(&prior)?);}
    }
    let prior_goals: i64 = tx.query_row(
        "SELECT COUNT(*) FROM lifetime_turn_goals WHERE turn_id=?1",
        [turn_id],
        |row| row.get(0),
    )?;
    if prior_goals >= MAX_DERIVED_GOALS_PER_TURN {
        return Err(host_apply::reject(
            "limit_reached",
            "an owner turn may create at most four derived Goals",
            RetryClass::NewRevision,
        ));
    }

    let mut privacy = conversation_privacy(tx, &turn_ghost, &turn_conversation)?;
    raise_privacy(&mut privacy, &turn_privacy)?;
    let admission_body = json!({
        "method": "goal.submit",
        "ghost_id": turn_ghost,
        "conversation_id": turn_conversation,
        "prompt": prompt,
        "privacy": privacy,
        "acceptance_spec": acceptance_spec,
    });
    let mut admission_envelope = envelope.clone();
    admission_envelope.payload_digest = canonical_digest(&admission_body)?;
    admission_envelope.body = admission_body;
    admission_envelope.expected_revision = None;
    let mut response = host_apply::admit_goal(
        tx,
        &admission_envelope,
        principal,
        context,
        true,
    )?;
    if response.status == ResponseStatus::Error {
        return Ok(response);
    }
    if response.status != ResponseStatus::Success {
        bail!("derived Goal admission returned a non-success response");
    }
    let goal_id = response.data["goal"]["id"]
        .as_str()
        .ok_or_else(|| anyhow!("Goal admission response omitted its Goal identity"))?;
    // Registered task contracts retain their original verification and
    // disclosure authority, including on public Owner turns.
    if envelope.body.get("task_contract_ref").is_none() {
        super::orchestra::admit_goal(tx, turn_id, goal_id, acceptance_spec.get("orchestra_task"))?;
    }
    tx.execute(
        "INSERT INTO lifetime_turn_goals(turn_id,goal_id) VALUES(?1,?2)",
        params![turn_id, goal_id],
    )?;
    let data = response
        .data
        .as_object_mut()
        .ok_or_else(|| anyhow!("Goal admission response data is not an object"))?;
    data.insert("origin_turn_id".to_owned(), json!(turn_id));
    Ok(response)
}

fn conversation_reply(
    tx: &Transaction<'_>,
    envelope: &Envelope,
    principal: &str,
) -> Result<Response> {
    host_apply::allowed_fields(
        &envelope.body,
        &["method", "turn_id", "ghost_id", "conversation_id", "text", "memory_context_revision"],
        &["method", "turn_id", "ghost_id", "conversation_id", "text"],
    )?;
    let turn_id = host_apply::string_field(&envelope.body, "turn_id")?;
    let ghost_id = host_apply::string_field(&envelope.body, "ghost_id")?;
    let conversation_id = host_apply::string_field(&envelope.body, "conversation_id")?;
    let text = host_apply::string_field(&envelope.body, "text")?;
    host_apply::validate_text("text", text)?;
    if principal != ghost_id {
        return Err(host_apply::reject(
            "unauthorized",
            "conversation.reply requires the authenticated Ghost conversation scope",
            RetryClass::Never,
        ));
    }
    registered_mode(tx, ghost_id, conversation_id)?;
    require_pi_binding(tx, ghost_id, conversation_id)?;
    let (
        turn_ghost,
        turn_conversation,
        turn_sender_kind,
        turn_sender_ref,
        turn_kind,
        turn_privacy,
    ) = turn_scope(tx, turn_id)?.ok_or_else(|| host_apply::not_found("origin owner turn not found"))?;
    if turn_ghost != ghost_id
        || turn_conversation != conversation_id
        || turn_sender_kind != "owner"
        || turn_sender_ref != OWNER_PRINCIPAL
        || turn_kind != "user"
    {
        return Err(host_apply::reject(
            "unauthorized",
            "reply origin is not a user turn in the authenticated registered conversation",
            RetryClass::Never,
        ));
    }
    super::turn_runs::check_reply(tx, ghost_id, conversation_id, turn_id)?;
    super::task_contracts::require_reply_admission(tx, turn_id, ghost_id, conversation_id)?;
    if !super::super::bots_provisioning::creation_reply_admitted(tx, turn_id, ghost_id, conversation_id)? {
        return Err(host_apply::reject("bot_creation_incomplete", "The prepared Owner bot creation has no armed evaluation/provisioning responsibility", RetryClass::Never));
    }
    let mut privacy = conversation_privacy(tx, ghost_id, conversation_id)?;
    raise_privacy(&mut privacy, &turn_privacy)?;
    persist_disclosure(tx, ghost_id, conversation_id, &privacy)?;
    let sequence = append_turn(
        tx,
        &envelope.command_id,
        ghost_id,
        conversation_id,
        "ghost",
        ghost_id,
        text,
        &privacy,
        "assistant_advisory",
        Some(turn_id),
        &[],
    )?;
    super::turn_runs::record_reply(tx, ghost_id, conversation_id, turn_id)?;
    Ok(host_apply::success(
        "committed advisory reply recorded",
        vec![envelope.command_id.clone()],
        json!({
            "turn_id": envelope.command_id,
            "sequence": sequence,
            "privacy": privacy,
            "kind": "assistant_advisory",
            "source_turn_id": turn_id,
        }),
    ))
}

pub(super) fn turn_scope(
    conn: &Connection,
    turn_id: &str,
) -> Result<Option<(String, String, String, String, String, String)>> {
    conn.query_row(
        "SELECT ghost_id,conversation_id,sender_kind,sender_ref,kind,privacy FROM lifetime_turns WHERE id=?1",
        [turn_id],
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
    .optional()
    .map_err(Into::into)
}

pub(super) fn append_turn(
    conn: &Connection,
    id: &str,
    ghost_id: &str,
    conversation_id: &str,
    sender_kind: &str,
    sender_ref: &str,
    text: &str,
    privacy: &str,
    kind: &str,
    source_turn_id: Option<&str>,
    attachments: &[Artifact],
) -> Result<u64> {
    let previous: Option<i64> = conn.query_row(
        "SELECT MAX(sequence) FROM lifetime_turns WHERE ghost_id=?1 AND conversation_id=?2",
        params![ghost_id, conversation_id],
        |row| row.get(0),
    )?;
    let sequence = previous
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| anyhow!("conversation sequence exhausted SQLite integer range"))?;
    if sequence <= 0 {
        bail!("stored conversation sequence is invalid");
    }
    let created_at_ms = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_millis(),
    )
    .map_err(|_| anyhow!("conversation timestamp exceeds SQLite integer range"))?;
    let attachments = serde_json::to_string(attachments)?;
    conn.execute(
        "INSERT INTO lifetime_turns(id,ghost_id,conversation_id,sequence,sender_kind,sender_ref,text,privacy,kind,source_turn_id,attachments,created_at_ms)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            id,
            ghost_id,
            conversation_id,
            sequence,
            sender_kind,
            sender_ref,
            text,
            privacy,
            kind,
            source_turn_id,
            attachments,
            created_at_ms,
        ],
    )?;
    u64::try_from(sequence).map_err(|_| anyhow!("conversation sequence is negative"))
}

pub(super) fn allowed_fields(body: &Value, allowed: &[&str], required: &[&str]) -> Result<()> {
    let Some(object) = body.as_object() else {
        return Err(host_apply::invalid("command body must be an object"));
    };
    if required.iter().any(|field| !object.contains_key(*field)) {
        return Err(host_apply::invalid("command body is missing a required field"));
    }
    if object.keys().any(|field| !allowed.contains(&field.as_str())) {
        return Err(host_apply::invalid("command body contains an unknown field"));
    }
    Ok(())
}
