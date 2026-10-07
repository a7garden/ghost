#![cfg(feature = "native-fixtures")]
use ghost::native_http::{EndpointApproval, Limits, MemoryCredential, NativeProvider, Preset};
use ghost::provider::{Provider, ProviderRequest};
use ghost::provider_control::{CallFailure, FailureKind, OutcomeClass, RunControl, StreamEvent};
use ghost::provider_journal::{receipt, ProviderRun};
use ghost::store::{ProfileStore, Task};
use ghost::{run_task, run_task_with_control};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tempfile::TempDir;

// Public non-secret fixture string. No environment, config, key-file or API.
const KEY: &str = "public-dummy-native-fixture-12345";
struct Fixture {
    address: SocketAddr,
    count: Arc<AtomicUsize>,
    requests: mpsc::Receiver<String>,
    handle: Option<JoinHandle<()>>,
}
impl Fixture {
    fn start(
        status: u16,
        content_type: &str,
        body: Vec<u8>,
        extra: String,
        delay: Duration,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let counter = count.clone();
        let (sender, requests) = mpsc::channel();
        let content_type = content_type.to_string();
        let handle = thread::spawn(move || {
            let mut deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        counter.fetch_add(1, Ordering::SeqCst);
                        // macOS accepts inherit the listener's nonblocking flag.
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_millis(400)))
                            .unwrap();
                        let request = read_request(&mut stream);
                        let _ = sender.send(request);
                        thread::sleep(delay);
                        let header=format!("HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",body.len());
                        if stream.write_all(header.as_bytes()).is_ok() {
                            // Deliberately split lines and UTF-8 across TCP writes.
                            for chunk in body.chunks(7) {
                                if stream.write_all(chunk).is_err() {
                                    break;
                                }
                            }
                        }
                        deadline = Instant::now() + Duration::from_millis(250);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            address,
            count,
            requests,
            handle: Some(handle),
        }
    }
    fn stream(body: String) -> Self {
        Self::start(
            200,
            "text/event-stream; charset=utf-8",
            body.into_bytes(),
            String::new(),
            Duration::ZERO,
        )
    }
    fn provider(&self, preset: Preset, limits: Limits) -> NativeProvider {
        NativeProvider::new(
            EndpointApproval::fixture(preset, self.address).unwrap(),
            match preset {
                Preset::OpenAi => "fixture-openai",
                Preset::Zai => "fixture-zai",
            }
            .into(),
            MemoryCredential::new(KEY.into()).unwrap(),
            limits,
        )
        .unwrap()
    }
    fn count(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
    fn join(&mut self) {
        self.handle.take().unwrap().join().unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            handle.join().unwrap();
        }
    }
}
fn read_request(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => bytes.extend_from_slice(&chunk[..n]),
        }
        assert!(bytes.len() < 131_072);
        if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
            let header = String::from_utf8_lossy(&bytes[..end]);
            let length = header
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                break;
            }
        }
    }
    String::from_utf8(bytes).unwrap()
}
fn delta(text: &str) -> String {
    format!(
        "data: {}\n\n",
        json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]})
    )
}
fn end(usage: bool) -> String {
    let mut value = format!(
        "data: {}\n\n",
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
    );
    if usage {
        value += &format!(
            "data: {}\n\n",
            json!({"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}})
        );
    }
    value + "data: [DONE]\n\n"
}
fn setup() -> (TempDir, ProfileStore, Task) {
    let temp = TempDir::new().unwrap();
    let store = ProfileStore::create_profile(temp.path(), "a", "Korean assistant").unwrap();
    let session = store.create_session().unwrap();
    let (task, _) = store
        .submit(&session.uuid, "request-1", "안녕", None, None, None)
        .unwrap();
    (temp, store, task)
}
fn assert_no_fixture_value(store: &ProfileStore, run: &ProviderRun) {
    let dump = serde_json::to_string(run).unwrap();
    assert!(!dump.contains(KEY));
    for row in store.outbox().unwrap() {
        assert!(!row.content.as_deref().unwrap_or("").contains(KEY));
    }
    let mut query = store.conn.prepare("SELECT detail FROM audit").unwrap();
    for row in query.query_map([], |r| r.get::<_, String>(0)).unwrap() {
        assert!(!row.unwrap().contains(KEY));
    }
}
fn expect_status(body: String, status: &str) {
    let (_temp, store, task) = setup();
    let mut fixture = Fixture::stream(body);
    let provider = fixture.provider(Preset::OpenAi, Limits::default());
    run_task(&store, &provider, task.id).unwrap();
    assert_eq!(store.task(&task.uuid).unwrap().unwrap().status, status);
    run_task(&store, &provider, task.id).unwrap();
    fixture.join();
    assert_eq!(fixture.count(), 1);
    assert_eq!(store.outbox().unwrap().len(), 1);
    assert_no_fixture_value(&store, &receipt(&store, &task.uuid).unwrap().unwrap());
}

#[test]
fn concurrent_two_presets_keep_ghost_session_and_attempt_correlation() {
    let mut first = Fixture::stream(delta("첫 ghost") + &end(true));
    let mut second = Fixture::stream(delta("두번째 ghost") + &end(true));
    let root = TempDir::new().unwrap();
    let mut jobs = Vec::new();
    for (name, preset, provider) in [
        (
            "alice",
            Preset::OpenAi,
            first.provider(Preset::OpenAi, Limits::default()),
        ),
        (
            "bob",
            Preset::Zai,
            second.provider(Preset::Zai, Limits::default()),
        ),
    ] {
        let path = root.path().to_path_buf();
        jobs.push(thread::spawn(move || {
            let store = ProfileStore::create_profile(&path, name, name).unwrap();
            let session = store.create_session().unwrap();
            let (task, _) = store
                .submit(
                    &session.uuid,
                    "same-message",
                    "independent question",
                    None,
                    None,
                    None,
                )
                .unwrap();
            assert_eq!(run_task(&store, &provider, task.id).unwrap().completed, 1);
            let (duplicate, created) = store
                .submit(
                    &session.uuid,
                    "same-message",
                    "independent question",
                    None,
                    None,
                    None,
                )
                .unwrap();
            assert!(!created);
            assert_eq!(duplicate.uuid, task.uuid);
            assert_eq!(run_task(&store, &provider, task.id).unwrap().completed, 0);
            let run = receipt(&store, &task.uuid).unwrap().unwrap();
            assert_eq!(run.provider_id, preset.id());
            assert_eq!(run.profile_uuid, store.uuid);
            assert_eq!(run.session_uuid, session.uuid);
            assert_eq!(run.task_uuid, task.uuid);
            assert_eq!(run.usage.as_ref().unwrap().total_tokens, 18);
            assert_eq!(store.outbox().unwrap().len(), 1);
            assert_no_fixture_value(&store, &run);
            drop(store);
            let reopened = ProfileStore::open_profile(&path, name).unwrap();
            assert_eq!(
                receipt(&reopened, &task.uuid).unwrap().unwrap().attempt_id,
                run.attempt_id
            );
            run
        }));
    }
    let runs: Vec<_> = jobs.into_iter().map(|j| j.join().unwrap()).collect();
    assert_ne!(runs[0].profile_uuid, runs[1].profile_uuid);
    assert_ne!(runs[0].session_uuid, runs[1].session_uuid);
    assert_ne!(runs[0].attempt_id, runs[1].attempt_id);
    for (fixture, run, path) in [
        (&mut first, &runs[0], "/v1/chat/completions"),
        (&mut second, &runs[1], "/api/paas/v4/chat/completions"),
    ] {
        let request = fixture
            .requests
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(request.starts_with(&format!("POST {path} ")));
        assert!(request
            .to_ascii_lowercase()
            .contains(&format!("x-request-id: {}", run.attempt_id)));
        let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["model"], run.model);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!(!body.to_string().contains(KEY));
        fixture.join();
        assert_eq!(fixture.count(), 1);
    }
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_ghost"))
        .args([
            "--root",
            root.path().to_str().unwrap(),
            "task",
            "provider-receipt",
            "alice",
            &runs[0].task_uuid,
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let cli: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(cli["attempt_id"], runs[0].attempt_id);
}

#[test]
fn split_secret_and_unicode_are_redacted_before_stream_persistence() {
    let (_temp, store, task) = setup();
    let split = KEY.len() / 2;
    let fixture = Fixture::stream(
        ":comment\r\nevent: text\r\nid: ignored\r\nretry: 1\r\n\r\n".to_string()
            + &delta(&format!("한글 {}", &KEY[..split]))
            + &delta(&format!("{} 끝", &KEY[split..]))
            + &end(true),
    );
    let provider = fixture.provider(Preset::OpenAi, Limits::default());
    assert!(!format!("{provider:?}").contains(KEY));
    run_task(&store, &provider, task.id).unwrap();
    assert_eq!(
        store.task(&task.uuid).unwrap().unwrap().output.unwrap(),
        "한글 [REDACTED] 끝"
    );
    let run = receipt(&store, &task.uuid).unwrap().unwrap();
    assert_no_fixture_value(&store, &run);
    assert!(run.events.iter().any(|e| e["kind"] == "text_delta"));
    drop(store);
    for file in std::fs::read_dir(_temp.path().join("profiles/a")).unwrap() {
        let bytes = std::fs::read(file.unwrap().path()).unwrap();
        assert!(!bytes.windows(KEY.len()).any(|b| b == KEY.as_bytes()));
    }
}

#[test]
fn multi_line_sse_and_missing_usage_are_supported() {
    expect_status("data: {\ndata: \"choices\": [{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\n".to_string()+&end(false),"completed");
}
#[test]
fn authentication_and_rate_limit_are_redacted_definitive_failures() {
    for status in [401, 403, 429] {
        let (_temp, store, task) = setup();
        let mut fixture = Fixture::start(
            status,
            "application/json",
            format!("{{\"key\":\"{KEY}\"}}").into_bytes(),
            String::new(),
            Duration::ZERO,
        );
        let provider = fixture.provider(Preset::Zai, Limits::default());
        assert_eq!(run_task(&store, &provider, task.id).unwrap().failed, 1);
        let run = receipt(&store, &task.uuid).unwrap().unwrap();
        assert_no_fixture_value(&store, &run);
        assert!(run.failure.unwrap().contains(if status == 429 {
            "RateLimit"
        } else {
            "Authentication"
        }));
        run_task(&store, &provider, task.id).unwrap();
        fixture.join();
        assert_eq!(fixture.count(), 1);
    }
}
#[test]
fn server_failure_is_uncertain_and_never_retried_after_restart() {
    let (temp, store, task) = setup();
    let mut fixture = Fixture::start(
        503,
        "text/plain",
        KEY.as_bytes().to_vec(),
        String::new(),
        Duration::ZERO,
    );
    let provider = fixture.provider(Preset::OpenAi, Limits::default());
    assert_eq!(run_task(&store, &provider, task.id).unwrap().uncertain, 1);
    drop(store);
    let reopened = ProfileStore::open_profile(temp.path(), "a").unwrap();
    run_task(&reopened, &provider, task.id).unwrap();
    fixture.join();
    assert_eq!(fixture.count(), 1);
    assert_no_fixture_value(&reopened, &receipt(&reopened, &task.uuid).unwrap().unwrap());
}
#[test]
fn redirect_never_transfers_authorization_or_reaches_second_server() {
    let mut recipient = Fixture::stream(delta("unexpected") + &end(false));
    let (_temp, store, task) = setup();
    let mut fixture = Fixture::start(
        307,
        "text/plain",
        KEY.as_bytes().to_vec(),
        format!("Location: http://{}/evil\r\n", recipient.address),
        Duration::ZERO,
    );
    let provider = fixture.provider(Preset::OpenAi, Limits::default());
    assert_eq!(run_task(&store, &provider, task.id).unwrap().uncertain, 1);
    run_task(&store, &provider, task.id).unwrap();
    fixture.join();
    recipient.join();
    assert_eq!(fixture.count(), 1);
    assert_eq!(recipient.count(), 0);
}
#[test]
fn queued_cancel_has_no_network_or_native_attempt() {
    let (_temp, store, task) = setup();
    let mut fixture = Fixture::stream(delta("never") + &end(false));
    let provider = fixture.provider(Preset::OpenAi, Limits::default());
    let control = RunControl::default();
    control.cancellation.cancel();
    assert_eq!(
        run_task_with_control(&store, &provider, task.id, &control)
            .unwrap()
            .cancelled,
        1
    );
    assert_eq!(store.task(&task.uuid).unwrap().unwrap().status, "cancelled");
    assert!(receipt(&store, &task.uuid).unwrap().is_none());
    run_task(&store, &provider, task.id).unwrap();
    fixture.join();
    assert_eq!(fixture.count(), 0);
}
#[test]
fn cancellation_after_received_request_is_uncertain() {
    let (_temp, store, task) = setup();
    let fixture = Fixture::start(
        200,
        "text/event-stream",
        (delta("late") + &end(false)).into_bytes(),
        String::new(),
        Duration::from_millis(180),
    );
    let provider = fixture.provider(Preset::Zai, Limits::default());
    let control = RunControl::default();
    let cancellation = control.cancellation.clone();
    let count = fixture.count.clone();
    let cancel = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        while count.load(Ordering::SeqCst) == 0 {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(2));
        }
        cancellation.cancel();
    });
    assert_eq!(
        run_task_with_control(&store, &provider, task.id, &control)
            .unwrap()
            .uncertain,
        1
    );
    cancel.join().unwrap();
    let run = receipt(&store, &task.uuid).unwrap().unwrap();
    assert!(run.dispatch_started);
    assert!(run.failure.unwrap().contains("Cancelled"));
    run_task(&store, &provider, task.id).unwrap();
    assert_eq!(fixture.count(), 1);
}
#[test]
fn slow_response_deadline_is_uncertain() {
    let (_temp, store, task) = setup();
    let mut fixture = Fixture::start(
        200,
        "text/event-stream",
        (delta("late") + &end(false)).into_bytes(),
        String::new(),
        Duration::from_millis(180),
    );
    let provider = fixture.provider(Preset::OpenAi, Limits::default());
    let control = RunControl {
        timeout: Duration::from_millis(50),
        ..Default::default()
    };
    assert_eq!(
        run_task_with_control(&store, &provider, task.id, &control)
            .unwrap()
            .uncertain,
        1
    );
    assert!(receipt(&store, &task.uuid)
        .unwrap()
        .unwrap()
        .failure
        .unwrap()
        .contains("Timeout"));
    run_task(&store, &provider, task.id).unwrap();
    fixture.join();
    assert_eq!(fixture.count(), 1);
}
#[test]
fn missing_done_and_malformed_streams_are_uncertain() {
    for body in [delta("partial"),delta("partial")+&end(false).replace("data: [DONE]\n\n",""),"data: broken-json\n\n".into(),"data: [DONE]\n\n".into(),"data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[]},\"finish_reason\":null}]}\n\n".into()] {expect_status(body,"uncertain");}
}
#[test]
fn byte_output_event_limits_stop_without_replay() {
    for limits in [
        Limits {
            response_bytes: 24,
            ..Default::default()
        },
        Limits {
            output_bytes: 4,
            ..Default::default()
        },
        Limits {
            events: 1,
            ..Default::default()
        },
    ] {
        let (_temp, store, task) = setup();
        let mut fixture = Fixture::stream(delta("long enough output") + &end(true));
        let provider = fixture.provider(Preset::OpenAi, limits);
        assert_eq!(run_task(&store, &provider, task.id).unwrap().uncertain, 1);
        assert!(receipt(&store, &task.uuid)
            .unwrap()
            .unwrap()
            .failure
            .unwrap()
            .contains("Limit"));
        run_task(&store, &provider, task.id).unwrap();
        fixture.join();
        assert_eq!(fixture.count(), 1);
    }
}
#[test]
fn dispatch_receipt_failure_prevents_http_request() {
    let (_temp, store, task) = setup();
    let mut fixture = Fixture::stream(delta("never") + &end(false));
    let provider = fixture.provider(Preset::OpenAi, Limits::default());
    // Initialize journal without dispatch using an invalid bounded deadline.
    let bad = RunControl {
        timeout: Duration::ZERO,
        ..Default::default()
    };
    run_task_with_control(&store, &provider, task.id, &bad).unwrap();
    let session = store.create_session().unwrap();
    let (next, _) = store
        .submit(
            &session.uuid,
            "observer-failure",
            "second",
            None,
            None,
            None,
        )
        .unwrap();
    store.conn.execute_batch("CREATE TRIGGER fail_dispatch BEFORE INSERT ON provider_events BEGIN SELECT RAISE(FAIL,'fixture'); END;").unwrap();
    assert_eq!(run_task(&store, &provider, next.id).unwrap().failed, 1);
    let run = receipt(&store, &next.uuid).unwrap().unwrap();
    assert!(!run.dispatch_started);
    fixture.join();
    assert_eq!(fixture.count(), 0);
}
#[test]
fn terminal_commit_failure_recovers_uncertain_without_resend() {
    let (temp, store, task) = setup();
    let mut fixture = Fixture::stream(delta("completed remote") + &end(true));
    let provider = fixture.provider(Preset::OpenAi, Limits::default());
    store.conn.execute_batch("CREATE TRIGGER fail_receipt BEFORE INSERT ON outbox BEGIN SELECT RAISE(FAIL,'fixture'); END;").unwrap();
    assert!(run_task(&store, &provider, task.id).is_err());
    assert_eq!(store.task(&task.uuid).unwrap().unwrap().status, "running");
    assert!(store.outbox().unwrap().is_empty());
    assert_eq!(
        receipt(&store, &task.uuid).unwrap().unwrap().attempt_state,
        "dispatched"
    );
    store
        .conn
        .execute_batch("DROP TRIGGER fail_receipt;")
        .unwrap();
    drop(store);
    let reopened = ProfileStore::open_profile(temp.path(), "a").unwrap();
    let run = receipt(&reopened, &task.uuid).unwrap().unwrap();
    assert_eq!(run.status, "uncertain");
    assert!(run.failure.unwrap().contains("interrupted"));
    assert_eq!(
        run_task(&reopened, &provider, task.id).unwrap().completed,
        0
    );
    fixture.join();
    assert_eq!(fixture.count(), 1);
    assert_eq!(reopened.outbox().unwrap().len(), 1);
}
#[test]
fn text_provider_cannot_expand_filesystem_permission() {
    let (temp, store, _) = setup();
    let session = store.create_session().unwrap();
    let destination = temp.path().join("denied.txt");
    let (task, _) = store
        .submit(
            &session.uuid,
            "denied-tool",
            "write request",
            None,
            Some(destination.to_str().unwrap()),
            Some("must not land"),
        )
        .unwrap();
    let fixture = Fixture::stream(delta("model says approved") + &end(true));
    let provider = fixture.provider(Preset::OpenAi, Limits::default());
    let summary = run_task(&store, &provider, task.id).unwrap();
    assert_eq!(
        summary.denied,
        1,
        "summary={summary:?}, task={:?}",
        store.task(&task.uuid).unwrap().unwrap()
    );
    assert!(!destination.exists());
    assert_eq!(
        receipt(&store, &task.uuid).unwrap().unwrap().status,
        "denied"
    );
}
#[test]
fn input_bound_and_invalid_host_ids_fail_before_dispatch() {
    let mut fixture = Fixture::stream(delta("never") + &end(false));
    let provider = fixture.provider(Preset::OpenAi, Limits::default());
    let mut req = ProviderRequest {
        profile_uuid: uuid::Uuid::new_v4().to_string(),
        persona: String::new(),
        session_uuid: uuid::Uuid::new_v4().to_string(),
        task_uuid: uuid::Uuid::new_v4().to_string(),
        message_id: "fixture".into(),
        prompt: "x".repeat(65_537),
    };
    for invalid in [false, true] {
        if invalid {
            req.prompt = "ok".into();
            req.task_uuid = "not-host-uuid".into();
        }
        let mut events = Vec::<StreamEvent>::new();
        let error = provider
            .run_controlled(
                &req,
                &uuid::Uuid::new_v4().to_string(),
                &RunControl::default(),
                &mut |e| {
                    events.push(e.clone());
                    Ok(())
                },
            )
            .err()
            .unwrap();
        let failure = error.downcast_ref::<CallFailure>().unwrap();
        assert_eq!(failure.kind, FailureKind::Configuration);
        assert_eq!(failure.outcome, OutcomeClass::NotSent);
        assert!(events.is_empty());
    }
    fixture.join();
    assert_eq!(fixture.count(), 0);
}

