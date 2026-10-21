#![cfg(all(feature = "lifetime", unix))]

use ghost::worker::guest_broker::{
    GuestBrokerAuthorizationCheck, GuestBrokerConfig, GuestBrokerError, GuestModelBroker, GuestModelBackend,
};
use ghost::worker::subscription_bridge::SubscriptionBridgeConfig;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    os::unix::fs::{symlink, PermissionsExt},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use uuid::Uuid;

const MODEL_PIN: &str = "mlx-community/Qwen3.6-35B-A3B-4bit";

struct ModelFixture {
    address: SocketAddr,
    calls: Arc<AtomicUsize>,
    stopping: Arc<AtomicBool>,
    released: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl ModelFixture {
    fn start(
        block_response: bool,
        on_request: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let stopping = Arc::new(AtomicBool::new(false));
        let released = Arc::new(AtomicBool::new(false));
        let thread_calls = Arc::clone(&calls);
        let thread_stopping = Arc::clone(&stopping);
        let thread_released = Arc::clone(&released);
        let response_body = completion_json().into_bytes();
        let worker = thread::spawn(move || {
            while !thread_stopping.load(Ordering::Acquire) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => break,
                };
                // Darwin accept inherits the listener's nonblocking flag.
                stream.set_nonblocking(false).unwrap();
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                if read_http_request(&mut stream).is_err() {
                    continue;
                }
                thread_calls.fetch_add(1, Ordering::AcqRel);
                if let Some(callback) = &on_request {
                    callback();
                }
                if block_response {
                    while !thread_released.load(Ordering::Acquire)
                        && !thread_stopping.load(Ordering::Acquire)
                    {
                        thread::sleep(Duration::from_millis(10));
                    }
                }
                let headers = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    response_body.len()
                );
                let _ = stream.write_all(headers.as_bytes());
                let _ = stream.write_all(&response_body);
                let _ = stream.flush();
            }
        });
        Self {
            address,
            calls,
            stopping,
            released,
            thread: Some(worker),
        }
    }

    fn call_count(&self) -> usize {
        self.calls.load(Ordering::Acquire)
    }

    fn wait_for_calls(&self, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.call_count() < expected {
            assert!(Instant::now() < deadline, "simulated model fixture was not called");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn release_response(&self) {
        self.released.store(true, Ordering::Release);
    }
}

impl Drop for ModelFixture {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        self.release_response();
        if let Some(worker) = self.thread.take() {
            let _ = worker.join();
        }
    }
}

fn read_http_request(stream: &mut TcpStream) -> io::Result<()> {
    let mut request = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let header_end = request.windows(4).position(|window| window == b"\r\n\r\n");
        if let Some(header_end) = header_end {
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing content length"))?;
            let required = header_end + 4 + content_length;
            while request.len() < required {
                let count = stream.read(&mut chunk)?;
                if count == 0 {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "short request"));
                }
                request.extend_from_slice(&chunk[..count]);
                if request.len() > 3 * 1024 * 1024 {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "request too large"));
                }
            }
            return Ok(());
        }
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "short headers"));
        }
        request.extend_from_slice(&chunk[..count]);
        if request.len() > 3 * 1024 * 1024 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "headers too large"));
        }
    }
}

fn completion_json() -> String {
    json!({
        "id": "chatcmpl-c2b-fixture",
        "object": "chat.completion",
        "created": 1,
        "model": MODEL_PIN,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "fixture completion"},
            "finish_reason": "stop"
        }]
    })
    .to_string()
}

fn config(root: &TempDir, fixture: &ModelFixture) -> GuestBrokerConfig {
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let request_directory = root.path().join("requests");
    let response_directory = root.path().join("responses");
    fs::create_dir(&request_directory).unwrap();
    fs::create_dir(&response_directory).unwrap();
    fs::set_permissions(&request_directory, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&response_directory, fs::Permissions::from_mode(0o700)).unwrap();
    GuestBrokerConfig {
        version: 1,
        execution_id: "execution-model-broker-fixture".into(),
        authority_epoch: 1,
        request_directory: request_directory.canonicalize().unwrap(),
        response_directory: response_directory.canonicalize().unwrap(),
        journal_path: root.path().canonicalize().unwrap().join("guest-broker.sqlite"),
        backend: GuestModelBackend::LocalHttp { endpoint: format!("http://{}/v1", fixture.address) },
        model_id: MODEL_PIN.into(),
        model_pin: MODEL_PIN.into(),
        max_tokens: 64,
        context_window: 1024,
        allowed_tools: vec!["read".into(), "write".into(), "edit".into(), "bash".into(), "grep".into(),
            "glob".into(), "ast_grep".into(), "ast_edit".into(), "eval".into(), "todo".into(), "publish_artifact".into()],
        deadline_ms: 5_000,
        max_requests: 4,
    }
}

