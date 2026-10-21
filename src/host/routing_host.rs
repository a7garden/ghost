//! Trusted binding for owner control and scoped SDK router callers.
//! Admission and execution share root-journal identities and current authority.
use super::{now_ms, services::Bridge, work_routing::*, Host, State};
use crate::{
    control::api::{Action, Command, RoutingAction, RoutingEntry, RoutingPermissions},
    domain::{Delegation, Policy},
    durable::durable::{Task, TaskKind},
};
use anyhow::{anyhow, ensure, Result};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{atomic::Ordering, Arc},
};
const SHARE: &str = "routing_share_v1";
const NATURAL_CONTEXT: &str = "routing_natural_context_v1";
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct NaturalContext {
    resolves: Vec<ResolutionRef>,
    clarification_target: Option<Target>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoutingShare {
    pub schema: u32,
    pub id: String,
    pub version: u64,
    pub source: RoutingEntry,
    pub recipient: RoutingEntry,
    pub permissions: RoutingPermissions,
    pub enabled: bool,
    pub delegation_id: Option<String>,
}
/// This is not a control-plane caller switch. The host receives an actual runtime
/// Task and installed profile identity separately from these untrusted arguments.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ModelRoutingAction {
    Input {},
    Candidates {
        query: String,
        limit: usize,
    },
    Work {
        work_id: String,
    },
    Decisions {
        work_id: String,
    },
    Receipt {
        source: RoutingEntry,
        message_id: String,
    },
    Admit {
        segments: Vec<Segment>,
        #[serde(default)]
        resolves: Vec<ResolutionRef>,
        proposal: RoutingProposal,
    },
}
pub fn capability() -> Value {
    json!({"schema":"ghost-routing-host/1","admission":true,"clarification_resolution":true,
        "runtime_dispatch":true,"effect_fence":true,"verified_completion_report":true,
        "model_router":true,"model_tool_registration":true,"entry_view":true,
        "verification_scope":"observed_local_effects","external_mutation_dispatch":false,
        "immutable_evidence":true,"unsupported_bound_mutation_tools":["shell","integration_call","memory_retain","memory_session_record","planner_mutation","browser_mutation","code_worker"]})
}
/// Owner control only. Uses canonical receipts and their current visibility;
/// no transcript cache or model caller switch. Pages are ordered by immutable
/// admission creation time plus ID, so retries and concurrent new admissions
/// cannot skip previously existing history.
fn owner_view(s: &State, a: &Access<'_>, limit: usize, before: Option<&str>) -> Result<Value> {
    ensure!(a.owner_control, RoutingErrorCode::OriginUnavailable);
    ensure!((1..=50).contains(&limit), "invalid view limit");
    let epoch = a.revision();
    let mut admissions: Vec<Admission> = s.journal.objects("routing_admission_v2")?;
    admissions
        .retain(|r| r.input.origin.owner_id == a.owner && entry_of(&r.input.origin) == a.entry);
    admissions.sort_by(|x, y| y.created_ms.cmp(&x.created_ms).then(y.id.cmp(&x.id)));
    if let Some(id) = before {
        uuid::Uuid::parse_str(id)?;
        let position = admissions
            .iter()
            .position(|r| r.id == id)
            .ok_or_else(|| anyhow!(RoutingErrorCode::OriginUnavailable))?;
        admissions.drain(..=position);
    }
    let has_more = admissions.len() > limit;
    admissions.truncate(limit);
    let next = has_more.then(|| admissions.last().unwrap().id.clone());
    let mut views = Vec::new();
    let mut ids = BTreeSet::new();
    for r in admissions {
        let view = s
            .journal
            .routing_receipt(a, &r.input.origin)?
            .ok_or_else(|| anyhow!(RoutingErrorCode::OriginUnavailable))?;
        for item in &view.admission.items {
            if let Some(id) = &item.work_id {
                ids.insert(id.clone());
            }
            if let Operation::Clarify { candidates, .. } = &item.operation {
                ids.extend(candidates.iter().map(|target| target.work_id.clone()));
            }
        }
        views.push(view);
    }
    let mut works = Vec::new();
    let mut decisions = Vec::new();
    for id in ids {
        works.push(s.journal.routing_work(a, &id)?);
        decisions.extend(s.journal.routing_decisions(a, &id)?);
    }
    ensure!(a.revision() == epoch, RoutingErrorCode::AuthorityChanged);
    Ok(json!({"schema":"ghost-routing-view/1", "works":works,
        "decisions":decisions,"admissions":views,"next_before_admission_id":next}))
}
fn reply(result: Result<Value>) -> Value {
    match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(error) => json!({"ok":false,"error":error.to_string(),
            "error_code":error.downcast_ref::<RoutingErrorCode>().map(|c|serde_json::to_value(c).unwrap())}),
    }
}
fn natural_context(s: &State, a: &Access<'_>) -> Result<(NaturalContext, Vec<Value>)> {
    let context = s
        .journal
        .get::<NaturalContext>(NATURAL_CONTEXT, &a.message)?
        .unwrap_or_default();
    let accepted = s
        .journal
        .routing_receipt(a, &origin(&a.owner, &a.entry, &a.message))?;
    let mut held = Vec::new();
    for r in &context.resolves {
        let admission = s
            .journal
            .get::<Admission>("routing_admission_v2", &r.source_admission_id)?
            .ok_or_else(|| anyhow!(RoutingErrorCode::OriginUnavailable))?;
        ensure!(
            admission.input_hash == r.expected_input_hash,
            RoutingErrorCode::InputCollision
        );
        ensure!(
            a.may_resolve_clarification(&admission, &r.source_segment_id),
            RoutingErrorCode::OriginUnavailable
        );
        let view = s
            .journal
            .routing_receipt(a, &admission.input.origin)?
            .ok_or_else(|| anyhow!(RoutingErrorCode::OriginUnavailable))?;
        ensure!(
            view.resolutions
                .iter()
                .all(|v| v.source_segment_id != r.source_segment_id
                    || accepted
                        .as_ref()
                        .is_some_and(|own| own.admission.id == v.answer_admission_id)),
            RoutingErrorCode::ClarificationAlreadyAnswered
        );
        let item = admission
            .items
            .iter()
            .find(|i| i.segment_id == r.source_segment_id)
            .ok_or_else(|| anyhow!(RoutingErrorCode::OriginUnavailable))?;
        ensure!(
            matches!(item.operation, Operation::Clarify { .. }),
            RoutingErrorCode::OriginUnavailable
        );
        held.push(json!({"reference":r,"source":view}));
    }
    if let Some(target) = &context.clarification_target {
        ensure!(
            !context.resolves.is_empty(),
            "clarification target requires linked question"
        );
        let work = s.journal.routing_work(a, &target.work_id)?;
        ensure!(
            accepted.is_some() || work.target() == *target,
            RoutingErrorCode::RevisionConflict
        );
    }
    Ok((context, held))
}
fn workspace_id(s: &State) -> Result<String> {
    s.journal
        .get("meta", "workspace_id")?
        .ok_or_else(|| anyhow!(RoutingErrorCode::OriginUnavailable))
}
fn checked_entry(s: &State, entry: &RoutingEntry) -> Result<RoutingEntry> {
    let p = s
        .profiles
        .get(&entry.profile_id)
        .ok_or_else(|| anyhow!(RoutingErrorCode::OriginUnavailable))?;
    ensure!(p.error.is_none(), RoutingErrorCode::OriginUnavailable);
    let snapshot = p.runtime.session.committed()?;
    let c = snapshot
        .conversations
        .get(&entry.conversation_id)
        .ok_or_else(|| anyhow!(RoutingErrorCode::OriginUnavailable))?;
    Ok(RoutingEntry {
        profile_id: p.id.clone(),
        conversation_id: c.id.clone(),
    })
}
fn origin(owner: &str, entry: &RoutingEntry, message: &str) -> Origin {
    Origin {
        owner_id: owner.into(),
        entry_profile_id: entry.profile_id.clone(),
        conversation_id: entry.conversation_id.clone(),
        message_id: message.into(),
    }
}
fn entry_of(origin: &Origin) -> RoutingEntry {
    RoutingEntry {
        profile_id: origin.entry_profile_id.clone(),
        conversation_id: origin.conversation_id.clone(),
    }
}
fn policy(s: &State, profile: &str) -> Result<Policy> {
    Ok(s.journal.get("policy", profile)?.unwrap_or_default())
}
/// Root state serializes profile availability, policies, grants and lineage.
/// General SDK progress is not an authority revision. Scoped callers separately
/// pin only the actual runtime tasks on which their authority depends.
fn epoch(s: &State) -> Result<String> {
    let profiles = s
        .profiles
        .values()
        .map(|p| (p.id.clone(), p.error.clone()))
        .collect::<Vec<_>>();
    let policies: Vec<(String, Policy)> = s
        .profiles
        .keys()
        .map(|id| Ok((id.clone(), policy(s, id)?)))
        .collect::<Result<_>>()?;
    let shares: Vec<RoutingShare> = s.journal.objects(SHARE)?;
    let lineage: Vec<Delegation> = s.journal.objects("delegation")?;
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(profiles, policies, shares, lineage))?)
    ))
}
struct Access<'a> {
    state: &'a State,
    owner: String,
    entry: RoutingEntry,
    message: String,
    owner_control: bool,
    scopes: BTreeMap<RoutingEntry, RoutingPermissions>,
    assignees: BTreeSet<String>,
    runtime_proof: Vec<(String, Task)>,
}
impl Access<'_> {
    fn proof_current(&self) -> bool {
        self.runtime_proof.iter().all(|(profile, expected)| {
            self.state
                .profiles
                .get(profile)
                .and_then(|p| p.runtime.session.committed().ok())
                .and_then(|snapshot| snapshot.tasks.get(&expected.id).cloned())
                .is_some_and(|actual| {
                    serde_json::to_value(actual).ok() == serde_json::to_value(expected).ok()
                })
        })
    }
}
impl RoutingAccess for Access<'_> {
    fn owner_id(&self) -> &str {
        &self.owner
    }
    fn revision(&self) -> String {
        if !self.proof_current() {
            return "authority-unavailable".into();
        }
        epoch(self.state).unwrap_or_else(|_| "authority-unavailable".into())
    }
    fn accepts_origin(&self, o: &Origin) -> bool {
        self.proof_current()
            && o.owner_id == self.owner
            && entry_of(o) == self.entry
            && o.message_id == self.message
    }
    fn may_read_origin(&self, o: &Origin) -> bool {
        self.proof_current()
            && o.owner_id == self.owner
            && checked_entry(self.state, &entry_of(o)).is_ok()
            && (self.owner_control
                || self
                    .scopes
                    .get(&entry_of(o))
                    .is_some_and(|p| p.read_content))
    }
    fn may_read_receipt_content(&self, r: &Admission) -> bool {
        self.may_read_origin(&r.input.origin)
    }
    fn may_resolve_clarification(&self, r: &Admission, _: &str) -> bool {
        self.may_read_origin(&r.input.origin)
            && (self.owner_control
                || self
                    .scopes
                    .get(&entry_of(&r.input.origin))
                    .is_some_and(|p| p.resolve_clarification))
    }
    fn may_create(&self) -> bool {
        self.proof_current()
    }
    fn may_assign(&self, p: &str) -> bool {
        self.proof_current() && self.assignees.contains(p)
    }
    fn may_read(&self, w: &Work) -> bool {
        self.proof_current()
            && w.owner_id == self.owner
            && checked_entry(self.state, &entry_of(&w.origin)).is_ok()
            && (self.owner_control
                || self
                    .scopes
                    .get(&entry_of(&w.origin))
                    .is_some_and(|p| p.read_work))
    }
    fn may_change(&self, w: &Work) -> bool {
        self.may_read(w)
            && (self.owner_control
                || self
                    .scopes
                    .get(&entry_of(&w.origin))
                    .is_some_and(|p| p.change_work))
    }
}
fn owner_access<'a>(s: &'a State, entry: &RoutingEntry, message: &str) -> Result<Access<'a>> {
    Ok(Access {
        state: s,
        owner: workspace_id(s)?,
        entry: checked_entry(s, entry)?,
        message: message.into(),
        owner_control: true,
        runtime_proof: Vec::new(),
        scopes: BTreeMap::new(),
        assignees: s
            .profiles
            .values()
            .filter(|p| p.error.is_none())
            .map(|p| p.id.clone())
            .collect(),
    })
}
fn scopes_for(
    s: &State,
    entry: &RoutingEntry,
    records: &[Delegation],
    lineage: &BTreeSet<String>,
    shares: &[RoutingShare],
) -> Result<BTreeMap<RoutingEntry, RoutingPermissions>> {
    let mut scopes = BTreeMap::from([(
        entry.clone(),
        RoutingPermissions {
            read_work: true,
            change_work: true,
            read_content: true,
            resolve_clarification: true,
        },
    )]);
    for share in shares {
        if share.schema != 1
            || !share.enabled
            || &share.recipient != entry
            || checked_entry(s, &share.source).is_err()
            || !policy(s, &share.source.profile_id)?.delegation
        {
            continue;
        }
        if let Some(id) = &share.delegation_id {
            let Some(d) = records.iter().find(|d| &d.id == id) else {
                continue;
            };
            if !lineage.contains(id)
                || d.target != entry.profile_id
                || d.conversation_id != entry.conversation_id
                || d.owner != share.source.profile_id
            {
                continue;
            }
            let source_snap = s.profiles[&d.owner].runtime.session.committed()?;
            if source_snap
                .tasks
                .get(&d.owner_task)
                .is_none_or(|t| t.conversation_id != share.source.conversation_id)
            {
                continue;
            }
        }
        let p = scopes.entry(share.source.clone()).or_default();
        p.read_work |= share.permissions.read_work;
        p.change_work |= share.permissions.change_work;
        p.read_content |= share.permissions.read_content;
        p.resolve_clarification |= share.permissions.resolve_clarification;
    }
    Ok(scopes)
}

