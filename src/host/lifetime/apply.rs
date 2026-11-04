use super::{db, db::revision};
use crate::lifetime_contract::{
    canonical_digest, Acceptance, Artifact, Envelope, Goal, Response, ResponseStatus,
    RetryClass, RuntimeBinding, Work, WorkerSpec, VERSION,
};
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Debug)]
pub(super) struct Rejected {
    code: &'static str,
    summary: String,
    retry_class: RetryClass,
}
impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.summary)
    }
}
impl std::error::Error for Rejected {}

pub(super) fn reject(code: &'static str, summary: impl Into<String>, retry_class: RetryClass) -> anyhow::Error {
    anyhow::Error::new(Rejected {
        code,
        summary: summary.into(),
        retry_class,
    })
}
pub(super) fn conflict(summary: impl Into<String>) -> anyhow::Error {
    reject("conflict", summary, RetryClass::NewRevision)
}
pub(super) fn invalid(summary: impl Into<String>) -> anyhow::Error {
    reject("invalid_request", summary, RetryClass::Never)
}
pub(super) fn not_found(summary: impl Into<String>) -> anyhow::Error {
    reject("not_found", summary, RetryClass::Never)
}

fn error_response(code: &str, summary: impl Into<String>, retry_class: RetryClass) -> Response {
    Response {
        status: ResponseStatus::Error,
        summary: summary.into(),
        object_refs: Vec::new(),
        artifacts: Vec::new(),
        next_actions: Vec::new(),
        error_code: Some(code.to_owned()),
        retry_class,
        data: Value::Null,
    }
}
pub(super) fn success(summary: impl Into<String>, object_refs: Vec<String>, data: Value) -> Response {
    Response {
        status: ResponseStatus::Success,
        summary: summary.into(),
        object_refs,
        artifacts: Vec::new(),
        next_actions: Vec::new(),
        error_code: None,
        retry_class: RetryClass::SameId,
        data,
    }
}
pub(super) fn warning(summary: impl Into<String>, object_refs: Vec<String>, data: Value) -> Response {
    Response {
        status: ResponseStatus::Warning,
        summary: summary.into(),
        object_refs,
        artifacts: Vec::new(),
        next_actions: vec!["inspect_current_state".to_owned()],
        error_code: None,
        retry_class: RetryClass::ReconcileFirst,
        data,
    }
}

pub(super) fn apply(conn: &Connection, envelope: &Envelope, principal: &str,
    admission: impl FnOnce(&Connection) -> Result<Option<Response>>) -> Result<Response> {
    if let Err(error) = envelope.validate() {
        return Ok(error_response(
            "invalid_envelope",
            error.to_string(),
            RetryClass::Never,
        ));
    }
    if principal.is_empty() || principal != envelope.actor_ref {
        return Ok(error_response(
            "unauthorized",
            "authenticated principal does not match envelope actor",
            RetryClass::Never,
        ));
    }

    let thread_read = envelope.body["method"] == "goal.thread.inspect";
    let behavior = if thread_read { TransactionBehavior::Deferred } else { TransactionBehavior::Immediate };
    let tx = Transaction::new_unchecked(conn, behavior)?;
    let epoch = revision(envelope.authority_epoch)?;
    if let Some(response) = super::authority::guard(&tx, envelope)? {
        return Ok(response);
    }
    if envelope.body["method"].as_str() == Some("command.inspect") {
        if principal != "owner" {
            return Ok(error_response("unauthorized", "command receipts require owner authentication", RetryClass::Never));
        }
        let response = super::receipts::inspect(&tx, envelope, principal)?;
        tx.commit()?;
        return Ok(response);
    }
    if thread_read {
        let response = match super::work_threads::inspect(&tx, &envelope.body, principal) {
            Ok(response) => response,
            Err(error) => match error.downcast_ref::<Rejected>() {
                Some(rejection) => error_response(rejection.code, &rejection.summary, rejection.retry_class.clone()),
                None => return Err(error),
            },
        };
        tx.commit()?;
        return Ok(response);
    }
    let mut recheck_waiting = false;
    let previous: Option<(String, String, i64, String)> = tx
        .query_row(
            "SELECT payload_digest,actor_ref,authority_epoch,response FROM lifetime_commands WHERE command_id=?1",
            [&envelope.command_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if let Some((digest, actor, old_epoch, response)) = previous {
        if digest != envelope.payload_digest || actor != principal || old_epoch != epoch {
            tx.commit()?;
            return Ok(error_response(
                "conflict",
                "command ID was already used with a different actor, epoch, or body",
                RetryClass::Never,
            ));
        }
        let cached: Response = serde_json::from_str(&response)?;
        // waiting_host is emitted before work.submit changes state or queues an
        // effect. Recheck this known no-effect intent after cancellation settles.
        if cached.status == ResponseStatus::Error && cached.error_code.as_deref() == Some("waiting_host") {
            recheck_waiting = true;
        } else {
            tx.commit()?;
            return Ok(cached);
        }
    }

    let mut context = ApplyContext::default();
    tx.execute_batch("SAVEPOINT lifetime_action;")?;
    let mut response = match admission(&tx)? {
        Some(response) => response,
        None => match dispatch(&tx, envelope, principal, &mut context) {
            Ok(response) => response,
            Err(error) => match error.downcast_ref::<Rejected>() {
                Some(rejection) => error_response(
                    rejection.code,
                    rejection.summary.clone(),
                    rejection.retry_class.clone(),
                ),
                None => return Err(error),
            },
        },
    };
    if response.status == ResponseStatus::Error {
        tx.execute_batch("ROLLBACK TO lifetime_action;")?;
        context.outbox.clear();
        // This witnesses the original command, not a fenced replay attempt.
        // Historical error receipts remain byte-for-byte unchanged.
        response.data = json!({ "host_effect_class": "no_effect" });
    }
    tx.execute_batch("RELEASE lifetime_action;")?;

    if recheck_waiting {
        tx.execute(
            "UPDATE lifetime_commands SET response=?1 WHERE command_id=?2",
            params![serde_json::to_string(&response)?, envelope.command_id],
        )?;
    } else {
        tx.execute(
            "INSERT INTO lifetime_commands(command_id,payload_digest,actor_ref,authority_epoch,request,response) VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                envelope.command_id,
                envelope.payload_digest,
                principal,
                epoch,
                serde_json::to_string(envelope)?,
                serde_json::to_string(&response)?,
            ],
        )?;
    }
    for item in context.outbox {
        tx.execute(
            "INSERT INTO lifetime_outbox(command_id,target,delivery_ref,payload) VALUES(?1,?2,?3,?4)",
            params![
                item.source_command_id.as_deref().unwrap_or(&envelope.command_id),
                item.target,
                item.payload.get("command_id").and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("outgoing delivery is missing its receiver command ID"))?,
                serde_json::to_string(&item.payload)?,
            ],
        )?;
        if item.target=="pi" {super::work_context::admitted(&tx,&item.payload)?;}
    }
    tx.commit()?;
    Ok(response)
}

