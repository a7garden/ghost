import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostToolTransport } from "../src/host-transport.js";
import { directWorkInvocationId } from "../src/direct-work.js";
import { payloadDigest } from "../src/contract.js";

test("direct Pi callback authenticates the exact task/call input envelope and completion without accepting model controls", async t => {
  const root = await mkdtemp(join(tmpdir(), "ghost-pi-wire-")); const token = "a".repeat(64); const requests = [];
  await writeFile(join(root, ".ghost-control.json"), JSON.stringify({ protocol: "ghost-control", protocol_version: 1, host: "127.0.0.1", port: 9, token }), { mode: 0o600 });
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/api/v1/bootstrap/")) {
      const nonce = parsed.pathname.split("/").at(-1);
      return new Response(JSON.stringify({ protocol: "ghost-control", version: 1, proof: createHmac("sha256", token).update("ghost-control-bootstrap-v1\0").update(nonce).digest("hex") }), { status: 200 });
    }
    assert.equal(parsed.pathname, "/api/v1/pi/action");
    assert.equal(options.headers.Authorization, "Bearer fixture-pi-callback");
    const request = JSON.parse(options.body); requests.push(request);
    assert.equal(request.envelope.payload_digest, payloadDigest(request.envelope.body));
    return new Response(JSON.stringify({ ok: true, result: { status: "success", summary: "fixture receipt", artifacts: [], next_actions: [], data: {} } }), { status: 200 });
  });
  try {
    const transport = createHostToolTransport({ hostRoot: root, callbackToken: "fixture-pi-callback", authorityEpoch: 3 });
    const identity = { ghostId: "ghost", conversationId: "conversation", assignmentId: "assignment", workId: "work", taskId: 8, callId: "call" };
    const args = { command: "test -s output.txt", timeout: 5 };
    const input = { method: "work.execute", ghost_id: identity.ghostId, conversation_id: identity.conversationId, assignment_id: identity.assignmentId, work_id: identity.workId,
      generation_task_id: 7, task_id: 8, call_id: "call", operation: "bash", input_digest: payloadDigest({ operation: "bash", arguments: args }), arguments: args,
      invocation_id: directWorkInvocationId(identity), inference_scope: "public", conversation_disclosure: "public" };
    await transport(input); await transport(input);
    assert.deepEqual(requests[0], requests[1], "same call and bytes retain the authenticated envelope identity");
    assert.equal(requests[0].envelope.authority_epoch, 3);
    assert.deepEqual(requests[0].envelope.body, { method: "work.execute", assignment_id: "assignment", work_id: "work", generation_task_id: 7, task_id: 8, call_id: "call", input_digest: input.input_digest, operation: "bash", arguments: args });
    for (const mutation of [{ input_digest: "0".repeat(64) }, { task_id: 9 }, { work_id: "other" }, { operation: "raw_host_shell" }, { arguments: { command: "changed" } }]) await assert.rejects(transport({ ...input, ...mutation }));
    assert.equal(requests.length, 2);
    await transport({ ...input, method: "work.execution.complete", task_id: 7, arguments: { summary: "Work ready for separate Host validation" }, invocation_id: JSON.stringify(["ghost-pi-complete/1", "ghost", "conversation", "assignment", 7]) });
    assert.deepEqual(requests[2].envelope.body, { method: "work.execution.complete", assignment_id: "assignment", work_id: "work", task_id: 7, summary: "Work ready for separate Host validation" });
    await transport({ method: "conversation.reply", ghost_id: "ghost", conversation_id: "conversation", turn_id: "owner-turn", invocation_id: "memory-reply", inference_scope: "public", conversation_disclosure: "public", memory_context_revision: "a".repeat(64), arguments: { text: "memory-derived response" } });
    assert.deepEqual(requests[3].envelope.body, { method: "conversation.reply", ghost_id: "ghost", conversation_id: "conversation", turn_id: "owner-turn", text: "memory-derived response", memory_context_revision: "a".repeat(64) });
    assert.equal(requests.length, 4, "stamped replay reaches the Host guard without a legacy history-read shortcut");
    const reportReply = { method: "conversation.report.reply", ghost_id: "ghost", conversation_id: "conversation", report_id: "accepted-work-report", invocation_id: "report-reply", inference_scope: "public", conversation_disclosure: "public", arguments: { text: "The accepted Work is ready." } };
    await transport(reportReply);
    await transport(reportReply);
    assert.deepEqual(requests[4].envelope.body, { method: "conversation.report.reply", report_id: "accepted-work-report", ghost_id: "ghost", conversation_id: "conversation", text: "The accepted Work is ready." });
    assert.deepEqual(requests[4], requests[5], "report retries preserve their own identity without execution-only fields");
  } finally { await rm(root, { recursive: true, force: true }); }
});
