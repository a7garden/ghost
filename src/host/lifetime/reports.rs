use super::{apply as host_apply, assignments, conversation};
use crate::lifetime_contract::{Envelope, Goal, Response};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

struct ReportSource {
    outbox_id: i64,
    source_command_id: String,
    receiver: Envelope,
    goal: Goal,
    origin_privacy: Option<String>,
    producing_work: Option<crate::lifetime_contract::Work>,
}

struct StoredReply {
    turn_id: String,
    sequence: u64,
    text: String,
    text_digest: String,
}

fn request_scope<'a>(
    tx: &Transaction<'_>,
    envelope: &'a Envelope,
    principal: &str,
    expected_method: &str,
    body_fields: &[&str],
) -> Result<(&'a str, &'a str, &'a str)> {
    host_apply::exact_fields(&envelope.body, body_fields)?;
    if host_apply::string_field(&envelope.body, "method")? != expected_method {
        return Err(host_apply::invalid("unexpected work-report method"));
    }
    let report_id = host_apply::string_field(&envelope.body, "report_id")?;
    let ghost_id = host_apply::string_field(&envelope.body, "ghost_id")?;
    let conversation_id = host_apply::string_field(&envelope.body, "conversation_id")?;
    host_apply::validate_identity("report_id", report_id)?;
    host_apply::validate_identity("ghost_id", ghost_id)?;
    host_apply::validate_identity("conversation_id", conversation_id)?;
    if principal != ghost_id {
        return Err(host_apply::reject(
            "unauthorized",
            "work reports require the authenticated Ghost for the registered pair",
            crate::lifetime_contract::RetryClass::Never,
        ));
    }
    conversation::registered_mode(tx, ghost_id, conversation_id)?;
    conversation::require_pi_binding(tx, ghost_id, conversation_id)?;
    Ok((report_id, ghost_id, conversation_id))
}

fn valid_privacy(privacy: &str) -> bool {
    matches!(privacy, "public" | "private" | "local_only")
}

