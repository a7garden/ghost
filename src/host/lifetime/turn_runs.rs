use super::{apply as host_apply, conversation};
use crate::lifetime_contract::{canonical_digest, Envelope, Response, RetryClass};
use anyhow::{anyhow, bail, Result};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

const OWNER_PRINCIPAL: &str = "owner";
const MAX_OPAQUE_ID_UTF8_BYTES: usize = 512;
const MAX_SAFE_JSON_INTEGER: i64 = 9_007_199_254_740_991;
const REASON_CODES: &[&str] = &[
    "model_request_failed",
    "runtime_failure",
    "admission_blocked",
    "answer_unprojectable",
    "owner_cancelled",
    "effect_unconfirmed",
    "reply_delivery_unconfirmed",
    "authority_revoked",
];

struct TurnRun {
    turn_id: String,
    ghost_id: String,
    conversation_id: String,
    state: String,
    cancel_requested: bool,
    cancel_command_id: Option<String>,
    submission_id: Option<String>,
    entry_id: Option<String>,
    reason_code: Option<String>,
    latest_status_command_id: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
}


impl TurnRun {
    fn data(&self) -> Value {
        json!({
            "turn_id": self.turn_id,
            "ghost_id": self.ghost_id,
            "conversation_id": self.conversation_id,
            "state": self.state,
            "cancel_requested": self.cancel_requested,
            "cancel_command_id": self.cancel_command_id,
            "submission_id": self.submission_id,
            "entry_id": self.entry_id,
            "reason_code": self.reason_code,
            "latest_status_command_id": self.latest_status_command_id,
            "created_at_ms": self.created_at_ms,
            "updated_at_ms": self.updated_at_ms,
        })
    }

    fn next_updated_at_ms(&self) -> Result<i64> {
        let next = now_ms()?.max(self.updated_at_ms + 1);
        if next > MAX_SAFE_JSON_INTEGER {
            bail!("turn-run timestamp is outside the safe JSON integer range");
        }
        Ok(next)
    }
}

fn read_columns(row: &Row<'_>) -> rusqlite::Result<TurnRun> {
    Ok(TurnRun {
        turn_id: row.get(0)?,
        ghost_id: row.get(1)?,
        conversation_id: row.get(2)?,
        state: row.get(3)?,
        cancel_requested: row.get(4)?,
        cancel_command_id: row.get(5)?,
        submission_id: row.get(6)?,
        entry_id: row.get(7)?,
        reason_code: row.get(8)?,
        latest_status_command_id: row.get(9)?,
        created_at_ms: row.get(10)?,
        updated_at_ms: row.get(11)?,
    })
}


fn decode_columns(run: TurnRun) -> Result<TurnRun> {
    if run.created_at_ms < 0
        || run.updated_at_ms < run.created_at_ms
        || run.created_at_ms > MAX_SAFE_JSON_INTEGER
        || run.updated_at_ms > MAX_SAFE_JSON_INTEGER
    {
        bail!("stored turn-run timestamp is outside the safe JSON integer range");
    }
    if !matches!(run.state.as_str(),
        "queued" | "running" | "answered" | "failed" | "cancelled" | "effect_unknown")
    {
        bail!("stored turn-run state is invalid");
    }
    if run.cancel_requested != run.cancel_command_id.is_some()
        || run.cancel_command_id.as_deref().is_some_and(|id| id.trim().is_empty())
        || run.latest_status_command_id.as_deref().is_some_and(|id| id.trim().is_empty())
        || !valid_reason_code(run.reason_code.as_deref())
    {
        bail!("stored turn-run cancellation or status metadata is invalid");
    }
    for (field, value) in [("submission_id", &run.submission_id), ("entry_id", &run.entry_id)] {
        if let Some(value) = value { validate_opaque_id(field, value)?; }
    }
    Ok(run)
}

fn load_run(conn: &Connection, turn_id: &str) -> Result<Option<TurnRun>> {
    let columns = conn
        .query_row(
            "SELECT turn_id,ghost_id,conversation_id,state,cancel_requested,cancel_command_id,
                    submission_id,entry_id,reason_code,latest_status_command_id,created_at_ms,updated_at_ms
             FROM lifetime_turn_runs WHERE turn_id=?1",
            [turn_id],
            read_columns,
        )
        .optional()?;
    columns.map(decode_columns).transpose()
}

