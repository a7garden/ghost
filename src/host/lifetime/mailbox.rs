use crate::lifetime_contract::{
    canonical_digest, Envelope, Goal, Response, ResponseStatus, RetryClass, Work,
};
use anyhow::{anyhow, bail, Result};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::{json, Value};

#[derive(Debug)]
struct Rejected {
    code: &'static str,
    summary: String,
    retry_class: RetryClass,
}
impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.summary)
    }
}
impl std::error::Error for Rejected {}

fn reject(code: &'static str, summary: impl Into<String>, retry_class: RetryClass) -> anyhow::Error {
    anyhow::Error::new(Rejected {
        code,
        summary: summary.into(),
        retry_class,
    })
}
fn invalid(summary: impl Into<String>) -> anyhow::Error {
    reject("invalid_request", summary, RetryClass::Never)
}
fn conflict(summary: impl Into<String>) -> anyhow::Error {
    reject("conflict", summary, RetryClass::Never)
}
fn unauthorized(summary: impl Into<String>) -> anyhow::Error {
    reject("unauthorized", summary, RetryClass::Never)
}
fn not_found(summary: impl Into<String>) -> anyhow::Error {
    reject("not_found", summary, RetryClass::Never)
}

fn error_response(code: &str, summary: impl Into<String>, retry_class: RetryClass) -> Response {
    Response {
        status: ResponseStatus::Error,
        summary: summary.into(),
        object_refs: Vec::new(),
        artifacts: Vec::new(),
        next_actions: Vec::new(),
        error_code: Some(code.to_owned()),
        retry_class,
        data: Value::Null,
    }
}
fn success(summary: impl Into<String>, object_refs: Vec<String>, data: Value) -> Response {
    Response {
        status: ResponseStatus::Success,
        summary: summary.into(),
        object_refs,
        artifacts: Vec::new(),
        next_actions: Vec::new(),
        error_code: None,
        retry_class: RetryClass::SameId,
        data,
    }
}

/// Mailbox commands are dispatched by the existing Host ledger after owner
/// authentication, command deduplication, and profile validation. This module
/// never opens or commits a transaction and never queues model/runtime work.
pub(super) fn handles(method: &str) -> bool {
    matches!(
        method,
        "registry.ensure"
            | "registry.inspect"
            | "registry.mode"
            | "mailbox.send"
            | "mailbox.inspect"
            | "mailbox.ack"
            | "notification.inspect"
            | "notification.ack"
    )
}

pub(super) fn apply(
    tx: &Transaction<'_>,
    envelope: &Envelope,
    principal: &str,
) -> Result<Response> {
    if let Err(error) = envelope.validate() {
        return Ok(error_response(
            "invalid_envelope",
            error.to_string(),
            RetryClass::Never,
        ));
    }
    if principal.is_empty() || principal != envelope.actor_ref {
        return Ok(error_response(
            "unauthorized",
            "authenticated principal does not match envelope actor",
            RetryClass::Never,
        ));
    }

    let result = apply_inner(tx, envelope, principal);
    match result {
        Ok(response) => Ok(response),
        Err(error) => match error.downcast_ref::<Rejected>() {
            Some(rejection) => Ok(error_response(
                rejection.code,
                rejection.summary.clone(),
                rejection.retry_class.clone(),
            )),
            None => Err(error),
        },
    }
}

fn apply_inner(tx: &Transaction<'_>, envelope: &Envelope, principal: &str) -> Result<Response> {
    let body = &envelope.body;
    let method = string_field(body, "method")?;
    if matches!(method, "registry.ensure" | "registry.mode") && principal != "owner" {
        return Err(unauthorized("registry changes require authenticated owner"));
    }
    match method {
        "registry.ensure" => registry_ensure(tx, body),
        "registry.inspect" => registry_inspect(tx, body, principal),
        "registry.mode" => registry_mode(tx, body),
        "mailbox.send" => mailbox_send(tx, body, principal, &envelope.payload_digest),
        "mailbox.inspect" => mailbox_inspect(tx, body, principal),
        "mailbox.ack" => mailbox_ack(tx, body, principal),
        "notification.inspect" => notification_inspect(tx, body, principal),
        "notification.ack" => notification_ack(tx, body, principal),
        _ => Err(reject(
            "unsupported_method",
            format!("unsupported collaboration method: {method}"),
            RetryClass::Never,
        )),
    }
}

