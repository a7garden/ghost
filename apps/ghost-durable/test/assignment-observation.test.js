import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignmentGoalObservation } from "../src/bot-evaluation-observation.js";
import { openGhostRuntime } from "../src/runtime.js";
import { createBrokerModelProvider } from "../src/models.js";
import { callbackCommandId } from "../src/host-transport.js";
import { payloadDigest } from "../src/contract.js";

const ghost = "assignment-observation-ghost", conversation = "assignment-observation-conversation";
const requirements = "EXACT_FRESH_PRODUCER_REQUIREMENTS_SENTINEL: preserve every byte of these instructions.";
const assignment = { id: "assigned-original", source_command_id: "source-original", ghost_id: ghost, conversation_id: conversation,
  goal_id: "goal-original", goal_revision: 3, work_id: "work-original", prompt: requirements, privacy: "public",
  origin_kind: "bot_evaluation", parent_work_id: null, root_goal_id: "goal-original" };
const scope = { originKind: "goal_assignment", assignmentId: assignment.id, goalId: assignment.goal_id,
  goalRevision: assignment.goal_revision, workId: assignment.work_id };
const goalReceipt = { status: "success", summary: "Current Goal", artifacts: [], next_actions: [], object_refs: ["goal:goal-original"],
  retry_class: "same_id", error_code: null, data: { goal: { id: assignment.goal_id, revision: 3, prompt: requirements,
    accountable_ghost: ghost, reply_conversation: conversation, state: "active", requirement_digest: "b".repeat(64),
    acceptance_spec: { required_checks: ["independent-verifier"], preserved: true } }, other_evidence: { retained: true } } };
const context = { scope, assignment, args: { goal_id: assignment.goal_id }, ghostId: ghost, conversationId: conversation };

test("Goal prompt projection requires exact current assignment and receipt identity; all ambiguous receipts remain unchanged", () => {
  const bytes = JSON.stringify(goalReceipt);
  const projected = assignmentGoalObservation(goalReceipt, context);
  assert.equal(projected.data.goal.prompt, undefined);
  const { prompt, ...rest } = goalReceipt.data.goal;
  assert.deepEqual(projected.data.goal, rest);
  assert.deepEqual(projected.data.other_evidence, goalReceipt.data.other_evidence);
  assert.deepEqual(projected.data.supplied_requirements, { kind: "ghost.assignment-requirements/1", source: "current_assignment.requirements",
    assignment_id: assignment.id, goal_id: assignment.goal_id, goal_revision: 3, work_id: assignment.work_id,
    sha256: createHash("sha256").update(requirements, "utf8").digest("hex") });
  for (const changed of [
    { scope: { ...scope, originKind: "owner" } }, { scope: { ...scope, assignmentId: "old" } },
    { scope: { ...scope, workId: "foreign" } }, { scope: { ...scope, goalId: "foreign" } },
    { scope: { ...scope, goalRevision: 2 } }, { args: { goal_id: "foreign" } },
    { assignment: { ...assignment, ghost_id: "foreign" } }, { assignment: { ...assignment, conversation_id: "foreign" } },
    { assignment: { ...assignment, prompt: `${requirements} changed` } },
  ]) assert.equal(assignmentGoalObservation(goalReceipt, { ...context, ...changed }), goalReceipt);
  for (const changed of [{ id: "foreign" }, { revision: 2 }, { prompt: `${requirements} changed` },
    { accountable_ghost: "parent-accountable-ghost" }, { reply_conversation: "foreign" }]) {
    const response = { ...goalReceipt, data: { ...goalReceipt.data, goal: { ...goalReceipt.data.goal, ...changed } } };
    assert.equal(assignmentGoalObservation(response, context), response);
  }
  for (const status of ["warning", "error", "unknown"]) {
    const response = { ...goalReceipt, status }; assert.equal(assignmentGoalObservation(response, context), response);
  }
  assert.equal(JSON.stringify(goalReceipt), bytes);
});

