#![cfg(feature = "lifetime")]

use ghost::{
    host::lifetime::{apply, pending_outbox, snapshot},
    lifetime_contract::{canonical_digest, Artifact, Envelope, Response, ResponseStatus, VERSION},
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;
use tempfile::TempDir;

const CANARY_ROOT: &str = ".lifetime-canary/ghost-20261009T012047Z/A4-tests";
const OWNER: &str = "owner";
const ROOT_GHOST: &str = "22222222-2222-7222-8222-222222222222";
const ROOT_CONVERSATION: &str = "11111111-1111-7111-8111-111111111111";
const TARGET_GHOST: &str = "33333333-3333-7333-8333-333333333333";
const TARGET_CONVERSATION: &str = "33333333-3333-7333-8333-444444444444";

fn database() -> (TempDir, Connection) {
    let canary = Path::new(env!("CARGO_MANIFEST_DIR")).join(CANARY_ROOT);
    std::fs::create_dir_all(&canary).unwrap();
    let root = tempfile::Builder::new()
        .prefix("host-turn-runs-")
        .tempdir_in(canary)
        .unwrap();
    let connection = Connection::open(root.path().join("workspace.db")).unwrap();
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE workspace_objects(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));",
        )
        .unwrap();
    for ghost_id in [ROOT_GHOST, TARGET_GHOST] {
        connection
            .execute(
                "INSERT INTO workspace_objects(kind,id,payload) VALUES('profile',?1,'preserve-me')",
                [ghost_id],
            )
            .unwrap();
    }
    for migration in [
        include_str!("../contracts/lifetime/migration-005.sql"),
        include_str!("../contracts/lifetime/migration-006.sql"),
        include_str!("../contracts/lifetime/migration-007.sql"),
        include_str!("../contracts/lifetime/migration-008.sql"),
        include_str!("../contracts/lifetime/migration-009.sql"),
        include_str!("../contracts/lifetime/migration-010.sql"),
        include_str!("../contracts/lifetime/migration-011.sql"),
        include_str!("../contracts/lifetime/migration-012.sql"),
        include_str!("../contracts/lifetime/migration-013.sql"),
        include_str!("../contracts/lifetime/migration-014.sql"),
    ] {
        connection.execute_batch(migration).unwrap();
    }
    connection
        .execute(
            "UPDATE lifetime_verification_policy SET verifier_revision='fixture-verifier/1' WHERE singleton=1",
            [],
        )
        .unwrap();
    register_ghost(
        &connection,
        "registry-root",
        ROOT_GHOST,
        "primary",
        ROOT_CONVERSATION,
    );
    register_ghost(
        &connection,
        "registry-target",
        TARGET_GHOST,
        "specialist",
        TARGET_CONVERSATION,
    );
    (root, connection)
}

fn envelope(command_id: &str, principal: &str, body: Value) -> Envelope {
    Envelope {
        protocol_version: VERSION.to_owned(),
        command_id: command_id.to_owned(),
        payload_digest: canonical_digest(&body).unwrap(),
        actor_ref: principal.to_owned(),
        authority_epoch: 1,
        expected_revision: None,
        correlation_id: format!("corr-{command_id}"),
        body,
    }
}

fn send(conn: &Connection, request: &Envelope, principal: &str) -> Response {
    apply(conn, request, principal).unwrap()
}

fn assert_success(response: &Response) {
    assert_eq!(response.status, ResponseStatus::Success, "{response:?}");
    assert_eq!(response.error_code, None);
}

fn assert_error(response: &Response, code: &str) {
    assert_eq!(response.status, ResponseStatus::Error, "{response:?}");
    assert_eq!(response.error_code.as_deref(), Some(code));
}

fn register_ghost(
    conn: &Connection,
    command_id: &str,
    ghost_id: &str,
    kind: &str,
    conversation_id: &str,
) {
    let request = envelope(
        command_id,
        OWNER,
        json!({
            "method": "registry.ensure",
            "ghost_id": ghost_id,
            "kind": kind,
            "conversation_id": conversation_id,
            "roles": []
        }),
    );
    assert_success(&send(conn, &request, OWNER));
}

