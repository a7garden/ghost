//! Personal organizer records, separate from agent runs and document bodies.
use super::{now_ms, State};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TodoInput {
    pub title: String,
    #[serde(default)]
    pub notes: String,
    pub due: Option<String>,
    #[serde(default)]
    pub completed: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Todo {
    pub id: String,
    #[serde(flatten)]
    pub data: TodoInput,
    pub version: u64,
    pub updated_ms: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventInput {
    pub title: String,
    #[serde(default)]
    pub notes: String,
    pub start_ms: u64,
    pub end_ms: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    #[serde(flatten)]
    pub data: EventInput,
    pub version: u64,
    pub updated_ms: u64,
}

fn fields(title: &str, notes: &str) -> Result<()> {
    if title.trim().is_empty() || title.chars().count() > 500 {
        bail!("제목은 1~500자로 입력해 주세요.");
    }
    if notes.chars().count() > 8192 {
        bail!("메모는 8192자 이내로 입력해 주세요.");
    }
    Ok(())
}
fn date(value: &str) -> Result<()> {
    // Date-only deadlines never change when the viewer changes time zones.
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(i, c)| i != 4 && i != 7 && !c.is_ascii_digit())
    {
        bail!("마감일은 YYYY-MM-DD 형식이어야 합니다.");
    }
    let year: u32 = value[..4].parse()?;
    let month: u32 = value[5..7].parse()?;
    let day: u32 = value[8..].parse()?;
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    if year == 0 || day == 0 || day > days {
        bail!("유효한 마감일을 입력해 주세요.");
    }
    Ok(())
}
fn check_version(current: Option<u64>, expected: Option<u64>, editing: bool) -> Result<u64> {
    if editing && (current.is_none() || current != expected) {
        bail!("다른 변경이 저장되었습니다. 최신 항목을 다시 열어 수정해 주세요.");
    }
    if !editing && expected.is_some() {
        bail!("새 항목에는 version을 지정하지 않습니다.");
    }
    Ok(current.unwrap_or(0) + 1)
}
pub(crate) fn save_todo(
    s: &State,
    key: &str,
    id: Option<&str>,
    version: Option<u64>,
    data: TodoInput,
) -> Result<Value> {
    fields(&data.title, &data.notes)?;
    if let Some(due) = &data.due {
        date(due)?;
    }
    let old: Option<Todo> = s.journal.get("todo", id.unwrap_or(key))?;
    let next = check_version(old.as_ref().map(|t| t.version), version, id.is_some())?;
    let todo = Todo {
        id: id.unwrap_or(key).into(),
        data,
        version: next,
        updated_ms: now_ms(),
    };
    s.journal.put("todo", &todo.id, &todo)?;
    Ok(json!(todo))
}
pub(crate) fn save_event(
    s: &State,
    key: &str,
    id: Option<&str>,
    version: Option<u64>,
    data: EventInput,
) -> Result<Value> {
    fields(&data.title, &data.notes)?;
    if data.start_ms >= data.end_ms || data.end_ms > 253_402_300_799_999 {
        bail!("일정 종료 시각은 시작 이후여야 합니다.");
    }
    let old: Option<Event> = s.journal.get("calendar_event", id.unwrap_or(key))?;
    let next = check_version(old.as_ref().map(|t| t.version), version, id.is_some())?;
    let event = Event {
        id: id.unwrap_or(key).into(),
        data,
        version: next,
        updated_ms: now_ms(),
    };
    s.journal.put("calendar_event", &event.id, &event)?;
    Ok(json!(event))
}
pub(crate) fn delete(s: &State, kind: &str, id: &str, version: u64) -> Result<Value> {
    let old: Value = s
        .journal
        .get(kind, id)?
        .ok_or_else(|| anyhow!("항목을 찾지 못했습니다."))?;
    check_version(old["version"].as_u64(), Some(version), true)?;
    s.journal.delete(kind, id)?;
    Ok(json!({"deleted":id}))
}
pub(crate) fn execute(s: &State, name: &str, args: &Value, key: &str) -> Result<Value> {
    let id = args["id"].as_str();
    let version = args["version"].as_u64();
    match name {
        "list_todos" => Ok(json!({"todos":s.journal.objects::<Todo>("todo")?})),
        "list_calendar_events" => {
            let from = args["from_ms"]
                .as_u64()
                .ok_or_else(|| anyhow!("from_ms required"))?;
            let to = args["to_ms"]
                .as_u64()
                .ok_or_else(|| anyhow!("to_ms required"))?;
            if from >= to {
                bail!("to_ms must follow from_ms");
            }
            let mut events = s.journal.objects::<Event>("calendar_event")?;
            events.retain(|e| e.data.start_ms < to && e.data.end_ms > from);
            events.sort_by_key(|e| e.data.start_ms);
            Ok(json!({"events":events}))
        }
        "save_todo" => save_todo(
            s,
            key,
            id,
            version,
            serde_json::from_value(args["todo"].clone())?,
        ),
        "save_calendar_event" => save_event(
            s,
            key,
            id,
            version,
            serde_json::from_value(args["event"].clone())?,
        ),
        "delete_todo" | "delete_calendar_event" => delete(
            s,
            if name == "delete_todo" {
                "todo"
            } else {
                "calendar_event"
            },
            id.ok_or_else(|| anyhow!("id required"))?,
            version.ok_or_else(|| anyhow!("version required"))?,
        ),
        _ => bail!("unknown planner tool"),
    }
}
