//! Host-owned execution bindings. Admission remains in work_routing; runtime
//! receipts, rather than assistant prose, determine execution verification.
use super::{now_ms, services::Bridge, work_routing::*, Host, State};
use crate::{
    domain::Policy,
    durable::{
        self as host,
        durable::{InputKind, Phase, Snapshot, Task, TaskKind, ToolOutput, ToolStatus},
    },
};
use anyhow::{anyhow, ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    sync::{Arc, MutexGuard},
};

pub const BINDINGS: &str = "routing_execution_v1";
pub const RESULTS: &str = "routing_result_v1";
pub const COMPLETIONS: &str = "routing_completion_v1";
pub const EVIDENCE: &str = "routing_evidence_v1";
pub const EFFECT_EVIDENCE: &str = "routing_effect_evidence_v1";

/// Append-only observations; current report promotion is a separate projection.
/// The content hash excludes observation time, making retries idempotent.
fn append_evidence(s: &State, kind: &str, observation: Value) -> Result<String> {
    let id = format!("{:x}", Sha256::digest(serde_json::to_vec(&observation)?));
    s.journal.0.execute(
        "INSERT OR IGNORE INTO workspace_objects(kind,id,payload) VALUES(?,?,?)",
        rusqlite::params![
            kind,
            id,
            serde_json::to_string(&json!({
                "schema":1,"id":id,"observation":observation,"observed_ms":now_ms()
            }))?
        ],
    )?;
    Ok(id)
}

/// Preserve an actual host result before any post-effect authority check can
/// withhold it from the model. Never treats this as a runtime completion receipt.
pub(crate) fn record_effect(
    s: &State,
    profile: &str,
    task: &Task,
    call: &host::durable::ai::ToolCall,
    output: &ToolOutput,
) -> Result<()> {
    if let Some(b) = fence(s, profile, task)? {
        append_evidence(
            s,
            EFFECT_EVIDENCE,
            json!({
                "intent_id":b.id,"work_id":b.work_id,"work_revision":b.work_revision,
                "decision_revision":b.decision_revision,"profile_id":profile,
                "task_id":task.id,"call":call,"output":output
            }),
        )?;
    }
    Ok(())
}

