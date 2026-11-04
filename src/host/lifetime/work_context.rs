//! Host-sealed clean Pi contexts. Eligibility is created with a new assignment,
//! never inferred from an existing SDK generation or historical execution.
use super::{apply, assignments, db, pi_tools::PiToolRequest};
use crate::lifetime_contract::{canonical_digest, Envelope, Response, Work};
use anyhow::{anyhow, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const CONTEXT: &str = "ghost_work_context_v1";
const CLAIM: &str = "ghost_work_context_claim_v1";
const STORAGE: &str = "ghost_work_context_storage_v1";
const COMPLETION: &str = "ghost_work_context_completion_v1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Context {
    ghost_id: String,
    conversation_id: String,
    assignment_id: String,
    assignment_digest: String,
    work_id: String,
    goal_revision: u64,
    owner_revision: u64,
    authority_epoch: u64,
    execution_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    producer_profile_pin: Option<String>,
    reference: String,
}

impl Context {
    fn profile_scope(&self) -> super::producer_profiles::PinScope {
        super::producer_profiles::PinScope { ghost_id:self.ghost_id.clone(),conversation_id:self.conversation_id.clone(),assignment_id:self.assignment_id.clone(),assignment_digest:self.assignment_digest.clone(),work_id:self.work_id.clone(),goal_revision:self.goal_revision,owner_revision:self.owner_revision,authority_epoch:self.authority_epoch,execution_id:self.execution_id.clone() }
    }

    fn expected_reference(&self) -> Result<String> {
        // The old domain and exact field list deliberately remain unchanged.
        let base=json!(["ghost-work-context/1",self.ghost_id,self.conversation_id,self.assignment_id,self.assignment_digest,self.work_id,self.goal_revision,self.owner_revision,self.authority_epoch,self.execution_id]);
        let identity=match &self.producer_profile_pin { Some(pin)=>json!(["ghost-work-context/2",base,pin]),None=>base };
        Ok(format!("wc-{}",canonical_digest(&identity)?))
    }

    fn producer_profile(&self, conn:&Connection) -> Result<Option<crate::computers::AcceptedProducerProfile>> {
        ensure!(self.reference==self.expected_reference()?,"Pi context reference bytes changed");
        self.producer_profile_pin.as_deref().map(|pin|super::producer_profiles::pinned(conn,pin,&self.profile_scope())).transpose()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Claim {
    generation_task_id: u64,
    provider_session_id: String,
    storage_ref: String,
}

fn load<T: for<'de> Deserialize<'de>>(
    conn: &Connection,
    kind: &str,
    id: &str,
) -> Result<Option<T>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
            params![kind, id],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .transpose()
}

fn immutable(conn: &Connection, kind: &str, id: &str, value: &impl Serialize) -> Result<()> {
    let raw = serde_json::to_string(value)?;
    conn.execute(
        "INSERT OR IGNORE INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3)",
        params![kind, id, raw],
    )?;
    let prior: String = conn.query_row(
        "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
        params![kind, id],
        |r| r.get(0),
    )?;
    ensure!(prior == raw, "Pi context immutable identity conflict");
    Ok(())
}

fn execution_id(ghost: &str, work: &Work, assignment: &str) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!([
            "ghost-pi/1",
            ghost,
            work.id,
            work.goal_revision,
            assignment
        ]))?)
    ))
}