/// Validate the existing committed delegation chain; a lineage itself does not
/// grant private transcript visibility. Explicit routing_share is also required.
fn model_access<'a>(s: &'a State, identity: &str, task: &Task) -> Result<(Access<'a>, String)> {
    let before = epoch(s)?;
    let entry = checked_entry(
        s,
        &RoutingEntry {
            profile_id: identity.into(),
            conversation_id: task.conversation_id.clone(),
        },
    )?;
    let snap = s.profiles[identity].runtime.session.committed()?;
    let actual = snap
        .tasks
        .get(&task.id)
        .ok_or_else(|| anyhow!(RoutingErrorCode::OriginUnavailable))?;
    // Runtime passes the pre-intent Task to Host::execute while its committed
    // phase/plan has advanced. Compare immutable identity/call, use current state.
    let same_call = match (&actual.kind, &task.kind) {
        (TaskKind::Tool { call: current, .. }, TaskKind::Tool { call: supplied, .. }) => {
            serde_json::to_vec(current)? == serde_json::to_vec(supplied)?
        }
        (TaskKind::Generation { .. }, TaskKind::Generation { .. }) => true,
        _ => false,
    };
    ensure!(
        !actual.phase.terminal()
            && same_call
            && actual.conversation_id == task.conversation_id
            && actual.parent_id == task.parent_id
            && actual.ordinal == task.ordinal
            && actual.background == task.background,
        RoutingErrorCode::OriginUnavailable
    );
    // A Work descendant's model-generated prompt is execution context, not a
    // new owner input. Do not let it detach fresh Work from its owning lineage.
    ensure!(
        super::routing_dispatch::fence_current(s, identity, actual)
            .map_err(|_| anyhow!(RoutingErrorCode::OriginUnavailable))?
            .is_none(),
        RoutingErrorCode::OriginUnavailable
    );
    Bridge::authority_in(s, identity, actual, None)
        .map_err(|_| anyhow!(RoutingErrorCode::OriginUnavailable))?;
    let mut cursor = actual;
    let mut task_ids = BTreeSet::new();
    let submission = loop {
        ensure!(
            task_ids.len() < 64 && task_ids.insert(cursor.id.clone()),
            RoutingErrorCode::OriginUnavailable
        );
        if let Some(input) = snap
            .submissions
            .iter()
            .find(|i| i.task_id == cursor.id && i.conversation_id == entry.conversation_id)
        {
            break input;
        }
        cursor = snap
            .tasks
            .get(
                cursor
                    .parent_id
                    .as_deref()
                    .ok_or_else(|| anyhow!(RoutingErrorCode::OriginUnavailable))?,
            )
            .ok_or_else(|| anyhow!(RoutingErrorCode::OriginUnavailable))?;
        ensure!(
            cursor.conversation_id == entry.conversation_id,
            RoutingErrorCode::OriginUnavailable
        );
    };
    let mut runtime_proof = task_ids
        .iter()
        .map(|id| (identity.to_string(), snap.tasks[id].clone()))
        .collect::<Vec<_>>();
    let records: Vec<Delegation> = s.journal.objects("delegation")?;
    let mut lineage = BTreeSet::new();
    let mut current = entry.clone();
    let mut ancestors = vec![entry.clone()];
    let mut identities = BTreeSet::from([identity.to_string()]);
    loop {
        let matching = records
            .iter()
            .filter(|d| {
                d.target == current.profile_id && d.conversation_id == current.conversation_id
            })
            .collect::<Vec<_>>();
        ensure!(matching.len() <= 1, RoutingErrorCode::OriginUnavailable);
        let Some(d) = matching.first() else { break };
        ensure!(
            identities.len() < 8
                && identities.insert(d.owner.clone())
                && matches!(d.state.as_str(), "starting" | "running"),
            RoutingErrorCode::OriginUnavailable
        );
        let source = s
            .profiles
            .get(&d.owner)
            .ok_or_else(|| anyhow!(RoutingErrorCode::OriginUnavailable))?;
        ensure!(
            source.error.is_none() && policy(s, &d.owner)?.delegation,
            RoutingErrorCode::OriginUnavailable
        );
        let source_snap = source.runtime.session.committed()?;
        let source_task = source_snap
            .tasks
            .get(&d.owner_task)
            .ok_or_else(|| anyhow!(RoutingErrorCode::OriginUnavailable))?;
        ensure!(
            !matches!(
                source_task.phase,
                crate::durable::durable::Phase::Cancelled
                    | crate::durable::durable::Phase::Failed
                    | crate::durable::durable::Phase::Uncertain
            ) && (d.background || !source_task.phase.terminal()),
            RoutingErrorCode::OriginUnavailable
        );
        // A committed host delegation must originate in an actual delegate tool.
        let TaskKind::Tool { call, .. } = &source_task.kind else {
            return Err(anyhow!(RoutingErrorCode::OriginUnavailable));
        };
        ensure!(
            call.name == "delegate_ghost"
                && call.arguments["background"].as_bool().unwrap_or(false) == d.background
                && call.arguments["profile_id"].as_str() == Some(current.profile_id.as_str()),
            RoutingErrorCode::OriginUnavailable
        );
        let target_snap = s.profiles[&current.profile_id]
            .runtime
            .session
            .committed()?;
        ensure!(
            target_snap.submissions.iter().any(|i| i.request_id == d.id
                && i.task_id == d.task_id
                && i.conversation_id == d.conversation_id
                && call.arguments["prompt"].as_str() == Some(i.text.as_str())),
            RoutingErrorCode::OriginUnavailable
        );
        runtime_proof.push((d.owner.clone(), source_task.clone()));
        lineage.insert(d.id.clone());
        current = checked_entry(
            s,
            &RoutingEntry {
                profile_id: d.owner.clone(),
                conversation_id: source_task.conversation_id.clone(),
            },
        )?;
        ancestors.push(current.clone());
    }
    let shares = s.journal.objects::<RoutingShare>(SHARE)?;
    let mut scopes = scopes_for(s, &entry, &records, &lineage, &shares)?;
    // Explicit receiver grants do not widen a delegated sender's current scope.
    // Own input/work in this dedicated receiving conversation remains local;
    // every cross-origin operation intersects all actual ancestor permissions.
    for ancestor in ancestors.iter().skip(1) {
        let sender = scopes_for(s, ancestor, &records, &lineage, &shares)?;
        for (source, p) in &mut scopes {
            if source == &entry {
                continue;
            }
            let allowed = sender.get(source).cloned().unwrap_or_default();
            p.read_work &= allowed.read_work;
            p.change_work &= allowed.change_work;
            p.read_content &= allowed.read_content;
            p.resolve_clarification &= allowed.resolve_clarification;
        }
    }
    let assignees = if policy(s, identity)?.delegation {
        s.profiles
            .values()
            .filter(|p| p.error.is_none())
            .map(|p| p.id.clone())
            .collect()
    } else {
        BTreeSet::from([identity.to_string()])
    };
    ensure!(before == epoch(s)?, RoutingErrorCode::AuthorityChanged);
    Ok((
        Access {
            state: s,
            owner: workspace_id(s)?,
            entry,
            message: submission.request_id.clone(),
            owner_control: false,
            runtime_proof,
            scopes,
            assignees,
        },
        submission.text.clone(),
    ))
}
impl Host {
    /// Called only with the runtime's Task/profile binding, never via a caller
    /// selector in the owner control JSON. Tool registration is a later gate.
    pub fn routing_for_model(
        &self,
        identity: &str,
        task: &Task,
        action: ModelRoutingAction,
    ) -> Value {
        reply((|| {
            ensure!(
                !self.stopping.load(Ordering::Acquire),
                "Ghost host is stopping"
            );
            let s = self.lock()?;
            let (a, text) = model_access(&s, identity, task)?;
            let (context, held) = natural_context(&s, &a)?;
            match action {
                ModelRoutingAction::Input {} => Ok(json!({
                    "text":text,
                    "message_id":a.message,
                    "utf8_byte_length":text.len(),
                    "byte_boundaries":text.char_indices().map(|(i,_)|i).chain(std::iter::once(text.len())).collect::<Vec<_>>(),
                    "char_spans":text.char_indices().map(|(start,ch)|json!({"text":ch.to_string(),"start_byte":start,"end_byte":start+ch.len_utf8()})).collect::<Vec<_>>(),
                    "expected_resolves":context.resolves,
                    "clarification_target":context.clarification_target,
                    "held_clarifications":held,
                    "assignees":a.assignees.iter().filter_map(|id|s.profiles.get(id)).map(|p|json!({"profile_id":p.id,"name":p.name,"persona":p.persona})).collect::<Vec<_>>()
                })),
                ModelRoutingAction::Candidates { query, limit } => Ok(serde_json::to_value(
                    s.journal.routing_candidates(&a, &query, limit)?,
                )?),
                ModelRoutingAction::Work { work_id } => {
                    Ok(serde_json::to_value(s.journal.routing_work(&a, &work_id)?)?)
                }
                ModelRoutingAction::Decisions { work_id } => Ok(serde_json::to_value(
                    s.journal.routing_decisions(&a, &work_id)?,
                )?),
                ModelRoutingAction::Receipt { source, message_id } => Ok(serde_json::to_value(
                    s.journal
                        .routing_receipt(&a, &origin(&a.owner, &source, &message_id))?,
                )?),
                ModelRoutingAction::Admit {
                    segments,
                    resolves,
                    proposal,
                } => {
                    if !context.resolves.is_empty() {
                        ensure!(
                            serde_json::to_value(&resolves)?
                                == serde_json::to_value(&context.resolves)?,
                            RoutingErrorCode::InputCollision
                        );
                        if let Some(selected) = context.clarification_target {
                            ensure!(
                                proposal
                                    .items
                                    .iter()
                                    .filter(|item| {
                                        context.resolves.iter().any(|reference| {
                                            item.segment_id == reference.answer_segment_id
                                                || item
                                                    .additional_segment_ids
                                                    .contains(&reference.answer_segment_id)
                                        })
                                    })
                                    .all(|item| match &item.operation {
                                        Operation::Amend { target, .. }
                                        | Operation::Continue { target }
                                        | Operation::Cancel { target }
                                        | Operation::Question {
                                            target: Some(target),
                                        } => target == &selected,
                                        _ => false,
                                    }),
                                RoutingErrorCode::InputCollision
                            );
                        }
                    }
                    let input = RoutingInput {
                        schema: INPUT_SCHEMA.into(),
                        origin: origin(&a.owner, &a.entry, &a.message),
                        text,
                        segments,
                        resolves,
                    };
                    Ok(serde_json::to_value(s.journal.admit_routing(
                        &a,
                        &input,
                        &proposal,
                        now_ms(),
                    )?)?)
                }
            }
        })())
    }
}
/// Routing control commands have a special recovery boundary: replay is safe
/// only for this effect-free admission, and revalidates committed visibility.
/// Existing commands' interruption behavior is unchanged.
pub(crate) fn owner_action(host: &Arc<Host>, action: &Action) -> Result<Value> {
    let mutation = matches!(
        &action.command,
        Command::Routing {
            action: RoutingAction::RoutingAdmit { .. }
                | RoutingAction::RoutingShareAccess { .. }
                | RoutingAction::RoutingNatural { .. }
        }
    );
    let result = (|| {
        ensure!(
            !host.stopping.load(Ordering::Acquire),
            "Ghost host is stopping"
        );
        uuid::Uuid::parse_str(&action.request_id)?;
        let s = host.lock()?;
        let Command::Routing { action: r } = &action.command else {
            unreachable!()
        };
        match r {
            RoutingAction::RoutingCapability => Ok(capability()),
            RoutingAction::RoutingView {
                entry,
                limit,
                before_admission_id,
            } => {
                let a = owner_access(&s, entry, &action.request_id)?;
                owner_view(&s, &a, *limit, before_admission_id.as_deref())
            }
            RoutingAction::RoutingResults { entry } => {
                owner_access(&s, entry, &action.request_id)?;
                super::routing_dispatch::owner_results(&s)
            }
            RoutingAction::RoutingNatural {
                entry,
                text,
                kind,
                resolves,
                clarification_target,
            } => {
                owner_access(&s, entry, &action.request_id)?;
                super::text(text, 8192)?;
                ensure!(matches!(kind,crate::durable::durable::InputKind::Prompt | crate::durable::durable::InputKind::FollowUp),"routing natural input must be prompt or follow_up; steering is a separate running-task operation");
                let payload = serde_json::to_string(&serde_json::to_value(&action.command)?)?;
                let old: Option<(String, Option<String>)> = s
                    .journal
                    .0
                    .query_row(
                        "SELECT payload,response FROM workspace_commands WHERE id=?1",
                        [&action.request_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                if let Some((saved, response)) = old {
                    ensure!(saved == payload, RoutingErrorCode::InputCollision);
                    if let Some(response) = response {
                        return Ok(serde_json::from_str::<Value>(&response)?);
                    }
                } else {
                    s.journal.begin(&action.request_id, &payload)?;
                }
                let outcome = (|| {
                    let context = NaturalContext {
                        resolves: resolves.clone(),
                        clarification_target: clarification_target.clone(),
                    };
                    s.journal
                        .put(NATURAL_CONTEXT, &action.request_id, &context)?;
                    let access = owner_access(&s, entry, &action.request_id)?;
                    natural_context(&s, &access)?;
                    let profile = &s.profiles[&entry.profile_id];
                    let snapshot = profile.runtime.session.committed()?;
                    if let Some(input) = snapshot
                        .submissions
                        .iter()
                        .find(|input| input.request_id == action.request_id)
                    {
                        ensure!(
                            input.conversation_id == entry.conversation_id
                                && input.text == *text
                                && input.kind == *kind,
                            RoutingErrorCode::InputCollision
                        );
                        return Ok(json!({"submission":input,"routing_pending":true}));
                    }
                    super::models::prepare_conversation(
                        &s,
                        &entry.profile_id,
                        &entry.conversation_id,
                        *kind,
                    )?;
                    let snapshot = profile.runtime.session.committed()?;
                    let mut config = snapshot
                        .conversations
                        .get(&entry.conversation_id)
                        .ok_or_else(|| anyhow!(RoutingErrorCode::OriginUnavailable))?
                        .config
                        .clone();
                    if !config.tools.iter().any(|tool| tool.name == "route_work") {
                        super::routing_model::configure(&mut config);
                        profile
                            .runtime
                            .session
                            .set_config(&entry.conversation_id, config)?;
                    }
                    let input = profile.runtime.session.submit(
                        &entry.conversation_id,
                        &action.request_id,
                        *kind,
                        text,
                    )?;
                    Ok(json!({"submission":input,"routing_pending":true}))
                })();
                let value = reply(outcome);
                s.journal.finish(&action.request_id, &value)?;
                Ok(value)
            }
            RoutingAction::RoutingCandidates {
                entry,
                query,
                limit,
            } => {
                let a = owner_access(&s, entry, &action.request_id)?;
                Ok(serde_json::to_value(
                    s.journal.routing_candidates(&a, query, *limit)?,
                )?)
            }
            RoutingAction::RoutingWork { entry, work_id } => {
                let a = owner_access(&s, entry, &action.request_id)?;
                Ok(serde_json::to_value(s.journal.routing_work(&a, work_id)?)?)
            }
            RoutingAction::RoutingDecisions { entry, work_id } => {
                let a = owner_access(&s, entry, &action.request_id)?;
                Ok(serde_json::to_value(
                    s.journal.routing_decisions(&a, work_id)?,
                )?)
            }
            RoutingAction::RoutingReceipt { entry, message_id } => {
                let a = owner_access(&s, entry, &action.request_id)?;
                Ok(serde_json::to_value(s.journal.routing_receipt(
                    &a,
                    &origin(&a.owner, &a.entry, message_id),
                )?)?)
            }
            RoutingAction::RoutingAdmit {
                entry,
                text,
                segments,
                resolves,
                proposal,
            } => {
                let a = owner_access(&s, entry, &action.request_id)?;
                let payload = serde_json::to_string(&serde_json::to_value(&action.command)?)?;
                ensure!(payload.len() <= 1_048_576, "command size limit");
                let saved: Option<(String, Option<String>)> = s
                    .journal
                    .0
                    .query_row(
                        "SELECT payload,response FROM workspace_commands WHERE id=?1",
                        [&action.request_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                if let Some((saved, response)) = saved {
                    ensure!(saved == payload, RoutingErrorCode::InputCollision);
                    if let Some(response) = response {
                        let previous: Value = serde_json::from_str(&response)?;
                        // A recorded rejection is an immutable command outcome.
                        // Corrected proposals use a new owner message/request UUID.
                        if previous["ok"] == false {
                            return Ok(previous);
                        }
                    }
                } else {
                    s.journal.begin(&action.request_id, &payload)?;
                }
                let input = RoutingInput {
                    schema: INPUT_SCHEMA.into(),
                    origin: origin(&a.owner, &a.entry, &action.request_id),
                    text: text.clone(),
                    segments: segments.clone(),
                    resolves: resolves.clone(),
                };
                fixture_gate(host, &action.request_id, "after_command_begin")?;
                let result = s
                    .journal
                    .admit_routing(&a, &input, proposal, now_ms())
                    .and_then(|v| Ok(serde_json::to_value(v)?));
                let value = reply(result);
                if value["ok"] == true {
                    fixture_gate(host, &action.request_id, "after_admission_commit")?;
                }
                s.journal.finish(&action.request_id, &value)?;
                // Already enveloped: the outer reply below must not double-wrap.
                Ok(value)
            }
            RoutingAction::RoutingShareAccess {
                id,
                expected_version,
                source,
                recipient,
                permissions,
                enabled,
                delegation_id,
            } => {
                checked_entry(&s, source)?;
                checked_entry(&s, recipient)?;
                ensure!(source != recipient, "self sharing is unnecessary");
                let payload = serde_json::to_string(&serde_json::to_value(&action.command)?)?;
                ensure!(payload.len() <= 1_048_576, "command size limit");
                let tx = Transaction::new_unchecked(&s.journal.0, TransactionBehavior::Immediate)?;
                let old: Option<(String, Option<String>)> = tx
                    .query_row(
                        "SELECT payload,response FROM workspace_commands WHERE id=?1",
                        [&action.request_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                if let Some((old, response)) = old {
                    ensure!(old == payload, RoutingErrorCode::InputCollision);
                    if let Some(response) = response {
                        return Ok(serde_json::from_str::<Value>(&response)?);
                    }
                    return Err(anyhow!(
                        "routing share command interrupted; inspect current share version"
                    ));
                }
                let share_id = id.as_deref().unwrap_or(&action.request_id);
                uuid::Uuid::parse_str(share_id)?;
                let old: Option<String> = tx
                    .query_row(
                        "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
                        params![SHARE, share_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let previous = old
                    .map(|s| serde_json::from_str::<RoutingShare>(&s))
                    .transpose()?;
                ensure!(
                    previous.as_ref().map(|s| s.version) == *expected_version,
                    RoutingErrorCode::RevisionConflict
                );
                ensure!(
                    id.is_some() == previous.is_some(),
                    RoutingErrorCode::RevisionConflict
                );
                let version = previous.as_ref().map_or(Ok(1), |s| {
                    s.version
                        .checked_add(1)
                        .ok_or_else(|| anyhow!("share version overflow"))
                })?;
                let share = RoutingShare {
                    schema: 1,
                    id: share_id.into(),
                    version,
                    source: source.clone(),
                    recipient: recipient.clone(),
                    permissions: permissions.clone(),
                    enabled: *enabled,
                    delegation_id: delegation_id.clone(),
                };
                let value = reply(Ok(serde_json::to_value(&share)?));
                tx.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",params![SHARE,share.id,serde_json::to_string(&share)?])?;
                tx.execute(
                    "INSERT INTO workspace_commands(id,payload,response) VALUES(?1,?2,?3)",
                    params![action.request_id, payload, value.to_string()],
                )?;
                tx.commit()?;
                Ok(value)
            }
        }
    })();
    Ok(match result {
        Ok(value) if mutation => value,
        other => reply(other),
    })
}

/// Isolated crash fixture only; this build feature is never enabled in production.
#[cfg(feature = "native-fixtures")]
pub(crate) fn fixture_gate(host: &Host, message: &str, stage: &str) -> Result<()> {
    let path = host.root.join(".routing-fixture-control-gate.json");
    if !path.is_file() {
        return Ok(());
    }
    let config: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    if config["schema"] == "ghost-routing-host-fixture/1"
        && (config["message_id"] == message
            || (stage == "after_routing_effect" && config["message_id"] == "*"))
        && config["stage"] == stage
    {
        std::fs::write(
            host.root.join(".routing-fixture-control-reached.json"),
            serde_json::to_vec(&json!({"message_id":message,"stage":stage}))?,
        )?;
        loop {
            std::thread::park_timeout(std::time::Duration::from_millis(25));
        }
    }
    Ok(())
}
#[cfg(not(feature = "native-fixtures"))]
pub(crate) fn fixture_gate(_: &Host, _: &str, _: &str) -> Result<()> {
    Ok(())
}
