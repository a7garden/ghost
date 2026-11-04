import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { botEvaluationObservation } from "../src/bot-evaluation-observation.js";
import { openGhostRuntime } from "../src/runtime.js";
import { createBrokerModelProvider } from "../src/models.js";
import { callbackCommandId } from "../src/host-transport.js";
import { payloadDigest } from "../src/contract.js";

const sentinel = "PRODUCER_ONLY_EVALUATION_PROMPT_AND_HELDOUT_SENTINEL";
const candidate = "candidate-original", digest = "a".repeat(64);
const receipt = {
  status: "success", summary: "Evaluation is bound to its original Work; acceptance remains pending.",
  next_actions: ["Inspect the evaluation Work before activation."],
  artifacts: [{ digest, locator: "artifact:evaluation", privacy: "public", producing_attempt: "attempt-original" }],
  object_refs: ["work:evaluation-work"], error_code: null, retry_class: "same_id",
  data: { candidate_id: candidate, candidate_digest: digest, state: "evaluating", activation_requested: false,
    evaluation_goal_id: "evaluation-goal", evaluation_work_id: "evaluation-work",
    goal: { id: "evaluation-goal", revision: 7, state: "active", prompt: sentinel.repeat(2000),
      acceptance_spec: { heldout_inputs: [sentinel] }, assets: [{ content: sentinel }] },
    work: { id: "evaluation-work", goal_id: "evaluation-goal", goal_revision: 7, owner_revision: 2,
      state: "queued", execution_id: null, arbitrary_nested_input: sentinel }, extra: sentinel },
};

test("evaluation observations retain typed metadata and exact error/unknown receipts without mutating evidence", () => {
  const bytes = JSON.stringify(receipt);
  for (const status of ["success", "warning"]) {
    const observed = botEvaluationObservation({ ...receipt, status });
    assert.equal(observed.status, status);
    assert.equal(observed.summary, receipt.summary);
    assert.deepEqual(observed.next_actions, receipt.next_actions);
    assert.deepEqual(observed.artifacts, receipt.artifacts);
    assert.equal(observed.data.candidate_id, candidate);
    assert.equal(observed.data.candidate_digest, digest);
    assert.equal(observed.data.activation_requested, false);
    assert.deepEqual(observed.data.goal, { id: "evaluation-goal", revision: 7, state: "active" });
    assert.deepEqual(observed.data.work, { id: "evaluation-work", goal_id: "evaluation-goal", goal_revision: 7,
      owner_revision: 2, state: "queued", execution_id: null });
    assert.equal(JSON.stringify(observed).includes(sentinel), false);
  }
  for (const status of ["error", "unknown", undefined]) {
    const uncertain = { ...receipt, status, error_code: "evaluation_outcome_unknown", retry_class: "reconcile_first" };
    assert.equal(botEvaluationObservation(uncertain), uncertain);
  }
  assert.equal(JSON.stringify(receipt), bytes);
});

function envelope(id, body) {
  return { protocol_version: "ghost-lifetime/1", command_id: id, payload_digest: payloadDigest(body), actor_ref: "ghost",
    authority_epoch: 1, expected_revision: null, correlation_id: id, body };
}
function controlledHost(callbacks, result) {
  const runs = new Map();
  return async input => {
    callbacks.push(input);
    if (input.method === "inference.inspect") return { status: "success", data: { inference_scope: "public" } };
    if (["memory.capabilities", "documents.capabilities"].includes(input.method)) return { status: "success", data: { available_tools: [] } };
    if (input.method === "conversation.turn.inspect") return { status: "success", data: { run: runs.get(input.turn_id) ?? {
      turn_id: input.turn_id, ghost_id: "ghost", conversation_id: "conversation", state: "queued", cancel_requested: false,
      cancel_command_id: null, submission_id: null, entry_id: null, reason_code: null, latest_status_command_id: null,
      created_at_ms: 1, updated_at_ms: 1 } } };
    if (input.method === "conversation.turn_status") {
      const run = { turn_id: input.turn_id, ghost_id: "ghost", conversation_id: "conversation", state: input.arguments.status,
        cancel_requested: false, cancel_command_id: null, submission_id: input.arguments.submission_id,
        entry_id: input.arguments.entry_id, reason_code: input.arguments.reason_code,
        latest_status_command_id: callbackCommandId("ghost", "conversation", input.invocation_id, input.method),
        created_at_ms: 1, updated_at_ms: 2 };
      runs.set(input.turn_id, run); return { status: "success", data: { run } };
    }
    if (input.method === "conversation.reply") return { status: "success", data: { turn_id: input.turn_id } };
    if (input.method === "bot.evaluate") return result;
    throw new Error(`Unexpected observation fixture callback: ${input.method}`);
  };
}
function input(id, prompt = "Evaluate the exact existing candidate.") {
  return envelope(id, { method: "conversation.input", ghost_id: "ghost", conversation_id: "conversation", turn_id: id,
    prompt, privacy: "public", attachments: [] });
}
function controlledProvider(requests, firstTool) {
  let generation = 0;
  return createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => {
    requests.push(request);
    const summary = JSON.stringify(request.body.messages).includes("context summarization assistant");
    const tool = !summary && generation++ === 0 ? firstTool : null;
    const message = tool ? { role: "assistant", content: null, tool_calls: [{ id: "original-call", type: "function",
      function: { name: tool, arguments: JSON.stringify(tool === "bot_evaluate" ? { candidate_id: candidate, candidate_digest: digest }
        : { work_id: "old-work", prompt: "Do not create a replacement execution." }) } }] }
      : { role: "assistant", content: summary ? "Retain original evaluation IDs; acceptance is pending." : "The exact Work remains pending." };
    return { id: request.id, status: 200, body: { id: `completion-${requests.length}`, object: "chat.completion",
      model: "minimax-code/MiniMax-M2.7", created: 1, choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }] } };
  } });
}