/// Called only inside the original outbox insertion transaction. Historical
/// assignments are deliberately never backfilled by inspection or a claim.
pub(super) fn admitted(conn: &Connection, receiver: &Value) -> Result<()> {
    if receiver["body"]["method"] != "conversation.assignment" {
        return Ok(());
    }
    let receiver: Envelope = serde_json::from_value(receiver.clone())?;
    receiver.validate()?;
    let body = &receiver.body;
    let work = db::work(conn, apply::string_field(body, "work_id")?)?
        .ok_or_else(|| anyhow!("Pi context Work missing"))?;
    ensure!(
        work.owner == apply::string_field(body, "ghost_id")?,
        "Pi context owner differs from assignment"
    );
    if work.execution_id.is_some() {
        return Ok(());
    }
    let prior:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.work_id')=?2 AND json_extract(payload,'$.goal_revision')=?3 AND json_extract(payload,'$.owner_revision')=?4)",params![CONTEXT,work.id,work.goal_revision,work.owner_revision],|r|r.get(0))?;
    if prior {
        return Ok(());
    }
    let digest = canonical_digest(&serde_json::to_value(&receiver)?)?;
    let execution = execution_id(&work.owner, &work, &receiver.command_id)?;
    let mut context = Context {
        ghost_id: work.owner.clone(),
        conversation_id: apply::string_field(body, "conversation_id")?.into(),
        assignment_id: receiver.command_id.clone(),
        assignment_digest: digest,
        work_id: work.id.clone(),
        goal_revision: work.goal_revision,
        owner_revision: work.owner_revision,
        authority_epoch: receiver.authority_epoch,
        execution_id: execution,
        producer_profile_pin: None,
        reference: String::new(),
    };
    context.producer_profile_pin=super::producer_profiles::admit(conn,&context.profile_scope())?;
    context.reference=context.expected_reference()?;
    immutable(conn, CONTEXT, &receiver.command_id, &context)
}

fn current(conn: &Connection, context: &Context, request: &PiToolRequest) -> Result<Work> {
    context.producer_profile(conn)?;
    ensure!(
        context.ghost_id == request.ghost_id && context.conversation_id == request.conversation_id,
        "Pi context canonical audience mismatch"
    );
    ensure!(
        context.authority_epoch == request.envelope.authority_epoch
            && super::authority::current(conn)?.epoch == context.authority_epoch,
        "Pi context epoch is no longer current"
    );
    let raw: String = conn.query_row(
        "SELECT payload FROM lifetime_outbox WHERE target='pi' AND delivery_ref=?1",
        [&context.assignment_id],
        |r| r.get(0),
    )?;
    let receiver: Envelope = serde_json::from_str(&raw)?;
    ensure!(
        canonical_digest(&serde_json::to_value(&receiver)?)? == context.assignment_digest,
        "Pi context assignment bytes changed"
    );
    let mut inspected = request.envelope.clone();
    inspected.body = json!({"method":"conversation.assignment.inspect","assignment_id":context.assignment_id,"ghost_id":request.ghost_id,"conversation_id":request.conversation_id});
    inspected.payload_digest = canonical_digest(&inspected.body)?;
    let work =
        db::work(conn, &context.work_id)?.ok_or_else(|| anyhow!("Pi context Work missing"))?;
    ensure!(
        work.owner == context.ghost_id
            && work.goal_revision == context.goal_revision
            && work.owner_revision == context.owner_revision,
        "Pi context Work revision changed"
    );
    ensure!(work.cancellation == "none", "Pi context Work cancelled");
    if matches!(work.state.as_str(), "queued" | "running" | "blocked") {
        assignments::inspect(conn, &inspected, &request.ghost_id)?;
    } else {
        let goal =
            db::goal(conn, &work.goal_id)?.ok_or_else(|| anyhow!("Pi context Goal missing"))?;
        ensure!(
            goal.revision == context.goal_revision
                && goal.accountable_ghost == context.ghost_id
                && goal.reply_conversation == context.conversation_id
                && super::graph::current_result_scope(conn, &work)?,
            "Pi context terminal scope changed"
        );
        ensure!(
            replay_only(conn, context, request)?,
            "Terminal Pi context permits only exact original receipt recovery"
        );
    }
    ensure!(
        work.execution_id
            .as_ref()
            .is_none_or(|id| id == &context.execution_id),
        "Pi context execution lineage changed"
    );
    Ok(work)
}

