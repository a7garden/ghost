import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostToolTransport } from "../src/host-transport.js";
import { createBrokerModelProvider } from "../src/models.js";
import { openGhostRuntime } from "../src/runtime.js";
import { payloadDigest } from "../src/contract.js";

const mail = { integration_id: "fixture", tool: "send_email",
  arguments: { to: "owner@example.invalid", subject: "Fixture", body: "Synthetic message" } };

test("integration transport binds immutable arguments to the Owner turn and exposes no dispatch method", async () => {
  const seen = [];
  const transport = createHostToolTransport({ hostRoot: "/tmp/ghost-integration-fixture", callbackToken: "fixture", authorityEpoch: 3,
    dispatch: async request => {
      seen.push(request);
      return { ok: true, result: { status: "success", summary: "pending approval", artifacts: [], next_actions: [], data: { state: "pending" } } };
    },
  });
  const invocation = { ghost_id: "g", conversation_id: "c", turn_id: "turn", inference_scope: "public", conversation_disclosure: "public", invocation_id: "call" };
  const result = await transport({ ...invocation, method: "integrations.propose", arguments: mail });
  assert.equal(result.data.state, "pending");
  assert.deepEqual(seen[0].envelope.body, { method: "integrations.propose", ghost_id: "g", conversation_id: "c", turn_id: "turn", ...mail });
  await assert.rejects(transport({ ...invocation, method: "integrations.propose", arguments: { ...mail, approve: true } }));
  await assert.rejects(transport({ ...invocation, turn_id: undefined, method: "integrations.propose", arguments: mail }));
  await assert.rejects(transport({ ...invocation, method: "integrations.execute", arguments: mail }));
  assert.equal(seen.length, 1);
});

test("the same Pi conversation answers ordinary chat and proposes mail for Owner review", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-integration-approval-"));
  const callbacks = [], runs = new Map();
  let runtime;
  const host = async input => {
    callbacks.push(input);
    if (input.method === "inference.inspect") return { status: "success", data: { inference_scope: "public" } };
    if (["memory.capabilities", "documents.capabilities"].includes(input.method)) return { status: "success", data: { available_tools: [] } };
    if (input.method === "conversation.turn.inspect") return { status: "success", data: { integration_approvals: input.turn_id === "mail", run: runs.get(input.turn_id) ?? {
      turn_id: input.turn_id, ghost_id: "g", conversation_id: "c", state: "queued", cancel_requested: false,
      cancel_command_id: null, submission_id: null, entry_id: null, reason_code: null, latest_status_command_id: null, created_at_ms: 1, updated_at_ms: 1,
    } } };
    if (input.method === "conversation.turn_status") {
      const run = { turn_id: input.turn_id, ghost_id: "g", conversation_id: "c", state: input.arguments.status,
        cancel_requested: false, cancel_command_id: null, submission_id: input.arguments.submission_id, entry_id: input.arguments.entry_id,
        reason_code: input.arguments.reason_code, latest_status_command_id: input.invocation_id, created_at_ms: 1, updated_at_ms: 2 };
      runs.set(input.turn_id, run);
      return { status: "success", data: { run } };
    }
    if (input.method === "conversation.reply") return { status: "success", data: { turn_id: input.turn_id } };
    if (input.method === "integrations.list") return { status: "success", data: { features: [{ integration_id: "fixture", tool: "send_email" }] } };
    if (input.method === "integrations.propose") return { status: "success", data: { id: "approval", state: "pending" } };
    throw new Error(`Unexpected Host method ${input.method}`);
  };
  const messages = [
    { role: "assistant", content: "안녕하세요!" },
    { role: "assistant", content: null, tool_calls: [{ id: "list", type: "function", function: { name: "integration_list", arguments: "{}" } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "propose", type: "function", function: { name: "integration_propose", arguments: JSON.stringify(mail) } }] },
    { role: "assistant", content: "확인할 일에 이메일 발송 승인 요청을 올렸어요." },
  ];
  let step = 0;
  const modelRef = "minimax-code/MiniMax-M2.7";
  const modelProvider = createBrokerModelProvider({ modelRef, invoke: async request => {
    assert.equal(request.body.tools.some(tool => tool.function.name === "integration_propose"), step > 0);
    const message = messages[step++];
    return { id: request.id, status: 200, body: { id: `fixture-${step}`, object: "chat.completion", model: modelRef,
      created: 1, choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] } };
  } });
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider, hostToolTransport: host });
    for (const [turn_id, prompt] of [["hello", "안녕"], ["mail", "시험 이메일을 보내 줘"]]) {
      const body = { method: "conversation.input", ghost_id: "g", conversation_id: "c", turn_id, prompt, privacy: "public", attachments: [] };
      const envelope = { protocol_version: "ghost-lifetime/1", command_id: turn_id, payload_digest: payloadDigest(body),
        actor_ref: "g", authority_epoch: 1, expected_revision: null, correlation_id: turn_id, body };
      assert.equal((await runtime.handle(envelope)).status, "success");
      await runtime.waitForIdle("g", "c");
    }
    assert.equal(step, 4);
    assert.deepEqual(callbacks.filter(input => input.method.startsWith("integrations.")).map(input => [input.method, input.turn_id]),
      [["integrations.list", "mail"], ["integrations.propose", "mail"]]);
    assert.deepEqual(callbacks.find(input => input.method === "integrations.propose").arguments, mail);
    assert.equal(callbacks.some(input => input.method === "goal.create"), false);
    assert.equal(callbacks.filter(input => input.method === "conversation.reply").length, 2);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