fn scoped_run(
    conn: &Connection,
    ghost_id: &str,
    conversation_id: &str,
    turn_id: &str,
) -> Result<TurnRun> {
    let Some(run) = load_run(conn, turn_id)? else {
        return Err(host_apply::not_found("Owner turn run not found"));
    };
    if run.ghost_id != ghost_id || run.conversation_id != conversation_id {
        return Err(host_apply::not_found("Owner turn run not found"));
    }
    Ok(run)
}

fn verify_owner_turn(
    conn: &Connection,
    ghost_id: &str,
    conversation_id: &str,
    turn_id: &str,
) -> Result<()> {
    let Some((turn_ghost, turn_conversation, sender_kind, sender_ref, kind, _)) =
        conversation::turn_scope(conn, turn_id)?
    else {
        return Err(host_apply::not_found("Owner turn not found"));
    };
    if turn_ghost != ghost_id
        || turn_conversation != conversation_id
        || sender_kind != "owner"
        || sender_ref != OWNER_PRINCIPAL
        || kind != "user"
    {
        return Err(host_apply::not_found("Owner turn not found"));
    }
    Ok(())
}

/// The operator route never invents a turn or changes its submission state.
pub(super) fn selected_task_scope(
    conn: &Connection,
    ghost_id: &str,
    conversation_id: &str,
    turn_id: &str,
    recovery: bool,
) -> Result<()> {
    conversation::registered_mode(conn, ghost_id, conversation_id)?;
    conversation::require_pi_binding(conn, ghost_id, conversation_id)?;
    let binding = super::db::binding(conn, conversation_id)?.ok_or_else(||host_apply::not_found("Pi binding is missing"))?;
    if binding.runtime_release != "1.1.0" || binding.storage_ref.is_empty() || binding.storage_ref.starts_with("unresolved:") {
        return Err(host_apply::reject("selected_task_binding_unconfirmed", "Selected-task inspection requires an acknowledged Pi binding", RetryClass::Never));
    }
    verify_owner_turn(conn, ghost_id, conversation_id, turn_id)?;
    let run = scoped_run(conn, ghost_id, conversation_id, turn_id)?;
    if recovery && (run.cancel_requested || run.submission_id.is_some() || run.entry_id.is_some()
        || !matches!(run.state.as_str(), "queued" | "effect_unknown")) {
        return Err(host_apply::reject("selected_task_recovery_blocked",
            "Owner turn cannot start selected-task recovery", RetryClass::Never));
    }
    Ok(())
}

fn validate_opaque_id(field: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > MAX_OPAQUE_ID_UTF8_BYTES {
        return Err(host_apply::invalid(format!(
            "{field} must be a nonempty SDK identity of at most {MAX_OPAQUE_ID_UTF8_BYTES} UTF-8 bytes"
        )));
    }
    Ok(())
}

fn optional_opaque_id(body: &Value, field: &str) -> Result<Option<String>> {
    match host_apply::value_field(body, field)? {
        Value::Null => Ok(None),
        Value::String(value) => {
            validate_opaque_id(field, value)?;
            Ok(Some(value.clone()))
        }
        _ => Err(host_apply::invalid(format!(
            "{field} must be a bounded SDK identity string or null"
        ))),
    }
}


fn now_ms() -> Result<i64> {
    let timestamp = i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())
        .map_err(|_| anyhow!("turn-run timestamp exceeds SQLite integer range"))?;
    if timestamp > MAX_SAFE_JSON_INTEGER {
        bail!("turn-run timestamp exceeds the safe JSON integer range");
    }
    Ok(timestamp)
}

/// Insert the original Owner turn's queued run inside the intake transaction.
pub(super) fn create_queued(
    tx: &Transaction<'_>,
    turn_id: &str,
    ghost_id: &str,
    conversation_id: &str,
) -> Result<()> {
    let created_at_ms: i64 = tx.query_row(
        "SELECT created_at_ms FROM lifetime_turns
         WHERE id=?1 AND ghost_id=?2 AND conversation_id=?3
           AND sender_kind='owner' AND sender_ref=?4 AND kind='user'",
        params![turn_id, ghost_id, conversation_id, OWNER_PRINCIPAL],
        |row| row.get(0),
    )?;
    if !(0..=MAX_SAFE_JSON_INTEGER).contains(&created_at_ms) {
        bail!("Owner turn timestamp is outside the safe JSON integer range");
    }
    tx.execute(
        "INSERT INTO lifetime_turn_runs(
            turn_id,ghost_id,conversation_id,state,cancel_requested,cancel_command_id,
            submission_id,entry_id,reason_code,latest_status_command_id,created_at_ms,updated_at_ms
         ) VALUES(?1,?2,?3,'queued',0,NULL,NULL,NULL,NULL,NULL,?4,?4)",
        params![turn_id, ghost_id, conversation_id, created_at_ms],
    )?;
    Ok(())
}