fn registry_ensure(tx: &Transaction<'_>, body: &Value) -> Result<Response> {
    exact_fields(
        body,
        &["method", "ghost_id", "kind", "conversation_id", "roles"],
    )?;
    let ghost_id = string_field(body, "ghost_id")?;
    let kind = string_field(body, "kind")?;
    let conversation_id = string_field(body, "conversation_id")?;
    validate_identity("ghost_id", ghost_id)?;
    validate_identity("conversation_id", conversation_id)?;
    if !matches!(kind, "primary" | "specialist") {
        return Err(invalid("registry kind must be primary or specialist"));
    }
    let roles = string_array(body, "roles")?;
    if roles.len() > 16 {
        return Err(invalid("registry roles exceed the contract limit of 16"));
    }
    let roles_json = serde_json::to_string(&roles)?;

    let existing_conversation: Option<String> = tx
        .query_row(
            "SELECT conversation_id FROM lifetime_registry WHERE ghost_id=?1",
            [ghost_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing_conversation) = &existing_conversation {
        if existing_conversation.as_str() != conversation_id {
            return Err(conflict("registry conversation binding is immutable"));
        }
    } else {
        let conversation_owner: Option<String> = tx
            .query_row(
                "SELECT ghost_id FROM lifetime_registry WHERE conversation_id=?1",
                [conversation_id],
                |row| row.get(0),
            )
            .optional()?;
        if conversation_owner.is_some() {
            return Err(conflict("conversation is already bound to another Ghost"));
        }
        if super::super::bots_provisioning::reserves_registry_identity(tx, ghost_id, conversation_id)? {
            return Err(conflict("Ghost or conversation identity is reserved for bot provisioning"));
        }
        if super::db::binding(tx, conversation_id)?.is_some_and(|binding| {
            binding.ghost_id != ghost_id || binding.runtime_kind != "pi-durable"
        }) {
            return Err(conflict("conversation is already bound to another Ghost or runtime"));
        }
    }

    if kind == "primary" {
        let other_primary: Option<String> = tx
            .query_row(
                "SELECT ghost_id FROM lifetime_registry WHERE kind='primary' AND ghost_id<>?1 LIMIT 1",
                [ghost_id],
                |row| row.get(0),
            )
            .optional()?;
        if other_primary.is_some() {
            return Err(conflict("a primary Ghost is already registered"));
        }
    }

    if existing_conversation.is_some() {
        tx.execute(
            "UPDATE lifetime_registry SET kind=?1,roles=?2 WHERE ghost_id=?3",
            params![kind, roles_json, ghost_id],
        )?;
    } else {
        tx.execute(
            "INSERT INTO lifetime_registry(ghost_id,kind,conversation_id,roles,mode) VALUES(?1,?2,?3,?4,'active')",
            params![ghost_id, kind, conversation_id, roles_json],
        )?;
    }
    let record = registry_record(tx, ghost_id)?
        .ok_or_else(|| anyhow!("registry row disappeared during ensure"))?;
    Ok(success(
        "Ghost identity registered",
        vec![ghost_id.to_owned()],
        json!({ "registry": record }),
    ))
}


fn registry_inspect(tx: &Transaction<'_>, body: &Value, principal: &str) -> Result<Response> {
    super::apply::allowed_fields(body, &["method", "include_secondary"], &["method"])?;
    let include_secondary = match body.get("include_secondary") {
        None => false,
        Some(Value::Bool(value)) if principal == "owner" => *value,
        Some(_) => return Err(unauthorized("only the Owner can enumerate separate conversation pairs")),
    };
    let mut statement = tx.prepare(
        "SELECT ghost_id,kind,conversation_id,roles,mode FROM lifetime_registry ORDER BY ghost_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut registry = Vec::new();
    let mut refs = Vec::new();
    for row in rows {
        let (ghost_id, kind, conversation_id, roles, mode) = row?;
        let roles: Vec<String> = serde_json::from_str(&roles)?;
        refs.push(ghost_id.clone());
        registry.push(json!({
            "ghost_id": ghost_id,
            "kind": kind,
            "conversation_id": conversation_id,
            "roles": roles,
            "mode": mode,
        }));
    }
    if include_secondary { registry.extend(super::conversation::public_secondary_entries(tx)?); }
    Ok(success(
        "registered Ghost identities inspected",
        refs,
        json!({ "registry": registry }),
    ))
}

fn registry_mode(tx: &Transaction<'_>, body: &Value) -> Result<Response> {
    exact_fields(body, &["method", "ghost_id", "mode"])?;
    let ghost_id = string_field(body, "ghost_id")?;
    let mode = string_field(body, "mode")?;
    validate_identity("ghost_id", ghost_id)?;
    if !matches!(mode, "active" | "draining") {
        return Err(invalid("registry mode must be active or draining"));
    }
    let changed = tx.execute(
        "UPDATE lifetime_registry SET mode=?1 WHERE ghost_id=?2",
        params![mode, ghost_id],
    )?;
    if changed != 1 {
        return Err(not_found("Ghost identity is not registered"));
    }
    let record = registry_record(tx, ghost_id)?
        .ok_or_else(|| anyhow!("registry row disappeared during mode update"))?;
    Ok(success(
        "Ghost registry mode updated",
        vec![ghost_id.to_owned()],
        json!({ "registry": record }),
    ))
}

fn registry_record(tx: &Transaction<'_>, ghost_id: &str) -> Result<Option<Value>> {
    let row: Option<(String, String, String, String)> = tx
        .query_row(
            "SELECT kind,conversation_id,roles,mode FROM lifetime_registry WHERE ghost_id=?1",
            [ghost_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    row.map(|(kind, conversation_id, roles, mode)| {
        let roles: Vec<String> = serde_json::from_str(&roles)?;
        Ok(json!({
            "ghost_id": ghost_id,
            "kind": kind,
            "conversation_id": conversation_id,
            "roles": roles,
            "mode": mode,
        }))
    })
    .transpose()
}

fn mailbox_send(
    tx: &Transaction<'_>,
    body: &Value,
    principal: &str,
    payload_digest: &str,
) -> Result<Response> {
    exact_fields(
        body,
        &[
            "method",
            "sender_id",
            "message_id",
            "recipient_ids",
            "privacy",
            "summary",
            "object_refs",
        ],
    )?;
    let sender_id = string_field(body, "sender_id")?;
    let message_id = string_field(body, "message_id")?;
    let privacy = string_field(body, "privacy")?;
    let summary = string_field(body, "summary")?;
    validate_identity("sender_id", sender_id)?;
    validate_identity("message_id", message_id)?;
    if principal != "owner" && sender_id != principal {
        return Err(unauthorized("sender_id does not match authenticated principal"));
    }
    if !matches!(privacy, "public" | "private" | "local_only") {
        return Err(invalid("mailbox privacy must be public, private, or local_only"));
    }
    if summary.len() > 65_536 {
        return Err(invalid("mailbox summary exceeds 65536 UTF-8 bytes"));
    }
    let recipients = string_array(body, "recipient_ids")?;
    if recipients.len() > 16 {
        return Err(invalid("mailbox recipients exceed the contract limit of 16"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for recipient in &recipients {
        validate_identity("recipient_id", recipient)?;
        if !seen.insert(recipient.as_str()) {
            return Err(invalid("recipient_ids must be unique"));
        }
    }
    let object_refs = string_array(body, "object_refs")?;

    let sender_registered: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM lifetime_registry WHERE ghost_id=?1)",
        [sender_id],
        |row| row.get(0),
    )?;
    if !sender_registered {
        return Err(not_found("sender Ghost is not registered"));
    }
    for recipient in &recipients {
        let registered: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM lifetime_registry WHERE ghost_id=?1)",
            [recipient],
            |row| row.get(0),
        )?;
        if !registered {
            return Err(not_found(format!("recipient Ghost is not registered: {recipient}")));
        }
    }

    // Preflight every recipient before inserting any row. The body digest also
    // covers the full recipient set, so a retry cannot extend or alter a send.
    let mut existing = Vec::with_capacity(recipients.len());
    for recipient in &recipients {
        let row: Option<(i64, String, String)> = tx
            .query_row(
                "SELECT sequence,payload_digest,state FROM lifetime_mailbox WHERE sender_id=?1 AND message_id=?2 AND recipient_id=?3",
                params![sender_id, message_id, recipient],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((_, digest, _)) = &row {
            if digest != payload_digest {
                return Err(conflict("mailbox dedup key was reused with different content"));
            }
        }
        existing.push(row);
    }

    let payload = serde_json::to_string(&json!({
        "summary": summary,
        "object_refs": object_refs,
    }))?;
    let mut deliveries = Vec::with_capacity(recipients.len());
    for (recipient, previous) in recipients.iter().zip(existing) {
        let (sequence, state, deduplicated) = match previous {
            Some((sequence, _, state)) => (sequence, state, true),
            None => {
                tx.execute(
                    "INSERT INTO lifetime_mailbox(sender_id,message_id,recipient_id,payload_digest,privacy,payload,state) VALUES(?1,?2,?3,?4,?5,?6,'pending')",
                    params![
                        sender_id,
                        message_id,
                        recipient,
                        payload_digest,
                        privacy,
                        payload,
                    ],
                )?;
                (tx.last_insert_rowid(), "pending".to_owned(), false)
            }
        };
        deliveries.push(json!({
            "recipient_id": recipient,
            "message_id": message_id,
            "sequence": sequence,
            "state": state,
            "deduplicated": deduplicated,
        }));
    }
    Ok(success(
        "mailbox message durably delivered",
        vec![message_id.to_owned()],
        json!({ "deliveries": deliveries }),
    ))
}

fn mailbox_inspect(
    tx: &Transaction<'_>,
    body: &Value,
    principal: &str,
) -> Result<Response> {
    exact_fields(
        body,
        &["method", "recipient_id", "after_sequence", "limit"],
    )?;
    let recipient_id = string_field(body, "recipient_id")?;
    validate_identity("recipient_id", recipient_id)?;
    if principal != "owner" && recipient_id != principal {
        return Err(unauthorized("mailbox inspect is recipient-scoped"));
    }
    let after_sequence = optional_cursor(body, "after_sequence")?;
    let limit = optional_limit(body)?;
    let mut statement = tx.prepare(
        "SELECT sequence,sender_id,message_id,privacy,payload,state FROM lifetime_mailbox WHERE recipient_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3",
    )?;
    let rows = statement.query_map(params![recipient_id, after_sequence, limit], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut messages = Vec::new();
    let mut refs = Vec::new();
    for row in rows {
        let (sequence, sender_id, message_id, privacy, payload, state) = row?;
        let payload: Value = serde_json::from_str(&payload)?;
        let summary = payload
            .get("summary")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("mailbox payload has no summary"))?;
        let object_refs = payload
            .get("object_refs")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("mailbox payload has no object_refs"))?;
        refs.push(message_id.clone());
        messages.push(json!({
            "sequence": sequence,
            "sender_id": sender_id,
            "message_id": message_id,
            "recipient_id": recipient_id,
            "privacy": privacy,
            "summary": summary,
            "object_refs": object_refs,
            "state": state,
        }));
    }
    Ok(success(
        "recipient mailbox inspected",
        refs,
        json!({ "messages": messages }),
    ))
}

fn mailbox_ack(
    tx: &Transaction<'_>,
    body: &Value,
    principal: &str,
) -> Result<Response> {
    exact_fields(
        body,
        &["method", "recipient_id", "sender_id", "message_id", "state"],
    )?;
    let recipient_id = string_field(body, "recipient_id")?;
    let sender_id = string_field(body, "sender_id")?;
    let message_id = string_field(body, "message_id")?;
    let requested_state = string_field(body, "state")?;
    validate_identity("recipient_id", recipient_id)?;
    validate_identity("sender_id", sender_id)?;
    validate_identity("message_id", message_id)?;
    if principal != "owner" && recipient_id != principal {
        return Err(unauthorized("mailbox acknowledgement is recipient-scoped"));
    }
    if !matches!(requested_state, "transport_accepted" | "client_seen") {
        return Err(invalid("mailbox acknowledgement state is invalid"));
    }
    let current_state: Option<String> = tx
        .query_row(
            "SELECT state FROM lifetime_mailbox WHERE recipient_id=?1 AND sender_id=?2 AND message_id=?3",
            params![recipient_id, sender_id, message_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(current_state) = current_state else {
        return Err(not_found("mailbox message not found for recipient"));
    };
    let state = monotonic_state(&current_state, requested_state)?;
    tx.execute(
        "UPDATE lifetime_mailbox SET state=?1 WHERE recipient_id=?2 AND sender_id=?3 AND message_id=?4",
        params![state, recipient_id, sender_id, message_id],
    )?;
    Ok(success(
        "mailbox delivery state recorded",
        vec![message_id.to_owned()],
        json!({
            "recipient_id": recipient_id,
            "sender_id": sender_id,
            "message_id": message_id,
            "state": state,
        }),
    ))
}

fn notification_inspect(
    tx: &Transaction<'_>,
    body: &Value,
    principal: &str,
) -> Result<Response> {
    exact_fields(body, &["method", "recipient_id", "limit"])?;
    let recipient_id = string_field(body, "recipient_id")?;
    validate_identity("recipient_id", recipient_id)?;
    if principal != "owner" && recipient_id != principal {
        return Err(unauthorized("notification inbox is recipient-scoped"));
    }
    let limit = optional_limit(body)?;
    let mut statement = tx.prepare(
        "SELECT id,conversation_id,work_id,goal_revision,event_kind,state FROM lifetime_notifications WHERE recipient_id=?1 ORDER BY rowid DESC LIMIT ?2",
    )?;
    let rows = statement.query_map(params![recipient_id, limit], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut notifications = Vec::new();
    let mut refs = Vec::new();
    for row in rows {
        let (id, conversation_id, work_id, goal_revision, event_kind, state) = row?;
        if goal_revision < 1 {
            bail!("notification has an invalid goal revision");
        }
        refs.push(id.clone());
        notifications.push(json!({
            "id": id,
            "conversation_id": conversation_id,
            "work_id": work_id,
            "goal_revision": goal_revision,
            "event_kind": event_kind,
            "state": state,
        }));
    }
    Ok(success(
        "recipient notification inbox inspected",
        refs,
        json!({ "notifications": notifications }),
    ))
}

fn notification_ack(
    tx: &Transaction<'_>,
    body: &Value,
    principal: &str,
) -> Result<Response> {
    exact_fields(body, &["method", "recipient_id", "notification_id", "state"])?;
    let recipient_id = string_field(body, "recipient_id")?;
    let notification_id = string_field(body, "notification_id")?;
    let requested_state = string_field(body, "state")?;
    validate_identity("recipient_id", recipient_id)?;
    validate_identity("notification_id", notification_id)?;
    if principal != "owner" && recipient_id != principal {
        return Err(unauthorized("notification acknowledgement is recipient-scoped"));
    }
    if !matches!(requested_state, "transport_accepted" | "client_seen") {
        return Err(invalid("notification acknowledgement state is invalid"));
    }
    let current_state: Option<String> = tx
        .query_row(
            "SELECT state FROM lifetime_notifications WHERE id=?1 AND recipient_id=?2",
            params![notification_id, recipient_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(current_state) = current_state else {
        return Err(not_found("notification not found for recipient"));
    };
    let state = monotonic_state(&current_state, requested_state)?;
    tx.execute(
        "UPDATE lifetime_notifications SET state=?1 WHERE id=?2 AND recipient_id=?3",
        params![state, notification_id, recipient_id],
    )?;
    Ok(success(
        "notification delivery state recorded",
        vec![notification_id.to_owned()],
        json!({
            "recipient_id": recipient_id,
            "notification_id": notification_id,
            "state": state,
        }),
    ))
}

/// Persist an opaque inbox notification in the caller's result/acceptance
/// transaction. This method never creates model input or copies result content.
pub(super) fn notify_work(
    tx: &Transaction<'_>,
    work: &Work,
    goal: &Goal,
    event_kind: &str,
) -> Result<()> {
    if !matches!(event_kind, "result" | "acceptance") {
        bail!("unsupported lifetime notification event kind");
    }
    if work.goal_id != goal.id {
        bail!("notification Work and Goal identities do not match");
    }

    let actual_work: Option<(String, i64, String, String)> = tx
        .query_row(
            "SELECT goal_id,goal_revision,owner,state FROM lifetime_work WHERE id=?1",
            [&work.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((actual_goal_id, actual_work_revision, actual_owner, actual_work_state)) = actual_work else {
        bail!("notification Work is not in the Host ledger");
    };
    let actual_goal: Option<(i64, String)> = tx
        .query_row(
            "SELECT revision,reply_conversation FROM lifetime_goals WHERE id=?1",
            [&goal.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((actual_goal_revision, actual_conversation)) = actual_goal else {
        bail!("notification Goal is not in the Host ledger");
    };
    let expected_work_revision = i64::try_from(work.goal_revision)
        .map_err(|_| anyhow!("Work revision exceeds SQLite integer range"))?;
    let expected_goal_revision = i64::try_from(goal.revision)
        .map_err(|_| anyhow!("Goal revision exceeds SQLite integer range"))?;
    if actual_goal_id != work.goal_id
        || actual_work_revision != expected_work_revision
        || actual_owner != work.owner
        || actual_work_state != work.state
        || actual_goal_revision != expected_goal_revision
        || actual_conversation != goal.reply_conversation
    {
        bail!("notification arguments differ from committed Host rows");
    }

    // Old-revision terminal events remain ledger facts but are not current
    // notifications for the recipient.
    if work.goal_revision != goal.revision || actual_work_revision != actual_goal_revision {
        return Ok(());
    }
    match event_kind {
        "result" => {
            if !matches!(work.state.as_str(), "completed" | "failed" | "cancelled") {
                bail!("result notification requires a terminal worker result");
            }
            let current_result: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM lifetime_results WHERE work_id=?1 AND goal_revision=?2)",
                params![work.id, expected_goal_revision],
                |row| row.get(0),
            )?;
            if !current_result {
                bail!("result notification requires a committed current result");
            }
        }
        "acceptance" => {
            if work.state != "accepted" {
                bail!("acceptance notification requires accepted Work state");
            }
            let current_acceptance: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM lifetime_acceptances WHERE work_id=?1 AND goal_revision=?2)",
                params![work.id, expected_goal_revision],
                |row| row.get(0),
            )?;
            if !current_acceptance {
                bail!("acceptance notification requires a committed current acceptance");
            }
        }
        _ => unreachable!(),
    }

    let notification_digest = canonical_digest(&json!([
        work.owner,
        work.id,
        goal.revision,
        event_kind,
    ]))?;
    let id = format!("notification:{notification_digest}");
    // An Owner-approved wake occurrence derives the briefing kind from the
    // durable wake run ledger — the goal's acceptance_spec JSON alone is never
    // trusted as origin proof.
    let event_kind = if event_kind == "result" && wake_origin_kind(&tx, &goal.id)? {
        "briefing"
    } else {
        event_kind
    };
    tx.execute(
        "INSERT INTO lifetime_notifications(id,recipient_id,conversation_id,work_id,goal_revision,event_kind,state) VALUES(?1,?2,?3,?4,?5,?6,'pending') ON CONFLICT(recipient_id,work_id,goal_revision,event_kind) DO NOTHING",
        params![
            id,
            work.owner,
            goal.reply_conversation,
            work.id,
            expected_goal_revision,
            event_kind,
        ],
    )?;
    Ok(())
}

/// True when this Goal was admitted by a durably recorded, Owner-approved wake
/// occurrence: a submitted wake run links the goal id. workspace_objects lives
/// in the same journal; the linkage is written before the Pi turn can report.
fn wake_origin_kind(tx: &Transaction<'_>, goal_id: &str) -> Result<bool> {
    let mut statement = tx.prepare(
        "SELECT EXISTS(SELECT 1 FROM workspace_objects WHERE kind='wake_run'
         AND json_extract(payload,'$.goal_id')=?1 AND json_extract(payload,'$.status')='submitted')",
    )?;
    let found = statement.query_row([goal_id], |row| row.get::<_, bool>(0))?;
    Ok(found)
}

fn exact_fields(body: &Value, allowed: &[&str]) -> Result<()> {
    let Some(object) = body.as_object() else {
        return Err(invalid("collaboration command body must be an object"));
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid("collaboration command contains an unknown field"));
    }
    Ok(())
}

fn string_field<'a>(body: &'a Value, key: &str) -> Result<&'a str> {
    body.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("collaboration body field {key} must be a string")))
}

fn string_array(body: &Value, key: &str) -> Result<Vec<String>> {
    let Some(items) = body.get(key).and_then(Value::as_array) else {
        return Err(invalid(format!("collaboration body field {key} must be an array")));
    };
    items
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| invalid(format!("collaboration body field {key} must contain strings")))
        })
        .collect()
}