test("actual assignment provider sees requirements once and full Work metadata, while original Goal and Work receipt bytes remain durable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-assignment-observation-")), requests = [], callbacks = [], runs = new Map();
  const workReceipt = { status: "success", summary: "Current Work", artifacts: [], next_actions: [], data: {
    work: { id: assignment.work_id, goal_id: assignment.goal_id, goal_revision: 3, owner: ghost, owner_revision: 1,
      state: "queued", execution_id: null, cancellation: "none", blocker: null },
    acceptance: { accepted: false, checks: ["WORK_METADATA_SENTINEL"] }, independent_verification: { status: "pending" },
    execution: { environment: { backend: "fixture", configured: true } }, task_input: { path: "inputs/original.json", digest: "c".repeat(64) },
    delegation_contracts: [{ contract_ref: "dc-original" }], command_recipes: [{ method: "work.inspect" }], input_artifacts: [] } };
  const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => {
    requests.push(request); const tool = ["goal_inspect", "work_inspect"][requests.length - 1];
    const message = tool ? { role: "assistant", content: null, tool_calls: [{ id: `inspect-${tool}`, type: "function", function: {
      name: tool, arguments: JSON.stringify(tool === "goal_inspect" ? { goal_id: assignment.goal_id } : { work_id: assignment.work_id }) } }] }
      : { role: "assistant", content: "Inspected original Goal and Work; artifact acceptance remains pending." };
    return { id: request.id, status: 200, body: { id: `completion-${requests.length}`, object: "chat.completion", created: 1,
      model: "minimax-code/MiniMax-M2.7", choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }] } };
  } });
  const host = async input => {
    callbacks.push(input);
    if (input.method === "inference.inspect") return { status: "success", data: { inference_scope: "public", authority_epoch: 1 } };
    if (input.method === "conversation.assignment.inspect") return { status: "success", data: { assignment, skills: [], execution: { engine: "pi", version: 1, tools: ["read"] } } };
    if (input.method === "goal.inspect") return goalReceipt;
    if (input.method === "work.inspect") return workReceipt;
    if (input.method === "conversation.turn.inspect") return { status: "success", data: { run: runs.get(input.turn_id) ?? {
      turn_id: input.turn_id, ghost_id: ghost, conversation_id: conversation, state: "queued", cancel_requested: false,
      cancel_command_id: null, submission_id: null, entry_id: null, reason_code: null, latest_status_command_id: null,
      created_at_ms: 1, updated_at_ms: 1 } } };
    if (input.method === "conversation.turn_status") {
      const run = { turn_id: input.turn_id, ghost_id: ghost, conversation_id: conversation, state: input.arguments.status,
        cancel_requested: false, cancel_command_id: null, submission_id: input.arguments.submission_id, entry_id: input.arguments.entry_id,
        reason_code: input.arguments.reason_code, latest_status_command_id: callbackCommandId(ghost, conversation, input.invocation_id, input.method),
        created_at_ms: 1, updated_at_ms: 2 }; runs.set(input.turn_id, run); return { status: "success", data: { run } };
    }
    if (input.method === "work.execution.complete") return { status: "success", data: { assignment_id: assignment.id, work_id: assignment.work_id,
      task_id: input.task_id, execution_id: null, accepted: false } };
    throw new Error(`Unexpected assignment observation callback ${input.method}`);
  };
  let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host });
    const body = { method: "conversation.assignment", ghost_id: ghost, conversation_id: conversation, goal_id: assignment.goal_id,
      goal_revision: 3, work_id: assignment.work_id, prompt: requirements, privacy: "public" };
    const frame = { protocol_version: "ghost-lifetime/1", command_id: assignment.id, payload_digest: payloadDigest(body), actor_ref: ghost,
      authority_epoch: 1, expected_revision: null, correlation_id: assignment.id, body };
    assert.equal((await runtime.handle(frame)).status, "success"); await runtime.waitForIdle(ghost, conversation);
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(JSON.stringify(request.body.messages).split(requirements).length - 1, 1, "fresh requirements remain exact and occur once");
      assert.equal(request.body.tools.some(tool => tool.function.name === "work_steer"), false);
    }
    const observedGoal = JSON.parse(requests[1].body.messages.find(message => message.role === "tool").content);
    assert.deepEqual(observedGoal, assignmentGoalObservation(goalReceipt, context));
    const observedWork = JSON.parse(requests[2].body.messages.filter(message => message.role === "tool").at(-1).content);
    assert.equal(JSON.stringify(observedWork), JSON.stringify(workReceipt));
    const session = [...runtime.sessions.values()][0];
    const rows = await session.database.all("SELECT id,record FROM entries WHERE json_extract(record, '$.kind')=?", "pi.tool-result");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => JSON.parse(row.record).model[0].details), [goalReceipt, workReceipt]);
    await runtime.close(); runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host });
    const inspection = { method: "conversation.inspect", ghost_id: ghost, conversation_id: conversation };
    await runtime.handle({ ...frame, command_id: "read-original-receipts", correlation_id: "read-original-receipts", body: inspection, payload_digest: payloadDigest(inspection) });
    const reopened = [...runtime.sessions.values()][0];
    assert.deepEqual(await reopened.database.all("SELECT id,record FROM entries WHERE json_extract(record, '$.kind')=?", "pi.tool-result"), rows);
    assert.equal(requests.length, 3, "cold inspection starts no inference");
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
