use super::{
    apply::{self, ApplyContext},
    assignments,
    conversation,
    db,
};
use crate::lifetime_contract::{canonical_digest, Envelope, Goal, Response, RetryClass, Work, WorkerArtifactInput};
use anyhow::{anyhow, bail, Result};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, VecDeque},
    time::{SystemTime, UNIX_EPOCH},
};

const OWNER_ADMIN: &str = "owner";
const HOST_MAINTENANCE: &str = "host-maintenance";
const HOST_RECEIPT_SENDER: &str = "host-receipt";
const DELEGATION_DEPTH_MAX: i64 = 3;
const ACTIVE_CHILDREN_MAX: i64 = 4;
const AUTOMATIC_REVISIONS_MAX: i64 = 2;
const DELEGATION_WALL_TIME_MS: i64 = 1_800_000;
const GRAPH_NODES_MAX: usize = 256;
const DELEGATION_SUMMARY_MAX_BYTES: usize = 8_192;
const ARTIFACT_REFS_MAX: usize = 32;
const WAIT_FOR_MAX: usize = 4;
const CHILD_LIMIT_BLOCKER: &str = "root_graph_child_limit:";
pub(super) const WAIT_BLOCKER: &str = "wait_for:";

#[derive(Clone, Debug)]
struct WorkLink {
    child_work_id: String,
    parent_work_id: String,
    parent_goal_revision: i64,
    root_goal_id: String,
    depth: i64,
    current: bool,
}

#[derive(Clone, Debug)]
struct GraphBudget {
    root_goal_id: String,
    deadline_ms: i64,
    automatic_revisions: i64,
    expired: bool,
}

#[derive(Clone, Debug)]
struct GraphScope {
    root_goal_id: String,
    depth: i64,
}

pub(super) fn handles(method: &str) -> bool {
    matches!(
        method,
        "work.delegate" | "work.wait" | "work.children" | "work.expire"
    )
}

pub(super) fn apply(
    tx: &Transaction<'_>,
    envelope: &Envelope,
    principal: &str,
    context: &mut ApplyContext,
) -> Result<Response> {
    match apply::string_field(&envelope.body, "method")? {
        "work.delegate" => work_delegate(tx, envelope, principal, context),
        "work.wait" => work_wait(tx, envelope, principal),
        "work.children" => work_children(tx, &envelope.body, principal),
        "work.expire" => work_expire(tx, envelope, principal, context),
        _ => Err(apply::reject(
            "unsupported_method",
            "unsupported responsibility graph method",
            RetryClass::Never,
        )),
    }
}

