//! H02/H03 exercise the actual durable provider/Bridge/session SQLite path.
use super::fixtures::*;
use super::*;
use crate::durable::{
    self as host,
    durable::{
        AgentConfig, Host as DurableHost, HostFuture, InputKind, Runtime, SingleProvider, TaskKind,
        ToolPlan,
    },
};
use crate::{host::services, store::ProfileStore};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
struct Once {
    call: ai::ToolCall,
    turn: AtomicUsize,
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
            if self.turn.fetch_add(1, Ordering::SeqCst) == 0 {
                message
                    .content
                    .push(ai::ContentBlock::ToolCall(self.call.clone()));
            } else {
                message
                    .content
                    .push(ai::ContentBlock::Text(ai::TextContent::new(
                        "Admission receipt reviewed",
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
#[derive(Clone, Copy)]
enum Boundary {
    BeforeAdmission,
    AfterAdmission,
    None,
}
struct CrashBridge {
    inner: services::Bridge,
    boundary: Boundary,
    reached: Arc<tokio::sync::Notify>,
}
impl DurableHost for CrashBridge {
    fn admit_tool(&self, t: &Task, c: &ai::ToolCall) -> host::durable::Result<()> {
        self.inner.admit_tool(t, c)
    }
    fn admit_model(&self, t: &Task, c: &AgentConfig) -> host::durable::Result<()> {
        self.inner.admit_model(t, c)
    }
    fn prepare(&self, t: &Task, c: &ai::ToolCall) -> host::durable::Result<ToolPlan> {
        self.inner.prepare(t, c)
    }
    fn execute<'a>(
        &'a self,
        t: &'a Task,
        c: &'a ai::ToolCall,
        p: &'a ToolPlan,
    ) -> HostFuture<'a, ToolOutput> {
        Box::pin(async move {
            if matches!(self.boundary, Boundary::BeforeAdmission) {
                self.reached.notify_one();
                std::future::pending::<()>().await;
            }
            let output = self.inner.execute(t, c, p).await?;
            if matches!(self.boundary, Boundary::AfterAdmission) {
                self.reached.notify_one();
                std::future::pending::<()>().await;
            }
            Ok(output)
        })
    }
}
fn runtime_host(
    root: &std::path::Path,
    boundary: Boundary,
) -> (Arc<Host>, String, Arc<tokio::sync::Notify>) {
    let app = Host::open(root, tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let mut p = Host::profile(
        ProfileStore::create_profile(root, "writer", "synthetic planner test").unwrap(),
    )
    .unwrap();
    let profile = p.id.clone();
    let call = ai::ToolCall::new(
        "create-connected",
        "planner_mutation",
        json!({"mutation":{"collection_id":"todos","operation":"create","changes":{"title":"durable synthetic"}}}),
    );
    p.runtime = Runtime::new(
        p.runtime.session.clone(),
        Arc::new(SingleProvider(Arc::new(Once {
            call,
            turn: AtomicUsize::new(0),
        }))),
        p.host.clone(),
    );
    let reached = Arc::new(tokio::sync::Notify::new());
    p.host
        .install_services(Arc::new(CrashBridge {
            inner: services::Bridge {
                owner: profile.clone(),
                host: Arc::downgrade(&app),
            },
            boundary,
            reached: reached.clone(),
        }))
        .unwrap();
    app.lock().unwrap().profiles.insert(profile.clone(), p);
    configure_fixture(&app, "todos", Kind::Todo, vec![profile.clone()]);
    (app, profile, reached)
}
fn start(app: &Arc<Host>, profile: &str) -> String {
    let (session, runtime, config) = {
        let s = app.lock().unwrap();
        let p = &s.profiles[profile];
        let store = p.host.store.lock().unwrap();
        let mut config = host::config(&store, Some("mock"), true).unwrap();
        config.tools.extend(services::tool_definitions(app));
        (p.runtime.session.clone(), p.runtime.clone(), config)
    };
    let convo = session.create_conversation(config).unwrap();
    let parent = session
        .submit(
            &convo,
            "synthetic-input",
            InputKind::Prompt,
            "Queue one task",
        )
        .unwrap()
        .task_id;
    app.start_worker(profile.into(), runtime, 2);
    parent
}
async fn wait_complete(app: &Arc<Host>, profile: &str, parent: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let phase = app.lock().unwrap().profiles[profile]
                .runtime
                .session
                .snapshot()
                .unwrap()
                .tasks[parent]
                .phase;
            if phase.terminal() {
                assert_eq!(phase, Phase::Complete);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
fn effect(app: &Arc<Host>, profile: &str) -> host::durable::Effect {
    app.lock().unwrap().profiles[profile]
        .runtime
        .session
        .snapshot()
        .unwrap()
        .effects
        .values()
        .find(|e| e.name == "planner_mutation")
        .unwrap()
        .clone()
}
async fn crash_case(boundary: Boundary, dispatch_before_reconcile: bool) {
    let root = tempfile::tempdir().unwrap();
    let (app, profile, reached) = runtime_host(root.path(), boundary);
    let parent = start(&app, &profile);
    if matches!(boundary, Boundary::None) {
        wait_complete(&app, &profile, &parent).await;
    } else {
        tokio::time::timeout(std::time::Duration::from_secs(10), reached.notified())
            .await
            .unwrap();
    }
    let original_effect = effect(&app, &profile);
    let original_ops = operations(&app.lock().unwrap().journal.0, "todos").unwrap();
    assert_eq!(
        original_ops.len(),
        usize::from(!matches!(boundary, Boundary::BeforeAdmission))
    );
    if let Some(o) = original_ops.first() {
        assert_eq!(
            o.identity,
            format!("effect:{profile}:{}", original_effect.key)
        );
        assert_eq!(o.state, "queued");
        assert!(!o.remote_applied);
    }
    app.shutdown().await.unwrap();
    // The SDK aborts child futures asynchronously. A real process exit drops
    // them all; this in-process crash fixture must wait for the actual file
    // lock release. Arc strong_count==0 precedes completion of field Drop.
    drop(app);
    let probe = std::fs::OpenOptions::new()
        .write(true)
        .open(root.path().join("workspace.lock"))
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if fs2::FileExt::try_lock_exclusive(&probe).is_ok() {
                fs2::FileExt::unlock(&probe).unwrap();
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(probe);
    let app = Host::open(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let recovered = effect(&app, &profile);
    assert_eq!(recovered.key, original_effect.key);
    let remote = Synthetic::new("fixture:todos");
    if matches!(boundary, Boundary::BeforeAdmission) {
        assert_eq!(recovered.phase, Phase::Uncertain);
        assert!(operations(&app.lock().unwrap().journal.0, "todos")
            .unwrap()
            .is_empty());
        let result = owner(
            &app,
            crate::control::api::OwnerAction::ReconcilePlannerEffect {
                profile_id: profile.clone(),
                effect_key: recovered.key.clone(),
            },
        );
        assert_eq!(
            result["ok"], false,
            "absence is not automatic replay permission"
        );
    } else {
        let before = original_ops.first().unwrap();
        let o = operations(&app.lock().unwrap().journal.0, "todos")
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(o.id, before.id);
        assert_eq!(o.uid, before.uid);
        let original_admission = admission_receipt(&app.lock().unwrap().journal.0, &o.id).unwrap();
        assert_eq!(original_admission["phase"], "queued");
        assert_eq!(original_admission["remote_applied"], false);
        if dispatch_before_reconcile {
            assert_eq!(
                app.planner_dispatch(&o.id, &remote).await.unwrap()["phase"],
                "synced"
            );
            assert_eq!(
                status(&app.lock().unwrap(), &o.id, "todos").unwrap()["remote_applied"],
                true
            );
        }
        if matches!(boundary, Boundary::AfterAdmission) {
            assert_eq!(recovered.phase, Phase::Uncertain);
            assert!(recovered.output.is_none());
            let reconciled = owner(
                &app,
                crate::control::api::OwnerAction::ReconcilePlannerEffect {
                    profile_id: profile.clone(),
                    effect_key: recovered.key.clone(),
                },
            );
            assert_eq!(reconciled["ok"], true, "{reconciled}");
            assert_eq!(reconciled["result"]["operation_id"], o.id);
            assert_eq!(reconciled["result"]["remote_applied"], false);
            assert_eq!(reconciled["result"], original_admission);
            let e = effect(&app, &profile);
            assert_eq!(e.phase, Phase::Complete);
            assert_eq!(e.output.unwrap().content, original_admission);
        } else {
            assert_eq!(
                recovered.output.as_ref().unwrap().content["operation_id"],
                o.id
            );
            assert_eq!(
                recovered.output.as_ref().unwrap().content["remote_applied"],
                false
            );
        }
        assert_eq!(
            app.planner_dispatch(&o.id, &remote).await.unwrap()["phase"],
            "synced"
        );
        assert_eq!(
            app.planner_dispatch(&o.id, &remote).await.unwrap()["phase"],
            "synced"
        );
        assert_eq!(remote.requests.lock().unwrap().len(), 1);
        assert_eq!(remote.items.lock().unwrap().len(), 1);
        let (task, call) = {
            let s = app.lock().unwrap();
            let snapshot = s.profiles[&profile].runtime.session.committed().unwrap();
            let task = snapshot.tasks[&recovered.task_id].clone();
            let TaskKind::Tool { call, .. } = &task.kind else {
                panic!("real tool task required")
            };
            (task.clone(), call.clone())
        };
        let m: Mutation = serde_json::from_value(call.arguments["mutation"].clone()).unwrap();
        let reused = enqueue_model(
            &app.lock().unwrap(),
            &profile,
            &task,
            &call,
            &recovered.key,
            m.clone(),
        )
        .unwrap();
        assert_eq!(reused["operation_id"], o.id);
        assert_eq!(
            reused, original_admission,
            "model replay is immutable admission, not mutable remote status"
        );
        let mut different = m;
        different.changes.insert("title".into(), json!("collision"));
        assert!(enqueue_model(
            &app.lock().unwrap(),
            &profile,
            &task,
            &call,
            &recovered.key,
            different
        )
        .is_err());
        assert_eq!(
            operations(&app.lock().unwrap().journal.0, "todos")
                .unwrap()
                .len(),
            1
        );
    }
    assert!(app.snapshot().unwrap()["todos"]
        .as_array()
        .unwrap()
        .is_empty());
    app.shutdown().await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn caldav_h02_before_workspace_admission_crash_never_replays() {
    crash_case(Boundary::BeforeAdmission, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn caldav_h02_workspace_commit_before_durable_receipt_same_effect_uid() {
    crash_case(Boundary::AfterAdmission, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn caldav_h02_durable_receipt_before_caller_restart_same_operation() {
    crash_case(Boundary::None, false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn caldav_h02_remote_finishes_before_admission_reconcile_receipt_stays_queued() {
    crash_case(Boundary::AfterAdmission, true).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn caldav_h03_delegation_intersection_and_revocation_before_dispatch() {
    let root = tempfile::tempdir().unwrap();
    let (app, recipient, _) = runtime_host(root.path(), Boundary::None);
    let sender = Host::profile(
        ProfileStore::create_profile(root.path(), "sender", "delegates synthetic work").unwrap(),
    )
    .unwrap();
    let sender_id = sender.id.clone();
    let source_session = sender.runtime.session.clone();
    app.lock()
        .unwrap()
        .profiles
        .insert(sender_id.clone(), sender);
    let source_convo = source_session
        .create_conversation(AgentConfig::new(host::mock_model(), "sender"))
        .unwrap();
    let source = source_session
        .submit(&source_convo, "source", InputKind::Prompt, "delegate")
        .unwrap();
    let (session, runtime, config) = {
        let s = app.lock().unwrap();
        let p = &s.profiles[&recipient];
        let store = p.host.store.lock().unwrap();
        let mut config = host::config(&store, Some("mock"), true).unwrap();
        config.tools.extend(services::tool_definitions(&app));
        (p.runtime.session.clone(), p.runtime.clone(), config)
    };
    let convo = session.create_conversation(config).unwrap();
    let child = session
        .submit(&convo, "child", InputKind::Prompt, "Queue task")
        .unwrap();
    app.lock()
        .unwrap()
        .journal
        .put(
            "delegation",
            "synthetic",
            &crate::domain::Delegation {
                id: "synthetic".into(),
                owner: sender_id.clone(),
                owner_task: source.task_id,
                target: recipient.clone(),
                conversation_id: convo,
                task_id: child.task_id.clone(),
                background: false,
                state: "running".into(),
                config: None,
            },
        )
        .unwrap();
    let task = session.snapshot().unwrap().tasks[&child.task_id].clone();
    let call = ai::ToolCall::new(
        "probe",
        "planner_mutation",
        json!({"mutation":{"collection_id":"todos","operation":"create","changes":{"title":"probe"}}}),
    );
    let bridge = services::Bridge {
        owner: recipient.clone(),
        host: Arc::downgrade(&app),
    };
    assert!(
        bridge.prepare(&task, &call).is_err(),
        "recipient-only grant must not widen sender scope"
    );
    let input = CollectionInput {
        id: "todos".into(),
        binding: "fixture:todos".into(),
        kind: Kind::Todo,
        profiles: vec![recipient.clone(), sender_id.clone()],
        enabled: true,
    };
    assert_eq!(
        owner(
            &app,
            crate::control::api::OwnerAction::SavePlannerCollection {
                collection: input.clone(),
                version: Some(1)
            }
        )["ok"],
        true
    );
    assert!(bridge.prepare(&task, &call).is_ok());
    app.start_worker(recipient.clone(), runtime, 2);
    wait_complete(&app, &recipient, &child.task_id).await;
    let queued = operations(&app.lock().unwrap().journal.0, "todos")
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(queued.generation, 2);
    let mut policy = crate::domain::Policy {
        delegation: false,
        ..Default::default()
    };
    app.lock()
        .unwrap()
        .journal
        .put("policy", &sender_id, &policy)
        .unwrap();
    assert!(bridge.prepare(&task, &call).is_err());
    let remote = Synthetic::new("fixture:todos");
    assert_eq!(
        app.planner_dispatch(&queued.id, &remote).await.unwrap()["phase"],
        "blocked"
    );
    assert!(remote.requests.lock().unwrap().is_empty());
    assert_eq!(
        collection(&app.lock().unwrap(), "todos")
            .unwrap()
            .generation,
        queued.generation,
        "policy revocation does not need collection generation change"
    );
    policy.delegation = true;
    app.lock()
        .unwrap()
        .journal
        .put("policy", &sender_id, &policy)
        .unwrap();
    let mut narrowed = input;
    narrowed.profiles = vec![recipient.clone()];
    assert_eq!(
        owner(
            &app,
            crate::control::api::OwnerAction::SavePlannerCollection {
                collection: narrowed,
                version: Some(2)
            }
        )["ok"],
        true
    );
    assert!(bridge.prepare(&task, &call).is_err());
    assert!(remote.items.lock().unwrap().is_empty());
    app.shutdown().await.unwrap();
}