fn load_source(
    tx: &rusqlite::Connection,
    report_id: &str,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<ReportSource> {
    let (outbox_id, source_command_id, target, payload) = {
        let mut statement = tx.prepare(
            "SELECT id,command_id,target,payload FROM lifetime_outbox WHERE delivery_ref=?1 LIMIT 2",
        )?;
        let mut rows = statement.query([report_id])?;
        let Some(first) = rows.next()? else {
            return Err(host_apply::not_found("work report source not found"));
        };
        let source = (
            first.get::<_, i64>(0)?,
            first.get::<_, String>(1)?,
            first.get::<_, String>(2)?,
            first.get::<_, String>(3)?,
        );
        if rows.next()?.is_some() {
            return Err(host_apply::conflict(
                "work report delivery reference is ambiguous",
            ));
        }
        source
    };
    if target != "pi" {
        return Err(host_apply::not_found("work report is not a Pi delivery"));
    }
    host_apply::validate_identity("source_command_id", &source_command_id)?;

    let receiver: Envelope = serde_json::from_str(&payload)
        .map_err(|_| host_apply::not_found("work report source envelope is invalid"))?;
    if receiver.validate().is_err() || receiver.command_id != report_id {
        return Err(host_apply::not_found(
            "work report source envelope does not match its delivery reference",
        ));
    }
    host_apply::exact_fields(
        &receiver.body,
        &[
            "method",
            "ghost_id",
            "conversation_id",
            "prompt",
            "privacy",
            "goal_id",
            "goal_revision",
        ],
    )?;
    if host_apply::string_field(&receiver.body, "method")? != "conversation.submit" {
        return Err(host_apply::not_found(
            "work report source is not a canonical conversation submission",
        ));
    }
    if host_apply::string_field(&receiver.body, "ghost_id")? != ghost_id
        || host_apply::string_field(&receiver.body, "conversation_id")? != conversation_id
    {
        return Err(host_apply::not_found("work report source is outside this Ghost pair"));
    }
    let goal_id = host_apply::string_field(&receiver.body, "goal_id")?;
    host_apply::validate_identity("goal_id", goal_id)?;
    let report_revision = host_apply::number_field(&receiver.body, "goal_revision")?;
    let original_privacy = host_apply::string_field(&receiver.body, "privacy")?;
    let prompt = host_apply::string_field(&receiver.body, "prompt")?;
    if !valid_privacy(original_privacy) {
        return Err(host_apply::not_found("work report privacy is invalid"));
    }
    host_apply::validate_text("prompt", prompt)?;

    let goal_columns: Option<(i64, String, String, String, String)> = tx
        .query_row(
            "SELECT revision,accountable_ghost,reply_conversation,privacy,payload
             FROM lifetime_goals WHERE id=?1",
            [goal_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    let Some((column_revision, column_ghost, column_conversation, column_privacy, payload)) =
        goal_columns
    else {
        return Err(host_apply::not_found("work report Goal not found"));
    };
    let current_revision = u64::try_from(column_revision)
        .map_err(|_| host_apply::not_found("work report Goal revision is invalid"))?;
    if current_revision == 0 {
        return Err(host_apply::not_found("work report Goal revision is invalid"));
    }
    if report_revision != current_revision {
        return Err(host_apply::conflict("work report targets a stale Goal revision"));
    }
    let goal: Goal = serde_json::from_str(&payload)
        .map_err(|_| host_apply::not_found("work report Goal record is invalid"))?;
    if goal.id != goal_id
        || goal.revision != current_revision
        || goal.accountable_ghost != column_ghost
        || goal.reply_conversation != column_conversation
        || goal.privacy != column_privacy
        || column_ghost != ghost_id
        || column_conversation != conversation_id
        || !valid_privacy(&goal.privacy)
    {
        return Err(host_apply::not_found(
            "work report Goal record does not match the registered pair",
        ));
    }

    let origin: Option<(String, String, String, String, String)> = tx
        .query_row(
            "SELECT t.ghost_id,t.conversation_id,t.sender_kind,t.sender_ref,t.kind
             FROM lifetime_turn_goals link
             JOIN lifetime_turns t ON t.id=link.turn_id
             WHERE link.goal_id=?1",
            [goal_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    let (goal, origin_privacy) = match origin {
        Some((origin_ghost, origin_conversation, sender_kind, sender_ref, turn_kind)) => {
            if origin_ghost != ghost_id
                || origin_conversation != conversation_id
                || sender_kind != "owner"
                || sender_ref != conversation::OWNER_PRINCIPAL
                || turn_kind != "user"
            {
                return Err(host_apply::not_found(
                    "work report Goal has no canonical Owner-turn origin",
                ));
            }
            (goal, None)
        }
        None => {
            let (goal, privacy) = assignments::report_origin(tx, goal, ghost_id, conversation_id)?;
            (goal, Some(privacy))
        }
    };

    // Resolve the producing Work from this report's committed source command;
    // never select an unrelated/latest Work merely because its Goal matches.
    let execution:Option<String>=tx.query_row("SELECT json_extract(request,'$.body.execution_id') FROM lifetime_commands WHERE command_id=?1",[&source_command_id],|r|r.get(0)).optional()?.flatten();
    let notice_work=super::task_verification::report_work(tx,&source_command_id,report_id)?;
    let work:Option<crate::lifetime_contract::Work>=if notice_work.is_some(){notice_work}else if let Some(execution)=execution {
        let mut q=tx.prepare("SELECT payload FROM lifetime_work WHERE execution_id=?1 AND goal_id=?2 AND json_extract(payload,'$.goal_revision')=?3 LIMIT 2")?;
        let rows=q.query_map(params![execution,goal.id,goal.revision],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.len()>1 {return Err(host_apply::conflict("Report producer execution identifies multiple Works"));}
        rows.first().map(|raw|serde_json::from_str(raw)).transpose()?
    }else{None};
    if let Some(work)=&work {if work.goal_id!=goal.id || work.goal_revision!=goal.revision {return Err(host_apply::conflict("Report verifier source is outside this Goal revision"));}}

    Ok(ReportSource {
        outbox_id,
        source_command_id,
        receiver,
        goal,
        origin_privacy,
        producing_work: work,
    })
}

pub(super) fn bot_repair_goal(conn:&rusqlite::Connection,report_id:&str,ghost_id:&str,conversation_id:&str)->Result<Goal> {
    conversation::registered_mode(conn,ghost_id,conversation_id)?;
    conversation::require_pi_binding(conn,ghost_id,conversation_id)?;
    Ok(load_source(conn,report_id,ghost_id,conversation_id)?.goal)
}

fn report_privacy(
    tx: &Transaction<'_>,
    source: &ReportSource,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<String> {
    let mut privacy = conversation::conversation_privacy(tx, ghost_id, conversation_id)?;
    conversation::raise_privacy(
        &mut privacy,
        host_apply::string_field(&source.receiver.body, "privacy")?,
    )?;
    conversation::raise_privacy(&mut privacy, &source.goal.privacy)?;
    if let Some(origin_privacy) = &source.origin_privacy {
        conversation::raise_privacy(&mut privacy, origin_privacy)?;
    }
    Ok(privacy)
}

fn text_digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn load_reply(
    tx: &Transaction<'_>,
    source: &ReportSource,
    report_id: &str,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<Option<StoredReply>> {
    let stored: Option<(i64, String, String)> = tx
        .query_row(
            "SELECT outbox_id,reply_turn_id,text_digest
             FROM lifetime_report_replies WHERE report_id=?1",
            [report_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((outbox_id, turn_id, stored_digest)) = stored else {
        return Ok(None);
    };
    if outbox_id != source.outbox_id {
        bail!("work report reply is correlated to a different outbox row");
    }

    let turn: Option<(String, String, String, String, String, Option<String>, i64, String, String)> =
        tx.query_row(
            "SELECT ghost_id,conversation_id,sender_kind,sender_ref,kind,source_turn_id,
                    sequence,text,privacy
             FROM lifetime_turns WHERE id=?1",
            [&turn_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .optional()?;
    let Some((turn_ghost, turn_conversation, sender_kind, sender_ref, kind, source_turn_id, sequence, text, privacy)) = turn else {
        bail!("work report reply turn is missing");
    };
    if turn_ghost != ghost_id
        || turn_conversation != conversation_id
        || sender_kind != "ghost"
        || sender_ref != ghost_id
        || kind != "assistant_advisory"
        || source_turn_id.is_some()
        || sequence <= 0
        || !valid_privacy(&privacy)
        || text.trim().is_empty()
        || text_digest(&text) != stored_digest
    {
        bail!("work report reply correlation is inconsistent");
    }
    let sequence = u64::try_from(sequence).map_err(|_| anyhow::anyhow!("invalid report reply sequence"))?;
    Ok(Some(StoredReply {
        turn_id,
        sequence,
        text,
        text_digest: stored_digest,
    }))
}

fn reply_value(reply: Option<&StoredReply>) -> Value {
    match reply {
        Some(reply) => json!({
            "turn_id": reply.turn_id,
            "sequence": reply.sequence,
            "text": reply.text,
            "text_digest": reply.text_digest,
        }),
        None => Value::Null,
    }
}

pub(super) fn inspect(
    tx: &Transaction<'_>,
    envelope: &Envelope,
    principal: &str,
) -> Result<Response> {
    let (report_id, ghost_id, conversation_id) = request_scope(
        tx,
        envelope,
        principal,
        "conversation.report.inspect",
        &["method", "report_id", "ghost_id", "conversation_id"],
    )?;
    let source = load_source(tx, report_id, ghost_id, conversation_id)?;
    let privacy = report_privacy(tx, &source, ghost_id, conversation_id)?;
    let reply = load_reply(tx, &source, report_id, ghost_id, conversation_id)?;
    let prompt = host_apply::string_field(&source.receiver.body, "prompt")?;
    let verification=source.producing_work.as_ref().map(|work|super::task_verification::view(tx,work)).transpose()?.flatten();
    Ok(host_apply::success(
        "canonical Work report inspected",
        vec![report_id.to_owned()],
        json!({
            "independent_verification":verification,
            "report": {
                "id": report_id,
                "source_command_id": source.source_command_id,
                "ghost_id": ghost_id,
                "conversation_id": conversation_id,
                "goal_id": source.goal.id,
                "goal_revision": source.goal.revision,
                "privacy": privacy,
                "prompt": prompt,
                "reply": reply_value(reply.as_ref()),
            }
        }),
    ))
}

pub(super) fn reply(
    tx: &Transaction<'_>,
    envelope: &Envelope,
    principal: &str,
) -> Result<Response> {
    let (report_id, ghost_id, conversation_id) = request_scope(
        tx,
        envelope,
        principal,
        "conversation.report.reply",
        &["method", "report_id", "ghost_id", "conversation_id", "text"],
    )?;
    let text = host_apply::string_field(&envelope.body, "text")?;
    host_apply::validate_text("text", text)?;
    let source = load_source(tx, report_id, ghost_id, conversation_id)?;
    let privacy = report_privacy(tx, &source, ghost_id, conversation_id)?;
    if let Some(existing) = load_reply(tx, &source, report_id, ghost_id, conversation_id)? {
        if existing.text != text {
            return Err(host_apply::conflict(
                "work report already has a different committed reply",
            ));
        }
        return Ok(host_apply::success(
            "original Work report reply recovered",
            vec![report_id.to_owned()],
            json!({
                "report_id": report_id,
                "reply_id": existing.turn_id,
                "sequence": existing.sequence,
                "replayed": true,
            }),
        ));
    }

    conversation::persist_disclosure(tx, ghost_id, conversation_id, &privacy)?;
    let sequence = conversation::append_turn(
        tx,
        &envelope.command_id,
        ghost_id,
        conversation_id,
        "ghost",
        ghost_id,
        text,
        &privacy,
        "assistant_advisory",
        None,
        &[],
    )?;
    let digest = text_digest(text);
    tx.execute(
        "INSERT INTO lifetime_report_replies(report_id,outbox_id,reply_turn_id,text_digest)
         VALUES(?1,?2,?3,?4)",
        params![report_id, source.outbox_id, envelope.command_id, digest],
    )?;
    Ok(host_apply::success(
        "canonical Work report reply recorded",
        vec![report_id.to_owned()],
        json!({
            "report_id": report_id,
            "reply_id": envelope.command_id,
            "sequence": sequence,
            "replayed": false,
        }),
    ))
}
