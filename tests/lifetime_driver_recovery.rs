#![cfg(all(unix, feature = "lifetime"))]

use ghost::{control::{api::Action, ControlClient}, lifetime_contract::{canonical_digest, Envelope, VERSION}};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{path::Path, process::{Child, Command, Stdio}, time::{Duration, Instant}};

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn action(client: &ControlClient, command: Value) -> Value {
    let response = client.action(serde_json::from_value::<Action>(json!({
        "request_id": uuid::Uuid::new_v4().to_string(), "command": command,
    })).unwrap()).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    response["result"].clone()
}

fn lifetime(client: &ControlClient, body: Value) -> Value {
    let id = uuid::Uuid::new_v4().to_string();
    let envelope = Envelope {
        protocol_version: VERSION.into(), command_id: id.clone(), payload_digest: canonical_digest(&body).unwrap(),
        actor_ref: "owner".into(), authority_epoch: 1, expected_revision: None, correlation_id: id, body,
    };
    let result = action(client, json!({"type":"lifetime", "envelope":envelope}));
    assert_eq!(result["status"], "success", "{result}");
    result["data"].clone()
}

#[test]
fn pi_startup_failure_hung_handshake_and_lost_ack_recover_original_assignment() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("host");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pi_recovery.mjs");
    let log = std::fs::File::create(directory.path().join("host.log")).unwrap();
    let mut server = Server(Command::new(env!("CARGO_BIN_EXE_ghost"))
        .arg("--root").arg(&root).args(["serve", "--headless", "--port", "0", "--model", "mock"])
        .env("GHOST_LIFETIME_PI_ENTRY", fixture).env("GHOST_LIFETIME_MODE", "broker")
        .env_remove("GHOST_LIFETIME_NATIVE_WORKERS_CONFIG")
        .env_remove("GHOST_LIFETIME_LOCAL_MODEL_URL").env_remove("GHOST_LIFETIME_LOCAL_MODEL_ID")
        .env_remove("GHOST_WORKER_RELOCATION_FILE")
        .stdout(Stdio::null()).stderr(Stdio::from(log)).spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(45);
    let client = loop {
        if let Ok(client) = ControlClient::discover(&root) { break client; }
        assert!(server.0.try_wait().unwrap().is_none(), "Host exited before readiness");
        assert!(Instant::now() < deadline, "Host readiness timed out");
        std::thread::sleep(Duration::from_millis(30));
    };
    let connection = Connection::open_with_flags(root.join("workspace.db"), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let (ghost, conversation): (String, String) = connection.query_row(
        "SELECT ghost_id,conversation_id FROM lifetime_registry WHERE kind='primary'", [], |r| Ok((r.get(0)?, r.get(1)?))
    ).unwrap();
    lifetime(&client, json!({"method":"goal.submit", "ghost_id":ghost, "conversation_id":conversation,
        "prompt":"fixture transport recovery only", "privacy":"public", "acceptance_spec":{}}));
    loop {
        let receipt_count: i64 = connection.query_row("SELECT count(*) FROM lifetime_delivery_receipts", [], |r| r.get(0)).unwrap();
        if receipt_count == 1 { break; }
        assert!(Instant::now() < deadline, "Recovery did not ACK the original assignment: {}",
            std::fs::read_to_string(directory.path().join("host.log")).unwrap());
        std::thread::sleep(Duration::from_millis(100));
    }
    let state: Value = serde_json::from_slice(&std::fs::read(root.join("pi-recovery.json")).unwrap()).unwrap();
    assert_eq!(state["starts"], 4);
    assert_eq!(state["admissions"], 1);
    let ids = state["assignment_ids"].as_array().unwrap();
    assert_eq!(ids.len(), 3);
    assert!(ids.iter().all(|id| id == &ids[0]));
    assert_eq!(connection.query_row("SELECT count(*) FROM lifetime_outbox WHERE acknowledged=0", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    // Receipt delivery is not an invented execution or Goal acceptance.
    assert_eq!(connection.query_row("SELECT state FROM lifetime_work", [], |r| r.get::<_, String>(0)).unwrap(), "queued");
    assert_eq!(connection.query_row("SELECT json_extract(payload,'$.blocker') FROM lifetime_work", [], |r| r.get::<_, Option<String>>(0)).unwrap(), None);
    assert_eq!(connection.query_row("SELECT count(*) FROM lifetime_acceptances", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
}
