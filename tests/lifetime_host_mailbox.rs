#![cfg(feature = "lifetime")]

use ghost::{
    host::lifetime::apply,
    lifetime_contract::{
        canonical_digest, Acceptance, Artifact, Check, Envelope, Response, ResponseStatus,
        WorkerSpec, VERSION,
    },
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;
use tempfile::TempDir;

const CANARY_ROOT: &str = ".lifetime-canary/ghost-20261009T012047Z/a2a-fixtures";
const PRIMARY: &str = "11111111-1111-7111-8111-111111111111";
const SENDER: &str = "22222222-2222-7222-8222-222222222222";
const RECIPIENT_B: &str = "33333333-3333-7333-8333-333333333333";
const RECIPIENT_C: &str = "44444444-4444-7444-8444-444444444444";
const RECIPIENT_D: &str = "55555555-5555-7555-8555-555555555555";
const OTHER_SENDER: &str = "66666666-6666-7666-8666-666666666666";
const PRIMARY_CONVERSATION: &str = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";

fn database() -> (TempDir, Connection) {
    let canary = Path::new(env!("CARGO_MANIFEST_DIR")).join(CANARY_ROOT);
    std::fs::create_dir_all(&canary).unwrap();
    let root = tempfile::Builder::new()
        .prefix("lifetime-mailbox-")
        .tempdir_in(canary)
        .unwrap();
    let connection = Connection::open(root.path().join("workspace.db")).unwrap();
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE workspace_objects(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));",
        )
        .unwrap();
    connection
        .execute_batch(include_str!("../contracts/lifetime/migration-005.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../contracts/lifetime/migration-006.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../contracts/lifetime/migration-007.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../contracts/lifetime/migration-008.sql"))
        .unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-009.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-010.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-011.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-012.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-013.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-014.sql")).unwrap();
    connection
        .execute(
            "UPDATE lifetime_verification_policy SET verifier_revision='fixture-verifier/1' WHERE singleton=1",
            [],
        )
        .unwrap();
    for profile_id in [
        PRIMARY,
        SENDER,
        RECIPIENT_B,
        RECIPIENT_C,
        RECIPIENT_D,
        OTHER_SENDER,
    ] {
        connection
            .execute(
                "INSERT INTO workspace_objects(kind,id,payload) VALUES('profile',?1,?2)",
                params![profile_id, json!({"id":profile_id,"name":"canary","persona":"fixture"}).to_string()],
            )
            .unwrap();
    }
    (root, connection)
}

fn envelope(
    command_id: &str,
    principal: &str,
    expected_revision: Option<u64>,
    body: Value,
) -> Envelope {
    Envelope {
        protocol_version: VERSION.to_owned(),
        command_id: command_id.to_owned(),
        payload_digest: canonical_digest(&body).unwrap(),
        actor_ref: principal.to_owned(),
        authority_epoch: 1,
        expected_revision,
        correlation_id: format!("corr-{command_id}"),
        body,
    }
}

fn call(
    connection: &Connection,
    command_id: &str,
    principal: &str,
    expected_revision: Option<u64>,
    body: Value,
) -> Response {
    let request = envelope(command_id, principal, expected_revision, body);
    apply(connection, &request, principal).unwrap()
}

fn assert_success(response: &Response) {
    assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    assert_eq!(response.error_code, None);
}

fn assert_error(response: &Response, code: &str) {
    assert_eq!(response.status, ResponseStatus::Error, "{response:?}");
    assert_eq!(response.error_code.as_deref(), Some(code));
}

fn register(
    connection: &Connection,
    command_id: &str,
    ghost_id: &str,
    kind: &str,
    conversation_id: &str,
    roles: Vec<&str>,
) -> Response {
    call(
        connection,
        command_id,
        "owner",
        None,
        json!({
            "method": "registry.ensure",
            "ghost_id": ghost_id,
            "kind": kind,
            "conversation_id": conversation_id,
            "roles": roles,
        }),
    )
}

fn inbox(
    connection: &Connection,
    command_id: &str,
    recipient_id: &str,
    limit: Option<u64>,
) -> Response {
    let mut body = json!({ "method": "notification.inspect", "recipient_id": recipient_id });
    if let Some(limit) = limit {
        body["limit"] = json!(limit);
    }
    call(connection, command_id, recipient_id, None, body)
}