const CONVERSATIONS: &str = "routing_conversation_v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Binding {
    pub schema: u32,
    pub id: String,
    pub work_id: String,
    pub work_revision: u64,
    pub decision_revision: u64,
    pub intent_kind: IntentKind,
    pub owner_id: String,
    pub profile_id: String,
    pub conversation_id: String,
    pub request_id: String,
    pub task_id: Option<String>,
    pub prompt: String,
    pub state: String,
    pub created_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConversationBinding {
    work_id: String,
    profile_id: String,
    conversation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    #[serde(default)]
    pub profile_id: String,
    pub effect_key: String,
    pub task_id: String,
    pub tool: String,
    pub phase: Phase,
    pub output: Option<ToolOutput>,
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub verification: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResult {
    pub schema: u32,
    pub id: String,
    pub work_id: String,
    pub work_revision: u64,
    pub decision_revision: u64,
    pub intent_id: String,
    pub profile_id: String,
    pub conversation_id: String,
    pub task_id: Option<String>,
    pub status: String,
    pub current: bool,
    pub verified: bool,
    pub summary: String,
    pub model_output: Option<String>,
    pub receipts: Vec<Receipt>,
    pub artifacts: Vec<String>,
    pub source_admission_id: String,
    pub source_fragments: Vec<SourceFragment>,
    pub updated_ms: u64,
}
fn current(work: &Work, b: &Binding) -> bool {
    work.work_revision == b.work_revision
        && work.decision_revision == b.decision_revision
        && work.responsible_profile_id == b.profile_id
        && work.owner_id == b.owner_id
}
fn descendants(snap: &Snapshot, root: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::from([root.to_string()]);
    loop {
        let previous = found.len();
        for task in snap.tasks.values() {
            if task.parent_id.as_ref().is_some_and(|p| found.contains(p)) {
                found.insert(task.id.clone());
            }
        }
        if found.len() == previous {
            return found;
        }
    }
}
fn execution_authority(
    s: &State,
    w: &Work,
    profile: &str,
    call: Option<&host::durable::ai::ToolCall>,
) -> Result<()> {
    let source = s
        .profiles
        .get(&w.origin.entry_profile_id)
        .ok_or_else(|| anyhow!("Work origin profile unavailable"))?;
    ensure!(source.error.is_none(), "Work origin profile unavailable");
    ensure!(
        source
            .runtime
            .session
            .committed()?
            .conversations
            .contains_key(&w.origin.conversation_id),
        "Work origin conversation unavailable"
    );
    let assigned = profile != w.origin.entry_profile_id;
    for identity in if assigned {
        vec![profile, w.origin.entry_profile_id.as_str()]
    } else {
        vec![profile]
    } {
        let p = s
            .profiles
            .get(identity)
            .ok_or_else(|| anyhow!("execution authority profile missing"))?;
        ensure!(p.error.is_none(), "execution authority profile unavailable");
        let policy: Policy = s.journal.get("policy", identity)?.unwrap_or_default();
        if assigned && identity == w.origin.entry_profile_id {
            ensure!(policy.delegation, "assignment sender permission revoked")
        }
        if let Some(call) = call {
            match call.name.as_str() {
                name if super::routing_model::is_tool(name) => {
                    anyhow::bail!("Work descendant cannot route independent Work")
                }
                // These adapters can cross an asynchronous remote boundary.
                // Bound Work must fail closed until that boundary has a lease
                // serialized with revision admission; ordinary tasks are unchanged.
                "shell" | "integration_call" | "memory_retain" | "planner_mutation" => {
                    anyhow::bail!("Work external mutation requires a fenced executor")
                }
                "browser" => {
                    ensure!(
                        matches!(
                            call.arguments["operation"].as_str(),
                            Some("read" | "snapshot" | "screenshot")
                        ),
                        "Work browser mutation requires a fenced executor"
                    );
                    ensure!(policy.browser, "browser permission revoked");
                }
                "memory_search" => ensure!(
                    policy.memory && !assigned,
                    "memory access denied for assignment"
                ),
                "delegate_ghost" | "durable_delegate" => {
                    ensure!(policy.delegation, "delegation permission revoked")
                }
                "integration_tools" => {
                    super::integrations::allowed(
                        s,
                        call.arguments["integration_id"].as_str().unwrap_or(""),
                        Some(identity),
                    )?;
                }
                "read_file" | "write_file" => {
                    let store = p
                        .host
                        .store
                        .lock()
                        .map_err(|_| anyhow!("execution grant store unavailable"))?;
                    host::GhostHost::target(&store, call, false)?;
                }
                "read_page" | "list_pages" | "review_page" => {
                    let space: crate::adapters::documents::Space = s
                        .journal
                        .get("space", call.arguments["space_id"].as_str().unwrap_or(""))?
                        .ok_or_else(|| anyhow!("Space missing"))?;
                    ensure!(
                        space.profiles.contains(&identity.to_string())
                            && (call.name != "review_page" || space.writable),
                        "Space permission revoked"
                    );
                }
                #[cfg(feature = "caldav")]
                "list_connected_planner" | "planner_operation_status" => {
                    let args = &call.arguments;
                    super::planner_sync::allowed(
                        s,
                        args["collection_id"].as_str().unwrap_or(""),
                        Some(identity),
                    )?;
                }
                _ => {}
            }
        }
    }
    Ok(())
}

/// Call at model/tool admission and preparation. Routing conversations are
/// reserved: unrelated submissions cannot inherit their execution authority.
/// Nonrouting task authority continues through the host's ordinary Bridge.
pub(crate) fn fence(s: &State, profile: &str, task: &Task) -> Result<Option<Binding>> {
    fence_bound(s, profile, task, false)
}
/// Current attribution permits successfully completed source tasks for deferred
/// owner effects, while revoked, stale, failed, cancelled or uncertain tasks deny.
pub(crate) fn fence_current(s: &State, profile: &str, task: &Task) -> Result<Option<Binding>> {
    fence_bound(s, profile, task, true)
}
fn fence_bound(s: &State, profile: &str, task: &Task, completed: bool) -> Result<Option<Binding>> {
    fence_lineage(s, profile, task, completed, &mut BTreeSet::new())
}
fn fence_lineage(
    s: &State,
    profile: &str,
    task: &Task,
    completed: bool,
    delegation_path: &mut BTreeSet<(String, String)>,
) -> Result<Option<Binding>> {
    ensure!(
        delegation_path.len() < 128 && delegation_path.insert((profile.into(), task.id.clone())),
        "Work delegation ancestry invalid"
    );
    let p = s
        .profiles
        .get(profile)
        .ok_or_else(|| anyhow!("execution profile missing"))?;
    ensure!(p.error.is_none(), "execution profile unavailable");
    let snap = p.runtime.session.committed()?;
    let actual = snap
        .tasks
        .get(&task.id)
        .ok_or_else(|| anyhow!("runtime task missing"))?;
    let same_kind = match (&actual.kind, &task.kind) {
        (TaskKind::Tool { call: a, .. }, TaskKind::Tool { call: b, .. }) => {
            serde_json::to_value(a)? == serde_json::to_value(b)?
        }
        (TaskKind::Generation { .. }, TaskKind::Generation { .. }) => true,
        _ => false,
    };
    ensure!(
        same_kind
            && actual.ordinal == task.ordinal
            && actual.background == task.background
            && actual.conversation_id == task.conversation_id
            && actual.parent_id == task.parent_id,
        "runtime task identity changed"
    );
    let bindings: Vec<Binding> = s.journal.objects(BINDINGS)?;
    let reserved: Vec<ConversationBinding> = s.journal.objects(CONVERSATIONS)?;
    let mut cursor = actual;
    let mut seen = BTreeSet::new();
    let mut background_lineage = false;
    loop {
        background_lineage |= cursor.background;
        ensure!(
            seen.insert(cursor.id.clone()) && seen.len() <= 128,
            "execution ancestry invalid"
        );
        if let Some(b) = bindings.iter().find(|b| {
            b.profile_id == profile
                && (b.task_id.as_deref() == Some(&cursor.id)
                    || snap.submissions.iter().any(|sub| {
                        sub.conversation_id == b.conversation_id
                            && sub.request_id == b.request_id
                            && sub.task_id == cursor.id
                    }))
        }) {
            let w: Work = s
                .journal
                .get("routing_work_v2", &b.work_id)?
                .ok_or_else(|| anyhow!("Work missing"))?;
            ensure!(
                current(&w, b)
                    && w.status == WorkStatus::Pending
                    && b.intent_kind != IntentKind::Cancel,
                "execution superseded or cancelled"
            );
            ensure!(
                cursor.conversation_id == b.conversation_id
                    && (!cursor.phase.terminal()
                        || (cursor.phase == Phase::Complete
                            && (completed || (background_lineage && actual.id != cursor.id))))
                    && (!actual.phase.terminal() || (completed && actual.phase == Phase::Complete)),
                "execution no longer active"
            );
            let owner: String = s
                .journal
                .get("meta", "workspace_id")?
                .ok_or_else(|| anyhow!("workspace missing"))?;
            ensure!(owner == b.owner_id, "execution workspace identity changed");
            execution_authority(
                s,
                &w,
                profile,
                match &actual.kind {
                    TaskKind::Tool { call, .. } => Some(call),
                    _ => None,
                },
            )?;
            return Ok(Some(b.clone()));
        }
        match &cursor.parent_id {
            Some(parent) => {
                cursor = snap
                    .tasks
                    .get(parent)
                    .ok_or_else(|| anyhow!("execution parent missing"))?
            }
            None => break,
        }
    }
    // Cross-profile host delegations have distinct SDK roots. Resolve their
    // persisted source tool to the SAME Work; never widen authority merely
    // because the target has no local execution binding.
    let records: Vec<crate::domain::Delegation> = s.journal.objects("delegation")?;
    let parents = records
        .iter()
        .filter(|d| d.target == profile && d.conversation_id == cursor.conversation_id)
        .collect::<Vec<_>>();
    ensure!(parents.len() <= 1, "Work delegation lineage ambiguous");
    if let Some(d) = parents.first() {
        let source = s
            .profiles
            .get(&d.owner)
            .ok_or_else(|| anyhow!("Work delegation source missing"))?;
        let source_snapshot = source.runtime.session.committed()?;
        let source_task = source_snapshot
            .tasks
            .get(&d.owner_task)
            .ok_or_else(|| anyhow!("Work delegation source task missing"))?;
        let inherited = fence_lineage(s, &d.owner, source_task, true, delegation_path)?;
        if let Some(b) = inherited {
            let TaskKind::Tool { call, .. } = &source_task.kind else {
                anyhow::bail!("Work delegation source is not a tool");
            };
            ensure!(
                call.name == "delegate_ghost"
                    && call.arguments["profile_id"].as_str() == Some(profile)
                    && call.arguments["background"].as_bool().unwrap_or(false) == d.background
                    && snap.submissions.iter().any(|sub| sub.request_id == d.id
                        && sub.task_id == cursor.id
                        && sub.conversation_id == d.conversation_id
                        && call.arguments["prompt"].as_str() == Some(sub.text.as_str()))
                    && (d.task_id.is_empty() || d.task_id == cursor.id),
                "Work delegation identity changed"
            );
            ensure!(
                matches!(d.state.as_str(), "starting" | "running" | "complete")
                    && (!cursor.phase.terminal()
                        || (cursor.phase == Phase::Complete
                            && (completed || (background_lineage && actual.id != cursor.id))))
                    && (!source_task.phase.terminal()
                        || (d.background && source_task.phase == Phase::Complete))
                    && (!actual.phase.terminal() || (completed && actual.phase == Phase::Complete)),
                "Work delegation no longer active"
            );
            let work: Work = s
                .journal
                .get("routing_work_v2", &b.work_id)?
                .ok_or_else(|| anyhow!("Work missing"))?;
            execution_authority(
                s,
                &work,
                profile,
                match &actual.kind {
                    TaskKind::Tool { call, .. } => Some(call),
                    _ => None,
                },
            )?;
            return Ok(Some(b));
        }
    }
    ensure!(
        !reserved
            .iter()
            .any(|c| c.profile_id == profile && c.conversation_id == task.conversation_id),
        "unbound task in reserved Work conversation"
    );
    Ok(None)
}
/// Pin the root state across a synchronous final effect boundary. Lock ordering
/// is root state, then profile store. Never acquire this while holding a store.
pub(crate) struct EffectGuard<'a>(MutexGuard<'a, State>);
impl EffectGuard<'_> {
    pub(crate) fn state(&self) -> &State {
        &self.0
    }
}
pub(crate) fn effect_guard<'a>(
    host: &'a Host,
    profile: &str,
    task: &Task,
) -> Result<EffectGuard<'a>> {
    let state = host.lock()?;
    fence(&state, profile, task)?;
    Bridge::authority_in(
        &state,
        profile,
        task,
        match &task.kind {
            TaskKind::Tool { call, .. } => Some(call),
            _ => None,
        },
    )?;
    Ok(EffectGuard(state))
}
fn intent_revision(s: &State, intent: &ExecutionIntent) -> Result<u64> {
    let admission: Admission = s
        .journal
        .get("routing_admission_v2", &intent.source_admission_id)?
        .ok_or_else(|| anyhow!("dispatch admission missing"))?;
    admission
        .items
        .iter()
        .find(|i| i.intent_id.as_deref() == Some(&intent.id))
        .and_then(|i| i.work_revision)
        .ok_or_else(|| anyhow!("dispatch revision missing"))
}
fn binding(s: &State, work: &Work, intent: &ExecutionIntent) -> Result<Binding> {
    if let Some(old) = s.journal.get(BINDINGS, &intent.id)? {
        return Ok(old);
    }
    let conversation: ConversationBinding = match s.journal.get(CONVERSATIONS, &work.id)? {
        Some(c) => c,
        None => {
            let c = ConversationBinding {
                work_id: work.id.clone(),
                profile_id: work.responsible_profile_id.clone(),
                conversation_id: uuid::Uuid::new_v5(
                    &uuid::Uuid::NAMESPACE_URL,
                    format!("ghost-work:{}:{}", work.owner_id, work.id).as_bytes(),
                )
                .to_string(),
            };
            s.journal.put(CONVERSATIONS, &work.id, &c)?;
            c
        }
    };
    ensure!(
        conversation.profile_id == work.responsible_profile_id,
        "Work assignee changed without conversation migration"
    );
    let decision: Decision = s
        .journal
        .get(
            "routing_decision_v2",
            &format!("{}:{}", work.id, intent.decision_revision),
        )?
        .ok_or_else(|| anyhow!("dispatch decision missing"))?;
    let b = Binding {schema:1, id:intent.id.clone(), work_id:work.id.clone(), work_revision:intent_revision(s,intent)?,
        decision_revision:intent.decision_revision,intent_kind:intent.kind,owner_id:work.owner_id.clone(),
        profile_id:conversation.profile_id,conversation_id:conversation.conversation_id,
        request_id:format!("routing-intent:{}",intent.id),task_id:None,
        prompt:format!("Execute durable Work {} at revision {} and decision {}. Current authoritative scope:\n{}\n\nAdmitted operation:\n{:?}\n\nUse actual tools for requested actions. Do not claim external success from text. Preserve artifacts and report blocked or uncertain actions honestly.",
            work.id,intent_revision(s,intent)?,intent.decision_revision,decision.scope,intent.kind),
        state:"bound".into(),created_ms:now_ms()};
    // This commit precedes conversation creation and input admission.
    s.journal.put(BINDINGS, &b.id, &b)?;
    Ok(b)
}
// Report facts remain explicit so every promotion call supplies verification.
#[allow(clippy::too_many_arguments)]
pub(super) fn result(
    s: &State,
    work: &Work,
    b: &Binding,
    status: &str,
    summary: &str,
    model_output: Option<String>,
    receipts: Vec<Receipt>,
    verified: bool,
) -> Result<()> {
    let intent: ExecutionIntent = s
        .journal
        .get("routing_intent_v2", &b.id)?
        .ok_or_else(|| anyhow!("intent missing"))?;
    let artifacts: BTreeSet<String> = receipts
        .iter()
        .filter_map(|r| r.output.as_ref())
        .flat_map(|o| o.artifacts.iter().cloned())
        .collect();
    let r = ExecutionResult {
        schema: 1,
        id: b.id.clone(),
        work_id: b.work_id.clone(),
        work_revision: b.work_revision,
        decision_revision: b.decision_revision,
        intent_id: b.id.clone(),
        profile_id: b.profile_id.clone(),
        conversation_id: b.conversation_id.clone(),
        task_id: b.task_id.clone(),
        status: status.into(),
        current: current(work, b),
        verified: verified && current(work, b) && work.status == WorkStatus::Pending,
        summary: summary.into(),
        model_output,
        receipts,
        artifacts: artifacts.into_iter().collect(),
        source_admission_id: intent.source_admission_id,
        source_fragments: intent.source_fragments,
        updated_ms: now_ms(),
    };
    let prior: Option<ExecutionResult> = s.journal.get(RESULTS, &r.id)?;
    let mut comparable = r.clone();
    if let Some(old) = prior {
        comparable.updated_ms = old.updated_ms;
        if serde_json::to_value(&old)? == serde_json::to_value(&comparable)? {
            return Ok(());
        }
    }
    let tx = s.journal.0.unchecked_transaction()?;
    let mut observation = serde_json::to_value(&r)?;
    observation.as_object_mut().unwrap().remove("updated_ms");
    append_evidence(s, EVIDENCE, observation)?;
    for kind in [RESULTS, COMPLETIONS] {
        if kind == COMPLETIONS
            && !matches!(
                status,
                "finished_verified"
                    | "finished_unverified"
                    | "failed"
                    | "cancelled"
                    | "uncertain"
                    | "superseded"
                    | "blocked"
            )
        {
            tx.execute(
                "DELETE FROM workspace_objects WHERE kind=? AND id=?",
                rusqlite::params![COMPLETIONS, r.id],
            )?;
            continue;
        }
        tx.execute(
            "INSERT OR REPLACE INTO workspace_objects(kind,id,payload) VALUES(?,?,?)",
            rusqlite::params![kind, r.id, serde_json::to_string(&r)?],
        )?;
    }
    tx.commit()?;
    Ok(())
}
/// Follow persisted host delegations across profile sessions. SDK parent_id
/// links alone cannot describe these target roots, including background work.
type LinkedExecution = (
    Vec<(String, Task)>,
    Vec<Receipt>,
    Vec<crate::domain::Delegation>,
);
fn linked_execution(s: &State, b: &Binding) -> Result<LinkedExecution> {
    let Some(root) = &b.task_id else {
        return Ok((vec![], vec![], vec![]));
    };
    let records: Vec<crate::domain::Delegation> = s.journal.objects("delegation")?;
    let mut pending = vec![(b.profile_id.clone(), root.clone())];
    let mut seen = BTreeSet::new();
    let mut tasks = vec![];
    let mut receipts = vec![];
    let mut delegations = vec![];
    while let Some((profile, root)) = pending.pop() {
        ensure!(seen.len() < 128, "Work delegation graph exceeds limit");
        if !seen.insert((profile.clone(), root.clone())) {
            continue;
        }
        let p = s
            .profiles
            .get(&profile)
            .ok_or_else(|| anyhow!("Work descendant profile unavailable"))?;
        let snap = p.runtime.session.committed()?;
        let ids = descendants(&snap, &root);
        tasks.extend(
            snap.tasks
                .values()
                .filter(|t| ids.contains(&t.id))
                .cloned()
                .map(|t| (profile.clone(), t)),
        );
        receipts.extend(
            snap.effects
                .values()
                .filter(|e| ids.contains(&e.task_id))
                .map(|e| Receipt {
                    profile_id: profile.clone(),
                    effect_key: e.key.clone(),
                    task_id: e.task_id.clone(),
                    tool: e.name.clone(),
                    phase: e.phase,
                    output: e.output.clone(),
                    verified: false,
                    verification: Value::Null,
                }),
        );
        for record in records
            .iter()
            .filter(|d| d.owner == profile && ids.contains(&d.owner_task))
        {
            let mut d = record.clone();
            let target = s
                .profiles
                .get(&d.target)
                .ok_or_else(|| anyhow!("Work delegation target unavailable"))?;
            if d.task_id.is_empty() {
                if let Some(sub) = target
                    .runtime
                    .session
                    .committed()?
                    .submissions
                    .iter()
                    .find(|sub| sub.request_id == d.id && sub.conversation_id == d.conversation_id)
                {
                    d.task_id = sub.task_id.clone();
                }
            }
            if !d.task_id.is_empty() {
                pending.push((d.target.clone(), d.task_id.clone()));
            }
            delegations.push(d);
        }
    }
    Ok((tasks, receipts, delegations))
}

