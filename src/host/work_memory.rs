//! Explicit Work grants and generated experience outbox. This reuses scoped
//! Oxibrain reads and the PDC writer; generated summaries never become episodes.
use super::{
    lifetime::{self, PiInferenceScope, PiToolRequest},
    now_ms, Host, State,
};
use crate::{
    adapters::{
        documents::{self, Space},
        memory::Brain,
        memory_bindings::WorkMemoryProfile,
    },
    domain::Policy,
    durable::durable::{ai, ToolStatus},
    lifetime_contract::{
        canonical_digest, Artifact, Envelope, Response, ResponseStatus, RetryClass, Work,
    },
};
use anyhow::{anyhow, bail, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

#[path = "work_memory_profiles.rs"]
mod profiles;
pub(crate) use profiles::Unavailable as ProfileUnavailable;
pub(crate) use profiles::{resolve as resolve_definition_profile, configured_current as definition_profile_current, validate_creation as validate_creation_profile};

const GRANTS: &str = "work_memory_grant_v1";
const REVOKED: &str = "work_memory_revoked_v1";
const EXPERIENCES: &str = "work_experience_outbox_v1";
const LINEAGE: &str = "work_memory_lineage_v1";
const PROFILES: &str = "work_memory_profile_v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Profile {
    pub(crate) revision: u64,
    pub(crate) owner: String,
    pub(crate) required: bool,
    pub(crate) profile: Option<WorkMemoryProfile>,
    pub(crate) experience_space: Option<Space>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Grant {
    work_id: String,
    goal_id: String,
    goal_revision: u64,
    owner: String,
    owner_revision: u64,
    required: bool,
    profile: Option<WorkMemoryProfile>,
    experience_space: Option<Space>,
    private_delivery: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Experience {
    #[serde(default)]
    publication_dependencies: Vec<Value>,
    id: String,
    request_digest: String,
    assignment_id: String,
    grant_key: String,
    work_id: String,
    context_revision: String,
    #[serde(default)]
    writer_context_revision: Option<String>,
    #[serde(default)]
    generation: u64,
    goal_revision: u64,
    owner_revision: u64,
    owner: String,
    execution_id: String,
    artifacts: Vec<Artifact>,
    summary: String,
    limitations: String,
    page_id: String,
    created: String,
    body: Option<String>,
    hash: Option<String>,
    state: String,
    attempts: u32,
    next_attempt_ms: u64,
    last_reason: Option<String>,
}
fn key(work: &Work) -> String {
    format!("{}:{}:{}", work.id, work.goal_revision, work.owner_revision)
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
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .transpose()
}
fn put(conn: &Connection, kind: &str, id: &str, value: &impl Serialize) -> Result<()> {
    conn.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",
        params![kind,id,serde_json::to_string(value)?])?;
    Ok(())
}

fn save_experience(conn: &Connection, entry: &Experience) -> Result<bool> {
    Ok(conn.execute("UPDATE workspace_objects SET payload=?3 WHERE kind=?1 AND id=?2 AND COALESCE(json_extract(payload,'$.generation'),0)=?4",
        params![EXPERIENCES,entry.id,serde_json::to_string(entry)?,entry.generation])?==1)
}
fn work(conn: &Connection, id: &str) -> Result<Work> {
    let raw: String = conn.query_row(
        "SELECT payload FROM lifetime_work WHERE id=?1",
        [id],
        |row| row.get(0),
    )?;
    Ok(serde_json::from_str(&raw)?)
}
fn result(code: Option<&str>, summary: &str, data: Value) -> Response {
    Response {
        status: if code.is_none() {
            ResponseStatus::Success
        } else {
            ResponseStatus::Error
        },
        summary: summary.into(),
        object_refs: vec![],
        artifacts: vec![],
        next_actions: vec![],
        error_code: code.map(str::to_owned),
        retry_class: if code.is_none() {
            RetryClass::SameId
        } else {
            RetryClass::Never
        },
        data,
    }
}
fn fields(body: &Value, allowed: &[&str]) -> Result<()> {
    ensure!(
        body.as_object()
            .is_some_and(|object| object.keys().all(|key| allowed.contains(&key.as_str()))),
        "unexpected Work memory field"
    );
    Ok(())
}
fn string<'a>(body: &'a Value, name: &str, limit: usize) -> Result<&'a str> {
    body[name]
        .as_str()
        .filter(|value| !value.trim().is_empty() && value.len() <= limit && !value.contains('\0'))
        .ok_or_else(|| anyhow!("invalid Work memory {name}"))
}
fn private_space(conn: &Connection, owner: &str, id: &str) -> Result<Space> {
    let space: Space = load(conn, "space", id)?
        .ok_or_else(|| anyhow!("experience document Space is not granted"))?;
    ensure!(
        space.writable && space.profiles == [owner.to_owned()],
        "experience Space must be writable and private to this Ghost"
    );
    Ok(space)
}
fn grant(conn: &Connection, work: &Work) -> Result<Option<Grant>> {
    let grant: Option<Grant> = load(conn, GRANTS, &key(work))?;
    if let Some(grant) = &grant {
        ensure!(
            grant.work_id == work.id
                && grant.owner == work.owner
                && grant.goal_id == work.goal_id
                && grant.goal_revision == work.goal_revision
                && grant.owner_revision == work.owner_revision,
            "Work memory grant scope mismatch"
        );
    }
    Ok(grant)
}

/// Called only in the Work admission/new-owner-revision transaction. Inspect
/// and dispatch never retrofit a later profile into old Work.
pub(crate) fn pin_work(conn: &Connection, work: &Work) -> Result<()> {
    if grant(conn, work)?.is_some() {
        return Ok(());
    }
    let definition=super::bots_store::definition_for_work(conn,work)?;
    let Some(profile)=profiles::for_definition(conn,&work.owner,definition.as_ref())? else {
        return Ok(());
    };
    ensure!(
        profile.owner == work.owner,
        "Work memory profile owner mismatch"
    );
    put(
        conn,
        GRANTS,
        &key(work),
        &Grant {
            work_id: work.id.clone(),
            goal_id: work.goal_id.clone(),
            goal_revision: work.goal_revision,
            owner: work.owner.clone(),
            owner_revision: work.owner_revision,
            required: profile.required,
            private_delivery: profile.required || profile.profile.is_some(),
            profile: profile.profile,
            experience_space: profile.experience_space,
        },
    )
}

pub(crate) fn requires_private_delivery(conn: &Connection, work_id: &str) -> Result<bool> {
    let work = work(conn, work_id)?;
    Ok(grant(conn, &work)?.is_some_and(|grant| grant.private_delivery) || super::memory_publication::has_work_references(conn,&work)?)
}

pub(crate) fn has_lineage(conn: &Connection, work: &Work) -> Result<bool> {
    Ok(load::<String>(conn, LINEAGE, &key(work))?.is_some())
}

