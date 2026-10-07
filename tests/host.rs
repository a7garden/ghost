#![cfg(feature = "host")]

#[cfg(not(feature = "computer"))]
use ghost::control::api::{Command, OwnerAction};
use ghost::{control::api::Action, host::Host};
use serde_json::{json, Value};
#[cfg(unix)]
use std::{io::Read, net::TcpStream, process::ExitStatus};
use std::{
    io::Write,
    path::Path,
    process::{Child, Command as ProcessCommand, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

fn action(host: &Arc<Host>, request_id: &str, command: Value) -> Value {
    let action: Action = serde_json::from_value(json!({
        "request_id": request_id,
        "command": command,
    }))
    .unwrap();
    host.action(action).unwrap()
}

fn result(reply: &Value) -> &Value {
    assert_eq!(reply["ok"], true, "host action failed: {reply}");
    &reply["result"]
}

fn find_id<'a>(value: &'a Value, id: &str) -> Option<&'a Value> {
    match value {
        Value::Array(values) => values.iter().find_map(|value| find_id(value, id)),
        Value::Object(fields) => {
            if fields.get("id").and_then(Value::as_str) == Some(id) {
                return Some(value);
            }
            fields.values().find_map(|value| find_id(value, id))
        }
        _ => None,
    }
}

fn cli(root: &Path, args: &[&str]) -> Value {
    let output = ProcessCommand::new(env!("CARGO_BIN_EXE_ghost"))
        .arg("--root")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "ghost CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn cli_action(root: &Path, action: Value) -> Value {
    let mut process = ProcessCommand::new(env!("CARGO_BIN_EXE_ghost"))
        .arg("--root")
        .arg(root)
        .args(["control", "send"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    process
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&action).unwrap())
        .unwrap();
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "ghost control send failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

struct ServerChild(Child);
impl Drop for ServerChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn headless_host_runs_and_persists_work_goals_and_timers() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("alice-root");
    let host = Host::open(&root, tokio::runtime::Handle::current(), Some("mock")).unwrap();

    let create_id = uuid::Uuid::new_v4().to_string();
    let created = action(
        &host,
        &create_id,
        json!({"type":"create_profile","name":"alice","persona":"tester"}),
    );
    let profile_id = result(&created)["profile_id"].as_str().unwrap().to_owned();

    let conversation_request = uuid::Uuid::new_v4().to_string();
    let created_conversation = action(
        &host,
        &conversation_request,
        json!({
            "type":"create_conversation",
            "profile_id":profile_id.clone(),
            "model":"mock",
            "tools":false
        }),
    );
    let conversation_id = result(&created_conversation)["conversation_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let submit_request = uuid::Uuid::new_v4().to_string();
    let submitted = action(
        &host,
        &submit_request,
        json!({
            "type":"submit",
            "profile_id":profile_id.clone(),
            "conversation_id":conversation_id.clone(),
            "prompt":"Complete this offline task",
            "kind":"prompt"
        }),
    );
    let task_id = result(&submitted)["task_id"].as_str().unwrap().to_owned();

    let schedule_id = uuid::Uuid::new_v4().to_string();
    let scheduled = action(
        &host,
        &schedule_id,
        json!({
            "type":"add_schedule",
            "profile_id":profile_id.clone(),
            "conversation_id":conversation_id.clone(),
            "prompt":"Run the persisted check",
            "interval_seconds":3600
        }),
    );
    assert_eq!(result(&scheduled)["id"], schedule_id);

    let goal_id = uuid::Uuid::new_v4().to_string();
    let goal = action(
        &host,
        &goal_id,
        json!({
            "type":"workspace",
            "action":{
                "type":"goal",
                "profile_id":profile_id.clone(),
                "title":"Keep the project state current",
                "criteria":"An owner can inspect the saved result",
                "instruction":"Summarize durable project state",
                "dependencies":[],
                "event":null
            }
        }),
    );
    assert_eq!(result(&goal)["id"], goal_id);

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = host.snapshot().unwrap();
            if find_id(&snapshot, &task_id).and_then(|task| task["phase"].as_str())
                == Some("complete")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("headless host did not complete the mock task");

    let snapshot = host.snapshot().unwrap();
    assert!(snapshot["schedules"]
        .as_array()
        .unwrap()
        .iter()
        .any(|schedule| { schedule["id"].as_str() == Some(schedule_id.as_str()) }));
    assert!(snapshot["goals"]
        .as_array()
        .unwrap()
        .iter()
        .any(|goal| goal["id"].as_str() == Some(goal_id.as_str())));

    host.shutdown().await.unwrap();
    drop(host);

    // A second root has independent identity and journal state.
    let other_root = dir.path().join("other-root");
    let other = Host::open(&other_root, tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let other_snapshot = other.snapshot().unwrap();
    assert!(other_snapshot["profiles"].as_array().unwrap().is_empty());
    assert!(other_snapshot["schedules"].as_array().unwrap().is_empty());
    other.shutdown().await.unwrap();
    drop(other);

    // Reopening proves shutdown released the root lock and durable handles.
    let reopened = Host::open(&root, tokio::runtime::Handle::current(), Some("mock")).unwrap();
    let replay = action(
        &reopened,
        &create_id,
        json!({"type":"create_profile","name":"alice","persona":"tester"}),
    );
    assert_eq!(result(&replay)["profile_id"], profile_id);
    let persisted = reopened.snapshot().unwrap();
    assert!(persisted["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .any(|profile| profile["id"].as_str() == Some(profile_id.as_str())));
    assert!(persisted["schedules"]
        .as_array()
        .unwrap()
        .iter()
        .any(|schedule| { schedule["id"].as_str() == Some(schedule_id.as_str()) }));
    assert!(persisted["goals"]
        .as_array()
        .unwrap()
        .iter()
        .any(|goal| goal["id"].as_str() == Some(goal_id.as_str())));
    reopened.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cli_uses_the_live_host_while_its_durable_writer_is_open() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("host-root");
    let mut server = ServerChild(
        ProcessCommand::new(env!("CARGO_BIN_EXE_ghost"))
            .arg("--root")
            .arg(&root)
            .args(["serve", "--headless", "--port", "0", "--model", "mock"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let discovery = root.join(".ghost-control.json");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !discovery.exists() {
        assert!(
            server.0.try_wait().unwrap().is_none(),
            "headless server exited before publishing its endpoint"
        );
        assert!(
            Instant::now() < deadline,
            "headless server did not become ready"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    let created = cli_action(
        &root,
        json!({
            "request_id":uuid::Uuid::new_v4().to_string(),
            "command":{"type":"create_profile","name":"alice","persona":"tester"}
        }),
    );
    let profile_id = created["result"]["profile_id"].as_str().unwrap().to_owned();
    let conversation_request = uuid::Uuid::new_v4().to_string();
    let created = cli_action(
        &root,
        json!({
            "request_id":conversation_request,
            "command":{
                "type":"create_conversation",
                "profile_id":profile_id.clone(),
                "model":"mock",
                "tools":false
            }
        }),
    );
    let conversation_id = created["result"]["conversation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let task = cli_action(
        &root,
        json!({
            "request_id":uuid::Uuid::new_v4().to_string(),
            "command":{
                "type":"submit",
                "profile_id":profile_id.clone(),
                "conversation_id":conversation_id.clone(),
                "prompt":"Run through the live host",
                "kind":"prompt"
            }
        }),
    );
    let task_id = task["result"]["task_id"].as_str().unwrap().to_owned();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = cli(&root, &["control", "snapshot"]);
            if find_id(&snapshot, &task_id).and_then(|task| task["phase"].as_str())
                == Some("complete")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("control CLI could not observe work owned by the live host");
}

#[derive(serde::Deserialize)]
#[cfg(unix)]
struct TestDiscovery {
    host: String,
    port: u16,
    token: String,
    pid: u32,
}

#[cfg(unix)]
async fn wait_for_server_exit(server: &mut ServerChild) -> ExitStatus {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(status) = server.0.try_wait().unwrap() {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("headless server did not exit after the pending request completed")
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn graceful_shutdown_joins_partial_http_request_before_releasing_host() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("pending-request-root");
    let mut server = ServerChild(
        ProcessCommand::new(env!("CARGO_BIN_EXE_ghost"))
            .arg("--root")
            .arg(&root)
            .args(["serve", "--headless", "--port", "0", "--model", "mock"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let discovery_path = root.join(".ghost-control.json");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !discovery_path.exists() {
        assert!(
            server.0.try_wait().unwrap().is_none(),
            "headless server exited before publishing its endpoint"
        );
        assert!(
            Instant::now() < deadline,
            "headless server did not become ready"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let discovery: TestDiscovery =
        serde_json::from_slice(&std::fs::read(&discovery_path).unwrap()).unwrap();

    let mut pending = TcpStream::connect((discovery.host.as_str(), discovery.port)).unwrap();
    pending
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    write!(
        pending,
        "GET /api/v1/snapshot HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n",
        discovery.host, discovery.port
    )
    .unwrap();

    // A second authenticated request can complete while the first handler is
    // blocked waiting for the missing header terminator. This confirms the
    // server accepted the partial request before shutdown begins.
    let endpoint = format!("{}:{}", discovery.host, discovery.port);
    let mut snapshot = TcpStream::connect((discovery.host.as_str(), discovery.port)).unwrap();
    write!(
        snapshot,
        "GET /api/v1/snapshot HTTP/1.1\r\nHost: {endpoint}\r\nAuthorization: Bearer {}\r\nOrigin: http://{endpoint}\r\nX-Ghost-CSRF: {}\r\nSec-Fetch-Site: same-origin\r\nConnection: close\r\n\r\n",
        discovery.token, discovery.token
    )
    .unwrap();
    snapshot
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut snapshot_response = Vec::new();
    snapshot.read_to_end(&mut snapshot_response).unwrap();
    assert!(snapshot_response.starts_with(b"HTTP/1.1 200"));

    let signal = ProcessCommand::new("kill")
        .arg("-INT")
        .arg(discovery.pid.to_string())
        .status()
        .unwrap();
    assert!(signal.success(), "failed to signal the headless server");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        server.0.try_wait().unwrap().is_none(),
        "server exited before joining the still-pending request handler"
    );

    // Completing the request lets its handler return, so graceful shutdown can
    // finish joining handlers, remove discovery metadata, and close the host.
    pending.write_all(b"\r\n").unwrap();
    let mut pending_response = Vec::new();
    pending.read_to_end(&mut pending_response).unwrap();
    assert!(pending_response.starts_with(b"HTTP/1.1 403"));

    let status = wait_for_server_exit(&mut server).await;
    assert!(
        status.success(),
        "headless server did not shut down cleanly"
    );
    assert!(
        !discovery_path.exists(),
        "server left stale discovery metadata"
    );

    let reopened = Host::open(&root, tokio::runtime::Handle::current(), Some("mock")).unwrap();
    reopened.shutdown().await.unwrap();
    drop(reopened);
}

#[cfg(not(feature = "computer"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_unavailable_computer_command_returns_error_without_panicking() {
    let dir = tempfile::tempdir().unwrap();
    let host = Host::open(
        &dir.path().join("host-root"),
        tokio::runtime::Handle::current(),
        Some("mock"),
    )
    .unwrap();
    let profile = action(
        &host,
        &uuid::Uuid::new_v4().to_string(),
        json!({"type":"create_profile","name":"alice","persona":"tester"}),
    );
    let profile_id = result(&profile)["profile_id"].as_str().unwrap().to_owned();

    let reply = host
        .action_async(Action {
            request_id: uuid::Uuid::new_v4().to_string(),
            command: Command::Workspace {
                action: OwnerAction::Computer {
                    profile_id,
                    verb: "status".into(),
                },
            },
        })
        .await
        .unwrap();
    assert_eq!(reply["ok"], false);
    assert!(reply["error"].as_str().unwrap().contains("unavailable"));
    host.shutdown().await.unwrap();
}