fn native_config(root: &TempDir) -> (GuestBrokerConfig, PathBuf) {
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root_path = root.path().canonicalize().unwrap();
    let request_directory = root_path.join("requests");
    let response_directory = root_path.join("responses");
    let home_directory = root_path.join("native-home");
    let sdk_package_root = root_path.join("sdk");
    for directory in [&request_directory, &response_directory, &home_directory, &sdk_package_root] {
        fs::create_dir(directory).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let entry = root_path.join("native-bridge.sh");
    fs::write(
        &entry,
        r#"#!/bin/sh
IFS= read -r configure || exit 1
printf '%s\n' '{"version":1,"kind":"ready","sdk_version":"18.8.6","provider":"openai-codex","model_id":"gpt-6-luna","thinking":"max","resolved_reasoning":"max"}'
IFS= read -r request || exit 1
: > "$HOME/dispatched"
printf '%s\n' '{}'
exec /bin/sleep 30
"#,
    ).unwrap();
    fs::set_permissions(&entry, fs::Permissions::from_mode(0o600)).unwrap();
    let auth_file = root_path.join("empty-auth.sqlite");
    fs::write(&auth_file, b"").unwrap();
    fs::set_permissions(&auth_file, fs::Permissions::from_mode(0o600)).unwrap();
    let bridge = SubscriptionBridgeConfig {
        executable: PathBuf::from("/bin/sh").canonicalize().unwrap(),
        entry: entry.canonicalize().unwrap(),
        sdk_package_root,
        auth_file,
        home_directory: home_directory.clone(),
    };
    (
        GuestBrokerConfig {
            version: 1,
            execution_id: "execution-native-payload-fixture".into(),
            authority_epoch: 1,
            request_directory,
            response_directory,
            journal_path: root_path.join("native-payload.sqlite"),
            backend: GuestModelBackend::SubscriptionNative(Arc::new(bridge)),
            model_id: "gpt-6-luna".into(),
            model_pin: "gpt-6-luna".into(),
            max_tokens: 1024,
            context_window: 272_000,
            allowed_tools: vec![
                "read".into(), "write".into(), "edit".into(), "bash".into(), "grep".into(),
                "glob".into(), "ast_grep".into(), "ast_edit".into(), "eval".into(), "todo".into(),
                "publish_artifact".into(),
            ],
            deadline_ms: 180_000,
            max_requests: 16,
        },
        home_directory.join("dispatched"),
    )
}

fn authorization(
    config: &GuestBrokerConfig,
    enabled: Arc<AtomicBool>,
) -> GuestBrokerAuthorizationCheck {
    let execution_id = config.execution_id.clone();
    let authority_epoch = config.authority_epoch;
    Arc::new(move |candidate, epoch| {
        enabled.load(Ordering::Acquire)
            && candidate == execution_id.as_str()
            && epoch == authority_epoch
    })
}

fn payload(content: &str) -> String {
    json!({
        "model": MODEL_PIN,
        "messages": [{"role": "user", "content": content}],
        "stream": true,
        "max_tokens": 64
    })
    .to_string()
}

fn native_payload(model_id: &str, role: &str, content: &str) -> String {
    json!({
        "modelId": model_id,
        "context": {
            "messages": [{"role": role, "content": [{"type": "text", "text": content}]}]
        },
        "options": {"maxTokens": 1024, "reasoning": "max"},
        "stream": true
    }).to_string()
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn write_request(
    config: &GuestBrokerConfig,
    request_id: &str,
    execution_id: &str,
    authority_epoch: u64,
    payload_json: &str,
    payload_sha256: &str,
) {
    let request = json!({
        "version": 1,
        "request_id": request_id,
        "execution_id": execution_id,
        "authority_epoch": authority_epoch,
        "payload_json": payload_json,
        "payload_sha256": payload_sha256
    });
    fs::write(
        config.request_directory.join(format!("{request_id}.request.json")),
        serde_json::to_vec(&request).unwrap(),
    )
    .unwrap();
}

fn write_valid_request(config: &GuestBrokerConfig, request_id: &str, payload_json: &str) -> String {
    let payload_sha256 = digest(payload_json.as_bytes());
    write_request(
        config,
        request_id,
        &config.execution_id,
        config.authority_epoch,
        payload_json,
        &payload_sha256,
    );
    payload_sha256
}

fn response_path(config: &GuestBrokerConfig, request_id: &str) -> PathBuf {
    config.response_directory.join(format!("{request_id}.response.json"))
}

fn wait_for_response(config: &GuestBrokerConfig, request_id: &str) -> Value {
    let path = response_path(config, request_id);
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        if let Ok(bytes) = fs::read(&path) {
            return serde_json::from_slice(&bytes).unwrap();
        }
        assert!(Instant::now() < deadline, "broker response did not arrive");
        thread::sleep(Duration::from_millis(10));
    }
}

fn assert_no_response(config: &GuestBrokerConfig, request_id: &str) {
    let path = response_path(config, request_id);
    let deadline = Instant::now() + Duration::from_millis(250);
    while Instant::now() < deadline {
        assert!(!path.exists(), "broker published a response without authority");
        thread::sleep(Duration::from_millis(10));
    }
}

fn write_cancel(config: &GuestBrokerConfig, request_id: &str, payload_sha256: &str) {
    fs::write(
        config.request_directory.join(format!("{request_id}.cancel.json")),
        serde_json::to_vec(&json!({
            "version": 1,
            "request_id": request_id,
            "payload_sha256": payload_sha256
        }))
        .unwrap(),
    )
    .unwrap();
}

fn start_broker(config: GuestBrokerConfig, enabled: Arc<AtomicBool>) -> GuestModelBroker {
    let check = authorization(&config, enabled);
    GuestModelBroker::start(Arc::new(config), check).unwrap()
}

#[test]
fn foreign_and_forged_requests_do_not_reach_the_model_route() {
    let root = TempDir::new().unwrap();
    let fixture = ModelFixture::start(false, None);
    let config = config(&root, &fixture);
    let payload_json = payload("reject unbound request");
    let good_digest = digest(payload_json.as_bytes());
    let foreign_id = "00000000-0000-4000-8000-000000000001";
    let forged_id = "00000000-0000-4000-8000-000000000002";
    let unsupported_id = "00000000-0000-4000-8000-000000000003";
    let mut unsupported_value: Value = serde_json::from_str(&payload_json).unwrap();
    unsupported_value["reasoning_effort"] = json!("high");
    let unsupported_payload = unsupported_value.to_string();
    let unsupported_digest = digest(unsupported_payload.as_bytes());
    write_request(
        &config,
        foreign_id,
        "foreign-execution",
        config.authority_epoch,
        &payload_json,
        &good_digest,
    );
    write_request(
        &config,
        forged_id,
        &config.execution_id,
        config.authority_epoch,
        &payload_json,
        &"0".repeat(64),
    );
    write_request(
        &config,
        unsupported_id,
        &config.execution_id,
        config.authority_epoch,
        &unsupported_payload,
        &unsupported_digest,
    );
    let mut broker = start_broker(config.clone(), Arc::new(AtomicBool::new(true)));
    assert_no_response(&config, foreign_id);
    assert_no_response(&config, forged_id);
    let rejected = wait_for_response(&config, unsupported_id);
    assert_eq!(rejected["status"], "rejected");
    assert_eq!(rejected["reason_code"], "invalid_payload");
    assert_eq!(fixture.call_count(), 0);
    broker.stop().unwrap();
}

#[test]
fn guest_cannot_change_or_expand_native_chat_template_policy() {
    let root = TempDir::new().unwrap();
    let fixture = ModelFixture::start(false, None);
    let mut config = config(&root, &fixture);
    config.max_requests = 16;
    let mut value: Value = serde_json::from_str(&payload("reject changed template policy")).unwrap();
    let mut broker = start_broker(config.clone(), Arc::new(AtomicBool::new(true)));
    for (preserve, kwargs) in [
        (Some(json!(true)), None),
        (None, Some(json!({"preserve_thinking": true}))),
        (Some(json!(false)), Some(json!({"preserve_thinking": false}))),
        (Some(json!(true)), Some(json!({"preserve_thinking": true, "enable_thinking": false}))),
        (Some(json!(true)), Some(json!({"preserve_thinking": "true"}))),
    ] {
        let fields = value.as_object_mut().unwrap();
        fields.remove("preserve_thinking");
        fields.remove("chat_template_kwargs");
        if let Some(preserve) = preserve {
            fields.insert("preserve_thinking".into(), preserve);
        }
        if let Some(kwargs) = kwargs {
            fields.insert("chat_template_kwargs".into(), kwargs);
        }
        let request_id = Uuid::new_v4().to_string();
        write_valid_request(&config, &request_id, &value.to_string());
        let rejected = wait_for_response(&config, &request_id);
        assert_eq!(rejected["status"], "rejected");
        assert_eq!(rejected["reason_code"], "invalid_payload");
        assert_eq!(fixture.call_count(), 0);
    }
    broker.stop().unwrap();
}

#[test]
fn changed_bytes_under_a_completed_request_id_conflict_without_second_inference() {
    let root = TempDir::new().unwrap();
    let fixture = ModelFixture::start(false, None);
    let config = config(&root, &fixture);
    let request_id = Uuid::new_v4().to_string();
    let original = payload("original bytes");
    let original_digest = write_valid_request(&config, &request_id, &original);
    let mut broker = start_broker(config.clone(), Arc::new(AtomicBool::new(true)));
    let first = wait_for_response(&config, &request_id);
    assert_eq!(first["status"], "completed", "first broker response: {first}");
    let first_bytes = fs::read(response_path(&config, &request_id)).unwrap();

    let changed = payload("changed bytes under same id");
    let changed_digest = digest(changed.as_bytes());
    assert_ne!(changed_digest, original_digest);
    write_request(
        &config,
        &request_id,
        &config.execution_id,
        config.authority_epoch,
        &changed,
        &changed_digest,
    );
    thread::sleep(Duration::from_millis(150));
    assert_eq!(fixture.call_count(), 1);
    assert_eq!(fs::read(response_path(&config, &request_id)).unwrap(), first_bytes);
    broker.stop().unwrap();
}

#[test]
fn newly_arriving_request_is_observed_without_replaying_completed_request() {
    let root = TempDir::new().unwrap();
    let fixture = ModelFixture::start(false, None);
    let config = config(&root, &fixture);
    let first_id = Uuid::new_v4().to_string();
    write_valid_request(&config, &first_id, &payload("first request"));
    let mut broker = start_broker(config.clone(), Arc::new(AtomicBool::new(true)));
    let first = wait_for_response(&config, &first_id);
    assert_eq!(first["status"], "completed", "first response: {first}");

    let second_id = Uuid::new_v4().to_string();
    write_valid_request(&config, &second_id, &payload("new request after initial scan"));
    let second = wait_for_response(&config, &second_id);
    assert_eq!(second["status"], "completed", "second response: {second}");
    assert_eq!(second["request_id"], second_id);
    assert_eq!(fixture.call_count(), 2);
    broker.stop().unwrap();
}

#[test]
fn exact_completed_replay_reuses_the_immutable_receipt_without_inference() {
    let root = TempDir::new().unwrap();
    let fixture = ModelFixture::start(false, None);
    let config = config(&root, &fixture);
    let request_id = Uuid::new_v4().to_string();
    let payload_json = payload("same id and bytes");
    write_valid_request(&config, &request_id, &payload_json);
    let mut broker = start_broker(config.clone(), Arc::new(AtomicBool::new(true)));
    let first = wait_for_response(&config, &request_id);
    let first_bytes = fs::read(response_path(&config, &request_id)).unwrap();
    assert_eq!(first["status"], "completed");

    write_valid_request(&config, &request_id, &payload_json);
    let replay = wait_for_response(&config, &request_id);
    assert_eq!(replay, first);
    assert_eq!(fs::read(response_path(&config, &request_id)).unwrap(), first_bytes);
    assert_eq!(fixture.call_count(), 1);
    broker.stop().unwrap();
}

#[test]
fn corrupted_completed_receipt_fails_closed_on_replay() {
    let root = TempDir::new().unwrap();
    let fixture = ModelFixture::start(false, None);
    let config = config(&root, &fixture);
    let request_id = Uuid::new_v4().to_string();
    let payload_json = payload("validate persisted completion digest");
    let payload_sha256 = write_valid_request(&config, &request_id, &payload_json);
    let mut broker = start_broker(config.clone(), Arc::new(AtomicBool::new(true)));
    let first = wait_for_response(&config, &request_id);
    let completion = first["completion_json"].as_str().unwrap();
    assert_eq!(first["response_sha256"], digest(completion.as_bytes()));
    broker.stop().unwrap();

    fs::remove_file(response_path(&config, &request_id)).unwrap();
    let journal = Connection::open(&config.journal_path).unwrap();
    let mut corrupted = first;
    corrupted["response_sha256"] = json!("0".repeat(64));
    journal
        .execute(
            "UPDATE requests SET response_json=?1 WHERE request_id=?2 AND payload_sha256=?3",
            params![serde_json::to_string(&corrupted).unwrap(), request_id, payload_sha256],
        )
        .unwrap();
    drop(journal);
    write_valid_request(&config, &request_id, &payload_json);

    let mut replay = GuestModelBroker::start(Arc::new(config.clone()), authorization(&config, Arc::new(AtomicBool::new(true))))
    .unwrap();
    thread::sleep(Duration::from_millis(150));
    assert!(!response_path(&config, &request_id).exists());
    assert_eq!(fixture.call_count(), 1);
    assert!(matches!(replay.stop(), Err(GuestBrokerError::Journal)));
}

#[test]
fn restart_pending_receipt_becomes_effect_unknown_without_new_inference() {
    let root = TempDir::new().unwrap();
    let fixture = ModelFixture::start(false, None);
    let config = config(&root, &fixture);
    let request_id = Uuid::new_v4().to_string();
    let payload_json = payload("crash window");
    let payload_sha256 = digest(payload_json.as_bytes());
    write_request(
        &config,
        &request_id,
        &config.execution_id,
        config.authority_epoch,
        &payload_json,
        &payload_sha256,
    );

    let journal = Connection::open(&config.journal_path).unwrap();
    journal
        .execute_batch(
            "CREATE TABLE requests (
                request_id TEXT PRIMARY KEY NOT NULL,
                payload_sha256 TEXT NOT NULL,
                execution_id TEXT NOT NULL,
                authority_epoch INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','completed','rejected','effect_unknown')),
                response_json TEXT
            );",
        )
        .unwrap();
    journal
        .execute(
            "INSERT INTO requests(request_id,payload_sha256,execution_id,authority_epoch,status,response_json)
             VALUES(?1,?2,?3,?4,'pending',NULL)",
            params![request_id, payload_sha256, config.execution_id, config.authority_epoch as i64],
        )
        .unwrap();
    drop(journal);

    let mut broker = start_broker(config.clone(), Arc::new(AtomicBool::new(true)));
    let response = wait_for_response(&config, &request_id);
    assert_eq!(response["status"], "effect_unknown");
    assert_eq!(response["reason_code"], "restart_pending");
    assert!(response["completion_json"].is_null());
    assert_eq!(fixture.call_count(), 0);
    broker.stop().unwrap();
}