fn owner_input(
    conn: &Connection,
    command_id: &str,
    ghost_id: &str,
    conversation_id: &str,
    text: &str,
    privacy: &str,
    attachments: Vec<Artifact>,
) -> Response {
    let request = envelope(
        command_id,
        OWNER,
        json!({
            "method": "conversation.input",
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
            "text": text,
            "privacy": privacy,
            "attachments": attachments,
        }),
    );
    send(conn, &request, OWNER)
}

fn cancel_turn(
    conn: &Connection,
    command_id: &str,
    principal: &str,
    ghost_id: &str,
    conversation_id: &str,
    turn_id: &str,
) -> Response {
    let request = envelope(
        command_id,
        principal,
        json!({
            "method": "conversation.cancel_turn",
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
            "turn_id": turn_id,
        }),
    );
    send(conn, &request, principal)
}

fn turn_status(
    conn: &Connection,
    command_id: &str,
    principal: &str,
    ghost_id: &str,
    conversation_id: &str,
    turn_id: &str,
    state: &str,
    submission_id: Option<&str>,
    entry_id: Option<&str>,
    reason_code: Option<&str>,
) -> Response {
    let request = envelope(
        command_id,
        principal,
        json!({
            "method": "conversation.turn_status",
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
            "turn_id": turn_id,
            "status": state,
            "submission_id": submission_id,
            "entry_id": entry_id,
            "reason_code": reason_code,
        }),
    );
    send(conn, &request, principal)
}

fn inspect_turn(
    conn: &Connection,
    command_id: &str,
    principal: &str,
    ghost_id: &str,
    conversation_id: &str,
    turn_id: &str,
) -> Response {
    let request = envelope(
        command_id,
        principal,
        json!({
            "method": "conversation.turn.inspect",
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
            "turn_id": turn_id,
        }),
    );
    send(conn, &request, principal)
}

fn inspect_conversation(
    conn: &Connection,
    command_id: &str,
    principal: &str,
    ghost_id: &str,
    conversation_id: &str,
) -> Response {
    let request = envelope(
        command_id,
        principal,
        json!({
            "method": "conversation.inspect",
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
        }),
    );
    send(conn, &request, principal)
}

fn reply(
    conn: &Connection,
    command_id: &str,
    principal: &str,
    turn_id: &str,
    ghost_id: &str,
    conversation_id: &str,
    text: &str,
) -> Response {
    let request = envelope(
        command_id,
        principal,
        json!({
            "method": "conversation.reply",
            "turn_id": turn_id,
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
            "text": text,
        }),
    );
    send(conn, &request, principal)
}

fn create_goal(
    conn: &Connection,
    command_id: &str,
    principal: &str,
    turn_id: &str,
    ghost_id: &str,
    conversation_id: &str,
    prompt: &str,
) -> Response {
    let request = envelope(
        command_id,
        principal,
        json!({
            "method": "goal.create",
            "turn_id": turn_id,
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
            "prompt": prompt,
            "acceptance_spec": { "required_checks": ["artifact_content"] },
        }),
    );
    send(conn, &request, principal)
}

fn inspect_goal(conn: &Connection, command_id: &str, goal_id: &str) -> Response {
    let request = envelope(
        command_id,
        OWNER,
        json!({ "method": "goal.inspect", "goal_id": goal_id }),
    );
    send(conn, &request, OWNER)
}

fn inspect_work(conn: &Connection, command_id: &str, work_id: &str) -> Response {
    let request = envelope(
        command_id,
        OWNER,
        json!({ "method": "work.inspect", "work_id": work_id }),
    );
    send(conn, &request, OWNER)
}