#[derive(Default)]
pub(super) struct ApplyContext {
    outbox: Vec<PendingOutbox>,
}
struct PendingOutbox {
    target: &'static str,
    payload: Value,
    // When set, the committed outbox row uses this command ID instead of the
    // current envelope's, binding the delivery to its original cause command.
    source_command_id: Option<String>,
}
impl ApplyContext {
    pub(super) fn enqueue(&mut self, target: &'static str, payload: Value) {
        self.outbox.push(PendingOutbox {
            target,
            payload,
            source_command_id: None,
        });
    }

    pub(super) fn enqueue_from(
        &mut self,
        source_command_id: String,
        target: &'static str,
        payload: Value,
    ) {
        self.outbox.push(PendingOutbox {
            target,
            payload,
            source_command_id: Some(source_command_id),
        });
    }
}

fn dispatch(
    conn: &Transaction<'_>,
    envelope: &Envelope,
    principal: &str,
    context: &mut ApplyContext,
) -> Result<Response> {
    let method = string_field(&envelope.body, "method")?;
    if super::selected_tasks::handles(method) {
        return super::selected_tasks::apply(conn, envelope, principal, context);
    }
    if super::conversation::handles(method) {
        return super::conversation::apply(conn, envelope, principal, context);
    }
    if super::mailbox::handles(method) {
        return super::mailbox::apply(conn, envelope, principal);
    }
    if super::graph::handles(method) {
        return super::graph::apply(conn, envelope, principal, context);
    }
    match method {
        "work.memory.profile.configure" | "work.memory.bind" | "work.memory.revoke" | "work.experience.inspect" | "work.experience.resume" => super::super::work_memory::apply_owner(conn, envelope, principal),
        "task.contract.register" => super::task_contracts::register(conn,envelope,principal),
        "bot.definition.update" | "bot.definition.inspect" => super::super::bots_store::apply_owner(conn, envelope, principal),
        "bot.evaluation_profile.configure" => super::super::bots_provisioning::configure_evaluator(conn,envelope,principal),
        "bot.candidate.inspect" => super::super::bots_provisioning::inspect(conn,envelope,principal),
        "bot.discover" => super::super::bots_provisioning::discover(conn,envelope,principal),
        "bot.surface.inspect" => super::super::bot_lifecycle::surface(conn,envelope,principal),
        "bot.lifecycle.inspect" | "bot.lifecycle.set" => super::super::bot_lifecycle::apply_owner(conn,envelope,principal),
        "bot.update.prepare" | "bot.clone.prepare" => {
            let evaluated=super::super::bot_lifecycle::prepare(conn,envelope,principal)?;
            let body=super::super::bots_provisioning::evaluation_goal(conn,&evaluated,principal)?.ok_or_else(||invalid("new lifecycle candidate already has evaluation"))?;
            let mut request=envelope.clone();request.payload_digest=canonical_digest(&body)?;request.body=body;
            let admitted=admit_goal(conn,&request,principal,context,true)?;
            super::super::bots_provisioning::evaluation_admitted(conn,&evaluated,principal,Some(&admitted))
        },
        "bot.activate" => super::super::bots_provisioning::activate(conn,envelope,principal),
        "bot.runtime.prepare" => {
            let (response,body)=super::super::bots_provisioning::runtime_prepare(conn,envelope,principal)?;
            if let Some(body)=body {context.enqueue("pi",outgoing(envelope,principal,None,body)?);}
            Ok(response)
        },
        "bot.evaluate" | "bot.repair" => {
            let evaluated=if method=="bot.repair" {super::super::bots_provisioning::repaired_evaluation_envelope(conn,envelope)?} else {envelope.clone()};
            let planned=super::super::bots_provisioning::evaluation_goal(conn,&evaluated,principal)?;
            let admitted=if let Some(body)=planned {
                // This is the implementation of the authenticated evaluate
                // intent, not a nested command or an impersonated credential.
                let mut request=envelope.clone();request.payload_digest=canonical_digest(&body)?;request.body=body;
                Some(admit_goal(conn,&request,principal,context,true)?)
            } else {None};
            super::super::bots_provisioning::evaluation_admitted(conn,&evaluated,principal,admitted.as_ref())
        },
        "bot.prepare" | "bot.provision" => Err(reject("waiting_host","bot creation requires Host resource preflight",RetryClass::ReconcileFirst)),
        "goal.submit" => admit_goal(conn, envelope, principal, context, true),
        "goal.inspect" => goal_inspect(conn, &envelope.body),
        "goal.update" => goal_update(conn, envelope, principal, context),
        "work.submit" => work_submit(conn, envelope, principal, context),
        "work.pi.admit" => super::pi_execution::admit(conn, envelope, principal, context),
        "work.inspect" => work_inspect(conn, &envelope.body),
        "work.steer" => work_steer(conn, envelope, principal, context),
        "work.cancel" => work_cancel(conn, envelope, principal, context),
        "work.result" => work_result(conn, envelope, principal, context),
        "work.accept" => work_accept(conn, envelope, principal, context),
        _ => Err(reject(
            "unsupported_method",
            format!("unsupported lifetime method: {method}"),
            RetryClass::Never,
        )),
    }
}

pub(super) fn admit_goal(
    conn: &Connection,
    envelope: &Envelope,
    principal: &str,
    context: &mut ApplyContext,
    enqueue_pi: bool,
) -> Result<Response> {
    exact_fields(
        &envelope.body,
        &["method", "ghost_id", "conversation_id", "prompt", "privacy", "acceptance_spec"],
    )?;
    let ghost_id = string_field(&envelope.body, "ghost_id")?;
    let conversation_id = string_field(&envelope.body, "conversation_id")?;
    let prompt = string_field(&envelope.body, "prompt")?;
    let privacy = string_field(&envelope.body, "privacy")?;
    validate_identity("ghost_id", ghost_id)?;
    validate_identity("conversation_id", conversation_id)?;
    validate_text("prompt", prompt)?;
    validate_privacy(privacy)?;
    let acceptance_spec = value_field(&envelope.body, "acceptance_spec")?;
    if !super::super::bot_lifecycle::admission_allowed(conn,ghost_id)? {
        return Err(reject("bot_unavailable","Bot is paused, retired, or lacks an evaluated selected definition",RetryClass::NewRevision));
    }
    if !acceptance_spec.is_object() {
        return Err(invalid("acceptance_spec must be an object"));
    }
    validate_required_checks(acceptance_spec)?;
    let requirement_digest = canonical_digest(&json!({
        "prompt": prompt,
        "acceptance_spec": acceptance_spec,
    }))?;
    let goal = Goal {
        id: uuid::Uuid::now_v7().to_string(),
        revision: 1,
        requirement_digest,
        prompt: prompt.to_owned(),
        accountable_ghost: ghost_id.to_owned(),
        reply_conversation: conversation_id.to_owned(),
        privacy: privacy.to_owned(),
        state: "open".to_owned(),
        acceptance_spec: acceptance_spec.clone(),
    };
    let work = new_work(&goal, ghost_id, 1);
    let existing_binding = db::binding(conn, conversation_id)?;
    let binding_missing = existing_binding.is_none();
    let binding = match existing_binding {
        Some(binding) if binding.ghost_id != ghost_id => {
            return Err(conflict("conversation is already bound to another Ghost"));
        }
        Some(binding) => binding,
        None => RuntimeBinding {
            conversation_id: conversation_id.to_owned(),
            ghost_id: ghost_id.to_owned(),
            runtime_kind: "pi-durable".to_owned(),
            // The Pi handshake resolves its pinned release; admission itself is
            // durable before that runtime has been contacted.
            runtime_release: "unresolved".to_owned(),
            storage_ref: format!("durable/{ghost_id}/{conversation_id}"),
        },
    };

    db::insert_goal(conn, &goal)?;
    db::insert_work(conn, &work)?;
    if binding_missing {
        db::insert_binding(conn, &binding)?;
    }
    if enqueue_pi {
        let body = json!({
            "method": "conversation.assignment",
            "ghost_id": goal.accountable_ghost,
            "conversation_id": goal.reply_conversation,
            "goal_id": goal.id,
            "goal_revision": goal.revision,
            "work_id": work.id,
            "prompt": goal.prompt,
            "privacy": super::super::work_memory::assignment_privacy(conn,&work,&goal.privacy)?,
        });
        context.enqueue(
            "pi",
            outgoing(envelope, principal, Some(goal.revision), body)?,
        );
    }
    Ok(success(
        "goal durably admitted",
        vec![goal.id.clone(), work.id.clone()],
        json!({
            "goal": goal,
            "work": work,
            "binding": binding,
            "runtime_configured": false,
        }),
    ))
}