pub(crate) fn assignment_privacy(conn: &Connection, work: &Work, base: &str) -> Result<String> {
    let mut privacy = base.to_owned();
    if requires_private_delivery(conn, &work.id)? && base == "public" {
        privacy = "private".into();
    }
    Ok(privacy)
}

/// Arbitrary generated delegation prose may contain any source in the parent
/// context. An independently configured child must already cover that audience.
pub(crate) fn validate_delegation_target(
    conn: &Connection,
    parent: &Work,
    target: &str,
) -> Result<()> {
    if !has_lineage(conn, parent)? {
        return Ok(());
    }
    let parent_grant = grant(conn, parent)?
        .ok_or_else(|| anyhow!("memory-derived delegation has no parent grant"))?;
    current(conn, parent, &parent_grant, true)?;
    let parent_profile = parent_grant
        .profile
        .as_ref()
        .ok_or_else(|| anyhow!("parent read profile missing"))?;
    let selected=super::bots_store::active_definition(conn,target)?;
    let child:Profile=profiles::for_definition(conn,target,selected.as_ref())?.ok_or_else(|| {
        anyhow!("memory-derived delegation requires the target's explicit shared read profile")
    })?;
    ensure!(
        child.owner == target,
        "delegation target memory profile owner mismatch"
    );
    let child_profile = child
        .profile
        .as_ref()
        .ok_or_else(|| anyhow!("delegation target has no shared read bindings"))?;
    let policy: Policy = load(conn, "policy", target)?.unwrap_or_default();
    ensure!(
        policy.memory,
        "delegation target memory permission is absent"
    );
    let ids: Vec<_> = child_profile
        .bindings
        .iter()
        .map(|binding| binding.id.clone())
        .collect();
    ensure!(
        Brain::work_profile(target, &ids)? == *child_profile,
        "delegation target binding authority changed"
    );
    let child_spaces: BTreeSet<_> = child_profile
        .bindings
        .iter()
        .flat_map(|binding| binding.spaces.iter())
        .collect();
    ensure!(
        parent_profile
            .bindings
            .iter()
            .flat_map(|binding| binding.spaces.iter())
            .all(|space| child_spaces.contains(space)),
        "delegation target cannot receive the parent Work source audience"
    );
    Ok(())
}

/// Delegation runs this inside its original admission transaction, before the
/// child assignment is observable. A child profile supplies no extra audience.
pub(crate) fn restrict_child(conn: &Connection, parent: &Work, child: &Work) -> Result<()> {
    let Some(mut child_grant) = grant(conn, child)? else {
        return Ok(());
    };
    let parent_grant = grant(conn, parent)?;
    let parent_spaces: BTreeSet<_> = parent_grant
        .as_ref()
        .and_then(|grant| grant.profile.as_ref())
        .into_iter()
        .flat_map(|profile| profile.bindings.iter())
        .flat_map(|binding| binding.spaces.iter().cloned())
        .collect();
    if let Some(profile) = &mut child_grant.profile {
        profile.bindings.retain(|binding| {
            binding
                .spaces
                .iter()
                .all(|space| parent_spaces.contains(space))
        });
        if profile.bindings.is_empty() {
            child_grant.profile = None;
        }
    }
    if has_lineage(conn, parent)? {
        ensure!(
            child_grant.profile.is_some(),
            "memory-derived delegation has no child subset read grant"
        );
        child_grant.required = true;
        child_grant.private_delivery = true;
    }
    // Read responsibility does not delegate the parent's document write grant,
    // nor activate an unrelated private child destination.
    child_grant.experience_space = None;
    put(conn, GRANTS, &key(child), &child_grant)
}