/// Reconcile every descendant of a changed Goal in the enclosing Host transaction.
pub(super) fn invalidate_descendants(
    conn: &Connection,
    changed_goal: &Goal,
    envelope: &Envelope,
    principal: &str,
    context: &mut ApplyContext,
) -> Result<()> {
    let persisted_goal = db::goal(conn, &changed_goal.id)?
        .ok_or_else(|| anyhow!("changed Goal is missing from the Host ledger"))?;
    if persisted_goal.revision != changed_goal.revision
        || persisted_goal.requirement_digest != changed_goal.requirement_digest
    {
        bail!("changed Goal callback does not match the current Host row");
    }

    let goal_works = db::works_for_goal(conn, &changed_goal.id)?;
    let goal_work_ids: Vec<String> = goal_works.iter().map(|work| work.id.clone()).collect();
    let direct_links = links_for_goal(conn, &changed_goal.id)?;
    let root_budget = budget_for(conn, &changed_goal.id)?;
    let mut roots = BTreeSet::new();
    if let Some(budget) = root_budget {
        roots.insert(budget.root_goal_id);
    }
    for link in &direct_links {
        roots.insert(link.root_goal_id.clone());
    }
    if roots.is_empty() {
        return Ok(());
    }
    if roots.len() != 1 {
        bail!("one Goal is linked into multiple root responsibility graphs");
    }
    let root_goal_id = roots.iter().next().unwrap().clone();

    if principal != OWNER_ADMIN {
        let changed = conn.execute(
            "UPDATE lifetime_graph_budgets SET automatic_revisions=automatic_revisions+1 WHERE root_goal_id=?1 AND automatic_revisions<?2",
            params![root_goal_id, AUTOMATIC_REVISIONS_MAX],
        )?;
        if changed != 1 {
            return Err(apply::conflict(
                "automatic Goal revisions are exhausted for this root graph",
            ));
        }
    }

    // The changed Goal's own work remains linked to its parent; only its children
    // are invalidated. A changed root Goal has no parent link, so all root links
    // are descendants of the affected root work.
    let seeds = goal_work_ids.clone();
    let descendant_links = collect_descendant_links(conn, &seeds, true)?;
    let descendant_ids: BTreeSet<String> = descendant_links
        .iter()
        .map(|link| link.child_work_id.clone())
        .collect();
    for link in &descendant_links {
        conn.execute(
            "UPDATE lifetime_work_links SET current=0 WHERE child_work_id=?1 AND current=1",
            [&link.child_work_id],
        )?;
    }

    let invalidation_reason = format!(
        "ancestor Goal {} advanced to revision {}; descendant work is stale",
        changed_goal.id, changed_goal.revision
    );
    let mut no_execution_cancelled = Vec::new();
    let mut stale_results = BTreeSet::new();
    let mut stale_work_ids = BTreeSet::new();
    for work_id in &descendant_ids {
        let Some(mut work) = db::work(conn, work_id)? else {
            bail!("graph link references missing descendant work {work_id}");
        };
        if is_dependency_resolved(&work.state) || work.state == "stale" {
            continue;
        }
        if work.state == "completed" {
            work.state = "stale".to_owned();
            work.blocker = Some(invalidation_reason.clone());
            db::update_work(conn, &work)?;
            stale_work_ids.insert(work.id.clone());
            if let Some(execution_id) = work.execution_id.as_deref() {
                stale_results.insert(execution_id.to_owned());
            }
            continue;
        }
        if work.cancellation == "requested" || work.cancellation == "confirmed" {
            continue;
        }
        if work.execution_id.is_some() {
            request_worker_cancellation(
                conn,
                &mut work,
                &invalidation_reason,
                envelope,
                principal,
                context,
            )?;
        } else {
            work.cancellation = "confirmed".to_owned();
            work.state = "cancelled".to_owned();
            work.blocker = None;
            db::update_work(conn, &work)?;
            no_execution_cancelled.push(work);
        }
    }
    for execution_id in stale_results {
        mark_result_stale(conn, &execution_id, "ancestor_revision_changed")?;
    }

    // A newly-created replacement Work for a revised child Goal keeps the
    // original parent/root/depth lineage. Superseded links remain historical.
    if !direct_links.is_empty() {
        for link in &direct_links {
            if let Some(work) = db::work(conn, &link.child_work_id)? {
                if work.goal_revision != changed_goal.revision
                    || work.state == "stale"
                    || work.cancellation != "none"
                {
                    conn.execute(
                        "UPDATE lifetime_work_links SET current=0 WHERE child_work_id=?1 AND current=1",
                        [&link.child_work_id],
                    )?;
                }
            }
        }
        let template = direct_links
            .iter()
            .max_by_key(|link| (link.current, link.child_work_id.as_str()))
            .unwrap();
        for work in &goal_works {
            if work.goal_revision != changed_goal.revision
                || matches!(work.state.as_str(), "stale" | "cancelled" | "failed" | "accepted")
            {
                continue;
            }
            if link_for_child(conn, &work.id)?.is_some() {
                continue;
            }
            let parent = db::work(conn, &template.parent_work_id)?;
            let lineage_current = if template.current {
                match parent.as_ref() {
                    Some(parent) => current_scope(conn, parent, false, false)?
                        .is_some_and(|scope| scope.root_goal_id == template.root_goal_id),
                    None => false,
                }
            } else {
                false
            };
            insert_link(
                conn,
                &work.id,
                &template.parent_work_id,
                template.parent_goal_revision,
                &template.root_goal_id,
                template.depth,
                lineage_current,
            )?;
        }
    }

    let invalidated_set = descendant_ids;
    remove_wait_edges_for_invalidated_waiters(conn, &invalidated_set)?;
    reconcile_superseded_dependencies(conn, &stale_work_ids)?;

    for work in &no_execution_cancelled {
        terminal_changed(conn, envelope, principal, work, context)?;
    }
    Ok(())
}
pub(super) fn redirect_work_dependencies(
    conn: &Connection,
    superseded_work_ids: &BTreeSet<String>,
    replacement_work_id: &str,
) -> Result<()> {
    if superseded_work_ids.is_empty() {
        return Ok(());
    }
    if superseded_work_ids.contains(replacement_work_id) {
        bail!("replacement Work is also marked superseded");
    }

    let mut affected_waiters = BTreeSet::new();
    for superseded_id in superseded_work_ids {
        let waiters = {
            let mut statement = conn.prepare(
                "SELECT waiter_work_id FROM lifetime_blocking_edges
                 WHERE blocker_work_id=?1 AND kind='dependency' ORDER BY waiter_work_id",
            )?;
            let rows = statement.query_map([superseded_id], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for waiter_id in waiters {
            if superseded_work_ids.contains(&waiter_id) {
                continue;
            }
            let Some(waiter) = db::work(conn, &waiter_id)? else {
                bail!("dependency edge references missing waiter Work {waiter_id}");
            };
            if is_dependency_resolved(&waiter.state) || waiter.cancellation != "none" {
                continue;
            }
            if waiter_id == replacement_work_id {
                return Err(apply::conflict(
                    "replacement Work dependency would create a self-cycle",
                ));
            }
            let removed = conn.execute(
                "DELETE FROM lifetime_blocking_edges
                 WHERE waiter_work_id=?1 AND blocker_work_id=?2 AND kind='dependency'",
                params![waiter_id, superseded_id],
            )?;
            if removed == 0 {
                continue;
            }
            conn.execute(
                "INSERT OR IGNORE INTO lifetime_blocking_edges(waiter_work_id,blocker_work_id,kind)
                 VALUES(?1,?2,'dependency')",
                params![waiter_id, replacement_work_id],
            )?;
            affected_waiters.insert(waiter_id);
        }
    }
    for waiter_id in affected_waiters {
        let _ = refresh_waiter_blocker(conn, &waiter_id)?;
    }
    Ok(())
}


/// Check graph ancestry and wait dependencies before a new worker admission or
/// an acceptance that could otherwise outlive an invalidated ancestor.
pub(super) fn check_admission(conn: &Connection, work: &Work) -> Result<Option<Response>> {
    let Some(actual) = db::work(conn, &work.id)? else {
        return Err(apply::not_found("work not found"));
    };
    if &actual != work {
        bail!("admission callback Work differs from the Host row");
    }
    let blocker = if actual.cancellation != "none" {
        Some("work cancellation is pending or confirmed".to_owned())
    } else if matches!(
        actual.state.as_str(),
        "accepted" | "failed" | "cancelled" | "canceled" | "stale" | "stopped"
            | "rejected" | "cancel_requested"
    ) {
        Some("terminal or stale work cannot be admitted".to_owned())
    } else {
        match current_scope(conn, &actual, true, false)? {
            Some(scope) => {
                if let Some(budget) = budget_for(conn, &scope.root_goal_id)? {
                    if budget.expired || budget.deadline_ms <= now_ms()? {
                        Some(format!(
                            "root graph {} has expired at deadline {}",
                            budget.root_goal_id, budget.deadline_ms
                        ))
                    } else {
                        None
                    }
                } else if link_for_child(conn, &actual.id)?.is_some() {
                    Some("descendant has no durable root graph budget".to_owned())
                } else {
                    None
                }
            }
            None => Some("work has a stale, terminal, cancelled, or superseded ancestor".to_owned()),
        }
    };
    if let Some(blocker) = blocker {
        return Ok(Some(admission_warning(conn, &actual, &blocker, false)?));
    }

    reconcile_terminal_dependencies(conn, &actual.id)?;
    let edges = edges_for_waiter(conn, &actual.id)?;
    if !edges.is_empty() {
        let blocker = format_wait_blocker(&edges);
        return Ok(Some(admission_warning(conn, &actual, &blocker, true)?));
    }
    if actual.state == "blocked" && actual.blocker.is_some() {
        return Ok(Some(apply::warning(
            "work admission remains blocked",
            vec![actual.id.clone()],
            json!({ "work": actual, "blocker": actual.blocker }),
        )));
    }
    Ok(None)
}

pub(super) fn remaining_deadline_ms(conn: &Connection, work: &Work) -> Result<Option<u64>> {
    let scope = current_scope(conn, work, true, false)?
        .ok_or_else(|| apply::conflict("work ancestry is no longer current"))?;
    let Some(budget) = budget_for(conn, &scope.root_goal_id)? else { return Ok(None); };
    let remaining = budget.deadline_ms.saturating_sub(now_ms()?);
    if budget.expired || remaining <= 0 {
        return Err(apply::conflict("root graph deadline has elapsed"));
    }
    Ok(Some(remaining as u64))
}

pub(super) fn current_result_scope(conn: &Connection, work: &Work) -> Result<bool> {
    let Some(scope) = current_scope(conn, work, true, true)? else { return Ok(false); };
    if db::goal(conn, &scope.root_goal_id)?.is_some_and(|goal| goal.state == "accepted") {
        return Ok(true);
    }
    Ok(match budget_for(conn, &scope.root_goal_id)? {
        Some(budget) => !budget.expired && budget.deadline_ms > now_ms()?,
        None => true,
    })
}

pub(super) fn check_acceptance(conn: &Connection, work: &Work) -> Result<Option<Response>> {
    if let Some(response) = check_admission(conn, work)? { return Ok(Some(response)); }
    for link in links_by_parent(conn, &work.id, true)? {
        let child = db::work(conn, &link.child_work_id)?
            .ok_or_else(|| anyhow!("graph child is missing"))?;
        if !is_dependency_resolved(&child.state) {
            return Ok(Some(admission_warning(conn, work, "current child responsibility is unresolved", false)?));
        }
    }
    Ok(None)
}

pub(super) fn cancel_descendants(
    conn: &Connection, parent_work_id: &str, envelope: &Envelope,
    principal: &str, context: &mut ApplyContext,
) -> Result<()> {
    let links = collect_descendant_links(conn, &[parent_work_id.to_owned()], true)?;
    let mut invalidated = BTreeSet::new();
    for link in links {
        conn.execute("UPDATE lifetime_work_links SET current=0 WHERE child_work_id=?1", [&link.child_work_id])?;
        invalidated.insert(link.child_work_id.clone());
        let mut child = db::work(conn, &link.child_work_id)?
            .ok_or_else(|| anyhow!("graph child is missing"))?;
        if is_dependency_resolved(&child.state) || child.state == "stale" { continue; }
        let reason = "ancestor responsibility was cancelled";
        if let Some(execution_id) = child.execution_id.as_deref() {
            mark_result_stale(conn, execution_id, reason)?;
            if child.state != "completed" {
                request_worker_cancellation(conn, &mut child, reason, envelope, principal, context)?;
            }
        } else {
            child.state = "cancelled".to_owned();
            child.cancellation = "confirmed".to_owned();
            child.blocker = None;
            db::update_work(conn, &child)?;
            release_child_dependencies(conn, &child.id, envelope, context)?;
        }
    }
    remove_wait_edges_for_invalidated_waiters(conn, &invalidated)?;
    reconcile_superseded_dependencies(conn, &invalidated)?;
    Ok(())
}

/// Emit terminal child facts in the same transaction as the authoritative
/// result/acceptance update. Child output is never copied into parent context.
pub(super) fn terminal_changed(
    conn: &Connection,
    envelope: &Envelope,
    principal: &str,
    work: &Work,
    context: &mut ApplyContext,
) -> Result<()> {
    let Some(actual) = db::work(conn, &work.id)? else {
        bail!("terminal Work is missing from the Host ledger");
    };
    if &actual != work {
        bail!("terminal callback Work differs from the Host row");
    }

    if matches!(work.state.as_str(), "completed" | "failed" | "cancelled" | "accepted") {
        if let Some(link) = link_for_child(conn, &work.id)? {
            let Some(parent) = db::work(conn, &link.parent_work_id)? else {
                bail!("graph link references missing parent work");
            };
            let Some(parent_goal) = db::goal(conn, &parent.goal_id)? else {
                bail!("graph parent work references missing Goal");
            };
            let Some(child_goal) = db::goal(conn, &work.goal_id)? else {
                bail!("graph child work references missing Goal");
            };
            if !link.current || parent.goal_revision != parent_goal.revision
                || db::revision(parent_goal.revision)? != link.parent_goal_revision
                || !live_ancestor(&parent) {
                return Ok(());
            }
            let recipient_registered: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM lifetime_registry WHERE ghost_id=?1)",
                [&parent.owner],
                |row| row.get(0),
            )?;
            if !recipient_registered {
                bail!("parent Ghost must be registered before child reports can be delivered");
            }
            let revision = db::revision(work.goal_revision)?;
            super::super::memory_publication::absorb_child_dependencies(conn,work,&parent)?;
            super::super::shared_skills::transfer(conn,work,&parent)?;
            let mut child_disclosure=child_goal.privacy.clone();
            conversation::raise_privacy(&mut child_disclosure,&super::super::shared_skills::privacy(conn,work)?)?;
            if let Some(execution)=&work.execution_id {
                let pinned:Option<String>=conn.query_row("SELECT privacy FROM lifetime_pi_executions WHERE execution_id=?1",[execution],|r|r.get(0)).optional()?;
                if let Some(pinned)=pinned {conversation::raise_privacy(&mut child_disclosure,&pinned)?;}
            }
            let mut parent_disclosure=conversation::conversation_privacy(conn,&parent_goal.accountable_ghost,&parent_goal.reply_conversation)?;
            conversation::raise_privacy(&mut parent_disclosure,&parent_goal.privacy)?;
            conversation::raise_privacy(&mut parent_disclosure,&super::super::shared_skills::privacy(conn,&parent)?)?;
            conversation::persist_disclosure(conn,&parent_goal.accountable_ghost,&parent_goal.reply_conversation,&parent_disclosure)?;
            let inserted = conn.execute(
                "INSERT OR IGNORE INTO lifetime_graph_wakes(parent_work_id,child_work_id,child_goal_revision,state) VALUES(?1,?2,?3,?4)",
                params![parent.id, work.id, revision, work.state],
            )?;
            if inserted == 1 {
                let summary = terminal_summary(work);
                let object_refs = vec![
                    parent.id.clone(),
                    work.id.clone(),
                    parent_goal.id.clone(),
                    child_goal.id.clone(),
                ];
                let payload = json!({
                    "summary": summary,
                    "object_refs": object_refs,
                });
                let payload_digest = canonical_digest(&payload)?;
                let message_id = format!(
                    "host-receipt:{}",
                    canonical_digest(&json!([
                        parent.id,
                        work.id,
                        work.goal_revision,
                        work.state,
                    ]))?
                );
                conn.execute(
                    "INSERT OR IGNORE INTO lifetime_mailbox(sender_id,message_id,recipient_id,payload_digest,privacy,payload,state) VALUES(?1,?2,?3,?4,?5,?6,'pending')",
                    params![
                        HOST_RECEIPT_SENDER,
                        message_id,
                        parent.owner,
                        payload_digest,
                        child_disclosure,
                        serde_json::to_string(&payload)?,
                    ],
                )?;
                let wake = json!({
                    "method": "conversation.submit",
                    "ghost_id": parent_goal.accountable_ghost,
                    "conversation_id": parent_goal.reply_conversation,
                    "privacy": parent_disclosure,
                    "goal_id": parent_goal.id,
                    "goal_revision": parent_goal.revision,
                    "prompt": summary,
                });
                context.enqueue(
                    "pi",
                    apply::outgoing(envelope, principal, Some(parent_goal.revision), wake)?,
                );
            }
            if is_dependency_resolved(&work.state) {
                release_child_dependencies(conn, &work.id, envelope, context)?;
                release_child_limit_blockers(conn, &link.root_goal_id)?;
            }
        } else if is_dependency_resolved(&work.state) {
            release_child_dependencies(conn, &work.id, envelope, context)?;
        }
    } else if is_dependency_resolved(&work.state) {
        release_child_dependencies(conn, &work.id, envelope, context)?;
    }
    Ok(())
}

