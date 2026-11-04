//! Read-only receipt recovery across an explicitly owner-controlled writer fence.
use super::apply::{exact_fields, string_field, success};
use crate::lifetime_contract::{Envelope, Response, ResponseStatus, RetryClass};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

pub(super) fn inspect(conn: &Connection, envelope: &Envelope, principal: &str) -> Result<Response> {
    exact_fields(&envelope.body, &["method", "command_id"])?;
    let id = string_field(&envelope.body, "command_id")?;
    let row: Option<(u64, String, String, String)> = conn.query_row(
        "SELECT authority_epoch,payload_digest,response,request FROM lifetime_commands WHERE command_id=?1 AND actor_ref=?2",
        params![id, principal], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional()?;
    let Some((epoch, digest, response, request)) = row else {
        return Ok(Response {
            status: ResponseStatus::Warning,
            summary: "No authoritative command receipt in this generation; outcome remains unresolved".into(),
            object_refs: vec![], artifacts: vec![],
            next_actions: vec!["reconcile_original_owner_and_effect_before_new_intent".into()],
            error_code: Some("not_found".into()), retry_class: RetryClass::ReconcileFirst,
            data: json!({"command_id":id,"found":false}),
        });
    };
    let receipt: Response = serde_json::from_str(&response)?;
    let mut data=json!({"command_id":id,"found":true,"authority_epoch":epoch,"payload_digest":digest,"response":receipt});
    if let Some(request) = serde_json::from_str::<serde_json::Value>(&request).ok()
        .filter(|request|request["body"]["method"].as_str().is_some_and(super::selected_tasks::handles)) {
        let source: Envelope = serde_json::from_value(request)?;
        source.validate()?;
        anyhow::ensure!(source.command_id==id && source.authority_epoch==epoch && source.payload_digest==digest
            && source.actor_ref==principal,"selected-task source command identity changed");
        if let Some(deliveries)=super::selected_tasks::deliveries(conn,&source)? {data["deliveries"]=deliveries;}
    }
    Ok(success(
        "Original command receipt recovered without replaying its effect",
        vec![],
        data,
    ))
}
