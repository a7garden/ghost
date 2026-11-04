#![cfg(feature = "lifetime")]

use ghost::{
    host::lifetime::{apply, pending_outbox, snapshot},
    lifetime_contract::{
        canonical_digest, Acceptance, Artifact, Check, Envelope, Response, ResponseStatus,
        RetryClass, WorkerSpec, VERSION,
    },
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{path::Path, time::{SystemTime, UNIX_EPOCH}};
use tempfile::TempDir;

const CANARY_ROOT: &str = ".lifetime-canary/ghost-20261009T012047Z/A2b";
const OWNER: &str = "owner";
const ROOT_GHOST: &str = "22222222-2222-7222-8222-222222222222";
const ROOT_CONVERSATION: &str = "11111111-1111-7111-8111-111111111111";
const TARGET_A: &str = "33333333-3333-7333-8333-333333333333";
const TARGET_A_CONVERSATION: &str = "33333333-3333-7333-8333-444444444444";
const TARGET_B: &str = "55555555-5555-7555-8555-555555555555";
const TARGET_B_CONVERSATION: &str = "55555555-5555-7555-8555-666666666666";

fn database() -> (TempDir, Connection) {
    let canary = Path::new(env!("CARGO_MANIFEST_DIR")).join(CANARY_ROOT);
    std::fs::create_dir_all(&canary).unwrap();
    let root = tempfile::Builder::new()
        .prefix("host-graph-")
        .tempdir_in(canary)
        .unwrap();
    let connection = Connection::open(root.path().join("workspace.db")).unwrap();
    connection.execute_batch(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE workspace_objects(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));",
    ).unwrap();
    for ghost_id in [ROOT_GHOST, TARGET_A, TARGET_B] {
        connection.execute(
            "INSERT INTO workspace_objects(kind,id,payload) VALUES('profile',?1,'preserve-me')",
            [ghost_id],
        ).unwrap();
    }
    connection.execute_batch(include_str!("../contracts/lifetime/migration-005.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-006.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-007.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-008.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-009.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-010.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-011.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-012.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-013.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-014.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-015.sql")).unwrap();
    connection.execute_batch(include_str!("../contracts/lifetime/migration-016.sql")).unwrap();
    connection.execute(
        "UPDATE lifetime_verification_policy SET verifier_revision='fixture-verifier/1' WHERE singleton=1",
        [],
    ).unwrap();
    register_ghost(&connection, "registry-root", ROOT_GHOST, "primary", ROOT_CONVERSATION);
    register_ghost(&connection, "registry-target-a", TARGET_A, "specialist", TARGET_A_CONVERSATION);
    register_ghost(&connection, "registry-target-b", TARGET_B, "specialist", TARGET_B_CONVERSATION);
    (root, connection)
}