pub(super) fn cancel_turn(
    tx: &Transaction<'_>,
    envelope: &Envelope,
    context: &mut host_apply::ApplyContext,
) -> Result<Response> {
    host_apply::exact_fields(
        &envelope.body,
        &["method", "ghost_id", "conversation_id", "turn_id"],
    )?;
    let ghost_id = host_apply::string_field(&envelope.body, "ghost_id")?;
    let conversation_id = host_apply::string_field(&envelope.body, "conversation_id")?;
    let turn_id = host_apply::string_field(&envelope.body, "turn_id")?;
    conversation::registered_mode(tx, ghost_id, conversation_id)?;
    verify_owner_turn(tx, ghost_id, conversation_id, turn_id)?;
    let mut run = scoped_run(tx, ghost_id, conversation_id, turn_id)?;

    if matches!(run.state.as_str(), "answered" | "failed" | "cancelled") {
        return Ok(host_apply::success(
            "Owner turn is already terminal; no cancellation was sent",
            vec![turn_id.to_owned()],
            json!({ "run": run.data(), "already_terminal": true }),
        ));
    }
    if run.cancel_requested {
        let Some(cancel_command_id) = run.cancel_command_id.as_ref() else {
            bail!("turn run has a cancellation request without its immutable command ID");
        };
        return Ok(host_apply::success(
            "Owner turn cancellation is already requested; completion is not confirmed",
            vec![turn_id.to_owned()],
            json!({
                "run": run.data(),
                "cancel_requested": true,
                "cancel_command_id": cancel_command_id,
                "completed": false,
            }),
        ));
    }
    if run.cancel_command_id.is_some() {
        bail!("turn run has a cancellation command without a cancellation request");
    }

    let body = json!({
        "method": "conversation.cancel_turn",
        "ghost_id": ghost_id,
        "conversation_id": conversation_id,
        "turn_id": turn_id,
    });
    let outbox = host_apply::outgoing(envelope, ghost_id, None, body)?;
    let cancel_command_id = outbox["command_id"]
        .as_str()
        .ok_or_else(|| anyhow!("outgoing cancellation is missing its immutable command ID"))?
        .to_owned();
    let changed = tx.execute(
        "UPDATE lifetime_turn_runs
         SET cancel_requested=1,cancel_command_id=?1,updated_at_ms=?2
         WHERE turn_id=?3 AND ghost_id=?4 AND conversation_id=?5
           AND cancel_requested=0 AND cancel_command_id IS NULL",
        params![
            cancel_command_id,
            run.next_updated_at_ms()?,
            turn_id,
            ghost_id,
            conversation_id,
        ],
    )?;
    if changed != 1 {
        return Err(host_apply::conflict(
            "Owner turn cancellation changed while the request was being recorded",
        ));
    }
    context.enqueue("pi", outbox);
    run = scoped_run(tx, ghost_id, conversation_id, turn_id)?;
    Ok(host_apply::success(
        "Owner turn cancellation requested; completion is not confirmed",
        vec![turn_id.to_owned()],
        json!({
            "run": run.data(),
            "cancel_requested": true,
            "cancel_command_id": cancel_command_id,
            "completed": false,
        }),
    ))
}

fn valid_reason_code(value: Option<&str>) -> bool {
    value.map_or(true, |reason| REASON_CODES.contains(&reason))
}

fn allowed_transition(current: &str, target: &str) -> bool {
    if current == target {
        return true;
    }
    match current {
        "queued" => matches!(target, "running" | "failed" | "cancelled" | "effect_unknown"),
        "running" => matches!(target, "answered" | "failed" | "cancelled" | "effect_unknown"),
        "effect_unknown" => {
            matches!(target, "running" | "answered" | "failed" | "cancelled")
        }
        "answered" | "failed" | "cancelled" => false,
        _ => false,
    }
}

fn merge_identity(
    current: &Option<String>,
    reported: Option<String>,
    field: &str,
) -> Result<Option<String>> {
    if let (Some(existing), Some(new_value)) = (current.as_ref(), reported.as_ref()) {
        if existing != new_value {
            return Err(host_apply::conflict(format!(
                "turn-run {field} is immutable once observed"
            )));
        }
    }
    Ok(current.clone().or(reported))
}