fn goal_inspect(conn: &Connection, body: &Value) -> Result<Response> {
    exact_fields(body, &["method", "goal_id"])?;
    let goal_id = string_field(body, "goal_id")?;
    let Some(goal) = db::goal(conn, goal_id)? else {
        return Err(not_found("goal not found"));
    };
    let works = db::works_for_goal(conn, goal_id)?;
    let mut refs = vec![goal.id.clone()];
    refs.extend(works.iter().map(|work| work.id.clone()));
    Ok(success(
        "goal inspected",
        refs,
        json!({ "goal": goal, "work": works }),
    ))
}

fn goal_update(
    conn: &Connection,
    envelope: &Envelope,
    principal: &str,
    context: &mut ApplyContext,
) -> Result<Response> {
    super::work_threads::goal_update_fields(&envelope.body)?;
    let goal_id = string_field(&envelope.body, "goal_id")?;
    let prompt = string_field(&envelope.body, "prompt")?;
    validate_text("prompt", prompt)?;
    let acceptance_spec = value_field(&envelope.body, "acceptance_spec")?;
    if !acceptance_spec.is_object() {
        return Err(invalid("acceptance_spec must be an object"));
    }
    validate_required_checks(acceptance_spec)?;
    let expected_revision = envelope
        .expected_revision
        .ok_or_else(|| conflict("goal.update requires expected_revision"))?;
    let Some(mut goal) = db::goal(conn, goal_id)? else {
        return Err(not_found("goal not found"));
    };
    if principal != super::conversation::OWNER_PRINCIPAL
        && principal != goal.accountable_ghost
    {
        return Err(reject(
            "unauthorized",
            "goal.update requires Owner administration or the accountable Goal Ghost",
            RetryClass::Never,
        ));
    }
    if goal.revision != expected_revision {
        return Err(conflict("goal revision changed; inspect before updating"));
    }
    let retained_owner_expectations = if envelope.body.get("follow_up").is_some() {
        super::work_threads::validate_follow_up(conn, &envelope.body, &goal, principal, prompt, acceptance_spec)?;
        Some(super::pi_execution::owner_goal_expectations(conn, &goal)?)
    } else {
        None
    };
    let next_revision = goal
        .revision
        .checked_add(1)
        .ok_or_else(|| invalid("goal revision overflow"))?;
    goal.revision = next_revision;
    goal.requirement_digest = canonical_digest(&json!({
        "prompt": prompt,
        "acceptance_spec": acceptance_spec,
    }))?;
    goal.prompt = prompt.to_owned();
    goal.acceptance_spec = acceptance_spec.clone();
    goal.state = "open".to_owned();
    if !db::update_goal(conn, &goal, expected_revision)? {
        return Err(conflict("goal revision changed during update"));
    }

    let mut works = db::works_for_goal(conn, goal_id)?;
    let mut has_current_work = false;
    let mut superseded_work_ids = BTreeSet::new();
    for work in &mut works {
        let was_current = work.goal_revision == expected_revision;
        if work.cancellation == "requested" {
            if was_current {
                superseded_work_ids.insert(work.id.clone());
            }
            // Keep the old execution at its old revision. A new work row may be
            // queued, but work.submit fences it until this cancellation settles.
        } else if work.cancellation == "confirmed" || is_terminal_state(&work.state) {
            if was_current {
                superseded_work_ids.insert(work.id.clone());
            }
            if work.cancellation != "confirmed" {
                work.state = "stale".to_owned();
                work.blocker = Some("goal requirement changed".to_owned());
                db::update_work(conn, work)?;
            }
        } else if was_current && retained_owner_expectations.is_some()
            && work.execution_id.is_none()
            && work.blocker.as_deref().is_some_and(|blocker| blocker.starts_with(super::graph::WAIT_BLOCKER))
        {
            // A parked Pi generation remains bound to its original revision.
            superseded_work_ids.insert(work.id.clone());
            work.state = "cancelled".to_owned();
            work.cancellation = "confirmed".to_owned();
            work.blocker = None;
            db::update_work(conn, work)?;
        } else if work.goal_revision == expected_revision && work.execution_id.is_none() {
            work.goal_revision = next_revision;
            // An explicit new requirement rearms unassigned delivery stops,
            // not an unresolved dependency wait or any original execution.
            if !work.blocker.as_deref().is_some_and(|blocker| {
                blocker.starts_with(super::graph::WAIT_BLOCKER)
            }) {
                work.state = "queued".to_owned();
                work.blocker = None;
            }
            db::update_work(conn, work)?;
            has_current_work = true;
        } else if work.execution_id.is_some() {
            if was_current {
                superseded_work_ids.insert(work.id.clone());
            }
            // An immutable worker spec cannot become a different requirement.
            // Reconcile the old attempt before admitting a fresh current work.
            work.cancellation = "requested".to_owned();
            work.state = "cancel_requested".to_owned();
            work.blocker = Some("requirement changed; waiting for prior execution cancellation".to_owned());
            db::update_work(conn, work)?;
            if !super::pi_execution::execution_is_pi(conn,work.execution_id.as_deref().unwrap())? {
                let body = json!({"method":"cancel","execution_id":work.execution_id});
                context.enqueue("worker",outgoing(envelope,principal,Some(work.goal_revision),body)?);
            }
        }
    }
    let mut replacement_work_id = None;
    if !has_current_work {
        let owner_revision = works
            .iter()
            .map(|work| work.owner_revision)
            .max()
            .unwrap_or(1);
        let work = new_work(&goal, &goal.accountable_ghost, owner_revision);
        replacement_work_id = Some(work.id.clone());
        db::insert_work(conn, &work)?;
        works.push(work);
    }
    super::graph::invalidate_descendants(conn, &goal, envelope, principal, context)?;
    if let Some(replacement_work_id) = replacement_work_id.as_deref() {
        super::graph::redirect_work_dependencies(
            conn,
            &superseded_work_ids,
            replacement_work_id,
        )?;
    }
    let mut current_queued_work = works.iter().filter(|work| {
        work.goal_revision == goal.revision
            && work.state == "queued"
            && work.execution_id.is_none()
            && work.cancellation == "none"
            && work.blocker.is_none()
    });
    if let Some(work) = current_queued_work.next() {
        if current_queued_work.next().is_some() {
            return Err(conflict(
                "Goal update produced ambiguous current queued Work assignments",
            ));
        }
        let pi_body = json!({
            "method": "conversation.assignment",
            "ghost_id": goal.accountable_ghost,
            "conversation_id": goal.reply_conversation,
            "goal_id": goal.id,
            "goal_revision": goal.revision,
            "work_id": work.id,
            "prompt": goal.prompt,
            "privacy": super::super::work_memory::assignment_privacy(conn,work,&goal.privacy)?,
        });
        context.enqueue(
            "pi",
            outgoing(envelope, principal, Some(goal.revision), pi_body)?,
        );
    }
    let mut refs = vec![goal.id.clone()];
    refs.extend(works.iter().map(|work| work.id.clone()));
    let mut data = json!({ "goal": goal, "work": works });
    if let Some(retained) = retained_owner_expectations {
        data["retained_owner_expectations"] = json!(retained);
    }
    Ok(success("goal requirement updated", refs, data))
}

