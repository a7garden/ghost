use super::*;
struct StreamingModel;
impl ai::Provider for StreamingModel {
    fn stream<'a>(
        &'a self,
        model: &'a ai::Model,
        _: &'a ai::Context,
        _: Option<ai::StreamOptions>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ai::prelude::StreamResult> + Send + 'a>>
    {
        Box::pin(async move {
            use futures::StreamExt;
            let partial = Arc::new(ai::AssistantMessage::new(
                model.api,
                &model.provider,
                &model.id,
            ));
            let stream = futures::stream::iter([ai::ProviderEvent::TextDelta {
                content_index: 0,
                delta: "저장된 응답 조각".into(),
                partial,
            }])
            .chain(futures::stream::pending());
            Ok(Box::pin(stream)
                as std::pin::Pin<
                    Box<dyn futures::Stream<Item = ai::ProviderEvent> + Send>,
                >)
        })
    }
}
#[tokio::test]
async fn worker_stream_is_visible_and_owner_cancel_closes_it_without_blocking_actions() {
    let dir = tempfile::tempdir().unwrap();
    let store = ProfileStore::create_profile(dir.path(), "stream", "Researcher").unwrap();
    let mut p = Host::profile(store).unwrap();
    let id = p.id.clone();
    p.runtime = Runtime::new(
        p.runtime.session.clone(),
        Arc::new(host::durable::SingleProvider(Arc::new(StreamingModel))),
        p.host.clone(),
    );
    let runtime = p.runtime.clone();
    let app = Arc::new(Host {
        root: dir.path().into(),
        state: Mutex::new(State {
            profiles: BTreeMap::from([(id.clone(), p)]),
            journal: Journal::open(&dir.path().join("workspace.db")).unwrap(),
        }),
        handle: tokio::runtime::Handle::current(),
        default_model: "mock".into(),
        _lock: File::create(dir.path().join("test.lock")).unwrap(),
        brain: memory::Brain::default(),
        computer: computer::default_backend(),
        integrations: crate::host::integrations::Connections::default(),
        workers: Mutex::new(Vec::new()),
        profile_workers: Mutex::new(BTreeMap::new()),
        recovery: tokio::sync::Mutex::new(()),
        stopping: AtomicBool::new(false),
    });
    let c = runtime
        .session
        .create_conversation(host::durable::AgentConfig::new(host::mock_model(), "test"))
        .unwrap();
    let reply = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Submit {
                profile_id: id.clone(),
                conversation_id: c.clone(),
                prompt: "work".into(),
                kind: InputKind::Prompt,
            },
        })
        .unwrap();
    let task = reply["result"]["task_id"].as_str().unwrap();
    let mut watch = runtime.session.watch();
    app.start_worker(id.clone(), runtime.clone(), 4);
    tokio::time::timeout(Duration::from_secs(3),async {
            loop {
                let snap=runtime.session.snapshot().unwrap();
                if matches!(&snap.tasks[task].kind,TaskKind::Generation{partial,..} if partial=="저장된 응답 조각") {break;}
                watch.changed().await.unwrap();
            }
        }).await.unwrap();
    let projected = app.snapshot().unwrap();
    assert_eq!(
        projected["profiles"][0]["conversations"][0]["tasks"][0]["partial"],
        "저장된 응답 조각"
    );
    let cancel = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Cancel {
                profile_id: id,
                task_id: task.into(),
            },
        })
        .unwrap();
    assert_eq!(cancel["ok"], true);
    assert_eq!(
        runtime.session.snapshot().unwrap().tasks[task].phase,
        Phase::Cancelled
    );
    let projected = app.snapshot().unwrap();
    assert!(projected["profiles"][0]["conversations"][0]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["role"] == "interrupted" && m["text"] == "저장된 응답 조각"));
}
fn setup(root: &Path) -> (tokio::runtime::Runtime, Arc<Host>, String, String) {
    ProfileStore::create_profile(root, "timer", "Researcher").unwrap();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let app = Host::open(root, rt.handle().clone(), None).unwrap();
    let id = app.lock().unwrap().profiles.keys().next().unwrap().clone();
    let reply = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::CreateConversation {
                profile_id: id.clone(),
                model: "mock".into(),
                tools: false,
            },
        })
        .unwrap();
    let conversation = reply["result"]["conversation_id"]
        .as_str()
        .unwrap()
        .to_string();
    (rt, app, id, conversation)
}
#[test]
fn timer_lost_ack_reuses_occurrence_after_restart_and_pause_defers_work() {
    let dir = tempfile::tempdir().unwrap();
    let (rt, app, id, conversation) = setup(dir.path());
    let schedule = Schedule {
        id: "timer-1".into(),
        profile_id: id.clone(),
        conversation_id: conversation.clone(),
        prompt: "Review progress".into(),
        interval_seconds: 60,
        next_run_ms: 1000,
        paused: false,
        last_task_id: None,
    };
    {
        let s = app.lock().unwrap();
        s.journal.add(&schedule).unwrap();
        // Runtime input committed, then process dies before timer ACK.
        s.profiles[&id]
            .runtime
            .session
            .submit(
                &conversation,
                "schedule:timer-1:1000",
                InputKind::FollowUp,
                &schedule.prompt,
            )
            .unwrap();
    }
    drop(app);
    drop(rt);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let app = Host::open(dir.path(), rt.handle().clone(), None).unwrap();
    // Queued input still owns this conversation: another occurrence waits.
    app.dispatch_due(&id, 4000).unwrap();
    {
        let s = app.lock().unwrap();
        assert_eq!(
            s.profiles[&id]
                .runtime
                .session
                .snapshot()
                .unwrap()
                .submissions
                .len(),
            1
        );
        assert_eq!(s.journal.list().unwrap()[0].next_run_ms, 1000);
        let task = s.profiles[&id]
            .runtime
            .session
            .snapshot()
            .unwrap()
            .submissions[0]
            .task_id
            .clone();
        s.profiles[&id].runtime.session.cancel(&task).unwrap();
    }
    app.dispatch_due(&id, 5000).unwrap();
    let s = app.lock().unwrap();
    assert_eq!(
        s.profiles[&id]
            .runtime
            .session
            .snapshot()
            .unwrap()
            .submissions
            .len(),
        1
    );
    assert_eq!(s.journal.list().unwrap()[0].next_run_ms, 65_000);
    s.journal.pause(&schedule.id, true, 6000).unwrap();
    drop(s);
    app.dispatch_due(&id, 100_000).unwrap();
    let s = app.lock().unwrap();
    assert_eq!(
        s.profiles[&id]
            .runtime
            .session
            .snapshot()
            .unwrap()
            .submissions
            .len(),
        1
    );
    s.journal.pause(&schedule.id, false, 100_000).unwrap();
    assert_eq!(s.journal.list().unwrap()[0].next_run_ms, 160_000);
}
#[test]
fn interrupted_command_intent_never_reissues_a_permission_change() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.db");
    let journal = Journal::open(&path).unwrap();
    assert!(journal
        .begin("request-1", "grant-folder")
        .unwrap()
        .is_none());
    drop(journal);
    let journal = Journal::open(&path).unwrap();
    assert!(journal
        .begin("request-1", "grant-folder")
        .unwrap_err()
        .to_string()
        .contains("interrupted"));
    assert!(journal.begin("request-1", "different-folder").is_err());
}
#[test]
fn schedules_reject_invalid_intervals_without_creating_a_timer() {
    let dir = tempfile::tempdir().unwrap();
    let (rt, app, id, conversation) = setup(dir.path());
    let reply = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::AddSchedule {
                profile_id: id,
                conversation_id: conversation,
                prompt: "repeat".into(),
                interval_seconds: 0,
            },
        })
        .unwrap();
    assert_eq!(reply["ok"], false);
    assert!(app.lock().unwrap().journal.list().unwrap().is_empty());
    drop(app);
    drop(rt);
}

