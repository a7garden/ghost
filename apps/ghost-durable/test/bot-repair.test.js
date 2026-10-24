import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGhostRuntime } from "../src/runtime.js";
import { createBrokerModelProvider } from "../src/models.js";
import { createHostToolTransport } from "../src/host-transport.js";
import { payloadDigest } from "../src/contract.js";
import { validateBotRepairDescriptor } from "../src/bot-repair.js";

const descriptor = { report_id: "failed-report", candidate_id: "failed-candidate", candidate_digest: "a".repeat(64), candidate_revision: 1, repairs_remaining: 2 };
const args = { candidate_id: descriptor.candidate_id, candidate_digest: descriptor.candidate_digest, instructions: "Preserve the exact scalar string output; never serialize an object." };

test("repair converter binds only the outer report and rejects authority/profile/fixture controls", async () => {
  const requests = [];
  const transport = createHostToolTransport({ hostRoot: "/tmp/ghost-repair-converter", callbackToken: "fixture", authorityEpoch: 1,
    dispatch: async request => { requests.push(request); return { ok: true, result: { status: "success", summary: "Host repair receipt", artifacts: [], next_actions: [], data: {} } }; } });
  const input = { ghost_id: "ghost", conversation_id: "conversation", report_id: "failed-report", invocation_id: "repair-call", inference_scope: "public", conversation_disclosure: "public", method: "bot.repair", arguments: args };
  await transport(input);
  assert.deepEqual(requests[0].envelope.body, { method: "bot.repair", report_id: "failed-report", arguments: args });
  assert.equal(requests[0].envelope.actor_ref, "ghost");
  for (const extra of [{ actor_ref: "owner" }, { report_id: "forged" }, { owner_approved: true }, { candidate_revision: 99 }, { fixtures: [] }, { required_capabilities: ["browser"] }]) await assert.rejects(transport({ ...input, arguments: { ...args, ...extra } }));
  await assert.rejects(transport({ ...input, report_id: undefined })); assert.equal(requests.length, 1);
});

test("repair descriptors have exact report identity and a Host-owned two-repair budget", () => {
  assert.deepEqual(validateBotRepairDescriptor(descriptor, "failed-report"), descriptor);
  assert.equal(validateBotRepairDescriptor(undefined, "failed-report"), null);
  for (const changed of [{ report_id: "other" }, { candidate_revision: 3, repairs_remaining: 1 }, { repairs_remaining: 99 }, { approved: true }]) assert.throws(() => validateBotRepairDescriptor({ ...descriptor, ...changed }, "failed-report"));
});

test("only a freshly authorized report offers repair, and revocation before the callback sends no mutation", async () => {
  for (const revoke of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "ghost-bot-repair-")); let runtime, current = descriptor; const requests = [], callbacks = [];
    const report = { id: "failed-report", source_command_id: "source-evaluation", ghost_id: "ghost", conversation_id: "conversation", goal_id: "goal", goal_revision: 1, privacy: "public", prompt: "The fixed bot evaluation failed. Repair only its instruction mistake.", reply: null };
    const host = async input => {
      callbacks.push(input);
      if (input.method === "inference.inspect") return { status: "success", data: { inference_scope: "public", authority_epoch: 1 } };
      if (input.method === "conversation.report.inspect") return { status: "success", data: { report, ...(current ? { bot_repair: current } : {}) } };
      if (input.method === "bot.repair") { assert.equal(input.report_id, "failed-report"); assert.deepEqual(input.arguments, args); assert.equal(input.turn_id, undefined); current = null; return { status: "success", data: { candidate_id: "next-candidate", state: "evaluating" } }; }
      if (input.method === "conversation.report.reply") { report.reply = { turn_id: "reply", sequence: 1, text: input.arguments.text, text_digest: createHash("sha256").update(input.arguments.text).digest("hex") }; return { status: "success", data: { report_id: report.id, reply_id: "reply", sequence: 1, replayed: false } }; }
      throw new Error(`Unexpected report repair callback ${input.method}`);
    };
    const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => {
      requests.push(request);
      if (requests.length === 1) {
        const names = request.body.tools.map(tool => tool.function.name);
        assert.equal(names.includes("bot_repair"), true); for (const name of ["bot_prepare", "bot_evaluate", "bot_activate"]) assert.equal(names.includes(name), false);
        if (revoke) current = null;
        return { id: request.id, status: 200, body: { id: "repair-generation", object: "chat.completion", model: "minimax-code/MiniMax-M2.7", created: 1, choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "repair-one", type: "function", function: { name: "bot_repair", arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] } };
      }
      assert.equal(request.body.tools.some(tool => tool.function.name === "bot_repair"), false, "old descriptor cannot persist authority");
      return { id: request.id, status: 200, body: { id: "repair-finished", object: "chat.completion", model: "minimax-code/MiniMax-M2.7", created: 1, choices: [{ index: 0, message: { role: "assistant", content: revoke ? "Repair capability is no longer available." : "The repaired candidate is evaluating; readiness is pending." }, finish_reason: "stop" }] } };
    } });
    try {
      runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host });
      const body = { method: "conversation.submit", ghost_id: "ghost", conversation_id: "conversation", goal_id: "goal", goal_revision: 1, prompt: report.prompt, privacy: "public" };
      const envelope = { protocol_version: "ghost-lifetime/1", command_id: report.id, payload_digest: payloadDigest(body), actor_ref: "ghost", authority_epoch: 1, expected_revision: null, correlation_id: "source-evaluation", body };
      assert.equal((await runtime.handle(envelope)).status, "success"); await runtime.waitForIdle("ghost", "conversation");
      assert.equal(callbacks.filter(input => input.method === "bot.repair").length, revoke ? 0 : 1);
      assert.equal(callbacks.some(input => ["bot.prepare", "bot.evaluate", "bot.activate", "goal.create", "mailbox.send"].includes(input.method)), false);
      assert.equal(requests.length, 2); await runtime.close(); runtime = null;
      runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host }); await runtime.waitForIdle("ghost", "conversation");
      assert.equal(requests.length, 2, "reopen cannot revive an old repair descriptor");
    } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
  }
});