fn report_reason(
    current: &Option<String>,
    reported: Option<String>,
    same_state: bool,
) -> Result<Option<String>> {
    if same_state {
        if let (Some(existing), Some(new_value)) = (current.as_ref(), reported.as_ref()) {
            if existing != new_value {
                return Err(host_apply::conflict(
                    "equal turn status cannot change its safe reason code",
                ));
            }
        }
        Ok(current.clone().or(reported))
    } else {
        Ok(reported)
    }
}

pub(super) fn report_status(
    tx: &Transaction<'_>,
    envelope: &Envelope,
    principal: &str,
) -> Result<Response> {
    host_apply::exact_fields(
        &envelope.body,
        &[
            "method",
            "ghost_id",
            "conversation_id",
            "turn_id",
            "status",
            "submission_id",
            "entry_id",
            "reason_code",
        ],
    )?;
    let ghost_id = host_apply::string_field(&envelope.body, "ghost_id")?;
    let conversation_id = host_apply::string_field(&envelope.body, "conversation_id")?;
    let turn_id = host_apply::string_field(&envelope.body, "turn_id")?;
    let target_state = host_apply::string_field(&envelope.body, "status")?;
    if !matches!(
        target_state,
        "running" | "answered" | "failed" | "cancelled" | "effect_unknown"
    ) {
        return Err(host_apply::invalid("unsupported controller turn status"));
    }
    if principal != ghost_id {
        return Err(host_apply::reject(
            "unauthorized",
            "turn status requires the authenticated Pi controller for this Ghost",
            RetryClass::Never,
        ));
    }
    conversation::registered_mode(tx, ghost_id, conversation_id)?;
    conversation::require_pi_binding(tx, ghost_id, conversation_id)?;
    verify_owner_turn(tx, ghost_id, conversation_id, turn_id)?;

    let reported_submission = optional_opaque_id(&envelope.body, "submission_id")?;
    let reported_entry = optional_opaque_id(&envelope.body, "entry_id")?;
    let reported_reason = match host_apply::value_field(&envelope.body, "reason_code")? {
        Value::Null => None,
        Value::String(value) if valid_reason_code(Some(value)) => Some(value.clone()),
        Value::String(_) => return Err(host_apply::invalid("reason_code is not in the frozen safe-code set")),
        _ => return Err(host_apply::invalid("reason_code must be an allowed string or null")),
    };

    let mut run = scoped_run(tx, ghost_id, conversation_id, turn_id)?;
    if !allowed_transition(&run.state, target_state) {
        return Err(host_apply::conflict(format!(
            "terminal or stale turn status {} cannot transition to {target_state}",
            run.state
        )));
    }
    if target_state == "cancelled" && !run.cancel_requested {
        return Err(host_apply::conflict(
            "controller cannot confirm cancellation without a persisted Owner cancellation request",
        ));
    }

    let submission_id = merge_identity(&run.submission_id, reported_submission, "submission_id")?;
    let entry_id = merge_identity(&run.entry_id, reported_entry, "entry_id")?;
    if target_state == "running" && submission_id.is_none() {
        return Err(host_apply::invalid(
            "running status requires a committed SDK submission identity",
        ));
    }
    if target_state == "answered" && entry_id.is_none() {
        return Err(host_apply::invalid(
            "answered status requires a committed assistant entry identity",
        ));
    }
    if target_state == "answered" && run.state != "answered" {
        super::task_contracts::require_reply_admission(tx, turn_id, ghost_id, conversation_id)?;
        if !super::super::bots_provisioning::creation_reply_admitted(tx, turn_id, ghost_id, conversation_id)? {
            return Err(host_apply::reject("bot_creation_incomplete", "The prepared Owner bot creation has no armed evaluation/provisioning responsibility", RetryClass::Never));
        }
    }
    let same_state = run.state == target_state;
    let reason_code = report_reason(&run.reason_code, reported_reason, same_state)?;
    let status_changed = !same_state
        || run.submission_id != submission_id
        || run.entry_id != entry_id
        || run.reason_code != reason_code
        || run.latest_status_command_id.is_none();
    if status_changed {
        let latest_status_command_id = envelope.command_id.as_str();
        let changed = tx.execute(
            "UPDATE lifetime_turn_runs
             SET state=?1,submission_id=?2,entry_id=?3,reason_code=?4,
                 latest_status_command_id=?5,updated_at_ms=?6
             WHERE turn_id=?7 AND ghost_id=?8 AND conversation_id=?9",
            params![
                target_state,
                submission_id,
                entry_id,
                reason_code,
                latest_status_command_id,
                run.next_updated_at_ms()?,
                turn_id,
                ghost_id,
                conversation_id,
            ],
        )?;
        if changed != 1 {
            return Err(host_apply::conflict(
                "turn-run identity changed while status was being recorded",
            ));
        }
    }
    run = scoped_run(tx, ghost_id, conversation_id, turn_id)?;
    if matches!(target_state, "failed" | "cancelled" | "effect_unknown") {
        ensure_host_fact(tx, &run)?;
    }
    Ok(host_apply::success(
        "authenticated controller status recorded",
        vec![turn_id.to_owned()],
        json!({ "run": run.data() }),
    ))
}

