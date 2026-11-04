use super::{
    apply,
    conversation::{self, OWNER_PRINCIPAL},
    db, graph,
};
use crate::lifetime_contract::{Goal, Response, RetryClass};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

const GOAL_UPDATE_FIELDS: &[&str] = &["method", "goal_id", "prompt", "acceptance_spec"];
const MAX_FOLLOW_UP_BYTES: usize = 16_384;
const MAX_THREAD_PROMPT_BYTES: usize = 65_536;

pub(super) fn goal_update_fields(body: &Value) -> Result<()> {
    apply::allowed_fields(
        body,
        &[
            "method",
            "goal_id",
            "prompt",
            "acceptance_spec",
            "follow_up",
        ],
        GOAL_UPDATE_FIELDS,
    )
}

pub(super) fn validate_follow_up(
    conn: &Connection,
    body: &Value,
    goal: &Goal,
    principal: &str,
    prompt: &str,
    acceptance_spec: &Value,
) -> Result<()> {
    if principal != OWNER_PRINCIPAL {
        return Err(apply::reject(
            "unauthorized",
            "Work thread follow-ups require Owner administration",
            RetryClass::Never,
        ));
    }
    if let Some(reason) = follow_up_blocker(conn, goal)? {
        return Err(apply::reject(
            "follow_up_unavailable",
            reason,
            RetryClass::Never,
        ));
    }
    let text = apply::string_field(body, "follow_up")?;
    apply::validate_text("follow_up", text)?;
    if text.len() > MAX_FOLLOW_UP_BYTES || prompt.len() > MAX_THREAD_PROMPT_BYTES {
        return Err(apply::invalid(
            "Work thread instructions exceed the UTF-8 size limit",
        ));
    }
    if prompt != format!("{}\n\nOwner follow-up:\n{text}", goal.prompt)
        || acceptance_spec != &goal.acceptance_spec
    {
        return Err(apply::invalid(
            "A Work thread follow-up must append to the current prompt and preserve acceptance conditions",
        ));
    }
    Ok(())
}

fn follow_up_blocker(conn: &Connection, goal: &Goal) -> Result<Option<&'static str>> {
    if goal.acceptance_spec["verifier"]["kind"] == "owner-task-verifier/1"
        || graph::has_goal_link_history(conn, &goal.id)?
    {
        return Ok(Some("fixed_contract"));
    }
    let owner_origin = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM lifetime_turn_goals WHERE goal_id=?1)
           OR EXISTS(SELECT 1 FROM lifetime_commands WHERE actor_ref='owner'
             AND json_extract(request,'$.body.method')='goal.submit'
             AND json_extract(response,'$.status')='success'
             AND json_extract(response,'$.data.goal.id')=?1)",
        [&goal.id],
        |row| row.get::<_, bool>(0),
    )?;
    if !owner_origin {
        return Ok(Some("fixed_contract"));
    }
    let current_privacy = conversation::conversation_privacy(
        conn,
        &goal.accountable_ghost,
        &goal.reply_conversation,
    )?;
    let mut privacy = goal.privacy.clone();
    conversation::raise_privacy(&mut privacy, &current_privacy)?;
    if privacy != goal.privacy {
        return Ok(Some("disclosure_changed"));
    }
    // Reserve the new revision only between native effects. A pending or
    // unknown effect must retain the authority needed to reconcile its receipt.
    let unsettled = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM lifetime_work w
           JOIN lifetime_pi_effects e ON e.execution_id=w.execution_id
           LEFT JOIN lifetime_work_links l ON l.child_work_id=w.id AND l.current=1
           WHERE (w.goal_id=?1 OR l.root_goal_id=?1)
             AND w.cancellation<>'confirmed' AND e.state<>'complete'
         )",
        [&goal.id],
        |row| row.get::<_, bool>(0),
    )?;
    Ok(unsettled.then_some("effect_unsettled"))
}

