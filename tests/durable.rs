#![cfg(feature = "durable-runtime")]
use ghost::{
    durable::{
        self as host,
        durable::{self, ai, Host, InputKind, Phase, Runtime, SingleProvider, ToolStatus},
    },
    store::ProfileStore,
};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

struct FileModel {
    path: String,
    turn: std::sync::atomic::AtomicUsize,
    write: bool,
}
impl ai::Provider for FileModel {
    fn stream<'a>(
        &'a self,
        m: &'a ai::Model,
        _: &'a ai::Context,
        _: Option<ai::StreamOptions>,
    ) -> Pin<Box<dyn Future<Output = ai::prelude::StreamResult> + Send + 'a>> {
        Box::pin(async move {
            let turn = self.turn.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut msg = ai::AssistantMessage::new(m.api, &m.provider, &m.id);
            if turn < 2 {
                let call = if self.write {
                    ai::ToolCall::new(
                        format!("call-{turn}"),
                        "write_file",
                        serde_json::json!({"path":self.path,"content":"durable effect"}),
                    )
                } else {
                    ai::ToolCall::new(
                        format!("call-{turn}"),
                        "read_file",
                        serde_json::json!({"path":self.path}),
                    )
                };
                msg.content.push(ai::ContentBlock::ToolCall(call));
            } else {
                msg.content
                    .push(ai::ContentBlock::Text(ai::TextContent::new("complete")));
            }
            Ok(
                Box::pin(futures::stream::iter(vec![ai::ProviderEvent::Done {
                    reason: ai::StopReason::Stop,
                    message: msg,
                }]))
                    as Pin<Box<dyn futures::Stream<Item = ai::ProviderEvent> + Send>>,
            )
        })
    }
}
#[tokio::test]
async fn ghost_write_uses_current_grants_and_reuses_one_effect_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("ghost");
    let workspace = dir.path().join("files");
    std::fs::create_dir(&workspace).unwrap();
    let store = ProfileStore::create_profile(&root, "a", "persona").unwrap();
    let grant = store.allow(&workspace, "write").unwrap();
    let config = host::config(&store, None, true).unwrap();
    let session = durable::Session::open(store.dir.join("durable.db")).unwrap();
    let convo = session.create_conversation(config).unwrap();
    let file = workspace.join("created.txt");
    let store = Arc::new(Mutex::new(store));
    let host = Arc::new(host::GhostHost::new(store.clone()));
    let runtime = Runtime::new(
        session,
        Arc::new(SingleProvider(Arc::new(FileModel {
            path: file.to_string_lossy().into(),
            turn: Default::default(),
            write: true,
        }))),
        host.clone(),
    );
    let sub = runtime
        .session
        .submit(&convo, "request", InputKind::Prompt, "create file")
        .unwrap();
    runtime.drive(50).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "durable effect");
    let snap = runtime.session.snapshot().unwrap();
    assert_eq!(snap.effects.len(), 1);
    assert_eq!(snap.tasks[&sub.task_id].phase, Phase::Complete);
    store.lock().unwrap().revoke(grant.id).unwrap();
    let tool = snap
        .tasks
        .values()
        .find(|t| matches!(t.kind, durable::TaskKind::Tool { .. }))
        .unwrap();
    let durable::TaskKind::Tool { call, .. } = &tool.kind else {
        panic!()
    };
    assert!(host.prepare(tool, call).is_err());
}
#[tokio::test]
async fn ghost_state_and_ungranted_paths_are_denied_with_no_effect() {
    for protected in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ghost");
        let store = ProfileStore::create_profile(&root, "a", "persona").unwrap();
        store.allow(dir.path(), "write").unwrap();
        let config = host::config(&store, None, true).unwrap();
        let path = if protected {
            store.dir.join("injected.txt")
        } else {
            dir.path().join("outside.txt")
        };
        if !protected {
            let g = store.grants().unwrap()[0].id;
            store.revoke(g).unwrap();
        }
        let s = durable::Session::open(store.dir.join("durable.db")).unwrap();
        let c = s.create_conversation(config).unwrap();
        let r = Runtime::new(
            s,
            Arc::new(SingleProvider(Arc::new(FileModel {
                path: path.to_string_lossy().into(),
                turn: Default::default(),
                write: true,
            }))),
            Arc::new(host::GhostHost::new(Arc::new(Mutex::new(store)))),
        );
        r.session
            .submit(&c, "req", InputKind::Prompt, "write")
            .unwrap();
        r.drive(50).await.unwrap();
        assert!(!path.exists());
        assert!(r.session.snapshot().unwrap().effects.is_empty());
        assert!(r.session.snapshot().unwrap().conversations[&c].entries.iter().any(|e|matches!(&e.kind,durable::EntryKind::Message(ai::Message::ToolResult(t)) if t.is_error)));
    }
}
#[tokio::test]
async fn revoked_read_policy_is_checked_before_actual_execution() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("ghost");
    let file = dir.path().join("data.txt");
    std::fs::write(&file, "data").unwrap();
    let store = ProfileStore::create_profile(&root, "a", "persona").unwrap();
    let grant = store.allow(dir.path(), "read").unwrap();
    let config = host::config(&store, None, true).unwrap();
    let s = durable::Session::open(store.dir.join("durable.db")).unwrap();
    let c = s.create_conversation(config).unwrap();
    let store = Arc::new(Mutex::new(store));
    let h = host::GhostHost::new(store.clone());
    let r = Runtime::new(
        s,
        Arc::new(SingleProvider(Arc::new(FileModel {
            path: file.to_string_lossy().into(),
            turn: Default::default(),
            write: false,
        }))),
        Arc::new(durable::DenyHost),
    );
    r.session
        .submit(&c, "req", InputKind::Prompt, "read")
        .unwrap();
    r.drive(2).await.unwrap();
    let snapshot = r.session.snapshot().unwrap();
    let t = snapshot
        .tasks
        .values()
        .find(|t| t.phase == Phase::ToolReady)
        .unwrap();
    let durable::TaskKind::Tool { call, .. } = &t.kind else {
        panic!()
    };
    let plan = h.prepare(t, call).unwrap();
    store.lock().unwrap().revoke(grant.id).unwrap();
    let output = h.execute(t, call, &plan).await.unwrap();
    assert_eq!(output.status, ToolStatus::Denied);
}
fn cli(root: &std::path::Path, args: &[&str]) -> serde_json::Value {
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_ghost"))
        .arg("--root")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&result.stdout).unwrap()
}
#[test]
fn cli_conversation_survives_separate_processes_and_compacts() {
    let dir = tempfile::tempdir().unwrap();
    cli(
        dir.path(),
        &["profile", "create", "alice", "--persona", "tester"],
    );
    let create = cli(dir.path(), &["conversation", "create", "alice"]);
    let c = create["conversation_id"].as_str().unwrap();
    cli(
        dir.path(),
        &[
            "conversation",
            "submit",
            "alice",
            c,
            "--request-id",
            "1",
            "--prompt",
            "hello",
        ],
    );
    cli(dir.path(), &["conversation", "run", "alice"]);
    cli(
        dir.path(),
        &[
            "conversation",
            "submit",
            "alice",
            c,
            "--request-id",
            "2",
            "--prompt",
            "remember",
            "--kind",
            "follow-up",
        ],
    );
    cli(dir.path(), &["conversation", "run", "alice"]);
    let status = cli(dir.path(), &["conversation", "status", "alice", c]);
    assert_eq!(
        status["conversation"]["entries"].as_array().unwrap().len(),
        4
    );
    cli(
        dir.path(),
        &[
            "conversation",
            "compact",
            "alice",
            c,
            "--request-id",
            "compact",
        ],
    );
    cli(dir.path(), &["conversation", "run", "alice"]);
    let status = cli(dir.path(), &["conversation", "status", "alice", c]);
    assert!(status["conversation"]["summary"].is_string());
    let events = cli(dir.path(), &["conversation", "events", "alice"]);
    assert!(events
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x["event"] == "model_completed"));
}
