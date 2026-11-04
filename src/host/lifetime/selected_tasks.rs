//! Narrow Owner requests to the existing owned Pi transport. No runtime I/O here.
use super::{apply as host_apply, turn_runs};
use crate::lifetime_contract::{Envelope, Response, RetryClass};
use anyhow::{ensure, Result};
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

const INSPECT: &str = "conversation.selected_task.inspect";
const RECONCILE: &str = "conversation.selected_task.reconcile";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) fn handles(method: &str) -> bool { matches!(method, INSPECT | RECONCILE) }

fn bounded(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.trim().is_empty() && s.len() <= 400)
}
fn hex(value: &Value) -> bool {
    value.as_str().is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}
fn operation(value: &Value) -> bool {
    value.as_str().and_then(|s| s.strip_prefix("selected-task:"))
        .is_some_and(|s| hex(&json!(s)))
}
fn safe_integer(value: &Value) -> bool { value.as_u64().is_some_and(|n| n <= MAX_SAFE_INTEGER) }

fn frame(source: &Envelope) -> Result<Value> {
    let body = &source.body;
    let method = host_apply::string_field(body, "method")?;
    let recovery = method == RECONCILE;
    if !handles(method) { return Err(host_apply::invalid("unsupported selected-task operator method")); }
    let mut fields = vec!["method", "ghost_id", "conversation_id", "turn_id"];
    if recovery { fields.push("operation_id"); }
    host_apply::exact_fields(body, &fields)?;
    for name in ["ghost_id", "conversation_id", "turn_id"] {
        if !bounded(&body[name]) { return Err(host_apply::invalid("selected-task identity is missing or exceeds its bound")); }
    }
    let mut receiver = json!({"ghost_id":body["ghost_id"],"conversation_id":body["conversation_id"]});
    if recovery {
        if !operation(&body["operation_id"]) { return Err(host_apply::invalid("original selected-task operation identity is invalid")); }
        receiver["method"] = json!("runtime.reconcile");
        receiver["selected_task_recovery"] = json!({"turn_id":body["turn_id"],"operation_id":body["operation_id"]});
    } else {
        receiver["method"] = json!("conversation.inspect");
        receiver["selected_task_inspection"] = json!({"turn_id":body["turn_id"]});
    }
    Ok(receiver)
}

pub(super) fn apply(conn: &Transaction<'_>, source: &Envelope, principal: &str,
    context: &mut host_apply::ApplyContext) -> Result<Response> {
    if principal != "owner" { return Err(host_apply::reject("unauthorized", "selected-task operator requests require Owner authentication", RetryClass::Never)); }
    let body = frame(source)?;
    turn_runs::selected_task_scope(conn, host_apply::string_field(&source.body,"ghost_id")?,
        host_apply::string_field(&source.body,"conversation_id")?, host_apply::string_field(&source.body,"turn_id")?,
        source.body["method"] == RECONCILE)?;
    let receiver = host_apply::outgoing(source, "owner", None, body)?;
    context.enqueue("pi", receiver.clone());
    Ok(host_apply::success("Selected-task operator request queued; inspect its correlated receiver receipt",
        vec![], json!({"ghost_id":source.body["ghost_id"],"conversation_id":source.body["conversation_id"],
            "turn_id":source.body["turn_id"],"receiver_command_id":receiver["command_id"],
            "receiver_payload_digest":receiver["payload_digest"],"delivery_state":"pending"})))
}