fn work_inspect(conn: &Connection, body: &Value) -> Result<Response> {
    exact_fields(body, &["method", "work_id"])?;
    let work_id = string_field(body, "work_id")?;
    let Some(work) = db::work(conn, work_id)? else {
        return Err(not_found("work not found"));
    };
    let result = result_for_execution(conn, work.execution_id.as_deref())?;
    let acceptance = db::acceptance(conn, work_id)?;
    Ok(success(
        "work inspected",
        vec![work.id.clone()],
        json!({ "work": work, "result": result, "acceptance": acceptance }),
    ))
}

fn work_submit(
    conn: &Connection,
    envelope: &Envelope,
    principal: &str,
    context: &mut ApplyContext,
) -> Result<Response> {
    exact_fields(&envelope.body, &["method", "work_id", "spec"])?;
    let work_id = string_field(&envelope.body, "work_id")?;
    let mut spec = WorkerSpec::deserialize(value_field(&envelope.body, "spec")?)
        .map_err(|error| invalid(format!("invalid WorkerSpec: {error}")))?;
    let Some(mut work) = db::work(conn, work_id)? else {
        return Err(not_found("work not found"));
    };
    let Some(goal) = db::goal(conn, &work.goal_id)? else {
        return Err(anyhow!("lifetime work references a missing goal"));
    };
    if work.goal_revision != goal.revision || spec.work_revision != goal.revision {
        return Err(conflict("worker spec is stale for the current goal revision"));
    }
    if spec.work_id != work.id || spec.authority_epoch != envelope.authority_epoch {
        return Err(invalid("WorkerSpec work ID or authority epoch does not match"));
    }
    if work.cancellation != "none" || work.state == "cancelled" {
        return Err(conflict("cancelled work cannot be submitted"));
    }
    if let Some(existing_execution) = &work.execution_id {
        if existing_execution != &spec.execution_id {
            return Err(conflict("work already owns a different immutable execution handle"));
        }
        if !same_submit_spec(conn, envelope, &spec.execution_id)? {
            return Err(conflict("execution handle was already submitted with different content"));
        }
        return Ok(success(
            "existing execution handle recovered",
            vec![work.id.clone(), existing_execution.clone()],
            json!({ "work": work, "execution_id": existing_execution }),
        ));
    }
    if let Some(response) = super::graph::check_admission(conn, &work)? {
        return Ok(response);
    }
    let derived_inputs = super::graph::native_artifact_inputs(conn, &work)?;
    if spec.input_artifacts.as_deref().unwrap_or(&[])
        != derived_inputs.as_deref().unwrap_or(&[])
    {
        return Err(invalid("WorkerSpec input_artifacts do not match the current authoritative child graph"));
    }
    spec.input_artifacts = derived_inputs;
    // Seal the Ghost's pinned skills into the spec BEFORE allocation/route
    // admission: the joined skill privacy must gate routing. Refs derive from
    // the Host's own authenticated skill store (the same journal the store
    // pins), never from caller/Goal metadata. Omission requests Host derivation;
    // a caller-supplied set must match exactly. An empty store stays None so
    // historical specs stay byte-equivalent.
    let derived_skills = super::super::skills::refs_for_work(conn, &work.owner)?;
    match (&mut spec.skills, &derived_skills) {
        (None, _) => {}
        (Some(caller), Some(derived)) => {
            caller.sort_unstable_by(|a, b| a.name.cmp(&b.name));
            if *caller != *derived {
                return Err(invalid(
                    "worker spec skills diverge from the Ghost's authenticated skill store",
                ));
            }
        }
        _ => {
            return Err(invalid(
                "worker spec skills diverge from the Ghost's authenticated skill store",
            ))
        }
    }
    spec.skills = derived_skills;
    if let Some(remaining_ms) = super::graph::remaining_deadline_ms(conn, &work)? {
        spec.deadline_ms = spec.deadline_ms.min(remaining_ms);
    }
    if spec.execution_id.trim().is_empty() || spec.computer_id.trim().is_empty() {
        return Err(invalid("WorkerSpec execution_id and computer_id must not be empty"));
    }
    if spec.deadline_ms == 0 || spec.max_progress_bytes == 0 {
        return Err(invalid("WorkerSpec limits must be positive"));
    }
    if let Some(other) = work_for_execution(conn, &spec.execution_id)? {
        if other.id != work.id {
            return Err(conflict("execution ID is already bound to another work item"));
        }
    }
    for prior in db::works_for_goal(conn, &work.goal_id)? {
        if prior.id != work.id
            && prior.execution_id.is_some()
            && prior.cancellation == "requested"
        {
            return Err(reject(
                "waiting_host",
                "a previous execution cancellation must be confirmed before new work starts",
                RetryClass::ReconcileFirst,
            ));
        }
    }
    // Skills can make a public Goal's execution private. Persist that fact
    // before dispatch so reports and subsequent Pi turns cannot downgrade it.
    let mut disclosure = super::conversation::conversation_privacy(
        conn,
        &goal.accountable_ghost,
        &goal.reply_conversation,
    )?;
    super::conversation::raise_privacy(&mut disclosure, &goal.privacy)?;
    if let Some(skills) = &spec.skills {
        for skill in skills {
            let privacy = match skill.privacy.as_str() {
                "public" => "public",
                "private" => "private",
                _ => "local_only",
            };
            super::conversation::raise_privacy(&mut disclosure, privacy)?;
        }
        super::conversation::persist_disclosure(
            conn,
            &goal.accountable_ghost,
            &goal.reply_conversation,
            &disclosure,
        )?;
    }
    if let Some(inputs) = &spec.input_artifacts {
        for input in inputs {
            for artifact in &input.artifacts {
                let privacy = match artifact.privacy.as_str() {
                    "public" => "public",
                    "private" => "private",
                    _ => "local_only",
                };
                super::conversation::raise_privacy(&mut disclosure, privacy)?;
            }
        }
        super::conversation::persist_disclosure(
            conn,
            &goal.accountable_ghost,
            &goal.reply_conversation,
            &disclosure,
        )?;
    }
    work.execution_id = Some(spec.execution_id.clone());
    work.state = "submitted".to_owned();
    work.blocker = None;
    db::update_work(conn, &work)?;
    let body = json!({ "method": "submit", "spec": spec });
    context.enqueue(
        "worker",
        outgoing(envelope, principal, Some(work.goal_revision), body)?,
    );
    Ok(success(
        "worker execution handle durably admitted",
        vec![work.id.clone(), spec.execution_id.clone()],
        json!({ "work": work, "execution_id": spec.execution_id }),
    ))
}