fn current(conn: &Connection, work: &Work, grant: &Grant, local: bool) -> Result<()> {
    current_at_depth(conn, work, grant, local, 0)
}
fn current_at_depth(
    conn: &Connection,
    work: &Work,
    grant: &Grant,
    local: bool,
    depth: usize,
) -> Result<()> {
    ensure!(
        depth <= 16,
        "Work memory ancestry exceeds the bounded limit"
    );
    ensure!(
        local,
        "Work memory requires the accepted local inference route"
    );
    ensure!(
        work.cancellation == "none" && lifetime::work_scope_current(conn, &work.id)?,
        "Work memory assignment is stale or cancelled"
    );
    ensure!(
        load::<bool>(conn, REVOKED, &key(work))? != Some(true),
        "Work memory grant was revoked"
    );
    let policy: Policy = load(conn, "policy", &work.owner)?.unwrap_or_default();
    ensure!(policy.memory, "Work memory permission was revoked");
    let profile = grant
        .profile
        .as_ref()
        .ok_or_else(|| anyhow!("required Work memory has no explicit read binding"))?;
    let ids: Vec<_> = profile
        .bindings
        .iter()
        .map(|binding| binding.id.clone())
        .collect();
    ensure!(
        Brain::work_profile(&work.owner, &ids)? == *profile,
        "Work memory binding policy changed"
    );
    let parent: Option<String> = conn
        .query_row(
            "SELECT parent_work_id FROM lifetime_work_links WHERE child_work_id=?1 AND current=1",
            [&work.id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(parent) = parent {
        let parent = crate::host::work_memory::work(conn, &parent)?;
        let parent_grant = crate::host::work_memory::grant(conn, &parent)?
            .ok_or_else(|| anyhow!("delegating Work has no memory grant"))?;
        current_at_depth(conn, &parent, &parent_grant, local, depth + 1)?;
        let spaces: BTreeSet<_> = parent_grant
            .profile
            .as_ref()
            .into_iter()
            .flat_map(|profile| profile.bindings.iter())
            .flat_map(|binding| binding.spaces.iter())
            .collect();
        ensure!(
            profile
                .bindings
                .iter()
                .flat_map(|binding| binding.spaces.iter())
                .all(|space| spaces.contains(space)),
            "child Work memory exceeds its parent grant"
        );
    }
    Ok(())
}
fn context_stamp(
    conn: &Connection,
    work: &Work,
    grant: Option<&Grant>,
    local: bool,
) -> Result<String> {
    let policy: Policy = load(conn, "policy", &work.owner)?.unwrap_or_default();
    let authority = lifetime::authority::current(conn)?;
    canonical_digest(
        &json!({"work_id":work.id,"goal_revision":work.goal_revision,"owner_revision":work.owner_revision,
        "owner":work.owner,"authority_epoch":authority.epoch,"dispatch_enabled":authority.dispatch_enabled,
        "grant":grant,"revoked":load::<bool>(conn,REVOKED,&key(work))?,"memory":policy.memory,"local":local,
        "configuration":Brain::context_revision(&work.owner).ok()}),
    )
}

pub(crate) fn apply_owner(
    conn: &Connection,
    envelope: &Envelope,
    principal: &str,
) -> Result<Response> {
    if principal != "owner" {
        return Ok(result(
            Some("unauthorized"),
            "Work memory grants require authenticated Owner",
            Value::Null,
        ));
    }
    let body = &envelope.body;
    if body["method"]=="work.memory.profile.inspect" {return profiles::inspect(conn,envelope);}
    if body["method"] == "work.memory.profile.configure" {
        return profiles::configure(conn,envelope);
    }
    fields(
        body,
        &[
            "method",
            "work_id",
            "binding_ids",
            "required",
            "experience_space_id",
            "experience_id",
        ],
    )?;
    let work = work(conn, string(body, "work_id", 200)?)?;
    if body["method"] == "work.experience.inspect" {
        fields(body, &["method", "work_id"])?;
        let mut query=conn.prepare("SELECT payload FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.work_id')=?2 ORDER BY id")?;
        let mut entries = vec![];
        for raw in query.query_map(params![EXPERIENCES, work.id], |row| row.get::<_, String>(0))? {
            let entry: Experience = serde_json::from_str(&raw?)?;
            entries.push(json!({"id":entry.id,"page_id":entry.page_id,"state":entry.state,"attempts":entry.attempts,
                "source_hash":entry.hash,"next_attempt_ms":entry.next_attempt_ms,"reason":entry.last_reason,
                "goal_revision":entry.goal_revision,"owner_revision":entry.owner_revision,
                "original_context_revision":entry.context_revision,"writer_context_revision":entry.writer_context_revision}));
        }
        return Ok(result(
            None,
            "Generated experience outbox inspected",
            json!({"work_id":work.id,"entries":entries}),
        ));
    }
    if envelope.expected_revision != Some(work.goal_revision) {
        return Ok(result(
            Some("conflict"),
            "Work memory grant requires the current Goal revision",
            Value::Null,
        ));
    }
    if body["method"] == "work.experience.resume" {
        fields(body, &["method", "work_id", "experience_id"])?;
        let id = string(body, "experience_id", 600)?;
        let mut entry: Experience = load(conn, EXPERIENCES, id)?
            .ok_or_else(|| anyhow!("original experience candidate missing"))?;
        ensure!(
            entry.grant_key == key(&work)
                && entry.owner == work.owner
                && entry.execution_id == work.execution_id.as_deref().unwrap_or(""),
            "experience recovery scope changed"
        );
        ensure!(
            entry.state != "indexed",
            "experience document is already confirmed"
        );
        ensure!(entry.publication_dependencies.is_empty(),"Publication-derived candidate cannot be indexed without an engine-enforced lineage contract");
        let pinned =
            grant(conn, &work)?.ok_or_else(|| anyhow!("original experience grant missing"))?;
        current(conn, &work, &pinned, true)?;
        let destination = pinned
            .experience_space
            .as_ref()
            .ok_or_else(|| anyhow!("original experience destination missing"))?;
        ensure!(
            serde_json::to_value(private_space(conn, &work.owner, &destination.id)?)?
                == serde_json::to_value(destination)?,
            "experience destination changed"
        );
        if let Ok(page) = documents::read(destination, &entry.page_id) {
            ensure!(
                entry.hash.as_deref() == Some(&page.hash),
                "original experience source has a conflict; resolve it before recovery"
            );
        }
        entry.writer_context_revision = Some(context_stamp(conn, &work, Some(&pinned), true)?);
        entry.generation = entry
            .generation
            .checked_add(1)
            .ok_or_else(|| anyhow!("experience recovery generation exhausted"))?;
        entry.state = if entry.body.is_some() {
            "writing"
        } else {
            "queued"
        }
        .into();
        entry.attempts = 0;
        entry.next_attempt_ms = 0;
        entry.last_reason = Some("explicit_owner_reauthorization".into());
        put(conn, EXPERIENCES, id, &entry)?;
        return Ok(result(None,"Original experience write reauthorized; source identity, content and lineage preserved",json!({"id":entry.id,"page_id":entry.page_id,"source_hash":entry.hash,"state":entry.state})));
    }
    if body["method"] == "work.memory.revoke" {
        fields(body, &["method", "work_id"])?;
        put(conn, REVOKED, &key(&work), &true)?;
        return Ok(result(
            None,
            "Work memory grant revoked; earlier effects remain historical",
            json!({"work_id":work.id}),
        ));
    }
    ensure!(
        body["method"] == "work.memory.bind",
        "unsupported Work memory Owner method"
    );
    let emitted:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_outbox WHERE json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1)",[&work.id],|row|row.get(0))?;
    ensure!(!emitted,"Work already has an immutable assignment; configure a memory profile before admitting new Work");
    if work.execution_id.is_some()
        || work.state != "queued"
        || work.cancellation != "none"
        || !lifetime::work_scope_current(conn, &work.id)?
    {
        return Ok(result(
            Some("conflict"),
            "Work memory must be bound before this Work starts",
            Value::Null,
        ));
    }
    if grant(conn, &work)?.is_some() || load::<bool>(conn, REVOKED, &key(&work))? == Some(true) {
        return Ok(result(
            Some("conflict"),
            "Work memory grant is immutable; admit a new revision",
            Value::Null,
        ));
    }
    let ids: Vec<String> =
        serde_json::from_value(body.get("binding_ids").cloned().unwrap_or(json!([])))?;
    ensure!(
        ids.len() <= 8 && ids.iter().collect::<BTreeSet<_>>().len() == ids.len(),
        "invalid Work memory binding selection"
    );
    let required = body
        .get("required")
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("Work memory required must be Boolean"))?;
    let profile = if ids.is_empty() {
        None
    } else {
        let policy: Policy = load(conn, "policy", &work.owner)?.unwrap_or_default();
        ensure!(policy.memory, "Ghost memory permission is not granted");
        Some(Brain::work_profile(&work.owner, &ids)?)
    };
    let experience_space = body
        .get("experience_space_id")
        .filter(|value| !value.is_null())
        .map(|value| {
            private_space(
                conn,
                &work.owner,
                value
                    .as_str()
                    .ok_or_else(|| anyhow!("experience Space identity invalid"))?,
            )
        })
        .transpose()?;
    let grant = Grant {
        work_id: work.id.clone(),
        goal_id: work.goal_id.clone(),
        goal_revision: work.goal_revision,
        owner: work.owner.clone(),
        owner_revision: work.owner_revision,
        private_delivery: required || profile.is_some(),
        required,
        profile,
        experience_space,
    };
    put(conn, GRANTS, &key(&work), &grant)?;
    Ok(result(
        None,
        "Exact Work memory grant pinned; existing Ghost permissions are unchanged",
        assignment_view(conn, &work, true)?,
    ))
}