#[test]
fn revoked_epoch_withholds_late_result_and_blocks_replay() {
    let root = TempDir::new().unwrap();
    let enabled = Arc::new(AtomicBool::new(true));
    let revoke = Arc::clone(&enabled);
    let fixture = ModelFixture::start(false, Some(Arc::new(move || {
        revoke.store(false, Ordering::Release);
    })));
    let config = config(&root, &fixture);
    let request_id = Uuid::new_v4().to_string();
    let payload_json = payload("authority revokes during inference");
    write_valid_request(&config, &request_id, &payload_json);
    let mut broker = start_broker(config.clone(), Arc::clone(&enabled));
    fixture.wait_for_calls(1);
    assert_no_response(&config, &request_id);
    assert_eq!(fixture.call_count(), 1);
    broker.stop().unwrap();

    let check = authorization(&config, Arc::clone(&enabled));
    assert!(matches!(
        GuestModelBroker::start(Arc::new(config), check),
        Err(GuestBrokerError::Unauthorized)
    ));
    assert_eq!(fixture.call_count(), 1);
}

#[test]
fn only_exact_request_id_and_digest_cancellation_withholds_completion() {
    let root = TempDir::new().unwrap();
    let fixture = ModelFixture::start(true, None);
    let config = config(&root, &fixture);
    let request_id = Uuid::new_v4().to_string();
    let other_id = Uuid::new_v4().to_string();
    let payload_json = payload("cancel one request");
    let payload_sha256 = write_valid_request(&config, &request_id, &payload_json);
    let mut broker = start_broker(config.clone(), Arc::new(AtomicBool::new(true)));
    fixture.wait_for_calls(1);

    write_cancel(&config, &other_id, &payload_sha256);
    write_cancel(&config, &request_id, &"0".repeat(64));
    thread::sleep(Duration::from_millis(100));
    assert!(!response_path(&config, &request_id).exists());

    write_cancel(&config, &request_id, &payload_sha256);
    let response = wait_for_response(&config, &request_id);
    assert_eq!(response["status"], "effect_unknown");
    assert_eq!(response["reason_code"], "cancelled_in_flight");
    assert!(response["completion_json"].is_null());
    assert_eq!(fixture.call_count(), 1);
    fixture.release_response();
    broker.stop().unwrap();
}