fn work_steer(
    conn: &Connection,
    envelope: &Envelope,
    principal: &str,
    context: &mut ApplyContext,
) -> Result<Response> {
    allowed_fields(&envelope.body, &["method", "work_id", "prompt"], &["method", "work_id"])?;
    let work_id = string_field(&envelope.body, "work_id")?;
    let Some(mut work) = db::work(conn, work_id)? else {
        return Err(not_found("work not found"));
    };
    let Some(execution_id) = work.execution_id.clone() else {
        return Err(conflict("work has no execution handle to steer"));
    };
    if work.cancellation != "none" || work.state == "cancelled" {
        return Err(conflict("cancelled work cannot be steered"));
    }
    if is_terminal_state(&work.state) {
        return Err(conflict("terminal work cannot be steered"));
    }
    if let Some(expected) = envelope.expected_revision {
        if expected != work.goal_revision {
            return Err(conflict("work steering revision is stale"));
        }
    }
    let prompt = match envelope.body.get("prompt") {
        Some(value) => value
            .as_str()
            .ok_or_else(|| invalid("prompt must be a string"))?
            .to_owned(),
        None => db::goal(conn, &work.goal_id)?
            .ok_or_else(|| anyhow!("lifetime work references a missing goal"))?
            .prompt,
    };
    validate_text("prompt", &prompt)?;
    work.state = "steering".to_owned();
    db::update_work(conn, &work)?;
    let body = json!({
        "method": "steer",
        "execution_id": execution_id,
        "prompt": prompt,
    });
    context.enqueue(
        "worker",
        outgoing(envelope, principal, Some(work.goal_revision), body)?,
    );
    Ok(success(
        "worker steering command durably queued",
        vec![work.id.clone(), execution_id],
        json!({ "work": work }),
    ))
}