struct DelegateToolModel {
    target: String,
    turn: std::sync::atomic::AtomicUsize,
}
impl ai::Provider for DelegateToolModel {
    fn stream<'a>(
        &'a self,
        model: &'a ai::Model,
        _: &'a ai::Context,
        _: Option<ai::StreamOptions>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ai::prelude::StreamResult> + Send + 'a>>
    {
        Box::pin(async move {
            let mut message = ai::AssistantMessage::new(model.api, &model.provider, &model.id);
            if self.turn.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                message
                    .content
                    .push(ai::ContentBlock::ToolCall(ai::ToolCall::new(
                        "delegate-call",
                        "delegate_ghost",
                        serde_json::json!({
                            "profile_id": self.target,
                            "prompt": "Inspect the current project state",
                            "background": false
                        }),
                    )));
            } else {
                message
                    .content
                    .push(ai::ContentBlock::Text(ai::TextContent::new(
                        "delegation settled",
                    )));
            }
            Ok(Box::pin(futures::stream::iter([ai::ProviderEvent::Done {
                reason: ai::StopReason::Stop,
                message,
            }]))
                as std::pin::Pin<
                    Box<dyn futures::Stream<Item = ai::ProviderEvent> + Send>,
                >)
        })
    }
}

struct PendingChildModel;
impl ai::Provider for PendingChildModel {
    fn stream<'a>(
        &'a self,
        model: &'a ai::Model,
        _: &'a ai::Context,
        _: Option<ai::StreamOptions>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ai::prelude::StreamResult> + Send + 'a>>
    {
        Box::pin(async move {
            use futures::StreamExt;
            let partial = Arc::new(ai::AssistantMessage::new(
                model.api,
                &model.provider,
                &model.id,
            ));
            let stream = futures::stream::iter([ai::ProviderEvent::TextDelta {
                content_index: 0,
                delta: "specialist still working".into(),
                partial,
            }])
            .chain(futures::stream::pending());
            Ok(Box::pin(stream)
                as std::pin::Pin<
                    Box<dyn futures::Stream<Item = ai::ProviderEvent> + Send>,
                >)
        })
    }
}