fn ensure_host_fact(tx: &Transaction<'_>, run: &TurnRun) -> Result<()> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM lifetime_turns
            WHERE ghost_id=?1 AND conversation_id=?2 AND source_turn_id=?3 AND kind='host_fact'
         )",
        params![run.ghost_id, run.conversation_id, run.turn_id],
        |row| row.get(0),
    )?;
    if exists {
        return Ok(());
    }
    let fact_id = format!(
        "host-fact-{}",
        canonical_digest(&json!({
            "contract": "ghost-canonical-controller-lifecycle/1",
            "ghost_id": run.ghost_id,
            "conversation_id": run.conversation_id,
            "turn_id": run.turn_id,
            "kind": "controller-status-fact",
        }))?
    );
    let Some((_, _, _, _, _, source_privacy)) = conversation::turn_scope(tx, &run.turn_id)? else {
        return Err(host_apply::not_found("Owner turn for Host fact not found"));
    };
    let mut privacy = conversation::conversation_privacy(tx, &run.ghost_id, &run.conversation_id)?;
    conversation::raise_privacy(&mut privacy, &source_privacy)?;
    conversation::persist_disclosure(tx, &run.ghost_id, &run.conversation_id, &privacy)?;
    let mut text = match run.state.as_str() {
        "failed" => "Host recorded a controller-reported failure for this turn.".to_owned(),
        "cancelled" => "Host recorded controller-confirmed cancellation for this turn.".to_owned(),
        "effect_unknown" => "Host could not confirm completion of this controller turn at report time; inspect the original SDK state before retrying.".to_owned(),
        _ => bail!("Host facts are only valid for failure, cancellation, or unknown status"),
    };
    if let Some(reason) = run.reason_code.as_deref() {
        if !valid_reason_code(Some(reason)) {
            bail!("stored turn-run reason code is not in the frozen safe-code set");
        }
        text.push_str(" Safe reason code: ");
        text.push_str(reason);
        text.push('.');
    }
    conversation::append_turn(
        tx,
        &fact_id,
        &run.ghost_id,
        &run.conversation_id,
        "host",
        "host",
        &text,
        &privacy,
        "host_fact",
        Some(&run.turn_id),
        &[],
    )?;
    Ok(())
}

pub(super) fn inspect_turn(
    tx: &Transaction<'_>,
    body: &Value,
    principal: &str,
) -> Result<Response> {
    host_apply::exact_fields(
        body,
        &["method", "ghost_id", "conversation_id", "turn_id"],
    )?;
    let ghost_id = host_apply::string_field(body, "ghost_id")?;
    let conversation_id = host_apply::string_field(body, "conversation_id")?;
    let turn_id = host_apply::string_field(body, "turn_id")?;
    conversation::registered_mode(tx, ghost_id, conversation_id)?;
    if principal != OWNER_PRINCIPAL {
        if principal != ghost_id {
            return Err(host_apply::reject(
                "unauthorized",
                "turn inspection is outside the authenticated Ghost pair",
                RetryClass::Never,
            ));
        }
        conversation::require_pi_binding(tx, ghost_id, conversation_id)?;
    }
    verify_owner_turn(tx, ghost_id, conversation_id, turn_id)?;
    let run = scoped_run(tx, ghost_id, conversation_id, turn_id)?;
    Ok(host_apply::success(
        "Owner turn run inspected",
        vec![turn_id.to_owned()],
        json!({ "run": run.data() }),
    ))
}