pub(super) fn view(conn: &Connection, assignment: &str) -> Result<Option<Value>> {
    let Some(c)=load::<Context>(conn,CONTEXT,assignment)? else {return Ok(None)};
    c.producer_profile(conn)?;
    Ok(Some(json!({"kind":"ghost-work-context/1","ref":c.reference,"assignment_id":c.assignment_id,"work_id":c.work_id,"goal_revision":c.goal_revision,"owner_revision":c.owner_revision,"authority_epoch":c.authority_epoch})))
}

fn for_work(conn:&Connection,work:&Work)->Result<Option<Context>> {
    let mut query=conn.prepare("SELECT payload FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.work_id')=?2 AND json_extract(payload,'$.goal_revision')=?3 AND json_extract(payload,'$.owner_revision')=?4")?;
    let rows=query.query_map(params![CONTEXT,work.id,work.goal_revision,work.owner_revision],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(rows.len()<=1,"Pi Work has conflicting clean contexts");
    rows.first().map(|raw|Ok(serde_json::from_str(raw)?)).transpose()
}

pub(crate) fn producer_profile(conn:&Connection,work:&Work)->Result<Option<crate::computers::AcceptedProducerProfile>> {
    // Historical shared-history callers never inherit the current route's
    // selected profile. Only an original clean assignment can carry a pin.
    if let Some(context)=for_work(conn,work)? {
        let profile=context.producer_profile(conn)?;
        if profile.is_some() {
            if let Some(execution)=work.execution_id.as_deref() {super::producer_profiles::execution_binding(conn,execution,&context.profile_scope(),context.producer_profile_pin.as_deref(),false)?;}
        }
        return Ok(profile);
    }
    let required:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM workspace_objects WHERE kind IN ('pi_producer_profile_pin_v1','pi_execution_profile_binding_v1') AND json_extract(payload,'$.scope.work_id')=?1 AND json_extract(payload,'$.scope.goal_revision')=?2 AND json_extract(payload,'$.scope.owner_revision')=?3)",params![work.id,work.goal_revision,work.owner_revision],|r|r.get(0))?;
    ensure!(!required,"Required producer context missing");
    Ok(None)
}

pub(super) fn execution_profile_binding(conn:&Connection,work:&Work,assignment:&str,execution:&str,create:bool)->Result<()> {
    if let Some(context)=for_work(conn,work)? {
        context.producer_profile(conn)?;
        ensure!(context.assignment_id==assignment && context.execution_id==execution && context.ghost_id==work.owner,"Pi execution profile scope mismatch");
        super::producer_profiles::execution_binding(conn,execution,&context.profile_scope(),context.producer_profile_pin.as_deref(),create)?;
    } else {
        let required:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM workspace_objects WHERE kind IN ('pi_producer_profile_pin_v1','pi_execution_profile_binding_v1') AND json_extract(payload,'$.scope.work_id')=?1 AND json_extract(payload,'$.scope.goal_revision')=?2 AND json_extract(payload,'$.scope.owner_revision')=?3)",params![work.id,work.goal_revision,work.owner_revision],|r|r.get(0))?;
        ensure!(!required,"Required producer context missing");
    }
    Ok(())
}

pub(crate) fn is_claimed(conn: &Connection, work: &Work) -> Result<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM workspace_objects c JOIN workspace_objects x ON x.kind=?5 AND x.id=json_extract(c.payload,'$.reference') WHERE c.kind=?1 AND json_extract(c.payload,'$.work_id')=?2 AND json_extract(c.payload,'$.goal_revision')=?3 AND json_extract(c.payload,'$.owner_revision')=?4)",params![CONTEXT,work.id,work.goal_revision,work.owner_revision,CLAIM],|r|r.get(0))?)
}

