//! Immutable common/project skill revisions and explicit, revocable readers.
//! Publication never selects executable bytes. Adoption uses the evaluated bot
//! update lifecycle and pins the exact grants before any candidate disclosure.
use super::{
    bots::RevisionRef,
    bots_provisioning::{Asset, Candidate},
    lifetime::{self, PiToolRequest},
    State,
};
use crate::lifetime_contract::{
    canonical_digest, Envelope, Response, ResponseStatus, RetryClass, Work,
};
use anyhow::{anyhow, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
const REVISIONS: &str = "shared_skill_revision_v1";
const HEADS: &str = "shared_skill_head_v1";
const GRANTS: &str = "shared_skill_reader_v1";
const PINS: &str = "shared_skill_work_pin_v1";
const HISTORY: &str = "shared_skill_history_v1";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Publication {
    reference: RevisionRef,
    source: RevisionRef,
    content: String,
    privacy: String,
    command_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Reader {
    pub reference: RevisionRef,
    pub ghost_id: String,
    pub revision: u64,
    pub allowed: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Adoption {
    pub alias: String,
    pub reference: RevisionRef,
    pub target: Reader,
    pub evaluator: Reader,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    reference: RevisionRef,
    alias: String,
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
    raw.map(|v| serde_json::from_str(&v).map_err(Into::into))
        .transpose()
}
fn put(conn: &Connection, kind: &str, id: &str, value: &impl Serialize) -> Result<()> {
    conn.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",params![kind,id,serde_json::to_string(value)?])?;
    Ok(())
}
fn immutable(conn: &Connection, kind: &str, id: &str, value: &impl Serialize) -> Result<()> {
    let value = serde_json::to_value(value)?;
    if let Some(old) = load::<Value>(conn, kind, id)? {
        ensure!(old == value, "immutable shared skill record conflicts");
        return Ok(());
    }
    conn.execute(
        "INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3)",
        params![kind, id, serde_json::to_string(&value)?],
    )?;
    Ok(())
}
fn exact(body: &Value, fields: &[&str]) -> Result<()> {
    let o = body
        .as_object()
        .ok_or_else(|| anyhow!("shared skill body missing"))?;
    ensure!(
        o.len() == fields.len() && fields.iter().all(|f| o.contains_key(*f)),
        "unexpected shared skill fields"
    );
    Ok(())
}
fn text<'a>(body: &'a Value, key: &str) -> Result<&'a str> {
    body[key]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| anyhow!("missing shared skill {key}"))
}
fn label(v: &str) -> Result<()> {
    ensure!(
        !v.is_empty()
            && v.len() <= 64
            && v.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_'),
        "invalid shared skill name or alias"
    );
    Ok(())
}
pub(crate) fn shared(namespace: &str) -> bool {
    namespace == "common" || namespace.starts_with("project:")
}
fn namespace(v: &str) -> Result<()> {
    ensure!(
        v == "common"
            || v.strip_prefix("project:")
                .is_some_and(|v| uuid::Uuid::parse_str(v)
                    .is_ok_and(|id| !id.is_nil() && id.to_string() == v)),
        "namespace must be common or project:<canonical UUID>"
    );
    Ok(())
}
fn ref_key(r: &RevisionRef) -> Result<String> {
    r.validate()?;
    namespace(&r.namespace)?;
    label(&r.id)?;
    canonical_digest(&json!([r.namespace, r.id, r.revision, r.digest]))
}
fn reader_key(r: &RevisionRef, ghost: &str) -> Result<String> {
    Ok(format!("{}:{ghost}", ref_key(r)?))
}
fn work_key(w: &Work) -> String {
    format!("{}:{}:{}", w.id, w.goal_revision, w.owner_revision)
}
fn publication(conn: &Connection, r: &RevisionRef) -> Result<Publication> {
    let p: Publication = load(conn, REVISIONS, &ref_key(r)?)?
        .ok_or_else(|| anyhow!("shared skill revision unavailable"))?;
    ensure!(
        p.reference == *r
            && p.content.len() <= 32768
            && !p.content.is_empty()
            && format!("{:x}", Sha256::digest(p.content.as_bytes())) == r.digest
            && matches!(p.privacy.as_str(), "public" | "private" | "local_only"),
        "shared skill immutable bytes changed"
    );
    Ok(p)
}
fn reader(conn: &Connection, r: &RevisionRef, ghost: &str) -> Result<Reader> {
    publication(conn, r)?;
    let g: Reader = load(conn, GRANTS, &reader_key(r, ghost)?)?
        .ok_or_else(|| anyhow!("explicit shared skill reader grant missing"))?;
    ensure!(
        g.reference == *r && g.ghost_id == ghost && g.revision > 0 && g.allowed,
        "shared skill reader grant revoked"
    );
    Ok(g)
}
fn current(conn: &Connection, g: &Reader) -> Result<()> {
    ensure!(
        reader(conn, &g.reference, &g.ghost_id)? == *g,
        "shared skill reader grant revision changed"
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
/// Called inside the existing authenticated Owner command transaction/cache.
pub(crate) fn owner_action(
    conn: &Connection,
    state: &State,
    root: &Path,
    e: &Envelope,
) -> Result<Response> {
    ensure!(
        e.actor_ref == "owner",
        "shared skill catalogue requires authenticated Owner"
    );
    match text(&e.body, "method")? {
        "skill.catalog.publish" => {
            exact(&e.body, &["method", "namespace", "id", "source"])?;
            let ns = text(&e.body, "namespace")?;
            namespace(ns)?;
            let id = text(&e.body, "id")?;
            label(id)?;
            let source: RevisionRef = serde_json::from_value(e.body["source"].clone())?;
            source.validate()?;
            label(&source.id)?;
            let profile = state
                .profiles
                .get(&source.namespace)
                .ok_or_else(|| anyhow!("publication source Ghost missing"))?;
            let s = super::skills::list(state, &profile.id)?
                .into_iter()
                .find(|s| {
                    s.id == source.id
                        && s.revision == source.revision
                        && s.digest == source.digest
                        && s.status == "active"
                })
                .ok_or_else(|| {
                    anyhow!("publication requires the exact active immutable source revision")
                })?;
            // Existing descriptor-relative file reader refuses traversal, symlinks,
            // hardlinks and mutation during read, including ancestor components.
            let scope =
                crate::worker::scoped_tools::ScopedWorkspace::for_task(&root.canonicalize()?)?;
            let path = format!(
                "profiles/{}/skills/{}/revisions/{}/SKILL.md",
                profile.name, source.id, source.digest
            );
            let (content, digest) = scope
                .read_utf8(&path)
                .map_err(|v| anyhow!("unsafe skill archive: {}", v.code))?;
            ensure!(
                digest == source.digest && !content.is_empty() && content.len() <= 32768,
                "publication source bytes or budget changed"
            );
            let headkey = canonical_digest(&json!([ns, id]))?;
            let old: Option<RevisionRef> = load(conn, HEADS, &headkey)?;
            ensure!(
                old.as_ref().map(|r| r.revision) == e.expected_revision,
                "shared skill catalogue revision changed"
            );
            let reference = RevisionRef {
                namespace: ns.into(),
                id: id.into(),
                revision: old
                    .map(|r| {
                        r.revision
                            .checked_add(1)
                            .ok_or_else(|| anyhow!("shared revision exhausted"))
                    })
                    .transpose()?
                    .unwrap_or(1),
                digest,
            };
            let p = Publication {
                reference: reference.clone(),
                source,
                content,
                privacy: s.privacy,
                command_id: e.command_id.clone(),
            };
            immutable(conn, REVISIONS, &ref_key(&reference)?, &p)?;
            put(conn, HEADS, &headkey, &reference)?;
            Ok(success(
                "Exact skill revision published; no bot definition was changed",
                json!({"reference":reference,"source":p.source,"privacy":p.privacy}),
            ))
        }
        "skill.catalog.grant" => {
            exact(&e.body, &["method", "reference", "ghost_id", "allow"])?;
            let r: RevisionRef = serde_json::from_value(e.body["reference"].clone())?;
            publication(conn, &r)?;
            let ghost = text(&e.body, "ghost_id")?;
            ensure!(
                state.profiles.contains_key(ghost),
                "shared skill reader Ghost missing"
            );
            let allowed = e.body["allow"]
                .as_bool()
                .ok_or_else(|| anyhow!("shared reader allow must be boolean"))?;
            let key = reader_key(&r, ghost)?;
            let old: Option<Reader> = load(conn, GRANTS, &key)?;
            ensure!(
                old.as_ref().map(|g| g.revision) == e.expected_revision,
                "shared skill reader revision changed"
            );
            let g = Reader {
                reference: r,
                ghost_id: ghost.into(),
                revision: old
                    .map(|g| {
                        g.revision
                            .checked_add(1)
                            .ok_or_else(|| anyhow!("reader revision exhausted"))
                    })
                    .transpose()?
                    .unwrap_or(1),
                allowed,
            };
            put(conn, GRANTS, &key, &g)?;
            Ok(success(
                "Exact shared skill reader changed",
                json!({"reader":g}),
            ))
        }
        "skill.catalog.inspect" => {
            exact(&e.body, &["method", "reference"])?;
            let r: RevisionRef = serde_json::from_value(e.body["reference"].clone())?;
            let p = publication(conn, &r)?;
            Ok(success(
                "Immutable shared skill provenance inspected",
                json!({"reference":p.reference,"source":p.source,"privacy":p.privacy,"publication_command":p.command_id}),
            ))
        }
        _ => Err(anyhow!("unsupported shared skill catalogue method")),
    }
}
pub(crate) fn stage(
    conn: &Connection,
    c: &mut Candidate,
    body: &Value,
    previous: &Candidate,
) -> Result<()> {
    let r: Request = serde_json::from_value(body.clone())?;
    label(&r.alias)?;
    let p = publication(conn, &r.reference)?;
    // A local skill or another shared reference cannot be silently shadowed.
    let local: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspace_objects WHERE kind='skill' AND id=?1)",
        [format!("{}:{}", c.definition.ghost_id, r.alias)],
        |row| row.get(0),
    )?;
    ensure!(!local, "shared skill alias collides with a local skill");
    ensure!(
        c.definition
            .content
            .skill_refs
            .iter()
            .filter(|v| v.namespace == r.reference.namespace && v.id == r.reference.id)
            .count()
            <= 1,
        "ambiguous shared skill slot"
    );
    for (alias, reference) in &c.definition.content.skill_aliases {
        ensure!(
            *alias != r.alias
                || (reference.namespace == r.reference.namespace && reference.id == r.reference.id),
            "shared skill alias collision"
        );
    }
    let evaluator: String = conn.query_row(
        "SELECT ghost_id FROM lifetime_registry WHERE kind='primary' AND mode='active'",
        [],
        |r| r.get(0),
    )?;
    let pin = Adoption {
        alias: r.alias.clone(),
        reference: r.reference.clone(),
        target: reader(conn, &r.reference, &c.definition.ghost_id)?,
        evaluator: reader(conn, &r.reference, &evaluator)?,
    };
    if let Some(index) = c
        .definition
        .content
        .skill_refs
        .iter()
        .position(|v| v.namespace == r.reference.namespace && v.id == r.reference.id)
    {
        let old = c.definition.content.skill_refs[index].clone();
        c.definition.content.skill_aliases.retain(|_, v| v != &old);
        c.definition.content.skill_refs[index] = r.reference.clone();
        c.assets[index + 1] = Asset {
            reference: r.reference.clone(),
            content: p.content,
            privacy: p.privacy.clone(),
        };
        c.shared_skills.retain(|v| {
            v.reference.namespace != r.reference.namespace || v.reference.id != r.reference.id
        });
    } else {
        c.definition.content.skill_refs.push(r.reference.clone());
        c.assets.push(Asset {
            reference: r.reference.clone(),
            content: p.content,
            privacy: p.privacy.clone(),
        });
    }
    c.definition
        .content
        .skill_aliases
        .insert(r.alias, r.reference);
    c.shared_skills.push(pin);
    for pin in &mut c.shared_skills {
        pin.target = reader(conn, &pin.reference, &c.definition.ghost_id)?;
        pin.evaluator = reader(conn, &pin.reference, &evaluator)?;
    }
    if p.privacy == "local_only" || (p.privacy == "private" && c.privacy == "public") {
        c.privacy = p.privacy;
    }
    // Every changed adoption retains the accepted corpus and adds a distinct
    // Owner-held-out input. Exact full-content rollback has already passed
    // that evidence and still runs the current corpus through real evaluation.
    ensure!(
        previous
            .evaluation_profile
            .fixtures
            .iter()
            .all(|old| c.evaluation_profile.fixtures.contains(old)),
        "shared adoption must retain the accepted evaluation corpus"
    );
    let mut q=conn.prepare("SELECT c.payload FROM workspace_objects c JOIN workspace_objects p ON p.kind='bot_provisioning_v1' AND p.id=c.id WHERE c.kind='bot_candidate_v1' AND json_extract(c.payload,'$.definition.ghost_id')=?1 AND json_extract(p.payload,'$.state')='ready'")?;
    let historical = q
        .query_map([&c.definition.ghost_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let exact_rollback = historical
        .into_iter()
        .map(|raw| serde_json::from_str::<Candidate>(&raw))
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .any(|old| old.definition.content == c.definition.content);
    ensure!(
        exact_rollback
            || c.evaluation_profile.fixtures.iter().any(|new| !previous
                .evaluation_profile
                .fixtures
                .iter()
                .any(|old| old.input == new.input)),
        "shared adoption requires a new independent evaluation input"
    );
    candidate_current(conn, c)?;
    Ok(())
}
pub(crate) fn candidate_current(conn: &Connection, c: &Candidate) -> Result<()> {
    for reference in c
        .definition
        .content
        .skill_refs
        .iter()
        .filter(|r| shared(&r.namespace))
    {
        let pins: Vec<_> = c
            .shared_skills
            .iter()
            .filter(|v| v.reference == *reference)
            .collect();
        ensure!(
            pins.len() == 1,
            "shared skill lacks a sealed adoption lineage"
        );
        let p = pins[0];
        ensure!(
            p.target.ghost_id == c.definition.ghost_id
                && p.target.reference == *reference
                && p.evaluator.reference == *reference
                && c.definition.content.skill_aliases.get(&p.alias) == Some(reference),
            "shared skill alias or target provenance changed"
        );
        let local: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspace_objects WHERE kind='skill' AND id=?1)",
            [format!("{}:{}", c.definition.ghost_id, p.alias)],
            |row| row.get(0),
        )?;
        ensure!(!local, "shared skill alias collides with local skill");
        current(conn, &p.target)?;
        current(conn, &p.evaluator)?;
    }
    ensure!(
        c.shared_skills.len()
            == c.definition
                .content
                .skill_refs
                .iter()
                .filter(|r| shared(&r.namespace))
                .count(),
        "unexpected shared skill lineage"
    );
    Ok(())
}
pub(crate) fn prove_adoption(
    conn: &Connection,
    c: &Candidate,
    source: &super::bots::BotDefinition,
    request: &Value,
) -> Result<()> {
    let r: Request = serde_json::from_value(request.clone())?;
    ensure!(
        c.definition.content.skill_aliases.get(&r.alias) == Some(&r.reference),
        "adoption differs from its Owner source"
    );
    let mut expected_refs = source.content.skill_refs.clone();
    let mut expected_aliases = source.content.skill_aliases.clone();
    if let Some(index) = expected_refs
        .iter()
        .position(|v| v.namespace == r.reference.namespace && v.id == r.reference.id)
    {
        let old = expected_refs[index].clone();
        expected_aliases.retain(|_, v| v != &old);
        expected_refs[index] = r.reference.clone();
    } else {
        expected_refs.push(r.reference.clone());
    }
    expected_aliases.insert(r.alias.clone(), r.reference.clone());
    ensure!(
        c.definition.content.skill_refs == expected_refs
            && c.definition.content.skill_aliases == expected_aliases,
        "adoption modified unrequested skill references or aliases"
    );
    let mut restored = c.definition.content.clone();
    restored.skill_refs = source.content.skill_refs.clone();
    restored.skill_aliases = source.content.skill_aliases.clone();
    restored.acceptance_policy_ref = source.content.acceptance_policy_ref.clone();
    ensure!(
        restored == source.content,
        "adoption changed unrelated bot authority or contracts"
    );
    candidate_current(conn, c)
}
fn deps(conn: &Connection, w: &Work) -> Result<Vec<Reader>> {
    Ok(load(conn, PINS, &work_key(w))?.unwrap_or_default())
}
pub(crate) fn pin_work(conn: &Connection, w: &Work) -> Result<()> {
    // This is only called by revision-scoped admission, never by inference.
    // A history-only Ghost with no selected definition must be covered too.
    let mut references = history_for_work(conn, w)?;
    if let Some(d) = super::bots_store::definition_for_work(conn, w)? {
        for r in d
            .content
            .skill_refs
            .into_iter()
            .filter(|r| shared(&r.namespace))
        {
            if !references.contains(&r) {
                references.push(r);
            }
        }
    }
    if references.is_empty() {
        return Ok(());
    }
    let pins = references
        .iter()
        .map(|r| reader(conn, r, &w.owner))
        .collect::<Result<Vec<_>>>()?;
    immutable(conn, PINS, &work_key(w), &pins)?;
    persist_scope(conn, w)
}
pub(crate) fn pin_evaluation(conn: &Connection, c: &Candidate, w: &Work) -> Result<()> {
    candidate_current(conn, c)?;
    let mut pins = deps(conn, w)?;
    for p in &c.shared_skills {
        ensure!(
            p.evaluator.ghost_id == w.owner,
            "shared skill evaluation Ghost changed"
        );
        if !pins.contains(&p.evaluator) {
            pins.push(p.evaluator.clone());
        }
    }
    if !pins.is_empty() {
        put(conn, PINS, &work_key(w), &pins)?;
        persist_scope(conn, w)?;
    }
    Ok(())
}
pub(crate) fn work_current(conn: &Connection, w: &Work) -> Result<()> {
    for p in deps(conn, w)? {
        current(conn, &p)?;
    }
    Ok(())
}
pub(crate) fn transfer(conn: &Connection, source: &Work, target: &Work) -> Result<()> {
    work_current(conn, source)?;
    work_current(conn, target)?;
    let mut pins = deps(conn, target)?;
    for reference in source_references(conn, source)? {
        reader(conn, &reference, &source.owner)?;
        let grant = reader(conn, &reference, &target.owner)?;
        if !pins.contains(&grant) {
            pins.push(grant);
        }
    }
    if !pins.is_empty() {
        put(conn, PINS, &work_key(target), &pins)?;
        persist_scope(conn, target)?;
    }
    Ok(())
}
pub(crate) fn delegation_target(conn: &Connection, w: &Work, ghost: &str) -> Result<()> {
    work_current(conn, w)?;
    for reference in source_references(conn, w)? {
        reader(conn, &reference, &w.owner)?;
        reader(conn, &reference, ghost)?;
    }
    Ok(())
}
/// Runs before cached callback return, disclosure and every effect authorization.
pub(crate) fn request_guard(
    conn: &Connection,
    r: &PiToolRequest,
    scope: lifetime::PiInferenceScope,
) -> Result<()> {
    let body = &r.envelope.body;
    let method = body["method"].as_str().unwrap_or("");
    let isolated=lifetime::work_context::validate(conn,r)?;
    // Cancellation transfers no learned source content. The Pi ingress still
    // checks current epoch and exact owned Work/conversation before applying it.
    if method=="work.cancel" && r.context_ref.is_none() {return Ok(());}
    let history_key = canonical_digest(&json!([r.ghost_id, r.conversation_id]))?;
    let history = if let Some(work)=&isolated {deps(conn,work)?.into_iter().map(|pin|pin.reference).collect()}else{load::<Vec<RevisionRef>>(conn, HISTORY, &history_key)?.unwrap_or_default()};
    if !history.is_empty()
        && (matches!(
            method,
            "mailbox.send"
                | "memory.retain"
                | "memory.session_record"
                | "work.memory.record"
                | "bot.prepare"
                | "bot.repair"
        ) || (method.starts_with("documents.") && method != "documents.capabilities"))
    {
        return Err(anyhow!(
            "shared source dependencies cannot be discarded by this derivative path"
        ));
    }
    for reference in history {
        // Explicit regrant authorizes these same immutable history bytes. The
        // original Work grant revision remains separately and strictly fenced.
        reader(conn, &reference, &r.ghost_id)?;
    }
    if method == "inference.inspect" && scope != lifetime::PiInferenceScope::Local && isolated.is_none() {
        let key = canonical_digest(&json!([r.ghost_id, r.conversation_id]))?;
        ensure!(
            load::<String>(conn, "shared_skill_disclosure_v1", &key)?
                .unwrap_or_else(|| "public".into())
                == "public",
            "shared source history requires local inference"
        );
    }
    if method == "inference.inspect"
        && (body.get("assignment_id").is_some() || body.get("work_id").is_some())
    {
        exact(body, &["method", "assignment_id", "work_id"])?;
        let w = lifetime::pi_execution::validate_assignment(conn, r)?;
        ensure!(w.owner == r.ghost_id, "inference Work owner mismatch");
        ensure!(
            w.cancellation == "none"
                && matches!(w.state.as_str(), "queued" | "running" | "blocked"),
            "inference Work is no longer live"
        );
        if let Some(execution) = &w.execution_id {
            let current:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_pi_executions WHERE work_id=?1 AND execution_id=?2 AND assignment_id=?3 AND ghost_id=?4 AND conversation_id=?5 AND authority_epoch=?6 AND goal_revision=?7 AND state='running')",params![w.id,execution,body["assignment_id"].as_str(),r.ghost_id,r.conversation_id,r.envelope.authority_epoch,w.goal_revision],|row|row.get(0))?;
            ensure!(
                current,
                "inference original Pi execution is no longer current"
            );
        }
        work_scope(conn, &w, scope,isolated.as_ref().is_some_and(|v|v.id==w.id) || matches!(method,"work.inspect"|"work.children"|"work.cancel"))?;
        for pin in deps(conn, &w)? {
            ensure!(
                scope == lifetime::PiInferenceScope::Local
                    || publication(conn, &pin.reference)?.privacy == "public",
                "protected shared skill requires local inference"
            );
        }
        return Ok(());
    }
    let id = body
        .get("parent_work_id")
        .or_else(|| body.get("work_id"))
        .and_then(Value::as_str);
    if let Some(id) = id {
        let w: Work = serde_json::from_str(&conn.query_row(
            "SELECT payload FROM lifetime_work WHERE id=?1",
            [id],
            |v| v.get::<_, String>(0),
        )?)?;
        work_scope(conn, &w, scope,isolated.as_ref().is_some_and(|v|v.id==w.id) || matches!(method,"work.inspect"|"work.children"|"work.cancel"))?;
    }
    if let Some(goal_id) = body.get("goal_id").and_then(Value::as_str) {
        guard_goal(conn, goal_id)?;
    }
    if matches!(
        method,
        "conversation.report.inspect" | "conversation.report.reply"
    ) {
        let goal:Option<String>=conn.query_row("SELECT json_extract(payload,'$.body.goal_id') FROM lifetime_outbox WHERE target='pi' AND delivery_ref=?1",[text(body,"report_id")?],|v|v.get(0)).optional()?;
        guard_goal(
            conn,
            goal.as_deref()
                .ok_or_else(|| anyhow!("report source Goal missing"))?,
        )?;
    }
    if method == "conversation.assignment.inspect" {
        let mut q=conn.prepare("SELECT json_extract(payload,'$.body.work_id') FROM lifetime_outbox WHERE target='pi' AND delivery_ref=?1")?;
        let ids = q
            .query_map([text(body, "assignment_id")?], |v| v.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(
            ids.len() == 1,
            "shared skill assignment provenance unavailable"
        );
        let w: Work = serde_json::from_str(&conn.query_row(
            "SELECT payload FROM lifetime_work WHERE id=?1",
            [&ids[0]],
            |v| v.get::<_, String>(0),
        )?)?;
        work_scope(conn, &w, scope,isolated.as_ref().is_some_and(|v|v.id==w.id))?;
    }
    Ok(())
}