pub(super) fn work_cancel(
    conn: &Connection,
    envelope: &Envelope,
    principal: &str,
    context: &mut ApplyContext,
) -> Result<Response> {
    exact_fields(&envelope.body, &["method", "work_id"])?;
    let work_id = string_field(&envelope.body, "work_id")?;
    let Some(mut work) = db::work(conn, work_id)? else {
        return Err(not_found("work not found"));
    };
    if work.cancellation == "requested" || work.cancellation == "confirmed" {
        return Ok(success(
            "cancellation state recovered",
            vec![work.id.clone()],
            json!({ "work": work }),
        ));
    }
    if is_terminal_state(&work.state) {
        return Err(conflict("terminal work cannot be cancelled"));
    }
    match work.execution_id.clone() {
        None => {
            work.cancellation = "confirmed".to_owned();
            work.state = "cancelled".to_owned();
            db::update_work(conn, &work)?;
        }
        Some(execution_id) => {
            work.cancellation = "requested".to_owned();
            work.state = "cancel_requested".to_owned();
            db::update_work(conn, &work)?;
            if !super::pi_execution::execution_is_pi(conn,&execution_id)? {
                let body = json!({ "method": "cancel", "execution_id": execution_id });
                context.enqueue("worker",outgoing(envelope, principal, Some(work.goal_revision), body)?);
            }
        }
    }
    super::graph::cancel_descendants(conn, &work.id, envelope, principal, context)?;
    if work.cancellation == "confirmed" {
        super::graph::terminal_changed(conn, envelope, principal, &work, context)?;
    }
    Ok(success(
        "cancellation request durably recorded",
        vec![work.id.clone()],
        json!({ "work": work }),
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredResult {
    event: Value,
    producer: String,
    epoch: u64,
    sequence: u64,
    current: bool,
    reason: Option<String>,
}

fn work_result(conn: &Transaction<'_>, envelope: &Envelope, principal: &str, context: &mut ApplyContext) -> Result<Response> {
    exact_fields(
        &envelope.body,
        &[
            "method",
            "execution_id",
            "producer",
            "sequence",
            "goal_revision",
            "state",
            "artifacts",
            "summary",
        ],
    )?;
    let execution_id = string_field(&envelope.body, "execution_id")?;
    let producer = string_field(&envelope.body, "producer")?;
    let sequence = number_field(&envelope.body, "sequence")?;
    let goal_revision = number_field(&envelope.body, "goal_revision")?;
    let state = string_field(&envelope.body, "state")?;
    let _summary = string_field(&envelope.body, "summary")?;
    validate_identity("execution_id", execution_id)?;
    validate_identity("producer", producer)?;
    if !matches!(state, "running" | "completed" | "failed" | "cancelled" | "unknown") {
        return Err(invalid("result state is not a producer-owned execution state"));
    }
    if producer != principal {
        return Err(reject(
            "unauthorized",
            "result producer does not match authenticated principal",
            RetryClass::Never,
        ));
    }
    let artifacts: Vec<Artifact> = serde_json::from_value(value_field(&envelope.body, "artifacts")?.clone())
        .map_err(|error| invalid(format!("invalid result artifacts: {error}")))?;
    for artifact in &artifacts {
        validate_artifact(artifact, execution_id)?;
    }
    let Some(mut work) = work_for_execution(conn, execution_id)? else {
        return Err(not_found("execution ID is not admitted by the Host ledger"));
    };
    let Some(goal) = db::goal(conn, &work.goal_id)? else {
        return Err(anyhow!("lifetime work references a missing goal"));
    };
    let epoch_sql = revision(envelope.authority_epoch)?;
    let sequence_sql = revision(sequence)?;
    let prior_inbox: Option<(String, String)> = conn
        .query_row(
            "SELECT payload_digest,payload FROM lifetime_inbox WHERE producer=?1 AND epoch=?2 AND sequence=?3",
            params![producer, epoch_sql, sequence_sql],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((digest, payload)) = prior_inbox {
        if digest != envelope.payload_digest {
            return Err(reject(
                "conflict",
                "producer sequence was already used with a different payload",
                RetryClass::Never,
            ));
        }
        let record: StoredResult = serde_json::from_str(&payload)?;
        let (current, reason) = result_is_current(conn, &record)?;
        return result_response(
            &work,
            &record,
            current,
            reason.as_deref(),
            true,
        );
    }

    let previous = result_record(conn, execution_id)?;
    let is_newer = match previous.as_ref() {
        None => true,
        Some(previous) if envelope.authority_epoch > previous.epoch => true,
        Some(previous) if envelope.authority_epoch < previous.epoch => false,
        Some(previous) if producer != previous.producer => {
            return Err(conflict("execution producer changed without a new authority epoch"));
        }
        Some(previous) => sequence > previous.sequence,
    };
    let reason = if !is_newer {
        Some("out_of_order".to_owned())
    } else if goal_revision != goal.revision || work.goal_revision != goal.revision {
        Some("stale_requirement".to_owned())
    } else if work.state == "accepted" {
        Some("already_accepted".to_owned())
    } else if work.cancellation != "none" || state == "cancelled" {
        Some("cancelled".to_owned())
    } else if !super::graph::current_result_scope(conn, &work)? {
        Some("stale_graph_scope".to_owned())
    } else {
        None
    };
    let current = reason.is_none();
    let record = StoredResult {
        event: envelope.body.clone(),
        producer: producer.to_owned(),
        epoch: envelope.authority_epoch,
        sequence,
        current,
        reason: reason.clone(),
    };
    conn.execute(
        "INSERT INTO lifetime_inbox(producer,epoch,sequence,payload_digest,payload) VALUES(?1,?2,?3,?4,?5)",
        params![
            producer,
            epoch_sql,
            sequence_sql,
            envelope.payload_digest,
            serde_json::to_string(&record)?,
        ],
    )?;
    if is_newer && work.state != "accepted" {
        conn.execute(
            "INSERT INTO lifetime_results(execution_id,work_id,goal_revision,payload_digest,payload) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(execution_id) DO UPDATE SET work_id=excluded.work_id,goal_revision=excluded.goal_revision,payload_digest=excluded.payload_digest,payload=excluded.payload",
            params![
                execution_id,
                work.id,
                revision(goal_revision)?,
                envelope.payload_digest,
                serde_json::to_string(&record)?,
            ],
        )?;
        if state == "cancelled" {
            work.cancellation = "confirmed".to_owned();
            work.state = "cancelled".to_owned();
            work.blocker = None;
            db::update_work(conn, &work)?;
            if producer == format!("pi-result:{}:{execution_id}", work.owner) {
                conn.execute(
                    "UPDATE lifetime_pi_executions SET state='cancelled'
                     WHERE execution_id=?1 AND authority_epoch=?2 AND state='running'",
                    params![execution_id, epoch_sql],
                )?;
            }
        } else if current {
            work.state = state.to_owned();
            work.blocker = None;
            db::update_work(conn, &work)?;
        }
    }
    if is_newer && (current || state == "cancelled") {
        super::graph::terminal_changed(conn, envelope, principal, &work, context)?;
    }
    if is_newer
        && matches!(state, "completed" | "failed" | "cancelled")
        && work.goal_revision == goal.revision
        && goal_revision == goal.revision
        && (current || state == "cancelled")
    {
        super::mailbox::notify_work(conn, &work, &goal, "result")?;
    }
    if is_newer && state != "running" && !(state == "cancelled" && goal_revision != goal.revision) {
        let report_summary=if super::super::work_memory::has_lineage(conn,&work)? || super::super::memory_publication::has_work_dependencies(conn,&work)? {"Work-scoped source content is retained in its original execution; this report contains status metadata only."}else{_summary};
        let body = json!({
            "method":"conversation.submit","ghost_id":goal.accountable_ghost,
            "conversation_id":goal.reply_conversation,"privacy":goal.privacy,
            "goal_id":goal.id,"goal_revision":goal.revision,
            "prompt":format!("Authoritative Host report for work {} and execution {}: state={state}, current={current}, reason={reason:?}. {} Goal acceptance is separate; do not claim verified completion or start another execution for this report.", work.id, execution_id, report_summary),
        });
        context.enqueue("pi", outgoing(envelope, principal, Some(goal.revision), body)?);
    }
    result_response(
        &work,
        &record,
        current,
        reason.as_deref(),
        false,
    )
}

fn result_response(
    work: &Work,
    record: &StoredResult,
    current: bool,
    reason: Option<&str>,
    duplicate: bool,
) -> Result<Response> {
    let artifacts: Vec<Artifact> = serde_json::from_value(
        record
            .event
            .get("artifacts")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    )?;
    let data = json!({
        "execution_id": record.event.get("execution_id"),
        "producer": record.producer,
        "sequence": record.sequence,
        "goal_revision": record.event.get("goal_revision"),
        "summary": record.event.get("summary"),
        "current": current,
        "stale": !current,
        "reason": reason,
        "duplicate": duplicate,
    });
    let mut response = if current {
        success("worker result durably recorded", vec![work.id.clone()], data)
    } else {
        warning("worker result retained but not current", vec![work.id.clone()], data)
    };
    response.artifacts = artifacts;
    Ok(response)
}

fn result_is_current(conn: &Connection, record: &StoredResult) -> Result<(bool, Option<String>)> {
    if !record.current {
        return Ok((false, record.reason.clone()));
    }
    let Some(latest) = result_record(
        conn,
        record
            .event
            .get("execution_id")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )? else {
        return Ok((false, Some("result_missing".to_owned())));
    };
    if latest.epoch != record.epoch
        || latest.sequence != record.sequence
        || latest.producer != record.producer
    {
        return Ok((false, Some("out_of_order".to_owned())));
    }
    let execution_id = record
        .event
        .get("execution_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(work) = work_for_execution(conn, execution_id)? else {
        return Ok((false, Some("work_missing".to_owned())));
    };
    let Some(goal) = db::goal(conn, &work.goal_id)? else {
        return Ok((false, Some("goal_missing".to_owned())));
    };
    let result_revision = record
        .event
        .get("goal_revision")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    if result_revision != goal.revision || work.goal_revision != goal.revision {
        return Ok((false, Some("stale_requirement".to_owned())));
    }
    if work.cancellation != "none"
        || record.event.get("state").and_then(Value::as_str) == Some("cancelled")
    {
        return Ok((false, Some("cancelled".to_owned())));
    }
    if !super::graph::current_result_scope(conn, &work)? {
        return Ok((false, Some("stale_graph_scope".to_owned())));
    }
    if !artifact_inputs_current(conn, &work)? {
        return Ok((false, Some("stale_artifact_inputs".to_owned())));
    }
    Ok((true, None))
}
fn work_accept(conn: &Transaction<'_>, envelope: &Envelope, principal: &str, context: &mut ApplyContext) -> Result<Response> {
    let body = &envelope.body;
    exact_fields(body, &["method", "acceptance"])?;
    let acceptance: Acceptance = serde_json::from_value(value_field(body, "acceptance")?.clone())
        .map_err(|error| invalid(format!("invalid Acceptance: {error}")))?;

    if acceptance.verifier_revision.trim().is_empty() || acceptance.policy_revision == 0 {
        return Err(invalid("acceptance verifier and policy revisions must be present"));
    }
    let (verifier, policy): (String, i64) = conn.query_row(
        "SELECT verifier_revision,policy_revision FROM lifetime_verification_policy WHERE singleton=1",
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if acceptance.verifier_revision != verifier || revision(acceptance.policy_revision)? != policy {
        return Err(conflict("acceptance does not match the authoritative current verifier and policy"));
    }
    if acceptance.checks.is_empty() || acceptance.checks.iter().any(|check| !check.passed) {
        return Err(conflict("acceptance requires independent passing checks"));
    }
    if !valid_digest(&acceptance.requirement_digest)
        || !valid_digest(&acceptance.artifact_digest)
    {
        return Err(invalid("acceptance digests must be lowercase SHA-256"));
    }
    let Some(mut work) = db::work(conn, &acceptance.work_id)? else {
        return Err(not_found("work not found"));
    };
    let has_acceptance: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM lifetime_acceptances WHERE work_id=?1)",
        [&work.id],
        |row| row.get(0),
    )?;
    if has_acceptance || work.state == "accepted" {
        return Err(conflict("work acceptance is immutable; replay the original command receipt"));
    }
    let Some(mut goal) = db::goal(conn, &work.goal_id)? else {
        return Err(anyhow!("lifetime work references a missing goal"));
    };
    if acceptance.goal_revision != goal.revision
        || work.goal_revision != goal.revision
        || acceptance.requirement_digest != goal.requirement_digest
    {
        return Err(conflict("acceptance does not match the current goal revision"));
    }
    if work.cancellation != "none" || work.state == "cancelled" {
        return Err(conflict("cancelled work cannot be accepted"));
    }
    if let Some(response) = super::graph::check_acceptance(conn, &work)? {
        return Ok(response);
    }
    let Some(execution_id) = work.execution_id.as_deref() else {
        return Err(conflict("work has no execution result to accept"));
    };
    let Some(record) = result_record(conn, execution_id)? else {
        return Err(conflict("work has no durable result to accept"));
    };
    let (current, reason) = result_is_current(conn, &record)?;
    if !current {
        return Err(conflict(format!(
            "latest worker result is not current ({})",
            reason.unwrap_or_else(|| "stale".to_owned())
        )));
    }
    let result_state = record.event.get("state").and_then(Value::as_str).unwrap_or_default();
    if result_state != "completed" {
        return Err(conflict("only a completed execution result can be accepted"));
    }
    let artifacts: Vec<Artifact> = serde_json::from_value(
        record
            .event
            .get("artifacts")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    )?;
    if !artifacts.iter().any(|artifact| {
        artifact.digest == acceptance.artifact_digest
            && artifact.producing_attempt == execution_id
    }) {
        return Err(conflict("acceptance artifact is not attached to the current result"));
    }
    let required = required_checks(&goal.acceptance_spec)?;
    let mut seen = BTreeSet::new();
    for check in &acceptance.checks {
        if check.id.trim().is_empty() || !seen.insert(check.id.as_str()) {
            return Err(invalid("acceptance check IDs must be non-empty and unique"));
        }
    }
    for required_id in required {
        if !acceptance
            .checks
            .iter()
            .any(|check| check.id == required_id && check.passed && !check.evidence.trim().is_empty())
        {
            return Err(conflict(format!("required acceptance check is missing or failed: {required_id}")));
        }
    }
    if acceptance.checks.iter().any(|check| check.passed && check.evidence.trim().is_empty()) {
        return Err(invalid("passing acceptance checks require evidence"));
    }
    db::save_acceptance(conn, &acceptance)?;
    work.state = "accepted".to_owned();
    work.blocker = None;
    db::update_work(conn, &work)?;
    super::graph::terminal_changed(conn, envelope, principal, &work, context)?;
    let current_works = db::works_for_goal(conn, &goal.id)?;
    let mut has_current_work = false;
    let all_current_work_accepted = current_works
        .iter()
        .filter(|candidate| candidate.goal_revision == goal.revision)
        .all(|candidate| {
            has_current_work = true;
            candidate.state == "accepted"
        });
    if has_current_work && all_current_work_accepted {
        goal.state = "accepted".to_owned();
        conn.execute(
            "UPDATE lifetime_goals SET state=?1,payload=?2 WHERE id=?3 AND revision=?4",
            params![
                goal.state,
                serde_json::to_string(&goal)?,
                goal.id,
                revision(goal.revision)?,
            ],
        )?;
    }
    super::mailbox::notify_work(conn, &work, &goal, "acceptance")?;
    let report = json!({
        "method":"conversation.submit",
        "ghost_id":goal.accountable_ghost,
        "conversation_id":goal.reply_conversation,
        "privacy":goal.privacy,
        "goal_id":goal.id,
        "goal_revision":goal.revision,
        "prompt":format!("Authenticated Host verification: work_id={} is accepted at goal_revision={}. {} independent checks passed under verifier {} and policy {}. Goal state={}. Report this committed acceptance to the user; do not submit or restart any execution. Artifact contents remain in their original privacy scope.", work.id, goal.revision, acceptance.checks.len(), acceptance.verifier_revision, acceptance.policy_revision, goal.state),
    });
    context.enqueue("pi", outgoing(envelope, principal, Some(goal.revision), report)?);
    Ok(success(
        "current result accepted",
        vec![work.id.clone(), goal.id.clone()],
        json!({ "work": work, "goal": goal, "acceptance": acceptance }),
    ))
}

// Admission/revision-time validation of typed Pi acceptance criteria. Borrowed
// only: no command bytes are copied or normalized here.
fn validate_required_checks(spec: &Value) -> Result<()> {
    let Some(value) = spec.get("required_checks") else {
        return Ok(());
    };
    let Some(items) = value.as_array() else {
        return Err(invalid("acceptance_spec.required_checks must be an array"));
    };
    let mut seen = BTreeSet::new();
    for item in items {
        let Some(id) = item.as_str() else {
            return Err(invalid("required check IDs must be strings"));
        };
        if id.trim().is_empty() || !seen.insert(id) {
            return Err(invalid("required check IDs must be non-empty and unique"));
        }
    }
    Ok(())
}

fn required_checks(spec: &Value) -> Result<BTreeSet<String>> {
    validate_required_checks(spec)?;
    // Validation above guarantees the array holds unique non-empty strings.
    let Some(items) = spec.get("required_checks").and_then(Value::as_array) else {
        return Ok(BTreeSet::new());
    };
    Ok(items
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect())
}

fn result_for_execution(conn: &Connection, execution_id: Option<&str>) -> Result<Value> {
    let Some(execution_id) = execution_id else {
        return Ok(Value::Null);
    };
    let Some(record) = result_record(conn, execution_id)? else {
        return Ok(Value::Null);
    };
    let (current, reason) = result_is_current(conn, &record)?;
    Ok(json!({
        "event": record.event,
        "current": current,
        "stale": !current,
        "reason": reason,
    }))
}

pub(super) fn graph_artifact_metadata(
    conn: &Connection,
    work: &Work,
    disclosure: &str,
) -> Result<Option<Value>> {
    let Some(execution_id) = work.execution_id.as_deref() else {
        return Ok(None);
    };
    let Some(mut record) = result_record(conn, execution_id)? else {
        return Ok(None);
    };
    if !record.current || work.cancellation != "none"
        || record.event["execution_id"] != execution_id
        || record.event["goal_revision"].as_u64() != Some(work.goal_revision)
        || !super::graph::current_result_scope(conn, work)?
        || !artifact_inputs_current(conn, work)?
    {
        return Ok(None);
    }
    let mut artifacts = record.event.as_object_mut()
        .and_then(|event| event.remove("artifacts"))
        .ok_or_else(|| anyhow!("current graph result has no artifact metadata"))?;
    let items = artifacts.as_array_mut()
        .ok_or_else(|| anyhow!("current graph result artifact metadata is invalid"))?;
    let mut withheld = false;
    items.retain(|artifact| {
        let allowed = match artifact["privacy"].as_str() {
            Some("public") => true,
            Some("private") => matches!(disclosure, "private" | "local_only"),
            Some("local_only") => disclosure == "local_only",
            _ => false,
        };
        withheld |= !allowed;
        allowed
    });
    Ok(Some(json!({
        "work_id": work.id,
        "goal_id": work.goal_id,
        "goal_revision": work.goal_revision,
        "execution_id": execution_id,
        "state": work.state,
        "artifacts": artifacts,
        "protected_artifacts_withheld": withheld,
    })))
}

fn artifact_inputs_current(conn: &Connection, work: &Work) -> Result<bool> {
    let Some(execution_id) = work.execution_id.as_deref() else {
        return Ok(true);
    };
    // The worker intent seals the effective admitted spec even when the Host
    // reduces its deadline. Read only its input snapshot, not command bodies.
    let stored: Option<String> = conn.query_row(
        "SELECT json_extract(payload,'$.body.spec.input_artifacts')
         FROM lifetime_outbox WHERE target='worker'
           AND json_extract(payload,'$.body.method')='submit'
           AND json_extract(payload,'$.body.spec.execution_id')=?1",
        [execution_id], |row| row.get::<_, Option<String>>(0),
    ).optional()?.flatten();
    // No captured inputs means no artifact-input dependency; later child
    // completion cannot invalidate an independently produced parent result.
    let Some(stored) = stored else { return Ok(true); };
    let inputs: Vec<crate::lifetime_contract::WorkerArtifactInput> =
        serde_json::from_str(&stored)?;
    let current = super::graph::native_artifact_inputs(conn, work)?;
    Ok(inputs.as_slice() == current.as_deref().unwrap_or(&[]))
}

fn result_record(conn: &Connection, execution_id: &str) -> Result<Option<StoredResult>> {
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload FROM lifetime_results WHERE execution_id=?1",
            [execution_id],
            |row| row.get(0),
        )
        .optional()?;
    payload.map(|raw| serde_json::from_str(&raw).map_err(Into::into)).transpose()
}

fn work_for_execution(conn: &Connection, execution_id: &str) -> Result<Option<Work>> {
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload FROM lifetime_work WHERE execution_id=?1",
            [execution_id],
            |row| row.get(0),
        )
        .optional()?;
    payload.map(|raw| serde_json::from_str(&raw).map_err(Into::into)).transpose()
}

fn same_submit_spec(conn: &Connection, envelope: &Envelope, execution_id: &str) -> Result<bool> {
    // The immutable admission receipt retains the requested digest even when
    // the Host shrinks the effective worker deadline to a root graph budget.
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM lifetime_commands WHERE json_extract(request,'$.body.method')='work.submit'
         AND payload_digest=?1 AND json_extract(response,'$.status')='success'
         AND json_extract(response,'$.data.execution_id')=?2)",
        params![envelope.payload_digest, execution_id], |row| row.get(0),
    )?)
}