/// Nonrecursive evidence that this exact Work already owns a current SDK
/// generation. It grants no tool/memory authority and never calls assignment
/// inspection (which itself checks bot lifecycle). Restored or reassigned claims
/// cannot turn into a new admission merely because historical rows exist.
pub(crate) fn has_current_claim(conn:&Connection,work:&Work)->Result<bool> {
    let authority=super::authority::current(conn)?;
    if !authority.dispatch_enabled || work.cancellation!="none" {return Ok(false);}
    let mut query=conn.prepare("SELECT c.payload,x.payload FROM workspace_objects c JOIN workspace_objects x ON x.kind=?1 AND x.id=json_extract(c.payload,'$.reference') WHERE c.kind=?2 AND json_extract(c.payload,'$.work_id')=?3 AND json_extract(c.payload,'$.ghost_id')=?4 AND json_extract(c.payload,'$.goal_revision')=?5 AND json_extract(c.payload,'$.owner_revision')=?6 AND json_extract(c.payload,'$.authority_epoch')=?7")?;
    let rows=query.query_map(params![CLAIM,CONTEXT,work.id,work.owner,work.goal_revision,work.owner_revision,authority.epoch],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let [(context,claim)]=rows.as_slice() else{return Ok(false)};
    let context:Context=serde_json::from_str(context)?;let claim:Claim=serde_json::from_str(claim)?;
    context.producer_profile(conn)?;
    let Some(goal)=db::goal(conn,&work.goal_id)? else{return Ok(false)};
    if goal.revision!=context.goal_revision || goal.accountable_ghost!=context.ghost_id || goal.reply_conversation!=context.conversation_id || goal.state!="open" {return Ok(false);}
    let raw:Option<String>=conn.query_row("SELECT payload FROM lifetime_outbox WHERE target='pi' AND delivery_ref=?1",[&context.assignment_id],|r|r.get(0)).optional()?;
    let Some(raw)=raw else{return Ok(false)};let receiver:Envelope=serde_json::from_str(&raw)?;
    if receiver.validate().is_err() || receiver.command_id!=context.assignment_id || receiver.authority_epoch!=authority.epoch || receiver.expected_revision!=Some(context.goal_revision)
        || receiver.body["work_id"]!=work.id || receiver.body["ghost_id"]!=work.owner || receiver.body["conversation_id"]!=context.conversation_id
        || canonical_digest(&serde_json::to_value(&receiver)?)?!=context.assignment_digest
        || context.execution_id!=execution_id(&work.owner,work,&context.assignment_id)? {return Ok(false);}
    // The SDK's admitted storage receipt seals the otherwise model-independent
    // claim coordinates; an unacknowledged/manual claim alone is insufficient.
    let storage=load::<String>(conn,STORAGE,&context.reference)?;
    Ok(storage.as_deref()==Some(claim.storage_ref.as_str()) && claim.generation_task_id>0
        && claim.generation_task_id<=9_007_199_254_740_991 && uuid::Uuid::parse_str(&claim.provider_session_id).is_ok())
}

/// Verify outer trusted context before any cache replay or shared-history
/// exemption. A clean reference cannot be attached to an unclaimed generation.
pub(crate) fn validate(conn: &Connection, request: &PiToolRequest) -> Result<Option<Work>> {
    let Some(reference) = &request.context_ref else {
        let body = &request.envelope.body;
        if matches!(
            body["method"].as_str(),
            Some(
                "work.execute"
                    | "work.execution.complete"
                    | "work.context.claim"
                    | "inference.inspect"
            )
        ) || (body["method"] == "work.wait" && body.get("generation_task_id").is_some())
        {
            if let Some(id) = body
                .get("work_id")
                .or_else(|| body.get("parent_work_id"))
                .and_then(Value::as_str)
            {
                if let Some(work) = db::work(conn, id)? {
                    ensure!(producer_profile(conn,&work)?.is_none(),"Pinned producer Work requires its original outer context reference");
                    ensure!(
                        !is_claimed(conn, &work)?,
                        "Claimed Pi Work requires its original outer context reference"
                    );
                }
            }
        }
        return Ok(None);
    };
    ensure!(
        reference.starts_with("wc-") && reference.len() == 67,
        "Pi context reference malformed"
    );
    let raw:Option<String>=conn.query_row("SELECT payload FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.reference')=?2",params![CONTEXT,reference],|r|r.get(0)).optional()?;
    let context: Context =
        serde_json::from_str(&raw.ok_or_else(|| anyhow!("Pi context reference not admitted"))?)?;
    let work = current(conn, &context, request)?;
    let body = &request.envelope.body;
    let method = apply::string_field(body, "method")?;
    let paired = matches!(
        method,
        "inference.inspect"
            | "inference.settings"
            | "work.context.claim"
            | "work.execute"
            | "work.execution.complete"
            | "work.memory.context.inspect"
            | "work.memory.recall"
            | "work.memory.record"
            | "memory.publication.capabilities"
            | "memory.publication.context.inspect"
            | "memory.publication.read"
    );
    if paired {
        ensure!(
            body["assignment_id"].as_str() == Some(&context.assignment_id)
                && body["work_id"].as_str() == Some(&work.id),
            "Isolated Pi callback requires its exact assignment and Work pair"
        );
    } else {
        match method {
            "conversation.assignment.inspect" => ensure!(
                body["assignment_id"].as_str() == Some(&context.assignment_id),
                "Isolated Pi inspection requires its original assignment"
            ),
            "work.inspect" | "work.children" | "work.pi.admit" | "work.wait"
            | "work.wait.inspect" => ensure!(
                body["work_id"].as_str() == Some(&work.id),
                "Isolated Pi callback requires its original Work"
            ),
            "work.delegate" => ensure!(
                body["parent_work_id"].as_str() == Some(&work.id),
                "Isolated Pi delegation requires its original parent Work"
            ),
            "goal.inspect" => ensure!(
                body["goal_id"].as_str() == Some(&work.goal_id),
                "Isolated Pi inspection requires its original Goal"
            ),
            "registry.inspect" => {}
            _ => {
                return Err(anyhow!(
                    "Owner, report and unrelated callbacks cannot use an isolated Work context"
                ))
            }
        }
    }
    for field in ["work_id", "parent_work_id"] {
        if let Some(id) = body.get(field) {
            ensure!(
                id.as_str() == Some(&work.id),
                "Pi context Work selector mismatch"
            );
        }
    }
    if let Some(id) = body.get("assignment_id") {
        ensure!(
            id.as_str() == Some(&context.assignment_id),
            "Pi context assignment mismatch"
        );
    }
    if let Some(id) = body.get("goal_id") {
        ensure!(
            id.as_str() == Some(&work.goal_id),
            "Pi context Goal selector mismatch"
        );
    }
    if body["method"] == "work.context.claim" {
        ensure!(
            body["context_ref"].as_str() == Some(reference),
            "Pi claim outer reference mismatch"
        );
        return Ok(Some(work));
    }
    let claim = load::<Claim>(conn, CLAIM, reference)?
        .ok_or_else(|| anyhow!("Pi context has no durable generation claim"))?;
    if let Some(generation) = body.get("generation_task_id") {
        ensure!(
            generation.as_u64() == Some(claim.generation_task_id),
            "Pi context generation mismatch"
        );
    }
    if body["method"] == "work.execution.complete" {
        ensure!(
            body["task_id"].as_u64() == Some(claim.generation_task_id),
            "Pi context completion generation mismatch"
        );
    }
    if let Some(execution) = &work.execution_id {
        let matches:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_pi_executions WHERE work_id=?1 AND execution_id=?2 AND assignment_id=?3 AND generation_task_id=?4 AND authority_epoch=?5)",params![work.id,execution,context.assignment_id,claim.generation_task_id,context.authority_epoch],|r|r.get(0))?;
        ensure!(
            matches,
            "Pi context original execution is no longer current"
        );
        execution_profile_binding(conn,&work,&context.assignment_id,execution,false)?;
    }
    Ok(Some(work))
}