#[test]
fn request_symlink_and_out_of_scope_directories_are_rejected() {
    let root = TempDir::new().unwrap();
    let fixture = ModelFixture::start(false, None);
    let config = config(&root, &fixture);
    let request_id = Uuid::new_v4().to_string();
    let payload_json = payload("symlinked request");
    let payload_sha256 = digest(payload_json.as_bytes());
    let outside = root.path().join("outside-request.json");
    let request_path = config.request_directory.join(format!("{request_id}.request.json"));
    let request = json!({
        "version": 1,
        "request_id": request_id,
        "execution_id": config.execution_id,
        "authority_epoch": config.authority_epoch,
        "payload_json": payload_json,
        "payload_sha256": payload_sha256
    });
    fs::write(&outside, serde_json::to_vec(&request).unwrap()).unwrap();
    symlink(&outside, &request_path).unwrap();

    let mut broker = start_broker(config.clone(), Arc::new(AtomicBool::new(true)));
    assert_no_response(&config, &request_id);
    assert_eq!(fixture.call_count(), 0);
    broker.stop().unwrap();

    let alias = root.path().join("request-alias");
    symlink(&config.request_directory, &alias).unwrap();
    let mut symlinked = config.clone();
    symlinked.request_directory = alias;
    assert!(matches!(
        GuestModelBroker::start(Arc::new(symlinked.clone()), authorization(&symlinked, Arc::new(AtomicBool::new(true)))),
        Err(GuestBrokerError::InvalidConfig)
    ));

    let mut overlapping = config.clone();
    overlapping.response_directory = overlapping.request_directory.clone();
    assert!(matches!(
        GuestModelBroker::start(Arc::new(overlapping.clone()), authorization(&overlapping, Arc::new(AtomicBool::new(true)))),
        Err(GuestBrokerError::InvalidConfig)
    ));
}