fn new_work(goal: &Goal, owner: &str, owner_revision: u64) -> Work {
    Work {
        id: uuid::Uuid::now_v7().to_string(),
        goal_id: goal.id.clone(),
        goal_revision: goal.revision,
        owner: owner.to_owned(),
        owner_revision,
        state: "queued".to_owned(),
        execution_id: None,
        cancellation: "none".to_owned(),
        blocker: None,
    }
}


fn is_terminal_state(state: &str) -> bool {
    matches!(
        state,
        "accepted" | "complete" | "completed" | "failed" | "cancelled" | "canceled" | "stopped" | "rejected" | "stale"
    )
}

pub(super) fn outgoing(
    source: &Envelope,
    principal: &str,
    expected_revision: Option<u64>,
    body: Value,
) -> Result<Value> {
    outgoing_with_cause(source, &source.command_id, principal, expected_revision, body)
}

// Same delivery envelope as `outgoing`, but the receiver command ID hashes the
// original cause command instead of the current trigger. Authority epoch,
// principal, correlation header, and the body digest still come from the
// current source envelope.
pub(super) fn outgoing_with_cause(
    source: &Envelope,
    cause_command_id: &str,
    principal: &str,
    expected_revision: Option<u64>,
    body: Value,
) -> Result<Value> {
    let payload_digest = canonical_digest(&body)?;
    let mut command_hash = Sha256::new();
    command_hash.update(b"ghost-lifetime/outgoing/1");
    command_hash.update((cause_command_id.len() as u64).to_be_bytes());
    command_hash.update(cause_command_id.as_bytes());
    command_hash.update(payload_digest.as_bytes());
    command_hash.update(source.authority_epoch.to_be_bytes());
    command_hash.update(expected_revision.unwrap_or(0).to_be_bytes());
    let envelope = Envelope {
        protocol_version: VERSION.to_owned(),
        command_id: format!("{:x}", command_hash.finalize()),
        payload_digest,
        actor_ref: principal.to_owned(),
        authority_epoch: source.authority_epoch,
        expected_revision,
        correlation_id: source.correlation_id.clone(),
        body,
    };
    Ok(serde_json::to_value(envelope)?)
}