pub(super) fn claim(conn: &Connection, request: &PiToolRequest) -> Result<Response> {
    let body = &request.envelope.body;
    apply::exact_fields(
        body,
        &[
            "method",
            "assignment_id",
            "work_id",
            "context_ref",
            "generation_task_id",
            "provider_session_id",
            "storage_ref",
        ],
    )?;
    let reference = request
        .context_ref
        .as_deref()
        .ok_or_else(|| anyhow!("Pi context claim requires outer reference"))?;
    let work = validate(conn, request)?.ok_or_else(|| anyhow!("Pi context claim missing"))?;
    let generation = apply::number_field(body, "generation_task_id")?;
    ensure!(
        generation > 0 && generation <= 9_007_199_254_740_991,
        "Pi context generation invalid"
    );
    let provider = apply::string_field(body, "provider_session_id")?;
    uuid::Uuid::parse_str(provider)?;
    let storage = apply::string_field(body, "storage_ref")?;
    ensure!(
        !storage.is_empty()
            && storage.len() <= 1024
            && !storage.starts_with('/')
            && !storage.contains('\\')
            && !storage
                .split('/')
                .any(|v| v.is_empty() || matches!(v, "." | ".."))
            && !storage.contains(':'),
        "Pi context storage locator invalid"
    );
    let claim = Claim {
        generation_task_id: generation,
        provider_session_id: provider.into(),
        storage_ref: storage.into(),
    };
    let tx = conn.unchecked_transaction()?;
    if let Some(prior) = load::<String>(&tx, STORAGE, reference)? {
        ensure!(
            prior == storage,
            "Pi context storage differs from admitted receipt"
        );
    }
    if load::<Claim>(&tx, CLAIM, reference)?.is_none() {
        ensure!(
            work.execution_id.is_none(),
            "Existing execution cannot be relabeled as a clean Pi context"
        );
    }
    let collision:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM workspace_objects WHERE kind=?1 AND id<>?2 AND (json_extract(payload,'$.provider_session_id')=?3 OR json_extract(payload,'$.storage_ref')=?4))",params![CLAIM,reference,provider,storage],|r|r.get(0))?;
    ensure!(
        !collision,
        "Different Pi Works cannot share provider or storage context"
    );
    immutable(&tx, CLAIM, reference, &claim)?;
    tx.commit()?;
    Ok(apply::success(
        "Original clean Pi context generation bound",
        vec![],
        json!({"context_ref":reference,"assignment_id":body["assignment_id"],"work_id":work.id,"generation_task_id":generation,"provider_session_id":provider,"storage_ref":storage,"authority_epoch":request.envelope.authority_epoch}),
    ))
}