#[test]
fn registry_preserves_conversation_identity_and_enforces_primary_uniqueness() {
    let (_root, connection) = database();
    assert_success(&register(
        &connection,
        "registry-primary",
        PRIMARY,
        "primary",
        PRIMARY_CONVERSATION,
        vec!["owner", "planner"],
    ));

    let forged = envelope(
        "registry-forged-principal",
        "owner",
        None,
        json!({
            "method": "registry.ensure",
            "ghost_id": SENDER,
            "kind": "specialist",
            "conversation_id": "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
            "roles": ["research"],
        }),
    );
    assert_error(&apply(&connection, &forged, "not-owner").unwrap(), "unauthorized");

    assert_success(&call(
        &connection,
        "registry-drain-primary",
        "owner",
        None,
        json!({ "method": "registry.mode", "ghost_id": PRIMARY, "mode": "draining" }),
    ));
    let refreshed = register(
        &connection,
        "registry-refresh-primary",
        PRIMARY,
        "primary",
        PRIMARY_CONVERSATION,
        vec!["owner", "planner", "reviewer"],
    );
    assert_success(&refreshed);
    assert_eq!(refreshed.data["registry"]["mode"], "draining");
    assert_eq!(
        refreshed.data["registry"]["roles"],
        json!(["owner", "planner", "reviewer"])
    );

    assert_success(&register(
        &connection,
        "registry-specialist",
        SENDER,
        "specialist",
        "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
        vec!["research"],
    ));
    let second_primary = register(
        &connection,
        "registry-second-primary",
        OTHER_SENDER,
        "primary",
        "cccccccc-cccc-7ccc-8ccc-cccccccccccc",
        vec!["owner"],
    );
    assert_error(&second_primary, "conflict");

    let rebound = register(
        &connection,
        "registry-rebind",
        PRIMARY,
        "primary",
        "dddddddd-dddd-7ddd-8ddd-dddddddddddd",
        vec!["owner"],
    );
    assert_error(&rebound, "conflict");

    let too_many_roles: Vec<String> = (0..17).map(|index| format!("role-{index}")).collect();
    let over_limit = call(
        &connection,
        "registry-too-many-roles",
        "owner",
        None,
        json!({
            "method": "registry.ensure",
            "ghost_id": RECIPIENT_B,
            "kind": "specialist",
            "conversation_id": "eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee",
            "roles": too_many_roles,
        }),
    );
    assert_error(&over_limit, "invalid_request");

    let inspected = call(
        &connection,
        "registry-inspect",
        "owner",
        None,
        json!({ "method": "registry.inspect" }),
    );
    assert_success(&inspected);
    assert_eq!(inspected.data["registry"].as_array().unwrap().len(), 2);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM lifetime_registry", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
}

fn ensure_mailbox_participants(connection: &Connection) {
    assert_success(&register(
        connection,
        "register-mail-sender",
        SENDER,
        "primary",
        "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
        vec!["owner"],
    ));
    for (index, (ghost_id, conversation)) in [
        (RECIPIENT_B, "cccccccc-cccc-7ccc-8ccc-cccccccccccc"),
        (RECIPIENT_C, "dddddddd-dddd-7ddd-8ddd-dddddddddddd"),
        (RECIPIENT_D, "eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee"),
        (OTHER_SENDER, "ffffffff-ffff-7fff-8fff-ffffffffffff"),
    ]
    .into_iter()
    .enumerate()
    {
        assert_success(&register(
            connection,
            &format!("register-mail-participant-{index}"),
            ghost_id,
            "specialist",
            conversation,
            vec!["collaborator"],
        ));
    }
}

fn message_body(sender_id: &str, recipients: Vec<String>, summary: &str) -> Value {
    json!({
        "method": "mailbox.send",
        "sender_id": sender_id,
        "message_id": "shared-message-1",
        "recipient_ids": recipients,
        "privacy": "local_only",
        "summary": summary,
        "object_refs": ["artifact://canary/shared-result"],
    })
}

