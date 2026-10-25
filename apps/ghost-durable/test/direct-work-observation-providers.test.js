import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { openGhostRuntime } from "../src/runtime.js";
import { createBrokerModelProvider } from "../src/models.js";
import { payloadDigest } from "../src/contract.js";

test("the real SDK persists original direct receipts while completion and Responses wires use raw read text", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-direct-observation-wire-"));
  const ghost = "direct-observation-ghost", conversation = "direct-observation-conversation";
  const assignment = { id: "direct-observation-assignment", source_command_id: "source", ghost_id: ghost, conversation_id: conversation,
    goal_id: "goal", goal_revision: 1, work_id: "work", prompt: "Inspect the failed command output and read the original input; report the observed result.", privacy: "public", origin_kind: "owner_goal", parent_work_id: null, root_goal_id: "goal" };
  const rawText = '{"content":"user-authored field", "문장":"한글 🐈"}\n\n';
  const fullDigest = createHash("sha256").update(`unselected line\n${rawText}`).digest("hex");
  const calls = [], requests = [], originals = [], runs = new Map();
  const host = async input => {
    calls.push(input);
    if (input.method === "inference.inspect") return { status: "success", data: { inference_scope: "public", authority_epoch: 1 } };
    if (input.method === "conversation.assignment.inspect") return { status: "success", data: { assignment, skills: [], execution: { engine: "pi", version: 1, tools: ["read", "bash"] } } };
    if (input.method === "conversation.turn.inspect") return { status: "success", data: { run: runs.get(input.turn_id) ?? { turn_id: input.turn_id, ghost_id: ghost, conversation_id: conversation, state: "queued", cancel_requested: false, cancel_command_id: null, submission_id: null, entry_id: null, reason_code: null, latest_status_command_id: null, created_at_ms: 1, updated_at_ms: 1 } } };
    if (input.method === "conversation.turn_status") {
      const run = { turn_id: input.turn_id, ghost_id: ghost, conversation_id: conversation, state: input.arguments.status, cancel_requested: false, cancel_command_id: null, submission_id: input.arguments.submission_id, entry_id: input.arguments.entry_id, reason_code: input.arguments.reason_code, latest_status_command_id: input.invocation_id, created_at_ms: 1, updated_at_ms: 2 };
      runs.set(input.turn_id, run); return { status: "success", data: { run } };
    }
    if (input.method === "work.execute") {
      const response = { status: "success", summary: "Pi tool effect observed", object_refs: ["original-execution"], artifacts: [], next_actions: [], error_code: null, retry_class: "same_id", data: {
        receipt: { assignment_id: input.assignment_id, work_id: input.work_id, generation_task_id: input.generation_task_id, task_id: input.task_id, call_id: input.call_id, input_digest: input.input_digest, execution_id: "original-execution", state: "complete" },
        output: input.operation === "bash" ? { state: "stopped", exit_code: 1, success: false, stdout: "partial stdout\n", stderr: "KeyError: 'content'\n" } : { content: rawText, sha256: fullDigest } } };
      originals.push(JSON.stringify(response)); return response;
    }
    if (input.method === "work.execution.complete") return { status: "success", data: { assignment_id: assignment.id, work_id: assignment.work_id, task_id: input.task_id, execution_id: "original-execution", accepted: false } };
    throw Error(`Unexpected observation callback ${input.method}`);
  };
  const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => {
    requests.push(request);
    const step = [["bash", { command: "false" }], ["read", { path: "input.json", offset: 2, limit: 2 }]][requests.length - 1];
    const message = step ? { role: "assistant", content: null, tool_calls: [{ id: `direct-${requests.length}`, type: "function", function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }
      : { role: "assistant", content: "Inspected the original command failure and input; no artifact acceptance is claimed." };
    return { id: request.id, status: 200, body: { id: `completion-${requests.length}`, object: "chat.completion", created: 1, model: request.body.model, choices: [{ index: 0, message, finish_reason: step ? "tool_calls" : "stop" }] } };
  } });
  let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host });
    const body = { method: "conversation.assignment", ghost_id: ghost, conversation_id: conversation, goal_id: assignment.goal_id, goal_revision: 1, work_id: assignment.work_id, prompt: assignment.prompt, privacy: "public" };
    assert.equal((await runtime.handle({ protocol_version: "ghost-lifetime/1", command_id: assignment.id, payload_digest: payloadDigest(body), actor_ref: ghost, authority_epoch: 1, expected_revision: null, correlation_id: assignment.id, body })).status, "success");
    await runtime.waitForIdle(ghost, conversation);
    assert.equal(requests.length, 3);
    assert.deepEqual(calls.filter(call => call.method === "work.execute").map(call => call.operation), ["bash", "read"]);
    const session = [...runtime.sessions.values()][0];
    const rows = await session.database.all("SELECT record FROM entries WHERE json_extract(record, '$.kind')=? ORDER BY id", "pi.tool-result");
    const results = rows.map(row => JSON.parse(row.record).model[0]);
    assert.deepEqual(results.map(result => JSON.stringify(result.details)), originals, "immutable full Host responses stay in durable details");
    const failed = results.find(result => result.toolName === "bash"), read = results.find(result => result.toolName === "read");
    assert.equal(failed.isError, true);
    assert.equal(read.isError, false);
    const failedWire = requests[1].body.messages.find(message => message.role === "tool").content;
    assert.equal(failedWire, originals[0], "failure stdout and stderr are never compacted");
    const expectedReadWire = read.content.map(block => block.text).join("\n");
    const readWire = requests[2].body.messages.filter(message => message.role === "tool").at(-1).content;
    assert.equal(readWire, expectedReadWire);
    assert.equal(readWire.slice(readWire.indexOf("\n") + 1), rawText);
    const metadata = JSON.parse(readWire.slice(0, readWire.indexOf("\n")));
    assert.equal(metadata.full_file_sha256, fullDigest);
    assert.deepEqual(metadata.selection, { unit: "lines", offset: 2, limit: 2, whole_file: "not_asserted" });
    assert.equal(metadata.host_response.data, undefined);
    assert.equal(metadata.output, undefined);
    assert.equal(metadata.receipt.state, "complete");

    // Exercise the SDK's two actual wire converters against the durable result.
    // Details remain available to storage and inspection, never a second payload.
    const context = { messages: [read] }, before = JSON.stringify(read);
    const model = { id: "wire-fixture", provider: "ghost-registered", api: "openai-completions", input: ["text"], reasoning: false };
    assert.equal(convertMessages(model, context, {}).find(message => message.role === "tool").content, expectedReadWire);
    const native = convertResponsesMessages({ ...model, api: "openai-responses" }, context, new Set());
    assert.equal(native.find(message => message.type === "function_call_output").output, expectedReadWire);
    assert.equal(JSON.stringify(read), before, "provider conversion cannot rewrite retained Host details");
    // Assignments persist their canonical status locally and complete their Work;
    // conversation.turn_status is the separate Owner-turn projection.
    const turn = await session.index.get(`SELECT a.assignment_id, a.turn_id, a.conversation_id, a.work_id,
      a.sdk_task_id, a.sdk_entry_id, r.status, r.entry_id, r.reason_code
      FROM ghost_canonical_assignments a JOIN ghost_canonical_turn_runs r
        ON r.turn_id=a.turn_id AND r.conversation_id=a.conversation_id
      WHERE a.assignment_id=? AND a.conversation_id=?`, assignment.id, conversation);
    assert.ok(turn, "the exact admitted assignment retains its canonical run");
    assert.deepEqual({ assignment_id: turn.assignment_id, turn_id: turn.turn_id, conversation_id: turn.conversation_id, work_id: turn.work_id,
      status: turn.status, reason_code: turn.reason_code },
    { assignment_id: assignment.id, turn_id: assignment.id, conversation_id: conversation, work_id: assignment.work_id,
      status: "answered", reason_code: null }, "known command failure and subsequent inspection settle the original assignment without uncertainty");
    const originalGenerationId = JSON.parse(turn.sdk_task_id), finalEntryId = JSON.parse(turn.entry_id);
    assert.equal(JSON.parse(turn.sdk_entry_id), finalEntryId);
    const directInputs = calls.filter(call => call.method === "work.execute");
    for (const input of directInputs) {
      assert.equal(input.assignment_id, assignment.id);
      assert.equal(input.work_id, assignment.work_id);
      assert.equal(input.generation_task_id, originalGenerationId);
    }
    const completions = calls.filter(call => call.method === "work.execution.complete");
    assert.equal(completions.length, 1, "only the original Work is completed once after safe inspection");
    const completion = completions[0];
    assert.deepEqual({ ghost_id: completion.ghost_id, conversation_id: completion.conversation_id, assignment_id: completion.assignment_id,
      work_id: completion.work_id, task_id: completion.task_id },
    { ghost_id: ghost, conversation_id: conversation, assignment_id: assignment.id, work_id: assignment.work_id, task_id: originalGenerationId });
    assert.equal(completion.invocation_id, JSON.stringify(["ghost-pi-complete/1", ghost, conversation, assignment.id, originalGenerationId]));
    assert.ok(calls.indexOf(completion) > calls.indexOf(directInputs[1]), "the original failed command cannot prematurely complete the assignment");
    const finalGenerationRow = await session.database.get("SELECT id,record FROM tasks WHERE conversation_id=? AND json_extract(kind,'$')='pi.generation' ORDER BY id DESC LIMIT 1", session.root.id);
    assert.ok(finalGenerationRow);
    const finalGeneration = JSON.parse(finalGenerationRow.record);
    assert.ok(finalGenerationRow.id >= originalGenerationId);
    assert.equal(finalGeneration.conversationId, session.root.id);
    assert.equal(finalGeneration.state.status, "terminal");
    assert.equal(finalGeneration.state.outcome.status, "completed");
    assert.equal(finalGeneration.state.outcome.result.entryId, finalEntryId, "the exact final SDK answer is the canonical answered entry");
    assert.equal(calls.filter(call => call.method === "conversation.turn_status").length, 0, "Work assignments do not fabricate Owner-turn status callbacks");
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