/// A Work-store ACK is not the canonical Owner conversation storage binding.
pub(super) fn ack(conn: &Connection, command: &Envelope, data: &Value) -> Result<bool> {
    let admitted = load::<Context>(conn, CONTEXT, &command.command_id)?;
    let Some(reference) = data.get("context_ref") else {
        ensure!(
            admitted.is_none(),
            "New Pi Work assignment ACK requires its sealed context reference"
        );
        return Ok(false);
    };
    ensure!(
        command.body["method"] == "conversation.assignment",
        "Only a Work assignment may acknowledge an isolated context"
    );
    let context =
        admitted.ok_or_else(|| anyhow!("Historical assignment has no clean Pi context"))?;
    ensure!(
        reference.as_str() == Some(&context.reference)
            && canonical_digest(&serde_json::to_value(command)?)? == context.assignment_digest
            && command.authority_epoch == context.authority_epoch
            && super::authority::current(conn)?.epoch == context.authority_epoch,
        "Pi context ACK identity or epoch mismatch"
    );
    let storage = apply::string_field(data, "storage_ref")?;
    if let Some(claim) = load::<Claim>(conn, CLAIM, &context.reference)? {
        ensure!(
            claim.storage_ref == storage,
            "Pi context ACK differs from original generation store"
        );
    }
    immutable(conn, STORAGE, &context.reference, &storage)?;
    Ok(true)
}