fn setup_live_delegation(root: &Path) -> (Arc<Host>, String, String, String, String) {
    setup_delegation_with_provider(root, Arc::new(PendingChildModel))
}
fn setup_delegation_with_provider(
    root: &Path,
    specialist: Arc<dyn ai::Provider>,
) -> (Arc<Host>, String, String, String, String) {
    let owner_store = ProfileStore::create_profile(root, "owner", "Coordinator").unwrap();
    let target_store = ProfileStore::create_profile(root, "specialist", "Analyst").unwrap();
    let mut owner = Host::profile(owner_store).unwrap();
    let mut target = Host::profile(target_store).unwrap();
    let owner_id = owner.id.clone();
    let target_id = target.id.clone();

    owner.runtime = Runtime::new(
        owner.runtime.session.clone(),
        Arc::new(host::durable::SingleProvider(Arc::new(DelegateToolModel {
            target: target_id.clone(),
            turn: Default::default(),
        }))),
        owner.host.clone(),
    );
    target.runtime = Runtime::new(
        target.runtime.session.clone(),
        Arc::new(host::durable::SingleProvider(specialist)),
        target.host.clone(),
    );

    let owner_runtime = owner.runtime.clone();
    let target_runtime = target.runtime.clone();
    let app = Arc::new(Host {
        root: root.to_path_buf(),
        state: Mutex::new(State {
            profiles: BTreeMap::from([(owner_id.clone(), owner), (target_id.clone(), target)]),
            journal: Journal::open(&root.join("workspace.db")).unwrap(),
        }),
        handle: tokio::runtime::Handle::current(),
        default_model: "mock".into(),
        _lock: File::create(root.join("test.lock")).unwrap(),
        brain: memory::Brain::default(),
        computer: computer::default_backend(),
        integrations: crate::host::integrations::Connections::default(),
        workers: Mutex::new(Vec::new()),
        profile_workers: Mutex::new(BTreeMap::new()),
        recovery: tokio::sync::Mutex::new(()),
        stopping: AtomicBool::new(false),
    });
    {
        let state = app.lock().unwrap();
        for id in [&owner_id, &target_id] {
            state.profiles[id]
                .host
                .install_services(Arc::new(services::Bridge {
                    owner: id.clone(),
                    host: Arc::downgrade(&app),
                }))
                .unwrap();
        }
    }
    let config = {
        let state = app.lock().unwrap();
        let store = state.profiles[&owner_id].host.store.lock().unwrap();
        let mut config = host::config(&store, Some("mock"), true).unwrap();
        config.tools.extend(services::tool_definitions(&app));
        config
    };
    let conversation = app.lock().unwrap().profiles[&owner_id]
        .runtime
        .session
        .create_conversation(config)
        .unwrap();
    app.start_worker(owner_id.clone(), owner_runtime, 4);
    app.start_worker(target_id.clone(), target_runtime, 4);
    let submitted = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Submit {
                profile_id: owner_id.clone(),
                conversation_id: conversation.clone(),
                prompt: "Delegate a bounded analysis".into(),
                kind: InputKind::Prompt,
            },
        })
        .unwrap();
    let parent_task = submitted["result"]["task_id"].as_str().unwrap().to_owned();
    (app, owner_id, target_id, parent_task, conversation)
}

