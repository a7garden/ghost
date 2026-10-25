//! Exact durable Pi dependency waits. No model or external effect is started.
use super::{apply, authority, db, graph, pi_execution, pi_tools::PiToolRequest};
use crate::lifetime_contract::{canonical_digest, Envelope, Response, ResponseStatus, Work};
use anyhow::{anyhow, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Binding {
    request: Envelope,
    assignment_id: String,
    generation_task_id: u64,
    work_id: String,
    goal_revision: u64,
    owner_revision: u64,
    ghost_id: String,
    conversation_id: String,
    execution_id: Option<String>,
    started_ms: u64,
}
fn get(conn: &Connection, kind: &str, id: &str) -> Result<Option<Value>> {
    conn.query_row(
        "SELECT payload FROM workspace_objects WHERE kind=?1 AND id=?2",
        params![kind, id],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(|raw| serde_json::from_str(&raw).map_err(Into::into))
    .transpose()
}
fn put(conn: &Connection, kind: &str, id: &str, value: &Value) -> Result<()> {
    conn.execute("INSERT INTO workspace_objects(kind,id,payload) VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",params![kind,id,serde_json::to_string(value)?])?;
    Ok(())
}
fn receipt(binding: &Binding) -> Value {
    json!({"kind":"pi-work-wait/1","assignment_id":binding.assignment_id,"work_id":binding.work_id,"goal_revision":binding.goal_revision,"owner_revision":binding.owner_revision,"generation_task_id":binding.generation_task_id,"authority_epoch":binding.request.authority_epoch,"wait_command_id":binding.request.command_id,"wait_payload_digest":binding.request.payload_digest,"wait_for":binding.request.body["wait_for"],"execution_id":binding.execution_id})
}
fn load(conn: &Connection, id: &str) -> Result<Binding> {
    let binding: Binding = serde_json::from_value(
        get(conn, "pi_work_wait", id)?.ok_or_else(|| anyhow!("Original Pi wait is missing"))?,
    )?;
    binding.request.validate()?;
    ensure!(
        binding.request.command_id == id,
        "Pi wait command binding mismatch"
    );
    let (request, response): (String, String) = conn.query_row(
        "SELECT request,response FROM lifetime_commands WHERE command_id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let source: Envelope = serde_json::from_str(&request)?;
    let response: Response = serde_json::from_str(&response)?;
    ensure!(
        source == binding.request
            && response.status == ResponseStatus::Success
            && response.data["wait_receipt"] == receipt(&binding),
        "Pi wait has no exact original committed receipt"
    );
    Ok(binding)
}
fn active(conn: &Connection, work: &Work) -> Result<Option<Binding>> {
    let Some(pointer) = get(conn, "pi_work_wait_active", &work.id)? else {
        return Ok(None);
    };
    let binding = load(conn, apply::string_field(&pointer, "command_id")?)?;
    ensure!(binding.work_id == work.id, "Pi active wait Work mismatch");
    Ok(Some(binding))
}
fn phase(conn: &Connection, binding: &Binding, work: &Work) -> Result<&'static str> {
    let auth = authority::current(conn)?;
    ensure!(
        auth.dispatch_enabled
            && auth.epoch == binding.request.authority_epoch
            && work.id == binding.work_id
            && work.owner == binding.ghost_id
            && work.goal_revision == binding.goal_revision
            && work.owner_revision == binding.owner_revision
            && work.cancellation == "none"
            && graph::current_result_scope(conn, work)?,
        "Pi wait authority, Work revision or ancestry is no longer current"
    );
    if let Some(execution) = &work.execution_id {
        ensure!(
            binding
                .execution_id
                .as_ref()
                .is_none_or(|original| original == execution),
            "Pi wait execution changed"
        );
        let (assignment,generation,epoch,state):(String,u64,u64,String)=conn.query_row("SELECT assignment_id,generation_task_id,authority_epoch,state FROM lifetime_pi_executions WHERE work_id=?1 AND execution_id=?2",params![work.id,execution],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        ensure!(
            assignment == binding.assignment_id
                && generation == binding.generation_task_id
                && epoch == auth.epoch,
            "Pi wait generation binding changed"
        );
        let unknown:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_pi_effects WHERE execution_id=?1 AND state<>'complete')",[execution],|r|r.get(0))?;
        if unknown || state != "running" {
            return Ok("unknown");
        }
    } else {
        ensure!(
            binding.execution_id.is_none(),
            "Pi wait lost original execution"
        );
    }
    let targets = binding.request.body["wait_for"]
        .as_array()
        .ok_or_else(|| anyhow!("Pi wait original targets missing"))?;
    let mut query = conn.prepare(
        "SELECT blocker_work_id,kind FROM lifetime_blocking_edges WHERE waiter_work_id=?1",
    )?;
    let edges = query
        .query_map([&work.id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, kind) in &edges {
        ensure!(
            kind != "dependency" || targets.iter().any(|target| target.as_str() == Some(id)),
            "Pi wait dependencies differ from original set"
        );
    }
    if !edges.is_empty() {
        ensure!(
            work.state == "blocked"
                && work
                    .blocker
                    .as_deref()
                    .is_some_and(|reason| reason.starts_with(graph::WAIT_BLOCKER)),
            "Pi wait blocker is not original dependency wait"
        );
        return Ok("waiting");
    }
    ensure!(
        matches!(work.state.as_str(), "queued" | "running"),
        "Pi wait is no longer resumable"
    );
    for target in targets {
        let target = db::work(
            conn,
            target
                .as_str()
                .ok_or_else(|| anyhow!("Pi wait target invalid"))?,
        )?
        .ok_or_else(|| anyhow!("Pi wait target disappeared"))?;
        ensure!(
            matches!(target.state.as_str(), "accepted" | "failed" | "cancelled"),
            "Pi wait target has no resolved terminal fact"
        );
    }
    Ok("resolved")
}
pub(super) fn prepare(
    conn: &Connection,
    envelope: &Envelope,
    principal: &str,
    work: &Work,
) -> Result<Option<Binding>> {
    let body = &envelope.body;
    if !body.get("assignment_id").is_some() && !body.get("generation_task_id").is_some() {
        return Ok(None);
    }
    let assignment = apply::string_field(body, "assignment_id")?;
    let generation = apply::number_field(body, "generation_task_id")?;
    ensure!(
        generation > 0 && generation <= 9_007_199_254_740_991 && principal == work.owner,
        "Pi wait generation or actor invalid"
    );
    let goal = db::goal(conn, &work.goal_id)?.ok_or_else(|| anyhow!("Pi wait Goal missing"))?;
    let request = PiToolRequest {
        context_ref: None, ghost_id: principal.into(),
        conversation_id: goal.reply_conversation.clone(),
        envelope: envelope.clone(),
    };
    pi_execution::validate_assignment(conn, &request)?;
    if let Some(previous) = active(conn, work)? {
        ensure!(
            phase(conn, &previous, work)? == "resolved",
            "Original Pi wait remains unresolved"
        );
        let mut resumed = work.clone();
        resume(conn, &mut resumed, assignment, generation)?;
    }
    if let Some(execution) = &work.execution_id {
        let (id,task):(String,u64)=conn.query_row("SELECT assignment_id,generation_task_id FROM lifetime_pi_executions WHERE execution_id=?1 AND work_id=?2",params![execution,work.id],|r|Ok((r.get(0)?,r.get(1)?)))?;
        ensure!(
            id == assignment && task == generation,
            "Pi wait cannot replace its execution generation"
        );
        let alive:bool=conn.query_row("SELECT state='running' AND ?2<=created_ms+deadline_ms+paused_ms FROM lifetime_pi_executions WHERE execution_id=?1",params![execution,crate::host::now_ms()],|r|r.get(0))?;
        ensure!(
            alive,
            "Pi execution deadline expired before dependency wait"
        );

        ensure!(!conn.query_row("SELECT EXISTS(SELECT 1 FROM lifetime_pi_effects WHERE execution_id=?1 AND state<>'complete')",[execution],|r|r.get::<_,bool>(0))?,"Pi wait cannot park an unresolved effect");
    }
    Ok(Some(Binding {
        request: envelope.clone(),
        assignment_id: assignment.into(),
        generation_task_id: generation,
        work_id: work.id.clone(),
        goal_revision: work.goal_revision,
        owner_revision: work.owner_revision,
        ghost_id: principal.into(),
        conversation_id: goal.reply_conversation,
        execution_id: work.execution_id.clone(),
        started_ms: crate::host::now_ms(),
    }))
}
pub(super) fn store(conn: &Connection, binding: &Binding) -> Result<Value> {
    ensure!(
        get(conn, "pi_work_wait", &binding.request.command_id)?.is_none(),
        "Pi wait immutable identity already exists"
    );
    put(
        conn,
        "pi_work_wait",
        &binding.request.command_id,
        &serde_json::to_value(binding)?,
    )?;
    put(
        conn,
        "pi_work_wait_active",
        &binding.work_id,
        &json!({"command_id":binding.request.command_id}),
    )?;
    let work =
        db::work(conn, &binding.work_id)?.ok_or_else(|| anyhow!("Pi wait Work disappeared"))?;
    if work.state == "queued" && work.blocker.is_none() {
        put(
            conn,
            "pi_work_wait_resolved",
            &binding.request.command_id,
            &json!({"at_ms":binding.started_ms}),
        )?;
    }
    Ok(receipt(binding))
}
pub(super) fn mark_resolved(conn: &Connection, work: &Work) -> Result<()> {
    let Some(binding) = active(conn, work)? else {
        return Ok(());
    };
    if phase(conn, &binding, work).is_ok_and(|phase| phase == "resolved")
        && get(conn, "pi_work_wait_resolved", &binding.request.command_id)?.is_none()
    {
        put(
            conn,
            "pi_work_wait_resolved",
            &binding.request.command_id,
            &json!({"at_ms":crate::host::now_ms()}),
        )?;
    }
    Ok(())
}
fn pause_until(conn: &Connection, binding: &Binding, now: u64) -> Result<u64> {
    let end = get(conn, "pi_work_wait_resolved", &binding.request.command_id)?
        .and_then(|value| value["at_ms"].as_u64())
        .unwrap_or(now);
    Ok(end.saturating_sub(binding.started_ms))
}
pub(super) fn projection(
    conn: &Connection,
    work: &Work,
    assignment: &str,
) -> Result<Option<Value>> {
    let Some(binding) = active(conn, work)? else {
        return Ok(None);
    };
    if binding.assignment_id != assignment {
        return Ok(None);
    }
    Ok(Some(
        json!({"receipt":receipt(&binding),"phase":phase(conn,&binding,work)?}),
    ))
}
pub(super) fn has_bound_wait(conn: &Connection, work: &Work) -> Result<bool> {
    // A fenced original generation is not permission to admit a replacement.
    // Only an explicit new Work/owner revision can leave this bound wait.
    Ok(active(conn, work)?.is_some_and(|binding| {
        binding.goal_revision == work.goal_revision
            && binding.owner_revision == work.owner_revision
            && binding.ghost_id == work.owner
    }))
}
pub(super) fn inspect(conn: &Connection, request: &PiToolRequest) -> Result<Response> {
    let body = &request.envelope.body;
    apply::allowed_fields(
        body,
        &[
            "method",
            "assignment_id",
            "work_id",
            "generation_task_id",
            "wait_command_id",
            "wait_payload_digest",
            "wait_for",
            "work_memory_context_revision",
        ],
        &[
            "method",
            "assignment_id",
            "work_id",
            "generation_task_id",
            "wait_command_id",
            "wait_payload_digest",
            "wait_for",
        ],
    )?;
    let work = db::work(conn, apply::string_field(body, "work_id")?)?
        .ok_or_else(|| anyhow!("Pi waiting Work missing"))?;
    let binding = active(conn, &work)?.ok_or_else(|| anyhow!("Pi active wait missing"))?;
    ensure!(
        binding.ghost_id == request.ghost_id
            && binding.conversation_id == request.conversation_id
            && body["assignment_id"] == binding.assignment_id
            && body["generation_task_id"] == binding.generation_task_id
            && body["wait_command_id"] == binding.request.command_id
            && body["wait_payload_digest"] == binding.request.payload_digest
            && body["wait_for"] == binding.request.body["wait_for"],
        "Pi wait inspection identity or exact target set mismatch"
    );
    let phase = phase(conn, &binding, &work)?;
    Ok(apply::success(
        "Original Pi dependency wait inspected",
        vec![work.id.clone()],
        json!({"wait_receipt":receipt(&binding),"phase":phase}),
    ))
}
pub(super) fn assert_resumed(
    conn: &Connection,
    work: &Work,
    assignment: &str,
    generation: u64,
) -> Result<()> {
    let Some(binding) = active(conn, work)? else {
        return Ok(());
    };
    ensure!(
        binding.assignment_id == assignment
            && binding.generation_task_id == generation
            && get(conn, "pi_work_wait_resumed", &binding.request.command_id)?.is_some(),
        "Pi dependencies are not resolved and resumed"
    );
    Ok(())
}
pub(super) fn ongoing_pause_ms(conn: &Connection, work: &Work, now: u64) -> Result<u64> {
    let Some(binding) = active(conn, work)? else {
        return Ok(0);
    };
    if get(conn, "pi_work_wait_resumed", &binding.request.command_id)?.is_some() {
        return Ok(0);
    }
    ensure!(
        matches!(phase(conn, &binding, work)?, "waiting" | "resolved"),
        "Pi wait is unresolved or fenced"
    );
    pause_until(conn, &binding, now)
}
pub(super) fn resume(
    conn: &Connection,
    work: &mut Work,
    assignment: &str,
    generation: u64,
) -> Result<()> {
    let Some(binding) = active(conn, work)? else {
        return Ok(());
    };
    if binding.assignment_id == assignment
        && binding.generation_task_id == generation
        && matches!(
            work.state.as_str(),
            "running" | "blocked" | "unknown" | "completed" | "accepted"
        )
        && get(conn, "pi_work_wait_resumed", &binding.request.command_id)?.is_some()
    {
        return Ok(());
    }
    ensure!(
        binding.assignment_id == assignment
            && binding.generation_task_id == generation
            && phase(conn, &binding, work)? == "resolved",
        "Pi execution cannot resume before its original wait resolves"
    );
    conn.execute_batch("SAVEPOINT ghost_pi_wait_resume")?;
    let result = (|| -> Result<()> {
        if get(conn, "pi_work_wait_resumed", &binding.request.command_id)?.is_none() {
            if let Some(execution) = &binding.execution_id {
                // Append only newly accepted exact dependencies to the original
                // execution's immutable input manifest. Existing provenance is
                // never replaced by a later child attempt or mutable alias.
                let raw: String = conn.query_row(
                    "SELECT input_artifacts_json FROM lifetime_pi_executions WHERE execution_id=?1",
                    [execution],
                    |r| r.get(0),
                )?;
                let mut pinned: Vec<crate::lifetime_contract::WorkerArtifactInput> =
                    serde_json::from_str(&raw)?;
                let current = graph::native_artifact_inputs(conn, work)?.unwrap_or_default();
                for old in &pinned {
                    ensure!(
                        current
                            .iter()
                            .any(|candidate| serde_json::to_value(candidate).ok()
                                == serde_json::to_value(old).ok()),
                        "Original Pi artifact input changed during wait"
                    );
                }
                for input in current {
                    if pinned.iter().any(|old| old.work_id == input.work_id) {
                        continue;
                    }
                    if !binding.request.body["wait_for"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|id| id.as_str() == Some(&input.work_id))
                    {
                        continue;
                    }
                    ensure!(
                        db::work(conn, &input.work_id)?
                            .is_some_and(|child| child.state == "accepted"),
                        "Pi wait input has no independent acceptance"
                    );
                    pinned.push(input);
                }
                conn.execute("UPDATE lifetime_pi_executions SET input_artifacts_json=?2 WHERE execution_id=?1",params![execution,serde_json::to_string(&pinned)?])?;
                conn.execute(
                "UPDATE lifetime_pi_executions SET paused_ms=paused_ms+?2 WHERE execution_id=?1",
                params![
                    execution,
                    pause_until(conn,&binding,crate::host::now_ms())?
                ],
            )?;
            }
            put(
                conn,
                "pi_work_wait_resumed",
                &binding.request.command_id,
                &json!({"resumed":true}),
            )?;
        }
        if work.state == "queued" && work.execution_id.is_some() {
            work.state = "running".into();
            db::update_work(conn, work)?;
        }
        Ok(())
    })();
    if result.is_ok() {
        conn.execute_batch("RELEASE ghost_pi_wait_resume")?;
    } else {
        conn.execute_batch("ROLLBACK TO ghost_pi_wait_resume; RELEASE ghost_pi_wait_resume")?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::super::pi_tools::PiInferenceScope;
    use super::*;
    use crate::host::{
        self,
        lifetime::pi_execution::tests::{envelope, request, setup_with_spec, Fixture},
        Host, State,
    };
    use std::{
        collections::BTreeMap,
        fs::File,
        sync::{atomic::AtomicBool, Mutex},
    };
    async fn action(f: &Fixture, body: Value) -> Result<Response> {
        let mut command = envelope(&f.ghost, body);
        command.expected_revision = Some(1);
        let frame = f
            .host
            .lifetime_pi_action(
                &PiToolRequest {
                    context_ref: None, ghost_id: f.ghost.clone(),
                    conversation_id: f.conversation.clone(),
                    envelope: command,
                },
                PiInferenceScope::Public,
            )
            .await?;
        ensure!(frame["ok"] == true, "{frame}");
        Ok(serde_json::from_value(frame["result"].clone())?)
    }
    async fn delegate_child(f: &Fixture) -> Result<String> {
        let target = uuid::Uuid::new_v4().to_string();
        let conversation = uuid::Uuid::new_v4().to_string();
        {
            let state = f.host.lock()?;
            let result = super::super::apply(
                &state.journal.0,
                &envelope(
                    "owner",
                    json!({"method":"registry.ensure","ghost_id":target,"conversation_id":conversation,"kind":"specialist","roles":["research"]}),
                ),
                "owner",
            )?;
            ensure!(result.status == ResponseStatus::Success, "{result:?}");
        }
        let response=action(f,json!({"method":"work.delegate","parent_work_id":f.work,"target_ghost_id":target,"summary":"Synthetic independent dependency","acceptance_spec":{},"artifact_refs":[]})).await?;
        ensure!(response.status == ResponseStatus::Success, "{response:?}");
        Ok(response.data["work"]["id"].as_str().unwrap().to_string())
    }
    fn wait(f: &Fixture, child: &str) -> PiToolRequest {
        let mut command = envelope(
            &f.ghost,
            json!({"method":"work.wait","work_id":f.work,"wait_for":[child],"assignment_id":f.assignment,"generation_task_id":7}),
        );
        command.expected_revision = Some(1);
        PiToolRequest {
            context_ref: None, ghost_id: f.ghost.clone(),
            conversation_id: f.conversation.clone(),
            envelope: command,
        }
    }
    fn inspect(f: &Fixture, wait: &PiToolRequest) -> PiToolRequest {
        PiToolRequest {
            context_ref: None, ghost_id: f.ghost.clone(),
            conversation_id: f.conversation.clone(),
            envelope: envelope(
                &f.ghost,
                json!({"method":"work.wait.inspect","assignment_id":f.assignment,"work_id":f.work,"generation_task_id":7,"wait_command_id":wait.envelope.command_id,"wait_payload_digest":wait.envelope.payload_digest,"wait_for":wait.envelope.body["wait_for"]}),
            ),
        }
    }
    async fn callback(f: &Fixture, request: &PiToolRequest) -> Result<Value> {
        f.host
            .lifetime_pi_action(request, PiInferenceScope::Public)
            .await
    }
    fn cold(f: Fixture) -> Result<Fixture> {
        let Fixture {
            _root,
            host,
            ghost,
            conversation,
            assignment,
            work,
        } = f;
        drop(host);
        let profiles = crate::store::list_profiles(_root.path())?
            .into_iter()
            .map(|name| {
                Host::profile(crate::store::ProfileStore::open_profile(
                    _root.path(),
                    &name,
                )?)
                .map(|profile| (profile.id.clone(), profile))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        let journal = host::scheduler::Journal::open(&_root.path().join("workspace.db"))?;
        let computers = host::lifetime_computers::NativeComputers::pi_fixture(
            &_root.path().join("registry"),
            &ghost,
        )?;
        let host = Host {
            root: _root.path().into(),
            state: Mutex::new(State { profiles, journal }),
            handle: tokio::runtime::Handle::current(),
            default_model: "mock".into(),
            _lock: host::WorkspaceLock(File::create(_root.path().join("test.lock"))?),
            brain: crate::adapters::memory::Brain::default(),
            computer: crate::adapters::computer::default_backend(),
            integrations: host::integrations::Connections::default(),
            workers: Mutex::new(vec![]),
            profile_workers: Mutex::new(BTreeMap::new()),
            recovery: tokio::sync::Mutex::new(()),
            stopping: AtomicBool::new(false),
            legacy_fixture_reasoning: AtomicBool::new(false),
            dispatch_enabled: true,
            pi_callback_token: String::new(),
            pi_local_route: None,
            authority_epoch: 1,
            native_computers: Some(computers),
        };
        Ok(Fixture {
            _root,
            host,
            ghost,
            conversation,
            assignment,
            work,
        })
    }
    #[tokio::test]
    async fn pi_wait_prework_exact_ack_cold_release_resumes_original_execution_without_duplicate_effects(
    ) -> Result<()> {
        let f = setup_with_spec(json!({}));
        let original = request(
            &f,
            10,
            "before-wait",
            "write",
            json!({"path":"answer.txt","content":"before"}),
        );
        let first = f
            .host
            .lifetime_pi_execution_action(&original, PiInferenceScope::Public)
            .await?;
        ensure!(first.status == ResponseStatus::Success, "{first:?}");
        let execution = first.data["receipt"]["execution_id"]
            .as_str()
            .unwrap()
            .to_string();
        let child = delegate_child(&f).await?;
        let waiting = wait(&f, &child);
        let accepted = callback(&f, &waiting).await?;
        ensure!(accepted["result"]["status"] == "success", "{accepted}");
        assert_eq!(
            accepted,
            callback(&f, &waiting).await?,
            "Lost ACK must return exact original wait receipt"
        );
        // Deterministic clock advancement: the wait lasts two seconds while
        // the original execution has only a one-second active budget.
        {
            let state = f.host.lock()?;
            let conn = &state.journal.0;
            let now = crate::host::now_ms();
            conn.execute(
                "UPDATE lifetime_pi_executions SET created_ms=?1,deadline_ms=1000",
                [now - 2000],
            )?;
            let mut binding: Binding = serde_json::from_value(
                get(conn, "pi_work_wait", &waiting.envelope.command_id)?.unwrap(),
            )?;
            binding.started_ms = now - 2000;
            put(
                conn,
                "pi_work_wait",
                &waiting.envelope.command_id,
                &serde_json::to_value(binding)?,
            )?;
            let work = db::work(conn, &f.work)?.unwrap();
            assert!(ongoing_pause_ms(conn, &work, now)? >= 2000);
        }
        let f = cold(f)?;
        let projection=action(&f,json!({"method":"conversation.assignment.inspect","assignment_id":f.assignment,"ghost_id":f.ghost,"conversation_id":f.conversation})).await?;
        assert_eq!(projection.data["work_wait"]["phase"], "waiting");
        assert_eq!(projection.data["execution"]["engine"], "pi");
        let poll = inspect(&f, &waiting);
        assert_eq!(
            callback(&f, &poll).await?["result"]["data"]["phase"],
            "waiting"
        );
        assert!(f
            .host
            .lifetime_pi_execution_action(
                &request(
                    &f,
                    11,
                    "while-waiting",
                    "write",
                    json!({"path":"never.txt","content":"no"})
                ),
                PiInferenceScope::Public
            )
            .await
            .is_err());
        {
            let state = f.host.lock()?;
            assert_eq!(
                state
                    .journal
                    .0
                    .query_row("SELECT COUNT(*) FROM lifetime_pi_effects", [], |r| r
                        .get::<_, u64>(0))?,
                1
            );
            let cancel = super::super::apply(
                &state.journal.0,
                &envelope("owner", json!({"method":"work.cancel","work_id":child})),
                "owner",
            )?;
            assert_eq!(cancel.status, ResponseStatus::Success);
        }
        assert_eq!(
            callback(&f, &poll).await?["result"]["data"]["phase"],
            "resolved"
        );
        let resumed = f
            .host
            .lifetime_pi_execution_action(
                &request(
                    &f,
                    12,
                    "after-wait",
                    "write",
                    json!({"path":"answer.txt","content":"after"}),
                ),
                PiInferenceScope::Public,
            )
            .await?;
        assert_eq!(resumed.status, ResponseStatus::Success, "{resumed:?}");
        assert_eq!(resumed.data["receipt"]["execution_id"], execution);
        assert_eq!(
            first,
            f.host
                .lifetime_pi_execution_action(&original, PiInferenceScope::Public)
                .await?
        );
        let read = f
            .host
            .lifetime_pi_execution_action(
                &request(&f, 13, "read-resumed", "read", json!({"path":"answer.txt"})),
                PiInferenceScope::Public,
            )
            .await?;
        assert_eq!(read.data["output"]["content"], "after");
        let state = f.host.lock()?;
        let work = db::work(&state.journal.0, &f.work)?.unwrap();
        assert_eq!(work.execution_id.as_deref(), Some(execution.as_str()));
        assert_eq!(work.state, "running");
        assert_eq!(
            state
                .journal
                .0
                .query_row("SELECT COUNT(*) FROM lifetime_pi_executions", [], |r| r
                    .get::<_, u64>(0))?,
            1
        );
        assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1",[&f.work],|r|r.get::<_,u64>(0))?,1);
        assert_eq!(
            state.journal.0.query_row(
                "SELECT COUNT(*) FROM lifetime_outbox WHERE target='worker'",
                [],
                |r| r.get::<_, u64>(0)
            )?,
            0
        );
        Ok(())
    }
    #[tokio::test]
    async fn pi_wait_exact_targets_epoch_cancel_and_unknown_effects_remain_fenced() -> Result<()> {
        let f = setup_with_spec(json!({}));
        let child = delegate_child(&f).await?;
        let waiting = wait(&f, &child);
        ensure!(callback(&f, &waiting).await?["result"]["status"] == "success");
        let mut wrong = inspect(&f, &waiting);
        wrong.envelope.body["wait_for"] = json!([]);
        wrong.envelope.payload_digest = canonical_digest(&wrong.envelope.body)?;
        assert!(callback(&f, &wrong).await?["ok"] != true);
        let mut old = inspect(&f, &waiting);
        old.envelope.authority_epoch = 2;
        let response = callback(&f, &old).await?;
        assert_eq!(response["result"]["error_code"], "authority_fenced");
        {
            let state = f.host.lock()?;
            super::super::apply(
                &state.journal.0,
                &envelope("owner", json!({"method":"work.cancel","work_id":f.work})),
                "owner",
            )?;
        }
        assert!(callback(&f, &inspect(&f, &waiting)).await?["ok"] != true);
        let f = setup_with_spec(json!({}));
        let before = f
            .host
            .lifetime_pi_execution_action(
                &request(
                    &f,
                    10,
                    "before-revoke",
                    "write",
                    json!({"path":"grant.txt","content":"before"}),
                ),
                PiInferenceScope::Public,
            )
            .await?;
        let child = delegate_child(&f).await?;
        let waiting = wait(&f, &child);
        ensure!(callback(&f, &waiting).await?["result"]["status"] == "success");
        f.host.native_computers.as_ref().unwrap().pi_release(
            &f.ghost,
            before.data["receipt"]["execution_id"].as_str().unwrap(),
            1,
        )?;
        assert!(callback(&f, &inspect(&f, &waiting)).await?["ok"] != true);
        let f = setup_with_spec(json!({}));
        let child = delegate_child(&f).await?;
        f.host
            .lifetime_pi_execution_action(
                &request(
                    &f,
                    10,
                    "unknown-source",
                    "write",
                    json!({"path":"answer.txt","content":"source"}),
                ),
                PiInferenceScope::Public,
            )
            .await?;
        {
            let state = f.host.lock()?;
            state.journal.0.execute(
                "UPDATE lifetime_pi_effects SET state='pending',response_json=NULL",
                [],
            )?;
        }
        assert!(callback(&f, &wait(&f, &child)).await?["ok"] != true);
        let state = f.host.lock()?;
        assert_eq!(
            state.journal.0.query_row(
                "SELECT COUNT(*) FROM workspace_objects WHERE kind='pi_work_wait'",
                [],
                |r| r.get::<_, u64>(0)
            )?,
            0
        );
        assert_eq!(
            db::work(&state.journal.0, &f.work)?.unwrap().state,
            "running"
        );
        Ok(())
    }
    #[tokio::test]
    async fn pi_wait_epoch_change_and_child_release_never_admit_a_replacement_generation(
    ) -> Result<()> {
        let f = setup_with_spec(json!({}));
        let child = delegate_child(&f).await?;
        let waiting = wait(&f, &child);
        ensure!(callback(&f, &waiting).await?["result"]["status"] == "success");
        {
            let state = f.host.lock()?;
            state
                .journal
                .0
                .execute("UPDATE lifetime_authority SET authority_epoch=2", [])?;
            let mut cancel = envelope("owner", json!({"method":"work.cancel","work_id":child}));
            cancel.authority_epoch = 2;
            let response = super::super::apply(&state.journal.0, &cancel, "owner")?;
            ensure!(response.status == ResponseStatus::Success, "{response:?}");
            let root = db::work(&state.journal.0, &f.work)?.unwrap();
            assert_eq!(root.state, "queued");
            assert!(root.execution_id.is_none());
            assert_eq!(state.journal.0.query_row("SELECT COUNT(*) FROM lifetime_outbox WHERE target='pi' AND json_extract(payload,'$.body.method')='conversation.assignment' AND json_extract(payload,'$.body.work_id')=?1",[&f.work],|r|r.get::<_,u64>(0))?,1);
            assert_eq!(
                state.journal.0.query_row(
                    "SELECT COUNT(*) FROM lifetime_pi_executions",
                    [],
                    |r| r.get::<_, u64>(0)
                )?,
                0
            );
        }
        let poll = callback(&f, &inspect(&f, &waiting)).await?;
        assert!(poll["ok"] != true || poll["result"]["status"] != "success");
        Ok(())
    }
}