#[test]
fn registered_limits_refuse_backend_specific_capacity_overrides() {
    let root = TempDir::new().unwrap();
    let fixture = ModelFixture::start(false, None);
    let local = config(&root, &fixture);
    for (max_tokens, context_window) in [(4097, 16_384), (4096, 16_385), (4096, 4095)] {
        let mut rejected = local.clone();
        rejected.max_tokens = max_tokens;
        rejected.context_window = context_window;
        assert!(matches!(
            GuestModelBroker::start(
                Arc::new(rejected.clone()),
                authorization(&rejected, Arc::new(AtomicBool::new(true))),
            ),
            Err(GuestBrokerError::InvalidConfig)
        ));
    }
    assert_eq!(fixture.call_count(), 0);

    let native_root = TempDir::new().unwrap();
    let (mut native, dispatched) = native_config(&native_root);
    native.max_tokens = 1025;
    assert!(matches!(
        GuestModelBroker::start(
            Arc::new(native.clone()),
            authorization(&native, Arc::new(AtomicBool::new(true))),
        ),
        Err(GuestBrokerError::InvalidConfig)
    ));
    assert!(!dispatched.exists());
}

#[test]
fn journal_capacity_rejects_without_growing_or_invoking_the_model() {
    let root = TempDir::new().unwrap();
    let fixture = ModelFixture::start(false, None);
    let config = config(&root, &fixture);
    let journal = Connection::open(&config.journal_path).unwrap();
    journal
        .execute_batch(
            "CREATE TABLE requests (
                request_id TEXT PRIMARY KEY NOT NULL,
                payload_sha256 TEXT NOT NULL,
                execution_id TEXT NOT NULL,
                authority_epoch INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','completed','rejected','effect_unknown')),
                response_json TEXT
            );",
        )
        .unwrap();
    for index in 0..128 {
        journal
            .execute(
                "INSERT INTO requests(request_id,payload_sha256,execution_id,authority_epoch,status,response_json)
                 VALUES(?1,?2,?3,?4,'rejected',NULL)",
                params![
                    format!("existing-{index}"),
                    format!("{index:064x}"),
                    config.execution_id,
                    config.authority_epoch as i64
                ],
            )
            .unwrap();
    }
    drop(journal);

    let request_id = Uuid::new_v4().to_string();
    let payload_json = payload("journal row ceiling");
    write_valid_request(&config, &request_id, &payload_json);
    let mut broker = start_broker(config.clone(), Arc::new(AtomicBool::new(true)));
    let response = wait_for_response(&config, &request_id);
    assert_eq!(response["status"], "rejected");
    assert_eq!(response["reason_code"], "request_limit");
    assert_eq!(fixture.call_count(), 0);
    let journal = Connection::open(&config.journal_path).unwrap();
    let rows: i64 = journal
        .query_row("SELECT COUNT(*) FROM requests", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 128);
    broker.stop().unwrap();
}