fn target(receiver: &Envelope) -> Result<Option<(&Value, bool)>> {
    let inspection = receiver.body.get("selected_task_inspection");
    let recovery = receiver.body.get("selected_task_recovery");
    if inspection.is_none() && recovery.is_none() { return Ok(None); }
    ensure!(inspection.is_none() || recovery.is_none(), "selected-task receiver has multiple targets");
    let (target, recovering) = match recovery {Some(value)=>(value,true),None=>(inspection.unwrap(),false)};
    host_apply::exact_fields(&receiver.body, &["method","ghost_id","conversation_id",
        if recovering {"selected_task_recovery"} else {"selected_task_inspection"}])?;
    ensure!(receiver.body["method"] == if recovering {"runtime.reconcile"} else {"conversation.inspect"},
        "selected-task receiver method differs from its target");
    host_apply::exact_fields(target, if recovering { &["turn_id","operation_id"] } else { &["turn_id"] })?;
    ensure!(bounded(&target["turn_id"]) && (!recovering || operation(&target["operation_id"])), "selected-task receiver target is invalid");
    Ok(Some((target,recovering)))
}

/// Only an existing immutable Owner outbox row may use this transport path.
pub(crate) fn delivery_allowed(conn: &Connection, receiver: &Envelope) -> Result<Option<bool>> {
    let Some((target,_recovering)) = target(receiver)? else {return Ok(None)};
    receiver.validate()?;
    let source: Option<(String,String)> = conn.query_row(
        "SELECT c.request,o.payload FROM lifetime_outbox o JOIN lifetime_commands c ON c.command_id=o.command_id
         WHERE o.target='pi' AND o.delivery_ref=?1 AND c.actor_ref='owner'", [&receiver.command_id],
        |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((source,stored)) = source else {return Ok(Some(false))};
    let source: Envelope = serde_json::from_str(&source)?;
    source.validate()?;
    let stored: Envelope = serde_json::from_str(&stored)?;
    let authority = super::authority::current(conn)?;
    ensure!(stored == *receiver && source.actor_ref == "owner" && source.authority_epoch == receiver.authority_epoch,
        "selected-task receiver differs from its original Owner command");
    let expected: Envelope = serde_json::from_value(host_apply::outgoing(&source,"owner",None,frame(&source)?)?)?;
    ensure!(expected == *receiver, "selected-task receiver identity changed");
    if !authority.dispatch_enabled || authority.epoch != receiver.authority_epoch {return Ok(Some(false));}
    // This is the exact already-authorized frame, including its receiver ID.
    // After lost ACKs, only Pi can distinguish its immutable prior receipt from
    // fresh recovery. The targeted receiver checks history before all fresh
    // recovery/scheduler actions and independently fences progressed turns.
    let current = turn_runs::selected_task_scope(conn, host_apply::string_field(&receiver.body,"ghost_id")?,
        host_apply::string_field(&receiver.body,"conversation_id")?, host_apply::string_field(target,"turn_id")?, false);
    match current {
        Ok(())=>Ok(Some(true)),
        Err(error) if error.downcast_ref::<host_apply::Rejected>().is_some()=>Ok(Some(false)),
        Err(error)=>Err(error),
    }
}

fn outcome(value: &Value, expected_operation: Option<&Value>) -> Result<()> {
    host_apply::allowed_fields(value, &["state","provenance","operation_id","command_id","body_digest","source_command_id",
        "assignment_id","goal_id","goal_revision","work_id","work_state","response_digest"], &["state"])?;
    let state = host_apply::string_field(value,"state")?;
    ensure!(matches!(state,"blocked"|"unknown"|"admitted"), "selected-task outcome state is invalid");
    if state == "blocked" {host_apply::exact_fields(value,&["state"])?;return Ok(());}
    ensure!(operation(&value["operation_id"]), "selected-task outcome lacks its original operation");
    if let Some(expected)=expected_operation {ensure!(&value["operation_id"]==expected,"selected-task outcome operation mismatch");}
    for name in ["command_id","source_command_id","assignment_id","goal_id","work_id","work_state"] {
        if let Some(v)=value.get(name) {ensure!(bounded(v),"selected-task outcome identity exceeds its bound");}
    }
    for name in ["body_digest","response_digest"] {
        if let Some(v)=value.get(name) {ensure!(hex(v),"selected-task outcome digest is invalid");}
    }
    if state == "unknown" {
        host_apply::exact_fields(value,&["state","operation_id","command_id","body_digest"])?;
        ensure!(bounded(&value["command_id"]) && hex(&value["body_digest"]),"unknown selected-task evidence is incomplete");
    } else {
        ensure!(matches!(value["provenance"].as_str(),Some("runtime_created"|"observed_existing"))
            && bounded(&value["goal_id"]) && bounded(&value["work_id"]) && bounded(&value["work_state"])
            && safe_integer(&value["goal_revision"]) && value["goal_revision"].as_u64()!=Some(0), "admitted selected-task evidence is incomplete");
        if value["provenance"]=="runtime_created" {
            ensure!(["command_id","source_command_id","assignment_id"].iter().all(|n|bounded(&value[*n]))
                && hex(&value["body_digest"]) && hex(&value["response_digest"]), "created selected-task evidence is incomplete");
            ensure!(value["command_id"]==value["source_command_id"],"created selected-task provenance names another source");
        } else if value.get("command_id").is_some() && value.get("source_command_id").is_some() {
            ensure!(value["command_id"]!=value["source_command_id"],"existing selected-task provenance names its own creation command");
        }
    }
    Ok(())
}

fn observation(value: &Value, turn: &Value) -> Result<()> {
    host_apply::allowed_fields(value, &["kind","turn_id","exists","operation_id","command_id","body_digest","dispatch_started",
        "original_task_id","outcome","recoveries"], &["kind","turn_id","exists"])?;
    ensure!(value["kind"]=="ghost.selected-task-admission-observation/1" && &value["turn_id"]==turn,
        "selected-task observation scope mismatch");
    let exists=value["exists"].as_bool().ok_or_else(||host_apply::invalid("selected-task observation existence is invalid"))?;
    if !exists {host_apply::exact_fields(value,&["kind","turn_id","exists"])?;return Ok(());}
    ensure!(operation(&value["operation_id"]) && bounded(&value["command_id"]) && hex(&value["body_digest"])
        && value["dispatch_started"].is_boolean() && value.get("outcome").is_some(), "selected-task observation is incomplete");
    if let Some(id)=value.get("original_task_id") {ensure!(id.is_null() || safe_integer(id),"selected-task task identity is invalid");}
    let validate_linked = |result:&Value| -> Result<()> {
        outcome(result,Some(&value["operation_id"]))?;
        for name in ["command_id","body_digest"] {
            if let Some(actual)=result.get(name) {ensure!(actual==&value[name],"selected-task outcome differs from original intent evidence");}
        }
        Ok(())
    };
    if !value["outcome"].is_null() {validate_linked(&value["outcome"])?;}
    let recoveries=value["recoveries"].as_array().ok_or_else(||host_apply::invalid("selected-task recovery observations are missing"))?;
    ensure!(recoveries.len()<=8,"selected-task recovery observations exceed their bound");
    let mut ids=std::collections::BTreeSet::new();
    for evidence in recoveries {
        host_apply::exact_fields(evidence,&["request_id","started","task_id","outcome"])?;
        ensure!(bounded(&evidence["request_id"]) && ids.insert(evidence["request_id"].as_str().unwrap())
            && evidence["started"].is_boolean() && (evidence["task_id"].is_null() || safe_integer(&evidence["task_id"])),
            "selected-task recovery observation identity is invalid");
        if !evidence["outcome"].is_null() {validate_linked(&evidence["outcome"])?;}
    }
    Ok(())
}

/// Validate before ACK storage and before exposing an immutable receiver result.
/// No raw inspection, arbitrary metadata or transcript fields pass this boundary.
pub(super) fn receiver_evidence(receiver: &Envelope, receipt: &Value) -> Result<Option<Value>> {
    let Some((target,recovering))=target(receiver)? else {return Ok(None)};
    ensure!(serde_json::to_vec(receipt)?.len()<=65_536,"selected-task receiver receipt exceeds its bound");
    let data=&receipt["data"];
    host_apply::exact_fields(data,&["command_id","ghost_id","conversation_id","runtime_kind","runtime_release","storage_ref",
        if recovering {"selected_task_recoveries"} else {"selected_task_inspection"}])?;
    ensure!(receipt["status"]=="success" && data["command_id"]==receiver.command_id
        && data["ghost_id"]==receiver.body["ghost_id"] && data["conversation_id"]==receiver.body["conversation_id"]
        && data["runtime_kind"]=="pi-durable" && data["runtime_release"]=="1.1.0"
        && data["storage_ref"].as_str().is_some_and(|s|!s.is_empty() && s.len()<=4096 && !s.starts_with("unresolved:")),
        "selected-task receiver receipt correlation is invalid");
    if recovering {
        let entries=data["selected_task_recoveries"].as_array().ok_or_else(||host_apply::invalid("selected-task recovery receipt is missing"))?;
        ensure!(entries.len()==1 && entries[0]["turn_id"]==target["turn_id"],"selected-task recovery receipt scope mismatch");
        let mut result=entries[0].clone();result.as_object_mut().ok_or_else(||host_apply::invalid("selected-task recovery result is invalid"))?.remove("turn_id");
        outcome(&result,Some(&target["operation_id"]))?;
    } else {observation(&data["selected_task_inspection"],&target["turn_id"])?;}
    Ok(Some(data.clone()))
}

pub(super) fn deliveries(conn: &Connection, source: &Envelope) -> Result<Option<Value>> {
    if !source.body["method"].as_str().is_some_and(handles) {return Ok(None);}
    let expected:Envelope=serde_json::from_value(host_apply::outgoing(source,"owner",None,frame(source)?)?)?;
    let mut statement=conn.prepare("SELECT o.id,o.payload,o.acknowledged,r.receiver_command_id,r.receipt_digest,r.payload
        FROM lifetime_outbox o LEFT JOIN lifetime_delivery_receipts r ON r.outbox_id=o.id
        WHERE o.command_id=?1 AND o.target='pi' ORDER BY o.id LIMIT 2")?;
    let rows=statement.query_map([&source.command_id],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,
        row.get::<_,bool>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,Option<String>>(4)?,row.get::<_,Option<String>>(5)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(rows.len()<=1,"selected-task Owner command has multiple deliveries");
    let mut projected=Vec::new();
    for (id,raw,acknowledged,receipt_id,digest,payload) in rows {
        let receiver:Envelope=serde_json::from_str(&raw)?;
        ensure!(receiver==expected,"selected-task delivery differs from original Owner request");
        let evidence=if acknowledged {
            use sha2::{Digest,Sha256};
            let raw=payload.ok_or_else(||host_apply::invalid("selected-task delivery ACK has no receipt"))?;
            ensure!(receipt_id.as_deref()==Some(receiver.command_id.as_str())
                && digest.as_deref()==Some(format!("{:x}",Sha256::digest(raw.as_bytes())).as_str()),
                "selected-task delivery receipt identity changed");
            receiver_evidence(&receiver,&serde_json::from_str::<Value>(&raw)?)?
                .ok_or_else(||host_apply::invalid("selected-task delivery receipt has no bounded evidence"))?
        } else {
            ensure!(receipt_id.is_none() && digest.is_none() && payload.is_none(),"pending selected-task delivery has an inconsistent receipt");
            Value::Null
        };
        projected.push(json!({"outbox_id":id,"receiver_command_id":receiver.command_id,
            "receiver_payload_digest":receiver.payload_digest,"delivery_state":if acknowledged {"acknowledged"} else {"pending"},
            "receipt_digest":digest,"receiver_evidence":evidence}));
    }
    Ok(Some(json!(projected)))
}

#[cfg(test)]
#[path = "selected_tasks_tests.rs"]
mod tests;