struct AssignedReporter {
    turn: std::sync::atomic::AtomicUsize,
}
impl ai::Provider for AssignedReporter {
    fn stream<'a>(
        &'a self,
        model: &'a ai::Model,
        context: &'a ai::Context,
        _: Option<ai::StreamOptions>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ai::prelude::StreamResult> + Send + 'a>>
    {
        Box::pin(async move {
            assert!(context
                .tools
                .iter()
                .any(|tool| tool.name == "report_delegation"));
            let mut message = ai::AssistantMessage::new(model.api, &model.provider, &model.id);
            if self.turn.fetch_add(1, Ordering::SeqCst) == 0 {
                let identity = context
                    .system_prompt
                    .as_deref()
                    .unwrap()
                    .split_once("Delegation identity: ")
                    .unwrap()
                    .1
                    .split(". Report progress")
                    .next()
                    .unwrap();
                message.content.push(ai::ContentBlock::ToolCall(ai::ToolCall::new("assigned-report", "report_delegation", serde_json::json!({"delegation_id":identity,"summary":"Synthetic assigned progress","artifacts":[]}))));
            } else {
                message
                    .content
                    .push(ai::ContentBlock::Text(ai::TextContent::new(
                        "Synthetic specialist final result",
                    )));
            }
            Ok(Box::pin(futures::stream::iter([ai::ProviderEvent::Done {
                reason: ai::StopReason::Stop,
                message,
            }]))
                as std::pin::Pin<
                    Box<dyn futures::Stream<Item = ai::ProviderEvent> + Send>,
                >)
        })
    }
}