fn replay_only(conn: &Connection, context: &Context, request: &PiToolRequest) -> Result<bool> {
    let body = &request.envelope.body;
    Ok(match body["method"].as_str() {
        Some("work.context.claim") => {
            load::<Claim>(conn, CLAIM, &context.reference)?.is_some_and(|c| {
                body["generation_task_id"] == c.generation_task_id
                    && body["provider_session_id"] == c.provider_session_id
                    && body["storage_ref"] == c.storage_ref
            })
        }
        Some("work.execution.complete") => load::<Value>(conn, COMPLETION, &context.reference)?
            .is_some_and(|r| r["input_digest"] == canonical_digest(body).unwrap_or_default()),
        Some("work.execute") => cached_effect(conn, request)?.is_some(),
        Some("conversation.assignment.inspect") => {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT request FROM lifetime_commands WHERE command_id=?1",
                    [&request.envelope.command_id],
                    |r| r.get(0),
                )
                .optional()?;
            raw.map(|raw| serde_json::from_str::<Envelope>(&raw).map(|e| e == request.envelope))
                .transpose()?
                .unwrap_or(false)
        }
        _ => false,
    })
}

pub(super) fn cached_effect(
    conn: &Connection,
    request: &PiToolRequest,
) -> Result<Option<Response>> {
    let body = &request.envelope.body;
    if body["method"] != "work.execute" {
        return Ok(None);
    }
    let digest =
        canonical_digest(&json!({"operation":body["operation"],"arguments":body["arguments"]}))?;
    ensure!(
        body["input_digest"] == digest,
        "Pi replay input digest mismatch"
    );
    let raw:Option<String>=conn.query_row("SELECT e.response_json FROM lifetime_pi_effects e JOIN lifetime_pi_executions x ON x.execution_id=e.execution_id WHERE x.work_id=?1 AND x.assignment_id=?2 AND x.generation_task_id=?3 AND e.task_id=?4 AND e.call_id=?5 AND e.input_digest=?6 AND e.state IN ('complete','unknown')",params![body["work_id"].as_str(),body["assignment_id"].as_str(),body["generation_task_id"].as_u64(),body["task_id"].as_u64(),body["call_id"].as_str(),digest],|r|r.get(0)).optional()?.flatten();
    raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .transpose()
}

/// Persist the exact completion intent before result projection. A crash after
/// result commit can finish the same receipt; it cannot authorize a new effect.
pub(super) fn completion(
    conn: &Connection,
    request: &PiToolRequest,
    response: Option<&Response>,
) -> Result<Option<Response>> {
    let Some(reference) = request.context_ref.as_deref() else {
        return Ok(None);
    };
    let digest = canonical_digest(&request.envelope.body)?;
    conn.execute(
        "INSERT OR IGNORE INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3)",
        params![
            COMPLETION,
            reference,
            serde_json::to_string(&json!({"input_digest":digest,"response":null}))?
        ],
    )?;
    let prior: Value = load(conn, COMPLETION, reference)?.unwrap();
    ensure!(
        prior["input_digest"] == digest,
        "Pi completion original input changed"
    );
    if let Some(response) = response {
        if prior["response"].is_null() {
            conn.execute(
                "UPDATE workspace_objects SET payload=?1 WHERE kind=?2 AND id=?3 AND payload=?4",
                params![
                    serde_json::to_string(&json!({"input_digest":digest,"response":response}))?,
                    COMPLETION,
                    reference,
                    serde_json::to_string(&prior)?
                ],
            )?;
        } else {
            ensure!(
                prior["response"] == serde_json::to_value(response)?,
                "Pi completion receipt changed"
            );
        }
    }
    if prior["response"].is_null() {
        Ok(None)
    } else {
        Ok(Some(serde_json::from_value(prior["response"].clone())?))
    }
}

#[cfg(test)]
#[path = "work_context_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "producer_profile_tests.rs"]
mod producer_profile_tests;
