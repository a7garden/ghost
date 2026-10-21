//! Owner-approved scheduled wake and morning briefing.
//!
//! One schedule row per daily responsibility, persisted in the existing
//! workspace journal (`workspace_objects`, kind `wake`). Firing reuses the
//! existing per-profile `dispatch_due` worker loop; there is no second timer.
//! Every occurrence has a stable identity — the local civil datetime in the
//! schedule's IANA zone — and a fixed request identity
//! `wake:{schedule_id}:{occurrence}`, so restarts, replays and clock regressions
//! can never duplicate a fire. Schedule provenance is persisted at creation
//! (`origin.kind = "owner"` with the approving control request id); a fire is an
//! emission of that Owner-approved schedule, never a generated human turn.
//!
//! Delivery follows the conversation's real runtime: a legacy runtime
//! conversation receives the composed briefing as a durable observation plus a
//! `FollowUp` turn exactly like the interval scheduler; a lifetime-registered
//! Ghost receives an owner-principal `goal.submit` through
//! [`crate::host::lifetime::apply`], which enqueues the frozen
//! `conversation.assignment` to Pi Durable and gives the briefing Goal a real
//! Work, a canonical Owner report and a `briefing` notification derived from the
//! durable wake ledger (never from acceptance_spec JSON alone).
use super::{now_ms, State};
use crate::durable::durable::InputKind;
use anyhow::{anyhow, bail, Result};
use jiff::civil::DateTime;
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// workspace_objects kind for schedule rows.
pub(crate) const WAKE_KIND: &str = "wake";
/// workspace_objects kind for per-occurrence fire records.
pub(crate) const WAKE_RUN_KIND: &str = "wake_run";
/// Briefing text limit: the legacy observation channel accepts 32 KiB.
const LEGACY_BRIEFING_LIMIT: usize = 32_000;
/// Pi `goal.submit` prompts ride `conversation.assignment`; stay well inside the
/// frozen 65,536-byte conversation input bound.
const LIFETIME_BRIEFING_LIMIT: usize = 60_000;
/// Bounded missed-occurrence window: anything older coalesces into one summary.
const MAX_MISSED_OCCURRENCES: u64 = 60;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WakeInput {
    pub conversation_id: String,
    pub prompt: String,
    /// Stored IANA zone; occurrence math is DST-correct via the tz database.
    pub timezone: String,
    /// Local wall-clock fire time, "HH:MM".
    pub local_time: String,
    /// Optional quiet-hours length in minutes after local midnight; a fire time
    /// inside the window is postponed to its end.
    #[serde(default)]
    pub quiet_minutes: Option<u32>,
    /// `coalesce` (default): one fire for the latest missed occurrence.
    /// `skip`: missed occurrences are recorded and skipped without a fire.
    #[serde(default)]
    pub missed_policy: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WakeSchedule {
    pub id: String,
    pub profile_id: String,
    #[serde(flatten)]
    pub input: WakeInput,
    /// UTC millis of the next (or in-flight) occurrence.
    pub next_run_ms: u64,
    /// Local civil datetime identity of `next_run_ms`, e.g. `2026-10-12T08:00:00`.
    pub next_occurrence_key: String,
    /// Monotonic occurrence counter; doubles as the notification goal revision.
    pub occurrence_seq: u64,
    pub paused: bool,
    /// `idle` | `claiming` — a claiming occurrence survives restarts for recovery.
    pub fire_state: String,
    /// Legacy delivery: the durable conversation task id once submitted.
    pub last_task_id: Option<String>,
    /// Truthful schedule origin, e.g. `{"kind":"owner","request_id":…,"created_ms":…}`.
    pub origin: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WakeRun {
    pub id: String,
    pub wake_id: String,
    pub occurrence_key: String,
    /// `claimed` | `submitted` | `skipped` | `unknown` | `failed`
    pub status: String,
    /// Lifetime authority epoch at claim time. A restore that changed the epoch
    /// fences the claimed occurrence as `unknown` instead of resubmitting it.
    pub authority_epoch: u64,
    /// Lifetime delivery: the admitted briefing Goal id.
    pub goal_id: Option<String>,
    /// Legacy delivery: the durable conversation task id.
    pub task_id: Option<String>,
    pub at_ms: u64,
    #[serde(default)]
    pub diagnostic: Option<String>,
}

fn parse_local_time(value: &str) -> Result<(i32, i32)> {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        bail!("local_time must be HH:MM");
    }
    let hour: i32 = value[..2].parse()?;
    let minute: i32 = value[3..].parse()?;
    if !(0..24).contains(&hour) || !(0..60).contains(&minute) {
        bail!("local_time must be a valid wall-clock time");
    }
    Ok((hour, minute))
}

fn zone(timezone: &str) -> Result<TimeZone> {
    TimeZone::get(timezone).map_err(|_| anyhow!("unknown IANA timezone '{timezone}'"))
}

/// Adjust the local fire time for stored quiet hours: a time inside
/// [00:00, quiet_end) fires at quiet_end the same local day.
fn apply_quiet(hour: i32, minute: i32, quiet_minutes: Option<u32>) -> (i32, i32) {
    match quiet_minutes {
        Some(minutes) if minutes > 0 => {
            let end = (minutes as i32).min(24 * 60);
            let (end_hour, end_minute) = (end / 60, end % 60);
            if hour * 60 + minute < end {
                (end_hour, end_minute)
            } else {
                (hour, minute)
            }
        }
        _ => (hour, minute),
    }
}

/// The next occurrence strictly after `after_ms`, DST-correct in the stored
/// zone. jiff `compatible` disambiguation: a spring-forward gap fires at the
/// offset before the transition, a fall-back fold uses the earlier offset.
pub(crate) fn occurrence_after(
    timezone: &str,
    local_time: &str,
    quiet_minutes: Option<u32>,
    after_ms: u64,
) -> Result<(u64, String)> {
    let tz = zone(timezone)?;
    let (hour, minute) = parse_local_time(local_time)?;
    let (hour, minute) = apply_quiet(hour, minute, quiet_minutes);
    let after = jiff::Timestamp::from_millisecond(after_ms as i64)
        .map_err(|_| anyhow!("timestamp out of range"))?;
    let mut date = after.to_zoned(tz.clone()).datetime().date();
    for _ in 0..3 {
        let candidate: DateTime = date.at(hour as i8, minute as i8, 0, 0);
        let instant = tz
            .to_zoned(candidate)
            .map_err(|_| anyhow!("occurrence resolution failed"))?
            .timestamp();
        if instant.as_millisecond() > after.as_millisecond() {
            return Ok((instant.as_millisecond() as u64, candidate.to_string()));
        }
        date = date.tomorrow().map_err(|_| anyhow!("date overflow"))?;
    }
    bail!("could not resolve the next wake occurrence")
}

/// The latest occurrence at or before `now_ms`, for missed-occurrence policy.
pub(crate) fn occurrence_at_or_before(
    timezone: &str,
    local_time: &str,
    quiet_minutes: Option<u32>,
    now_ms: u64,
) -> Result<(u64, String)> {
    let tz = zone(timezone)?;
    let (hour, minute) = parse_local_time(local_time)?;
    let (hour, minute) = apply_quiet(hour, minute, quiet_minutes);
    let now = jiff::Timestamp::from_millisecond(now_ms as i64)
        .map_err(|_| anyhow!("timestamp out of range"))?;
    let mut date = now.to_zoned(tz.clone()).datetime().date();
    for _ in 0..3 {
        let candidate: DateTime = date.at(hour as i8, minute as i8, 0, 0);
        if let Ok(zoned) = tz.to_zoned(candidate) {
            let ms = zoned.timestamp().as_millisecond();
            if ms <= now.as_millisecond() {
                return Ok((ms as u64, candidate.to_string()));
            }
        }
        date = date.yesterday().map_err(|_| anyhow!("date underflow"))?;
    }
    bail!("could not resolve the previous wake occurrence")
}

fn validate_input(input: &WakeInput) -> Result<()> {
    zone(&input.timezone)?;
    parse_local_time(&input.local_time)?;
    if let Some(quiet) = input.quiet_minutes {
        if quiet > 14 * 60 {
            bail!("quiet_minutes must be at most 14 hours");
        }
    }
    match input.missed_policy.as_str() {
        "" | "coalesce" => {}
        "skip" => {}
        other => bail!("missed_policy must be 'coalesce' or 'skip', not '{other}'"),
    }
    let prompt = input.prompt.trim();
    if prompt.is_empty() || prompt.len() > 8192 {
        bail!("wake prompt must be 1..=8192 bytes");
    }
    Ok(())
}

#[cfg(feature = "lifetime")]
fn registered_conversation(conn: &rusqlite::Connection, profile_id: &str) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT conversation_id FROM lifetime_registry WHERE ghost_id=?1 LIMIT 1",
        [profile_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

fn broker_mode() -> bool {
    #[cfg(feature = "lifetime")]
    {
        std::env::var("GHOST_LIFETIME_MODE").as_deref() == Ok("broker")
    }
    #[cfg(not(feature = "lifetime"))]
    {
        false
    }
}

/// Create an Owner-approved wake schedule. In lifetime broker mode the target
/// conversation must be the Ghost's registered lifetime conversation, so the
/// briefing reaches the single main registered Ghost and its scoped devices.
pub(crate) fn add(s: &State, request: &str, profile_id: &str, input: WakeInput) -> Result<Value> {
    validate_input(&input)?;
    let p = s
        .profiles
        .get(profile_id)
        .ok_or_else(|| anyhow!("Ghost missing"))?;
    let legacy_exists = p
        .runtime
        .session
        .committed()?
        .conversations
        .contains_key(&input.conversation_id);
    #[cfg(feature = "lifetime")]
    let registered = registered_conversation(&s.journal.0, profile_id)?;
    #[cfg(not(feature = "lifetime"))]
    let registered: Option<String> = None;
    if legacy_exists {
        if registered.is_some() && broker_mode() {
            bail!("this Ghost's briefing conversation is the registered lifetime conversation; schedule the wake against it");
        }
    } else if registered.as_deref() == Some(input.conversation_id.as_str()) {
        if !broker_mode() {
            bail!("lifetime broker mode is required for the registered briefing conversation");
        }
    } else {
        bail!("conversation missing for this Ghost");
    }
    let now = now_ms();
    let (next_run_ms, next_key) =
        occurrence_after(&input.timezone, &input.local_time, input.quiet_minutes, now)?;
    let wake = WakeSchedule {
        id: uuid::Uuid::now_v7().to_string(),
        profile_id: profile_id.to_owned(),
        input,
        next_run_ms,
        next_occurrence_key: next_key,
        occurrence_seq: 0,
        paused: false,
        fire_state: "idle".into(),
        last_task_id: None,
        origin: json!({"kind":"owner","request_id":request,"created_ms":now}),
    };
    s.journal.put(WAKE_KIND, &wake.id, &wake)?;
    Ok(json!(wake))
}

pub(crate) fn list(s: &State, profile_id: &str) -> Result<Vec<WakeSchedule>> {
    Ok(s.journal
        .objects::<WakeSchedule>(WAKE_KIND)?
        .into_iter()
        .filter(|w| w.profile_id == profile_id)
        .collect())
}

fn load_wake(s: &State, profile_id: &str, wake_id: &str) -> Result<WakeSchedule> {
    let wake: WakeSchedule = s
        .journal
        .get(WAKE_KIND, wake_id)?
        .ok_or_else(|| anyhow!("wake schedule not found"))?;
    if wake.profile_id != profile_id {
        bail!("wake schedule belongs to another Ghost");
    }
    Ok(wake)
}

/// Reschedule or pause. Refuses while an occurrence is claimed so an in-flight
/// fire can never be silently retargeted; pause/resume recomputes the next
/// occurrence from now (missed occurrences are not backfilled after resume).
pub(crate) fn update(
    s: &State,
    profile_id: &str,
    wake_id: &str,
    local_time: Option<String>,
    timezone: Option<String>,
    quiet_minutes: Option<Option<u32>>,
    missed_policy: Option<String>,
    paused: Option<bool>,
) -> Result<Value> {
    let mut wake = load_wake(s, profile_id, wake_id)?;
    if wake.fire_state != "idle" {
        bail!("a wake occurrence is being delivered; retry after it settles");
    }
    if let Some(value) = &local_time {
        parse_local_time(value)?;
        wake.input.local_time = value.clone();
    }
    if let Some(value) = &timezone {
        zone(value)?;
        wake.input.timezone = value.clone();
    }
    if let Some(value) = quiet_minutes {
        if let Some(minutes) = value {
            if minutes > 14 * 60 {
                bail!("quiet_minutes must be at most 14 hours");
            }
        }
        wake.input.quiet_minutes = value;
    }
    if let Some(policy) = &missed_policy {
        match policy.as_str() {
            "coalesce" | "skip" => wake.input.missed_policy = policy.clone(),
            other => bail!("missed_policy must be 'coalesce' or 'skip', not '{other}'"),
        }
    }
    validate_input(&wake.input)?;
    let now = now_ms();
    match paused {
        Some(true) if !wake.paused => {
            wake.paused = true;
        }
        Some(false) if wake.paused => {
            wake.paused = false;
            let (next, key) = occurrence_after(
                &wake.input.timezone,
                &wake.input.local_time,
                wake.input.quiet_minutes,
                now,
            )?;
            wake.next_run_ms = next;
            wake.next_occurrence_key = key;
        }
        _ => {}
    }
    if !wake.paused
        && (local_time.is_some() || timezone.is_some() || quiet_minutes.is_some())
    {
        let (next, key) = occurrence_after(
            &wake.input.timezone,
            &wake.input.local_time,
            wake.input.quiet_minutes,
            now,
        )?;
        wake.next_run_ms = next;
        wake.next_occurrence_key = key;
    }
    s.journal.put(WAKE_KIND, &wake.id, &wake)?;
    Ok(json!(wake))
}

/// Cancel an Owner-approved wake schedule. Run history is preserved as the
/// durable record of what already fired; only in-flight claims are refused.
pub(crate) fn remove(s: &State, profile_id: &str, wake_id: &str) -> Result<Value> {
    let wake = load_wake(s, profile_id, wake_id)?;
    if wake.fire_state != "idle" {
        bail!("a wake occurrence is being delivered; cancel after it settles");
    }
    s.journal.delete(WAKE_KIND, wake_id)?;
    Ok(json!({"deleted": wake_id}))
}

/// Read-only preview of the next briefing: pure derivation from persisted rows,
/// no model call, no write, no effect. Served by the read-only action surface.
pub(crate) fn preview(
    s: &State,
    profile_id: &str,
    wake_id: &str,
    now_override: Option<u64>,
) -> Result<Value> {
    let wake = load_wake(s, profile_id, wake_id)?;
    let now = now_override.unwrap_or_else(now_ms);
    let (occurrence_ms, occurrence_key) = occurrence_after(
        &wake.input.timezone,
        &wake.input.local_time,
        wake.input.quiet_minutes,
        now.saturating_sub(1),
    )?;
    let (start_ms, end_ms) = briefing_window(&wake.input.timezone, occurrence_ms)?;
    let composed = compose(s, profile_id, &wake.input.timezone, start_ms, end_ms, now, LEGACY_BRIEFING_LIMIT)?;
    let delivery = delivery_route(s, profile_id, &wake.input.conversation_id);
    Ok(json!({
        "wake_id": wake.id,
        "paused": wake.paused,
        "delivery": delivery,
        "occurrence_ms": occurrence_ms,
        "occurrence_key": occurrence_key,
        "window": {"start_ms": start_ms, "end_ms": end_ms},
        "request_id": format!("wake:{}:{}", wake.id, occurrence_key),
        "briefing": composed,
    }))
}

/// Which runtime actually receives this conversation's fires.
fn delivery_route(s: &State, profile_id: &str, conversation_id: &str) -> &'static str {
    let legacy = s
        .profiles
        .get(profile_id)
        .and_then(|p| p.runtime.session.committed().ok())
        .is_some_and(|snapshot| snapshot.conversations.contains_key(conversation_id));
    if legacy {
        "legacy"
    } else {
        "lifetime"
    }
}

/// The briefing covers the scheduled local day [00:00, +24h) in the wake zone.
fn briefing_window(timezone: &str, occurrence_ms: u64) -> Result<(i64, i64)> {
    let tz = zone(timezone)?;
    let occurrence = jiff::Timestamp::from_millisecond(occurrence_ms as i64)
        .map_err(|_| anyhow!("timestamp out of range"))?;
    let midnight = occurrence
        .to_zoned(tz.clone())
        .datetime()
        .date()
        .at(0, 0, 0, 0);
    let start = tz
        .to_zoned(midnight)
        .map_err(|_| anyhow!("window resolution failed"))?
        .timestamp()
        .as_millisecond();
    Ok((start, start + 86_400_000))
}

fn push_line(out: &mut String, limit: usize, line: String) -> bool {
    let line = line.trim_end_matches('\n');
    if out.len() + line.len() + 1 > limit {
        out.push_str("…(이하 생략)");
        return false;
    }
    out.push_str(line);
    out.push('\n');
    true
}

/// Deterministic briefing composition from persisted rows only: local calendar
/// events and to-dos, connected planner resources, sync freshness, and (under
/// the lifetime feature) blocked Work and pending decisions from the Host
/// ledger. No network, no model — the authoritative inputs are the last synced
/// state plus the local planner, preserved as-is when a sync is incomplete.
pub(crate) fn compose(
    s: &State,
    profile_id: &str,
    timezone: &str,
    start_ms: i64,
    end_ms: i64,
    now: u64,
    limit: usize,
) -> Result<String> {
    let tz = zone(timezone)?;
    let day = jiff::Timestamp::from_millisecond(start_ms)
        .map_err(|_| anyhow!("timestamp out of range"))?
        .to_zoned(tz.clone())
        .datetime()
        .date();
    let mut out = String::new();
    out.push_str(&format!(
        "브리핑 — {day} ({timezone}), 조회 시각 UTC {}\n",
        jiff::Timestamp::from_millisecond(now as i64)
            .map(|t| t.to_string())
            .unwrap_or_else(|_| "unknown".into())
    ));

    // Local calendar events overlapping the day window.
    let mut events = s.journal.objects::<crate::host::planner::Event>("calendar_event")?;
    events.retain(|e| i128::from(e.data.start_ms) < i128::from(end_ms)
        && i128::from(e.data.end_ms) > i128::from(start_ms));
    events.sort_by_key(|e| e.data.start_ms);
    out.push_str("\n일정(로컬):\n");
    if events.is_empty() {
        out.push_str("- 없음\n");
    }
    for event in &events {
        let start = jiff::Timestamp::from_millisecond(event.data.start_ms as i64)
            .map(|t| t.to_zoned(tz.clone()).to_string())
            .unwrap_or_else(|_| "?".into());
        let end = jiff::Timestamp::from_millisecond(event.data.end_ms as i64)
            .map(|t| t.to_zoned(tz.clone()).strftime("%H:%M").to_string())
            .unwrap_or_else(|_| "?".into());
        if !push_line(
            &mut out,
            limit,
            format!("- {} {}–{} [local:{}]\n", start, end, event.data.title, event.id).trim_end().to_string(),
        ) {
            return Ok(out);
        }
    }

    // Connected planner collections bound to this Ghost: events in the window.
    #[cfg(feature = "caldav")]
    {
        use crate::host::planner_sync::{self, Kind};
        let snapshot = planner_sync::snapshot(s)?;
        let collections = snapshot["collections"].as_array().cloned().unwrap_or_default();
        let mut listed_any = false;
        for collection in &collections {
            let cid = collection["id"].as_str().unwrap_or_default();
            if cid.is_empty()
                || !collection["enabled"].as_bool().unwrap_or(false)
                || !collection["profiles"]
                    .as_array()
                    .is_some_and(|ps| ps.iter().any(|p| p.as_str() == Some(profile_id)))
            {
                continue;
            }
            listed_any = true;
            let status = planner_sync::sync_status(s, cid)?;
            out.push_str(&format!("\n연결된 일정 [{cid} / {}]:\n", collection["binding"].as_str().unwrap_or("?")));
            if !push_line(
                &mut out,
                limit,
                format!(
                    "- 동기화: 성공 {}, 시도 {}, 오류 {}\n",
                    status["last_success_ms"].as_i64().map(|ms| jiff::Timestamp::from_millisecond(ms).map(|t| t.to_string()).unwrap_or_default()).unwrap_or_else(|| "없음".into()),
                    status["last_attempt_ms"].as_i64().map(|ms| jiff::Timestamp::from_millisecond(ms).map(|t| t.to_string()).unwrap_or_default()).unwrap_or_else(|| "없음".into()),
                    status["last_error"].as_str().unwrap_or("없음")
                ),
            ) {
                return Ok(out);
            }
            let listed = planner_sync::list(s, cid, Some(start_ms), Some(end_ms))?;
            let items = listed["items"].as_array().cloned().unwrap_or_default();
            if items.is_empty() {
                out.push_str("- 해당 없음\n");
            }
            let today = day.to_string();
            for item in &items {
                let view = &item["view"];
                let kind = view["kind"].as_str().unwrap_or("");
                if kind == serde_json::json!(Kind::Event).as_str().unwrap_or("VEVENT") {
                    let start = view["start_ms"].as_i64().unwrap_or(0);
                    let end = view["end_ms"].as_i64().unwrap_or(0);
                    let span = format!(
                        "{}–{}",
                        jiff::Timestamp::from_millisecond(start)
                            .map(|t| t.to_zoned(tz.clone()).strftime("%m-%d %H:%M").to_string())
                            .unwrap_or_else(|_| "?".into()),
                        jiff::Timestamp::from_millisecond(end)
                            .map(|t| t.to_zoned(tz.clone()).strftime("%H:%M").to_string())
                            .unwrap_or_else(|_| "?".into()),
                    );
                    if !push_line(
                        &mut out,
                        limit,
                        format!(
                            "- {} {} [connected:{cid} uid:{}]\n",
                            span,
                            view["title"].as_str().unwrap_or(""),
                            item["uid"].as_str().unwrap_or("")
                        ),
                    ) {
                        return Ok(out);
                    }
                } else if kind == serde_json::json!(Kind::Todo).as_str().unwrap_or("VTODO") {
                    let completed = view["completed"].as_bool().unwrap_or(false);
                    let due = view["due"].as_str().unwrap_or("");
                    if completed || due.is_empty() || due > today.as_str() {
                        continue;
                    }
                    let marker = if due < today.as_str() { "기한 지남" } else { "오늘" };
                    if !push_line(
                        &mut out,
                        limit,
                        format!(
                            "- [{marker} {due}] {} [connected:{cid} uid:{}]\n",
                            view["title"].as_str().unwrap_or(""),
                            item["uid"].as_str().unwrap_or("")
                        ),
                    ) {
                        return Ok(out);
                    }
                }
            }
        }
        if !listed_any {
            out.push_str("\n연결된 일정: 바인딩 없음\n");
        }
    }

    // Local to-dos: open items due today or overdue.
    let mut todos = s.journal.objects::<crate::host::planner::Todo>("todo")?;
    todos.retain(|t| !t.data.completed && t.data.due.is_some());
    todos.sort_by(|a, b| a.data.due.cmp(&b.data.due));
    let today = day.to_string();
    out.push_str("\n할 일:\n");
    if todos.is_empty() {
        out.push_str("- 없음\n");
    }
    for todo in &todos {
        let Some(due) = &todo.data.due else { continue };
        let marker = if due.as_str() < today.as_str() { "기한 지남" } else { "오늘" };
        if !push_line(
            &mut out,
            limit,
            format!("- [{marker} {due}] {} [todo:{}]\n", todo.data.title, todo.id),
        ) {
            return Ok(out);
        }
    }

    #[cfg(feature = "lifetime")]
    {
        // Blocked work and decisions waiting on the Owner, from the Host ledger.
        let mut statement = s.journal.0.prepare(
            "SELECT w.id,w.state,w.goal_id,w.goal_revision,json_extract(w.payload,'$.blocker'),json_extract(g.payload,'$.prompt') FROM lifetime_work w
             JOIN lifetime_goals g ON g.id=w.goal_id
             WHERE w.owner=?1 AND (w.state='blocked' OR (w.state='review' AND EXISTS(
               SELECT 1 FROM lifetime_results r WHERE r.work_id=w.id AND r.goal_revision=w.goal_revision)))
             ORDER BY w.rowid LIMIT 32",
        )?;
        let rows = statement.query_map([profile_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        let mut found = false;
        let mut section = String::from("\n막힌 작업과 결정 대기:\n");
        for row in rows {
            let (id, state, goal_id, revision, blocker, prompt) = row?;
            found = true;
            let label = if state == "blocked" { "막힘" } else { "결정 대기" };
            let reason = blocker.unwrap_or_default();
            let snippet: String = prompt.chars().take(80).collect();
            if !push_line(
                &mut section,
                limit,
                format!(
                    "- [{label}] {} rev {revision} 목표: {snippet} [work:{id} goal:{goal_id}]\n",
                    reason.trim()
                ),
            ) {
                break;
            }
        }
        if !found {
            section.push_str("- 없음\n");
        }
        if !push_line(&mut out, limit, section) {
            return Ok(out);
        }
    }
    Ok(out)
}

/// Provenance header + Owner standing instruction for the briefing turn. The
/// text states its schedule origin truthfully; it never impersonates the Owner.
fn briefing_prompt(wake: &WakeSchedule, occurrence_key: &str, briefing: &str) -> String {
    format!(
        "[scheduled wake] Owner가 승인한 wake 일정 {}({}) {} 발생분 자동 브리핑입니다. 아래 수집 결과를 근거로 짧게 요약하고, 출처 표시와 누락 항목을 유지하세요.\n\n{}",
        wake.id, wake.origin["request_id"].as_str().unwrap_or("owner"), occurrence_key, briefing
    )
}

/// Fire every due wake for this Ghost, and recover any claimed occurrence left
/// by a restart. Called only from the existing dispatch_due worker loop.
pub(crate) fn fire_due(s: &State, profile_id: &str, now: u64) -> Result<()> {
    // 1. Recover interrupted claims before new fires.
    for wake in list(s, profile_id)? {
        if wake.fire_state != "claiming" {
            continue;
        }
        recover_claim(s, &wake, now)?;
    }
    // 2. Fire what is due.
    for wake in list(s, profile_id)? {
        if wake.paused || wake.fire_state != "idle" || wake.next_run_ms > now {
            continue;
        }
        let (latest_ms, latest_key) = occurrence_at_or_before(
            &wake.input.timezone,
            &wake.input.local_time,
            wake.input.quiet_minutes,
            now,
        )?;
        if latest_ms == wake.next_run_ms {
            deliver(s, profile_id, &wake, latest_ms, &latest_key, now)?;
            continue;
        }
        // wake.next_run_ms < latest: occurrences were missed (offline, reboot).
        let policy = if wake.input.missed_policy.is_empty() {
            "coalesce"
        } else {
            wake.input.missed_policy.as_str()
        };
        if policy == "skip" {
            record_skipped(s, &wake, wake.next_run_ms, latest_ms, now)?;
            advance(s, &wake, latest_ms, now)?;
            continue;
        }
        // coalesce: one bounded summary for the skipped span, one fire for the
        // latest missed occurrence — never an explosion of backfilled days.
        record_skipped(s, &wake, wake.next_run_ms, latest_ms, now)?;
        deliver(s, profile_id, &wake, latest_ms, &latest_key, now)?;
    }
    Ok(())
}

/// Persist the skipped span as one summary run (bounded count, first/last key).
fn record_skipped(s: &State, wake: &WakeSchedule, from_ms: u64, to_ms: u64, now: u64) -> Result<()> {
    if from_ms >= to_ms {
        return Ok(());
    }
    let mut count: u64 = 0;
    let mut first_key = String::new();
    let mut last_key = String::new();
    let mut cursor = from_ms;
    while count < MAX_MISSED_OCCURRENCES {
        let (ms, key) = occurrence_after(
            &wake.input.timezone,
            &wake.input.local_time,
            wake.input.quiet_minutes,
            cursor,
        )?;
        if ms >= to_ms {
            break;
        }
        if first_key.is_empty() {
            first_key = key.clone();
        }
        last_key = key;
        count += 1;
        cursor = ms;
    }
    s.journal.put(
        WAKE_RUN_KIND,
        &format!("{}:skip:{from_ms}", wake.id),
        &WakeRun {
            id: format!("{}:skip:{from_ms}", wake.id),
            wake_id: wake.id.clone(),
            occurrence_key: format!("{first_key}..{last_key}"),
            status: "skipped".into(),
            authority_epoch: current_epoch(s),
            goal_id: None,
            task_id: None,
            at_ms: now,
            diagnostic: Some(format!("missed occurrences coalesced: {count}")),
        },
    )?;
    Ok(())
}

#[cfg(feature = "lifetime")]
pub(crate) fn current_epoch(s: &State) -> u64 {
    super::lifetime::authority::current(&s.journal.0)
        .map(|a| a.epoch)
        .unwrap_or(0)
}
#[cfg(not(feature = "lifetime"))]
pub(crate) fn current_epoch(_s: &State) -> u64 {
    0
}

/// A restart interrupted a claimed occurrence. Same epoch: redeliver the exact
/// request identity (durable dedup makes this a no-op if it already landed).
/// A changed epoch (restore/rebind): fence the occurrence `unknown` for Owner
/// resolution — never derive a fresh command id for it. Future occurrences
/// resume normally.
fn recover_claim(s: &State, wake: &WakeSchedule, now: u64) -> Result<()> {
    let run_id = format!("{}:{}", wake.id, wake.next_occurrence_key);
    let run: WakeRun = match s.journal.get(WAKE_RUN_KIND, &run_id)? {
        Some(run) => run,
        None => {
            // Crash between the schedule claim and the run record: rebuild the
            // claim row so delivery stays accountable for this occurrence.
            WakeRun {
                id: run_id.clone(),
                wake_id: wake.id.clone(),
                occurrence_key: wake.next_occurrence_key.clone(),
                status: "claimed".into(),
                authority_epoch: current_epoch(s),
                goal_id: None,
                task_id: None,
                at_ms: now,
                diagnostic: None,
            }
        }
    };
    s.journal.put(WAKE_RUN_KIND, &run_id, &run)?;
    let epoch = current_epoch(s);
    if run.status == "claimed" && run.authority_epoch != epoch {
        let mut fenced = run.clone();
        fenced.status = "unknown".into();
        fenced.diagnostic = Some(format!(
            "authority epoch changed from {} to {epoch} while the occurrence was claimed; inspect for effects before resuming",
            run.authority_epoch
        ));
        fenced.at_ms = now;
        s.journal.put(WAKE_RUN_KIND, &run_id, &fenced)?;
        advance(s, wake, wake.next_run_ms, now)?;
        return Ok(());
    }
    if run.status == "claimed" {
        deliver(s, &wake.profile_id, wake, wake.next_run_ms, &wake.next_occurrence_key, now)?;
    } else {
        // already submitted/failed — just close the claim
        advance(s, wake, wake.next_run_ms, now)?;
    }
    Ok(())
}

/// CAS-claim the occurrence, deliver it, then advance. The claim row carries the
/// authority epoch so a restore can never replay an unknown occurrence.
fn deliver(
    s: &State,
    profile_id: &str,
    wake: &WakeSchedule,
    occurrence_ms: u64,
    occurrence_key: &str,
    now: u64,
) -> Result<()> {
    // One writer per occurrence: the CAS on the persisted schedule state. The
    // schedule claim is committed first so a crash between the two writes still
    // leaves a recoverable claim keyed by next_occurrence_key.
    let mut claimed = wake.clone();
    claimed.fire_state = "claiming".into();
    claimed.occurrence_seq += 1;
    claimed.next_run_ms = occurrence_ms;
    claimed.next_occurrence_key = occurrence_key.to_string();
    s.journal.put(WAKE_KIND, &wake.id, &claimed)?;
    let run_id = format!("{}:{}", wake.id, occurrence_key);
    s.journal.put(
        WAKE_RUN_KIND,
        &run_id,
        &WakeRun {
            id: run_id.clone(),
            wake_id: wake.id.clone(),
            occurrence_key: occurrence_key.to_string(),
            status: "claimed".into(),
            authority_epoch: current_epoch(s),
            goal_id: None,
            task_id: None,
            at_ms: now,
            diagnostic: None,
        },
    )?;

    let request_id = format!("wake:{}:{}", wake.id, occurrence_key);
    let result = deliver_once(s, profile_id, &claimed, occurrence_key, &request_id);
    match result {
        Ok(outcome) => {
            let mut run: WakeRun = s
                .journal
                .get(WAKE_RUN_KIND, &run_id)?
                .ok_or_else(|| anyhow!("claim row vanished"))?;
            run.status = "submitted".into();
            run.task_id = outcome.task_id.clone();
            run.goal_id = outcome.goal_id;
            run.at_ms = now;
            s.journal.put(WAKE_RUN_KIND, &run_id, &run)?;
            let mut done = claimed;
            done.fire_state = "idle".into();
            done.last_task_id = outcome.task_id.clone();
            let (next, key) = occurrence_after(
                &done.input.timezone,
                &done.input.local_time,
                done.input.quiet_minutes,
                occurrence_ms,
            )?;
            done.next_run_ms = next;
            done.next_occurrence_key = key;
            s.journal.put(WAKE_KIND, &wake.id, &done)?;
        }
        Err(error) => {
            let mut run: WakeRun = s
                .journal
                .get(WAKE_RUN_KIND, &run_id)?
                .ok_or_else(|| anyhow!("claim row vanished"))?;
            run.status = "failed".into();
            run.diagnostic = Some(error.to_string());
            run.at_ms = now;
            s.journal.put(WAKE_RUN_KIND, &run_id, &run)?;
            let mut failed = claimed;
            failed.fire_state = "idle".into();
            let (next, key) = occurrence_after(
                &failed.input.timezone,
                &failed.input.local_time,
                failed.input.quiet_minutes,
                occurrence_ms,
            )?;
            failed.next_run_ms = next;
            failed.next_occurrence_key = key;
            s.journal.put(WAKE_KIND, &wake.id, &failed)?;
        }
    }
    Ok(())
}

struct DeliveryOutcome {
    task_id: Option<String>,
    goal_id: Option<String>,
}

fn deliver_once(
    s: &State,
    profile_id: &str,
    claimed: &WakeSchedule,
    occurrence_key: &str,
    request_id: &str,
) -> Result<DeliveryOutcome> {
    let legacy = s
        .profiles
        .get(profile_id)
        .ok_or_else(|| anyhow!("Ghost missing"))?
        .runtime
        .session
        .committed()?
        .conversations
        .contains_key(&claimed.input.conversation_id);
    let (start_ms, end_ms) = briefing_window(&claimed.input.timezone, claimed.next_run_ms)?;
    let briefing = compose(
        s,
        profile_id,
        &claimed.input.timezone,
        start_ms,
        end_ms,
        now_ms(),
        if legacy { LEGACY_BRIEFING_LIMIT } else { LIFETIME_BRIEFING_LIMIT },
    )?;
    if legacy {
        // Machine-origin context first, then the standing instruction as a
        // FollowUp — the same durable admission the interval scheduler uses.
        s.profiles
            .get(profile_id)
            .ok_or_else(|| anyhow!("Ghost missing"))?
            .runtime
            .session
            .observe(
                &claimed.input.conversation_id,
                request_id,
                &format!("wake:{}:{}", claimed.id, occurrence_key),
                &briefing,
            )?;
        let submission = s
            .profiles
            .get(profile_id)
            .ok_or_else(|| anyhow!("Ghost missing"))?
            .runtime
            .session
            .submit(
                &claimed.input.conversation_id,
                request_id,
                InputKind::FollowUp,
                &briefing_prompt(claimed, occurrence_key, &briefing),
            )?;
        Ok(DeliveryOutcome { task_id: Some(submission.task_id), goal_id: None })
    } else {
        #[cfg(feature = "lifetime")]
        {
            deliver_lifetime(s, profile_id, claimed, occurrence_key, request_id, &briefing)
        }
        #[cfg(not(feature = "lifetime"))]
        {
            let _ = occurrence_key;
            bail!("conversation is not a legacy runtime conversation; lifetime briefing requires the lifetime feature");
        }
    }
}

/// Lifetime delivery: owner-principal goal.submit through the canonical apply
/// path. The command id is the fixed wake occurrence identity, so a crash and
/// restart re-derives the same command and the lifetime command ledger dedups
/// it. The acceptance_spec records the durable wake origin; the notification
/// kind is later derived from the wake run ledger, not from this JSON alone.
#[cfg(feature = "lifetime")]
fn deliver_lifetime(
    s: &State,
    profile_id: &str,
    claimed: &WakeSchedule,
    occurrence_key: &str,
    request_id: &str,
    briefing: &str,
) -> Result<DeliveryOutcome> {
    use crate::lifetime_contract::{canonical_digest, Envelope, VERSION};
    if !broker_mode() {
        bail!("lifetime briefing requires broker mode for this Ghost");
    }
    let registered = registered_conversation(&s.journal.0, profile_id)?
        .ok_or_else(|| anyhow!("Ghost is not lifetime-registered"))?;
    if registered != claimed.input.conversation_id {
        bail!("wake conversation is not the Ghost's registered conversation");
    }
    let authority = super::lifetime::authority::current(&s.journal.0)?;
    if !authority.dispatch_enabled {
        bail!("lifetime dispatch is disabled; the claimed occurrence stays recoverable");
    }
    let body = json!({
        "method": "goal.submit",
        "ghost_id": profile_id,
        "conversation_id": claimed.input.conversation_id,
        "prompt": briefing_prompt(claimed, occurrence_key, briefing),
        "privacy": "private",
        "acceptance_spec": {
            "origin": "wake",
            "wake_id": claimed.id,
            "occurrence_key": occurrence_key,
            "schedule_origin": claimed.origin,
            "expected": {
                "sections": ["일정", "할 일", "막힌 작업과 결정 대기"],
                "source_links": true,
                "as_of": "composition time recorded in the prompt",
            },
        },
    });
    let envelope = Envelope {
        protocol_version: VERSION.into(),
        payload_digest: canonical_digest(&body)?,
        actor_ref: "owner".into(),
        authority_epoch: authority.epoch,
        expected_revision: None,
        correlation_id: request_id.to_owned(),
        command_id: request_id.to_owned(),
        body,
    };
    let response = super::lifetime::apply(&s.journal.0, &envelope, "owner")?;
    if response.status != crate::lifetime_contract::ResponseStatus::Success {
        bail!("wake goal admission rejected: {}", response.summary);
    }
    let goal_id = response
        .object_refs
        .first()
        .cloned()
        .ok_or_else(|| anyhow!("wake goal admission returned no goal id"))?;
    Ok(DeliveryOutcome { task_id: None, goal_id: Some(goal_id) })
}

/// Advance to the next occurrence strictly after the given instant.
fn advance(s: &State, wake: &WakeSchedule, after_ms: u64, _now: u64) -> Result<()> {
    let mut fresh: WakeSchedule = s
        .journal
        .get(WAKE_KIND, &wake.id)?
        .ok_or_else(|| anyhow!("wake schedule vanished"))?;
    if fresh.fire_state == "claiming" {
        fresh.fire_state = "idle".into();
        let (next, key) = occurrence_after(
            &fresh.input.timezone,
            &fresh.input.local_time,
            fresh.input.quiet_minutes,
            after_ms,
        )?;
        fresh.next_run_ms = next;
        fresh.next_occurrence_key = key;
        s.journal.put(WAKE_KIND, &wake.id, &fresh)?;
    }
    Ok(())
}
