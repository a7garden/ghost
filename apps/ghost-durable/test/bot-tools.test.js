import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGhostRuntime } from "../src/runtime.js";
import { createBrokerModelProvider } from "../src/models.js";
import { createHostToolTransport } from "../src/host-transport.js";
import { payloadDigest } from "../src/contract.js";

const args = { display_name: "Comparison Ghost", purpose: "Repeat source-backed product comparisons.", input_contract: { type: "object" }, output_contract: { artifact: "comparison" }, instructions: "Compare only the provided evidence and publish its supporting artifact.", required_capabilities: ["read", "write", "publish_artifact"], source_work_ids: ["scoped-source-work"] };
const digest = "a".repeat(64), candidate = "candidate-from-host";

test("bot callback converter injects the committed Owner turn and rejects model authority controls", async () => {
  const requests = [];
  const transport = createHostToolTransport({ hostRoot: "/tmp/bot-transport-fixture", callbackToken: "fixture-no-http", authorityEpoch: 3,
    dispatch: async request => { requests.push(request); return { ok: true, result: { status: "success", summary: "Host candidate receipt", artifacts: [], next_actions: [], data: { candidate_id: candidate, candidate_digest: digest } } }; } });
  const input = { ghost_id: "ghost", conversation_id: "conversation", turn_id: "owner-turn", inference_scope: "public", conversation_disclosure: "public", invocation_id: "original-call" };
  await transport({ ...input, method: "bot.prepare", arguments: args });
  for (const method of ["bot.evaluate", "bot.activate"]) await transport({ ...input, method, arguments: { candidate_id: candidate, candidate_digest: digest } });
  assert.deepEqual(requests.map(request => request.envelope.body.method), ["bot.prepare", "bot.evaluate", "bot.activate"]);
  for (const request of requests) {
    assert.equal(request.envelope.actor_ref, "ghost"); assert.equal(request.envelope.authority_epoch, 3);
    assert.equal(request.envelope.body.turn_id, "owner-turn"); assert.equal(request.ghost_id, "ghost");
    assert.deepEqual(Object.keys(request.envelope.body).sort(), ["arguments", "method", "turn_id"]);
  }
  for (const extra of [{ actor_ref: "owner" }, { owner_approved: true }, { grants: ["all"] }, { model: "another" }, { fixture_receipt: {} }, { turn_id: "forged" }]) await assert.rejects(transport({ ...input, method: "bot.prepare", arguments: { ...args, ...extra } }));
  await assert.rejects(transport({ ...input, turn_id: undefined, method: "bot.prepare", arguments: args }));
  await assert.rejects(transport({ ...input, method: "bot.activate", arguments: { candidate_id: candidate, candidate_digest: digest, owner_approved: true } }));
  assert.equal(requests.length, 3);
});

test("the same Pi Owner turn prepares, evaluates and requests activation using only Host-issued candidate identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-bot-owner-")); const callbacks = [], requests = [], runs = new Map(); let runtime;
  const host = async input => {
    callbacks.push(input);
    if (input.method === "inference.inspect") return { status: "success", data: { inference_scope: "public" } };
    if (["memory.capabilities", "documents.capabilities"].includes(input.method)) return { status: "success", data: { available_tools: [] } };
    if (input.method === "conversation.turn.inspect") return { status: "success", data: { run: runs.get(input.turn_id) ?? { turn_id: input.turn_id, ghost_id: "ghost", conversation_id: "conversation", state: "queued", cancel_requested: false, cancel_command_id: null, submission_id: null, entry_id: null, reason_code: null, latest_status_command_id: null, created_at_ms: 1, updated_at_ms: 1 } } };
    if (input.method === "conversation.turn_status") { const run = { turn_id: input.turn_id, ghost_id: "ghost", conversation_id: "conversation", state: input.arguments.status, cancel_requested: false, cancel_command_id: null, submission_id: input.arguments.submission_id, entry_id: input.arguments.entry_id, reason_code: input.arguments.reason_code, latest_status_command_id: input.invocation_id, created_at_ms: 1, updated_at_ms: 2 }; runs.set(input.turn_id, run); return { status: "success", data: { run } }; }
    if (input.method === "conversation.reply") return { status: "success", data: { turn_id: input.turn_id } };
    assert.equal(input.turn_id, "create-bot-turn");
    if (input.method === "bot.prepare") { assert.deepEqual(input.arguments, args); return { status: "success", data: { candidate_id: candidate, candidate_digest: digest } }; }
    if (["bot.evaluate", "bot.activate"].includes(input.method)) { assert.deepEqual(input.arguments, { candidate_id: candidate, candidate_digest: digest }); return { status: "success", data: { candidate_id: candidate, candidate_digest: digest, state: input.method === "bot.activate" ? "provisioning" : "evaluated" } }; }
    throw new Error(`Unexpected bot callback ${input.method}`);
  };
  const steps = [["bot_prepare", args], ["bot_evaluate", { candidate_id: candidate, candidate_digest: digest }], ["bot_activate", { candidate_id: candidate, candidate_digest: digest }]];
  const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => {
    requests.push(request); const step = steps[requests.length - 1];
    const message = step ? { role: "assistant", content: null, tool_calls: [{ id: `bot-call-${requests.length}`, type: "function", function: { name: step[0], arguments: JSON.stringify(step[1]) } }] } : { role: "assistant", content: "The Host is provisioning the evaluated candidate; activation is still pending." };
    return { id: request.id, status: 200, body: { id: `completion-${requests.length}`, object: "chat.completion", model: "minimax-code/MiniMax-M2.7", created: 1, choices: [{ index: 0, message, finish_reason: step ? "tool_calls" : "stop" }] } };
  } });
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host });
    const body = { method: "conversation.input", ghost_id: "ghost", conversation_id: "conversation", turn_id: "create-bot-turn", prompt: "Create a reusable comparison Ghost from this completed source Work.", privacy: "public", attachments: [] };
    const envelope = { protocol_version: "ghost-lifetime/1", command_id: "create-bot-turn", payload_digest: payloadDigest(body), actor_ref: "ghost", authority_epoch: 1, expected_revision: null, correlation_id: "create-bot-turn", body };
    assert.equal((await runtime.handle(envelope)).status, "success"); await runtime.waitForIdle("ghost", "conversation");
    assert.equal(requests.length, 4); assert.deepEqual(callbacks.filter(input => input.method.startsWith("bot.")).map(input => input.method), ["bot.prepare", "bot.evaluate", "bot.activate"]);
    for (const name of ["bot_prepare", "bot_evaluate", "bot_activate"]) assert.equal(requests[0].body.tools.some(tool => tool.function.name === name), true);
    assert.equal(callbacks.find(input => input.method === "conversation.reply").arguments.text.includes("pending"), true);
    await runtime.handle(envelope); await runtime.waitForIdle("ghost", "conversation"); assert.equal(requests.length, 4, "same turn replay cannot prepare another candidate");
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
