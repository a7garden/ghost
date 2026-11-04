use crate::lifetime_contract::{Envelope, Response, ResponseStatus, RetryClass};
use anyhow::Result;
use rusqlite::Connection;
use serde_json::json;

pub(crate) struct Authority {
    pub(crate) epoch: u64,
    pub(crate) dispatch_enabled: bool,
}

pub(crate) fn current(conn: &Connection) -> Result<Authority> {
    conn.query_row(
        "SELECT authority_epoch,dispatch_enabled FROM lifetime_authority WHERE singleton=1",
        [], |row| Ok(Authority { epoch: row.get(0)?, dispatch_enabled: row.get(1)? }),
    ).map_err(Into::into)
}

pub(crate) fn read_only(method: Option<&str>) -> bool {
    matches!(method, Some("snapshot" | "goal.inspect" | "goal.thread.inspect" | "work.inspect" | "work.artifact" | "work.children"
        | "conversation.inspect" | "conversation.turn.inspect" | "conversation.report.inspect" | "command.inspect" | "registry.inspect" | "mailbox.inspect" | "notification.inspect" | "bot.definition.inspect" | "bot.candidate.inspect" | "bot.discover" | "bot.lifecycle.inspect" | "bot.surface.inspect" | "bot.creation.plan" | "work.memory.profile.inspect" | "memory.context.inspect" | "work.experience.inspect"))
}

pub(crate) fn guard(conn: &Connection, envelope: &Envelope) -> Result<Option<Response>> {
    let authority = current(conn)?;
    let rejection = if envelope.authority_epoch != authority.epoch {
        Some(("authority_fenced", "writer authority epoch is not current"))
    } else if !authority.dispatch_enabled && !read_only(envelope.body["method"].as_str()) {
        Some(("dispatch_off", "restored Host is read-only; effect dispatch is disabled"))
    } else { None };
    Ok(rejection.map(|(code, summary)| Response {
        status: ResponseStatus::Error, summary: summary.into(),
        object_refs: vec![], artifacts: vec![], next_actions: vec![],
        error_code: Some(code.into()), retry_class: RetryClass::Never,
        data: json!({"authority_epoch":authority.epoch,"dispatch_enabled":authority.dispatch_enabled}),
    }))
}
