use super::{routing_dispatch::*, services::Bridge, work_routing::*, Host};
use crate::durable as host;
use crate::{
    control::api::RoutingEntry,
    durable::durable::{
        self, ai, AgentConfig, Host as DurableHost, HostFuture, Phase, Runtime, SingleProvider,
        Task, ToolOutput, ToolPlan, ToolStatus,
    },
    store::ProfileStore,
};
use serde_json::json;
use std::sync::Arc;
use std::{
    future::Future,
    pin::Pin,
    sync::atomic::{AtomicUsize, Ordering},
};

struct Once {
    call: Option<ai::ToolCall>,
    turns: AtomicUsize,
}
impl ai::Provider for Once {
    fn stream<'a>(
        &'a self,
        model: &'a ai::Model,
        _: &'a ai::Context,
        _: Option<ai::StreamOptions>,
    ) -> Pin<Box<dyn Future<Output = ai::prelude::StreamResult> + Send + 'a>> {
        Box::pin(async move {
            let mut message = ai::AssistantMessage::new(model.api, &model.provider, &model.id);
            if self.turns.fetch_add(1, Ordering::SeqCst) == 0 && self.call.is_some() {
                message
                    .content
                    .push(ai::ContentBlock::ToolCall(self.call.clone().unwrap()));
            } else {
                message
                    .content
                    .push(ai::ContentBlock::Text(ai::TextContent::new(
                        "All done, externally successful",
                    )));
            }
            Ok(Box::pin(futures::stream::iter([ai::ProviderEvent::Done {
                reason: ai::StopReason::Stop,
                message,
            }]))
                as Pin<
                    Box<dyn futures::Stream<Item = ai::ProviderEvent> + Send>,
                >)
        })
    }
}
struct CrashAfterEffect {
    inner: Arc<host::GhostHost>,
    reached: Arc<tokio::sync::Notify>,
}
impl DurableHost for CrashAfterEffect {
    fn admit_tool(&self, t: &Task, c: &ai::ToolCall) -> durable::Result<()> {
        self.inner.admit_tool(t, c)
    }
    fn admit_model(&self, t: &Task, c: &AgentConfig) -> durable::Result<()> {
        self.inner.admit_model(t, c)
    }
    fn prepare(&self, t: &Task, c: &ai::ToolCall) -> durable::Result<ToolPlan> {
        self.inner.prepare(t, c)
    }
    fn execute<'a>(
        &'a self,
        t: &'a Task,
        c: &'a ai::ToolCall,
        p: &'a ToolPlan,
    ) -> HostFuture<'a, ToolOutput> {
        Box::pin(async move {
            let _output = self.inner.execute(t, c, p).await?;
            self.reached.notify_one();
            std::future::pending().await
        })
    }
}
fn key() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn fixture(
    root: &std::path::Path,
    call: Option<ai::ToolCall>,
    crash: bool,
) -> (Arc<Host>, RoutingEntry, Arc<tokio::sync::Notify>) {
    let app = Host::open(root, tokio::runtime::Handle::current(), Some("mock")).unwrap();
    for worker in app.workers.lock().unwrap().iter() {
        worker.abort();
    }
    let mut p =
        Host::profile(ProfileStore::create_profile(root, "fixture", "synthetic routing").unwrap())
            .unwrap();
    let id = p.id.clone();
    p.host
        .install_services(Arc::new(Bridge {
            owner: id.clone(),
            host: Arc::downgrade(&app),
        }))
        .unwrap();
    p.host
        .install_file_fence(Arc::new(Bridge {
            owner: p.id.clone(),
            host: Arc::downgrade(&app),
        }))
        .unwrap();
    let reached = Arc::new(tokio::sync::Notify::new());
    let executor: Arc<dyn DurableHost> = if crash {
        Arc::new(CrashAfterEffect {
            inner: p.host.clone(),
            reached: reached.clone(),
        })
    } else {
        p.host.clone()
    };
    p.runtime = Runtime::new(
        p.runtime.session.clone(),
        Arc::new(SingleProvider(Arc::new(Once {
            call,
            turns: AtomicUsize::new(0),
        }))),
        executor,
    );
    let convo = p
        .runtime
        .session
        .create_conversation(
            host::config(&p.host.store.lock().unwrap(), Some("mock"), false).unwrap(),
        )
        .unwrap();
    app.lock().unwrap().profiles.insert(id.clone(), p);
    (
        app,
        RoutingEntry {
            profile_id: id,
            conversation_id: convo,
        },
        reached,
    )
}
fn admit(app: &Arc<Host>, entry: &RoutingEntry, text: &str, op: Operation) -> Admission {
    let action = json!({"request_id":key(),"command":{"type":"routing","action":{"type":"routing_admit","entry":entry,"text":text,
        "segments":[{"id":"s1","start_byte":0,"end_byte":text.len()}],"proposal":{"schema":PROPOSAL_SCHEMA,"items":[{"segment_id":"s1","operation":op}]}}}});
    let reply = app.action(serde_json::from_value(action).unwrap()).unwrap();
    assert_eq!(reply["ok"], true, "{reply}");
    serde_json::from_value(reply["result"].clone()).unwrap()
}
fn new_work(app: &Arc<Host>, entry: &RoutingEntry) -> Work {
    let a = admit(
        app,
        entry,
        "Do this durable task",
        Operation::New {
            title: "durable task".into(),
            scope: "Save one fixture todo".into(),
            responsible_profile_id: entry.profile_id.clone(),
            dependencies: vec![],
        },
    );
    app.lock()
        .unwrap()
        .journal
        .get("routing_work_v2", a.items[0].work_id.as_ref().unwrap())
        .unwrap()
        .unwrap()
}
fn execution(app: &Arc<Host>, w: &Work) -> Binding {
    app.lock()
        .unwrap()
        .journal
        .objects::<Binding>(BINDINGS)
        .unwrap()
        .into_iter()
        .find(|b| b.work_id == w.id && b.work_revision == w.work_revision)
        .unwrap()
}
fn runtime(app: &Arc<Host>, entry: &RoutingEntry) -> Runtime {
    app.lock().unwrap().profiles[&entry.profile_id]
        .runtime
        .clone()
}
fn result_row(app: &Arc<Host>, id: &str) -> ExecutionResult {
    app.lock()
        .unwrap()
        .journal
        .get(RESULTS, id)
        .unwrap()
        .unwrap()
}