#[test]
fn native_token_window_is_not_a_serialized_byte_limit() {
    let root = TempDir::new().unwrap();
    let (config, dispatched) = native_config(&root);
    let mut broker = start_broker(config.clone(), Arc::new(AtomicBool::new(true)));

    let mut foreign_tool: Value = serde_json::from_str(
        &native_payload("openai-codex/gpt-6-luna", "user", "foreign tool"),
    ).unwrap();
    foreign_tool["context"]["tools"] = json!([{
        "name": "canary_read",
        "description": "unregistered tool",
        "parameters": {"type": "object", "properties": {}}
    }]);
    let foreign_model = native_payload("openai-codex/gpt-6-other", "user", "foreign model");
    let foreign_role = native_payload("openai-codex/gpt-6-luna", "system", "foreign role");
    for (index, invalid) in [foreign_tool.to_string(), foreign_model, foreign_role].iter().enumerate() {
        let request_id = format!("00000000-0000-4000-8000-{:012x}", index + 1);
        write_valid_request(&config, &request_id, invalid);
        let response = wait_for_response(&config, &request_id);
        assert_eq!(response["status"], "rejected");
        assert_eq!(response["reason_code"], "invalid_payload");
        assert!(!dispatched.exists());
    }

    let oversized = native_payload(
        "openai-codex/gpt-6-luna",
        "user",
        &"x".repeat(1_048_577),
    );
    assert!(oversized.len() > 1_048_576);
    let oversized_id = "00000000-0000-4000-8000-000000000004";
    write_valid_request(&config, oversized_id, &oversized);
    assert_no_response(&config, oversized_id);
    assert!(!dispatched.exists());

    let within_byte_cap = native_payload(
        "openai-codex/gpt-6-luna",
        "user",
        &"x".repeat(271_000),
    );
    assert!(within_byte_cap.len() > (config.context_window - config.max_tokens) as usize);
    assert!(within_byte_cap.len() <= 1_048_576);
    let request_id = "00000000-0000-4000-8000-000000000005";
    write_valid_request(&config, request_id, &within_byte_cap);
    let response = wait_for_response(&config, request_id);
    assert_eq!(response["status"], "effect_unknown");
    assert!(dispatched.is_file());
    broker.stop().unwrap();
}