fn validate_identity(field: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(invalid(format!("{field} must not be empty")));
    }
    Ok(())
}

fn optional_cursor(body: &Value, field: &str) -> Result<i64> {
    match body.get(field) {
        None => Ok(0),
        Some(value) => {
            let cursor = value
                .as_u64()
                .ok_or_else(|| invalid(format!("{field} must be a non-negative integer")))?;
            i64::try_from(cursor).map_err(|_| invalid(format!("{field} exceeds SQLite integer range")))
        }
    }
}

fn optional_limit(body: &Value) -> Result<i64> {
    let limit = match body.get("limit") {
        None => 100,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| invalid("limit must be a non-negative integer"))?,
    };
    if limit > 100 {
        return Err(invalid("limit exceeds the contract maximum of 100"));
    }
    i64::try_from(limit).map_err(|_| invalid("limit exceeds SQLite integer range"))
}

fn monotonic_state(current: &str, requested: &str) -> Result<&'static str> {
    if !matches!(current, "pending" | "transport_accepted" | "client_seen") {
        bail!("stored delivery state is invalid");
    }
    if !matches!(requested, "transport_accepted" | "client_seen") {
        return Err(invalid("delivery acknowledgement state is invalid"));
    }
    if current == "client_seen" || requested == "client_seen" {
        Ok("client_seen")
    } else {
        Ok("transport_accepted")
    }
}