#[test]
fn mailbox_is_recipient_scoped_atomic_private_and_recoverable() {
    let (root, connection) = database();
    ensure_mailbox_participants(&connection);

    let body = message_body(
        SENDER,
        vec![RECIPIENT_B.to_owned(), RECIPIENT_C.to_owned()],
        "Scoped status only; no transcript copied.",
    );
    let first = call(&connection, "mailbox-send-1", SENDER, None, body.clone());
    assert_success(&first);
    assert_eq!(first.data["deliveries"].as_array().unwrap().len(), 2);
    assert_eq!(first.data["deliveries"][0]["deduplicated"], false);
    let first_sequence = first.data["deliveries"][0]["sequence"].as_i64().unwrap();

    let replay = call(&connection, "mailbox-send-replay", SENDER, None, body);
    assert_success(&replay);
    assert_eq!(replay.data["deliveries"][0]["deduplicated"], true);
    assert_eq!(replay.data["deliveries"][0]["sequence"], first_sequence);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM lifetime_mailbox", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );

    let other_sender = call(
        &connection,
        "mailbox-same-message-other-sender",
        OTHER_SENDER,
        None,
        message_body(
            OTHER_SENDER,
            vec![RECIPIENT_B.to_owned()],
            "Scoped status only; no transcript copied.",
        ),
    );
    assert_success(&other_sender);
    assert_eq!(other_sender.data["deliveries"][0]["deduplicated"], false);

    let changed = call(
        &connection,
        "mailbox-conflicting-payload",
        SENDER,
        None,
        message_body(
            SENDER,
            vec![
                RECIPIENT_B.to_owned(),
                RECIPIENT_C.to_owned(),
                RECIPIENT_D.to_owned(),
            ],
            "Different bytes under the same sender/message identity.",
        ),
    );
    assert_error(&changed, "conflict");
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM lifetime_mailbox", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM lifetime_mailbox WHERE recipient_id=?1",
                [RECIPIENT_D],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );

    let spoofed = call(
        &connection,
        "mailbox-spoofed-sender",
        SENDER,
        None,
        message_body(
            OTHER_SENDER,
            vec![RECIPIENT_B.to_owned()],
            "A sender identity mismatch must be rejected.",
        ),
    );
    assert_error(&spoofed, "unauthorized");

    let too_many_recipients: Vec<String> = (0..17)
        .map(|index| format!("unregistered-recipient-{index}"))
        .collect();
    let over_recipient_limit = call(
        &connection,
        "mailbox-too-many-recipients",
        SENDER,
        None,
        message_body(SENDER, too_many_recipients, "bounded recipient list"),
    );
    assert_error(&over_recipient_limit, "invalid_request");

    let oversized_summary = "é".repeat(32_769);
    let over_summary_limit = call(
        &connection,
        "mailbox-too-large-summary",
        SENDER,
        None,
        message_body(SENDER, vec![RECIPIENT_B.to_owned()], &oversized_summary),
    );
    assert_error(&over_summary_limit, "invalid_request");

    let too_large_page = call(
        &connection,
        "mailbox-limit-over-100",
        RECIPIENT_B,
        None,
        json!({ "method": "mailbox.inspect", "recipient_id": RECIPIENT_B, "limit": 101 }),
    );
    assert_error(&too_large_page, "invalid_request");

    let wrong_recipient = call(
        &connection,
        "mailbox-wrong-recipient-inspect",
        RECIPIENT_C,
        None,
        json!({ "method": "mailbox.inspect", "recipient_id": RECIPIENT_B }),
    );
    assert_error(&wrong_recipient, "unauthorized");

    let inspected = call(
        &connection,
        "mailbox-inspect-b",
        RECIPIENT_B,
        None,
        json!({ "method": "mailbox.inspect", "recipient_id": RECIPIENT_B, "limit": 100 }),
    );
    assert_success(&inspected);
    let messages = inspected.data["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert!(messages.iter().all(|message| message["state"] == "pending"));
    assert!(messages.iter().any(|message| message["sender_id"] == SENDER));
    assert!(messages.iter().any(|message| message["sender_id"] == OTHER_SENDER));
    assert!(messages.iter().all(|message| message["recipient_id"] == RECIPIENT_B));
    assert!(messages.iter().all(|message| message["privacy"] == "local_only"));

    let after_first = call(
        &connection,
        "mailbox-after-cursor",
        RECIPIENT_B,
        None,
        json!({
            "method": "mailbox.inspect",
            "recipient_id": RECIPIENT_B,
            "after_sequence": first_sequence,
            "limit": 100,
        }),
    );
    assert_success(&after_first);
    assert_eq!(after_first.data["messages"].as_array().unwrap().len(), 1);

    let wrong_ack = call(
        &connection,
        "mailbox-wrong-recipient-ack",
        RECIPIENT_C,
        None,
        json!({
            "method": "mailbox.ack",
            "recipient_id": RECIPIENT_B,
            "sender_id": SENDER,
            "message_id": "shared-message-1",
            "state": "client_seen",
        }),
    );
    assert_error(&wrong_ack, "unauthorized");

    for (command_id, state) in [
        ("mailbox-transport-ack", "transport_accepted"),
        ("mailbox-seen-ack", "client_seen"),
        ("mailbox-no-downgrade", "transport_accepted"),
    ] {
        let ack = call(
            &connection,
            command_id,
            RECIPIENT_B,
            None,
            json!({
                "method": "mailbox.ack",
                "recipient_id": RECIPIENT_B,
                "sender_id": SENDER,
                "message_id": "shared-message-1",
                "state": state,
            }),
        );
        assert_success(&ack);
    }
    let after_ack = call(
        &connection,
        "mailbox-inspect-after-ack",
        RECIPIENT_B,
        None,
        json!({ "method": "mailbox.inspect", "recipient_id": RECIPIENT_B }),
    );
    let messages = after_ack.data["messages"].as_array().unwrap();
    let first_message = messages
        .iter()
        .find(|message| message["sender_id"] == SENDER)
        .unwrap();
    assert_eq!(first_message["state"], "client_seen");

    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM lifetime_outbox", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0,
        "mailbox content must not enter the model/runtime outbox"
    );

    let database_path = root.path().join("workspace.db");
    drop(connection);
    let reopened = Connection::open(database_path).unwrap();
    let recovered = call(
        &reopened,
        "mailbox-inspect-after-reopen",
        RECIPIENT_B,
        None,
        json!({ "method": "mailbox.inspect", "recipient_id": RECIPIENT_B }),
    );
    assert_success(&recovered);
    let recovered_message = recovered.data["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["sender_id"] == SENDER)
        .unwrap()
        .clone();
    assert_eq!(recovered_message["state"], "client_seen");
}