fn verify_receipts(s: &State, w: &Work, b: &Binding, snap: &Snapshot, receipts: &mut [Receipt]) {
    for receipt in receipts {
        if receipt.profile_id != b.profile_id {
            continue;
        }
        if receipt.phase != Phase::Complete
            || !receipt
                .output
                .as_ref()
                .is_some_and(|o| o.status == ToolStatus::Success)
        {
            continue;
        }
        let Some(task) = snap.tasks.get(&receipt.task_id) else {
            continue;
        };
        let TaskKind::Tool { call, .. } = &task.kind else {
            continue;
        };
        if execution_authority(s, w, &b.profile_id, Some(call)).is_err() {
            continue;
        }
        let output = receipt.output.as_ref().unwrap();
        let verification: Result<Value> = (|| match receipt.tool.as_str() {
            "write_file" => {
                let p = s
                    .profiles
                    .get(&b.profile_id)
                    .ok_or_else(|| anyhow!("profile missing"))?;
                let store = p
                    .host
                    .store
                    .lock()
                    .map_err(|_| anyhow!("profile unavailable"))?;
                let (path, _) = host::GhostHost::target(&store, call, false)?;
                ensure!(
                    std::fs::symlink_metadata(&path)?.file_type().is_file(),
                    "artifact must be a regular file"
                );
                ensure!(
                    output.content["path"].as_str() == Some(path.to_string_lossy().as_ref()),
                    "receipt artifact identity differs"
                );
                let content = crate::tools::read_bounded(&path)?;
                ensure!(
                    Some(content.as_str()) == call.arguments["content"].as_str(),
                    "artifact content differs from actual call"
                );
                Ok(
                    json!({"kind":"file_content","path":path,"sha256":format!("{:x}",Sha256::digest(content.as_bytes())),"bytes":content.len()}),
                )
            }
            "save_todo" | "save_calendar_event" => {
                let kind = if receipt.tool == "save_todo" {
                    "todo"
                } else {
                    "calendar_event"
                };
                let id = output.content["id"]
                    .as_str()
                    .ok_or_else(|| anyhow!("organizer receipt id missing"))?;
                let actual: Value = s
                    .journal
                    .get(kind, id)?
                    .ok_or_else(|| anyhow!("organizer object missing"))?;
                ensure!(
                    actual == output.content,
                    "organizer object changed after execution"
                );
                Ok(
                    json!({"kind":"durable_object","namespace":kind,"id":id,"version":actual["version"]}),
                )
            }
            "delete_todo" | "delete_calendar_event" => {
                let kind = if receipt.tool == "delete_todo" {
                    "todo"
                } else {
                    "calendar_event"
                };
                let id = output.content["deleted"]
                    .as_str()
                    .ok_or_else(|| anyhow!("delete receipt id missing"))?;
                ensure!(
                    s.journal.get::<Value>(kind, id)?.is_none(),
                    "deleted object recreated"
                );
                Ok(json!({"kind":"durable_absence","namespace":kind,"id":id}))
            }
            "read_file"
            | "read_page"
            | "list_pages"
            | "list_todos"
            | "list_calendar_events"
            | "list_integrations"
            | "integration_tools"
            | "list_spaces"
            | "list_ghosts"
            | "memory_search" => Ok(json!({"kind":"actual_read_receipt"})),
            _ => Err(anyhow!(
                "external mutation lacks independent verification observation"
            )),
        })();
        if let Ok(v) = verification {
            receipt.verified = true;
            receipt.verification = v;
        }
    }
}