/// Add only exact-pair runs referenced by this page's Owner turns or source links.
pub(super) fn inspect_page(
    conn: &Connection,
    ghost_id: &str,
    conversation_id: &str,
    before_sequence: Option<i64>,
    limit: i64,
) -> Result<Vec<Value>> {
    let mut statement = conn.prepare(
        "WITH page_rows AS (
            SELECT id,sender_kind,kind,source_turn_id
            FROM lifetime_turns
            WHERE ghost_id=?1 AND conversation_id=?2
              AND (?3 IS NULL OR sequence<?3)
            ORDER BY sequence DESC LIMIT ?4
         ),
         turn_refs AS (
            SELECT id AS turn_id
            FROM page_rows
            WHERE sender_kind='owner' AND kind='user'
            UNION
            SELECT source_turn_id AS turn_id
            FROM page_rows
            WHERE kind IN ('assistant_advisory','host_fact') AND source_turn_id IS NOT NULL
         )
         SELECT r.turn_id,r.ghost_id,r.conversation_id,r.state,r.cancel_requested,r.cancel_command_id,
                r.submission_id,r.entry_id,r.reason_code,r.latest_status_command_id,r.created_at_ms,r.updated_at_ms
         FROM lifetime_turn_runs r
         JOIN lifetime_turns t ON t.id=r.turn_id
         WHERE r.ghost_id=?1 AND r.conversation_id=?2
           AND r.turn_id IN (SELECT turn_id FROM turn_refs)
         ORDER BY t.sequence DESC",
    )?;
    let rows = statement.query_map(
        params![ghost_id, conversation_id, before_sequence, limit],
        read_columns,
    )?;
    let mut runs = Vec::new();
    for row in rows {
        runs.push(decode_columns(row?)?.data());
    }
    runs.reverse();
    Ok(runs)
}

pub(super) fn ensure_goal_admission(
    conn: &Connection,
    ghost_id: &str,
    conversation_id: &str,
    turn_id: &str,
) -> Result<()> {
    let run = scoped_run(conn, ghost_id, conversation_id, turn_id)?;
    if run.cancel_requested || matches!(run.state.as_str(), "answered" | "failed" | "cancelled") {
        return Err(host_apply::reject(
            "conflict",
            "new Goal admission is fenced after Owner-turn cancellation or terminal status",
            RetryClass::NewRevision,
        ));
    }
    Ok(())
}

pub(super) fn check_reply(
    conn: &Connection,
    ghost_id: &str,
    conversation_id: &str,
    turn_id: &str,
) -> Result<()> {
    let run = scoped_run(conn, ghost_id, conversation_id, turn_id)?;
    if matches!(run.state.as_str(), "queued" | "failed" | "cancelled") {
        return Err(host_apply::conflict(
            "a controller reply cannot settle a queued, failed, or cancelled turn",
        ));
    }
    let already_projected: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM lifetime_turns
            WHERE ghost_id=?1 AND conversation_id=?2 AND source_turn_id=?3
              AND kind='assistant_advisory'
         )",
        params![ghost_id, conversation_id, turn_id],
        |row| row.get(0),
    )?;
    if already_projected {
        return Err(host_apply::conflict(
            "an advisory reply is already committed for this Owner turn",
        ));
    }
    Ok(())
}

/// The actual advisory callback is evidence of completion; status reports never fabricate it.
pub(super) fn record_reply(
    tx: &Transaction<'_>,
    ghost_id: &str,
    conversation_id: &str,
    turn_id: &str,
) -> Result<()> {
    let run = scoped_run(tx, ghost_id, conversation_id, turn_id)?;
    if matches!(run.state.as_str(), "failed" | "cancelled") {
        return Err(host_apply::conflict(
            "late advisory reply cannot alter a confirmed terminal turn",
        ));
    }
    if run.state == "queued" {
        return Err(host_apply::conflict(
            "advisory reply requires a committed running or reconciled turn",
        ));
    }
    if run.state == "answered" {
        return Ok(());
    }
    let changed = tx.execute(
        "UPDATE lifetime_turn_runs
         SET state='answered',reason_code=NULL,updated_at_ms=?1
         WHERE turn_id=?2 AND ghost_id=?3 AND conversation_id=?4
           AND state IN ('running','effect_unknown')",
        params![
            run.next_updated_at_ms()?,
            turn_id,
            ghost_id,
            conversation_id,
        ],
    )?;
    if changed != 1 {
        return Err(host_apply::conflict(
            "Owner turn changed before its advisory reply was committed",
        ));
    }
    Ok(())
}