test("actual SDK provider and compaction see only evaluation metadata while the complete durable receipt survives reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-evaluation-observation-")), requests = [], callbacks = [];
  const host = controlledHost(callbacks, receipt), provider = controlledProvider(requests, "bot_evaluate");
  let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host });
    assert.equal((await runtime.handle(input("evaluate-turn"))).status, "success");
    await runtime.waitForIdle("ghost", "conversation");
    const session = [...runtime.sessions.values()][0];
    const original = await session.database.get("SELECT id,record FROM entries WHERE json_extract(record, '$.kind')=? AND record LIKE ?", "pi.tool-result", `%${sentinel}%`);
    assert.ok(original, "SDK retained the complete original receipt");
    const message = JSON.parse(original.record).model[0];
    assert.equal(JSON.stringify(message.details), JSON.stringify(receipt));
    assert.deepEqual(JSON.parse(message.content[0].text), botEvaluationObservation(receipt));
    assert.equal(requests.length, 2);
    assert.ok(JSON.stringify(requests[1].body.messages).includes("evaluation-work"));
    assert.equal(JSON.stringify(requests).includes(sentinel), false);
    for (const request of requests) assert.equal(request.body.tools.some(tool => tool.function.name === "work_steer"), false);

    // Existing SDK manual compaction selects the old tool turn while retaining a
    // later user turns within the existing input bound. Its summary provider
    // must not see details.
    for (const id of ["later-turn-1", "later-turn-2"]) {
      assert.equal((await runtime.handle(input(id, "Later retained history. ".repeat(2500)))).status, "success");
      await runtime.waitForIdle("ghost", "conversation");
    }
    const task = await session.root.compact(undefined, BACKGROUND_CONTEXT);
    await session.harness.waitForTask(task, BACKGROUND_CONTEXT);
    const summary = requests.find(request => JSON.stringify(request.body.messages).includes("context summarization assistant"));
    assert.ok(summary, "the actual SDK summarizer ran");
    assert.ok(JSON.stringify(summary.body.messages).includes("evaluation-work"));
    assert.equal(JSON.stringify(requests).includes(sentinel), false);
    assert.equal((await session.database.get("SELECT record FROM entries WHERE id=?", original.id)).record, original.record);
    assert.equal(callbacks.filter(value => value.method === "bot.evaluate").length, 1);
    await runtime.close(); runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host });
    await runtime.handle(envelope("inspect-after-reopen", { method: "conversation.inspect", ghost_id: "ghost", conversation_id: "conversation" }));
    const reopened = [...runtime.sessions.values()][0];
    assert.equal((await reopened.database.get("SELECT record FROM entries WHERE id=?", original.id)).record, original.record);
    assert.equal(callbacks.filter(value => value.method === "bot.evaluate").length, 1);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("forced unadvertised work_steer settles with no Host callback and no assertion about prior effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-forced-steer-")), requests = [], callbacks = [];
  let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: controlledProvider(requests, "work_steer"),
      hostToolTransport: controlledHost(callbacks, receipt) });
    await runtime.handle(input("forced-steer-turn")); await runtime.waitForIdle("ghost", "conversation");
    assert.equal(requests.length, 2);
    assert.equal(callbacks.filter(input => input.method === "work.steer").length, 0);
    assert.equal(requests.every(request => !request.body.tools.some(tool => tool.function.name === "work_steer")), true);
    const session = [...runtime.sessions.values()][0];
    const row = await session.database.get("SELECT record FROM entries WHERE json_extract(record, '$.kind')=? AND record LIKE ?", "pi.tool-result", '%"toolName":"work_steer"%');
    const result = JSON.parse(row.record).model[0];
    assert.equal(result.isError, true); assert.equal(result.details.data?.host_effect_class, undefined);
    assert.ok(result.content[0].text.includes("prior submission or effect retains its original outcome"));
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("actual SDK preserves an evaluation error receipt and its recovery semantics in provider content", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-evaluation-error-")), requests = [], callbacks = [];
  const error = { status: "error", summary: "The original evaluation result is unconfirmed.",
    next_actions: ["Inspect the original command; do not create another candidate."], artifacts: [], object_refs: [],
    error_code: "evaluation_outcome_unknown", retry_class: "reconcile_first", data: { candidate_id: candidate, state: "unknown" } };
  let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: controlledProvider(requests, "bot_evaluate"),
      hostToolTransport: controlledHost(callbacks, error) });
    await runtime.handle(input("error-turn")); await runtime.waitForIdle("ghost", "conversation");
    const tool = requests[1].body.messages.find(message => message.role === "tool");
    assert.deepEqual(JSON.parse(tool.content), error);
    const session = [...runtime.sessions.values()][0];
    const row = await session.database.get("SELECT record FROM entries WHERE json_extract(record, '$.kind')=? AND record LIKE ?", "pi.tool-result", '%"toolName":"bot_evaluate"%');
    const result = JSON.parse(row.record).model[0];
    assert.equal(result.isError, true); assert.deepEqual(result.details, error);
    assert.equal(callbacks.filter(input => input.method === "bot.evaluate").length, 1);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
