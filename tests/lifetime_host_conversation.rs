#![cfg(feature = "lifetime")]

use ghost::{
    host::lifetime::{apply, pending_outbox},
    lifetime_contract::{
        canonical_digest, Artifact, Envelope, Response, ResponseStatus, WorkerSpec, VERSION,
    },
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;
use tempfile::TempDir;

const CANARY_ROOT: &str = ".lifetime-canary/ghost-20261009T012047Z/A3-tests";
const OWNER: &str = "owner";
const ROOT_GHOST: &str = "22222222-2222-7222-8222-222222222222";
const ROOT_CONVERSATION: &str = "11111111-1111-7111-8111-111111111111";
const TARGET_GHOST: &str = "33333333-3333-7333-8333-333333333333";
const TARGET_CONVERSATION: &str = "33333333-3333-7333-8333-444444444444";

fn database() -> (TempDir, Connection) {
    let canary = Path::new(env!("CARGO_MANIFEST_DIR")).join(CANARY_ROOT);
    std::fs::create_dir_all(&canary).unwrap();
    let root = tempfile::Builder::new()
        .prefix("host-conversation-")
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
    connection
        .execute_batch(include_str!("../contracts/lifetime/migration-009.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../contracts/lifetime/migration-010.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../contracts/lifetime/migration-011.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../contracts/lifetime/migration-012.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../contracts/lifetime/migration-013.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../contracts/lifetime/migration-014.sql"))
        .unwrap();
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

fn envelope(
    command_id: &str,
    principal: &str,
    body: Value,
) -> Envelope {
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

fn inspect(
    conn: &Connection,
    command_id: &str,
    ghost_id: &str,
    conversation_id: &str,
    optional: Value,
) -> Response {
    let mut body = json!({
        "method": "conversation.inspect",
        "ghost_id": ghost_id,
        "conversation_id": conversation_id,
    });
    for (key, value) in optional.as_object().unwrap() {
        body[key.as_str()] = value.clone();
    }
    let request = envelope(command_id, OWNER, body);
    send(conn, &request, OWNER)
}

fn inspect_assignment(
    conn: &Connection,
    command_id: &str,
    principal: &str,
    ghost_id: &str,
    conversation_id: &str,
    assignment_id: &str,
) -> Response {
    let request = envelope(
        command_id,
        principal,
        json!({
            "method": "conversation.assignment.inspect",
            "assignment_id": assignment_id,
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
        }),
    );
    send(conn, &request, principal)
}

fn goal_create(
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

fn seed_artifact(conn: &Connection, artifact: &Artifact) {
    let goal_id = "artifact-goal";
    let work_id = "artifact-work";
    let goal = json!({
        "id": goal_id,
        "revision": 1,
        "requirement_digest": "a".repeat(64),
        "prompt": "Fixture source artifact",
        "accountable_ghost": ROOT_GHOST,
        "reply_conversation": ROOT_CONVERSATION,
        "privacy": "public",
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
        "execution_id": artifact.producing_attempt,
        "cancellation": "none",
        "blocker": null,
    });
    let result = json!({
        "event": {
            "method": "work.result",
            "goal_revision": 1,
            "artifacts": [artifact],
            "summary": "Fixture artifact record",
        },
        "producer": "fixture-worker",
        "epoch": 1,
        "sequence": 1,
        "current": true,
        "reason": null,
    });
    conn.execute(
        "INSERT INTO lifetime_goals(id,revision,requirement_digest,accountable_ghost,reply_conversation,privacy,state,payload)
         VALUES(?1,1,?2,?3,?4,'public','open',?5)",
        params![goal_id, "a".repeat(64), ROOT_GHOST, ROOT_CONVERSATION, goal.to_string()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO lifetime_work(id,goal_id,goal_revision,owner,owner_revision,state,execution_id,cancellation,payload)
         VALUES(?1,?2,1,?3,1,'completed',?4,'none',?5)",
        params![work_id, goal_id, ROOT_GHOST, artifact.producing_attempt, work.to_string()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO lifetime_results(execution_id,work_id,goal_revision,payload_digest,payload)
         VALUES(?1,?2,1,?3,?4)",
        params![
            artifact.producing_attempt,
            work_id,
            "b".repeat(64),
            result.to_string(),
        ],
    )
    .unwrap();
}

fn seed_goal_context(
    conn: &Connection,
    goal_id: &str,
    ghost_id: &str,
    conversation_id: &str,
    privacy: &str,
) {
    let goal = json!({
        "id": goal_id,
        "revision": 1,
        "requirement_digest": "d".repeat(64),
        "prompt": "Existing protected Goal context",
        "accountable_ghost": ghost_id,
        "reply_conversation": conversation_id,
        "privacy": privacy,
        "state": "open",
        "acceptance_spec": {"required_checks": ["artifact_content"]},
    });
    conn.execute(
        "INSERT INTO lifetime_goals(id,revision,requirement_digest,accountable_ghost,reply_conversation,privacy,state,payload)
         VALUES(?1,1,?2,?3,?4,?5,'open',?6)",
        params![
            goal_id,
            "d".repeat(64),
            ghost_id,
            conversation_id,
            privacy,
            goal.to_string(),
        ],
    )
    .unwrap();
}

#[test]
fn owner_goal_assignment_retains_source_and_protected_conversation_floor() {
    let (_root, conn) = database();
    let private_turn = owner_input(
        &conn,
        "protected-owner-turn",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "Local-only context in the canonical conversation",
        "local_only",
        vec![],
    );
    assert_success(&private_turn);

    let admission = envelope(
        "owner-goal-assignment",
        OWNER,
        json!({
            "method": "goal.submit",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "prompt": "Owner Goal admitted in an existing conversation",
            "privacy": "public",
            "acceptance_spec": {"required_checks": ["artifact_content"]},
        }),
    );
    let admitted = send(&conn, &admission, OWNER);
    assert_success(&admitted);
    let goal_id = admitted.data["goal"]["id"].as_str().unwrap().to_owned();
    let work_id = admitted.data["work"]["id"].as_str().unwrap().to_owned();
    let assignment = pending_outbox(&conn)
        .unwrap()
        .into_iter()
        .find(|item| item.target == "pi" && item.payload["body"]["work_id"] == work_id)
        .unwrap();
    let assignment_id = assignment.payload["command_id"].as_str().unwrap().to_owned();

    let inspected = inspect_assignment(
        &conn,
        "inspect-owner-goal-assignment",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        &assignment_id,
    );
    assert_success(&inspected);
    assert_eq!(inspected.data["assignment"]["id"], assignment_id);
    assert_eq!(inspected.data["assignment"]["source_command_id"], "owner-goal-assignment");
    assert_eq!(inspected.data["assignment"]["origin_kind"], "owner_goal");
    assert_eq!(inspected.data["assignment"]["ghost_id"], ROOT_GHOST);
    assert_eq!(inspected.data["assignment"]["conversation_id"], ROOT_CONVERSATION);
    assert_eq!(inspected.data["assignment"]["goal_id"], goal_id);
    assert_eq!(inspected.data["assignment"]["work_id"], work_id);
    assert_eq!(inspected.data["assignment"]["parent_work_id"], Value::Null);
    assert_eq!(inspected.data["assignment"]["root_goal_id"], goal_id);
    assert_eq!(inspected.data["assignment"]["privacy"], "local_only");

    let replayed = inspect_assignment(
        &conn,
        "inspect-owner-goal-assignment",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        &assignment_id,
    );
    assert_eq!(replayed, inspected);
    assert_error(
        &inspect_assignment(
            &conn,
            "inspect-owner-goal-assignment",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "different-assignment",
        ),
        "conflict",
    );

    assert_error(
        &inspect_assignment(
            &conn,
            "owner-cannot-impersonate-assignment-target",
            OWNER,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            &assignment_id,
        ),
        "unauthorized",
    );
    assert_error(
        &inspect_assignment(
            &conn,
            "unknown-assignment-source",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "unknown-assignment",
        ),
        "not_found",
    );

    let spec = WorkerSpec {
        execution_id: "execution-owner-goal-assignment".to_owned(),
        work_id: work_id.clone(),
        work_revision: 1,
        authority_epoch: 1,
        computer_id: "computer-fixture".to_owned(),
        cwd: "/workspace/canary".to_owned(),
        prompt: admitted.data["goal"]["prompt"]
            .as_str()
            .unwrap()
            .to_owned(),
        model: "fixture-model".to_owned(),
        thinking: "max".to_owned(),
        allowed_tools: vec!["read".to_owned()],
        deadline_ms: 30_000,
        max_progress_bytes: 4096,
        skills: None,
        input_artifacts: None,
    };
    let body = json!({
        "method": "work.submit",
        "work_id": work_id,
        "spec": serde_json::to_value(&spec).unwrap(),
    });
    let mut submission = envelope("submit-owner-goal-work", ROOT_GHOST, body);
    submission.expected_revision = Some(spec.work_revision);
    assert_success(&send(&conn, &submission, ROOT_GHOST));

    let continued = inspect_assignment(
        &conn,
        "inspect-owner-goal-after-work-submit",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        &assignment_id,
    );
    assert_success(&continued);
    assert_eq!(continued.data["assignment"]["privacy"], "local_only");
}

#[test]
fn natural_input_is_idempotent_paged_and_does_not_create_goal_or_work() {
    let (_root, conn) = database();
    let request = envelope(
        "owner-turn-1",
        OWNER,
        json!({
            "method": "conversation.input",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "text": "What changed in the project?",
            "privacy": "public",
            "attachments": [],
        }),
    );
    let first = send(&conn, &request, OWNER);
    assert_success(&first);
    assert_eq!(first.data["turn_id"], "owner-turn-1");
    assert_eq!(first.data["sequence"], 1);
    assert_eq!(first.data["privacy"], "public");
    assert_eq!(first.data["queued"], true);
    assert_eq!(send(&conn, &request, OWNER), first);

    let second = owner_input(
        &conn,
        "owner-turn-2",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "And list the open questions.",
        "public",
        vec![],
    );
    assert_success(&second);
    assert_eq!(second.data["sequence"], 2);
    let first_page = inspect(
        &conn,
        "inspect-latest",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        json!({ "limit": 1 }),
    );
    assert_success(&first_page);
    assert_eq!(first_page.data["turns"][0]["id"], "owner-turn-2");
    assert_eq!(first_page.data["turns"][0]["sequence"], 2);
    assert_eq!(first_page.data["has_older"], true);
    assert_eq!(first_page.data["oldest_sequence"], 2);

    let older_page = inspect(
        &conn,
        "inspect-older",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        json!({ "before_sequence": 2, "limit": 1 }),
    );
    assert_success(&older_page);
    assert_eq!(older_page.data["turns"][0]["id"], "owner-turn-1");
    assert_eq!(older_page.data["turns"][0]["sequence"], 1);
    assert_eq!(older_page.data["has_older"], false);

    let mut changed_body = request.body.clone();
    changed_body["text"] = json!("different content under the same ID");
    let changed = envelope("owner-turn-1", OWNER, changed_body);
    assert_error(&send(&conn, &changed, OWNER), "conflict");

    let too_large = owner_input(
        &conn,
        "owner-turn-too-large",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        &"x".repeat(65_537),
        "public",
        vec![],
    );
    assert_error(&too_large, "invalid_request");

    let goal_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM lifetime_goals", [], |row| row.get(0))
        .unwrap();
    let work_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM lifetime_work", [], |row| row.get(0))
        .unwrap();
    let turn_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM lifetime_turns", [], |row| row.get(0))
        .unwrap();
    assert_eq!(goal_count, 0);
    assert_eq!(work_count, 0);
    assert_eq!(turn_count, 2);

    let outbox = pending_outbox(&conn).unwrap();
    assert_eq!(outbox.len(), 2);
    for item in outbox {
        assert_eq!(item.target, "pi");
        assert_eq!(item.payload["body"]["method"], "conversation.input");
        assert!(item.payload["body"].get("goal_id").is_none());
    }
}

#[test]
fn attachment_privacy_and_prior_turn_disclosure_are_sticky() {
    let (_root, conn) = database();
    let artifact = Artifact {
        digest: "c".repeat(64),
        locator: "artifact://canary/private-note.txt".to_owned(),
        privacy: "local_only".to_owned(),
        producing_attempt: "artifact-execution".to_owned(),
    };
    seed_artifact(&conn, &artifact);

    let attached = owner_input(
        &conn,
        "attached-turn",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "Please use this private result.",
        "public",
        vec![artifact.clone()],
    );
    assert_success(&attached);
    assert_eq!(attached.data["privacy"], "local_only");

    let later_public = owner_input(
        &conn,
        "later-public-turn",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "This later text asks for public disclosure.",
        "public",
        vec![],
    );
    assert_success(&later_public);
    assert_eq!(later_public.data["privacy"], "local_only");

    let disclosure: String = conn
        .query_row(
            "SELECT privacy FROM lifetime_conversation_disclosure WHERE ghost_id=?1 AND conversation_id=?2",
            params![ROOT_GHOST, ROOT_CONVERSATION],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(disclosure, "local_only");
    let page = inspect(
        &conn,
        "inspect-protected-history",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        json!({}),
    );
    assert_success(&page);
    assert_eq!(page.data["privacy"], "local_only");
    assert_eq!(page.data["turns"][0]["privacy"], "local_only");
    assert_eq!(page.data["turns"][0]["attachments"][0]["privacy"], "local_only");

    let mut forged = artifact;
    forged.privacy = "public".to_owned();
    let rejected = owner_input(
        &conn,
        "forged-attachment-turn",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "Try to relabel the stored artifact.",
        "public",
        vec![forged],
    );
    assert_error(&rejected, "not_found");
    let turn_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM lifetime_turns", [], |row| row.get(0))
        .unwrap();
    assert_eq!(turn_count, 2);
}

#[test]
fn protected_existing_goal_context_cannot_be_downgraded_by_public_input() {
    let (_root, conn) = database();
    seed_goal_context(
        &conn,
        "existing-protected-goal",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "local_only",
    );
    let response = owner_input(
        &conn,
        "public-after-protected-goal",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "The caller requests public disclosure after a protected Goal.",
        "public",
        vec![],
    );
    assert_success(&response);
    assert_eq!(response.data["privacy"], "local_only");

    let outbox = pending_outbox(&conn).unwrap();
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].payload["body"]["privacy"], "local_only");
    let disclosure: String = conn
        .query_row(
            "SELECT privacy FROM lifetime_conversation_disclosure WHERE ghost_id=?1 AND conversation_id=?2",
            params![ROOT_GHOST, ROOT_CONVERSATION],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(disclosure, "local_only");
    let goals: i64 = conn
        .query_row("SELECT COUNT(*) FROM lifetime_goals", [], |row| row.get(0))
        .unwrap();
    assert_eq!(goals, 1);
}

#[test]
fn exact_registered_pair_and_owner_scope_are_required() {
    let (_root, conn) = database();
    let cross_pair = owner_input(
        &conn,
        "cross-pair-input",
        ROOT_GHOST,
        TARGET_CONVERSATION,
        "Do not bind the other Ghost's conversation.",
        "public",
        vec![],
    );
    assert_error(&cross_pair, "unauthorized");

    let inspect_cross_pair = inspect(
        &conn,
        "cross-pair-inspect",
        ROOT_GHOST,
        TARGET_CONVERSATION,
        json!({}),
    );
    assert_error(&inspect_cross_pair, "unauthorized");

    let unregistered = owner_input(
        &conn,
        "unregistered-input",
        "77777777-7777-7777-8777-777777777777",
        "77777777-7777-7777-8777-888888888888",
        "No ad hoc conversation identity.",
        "public",
        vec![],
    );
    assert_error(&unregistered, "not_found");

    let nonowner_input = envelope(
        "nonowner-input",
        ROOT_GHOST,
        json!({
            "method": "conversation.input",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "text": "A Ghost callback cannot impersonate owner intake.",
            "privacy": "public",
            "attachments": [],
        }),
    );
    assert_error(&send(&conn, &nonowner_input, ROOT_GHOST), "unauthorized");
    let nonowner_inspect = envelope(
        "nonowner-inspect",
        ROOT_GHOST,
        json!({
            "method": "conversation.inspect",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
        }),
    );
    assert_error(&send(&conn, &nonowner_inspect, ROOT_GHOST), "unauthorized");

    let user_turn = owner_input(
        &conn,
        "registered-origin",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "A registered owner turn.",
        "public",
        vec![],
    );
    assert_success(&user_turn);
    let wrong_origin = goal_create(
        &conn,
        "wrong-origin",
        ROOT_GHOST,
        "registered-origin",
        ROOT_GHOST,
        TARGET_CONVERSATION,
        "A mismatched origin must not create a Goal.",
    );
    assert_error(&wrong_origin, "unauthorized");
    let goals: i64 = conn
        .query_row("SELECT COUNT(*) FROM lifetime_goals", [], |row| row.get(0))
        .unwrap();
    assert_eq!(goals, 0);
}

#[test]
fn derived_goals_keep_origin_limit_four_and_do_not_enqueue_another_pi_turn() {
    let (_root, conn) = database();
    let turn = owner_input(
        &conn,
        "natural-origin",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "Find the three compatibility risks and summarize them.",
        "private",
        vec![],
    );
    assert_success(&turn);
    let turn_id = turn.data["turn_id"].as_str().unwrap();
    let first_request = envelope(
        "derived-goal-1",
        ROOT_GHOST,
        json!({
            "method": "goal.create",
            "turn_id": turn_id,
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "prompt": "Check compatibility risk one.",
            "acceptance_spec": { "required_checks": ["artifact_content"] },
        }),
    );
    let first = send(&conn, &first_request, ROOT_GHOST);
    assert_success(&first);
    assert_eq!(first.data["origin_turn_id"], turn_id);
    assert_eq!(first.data["goal"]["privacy"], "private");
    let first_goal_id = first.data["goal"]["id"].as_str().unwrap().to_owned();
    assert_eq!(send(&conn, &first_request, ROOT_GHOST), first);

    for index in 2..=4 {
        let response = goal_create(
            &conn,
            &format!("derived-goal-{index}"),
            ROOT_GHOST,
            turn_id,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            &format!("Check compatibility risk {index}."),
        );
        assert_success(&response);
        assert_eq!(response.data["origin_turn_id"], turn_id);
    }
    let fifth = goal_create(
        &conn,
        "derived-goal-5",
        ROOT_GHOST,
        turn_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "A fifth Goal exceeds the owner-turn budget.",
    );
    assert_error(&fifth, "limit_reached");

    let origins: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM lifetime_turn_goals WHERE turn_id=?1",
            [turn_id],
            |row| row.get(0),
        )
        .unwrap();
    let goals: i64 = conn
        .query_row("SELECT COUNT(*) FROM lifetime_goals", [], |row| row.get(0))
        .unwrap();
    assert_eq!(origins, 4);
    assert_eq!(goals, 4);
    let first_origin: String = conn
        .query_row(
            "SELECT turn_id FROM lifetime_turn_goals WHERE goal_id=?1",
            [first_goal_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(first_origin, turn_id);

    let outbox = pending_outbox(&conn).unwrap();
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].payload["body"]["method"], "conversation.input");
    assert_eq!(outbox[0].payload["body"]["turn_id"], turn_id);
    assert!(outbox[0].payload["body"].get("goal_id").is_none());
    assert_eq!(outbox[0].target, "pi");
}

#[test]
fn committed_reply_is_advisory_immutable_and_scoped_to_its_owner_turn() {
    let (_root, conn) = database();
    let turn = owner_input(
        &conn,
        "reply-source-turn",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "Explain the current blocker.",
        "private",
        vec![],
    );
    assert_success(&turn);
    let running = envelope(
        "reply-source-running",
        ROOT_GHOST,
        json!({
            "method": "conversation.turn_status",
            "turn_id": "reply-source-turn",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "status": "running",
            "submission_id": "17",
            "entry_id": null,
            "reason_code": null,
        }),
    );
    assert_success(&send(&conn, &running, ROOT_GHOST));

    let draining = envelope(
        "drain-root",
        OWNER,
        json!({
            "method": "registry.mode",
            "ghost_id": ROOT_GHOST,
            "mode": "draining",
        }),
    );
    assert_success(&send(&conn, &draining, OWNER));

    let reply_request = envelope(
        "stable-pi-entry:root:entry-17",
        ROOT_GHOST,
        json!({
            "method": "conversation.reply",
            "turn_id": "reply-source-turn",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "text": "The worker is waiting for a current local route.",
        }),
    );
    let first = send(&conn, &reply_request, ROOT_GHOST);
    assert_success(&first);
    assert_eq!(first.data["turn_id"], reply_request.command_id);
    assert_eq!(first.data["source_turn_id"], "reply-source-turn");
    assert_eq!(first.data["kind"], "assistant_advisory");
    assert_eq!(first.data["privacy"], "private");
    assert_eq!(send(&conn, &reply_request, ROOT_GHOST), first);

    let changed_reply = envelope(
        &reply_request.command_id,
        ROOT_GHOST,
        json!({
            "method": "conversation.reply",
            "turn_id": "reply-source-turn",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "text": "Different text under the same Pi entry ID.",
        }),
    );
    assert_error(&send(&conn, &changed_reply, ROOT_GHOST), "conflict");

    let wrong_pair = reply(
        &conn,
        "wrong-pair-reply",
        ROOT_GHOST,
        "reply-source-turn",
        ROOT_GHOST,
        TARGET_CONVERSATION,
        "A callback from another conversation is denied.",
    );
    assert_error(&wrong_pair, "unauthorized");
    let owner_forgery = reply(
        &conn,
        "owner-forged-reply",
        OWNER,
        "reply-source-turn",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "Owner transport cannot impersonate the Pi callback.",
    );
    assert_error(&owner_forgery, "unauthorized");

    let turn_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM lifetime_turns", [], |row| row.get(0))
        .unwrap();
    let advisory_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM lifetime_turns WHERE kind='assistant_advisory' AND source_turn_id='reply-source-turn'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let acceptance_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM lifetime_acceptances", [], |row| row.get(0))
        .unwrap();
    assert_eq!(turn_count, 2);
    assert_eq!(advisory_count, 1);
    assert_eq!(acceptance_count, 0);
}

#[test]
fn callbacks_require_the_exact_turn_and_canonical_binding() {
    let (_root, conn) = database();
    let turn = owner_input(
        &conn,
        "scope-turn",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "A source turn for scoped callbacks.",
        "public",
        vec![],
    );
    assert_success(&turn);

    let reply_to_other_ghost = reply(
        &conn,
        "reply-other-ghost",
        TARGET_GHOST,
        "scope-turn",
        TARGET_GHOST,
        TARGET_CONVERSATION,
        "A reply cannot cross Ghosts.",
    );
    assert_error(&reply_to_other_ghost, "unauthorized");
    let goal_from_other_turn = goal_create(
        &conn,
        "goal-other-turn",
        ROOT_GHOST,
        "missing-turn",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "An unknown origin cannot create a Goal.",
    );
    assert_error(&goal_from_other_turn, "not_found");

    let created: i64 = conn
        .query_row("SELECT COUNT(*) FROM lifetime_goals", [], |row| row.get(0))
        .unwrap();
    let replies: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM lifetime_turns WHERE kind='assistant_advisory'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(created, 0);
    assert_eq!(replies, 0);
}

#[test]
fn owner_conversation_methods_reject_unknown_fields_and_bad_page_bounds() {
    let (_root, conn) = database();
    let unknown_field = envelope(
        "unknown-field-input",
        OWNER,
        json!({
            "method": "conversation.input",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "text": "Do not accept a shadow scope field.",
            "privacy": "public",
            "attachments": [],
            "origin": "model-controlled",
        }),
    );
    assert_error(&send(&conn, &unknown_field, OWNER), "invalid_request");

    let page_limit = inspect(
        &conn,
        "invalid-page-limit",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        json!({ "limit": 101 }),
    );
    assert_error(&page_limit, "invalid_request");
    let zero_limit = inspect(
        &conn,
        "zero-page-limit",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        json!({ "limit": 0 }),
    );
    assert_error(&zero_limit, "invalid_request");
}

#[test]
fn authenticated_ghost_can_inspect_its_pair_without_owner_write_authority() {
    let (_root, conn) = database();
    assert_success(&owner_input(
        &conn, "scoped-history-source", ROOT_GHOST, ROOT_CONVERSATION,
        "Private canonical turn", "private", vec![],
    ));
    let scoped_read = envelope("scoped-history-read", ROOT_GHOST, json!({
        "method": "conversation.inspect", "ghost_id": ROOT_GHOST,
        "conversation_id": ROOT_CONVERSATION,
    }));
    let page = send(&conn, &scoped_read, ROOT_GHOST);
    assert_success(&page);
    assert_eq!(page.data["turns"][0]["id"], "scoped-history-source");
    assert_eq!(page.data["turns"][0]["privacy"], "private");

    for (id, ghost, conversation) in [
        ("other-ghost-history", TARGET_GHOST, TARGET_CONVERSATION),
        ("other-conversation-history", ROOT_GHOST, TARGET_CONVERSATION),
    ] {
        let request = envelope(id, ROOT_GHOST, json!({
            "method": "conversation.inspect", "ghost_id": ghost,
            "conversation_id": conversation,
        }));
        let rejected = send(&conn, &request, ROOT_GHOST);
        assert_error(&rejected, "unauthorized");
    }
    let forged_input = envelope("ghost-forged-owner-input", ROOT_GHOST, json!({
        "method": "conversation.input", "ghost_id": ROOT_GHOST,
        "conversation_id": ROOT_CONVERSATION, "text": "Forged Owner input.",
        "privacy": "public", "attachments": [],
    }));
    assert_error(&send(&conn, &forged_input, ROOT_GHOST), "unauthorized");
    let turn_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM lifetime_turns", [], |row| row.get(0),
    ).unwrap();
    assert_eq!(turn_count, 1);
}

fn insert_assignment_outbox(
    conn: &Connection,
    source_command_id: &str,
    assignment_id: &str,
    actor: &str,
    ghost_id: &str,
    conversation_id: &str,
    goal_id: &str,
    goal_revision: u64,
    work_id: &str,
    prompt: &str,
    privacy: &str,
) {
    let mut receiver = envelope(
        assignment_id,
        actor,
        json!({
            "method": "conversation.assignment",
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
            "goal_id": goal_id,
            "goal_revision": goal_revision,
            "work_id": work_id,
            "prompt": prompt,
            "privacy": privacy,
        }),
    );
    receiver.expected_revision = Some(goal_revision);
    receiver.correlation_id = format!("corr-{source_command_id}");
    conn.execute(
        "INSERT INTO lifetime_outbox(command_id,target,delivery_ref,payload) VALUES(?1,'pi',?2,?3)",
        params![
            source_command_id,
            assignment_id,
            serde_json::to_string(&receiver).unwrap(),
        ],
    )
    .unwrap();
}

#[test]
fn model_created_owner_turn_root_is_assignable_and_survives_revision() {
    let (_root, conn) = database();
    let turn = owner_input(
        &conn,
        "model-root-origin",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "Summarize the migration risk for the quarterly review.",
        "private",
        vec![],
    );
    assert_success(&turn);
    let turn_id = turn.data["turn_id"].as_str().unwrap().to_owned();
    let created = goal_create(
        &conn,
        "model-root",
        ROOT_GHOST,
        &turn_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "Summarize the migration risk.",
    );
    assert_success(&created);
    assert_eq!(created.data["origin_turn_id"], json!(turn_id));
    let goal_id = created.data["goal"]["id"].as_str().unwrap().to_owned();
    let work_id = created.data["work"]["id"].as_str().unwrap().to_owned();
    assert_eq!(created.data["goal"]["revision"], 1);

    insert_assignment_outbox(
        &conn,
        "model-root",
        "assign-model-root-1",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        &goal_id,
        1,
        &work_id,
        "Summarize the migration risk.",
        "private",
    );
    let inspected = inspect_assignment(
        &conn,
        "inspect-model-root-1",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "assign-model-root-1",
    );
    assert_success(&inspected);
    assert_eq!(inspected.data["assignment"]["origin_kind"], "owner_goal");
    assert_eq!(inspected.data["assignment"]["source_command_id"], "model-root");
    assert_eq!(inspected.data["assignment"]["goal_id"], goal_id.as_str());
    assert_eq!(inspected.data["assignment"]["root_goal_id"], goal_id.as_str());
    assert_eq!(inspected.data["assignment"]["parent_work_id"], Value::Null);

    let mut revision = envelope("revise-model-root", OWNER, json!({
        "method": "goal.update",
        "goal_id": goal_id,
        "prompt": "Revised: summarize the migration risk with owners.",
        "acceptance_spec": { "required_checks": ["artifact_content"] },
    }));
    revision.expected_revision = Some(1);
    let revised = send(&conn, &revision, OWNER);
    assert_success(&revised);
    assert_eq!(revised.data["goal"]["revision"], 2);
    assert_eq!(revised.data["work"][0]["id"], json!(work_id));

    insert_assignment_outbox(
        &conn,
        "revise-model-root",
        "assign-model-root-2",
        OWNER,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        &goal_id,
        2,
        &work_id,
        "Revised: summarize the migration risk with owners.",
        "private",
    );
    let revised_inspected = inspect_assignment(
        &conn,
        "inspect-model-root-2",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "assign-model-root-2",
    );
    assert_success(&revised_inspected);
    assert_eq!(revised_inspected.data["assignment"]["origin_kind"], "owner_goal");
    assert_eq!(
        revised_inspected.data["assignment"]["source_command_id"],
        "revise-model-root"
    );

    // Tampering with the committed Owner-turn provenance must fail closed.
    conn.execute(
        "UPDATE lifetime_turns SET sender_ref='intruder' WHERE id=?1",
        params![turn_id],
    )
    .unwrap();
    assert_error(
        &inspect_assignment(
            &conn,
            "inspect-model-root-tampered",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            "assign-model-root-2",
        ),
        "not_found",
    );
}

#[test]
fn revised_delegated_goal_keeps_canonical_prompt_and_stale_parent_denied() {
    let (_root, conn) = database();
    let admission = envelope("delegate-parent", OWNER, json!({
        "method": "goal.submit",
        "ghost_id": ROOT_GHOST,
        "conversation_id": ROOT_CONVERSATION,
        "prompt": "Report the delegated outcome.",
        "privacy": "public",
        "acceptance_spec": { "required_checks": ["artifact_content"] },
    }));
    let admitted = send(&conn, &admission, OWNER);
    assert_success(&admitted);
    let parent_goal_id = admitted.data["goal"]["id"].as_str().unwrap().to_owned();
    let parent_work_id = admitted.data["work"]["id"].as_str().unwrap().to_owned();

    let mut delegation = envelope("delegate-with-refs", ROOT_GHOST, json!({
        "method": "work.delegate",
        "parent_work_id": parent_work_id,
        "target_ghost_id": TARGET_GHOST,
        "summary": "Return the delegated result.",
        "artifact_refs": ["artifact-alpha", "artifact-beta"],
        "acceptance_spec": { "required_checks": ["artifact_content"] },
    }));
    delegation.expected_revision = Some(1);
    let child = send(&conn, &delegation, ROOT_GHOST);
    assert_success(&child);
    let child_goal_id = child.data["goal"]["id"].as_str().unwrap().to_owned();
    let child_work_id = child.data["work"]["id"].as_str().unwrap().to_owned();
    let canonical_prompt = "Return the delegated result.\n\nOpaque artifact references selected for this delegation (contents were not copied): [\"artifact-alpha\",\"artifact-beta\"]";
    assert_eq!(child.data["goal"]["prompt"], json!(canonical_prompt));

    // The direct delegation delivery verifies the canonical appended prompt.
    let assignment_id = pending_outbox(&conn)
        .unwrap()
        .into_iter()
        .find(|item| {
            item.target == "pi"
                && item.payload["body"]["method"] == "conversation.assignment"
                && item.payload["body"]["work_id"] == json!(child_work_id)
        })
        .map(|item| item.payload["command_id"].as_str().unwrap().to_owned())
        .unwrap();
    let inspected = inspect_assignment(
        &conn,
        "inspect-delegated-child-1",
        TARGET_GHOST,
        TARGET_GHOST,
        TARGET_CONVERSATION,
        &assignment_id,
    );
    assert_success(&inspected);
    assert_eq!(inspected.data["assignment"]["origin_kind"], "delegated_goal");
    assert_eq!(
        inspected.data["assignment"]["prompt"],
        json!(canonical_prompt)
    );
    assert_eq!(
        inspected.data["assignment"]["parent_work_id"],
        json!(parent_work_id)
    );
    assert_eq!(
        inspected.data["assignment"]["root_goal_id"],
        json!(parent_goal_id)
    );

    let mut child_revision = envelope("revise-delegated-child", TARGET_GHOST, json!({
        "method": "goal.update",
        "goal_id": child_goal_id,
        "prompt": "Revised delegated requirement.",
        "acceptance_spec": { "required_checks": ["artifact_content"] },
    }));
    child_revision.expected_revision = Some(1);
    let revised = send(&conn, &child_revision, TARGET_GHOST);
    assert_success(&revised);
    assert_eq!(revised.data["goal"]["revision"], 2);
    assert_eq!(revised.data["work"][0]["id"], json!(child_work_id));

    insert_assignment_outbox(
        &conn,
        "revise-delegated-child",
        "assign-delegated-child-2",
        TARGET_GHOST,
        TARGET_GHOST,
        TARGET_CONVERSATION,
        &child_goal_id,
        2,
        &child_work_id,
        "Revised delegated requirement.",
        "public",
    );
    let revised_inspected = inspect_assignment(
        &conn,
        "inspect-delegated-child-2",
        TARGET_GHOST,
        TARGET_GHOST,
        TARGET_CONVERSATION,
        "assign-delegated-child-2",
    );
    assert_success(&revised_inspected);
    assert_eq!(revised_inspected.data["assignment"]["origin_kind"], "delegated_goal");
    assert_eq!(
        revised_inspected.data["assignment"]["parent_work_id"],
        json!(parent_work_id)
    );

    // Tampering with the committed delegation receipt must fail closed.
    conn.execute(
        "UPDATE lifetime_commands SET response=json_set(response,'$.data.goal.prompt',?1)
         WHERE command_id='delegate-with-refs'",
        params!["Return the delegated result."],
    )
    .unwrap();
    assert_error(
        &inspect_assignment(
            &conn,
            "inspect-delegated-child-tampered",
            TARGET_GHOST,
            TARGET_GHOST,
            TARGET_CONVERSATION,
            "assign-delegated-child-2",
        ),
        "not_found",
    );

    // A stale ancestor revision is a safety boundary, not a reparent permit.
    conn.execute(
        "UPDATE lifetime_commands SET response=json_set(response,'$.data.goal.prompt',?1)
         WHERE command_id='delegate-with-refs'",
        params![canonical_prompt],
    )
    .unwrap();
    let mut parent_revision = envelope("revise-delegate-parent", OWNER, json!({
        "method": "goal.update",
        "goal_id": parent_goal_id,
        "prompt": "Parent moved on without the child.",
        "acceptance_spec": { "required_checks": ["artifact_content"] },
    }));
    parent_revision.expected_revision = Some(1);
    let moved = send(&conn, &parent_revision, OWNER);
    assert_success(&moved);
    let stale = inspect_assignment(
        &conn,
        "inspect-delegated-child-stale",
        TARGET_GHOST,
        TARGET_GHOST,
        TARGET_CONVERSATION,
        "assign-delegated-child-2",
    );
    assert_eq!(stale.status, ResponseStatus::Error);
}