struct StandaloneText;
impl ai::Provider for StandaloneText {
    fn stream<'a>(
        &'a self,
        model: &'a ai::Model,
        context: &'a ai::Context,
        _: Option<ai::StreamOptions>,
    ) -> Pin<Box<dyn Future<Output = ai::prelude::StreamResult> + Send + 'a>> {
        Box::pin(async move {
            // Inspect the actual SDK model context, not only a catalog helper.
            assert!(!context
                .tools
                .iter()
                .any(|tool| matches!(tool.name.as_str(), "report_delegation" | "report_goal")));
            let mut message = ai::AssistantMessage::new(model.api, &model.provider, &model.id);
            message
                .content
                .push(ai::ContentBlock::Text(ai::TextContent::new(
                    "Synthetic standalone final result",
                )));
            Ok(Box::pin(futures::stream::iter([ai::ProviderEvent::Done {
                reason: ai::StopReason::Stop,
                message,
            }]))
                as Pin<
                    Box<dyn futures::Stream<Item = ai::ProviderEvent> + Send>,
                >)
        })
    }
}

#[tokio::test]
async fn standalone_work_three_revisions_close_without_assignment_reports_and_migrate_idle_legacy_config(
) {
    let dir = tempfile::tempdir().unwrap();
    let (app, entry, _) = fixture(dir.path(), None, false);
    {
        let mut state = app.lock().unwrap();
        let profile = state.profiles.get_mut(&entry.profile_id).unwrap();
        profile.runtime = Runtime::new(
            profile.runtime.session.clone(),
            Arc::new(SingleProvider(Arc::new(StandaloneText))),
            profile.host.clone(),
        );
    }
    let mut work = new_work(&app, &entry);
    let runtime = runtime(&app, &entry);
    let mut conversation = None;
    for revision in 1..=3 {
        if revision > 1 {
            admit(
                &app,
                &entry,
                "Amend this same standalone work",
                Operation::Amend {
                    target: work.target(),
                    scope: format!("Synthetic revision {revision}"),
                },
            );
            work = app
                .lock()
                .unwrap()
                .journal
                .get("routing_work_v2", &work.id)
                .unwrap()
                .unwrap();
        }
        pump(&app).unwrap();
        let binding = execution(&app, &work);
        if let Some(id) = &conversation {
            assert_eq!(&binding.conversation_id, id);
        } else {
            conversation = Some(binding.conversation_id.clone());
        }
        runtime.drive(64).await.unwrap();
        pump(&app).unwrap();
        let result = result_row(&app, &binding.id);
        assert_eq!(result.status, "finished_unverified");
        assert_eq!(
            result.model_output.as_deref(),
            Some("Synthetic standalone final result")
        );
        assert!(!result.verified);
        assert!(result.receipts.is_empty());
        if revision == 1 {
            // Simulate an idle Work conversation saved by the previous release.
            let mut config = runtime.session.committed().unwrap().conversations
                [&binding.conversation_id]
                .config
                .clone();
            for tool in super::services::role_tool_definitions(
                &app,
                super::services::ToolRole::AssignedDelegation,
            ) {
                if !config
                    .tools
                    .iter()
                    .any(|existing| existing.name == tool.name)
                {
                    config.tools.push(tool);
                }
            }
            runtime
                .session
                .set_config(&binding.conversation_id, config)
                .unwrap();
        }
    }
    drop(runtime);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn one_work_conversation_binding_retry_amend_cancel_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (app, e, _) = fixture(dir.path(), None, false);
    let mut w = new_work(&app, &e);
    pump(&app).unwrap();
    let first = execution(&app, &w);
    let session = runtime(&app, &e).session;
    // Emulate losing the root task-id acknowledgement after SDK commit. Exact
    // committed request ID recovers the original task, without another input.
    let mut lost = first.clone();
    lost.task_id = None;
    app.lock()
        .unwrap()
        .journal
        .put(BINDINGS, &lost.id, &lost)
        .unwrap();
    pump(&app).unwrap();
    assert_eq!(execution(&app, &w).task_id, first.task_id);
    assert_eq!(
        session
            .committed()
            .unwrap()
            .submissions
            .iter()
            .filter(|s| s.conversation_id == first.conversation_id)
            .count(),
        1
    );
    let old = session.committed().unwrap().tasks[first.task_id.as_ref().unwrap()].clone();
    assert!(fence(&app.lock().unwrap(), &e.profile_id, &old)
        .unwrap()
        .is_some());
    admit(
        &app,
        &e,
        "Change scope",
        Operation::Amend {
            target: w.target(),
            scope: "Changed authoritative scope".into(),
        },
    );
    w = app
        .lock()
        .unwrap()
        .journal
        .get("routing_work_v2", &w.id)
        .unwrap()
        .unwrap();
    assert!(fence(&app.lock().unwrap(), &e.profile_id, &old).is_err());
    pump(&app).unwrap();
    let second = execution(&app, &w);
    assert_eq!(second.conversation_id, first.conversation_id);
    assert_ne!(second.task_id, first.task_id);
    assert_eq!(
        session.committed().unwrap().tasks[old.id.as_str()].phase,
        Phase::Cancelled
    );
    assert_eq!(result_row(&app, &first.id).status, "superseded");
    admit(
        &app,
        &e,
        "Continue this",
        Operation::Continue { target: w.target() },
    );
    let previous_decision = w.decision_revision;
    w = app
        .lock()
        .unwrap()
        .journal
        .get("routing_work_v2", &w.id)
        .unwrap()
        .unwrap();
    assert_eq!(w.decision_revision, previous_decision);
    pump(&app).unwrap();
    let continued = execution(&app, &w);
    assert_eq!(continued.conversation_id, first.conversation_id);
    assert_ne!(continued.task_id, second.task_id);
    admit(
        &app,
        &e,
        "Stop now",
        Operation::Cancel { target: w.target() },
    );
    pump(&app).unwrap();
    pump(&app).unwrap();
    assert_eq!(
        session
            .committed()
            .unwrap()
            .submissions
            .iter()
            .filter(|s| s.conversation_id == first.conversation_id)
            .count(),
        3
    );
    let reports = owner_results(&app.lock().unwrap()).unwrap();
    assert!(reports["results"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["verified"] == false));
    drop(session);
    app.shutdown().await.unwrap();
    drop(app);
    let reopened = Host::open(dir.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    pump(&reopened).unwrap();
    let state = reopened.lock().unwrap();
    assert_eq!(
        state.profiles[&e.profile_id]
            .runtime
            .session
            .committed()
            .unwrap()
            .submissions
            .iter()
            .filter(|s| s.conversation_id == first.conversation_id)
            .count(),
        3
    );
    assert!(!owner_results(&state).unwrap()["completion_outbox"]
        .as_array()
        .unwrap()
        .is_empty());
    drop(state);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn model_prose_never_verifies_external_success_but_actual_receipts_do() {
    for tool in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let call = tool.then(|| {
            ai::ToolCall::new(
                "todo",
                "save_todo",
                json!({"todo":{"title":"Actual durable receipt"}}),
            )
        });
        let (app, e, _) = fixture(dir.path(), call, false);
        let w = new_work(&app, &e);
        pump(&app).unwrap();
        let b = execution(&app, &w);
        let runtime = runtime(&app, &e);
        runtime.drive(64).await.unwrap();
        pump(&app).unwrap();
        let r = result_row(&app, &b.id);
        assert_eq!(
            r.status,
            if tool {
                "finished_verified"
            } else {
                "finished_unverified"
            }
        );
        assert_eq!(r.verified, tool);
        if tool {
            assert_eq!(
                r.receipts[0].output.as_ref().unwrap().status,
                ToolStatus::Success
            );
            assert_eq!(
                app.snapshot().unwrap()["todos"][0]["title"],
                "Actual durable receipt"
            );
        }
        admit(
            &app,
            &e,
            "Changed",
            Operation::Amend {
                target: w.target(),
                scope: "New scope".into(),
            },
        );
        let projected = owner_results(&app.lock().unwrap()).unwrap();
        let previous = projected["results"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == b.id)
            .unwrap();
        assert_eq!(previous["current"], false);
        assert_eq!(previous["verified"], false);
        drop(runtime);
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn process_loss_after_nonreplayable_effect_requires_reconciliation() {
    let dir = tempfile::tempdir().unwrap();
    let (app, e, reached) = fixture(
        dir.path(),
        Some(ai::ToolCall::new(
            "todo",
            "save_todo",
            json!({"todo":{"title":"Applied exactly once"}}),
        )),
        true,
    );
    let w = new_work(&app, &e);
    pump(&app).unwrap();
    let b = execution(&app, &w);
    let r = runtime(&app, &e);
    let driving = tokio::spawn(async move { r.drive(64).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), reached.notified())
        .await
        .unwrap();
    assert_eq!(
        app.snapshot().unwrap()["todos"].as_array().unwrap().len(),
        1
    );
    driving.abort();
    let _ = driving.await;
    app.shutdown().await.unwrap();
    drop(app);
    let reopened = Host::open(dir.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    for worker in reopened.workers.lock().unwrap().iter() {
        worker.abort();
    }
    pump(&reopened).unwrap();
    assert_eq!(result_row(&reopened, &b.id).status, "uncertain");
    let evidence: Vec<serde_json::Value> = reopened
        .lock()
        .unwrap()
        .journal
        .objects(EFFECT_EVIDENCE)
        .unwrap();
    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0]["observation"]["work_id"], w.id);
    assert_eq!(
        evidence[0]["observation"]["output"]["content"]["title"],
        "Applied exactly once"
    );
    let r = runtime(&reopened, &e);
    r.drive(64).await.unwrap();
    pump(&reopened).unwrap();
    assert_eq!(
        reopened.snapshot().unwrap()["todos"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(result_row(&reopened, &b.id).status, "uncertain");
    admit(
        &reopened,
        &e,
        "Amend uncertain task",
        Operation::Amend {
            target: w.target(),
            scope: "Changed scope".into(),
        },
    );
    pump(&reopened).unwrap();
    let state = reopened.lock().unwrap();
    let bindings: Vec<Binding> = state.journal.objects(BINDINGS).unwrap();
    assert!(bindings
        .iter()
        .find(|x| x.work_revision == 2)
        .unwrap()
        .task_id
        .is_none());
    drop(state);
    drop(r);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn final_effect_guard_pins_revision_and_rejects_forged_identity() {
    let dir = tempfile::tempdir().unwrap();
    let (app, e, _) = fixture(dir.path(), None, false);
    let w = new_work(&app, &e);
    pump(&app).unwrap();
    let b = execution(&app, &w);
    let snap = runtime(&app, &e).session.committed().unwrap();
    let task = snap.tasks[b.task_id.as_ref().unwrap()].clone();
    let mut forged = task.clone();
    forged.ordinal += 1;
    assert!(fence(&app.lock().unwrap(), &e.profile_id, &forged).is_err());
    let guard = effect_guard(&app, &e.profile_id, &task).unwrap();
    let other = app.clone();
    let probe = std::thread::spawn(move || other.state.try_lock().is_err())
        .join()
        .unwrap();
    assert!(probe);
    assert_eq!(
        guard
            .state()
            .journal
            .get::<Work>("routing_work_v2", &w.id)
            .unwrap()
            .unwrap()
            .work_revision,
        1
    );
    drop(guard);
    admit(
        &app,
        &e,
        "Amend",
        Operation::Amend {
            target: w.target(),
            scope: "Revised".into(),
        },
    );
    assert!(effect_guard(&app, &e.profile_id, &task).is_err());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn actual_file_artifact_hash_current_content_and_revoked_grant_control_promotion() {
    let dir = tempfile::tempdir().unwrap();
    let artifacts = tempfile::tempdir().unwrap();
    let path = artifacts.path().join("result.txt");
    let call = ai::ToolCall::new(
        "file",
        "write_file",
        json!({"path":path,"content":"reviewable artifact"}),
    );
    let (app, e, _) = fixture(dir.path(), Some(call), false);
    let grant = {
        let state = app.lock().unwrap();
        let store = state.profiles[&e.profile_id].host.store.lock().unwrap();
        store.allow(artifacts.path(), "write").unwrap()
    };
    let w = new_work(&app, &e);
    pump(&app).unwrap();
    let b = execution(&app, &w);
    let r = runtime(&app, &e);
    r.drive(64).await.unwrap();
    pump(&app).unwrap();
    let report = result_row(&app, &b.id);
    assert_eq!(report.status, "finished_verified");
    assert!(report.verified);
    assert_eq!(report.receipts[0].verification["kind"], "file_content");
    assert_eq!(
        report.receipts[0].verification["sha256"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    let original_evidence: Vec<serde_json::Value> =
        app.lock().unwrap().journal.objects(EVIDENCE).unwrap();
    let verified_evidence = original_evidence
        .iter()
        .find(|row| row["observation"]["verified"] == true)
        .unwrap()
        .clone();
    let observed_hash =
        verified_evidence["observation"]["receipts"][0]["verification"]["sha256"].clone();
    let effect_evidence: Vec<serde_json::Value> = app
        .lock()
        .unwrap()
        .journal
        .objects(EFFECT_EVIDENCE)
        .unwrap();
    assert_eq!(effect_evidence.len(), 1);
    assert_eq!(
        effect_evidence[0]["observation"]["output"]["content"]["path"],
        json!(path.canonicalize().unwrap())
    );
    std::fs::write(&path, "artifact changed").unwrap();
    pump(&app).unwrap();
    let history: Vec<serde_json::Value> = app.lock().unwrap().journal.objects(EVIDENCE).unwrap();
    assert!(history.contains(&verified_evidence));
    assert_eq!(
        verified_evidence["observation"]["receipts"][0]["verification"]["sha256"],
        observed_hash
    );
    assert_eq!(
        owner_results(&app.lock().unwrap()).unwrap()["results"][0]["verified"],
        false
    );
    std::fs::write(&path, "reviewable artifact").unwrap();
    pump(&app).unwrap();
    assert_eq!(
        owner_results(&app.lock().unwrap()).unwrap()["results"][0]["verified"],
        true
    );
    {
        let state = app.lock().unwrap();
        state.profiles[&e.profile_id]
            .host
            .store
            .lock()
            .unwrap()
            .revoke(grant.id)
            .unwrap();
    }
    assert_eq!(
        owner_results(&app.lock().unwrap()).unwrap()["results"][0]["verified"],
        false
    );
    drop(r);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn assigned_worker_does_not_receive_original_text_and_source_policy_revocation_fences_it() {
    let dir = tempfile::tempdir().unwrap();
    let (app, e, _) = fixture(dir.path(), None, false);
    let mut p = Host::profile(
        ProfileStore::create_profile(dir.path(), "specialist", "synthetic specialist").unwrap(),
    )
    .unwrap();
    let specialist = p.id.clone();
    p.host
        .install_services(Arc::new(Bridge {
            owner: specialist.clone(),
            host: Arc::downgrade(&app),
        }))
        .unwrap();
    p.runtime = Runtime::new(
        p.runtime.session.clone(),
        Arc::new(SingleProvider(Arc::new(Once {
            call: None,
            turns: AtomicUsize::new(0),
        }))),
        p.host.clone(),
    );
    app.lock().unwrap().profiles.insert(specialist.clone(), p);
    let admission = admit(
        &app,
        &e,
        "PRIVATE_TRANSCRIPT_MARKER",
        Operation::New {
            title: "Assigned".into(),
            scope: "Owner approved shared scope".into(),
            responsible_profile_id: specialist.clone(),
            dependencies: vec![],
        },
    );
    let w: Work = app
        .lock()
        .unwrap()
        .journal
        .get(
            "routing_work_v2",
            admission.items[0].work_id.as_ref().unwrap(),
        )
        .unwrap()
        .unwrap();
    pump(&app).unwrap();
    let b = execution(&app, &w);
    assert!(!b.prompt.contains("PRIVATE_TRANSCRIPT_MARKER"));
    let task = app.lock().unwrap().profiles[&specialist]
        .runtime
        .session
        .committed()
        .unwrap()
        .tasks[b.task_id.as_ref().unwrap()]
    .clone();
    assert!(fence(&app.lock().unwrap(), &specialist, &task).is_ok());
    let mut policy = crate::domain::Policy::default();
    policy.delegation = false;
    app.lock()
        .unwrap()
        .journal
        .put("policy", &e.profile_id, &policy)
        .unwrap();
    assert!(fence(&app.lock().unwrap(), &specialist, &task).is_err());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn amendment_between_model_and_tool_execution_denies_old_effect_before_pump() {
    let dir = tempfile::tempdir().unwrap();
    let (app, e, _) = fixture(
        dir.path(),
        Some(ai::ToolCall::new(
            "todo",
            "save_todo",
            json!({"todo":{"title":"Must never be applied"}}),
        )),
        false,
    );
    let w = new_work(&app, &e);
    pump(&app).unwrap();
    let b = execution(&app, &w);
    let r = runtime(&app, &e);
    r.drive(2).await.unwrap();
    let snap = r.session.committed().unwrap();
    assert!(snap
        .tasks
        .values()
        .any(|task| matches!(task.kind, host::durable::TaskKind::Tool { .. })));
    assert!(snap.effects.is_empty());
    admit(
        &app,
        &e,
        "New scope before tool",
        Operation::Amend {
            target: w.target(),
            scope: "Do no local mutation".into(),
        },
    );
    // Do not pump/cancel the old SDK task first: current root Work itself is the
    // admission boundary and must fence stale effects immediately.
    let _ = r.drive(64).await;
    assert!(app.snapshot().unwrap()["todos"]
        .as_array()
        .unwrap()
        .is_empty());
    pump(&app).unwrap();
    assert_eq!(result_row(&app, &b.id).status, "superseded");
    drop(r);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn read_only_receipt_and_model_done_claim_cannot_verify_requested_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let (app, e, _) = fixture(
        dir.path(),
        Some(ai::ToolCall::new("list", "list_todos", json!({}))),
        false,
    );
    let w = new_work(&app, &e);
    pump(&app).unwrap();
    let b = execution(&app, &w);
    let r = runtime(&app, &e);
    r.drive(64).await.unwrap();
    pump(&app).unwrap();
    let report = result_row(&app, &b.id);
    assert!(report.receipts[0].verified);
    assert_eq!(report.status, "finished_unverified");
    assert!(!report.verified);
    drop(r);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn committed_background_sdk_child_outlives_root_but_never_its_work_revision() {
    let dir = tempfile::tempdir().unwrap();
    let (app, e, _) = fixture(dir.path(), None, false);
    let w = new_work(&app, &e);
    pump(&app).unwrap();
    let b = execution(&app, &w);
    let r = runtime(&app, &e);
    let config = r.session.committed().unwrap().conversations[&b.conversation_id]
        .config
        .clone();
    let child = r
        .session
        .spawn(
            b.task_id.as_ref().unwrap(),
            "owned-background",
            config,
            "background scope",
            true,
        )
        .unwrap();
    r.drive(2).await.unwrap();
    let snap = r.session.committed().unwrap();
    let task = snap.tasks[&child.task_id].clone();
    assert_eq!(
        snap.tasks[b.task_id.as_ref().unwrap()].phase,
        Phase::Complete
    );
    assert!(!task.phase.terminal());
    assert!(fence(&app.lock().unwrap(), &e.profile_id, &task)
        .unwrap()
        .is_some());
    assert!(fence_current(
        &app.lock().unwrap(),
        &e.profile_id,
        &snap.tasks[b.task_id.as_ref().unwrap()]
    )
    .is_ok());
    assert!(fence(
        &app.lock().unwrap(),
        &e.profile_id,
        &snap.tasks[b.task_id.as_ref().unwrap()]
    )
    .is_err());
    pump(&app).unwrap();
    assert_eq!(result_row(&app, &b.id).status, "running");
    admit(
        &app,
        &e,
        "Amend background",
        Operation::Amend {
            target: w.target(),
            scope: "New background scope".into(),
        },
    );
    assert!(fence(&app.lock().unwrap(), &e.profile_id, &task).is_err());
    drop(r);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn cross_profile_background_uncertainty_blocks_amend_and_survives_cancellation_report() {
    let dir = tempfile::tempdir().unwrap();
    let (app, e, _) = fixture(dir.path(), None, false);
    let mut p = Host::profile(
        ProfileStore::create_profile(dir.path(), "target", "synthetic background").unwrap(),
    )
    .unwrap();
    let target = p.id.clone();
    p.host
        .install_file_fence(Arc::new(Bridge {
            owner: p.id.clone(),
            host: Arc::downgrade(&app),
        }))
        .unwrap();
    let reached = Arc::new(tokio::sync::Notify::new());
    p.host
        .install_services(Arc::new(Bridge {
            owner: target.clone(),
            host: Arc::downgrade(&app),
        }))
        .unwrap();
    p.runtime = Runtime::new(
        p.runtime.session.clone(),
        Arc::new(SingleProvider(Arc::new(Once {
            call: Some(ai::ToolCall::new(
                "target-todo",
                "save_todo",
                json!({"todo":{"title":"Specialist applied once"}}),
            )),
            turns: AtomicUsize::new(0),
        }))),
        Arc::new(CrashAfterEffect {
            inner: p.host.clone(),
            reached: reached.clone(),
        }),
    );
    {
        let mut state = app.lock().unwrap();
        state.profiles.insert(target.clone(), p);
        let source = state.profiles.get_mut(&e.profile_id).unwrap();
        source.runtime = Runtime::new(
            source.runtime.session.clone(),
            Arc::new(SingleProvider(Arc::new(Once {
                call: Some(ai::ToolCall::new(
                    "delegate",
                    "delegate_ghost",
                    json!({"profile_id":target,"prompt":"Save the shared fixture","background":true}),
                )),
                turns: AtomicUsize::new(0),
            }))),
            source.host.clone(),
        );
    }
    let mut w = new_work(&app, &e);
    pump(&app).unwrap();
    let b = execution(&app, &w);
    let source = runtime(&app, &e);
    source.drive(64).await.unwrap();
    pump(&app).unwrap();
    assert_eq!(result_row(&app, &b.id).status, "running");
    let target_runtime = app.lock().unwrap().profiles[&target].runtime.clone();
    let drive_runtime = target_runtime.clone();
    let driving = tokio::spawn(async move { drive_runtime.drive(64).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), reached.notified())
        .await
        .unwrap();
    driving.abort();
    let _ = driving.await;
    target_runtime.session.reload_committed().unwrap();
    pump(&app).unwrap();
    let report = result_row(&app, &b.id);
    assert_eq!(report.status, "uncertain");
    let host_evidence: Vec<serde_json::Value> = app
        .lock()
        .unwrap()
        .journal
        .objects(EFFECT_EVIDENCE)
        .unwrap();
    assert!(host_evidence
        .iter()
        .any(|row| row["observation"]["profile_id"] == target
            && row["observation"]["work_id"] == w.id
            && row["observation"]["output"]["content"]["title"] == "Specialist applied once"));
    assert!(report
        .receipts
        .iter()
        .any(|receipt| receipt.profile_id == target && receipt.phase == Phase::Uncertain));
    admit(
        &app,
        &e,
        "Amend uncertain specialist",
        Operation::Amend {
            target: w.target(),
            scope: "New assigned scope".into(),
        },
    );
    w = app
        .lock()
        .unwrap()
        .journal
        .get("routing_work_v2", &w.id)
        .unwrap()
        .unwrap();
    pump(&app).unwrap();
    let amendment = execution(&app, &w);
    assert!(amendment.task_id.is_none());
    assert_eq!(result_row(&app, &amendment.id).status, "uncertain");
    admit(
        &app,
        &e,
        "Cancel uncertain specialist",
        Operation::Cancel { target: w.target() },
    );
    w = app
        .lock()
        .unwrap()
        .journal
        .get("routing_work_v2", &w.id)
        .unwrap()
        .unwrap();
    pump(&app).unwrap();
    let cancelled = execution(&app, &w);
    let report = result_row(&app, &cancelled.id);
    assert_eq!(report.status, "uncertain");
    assert!(!report.verified);
    assert!(report
        .receipts
        .iter()
        .any(|receipt| receipt.profile_id == target && receipt.phase == Phase::Uncertain));
    assert_eq!(
        app.snapshot().unwrap()["todos"].as_array().unwrap().len(),
        1
    );
    drop(source);
    drop(target_runtime);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn resumed_execution_revokes_stale_outbox_without_erasing_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let (app, e, _) = fixture(dir.path(), None, false);
    let w = new_work(&app, &e);
    pump(&app).unwrap();
    let b = execution(&app, &w);
    {
        let s = app.lock().unwrap();
        result(
            &s,
            &w,
            &b,
            "blocked",
            "temporary owner wait",
            None,
            vec![],
            false,
        )
        .unwrap();
        assert_eq!(
            s.journal
                .objects::<ExecutionResult>(COMPLETIONS)
                .unwrap()
                .len(),
            1
        );
        result(&s, &w, &b, "running", "resumed", None, vec![], false).unwrap();
        assert!(s
            .journal
            .objects::<ExecutionResult>(COMPLETIONS)
            .unwrap()
            .is_empty());
        let evidence: Vec<serde_json::Value> = s.journal.objects(EVIDENCE).unwrap();
        assert!(evidence
            .iter()
            .any(|row| row["observation"]["status"] == "blocked"));
        let count = evidence.len();
        result(&s, &w, &b, "running", "resumed", None, vec![], false).unwrap();
        assert_eq!(
            s.journal
                .objects::<serde_json::Value>(EVIDENCE)
                .unwrap()
                .len(),
            count
        );
    }
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn bound_work_denies_unfenced_external_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let (app, e, _) = fixture(
        dir.path(),
        Some(ai::ToolCall::new(
            "remote",
            "integration_call",
            json!({"integration_id":"not-connected","tool":"send","arguments":{}}),
        )),
        false,
    );
    let _w = new_work(&app, &e);
    pump(&app).unwrap();
    let r = runtime(&app, &e);
    r.drive(2).await.unwrap();
    let snap = r.session.committed().unwrap();
    let task = snap
        .tasks
        .values()
        .find(|task| matches!(task.kind, host::durable::TaskKind::Tool { .. }))
        .unwrap();
    let error = fence(&app.lock().unwrap(), &e.profile_id, task).unwrap_err();
    assert!(error.to_string().contains("fenced executor"));
    assert!(snap.effects.is_empty());
    app.shutdown().await.unwrap();
}

async fn delegated_remote_denial(call: ai::ToolCall) {
    let routing_attempt = super::routing_model::is_tool(&call.name);
    let planner_attempt = call.name == "planner_mutation";
    let dir = tempfile::tempdir().unwrap();
    let (app, e, _) = fixture(dir.path(), None, false);
    let mut target =
        Host::profile(ProfileStore::create_profile(dir.path(), "specialist", "synthetic").unwrap())
            .unwrap();
    let target_id = target.id.clone();
    target
        .host
        .install_services(Arc::new(Bridge {
            owner: target_id.clone(),
            host: Arc::downgrade(&app),
        }))
        .unwrap();
    target.runtime = Runtime::new(
        target.runtime.session.clone(),
        Arc::new(SingleProvider(Arc::new(Once {
            call: Some(call),
            turns: AtomicUsize::new(0),
        }))),
        target.host.clone(),
    );
    {
        let mut state = app.lock().unwrap();
        state.profiles.insert(target_id.clone(), target);
        let source = state.profiles.get_mut(&e.profile_id).unwrap();
        source.runtime = Runtime::new(
            source.runtime.session.clone(),
            Arc::new(SingleProvider(Arc::new(Once {
                call: Some(ai::ToolCall::new(
                    "delegate",
                    "delegate_ghost",
                    json!({"profile_id":target_id,"prompt":"synthetic child","background":true}),
                )),
                turns: AtomicUsize::new(0),
            }))),
            source.host.clone(),
        );
    }
    let w = new_work(&app, &e);
    pump(&app).unwrap();
    let binding = execution(&app, &w);
    runtime(&app, &e).drive(64).await.unwrap();
    let child = app.lock().unwrap().profiles[&target_id].runtime.clone();
    child.drive(2).await.unwrap();
    let snap = child.session.committed().unwrap();
    let generation = snap
        .tasks
        .values()
        .find(|task| matches!(task.kind, host::durable::TaskKind::Generation { .. }))
        .unwrap();
    assert_eq!(
        fence_current(&app.lock().unwrap(), &target_id, generation)
            .unwrap()
            .unwrap()
            .id,
        binding.id
    );
    let tool = snap
        .tasks
        .values()
        .find(|task| matches!(task.kind, host::durable::TaskKind::Tool { .. }))
        .unwrap();
    assert!(fence(&app.lock().unwrap(), &target_id, tool)
        .unwrap_err()
        .to_string()
        .contains(if routing_attempt {
            "cannot route independent Work"
        } else {
            "fenced executor"
        }));
    assert!(snap.effects.is_empty());
    if routing_attempt {
        use super::routing_host::ModelRoutingAction;
        let action = ModelRoutingAction::Admit {
            segments: vec![Segment {
                id: "s1".into(),
                start_byte: 0,
                end_byte: "synthetic child".len(),
            }],
            resolves: vec![],
            proposal: RoutingProposal {
                schema: PROPOSAL_SCHEMA.into(),
                items: vec![ProposedSegment {
                    segment_id: "s1".into(),
                    additional_segment_ids: vec![],
                    operation: Operation::New {
                        title: "escaped child".into(),
                        scope: "must not exist".into(),
                        responsible_profile_id: target_id.clone(),
                        dependencies: vec![],
                    },
                }],
            },
        };
        let child_task_count = snap.tasks.len();
        let child_conversation_count = snap.conversations.len();
        let records: Vec<crate::domain::Delegation> =
            app.lock().unwrap().journal.objects("delegation").unwrap();
        let config = records
            .iter()
            .find(|d| d.target == target_id)
            .unwrap()
            .config
            .as_ref()
            .unwrap();
        assert!(config
            .tools
            .iter()
            .all(|t| !super::routing_model::is_tool(&t.name)));
        // Use the actual generation task to bypass tool-list/ToolKind filtering.
        // The server must reject even this direct authenticated model call.
        for state in ["current", "revoked", "cancelled"] {
            if state == "revoked" {
                let mut policy: crate::domain::Policy = app
                    .lock()
                    .unwrap()
                    .journal
                    .get("policy", &e.profile_id)
                    .unwrap()
                    .unwrap_or_default();
                policy.delegation = false;
                app.lock()
                    .unwrap()
                    .journal
                    .put("policy", &e.profile_id, &policy)
                    .unwrap();
            }
            if state == "cancelled" {
                let mut policy: crate::domain::Policy = app
                    .lock()
                    .unwrap()
                    .journal
                    .get("policy", &e.profile_id)
                    .unwrap()
                    .unwrap_or_default();
                policy.delegation = true;
                app.lock()
                    .unwrap()
                    .journal
                    .put("policy", &e.profile_id, &policy)
                    .unwrap();
                admit(
                    &app,
                    &e,
                    "cancel owning Work",
                    Operation::Cancel { target: w.target() },
                );
            }
            let reply = app.routing_for_model(&target_id, generation, action.clone());
            assert_eq!(reply["ok"], false, "{state}: {reply}");
            let s = app.lock().unwrap();
            assert_eq!(
                s.journal.objects::<Work>("routing_work_v2").unwrap().len(),
                1
            );
            let after = child.session.committed().unwrap();
            assert_eq!(after.tasks.len(), child_task_count);
            assert_eq!(after.conversations.len(), child_conversation_count);
            assert!(after.effects.is_empty());
        }
        pump(&app).unwrap();
        assert_eq!(
            app.lock()
                .unwrap()
                .journal
                .objects::<Work>("routing_work_v2")
                .unwrap()
                .len(),
            1
        );
    }
    if planner_attempt {
        child.drive(64).await.unwrap();
        assert!(child.session.committed().unwrap().effects.is_empty());
        #[cfg(feature = "caldav")]
        assert_eq!(
            app.lock()
                .unwrap()
                .journal
                .0
                .query_row("SELECT COUNT(*) FROM planner_operations", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn delegated_work_inherits_remote_mutation_denial_and_owning_binding() {
    delegated_remote_denial(ai::ToolCall::new(
        "remote",
        "shell",
        json!({"command":"must not execute"}),
    ))
    .await;
}

#[cfg(feature = "caldav")]
#[tokio::test]
async fn delegated_work_denies_planner_mutation_before_enqueue() {
    delegated_remote_denial(planner_call()).await;
}

#[cfg(feature = "caldav")]
fn planner_call() -> ai::ToolCall {
    ai::ToolCall::new(
        "planner",
        "planner_mutation",
        json!({"mutation":{
            "collection_id":"todos", "operation":"create", "changes":{"title":"synthetic only"}
        }}),
    )
}

/// Emulate a persisted queue from the earlier implementation without relaxing
/// the new production admission boundary. Only the synthetic fixture edits SQL.
#[cfg(feature = "caldav")]
fn historical_planner_queue(
    app: &Arc<Host>,
    profile: &str,
    task: &Task,
    call: &ai::ToolCall,
) -> String {
    use super::planner_sync::{self, Actor};
    let s = app.lock().unwrap();
    let receipt = planner_sync::enqueue_owner(
        &s,
        &key(),
        "fixture legacy admission",
        serde_json::from_value(call.arguments["mutation"].clone()).unwrap(),
    )
    .unwrap();
    let id = receipt["result"]["operation_id"]
        .as_str()
        .unwrap()
        .to_string();
    let raw: String = s
        .journal
        .0
        .query_row(
            "SELECT payload FROM planner_operations WHERE id=?",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    let mut op: planner_sync::Operation = serde_json::from_str(&raw).unwrap();
    op.actor = Actor::Model {
        profile_id: profile.into(),
        task_id: task.id.clone(),
        effect_key: key(),
        call: call.clone(),
    };
    s.journal
        .0
        .execute(
            "UPDATE planner_operations SET payload=?1 WHERE id=?2",
            rusqlite::params![serde_json::to_string(&op).unwrap(), id],
        )
        .unwrap();
    assert_eq!(op.state, "queued");
    id
}

#[cfg(feature = "caldav")]
#[tokio::test]
async fn persisted_bound_planner_queue_denied_current_amended_cancelled_before_remote_dispatch() {
    use super::planner_sync::{
        fixtures::{configure_fixture, Synthetic},
        Kind,
    };
    for transition in ["current", "amend", "cancel"] {
        let dir = tempfile::tempdir().unwrap();
        let call = planner_call();
        let (app, e, _) = fixture(dir.path(), Some(call.clone()), false);
        configure_fixture(&app, "todos", Kind::Todo, vec![e.profile_id.clone()]);
        let w = new_work(&app, &e);
        pump(&app).unwrap();
        let r = runtime(&app, &e);
        r.drive(2).await.unwrap();
        let snap = r.session.committed().unwrap();
        let task = snap
            .tasks
            .values()
            .find(|t| matches!(t.kind, host::durable::TaskKind::Tool { .. }))
            .unwrap();
        assert!(!task.phase.terminal(), "fixture must stop before admission");
        assert!(
            Bridge::authority_in(&app.lock().unwrap(), &e.profile_id, task, Some(&call))
                .unwrap_err()
                .to_string()
                .contains("fenced executor")
        );
        let id = historical_planner_queue(&app, &e.profile_id, task, &call);
        match transition {
            "amend" => {
                admit(
                    &app,
                    &e,
                    "change prior planner request",
                    Operation::Amend {
                        target: w.target(),
                        scope: "local only".into(),
                    },
                );
            }
            "cancel" => {
                admit(
                    &app,
                    &e,
                    "cancel prior planner request",
                    Operation::Cancel { target: w.target() },
                );
            }
            _ => {}
        }
        // No pump before dispatch: current authority must deny persisted queue.
        let remote = Synthetic::new("fixture:todos");
        let result = app.planner_dispatch(&id, &remote).await.unwrap();
        assert_eq!(result["phase"], "blocked", "{transition}: {result}");
        assert_eq!(result["remote_applied"], false);
        assert!(remote.requests.lock().unwrap().is_empty());
        assert!(remote.items.lock().unwrap().is_empty());
        assert!(r.session.committed().unwrap().effects.is_empty());
        app.shutdown().await.unwrap();
    }
}

#[cfg(feature = "caldav")]
#[tokio::test]
async fn ordinary_unbound_planner_model_authority_and_synthetic_dispatch_preserved() {
    use super::planner_sync::{
        self,
        fixtures::{configure_fixture, Synthetic},
        Kind,
    };
    let dir = tempfile::tempdir().unwrap();
    let call = planner_call();
    let (app, e, _) = fixture(dir.path(), Some(call.clone()), false);
    configure_fixture(&app, "todos", Kind::Todo, vec![e.profile_id.clone()]);
    let r = runtime(&app, &e);
    r.session
        .submit(
            &e.conversation_id,
            &key(),
            durable::InputKind::Prompt,
            "ordinary planner fixture",
        )
        .unwrap();
    r.drive(2).await.unwrap();
    let snap = r.session.committed().unwrap();
    let task = snap
        .tasks
        .values()
        .find(|t| matches!(t.kind, host::durable::TaskKind::Tool { .. }))
        .unwrap();
    assert!(fence_current(&app.lock().unwrap(), &e.profile_id, task)
        .unwrap()
        .is_none());
    let queued = planner_sync::enqueue_model(
        &app.lock().unwrap(),
        &e.profile_id,
        task,
        &call,
        &key(),
        serde_json::from_value(call.arguments["mutation"].clone()).unwrap(),
    )
    .unwrap();
    let remote = Synthetic::new("fixture:todos");
    let result = app
        .planner_dispatch(queued["operation_id"].as_str().unwrap(), &remote)
        .await
        .unwrap();
    assert_eq!(result["phase"], "synced", "{result}");
    assert_eq!(remote.requests.lock().unwrap().len(), 1);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn delegated_work_cannot_escape_lineage_through_model_routing_admission() {
    delegated_remote_denial(ai::ToolCall::new("escape", "route_work", json!({}))).await;
}