/// These links belong to the canonical turn. Report links use the original
/// delivery so old reports still open the same thread after a Goal revision.
pub(super) fn turn_goal_ids(conn: &Connection, turn_id: &str) -> Result<Vec<String>> {
    let mut statement = conn.prepare_cached(
        "SELECT goal_id FROM lifetime_turn_goals WHERE turn_id=?1
         UNION
         SELECT json_extract(o.payload,'$.body.goal_id')
         FROM lifetime_report_replies AS r
         JOIN lifetime_outbox AS o ON o.id=r.outbox_id
         WHERE r.reply_turn_id=?1
         ORDER BY 1",
    )?;
    let ids = statement.query_map([turn_id], |row| row.get(0))?;
    Ok(ids.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(super) fn inspect(conn: &Connection, body: &Value, principal: &str) -> Result<Response> {
    if principal != OWNER_PRINCIPAL {
        return Err(apply::reject(
            "unauthorized",
            "Work thread history requires Owner administration",
            RetryClass::Never,
        ));
    }
    apply::exact_fields(body, &["method", "goal_id"])?;
    let goal_id = apply::string_field(body, "goal_id")?;
    let goal = db::goal(conn, goal_id)?.ok_or_else(|| apply::not_found("goal not found"))?;
    let origin = conn.query_row(
        "SELECT t.id,t.text,t.created_at_ms FROM lifetime_turn_goals AS g
         JOIN lifetime_turns AS t ON t.id=g.turn_id
         WHERE g.goal_id=?1 AND t.ghost_id=?2 AND t.conversation_id=?3",
        params![goal_id, goal.accountable_ghost, goal.reply_conversation],
        |row| Ok(json!({"id": row.get::<_, String>(0)?, "text": row.get::<_, String>(1)?, "created_at_ms": row.get::<_, i64>(2)?})),
    ).optional()?;

    let mut statement = conn.prepare(
        "SELECT c.command_id,json_extract(c.request,'$.body.follow_up'),json_extract(c.response,'$.data.goal.revision')
         FROM lifetime_outbox AS o
         JOIN lifetime_commands AS c ON c.command_id=o.command_id
         WHERE o.target='pi'
           AND json_extract(o.payload,'$.body.method')='conversation.assignment'
           AND json_extract(o.payload,'$.body.goal_id')=?1
           AND c.actor_ref='owner'
           AND json_extract(c.request,'$.body.method')='goal.update'
           AND json_extract(c.request,'$.body.goal_id')=?1
           AND json_type(c.request,'$.body.follow_up')='text'
           AND json_extract(c.response,'$.status')='success'
         ORDER BY o.id DESC LIMIT 40",
    )?;
    let mut follow_ups = statement
        .query_map([goal_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "text": row.get::<_, String>(1)?,
                "revision": row.get::<_, u64>(2)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    follow_ups.reverse();

    let mut statement = conn.prepare(
        "SELECT t.id,t.text,t.created_at_ms,json_extract(o.payload,'$.body.goal_revision')
         FROM lifetime_report_replies AS r
         JOIN lifetime_outbox AS o ON o.id=r.outbox_id
         JOIN lifetime_turns AS t ON t.id=r.reply_turn_id
         WHERE t.ghost_id=?2 AND t.conversation_id=?3
           AND json_extract(o.payload,'$.body.goal_id')=?1
         ORDER BY t.sequence DESC LIMIT 40",
    )?;
    let mut reports = statement
        .query_map(
            params![goal_id, goal.accountable_ghost, goal.reply_conversation],
            |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "text": row.get::<_, String>(1)?,
                    "created_at_ms": row.get::<_, i64>(2)?,
                    "revision": row.get::<_, u64>(3)?,
                }))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    reports.reverse();

    let current_work_id: Option<String> = conn.query_row(
        "SELECT id FROM lifetime_work WHERE goal_id=?1 AND goal_revision=?2 ORDER BY rowid DESC LIMIT 1",
        params![goal_id, db::revision(goal.revision)?],
        |row| row.get(0),
    ).optional()?;
    let graph = current_work_id
        .map(|id| {
            graph::work_children(
                conn,
                &json!({"method": "work.children", "work_id": id}),
                principal,
            )
        })
        .transpose()?
        .map(|response| response.data);
    let follow_up_blocker = follow_up_blocker(conn, &goal)?;
    Ok(apply::success(
        "Work thread inspected",
        vec![goal_id.to_owned()],
        json!({"goal": goal, "origin": origin, "follow_ups": follow_ups, "reports": reports, "graph": graph, "follow_up_blocker": follow_up_blocker}),
    ))
}
