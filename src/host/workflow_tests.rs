use super::*;
use host::durable::{Host as _, SingleProvider, Task};

struct OnceTool {
    call: ai::ToolCall,
    turn: std::sync::atomic::AtomicUsize,
}
impl ai::Provider for OnceTool {
    fn stream<'a>(
        &'a self,
        model: &'a ai::Model,
        _: &'a ai::Context,
        _: Option<ai::StreamOptions>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ai::prelude::StreamResult> + Send + 'a>>
    {
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
                        "Verified receipt",
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
fn setup(root: &Path, call: ai::ToolCall) -> (Arc<Host>, String) {
    let store = ProfileStore::create_profile(root, "writer", "Writes reviewed pages").unwrap();
    let mut p = Host::profile(store).unwrap();
    let id = p.id.clone();
    p.runtime = Runtime::new(
        p.runtime.session.clone(),
        Arc::new(SingleProvider(Arc::new(OnceTool {
            call,
            turn: Default::default(),
        }))),
        p.host.clone(),
    );
    let app = Arc::new(Host {
        root: root.into(),
        state: Mutex::new(State {
            profiles: BTreeMap::from([(id.clone(), p)]),
            journal: Journal::open(&root.join("workspace.db")).unwrap(),
        }),
        handle: tokio::runtime::Handle::current(),
        default_model: "mock".into(),
        _lock: super::WorkspaceLock(File::create(root.join("test.lock")).unwrap()),
        brain: memory::Brain::default(),
        computer: computer::default_backend(),
        integrations: crate::host::integrations::Connections::default(),
        workers: Mutex::new(vec![]),
        profile_workers: Mutex::new(BTreeMap::new()),
        recovery: tokio::sync::Mutex::new(()),
        stopping: AtomicBool::new(false),
        #[cfg(test)]
        legacy_fixture_reasoning: AtomicBool::new(false),
        dispatch_enabled: true,
        #[cfg(feature = "lifetime")]
        pi_callback_token: String::new(),
        #[cfg(feature = "lifetime")]
        pi_local_route: None,
        #[cfg(feature = "lifetime")]
        native_computers: None,
        #[cfg(feature = "lifetime")]
        authority_epoch: 1,
    });
    app.lock().unwrap().profiles[&id]
        .host
        .install_services(Arc::new(services::Bridge {
            owner: id.clone(),
            host: Arc::downgrade(&app),
        }))
        .unwrap();
    (app, id)
}
fn owner(app: &Arc<Host>, action: OwnerAction) -> Value {
    app.action(Action {
        request_id: uuid::Uuid::new_v4().to_string(),
        command: Command::Workspace { action },
    })
    .unwrap()
}
fn start(app: &Arc<Host>, id: &str) -> String {
    let (session, runtime, config) = {
        let s = app.lock().unwrap();
        let p = &s.profiles[id];
        let store = p.host.store.lock().unwrap();
        let mut c = host::config(&store, Some("mock"), true).unwrap();
        c.tools.extend(services::role_tool_definitions(app, services::ToolRole::Ordinary));
        (p.runtime.session.clone(), p.runtime.clone(), c)
    };
    let conversation = session.create_conversation(config).unwrap();
    let submitted = session
        .submit(
            &conversation,
            "review-input",
            InputKind::Prompt,
            "Propose a page",
        )
        .unwrap();
    app.start_legacy_fixture_worker(id.into(), runtime, 2);
    submitted.task_id
}
async fn review(app: &Arc<Host>) -> Review {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(review) = app
                .lock()
                .unwrap()
                .journal
                .objects::<Review>("review")
                .unwrap()
                .into_iter()
                .next()
            {
                return review;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
async fn settled(app: &Arc<Host>, id: &str, task: &str) -> Task {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let task = app.lock().unwrap().profiles[id]
                .runtime
                .session
                .snapshot()
                .unwrap()
                .tasks[task]
                .clone();
            if task.phase.terminal() {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
fn connect_space(app: &Arc<Host>, id: &str, path: &Path, space: &str) {
    documents::initialize(&documents::Space {
        id: space.into(),
        name: "Notes".into(),
        path: path.into(),
        writable: true,
        profiles: vec![id.into()],
    })
    .unwrap();
    app.lock()
        .unwrap()
        .journal
        .put(
            "space",
            space,
            &documents::Space {
                id: space.into(),
                name: "Notes".into(),
                path: path.into(),
                writable: true,
                profiles: vec![id.into()],
            },
        )
        .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn planner_tool_executes_through_durable_runtime_and_records_receipt() {
    let root = tempfile::tempdir().unwrap();
    let (app, id) = setup(
        root.path(),
        ai::ToolCall::new(
            "todo",
            "save_todo",
            json!({"todo":{"title":"모델이 기록한 할 일","notes":"","due":"2026-10-03"}}),
        ),
    );
    let parent = start(&app, &id);
    assert_eq!(settled(&app, &id, &parent).await.phase, Phase::Complete);
    assert_eq!(
        app.snapshot().unwrap()["todos"][0]["title"],
        "모델이 기록한 할 일"
    );
    let session = app.lock().unwrap().profiles[&id].runtime.session.clone();
    let snapshot = session.snapshot().unwrap();
    let effect = snapshot
        .effects
        .values()
        .find(|e| e.name == "save_todo")
        .unwrap();
    assert_eq!(effect.output.as_ref().unwrap().status, ToolStatus::Success);
    drop(session);
    app.shutdown().await.unwrap();
    drop(app);
    let reopened =
        Host::open_legacy_fixture(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    assert_eq!(
        reopened.snapshot().unwrap()["todos"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    reopened.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn review_survives_restart_and_saves_only_after_owner_approval() {
    let root = tempfile::tempdir().unwrap();
    let notes = tempfile::tempdir().unwrap();
    let space = uuid::Uuid::now_v7().to_string();
    let (app, id) = setup(
        root.path(),
        ai::ToolCall::new(
            "review",
            "review_page",
            json!({"space_id":space,"title":"Owner page","body":"Approved content","profile":"pdc-markdown/1"}),
        ),
    );
    connect_space(&app, &id, notes.path(), &space);
    let parent = start(&app, &id);
    let proposed = review(&app).await;
    assert!(documents::list(
        &app.lock()
            .unwrap()
            .journal
            .get::<documents::Space>("space", &space)
            .unwrap()
            .unwrap(),
        ""
    )
    .unwrap()
    .is_empty());
    app.shutdown().await.unwrap();
    drop(app);
    let app = Host::open_legacy_fixture(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let approved = owner(
        &app,
        OwnerAction::DecideReview {
            review_id: proposed.id.clone(),
            approve: true,
        },
    );
    assert_eq!(approved["ok"], true, "{approved}");
    assert_eq!(settled(&app, &id, &parent).await.phase, Phase::Complete);
    let pages = documents::list(
        &app.lock()
            .unwrap()
            .journal
            .get::<documents::Space>("space", &space)
            .unwrap()
            .unwrap(),
        "",
    )
    .unwrap();
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].id.as_deref(), Some(proposed.page_id.as_str()));
    let events = app
        .lock()
        .unwrap()
        .journal
        .objects::<Value>("event")
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["name"], "page_saved");
    assert_eq!(events[0]["document_id"], proposed.page_id);
    let retry = owner(
        &app,
        OwnerAction::DecideReview {
            review_id: proposed.id,
            approve: true,
        },
    );
    assert_eq!(retry["ok"], true);
    assert_eq!(
        app.lock()
            .unwrap()
            .journal
            .objects::<Value>("event")
            .unwrap(),
        events
    );
    assert_eq!(pages.len(), 1);
    app.shutdown().await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_or_revoked_proposals_never_write_a_document() {
    for revoke in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let notes = tempfile::tempdir().unwrap();
        let space = uuid::Uuid::now_v7().to_string();
        let (app, id) = setup(
            root.path(),
            ai::ToolCall::new(
                "review",
                "review_page",
                json!({"space_id":space,"title":"Must not save","body":"draft"}),
            ),
        );
        connect_space(&app, &id, notes.path(), &space);
        let task = start(&app, &id);
        let proposed = review(&app).await;
        if revoke {
            owner(
                &app,
                OwnerAction::SpaceAccess {
                    space_id: space.clone(),
                    writable: true,
                    profiles: vec![],
                },
            );
        } else {
            app.lock().unwrap().profiles[&id]
                .runtime
                .session
                .cancel(&task)
                .unwrap();
        }
        let result = owner(
            &app,
            OwnerAction::DecideReview {
                review_id: proposed.id,
                approve: true,
            },
        );
        assert_eq!(result["ok"], false);
        assert!(documents::list(
            &documents::Space {
                id: space,
                name: "Notes".into(),
                path: notes.path().into(),
                writable: true,
                profiles: vec![]
            },
            ""
        )
        .unwrap()
        .is_empty());
        app.shutdown().await.unwrap();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupted_approved_write_uses_persisted_hash_instead_of_overwriting() {
    let root = tempfile::tempdir().unwrap();
    let notes = tempfile::tempdir().unwrap();
    let space = uuid::Uuid::now_v7().to_string();
    let page_id = uuid::Uuid::now_v7().to_string();
    let s = documents::Space {
        id: space.clone(),
        name: "Notes".into(),
        path: notes.path().into(),
        writable: true,
        profiles: vec![],
    };
    let original = documents::create(
        &s,
        &page_id,
        "Original",
        "old",
        "pdc-markdown/1",
        "2026-01-01T00:00:00.000Z",
    )
    .unwrap();
    let (app, id) = setup(
        root.path(),
        ai::ToolCall::new(
            "review",
            "review_page",
            json!({"space_id":space,"page_id":page_id,"expected_hash":original.hash,"title":"Updated","body":"new"}),
        ),
    );
    connect_space(&app, &id, notes.path(), &space);
    let task = start(&app, &id);
    let mut proposed = review(&app).await;
    let bytes = documents::proposed_source(
        &original,
        &proposed.title,
        &proposed.body,
        &proposed.created,
    )
    .unwrap();
    proposed.state = "approved".into();
    proposed.result = Some(json!({"planned_hash":documents::digest(&bytes)}));
    app.lock()
        .unwrap()
        .journal
        .put("review", &proposed.id, &proposed)
        .unwrap();
    std::fs::write(notes.path().join(&original.locator), &bytes).unwrap();
    app.lock().unwrap().profiles[&id]
        .runtime
        .session
        .cancel(&task)
        .unwrap();
    app.shutdown().await.unwrap();
    drop(app);
    let app = Host::open_legacy_fixture(root.path(), tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let declined = owner(
        &app,
        OwnerAction::DecideReview {
            review_id: proposed.id.clone(),
            approve: false,
        },
    );
    assert_eq!(declined["ok"], false);
    let saved = owner(
        &app,
        OwnerAction::DecideReview {
            review_id: proposed.id,
            approve: true,
        },
    );
    assert_eq!(saved["ok"], true, "{saved}");
    assert_eq!(
        std::fs::read(notes.path().join(&original.locator)).unwrap(),
        bytes
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn backup_restore_checks_integrity_and_refuses_overwrite_or_tampering() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("host");
    let app = Host::open_legacy_fixture(&root, tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let result = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::CreateProfile {
                name: "owner".into(),
                persona: "Keeper".into(),
            },
        })
        .unwrap();
    let id = result["result"]["profile_id"].as_str().unwrap();
    let create = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::CreateConversation {
                profile_id: id.into(),
                model: "mock".into(),
                tools: false,
            },
        })
        .unwrap();
    let conversation = create["result"]["conversation_id"].as_str().unwrap();
    let original = app.lock().unwrap().profiles[id]
        .runtime
        .session
        .snapshot()
        .unwrap();
    let backup = temp.path().join("backup");
    assert_eq!(
        owner(
            &app,
            OwnerAction::Backup {
                destination: backup.to_string_lossy().into()
            }
        )["ok"],
        true
    );
    let restored = temp.path().join("restored");
    operations::restore(&backup, &restored).unwrap();
    assert!(operations::restore(&backup, &root).is_err());
    let copy = Host::open_legacy_fixture(&restored, tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let snapshot = copy.lock().unwrap().profiles[id]
        .runtime
        .session
        .snapshot()
        .unwrap();
    assert_eq!(
        snapshot.conversations[conversation].id,
        original.conversations[conversation].id
    );
    copy.shutdown().await.unwrap();
    std::fs::write(backup.join("workspace.db"), b"tampered").unwrap();
    assert!(operations::restore(&backup, &temp.path().join("damaged")).is_err());
    assert!(!temp.path().join("damaged").exists());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn delegated_file_authority_is_intersection_and_revocation_is_immediate() {
    let temp = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let target = files.path().join("note.txt");
    std::fs::write(&target, "private").unwrap();
    let (app, sender) = setup(
        temp.path(),
        ai::ToolCall::new("noop", "read_file", json!({"path":target})),
    );
    let recipient =
        Host::profile(ProfileStore::create_profile(temp.path(), "specialist", "Analyst").unwrap())
            .unwrap();
    let id = recipient.id.clone();
    let session = recipient.runtime.session.clone();
    app.lock().unwrap().profiles.insert(id.clone(), recipient);
    let source_session = app.lock().unwrap().profiles[&sender]
        .runtime
        .session
        .clone();
    let source_convo = source_session
        .create_conversation(host::durable::AgentConfig::new(
            host::mock_model(),
            "sender",
        ))
        .unwrap();
    let source = source_session
        .submit(&source_convo, "input", InputKind::Prompt, "analyze")
        .unwrap();
    let mut config = host::durable::AgentConfig::new(host::mock_model(), "recipient");
    config.tools = host::tool_definitions();
    config.tools.extend(services::role_tool_definitions(&app, services::ToolRole::Ordinary));
    let convo = session.create_conversation(config).unwrap();
    let input = session
        .submit(&convo, "child", InputKind::Prompt, "read")
        .unwrap();
    let task = session.snapshot().unwrap().tasks[&input.task_id].clone();
    app.lock()
        .unwrap()
        .journal
        .put(
            "delegation",
            "delegation",
            &Delegation {
                id: "delegation".into(),
                owner: sender.clone(),
                owner_task: source.task_id,
                target: id.clone(),
                conversation_id: convo,
                task_id: input.task_id,
                background: false,
                state: "running".into(),
                config: None,
            },
        )
        .unwrap();
    let bridge = services::Bridge {
        owner: id.clone(),
        host: Arc::downgrade(&app),
    };
    let call = ai::ToolCall::new("read", "read_file", json!({"path":target}));
    app.lock().unwrap().profiles[&id]
        .host
        .store
        .lock()
        .unwrap()
        .allow(files.path(), "read")
        .unwrap();
    assert!(
        bridge.admit_tool(&task, &call).is_err(),
        "recipient grant escalated sender authority"
    );
    let grant = app.lock().unwrap().profiles[&sender]
        .host
        .store
        .lock()
        .unwrap()
        .allow(files.path(), "read")
        .unwrap();
    assert!(bridge.admit_tool(&task, &call).is_ok());
    app.lock().unwrap().profiles[&sender]
        .host
        .store
        .lock()
        .unwrap()
        .revoke(grant.id)
        .unwrap();
    assert!(bridge.admit_tool(&task, &call).is_err());
    let memory = ai::ToolCall::new("memory", "memory_search", json!({"query":"private"}));
    assert!(bridge.admit_tool(&task, &memory).is_err());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn responsibility_dependencies_and_events_wait_for_owner_verification() {
    let temp = tempfile::tempdir().unwrap();
    let (app, id) = setup(
        temp.path(),
        ai::ToolCall::new("unused", "read_file", json!({"path":"/unused"})),
    );
    let first = owner(
        &app,
        OwnerAction::Goal {
            profile_id: id.clone(),
            title: "First".into(),
            criteria: "Owner checks evidence".into(),
            instruction: "Analyze".into(),
            dependencies: vec![],
            event: Some("ready".into()),
        },
    )["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let second = owner(
        &app,
        OwnerAction::Goal {
            profile_id: id.clone(),
            title: "Second".into(),
            criteria: "Owner checks second".into(),
            instruction: "Then analyze".into(),
            dependencies: vec![first.clone()],
            event: None,
        },
    )["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    app.dispatch_due(&id, now_ms()).unwrap();
    assert!(app
        .lock()
        .unwrap()
        .journal
        .get::<Goal>("goal", &first)
        .unwrap()
        .unwrap()
        .task_id
        .is_none());
    owner(
        &app,
        OwnerAction::Event {
            profile_id: id.clone(),
            name: "ready".into(),
        },
    );
    app.dispatch_due(&id, now_ms()).unwrap();
    assert!(app
        .lock()
        .unwrap()
        .journal
        .get::<Goal>("goal", &first)
        .unwrap()
        .unwrap()
        .task_id
        .is_some());
    assert!(app
        .lock()
        .unwrap()
        .journal
        .get::<Goal>("goal", &second)
        .unwrap()
        .unwrap()
        .task_id
        .is_none());
    assert_eq!(
        owner(
            &app,
            OwnerAction::GoalState {
                goal_id: first.clone(),
                state: "complete".into(),
                evidence: vec![]
            }
        )["ok"],
        false
    );
    assert_eq!(
        owner(
            &app,
            OwnerAction::GoalState {
                goal_id: first,
                state: "complete".into(),
                evidence: vec!["Owner inspected result".into()]
            }
        )["ok"],
        true
    );
    app.dispatch_due(&id, now_ms()).unwrap();
    assert!(app
        .lock()
        .unwrap()
        .journal
        .get::<Goal>("goal", &second)
        .unwrap()
        .unwrap()
        .task_id
        .is_some());
    app.shutdown().await.unwrap();
}

#[test]
fn service_configuration_is_explicit_and_escaped() {
    let spec = operations::service_spec(
        Path::new("/tmp/Ghost & Notes"),
        Path::new("/tmp/ghost"),
        62062,
        "mock",
        "launchd",
        true,
    )
    .unwrap();
    assert!(spec.contains("Ghost &amp; Notes") && spec.contains("com.a7.ghost"));
    assert!(spec.contains("<string>run</string>") && !spec.contains("--headless"));
    let systemd = operations::service_spec(
        Path::new("/tmp/%i $root"),
        Path::new("/tmp/ghost"),
        62062,
        "mock",
        "systemd",
        true,
    )
    .unwrap();
    assert!(systemd.contains("%%i $$root") && systemd.contains("Restart=on-failure"));
    assert!(operations::service_spec(
        Path::new("relative"),
        Path::new("/tmp/ghost"),
        0,
        "mock",
        "launchd",
        true
    )
    .is_err());
}

#[tokio::test]
async fn collaboration_protocol_preserves_exact_retries_versions_and_cursor_after_restart() {
    use crate::domain::protocol::{Event, VERSION};
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("journal.db");
    let journal = Journal::open(&path).unwrap();
    let record = Delegation {
        id: "effect-key".into(),
        owner: uuid::Uuid::new_v4().to_string(),
        target: uuid::Uuid::new_v4().to_string(),
        owner_task: uuid::Uuid::new_v4().to_string(),
        conversation_id: uuid::Uuid::new_v4().to_string(),
        task_id: uuid::Uuid::new_v4().to_string(),
        background: false,
        state: "running".into(),
        config: None,
    };
    let event = Event::Requested {
        prompt: "Analyze only".into(),
        background: false,
    };
    let first = journal
        .message(&record, "requested", event.clone())
        .unwrap();
    let repeat = journal.message(&record, "requested", event).unwrap();
    assert_eq!(first.message_id, repeat.message_id);
    assert_eq!(first.created_ms, repeat.created_ms);
    assert_eq!(first.sequence, 1);
    assert_eq!(first.protocol, VERSION);
    assert!(journal
        .message(
            &record,
            "requested",
            Event::Requested {
                prompt: "Write instead".into(),
                background: false
            }
        )
        .is_err());
    let second = journal
        .message(
            &record,
            "accepted",
            Event::Accepted {
                conversation_id: record.conversation_id.clone(),
                task_id: record.task_id.clone(),
            },
        )
        .unwrap();
    assert_eq!(second.sequence, 2);
    assert_eq!(second.from, record.target);
    assert_eq!(second.to, record.owner);
    drop(journal);
    let journal = Journal::open(&path).unwrap();
    let read = journal.messages(&record.id, 1).unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].message_id, second.message_id);
    let mut redirected = record.clone();
    redirected.target = uuid::Uuid::new_v4().to_string();
    assert!(journal
        .message(&redirected, "accepted", second.event.clone())
        .is_err());
    assert!(Event::Accepted {
        conversation_id: "invalid".into(),
        task_id: record.task_id.clone()
    }
    .validate()
    .is_err());
    assert!(Event::Result {
        conversation_id: record.conversation_id.clone(),
        task_id: record.task_id.clone(),
        phase: Phase::Queued,
        summary: "unfinished".into(),
        artifacts: vec![]
    }
    .validate()
    .is_err());
    let mut unsupported = read[0].clone();
    unsupported.protocol = "ghost-collaboration/2".into();
    assert!(unsupported.validate().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repaired_profile_reloads_committed_work_without_stopping_other_ghosts() {
    let root = tempfile::tempdir().unwrap();
    let (app, id) = setup(
        root.path(),
        ai::ToolCall::new("inspect", "list_spaces", json!({})),
    );
    let runtime = app.lock().unwrap().profiles[&id].runtime.clone();
    let conversation = runtime
        .session
        .create_conversation(host::durable::AgentConfig::new(
            host::mock_model(),
            "Repair test",
        ))
        .unwrap();
    let accepted = runtime
        .session
        .submit(
            &conversation,
            "queued-before-fault",
            InputKind::Prompt,
            "Resume committed work",
        )
        .unwrap();
    let db = rusqlite::Connection::open(root.path().join("profiles/writer/durable.db")).unwrap();
    db.execute_batch("CREATE TRIGGER simulated_fault BEFORE UPDATE ON durable_meta BEGIN SELECT RAISE(FAIL,'simulated storage fault'); END;").unwrap();
    app.start_legacy_fixture_worker(id.clone(), runtime.clone(), 2);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if app.lock().unwrap().profiles[&id].error.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let fault = app.snapshot().unwrap();
    assert!(fault["profiles"][0]["policy"].is_object());
    assert!(runtime.session.committed().is_err());
    let healthy = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::CreateProfile {
                name: "healthy".into(),
                persona: "Independent".into(),
            },
        })
        .unwrap();
    assert_eq!(healthy["ok"], true);
    let other = healthy["result"]["profile_id"]
        .as_str()
        .unwrap()
        .to_string();
    let other_conversation = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::CreateConversation {
                profile_id: other.clone(),
                model: "mock".into(),
                tools: false,
            },
        })
        .unwrap()["result"]["conversation_id"]
        .as_str()
        .unwrap()
        .to_string();
    let submit = app
        .action(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Submit {
                profile_id: other.clone(),
                conversation_id: other_conversation,
                prompt: "Still running".into(),
                kind: InputKind::Prompt,
            },
        })
        .unwrap();
    assert_eq!(
        settled(&app, &other, submit["result"]["task_id"].as_str().unwrap())
            .await
            .phase,
        Phase::Complete
    );
    let repair = || Action {
        request_id: uuid::Uuid::new_v4().to_string(),
        command: Command::Workspace {
            action: OwnerAction::RecoverProfile {
                profile_id: id.clone(),
            },
        },
    };
    assert_eq!(app.action_async(repair()).await.unwrap()["ok"], false);
    db.execute_batch("DROP TRIGGER simulated_fault;").unwrap();
    assert_eq!(app.action_async(repair()).await.unwrap()["ok"], true);
    assert_eq!(
        settled(&app, &id, &accepted.task_id).await.phase,
        Phase::Complete
    );
    assert!(app.lock().unwrap().profiles[&id].error.is_none());
    assert_eq!(app.action_async(repair()).await.unwrap()["ok"], false);
    assert_eq!(app.profile_workers.lock().unwrap().len(), 2);
    app.shutdown().await.unwrap();
}