#[test]
fn partial_reported_usage_survives_an_incomplete_stream_as_advisory() {
    let (_temp, store, task) = setup();
    let fixture = Fixture::stream(delta("partial") + &end(true).replace("data: [DONE]\n\n", ""));
    let provider = fixture.provider(Preset::Zai, Limits::default());
    assert_eq!(run_task(&store, &provider, task.id).unwrap().uncertain, 1);
    let run = receipt(&store, &task.uuid).unwrap().unwrap();
    assert_eq!(run.usage.unwrap().total_tokens, 18);
    assert_eq!(run.status, "uncertain");
}

#[test]
fn stream_observer_db_failure_after_dispatch_is_uncertain() {
    let (_temp, store, first) = setup();
    let mut fixture = Fixture::stream(delta(&"remote output ".repeat(10)) + &end(true));
    let provider = fixture.provider(Preset::OpenAi, Limits::default());
    run_task_with_control(
        &store,
        &provider,
        first.id,
        &RunControl {
            timeout: Duration::ZERO,
            ..Default::default()
        },
    )
    .unwrap();
    let session = store.create_session().unwrap();
    let (task, _) = store
        .submit(
            &session.uuid,
            "stream-observer",
            "question",
            None,
            None,
            None,
        )
        .unwrap();
    store.conn.execute_batch("CREATE TRIGGER fail_delta BEFORE INSERT ON provider_events WHEN json_extract(NEW.event_json,'$.kind')='text_delta' BEGIN SELECT RAISE(FAIL,'fixture'); END;").unwrap();
    assert_eq!(run_task(&store, &provider, task.id).unwrap().uncertain, 1);
    let run = receipt(&store, &task.uuid).unwrap().unwrap();
    assert!(run.dispatch_started);
    assert!(run.failure.unwrap().contains("Observer"));
    run_task(&store, &provider, task.id).unwrap();
    fixture.join();
    assert_eq!(fixture.count(), 1);
}

#[test]
fn non_sse_success_is_uncertain_without_parsing_or_logging_body() {
    let (_temp, store, task) = setup();
    let fixture = Fixture::start(
        200,
        "application/json",
        KEY.as_bytes().to_vec(),
        String::new(),
        Duration::ZERO,
    );
    let provider = fixture.provider(Preset::OpenAi, Limits::default());
    assert_eq!(run_task(&store, &provider, task.id).unwrap().uncertain, 1);
    assert_no_fixture_value(&store, &receipt(&store, &task.uuid).unwrap().unwrap());
}
