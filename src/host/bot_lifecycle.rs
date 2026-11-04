//! Owner-bound definition replacement, cloning and scheduling lifecycle. These
//! states never erase identities, Work pins, results, memory or credentials.
use super::{bots::BotDefinition, bots_provisioning as provisioning, bots_store};
use crate::lifetime_contract::{
    canonical_digest, Envelope, Response, ResponseStatus, RetryClass, Work,
};
use anyhow::{anyhow, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
const STATES: &str = "bot_lifecycle_v1";
const CONTROLS: &str = "bot_control_intent_v1";
const TARGETS: &str = "bot_candidate_target_v1";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    ghost_id: String,
    revision: u64,
    mode: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Control {
    request_id: String,
    payload_digest: String,
    epoch: u64,
    candidate_id: String,
    candidate_digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Target {
    pub mode: String,
    pub source_ghost: String,
    pub source_revision: u64,
    pub source_digest: String,
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
    raw.map(|r| serde_json::from_str(&r).map_err(Into::into))
        .transpose()
}
fn save<T: Serialize>(conn: &Connection, kind: &str, id: &str, value: &T) -> Result<()> {
    conn.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",params![kind,id,serde_json::to_string(value)?])?;
    Ok(())
}
fn exact(body: &Value, fields: &[&str]) -> Result<()> {
    let value = body
        .as_object()
        .ok_or_else(|| anyhow!("bot lifecycle body must be an object"))?;
    ensure!(
        value.len() == fields.len() && fields.iter().all(|f| value.contains_key(*f)),
        "unexpected bot lifecycle fields"
    );
    Ok(())
}
fn text<'a>(body: &'a Value, key: &str) -> Result<&'a str> {
    body[key]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 32768)
        .ok_or_else(|| anyhow!("missing bounded lifecycle {key}"))
}
fn owner(e: &Envelope, principal: &str) -> Result<()> {
    ensure!(
        principal == "owner" && e.actor_ref == "owner",
        "bot lifecycle requires authenticated Owner"
    );
    Ok(())
}
fn success(summary: &str, data: Value) -> Response {
    Response {
        status: ResponseStatus::Success,
        summary: summary.into(),
        object_refs: vec![],
        artifacts: vec![],
        next_actions: vec![],
        error_code: None,
        retry_class: RetryClass::SameId,
        data,
    }
}
fn conflict(code: &str, summary: &str, retry_class: RetryClass) -> Response {
    Response {
        status: ResponseStatus::Error,
        summary: summary.into(),
        object_refs: vec![],
        artifacts: vec![],
        next_actions: vec![],
        error_code: Some(code.into()),
        retry_class,
        data: json!({"host_effect_class":"no_effect"}),
    }
}
pub(crate) fn mode(conn: &Connection, ghost: &str) -> Result<String> {
    let Some(value) = load::<State>(conn, STATES, ghost)? else {
        return Ok("active".into());
    };
    ensure!(
        value.ghost_id == ghost
            && value.revision > 0
            && matches!(value.mode.as_str(), "active" | "paused" | "retired"),
        "invalid bot lifecycle state"
    );
    Ok(value.mode)
}
// Accepted immutable evaluation is historical evidence. Current execution
// epoch/home authority is checked by Host NativeComputers and every callback.
fn evaluated_definition(conn: &Connection, ghost: &str, digest: &str) -> Result<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM workspace_objects c JOIN workspace_objects p ON p.kind='bot_provisioning_v1' AND p.id=c.id WHERE c.kind='bot_candidate_v1' AND json_extract(c.payload,'$.definition.ghost_id')=?1 AND json_extract(c.payload,'$.definition.digest')=?2 AND json_extract(p.payload,'$.state')='ready' AND EXISTS(SELECT 1 FROM lifetime_verification_policy v WHERE v.singleton=1 AND v.verifier_revision=json_extract(c.payload,'$.verifier_revision') AND v.policy_revision=json_extract(c.payload,'$.policy_revision')))",params![ghost,digest],|r|r.get(0)).map_err(Into::into)
}
fn managed(conn: &Connection, ghost: &str) -> Result<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM workspace_objects WHERE kind='bot_candidate_v1' AND json_extract(payload,'$.definition.ghost_id')=?1)",[ghost],|r|r.get(0)).map_err(Into::into)
}
pub(crate) fn admission_allowed(conn: &Connection, ghost: &str) -> Result<bool> {
    if mode(conn, ghost)? != "active" {
        return Ok(false);
    }
    if !managed(conn, ghost)? {
        return Ok(true);
    }
    let Some(d) = bots_store::active_definition(conn, ghost)? else {
        return Ok(false);
    };
    if super::shared_skills::definition_current(conn,&d).is_err(){return Ok(false);}
    Ok(evaluated_definition(conn,ghost,&d.digest)? && super::bots_memory::definition_current(conn,&d)?)
}
pub(crate) fn work_may_start(conn: &Connection, work: &Work) -> Result<bool> {
    if work.execution_id.is_some() {
        return Ok(true);
    }
    let claimed=super::lifetime::work_context::has_current_claim(conn,work)?;
    if !claimed && mode(conn, &work.owner)? != "active" {
        return Ok(false);
    }
    if !managed(conn, &work.owner)? {
        return Ok(true);
    }
    let Some(d) = bots_store::definition_for_work(conn, work)? else {
        return Ok(false);
    };
    if super::shared_skills::work_current(conn,work).is_err(){return Ok(false);}
    Ok(evaluated_definition(conn,&work.owner,&d.digest)? && if claimed {
        super::bots_memory::definition_authority_current(conn,&d)?
    } else {
        super::bots_memory::definition_current(conn,&d)?
    })
}
pub(crate) fn apply_owner(conn: &Connection, e: &Envelope, principal: &str) -> Result<Response> {
    owner(e, principal)?;
    let method = text(&e.body, "method")?;
    match method {
        "bot.lifecycle.inspect" => {
            exact(&e.body, &["method", "ghost_id"])?;
            let ghost = text(&e.body, "ghost_id")?;
            let state = load::<State>(conn, STATES, ghost)?;
            Ok(success(
                "Bot lifecycle inspected",
                json!({"ghost_id":ghost,"mode":mode(conn,ghost)?,"revision":state.as_ref().map(|s|s.revision).unwrap_or(0),"expected_revision":state.as_ref().map(|s|s.revision),"admission_allowed":admission_allowed(conn,ghost)?,"definition":bots_store::active_definition(conn,ghost)?,"history_preserved":true}),
            ))
        }
        "bot.lifecycle.set" => {
            exact(&e.body, &["method", "ghost_id", "mode"])?;
            let ghost = text(&e.body, "ghost_id")?;
            let next = text(&e.body, "mode")?;
            ensure!(
                matches!(next, "active" | "paused" | "retired"),
                "unsupported bot lifecycle mode"
            );
            let registered: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM lifetime_registry WHERE ghost_id=?1)",
                [ghost],
                |r| r.get(0),
            )?;
            ensure!(registered, "bot identity is not registered");
            let old = load::<State>(conn, STATES, ghost)?;
            if old.as_ref().map(|v| v.revision) != e.expected_revision {
                return Ok(conflict(
                    "conflict",
                    "bot lifecycle revision changed",
                    RetryClass::NewRevision,
                ));
            }
            if old
                .as_ref()
                .is_some_and(|v| v.mode == "retired" && next != "retired")
            {
                return Ok(conflict(
                    "bot_retired",
                    "retired bots cannot resume through an ordinary mode toggle",
                    RetryClass::Never,
                ));
            }
            let value = State {
                ghost_id: ghost.into(),
                revision: old
                    .map(|v| {
                        v.revision
                            .checked_add(1)
                            .ok_or_else(|| anyhow!("lifecycle revision exhausted"))
                    })
                    .transpose()?
                    .unwrap_or(1),
                mode: next.into(),
            };
            save(conn, STATES, ghost, &value)?;
            Ok(success(
                "Bot lifecycle changed; existing bound Work and history are preserved",
                json!({"ghost_id":ghost,"mode":value.mode,"revision":value.revision,"history_preserved":true,"running_work_cancelled":false}),
            ))
        }
        _ => Err(anyhow!("unsupported bot lifecycle method")),
    }
}
pub(crate) fn target(conn: &Connection, candidate: &str) -> Result<Option<Target>> {
    load(conn, TARGETS, candidate)
}
pub(crate) fn control_request(conn: &Connection, candidate: &str) -> Result<Option<String>> {
    let mut q=conn.prepare("SELECT id FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.candidate_id')=?2 LIMIT 2")?;
    let ids = q
        .query_map(params![CONTROLS, candidate], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(ids.len() <= 1, "ambiguous bot control request");
    Ok(ids.into_iter().next())
}
fn evaluated_source(conn: &Connection, definition: &BotDefinition) -> Result<provisioning::Candidate> {
    let raw:String=conn.query_row("SELECT c.payload FROM workspace_objects c JOIN workspace_objects p ON p.kind='bot_provisioning_v1' AND p.id=c.id WHERE c.kind='bot_candidate_v1' AND json_extract(c.payload,'$.definition.ghost_id')=?1 AND json_extract(c.payload,'$.definition.digest')=?2 AND json_extract(p.payload,'$.state')='ready'",params![definition.ghost_id,definition.digest],|r|r.get(0))?;
    let candidate: provisioning::Candidate = serde_json::from_str(&raw)?;
    candidate.validate()?;
    Ok(candidate)
}
fn selected_memory(
    conn: &Connection,
    ghost: &str,
    value: &Value,
) -> Result<(super::bots::RevisionRef, super::work_memory::Profile)> {
    let pin: super::bots::RevisionRef = serde_json::from_value(value.clone())?;
    let profile = super::work_memory::resolve_definition_profile(conn, ghost, &pin)?;
    Ok((pin, profile))
}
fn memory_privacy(source: &str, profile: &super::work_memory::Profile) -> String {
    if source == "public" && (profile.required || profile.profile.is_some()) {
        "private".into()
    } else {
        source.into()
    }
}
fn validate_control_source(
    conn: &Connection,
    original: &Envelope,
    control: &Control,
) -> Result<()> {
    original.validate()?;
    ensure!(
        original.actor_ref == "owner"
            && original.command_id == control.request_id
            && original.payload_digest == control.payload_digest
            && original.authority_epoch == control.epoch,
        "lifecycle control source changed"
    );
    let update = match original.body["method"].as_str() {
        Some("bot.update.prepare") => true,
        Some("bot.clone.prepare") => false,
        _ => return Err(anyhow!("lifecycle control source method changed")),
    };
    let candidate = provisioning::candidate(conn, &control.candidate_id)?;
    let target = target(conn, &candidate.id)?
        .ok_or_else(|| anyhow!("lifecycle candidate target missing"))?;
    let pointer: bots_store::DefinitionPointer =
        serde_json::from_value(original.body["definition_ref"].clone())?;
    let derived_id = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("ghost-bot-control/1:{}", original.command_id).as_bytes(),
    )
    .to_string();
    ensure!(
        candidate.id == derived_id
            && candidate.digest == control.candidate_digest
            && candidate.request_ref == original.command_id
            && candidate.intent_turn_id.is_none()
            && candidate.issuer_ghost.is_none(),
        "lifecycle candidate differs from its Owner request"
    );
    ensure!(
        target.mode == if update { "update" } else { "clone" }
            && original.body["ghost_id"] == target.source_ghost
            && pointer.ghost_id == target.source_ghost
            && pointer.revision == target.source_revision
            && pointer.digest == target.source_digest,
        "lifecycle target differs from its immutable Owner source reference"
    );
    let source = bots_store::definition(conn, &pointer.ghost_id, pointer.revision)?
        .ok_or_else(|| anyhow!("lifecycle source definition missing"))?;
    ensure!(
        source.digest == pointer.digest,
        "lifecycle source definition digest changed"
    );
    let prior_source=evaluated_source(conn,&source)?;
    ensure!(candidate.source_contract_ref==prior_source.source_contract_ref
        && candidate.source_contract==prior_source.source_contract,
        "lifecycle candidate changed original source-contract provenance");
    let expected_inputs=if prior_source.evaluation_inputs.is_some() {Some(super::lifetime::evaluation_inputs::pin(&candidate.evaluation_profile)?)}else{None};
    ensure!(candidate.evaluation_inputs==expected_inputs,"lifecycle candidate changed evaluation input transport");
    let ghost = if update {
        pointer.ghost_id.clone()
    } else {
        uuid::Uuid::new_v5(
            &uuid::Uuid::NAMESPACE_URL,
            format!("ghost-bot-identity/1:{}", candidate.id).as_bytes(),
        )
        .to_string()
    };
    ensure!(
        candidate.definition.ghost_id == ghost
            && candidate.definition.revision
                == if update {
                    pointer
                        .revision
                        .checked_add(1)
                        .ok_or_else(|| anyhow!("definition revision exhausted"))?
                } else {
                    1
                },
        "lifecycle target identity or revision changed"
    );
    if original.body.get("skill_adoption").is_some() {
        ensure!(update,"shared skill adoption is an update only");
        super::shared_skills::prove_adoption(conn,&candidate,&source,&original.body["skill_adoption"])?;
    }
    if let Some(value) = original.body.get("memory_profile_ref") {
        ensure!(update, "memory profile adoption is an update only");
        exact(&original.body, &["method", "ghost_id", "definition_ref", "memory_profile_ref"])?;
        let (pin, profile) = selected_memory(conn, &source.ghost_id, value)?;
        let mut expected = source.content.clone();
        expected.acceptance_policy_ref = candidate.definition.content.acceptance_policy_ref.clone();
        expected.memory_profile_ref = Some(pin);
        let prior = evaluated_source(conn, &source)?;
        // Current engine/config authority is checked separately at readiness.
        // This check reconstructs immutable bytes from the authenticated intent,
        // including after a later token revoke/configuration change.
        ensure!(
            candidate.definition.content == expected
                && candidate.assets == prior.assets
                && candidate.shared_skills == prior.shared_skills
                && candidate.source_work_ids == prior.source_work_ids
                && candidate.source_acceptances == prior.source_acceptances
                && candidate.profile_name == prior.profile_name
                && candidate.display_name == prior.display_name
                && candidate.conversation_id == prior.conversation_id
                && candidate.privacy == memory_privacy(&prior.privacy, &profile),
            "memory profile adoption differs from its authenticated Owner source"
        );
    }
    if !update {
        ensure!(
            candidate.source_work_ids.is_empty(),
            "clone copied source Work history"
        );
    }
    Ok(())
}
pub(crate) fn authorize_control(conn: &Connection, e: &Envelope, principal: &str) -> Result<()> {
    ensure!(
        principal == "host-bot-provisioner" && e.actor_ref == principal,
        "invalid bot control continuation actor"
    );
    let request = text(&e.body, "control_request_id")?;
    let c = load::<Control>(conn, CONTROLS, request)?
        .ok_or_else(|| anyhow!("bot control intent missing"))?;
    ensure!(
        c.request_id == request
            && c.epoch == e.authority_epoch
            && e.body["candidate_id"] == c.candidate_id
            && e.body["candidate_digest"] == c.candidate_digest,
        "bot control continuation scope changed"
    );
    let raw:String=conn.query_row("SELECT request FROM lifetime_commands WHERE command_id=?1 AND actor_ref='owner' AND payload_digest=?2 AND authority_epoch=?3 AND json_extract(response,'$.status')='success'",params![request,c.payload_digest,c.epoch],|r|r.get(0))?;
    let original: Envelope = serde_json::from_str(&raw)?;
    validate_control_source(conn, &original, &c)?;
    ensure!(
        original.actor_ref == "owner"
            && matches!(
                original.body["method"].as_str(),
                Some("bot.update.prepare" | "bot.clone.prepare")
            ),
        "bot control source is not authenticated Owner intent"
    );
    let candidate = provisioning::candidate(conn, &c.candidate_id)?;
    ensure!(
        candidate.digest == c.candidate_digest,
        "bot control candidate changed"
    );
    Ok(())
}
pub(crate) fn evaluation_envelope(conn: &Connection, e: &Envelope) -> Result<Envelope> {
    ensure!(
        e.actor_ref == "owner",
        "definition lifecycle admission source must be Owner"
    );
    let c = load::<Control>(conn, CONTROLS, &e.command_id)?
        .ok_or_else(|| anyhow!("bot control candidate missing"))?;
    ensure!(
        c.payload_digest == e.payload_digest && c.epoch == e.authority_epoch,
        "bot lifecycle request digest changed"
    );
    validate_control_source(conn, e, &c)?;
    let body = json!({"method":"bot.evaluate","candidate_id":c.candidate_id,"candidate_digest":c.candidate_digest});
    Ok(Envelope {
        payload_digest: canonical_digest(&body)?,
        body,
        ..e.clone()
    })
}
pub(crate) fn prepare(conn: &Connection, e: &Envelope, principal: &str) -> Result<Envelope> {
    owner(e, principal)?;
    let method = text(&e.body, "method")?;
    let update = method == "bot.update.prepare";
    ensure!(
        update || method == "bot.clone.prepare",
        "unsupported bot definition candidate request"
    );
    exact(
        &e.body,
        if update && e.body.get("skill_adoption").is_some() {
            &["method", "ghost_id", "definition_ref", "skill_adoption"]
        } else if update && e.body.get("memory_profile_ref").is_some() {
            &["method", "ghost_id", "definition_ref", "memory_profile_ref"]
        } else if update {
            &["method", "ghost_id", "definition_ref", "instructions"]
        } else {
            &["method", "ghost_id", "definition_ref", "display_name"]
        },
    )?;
    let ghost = text(&e.body, "ghost_id")?;
    let original = bots_store::active_definition(conn, ghost)?
        .ok_or_else(|| anyhow!("source bot has no selected definition"))?;
    let expected: super::bots_store::DefinitionPointer =
        serde_json::from_value(e.body["definition_ref"].clone())?;
    ensure!(
        expected == super::bots_store::DefinitionPointer::from(&original),
        "source bot definition reference changed"
    );
    if update {
        ensure!(
            mode(conn, ghost)? != "retired",
            "retired bot definitions cannot be updated"
        );
    }
    let source = evaluated_source(conn, &original)?;
    ensure!(
        evaluated_definition(conn, ghost, &original.digest)?,
        "source bot definition is not independently evaluated/current"
    );
    let id = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("ghost-bot-control/1:{}", e.command_id).as_bytes(),
    )
    .to_string();
    let target_id = if update {
        ghost.to_owned()
    } else {
        uuid::Uuid::new_v5(
            &uuid::Uuid::NAMESPACE_URL,
            format!("ghost-bot-identity/1:{id}").as_bytes(),
        )
        .to_string()
    };
    let conversation = if update {
        source.conversation_id.clone()
    } else {
        uuid::Uuid::new_v5(
            &uuid::Uuid::NAMESPACE_URL,
            format!("ghost-bot-conversation/1:{id}").as_bytes(),
        )
        .to_string()
    };
    let mut c = source.clone();
    c.id = id.clone();
    c.request_ref = e.command_id.clone();
    c.intent_turn_id = None;
    c.issuer_ghost = None;
    c.conversation_id = conversation;
    if !update {
        c.source_work_ids.clear();
        c.source_acceptances.clear();
    }
    if !update {
        let name = text(&e.body, "display_name")?;
        ensure!(name.len() <= 256, "clone display name exceeds limit");
        c.display_name = name.into();
        c.profile_name = format!("bot-{}", target_id.replace('-', ""));
    }
    let mut content = original.content.clone();
    c.evaluation_profile =
        load::<provisioning::EvaluationProfile>(conn, "bot_evaluation_profile_v1", "workspace")?
            .ok_or_else(|| anyhow!("Owner evaluation profile unavailable"))?;
    if source.evaluation_inputs.is_some() {c.evaluation_inputs=Some(super::lifetime::evaluation_inputs::pin(&c.evaluation_profile)?);}
    let (verifier,policy):(String,u64)=conn.query_row("SELECT verifier_revision,policy_revision FROM lifetime_verification_policy WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
    c.verifier_revision = verifier.clone();
    c.policy_revision = policy;
    content.acceptance_policy_ref = super::bots::RevisionRef {
        namespace: "host".into(),
        id: verifier.clone(),
        revision: policy,
        digest: canonical_digest(&json!({"verifier_revision":verifier,"policy_revision":policy}))?,
    };
    if update && e.body.get("skill_adoption").is_some() {
        // Stage candidate bytes only. Existing activation performs the evaluated
        // definition CAS after current resource and source authority checks.
        c.definition.content=content.clone();
        super::shared_skills::stage(conn,&mut c,&e.body["skill_adoption"],&source)?;
        content=c.definition.content.clone();
    } else if update && e.body.get("memory_profile_ref").is_some() {
        let (pin, profile) = selected_memory(conn, ghost, &e.body["memory_profile_ref"])?;
        super::work_memory::definition_profile_current(conn, &profile)?;
        c.privacy = memory_privacy(&source.privacy, &profile);
        content.memory_profile_ref = Some(pin);
    } else if update {
        let instructions = text(&e.body, "instructions")?;
        let bound_instructions=c.source_contract.as_ref().map(|pin|pin.with_notes(instructions)).transpose()?;
        let instructions=bound_instructions.as_deref().unwrap_or(instructions);
        let asset = &mut c.assets[0];
        asset.content = instructions.into();
        asset.reference.revision = asset
            .reference
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow!("instruction revision exhausted"))?;
        asset.reference.digest = format!("{:x}", Sha256::digest(instructions.as_bytes()));
        content.instruction_ref = asset.reference.clone();
    }
    c.definition = BotDefinition::new(
        target_id.clone(),
        if update {
            original
                .revision
                .checked_add(1)
                .ok_or_else(|| anyhow!("definition revision exhausted"))?
        } else {
            1
        },
        content,
    )?;
    c.digest = String::new();
    let mut sealed = serde_json::to_value(&c)?;
    sealed.as_object_mut().unwrap().remove("digest");
    c.digest = canonical_digest(&sealed)?;
    c.validate()?;
    ensure!(
        load::<Value>(conn, "bot_candidate_v1", &id)?.is_none(),
        "bot control candidate already exists under another receipt"
    );
    let target = Target {
        mode: if update { "update" } else { "clone" }.into(),
        source_ghost: ghost.into(),
        source_revision: original.revision,
        source_digest: original.digest,
    };
    let p = provisioning::Progress {
        candidate_id: id.clone(),
        candidate_digest: c.digest.clone(),
        operation_id: format!("bot-provision/1:{id}"),
        ghost_id: target_id,
        conversation_id: c.conversation_id.clone(),
        state: "draft".into(),
        activation_requested: true,
        evaluation_work_id: None,
        evaluation_goal_id: None,
        receipts: json!({"mode":target.mode,"source_definition":expected}),
    };
    save(conn, "bot_candidate_v1", &id, &c)?;
    save(conn, "bot_provisioning_v1", &id, &p)?;
    save(conn, TARGETS, &id, &target)?;
    save(
        conn,
        CONTROLS,
        &e.command_id,
        &Control {
            request_id: e.command_id.clone(),
            payload_digest: e.payload_digest.clone(),
            epoch: e.authority_epoch,
            candidate_id: id,
            candidate_digest: c.digest,
        },
    )?;
    evaluation_envelope(conn, e)
}
pub(crate) fn target_is_stale(conn: &Connection, c: &provisioning::Candidate) -> Result<bool> {
    let Some(target) = target(conn, &c.id)? else {
        return Ok(false);
    };
    if target.mode != "update" {
        return Ok(false);
    }
    let selected = bots_store::active_definition(conn, &target.source_ghost)?;
    Ok(mode(conn, &target.source_ghost)? == "retired"
        || selected.is_none_or(|d| d.digest != target.source_digest))
}

