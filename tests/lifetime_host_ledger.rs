#![cfg(feature = "lifetime")]

use ghost::{
    host::lifetime::{ack_outbox, apply, pending_outbox, snapshot},
    lifetime_contract::{canonical_digest, Acceptance, Artifact, Envelope, Response, ResponseStatus, WorkerSpec, VERSION},
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;
use tempfile::TempDir;

const CANARY_ROOT: &str = ".lifetime-canary/ghost-20261009T012047Z/A1";

fn database() -> (TempDir, Connection) {
    let canary = Path::new(env!("CARGO_MANIFEST_DIR")).join(CANARY_ROOT);
    std::fs::create_dir_all(&canary).unwrap();
    let root = tempfile::Builder::new()
        .prefix("host-ledger-")
        .tempdir_in(canary)
        .unwrap();
    let connection = Connection::open(root.path().join("workspace.db")).unwrap();
    connection.execute_batch(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE workspace_objects(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
         INSERT INTO workspace_objects(kind,id,payload) VALUES('profile','22222222-2222-7222-8222-222222222222','preserve-me');",
    ).unwrap();
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
    connection.execute("UPDATE lifetime_verification_policy SET verifier_revision='fixture-verifier/1' WHERE singleton=1", []).unwrap();
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

fn assert_error(response: &Response, code: &str) {
    assert_eq!(response.status, ResponseStatus::Error, "{response:?}");
    assert_eq!(response.error_code.as_deref(), Some(code));
}

fn submit_goal(conn: &Connection, command_id: &str) -> Response {
    let request = envelope(
        command_id,
        "owner",
        1,
        None,
        json!({
            "method": "goal.submit",
            "ghost_id": "22222222-2222-7222-8222-222222222222",
            "conversation_id": "11111111-1111-7111-8111-111111111111",
            "prompt": "Create a canary artifact",
            "privacy": "public",
            "acceptance_spec": { "required_checks": ["artifact_content"] }
        }),
    );
    send(conn, &request, "owner")
}

fn worker_spec(work_id: &str, execution_id: &str, revision: u64) -> WorkerSpec {
    WorkerSpec {
        execution_id: execution_id.to_owned(),
        work_id: work_id.to_owned(),
        work_revision: revision,
        authority_epoch: 1,
        computer_id: "computer-fixture".to_owned(),
        cwd: "/workspace/canary".to_owned(),
        prompt: "Run only the canary task".to_owned(),
        model: "fixture-model".to_owned(),
        thinking: "max".to_owned(),
        allowed_tools: vec!["read".to_owned()],
        deadline_ms: 30_000,
        max_progress_bytes: 4096,
        skills: None,
        input_artifacts: None,
    }
}

fn submit_worker(conn: &Connection, work_id: &str, execution_id: &str) -> (Response, WorkerSpec) {
    let spec = worker_spec(work_id, execution_id, 1);
    let request = envelope(
        "worker-submit-1",
        "owner",
        1,
        Some(1),
        json!({
            "method": "work.submit",
            "work_id": work_id,
            "spec": serde_json::to_value(&spec).unwrap()
        }),
    );
    (send(conn, &request, "owner"), spec)
}

fn store_skill_revision(conn: &Connection, revision: u64, digest: &str, privacy: &str) {
    let payload = json!({
        "id": "canary-counter",
        "profile_id": "22222222-2222-7222-8222-222222222222",
        "digest": digest,
        "revision": revision,
        "status": "active",
        "privacy": privacy,
        "origin": { "kind": "owner" },
        "created_ms": 1,
        "updated_ms": revision,
        "title": "Canary counter",
        "description": "Use the admitted counter procedure"
    });
    conn.execute(
        "INSERT INTO workspace_objects(kind,id,payload) VALUES('skill','owner:canary-counter',?1)
         ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",
        [payload.to_string()],
    ).unwrap();
}

#[test]
fn omitted_skills_admit_and_promotion_cannot_replace_the_queued_pin_or_lower_disclosure() {
    let (_root, conn) = database();
    store_skill_revision(&conn, 1, &"a".repeat(64), "private");
    let submitted = submit_goal(&conn, "skill-goal");
    let work_id = submitted.data["work"]["id"].as_str().unwrap();
    let (admitted, spec) = submit_worker(&conn, work_id, "skill-execution");
    assert_success(&admitted);
    assert_eq!(admitted.data["work"]["state"], "submitted");
    let queued: Vec<_> = pending_outbox(&conn).unwrap().into_iter()
        .filter(|item| item.target == "worker").collect();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].payload["body"]["spec"]["skills"][0]["sha256"], "a".repeat(64));

    store_skill_revision(&conn, 2, &"b".repeat(64), "public");
    let replay = envelope("skill-replay", "owner", 1, Some(1), json!({
        "method": "work.submit", "work_id": work_id, "spec": spec
    }));
    assert_success(&send(&conn, &replay, "owner"));
    let recovered: Vec<_> = pending_outbox(&conn).unwrap().into_iter()
        .filter(|item| item.target == "worker").collect();
    assert_eq!(recovered, queued);
    let disclosure: String = conn.query_row(
        "SELECT privacy FROM lifetime_conversation_disclosure
         WHERE ghost_id='22222222-2222-7222-8222-222222222222'
           AND conversation_id='11111111-1111-7111-8111-111111111111'",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(disclosure, "private");
}

#[test]
fn caller_cannot_forge_the_skill_revision_or_downgrade_its_source_privacy() {
    let (_root, conn) = database();
    let digest = "a".repeat(64);
    store_skill_revision(&conn, 1, &digest, "private");
    let submitted = submit_goal(&conn, "forged-skill-goal");
    let work_id = submitted.data["work"]["id"].as_str().unwrap();
    for (command_id, supplied_digest, supplied_privacy) in [
        ("wrong-skill-revision", "b".repeat(64), "private"),
        ("downgraded-skill-source", digest, "public"),
    ] {
        let mut spec = serde_json::to_value(worker_spec(work_id, "forged-skill-execution", 1)).unwrap();
        spec["skills"] = json!([{
            "name": "canary-counter", "sha256": supplied_digest, "privacy": supplied_privacy
        }]);
        let request = envelope(command_id, "owner", 1, Some(1), json!({
            "method": "work.submit", "work_id": work_id, "spec": spec
        }));
        assert_error(&send(&conn, &request, "owner"), "invalid_request");
        assert!(snapshot(&conn).unwrap().work[0].execution_id.is_none());
        assert!(pending_outbox(&conn).unwrap().iter().all(|item| item.target != "worker"));
    }
}

fn artifact(execution_id: &str) -> Artifact {
    Artifact {
        digest: "a".repeat(64),
        locator: "artifact://canary/result.txt".to_owned(),
        privacy: "public".to_owned(),
        producing_attempt: execution_id.to_owned(),
    }
}

fn worker_result(
    command_id: &str,
    execution_id: &str,
    producer: &str,
    sequence: u64,
    goal_revision: u64,
    state: &str,
    artifacts: Vec<Artifact>,
    summary: &str,
) -> Envelope {
    envelope(
        command_id,
        producer,
        1,
        Some(goal_revision),
        json!({
            "method": "work.result",
            "execution_id": execution_id,
            "producer": producer,
            "sequence": sequence,
            "goal_revision": goal_revision,
            "state": state,
            "artifacts": artifacts,
            "summary": summary
        }),
    )
}

fn acceptance(work_id: &str, revision: u64, requirement_digest: &str, artifact_digest: &str) -> Acceptance {
    Acceptance {
        work_id: work_id.to_owned(),
        goal_revision: revision,
        requirement_digest: requirement_digest.to_owned(),
        artifact_digest: artifact_digest.to_owned(),
        verifier_revision: "fixture-verifier/1".to_owned(),
        policy_revision: 1,
        checks: vec![ghost::lifetime_contract::Check {
            id: "artifact_content".to_owned(),
            passed: true,
            evidence: "verified canary bytes".to_owned(),
        }],
    }
}


#[test]
fn admission_replay_and_lost_outbox_ack_recover_the_same_command() {
    let (root, connection) = database();
    let request = envelope(
        "goal-submit-replay",
        "owner",
        1,
        None,
        json!({
            "method": "goal.submit",
            "ghost_id": "22222222-2222-7222-8222-222222222222",
            "conversation_id": "11111111-1111-7111-8111-111111111111",
            "prompt": "Create a canary artifact",
            "privacy": "public",
            "acceptance_spec": { "required_checks": ["artifact_content"] }
        }),
    );
    let first = send(&connection, &request, "owner");
    assert_success(&first);
    assert_eq!(snapshot(&connection).unwrap().goals.len(), 1);
    assert_eq!(snapshot(&connection).unwrap().work.len(), 1);
    let legacy: String = connection
        .query_row(
            "SELECT payload FROM workspace_objects WHERE kind='profile' AND id='22222222-2222-7222-8222-222222222222'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(legacy, "preserve-me");

    let pending = pending_outbox(&connection).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].target, "pi");
    drop(connection); // The committed delivery intent has no Host ACK.

    let reopened = Connection::open(root.path().join("workspace.db")).unwrap();
    let recovered = pending_outbox(&reopened).unwrap();
    assert_eq!(recovered, pending);
    assert!(ack_outbox(&reopened, recovered[0].id, &json!({ "status": "error" })).is_err());
    assert_eq!(pending_outbox(&reopened).unwrap(), recovered);
    let accepted_receipt = json!({"status":"success","data":{
        "command_id":recovered[0].payload["command_id"],"submission_id":1,
        "conversation_id":request.body["conversation_id"],"ghost_id":request.body["ghost_id"],
        "runtime_kind":"pi-durable","runtime_release":"1.1.0","storage_ref":"fixture:durable-conversation"
    }});
    ack_outbox(&reopened, recovered[0].id, &accepted_receipt).unwrap();
    assert!(pending_outbox(&reopened).unwrap().is_empty());
    ack_outbox(&reopened, recovered[0].id, &accepted_receipt).unwrap();
    let mut replaced_receipt = accepted_receipt.clone();
    replaced_receipt["data"]["submission_id"] = json!(2);
    assert!(ack_outbox(&reopened, recovered[0].id, &replaced_receipt).is_err());

    assert_eq!(send(&reopened, &request, "owner"), first);
    let changed_body = envelope(
        "goal-submit-replay",
        "owner",
        1,
        None,
        json!({
            "method": "goal.submit",
            "ghost_id": "22222222-2222-7222-8222-222222222222",
            "conversation_id": "11111111-1111-7111-8111-111111111111",
            "prompt": "Different bytes under the same ID",
            "privacy": "public",
            "acceptance_spec": { "required_checks": ["artifact_content"] }
        }),
    );
    assert_error(&send(&reopened, &changed_body, "owner"), "conflict");
    let changed_actor = envelope(
        "goal-submit-replay",
        "different-owner",
        1,
        None,
        request.body.clone(),
    );
    assert_error(
        &send(&reopened, &changed_actor, "different-owner"),
        "conflict",
    );
    assert_eq!(snapshot(&reopened).unwrap().goals.len(), 1);
}

#[test]
fn assignment_ack_clears_only_current_unexecuted_transport_blockers() {
    for (blocker, state, execution, stale, cleared) in [
        ("goal_assignment_inspection_unconfirmed", "queued", None, false, true),
        ("policy_blocked", "queued", None, false, false),
        ("goal_assignment_inspection_unconfirmed", "unknown", Some("existing-execution"), false, false),
        ("goal_assignment_inspection_unconfirmed", "queued", None, true, false),
    ] {
        let (_root, conn) = database();
        assert_success(&submit_goal(&conn, "assignment-ack-blocker"));
        conn.execute("UPDATE lifetime_work SET state=?1,execution_id=?2,payload=json_set(payload,'$.state',?1,'$.execution_id',?2,'$.blocker',?3)",
            rusqlite::params![state, execution, blocker]).unwrap();
        if stale { conn.execute("UPDATE lifetime_goals SET revision=2,payload=json_set(payload,'$.revision',2)", []).unwrap(); }
        let pending = pending_outbox(&conn).unwrap().remove(0);
        ack_outbox(&conn, pending.id, &json!({"status":"success","data":{
            "command_id":pending.payload["command_id"],
            "conversation_id":pending.payload["body"]["conversation_id"],"ghost_id":pending.payload["body"]["ghost_id"],
            "runtime_kind":"pi-durable","runtime_release":"1.1.0","storage_ref":"fixture:original-storage"
        }})).unwrap();
        let remaining: Option<String> = conn.query_row("SELECT json_extract(payload,'$.blocker') FROM lifetime_work", [], |row| row.get(0)).unwrap();
        assert_eq!(remaining.as_deref(), if cleared { None } else { Some(blocker) });
    }
}

#[test]
fn goal_cas_stale_result_and_acceptance_require_the_current_revision() {
    let (_root, connection) = database();
    let submitted = submit_goal(&connection, "goal-submit-cas");
    assert_success(&submitted);
    let goal_id = submitted.data["goal"]["id"].as_str().unwrap().to_owned();
    let work_id = submitted.data["work"]["id"].as_str().unwrap().to_owned();
    let (worker_admission, spec) = submit_worker(&connection, &work_id, "execution-cas");
    assert_success(&worker_admission);

    let update = envelope(
        "goal-update-r2",
        "owner",
        1,
        Some(1),
        json!({
            "method": "goal.update",
            "goal_id": goal_id,
            "prompt": "Create a canary artifact with the revised requirement",
            "acceptance_spec": { "required_checks": ["artifact_content"] }
        }),
    );
    let updated = send(&connection, &update, "owner");
    assert_success(&updated);
    let current_goal = updated.data["goal"].clone();
    let current_work = updated.data["work"].as_array().unwrap().iter()
        .find(|candidate| candidate["goal_revision"] == 2).unwrap().clone();
    assert_eq!(current_goal["revision"], 2);
    assert_eq!(current_work["goal_revision"], 2);

    let stale_cas = envelope(
        "goal-update-stale-cas",
        "owner",
        1,
        Some(1),
        json!({
            "method": "goal.update",
            "goal_id": goal_id,
            "prompt": "This stale update must not win",
            "acceptance_spec": { "required_checks": ["artifact_content"] }
        }),
    );
    assert_error(&send(&connection, &stale_cas, "owner"), "conflict");
    assert_eq!(snapshot(&connection).unwrap().goals[0].revision, 2);

    let current_artifact = artifact(&spec.execution_id);
    let stale_result = worker_result(
        "result-old-revision",
        &spec.execution_id,
        "worker-1",
        1,
        1,
        "completed",
        vec![current_artifact.clone()],
        "late result for revision one",
    );
    let stale_reply = send(&connection, &stale_result, "worker-1");
    assert_eq!(stale_reply.status, ResponseStatus::Warning);
    assert_eq!(stale_reply.data["current"], false);
    assert_eq!(stale_reply.data["reason"], "stale_requirement");
    assert_eq!(stale_reply.artifacts, vec![current_artifact.clone()]);

    let stale_acceptance = acceptance(
        &work_id,
        2,
        current_goal["requirement_digest"].as_str().unwrap(),
        &current_artifact.digest,
    );
    let stale_accept = envelope(
        "accept-stale-result",
        "owner",
        1,
        Some(2),
        json!({ "method": "work.accept", "acceptance": stale_acceptance }),
    );
    assert_error(&send(&connection, &stale_accept, "owner"), "conflict");
    assert!(snapshot(&connection).unwrap().acceptances.is_empty());

    let current_work_id = current_work["id"].as_str().unwrap().to_owned();
    let current_spec = worker_spec(&current_work_id, "execution-cas-current", 2);
    let current_submit = envelope(
        "current-submit-reconciled",
        "owner", 1, Some(2),
        json!({
            "method": "work.submit",
            "work_id": current_work_id,
            "spec": current_spec,
        }),
    );
    assert_error(&send(&connection, &current_submit, "owner"), "waiting_host");
    let cancel_confirmation = worker_result(
        "old-attempt-cancelled", &spec.execution_id, "worker-1", 2, 1,
        "cancelled", Vec::new(), "old immutable attempt has terminated",
    );
    send(&connection, &cancel_confirmation, "worker-1");
    assert_success(&send(&connection, &current_submit, "owner"));
    let current_artifact = artifact(&current_spec.execution_id);
    let current_result = worker_result(
        "result-current-revision",
        &current_spec.execution_id,
        "worker-2",
        1,
        2,
        "completed",
        vec![current_artifact.clone()],
        "result for current revision from a new immutable attempt",
    );
    let current_reply = send(&connection, &current_result, "worker-2");
    assert_success(&current_reply);
    assert_eq!(current_reply.data["current"], true);
    let accepted = acceptance(
        &current_work_id,
        2,
        current_goal["requirement_digest"].as_str().unwrap(),
        &current_artifact.digest,
    );
    let mut incomplete = accepted.clone();
    incomplete.checks.clear();
    let missing_check = envelope(
        "accept-missing-required-check",
        "owner",
        1,
        Some(2),
        json!({ "method": "work.accept", "acceptance": incomplete }),
    );
    assert_error(&send(&connection, &missing_check, "owner"), "conflict");
    assert!(snapshot(&connection).unwrap().acceptances.is_empty());
    let accept_request = envelope(
        "accept-current-result",
        "owner",
        1,
        Some(2),
        json!({ "method": "work.accept", "acceptance": accepted.clone() }),
    );
    assert_success(&send(&connection, &accept_request, "owner"));
    assert_eq!(snapshot(&connection).unwrap().acceptances.len(), 1);

    let late_artifact = Artifact {
        digest: "b".repeat(64),
        locator: "artifact://canary/late.txt".to_owned(),
        privacy: "public".to_owned(),
        producing_attempt: current_spec.execution_id.clone(),
    };
    let post_acceptance_result = worker_result(
        "result-after-acceptance",
        &current_spec.execution_id,
        "worker-2",
        3,
        2,
        "failed",
        vec![late_artifact],
        "late result must not replace acceptance",
    );
    let post_acceptance = send(&connection, &post_acceptance_result, "worker-2");
    assert_eq!(post_acceptance.status, ResponseStatus::Warning);
    assert_eq!(post_acceptance.data["reason"], "already_accepted");
    let inspect_accepted = envelope(
        "inspect-after-late-result",
        "owner",
        1,
        None,
        json!({ "method": "work.inspect", "work_id": current_work_id }),
    );
    let accepted_state = send(&connection, &inspect_accepted, "owner");
    assert_eq!(accepted_state.data["work"]["state"], "accepted");
    assert_eq!(accepted_state.data["result"]["current"], true);
    assert_eq!(
        accepted_state.data["acceptance"]["artifact_digest"],
        current_artifact.digest
    );
    let next_update = envelope(
        "goal-update-r3",
        "owner",
        1,
        Some(2),
        json!({
            "method": "goal.update",
            "goal_id": goal_id,
            "prompt": "A third requirement revision",
            "acceptance_spec": { "required_checks": ["artifact_content"] }
        }),
    );
    let revised = send(&connection, &next_update, "owner");
    assert_success(&revised);
    assert_eq!(revised.data["goal"]["revision"], 3);
    assert_eq!(snapshot(&connection).unwrap().acceptances[0].goal_revision, 2);
    let stale_acceptance = envelope(
        "accept-old-acceptance-r3",
        "owner",
        1,
        Some(3),
        json!({ "method": "work.accept", "acceptance": accepted }),
    );
    assert_error(&send(&connection, &stale_acceptance, "owner"), "conflict");
}

#[test]
fn worker_cancel_requires_confirmation_and_sequences_fence_late_results() {
    let (_root, connection) = database();
    let submitted = submit_goal(&connection, "goal-submit-cancel");
    let work_id = submitted.data["work"]["id"].as_str().unwrap().to_owned();
    let (admitted, spec) = submit_worker(&connection, &work_id, "execution-cancel");
    assert_success(&admitted);

    let duplicate_submit = envelope(
        "worker-submit-replay-new-command",
        "owner",
        1,
        Some(1),
        json!({
            "method": "work.submit",
            "work_id": work_id,
            "spec": serde_json::to_value(&spec).unwrap()
        }),
    );
    assert_eq!(
        send(&connection, &duplicate_submit, "owner").data["execution_id"],
        "execution-cancel"
    );
    assert_eq!(
        pending_outbox(&connection)
            .unwrap()
            .iter()
            .filter(|item| item.target == "worker" && item.payload["body"]["method"] == "submit")
            .count(),
        1
    );
    let mut altered_spec = spec.clone();
    altered_spec.prompt = "changed immutable execution bytes".to_owned();
    let conflicting_submit = envelope(
        "worker-submit-conflicting-content",
        "owner",
        1,
        Some(1),
        json!({
            "method": "work.submit",
            "work_id": work_id,
            "spec": serde_json::to_value(altered_spec).unwrap()
        }),
    );
    assert_error(&send(&connection, &conflicting_submit, "owner"), "conflict");

    let cancel = envelope(
        "work-cancel-request",
        "owner",
        1,
        Some(1),
        json!({ "method": "work.cancel", "work_id": work_id }),
    );
    let cancel_reply = send(&connection, &cancel, "owner");
    assert_success(&cancel_reply);
    assert_eq!(cancel_reply.data["work"]["cancellation"], "requested");
    let cancel_item = pending_outbox(&connection)
        .unwrap()
        .into_iter()
        .find(|item| item.target == "worker" && item.payload["body"]["method"] == "cancel")
        .unwrap();
    ack_outbox(
        &connection,
        cancel_item.id,
        &json!({ "status": "success", "data": { "execution_id":spec.execution_id, "cancel_receipt": "queued" } }),
    )
    .unwrap();
    let inspect_before_result = envelope(
        "inspect-cancel-before-confirm",
        "owner",
        1,
        None,
        json!({ "method": "work.inspect", "work_id": work_id }),
    );
    assert_eq!(
        send(&connection, &inspect_before_result, "owner").data["work"]["cancellation"],
        "requested"
    );

    let cancelled_result = worker_result(
        "result-cancel-confirmed",
        &spec.execution_id,
        "worker-1",
        2,
        1,
        "cancelled",
        Vec::new(),
        "worker confirmed cancellation",
    );
    let cancelled = send(&connection, &cancelled_result, "worker-1");
    assert_eq!(cancelled.status, ResponseStatus::Warning);
    let inspect_after_result = envelope(
        "inspect-cancel-after-confirm",
        "owner",
        1,
        None,
        json!({ "method": "work.inspect", "work_id": work_id }),
    );
    let work_after_cancel = send(&connection, &inspect_after_result, "owner").data["work"].clone();
    assert_eq!(work_after_cancel["cancellation"], "confirmed");
    assert_eq!(work_after_cancel["state"], "cancelled");

    let late_result = worker_result(
        "result-out-of-order-late",
        &spec.execution_id,
        "worker-1",
        1,
        1,
        "completed",
        Vec::new(),
        "older terminal event arrived late",
    );
    let late = send(&connection, &late_result, "worker-1");
    assert_eq!(late.status, ResponseStatus::Warning);
    assert_eq!(late.data["reason"], "out_of_order");
    assert_eq!(
        send(&connection, &inspect_after_result, "owner").data["work"]["state"],
        "cancelled"
    );

    let duplicate_sequence = envelope(
        "result-out-of-order-duplicate",
        "worker-1",
        1,
        Some(1),
        late_result.body.clone(),
    );
    let duplicate = send(&connection, &duplicate_sequence, "worker-1");
    assert_eq!(duplicate.data["duplicate"], true);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM lifetime_inbox", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
    let changed_sequence = worker_result(
        "result-out-of-order-conflict",
        &spec.execution_id,
        "worker-1",
        1,
        1,
        "completed",
        Vec::new(),
        "different bytes at the same producer sequence",
    );
    assert_error(&send(&connection, &changed_sequence, "worker-1"), "conflict");
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM lifetime_inbox", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn producer_cannot_accept_work_or_replace_an_immutable_verifier_record() {
    let (_root, connection) = database();
    let goal = submit_goal(&connection, "producer-reserved-state-goal");
    let work_id = goal.data["work"]["id"].as_str().unwrap().to_owned();
    let (_, spec) = submit_worker(&connection, &work_id, "execution-producer-state");
    let produced_artifact = artifact(&spec.execution_id);
    let forged = worker_result(
        "producer-forged-accepted", &spec.execution_id, "worker-state", 1, 1,
        "accepted", vec![produced_artifact.clone()], "not verifier authority",
    );
    assert_error(&send(&connection, &forged, "worker-state"), "invalid_request");
    assert!(snapshot(&connection).unwrap().acceptances.is_empty());
    assert_ne!(snapshot(&connection).unwrap().work[0].state, "accepted");

    let running = worker_result(
        "producer-still-running", &spec.execution_id, "worker-state", 1, 1,
        "running", vec![produced_artifact.clone()], "file exists but process has not completed",
    );
    assert_success(&send(&connection, &running, "worker-state"));
    let proof = acceptance(
        &work_id, 1, goal.data["goal"]["requirement_digest"].as_str().unwrap(),
        &produced_artifact.digest,
    );
    let premature = envelope(
        "accept-running-producer", "owner", 1, Some(1),
        json!({"method":"work.accept","acceptance":proof}),
    );
    assert_error(&send(&connection, &premature, "owner"), "conflict");

    let completed = worker_result(
        "producer-completed", &spec.execution_id, "worker-state", 2, 1,
        "completed", vec![produced_artifact], "completed attempt ready for independent verification",
    );
    assert_success(&send(&connection, &completed, "worker-state"));
    let accepted_request = envelope(
        "accept-completed-producer", "owner", 1, Some(1),
        json!({"method":"work.accept","acceptance":proof}),
    );
    let first = send(&connection, &accepted_request, "owner");
    assert_success(&first);
    let mut replacement = proof.clone();
    replacement.checks[0].evidence = "replacement evidence must not overwrite the original".into();
    let replacement_request = envelope(
        "replace-accepted-proof", "owner", 1, Some(1),
        json!({"method":"work.accept","acceptance":replacement}),
    );
    assert_error(&send(&connection, &replacement_request, "owner"), "conflict");
    assert_eq!(snapshot(&connection).unwrap().acceptances, vec![proof]);
    assert_eq!(
        serde_json::to_value(send(&connection, &accepted_request, "owner")).unwrap(),
        serde_json::to_value(first).unwrap(),
    );
}

#[test]
fn acceptance_rejects_stale_verifier_policy_and_failed_independent_checks() {
    let (_root, conn) = database();
    let submitted = submit_goal(&conn, "verifier-goal");
    assert_success(&submitted);
    let snapshot = ghost::host::lifetime::snapshot(&conn).unwrap();
    let goal = &snapshot.goals[0];
    let work_id = &snapshot.work[0].id;
    let (admitted, _) = submit_worker(&conn, work_id, "verifier-execution");
    assert_success(&admitted);
    let output = artifact("verifier-execution");
    let result = worker_result("verifier-result", "verifier-execution", "verifier-worker", 1, 1, "completed", vec![output.clone()], "Fixture result for verifier revision boundary");
    assert_success(&send(&conn, &result, "verifier-worker"));
    let valid = acceptance(work_id, 1, &goal.requirement_digest, &output.digest);
    let mut stale_verifier = valid.clone();
    stale_verifier.verifier_revision = "retired-verifier/0".into();
    let mut stale_policy = valid.clone();
    stale_policy.policy_revision = 2;
    let mut failed_check = valid.clone();
    failed_check.checks.push(ghost::lifetime_contract::Check { id:"side_effect_policy".into(), passed:false, evidence:"A required boundary did not pass".into() });
    for (id, proof) in [("stale-verifier", stale_verifier), ("stale-policy", stale_policy), ("failed-check", failed_check)] {
        let request = envelope(id, "owner", 1, Some(1), json!({"method":"work.accept","acceptance":proof}));
        assert_error(&send(&conn, &request, "owner"), "conflict");
    }
    let unchanged = ghost::host::lifetime::snapshot(&conn).unwrap();
    assert_eq!(unchanged.work[0].state, "completed");
    assert!(unchanged.acceptances.is_empty());
    let current = envelope("current-verifier", "owner", 1, Some(1), json!({"method":"work.accept","acceptance":valid}));
    assert_success(&send(&conn, &current, "owner"));
}

#[test]
fn revision_change_cancels_each_current_execution_and_replays_without_fanout() {
    let (_root, conn) = database();
    let admitted = submit_goal(&conn, "fanout-goal");
    assert_success(&admitted);
    let before = snapshot(&conn).unwrap();
    let goal = &before.goals[0];
    let mut child = before.work[0].clone();
    child.id = uuid::Uuid::now_v7().to_string();
    conn.execute(
        "INSERT INTO lifetime_work(id,goal_id,goal_revision,owner,owner_revision,state,execution_id,cancellation,payload) VALUES(?1,?2,?3,?4,?5,?6,NULL,?7,?8)",
        rusqlite::params![child.id,child.goal_id,child.goal_revision,child.owner,child.owner_revision,child.state,child.cancellation,serde_json::to_string(&child).unwrap()],
    ).unwrap();
    for (id, execution, work) in [("fanout-worker-a","execution-a",&before.work[0]),("fanout-worker-b","execution-b",&child)] {
        let request = envelope(id,"owner",1,Some(1),json!({
            "method":"work.submit","work_id":work.id,"spec":worker_spec(&work.id,execution,1),
        }));
        assert_success(&send(&conn,&request,"owner"));
    }
    let changed = envelope("fanout-direction","owner",1,Some(1),json!({
        "method":"goal.update","goal_id":goal.id,"prompt":"Changed requirement for both current executions",
        "acceptance_spec":goal.acceptance_spec,
    }));
    let receipt = send(&conn,&changed,"owner");
    assert_success(&receipt);
    let cancellation_intents = |conn: &Connection| {
        pending_outbox(conn).unwrap().into_iter()
            .filter(|item| item.target=="worker" && item.payload["body"]["method"]=="cancel")
            .map(|item| (item.id,item.payload["body"]["execution_id"].as_str().unwrap().to_owned()))
            .collect::<Vec<_>>()
    };
    let cancellations = cancellation_intents(&conn);
    let executions = cancellations.iter().map(|(_,id)|id.as_str()).collect::<std::collections::BTreeSet<_>>();
    assert_eq!(executions,std::collections::BTreeSet::from(["execution-a","execution-b"]));
    assert_eq!(serde_json::to_value(send(&conn,&changed,"owner")).unwrap(),serde_json::to_value(receipt).unwrap());
    assert_eq!(cancellation_intents(&conn),cancellations);
}

#[test]
fn writer_epoch_fences_new_commands_and_replays_while_dispatch_off_preserves_facts() {
    let (_root, conn) = database();
    let body = json!({
        "method":"goal.submit",
        "ghost_id":"22222222-2222-7222-8222-222222222222",
        "conversation_id":"11111111-1111-7111-8111-111111111111",
        "prompt":"Epoch-bound canary admission", "privacy":"private",
        "acceptance_spec":{"required_checks":["artifact_content"]},
    });
    let original = envelope("writer-one", "owner", 1, None, body.clone());
    let committed = send(&conn, &original, "owner");
    assert_success(&committed);
    let original_goal = committed.data["goal"]["id"].as_str().unwrap();
    let intents = pending_outbox(&conn).unwrap().len();
    conn.execute("UPDATE lifetime_authority SET authority_epoch=2 WHERE singleton=1", []).unwrap();
    for request in [
        original,
        envelope("stale-fresh-id", "owner", 1, None, body.clone()),
        envelope("unissued-future-epoch", "owner", 3, None, body.clone()),
    ] {
        assert_error(&send(&conn, &request, "owner"), "authority_fenced");
    }
    assert_eq!(snapshot(&conn).unwrap().goals.len(), 1);
    assert_eq!(pending_outbox(&conn).unwrap().len(), intents);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM lifetime_commands", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    let current = envelope("writer-two", "owner", 2, None, body.clone());
    let accepted = send(&conn, &current, "owner");
    assert_success(&accepted);
    assert_ne!(accepted.data["goal"]["id"], original_goal);
    conn.execute("UPDATE lifetime_authority SET dispatch_enabled=0 WHERE singleton=1", []).unwrap();
    let before = snapshot(&conn).unwrap();
    let intents = pending_outbox(&conn).unwrap().len();
    let disabled = envelope("disabled-fresh-intent", "owner", 2, None, body);
    assert_error(&send(&conn, &disabled, "owner"), "dispatch_off");
    assert_eq!(snapshot(&conn).unwrap(), before);
    assert_eq!(pending_outbox(&conn).unwrap().len(), intents);
    let inspect = envelope("readonly-inspect", "owner", 2, None,
        json!({"method":"goal.inspect","goal_id":original_goal}));
    assert_success(&send(&conn, &inspect, "owner"));
}

#[test]
fn required_checks_are_validated_at_goal_admission_and_revision() {
    let (_root, connection) = database();

    // Malformed Goal creation must leave no goal, work, binding, or delivery.
    for (command_id, spec) in [
        ("admission-not-array", json!({ "required_checks": "artifact_content" })),
        ("admission-nonstring", json!({ "required_checks": [42] })),
        ("admission-blank", json!({ "required_checks": ["artifact_content", "   "] })),
        ("admission-duplicate", json!({ "required_checks": ["artifact_content", "artifact_content"] })),
    ] {
        let request = envelope(
            command_id,
            "owner",
            1,
            None,
            json!({
                "method": "goal.submit",
                "ghost_id": "22222222-2222-7222-8222-222222222222",
                "conversation_id": "11111111-1111-7111-8111-111111111111",
                "prompt": "Create a canary artifact",
                "privacy": "public",
                "acceptance_spec": spec,
            }),
        );
        assert_error(&send(&connection, &request, "owner"), "invalid_request");
        let state = snapshot(&connection).unwrap();
        assert!(state.goals.is_empty(), "{command_id} created a goal");
        assert!(state.work.is_empty(), "{command_id} created work");
        assert!(state.bindings.is_empty(), "{command_id} created a binding");
        assert!(pending_outbox(&connection).unwrap().is_empty());
    }

    // A valid spec with ordered additional acceptance criteria is preserved
    // verbatim, and both required checks gate acceptance.
    let spec = json!({
        "required_checks": ["artifact_content", "independent_witness"],
        "criteria": ["canary bytes match", "witness receipt exists"],
    });
    let submitted = envelope(
        "admission-with-criteria",
        "owner",
        1,
        None,
        json!({
            "method": "goal.submit",
            "ghost_id": "22222222-2222-7222-8222-222222222222",
            "conversation_id": "11111111-1111-7111-8111-111111111111",
            "prompt": "Create a canary artifact",
            "privacy": "public",
            "acceptance_spec": spec,
        }),
    );
    assert_success(&send(&connection, &submitted, "owner"));
    let state = snapshot(&connection).unwrap();
    assert_eq!(state.goals[0].acceptance_spec, spec);

    let work_id = state.work[0].id.clone();
    let requirement_digest = state.goals[0].requirement_digest.clone();
    let (_, execution_spec) = submit_worker(&connection, &work_id, "execution-criteria");
    let output = artifact(&execution_spec.execution_id);
    assert_success(&send(
        &connection,
        &worker_result(
            "criteria-result",
            &execution_spec.execution_id,
            "criteria-worker",
            1,
            1,
            "completed",
            vec![output.clone()],
            "completed attempt ready for independent verification",
        ),
        "criteria-worker",
    ));

    let mut partial = acceptance(&work_id, 1, &requirement_digest, &output.digest);
    partial.checks.push(ghost::lifetime_contract::Check {
        id: "independent_witness".to_owned(),
        passed: false,
        evidence: "no witness receipt yet".to_owned(),
    });
    let partial_request = envelope(
        "accept-partial-criteria",
        "owner",
        1,
        Some(1),
        json!({ "method": "work.accept", "acceptance": partial }),
    );
    assert_error(&send(&connection, &partial_request, "owner"), "conflict");
    assert!(snapshot(&connection).unwrap().acceptances.is_empty());

    let mut complete = acceptance(&work_id, 1, &requirement_digest, &output.digest);
    complete.checks.push(ghost::lifetime_contract::Check {
        id: "independent_witness".to_owned(),
        passed: true,
        evidence: "witness receipt verified".to_owned(),
    });
    let complete_request = envelope(
        "accept-complete-criteria",
        "owner",
        1,
        Some(1),
        json!({ "method": "work.accept", "acceptance": complete }),
    );
    assert_success(&send(&connection, &complete_request, "owner"));
    assert_eq!(snapshot(&connection).unwrap().acceptances.len(), 1);

    // A malformed revision leaves the existing revision, requirement digest,
    // and work untouched.
    let before = snapshot(&connection).unwrap();
    let outbox_before = pending_outbox(&connection).unwrap().into_iter()
        .map(|item| item.id).collect::<Vec<_>>();
    let bad_update = envelope(
        "revision-duplicate-check",
        "owner",
        1,
        Some(before.goals[0].revision),
        json!({
            "method": "goal.update",
            "goal_id": before.goals[0].id,
            "prompt": "Create a canary artifact with the revised requirement",
            "acceptance_spec": { "required_checks": ["revised_check", "revised_check"] },
        }),
    );
    assert_error(&send(&connection, &bad_update, "owner"), "invalid_request");
    let after = snapshot(&connection).unwrap();
    assert_eq!(after.goals, before.goals);
    assert_eq!(after.work, before.work);
    assert_eq!(after.acceptances, before.acceptances);
    assert_eq!(pending_outbox(&connection).unwrap().into_iter()
        .map(|item| item.id).collect::<Vec<_>>(), outbox_before);
}