pub(super) fn exact_fields(body: &Value, fields: &[&str]) -> Result<()> {
    allowed_fields(body, fields, fields)
}

pub(super) fn allowed_fields(body: &Value, allowed: &[&str], required: &[&str]) -> Result<()> {
    let Some(object) = body.as_object() else {
        return Err(invalid("command body must be an object"));
    };
    if required.iter().any(|key| !object.contains_key(*key)) {
        return Err(invalid("command body is missing a required field"));
    }
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid("command body contains an unknown field"));
    }
    Ok(())
}

pub(super) fn value_field<'a>(body: &'a Value, key: &str) -> Result<&'a Value> {
    body.get(key)
        .ok_or_else(|| invalid(format!("command body is missing {key}")))
}
pub(super) fn string_field<'a>(body: &'a Value, key: &str) -> Result<&'a str> {
    value_field(body, key)?
        .as_str()
        .ok_or_else(|| invalid(format!("command body field {key} must be a string")))
}
pub(super) fn number_field(body: &Value, key: &str) -> Result<u64> {
    let value = value_field(body, key)?
        .as_u64()
        .ok_or_else(|| invalid(format!("command body field {key} must be a positive integer")))?;
    if value == 0 {
        return Err(invalid(format!("command body field {key} must be positive")));
    }
    Ok(value)
}
pub(super) fn validate_identity(field: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(invalid(format!("{field} must not be empty")));
    }
    Ok(())
}
pub(super) fn validate_text(field: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(invalid(format!("{field} must not be empty")));
    }
    Ok(())
}
fn validate_privacy(privacy: &str) -> Result<()> {
    if !matches!(privacy, "public" | "private" | "local_only") {
        return Err(invalid("unsupported goal privacy"));
    }
    Ok(())
}
fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}


fn validate_artifact(artifact: &Artifact, execution_id: &str) -> Result<()> {
    if !valid_digest(&artifact.digest)
        || !matches!(artifact.privacy.as_str(), "public" | "private" | "local_only")
        || artifact.producing_attempt != execution_id
    {
        return Err(invalid("artifact digest, privacy, or producing attempt is invalid"));
    }
    Ok(())
}
