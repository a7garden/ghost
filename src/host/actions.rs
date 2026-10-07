//! Owner commands are separate from the model's action space.
use super::{now_ms, text, Host, State};
use crate::durable::{self as host, durable::Phase};
use crate::{
    adapters::{
        channels,
        documents::{self, Space},
    },
    control::api::OwnerAction,
    domain::{Goal, Policy, Review},
};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
fn space(s: &State, id: &str) -> Result<Space> {
    s.journal
        .get("space", id)?
        .ok_or_else(|| anyhow!("Space missing"))
}
fn profiles(s: &State, ids: &[String]) -> Result<()> {
    if ids.len() > 64 || ids.iter().any(|id| !s.profiles.contains_key(id)) {
        bail!("invalid Space profile access");
    }
    Ok(())
}
fn page_saved(s: &State, review: &Review, page: &documents::Page) -> Result<()> {
    let access = space(s, &review.space_id)?.profiles;
    for profile in access {
        let key = format!("page_saved:{}:{}", review.id, profile);
        if s.journal.get::<Value>("event", &key)?.is_none() {
            s.journal.put("event", &key, &json!({"id":key,"profile_id":profile,"name":"page_saved","created_ms":now_ms(),"space_id":review.space_id,"document_id":page.id,"source_hash":page.hash}))?;
        }
    }
    Ok(())
}
pub fn save_review(s: &State, review: &mut Review) -> Result<Value> {
    let space = space(s, &review.space_id)?;
    if !space.writable {
        bail!("Space is read-only");
    }
    if !review.profile_id.is_empty() {
        if !space.profiles.contains(&review.profile_id) {
            bail!("Space access was revoked");
        }
        let snapshot = s
            .profiles
            .get(&review.profile_id)
            .ok_or_else(|| anyhow!("Ghost missing"))?
            .runtime
            .session
            .snapshot()?;
        if !snapshot.tasks.get(&review.task_id).is_some_and(|t| {
            matches!(t.phase, Phase::WaitingOwner | Phase::ToolReady)
                || review.state == "approved" && t.phase == Phase::Uncertain
        }) {
            bail!("proposal is no longer awaiting owner review");
        }
        if let Some(task) = snapshot.tasks.get(&review.task_id) {
            if let host::durable::TaskKind::Tool { call, .. } = &task.kind {
                super::services::Bridge::authority_in(s, &review.profile_id, task, Some(call))?;
            }
        }
        if now_ms() >= review.expires_ms {
            bail!("proposal expired; no document saved");
        }
    }
    if let Some(expected) = &review.expected_hash {
        let current = documents::read(&space, &review.page_id)?;
        if review.state == "approved"
            && review
                .result
                .as_ref()
                .and_then(|v| v["planned_hash"].as_str())
                == Some(current.hash.as_str())
        {
            page_saved(s, review, &current)?;
            review.state = "saved".into();
            review.result = Some(json!(current));
            s.journal.put("review", &review.id, review)?;
            return Ok(json!(current));
        }
        if current.hash != *expected {
            bail!("external_change_conflict: inspect current source before approval");
        }
        let hash = documents::digest(&documents::proposed_source(
            &current,
            &review.title,
            &review.body,
            &review.created,
        )?);
        review.result = Some(json!({"planned_hash":hash}));
    } else {
        documents::new_source(
            &review.page_id,
            &review.title,
            &review.body,
            &review.profile,
            &review.created,
        )?;
    }
    review.state = "approved".into();
    s.journal.put("review", &review.id, review)?;
    let page = if let Some(expected) = &review.expected_hash {
        documents::update(
            &space,
            &review.page_id,
            expected,
            &review.title,
            &review.body,
            &review.created,
        )?
    } else {
        documents::create(
            &space,
            &review.page_id,
            &review.title,
            &review.body,
            &review.profile,
            &review.created,
        )?
    };
    page_saved(s, review, &page)?;
    review.state = "saved".into();
    review.result = Some(json!(page));
    s.journal.put("review", &review.id, review)?;
    Ok(json!(page))
}
pub fn apply(app: &Arc<Host>, s: &State, request: &str, action: OwnerAction) -> Result<Value> {
    match action {
        OwnerAction::SaveModelProvider { provider, version } => {
            super::models::save(s, provider, version)
        }
        OwnerAction::DeleteModelProvider { id, version } => super::models::delete(s, &id, version),
        OwnerAction::SelectRoleModel {
            role,
            model,
            version,
        } => super::models::select(s, role, model, version),
        OwnerAction::ModelCatalog
        | OwnerAction::DiscoverLocalModels
        | OwnerAction::CheckModelProvider { .. } => bail!("use async control for model discovery"),
        OwnerAction::CreateAvatar { avatar } => super::avatars::create(s, request, avatar),
        OwnerAction::ReadAvatar { id } => super::avatars::read(s, &id),
        OwnerAction::DeleteAvatar { id } => super::avatars::delete(s, &id),
        OwnerAction::SetProfileAvatar {
            profile_id,
            avatar_id,
            version,
        } => super::avatars::assign(s, &profile_id, avatar_id, version),
        #[cfg(feature = "caldav")]
        OwnerAction::SavePlannerCollection {
            collection,
            version,
        } => super::planner_sync::configure(s, collection, version),
        #[cfg(feature = "caldav")]
        OwnerAction::PlannerMutation { .. } => {
            bail!("planner admission requires atomic host route")
        }
        #[cfg(feature = "caldav")]
        OwnerAction::PlannerOperationStatus {
            collection_id,
            operation_id,
        } => super::planner_sync::status(s, &operation_id, &collection_id),
        #[cfg(feature = "caldav")]
        OwnerAction::ListConnectedPlanner {
            collection_id,
            from_ms,
            to_ms,
        } => super::planner_sync::list(s, &collection_id, from_ms, to_ms),
        #[cfg(feature = "caldav")]
        OwnerAction::ReconcilePlannerEffect {
            profile_id,
            effect_key,
        } => super::planner_sync::reconcile_effect(s, &profile_id, &effect_key),
        OwnerAction::SaveTodo { id, version, todo } => {
            super::planner::save_todo(s, request, id.as_deref(), version, todo)
        }
        OwnerAction::DeleteTodo { id, version } => super::planner::delete(s, "todo", &id, version),
        OwnerAction::SaveCalendarEvent { id, version, event } => {
            super::planner::save_event(s, request, id.as_deref(), version, event)
        }
        OwnerAction::DeleteCalendarEvent { id, version } => {
            super::planner::delete(s, "calendar_event", &id, version)
        }
        OwnerAction::SaveIntegration {
            id,
            version,
            integration,
        } => {
            let result =
                super::integrations::save(s, request, id.as_deref(), version, integration)?;
            app.integrations.remove(id.as_deref().unwrap_or(request));
            Ok(result)
        }
        OwnerAction::DeleteIntegration { id, version } => {
            let result = super::planner::delete(s, "integration", &id, version)?;
            app.integrations.remove(&id);
            Ok(result)
        }
        OwnerAction::CheckIntegration { .. } => {
            bail!("connection checks require async host dispatch")
        }
        OwnerAction::CollaborationMessages {
            delegation_id,
            after,
        } => {
            let _: crate::domain::Delegation = s
                .journal
                .get("delegation", &delegation_id)?
                .ok_or_else(|| anyhow!("delegation missing"))?;
            Ok(json!(s.journal.messages(&delegation_id, after)?))
        }
        OwnerAction::CancelDelegation {
            delegation_id,
            reason,
        } => {
            text(&reason, 2048)?;
            let mut record: crate::domain::Delegation = s
                .journal
                .get("delegation", &delegation_id)?
                .ok_or_else(|| anyhow!("delegation missing"))?;
            s.journal.message(
                &record,
                &format!("cancel:{request}"),
                crate::domain::protocol::Event::CancelRequested { reason },
            )?;
            record.state = "cancelling".into();
            s.journal.put("delegation", &delegation_id, &record)?;
            super::cancel_delegation(s, &mut record)?;
            Ok(json!(record))
        }
        OwnerAction::Backup { .. } => bail!("backup requires host dispatch"),
        OwnerAction::RecoverProfile { .. } => bail!("recovery requires async host dispatch"),
        OwnerAction::CreateSpace {
            name,
            path,
            writable,
            profiles: ids,
        } => {
            text(&name, 200)?;
            profiles(s, &ids)?;
            let path = PathBuf::from(path);
            if !path.is_absolute() || path.is_symlink() {
                bail!("choose an absolute Space directory without a symlink root");
            }
            let space = Space {
                id: request.into(),
                name,
                path,
                writable,
                profiles: ids,
            };
            if writable {
                documents::initialize(&space)?;
            } else if !space.path.is_dir() {
                bail!("read-only Space directory missing");
            }
            let mut space = space;
            space.path = space.path.canonicalize()?;
            s.journal.put("space", request, &space)?;
            Ok(json!(space))
        }
        OwnerAction::SpaceAccess {
            space_id,
            writable,
            profiles: ids,
        } => {
            profiles(s, &ids)?;
            let mut space = space(s, &space_id)?;
            space.writable = writable;
            space.profiles = ids;
            if writable {
                documents::initialize(&space)?;
            }
            s.journal.put("space", &space_id, &space)?;
            Ok(json!(space))
        }
        OwnerAction::UnlinkSpace { space_id } => {
            s.journal.delete("space", &space_id)?;
            Ok(json!({"unlinked":true,"documents_preserved":true}))
        }
        OwnerAction::ImportAsset { space_id, path } => {
            documents::import_asset(&space(s, &space_id)?, std::path::Path::new(&path))
        }
        OwnerAction::ListPages { space_id, query } => {
            Ok(json!(documents::list(&space(s, &space_id)?, &query)?))
        }
        OwnerAction::ReadPage {
            space_id,
            page_id,
            locator,
        } => {
            let space = space(s, &space_id)?;
            let page = match (page_id, locator) {
                (Some(id), None) => documents::read(&space, &id)?,
                (None, Some(path)) => documents::read_source(&space, &path)?,
                _ => bail!("select one document identity or source locator"),
            };
            Ok(json!(page))
        }
        OwnerAction::SavePage {
            space_id,
            page_id,
            expected_hash,
            title,
            body,
            profile,
        } => {
            if body.len() > 524288 {
                bail!("editor body size limit");
            }
            if page_id.is_some() && expected_hash.is_none() {
                bail!("existing page requires its source hash");
            }
            let mut review = s
                .journal
                .get::<Review>("review", request)?
                .unwrap_or(Review {
                    id: request.into(),
                    profile_id: String::new(),
                    conversation_id: String::new(),
                    task_id: String::new(),
                    space_id,
                    page_id: page_id.unwrap_or_else(|| uuid::Uuid::now_v7().to_string()),
                    title,
                    body,
                    profile,
                    expected_hash,
                    created: documents::timestamp()?,
                    expires_ms: now_ms() + 86400000,
                    state: "pending".into(),
                    result: None,
                });
            save_review(s, &mut review)
        }
        OwnerAction::DecideReview { review_id, approve } => {
            let mut review: Review = s
                .journal
                .get("review", &review_id)?
                .ok_or_else(|| anyhow!("proposal missing"))?;
            if review.state == "saved" {
                return Ok(review.result.unwrap_or(Value::Null));
            }
            if !matches!(review.state.as_str(), "pending" | "approved") {
                bail!("proposal already resolved");
            }
            if approve {
                let value = save_review(s, &mut review)?;
                if !review.profile_id.is_empty() {
                    let p = s
                        .profiles
                        .get(&review.profile_id)
                        .ok_or_else(|| anyhow!("Ghost missing"))?;
                    let snapshot = p.runtime.session.snapshot()?;
                    if snapshot
                        .tasks
                        .get(&review.task_id)
                        .is_some_and(|t| t.phase == Phase::Uncertain)
                    {
                        p.runtime.session.reconcile(
                            &review.id,
                            host::durable::ToolOutput::success(
                                "Owner inspected and resumed the approved save",
                                value.clone(),
                            ),
                        )?;
                    }
                }
                Ok(value)
            } else {
                if review.state == "approved" {
                    bail!(
                        "approved save may have completed; inspect and resume it before settling"
                    );
                }
                review.state = "declined".into();
                s.journal.put("review", &review_id, &review)?;
                Ok(json!({"state":"declined"}))
            }
        }
        OwnerAction::PageChat {
            space_id,
            page_id,
            profile_id,
        } => {
            let space = space(s, &space_id)?;
            if !space.profiles.contains(&profile_id) {
                bail!("Ghost has no current Space access");
            }
            documents::read(&space, &page_id)?;
            let p = s
                .profiles
                .get(&profile_id)
                .ok_or_else(|| anyhow!("Ghost missing"))?;
            let policy: Policy = s.journal.get("policy", &profile_id)?.unwrap_or_default();
            let store = p
                .host
                .store
                .lock()
                .map_err(|_| anyhow!("profile unavailable"))?;
            let mut config = host::config(
                &store,
                Some(
                    policy
                        .model
                        .as_deref()
                        .unwrap_or(&super::models::selected_llm(s, &app.default_model)?),
                ),
                true,
            )?;
            config.tools.extend(super::services::tool_definitions(app));
            config.system_prompt.push_str(&format!("\nThis conversation is bound to page {page_id} in Space {space_id}. Before working on the page, read_page to obtain current untrusted source and hash. Propose edits with review_page; only the owner saves."));
            s.journal.put(
                "page_chat",
                request,
                &json!({"profile_id":profile_id,"space_id":space_id,"page_id":page_id}),
            )?;
            let id = p
                .runtime
                .session
                .create_conversation_with_id(request, config)?;
            Ok(json!({"conversation_id":id}))
        }
        OwnerAction::Policy { profile_id, policy } => {
            if !s.profiles.contains_key(&profile_id) {
                bail!("Ghost missing");
            }
            if !(1..=32).contains(&policy.concurrency)
                || policy.daily_requests == 0
                || policy.daily_tokens == 0
                || !policy.daily_cost_usd.is_finite()
                || policy.daily_cost_usd <= 0.0
            {
                bail!("invalid budget or concurrency");
            }
            if let Some(model) = &policy.model {
                text(model, 200)?;
            }
            s.journal.put("policy", &profile_id, &policy)?;
            Ok(json!({"policy":policy,"concurrency_applies_on_restart":true}))
        }
        OwnerAction::Persona {
            profile_id,
            persona,
        } => {
            if persona.len() > 4096 {
                bail!("persona size limit");
            }
            let p = s
                .profiles
                .get(&profile_id)
                .ok_or_else(|| anyhow!("Ghost missing"))?;
            let mut store = p
                .host
                .store
                .lock()
                .map_err(|_| anyhow!("profile unavailable"))?;
            store
                .conn
                .execute("UPDATE meta SET persona=? WHERE id=1", [&persona])?;
            store.persona = persona;
            Ok(json!({"updated":true,"applies_to_new_conversations":true}))
        }
        OwnerAction::ConversationModel {
            profile_id,
            conversation_id,
            model,
        } => super::models::select_conversation(s, &profile_id, &conversation_id, &model),
        OwnerAction::Fork {
            profile_id,
            conversation_id,
        } => {
            let p = s
                .profiles
                .get(&profile_id)
                .ok_or_else(|| anyhow!("Ghost missing"))?;
            let id = p.runtime.session.fork(&conversation_id, request)?;
            if let Some(binding) = s.journal.get::<Value>("page_chat", &conversation_id)? {
                s.journal.put("page_chat", request, &binding)?;
            }
            Ok(json!({"conversation_id":id}))
        }
        OwnerAction::Reset {
            profile_id,
            conversation_id,
        } => {
            let p = s
                .profiles
                .get(&profile_id)
                .ok_or_else(|| anyhow!("Ghost missing"))?;
            p.runtime.session.reset_context(&conversation_id)?;
            Ok(json!({"reset":true,"source_preserved":true}))
        }
        OwnerAction::History {
            profile_id,
            conversation_id,
            before_revision,
        } => {
            let p = s
                .profiles
                .get(&profile_id)
                .ok_or_else(|| anyhow!("Ghost missing"))?;
            let snapshot = p.runtime.session.snapshot()?;
            let c = snapshot
                .conversations
                .get(&conversation_id)
                .ok_or_else(|| anyhow!("conversation missing"))?;
            let mut entries = c
                .entries
                .iter()
                .rev()
                .filter(|e| e.revision < before_revision)
                .take(200)
                .collect::<Vec<_>>();
            entries.reverse();
            Ok(json!(entries))
        }
        OwnerAction::DeleteSchedule { schedule_id } => {
            s.journal
                .0
                .execute("DELETE FROM schedules WHERE id=?", [schedule_id])?;
            Ok(json!({"deleted":true}))
        }
        OwnerAction::Goal {
            profile_id,
            title,
            criteria,
            instruction,
            dependencies,
            event,
        } => {
            if !s.profiles.contains_key(&profile_id) {
                bail!("Ghost missing");
            }
            text(&title, 200)?;
            text(&criteria, 4096)?;
            text(&instruction, 8192)?;
            if dependencies.len() > 32 {
                bail!("dependency limit");
            }
            for id in &dependencies {
                let _: Goal = s
                    .journal
                    .get("goal", id)?
                    .ok_or_else(|| anyhow!("dependency missing"))?;
            }
            if let Some(name) = &event {
                text(name, 200)?;
            }
            let goal = Goal {
                id: request.into(),
                profile_id,
                title,
                criteria,
                instruction,
                state: "ready".into(),
                dependencies,
                event,
                task_id: None,
                evidence: vec![],
                note: String::new(),
                run: 0,
                created_ms: now_ms(),
                last_event_ms: 0,
            };
            s.journal.put("goal", request, &goal)?;
            Ok(json!(goal))
        }
        OwnerAction::GoalState {
            goal_id,
            state,
            evidence,
        } => {
            let mut goal: Goal = s
                .journal
                .get("goal", &goal_id)?
                .ok_or_else(|| anyhow!("responsibility missing"))?;
            if !matches!(
                state.as_str(),
                "paused" | "ready" | "complete" | "cancelled"
            ) {
                bail!("invalid responsibility state");
            }
            if state == "complete" && evidence.is_empty() {
                bail!("owner completion requires verification evidence");
            }
            if evidence.len() > 32 || evidence.iter().any(|v| v.len() > 4096) {
                bail!("evidence limit");
            }
            if let Some(task) = &goal.task_id {
                if matches!(
                    state.as_str(),
                    "paused" | "cancelled" | "complete" | "ready"
                ) {
                    s.profiles
                        .get(&goal.profile_id)
                        .ok_or_else(|| anyhow!("Ghost missing"))?
                        .runtime
                        .session
                        .cancel(task)?;
                }
            }
            if let Some(task) = &goal.task_id {
                if state == "ready" {
                    let snapshot = s
                        .profiles
                        .get(&goal.profile_id)
                        .ok_or_else(|| anyhow!("Ghost missing"))?
                        .runtime
                        .session
                        .committed()?;
                    if snapshot.tasks.get(task).is_some_and(|root| {
                        snapshot.effects.values().any(|effect| {
                            effect.phase == Phase::Uncertain
                                && snapshot
                                    .tasks
                                    .get(&effect.task_id)
                                    .is_some_and(|t| t.conversation_id == root.conversation_id)
                        })
                    }) {
                        bail!("inspect and reconcile uncertain effects before another responsibility run");
                    }
                }
            }
            if state == "ready" {
                goal.task_id = None;
                goal.run += 1;
            }
            goal.state = state;
            goal.evidence = evidence;
            s.journal.put("goal", &goal_id, &goal)?;
            Ok(json!(goal))
        }
        OwnerAction::Event { profile_id, name } => {
            if !s.profiles.contains_key(&profile_id) {
                bail!("Ghost missing");
            }
            text(&name, 200)?;
            s.journal.put(
                "event",
                request,
                &json!({"id":request,"profile_id":profile_id,"name":name,"created_ms":now_ms()}),
            )?;
            Ok(json!({"event_id":request}))
        }
        OwnerAction::Receipts => {
            let mut stmt = s.journal.0.prepare(
                "SELECT id,payload FROM workspace_commands WHERE response IS NULL AND id != ? ORDER BY rowid",
            )?;
            let rows=stmt.query_map([request],|r|Ok(json!({"id":r.get::<_,String>(0)?,"command":serde_json::from_str::<Value>(&r.get::<_,String>(1)?).unwrap_or(Value::Null)})))?;
            Ok(json!(rows.collect::<std::result::Result<Vec<_>, _>>()?))
        }
        OwnerAction::DismissReceipt { receipt_id, note } => {
            text(&note, 2048)?;
            s.journal.finish(&receipt_id,&json!({"ok":false,"error":"owner inspected interrupted command","owner_note":note}))?;
            Ok(json!({"resolved":true}))
        }
        OwnerAction::SlackBinding { mut binding } => {
            if !s.profiles.contains_key(&binding.profile_id) {
                bail!("bound Ghost missing");
            }
            text(&binding.team, 100)?;
            text(&binding.channel, 100)?;
            if binding.users.is_empty() || binding.users.len() > 64 {
                bail!("provide an explicit Slack user allowlist");
            }
            for user in &binding.users {
                text(user, 100)?;
            }
            if binding.id.is_empty() {
                binding.id = request.into();
            } else {
                uuid::Uuid::parse_str(&binding.id)?;
            }
            s.journal.put("slack_binding", &binding.id, &binding)?;
            Ok(json!(binding))
        }
        OwnerAction::SlackReceipt {
            outbox_id,
            state,
            note,
        } => {
            text(&note, 2048)?;
            let mut outbox: channels::Outbox = s
                .journal
                .get("slack_outbox", &outbox_id)?
                .ok_or_else(|| anyhow!("outbox missing"))?;
            if !matches!(outbox.state.as_str(), "sending" | "uncertain" | "pending") {
                bail!("outbox already settled");
            }
            if !matches!(state.as_str(), "sent" | "declined") {
                bail!("choose a definitive send result after inspecting Slack");
            }
            outbox.state = state;
            outbox.receipt = Some(json!({"owner_note":note}));
            s.journal.put("slack_outbox", &outbox_id, &outbox)?;
            Ok(json!(outbox))
        }
        OwnerAction::VoiceEvent {
            call_id,
            event_id,
            role,
            transcript,
        } => {
            text(&event_id, 200)?;
            text(&transcript, 32768)?;
            if !matches!(role.as_str(), "user" | "assistant") {
                bail!("invalid transcript role");
            }
            let call: channels::Call = s
                .journal
                .get("voice_call", &call_id)?
                .ok_or_else(|| anyhow!("voice call missing"))?;
            if call.state != "active" {
                bail!("voice call is not active");
            }
            s.profiles
                .get(&call.profile_id)
                .ok_or_else(|| anyhow!("Ghost missing"))?
                .runtime
                .session
                .observe(
                    &call.conversation_id,
                    &format!(
                        "voice:{}:{}",
                        call_id,
                        documents::digest(event_id.as_bytes())
                    ),
                    &format!("voice_{role}"),
                    &transcript,
                )?;
            Ok(json!({"stored":true}))
        }
        OwnerAction::VoiceWork {
            call_id,
            function_id,
            prompt,
        } => {
            text(&function_id, 100)?;
            text(&prompt, 8192)?;
            let call: channels::Call = s
                .journal
                .get("voice_call", &call_id)?
                .ok_or_else(|| anyhow!("voice call missing"))?;
            if call.state != "active" || call.expires_ms <= now_ms() {
                bail!("voice call inactive or expired");
            }
            let p = s
                .profiles
                .get(&call.profile_id)
                .ok_or_else(|| anyhow!("Ghost missing"))?;
            let policy: Policy = s
                .journal
                .get("policy", &call.profile_id)?
                .unwrap_or_default();
            if !policy.voice {
                bail!("voice permission revoked");
            }
            super::models::prepare_conversation(
                s,
                &call.profile_id,
                &call.conversation_id,
                host::durable::InputKind::FollowUp,
            )?;
            let input = p.runtime.session.submit(
                &call.conversation_id,
                &format!(
                    "voice:{}:{}",
                    call_id,
                    documents::digest(function_id.as_bytes())
                ),
                host::durable::InputKind::FollowUp,
                &prompt,
            )?;
            Ok(json!(input))
        }
        OwnerAction::ResolveVoice { call_id, note } => {
            text(&note, 2048)?;
            let mut call: channels::Call = s
                .journal
                .get("voice_call", &call_id)?
                .ok_or_else(|| anyhow!("voice call missing"))?;
            if !matches!(call.state.as_str(), "starting" | "uncertain") {
                bail!("only an uncertain call needs manual reconciliation");
            }
            call.state = "ended".into();
            s.journal.put("voice_call", &call_id, &call)?;
            s.journal.put(
                "voice_reconciliation",
                &call_id,
                &json!({"owner_note":note}),
            )?;
            Ok(json!(call))
        }
        OwnerAction::Computer { .. }
        | OwnerAction::VoiceStart { .. }
        | OwnerAction::VoiceEnd { .. }
        | OwnerAction::SendSlack { .. } => bail!("channel command requires async dispatch"),
    }
}
