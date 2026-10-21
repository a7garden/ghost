#![cfg(feature = "lifetime")]

use ghost::{
    host::lifetime::apply,
    lifetime_contract::{canonical_digest, Envelope, Response, ResponseStatus, VERSION},
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use tempfile::TempDir;

const OWNER: &str = "owner";
const ROOT_GHOST: &str = "22222222-2222-7222-8222-222222222222";
const ROOT_CONVERSATION: &str = "11111111-1111-7111-8111-111111111111";
const TARGET_GHOST: &str = "33333333-3333-7333-8333-333333333333";
const TARGET_CONVERSATION: &str = "33333333-3333-7333-8333-444444444444";

fn database() -> (TempDir, Connection) {
    let root = tempfile::tempdir().unwrap();
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

fn send(connection: &Connection, request: &Envelope, principal: &str) -> Response {
    apply(connection, request, principal).unwrap()
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
    connection: &Connection,
    command_id: &str,
    ghost_id: &str,
    kind: &str,
    conversation_id: &str,
) {
    let request = envelope(
        command_id,
        OWNER,
        None,
        json!({
            "method": "registry.ensure",
            "ghost_id": ghost_id,
            "kind": kind,
            "conversation_id": conversation_id,
            "roles": []
        }),
    );
    assert_success(&send(connection, &request, OWNER));
}

fn owner_input(
    connection: &Connection,
    command_id: &str,
    ghost_id: &str,
    conversation_id: &str,
    privacy: &str,
) -> Response {
    let request = envelope(
        command_id,
        OWNER,
        None,
        json!({
            "method": "conversation.input",
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
            "text": "An Owner turn establishes the canonical source context.",
            "privacy": privacy,
            "attachments": [],
        }),
    );
    send(connection, &request, OWNER)
}

struct CanonicalGoal {
    owner_turn_id: Option<String>,
    goal_command_id: String,
    goal_id: String,
    revision: u64,
}

fn create_canonical_goal(
    connection: &Connection,
    owner_command_id: &str,
    goal_command_id: &str,
    ghost_id: &str,
    conversation_id: &str,
    privacy: &str,
) -> CanonicalGoal {
    let turn = owner_input(
        connection,
        owner_command_id,
        ghost_id,
        conversation_id,
        privacy,
    );
    assert_success(&turn);
    let owner_turn_id = turn.data["turn_id"].as_str().unwrap().to_owned();
    let request = envelope(
        goal_command_id,
        ghost_id,
        None,
        json!({
            "method": "goal.create",
            "turn_id": owner_turn_id,
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
            "prompt": "Derive a bounded work item from this Owner request.",
            "acceptance_spec": { "required_checks": ["artifact_content"] },
        }),
    );
    let response = send(connection, &request, ghost_id);
    assert_success(&response);
    CanonicalGoal {
        owner_turn_id: Some(owner_turn_id),
        goal_command_id: goal_command_id.to_owned(),
        goal_id: response.data["goal"]["id"].as_str().unwrap().to_owned(),
        revision: response.data["goal"]["revision"].as_u64().unwrap(),
    }
}

fn report_receiver(
    report_id: &str,
    goal: &CanonicalGoal,
    ghost_id: &str,
    conversation_id: &str,
    privacy: &str,
) -> Envelope {
    envelope(
        report_id,
        ghost_id,
        Some(goal.revision),
        json!({
            "method": "conversation.submit",
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
            "prompt": "The original canonical Pi work request.",
            "privacy": privacy,
            "goal_id": goal.goal_id,
            "goal_revision": goal.revision,
        }),
    )
}

fn insert_report_outbox(
    connection: &Connection,
    source_command_id: &str,
    target: &str,
    receiver: &Envelope,
) {
    connection
        .execute(
            "INSERT INTO lifetime_outbox(command_id,target,delivery_ref,payload)
             VALUES(?1,?2,?3,?4)",
            params![
                source_command_id,
                target,
                receiver.command_id,
                serde_json::to_string(receiver).unwrap(),
            ],
        )
        .unwrap();
}

fn report_inspect(
    connection: &Connection,
    command_id: &str,
    actor: &str,
    principal: &str,
    report_id: &str,
    ghost_id: &str,
    conversation_id: &str,
) -> Response {
    let request = envelope(
        command_id,
        actor,
        None,
        json!({
            "method": "conversation.report.inspect",
            "report_id": report_id,
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
        }),
    );
    send(connection, &request, principal)
}

fn report_reply(
    connection: &Connection,
    command_id: &str,
    report_id: &str,
    ghost_id: &str,
    conversation_id: &str,
    text: &str,
) -> Response {
    let request = envelope(
        command_id,
        ghost_id,
        None,
        json!({
            "method": "conversation.report.reply",
            "report_id": report_id,
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
            "text": text,
        }),
    );
    send(connection, &request, ghost_id)
}

fn conversation_inspect(
    connection: &Connection,
    command_id: &str,
    ghost_id: &str,
    conversation_id: &str,
) -> Response {
    let request = envelope(
        command_id,
        OWNER,
        None,
        json!({
            "method": "conversation.inspect",
            "ghost_id": ghost_id,
            "conversation_id": conversation_id,
        }),
    );
    send(connection, &request, OWNER)
}

fn goal_inspect(connection: &Connection, command_id: &str, goal_id: &str) -> Response {
    let request = envelope(
        command_id,
        OWNER,
        None,
        json!({ "method": "goal.inspect", "goal_id": goal_id }),
    );
    send(connection, &request, OWNER)
}

fn submit_direct_owner_goal(connection: &Connection, command_id: &str) -> (String, String) {
    let request = envelope(
        command_id,
        OWNER,
        None,
        json!({
            "method": "goal.submit",
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "prompt": "Report the outcome of this authenticated direct Owner Goal.",
            "privacy": "public",
            "acceptance_spec": { "required_checks": ["artifact_content"] },
        }),
    );
    let response = send(connection, &request, OWNER);
    assert_success(&response);
    let goal_id = response.data["goal"]["id"].as_str().unwrap().to_owned();
    let report_id = connection
        .query_row(
            "SELECT delivery_ref FROM lifetime_outbox WHERE command_id=?1 AND target='pi'",
            [command_id],
            |row| row.get(0),
        )
        .unwrap();
    (goal_id, report_id)
}

#[test]
fn report_reply_is_once_private_and_preserves_owner_state() {
    let (_root, connection) = database();
    let goal = create_canonical_goal(
        &connection,
        "owner-turn-report",
        "goal-create-report",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "private",
    );
    let report_id = "55555555-5555-7555-8555-555555555555";
    let receiver = report_receiver(
        report_id,
        &goal,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "public",
    );
    insert_report_outbox(&connection, &goal.goal_command_id, "pi", &receiver);

    let turns_before = conversation_inspect(
        &connection,
        "conversation-before-report-inspect",
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_success(&turns_before);
    let goal_before = goal_inspect(&connection, "goal-before-report-reply", &goal.goal_id);
    assert_success(&goal_before);

    let inspected = report_inspect(
        &connection,
        "report-inspect-before-reply",
        ROOT_GHOST,
        ROOT_GHOST,
        report_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_success(&inspected);
    assert_eq!(inspected.data["report"]["reply"], Value::Null);
    assert_eq!(inspected.data["report"]["privacy"], "private");

    let turns_after_inspect = conversation_inspect(
        &connection,
        "conversation-after-report-inspect",
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_success(&turns_after_inspect);
    assert_eq!(turns_before.data["turns"], turns_after_inspect.data["turns"]);
    assert_eq!(
        turns_before.data["turn_runs"],
        turns_after_inspect.data["turn_runs"]
    );

    let reply = report_reply(
        &connection,
        "pi-report-reply-entry-1",
        report_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "The committed SDK report has been projected.",
    );
    assert_success(&reply);
    assert_eq!(reply.data["report_id"], report_id);
    assert_eq!(reply.data["reply_id"], "pi-report-reply-entry-1");
    assert_eq!(reply.data["replayed"], false);
    let sequence = reply.data["sequence"].as_u64().unwrap();

    let recovered = report_reply(
        &connection,
        "pi-report-retry-entry-2",
        report_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "The committed SDK report has been projected.",
    );
    assert_success(&recovered);
    assert_eq!(recovered.data["reply_id"], reply.data["reply_id"]);
    assert_eq!(recovered.data["sequence"].as_u64(), Some(sequence));
    assert_eq!(recovered.data["replayed"], true);

    let changed = report_reply(
        &connection,
        "pi-report-changed-entry-3",
        report_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "A different committed report conflicts.",
    );
    assert_error(&changed, "conflict");

    let inspected_after_reply = report_inspect(
        &connection,
        "report-inspect-after-reply",
        ROOT_GHOST,
        ROOT_GHOST,
        report_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_success(&inspected_after_reply);
    assert_eq!(
        inspected_after_reply.data["report"]["reply"]["turn_id"],
        reply.data["reply_id"]
    );
    assert_eq!(
        inspected_after_reply.data["report"]["reply"]["sequence"].as_u64(),
        Some(sequence)
    );

    let turns_after = conversation_inspect(
        &connection,
        "conversation-after-report-replay",
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_success(&turns_after);
    let turns = turns_after.data["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2);
    let owner_turns: Vec<_> = turns
        .iter()
        .filter(|turn| turn["kind"] == "user")
        .collect();
    assert_eq!(owner_turns.len(), 1);
    assert_eq!(owner_turns[0]["id"], goal.owner_turn_id.as_deref().unwrap());
    let advisory_turns: Vec<_> = turns
        .iter()
        .filter(|turn| turn["kind"] == "assistant_advisory")
        .collect();
    assert_eq!(advisory_turns.len(), 1);
    assert_eq!(advisory_turns[0]["id"], reply.data["reply_id"]);
    assert_eq!(advisory_turns[0]["sender_kind"], "ghost");
    assert_eq!(advisory_turns[0]["sender_ref"], ROOT_GHOST);
    assert_eq!(advisory_turns[0]["source_turn_id"], Value::Null);
    assert_eq!(advisory_turns[0]["origin_report_id"], report_id);
    assert_eq!(advisory_turns[0]["privacy"], "private");
    assert_eq!(turns_before.data["turn_runs"], turns_after.data["turn_runs"]);

    let goal_after = goal_inspect(&connection, "goal-after-report-reply", &goal.goal_id);
    assert_success(&goal_after);
    assert_eq!(goal_before.data, goal_after.data);
}

#[test]
fn report_inspection_rejects_untrusted_sources_without_mutating_either_pair() {
    let (_root, connection) = database();
    let root_goal = create_canonical_goal(
        &connection,
        "owner-turn-root-report-scope",
        "goal-create-root-report-scope",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "public",
    );
    let target_goal = create_canonical_goal(
        &connection,
        "owner-turn-target-report-scope",
        "goal-create-target-report-scope",
        TARGET_GHOST,
        TARGET_CONVERSATION,
        "public",
    );
    let foreign_receiver = report_receiver(
        "66666666-6666-7666-8666-666666666666",
        &target_goal,
        TARGET_GHOST,
        TARGET_CONVERSATION,
        "public",
    );
    insert_report_outbox(
        &connection,
        &target_goal.goal_command_id,
        "pi",
        &foreign_receiver,
    );

    let (unlinked_goal_id, unlinked_report_id) =
        submit_direct_owner_goal(&connection, "goal-submit-unlinked-report");
    let ambiguous_id = "77777777-7777-7777-8777-777777777777";
    let ambiguous_receiver = report_receiver(
        ambiguous_id,
        &root_goal,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "public",
    );
    insert_report_outbox(&connection, &root_goal.goal_command_id, "pi", &ambiguous_receiver);
    insert_report_outbox(&connection, root_goal.owner_turn_id.as_deref().unwrap(), "pi", &ambiguous_receiver);

    let wrong_target_id = "88888888-8888-7888-8888-888888888888";
    let wrong_target_receiver = report_receiver(
        wrong_target_id,
        &root_goal,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "public",
    );
    insert_report_outbox(
        &connection,
        &root_goal.goal_command_id,
        "worker",
        &wrong_target_receiver,
    );

    let root_turns_before = conversation_inspect(
        &connection,
        "root-before-invalid-reports",
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    let target_turns_before = conversation_inspect(
        &connection,
        "target-before-invalid-reports",
        TARGET_GHOST,
        TARGET_CONVERSATION,
    );
    let root_goal_before = goal_inspect(&connection, "root-goal-before-invalid-reports", &root_goal.goal_id);
    let target_goal_before =
        goal_inspect(&connection, "target-goal-before-invalid-reports", &target_goal.goal_id);
    let unlinked_goal_before = goal_inspect(
        &connection,
        "unlinked-goal-before-invalid-reports",
        &unlinked_goal_id,
    );
    assert_success(&root_turns_before);
    assert_success(&target_turns_before);
    assert_success(&root_goal_before);
    assert_success(&target_goal_before);
    assert_success(&unlinked_goal_before);

    let missing = report_inspect(
        &connection,
        "inspect-forged-report-id",
        ROOT_GHOST,
        ROOT_GHOST,
        "99999999-9999-7999-8999-999999999999",
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_error(&missing, "not_found");
    let forged_reply = report_reply(
        &connection,
        "reply-forged-report-id",
        "99999999-9999-7999-8999-999999999999",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "A forged report cannot create a conversation turn.",
    );
    assert_error(&forged_reply, "not_found");

    let wrong_principal = report_inspect(
        &connection,
        "inspect-wrong-report-principal",
        TARGET_GHOST,
        TARGET_GHOST,
        unlinked_report_id.as_str(),
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_error(&wrong_principal, "unauthorized");
    let wrong_principal_reply_request = envelope(
        "reply-wrong-report-principal",
        TARGET_GHOST,
        None,
        json!({
            "method": "conversation.report.reply",
            "report_id": unlinked_report_id,
            "ghost_id": ROOT_GHOST,
            "conversation_id": ROOT_CONVERSATION,
            "text": "A foreign principal cannot create a conversation turn.",
        }),
    );
    let wrong_principal_reply = send(
        &connection,
        &wrong_principal_reply_request,
        TARGET_GHOST,
    );
    assert_error(&wrong_principal_reply, "unauthorized");

    let foreign = report_inspect(
        &connection,
        "inspect-foreign-report-source",
        ROOT_GHOST,
        ROOT_GHOST,
        foreign_receiver.command_id.as_str(),
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_error(&foreign, "not_found");
    let foreign_reply = report_reply(
        &connection,
        "reply-foreign-report-source",
        foreign_receiver.command_id.as_str(),
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "A foreign report cannot create a conversation turn.",
    );
    assert_error(&foreign_reply, "not_found");

    let unlinked = report_inspect(
        &connection,
        "inspect-unlinked-report-source",
        ROOT_GHOST,
        ROOT_GHOST,
        &unlinked_report_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_eq!(unlinked.status, ResponseStatus::Error, "{unlinked:?}");
    let unlinked_reply = report_reply(
        &connection,
        "reply-unlinked-report-source",
        &unlinked_report_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "A Goal assignment is not a Work report and cannot create its reply.",
    );
    assert_eq!(unlinked_reply.status, ResponseStatus::Error, "{unlinked_reply:?}");

    let ambiguous = report_inspect(
        &connection,
        "inspect-ambiguous-report-source",
        ROOT_GHOST,
        ROOT_GHOST,
        ambiguous_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_error(&ambiguous, "conflict");
    let ambiguous_reply = report_reply(
        &connection,
        "reply-ambiguous-report-source",
        ambiguous_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "An ambiguous delivery reference cannot create a conversation turn.",
    );
    assert_error(&ambiguous_reply, "conflict");

    let wrong_target = report_inspect(
        &connection,
        "inspect-non-pi-report-source",
        ROOT_GHOST,
        ROOT_GHOST,
        wrong_target_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_error(&wrong_target, "not_found");
    let wrong_target_reply = report_reply(
        &connection,
        "reply-non-pi-report-source",
        wrong_target_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "A non-Pi delivery cannot create a conversation turn.",
    );
    assert_error(&wrong_target_reply, "not_found");

    let root_turns_after = conversation_inspect(
        &connection,
        "root-after-invalid-reports",
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    let target_turns_after = conversation_inspect(
        &connection,
        "target-after-invalid-reports",
        TARGET_GHOST,
        TARGET_CONVERSATION,
    );
    let root_goal_after = goal_inspect(&connection, "root-goal-after-invalid-reports", &root_goal.goal_id);
    let target_goal_after =
        goal_inspect(&connection, "target-goal-after-invalid-reports", &target_goal.goal_id);
    let unlinked_goal_after = goal_inspect(
        &connection,
        "unlinked-goal-after-invalid-reports",
        &unlinked_goal_id,
    );
    assert_eq!(root_turns_before.data["turns"], root_turns_after.data["turns"]);
    assert_eq!(
        root_turns_before.data["turn_runs"],
        root_turns_after.data["turn_runs"]
    );
    assert_eq!(
        target_turns_before.data["turns"],
        target_turns_after.data["turns"]
    );
    assert_eq!(
        target_turns_before.data["turn_runs"],
        target_turns_after.data["turn_runs"]
    );
    assert_eq!(root_goal_before.data, root_goal_after.data);
    assert_eq!(target_goal_before.data, target_goal_after.data);
    assert_eq!(unlinked_goal_before.data, unlinked_goal_after.data);
}

#[test]
fn stale_report_revision_cannot_be_inspected_or_replied_to() {
    let (_root, connection) = database();
    let goal = create_canonical_goal(
        &connection,
        "owner-turn-stale-report",
        "goal-create-stale-report",
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "public",
    );
    let report_id = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
    let receiver = report_receiver(
        report_id,
        &goal,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "public",
    );
    insert_report_outbox(&connection, &goal.goal_command_id, "pi", &receiver);

    let update = envelope(
        "goal-update-before-stale-report",
        OWNER,
        Some(goal.revision),
        json!({
            "method": "goal.update",
            "goal_id": goal.goal_id,
            "prompt": "A newer Goal revision makes the report stale.",
            "acceptance_spec": { "required_checks": ["artifact_content"] },
        }),
    );
    assert_success(&send(&connection, &update, OWNER));

    let turns_before = conversation_inspect(
        &connection,
        "conversation-before-stale-report-check",
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    let goal_before = goal_inspect(&connection, "goal-before-stale-report-check", &goal.goal_id);
    assert_success(&turns_before);
    assert_success(&goal_before);

    let inspected = report_inspect(
        &connection,
        "inspect-stale-report",
        ROOT_GHOST,
        ROOT_GHOST,
        report_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    assert_error(&inspected, "conflict");
    let replied = report_reply(
        &connection,
        "reply-stale-report",
        report_id,
        ROOT_GHOST,
        ROOT_CONVERSATION,
        "A stale source must not become a conversation turn.",
    );
    assert_error(&replied, "conflict");

    let turns_after = conversation_inspect(
        &connection,
        "conversation-after-stale-report-check",
        ROOT_GHOST,
        ROOT_CONVERSATION,
    );
    let goal_after = goal_inspect(&connection, "goal-after-stale-report-check", &goal.goal_id);
    assert_eq!(turns_before.data["turns"], turns_after.data["turns"]);
    assert_eq!(turns_before.data["turn_runs"], turns_after.data["turn_runs"]);
    assert_eq!(goal_before.data, goal_after.data);
    assert_eq!(
        turns_after.data["turns"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|turn| turn["kind"] == "assistant_advisory")
            .count(),
        0
    );
}

#[test]
fn direct_owner_goal_report_survives_revision_and_acceptance_without_inventing_owner_turns() {
    let (_root, connection) = database();
    let (goal_id, _) = submit_direct_owner_goal(&connection, "direct-admission");
    let initial = goal_inspect(&connection, "inspect-direct-initial", &goal_id);
    assert_success(&initial);
    let update = envelope(
        "revise-direct-goal", OWNER,
        initial.data["goal"]["revision"].as_u64(),
        json!({
            "method": "goal.update", "goal_id": goal_id,
            "prompt": "Report the revised accepted result.",
            "acceptance_spec": {"required_checks": ["artifact_content"]},
        }),
    );
    let revised = send(&connection, &update, OWNER);
    assert_success(&revised);
    let goal = CanonicalGoal {
        owner_turn_id: None, goal_command_id: update.command_id.clone(), goal_id,
        revision: revised.data["goal"]["revision"].as_u64().unwrap(),
    };
    // Exercise the durable post-verification phase, not assignment eligibility.
    connection.execute(
        "UPDATE lifetime_goals SET state='accepted',payload=json_set(payload,'$.state','accepted') WHERE id=?1",
        [&goal.goal_id],
    ).unwrap();
    connection.execute(
        "UPDATE lifetime_work SET state='accepted',payload=json_set(payload,'$.state','accepted')
         WHERE goal_id=?1 AND goal_revision=?2",
        params![goal.goal_id, goal.revision],
    ).unwrap();
    let before = goal_inspect(&connection, "direct-before-report", &goal.goal_id);
    let report_id = "direct-accepted-report";
    let receiver = report_receiver(report_id, &goal, ROOT_GHOST, ROOT_CONVERSATION, "public");
    insert_report_outbox(&connection, &update.command_id, "pi", &receiver);
    let inspected = report_inspect(
        &connection, "inspect-direct-report", ROOT_GHOST, ROOT_GHOST,
        report_id, ROOT_GHOST, ROOT_CONVERSATION,
    );
    assert_success(&inspected);
    let reply = report_reply(
        &connection, "reply-direct-report", report_id, ROOT_GHOST, ROOT_CONVERSATION,
        "The revised result is accepted.",
    );
    assert_success(&reply);
    let replay = report_reply(
        &connection, "recover-direct-report", report_id, ROOT_GHOST, ROOT_CONVERSATION,
        "The revised result is accepted.",
    );
    assert_success(&replay);
    assert_eq!(replay.data["replayed"], true);
    assert_eq!(replay.data["reply_id"], reply.data["reply_id"]);
    let page = conversation_inspect(&connection, "direct-reply-history", ROOT_GHOST, ROOT_CONVERSATION);
    assert_success(&page);
    let turns = page.data["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["kind"], "assistant_advisory");
    assert_eq!(turns[0]["text"], "The revised result is accepted.");
    assert_eq!(turns[0]["origin_report_id"], report_id);
    let after = goal_inspect(&connection, "direct-after-report", &goal.goal_id);
    assert_eq!(before.data, after.data);
}

#[test]
fn direct_goal_report_requires_immutable_authenticated_owner_admission() {
    let (_root, connection) = database();
    let (goal_id, _) = submit_direct_owner_goal(&connection, "direct-owner-source");
    let current = goal_inspect(&connection, "direct-source-state", &goal_id);
    let goal = CanonicalGoal {
        owner_turn_id: None, goal_command_id: "direct-owner-source".to_owned(), goal_id,
        revision: current.data["goal"]["revision"].as_u64().unwrap(),
    };
    let report_id = "direct-tampered-origin-report";
    let receiver = report_receiver(report_id, &goal, ROOT_GHOST, ROOT_CONVERSATION, "public");
    insert_report_outbox(&connection, &goal.goal_command_id, "pi", &receiver);
    connection.execute(
        "UPDATE lifetime_commands SET actor_ref=?1,request=json_set(request,'$.actor_ref',?1) WHERE command_id=?2",
        params![TARGET_GHOST, goal.goal_command_id],
    ).unwrap();
    let inspected = report_inspect(
        &connection, "inspect-forged-owner-origin", ROOT_GHOST, ROOT_GHOST,
        report_id, ROOT_GHOST, ROOT_CONVERSATION,
    );
    assert_error(&inspected, "not_found");
    let replied = report_reply(
        &connection, "reply-forged-owner-origin", report_id, ROOT_GHOST, ROOT_CONVERSATION,
        "This unproven source must not be published.",
    );
    assert_error(&replied, "not_found");
    let page = conversation_inspect(&connection, "forged-origin-history", ROOT_GHOST, ROOT_CONVERSATION);
    assert_success(&page);
    assert_eq!(page.data["turns"], json!([]));
}

#[test]
fn delegated_goal_report_keeps_ancestor_privacy_after_terminal_phases() {
    let (_root, connection) = database();
    let (parent_id, _) = submit_direct_owner_goal(&connection, "delegation-parent");
    let parent = goal_inspect(&connection, "inspect-delegation-parent", &parent_id);
    let parent_work_id = parent.data["work"][0]["id"].as_str().unwrap();
    let delegation = envelope(
        "delegate-report-work", ROOT_GHOST, parent.data["goal"]["revision"].as_u64(),
        json!({
            "method": "work.delegate", "parent_work_id": parent_work_id,
            "target_ghost_id": TARGET_GHOST, "summary": "Return the delegated result.",
            "artifact_refs": [], "acceptance_spec": {"required_checks": ["artifact_content"]},
        }),
    );
    let child = send(&connection, &delegation, ROOT_GHOST);
    assert_success(&child);
    assert_success(&owner_input(
        &connection, "raise-ancestor-disclosure", ROOT_GHOST, ROOT_CONVERSATION, "local_only",
    ));
    let goal = CanonicalGoal {
        owner_turn_id: None, goal_command_id: delegation.command_id.clone(),
        goal_id: child.data["goal"]["id"].as_str().unwrap().to_owned(),
        revision: child.data["goal"]["revision"].as_u64().unwrap(),
    };
    connection.execute(
        "UPDATE lifetime_goals SET state='accepted',payload=json_set(payload,'$.state','accepted') WHERE id IN (?1,?2)",
        params![parent_id, goal.goal_id],
    ).unwrap();
    connection.execute(
        "UPDATE lifetime_work SET state='accepted',payload=json_set(payload,'$.state','accepted') WHERE goal_id IN (?1,?2)",
        params![parent_id, goal.goal_id],
    ).unwrap();
    let report_id = "delegated-terminal-report";
    let receiver = report_receiver(report_id, &goal, TARGET_GHOST, TARGET_CONVERSATION, "public");
    insert_report_outbox(&connection, &delegation.command_id, "pi", &receiver);
    let inspected = report_inspect(
        &connection, "inspect-delegated-report", TARGET_GHOST, TARGET_GHOST,
        report_id, TARGET_GHOST, TARGET_CONVERSATION,
    );
    assert_success(&inspected);
    assert_eq!(inspected.data["report"]["privacy"], "local_only");
    assert_success(&report_reply(
        &connection, "reply-delegated-report", report_id, TARGET_GHOST, TARGET_CONVERSATION,
        "The child result remains local-only.",
    ));
    let page = conversation_inspect(&connection, "delegated-reply-history", TARGET_GHOST, TARGET_CONVERSATION);
    assert_success(&page);
    assert_eq!(page.data["turns"][0]["privacy"], "local_only");
    assert_eq!(page.data["turns"][0]["text"], "The child result remains local-only.");
}