pub(crate) fn definition_current(
    conn: &Connection,
    definition: &super::bots::BotDefinition,
) -> Result<()> {
    for r in definition
        .content
        .skill_refs
        .iter()
        .filter(|r| shared(&r.namespace))
    {
        reader(conn, r, &definition.ghost_id)?;
    }
    Ok(())
}

fn guard_goal(conn: &Connection, goal: &str) -> Result<()> {
    let mut q = conn.prepare("SELECT payload FROM lifetime_work WHERE goal_id=?1")?;
    let rows = q
        .query_map([goal], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for row in rows {
        work_current(conn, &serde_json::from_str(&row)?)?;
    }
    Ok(())
}
pub(crate) fn alias_reserved(conn: &Connection, ghost: &str, alias: &str) -> Result<bool> {
    if super::bots_store::active_definition(conn, ghost)?
        .is_some_and(|d| d.content.skill_aliases.contains_key(alias))
    {
        return Ok(true);
    }
    let mut q=conn.prepare("SELECT payload FROM lifetime_work WHERE owner=?1 AND state IN ('queued','running','blocked')")?;
    let rows = q
        .query_map([ghost], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for row in rows {
        let w: Work = serde_json::from_str(&row)?;
        if super::bots_store::definition_for_work(conn, &w)?
            .is_some_and(|d| d.content.skill_aliases.contains_key(alias))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn privacy(conn: &Connection, w: &Work) -> Result<String> {
    let mut value = "public";
    for pin in deps(conn, w)? {
        let p = publication(conn, &pin.reference)?;
        if p.privacy == "local_only" {
            return Ok(p.privacy);
        }
        if p.privacy == "private" {
            value = "private";
        }
    }
    Ok(value.into())
}

fn work_scope(conn: &Connection, w: &Work, scope: lifetime::PiInferenceScope, isolated:bool) -> Result<()> {
    work_current(conn, w)?;
    let pinned = deps(conn, w)?;
    ensure!(isolated || history_for_work(conn,w)?.iter().all(|r|pinned.iter().any(|pin|pin.reference==*r)),"shared history changed outside the original Work pins; explicit source transfer or new Work required");
    ensure!(
        scope == lifetime::PiInferenceScope::Local || privacy(conn, w)? == "public",
        "protected shared source requires local scope"
    );
    Ok(())
}

fn persist_scope(conn: &Connection, w: &Work) -> Result<()> {
    let (ghost, conversation): (String, String) = conn.query_row(
        "SELECT accountable_ghost,reply_conversation FROM lifetime_goals WHERE id=?1",
        [&w.goal_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    ensure!(
        ghost == w.owner,
        "shared source Work has no exact originating Pi conversation"
    );
    let key = canonical_digest(&json!([ghost, conversation]))?;
    let mut history: Vec<RevisionRef> = load(conn, HISTORY, &key)?.unwrap_or_default();
    for pin in deps(conn, w)? {
        if !history.contains(&pin.reference) {
            history.push(pin.reference);
        }
    }
    if !history.is_empty() {
        put(conn, HISTORY, &key, &history)?;
    }
    let classification = privacy(conn, w)?;
    if classification == "public" {
        return Ok(());
    }
    lifetime::persist_work_disclosure(conn, w, &classification)?;
    let old: Option<String> = load(conn, "shared_skill_disclosure_v1", &key)?;
    let joined = if old.as_deref() == Some("local_only") || classification == "local_only" {
        "local_only"
    } else {
        "private"
    };
    put(conn, "shared_skill_disclosure_v1", &key, &joined)
}

fn history_for_work(conn: &Connection, w: &Work) -> Result<Vec<RevisionRef>> {
    let (ghost, conversation): (String, String) = conn.query_row(
        "SELECT accountable_ghost,reply_conversation FROM lifetime_goals WHERE id=?1",
        [&w.goal_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    // Historical reassigned non-Pi Work can retain its old contract. Shared
    // source transfer never guesses another owner's originating conversation.
    if ghost != w.owner {
        ensure!(
            deps(conn, w)?.is_empty(),
            "shared Work source owner differs"
        );
        return Ok(vec![]);
    }
    let key = canonical_digest(&json!([ghost, conversation]))?;
    Ok(load(conn, HISTORY, &key)?.unwrap_or_default())
}
fn source_references(conn: &Connection, w: &Work) -> Result<Vec<RevisionRef>> {
    let mut refs = if lifetime::work_context::is_claimed(conn,w)? {vec![]}else{history_for_work(conn, w)?};
    for pin in deps(conn, w)? {
        if !refs.contains(&pin.reference) {
            refs.push(pin.reference);
        }
    }
    Ok(refs)
}