pub(crate) fn assignment_view(conn: &Connection, work: &Work, local: bool) -> Result<Value> {
    let Some(grant) = grant(conn, work)? else {
        return Ok(json!({"available_tools":[],"required":false,"status":"absent"}));
    };
    let revision = context_stamp(conn, work, Some(&grant), local)?;
    let available = current(conn, work, &grant, local).is_ok();
    let mut tools = vec![];
    if available {
        tools.push("work_memory_recall");
        if grant
            .experience_space
            .as_ref()
            .is_some_and(|space| private_space(conn, &work.owner, &space.id).is_ok())
        {
            tools.push("work_memory_record");
        }
    }
    Ok(
        json!({"available_tools":tools,"required":grant.required,"status":if available{"requires_live_authentication"}else if grant.required{"blocked"}else{"degraded"},
        "context_revision":revision,"reason":if available{Value::Null}else{json!("required_memory_unavailable")}}),
    )
}

fn actual_artifacts(conn: &Connection, work: &Work) -> Result<Vec<Artifact>> {
    let Some(execution) = work.execution_id.as_deref() else {
        return Ok(vec![]);
    };
    let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='lifetime_pi_effects')",[],|row|row.get(0))?;
    if !exists {
        return Ok(vec![]);
    }
    let mut query=conn.prepare("SELECT response_json FROM lifetime_pi_effects WHERE execution_id=?1 AND operation='publish_artifact' AND state='complete'")?;
    let mut artifacts = vec![];
    for raw in query.query_map([execution], |row| row.get::<_, String>(0))? {
        let response: Response = serde_json::from_str(&raw?)?;
        if response.status == ResponseStatus::Success {
            for artifact in response.artifacts {
                ensure!(
                    artifact.producing_attempt == execution,
                    "artifact attempt differs from current Work"
                );
                artifacts.push(artifact);
            }
        }
    }
    Ok(artifacts)
}