fn report(s: &State, w: &Work, b: &Binding) -> Result<()> {
    let Some(p) = s.profiles.get(&b.profile_id) else {
        return result(
            s,
            w,
            b,
            "blocked",
            "Responsible profile unavailable",
            None,
            vec![],
            false,
        );
    };
    let snap = p.runtime.session.committed()?;
    let (mut linked_tasks, mut receipts, _) = linked_execution(s, b)?;
    if w.status == WorkStatus::CancelRequested && current(w, b) {
        let previous: Vec<Binding> = s.journal.objects(BINDINGS)?;
        receipts.clear();
        linked_tasks.clear();
        for old in previous.iter().filter(|old| old.work_id == b.work_id) {
            let (tasks, effects, _) = linked_execution(s, old)?;
            linked_tasks.extend(tasks);
            receipts.extend(effects);
        }
        receipts.sort_by_key(|r| (r.profile_id.clone(), r.effect_key.clone()));
        receipts.dedup_by(|a, b| a.profile_id == b.profile_id && a.effect_key == b.effect_key);
    }
    let task = b.task_id.as_ref().and_then(|id| snap.tasks.get(id));
    if !current(w, b) {
        return result(
            s,
            w,
            b,
            "superseded",
            "A newer Work revision supersedes this execution",
            task.and_then(|t| t.output.clone()),
            receipts,
            false,
        );
    }
    let uncertain = linked_tasks
        .iter()
        .any(|(_, t)| t.phase == Phase::Uncertain)
        || receipts.iter().any(|r| {
            r.phase == Phase::Uncertain
                || (r.phase == Phase::ToolRunning && r.output.is_none())
                || r.output
                    .as_ref()
                    .is_some_and(|o| o.status == ToolStatus::Uncertain)
        });
    if uncertain {
        return result(
            s,
            w,
            b,
            "uncertain",
            "External outcome requires owner reconciliation; no automatic reissue",
            None,
            receipts,
            false,
        );
    }
    if w.status == WorkStatus::CancelRequested {
        return result(
            s,
            w,
            b,
            "cancelled",
            "Cancellation committed; prior effects remain in historical receipts",
            None,
            receipts,
            false,
        );
    }
    let Some(task) = task else {
        return result(
            s,
            w,
            b,
            &b.state,
            "Execution binding durable; awaiting dispatch",
            None,
            receipts,
            false,
        );
    };
    let all = linked_tasks
        .iter()
        .map(|(_, task)| task)
        .collect::<Vec<_>>();
    if all.iter().any(|t| t.phase == Phase::Uncertain) {
        return result(
            s,
            w,
            b,
            "uncertain",
            "Runtime outcome requires reconciliation",
            task.output.clone(),
            receipts,
            false,
        );
    }
    if all
        .iter()
        .any(|t| matches!(t.phase, Phase::WaitingOwner | Phase::WaitingChild))
    {
        return result(
            s,
            w,
            b,
            "blocked",
            "Execution awaits an owner decision or child result",
            None,
            receipts,
            false,
        );
    }
    if !task.phase.terminal() {
        return result(
            s,
            w,
            b,
            "running",
            "Execution in progress",
            None,
            receipts,
            false,
        );
    }
    if all.iter().any(|t| !t.phase.terminal()) {
        return result(
            s,
            w,
            b,
            "running",
            "Descendant work remains active",
            task.output.clone(),
            receipts,
            false,
        );
    }
    if all
        .iter()
        .any(|t| matches!(t.phase, Phase::Failed | Phase::Cancelled))
        || receipts.iter().any(|r| {
            r.output
                .as_ref()
                .is_some_and(|o| matches!(o.status, ToolStatus::Denied | ToolStatus::Failed))
        })
    {
        return result(
            s,
            w,
            b,
            "failed",
            "Execution did not finish successfully",
            task.output.clone(),
            receipts,
            false,
        );
    }
    let authority = linked_tasks.iter().all(|(profile, t)| {
        let call = match &t.kind {
            TaskKind::Tool { call, .. } => Some(call),
            _ => None,
        };
        execution_authority(s, w, profile, call).is_ok()
    });
    let policy: Policy = s.journal.get("policy", &b.profile_id)?.unwrap_or_default();
    let policies = receipts.iter().all(|r| match r.tool.as_str() {
        "shell" => policy.shell,
        "browser" => policy.browser,
        "memory_retain" | "memory_search" => policy.memory,
        "durable_delegate" | "delegate_ghost" => policy.delegation,
        _ => true,
    });
    if !authority || !policies || p.error.is_some() {
        return result(
            s,
            w,
            b,
            "blocked",
            "Authority changed; result cannot be promoted",
            task.output.clone(),
            receipts,
            false,
        );
    }
    verify_receipts(s, w, b, &snap, &mut receipts);
    let verified = receipts.iter().any(|r| {
        r.verified
            && matches!(
                r.tool.as_str(),
                "write_file"
                    | "save_todo"
                    | "save_calendar_event"
                    | "delete_todo"
                    | "delete_calendar_event"
            )
    }) && receipts.iter().all(|r| r.verified);
    result(
        s,
        w,
        b,
        if verified {
            "finished_verified"
        } else {
            "finished_unverified"
        },
        if verified {
            "Generation ended with successful actual tool receipts; inspect receipts for the exact verified actions"
        } else {
            "Generation ended; external success is not verified by execution receipts"
        },
        task.output.clone(),
        receipts,
        verified,
    )
}
/// Reconcile durable bindings and consume only current revision intents. Holding
/// root state through session.submit closes the revision/admission race. Runtime
/// recovery owns interrupted tool replay; the dispatcher only deduplicates input.
pub fn pump(host: &Arc<Host>) -> Result<()> {
    let s = host.lock()?;
    let works: Vec<Work> = s.journal.objects("routing_work_v2")?;
    let mut intents: Vec<ExecutionIntent> = s.journal.objects("routing_intent_v2")?;
    intents.sort_by_key(|i| (i.work_id.clone(), intent_revision(&s, i).unwrap_or(0)));
    for intent in intents {
        let Some(w) = works.iter().find(|w| w.id == intent.work_id) else {
            continue;
        };
        let mut b = binding(&s, w, &intent)?;
        if let Some(p) = s.profiles.get(&b.profile_id) {
            let snap = p.runtime.session.committed()?;
            if let Some(sub) = snap.submissions.iter().find(|sub| {
                sub.conversation_id == b.conversation_id && sub.request_id == b.request_id
            }) {
                ensure!(sub.text == b.prompt, "dispatch request collision");
                b.task_id = Some(sub.task_id.clone());
            }
            if !current(w, &b) || w.status == WorkStatus::CancelRequested {
                if let Some(id) = &b.task_id {
                    if snap.tasks.get(id).is_some_and(|t| !t.phase.terminal()) {
                        p.runtime.session.cancel(id)?;
                    }
                }
                let (owned_tasks, _, delegations) = linked_execution(&s, &b)?;
                // SDK cancellation deliberately preserves background children;
                // a Work revision fence owns all of its bound descendants.
                for (profile, task) in owned_tasks {
                    if !task.phase.terminal() {
                        s.profiles[&profile].runtime.session.cancel(&task.id)?;
                    }
                }
                for mut delegation in delegations {
                    super::cancel_delegation(&s, &mut delegation)?;
                }
                b.state = if current(w, &b) {
                    "cancelled"
                } else {
                    "superseded"
                }
                .into();
                s.journal.put(BINDINGS, &b.id, &b)?;
                report(&s, w, &b)?;
                continue;
            }
            if p.error.is_some() || execution_authority(&s, w, &b.profile_id, None).is_err() {
                b.state = "blocked".into();
                s.journal.put(BINDINGS, &b.id, &b)?;
                report(&s, w, &b)?;
                continue;
            }
            let prior: Vec<Binding> = s.journal.objects(BINDINGS)?;
            let mut unresolved = false;
            for old in prior.iter().filter(|old| old.work_id == b.work_id) {
                let (tasks, receipts, _) = linked_execution(&s, old)?;
                unresolved |= tasks.iter().any(|(_, t)| t.phase == Phase::Uncertain)
                    || receipts.iter().any(|r| {
                        r.phase == Phase::Uncertain
                            || (r.phase == Phase::ToolRunning && r.output.is_none())
                            || r.output
                                .as_ref()
                                .is_some_and(|o| o.status == ToolStatus::Uncertain)
                    });
            }
            let dependencies = w.dependency_ids.iter().all(|id| {
                let Some(dep) = works.iter().find(|w| &w.id == id) else {
                    return false;
                };
                owner_results(&s).is_ok_and(|projection| {
                    projection["results"].as_array().is_some_and(|rows| {
                        rows.iter().any(|r| {
                            r["work_id"] == dep.id
                                && r["work_revision"] == dep.work_revision
                                && r["decision_revision"] == dep.decision_revision
                                && r["verified"] == true
                                && r["status"] == "finished_verified"
                        })
                    })
                })
            });
            if b.task_id.is_none() && (unresolved || !dependencies) {
                b.state = "blocked".into();
                s.journal.put(BINDINGS, &b.id, &b)?;
                result(
                    &s,
                    w,
                    &b,
                    if unresolved { "uncertain" } else { "blocked" },
                    if unresolved {
                        "Prior external effect requires reconciliation before another execution"
                    } else {
                        "Dependencies lack current verified completion"
                    },
                    None,
                    vec![],
                    false,
                )?;
                continue;
            }
            if b.task_id.is_none() {
                if !snap.conversations.contains_key(&b.conversation_id) {
                    let store = p
                        .host
                        .store
                        .lock()
                        .map_err(|_| anyhow!("profile store unavailable"))?;
                    let policy: Policy =
                        s.journal.get("policy", &b.profile_id)?.unwrap_or_default();
                    let model = policy
                        .model
                        .unwrap_or(super::models::selected_llm(&s, &host.default_model)?);
                    let mut config = host::config(&store, Some(&model), true)?;
                    config.tools.extend(super::services::role_tool_definitions(
                        host,
                        super::services::ToolRole::DurableWork,
                    ));
                    p.runtime
                        .session
                        .create_conversation_with_id(&b.conversation_id, config)?;
                } else {
                    // A prior release may have persisted another task role's
                    // report tools in this stable Work conversation. Revise
                    // only idle config; active executions retain their fences.
                    let current = &snap.conversations[&b.conversation_id].config;
                    let needs_role_refresh = current.tools.iter().any(|tool| {
                        matches!(tool.name.as_str(), "report_delegation" | "report_goal")
                            || super::routing_model::is_tool(&tool.name)
                    });
                    if needs_role_refresh {
                        if snap.tasks.values().any(|task| {
                            task.conversation_id == b.conversation_id && !task.phase.terminal()
                        }) {
                            b.state = "blocked".into();
                            s.journal.put(BINDINGS, &b.id, &b)?;
                            continue;
                        }
                        let mut config = current.clone();
                        config.tools.retain(|tool| {
                            !matches!(tool.name.as_str(), "report_delegation" | "report_goal")
                                && !super::routing_model::is_tool(&tool.name)
                        });
                        p.runtime.session.set_config(&b.conversation_id, config)?;
                    }
                }
                let sub = p.runtime.session.submit(
                    &b.conversation_id,
                    &b.request_id,
                    InputKind::Prompt,
                    &b.prompt,
                )?;
                b.task_id = Some(sub.task_id);
            }
            b.state = "submitted".into();
            s.journal.put(BINDINGS, &b.id, &b)?;
        } else {
            b.state = "blocked".into();
            s.journal.put(BINDINGS, &b.id, &b)?;
        }
        report(&s, w, &b)?;
    }
    Ok(())
}
/// Historical reports and completion outbox survive the entry conversation.
/// Re-evaluate current/verified here so an admission immediately hides stale
/// promotion, even before the asynchronous dispatcher next runs.
pub(crate) fn owner_results(s: &State) -> Result<Value> {
    let works: Vec<Work> = s.journal.objects("routing_work_v2")?;
    let project = |kind: &str| -> Result<Vec<ExecutionResult>> {
        let mut rows: Vec<ExecutionResult> = s.journal.objects(kind)?;
        for r in &mut rows {
            r.current = works.iter().any(|w| {
                w.id == r.work_id
                    && w.work_revision == r.work_revision
                    && w.decision_revision == r.decision_revision
                    && w.responsible_profile_id == r.profile_id
            });
            r.verified &= r.current
                && works
                    .iter()
                    .any(|w| w.id == r.work_id && w.status == WorkStatus::Pending);
            if !r.current {
                r.status = "superseded".into();
            } else if r.verified {
                let w = works.iter().find(|w| w.id == r.work_id).unwrap();
                let binding: Option<Binding> = s.journal.get(BINDINGS, &r.intent_id)?;
                if let (Some(b), Some(p)) = (binding, s.profiles.get(&r.profile_id)) {
                    let snapshot = p.runtime.session.committed()?;
                    let authority = p.error.is_none()
                        && execution_authority(s, w, &r.profile_id, None).is_ok()
                        && r.receipts.iter().all(|receipt| {
                            snapshot.tasks.get(&receipt.task_id).is_some_and(|task| {
                                let call = match &task.kind {
                                    TaskKind::Tool { call, .. } => Some(call),
                                    _ => None,
                                };
                                execution_authority(s, w, &r.profile_id, call).is_ok()
                            })
                        });
                    for receipt in &mut r.receipts {
                        receipt.verified = false;
                        receipt.verification = Value::Null;
                    }
                    if authority {
                        verify_receipts(s, w, &b, &snapshot, &mut r.receipts);
                    }
                    r.verified = authority
                        && !r.receipts.is_empty()
                        && r.receipts.iter().all(|receipt| receipt.verified);
                    if !r.verified {
                        r.status = if authority {
                            "finished_unverified"
                        } else {
                            "blocked"
                        }
                        .into();
                        r.summary="Current authority or artifact verification no longer supports promotion".into();
                    }
                } else {
                    r.verified = false;
                    r.status = "blocked".into();
                }
            }
        }
        Ok(rows)
    };
    Ok(
        json!({"results":project(RESULTS)?,"completion_outbox":project(COMPLETIONS)?,"bindings":s.journal.objects::<Binding>(BINDINGS)?,"evidence":s.journal.objects::<Value>(EVIDENCE)?,"effect_evidence":s.journal.objects::<Value>(EFFECT_EVIDENCE)?}),
    )
}