#[test]
fn owner_administration_keeps_provenance_without_granting_ghost_registry_authority() {
    let (_root, connection) = database();
    ensure_mailbox_participants(&connection);
    let denied = call(
        &connection, "ghost-registry-escalation", SENDER, None,
        json!({"method":"registry.mode", "ghost_id":RECIPIENT_B, "mode":"draining"}),
    );
    assert_error(&denied, "unauthorized");
    let mode: String = connection.query_row(
        "SELECT mode FROM lifetime_registry WHERE ghost_id=?1", [RECIPIENT_B],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(mode, "active");
    assert_error(&call(
        &connection, "ghost-registry-ensure-escalation", SENDER, None,
        json!({"method":"registry.ensure", "ghost_id":RECIPIENT_B, "kind":"specialist",
            "conversation_id":"cccccccc-cccc-7ccc-8ccc-cccccccccccc", "roles":["owner"]}),
    ), "unauthorized");

    let body = message_body(SENDER, vec![RECIPIENT_B.to_owned()], "Owner-approved scoped note.");
    let sent = call(&connection, "owner-mailbox-admin", "owner", None, body.clone());
    assert_success(&sent);
    let actor: String = connection.query_row(
        "SELECT actor_ref FROM lifetime_commands WHERE command_id='owner-mailbox-admin'",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(actor, "owner");
    let inspected = call(
        &connection, "owner-mailbox-inspect", "owner", None,
        json!({"method":"mailbox.inspect", "recipient_id":RECIPIENT_B}),
    );
    assert_success(&inspected);
    assert_eq!(inspected.data["messages"][0]["sender_id"], SENDER);
    assert_eq!(inspected.data["messages"][0]["state"], "pending");
    assert_error(&call(
        &connection, "ghost-foreign-inspect", SENDER, None,
        json!({"method":"mailbox.inspect", "recipient_id":RECIPIENT_B}),
    ), "unauthorized");
    assert_success(&call(
        &connection, "owner-mailbox-ack", "owner", None,
        json!({"method":"mailbox.ack", "recipient_id":RECIPIENT_B,
            "sender_id":SENDER, "message_id":"shared-message-1", "state":"client_seen"}),
    ));
    let forged_owner = envelope("forged-owner-admin", "owner", None, body);
    assert_error(&apply(&connection, &forged_owner, SENDER).unwrap(), "unauthorized");
}

fn submit_goal(connection: &Connection) -> (String, String, String) {
    let response = call(
        connection,
        "notification-goal-submit",
        "owner",
        None,
        json!({
            "method": "goal.submit",
            "ghost_id": PRIMARY,
            "conversation_id": PRIMARY_CONVERSATION,
            "prompt": "Produce a canary artifact",
            "privacy": "public",
            "acceptance_spec": { "required_checks": ["artifact_content"] },
        }),
    );
    assert_success(&response);
    (
        response.data["goal"]["id"].as_str().unwrap().to_owned(),
        response.data["work"]["id"].as_str().unwrap().to_owned(),
        response.data["goal"]["requirement_digest"]
            .as_str()
            .unwrap()
            .to_owned(),
    )
}

fn worker_spec(work_id: &str, execution_id: &str, revision: u64) -> WorkerSpec {
    WorkerSpec {
        execution_id: execution_id.to_owned(),
        work_id: work_id.to_owned(),
        work_revision: revision,
        authority_epoch: 1,
        computer_id: "canary-computer".to_owned(),
        cwd: "/workspace/canary".to_owned(),
        prompt: "Produce only the canary artifact".to_owned(),
        model: "fixture-model".to_owned(),
        thinking: "max".to_owned(),
        allowed_tools: vec!["read".to_owned()],
        deadline_ms: 30_000,
        max_progress_bytes: 4096,
        skills: None,
        input_artifacts: None,
    }
}

fn submit_worker(
    connection: &Connection,
    command_id: &str,
    work_id: &str,
    execution_id: &str,
    revision: u64,
) {
    let spec = worker_spec(work_id, execution_id, revision);
    let response = call(
        connection,
        command_id,
        "owner",
        Some(revision),
        json!({
            "method": "work.submit",
            "work_id": work_id,
            "spec": serde_json::to_value(spec).unwrap(),
        }),
    );
    assert_success(&response);
}

fn worker_result(
    connection: &Connection,
    command_id: &str,
    execution_id: &str,
    sequence: u64,
    revision: u64,
    state: &str,
    digest: &str,
) -> Response {
    let artifact = Artifact {
        digest: digest.to_owned(),
        locator: format!("artifact://canary/{execution_id}.txt"),
        privacy: "public".to_owned(),
        producing_attempt: execution_id.to_owned(),
    };
    call(
        connection,
        command_id,
        "worker-canary",
        Some(revision),
        json!({
            "method": "work.result",
            "execution_id": execution_id,
            "producer": "worker-canary",
            "sequence": sequence,
            "goal_revision": revision,
            "state": state,
            "artifacts": [artifact],
            "summary": "Canary result is available.",
        }),
    )
}

fn notification_rows(connection: &Connection, command_id: &str) -> Vec<Value> {
    let response = inbox(connection, command_id, PRIMARY, Some(100));
    assert_success(&response);
    response.data["notifications"].as_array().unwrap().clone()
}

#[test]
fn terminal_notifications_are_revision_scoped_deduplicated_opaque_and_recoverable() {
    let (root, connection) = database();
    assert_success(&register(
        &connection,
        "notification-register-primary",
        PRIMARY,
        "primary",
        PRIMARY_CONVERSATION,
        vec!["owner"],
    ));

    assert_success(&register(
        &connection,
        "notification-register-recipient-b",
        RECIPIENT_B,
        "specialist",
        "cccccccc-cccc-7ccc-8ccc-cccccccccccc",
        vec!["collaborator"],
    ));
    let (goal_id, work_id, requirement_digest) = submit_goal(&connection);
    submit_worker(&connection, "notification-submit-work-1", &work_id, "execution-r1", 1);

    let first_result = worker_result(
        &connection,
        "notification-result-r1-seq1",
        "execution-r1",
        1,
        1,
        "completed",
        &"a".repeat(64),
    );
    assert_success(&first_result);
    let first_rows = notification_rows(&connection, "notification-inspect-r1-first");
    assert_eq!(first_rows.len(), 1);
    let first_notification_id = first_rows[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(first_rows[0]["work_id"].as_str().unwrap(), work_id.as_str());
    assert_eq!(first_rows[0]["goal_revision"], 1);
    assert_eq!(first_rows[0]["event_kind"], "result");
    assert_eq!(first_rows[0]["conversation_id"], PRIMARY_CONVERSATION);
    assert!(first_rows[0].get("summary").is_none());
    assert!(first_rows[0].get("artifacts").is_none());

    assert_success(&worker_result(
        &connection,
        "notification-result-r1-seq2",
        "execution-r1",
        2,
        1,
        "completed",
        &"a".repeat(64),
    ));
    let after_duplicate_event = notification_rows(&connection, "notification-inspect-r1-dedup");
    assert_eq!(after_duplicate_event.len(), 1);
    assert_eq!(
        after_duplicate_event[0]["id"].as_str().unwrap(),
        first_notification_id.as_str()
    );

    let revision_update = call(
        &connection,
        "notification-goal-update-r2",
        "owner",
        Some(1),
        json!({
            "method": "goal.update",
            "goal_id": goal_id,
            "prompt": "Produce the canary artifact with revised requirements",
            "acceptance_spec": { "required_checks": ["artifact_content"] },
        }),
    );
    assert_success(&revision_update);
    let current_goal = revision_update.data["goal"].clone();
    assert_eq!(current_goal["revision"], 2);
    assert_ne!(
        current_goal["requirement_digest"].as_str().unwrap(),
        requirement_digest.as_str()
    );
    let current_work = revision_update.data["work"]
        .as_array()
        .unwrap()
        .iter()
        .find(|work| work["goal_revision"] == 2 && work["state"] == "queued")
        .unwrap()
        .clone();
    let current_work_id = current_work["id"].as_str().unwrap().to_owned();

    let stale_result = worker_result(
        &connection,
        "notification-stale-result-r1",
        "execution-r1",
        3,
        1,
        "completed",
        &"a".repeat(64),
    );
    assert_eq!(stale_result.status, ResponseStatus::Warning);
    let after_stale = notification_rows(&connection, "notification-inspect-after-stale");
    assert_eq!(after_stale.len(), 1);

    submit_worker(
        &connection,
        "notification-submit-work-r2",
        &current_work_id,
        "execution-r2",
        2,
    );
    assert_success(&worker_result(
        &connection,
        "notification-result-r2",
        "execution-r2",
        4,
        2,
        "completed",
        &"b".repeat(64),
    ));

    let acceptance = Acceptance {
        work_id: current_work_id.clone(),
        goal_revision: 2,
        requirement_digest: current_goal["requirement_digest"]
            .as_str()
            .unwrap()
            .to_owned(),
        artifact_digest: "b".repeat(64),
        verifier_revision: "fixture-verifier/1".to_owned(),
        policy_revision: 1,
        checks: vec![Check {
            id: "artifact_content".to_owned(),
            passed: true,
            evidence: "canary content verified".to_owned(),
        }],
    };
    assert_success(&call(
        &connection,
        "notification-accept-r2",
        "owner",
        Some(2),
        json!({ "method": "work.accept", "acceptance": acceptance }),
    ));

    let rows = notification_rows(&connection, "notification-inspect-final");
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().any(|row| row["event_kind"] == "result" && row["goal_revision"] == 1));
    assert!(rows.iter().any(|row| row["event_kind"] == "result" && row["goal_revision"] == 2));
    let acceptance_notification = rows
        .iter()
        .find(|row| row["event_kind"] == "acceptance" && row["goal_revision"] == 2)
        .unwrap();
    assert_eq!(
        acceptance_notification["work_id"].as_str().unwrap(),
        current_work_id.as_str()
    );
    assert!(rows.iter().all(|row| row.get("summary").is_none()));
    assert!(rows.iter().all(|row| row.get("artifacts").is_none()));

    let notification_id = acceptance_notification["id"].as_str().unwrap().to_owned();
    let wrong_recipient_ack = call(
        &connection,
        "notification-wrong-recipient-ack",
        RECIPIENT_B,
        None,
        json!({
            "method": "notification.ack",
            "recipient_id": PRIMARY,
            "notification_id": notification_id,
            "state": "client_seen",
        }),
    );
    assert_error(&wrong_recipient_ack, "unauthorized");

    for (command_id, state) in [
        ("notification-transport-ack", "transport_accepted"),
        ("notification-seen-ack", "client_seen"),
        ("notification-no-downgrade", "transport_accepted"),
    ] {
        assert_success(&call(
            &connection,
            command_id,
            PRIMARY,
            None,
            json!({
                "method": "notification.ack",
                "recipient_id": PRIMARY,
                "notification_id": notification_id,
                "state": state,
            }),
        ));
    }

    let database_path = root.path().join("workspace.db");
    drop(connection);
    let reopened = Connection::open(database_path).unwrap();
    let recovered = notification_rows(&reopened, "notification-inspect-after-reopen");
    let recovered_acceptance = recovered
        .iter()
        .find(|row| row["id"].as_str() == Some(notification_id.as_str()))
        .unwrap();
    assert_eq!(recovered_acceptance["state"], "client_seen");
    assert_eq!(recovered_acceptance["goal_revision"], 2);
}