fn quoted(value: &str) -> String {
    // Generated prose is visibly separate from Host-derived provenance. Escape
    // source markup so it cannot impersonate a provenance field or embed HTML.
    value
        .lines()
        .map(|line| {
            format!(
                "> {}",
                line.chars()
                    .map(|ch| match ch {
                        '&' => "&amp;".into(),
                        '<' => "&lt;".into(),
                        '>' => "&gt;".into(),
                        '\\' | '`' | '*' | '_' | '[' | ']' | '#' | '!' | '|' => format!("\\{ch}"),
                        _ => ch.to_string(),
                    })
                    .collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn experience_body(
    entry: &Experience,
    work: &Work,
    acceptance: &crate::lifetime_contract::Acceptance,
) -> String {
    let mut body=format!("# Generated Work experience\n\nDocument: {}\n\nAuthor Ghost: {}\n\nWork: {}\n\nGoal: {} at revision {}\n\nOwner revision: {}\n\nAttempt: {}\n\nSource assignment: {}\n\nMemory disclosure revision: {}\n\n## Generated summary\n\n{}\n\n## Limitations\n\n{}\n\n## Host verification\n\nState: accepted\n\nVerifier: {}\n\nPolicy revision: {}\n\nRequirement digest: {}\n\nAccepted artifact digest: {}\n\nChecks passed: {}\n\n## Source artifacts\n",
        entry.page_id,entry.owner,entry.work_id,work.goal_id,entry.goal_revision,entry.owner_revision,entry.execution_id,
        entry.assignment_id,entry.context_revision,quoted(&entry.summary),quoted(if entry.limitations.is_empty(){"No limitations supplied by the producer."}else{&entry.limitations}),
        acceptance.verifier_revision,acceptance.policy_revision,acceptance.requirement_digest,acceptance.artifact_digest,acceptance.checks.iter().filter(|check|check.passed).count());
    for artifact in &entry.artifacts {
        body.push_str(&format!(
            "\n- Digest: {}\n  Privacy: {}\n  Attempt: {}\n  Locator: {}\n",
            artifact.digest,
            artifact.privacy,
            artifact.producing_attempt,
            quoted(&artifact.locator)
        ));
    }
    body.push_str("\nThis generated summary is a source-backed document, not an observation, assertion, or memory episode. Source artifacts and independent verification retain their original authority.\n");
    body
}

impl Host {
    /// The lifetime driver owns this single continuation. Cancellation leaves
    /// the durable attempt and planned source intact for same-identity reconcile.
    pub(crate) async fn advance_work_experiences_bounded(
        &self,
        limit: std::time::Duration,
    ) -> Result<bool> {
        match tokio::time::timeout(limit, self.advance_work_experiences()).await {
            Ok(result) => {
                result?;
                Ok(true)
            }
            Err(_) => Ok(false),
        }
    }

    fn experience_authorized(
        &self,
        state: &State,
        entry: &Experience,
        pinned: &Grant,
        destination: &Space,
    ) -> Result<Work> {
        let conn = &state.journal.0;
        let persisted: Experience = load(conn, EXPERIENCES, &entry.id)?
            .ok_or_else(|| anyhow!("experience checkpoint missing"))?;
        ensure!(
            persisted.generation == entry.generation
                && persisted.page_id == entry.page_id
                && persisted.hash == entry.hash
                && persisted.body == entry.body,
            "experience writer checkpoint was superseded"
        );
        let authority = lifetime::authority::current(conn)?;
        ensure!(
            authority.epoch == self.authority_epoch && authority.dispatch_enabled,
            "experience writer authority fenced"
        );
        ensure!(
            !self.stopping.load(std::sync::atomic::Ordering::Acquire)
                && self.pi_local_route.is_some()
                && state.profiles.contains_key(&entry.owner),
            "experience local writer is unavailable"
        );
        let actual = work(conn, &entry.work_id)?;
        ensure!(
            key(&actual) == entry.grant_key
                && actual.owner == entry.owner
                && actual.state == "accepted"
                && actual.execution_id.as_deref() == Some(&entry.execution_id),
            "experience source changed"
        );
        let current_grant =
            grant(conn, &actual)?.ok_or_else(|| anyhow!("experience grant missing"))?;
        ensure!(
            serde_json::to_value(&current_grant)? == serde_json::to_value(pinned)?,
            "experience grant changed"
        );
        current(conn, &actual, &current_grant, true)?;
        ensure!(
            context_stamp(conn, &actual, Some(&current_grant), true)?
                == entry
                    .writer_context_revision
                    .as_deref()
                    .unwrap_or(&entry.context_revision),
            "experience original disclosure authority changed; explicit Owner recovery required"
        );
        ensure!(
            serde_json::to_value(private_space(conn, &entry.owner, &destination.id)?)?
                == serde_json::to_value(destination)?,
            "experience destination changed"
        );
        Ok(actual)
    }

    fn write_experience_source(
        &self,
        entry: &Experience,
        pinned: &Grant,
        destination: &Space,
    ) -> Result<documents::Page> {
        ensure!(entry.publication_dependencies.is_empty(),"Publication-derived candidate cannot be indexed without an engine-enforced lineage contract");
        let state = self.lock()?;
        self.experience_authorized(&state, entry, pinned, destination)?;
        for artifact in &entry.artifacts {
            crate::worker::journal::read_verified_pi_artifact(
                &self.root,
                &state.journal.0,
                &entry.execution_id,
                &artifact.digest,
                std::path::Path::new(&artifact.locator),
            )?;
        }
        documents::create(
            destination,
            &entry.page_id,
            &format!("Work experience {}", entry.page_id),
            entry
                .body
                .as_deref()
                .ok_or_else(|| anyhow!("planned source missing"))?,
            "pdc-markdown/1",
            &entry.created,
        )
    }

    /// One bounded item on the existing lifetime driver. The planned identity,
    /// exact source bytes and hash are durable before the PDC writer runs.
    pub(crate) async fn advance_work_experiences(&self) -> Result<()> {
        let next = {
            let state = self.lock()?;
            let raw:Option<String>=state.journal.0.query_row("SELECT payload FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.state') IN ('queued','waiting_verification','writing','written_index_pending') AND json_extract(payload,'$.next_attempt_ms')<=?2 ORDER BY id LIMIT 1",
                params![EXPERIENCES,now_ms()],|row|row.get(0)).optional()?;
            raw.map(|raw| serde_json::from_str::<Experience>(&raw))
                .transpose()?
        };
        let Some(mut entry) = next else {
            return Ok(());
        };
        let scope = {
            let state = self.lock()?;
            let conn = &state.journal.0;
            let authority = lifetime::authority::current(conn)?;
            ensure!(
                authority.epoch == self.authority_epoch && authority.dispatch_enabled,
                "experience writer authority fenced"
            );
            let actual = work(conn, &entry.work_id)?;
            let pinned = grant(conn, &actual)?;
            let valid = (|| -> Result<(Grant, Space)> {
                ensure!(
                    key(&actual) == entry.grant_key
                        && actual.owner == entry.owner
                        && actual.execution_id.as_deref() == Some(&entry.execution_id),
                    "experience attempt changed"
                );
                let pinned = pinned.ok_or_else(|| anyhow!("experience Work grant missing"))?;
                current(conn, &actual, &pinned, true)?;
                ensure!(
                    context_stamp(conn, &actual, Some(&pinned), true)?
                        == entry
                            .writer_context_revision
                            .as_deref()
                            .unwrap_or(&entry.context_revision),
                    "experience original disclosure authority changed"
                );
                let destination = pinned
                    .experience_space
                    .as_ref()
                    .ok_or_else(|| anyhow!("experience document destination missing"))?;
                let current = private_space(conn, &actual.owner, &destination.id)?;
                ensure!(
                    serde_json::to_value(&current)? == serde_json::to_value(destination)?,
                    "experience document authority changed"
                );
                Ok((pinned, current))
            })();
            match valid {
                Err(_) => {
                    entry.state = "blocked".into();
                    entry.last_reason = Some("source_or_destination_authority_changed".into());
                    save_experience(conn, &entry)?;
                    None
                }
                Ok((pinned, destination)) => {
                    if actual.state != "accepted" {
                        if matches!(actual.state.as_str(), "failed" | "cancelled" | "stale") {
                            entry.state = "blocked".into();
                            entry.last_reason = Some("source_work_not_accepted".into());
                        } else {
                            entry.state = "waiting_verification".into();
                            entry.next_attempt_ms = now_ms().saturating_add(30_000);
                            entry.last_reason = Some("independent_acceptance_pending".into());
                        }
                        save_experience(conn, &entry)?;
                        None
                    } else {
                        let raw: String = conn.query_row(
                            "SELECT payload FROM lifetime_acceptances WHERE work_id=?1",
                            [&actual.id],
                            |row| row.get(0),
                        )?;
                        let acceptance: crate::lifetime_contract::Acceptance =
                            serde_json::from_str(&raw)?;
                        ensure!(
                            acceptance.goal_revision == entry.goal_revision
                                && entry
                                    .artifacts
                                    .iter()
                                    .any(|artifact| artifact.digest == acceptance.artifact_digest),
                            "experience must retain the independently accepted artifact"
                        );
                        if entry.body.is_none() {
                            let body = experience_body(&entry, &actual, &acceptance);
                            let (_, bytes) = documents::new_source(
                                &entry.page_id,
                                &format!("Work experience {}", entry.page_id),
                                &body,
                                "pdc-markdown/1",
                                &entry.created,
                            )?;
                            entry.hash = Some(documents::digest(&bytes));
                            entry.body = Some(body);
                        }
                        Some((pinned, destination))
                    }
                }
            }
        };
        let Some((pinned, destination)) = scope else {
            return Ok(());
        };
        if entry.attempts >= 6 {
            entry.state = "reconcile_required".into();
            entry.last_reason = Some("bounded_retry_exhausted".into());
            let state = self.lock()?;
            if !save_experience(&state.journal.0, &entry)? {
                return Ok(());
            }
            return Ok(());
        }
        entry.attempts += 1;
        entry.state = if entry.state == "written_index_pending" {
            "written_index_pending"
        } else {
            "writing"
        }
        .into();
        entry.next_attempt_ms =
            now_ms().saturating_add(1_000u64.saturating_mul(1u64 << entry.attempts.min(12)));
        {
            let state = self.lock()?;
            if !save_experience(&state.journal.0, &entry)? {
                return Ok(());
            }
        }
        let check = || {
            let state = self.lock()?;
            self.experience_authorized(&state, &entry, &pinned, &destination)?;
            Ok(())
        };
        let attempted: Result<bool> = async {
            self.brain
                .validate_work_context(
                    &entry.owner,
                    pinned
                        .profile
                        .as_ref()
                        .ok_or_else(|| anyhow!("experience read grant missing"))?,
                    &check,
                )
                .await?;
            check()?;
            // Keep the writer lock across the small bounded atomic filesystem
            // write so an Owner revoke cannot race the final grant check.
            let page = self.write_experience_source(&entry, &pinned, &destination)?;
            ensure!(
                entry.hash.as_deref() == Some(&page.hash),
                "experience writer returned a different source hash"
            );
            check()?;
            {
                let state = self.lock()?;
                let mut written = entry.clone();
                written.state = "written_index_pending".into();
                written.last_reason = Some("registered_document_index_not_confirmed".into());
                ensure!(
                    save_experience(&state.journal.0, &written)?,
                    "experience writer was superseded during index checkpoint"
                );
            }
            self.brain
                .experience_document_indexed(
                    &entry.owner,
                    &entry.page_id,
                    &destination.path,
                    entry
                        .hash
                        .as_deref()
                        .ok_or_else(|| anyhow!("planned source hash missing"))?,
                    &check,
                )
                .await
        }
        .await;
        match attempted {
            Ok(indexed) => {
                entry.state = if indexed {
                    "indexed"
                } else {
                    "written_index_pending"
                }
                .into();
                entry.last_reason = if indexed {
                    None
                } else {
                    Some("registered_document_index_not_confirmed".into())
                };
            }
            Err(_) => {
                // A user edit or unrelated same-ID file is never overwritten.
                if documents::read(&destination, &entry.page_id)
                    .ok()
                    .is_some_and(|page| entry.hash.as_deref() != Some(&page.hash))
                {
                    entry.state = "reconcile_required".into();
                    entry.last_reason = Some("destination_source_conflict".into());
                } else {
                    entry.last_reason = Some("write_or_index_unconfirmed".into());
                }
            }
        }
        let state = self.lock()?;
        if !save_experience(&state.journal.0, &entry)? {
            return Ok(());
        }
        Ok(())
    }

    fn remember_work_memory(&self, work: &Work, stamp: &str) -> Result<()> {
        let state = self.lock()?;
        let actual = crate::host::work_memory::work(&state.journal.0, &work.id)?;
        ensure!(key(&actual) == key(work), "Work memory admission changed");
        let grant = grant(&state.journal.0, &actual)?
            .ok_or_else(|| anyhow!("Work memory grant missing"))?;
        current(&state.journal.0, &actual, &grant, true)?;
        ensure!(
            context_stamp(&state.journal.0, &actual, Some(&grant), true)? == stamp,
            "Work memory authority changed before delivery"
        );
        let previous: Option<String> = load(&state.journal.0, LINEAGE, &key(work))?;
        ensure!(
            previous.as_ref().is_none_or(|previous| previous == stamp),
            "Work memory context changed; a fresh admitted revision is required"
        );
        if previous.is_none() {
            put(&state.journal.0, LINEAGE, &key(work), &stamp)?;
        }
        Ok(())
    }

    /// This runs under the same writer lock as effect receipt lookup/admission.
    pub(crate) fn work_memory_effect_current(
        &self,
        state: &State,
        request: &PiToolRequest,
        route: PiInferenceScope,
    ) -> Result<Option<Response>> {
        if let Some(response)=self.publication_effect_current(state,request,route)? {return Ok(Some(response));}
        let conn = &state.journal.0;
        let work_id = string(&request.envelope.body, "work_id", 200)?;
        let raw:Option<String>=conn.query_row("SELECT payload FROM lifetime_work WHERE id=?1",[work_id],|row|row.get(0)).optional()?;
        let Some(raw)=raw else {
            return Ok(Some(result(Some("not_found"),
                "No Work in the authenticated Ghost scope has this ID; use the exact Work ID returned by Goal admission, not its Goal ID",
                json!({"host_effect_class":"no_effect"}))));
        };
        let work:Work=serde_json::from_str(&raw)?;
        if work.owner != request.ghost_id {
            return Ok(Some(result(Some("not_found"),
                "No Work in the authenticated Ghost scope has this ID; inspect the original scoped admission",
                json!({"host_effect_class":"no_effect"}))));
        }
        let grant = grant(conn, &work)?;
        let previous: Option<String> = load(conn, LINEAGE, &key(&work))?;
        let supplied = request.envelope.body.get("work_memory_context_revision");
        if previous.is_none()
            && supplied.is_none()
            && !grant.as_ref().is_some_and(|grant| grant.required)
        {
            return Ok(None);
        }
        let valid = (|| -> Result<()> {
            let supplied = supplied
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("memory-derived Work effect lacks provenance"))?;
            ensure!(
                previous.as_deref() == Some(supplied),
                "Work effect lineage differs from authenticated memory result"
            );
            let grant = grant
                .as_ref()
                .ok_or_else(|| anyhow!("Work memory grant missing"))?;
            current(conn, &work, grant, route == PiInferenceScope::Local)?;
            ensure!(
                context_stamp(conn, &work, Some(grant), route == PiInferenceScope::Local)?
                    == supplied,
                "Work memory authority changed"
            );
            Ok(())
        })();
        Ok(valid.err().map(|_| {
            result(
                Some("disclosure_blocked"),
                "Work memory provenance is no longer current; effect withheld",
                Value::Null,
            )
        }))
    }

    /// Fresh engine auth precedes every effect/completion, including receipt replay.
    pub(crate) async fn work_memory_effect_guard(
        &self,
        request: &PiToolRequest,
        route: PiInferenceScope,
    ) -> Result<Option<Response>> {
        let captured = {
            let state = self.lock()?;
            if let Some(response) = self.work_memory_effect_current(&state, request, route)? {
                return Ok(Some(response));
            }
            let work = work(
                &state.journal.0,
                string(&request.envelope.body, "work_id", 200)?,
            )?;
            let prior: Option<String> = load(&state.journal.0, LINEAGE, &key(&work))?;
            if prior.is_none() {
                return Ok(None);
            }
            let grant = grant(&state.journal.0, &work)?
                .ok_or_else(|| anyhow!("Work memory grant missing"))?;
            (work, grant)
        };
        let check = || {
            let state = self.lock()?;
            ensure!(
                self.check_pi_host_scope(&state, request, route)?.is_none(),
                "Pi Host is fenced"
            );
            ensure!(
                self.work_memory_effect_current(&state, request, route)?
                    .is_none(),
                "Work memory authority changed"
            );
            Ok(())
        };
        match self
            .brain
            .validate_work_context(
                &captured.0.owner,
                captured
                    .1
                    .profile
                    .as_ref()
                    .ok_or_else(|| anyhow!("Work memory bindings missing"))?,
                &check,
            )
            .await
        {
            Ok(_) => {
                check()?;
                Ok(None)
            }
            Err(_) => Ok(Some(result(
                Some("disclosure_blocked"),
                "Work memory source authority cannot be reauthenticated; effect withheld",
                Value::Null,
            ))),
        }
    }

    /// Independent local verification consumes the producer's recorded memory
    /// lineage. It cannot invent a new context stamp after production ended.
    pub(crate) fn work_memory_verification_current(&self, state: &State, expected: &Work) -> Result<()> {
        self.work_memory_verification_conn(&state.journal.0, expected)
    }

    pub(crate) fn work_memory_verification_conn(&self, conn: &Connection, expected: &Work) -> Result<()> {
        let actual = work(conn, &expected.id)?;
        ensure!(key(&actual) == key(expected) && actual.execution_id == expected.execution_id,
            "Verifier Work memory source changed");
        let configured = grant(conn, &actual)?;
        let prior: Option<String> = load(conn, LINEAGE, &key(&actual))?;
        if prior.is_none() && !configured.as_ref().is_some_and(|grant| grant.required) {
            return Ok(());
        }
        let prior = prior.ok_or_else(|| anyhow!("Required verifier memory lineage missing"))?;
        let configured = configured.ok_or_else(|| anyhow!("Verifier memory grant missing"))?;
        current(conn, &actual, &configured, true)?;
        ensure!(context_stamp(conn, &actual, Some(&configured), true)? == prior,
            "Verifier memory lineage is no longer current");
        Ok(())
    }

    pub(crate) async fn work_memory_verification_guard(&self, expected: &Work) -> Result<()> {
        let captured = {
            let state = self.lock()?;
            self.work_memory_verification_current(&state, expected)?;
            let actual = work(&state.journal.0, &expected.id)?;
            let prior: Option<String> = load(&state.journal.0, LINEAGE, &key(&actual))?;
            if prior.is_none() { return Ok(()); }
            let configured = grant(&state.journal.0, &actual)?
                .ok_or_else(|| anyhow!("Verifier memory grant missing"))?;
            (actual, configured)
        };
        let check = || {
            let state = self.lock()?;
            self.work_memory_verification_current(&state, expected)
        };
        self.brain.validate_work_context(&captured.0.owner,
            captured.1.profile.as_ref().ok_or_else(|| anyhow!("Verifier memory bindings missing"))?,
            &check).await?;
        check()
    }

    fn work_memory_scope(
        &self,
        request: &PiToolRequest,
        route: PiInferenceScope,
    ) -> Result<(Work, Option<Grant>, String)> {
        let state = self.lock()?;
        if let Some(response) = self
            .check_pi_host_scope(&state, request, route)?
            .or(lifetime::pi_tool_guard(&state.journal.0, request, route)?)
        {
            bail!("{}", response.summary);
        }
        let work = lifetime::pi_execution::validate_assignment(&state.journal.0, request)?;
        let grant = grant(&state.journal.0, &work)?;
        let stamp = context_stamp(
            &state.journal.0,
            &work,
            grant.as_ref(),
            route == PiInferenceScope::Local,
        )?;
        Ok((work, grant, stamp))
    }

    pub(crate) async fn lifetime_work_memory_action(
        &self,
        request: &PiToolRequest,
        route: PiInferenceScope,
    ) -> Result<Response> {
        request.envelope.validate()?;
        let body = &request.envelope.body;
        let method = string(body, "method", 100)?;
        let extra = match method {
            "work.memory.recall" => &["query", "token_budget", "as_of", "known_at", "planes"][..],
            "work.memory.record" => &["summary", "limitations", "artifact_digests"][..],
            "work.memory.context.inspect" => &[][..],
            _ => bail!("unsupported Work memory method"),
        };
        let mut allowed = vec![
            "method",
            "ghost_id",
            "conversation_id",
            "assignment_id",
            "work_id",
        ];
        allowed.extend(extra);
        fields(body, &allowed)?;
        let (work, grant, stamp) = self.work_memory_scope(request, route)?;
        let usable = {
            let state = self.lock()?;
            grant.as_ref().is_some_and(|grant| {
                current(
                    &state.journal.0,
                    &work,
                    grant,
                    route == PiInferenceScope::Local,
                )
                .is_ok()
            })
        };
        if method == "work.memory.context.inspect" && !usable {
            return Ok(result(
                None,
                "Current exact Work memory context inspected",
                json!({"context_revision":stamp,"memory_permitted":false}),
            ));
        }
        if !usable {
            return Ok(result(
                Some("required_memory_unavailable"),
                "No current exact Work read grant is usable",
                json!({"context_revision":stamp,"memory_permitted":false}),
            ));
        }
        let grant = grant.ok_or_else(|| anyhow!("Work memory grant missing"))?;
        let profile = grant
            .profile
            .as_ref()
            .ok_or_else(|| anyhow!("Work memory read bindings missing"))?;
        let check = || {
            let (current_work, current_grant, current_stamp) =
                self.work_memory_scope(request, route)?;
            ensure!(
                current_stamp == stamp,
                "Work memory authority changed during I/O"
            );
            let state = self.lock()?;
            current(
                &state.journal.0,
                &current_work,
                current_grant
                    .as_ref()
                    .ok_or_else(|| anyhow!("Work memory grant removed"))?,
                route == PiInferenceScope::Local,
            )
        };
        if method == "work.memory.context.inspect" {
            self.brain
                .validate_work_context(&work.owner, profile, &check)
                .await?;
            check()?;
            if grant.required {
                self.remember_work_memory(&work, &stamp)?;
            }
            return Ok(result(
                None,
                "Live exact Work memory context authenticated",
                json!({"context_revision":stamp,"memory_permitted":true}),
            ));
        }
        if method == "work.memory.record" {
            self.brain
                .validate_work_context(&work.owner, profile, &check)
                .await?;
            check()?;
            return self.enqueue_work_experience(request, &work, &grant, &stamp);
        }
        let query = string(body, "query", 8192)?;
        let budget = body
            .get("token_budget")
            .map(|value| {
                value
                    .as_u64()
                    .filter(|value| (128..=2048).contains(value))
                    .ok_or_else(|| anyhow!("Work memory budget must be in 128..2048"))
            })
            .transpose()?
            .unwrap_or(1024);
        let mut arguments=json!({"query":query,"token_budget":budget});
        for field in ["as_of","known_at","planes"] {if let Some(value)=body.get(field) {arguments[field]=value.clone();}}
        let call = ai::ToolCall::new(
            &request.envelope.command_id,
            "memory_recall",
            arguments,
        );
        let mut output = self
            .brain
            .read_work_memory(
                &work.owner,
                &format!(
                    "work:{}:{}:{}",
                    work.id, work.goal_revision, work.owner_revision
                ),
                profile,
                &call,
                &check,
            )
            .await?;
        check()?;
        if let Some(code)=crate::adapters::memory::read_error_code(&output) {return Ok(result(Some(code),&output.summary,output.content));}
        if output.status != ToolStatus::Success {
            return Ok(result(
                Some("memory_unavailable"),
                &output.summary,
                Value::Null,
            ));
        }
        output.content["context_revision"] = json!(stamp);
        self.remember_work_memory(&work, &stamp)?;
        Ok(result(
            None,
            "Untrusted evidence from this Work's exact shared read grants",
            output.content,
        ))
    }

    fn enqueue_work_experience(
        &self,
        request: &PiToolRequest,
        work: &Work,
        grant: &Grant,
        stamp: &str,
    ) -> Result<Response> {
        let summary = string(&request.envelope.body, "summary", 16_384)?;
        let limitations = request.envelope.body["limitations"]
            .as_str()
            .filter(|value| value.len() <= 8192 && !value.contains('\0'))
            .ok_or_else(|| anyhow!("experience limitations invalid"))?;
        let digests: Vec<String> =
            serde_json::from_value(request.envelope.body["artifact_digests"].clone())?;
        ensure!(
            !digests.is_empty()
                && digests.len() <= 8
                && digests.iter().all(|value| value.len() == 64
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
                && digests.iter().collect::<BTreeSet<_>>().len() == digests.len(),
            "experience must select 1..8 unique current artifact digests"
        );
        let state = self.lock()?;
        ensure!(
            self.check_pi_host_scope(&state, request, PiInferenceScope::Local)?
                .is_none()
                && lifetime::pi_tool_guard(&state.journal.0, request, PiInferenceScope::Local)?
                    .is_none(),
            "Work experience writer is fenced"
        );
        let actual = lifetime::pi_execution::validate_assignment(&state.journal.0, request)?;
        ensure!(
            key(&actual) == key(work) && actual.execution_id == work.execution_id,
            "Work experience source changed"
        );
        ensure!(
            context_stamp(&state.journal.0, &actual, Some(grant), true)? == stamp,
            "Work experience authority changed before admission"
        );
        current(&state.journal.0, work, grant, true)?;
        let destination = grant
            .experience_space
            .as_ref()
            .ok_or_else(|| anyhow!("no experience document destination is granted"))?;
        ensure!(
            serde_json::to_value(private_space(
                &state.journal.0,
                &work.owner,
                &destination.id
            )?)? == serde_json::to_value(destination)?,
            "experience document grant changed"
        );
        let id = format!("{}:{}", key(work), request.envelope.command_id);
        if let Some(previous) = load::<Experience>(&state.journal.0, EXPERIENCES, &id)? {
            ensure!(
                previous.request_digest == request.envelope.payload_digest,
                "experience checkpoint has different content"
            );
            return Ok(result(
                None,
                "Original generated experience candidate recovered",
                json!({"id":previous.id,"page_id":previous.page_id,"state":previous.state,"context_revision":stamp}),
            ));
        }
        let mut artifacts = actual_artifacts(&state.journal.0, work)?;
        artifacts.retain(|artifact| digests.contains(&artifact.digest));
        artifacts.sort_by(|left, right| left.digest.cmp(&right.digest));
        artifacts.dedup_by(|left, right| left.digest == right.digest);
        ensure!(
            digests
                .iter()
                .all(|digest| artifacts.iter().any(|artifact| &artifact.digest == digest)),
            "experience references an unpublished or unrelated artifact"
        );
        // A different model call after a lost ACK must recover this attempt's
        // original source candidate, never mint another document identity.
        let prior:Option<String>=state.journal.0.query_row("SELECT payload FROM workspace_objects WHERE kind=?1 AND json_extract(payload,'$.grant_key')=?2 AND json_extract(payload,'$.execution_id')=?3 LIMIT 1",
            params![EXPERIENCES,key(work),work.execution_id],|row|row.get(0)).optional()?;
        if let Some(prior) = prior {
            let prior: Experience = serde_json::from_str(&prior)?;
            ensure!(prior.summary==summary && prior.limitations==limitations && prior.artifacts==artifacts,"Original Work experience candidate already exists; reconcile it before another record");
            return Ok(result(
                None,
                "Original Work experience candidate recovered across call identity",
                json!({"id":prior.id,"page_id":prior.page_id,"state":prior.state,"context_revision":stamp}),
            ));
        }
        let count: i64 = state.journal.0.query_row(
            "SELECT COUNT(*) FROM workspace_objects WHERE kind=?1",
            [EXPERIENCES],
            |row| row.get(0),
        )?;
        ensure!(count < 4096, "experience outbox is full");
        let entry = Experience {
            publication_dependencies: super::memory_publication::experience_dependencies(&state.journal.0,work)?,
            id: id.clone(),
            request_digest: request.envelope.payload_digest.clone(),
            assignment_id: string(&request.envelope.body, "assignment_id", 400)?.into(),
            grant_key: key(work),
            work_id: work.id.clone(),
            context_revision: stamp.into(),
            writer_context_revision: None,
            generation: 0,
            goal_revision: work.goal_revision,
            owner_revision: work.owner_revision,
            owner: work.owner.clone(),
            execution_id: work
                .execution_id
                .clone()
                .ok_or_else(|| anyhow!("experience source execution missing"))?,
            artifacts,
            summary: summary.into(),
            limitations: limitations.into(),
            page_id: uuid::Uuid::now_v7().to_string(),
            created: documents::timestamp()?,
            body: None,
            hash: None,
            state: "queued".into(),
            attempts: 0,
            next_attempt_ms: 0,
            last_reason: None,
        };
        let mut entry=entry;
        if !entry.publication_dependencies.is_empty() {
            entry.state="blocked_publication_lineage".into();
            entry.last_reason=Some("Publication-derived document indexing needs an engine-enforced lineage contract; candidate retained without writing or indexing".into());
        }
        put(&state.journal.0, EXPERIENCES, &id, &entry)?;
        Ok(result(
            None,
            "Generated experience candidate retained; inspect its state before claiming source storage or indexing",
            json!({"id":entry.id,"page_id":entry.page_id,"state":entry.state,"context_revision":stamp}),
        ))
    }
}

/// Coordination transfers generated text to another admitted responsibility;
/// its source stamp is subject to the same fences as a direct tool effect.
fn coordination_request(request: &PiToolRequest) -> Result<Option<PiToolRequest>> {
    if !matches!(
        request.envelope.body["method"].as_str(),
        Some("work.delegate" | "work.wait" | "work.wait.inspect" | "work.pi.admit")
    ) {
        return Ok(None);
    }
    request.envelope.validate()?;
    let mut scoped = request.clone();
    if request.envelope.body["method"] == "work.delegate" {
        scoped.envelope.body["work_id"] = request.envelope.body["parent_work_id"].clone();
    }
    scoped.envelope.payload_digest = canonical_digest(&scoped.envelope.body)?;
    Ok(Some(scoped))
}
impl Host {
    pub(crate) async fn work_memory_coordination_guard(
        &self,
        request: &PiToolRequest,
        route: PiInferenceScope,
    ) -> Result<Option<Response>> {
        let Some(scoped) = coordination_request(request)? else {
            return Ok(None);
        };
        self.work_memory_effect_guard(&scoped, route).await
    }
    pub(crate) fn work_memory_coordination_current(
        &self,
        state: &State,
        request: &PiToolRequest,
        route: PiInferenceScope,
    ) -> Result<Option<Response>> {
        let Some(scoped) = coordination_request(request)? else {
            return Ok(None);
        };
        self.work_memory_effect_current(state, &scoped, route)
    }
}

#[cfg(all(test, feature = "memory", feature = "documents"))]
#[path = "work_memory_tests.rs"]
mod tests;