/// Exact Owner-conversation projection. This is intentionally separate from
/// global discovery; selected mobile identities cannot enumerate other sources.
pub(crate) fn surface(conn: &Connection, e: &Envelope, principal: &str) -> Result<Response> {
    owner(e, principal)?;
    exact(&e.body, &["method", "ghost_id", "conversation_id"])?;
    let ghost = text(&e.body, "ghost_id")?;
    let conversation = text(&e.body, "conversation_id")?;
    let registered: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM lifetime_registry WHERE ghost_id=?1 AND conversation_id=?2)",
        params![ghost, conversation],
        |r| r.get(0),
    )?;
    if super::lifetime::is_public_secondary(conn, ghost, conversation)? {
        return Ok(success("Separate public conversation has no bot administration",
            json!({"target":{"ghost_id":ghost,"conversation_id":conversation},"bots":[],"operations":[],"truncated":false})));
    }
    ensure!(registered, "selected bot conversation is not registered");
    let mut query=conn.prepare("SELECT c.id FROM workspace_objects c WHERE c.kind='bot_candidate_v1' AND ((json_extract(c.payload,'$.definition.ghost_id')=?1 AND json_extract(c.payload,'$.conversation_id')=?2) OR EXISTS(SELECT 1 FROM lifetime_turns t WHERE t.id=json_extract(c.payload,'$.intent_turn_id') AND t.ghost_id=?1 AND t.conversation_id=?2 AND json_extract(c.payload,'$.issuer_ghost')=?1) OR EXISTS(SELECT 1 FROM workspace_objects x WHERE x.kind='bot_candidate_target_v1' AND x.id=c.id AND json_extract(x.payload,'$.source_ghost')=?1)) ORDER BY c.rowid DESC LIMIT 129")?;
    let mut ids = query
        .query_map(params![ghost, conversation], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let truncated = ids.len() > 128;
    ids.truncate(128);
    let mut operations = vec![];
    let mut roster = std::collections::BTreeMap::new();
    for id in ids {
        let c = provisioning::candidate(conn, &id)?;
        let p = provisioning::progress(conn, &id)?;
        let state = load::<State>(conn, STATES, &c.definition.ghost_id)?;
        let mode = mode(conn, &c.definition.ghost_id)?;
        let revision = state.map(|s| s.revision).unwrap_or(0);
        let pointer = bots_store::DefinitionPointer::from(&c.definition);
        let action=if let Some(target)=target(conn,&c.id)? {target.mode} else if conn.query_row("SELECT EXISTS(SELECT 1 FROM workspace_objects WHERE kind='bot_candidate_lineage_v1' AND id=?1)",[&c.id],|r|r.get::<_,bool>(0))? {"repair".into()} else {"create".into()};
        operations.push(json!({"action":action,"candidate_id":c.id,"candidate_digest":c.digest,"ghost_id":c.definition.ghost_id,"display_name":c.display_name,"purpose":c.definition.content.purpose,"state":p.state,"blocker":p.receipts["blocker"],"source_turn_id":c.intent_turn_id,"operation_id":p.operation_id,"definition_ref":pointer,"mode":mode,"lifecycle_revision":revision,"lifecycle_expected_revision":if revision==0 {None}else{Some(revision)}}));
        let Some(d) = bots_store::active_definition(conn, &c.definition.ghost_id)? else {
            continue;
        };
        if d.digest != c.definition.digest {
            continue;
        }
        let registered:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_registry WHERE ghost_id=?1 AND conversation_id=?2 AND mode='active')",params![c.definition.ghost_id,c.conversation_id],|r|r.get(0))?;
        if !registered {
            continue;
        }
        let current_policy:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_verification_policy WHERE singleton=1 AND verifier_revision=?1 AND policy_revision=?2)",params![c.verifier_revision,c.policy_revision],|r|r.get(0))?;
        roster.insert(c.definition.ghost_id.clone(),json!({"ghost_id":c.definition.ghost_id,"conversation_id":c.conversation_id,"display_name":c.display_name,"purpose":d.content.purpose,"required_capabilities":d.content.required_capabilities,"input_contract":d.content.input_contract,"output_contract":d.content.output_contract,"definition_ref":bots_store::DefinitionPointer::from(&d),"mode":mode,"lifecycle_revision":revision,"lifecycle_expected_revision":if revision==0 {None}else{Some(revision)},"admission_allowed":current_policy && admission_allowed(conn,&d.ghost_id)?,"managed":true,"disclosure":c.privacy}));
    }
    Ok(success(
        "Selected conversation bot surface inspected",
        json!({"target":{"ghost_id":ghost,"conversation_id":conversation},"bots":roster.into_values().collect::<Vec<_>>(),"operations":operations,"truncated":truncated}),
    ))
}