fn envelope(
    command_id: &str,
    principal: &str,
    epoch: u64,
    expected_revision: Option<u64>,
    body: Value,
) -> Envelope {
    Envelope {
        protocol_version: VERSION.to_owned(),
        command_id: command_id.to_owned(),
        payload_digest: canonical_digest(&body).unwrap(),
        actor_ref: principal.to_owned(),
        authority_epoch: epoch,
        expected_revision,
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

fn assert_warning(response: &Response) {
    assert_eq!(response.status, ResponseStatus::Warning, "{response:?}");
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
        1,
        None,
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

fn submit_root(conn: &Connection, command_id: &str, prompt: &str) -> Response {
    let request = envelope(
        command_id,
        OWNER,
        1,
        None,
        json!({
            "method": "goal.submit",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "prompt": prompt,
            "privacy": "private",
            "acceptance_spec": { "required_checks": ["artifact_content"] }
        }),
    );
    send(conn, &request, OWNER)
}

fn delegate(
    conn: &Connection,
    command_id: &str,
    parent_work_id: &str,
    principal: &str,
    parent_revision: u64,
    target_ghost_id: &str,
    summary: &str,
    artifact_refs: Vec<String>,
) -> Response {
    let request = envelope(
        command_id,
        principal,
        1,
        Some(parent_revision),
        json!({
            "method": "work.delegate",
            "parent_work_id": parent_work_id,
            "target_ghost_id": target_ghost_id,
            "summary": summary,
            "artifact_refs": artifact_refs,
            "acceptance_spec": { "required_checks": ["artifact_content"] }
        }),
    );
    send(conn, &request, principal)
}

fn update_goal(
    conn: &Connection,
    command_id: &str,
    principal: &str,
    goal_id: &str,
    revision: u64,
    prompt: &str,
) -> Response {
    let request = envelope(
        command_id,
        principal,
        1,
        Some(revision),
        json!({
            "method": "goal.update",
            "goal_id": goal_id,
            "prompt": prompt,
            "acceptance_spec": { "required_checks": ["artifact_content"] }
        }),
    );
    send(conn, &request, principal)
}

fn worker_spec(work_id: &str, execution_id: &str, revision: u64) -> WorkerSpec {
    WorkerSpec {
        execution_id: execution_id.to_owned(),
        work_id: work_id.to_owned(),
        work_revision: revision,
        authority_epoch: 1,
        computer_id: "computer-fixture".to_owned(),
        cwd: "/workspace/canary".to_owned(),
        prompt: "Run only the isolated canary task".to_owned(),
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
    conn: &Connection,
    command_id: &str,
    work_id: &str,
    execution_id: &str,
    revision: u64,
) -> (Response, WorkerSpec) {
    let spec = worker_spec(work_id, execution_id, revision);
    let request = envelope(
        command_id,
        OWNER,
        1,
        Some(revision),
        json!({ "method": "work.submit", "work_id": work_id, "spec": serde_json::to_value(&spec).unwrap() }),
    );
    (send(conn, &request, OWNER), spec)
}

fn submit_worker_as(
    conn: &Connection,
    command_id: &str,
    principal: &str,
    work_id: &str,
    execution_id: &str,
    revision: u64,
    prompt: &str,
) -> (Response, WorkerSpec) {
    let mut spec = worker_spec(work_id, execution_id, revision);
    spec.prompt = prompt.to_owned();
    let request = envelope(
        command_id,
        principal,
        1,
        None,
        json!({ "method": "work.submit", "work_id": work_id, "spec": serde_json::to_value(&spec).unwrap() }),
    );
    (send(conn, &request, principal), spec)
}

fn artifact(execution_id: &str, digest_byte: char) -> Artifact {
    Artifact {
        digest: digest_byte.to_string().repeat(64),
        locator: "artifact://canary/child-result".to_owned(),
        privacy: "private".to_owned(),
        producing_attempt: execution_id.to_owned(),
    }
}

fn worker_result(
    command_id: &str,
    spec: &WorkerSpec,
    producer: &str,
    sequence: u64,
    state: &str,
    artifacts: Vec<Artifact>,
    summary: &str,
) -> Envelope {
    envelope(
        command_id,
        producer,
        1,
        Some(spec.work_revision),
        json!({
            "method": "work.result",
            "execution_id": spec.execution_id,
            "producer": producer,
            "sequence": sequence,
            "goal_revision": spec.work_revision,
            "state": state,
            "artifacts": artifacts,
            "summary": summary
        }),
    )
}

fn accept_work(
    conn: &Connection,
    command_id: &str,
    goal: &Value,
    work_id: &str,
    artifact: &Artifact,
) -> Response {
    let revision = goal["revision"].as_u64().unwrap();
    let proof = Acceptance {
        work_id: work_id.to_owned(),
        goal_revision: revision,
        requirement_digest: goal["requirement_digest"].as_str().unwrap().to_owned(),
        artifact_digest: artifact.digest.clone(),
        verifier_revision: "fixture-verifier/1".to_owned(),
        policy_revision: 1,
        checks: vec![Check {
            id: "artifact_content".to_owned(),
            passed: true,
            evidence: "verified isolated canary bytes".to_owned(),
        }],
    };
    let request = envelope(
        command_id,
        OWNER,
        1,
        Some(revision),
        json!({ "method": "work.accept", "acceptance": proof }),
    );
    send(conn, &request, OWNER)
}

fn inspect_mailbox(conn: &Connection, command_id: &str, recipient: &str) -> Response {
    let request = envelope(
        command_id,
        recipient,
        1,
        None,
        json!({
            "method": "mailbox.inspect",
            "recipient_id": recipient,
            "after_sequence": 0,
            "limit": 100
        }),
    );
    send(conn, &request, recipient)
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
        1,
        None,
        json!({
            "method": "conversation.assignment.inspect",
            "assignment_id": assignment_id,
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
        }),
    );
    send(conn, &request, principal)
}

fn assignment_id_for_work(conn: &Connection, work_id: &str) -> String {
    pending_outbox(conn)
        .unwrap()
        .into_iter()
        .find(|item| item.target == "pi" && item.payload["body"]["work_id"] == work_id)
        .unwrap()
        .payload["command_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn assignment_id_for_revision(conn: &Connection, work_id: &str, revision: u64) -> String {
    pending_outbox(conn)
        .unwrap()
        .into_iter()
        .find(|item| {
            item.target == "pi"
                && item.payload["body"]["method"] == "conversation.assignment"
                && item.payload["body"]["work_id"] == work_id
                && item.payload["body"]["goal_revision"] == revision
        })
        .unwrap()
        .payload["command_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn assignment_inspection_rejects_cancelled_work_and_invalidated_ancestry() {
    let (_root, conn) = database();
    let root = submit_root(&conn, "assignment-fence-root", "Private parent request");
    assert_success(&root);
    let root_goal_id = root.data["goal"]["id"].as_str().unwrap().to_owned();
    let root_work_id = root.data["work"]["id"].as_str().unwrap().to_owned();

    let cancelled_child = delegate(
        &conn,
        "assignment-fence-cancel-child",
        &root_work_id,
        ROOT_GHOST,
        1,
        TARGET_A,
        "Bounded child task",
        Vec::new(),
    );
    assert_success(&cancelled_child);
    let cancelled_work_id = cancelled_child.data["work"]["id"].as_str().unwrap();
    let cancelled_assignment_id = pending_outbox(&conn)
        .unwrap()
        .into_iter()
        .find(|item| item.target == "pi" && item.payload["body"]["work_id"] == cancelled_work_id)
        .unwrap()
        .payload["command_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let cancelled = send(
        &conn,
        &envelope(
            "cancel-assignment-work",
            TARGET_A,
            1,
            None,
            json!({"method": "work.cancel", "work_id": cancelled_work_id}),
        ),
        TARGET_A,
    );
    assert_success(&cancelled);
    assert_error(
        &inspect_assignment(
            &conn,
            "inspect-cancelled-assignment",
            TARGET_A,
            TARGET_A,
            TARGET_A_CONVERSATION,
            &cancelled_assignment_id,
        ),
        "conflict",
    );

    let current_child = delegate(
        &conn,
        "assignment-fence-current-child",
        &root_work_id,
        ROOT_GHOST,
        1,
        TARGET_B,
        "Another bounded child task",
        Vec::new(),
    );
    assert_success(&current_child);
    let current_work_id = current_child.data["work"]["id"].as_str().unwrap();
    let current_assignment_id = pending_outbox(&conn)
        .unwrap()
        .into_iter()
        .find(|item| item.target == "pi" && item.payload["body"]["work_id"] == current_work_id)
        .unwrap()
        .payload["command_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let revised = update_goal(
        &conn,
        "revise-assignment-parent",
        ROOT_GHOST,
        &root_goal_id,
        1,
        "Current parent requirement",
    );
    assert_success(&revised);
    assert_error(
        &inspect_assignment(
            &conn,
            "inspect-ancestor-invalidated-assignment",
            TARGET_B,
            TARGET_B,
            TARGET_B_CONVERSATION,
            &current_assignment_id,
        ),
        "conflict",
    );
}

#[test]
fn assignment_continuation_requires_matching_submit_and_live_work() {
    let (_root, conn) = database();

    let matching_goal = submit_root(
        &conn,
        "assignment-continuation-matching",
        "Run only the isolated canary task",
    );
    assert_success(&matching_goal);
    let matching_work_id = matching_goal.data["work"]["id"].as_str().unwrap().to_owned();
    let matching_assignment_id = assignment_id_for_work(&conn, &matching_work_id);
    assert_success(&inspect_assignment(
        &conn,
        "inspect-assignment-before-submit",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        &matching_assignment_id,
    ));

    let (submitted, spec) = submit_worker_as(
        &conn,
        "submit-matching-assignment-work",
        ROOT_GHOST,
        &matching_work_id,
        "execution-matching-assignment",
        1,
        matching_goal.data["goal"]["prompt"].as_str().unwrap(),
    );
    assert_success(&submitted);
    assert_success(&inspect_assignment(
        &conn,
        "inspect-submitted-assignment",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        &matching_assignment_id,
    ));

    let steering = send(
        &conn,
        &envelope(
            "steer-matching-assignment-work",
            ROOT_GHOST,
            1,
            Some(1),
            json!({
                "method": "work.steer",
                "work_id": matching_work_id,
                "prompt": "Continue the same bounded assignment",
            }),
        ),
        ROOT_GHOST,
    );
    assert_success(&steering);
    assert_success(&inspect_assignment(
        &conn,
        "inspect-steering-assignment",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        &matching_assignment_id,
    ));

    let completed = worker_result(
        "complete-matching-assignment-work",
        &spec,
        "worker-assignment-producer",
        1,
        "completed",
        Vec::new(),
        "The bounded task completed",
    );
    assert_success(&send(
        &conn,
        &completed,
        "worker-assignment-producer",
    ));
    assert_success(&inspect_assignment(
        &conn,
        "inspect-completed-assignment",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        &matching_assignment_id,
    ));

    let foreign_goal = submit_root(
        &conn,
        "assignment-continuation-foreign",
        "Run only the isolated canary task",
    );
    assert_success(&foreign_goal);
    let foreign_work_id = foreign_goal.data["work"]["id"].as_str().unwrap().to_owned();
    let foreign_assignment_id = assignment_id_for_work(&conn, &foreign_work_id);
    let (foreign_submit, _) = submit_worker_as(
        &conn,
        "submit-foreign-assignment-work",
        TARGET_A,
        &foreign_work_id,
        "execution-foreign-assignment",
        1,
        foreign_goal.data["goal"]["prompt"].as_str().unwrap(),
    );
    assert_success(&foreign_submit);
    assert_error(
        &inspect_assignment(
            &conn,
            "inspect-foreign-submit-assignment",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            &foreign_assignment_id,
        ),
        "conflict",
    );

    let mismatched_goal = submit_root(
        &conn,
        "assignment-continuation-mismatched-prompt",
        "Run only the isolated canary task",
    );
    assert_success(&mismatched_goal);
    let mismatched_work_id = mismatched_goal.data["work"]["id"].as_str().unwrap().to_owned();
    let mismatched_assignment_id = assignment_id_for_work(&conn, &mismatched_work_id);
    let (mismatched_submit, _) = submit_worker_as(
        &conn,
        "submit-mismatched-assignment-work",
        ROOT_GHOST,
        &mismatched_work_id,
        "execution-mismatched-assignment",
        1,
        "A different task than the admitted Goal",
    );
    assert_success(&mismatched_submit);
    assert_error(
        &inspect_assignment(
            &conn,
            "inspect-mismatched-submit-assignment",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            &mismatched_assignment_id,
        ),
        "conflict",
    );

    let cancelled_goal = submit_root(
        &conn,
        "assignment-continuation-cancelled",
        "Run only the isolated canary task",
    );
    assert_success(&cancelled_goal);
    let cancelled_work_id = cancelled_goal.data["work"]["id"].as_str().unwrap().to_owned();
    let cancelled_assignment_id = assignment_id_for_work(&conn, &cancelled_work_id);
    let (cancelled_submit, _) = submit_worker_as(
        &conn,
        "submit-cancellable-assignment-work",
        ROOT_GHOST,
        &cancelled_work_id,
        "execution-cancellable-assignment",
        1,
        cancelled_goal.data["goal"]["prompt"].as_str().unwrap(),
    );
    assert_success(&cancelled_submit);
    assert_success(&send(
        &conn,
        &envelope(
            "cancel-submitted-assignment-work",
            ROOT_GHOST,
            1,
            None,
            json!({ "method": "work.cancel", "work_id": cancelled_work_id }),
        ),
        ROOT_GHOST,
    ));
    assert_error(
        &inspect_assignment(
            &conn,
            "inspect-cancelled-submission-assignment",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            &cancelled_assignment_id,
        ),
        "conflict",
    );

    let stale_goal = submit_root(
        &conn,
        "assignment-continuation-stale",
        "Run only the isolated canary task",
    );
    assert_success(&stale_goal);
    let stale_goal_id = stale_goal.data["goal"]["id"].as_str().unwrap().to_owned();
    let stale_work_id = stale_goal.data["work"]["id"].as_str().unwrap().to_owned();
    let stale_assignment_id = assignment_id_for_work(&conn, &stale_work_id);
    let (stale_submit, _) = submit_worker_as(
        &conn,
        "submit-stale-assignment-work",
        ROOT_GHOST,
        &stale_work_id,
        "execution-stale-assignment",
        1,
        stale_goal.data["goal"]["prompt"].as_str().unwrap(),
    );
    assert_success(&stale_submit);
    assert_success(&update_goal(
        &conn,
        "revise-submitted-assignment-goal",
        ROOT_GHOST,
        &stale_goal_id,
        1,
        stale_goal.data["goal"]["prompt"].as_str().unwrap(),
    ));
    assert_error(
        &inspect_assignment(
            &conn,
            "inspect-stale-submission-assignment",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            &stale_assignment_id,
        ),
        "conflict",
    );
}

#[test]
fn goal_revision_rearms_unassigned_delivery_stop_without_replaying_old_assignment() {
    let (_root, conn) = database();
    let admitted = submit_root(&conn, "goal-update-assignment-root", "Initial durable task");
    assert_success(&admitted);
    let goal_id = admitted.data["goal"]["id"].as_str().unwrap().to_owned();
    let work_id = admitted.data["work"]["id"].as_str().unwrap().to_owned();
    let old_assignment_id = assignment_id_for_work(&conn, &work_id);
    let prompt = "Revised durable task with the exact new requirement";
    // Model delivery ended without a native execution. Only a new Owner
    // requirement may rearm this Work; the old assignment stays retired.
    conn.execute(
        "UPDATE lifetime_work SET state='blocked',
         payload=json_set(payload,'$.state','blocked','$.blocker',?2) WHERE id=?1",
        params![work_id, "Original Pi delivery requires Owner direction"],
    ).unwrap();
    let stopped = snapshot(&conn).unwrap().work.into_iter().find(|work| work.id == work_id).unwrap();
    assert_eq!(stopped.state, "blocked");
    assert!(stopped.execution_id.is_none());

    let updated = update_goal(
        &conn,
        "goal-update-assignment-r2",
        OWNER,
        &goal_id,
        1,
        prompt,
    );
    assert_success(&updated);
    assert_eq!(updated.data["goal"]["revision"], 2);
    let work_records = updated.data["work"].as_array().unwrap();
    let current_work = work_records
        .iter()
        .find(|candidate| candidate["id"] == work_id)
        .unwrap();
    assert_eq!(current_work["goal_revision"], 2);
    assert_eq!(current_work["state"], "queued");

    let current_assignment_id = assignment_id_for_revision(&conn, &work_id, 2);
    let current_assignment = inspect_assignment(
        &conn,
        "inspect-revised-root-assignment",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        &current_assignment_id,
    );
    assert_success(&current_assignment);
    assert_eq!(
        current_assignment.data["assignment"]["source_command_id"],
        "goal-update-assignment-r2"
    );
    assert_eq!(current_assignment.data["assignment"]["work_id"], work_id);
    assert_eq!(current_assignment.data["assignment"]["goal_revision"], 2);
    assert_eq!(current_assignment.data["assignment"]["prompt"], prompt);
    assert_eq!(current_assignment.data["assignment"]["origin_kind"], "owner_goal");
    assert_error(
        &inspect_assignment(
            &conn,
            "inspect-retired-root-assignment",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            &old_assignment_id,
        ),
        "conflict",
    );
    assert_eq!(snapshot(&conn).unwrap().goals.len(), 1);
}

#[test]
fn new_root_revision_keeps_dependency_wait_until_old_child_cancellation_settles() {
    let (_root, conn) = database();
    let root = submit_root(&conn, "waiting-root-r1", "Coordinate a child");
    assert_success(&root);
    let goal_id = root.data["goal"]["id"].as_str().unwrap();
    let work_id = root.data["work"]["id"].as_str().unwrap();
    let child = delegate(&conn, "waiting-child-r1", work_id, ROOT_GHOST, 1,
        TARGET_A, "Original child requirement", Vec::new());
    assert_success(&child);
    let child_id = child.data["work"]["id"].as_str().unwrap();
    let (submitted, _) = submit_worker_as(&conn, "waiting-child-submit", TARGET_A,
        child_id, "waiting-original-child", 1, child.data["goal"]["prompt"].as_str().unwrap());
    assert_success(&submitted);
    let waiting = envelope("waiting-root-dependencies", ROOT_GHOST, 1, Some(1),
        json!({"method":"work.wait","work_id":work_id,"wait_for":[child_id]}));
    assert_success(&send(&conn, &waiting, ROOT_GHOST));

    let prompt = "Coordinate the changed requirement";
    let revised = update_goal(&conn, "waiting-root-r2", OWNER, goal_id, 1, prompt);
    assert_success(&revised);
    let current = snapshot(&conn).unwrap();
    let parent = current.work.iter().find(|work| work.id == work_id).unwrap();
    let original = current.work.iter().find(|work| work.id == child_id).unwrap();
    assert_eq!(parent.goal_revision, 2);
    assert_eq!(parent.state, "blocked");
    assert!(parent.execution_id.is_none());
    assert_eq!(original.cancellation, "requested");
    assert_eq!(original.execution_id.as_deref(), Some("waiting-original-child"));
    let (premature, _) = submit_worker_as(&conn, "waiting-root-premature-submit",
        ROOT_GHOST, work_id, "must-not-start-before-child-cancellation", 2, prompt);
    assert_warning(&premature);
    assert!(snapshot(&conn).unwrap().work.iter()
        .find(|work| work.id == work_id).unwrap().execution_id.is_none());
}

#[test]
fn revised_delegated_work_preserves_lineage_and_parent_waits() {
    let (_root, conn) = database();
    let root = submit_root(&conn, "revision-wait-root", "Coordinate a bounded child task");
    assert_success(&root);
    let root_goal_id = root.data["goal"]["id"].as_str().unwrap().to_owned();
    let root_work_id = root.data["work"]["id"].as_str().unwrap().to_owned();
    let child = delegate(
        &conn,
        "revision-wait-child",
        &root_work_id,
        ROOT_GHOST,
        1,
        TARGET_A,
        "Initial child requirement",
        Vec::new(),
    );
    assert_success(&child);
    let child_goal_id = child.data["goal"]["id"].as_str().unwrap().to_owned();
    let old_work_id = child.data["work"]["id"].as_str().unwrap().to_owned();
    let old_assignment_id = assignment_id_for_work(&conn, &old_work_id);
    let child_prompt = child.data["goal"]["prompt"].as_str().unwrap();
    let (submitted, old_spec) = submit_worker_as(
        &conn,
        "submit-revisable-child",
        TARGET_A,
        &old_work_id,
        "execution-before-revision",
        1,
        child_prompt,
    );
    assert_success(&submitted);

    let waiting = send(
        &conn,
        &envelope(
            "parent-waits-for-revisable-child",
            ROOT_GHOST,
            1,
            Some(1),
            json!({
                "method": "work.wait",
                "work_id": root_work_id,
                "wait_for": [old_work_id],
            }),
        ),
        ROOT_GHOST,
    );
    assert_success(&waiting);
    assert_eq!(waiting.data["work"]["state"], "blocked");

    let original_link: (String, i64, String, i64, i64) = conn
        .query_row(
            "SELECT parent_work_id,parent_goal_revision,root_goal_id,depth,current
             FROM lifetime_work_links WHERE child_work_id=?1",
            [&old_work_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .unwrap();
    let budget_before: (i64, i64, i64) = conn
        .query_row(
            "SELECT deadline_ms,automatic_revisions,expired
             FROM lifetime_graph_budgets WHERE root_goal_id=?1",
            [&root_goal_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();

    let revised_prompt = "Revised child requirement; retain the original bounded parent scope";
    let updated = update_goal(
        &conn,
        "revise-delegated-child",
        TARGET_A,
        &child_goal_id,
        1,
        revised_prompt,
    );
    assert_success(&updated);
    assert_eq!(updated.data["goal"]["revision"], 2);
    let current_work = updated
        .data["work"]
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| candidate["goal_revision"] == 2)
        .unwrap();
    let replacement_work_id = current_work["id"].as_str().unwrap().to_owned();
    assert_ne!(replacement_work_id, old_work_id);
    assert_eq!(current_work["state"], "queued");
    assert!(current_work["execution_id"].is_null());

    let current_assignment_id = assignment_id_for_revision(&conn, &replacement_work_id, 2);
    let current_assignment = inspect_assignment(
        &conn,
        "inspect-revised-child-assignment",
        TARGET_A,
        TARGET_A,
        TARGET_A_CONVERSATION,
        &current_assignment_id,
    );
    assert_success(&current_assignment);
    assert_eq!(current_assignment.data["assignment"]["source_command_id"], "revise-delegated-child");
    assert_eq!(current_assignment.data["assignment"]["goal_revision"], 2);
    assert_eq!(current_assignment.data["assignment"]["work_id"], replacement_work_id);
    assert_eq!(current_assignment.data["assignment"]["prompt"], revised_prompt);
    assert_eq!(current_assignment.data["assignment"]["origin_kind"], "delegated_goal");
    assert_eq!(current_assignment.data["assignment"]["parent_work_id"], root_work_id);
    assert_eq!(current_assignment.data["assignment"]["root_goal_id"], root_goal_id);
    assert_eq!(current_assignment.data["assignment"]["privacy"], "private");
    assert_error(
        &inspect_assignment(
            &conn,
            "inspect-retired-child-assignment",
            TARGET_A,
            TARGET_A,
            TARGET_A_CONVERSATION,
            &old_assignment_id,
        ),
        "conflict",
    );

    let old_work = send(
        &conn,
        &envelope(
            "inspect-cancel-requested-old-execution",
            TARGET_A,
            1,
            None,
            json!({ "method": "work.inspect", "work_id": old_work_id }),
        ),
        TARGET_A,
    );
    assert_success(&old_work);
    assert_eq!(old_work.data["work"]["state"], "cancel_requested");
    assert_eq!(old_work.data["work"]["cancellation"], "requested");
    assert_eq!(old_work.data["work"]["execution_id"], old_spec.execution_id);
    assert!(pending_outbox(&conn).unwrap().iter().any(|item| {
        item.target == "worker"
            && item.payload["body"]["method"] == "cancel"
            && item.payload["body"]["execution_id"] == old_spec.execution_id
    }));

    let (blocked_submit, _) = submit_worker_as(
        &conn,
        "replacement-before-cancel-confirmation",
        TARGET_A,
        &replacement_work_id,
        "execution-before-cancel-confirmation",
        2,
        revised_prompt,
    );
    assert_error(&blocked_submit, "waiting_host");
    let unchanged_replacement = send(
        &conn,
        &envelope(
            "inspect-replacement-after-waiting-host",
            TARGET_A,
            1,
            None,
            json!({ "method": "work.inspect", "work_id": replacement_work_id }),
        ),
        TARGET_A,
    );
    assert_success(&unchanged_replacement);
    assert_eq!(unchanged_replacement.data["work"]["state"], "queued");
    assert!(unchanged_replacement.data["work"]["execution_id"].is_null());

    let mut edge_statement = conn
        .prepare(
            "SELECT blocker_work_id FROM lifetime_blocking_edges
             WHERE waiter_work_id=?1 AND kind='dependency' ORDER BY blocker_work_id",
        )
        .unwrap();
    let wait_edges: Vec<String> = edge_statement
        .query_map([&root_work_id], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(wait_edges, vec![replacement_work_id.clone()]);
    let waiting_parent = send(
        &conn,
        &envelope(
            "inspect-parent-wait-after-revision",
            ROOT_GHOST,
            1,
            None,
            json!({ "method": "work.inspect", "work_id": root_work_id }),
        ),
        ROOT_GHOST,
    );
    assert_success(&waiting_parent);
    assert_eq!(waiting_parent.data["work"]["state"], "blocked");
    let blocker = waiting_parent.data["work"]["blocker"].as_str().unwrap();
    assert!(blocker.contains(replacement_work_id.as_str()));
    assert!(!blocker.contains(old_work_id.as_str()));

    let historical_link: (String, i64, String, i64, i64) = conn
        .query_row(
            "SELECT parent_work_id,parent_goal_revision,root_goal_id,depth,current
             FROM lifetime_work_links WHERE child_work_id=?1",
            [&old_work_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .unwrap();
    let current_link: (String, i64, String, i64, i64) = conn
        .query_row(
            "SELECT parent_work_id,parent_goal_revision,root_goal_id,depth,current
             FROM lifetime_work_links WHERE child_work_id=?1",
            [&replacement_work_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .unwrap();
    assert_eq!(original_link.4, 1);
    assert_eq!(historical_link.4, 0);
    assert_eq!(current_link.4, 1);
    assert_eq!(current_link.0, original_link.0);
    assert_eq!(current_link.1, original_link.1);
    assert_eq!(current_link.2, original_link.2);
    assert_eq!(current_link.3, original_link.3);
    let budget_after: (i64, i64, i64) = conn
        .query_row(
            "SELECT deadline_ms,automatic_revisions,expired
             FROM lifetime_graph_budgets WHERE root_goal_id=?1",
            [&root_goal_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(budget_after.0, budget_before.0);
    assert_eq!(budget_after.1, budget_before.1 + 1);
    assert_eq!(budget_after.2, budget_before.2);

    conn.execute(
        "DELETE FROM lifetime_work_links WHERE child_work_id=?1",
        [&replacement_work_id],
    )
    .unwrap();
    let missing_ancestry = inspect_assignment(
        &conn,
        "reject-revised-assignment-with-missing-link",
        TARGET_A,
        TARGET_A,
        TARGET_A_CONVERSATION,
        &current_assignment_id,
    );
    assert_eq!(missing_ancestry.status, ResponseStatus::Error);
}

#[test]
fn goal_update_assignment_rejects_unauthorized_and_unmatched_receipts() {
    let (_root, conn) = database();
    let admitted = submit_root(&conn, "goal-update-source-root", "Initial source-owned task");
    assert_success(&admitted);
    let goal_id = admitted.data["goal"]["id"].as_str().unwrap().to_owned();

    let unauthorized = envelope(
        "unauthorized-goal-revision",
        TARGET_B,
        1,
        Some(1),
        json!({
            "method": "goal.update",
            "goal_id": goal_id,
            "prompt": "Unauthorized source must not revise this Goal",
            "acceptance_spec": { "required_checks": ["artifact_content"] },
        }),
    );
    assert_error(&send(&conn, &unauthorized, TARGET_B), "unauthorized");
    assert_eq!(snapshot(&conn).unwrap().goals[0].revision, 1);

    let updated = update_goal(
        &conn,
        "goal-update-source-array",
        OWNER,
        &goal_id,
        1,
        "Current task with a committed revision source",
    );
    assert_success(&updated);
    let work_id = updated.data["work"][0]["id"].as_str().unwrap().to_owned();
    let assignment_id = assignment_id_for_revision(&conn, &work_id, 2);
    assert_success(&inspect_assignment(
        &conn,
        "inspect-committed-source-array",
        ROOT_GHOST,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        &assignment_id,
    ));

    let response_text: String = conn
        .query_row(
            "SELECT response FROM lifetime_commands WHERE command_id=?1",
            ["goal-update-source-array"],
            |row| row.get(0),
        )
        .unwrap();
    let mut receipt: Value = serde_json::from_str(&response_text).unwrap();
    receipt["data"]["work"]
        .as_array_mut()
        .unwrap()
        .retain(|candidate| candidate["id"].as_str() != Some(work_id.as_str()));
    conn.execute(
        "UPDATE lifetime_commands SET response=?1 WHERE command_id=?2",
        params![receipt.to_string(), "goal-update-source-array"],
    )
    .unwrap();
    assert_error(
        &inspect_assignment(
            &conn,
            "reject-unmatched-committed-source-array",
            ROOT_GHOST,
            ROOT_GHOST,
            ROOT_CONVERSATION,
            &assignment_id,
        ),
        "not_found",
    );
}

#[test]
fn delegation_is_private_bounded_and_completed_children_still_consume_capacity() {
    let (_root, conn) = database();
    let root = submit_root(&conn, "root-delegate", "Private owner instructions");
    assert_success(&root);
    let root_goal_id = root.data["goal"]["id"].as_str().unwrap().to_owned();
    let root_work_id = root.data["work"]["id"].as_str().unwrap().to_owned();

    assert_error(
        &delegate(&conn, "delegate-wrong-owner", &root_work_id, TARGET_A, 1, TARGET_A, "Unauthorized parent identity", Vec::new()),
        "unauthorized",
    );
    assert_error(
        &delegate(&conn, "delegate-unregistered-target", &root_work_id, ROOT_GHOST, 1, "unregistered-ghost", "Target must be registered", Vec::new()),
        "not_found",
    );
    assert_success(&send(
        &conn,
        &envelope("drain-target-b", OWNER, 1, None, json!({ "method": "registry.mode", "ghost_id": TARGET_B, "mode": "draining" })),
        OWNER,
    ));
    assert_error(
        &delegate(&conn, "delegate-draining-target", &root_work_id, ROOT_GHOST, 1, TARGET_B, "Draining target must not receive work", Vec::new()),
        "conflict",
    );
    assert_success(&send(
        &conn,
        &envelope("reactivate-target-b", OWNER, 1, None, json!({ "method": "registry.mode", "ghost_id": TARGET_B, "mode": "active" })),
        OWNER,
    ));

    let summary = "é".repeat(4096);
    let first = delegate(
        &conn,
        "delegate-first",
        &root_work_id,
        ROOT_GHOST,
        1,
        TARGET_A,
        &summary,
        vec!["opaque-artifact-ref-1".to_owned()],
    );
    assert_success(&first);
    let first_goal = &first.data["goal"];
    let first_work_id = first.data["work"]["id"].as_str().unwrap().to_owned();
    let first_goal_id = first_goal["id"].as_str().unwrap().to_owned();
    assert_eq!(first_goal["privacy"], "private");
    assert_eq!(first_goal["reply_conversation"], TARGET_A_CONVERSATION);
    assert_eq!(first_goal["acceptance_spec"]["required_checks"][0], "artifact_content");
    assert_eq!(first.data["artifact_refs"][0], "opaque-artifact-ref-1");

    let child_assignment = pending_outbox(&conn).unwrap().into_iter().find(|item| {
        item.target == "pi" && item.payload["body"]["work_id"] == first_work_id
    }).unwrap();
    let assignment_id = child_assignment.payload["command_id"].as_str().unwrap().to_owned();

    let parent_private_turn = envelope(
        "raise-parent-conversation-floor",
        OWNER,
        1,
        None,
        json!({
            "method": "conversation.input",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "text": "New local-only parent context after child assignment",
            "privacy": "local_only",
            "attachments": [],
        }),
    );
    assert_success(&send(&conn, &parent_private_turn, OWNER));
    let inspected = inspect_assignment(
        &conn,
        "inspect-first-child-assignment",
        TARGET_A,
        TARGET_A,
        TARGET_A_CONVERSATION,
        &assignment_id,
    );
    assert_success(&inspected);
    assert_eq!(inspected.data["assignment"]["origin_kind"], "delegated_goal");
    assert_eq!(inspected.data["assignment"]["parent_work_id"], root_work_id);
    assert_eq!(inspected.data["assignment"]["root_goal_id"], root_goal_id);
    assert_eq!(inspected.data["assignment"]["privacy"], "local_only");
    assert_error(
        &inspect_assignment(
            &conn,
            "inspect-child-assignment-as-owner",
            OWNER,
            TARGET_A,
            TARGET_A_CONVERSATION,
            &assignment_id,
        ),
        "unauthorized",
    );

    assert_error(
        &inspect_assignment(
            &conn,
            "inspect-child-assignment-wrong-conversation",
            TARGET_A,
            TARGET_A,
            TARGET_B_CONVERSATION,
            &assignment_id,
        ),
        "unauthorized",
    );
    let report_inspection = send(
        &conn,
        &envelope(
            "inspect-assignment-as-report",
            TARGET_A,
            1,
            None,
            json!({
                "method": "conversation.report.inspect",
                "report_id": assignment_id,
                "ghost_id": TARGET_A,
                "conversation_id": TARGET_A_CONVERSATION,
            }),
        ),
        TARGET_A,
    );
    assert_eq!(report_inspection.status, ResponseStatus::Error);

    assert_error(
        &delegate(
            &conn,
            "delegate-summary-too-large",
            &root_work_id,
            ROOT_GHOST,
            1,
            TARGET_B,
            &"é".repeat(4097),
            Vec::new(),
        ),
        "invalid_request",
    );
    assert_error(
        &delegate(
            &conn,
            "delegate-too-many-refs",
            &root_work_id,
            ROOT_GHOST,
            1,
            TARGET_B,
            "A bounded delegation context",
            (0..33).map(|index| format!("opaque-{index}")).collect(),
        ),
        "invalid_request",
    );

    let mut child_pairs = vec![(first.data["goal"].clone(), first_work_id.clone())];
    for (index, target) in [(2, TARGET_B), (3, TARGET_A), (4, TARGET_B)] {
        let child = delegate(
            &conn,
            &format!("delegate-child-{index}"),
            &root_work_id,
            ROOT_GHOST,
            1,
            target,
            &format!("Bounded task {index}"),
            vec![format!("opaque-ref-{index}")],
        );
        assert_success(&child);
        child_pairs.push((child.data["goal"].clone(), child.data["work"]["id"].as_str().unwrap().to_owned()));
    }

    let blocked = delegate(
        &conn,
        "delegate-child-limit",
        &root_work_id,
        ROOT_GHOST,
        1,
        TARGET_A,
        "This must wait for an unresolved child",
        Vec::new(),
    );
    assert_warning(&blocked);
    assert_eq!(snapshot(&conn).unwrap().goals.len(), 5);

    let (admitted, spec) = submit_worker(
        &conn,
        "submit-first-child",
        &first_work_id,
        "execution-first-child",
        1,
    );
    assert_success(&admitted);
    let produced = artifact(&spec.execution_id, 'a');
    let result = worker_result(
        "complete-first-child",
        &spec,
        "worker-first-child",
        1,
        "completed",
        vec![produced.clone()],
        "Completed child result material",
    );
    assert_success(&send(&conn, &result, "worker-first-child"));
    let first_result_reply = send(&conn, &result, "worker-first-child");
    assert_eq!(first_result_reply.status, ResponseStatus::Success);

    let mailbox = inspect_mailbox(&conn, "mailbox-after-completion", ROOT_GHOST);
    assert_success(&mailbox);
    let messages = mailbox.data["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["sender_id"], "host-receipt");
    assert_eq!(messages[0]["privacy"], "private");
    assert_eq!(messages[0]["object_refs"].as_array().unwrap().len(), 4);

    let still_blocked = delegate(
        &conn,
        "delegate-completed-unaccepted-still-counts",
        &root_work_id,
        ROOT_GHOST,
        1,
        TARGET_A,
        "Completed is not independent acceptance",
        Vec::new(),
    );
    assert_warning(&still_blocked);

    assert_success(&accept_work(
        &conn,
        "accept-first-child",
        &child_pairs[0].0,
        &first_work_id,
        &produced,
    ));
    let current = snapshot(&conn).unwrap();
    let root_work = current.work.iter().find(|work| work.id == root_work_id).unwrap();
    assert_eq!(root_work.state, "queued");
    assert_eq!(root_work.blocker, None);

    let fifth = delegate(
        &conn,
        "delegate-after-child-acceptance",
        &root_work_id,
        ROOT_GHOST,
        1,
        TARGET_A,
        "Capacity becomes available after acceptance",
        Vec::new(),
    );
    assert_success(&fifth);
    assert_eq!(snapshot(&conn).unwrap().goals.len(), 6);

    let mailbox_after_accept = inspect_mailbox(&conn, "mailbox-after-acceptance", ROOT_GHOST);
    assert_success(&mailbox_after_accept);
    let reports = mailbox_after_accept.data["messages"].as_array().unwrap();
    assert_eq!(reports.len(), 2);

    let children = send(
        &conn,
        &envelope(
            "inspect-root-children",
            ROOT_GHOST,
            1,
            None,
            json!({ "method": "work.children", "work_id": root_work_id }),
        ),
        ROOT_GHOST,
    );
    assert_success(&children);
    assert_eq!(children.data["links"].as_array().unwrap().len(), 5);
    assert!(children.data["budget"]["deadline_ms"].as_i64().unwrap() > 0);
    let unauthorized = send(
        &conn,
        &envelope(
            "inspect-root-children-unauthorized",
            "unrelated-ghost",
            1,
            None,
            json!({ "method": "work.children", "work_id": root_work_id }),
        ),
        "unrelated-ghost",
    );
    assert_error(&unauthorized, "unauthorized");

    let final_state = snapshot(&conn).unwrap();
    let root_goal = final_state.goals.iter().find(|goal| goal.id == root_goal_id).unwrap();
    assert_eq!(root_goal.state, "open");
    assert!(final_state.acceptances.iter().all(|proof| proof.work_id != root_work_id));
}

#[test]
fn waits_replace_atomically_detect_cross_kind_cycles_and_only_resolve_on_terminal_facts() {
    let (_root, conn) = database();
    let root = submit_root(&conn, "root-wait", "Parent coordination task");
    assert_success(&root);
    let root_work_id = root.data["work"]["id"].as_str().unwrap().to_owned();
    let mut children = Vec::new();
    for (index, target) in [(0, TARGET_A), (1, TARGET_B), (2, TARGET_A), (3, TARGET_B)] {
        let child = delegate(
            &conn,
            &format!("wait-child-{index}"),
            &root_work_id,
            ROOT_GHOST,
            1,
            target,
            &format!("Wait graph child {index}"),
            Vec::new(),
        );
        assert_success(&child);
        children.push((child.data["goal"].clone(), child.data["work"]["id"].as_str().unwrap().to_owned()));
    }
    let child_ids: Vec<String> = children.iter().map(|(_, id)| id.clone()).collect();
    let first_wait = envelope(
        "wait-for-four-current-children",
        ROOT_GHOST,
        1,
        Some(1),
        json!({ "method": "work.wait", "work_id": root_work_id, "wait_for": child_ids.clone() }),
    );
    let waiting = send(&conn, &first_wait, ROOT_GHOST);
    assert_success(&waiting);
    assert_eq!(waiting.data["blocking_edges"].as_array().unwrap().len(), 4);
    assert_eq!(waiting.data["work"]["state"], "blocked");
    let graph_view = send(
        &conn,
        &envelope(
            "inspect-four-wait-edges",
            ROOT_GHOST,
            1,
            None,
            json!({ "method": "work.children", "work_id": root_work_id }),
        ),
        ROOT_GHOST,
    );
    assert_success(&graph_view);
    assert_eq!(graph_view.data["blocking_edges"].as_array().unwrap().len(), 4);
    let mut over_limit = child_ids.clone();
    over_limit.push("fifth-work-id".to_owned());
    let too_many_waits = envelope(
        "wait-more-than-four",
        ROOT_GHOST,
        1,
        Some(1),
        json!({ "method": "work.wait", "work_id": root_work_id, "wait_for": over_limit }),
    );
    assert_error(&send(&conn, &too_many_waits, ROOT_GHOST), "invalid_request");

    let duplicate_wait = envelope(
        "wait-duplicate-blocker",
        ROOT_GHOST,
        1,
        Some(1),
        json!({
            "method": "work.wait",
            "work_id": root_work_id,
            "wait_for": [children[0].1, children[0].1]
        }),
    );
    assert_error(&send(&conn, &duplicate_wait, ROOT_GHOST), "invalid_request");

    let replacement = envelope(
        "replace-wait-edges",
        ROOT_GHOST,
        1,
        Some(1),
        json!({ "method": "work.wait", "work_id": root_work_id, "wait_for": [children[1].1] }),
    );
    let replaced = send(&conn, &replacement, ROOT_GHOST);
    assert_success(&replaced);
    assert_eq!(replaced.data["blocking_edges"].as_array().unwrap().len(), 1);

    conn.execute(
        "INSERT INTO lifetime_blocking_edges(waiter_work_id,blocker_work_id,kind) VALUES(?1,?2,'resource_hold')",
        params![children[0].1, root_work_id],
    ).unwrap();
    let cross_kind_cycle = envelope(
        "wait-cross-kind-cycle",
        ROOT_GHOST,
        1,
        Some(1),
        json!({ "method": "work.wait", "work_id": root_work_id, "wait_for": [children[0].1] }),
    );
    assert_error(&send(&conn, &cross_kind_cycle, ROOT_GHOST), "conflict");

    let (admitted, spec) = submit_worker(
        &conn,
        "submit-wait-child-one",
        &children[1].1,
        "execution-wait-child-one",
        1,
    );
    assert_success(&admitted);
    let output = artifact(&spec.execution_id, 'b');
    let completed = worker_result(
        "complete-wait-child-one",
        &spec,
        "worker-wait-child-one",
        1,
        "completed",
        vec![output.clone()],
        "Finished but not independently accepted",
    );
    assert_success(&send(&conn, &completed, "worker-wait-child-one"));
    let after_completion = snapshot(&conn).unwrap();
    let root_waiter = after_completion.work.iter().find(|work| work.id == root_work_id).unwrap();
    assert_eq!(root_waiter.state, "blocked");

    assert_success(&accept_work(
        &conn,
        "accept-wait-child-one",
        &children[1].0,
        &children[1].1,
        &output,
    ));
    let after_acceptance = snapshot(&conn).unwrap();
    let root_waiter = after_acceptance.work.iter().find(|work| work.id == root_work_id).unwrap();
    assert_eq!(root_waiter.state, "queued");
    assert_eq!(root_waiter.blocker, None);

    let other_root = submit_root(&conn, "second-independent-root", "A separate root graph");
    assert_success(&other_root);
    let cross_root_wait = envelope(
        "wait-cross-root",
        ROOT_GHOST,
        1,
        Some(1),
        json!({
            "method": "work.wait",
            "work_id": root_work_id,
            "wait_for": [other_root.data["work"]["id"]]
        }),
    );
    assert_error(&send(&conn, &cross_root_wait, ROOT_GHOST), "conflict");
}

#[test]
fn depth_three_is_allowed_and_depth_four_is_blocked_without_creating_a_child() {
    let (_root, conn) = database();
    let root = submit_root(&conn, "root-depth", "Depth-limited root");
    assert_success(&root);
    let root_work_id = root.data["work"]["id"].as_str().unwrap().to_owned();
    let child_one = delegate(&conn, "depth-one", &root_work_id, ROOT_GHOST, 1, TARGET_A, "Depth one", Vec::new());
    assert_success(&child_one);
    let child_two = delegate(
        &conn,
        "depth-two",
        child_one.data["work"]["id"].as_str().unwrap(),
        TARGET_A,
        1,
        TARGET_B,
        "Depth two",
        Vec::new(),
    );
    assert_success(&child_two);
    let child_three = delegate(
        &conn,
        "depth-three",
        child_two.data["work"]["id"].as_str().unwrap(),
        TARGET_B,
        1,
        TARGET_A,
        "Depth three",
        Vec::new(),
    );
    assert_success(&child_three);
    let fourth = delegate(
        &conn,
        "depth-four-rejected",
        child_three.data["work"]["id"].as_str().unwrap(),
        TARGET_A,
        1,
        TARGET_B,
        "Depth four must not expand the graph",
        Vec::new(),
    );
    assert_warning(&fourth);
    assert_eq!(snapshot(&conn).unwrap().goals.len(), 4);

    let view = send(
        &conn,
        &envelope(
            "inspect-depth-graph",
            ROOT_GHOST,
            1,
            None,
            json!({ "method": "work.children", "work_id": root_work_id }),
        ),
        ROOT_GHOST,
    );
    assert_success(&view);
    let mut depths: Vec<i64> = view.data["links"].as_array().unwrap()
        .iter().map(|link| link["depth"].as_i64().unwrap()).collect();
    depths.sort_unstable();
    assert_eq!(depths, vec![1, 2, 3]);
}

#[test]
fn child_goal_revisions_are_bounded_and_keep_superseded_links_historical() {
    let (_root, conn) = database();
    let root = submit_root(&conn, "root-child-revisions", "Root prompt must remain unchanged");
    assert_success(&root);
    let root_work_id = root.data["work"]["id"].as_str().unwrap().to_owned();
    let child = delegate(
        &conn,
        "revisioned-child",
        &root_work_id,
        ROOT_GHOST,
        1,
        TARGET_A,
        "Child requirement revision one",
        Vec::new(),
    );
    assert_success(&child);
    let child_goal = child.data["goal"].clone();
    let first_work_id = child.data["work"]["id"].as_str().unwrap().to_owned();
    let (admitted, spec) = submit_worker(&conn, "submit-revisioned-child", &first_work_id, "execution-revisioned-child", 1);
    assert_success(&admitted);
    let output = artifact(&spec.execution_id, 'c');
    assert_success(&send(
        &conn,
        &worker_result(
            "complete-revisioned-child",
            &spec,
            "worker-revisioned-child",
            1,
            "completed",
            vec![output],
            "Completed child result retained as a historical fact",
        ),
        "worker-revisioned-child",
    ));

    let revision_two = update_goal(&conn, "child-revision-two", TARGET_A, child_goal["id"].as_str().unwrap(), 1, "Child requirement revision two");
    assert_success(&revision_two);
    assert_eq!(revision_two.data["goal"]["revision"], 2);
    let second_work_id = revision_two.data["work"].as_array().unwrap()
        .iter().find(|work| work["goal_revision"] == 2).unwrap()["id"].as_str().unwrap().to_owned();
    let view_one = send(
        &conn,
        &envelope(
            "view-after-first-auto-revision",
            ROOT_GHOST,
            1,
            None,
            json!({ "method": "work.children", "work_id": root_work_id }),
        ),
        ROOT_GHOST,
    );
    assert_success(&view_one);
    assert_eq!(view_one.data["budget"]["automatic_revisions"], 1);

    let revision_three = update_goal(&conn, "child-revision-three", TARGET_A, child_goal["id"].as_str().unwrap(), 2, "Child requirement revision three");
    assert_success(&revision_three);
    assert_eq!(revision_three.data["goal"]["revision"], 3);
    assert_eq!(revision_three.data["work"].as_array().unwrap()
        .iter().find(|work| work["id"] == second_work_id).unwrap()["goal_revision"], 3);

    assert_error(
        &update_goal(&conn, "child-revision-four-over-budget", TARGET_A, child_goal["id"].as_str().unwrap(), 3, "Automatic revision four is over budget"),
        "conflict",
    );
    let unchanged = snapshot(&conn).unwrap();
    assert_eq!(unchanged.goals.iter().find(|goal| goal.id == child_goal["id"].as_str().unwrap()).unwrap().revision, 3);

    let explicit_owner_update = update_goal(&conn, "owner-child-revision-four", OWNER, child_goal["id"].as_str().unwrap(), 3, "Explicit owner revision is not an automatic retry");
    assert_success(&explicit_owner_update);
    assert_eq!(explicit_owner_update.data["goal"]["revision"], 4);
    let view_final = send(
        &conn,
        &envelope(
            "view-after-owner-revision",
            ROOT_GHOST,
            1,
            None,
            json!({ "method": "work.children", "work_id": root_work_id }),
        ),
        ROOT_GHOST,
    );
    assert_success(&view_final);
    assert_eq!(view_final.data["budget"]["automatic_revisions"], 2);
    let links = view_final.data["links"].as_array().unwrap();
    assert_eq!(links.len(), 2);
    assert!(links.iter().any(|link| link["child_work_id"] == first_work_id && link["current"] == false));
    assert!(links.iter().any(|link| link["child_work_id"] == second_work_id && link["current"] == true));
}

#[test]
fn ancestor_revision_stales_completed_facts_and_requests_same_execution_cancellation() {
    let (_root, conn) = database();
    let root = submit_root(&conn, "root-invalidation", "Original parent requirement");
    assert_success(&root);
    let root_goal_id = root.data["goal"]["id"].as_str().unwrap().to_owned();
    let root_work_id = root.data["work"]["id"].as_str().unwrap().to_owned();

    let active_child = delegate(&conn, "active-descendant", &root_work_id, ROOT_GHOST, 1, TARGET_A, "Active descendant", Vec::new());
    let completed_child = delegate(&conn, "completed-descendant", &root_work_id, ROOT_GHOST, 1, TARGET_B, "Completed descendant", Vec::new());
    let queued_child = delegate(&conn, "queued-descendant", &root_work_id, ROOT_GHOST, 1, TARGET_A, "Queued descendant", Vec::new());
    assert_success(&active_child);
    assert_success(&completed_child);
    assert_success(&queued_child);

    let active_work_id = active_child.data["work"]["id"].as_str().unwrap().to_owned();
    let (active_admitted, active_spec) = submit_worker(&conn, "submit-active-descendant", &active_work_id, "execution-active-descendant", 1);
    assert_success(&active_admitted);
    let completed_work_id = completed_child.data["work"]["id"].as_str().unwrap().to_owned();
    let (completed_admitted, completed_spec) = submit_worker(&conn, "submit-completed-descendant", &completed_work_id, "execution-completed-descendant", 1);
    assert_success(&completed_admitted);
    let completed_artifact = artifact(&completed_spec.execution_id, 'd');
    assert_success(&send(
        &conn,
        &worker_result(
            "complete-before-ancestor-change",
            &completed_spec,
            "worker-completed-descendant",
            1,
            "completed",
            vec![completed_artifact.clone()],
            "A durable result that must become stale",
        ),
        "worker-completed-descendant",
    ));

    let update = update_goal(&conn, "revise-ancestor", OWNER, &root_goal_id, 1, "Revised parent requirement");
    assert_success(&update);
    assert_eq!(update.data["goal"]["revision"], 2);
    let state = snapshot(&conn).unwrap();
    let active_work = state.work.iter().find(|work| work.id == active_work_id).unwrap();
    let completed_work = state.work.iter().find(|work| work.id == completed_work_id).unwrap();
    let queued_work_id = queued_child.data["work"]["id"].as_str().unwrap();
    let queued_work = state.work.iter().find(|work| work.id == queued_work_id).unwrap();
    assert_eq!(active_work.state, "cancel_requested");
    assert_eq!(active_work.cancellation, "requested");
    assert_eq!(active_work.execution_id.as_deref(), Some("execution-active-descendant"));
    assert_eq!(completed_work.state, "stale");
    assert_eq!(queued_work.state, "cancelled");

    let cancellations: Vec<_> = pending_outbox(&conn).unwrap().into_iter()
        .filter(|item| item.target == "worker" && item.payload["body"]["method"] == "cancel")
        .collect();
    assert_eq!(cancellations.len(), 1);
    assert_eq!(cancellations[0].payload["body"]["execution_id"], "execution-active-descendant");

    let inspect_stale = send(
        &conn,
        &envelope(
            "inspect-stale-descendant-result",
            OWNER,
            1,
            None,
            json!({ "method": "work.inspect", "work_id": completed_work_id }),
        ),
        OWNER,
    );
    assert_success(&inspect_stale);
    assert_eq!(inspect_stale.data["result"]["current"], false);
    assert_eq!(inspect_stale.data["result"]["reason"], "ancestor_revision_changed");

    let stale_acceptance = accept_work(
        &conn,
        "reject-stale-descendant-acceptance",
        &completed_child.data["goal"],
        &completed_work_id,
        &completed_artifact,
    );
    assert_warning(&stale_acceptance);
    assert!(snapshot(&conn).unwrap().acceptances.is_empty());

    let replay = update_goal(&conn, "revise-ancestor", OWNER, &root_goal_id, 1, "Revised parent requirement");
    assert_eq!(serde_json::to_value(replay).unwrap(), serde_json::to_value(update).unwrap());
    let cancellations_after_replay = pending_outbox(&conn).unwrap().into_iter()
        .filter(|item| item.target == "worker" && item.payload["body"]["method"] == "cancel")
        .count();
    assert_eq!(cancellations_after_replay, 1);

    let cancelled_result = worker_result(
        "confirm-active-descendant-cancel",
        &active_spec,
        "worker-active-descendant",
        1,
        "cancelled",
        Vec::new(),
        "Worker confirmed the immutable execution has stopped",
    );
    let _ = send(&conn, &cancelled_result, "worker-active-descendant");
    let final_state = snapshot(&conn).unwrap();
    assert_eq!(final_state.work.iter().find(|work| work.id == active_work_id).unwrap().state, "cancelled");
}

#[test]
fn expiration_is_deadline_gated_and_recovery_does_not_repeat_execution_intents() {
    let (_root, conn) = database();
    let root = submit_root(&conn, "root-expire", "Deadline-bounded root");
    assert_success(&root);
    let root_goal_id = root.data["goal"]["id"].as_str().unwrap().to_owned();
    let root_work_id = root.data["work"]["id"].as_str().unwrap().to_owned();
    let active = delegate(&conn, "expire-active-child", &root_work_id, ROOT_GHOST, 1, TARGET_A, "Active descendant to cancel", Vec::new());
    let queued = delegate(&conn, "expire-queued-child", &root_work_id, ROOT_GHOST, 1, TARGET_B, "Queued descendant to cancel", Vec::new());
    assert_success(&active);
    assert_success(&queued);
    let active_work_id = active.data["work"]["id"].as_str().unwrap().to_owned();
    let (admitted, spec) = submit_worker(&conn, "submit-expiring-child", &active_work_id, "execution-expiring-child", 1);
    assert_success(&admitted);

    let too_early = envelope(
        "expire-too-early",
        "host-maintenance",
        1,
        None,
        json!({ "method": "work.expire", "root_goal_id": root_goal_id }),
    );
    assert_error(&send(&conn, &too_early, "host-maintenance"), "conflict");
    let unauthorized = envelope(
        "expire-untrusted",
        TARGET_A,
        1,
        None,
        json!({ "method": "work.expire", "root_goal_id": root_goal_id }),
    );
    assert_error(&send(&conn, &unauthorized, TARGET_A), "unauthorized");

    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
    conn.execute(
        "UPDATE lifetime_graph_budgets SET deadline_ms=?1 WHERE root_goal_id=?2",
        params![now_ms - 1, root_goal_id],
    ).unwrap();
    let expire = envelope(
        "expire-due-root",
        "host-maintenance",
        1,
        None,
        json!({ "method": "work.expire", "root_goal_id": root_goal_id }),
    );
    let expired = send(&conn, &expire, "host-maintenance");
    assert_success(&expired);
    assert_eq!(expired.data["expired"], true);

    let state = snapshot(&conn).unwrap();
    assert_eq!(state.work.iter().find(|work| work.id == root_work_id).unwrap().state, "blocked");
    assert_eq!(state.work.iter().find(|work| work.id == active_work_id).unwrap().state, "cancel_requested");
    let queued_work_id = queued.data["work"]["id"].as_str().unwrap();
    assert_eq!(state.work.iter().find(|work| work.id == queued_work_id).unwrap().state, "cancelled");
    let cancel_count = pending_outbox(&conn).unwrap().into_iter()
        .filter(|item| item.target == "worker" && item.payload["body"]["method"] == "cancel")
        .count();
    assert_eq!(cancel_count, 1);

    let recovered = send(
        &conn,
        &envelope(
            "expire-recovered-root",
            "host-maintenance",
            1,
            None,
            json!({ "method": "work.expire", "root_goal_id": root_goal_id }),
        ),
        "host-maintenance",
    );
    assert_success(&recovered);
    assert_eq!(recovered.data["recovered"], true);
    let replay = send(&conn, &expire, "host-maintenance");
    assert_eq!(serde_json::to_value(replay).unwrap(), serde_json::to_value(expired).unwrap());
    assert_eq!(pending_outbox(&conn).unwrap().into_iter()
        .filter(|item| item.target == "worker" && item.payload["body"]["method"] == "cancel")
        .count(), 1);

    let blocked_delegate = delegate(
        &conn,
        "delegate-after-expiration",
        &root_work_id,
        ROOT_GHOST,
        1,
        TARGET_A,
        "Expired graphs cannot admit more children",
        Vec::new(),
    );
    assert_warning(&blocked_delegate);
    let (rejected_submit, _) = submit_worker(&conn, "submit-root-after-expiration", &root_work_id, "execution-root-after-expiration", 1);
    assert_warning(&rejected_submit);
    assert_eq!(snapshot(&conn).unwrap().goals.len(), 3);
    assert!(!pending_outbox(&conn).unwrap().iter().any(|item| {
        item.target == "worker"
            && item.payload["body"]["method"] == "submit"
            && item.payload["body"]["spec"]["execution_id"] == "execution-root-after-expiration"
    }));
    assert_eq!(spec.execution_id, "execution-expiring-child");
}

#[test]
fn graph_node_limit_counts_historical_root_work_and_rejects_without_expanding() {
    let (_root, conn) = database();
    let root = submit_root(&conn, "root-node-limit", "Node-bounded root");
    assert_success(&root);
    let root_goal_id = root.data["goal"]["id"].as_str().unwrap().to_owned();
    let root_work_id = root.data["work"]["id"].as_str().unwrap().to_owned();
    let base = snapshot(&conn).unwrap().work.into_iter().find(|work| work.id == root_work_id).unwrap();

    for _ in 0..255 {
        let mut historical = base.clone();
        historical.id = uuid::Uuid::now_v7().to_string();
        historical.state = "accepted".to_owned();
        historical.execution_id = None;
        historical.cancellation = "none".to_owned();
        historical.blocker = None;
        conn.execute(
            "INSERT INTO lifetime_work(id,goal_id,goal_revision,owner,owner_revision,state,execution_id,cancellation,payload) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                historical.id,
                historical.goal_id,
                historical.goal_revision,
                historical.owner,
                historical.owner_revision,
                historical.state,
                historical.execution_id,
                historical.cancellation,
                serde_json::to_string(&historical).unwrap(),
            ],
        ).unwrap();
    }

    let blocked = delegate(
        &conn,
        "delegate-at-node-limit",
        &root_work_id,
        ROOT_GHOST,
        1,
        TARGET_A,
        "The 257th work node must not be created",
        Vec::new(),
    );
    assert_warning(&blocked);
    let state = snapshot(&conn).unwrap();
    assert_eq!(state.goals.len(), 1);
    assert_eq!(state.work.len(), 256);
    assert_eq!(state.goals[0].id, root_goal_id);
}

#[test]
fn completed_parent_retains_children_until_their_responsibilities_resolve() {
    let (_root, conn) = database();
    let root = submit_root(&conn, "completed-parent-root", "Parent artifact and independent child review");
    assert_success(&root);
    let parent_id = root.data["work"]["id"].as_str().unwrap();
    let child = delegate(&conn, "completed-parent-child", parent_id, ROOT_GHOST, 1, TARGET_A,
        "Independent child review", Vec::new());
    assert_success(&child);
    let child_id = child.data["work"]["id"].as_str().unwrap();
    let (admitted, parent_spec) = submit_worker(&conn, "parent-submit", parent_id, "parent-execution", 1);
    assert_success(&admitted);
    let parent_artifact = artifact("parent-execution", 'a');
    assert_success(&send(&conn, &worker_result("parent-complete", &parent_spec, "worker-parent", 1,
        "completed", vec![parent_artifact.clone()], "Parent artifact is ready"), "worker-parent"));
    assert_warning(&accept_work(&conn, "parent-accept-before-child", &root.data["goal"], parent_id, &parent_artifact));
    let (admitted, child_spec) = submit_worker(&conn, "child-submit-after-parent-result", child_id, "child-execution", 1);
    assert_success(&admitted);
    let child_artifact = artifact("child-execution", 'b');
    assert_success(&send(&conn, &worker_result("child-complete-after-parent-result", &child_spec, "worker-child", 1,
        "completed", vec![child_artifact.clone()], "Child review is complete"), "worker-child"));
    assert_success(&accept_work(&conn, "child-accept-after-parent-result", &child.data["goal"], child_id, &child_artifact));
    let before_owner_acceptance = snapshot(&conn).unwrap();
    assert_eq!(before_owner_acceptance.work.iter().find(|work| work.id == parent_id).unwrap().state, "completed");
    assert_eq!(before_owner_acceptance.goals.iter().find(|goal| goal.id == root.data["goal"]["id"].as_str().unwrap()).unwrap().state, "open");
    assert_success(&accept_work(&conn, "parent-accept-after-child", &root.data["goal"], parent_id, &parent_artifact));
    assert_eq!(snapshot(&conn).unwrap().work.iter().find(|work| work.id == parent_id).unwrap().state, "accepted");
}

#[test]
fn host_caps_effective_deadline_without_changing_requested_intent_recovery() {
    let (_root, conn) = database();
    let root = submit_root(&conn, "deadline-cap-root", "Bounded child execution");
    let root_id = root.data["goal"]["id"].as_str().unwrap();
    let child = delegate(&conn, "deadline-cap-child", root.data["work"]["id"].as_str().unwrap(),
        ROOT_GHOST, 1, TARGET_A, "Bounded child scope", Vec::new());
    assert_success(&child);
    let now = i64::try_from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()).unwrap();
    conn.execute("UPDATE lifetime_graph_budgets SET deadline_ms=?1 WHERE root_goal_id=?2", params![now + 20_000, root_id]).unwrap();
    let child_id = child.data["work"]["id"].as_str().unwrap();
    let (admitted, spec) = submit_worker(&conn, "deadline-cap-admission", child_id, "capped-execution", 1);
    assert_success(&admitted);
    let payload: String = conn.query_row(
        "SELECT payload FROM lifetime_outbox WHERE target='worker' AND json_extract(payload,'$.body.spec.execution_id')='capped-execution'",
        [], |row| row.get(0),
    ).unwrap();
    let payload: Value = serde_json::from_str(&payload).unwrap();
    let effective = payload["body"]["spec"]["deadline_ms"].as_u64().unwrap();
    assert!(effective > 0 && effective <= 20_000);
    assert_eq!(spec.deadline_ms, 30_000);
    let original_body = json!({"method":"work.submit","work_id":child_id,"spec":spec});
    assert_success(&send(&conn, &envelope("deadline-cap-recovery", OWNER, 1, Some(1), original_body.clone()), OWNER));
    let mut changed = original_body;
    changed["spec"]["prompt"] = json!("Different immutable intent");
    assert_error(&send(&conn, &envelope("deadline-cap-different-intent", OWNER, 1, Some(1), changed), OWNER), "conflict");
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM lifetime_outbox WHERE target='worker' AND json_extract(payload,'$.body.spec.execution_id')='capped-execution'",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(count, 1);
}

#[test]
fn old_receipt_inspection_is_read_only_and_never_replays_an_old_generation() {
    let (_root, conn) = database();
    let original = submit_root(&conn, "old-owner-intent", "Saved original responsibility");
    assert_success(&original);
    conn.execute("UPDATE lifetime_authority SET authority_epoch=2,dispatch_enabled=0 WHERE singleton=1", []).unwrap();
    let before: i64 = conn.query_row("SELECT count(*) FROM lifetime_commands", [], |row| row.get(0)).unwrap();
    let inspect = envelope("current-receipt-read", OWNER, 2, None,
        json!({"method":"command.inspect","command_id":"old-owner-intent"}));
    let recovered = send(&conn, &inspect, OWNER);
    assert_success(&recovered);
    assert_eq!(recovered.data["authority_epoch"], 1);
    assert_eq!(recovered.data["response"]["data"]["goal"]["id"], original.data["goal"]["id"]);
    let missing = send(&conn, &envelope("absent-receipt-read", OWNER, 2, None,
        json!({"method":"command.inspect","command_id":"missing-original-intent"})), OWNER);
    assert_warning(&missing);
    assert_eq!(missing.retry_class, RetryClass::ReconcileFirst);
    assert_eq!(missing.data["found"], false);
    assert_error(&send(&conn, &envelope("wrong-principal-read", ROOT_GHOST, 2, None,
        json!({"method":"command.inspect","command_id":"old-owner-intent"})), ROOT_GHOST), "unauthorized");
    let after: i64 = conn.query_row("SELECT count(*) FROM lifetime_commands", [], |row| row.get(0)).unwrap();
    assert_eq!(after, before);
    assert_eq!(snapshot(&conn).unwrap().goals.len(), 1);
}

#[test]
fn last_child_acceptance_reassigns_original_parent_and_preserves_closed_artifacts() {
    let (_directory, conn) = database();
    let root = submit_root(&conn, "release-original-root", "Reconcile the verified child artifact references");
    assert_success(&root);
    let parent_id = root.data["work"]["id"].as_str().unwrap();
    let initial = pending_outbox(&conn).unwrap().into_iter()
        .find(|item| item.target == "pi" && item.payload["body"]["work_id"] == parent_id).unwrap();
    let context_ref: String = conn.query_row(
        "SELECT json_extract(payload,'$.reference') FROM workspace_objects
         WHERE kind='ghost_work_context_v1' AND id=?1",
        [initial.payload["command_id"].as_str().unwrap()],
        |row| row.get(0),
    ).unwrap();
    ghost::host::lifetime::ack_outbox(&conn, initial.id, &json!({
        "status":"success", "data":{
            "context_ref":context_ref,
            "command_id":initial.payload["command_id"],
            "ghost_id":ROOT_GHOST,"conversation_id":ROOT_CONVERSATION,
            "runtime_kind":"pi-durable","runtime_release":"1.1.0",
            "storage_ref":"fixture://durably-received-root"
        }
    })).unwrap();
    let child = delegate(&conn, "release-child", parent_id, ROOT_GHOST, 1,
        TARGET_A, "Produce the child result", Vec::new());
    assert_success(&child);
    let child_id = child.data["work"]["id"].as_str().unwrap();
    let (submitted, child_spec) = submit_worker_as(&conn, "release-child-submit", TARGET_A,
        child_id, "release-child-execution", 1, child.data["goal"]["prompt"].as_str().unwrap());
    assert_success(&submitted);
    let waiting = envelope("release-parent-wait", ROOT_GHOST, 1, Some(1),
        json!({"method":"work.wait","work_id":parent_id,"wait_for":[child_id]}));
    assert_success(&send(&conn, &waiting, ROOT_GHOST));
    let visible = artifact(&child_spec.execution_id, 'a');
    let mut withheld = artifact(&child_spec.execution_id, 'b');
    withheld.privacy = "local_only".to_owned();
    let result = worker_result("release-child-result", &child_spec, "release-producer", 1,
        "completed", vec![visible.clone(), withheld], "Private child narrative must not become task input");
    assert_success(&send(&conn, &result, "release-producer"));
    assert!(pending_outbox(&conn).unwrap().iter().all(|item|
        item.payload["body"]["method"] != "conversation.assignment"
        || item.payload["body"]["work_id"] != parent_id));
    assert_success(&accept_work(&conn, "release-child-accept", &child.data["goal"], child_id, &visible));
    let assignment = pending_outbox(&conn).unwrap().into_iter()
        .find(|item| item.target == "pi"
            && item.payload["body"]["method"] == "conversation.assignment"
            && item.payload["body"]["work_id"] == parent_id).unwrap();
    assert_ne!(assignment.payload["command_id"], initial.payload["command_id"]);
    let inspected = inspect_assignment(&conn, "release-inspect-assignment", ROOT_GHOST,
        ROOT_GHOST, ROOT_CONVERSATION, assignment.payload["command_id"].as_str().unwrap());
    assert_success(&inspected);
    assert_eq!(inspected.data["assignment"]["source_command_id"], "release-original-root");
    assert_eq!(inspected.data["assignment"]["goal_id"], root.data["goal"]["id"]);
    assert_eq!(inspected.data["assignment"]["goal_revision"], 1);
    assert_eq!(inspected.data["assignment"]["prompt"], root.data["goal"]["prompt"]);
    let children = send(&conn, &envelope("release-inspect-children", ROOT_GHOST, 1, None,
        json!({"method":"work.children","work_id":parent_id})), ROOT_GHOST);
    assert_success(&children);
    assert_eq!(children.data["results"][0]["work_id"], child_id);
    assert_eq!(children.data["results"][0]["artifacts"], json!([visible]));
    assert_eq!(children.data["results"][0]["protected_artifacts_withheld"], true);
    let mut parent_spec = worker_spec(parent_id, "release-parent-execution", 1);
    parent_spec.prompt = root.data["goal"]["prompt"].as_str().unwrap().to_owned();
    parent_spec.input_artifacts = Some(serde_json::from_value(children.data["results"].clone()).unwrap());
    let mut forged = parent_spec.clone();
    forged.input_artifacts.as_mut().unwrap()[0].artifacts[0].digest = "f".repeat(64);
    let forged_request = envelope("release-forged-input", ROOT_GHOST, 1, Some(1),
        json!({"method":"work.submit","work_id":parent_id,"spec":forged}));
    assert_error(&send(&conn, &forged_request, ROOT_GHOST), "invalid_request");
    assert!(snapshot(&conn).unwrap().work.iter().find(|work| work.id == parent_id).unwrap().execution_id.is_none());
    let submit = envelope("release-parent-submit", ROOT_GHOST, 1, Some(1),
        json!({"method":"work.submit","work_id":parent_id,"spec":parent_spec}));
    assert_success(&send(&conn, &submit, ROOT_GHOST));
    let parent_artifact = artifact(&parent_spec.execution_id, 'c');
    assert_success(&send(&conn, &worker_result("release-parent-result", &parent_spec,
        "parent-producer", 1, "completed", vec![parent_artifact.clone()], "Verified references reconciled"),
        "parent-producer"));
    assert_success(&accept_work(&conn, "release-parent-accept", &root.data["goal"], parent_id, &parent_artifact));
    conn.execute("UPDATE lifetime_graph_budgets SET deadline_ms=1 WHERE root_goal_id=?1",
        [root.data["goal"]["id"].as_str().unwrap()]).unwrap();
    for (index, id) in [parent_id, child_id].into_iter().enumerate() {
        let inspected = send(&conn, &envelope(&format!("closed-artifact-{index}"), OWNER, 1, None,
            json!({"method":"work.inspect","work_id":id})), OWNER);
        assert_success(&inspected);
        assert_eq!(inspected.data["result"]["current"], true);
    }
    let forbidden = delegate(&conn, "closed-root-no-delegation", parent_id, ROOT_GHOST, 1,
        TARGET_B, "Do not restart a closed graph", Vec::new());
    assert_error(&forbidden, "conflict");
}

#[test]
fn child_revision_invalidates_parent_result_bound_to_older_input_artifacts() {
    let (_directory, conn) = database();
    let root = submit_root(&conn, "input-currency-root", "Reconcile current child references");
    assert_success(&root);
    let parent_id = root.data["work"]["id"].as_str().unwrap();
    let child = delegate(&conn, "input-currency-child", parent_id, ROOT_GHOST, 1,
        TARGET_A, "Produce current references", Vec::new());
    assert_success(&child);
    let child_id = child.data["work"]["id"].as_str().unwrap();
    let (submitted, child_spec) = submit_worker_as(&conn, "input-currency-child-submit",
        TARGET_A, child_id, "input-currency-child-execution", 1,
        child.data["goal"]["prompt"].as_str().unwrap());
    assert_success(&submitted);
    let child_artifact = artifact(&child_spec.execution_id, 'd');
    assert_success(&send(&conn, &worker_result("input-currency-child-result", &child_spec,
        "input-child-producer", 1, "completed", vec![child_artifact.clone()], "Current child artifact"),
        "input-child-producer"));
    assert_success(&accept_work(&conn, "input-currency-child-accept",
        &child.data["goal"], child_id, &child_artifact));
    let children = send(&conn, &envelope("input-currency-children", ROOT_GHOST, 1, None,
        json!({"method":"work.children","work_id":parent_id})), ROOT_GHOST);
    assert_success(&children);
    let mut spec = worker_spec(parent_id, "input-currency-parent-execution", 1);
    spec.prompt = root.data["goal"]["prompt"].as_str().unwrap().to_owned();
    spec.input_artifacts = Some(serde_json::from_value(children.data["results"].clone()).unwrap());
    assert_success(&send(&conn, &envelope("input-currency-parent-submit", ROOT_GHOST, 1, Some(1),
        json!({"method":"work.submit","work_id":parent_id,"spec":spec})), ROOT_GHOST));
    let parent_artifact = artifact(&spec.execution_id, 'e');
    assert_success(&send(&conn, &worker_result("input-currency-parent-result", &spec,
        "input-parent-producer", 1, "completed", vec![parent_artifact.clone()], "Snapshot reconciliation"),
        "input-parent-producer"));
    assert_success(&update_goal(&conn, "input-currency-child-revision", TARGET_A,
        child.data["goal"]["id"].as_str().unwrap(), 1, "New child requirement"));
    let inspected = send(&conn, &envelope("input-currency-parent-inspect", OWNER, 1, None,
        json!({"method":"work.inspect","work_id":parent_id})), OWNER);
    assert_success(&inspected);
    assert_eq!(inspected.data["result"]["current"], false);
    assert_eq!(inspected.data["result"]["reason"], "stale_artifact_inputs");
    let accepted = accept_work(&conn, "input-currency-must-not-accept", &root.data["goal"],
        parent_id, &parent_artifact);
    assert_ne!(accepted.status, ResponseStatus::Success);
    assert_eq!(snapshot(&conn).unwrap().goals.iter()
        .find(|goal| goal.id == root.data["goal"]["id"].as_str().unwrap()).unwrap().state, "open");
}

#[test]
fn bounded_delegation_cannot_widen_its_scope_on_revision() {
    let (_root, conn) = database();
    let root = submit_root(&conn, "bounded-root", "Coordinate a bounded research task.");
    assert_success(&root);
    let parent = root.data["work"]["id"].as_str().unwrap();
    let mut child_body = json!({
        "method":"work.delegate", "parent_work_id":parent, "target_ghost_id":TARGET_A,
        "summary":"Inspect the assigned evidence and report it.", "artifact_refs":[],
        "acceptance_spec":{"required_checks":["artifact_content"],"delegation_allowed":false}
    });
    let child = send(&conn, &envelope("bounded-child", ROOT_GHOST, 1, Some(1), child_body.clone()), ROOT_GHOST);
    assert_success(&child);
    let work_id = child.data["work"]["id"].as_str().unwrap();
    let goal_id = child.data["goal"]["id"].as_str().unwrap();
    let re_delegation = |id, revision| delegate(&conn, id, work_id, TARGET_A, revision, TARGET_B, "Pass it on.", vec![]);
    assert_error(&re_delegation("bounded-grandchild", 1), "unauthorized");
    assert_error(
        &update_goal(&conn, "bounded-widen", TARGET_A, goal_id, 1, "Drop my delegation restriction."),
        "unauthorized",
    );
    let revise = envelope("bounded-revise", TARGET_A, 1, Some(1), json!({
        "method":"goal.update", "goal_id":goal_id, "prompt":"Inspect the same scope with the revised instructions.",
        "acceptance_spec":child_body["acceptance_spec"],
    }));
    assert_success(&send(&conn, &revise, TARGET_A));
    assert_error(&re_delegation("bounded-grandchild-after-revision", 2), "unauthorized");
    child_body["target_ghost_id"] = json!(TARGET_B);
    child_body["acceptance_spec"]["delegation_allowed"] = json!("false");
    let invalid = envelope("invalid-delegation-limit", ROOT_GHOST, 1, Some(1), child_body);
    assert_error(&send(&conn, &invalid, ROOT_GHOST), "invalid_request");
    assert_eq!(snapshot(&conn).unwrap().goals.len(), 2);
}