fn seed_background_artifact(conn: &Connection) -> (String, String, Artifact) {
    let goal_id = "existing-background-goal";
    let work_id = "existing-background-work";
    let execution_id = "existing-background-execution";
    let artifact = Artifact {
        digest: "a".repeat(64),
        locator: "artifact://canary/existing-result".to_owned(),
        privacy: "private".to_owned(),
        producing_attempt: execution_id.to_owned(),
    };
    let goal = json!({
        "id": goal_id,
        "revision": 1,
        "requirement_digest": "b".repeat(64),
        "prompt": "Previously accepted background work",
        "accountable_ghost": ROOT_GHOST,
        "reply_conversation": ROOT_CONVERSATION,
        "privacy": "private",
        "state": "open",
        "acceptance_spec": {"required_checks": ["artifact_content"]},
    });
    let work = json!({
        "id": work_id,
        "goal_id": goal_id,
        "goal_revision": 1,
        "owner": ROOT_GHOST,
        "owner_revision": 1,
        "state": "completed",
        "execution_id": execution_id,
        "cancellation": "none",
        "blocker": null,
    });
    let result = json!({
        "event": {
            "method": "work.result",
            "execution_id": execution_id,
            "goal_revision": 1,
            "artifacts": [artifact],
            "summary": "Previously committed canary result",
        },
        "producer": "fixture-worker",
        "epoch": 1,
        "sequence": 1,
        "current": true,
        "reason": null,
    });
    conn.execute(
        "INSERT INTO lifetime_goals(id,revision,requirement_digest,accountable_ghost,reply_conversation,privacy,state,payload)
         VALUES(?1,1,?2,?3,?4,'private','open',?5)",
        params![goal_id, "b".repeat(64), ROOT_GHOST, ROOT_CONVERSATION, goal.to_string()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO lifetime_work(id,goal_id,goal_revision,owner,owner_revision,state,execution_id,cancellation,payload)
         VALUES(?1,?2,1,?3,1,'completed',?4,'none',?5)",
        params![work_id, goal_id, ROOT_GHOST, execution_id, work.to_string()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO lifetime_results(execution_id,work_id,goal_revision,payload_digest,payload)
         VALUES(?1,?2,1,?3,?4)",
        params![execution_id, work_id, "c".repeat(64), result.to_string()],
    )
    .unwrap();
    (goal_id.to_owned(), work_id.to_owned(), artifact)
}

#[test]
fn owner_input_atomically_creates_one_queued_run_and_replay_does_not_resubmit() {
    let (_root, conn) = database();
    let request = envelope(
        "owner-turn-one",
        OWNER,
        json!({
            "method": "conversation.input",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "text": "Please review the current status.",
            "privacy": "public",
            "attachments": [],
        }),
    );
    let first = send(&conn, &request, OWNER);
    assert_success(&first);
    assert_eq!(first.data["turn_id"], "owner-turn-one");
    assert_eq!(first.data["queued"], true);

    let run = inspect_turn(
        &conn,
        "inspect-queued-run",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "owner-turn-one",
    );
    assert_success(&run);
    assert_eq!(run.data["run"]["turn_id"], "owner-turn-one");
    assert_eq!(run.data["run"]["state"], "queued");
    assert_eq!(run.data["run"]["cancel_requested"], false);
    assert!(run.data["run"]["submission_id"].is_null());
    assert!(run.data["run"]["entry_id"].is_null());

    let history = inspect_conversation(
        &conn,
        "inspect-queued-history",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_success(&history);
    assert_eq!(history.data["turn_runs"].as_array().unwrap().len(), 1);
    assert_eq!(history.data["turn_runs"][0]["state"], "queued");
    assert_eq!(history.data["turns"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot(&conn).unwrap().goals.len(), 0);
    assert_eq!(snapshot(&conn).unwrap().work.len(), 0);

    let outbox = pending_outbox(&conn).unwrap();
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].target, "pi");
    assert_eq!(outbox[0].payload["body"]["method"], "conversation.input");
    assert_eq!(outbox[0].payload["body"]["turn_id"], "owner-turn-one");
    assert!(outbox[0].payload["body"].get("goal_id").is_none());

    let replay = send(&conn, &request, OWNER);
    assert_eq!(
        serde_json::to_value(replay).unwrap(),
        serde_json::to_value(first).unwrap()
    );
    let changed = envelope(
        "owner-turn-one",
        OWNER,
        json!({
            "method": "conversation.input",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "text": "Different payload under the original command ID.",
            "privacy": "public",
            "attachments": [],
        }),
    );
    assert_error(&send(&conn, &changed, OWNER), "conflict");
    assert_eq!(pending_outbox(&conn).unwrap().len(), 1);
    assert_eq!(
        inspect_turn(
            &conn,
            "inspect-after-replay-conflict",
            OWNER,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "owner-turn-one",
        )
        .data["run"]["state"],
        "queued"
    );
}

#[test]
fn cancellation_is_exact_single_request_and_never_marks_completion_by_itself() {
    let (_root, conn) = database();
    assert_success(&owner_input(
        &conn,
        "targeted-turn-one",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "First turn.",
        "public",
        vec![],
    ));
    assert_success(&owner_input(
        &conn,
        "targeted-turn-two",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "Second turn.",
        "public",
        vec![],
    ));
    assert_success(&owner_input(
        &conn,
        "targeted-turn-three",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "Later turn remains independent.",
        "public",
        vec![],
    ));
    assert_success(&owner_input(
        &conn,
        "foreign-owner-turn",
        TARGET_GHOST,
        TARGET_CONVERSATION,
        "Other Ghost turn.",
        "public",
        vec![],
    ));

    assert_success(&turn_status(
        &conn,
        "second-turn-running",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "targeted-turn-two",
        "running",
        Some("sdk-submit-two"),
        None,
        None,
    ));
    let assistant = reply(
        &conn,
        "assistant-entry-two",
        ROOT_GHOST,
        "targeted-turn-two",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "The second turn completed.",
    );
    assert_success(&assistant);

    let first_cancel = cancel_turn(
        &conn,
        "cancel-first-owner-request",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "targeted-turn-one",
    );
    assert_success(&first_cancel);
    assert_eq!(first_cancel.data["run"]["state"], "queued");
    assert_eq!(first_cancel.data["run"]["cancel_requested"], true);
    assert_eq!(first_cancel.data["completed"], false);
    assert_eq!(snapshot(&conn).unwrap().goals.len(), 0);
    assert_eq!(snapshot(&conn).unwrap().work.len(), 0);
    let cancel_command_id = first_cancel.data["cancel_command_id"].as_str().unwrap();
    let pending = pending_outbox(&conn).unwrap();
    assert_eq!(pending.len(), 5);
    let cancellation = pending
        .iter()
        .find(|item| item.payload["body"]["method"] == "conversation.cancel_turn")
        .unwrap();
    assert_eq!(cancellation.target, "pi");
    assert_eq!(cancellation.payload["body"]["turn_id"], "targeted-turn-one");
    assert_eq!(cancellation.payload["command_id"], cancel_command_id);

    let repeated = cancel_turn(
        &conn,
        "cancel-first-owner-request-again",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "targeted-turn-one",
    );
    assert_success(&repeated);
    assert_eq!(repeated.data["cancel_command_id"], cancel_command_id);
    assert_eq!(repeated.data["completed"], false);
    let already_terminal = cancel_turn(
        &conn,
        "cancel-already-answered-turn",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "targeted-turn-two",
    );
    assert_success(&already_terminal);
    assert_eq!(already_terminal.data["already_terminal"], true);
    assert_eq!(already_terminal.data["run"]["state"], "answered");
    assert_eq!(pending_outbox(&conn).unwrap().len(), 5);

    for (command_id, bad_turn) in [
        ("cancel-stale-target", "stale-owner-turn"),
        ("cancel-foreign-target", "foreign-owner-turn"),
        (
            "cancel-assistant-target",
            assistant.data["turn_id"].as_str().unwrap(),
        ),
    ] {
        assert_error(
            &cancel_turn(
                &conn,
                command_id,
                OWNER,
                ROOT_GHOST,
                ROOT_CONVERSATION,
                bad_turn,
            ),
            "not_found",
        );
    }
    assert_error(
        &cancel_turn(
            &conn,
            "cancel-other-pair",
            OWNER,
            ROOT_GHOST,
            "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
            "targeted-turn-three",
        ),
        "unauthorized",
    );
    assert_error(
        &cancel_turn(
            &conn,
            "cancel-by-pi-forbidden",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "targeted-turn-three",
        ),
        "unauthorized",
    );
    assert_error(
        &turn_status(
            &conn,
            "status-other-ghost-for-root",
            TARGET_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "targeted-turn-three",
            "running",
            Some("forged-submission"),
            None,
            None,
        ),
        "unauthorized",
    );
    assert_error(
        &turn_status(
            &conn,
            "status-foreign-owner-turn",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "foreign-owner-turn",
            "running",
            Some("foreign-submission"),
            None,
            None,
        ),
        "not_found",
    );
    assert_error(
        &turn_status(
            &conn,
            "status-assistant-turn",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            assistant.data["turn_id"].as_str().unwrap(),
            "running",
            Some("assistant-submission"),
            None,
            None,
        ),
        "not_found",
    );
    assert_error(
        &inspect_turn(
            &conn,
            "inspect-other-ghost-for-root",
            TARGET_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "targeted-turn-three",
        ),
        "unauthorized",
    );


    let later = inspect_turn(
        &conn,
        "inspect-later-turn-untouched",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "targeted-turn-three",
    );
    assert_success(&later);
    assert_eq!(later.data["run"]["state"], "queued");
    assert_eq!(later.data["run"]["cancel_requested"], false);
    assert_eq!(pending_outbox(&conn).unwrap().len(), 5);
}

#[test]
fn authenticated_status_is_monotone_and_only_actual_reply_creates_advisory_turn() {
    let (_root, conn) = database();
    assert_success(&owner_input(
        &conn,
        "status-owner-turn",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "Tell me when the task settles.",
        "public",
        vec![],
    ));
    let stale_read = envelope(
        "same-inspection-receipt",
        OWNER,
        json!({
            "method": "conversation.turn.inspect",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "turn_id": "status-owner-turn",
        }),
    );
    assert_eq!(send(&conn, &stale_read, OWNER).data["run"]["state"], "queued");

    assert_error(
        &turn_status(
            &conn,
            "owner-cannot-report-controller-status",
            OWNER,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "status-owner-turn",
            "running",
            Some("sdk-submit-one"),
            None,
            None,
        ),
        "unauthorized",
    );
    assert_success(&turn_status(
        &conn,
        "running-status-one",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "status-owner-turn",
        "running",
        Some("sdk-submit-one"),
        None,
        None,
    ));
    assert_eq!(send(&conn, &stale_read, OWNER).data["run"]["state"], "queued");
    assert_eq!(
        inspect_turn(
            &conn,
            "fresh-inspection-after-running",
            OWNER,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "status-owner-turn",
        )
        .data["run"]["state"],
        "running"
    );

    assert_error(
        &turn_status(
            &conn,
            "running-status-one",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "status-owner-turn",
            "failed",
            Some("sdk-submit-one"),
            None,
            Some("runtime_failure"),
        ),
        "conflict",
    );
    assert_error(
        &turn_status(
            &conn,
            "running-status-different-submission",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "status-owner-turn",
            "running",
            Some("sdk-submit-two"),
            None,
            None,
        ),
        "conflict",
    );
    let current = inspect_turn(
        &conn,
        "fresh-inspection-after-replay-conflicts",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "status-owner-turn",
    );
    assert_success(&current);
    assert_eq!(current.data["run"]["state"], "running");
    assert_eq!(current.data["run"]["submission_id"], "sdk-submit-one");

    assert_success(&turn_status(
        &conn,
        "answered-status-one",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "status-owner-turn",
        "answered",
        Some("sdk-submit-one"),
        Some("sdk-entry-one"),
        None,
    ));
    let before_reply = inspect_conversation(
        &conn,
        "history-after-status-not-reply",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_success(&before_reply);
    assert_eq!(before_reply.data["turns"].as_array().unwrap().len(), 1);
    assert_eq!(before_reply.data["turns"][0]["kind"], "user");
    assert_eq!(before_reply.data["turn_runs"][0]["state"], "answered");

    assert_success(&reply(
        &conn,
        "assistant-entry-one",
        ROOT_GHOST,
        "status-owner-turn",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "The committed answer is now visible.",
    ));
    let after_reply = inspect_conversation(
        &conn,
        "history-after-actual-reply",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_success(&after_reply);
    assert_eq!(after_reply.data["turns"].as_array().unwrap().len(), 2);
    assert_eq!(after_reply.data["turns"][1]["kind"], "assistant_advisory");
    assert_eq!(after_reply.data["turns"][1]["source_turn_id"], "status-owner-turn");
    assert_eq!(after_reply.data["turn_runs"][0]["state"], "answered");
    let assistant_only_page = envelope(
        "inspect-assistant-source-page",
        OWNER,
        json!({
            "method": "conversation.inspect",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "limit": 1,
        }),
    );
    let assistant_page = send(&conn, &assistant_only_page, OWNER);
    assert_success(&assistant_page);
    assert_eq!(assistant_page.data["turns"].as_array().unwrap().len(), 1);
    assert_eq!(assistant_page.data["turns"][0]["kind"], "assistant_advisory");
    assert_eq!(assistant_page.data["turn_runs"].as_array().unwrap().len(), 1);
    assert_eq!(assistant_page.data["turn_runs"][0]["turn_id"], "status-owner-turn");

    assert_error(
        &turn_status(
            &conn,
            "contradict-answered-with-failed",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "status-owner-turn",
            "failed",
            Some("sdk-submit-one"),
            Some("sdk-entry-one"),
            Some("runtime_failure"),
        ),
        "conflict",
    );
    assert_error(
        &reply(
            &conn,
            "second-advisory-for-same-turn",
            ROOT_GHOST,
            "status-owner-turn",
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "A second entry must not replace the immutable reply.",
        ),
        "conflict",
    );
    assert_eq!(pending_outbox(&conn).unwrap().len(), 1);
}

#[test]
fn effect_unknown_resolves_only_from_actual_status_without_resubmission() {
    let (_root, conn) = database();
    assert_success(&owner_input(
        &conn,
        "unknown-effect-turn",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "Reconcile this existing turn.",
        "private",
        vec![],
    ));
    let unknown = turn_status(
        &conn,
        "unknown-effect-status",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "unknown-effect-turn",
        "effect_unknown",
        None,
        None,
        Some("effect_unconfirmed"),
    );
    assert_success(&unknown);
    assert_eq!(unknown.data["run"]["state"], "effect_unknown");
    assert_eq!(pending_outbox(&conn).unwrap().len(), 1);

    let reconciled = turn_status(
        &conn,
        "reconciled-existing-entry",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "unknown-effect-turn",
        "answered",
        None,
        Some("sdk-existing-entry"),
        None,
    );
    assert_success(&reconciled);
    assert_eq!(reconciled.data["run"]["state"], "answered");
    assert_eq!(reconciled.data["run"]["entry_id"], "sdk-existing-entry");
    assert_eq!(pending_outbox(&conn).unwrap().len(), 1);

    let before_reply = inspect_conversation(
        &conn,
        "inspect-unknown-reconciled-status",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_success(&before_reply);
    assert_eq!(
        before_reply.data["turns"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|turn| turn["kind"] == "assistant_advisory")
            .count(),
        0
    );
    assert_eq!(
        before_reply.data["turns"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|turn| turn["kind"] == "host_fact")
            .count(),
        1
    );

    assert_success(&reply(
        &conn,
        "reply-for-reconciled-entry",
        ROOT_GHOST,
        "unknown-effect-turn",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "The previously committed answer is now projected.",
    ));
    assert_eq!(pending_outbox(&conn).unwrap().len(), 1);
}

#[test]
fn private_failure_fact_is_safe_sticky_and_idempotent() {
    let (_root, conn) = database();
    assert_success(&owner_input(
        &conn,
        "private-failure-turn",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "Keep this request private.",
        "private",
        vec![],
    ));
    let failed = turn_status(
        &conn,
        "private-failure-status",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "private-failure-turn",
        "failed",
        None,
        None,
        Some("model_request_failed"),
    );
    assert_success(&failed);
    assert_eq!(failed.data["run"]["state"], "failed");
    assert_eq!(failed.data["run"]["reason_code"], "model_request_failed");

    let history = inspect_conversation(
        &conn,
        "inspect-private-failure-fact",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_success(&history);
    assert_eq!(history.data["privacy"], "private");
    let facts: Vec<&Value> = history.data["turns"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|turn| turn["kind"] == "host_fact")
        .collect();
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0]["sender_kind"], "host");
    assert_eq!(facts[0]["privacy"], "private");
    assert_eq!(facts[0]["source_turn_id"], "private-failure-turn");
    let fact_only_page = envelope(
        "inspect-host-fact-source-page",
        OWNER,
        json!({
            "method": "conversation.inspect",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "limit": 1,
        }),
    );
    let fact_page = send(&conn, &fact_only_page, OWNER);
    assert_success(&fact_page);
    assert_eq!(fact_page.data["turns"].as_array().unwrap().len(), 1);
    assert_eq!(fact_page.data["turns"][0]["kind"], "host_fact");
    assert_eq!(fact_page.data["turn_runs"].as_array().unwrap().len(), 1);
    assert_eq!(fact_page.data["turn_runs"][0]["turn_id"], "private-failure-turn");

    let repeated = turn_status(
        &conn,
        "private-failure-status-repeat",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "private-failure-turn",
        "failed",
        None,
        None,
        Some("model_request_failed"),
    );
    assert_success(&repeated);
    assert_eq!(repeated.data["run"]["latest_status_command_id"], "private-failure-status");
    let history_after_repeat = inspect_conversation(
        &conn,
        "inspect-private-failure-fact-again",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    let fact_count = history_after_repeat.data["turns"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|turn| turn["kind"] == "host_fact")
        .count();
    assert_eq!(fact_count, 1);

    assert_error(
        &turn_status(
            &conn,
            "raw-provider-error-rejected",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "private-failure-turn",
            "failed",
            None,
            None,
            Some("Connection error: socket reset"),
        ),
        "invalid_request",
    );
    assert_eq!(pending_outbox(&conn).unwrap().len(), 1);
}

#[test]
fn cancellation_preserves_admitted_work_and_artifacts_and_rejects_late_reply() {
    let (_root, conn) = database();
    let (background_goal_id, background_work_id, artifact) = seed_background_artifact(&conn);
    assert_success(&owner_input(
        &conn,
        "cancel-with-existing-effects",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "Continue the current work.",
        "public",
        vec![artifact.clone()],
    ));
    assert_success(&turn_status(
        &conn,
        "cancel-existing-running-status",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "cancel-with-existing-effects",
        "running",
        Some("sdk-submit-existing"),
        None,
        None,
    ));

    let derived = create_goal(
        &conn,
        "goal-before-cancel",
        ROOT_GHOST,
        "cancel-with-existing-effects",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "A separately accepted Host Goal.",
    );
    assert_success(&derived);
    let derived_goal_id = derived.data["goal"]["id"].as_str().unwrap().to_owned();
    let derived_work_id = derived.data["work"]["id"].as_str().unwrap().to_owned();
    let goal_before = inspect_goal(&conn, "inspect-derived-goal-before-cancel", &derived_goal_id);
    let work_before = inspect_work(&conn, "inspect-derived-work-before-cancel", &derived_work_id);
    let artifact_work_before = inspect_work(&conn, "inspect-existing-artifact-before-cancel", &background_work_id);
    assert_success(&goal_before);
    assert_success(&work_before);
    assert_success(&artifact_work_before);
    assert_eq!(artifact_work_before.data["result"]["current"], true);
    assert_eq!(
        artifact_work_before.data["result"]["event"]["artifacts"][0]["digest"].as_str(),
        Some(artifact.digest.as_str())
    );

    let cancel = cancel_turn(
        &conn,
        "request-cancel-with-existing-effects",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "cancel-with-existing-effects",
    );
    assert_success(&cancel);
    assert_eq!(cancel.data["run"]["state"], "running");
    assert_eq!(cancel.data["run"]["cancel_requested"], true);
    assert_eq!(cancel.data["completed"], false);

    let after_request = create_goal(
        &conn,
        "goal-after-cancel-request",
        ROOT_GHOST,
        "cancel-with-existing-effects",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "This new Goal must be fenced.",
    );
    assert_error(&after_request, "conflict");
    let goal_after = inspect_goal(&conn, "inspect-derived-goal-after-cancel", &derived_goal_id);
    let work_after = inspect_work(&conn, "inspect-derived-work-after-cancel", &derived_work_id);
    let artifact_work_after = inspect_work(&conn, "inspect-existing-artifact-after-cancel", &background_work_id);
    assert_eq!(goal_after.data, goal_before.data);
    assert_eq!(work_after.data, work_before.data);
    assert_eq!(artifact_work_after.data, artifact_work_before.data);
    assert_eq!(snapshot(&conn).unwrap().goals.len(), 2);
    assert_eq!(snapshot(&conn).unwrap().work.len(), 2);

    conn.execute(
        "UPDATE lifetime_registry SET mode='draining' WHERE ghost_id=?1",
        [ROOT_GHOST],
    )
    .unwrap();
    let repeated_while_draining = cancel_turn(
        &conn,
        "repeat-cancel-while-draining",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "cancel-with-existing-effects",
    );
    assert_success(&repeated_while_draining);
    let blocked_new_input = owner_input(
        &conn,
        "new-input-while-draining",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "A new model-owned run must not start.",
        "public",
        vec![],
    );
    assert_error(&blocked_new_input, "waiting_host");
    let blocked_new_goal = create_goal(
        &conn,
        "new-goal-while-draining",
        ROOT_GHOST,
        "cancel-with-existing-effects",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "A draining Ghost must not start new model-owned work.",
    );
    assert_error(&blocked_new_goal, "waiting_host");

    let confirmed = turn_status(
        &conn,
        "confirm-existing-turn-cancelled",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "cancel-with-existing-effects",
        "cancelled",
        Some("sdk-submit-existing"),
        None,
        Some("owner_cancelled"),
    );
    assert_success(&confirmed);
    assert_eq!(confirmed.data["run"]["state"], "cancelled");
    assert_eq!(confirmed.data["run"]["cancel_requested"], true);
    assert_eq!(pending_outbox(&conn).unwrap().len(), 2);
    assert!(pending_outbox(&conn).unwrap().iter().all(|item| item.target == "pi"));

    assert_error(
        &reply(
            &conn,
            "late-reply-after-confirmed-cancel",
            ROOT_GHOST,
            "cancel-with-existing-effects",
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "This late answer must remain SDK evidence, not a Host advisory.",
        ),
        "conflict",
    );
    let history = inspect_conversation(
        &conn,
        "inspect-cancelled-source-and-fact",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_success(&history);
    assert_eq!(history.data["privacy"], "private");
    assert_eq!(
        history.data["turns"][0]["attachments"][0]["digest"].as_str(),
        Some(artifact.digest.as_str())
    );
    assert_eq!(history.data["turns"][0]["kind"], "user");
    assert_eq!(
        history.data["turns"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|turn| turn["kind"] == "assistant_advisory")
            .count(),
        0
    );
    assert_eq!(
        history.data["turns"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|turn| turn["kind"] == "host_fact")
            .count(),
        1
    );
    let still_there = inspect_work(&conn, "inspect-existing-artifact-after-confirmed-cancel", &background_work_id);
    assert_success(&still_there);
    assert_eq!(still_there.data["result"]["current"], true);
    assert_eq!(
        still_there.data["result"]["event"]["artifacts"][0]["digest"].as_str(),
        Some(artifact.digest.as_str())
    );
    assert_eq!(still_there.data["work"]["state"], "completed");
    assert_eq!(still_there.data["work"]["cancellation"], "none");
    let background_goal_after =
        inspect_goal(&conn, "inspect-background-goal-after-cancel", &background_goal_id);
    assert_success(&background_goal_after);
    assert_eq!(
        background_goal_after.data["goal"]["id"].as_str(),
        Some(background_goal_id.as_str())
    );
    let derived_goal_after_confirmation =
        inspect_goal(&conn, "inspect-derived-goal-after-confirmation", &derived_goal_id);
    let derived_work_after_confirmation =
        inspect_work(&conn, "inspect-derived-work-after-confirmation", &derived_work_id);
    assert_success(&derived_goal_after_confirmation);
    assert_success(&derived_work_after_confirmation);
    assert_eq!(derived_goal_after_confirmation.data, goal_before.data);
    assert_eq!(derived_work_after_confirmation.data, work_before.data);
}