#[tokio::test]
async fn actual_assigned_delegation_reports_through_sdk_and_finishes() {
    let dir = tempfile::tempdir().unwrap();
    let (app, owner, target, parent_task, _) = setup_delegation_with_provider(
        dir.path(),
        Arc::new(AssignedReporter {
            turn: Default::default(),
        }),
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            {
                let state = app.lock().unwrap();
                let snapshot = state.profiles[&target].runtime.session.committed().unwrap();
                let reported = snapshot.effects.values().any(|effect| {
                    effect.name == "report_delegation"
                        && effect.output.as_ref().is_some_and(|output| {
                            output.status == host::durable::ToolStatus::Success
                        })
                });
                let settled = state.profiles[&owner]
                    .runtime
                    .session
                    .committed()
                    .unwrap()
                    .tasks[&parent_task]
                    .phase
                    == Phase::Complete;
                if reported && settled {
                    assert!(state
                        .journal
                        .objects::<Delegation>("delegation")
                        .unwrap()
                        .iter()
                        .any(|record| record.target == target && record.state == "complete"));
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("assigned report must commit an actual SDK effect and let the sender complete");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn report_binding_rejects_forged_wrong_conversation_revoked_and_cancelled_assignments() {
    let dir = tempfile::tempdir().unwrap();
    let (app, owner, target, _, _) = setup_live_delegation(dir.path());
    let (_, child) = wait_for_running_delegate(&app, &owner, &target).await;
    let state = app.lock().unwrap();
    let task = state.profiles[&target]
        .runtime
        .session
        .committed()
        .unwrap()
        .tasks[&child]
        .clone();
    let record = state
        .journal
        .objects::<Delegation>("delegation")
        .unwrap()
        .into_iter()
        .find(|record| record.target == target)
        .unwrap();
    let report = |id: &str| {
        ai::ToolCall::new(
            "report",
            "report_delegation",
            serde_json::json!({"delegation_id":id,"summary":"Synthetic progress"}),
        )
    };
    assert!(
        services::Bridge::authority_in(&state, &target, &task, Some(&report(&record.id))).is_ok()
    );
    assert!(services::Bridge::authority_in(
        &state,
        &target,
        &task,
        Some(&report("forged-assignment"))
    )
    .is_err());
    let session = state.profiles[&target].runtime.session.clone();
    let unrelated = session
        .create_conversation(host::durable::AgentConfig::new(
            host::mock_model(),
            "unrelated synthetic conversation",
        ))
        .unwrap();
    let unrelated = session
        .submit(
            &unrelated,
            "unrelated",
            InputKind::Prompt,
            "synthetic input",
        )
        .unwrap();
    let unrelated = session.committed().unwrap().tasks[&unrelated.task_id].clone();
    assert!(
        services::Bridge::authority_in(&state, &target, &unrelated, Some(&report(&record.id)))
            .is_err()
    );
    let mut policy: Policy = state
        .journal
        .get("policy", &owner)
        .unwrap()
        .unwrap_or_default();
    policy.delegation = false;
    state.journal.put("policy", &owner, &policy).unwrap();
    assert!(
        services::Bridge::authority_in(&state, &target, &task, Some(&report(&record.id))).is_err()
    );
    policy.delegation = true;
    state.journal.put("policy", &owner, &policy).unwrap();
    let mut cancelled = record.clone();
    cancelled.state = "cancelled".into();
    state
        .journal
        .put("delegation", &record.id, &cancelled)
        .unwrap();
    assert!(
        services::Bridge::authority_in(&state, &target, &task, Some(&report(&record.id))).is_err()
    );
    drop(state);
    drop(session);
    app.shutdown().await.unwrap();
}

async fn wait_for_running_delegate(
    app: &Arc<Host>,
    owner_id: &str,
    target_id: &str,
) -> (String, String) {
    tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                {
                let state = app.lock().unwrap();
                let owner = &state.profiles[owner_id];
                let target = &state.profiles[target_id];
                let owner_snapshot = owner.runtime.session.snapshot().unwrap();
                let target_snapshot = target.runtime.session.snapshot().unwrap();
                let waiting = owner_snapshot.tasks.values().find(|task| {
                    task.phase == Phase::WaitingOwner
                        && matches!(&task.kind, TaskKind::Tool { call, .. } if call.name == "delegate_ghost")
                });
                if let Some(task) = waiting {
                    let TaskKind::Tool {
                        plan: Some(plan), ..
                    } = &task.kind
                    else {
                        unreachable!("waiting delegate must have a committed plan");
                    };
                    if let Some(child) = state
                        .journal
                        .get::<Delegation>("delegation", &plan.effect_key)
                        .unwrap()
                    {
                        if target_snapshot
                            .tasks
                            .get(&child.task_id)
                            .is_some_and(|task| task.phase == Phase::ModelRunning)
                        {
                            return (task.id.clone(), child.task_id);
                        }
                    }
                }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("owner and specialist should reach a persisted owner wait")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn graceful_host_shutdown_preserves_owned_delegation_for_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (app, owner_id, target_id, parent_task, _conversation) = setup_live_delegation(dir.path());
    let (tool_task, child_task) = wait_for_running_delegate(&app, &owner_id, &target_id).await;
    let effect_key = {
        let state = app.lock().unwrap();
        let owner = &state.profiles[&owner_id];
        let snapshot = owner.runtime.session.snapshot().unwrap();
        let TaskKind::Tool {
            plan: Some(plan), ..
        } = &snapshot.tasks[&tool_task].kind
        else {
            unreachable!();
        };
        plan.effect_key.clone()
    };

    app.shutdown().await.unwrap();
    drop(app);

    let resumed = Host::open(dir.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            {
                let state = resumed.lock().unwrap();
                let owner = &state.profiles[&owner_id];
                let target = &state.profiles[&target_id];
                let owner_snapshot = owner.runtime.session.snapshot().unwrap();
                let target_snapshot = target.runtime.session.snapshot().unwrap();
                let owner_phase = owner_snapshot.tasks[&parent_task].phase;
                let child_phase = target_snapshot.tasks[&child_task].phase;
                assert_ne!(
                    child_phase,
                    Phase::Cancelled,
                    "shutdown cancelled the specialist"
                );
                if owner_phase == Phase::Complete && child_phase == Phase::Complete {
                    let delegation = state
                        .journal
                        .get::<Delegation>("delegation", &effect_key)
                        .unwrap()
                        .unwrap();
                    assert_eq!(delegation.state, "complete");
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("reopened host should reattach to and finish the owned delegation");
    resumed.dispatch_due(&owner_id, now_ms()).unwrap();
    let messages = resumed
        .lock()
        .unwrap()
        .journal
        .messages(&effect_key, 0)
        .unwrap();
    assert_eq!(
        messages
            .iter()
            .filter(|m| matches!(m.event, crate::domain::protocol::Event::Requested { .. }))
            .count(),
        1
    );
    assert_eq!(
        messages
            .iter()
            .filter(|m| matches!(m.event, crate::domain::protocol::Event::Accepted { .. }))
            .count(),
        1
    );
    assert!(messages.iter().any(|m| matches!(
        m.event,
        crate::domain::protocol::Event::Result {
            phase: Phase::Complete,
            ..
        }
    )));
    resumed.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_parent_cancel_cancels_owned_delegation() {
    let dir = tempfile::tempdir().unwrap();
    let (app, owner_id, target_id, parent_task, _conversation) = setup_live_delegation(dir.path());
    let (tool_task, child_task) = wait_for_running_delegate(&app, &owner_id, &target_id).await;
    let effect_key = {
        let state = app.lock().unwrap();
        let owner = &state.profiles[&owner_id];
        let snapshot = owner.runtime.session.snapshot().unwrap();
        let TaskKind::Tool {
            plan: Some(plan), ..
        } = &snapshot.tasks[&tool_task].kind
        else {
            unreachable!();
        };
        plan.effect_key.clone()
    };

    let reply = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Cancel {
                profile_id: owner_id.clone(),
                task_id: parent_task,
            },
        })
        .unwrap();
    assert_eq!(reply["ok"], true);

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            {
                let state = app.lock().unwrap();
                let target = &state.profiles[&target_id];
                let child_phase =
                    target.runtime.session.snapshot().unwrap().tasks[&child_task].phase;
                if child_phase == Phase::Cancelled {
                    let delegation = state
                        .journal
                        .get::<Delegation>("delegation", &effect_key)
                        .unwrap()
                        .unwrap();
                    assert_eq!(delegation.state, "cancelled");
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("explicit owner cancellation should stop the specialist child");
    let messages = app
        .lock()
        .unwrap()
        .journal
        .messages(&effect_key, 0)
        .unwrap();
    assert!(messages.iter().any(|m| matches!(
        m.event,
        crate::domain::protocol::Event::CancelRequested { .. }
    )));
    assert!(messages.iter().any(|m| matches!(
        m.event,
        crate::domain::protocol::Event::CancelReceipt {
            phase: Some(Phase::Cancelled),
            ..
        }
    )));
    app.shutdown().await.unwrap();
}