fn work_delegate(
    conn: &Connection,
    envelope: &Envelope,
    principal: &str,
    context: &mut ApplyContext,
) -> Result<Response> {
    let normalized=super::delegation_contracts::resolved_body(conn,&envelope.body).map_err(|error|apply::invalid(error.to_string()))?;
    let body=&normalized;
    apply::allowed_fields(body,&["method","parent_work_id","target_ghost_id","summary","artifact_refs","acceptance_spec","work_memory_context_revision"],&["method","parent_work_id","target_ghost_id","summary","artifact_refs","acceptance_spec"])?;
    let parent_work_id = apply::string_field(body, "parent_work_id")?;
    let target_ghost_id = apply::string_field(body, "target_ghost_id")?;
    let summary = apply::string_field(body, "summary")?;
    let acceptance_spec = apply::value_field(body, "acceptance_spec")?;
    apply::validate_identity("parent_work_id", parent_work_id)?;
    apply::validate_identity("target_ghost_id", target_ghost_id)?;
    apply::validate_text("summary", summary)?;
    if summary.len() > DELEGATION_SUMMARY_MAX_BYTES {
        return Err(apply::invalid("delegation summary exceeds 8192 UTF-8 bytes"));
    }
    if !acceptance_spec.is_object() {
        return Err(apply::invalid("acceptance_spec must be an object"));
    }
    let artifact_refs = opaque_string_array(body, "artifact_refs", ARTIFACT_REFS_MAX)?;
    let expected_revision = envelope
        .expected_revision
        .ok_or_else(|| apply::conflict("work.delegate requires the current parent Goal revision"))?;
    let Some(parent_work) = db::work(conn, parent_work_id)? else {
        return Err(apply::not_found("parent work not found"));
    };
    if principal != OWNER_ADMIN && principal != parent_work.owner {
        return Err(apply::reject(
            "unauthorized",
            "delegation requires owner administration or the exact parent work owner",
            RetryClass::Never,
        ));
    }
    let Some(parent_goal) = db::goal(conn, &parent_work.goal_id)? else {
        bail!("parent work references a missing Goal");
    };
    if expected_revision != parent_goal.revision
        || parent_work.goal_revision != parent_goal.revision
    {
        return Err(apply::conflict("delegation parent Goal revision is stale"));
    }
    if parent_goal.state != "open" {
        return Err(apply::conflict("delegation parent Goal is not open"));
    }
    let Some(scope) = current_scope(conn, &parent_work, false, false)? else {
        return Err(apply::conflict(
            "terminal, cancelled, expired, or superseded ancestors cannot delegate",
        ));
    };
    let parent_registered: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM lifetime_registry WHERE ghost_id=?1)",
        [&parent_work.owner],
        |row| row.get(0),
    )?;
    if !parent_registered {
        return Err(apply::conflict(
            "parent Ghost must be registered before it can delegate durable child work",
        ));
    }
    let Some((target_conversation, target_mode)) = conn
        .query_row(
            "SELECT conversation_id,mode FROM lifetime_registry WHERE ghost_id=?1",
            [target_ghost_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
    else {
        return Err(apply::not_found("target Ghost is not registered"));
    };
    if target_mode != "active" {
        return Err(apply::conflict("target Ghost is not active"));
    }
    if !super::super::bot_lifecycle::admission_allowed(conn,target_ghost_id)? {
        return Err(apply::conflict("target bot is paused, retired, or not independently ready"));
    }

    let mut budget = budget_for(conn, &scope.root_goal_id)?;
    if budget.is_none() {
        if scope.depth != 0 || scope.root_goal_id != parent_goal.id {
            bail!("descendant work has no durable root graph budget");
        }
        ensure_budget(conn, &scope.root_goal_id)?;
        budget = budget_for(conn, &scope.root_goal_id)?;
    }
    let budget = budget.ok_or_else(|| anyhow!("root graph budget disappeared"))?;
    if budget.expired || budget.deadline_ms <= now_ms()? {
        return Ok(blocked_response(
            conn,
            &parent_work,
            &scope.root_goal_id,
            &format!("root graph deadline expired at {}", budget.deadline_ms),
        )?);
    }
    let child_depth = scope.depth + 1;
    if child_depth > DELEGATION_DEPTH_MAX {
        return Ok(blocked_response(
            conn,
            &parent_work,
            &scope.root_goal_id,
            &format!("delegation depth limit {DELEGATION_DEPTH_MAX} reached"),
        )?);
    }
    let unresolved_children = unresolved_child_count(conn, &scope.root_goal_id)?;
    if unresolved_children >= ACTIVE_CHILDREN_MAX {
        return Ok(blocked_response(
            conn,
            &parent_work,
            &scope.root_goal_id,
            &format!(
                "{CHILD_LIMIT_BLOCKER}{} unresolved current child work items; limit is {ACTIVE_CHILDREN_MAX}",
                unresolved_children
            ),
        )?);
    }
    if graph_node_count(conn, &scope.root_goal_id)? >= GRAPH_NODES_MAX as i64 {
        return Ok(blocked_response(
            conn,
            &parent_work,
            &scope.root_goal_id,
            &format!("graph node limit {GRAPH_NODES_MAX} reached"),
        )?);
    }

    super::super::work_memory::validate_delegation_target(conn,&parent_work,target_ghost_id)?;
    super::super::memory_publication::validate_delegation_target(conn,&parent_work,target_ghost_id)?;
    super::super::shared_skills::delegation_target(conn,&parent_work,target_ghost_id)?;
    let child_privacy=super::pi_execution::privacy(conn,&parent_work)?;
    let child_prompt = delegated_prompt(summary, &artifact_refs)?;
    let child_body = json!({
        "method": "goal.submit",
        "ghost_id": target_ghost_id,
        "conversation_id": target_conversation,
        "prompt": child_prompt,
        "privacy": child_privacy,
        "acceptance_spec": acceptance_spec,
    });
    let child_envelope = Envelope {
        body: child_body,
        ..envelope.clone()
    };
    let admitted = apply::admit_goal(conn, &child_envelope, principal, context, true)?;
    if admitted.status != crate::lifetime_contract::ResponseStatus::Success {
        return Ok(admitted);
    }
    let child_goal_id = admitted
        .data
        .pointer("/goal/id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("goal_submit omitted its child Goal ID"))?
        .to_owned();
    let child_work_id = admitted
        .data
        .pointer("/work/id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("goal_submit omitted its child Work ID"))?
        .to_owned();
    let child_goal = db::goal(conn, &child_goal_id)?
        .ok_or_else(|| anyhow!("goal_submit did not persist its child Goal"))?;
    let child_work = db::work(conn, &child_work_id)?
        .ok_or_else(|| anyhow!("goal_submit did not persist its child Work"))?;
    super::super::work_memory::restrict_child(conn,&parent_work,&child_work)?;
    super::super::memory_publication::child_dependencies(conn,&parent_work,&child_work)?;
    super::super::shared_skills::transfer(conn,&parent_work,&child_work)?;
    insert_link(
        conn,
        &child_work.id,
        &parent_work.id,
        db::revision(parent_work.goal_revision)?,
        &scope.root_goal_id,
        child_depth,
        true,
    )?;
    let link = link_for_child(conn, &child_work.id)?
        .ok_or_else(|| anyhow!("child Work link was not persisted"))?;
    Ok(apply::success(
        "child Goal and Work durably delegated",
        vec![parent_work.id, child_goal.id.clone(), child_work.id.clone()],
        json!({
            "goal": child_goal,
            "work": child_work,
            "link": link_json(&link),
            "root_goal_id": scope.root_goal_id,
            "artifact_refs": artifact_refs,
        }),
    ))
}

fn work_wait(conn: &Connection, envelope: &Envelope, principal: &str) -> Result<Response> {
    let body = &envelope.body;
    apply::allowed_fields(body,&["method","work_id","wait_for","work_memory_context_revision","assignment_id","generation_task_id"],&["method","work_id","wait_for"])?;
    let work_id = apply::string_field(body, "work_id")?;
    apply::validate_identity("work_id", work_id)?;
    let wait_for = opaque_string_array(body, "wait_for", WAIT_FOR_MAX)?;
    let Some(mut waiter) = db::work(conn, work_id)? else {
        return Err(apply::not_found("waiting work not found"));
    };
    if principal != OWNER_ADMIN && principal != waiter.owner {
        return Err(apply::reject(
            "unauthorized",
            "work.wait requires owner administration or the exact waiting work owner",
            RetryClass::Never,
        ));
    }
    let Some(waiter_goal) = db::goal(conn, &waiter.goal_id)? else {
        bail!("waiting work references a missing Goal");
    };
    let expected_revision = envelope
        .expected_revision
        .ok_or_else(|| apply::conflict("work.wait requires the current waiting Goal revision"))?;
    if expected_revision != waiter_goal.revision || waiter.goal_revision != waiter_goal.revision {
        return Err(apply::conflict("work.wait revision is stale"));
    }
    if is_dependency_resolved(&waiter.state) || waiter.cancellation != "none" {
        return Err(apply::conflict("terminal or cancelled work cannot wait"));
    }
    let Some(waiter_scope) = current_scope(conn, &waiter, false, false)? else {
        return Err(apply::conflict("waiting work has a stale or superseded ancestor"));
    };
    if let Some(budget) = budget_for(conn, &waiter_scope.root_goal_id)? {
        if budget.expired || budget.deadline_ms <= now_ms()? {
            return Err(apply::conflict("expired root graph cannot accept new wait edges"));
        }
    }
    if graph_node_count(conn, &waiter_scope.root_goal_id)? > GRAPH_NODES_MAX as i64 {
        return Err(apply::conflict("root graph exceeds the bounded node limit"));
    }

    let mut unique = BTreeSet::new();
    let mut resolved = Vec::new();
    let mut unresolved = Vec::new();
    for blocker_id in &wait_for {
        apply::validate_identity("wait_for work ID", blocker_id)?;
        if !unique.insert(blocker_id.as_str()) {
            return Err(apply::invalid("wait_for work IDs must be distinct"));
        }
        if blocker_id == &waiter.id {
            return Err(apply::conflict("work cannot wait for itself"));
        }
        let Some(blocker) = db::work(conn, blocker_id)? else {
            return Err(apply::not_found(format!("blocking work not found: {blocker_id}")));
        };
        let Some(blocker_scope) = current_scope(conn, &blocker, true, false)? else {
            return Err(apply::conflict(format!(
                "blocking work is stale or outside a current root graph: {blocker_id}"
            )));
        };
        if blocker_scope.root_goal_id != waiter_scope.root_goal_id {
            return Err(apply::conflict("wait_for work must belong to the same root graph"));
        }
        if is_dependency_resolved(&blocker.state) {
            resolved.push(blocker.id);
        } else {
            unresolved.push(blocker.id);
        }
    }

    let pi_wait=super::pi_wait::prepare(conn,envelope,principal,&waiter)?;
    conn.execute(
        "DELETE FROM lifetime_blocking_edges WHERE waiter_work_id=?1 AND kind='dependency'",
        [&waiter.id],
    )?;
    for blocker_id in &unresolved {
        conn.execute(
            "INSERT INTO lifetime_blocking_edges(waiter_work_id,blocker_work_id,kind) VALUES(?1,?2,'dependency')",
            params![waiter.id, blocker_id],
        )?;
    }
    for blocker_id in &unresolved {
        if blocking_path_reaches(conn, blocker_id, &waiter.id)? {
            return Err(apply::conflict(
                "blocking dependency would create a cycle across dependency/resource_hold edges",
            ));
        }
    }

    let edges = edges_for_waiter(conn, &waiter.id)?;
    if edges.is_empty() {
        waiter.state = "queued".to_owned();
        waiter.blocker = None;
    } else {
        waiter.state = "blocked".to_owned();
        waiter.blocker = Some(format_wait_blocker(&edges));
    }
    db::update_work(conn, &waiter)?;
    let wait_receipt=pi_wait.as_ref().map(|binding|super::pi_wait::store(conn,binding)).transpose()?;
    Ok(apply::success(
        if edges.is_empty() {
            "work dependencies are resolved"
        } else {
            "work is blocked on durable dependencies"
        },
        vec![waiter.id.clone()],
        json!({
            "work": waiter,
            "wait_receipt":wait_receipt,
            "root_goal_id": waiter_scope.root_goal_id,
            "wait_for": wait_for,
            "resolved_wait_for": resolved,
            "blocking_edges": edges_json(&edges),
        }),
    ))
}

fn work_children(conn: &Connection, body: &Value, principal: &str) -> Result<Response> {
    apply::exact_fields(body, &["method", "work_id"])?;
    let work_id = apply::string_field(body, "work_id")?;
    apply::validate_identity("work_id", work_id)?;
    let Some(requested) = db::work(conn, work_id)? else {
        return Err(apply::not_found("work not found"));
    };
    if principal != OWNER_ADMIN && principal != requested.owner {
        return Err(apply::reject(
            "unauthorized",
            "work.children requires owner administration or the exact work owner",
            RetryClass::Never,
        ));
    }
    let root_link = link_for_child(conn, &requested.id)?;
    let root_goal_id = root_link
        .as_ref()
        .map(|link| link.root_goal_id.clone())
        .unwrap_or_else(|| requested.goal_id.clone());
    let root_view = root_link.is_none();
    let (links, works, truncated) = collect_graph_view(conn, &requested, &root_goal_id, root_view)?;
    let budget = budget_for(conn, &root_goal_id)?;
    let requested_goal = db::goal(conn, &requested.goal_id)?
        .ok_or_else(|| anyhow!("graph Work references a missing Goal"))?;
    let pair_privacy = conversation::conversation_privacy(
        conn, &requested_goal.accountable_ghost, &requested_goal.reply_conversation,
    )?;
    let disclosure = if principal == OWNER_ADMIN || requested_goal.privacy == "local_only" || pair_privacy == "local_only" {
        "local_only"
    } else if requested_goal.privacy == "private" || pair_privacy == "private" {
        "private"
    } else {
        "public"
    };
    let mut results = Vec::new();
    for work in &works {
        if let Some(metadata) = apply::graph_artifact_metadata(conn, work, disclosure)? {
            results.push(metadata);
        }
    }
    let work_ids: BTreeSet<String> = works.iter().map(|work| work.id.clone()).collect();
    let blocking_edges = graph_edges_for_work_set(conn, &work_ids)?;
    let mut refs = vec![requested.id.clone(), root_goal_id.clone()];
    refs.extend(works.iter().map(|work| work.id.clone()));
    let data = json!({
        "work_id": requested.id,
        "root_goal_id": root_goal_id,
        "work": works,
        "results": results,
        "links": links.iter().map(link_json).collect::<Vec<_>>(),
        "budget": budget.map(budget_json),
        "blocking_edges": edges_json(&blocking_edges),
        "truncated": truncated,
        "node_limit": GRAPH_NODES_MAX,
    });
    if truncated {
        Ok(apply::warning(
            "responsibility graph view is bounded at 256 work nodes",
            refs,
            data,
        ))
    } else {
        Ok(apply::success("responsibility graph inspected", refs, data))
    }
}

pub(super) fn native_artifact_inputs(
    conn: &Connection,
    work: &Work,
) -> Result<Option<Vec<WorkerArtifactInput>>> {
    if !current_result_scope(conn, work)? {
        return Err(apply::conflict("native artifact inputs require a current parent Work"));
    }
    let goal = db::goal(conn, &work.goal_id)?
        .ok_or_else(|| anyhow!("native input Work references a missing Goal"))?;
    let pair_privacy = conversation::conversation_privacy(
        conn, &goal.accountable_ghost, &goal.reply_conversation,
    )?;
    let disclosure = if goal.privacy == "local_only" || pair_privacy == "local_only" {
        "local_only"
    } else if goal.privacy == "private" || pair_privacy == "private" {
        "private"
    } else {
        "public"
    };
    let links = links_by_parent(conn, &work.id, true)?;
    if links.len() > GRAPH_NODES_MAX {
        return Err(apply::conflict("native artifact inputs exceed the bounded child graph"));
    }
    let mut inputs = Vec::new();
    for link in links {
        let child = db::work(conn, &link.child_work_id)?
            .ok_or_else(|| anyhow!("native input link references a missing Work"))?;
        if !matches!(child.state.as_str(), "completed" | "accepted") {
            continue;
        }
        let Some(metadata) = apply::graph_artifact_metadata(conn, &child, disclosure)? else {
            continue;
        };
        let input: WorkerArtifactInput = serde_json::from_value(metadata)?;
        if !input.artifacts.is_empty() {
            inputs.push(input);
        }
    }
    Ok((!inputs.is_empty()).then_some(inputs))
}

fn work_expire(
    conn: &Connection,
    envelope: &Envelope,
    principal: &str,
    context: &mut ApplyContext,
) -> Result<Response> {
    let body = &envelope.body;
    apply::exact_fields(body, &["method", "root_goal_id"])?;
    let root_goal_id = apply::string_field(body, "root_goal_id")?;
    apply::validate_identity("root_goal_id", root_goal_id)?;
    if principal != OWNER_ADMIN && principal != HOST_MAINTENANCE {
        return Err(apply::reject(
            "unauthorized",
            "work.expire requires owner administration or the trusted host-maintenance principal",
            RetryClass::Never,
        ));
    }
    let Some(budget) = budget_for(conn, root_goal_id)? else {
        return Err(apply::not_found("root graph budget not found"));
    };
    if now_ms()? < budget.deadline_ms {
        return Err(apply::conflict("root graph deadline has not elapsed"));
    }
    if budget.expired {
        return Ok(apply::success(
            "root graph expiration recovered",
            vec![root_goal_id.to_owned()],
            json!({ "root_goal_id": root_goal_id, "expired": true, "recovered": true }),
        ));
    }
    if graph_node_count(conn, root_goal_id)? > GRAPH_NODES_MAX as i64 {
        return Err(apply::conflict(
            "cannot expire a responsibility graph that exceeds the bounded node limit",
        ));
    }
    let Some(root_goal) = db::goal(conn, root_goal_id)? else {
        bail!("graph budget references a missing root Goal");
    };
    conn.execute(
        "UPDATE lifetime_graph_budgets SET expired=1 WHERE root_goal_id=?1 AND expired=0",
        [root_goal_id],
    )?;

    let root_works = db::works_for_goal(conn, root_goal_id)?;
    for mut work in root_works {
        if work.goal_revision == root_goal.revision
            && !is_dependency_resolved(&work.state)
        {
            work.state = "blocked".to_owned();
            work.blocker = Some(format!("root graph expired at deadline {}", budget.deadline_ms));
            db::update_work(conn, &work)?;
        }
    }

    let links = links_for_root(conn, root_goal_id)?;
    for link in &links {
        if link.current {
            conn.execute(
                "UPDATE lifetime_work_links SET current=0 WHERE child_work_id=?1 AND current=1",
                [&link.child_work_id],
            )?;
        }
    }
    let mut cancel_requested = 0usize;
    let mut cancelled_without_execution = Vec::new();
    for link in &links {
        if !link.current {
            continue;
        }
        let Some(mut work) = db::work(conn, &link.child_work_id)? else {
            bail!("graph link references missing descendant work");
        };
        if is_dependency_resolved(&work.state)
            || work.cancellation == "requested"
            || matches!(work.state.as_str(), "completed" | "stale")
        {
            continue;
        }
        let reason = format!("root graph {} expired", root_goal_id);
        if work.execution_id.is_some() {
            if request_worker_cancellation(
                conn,
                &mut work,
                &reason,
                envelope,
                principal,
                context,
            )? {
                cancel_requested += 1;
            }
        } else {
            work.cancellation = "confirmed".to_owned();
            work.state = "cancelled".to_owned();
            work.blocker = None;
            db::update_work(conn, &work)?;
            cancelled_without_execution.push(work);
        }
    }
    for work in &cancelled_without_execution {
        terminal_changed(conn, envelope, principal, work, context)?;
    }
    Ok(apply::success(
        "root graph expired; unfinished descendants are cancelled or cancellation-requested",
        vec![root_goal_id.to_owned()],
        json!({
            "root_goal_id": root_goal_id,
            "expired": true,
            "deadline_ms": budget.deadline_ms,
            "cancel_requested": cancel_requested,
            "cancelled_without_execution": cancelled_without_execution.len(),
        }),
    ))
}

fn current_scope(
    conn: &Connection,
    work: &Work,
    allow_terminal_start: bool,
    allow_accepted_ancestors: bool,
) -> Result<Option<GraphScope>> {
    let mut parent_work;
    let mut cursor = work;
    let mut visited = BTreeSet::new();
    let mut root_goal_id: Option<String> = None;
    let mut expected_depth: Option<i64> = None;
    let mut start_depth = 0;
    let mut first = true;
    loop {
        if !visited.insert(cursor.id.clone()) || visited.len() > GRAPH_NODES_MAX {
            return Ok(None);
        }
        let Some(goal) = db::goal(conn, &cursor.goal_id)? else {
            return Ok(None);
        };
        if cursor.goal_revision != goal.revision {
            return Ok(None);
        }
        let accepted_ancestor = allow_accepted_ancestors
            && cursor.state == "accepted" && cursor.cancellation == "none";
        if !(first && allow_terminal_start) && !accepted_ancestor && !live_ancestor(&cursor) {
            return Ok(None);
        }
        match link_for_child(conn, &cursor.id)? {
            Some(link) => {
                if !link.current
                    || expected_depth.is_some_and(|depth| depth != link.depth)
                    || root_goal_id
                        .as_ref()
                        .is_some_and(|root| root != &link.root_goal_id)
                {
                    return Ok(None);
                }
                if first {
                    start_depth = link.depth;
                }
                if link.depth <= 0 {
                    return Ok(None);
                }
                root_goal_id.get_or_insert_with(|| link.root_goal_id.clone());
                let Some(parent) = db::work(conn, &link.parent_work_id)? else {
                    return Ok(None);
                };
                let Some(parent_goal) = db::goal(conn, &parent.goal_id)? else {
                    return Ok(None);
                };
                if parent.goal_revision != parent_goal.revision
                    || db::revision(parent.goal_revision)? != link.parent_goal_revision
                {
                    return Ok(None);
                }
                expected_depth = Some(link.depth - 1);
                parent_work = parent;
                cursor = &parent_work;
                first = false;
            }
            None => {
                let root = root_goal_id.unwrap_or_else(|| cursor.goal_id.clone());
                if cursor.goal_id != root || expected_depth.is_some_and(|depth| depth != 0) {
                    return Ok(None);
                }
                return Ok(Some(GraphScope {
                    root_goal_id: root,
                    depth: start_depth,
                }));
            }
        }
    }
}

fn live_ancestor(work: &Work) -> bool {
    work.cancellation == "none"
        && !matches!(
            work.state.as_str(),
            "accepted" | "failed" | "cancelled" | "canceled"
                | "stopped" | "rejected" | "stale"
        )
}

fn is_dependency_resolved(state: &str) -> bool {
    matches!(state, "accepted" | "failed" | "cancelled")
}

fn is_blocked_limit(work: &Work) -> bool {
    work.state == "blocked"
        && work
            .blocker
            .as_deref()
            .is_some_and(|blocker| blocker.starts_with(CHILD_LIMIT_BLOCKER))
}

fn link_for_child(conn: &Connection, child_work_id: &str) -> Result<Option<WorkLink>> {
    conn.query_row(
        "SELECT child_work_id,parent_work_id,parent_goal_revision,root_goal_id,depth,current FROM lifetime_work_links WHERE child_work_id=?1",
        [child_work_id],
        link_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn link_from_row(row: &Row<'_>) -> rusqlite::Result<WorkLink> {
    Ok(WorkLink {
        child_work_id: row.get(0)?,
        parent_work_id: row.get(1)?,
        parent_goal_revision: row.get(2)?,
        root_goal_id: row.get(3)?,
        depth: row.get(4)?,
        current: row.get::<_, i64>(5)? != 0,
    })
}

fn links_by_parent(conn: &Connection, parent_work_id: &str, current_only: bool) -> Result<Vec<WorkLink>> {
    let sql = if current_only {
        "SELECT child_work_id,parent_work_id,parent_goal_revision,root_goal_id,depth,current FROM lifetime_work_links WHERE parent_work_id=?1 AND current=1 ORDER BY child_work_id"
    } else {
        "SELECT child_work_id,parent_work_id,parent_goal_revision,root_goal_id,depth,current FROM lifetime_work_links WHERE parent_work_id=?1 ORDER BY child_work_id"
    };
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map([parent_work_id], link_from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

fn links_for_root(conn: &Connection, root_goal_id: &str) -> Result<Vec<WorkLink>> {
    let mut statement = conn.prepare(
        "SELECT child_work_id,parent_work_id,parent_goal_revision,root_goal_id,depth,current FROM lifetime_work_links WHERE root_goal_id=?1 ORDER BY depth,child_work_id LIMIT ?2",
    )?;
    let rows = statement.query_map(params![root_goal_id, GRAPH_NODES_MAX as i64 + 1], link_from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

fn links_for_goal(conn: &Connection, goal_id: &str) -> Result<Vec<WorkLink>> {
    let mut statement = conn.prepare(
        "SELECT l.child_work_id,l.parent_work_id,l.parent_goal_revision,l.root_goal_id,l.depth,l.current FROM lifetime_work_links l JOIN lifetime_work w ON w.id=l.child_work_id WHERE w.goal_id=?1 ORDER BY l.current DESC,l.child_work_id",
    )?;
    let rows = statement.query_map([goal_id], link_from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}
pub(super) fn has_goal_link_history(conn: &Connection, goal_id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM lifetime_work_links l
            JOIN lifetime_work w ON w.id=l.child_work_id
            WHERE w.goal_id=?1
        )",
        [goal_id],
        |row| row.get(0),
    )?)
}

fn insert_link(
    conn: &Connection,
    child_work_id: &str,
    parent_work_id: &str,
    parent_goal_revision: i64,
    root_goal_id: &str,
    depth: i64,
    current: bool,
) -> Result<()> {
    conn.execute(
        "INSERT INTO lifetime_work_links(child_work_id,parent_work_id,parent_goal_revision,root_goal_id,depth,current) VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            child_work_id,
            parent_work_id,
            parent_goal_revision,
            root_goal_id,
            depth,
            if current { 1i64 } else { 0i64 },
        ],
    )?;
    Ok(())
}

fn collect_descendant_links(
    conn: &Connection,
    seeds: &[String],
    current_only: bool,
) -> Result<Vec<WorkLink>> {
    let mut queue = VecDeque::new();
    let mut visited = BTreeSet::new();
    for seed in seeds {
        if visited.insert(seed.clone()) {
            queue.push_back(seed.clone());
        }
    }
    if visited.len() > GRAPH_NODES_MAX {
        return Err(apply::conflict("responsibility graph exceeds 256 work nodes"));
    }
    let mut links = Vec::new();
    while let Some(parent_id) = queue.pop_front() {
        for link in links_by_parent(conn, &parent_id, current_only)? {
            if visited.insert(link.child_work_id.clone()) {
                if visited.len() > GRAPH_NODES_MAX {
                    return Err(apply::conflict("responsibility graph exceeds 256 work nodes"));
                }
                queue.push_back(link.child_work_id.clone());
                links.push(link);
            }
        }
    }
    Ok(links)
}

fn budget_for(conn: &Connection, root_goal_id: &str) -> Result<Option<GraphBudget>> {
    conn.query_row(
        "SELECT root_goal_id,deadline_ms,automatic_revisions,expired FROM lifetime_graph_budgets WHERE root_goal_id=?1",
        [root_goal_id],
        |row| {
            Ok(GraphBudget {
                root_goal_id: row.get(0)?,
                deadline_ms: row.get(1)?,
                automatic_revisions: row.get(2)?,
                expired: row.get::<_, i64>(3)? != 0,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn ensure_budget(conn: &Connection, root_goal_id: &str) -> Result<()> {
    let deadline_ms = now_ms()?
        .checked_add(DELEGATION_WALL_TIME_MS)
        .ok_or_else(|| anyhow!("root graph deadline overflows SQLite integer range"))?;
    conn.execute(
        "INSERT OR IGNORE INTO lifetime_graph_budgets(root_goal_id,deadline_ms,automatic_revisions,expired) VALUES(?1,?2,0,0)",
        params![root_goal_id, deadline_ms],
    )?;
    Ok(())
}

fn now_ms() -> Result<i64> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| anyhow!("system clock precedes Unix epoch: {error}"))?;
    i64::try_from(elapsed.as_millis())
        .map_err(|_| anyhow!("current time exceeds SQLite integer range"))
}

fn graph_node_count(conn: &Connection, root_goal_id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM (SELECT id AS work_id FROM lifetime_work WHERE goal_id=?1 UNION SELECT child_work_id AS work_id FROM lifetime_work_links WHERE root_goal_id=?1)",
        [root_goal_id],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn unresolved_child_count(conn: &Connection, root_goal_id: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM lifetime_work_links l JOIN lifetime_work w ON w.id=l.child_work_id JOIN lifetime_goals g ON g.id=w.goal_id WHERE l.root_goal_id=?1 AND l.current=1 AND w.goal_revision=g.revision AND w.state NOT IN ('accepted','failed','cancelled')",
        [root_goal_id],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

fn blocked_response(
    conn: &Connection,
    work: &Work,
    root_goal_id: &str,
    blocker: &str,
) -> Result<Response> {
    let mut blocked = work.clone();
    blocked.state = "blocked".to_owned();
    blocked.blocker = Some(blocker.to_owned());
    db::update_work(conn, &blocked)?;
    Ok(apply::warning(
        blocker.to_owned(),
        vec![blocked.id.clone()],
        json!({ "work": blocked, "root_goal_id": root_goal_id, "blocker": blocker }),
    ))
}

fn admission_warning(
    conn: &Connection,
    work: &Work,
    blocker: &str,
    persist_block: bool,
) -> Result<Response> {
    let mut current = work.clone();
    if persist_block && !is_dependency_resolved(&current.state) {
        current.state = "blocked".to_owned();
        current.blocker = Some(blocker.to_owned());
        db::update_work(conn, &current)?;
    }
    Ok(apply::warning(
        blocker.to_owned(),
        vec![current.id.clone()],
        json!({ "work": current, "blocker": blocker }),
    ))
}

fn opaque_string_array(body: &Value, field: &str, max: usize) -> Result<Vec<String>> {
    let Some(items) = body.get(field).and_then(Value::as_array) else {
        return Err(apply::invalid(format!("{field} must be an array of strings")));
    };
    if items.len() > max {
        return Err(apply::invalid(format!("{field} exceeds its limit of {max}")));
    }
    items
        .iter()
        .map(|item| {
            let Some(value) = item.as_str() else {
                return Err(apply::invalid(format!("{field} must contain only strings")));
            };
            apply::validate_identity(field, value)?;
            Ok(value.to_owned())
        })
        .collect()
}

pub(super) fn delegated_prompt(summary: &str, refs: &[String]) -> Result<String> {
    if refs.is_empty() {
        return Ok(summary.to_owned());
    }
    Ok(format!(
        "{summary}\n\nOpaque artifact references selected for this delegation (contents were not copied): {}",
        serde_json::to_string(refs)?
    ))
}

fn terminal_summary(work: &Work) -> String {
    match work.state.as_str() {
        "completed" => format!(
            "Host receipt: child work {} produced a completed result at child Goal revision {}; independent acceptance is still required.",
            work.id, work.goal_revision
        ),
        "accepted" => format!(
            "Host receipt: child work {} was accepted at child Goal revision {}.",
            work.id, work.goal_revision
        ),
        "failed" => format!(
            "Host receipt: child work {} failed at child Goal revision {}.",
            work.id, work.goal_revision
        ),
        "cancelled" => format!(
            "Host receipt: child work {} was cancelled at child Goal revision {}.",
            work.id, work.goal_revision
        ),
        _ => "Host receipt: child work state changed.".to_owned(),
    }
}

fn request_worker_cancellation(
    conn: &Connection,
    work: &mut Work,
    reason: &str,
    envelope: &Envelope,
    principal: &str,
    context: &mut ApplyContext,
) -> Result<bool> {
    if work.cancellation != "none" {
        return Ok(false);
    }
    let Some(execution_id) = work.execution_id.clone() else {
        return Ok(false);
    };
    if matches!(work.state.as_str(), "accepted" | "failed" | "cancelled") {
        return Ok(false);
    }
    work.cancellation = "requested".to_owned();
    work.state = "cancel_requested".to_owned();
    work.blocker = Some(reason.to_owned());
    db::update_work(conn, work)?;
    if !super::pi_execution::execution_is_pi(conn,&execution_id)? {
        let body = json!({ "method": "cancel", "execution_id": execution_id });
        context.enqueue("worker",apply::outgoing(envelope, principal, Some(work.goal_revision), body)?);
    }
    Ok(true)
}

fn mark_result_stale(conn: &Connection, execution_id: &str, reason: &str) -> Result<()> {
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload FROM lifetime_results WHERE execution_id=?1",
            [execution_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(payload) = payload else {
        return Ok(());
    };
    let mut record: Value = serde_json::from_str(&payload)?;
    let Some(object) = record.as_object_mut() else {
        bail!("stored result record is not a JSON object");
    };
    object.insert("current".to_owned(), Value::Bool(false));
    object.insert("reason".to_owned(), Value::String(reason.to_owned()));
    conn.execute(
        "UPDATE lifetime_results SET payload=?1 WHERE execution_id=?2",
        params![serde_json::to_string(&record)?, execution_id],
    )?;
    Ok(())
}


fn remove_wait_edges_for_invalidated_waiters(
    conn: &Connection,
    invalidated: &BTreeSet<String>,
) -> Result<()> {
    for work_id in invalidated {
        conn.execute(
            "DELETE FROM lifetime_blocking_edges WHERE waiter_work_id=?1 AND kind='dependency'",
            [work_id],
        )?;
    }
    Ok(())
}

fn reconcile_superseded_dependencies(
    conn: &Connection,
    stale_work_ids: &BTreeSet<String>,
) -> Result<()> {
    for stale_id in stale_work_ids {
        let mut statement = conn.prepare(
            "SELECT waiter_work_id FROM lifetime_blocking_edges WHERE blocker_work_id=?1 AND kind='dependency' ORDER BY waiter_work_id",
        )?;
        let waiters = statement
            .query_map([stale_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        conn.execute(
            "DELETE FROM lifetime_blocking_edges WHERE blocker_work_id=?1 AND kind='dependency'",
            [stale_id],
        )?;
        for waiter_id in waiters {
            let Some(mut waiter) = db::work(conn, &waiter_id)? else {
                continue;
            };
            if waiter.state == "blocked" && waiter.cancellation == "none" {
                waiter.blocker = Some(format!(
                    "{WAIT_BLOCKER} dependency {stale_id} was superseded by a Goal revision"
                ));
                db::update_work(conn, &waiter)?;
            }
        }
    }
    Ok(())
}

fn release_child_dependencies(
    conn: &Connection,
    child_work_id: &str,
    cause: &Envelope,
    context: &mut ApplyContext,
) -> Result<()> {
    let waiters = {
        let mut statement = conn.prepare(
            "SELECT DISTINCT waiter_work_id FROM lifetime_blocking_edges WHERE blocker_work_id=?1 AND kind='dependency' ORDER BY waiter_work_id",
        )?;
        let rows = statement.query_map([child_work_id], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    conn.execute(
        "DELETE FROM lifetime_blocking_edges WHERE blocker_work_id=?1 AND kind='dependency'",
        [child_work_id],
    )?;
    for waiter_id in waiters {
        if let Some(waiter) = refresh_waiter_blocker(conn, &waiter_id)? {
            enqueue_released_assignment(conn, cause, context, waiter)?;
        }
    }
    Ok(())
}

fn refresh_waiter_blocker(conn: &Connection, waiter_id: &str) -> Result<Option<Work>> {
    let Some(mut waiter) = db::work(conn, waiter_id)? else {
        return Ok(None);
    };
    if is_dependency_resolved(&waiter.state) || waiter.cancellation != "none" {
        return Ok(None);
    }
    let edges = edges_for_waiter(conn, waiter_id)?;
    if edges.is_empty() {
        if waiter.state == "blocked"
            && waiter
                .blocker
                .as_deref()
                .is_some_and(|blocker| blocker.starts_with(WAIT_BLOCKER))
        {
            waiter.state = "queued".to_owned();
            waiter.blocker = None;
            db::update_work(conn, &waiter)?;
            super::pi_wait::mark_resolved(conn,&waiter)?;
            return Ok(Some(waiter));
        }
    } else if waiter.state == "blocked"
        && waiter
            .blocker
            .as_deref()
            .is_some_and(|blocker| blocker.starts_with(WAIT_BLOCKER))
    {
        waiter.blocker = Some(format_wait_blocker(&edges));
        db::update_work(conn, &waiter)?;
    }
    Ok(None)
}

fn enqueue_released_assignment(
    conn: &Connection,
    cause: &Envelope,
    context: &mut ApplyContext,
    mut work: Work,
) -> Result<()> {
    if work.execution_id.is_some() || super::pi_wait::has_bound_wait(conn,&work)? || !current_result_scope(conn, &work)? {
        return Ok(());
    }
    let pending: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM lifetime_outbox
            WHERE target='pi' AND acknowledged=0
              AND json_extract(payload,'$.body.method')='conversation.assignment'
              AND json_extract(payload,'$.body.work_id')=?1
              AND json_extract(payload,'$.body.goal_revision')=?2)",
        params![work.id, db::revision(work.goal_revision)?],
        |row| row.get(0),
    )?;
    if pending {
        return Ok(());
    }
    let goal = db::goal(conn, &work.goal_id)?
        .ok_or_else(|| anyhow!("released Work references a missing Goal"))?;
    let source = match assignments::source_for_current_goal(conn, &goal) {
        Ok(source) if source.authority_epoch == cause.authority_epoch => source,
        Ok(_) => {
            work.state = "blocked".to_owned();
            work.blocker = Some("Released responsibility needs current authority reconciliation".to_owned());
            db::update_work(conn, &work)?;
            return Ok(());
        }
        Err(error) if error.downcast_ref::<apply::Rejected>().is_some() => {
            work.state = "blocked".to_owned();
            work.blocker = Some("Released responsibility has no verified committed admission".to_owned());
            db::update_work(conn, &work)?;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
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
    let payload = apply::outgoing_with_cause(
        &source, &cause.command_id, &source.actor_ref, Some(goal.revision), body,
    )?;
    // A notification is not Owner authority. Reuse the immutable admission's
    // provenance; only the new dependency transition identifies this delivery.
    context.enqueue_from(source.command_id, "pi", payload);
    Ok(())
}

fn release_child_limit_blockers(conn: &Connection, root_goal_id: &str) -> Result<()> {
    let Some(budget) = budget_for(conn, root_goal_id)? else {
        return Ok(());
    };
    if budget.expired || budget.deadline_ms <= now_ms()? {
        return Ok(());
    }
    if unresolved_child_count(conn, root_goal_id)? >= ACTIVE_CHILDREN_MAX {
        return Ok(());
    }
    let mut work_ids = BTreeSet::new();
    let mut statement = conn.prepare(
        "SELECT id FROM lifetime_work WHERE goal_id=?1 UNION SELECT child_work_id FROM lifetime_work_links WHERE root_goal_id=?1",
    )?;
    let rows = statement.query_map([root_goal_id], |row| row.get::<_, String>(0))?;
    for row in rows {
        work_ids.insert(row?);
    }
    for work_id in work_ids {
        let Some(mut work) = db::work(conn, &work_id)? else {
            continue;
        };
        if !is_blocked_limit(&work) || work.cancellation != "none" {
            continue;
        }
        if current_scope(conn, &work, false, false)?.is_none() {
            continue;
        }
        work.state = "queued".to_owned();
        work.blocker = None;
        db::update_work(conn, &work)?;
    }
    Ok(())
}

fn reconcile_terminal_dependencies(conn: &Connection, waiter_id: &str) -> Result<()> {
    let edges = edges_for_waiter(conn, waiter_id)?;
    for edge in edges {
        if edge.kind != "dependency" {
            continue;
        }
        let Some(blocker) = db::work(conn, &edge.blocker_work_id)? else {
            continue;
        };
        if is_dependency_resolved(&blocker.state) {
            conn.execute(
                "DELETE FROM lifetime_blocking_edges WHERE waiter_work_id=?1 AND blocker_work_id=?2 AND kind='dependency'",
                params![waiter_id, edge.blocker_work_id],
            )?;
        }
    }
    let _ = refresh_waiter_blocker(conn, waiter_id)?;
    Ok(())
}

#[derive(Clone, Debug)]
struct BlockingEdge {
    waiter_work_id: String,
    blocker_work_id: String,
    kind: String,
}

fn edges_for_waiter(conn: &Connection, waiter_id: &str) -> Result<Vec<BlockingEdge>> {
    let mut statement = conn.prepare(
        "SELECT waiter_work_id,blocker_work_id,kind FROM lifetime_blocking_edges WHERE waiter_work_id=?1 ORDER BY kind,blocker_work_id",
    )?;
    let rows = statement.query_map([waiter_id], |row| {
        Ok(BlockingEdge {
            waiter_work_id: row.get(0)?,
            blocker_work_id: row.get(1)?,
            kind: row.get(2)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

fn graph_edges_for_work_set(
    conn: &Connection,
    work_ids: &BTreeSet<String>,
) -> Result<Vec<BlockingEdge>> {
    let mut edges = Vec::new();
    for work_id in work_ids {
        edges.extend(edges_for_waiter(conn, work_id)?);
    }
    Ok(edges)
}

fn format_wait_blocker(edges: &[BlockingEdge]) -> String {
    let values = edges
        .iter()
        .map(|edge| format!("{}:{}", edge.kind, edge.blocker_work_id))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{WAIT_BLOCKER} {values}")
}

fn edges_json(edges: &[BlockingEdge]) -> Vec<Value> {
    edges
        .iter()
        .map(|edge| {
            json!({
                "waiter_work_id": edge.waiter_work_id,
                "blocker_work_id": edge.blocker_work_id,
                "kind": edge.kind,
            })
        })
        .collect()
}

fn blocking_path_reaches(conn: &Connection, start: &str, target: &str) -> Result<bool> {
    let mut queue = VecDeque::from([start.to_owned()]);
    let mut visited = BTreeSet::new();
    while let Some(work_id) = queue.pop_front() {
        if !visited.insert(work_id.clone()) {
            continue;
        }
        if visited.len() > GRAPH_NODES_MAX {
            return Err(apply::conflict(
                "blocking graph traversal exceeds the 256-node safety bound",
            ));
        }
        if work_id == target {
            return Ok(true);
        }
        for edge in edges_for_waiter(conn, &work_id)? {
            queue.push_back(edge.blocker_work_id);
        }
    }
    Ok(false)
}

fn collect_graph_view(
    conn: &Connection,
    requested: &Work,
    root_goal_id: &str,
    root_view: bool,
) -> Result<(Vec<WorkLink>, Vec<Work>, bool)> {
    let mut work_ids = Vec::new();
    let mut seen = BTreeSet::new();
    let mut links = Vec::new();
    let mut truncated = false;
    if root_view {
        let root_works = {
            let mut statement = conn.prepare(
                "SELECT id FROM lifetime_work WHERE goal_id=?1 ORDER BY rowid LIMIT ?2",
            )?;
            let rows = statement.query_map(
                params![root_goal_id, GRAPH_NODES_MAX as i64 + 1],
                |row| row.get::<_, String>(0),
            )?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for work_id in root_works {
            if seen.len() == GRAPH_NODES_MAX {
                truncated = true;
                break;
            }
            if seen.insert(work_id.clone()) {
                work_ids.push(work_id);
            }
        }
        let root_links = links_for_root(conn, root_goal_id)?;
        if root_links.len() > GRAPH_NODES_MAX {
            truncated = true;
        }
        for link in root_links {
            if seen.contains(&link.child_work_id) {
                links.push(link);
                continue;
            }
            if seen.len() == GRAPH_NODES_MAX {
                truncated = true;
                continue;
            }
            seen.insert(link.child_work_id.clone());
            work_ids.push(link.child_work_id.clone());
            links.push(link);
        }
    } else {
        work_ids.push(requested.id.clone());
        seen.insert(requested.id.clone());
        let mut queue = VecDeque::from([requested.id.clone()]);
        while let Some(parent_id) = queue.pop_front() {
            for link in links_by_parent(conn, &parent_id, false)? {
                if seen.contains(&link.child_work_id) {
                    continue;
                }
                if seen.len() == GRAPH_NODES_MAX {
                    truncated = true;
                    continue;
                }
                seen.insert(link.child_work_id.clone());
                work_ids.push(link.child_work_id.clone());
                queue.push_back(link.child_work_id.clone());
                links.push(link);
            }
        }
    }
    let mut works = Vec::with_capacity(work_ids.len());
    for work_id in work_ids {
        let Some(work) = db::work(conn, &work_id)? else {
            bail!("responsibility graph references missing Work {work_id}");
        };
        works.push(work);
    }
    Ok((links, works, truncated))
}

fn link_json(link: &WorkLink) -> Value {
    json!({
        "child_work_id": link.child_work_id,
        "parent_work_id": link.parent_work_id,
        "parent_goal_revision": link.parent_goal_revision,
        "root_goal_id": link.root_goal_id,
        "depth": link.depth,
        "current": link.current,
    })
}

fn budget_json(budget: GraphBudget) -> Value {
    json!({
        "root_goal_id": budget.root_goal_id,
        "deadline_ms": budget.deadline_ms,
        "automatic_revisions": budget.automatic_revisions,
        "expired": budget.expired,
    })
}
