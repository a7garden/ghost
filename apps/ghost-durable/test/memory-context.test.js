import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGhostRuntime } from "../src/runtime.js";
import { createBrokerModelProvider, createLocalModelProvider } from "../src/models.js";
import { openGhostIndex, openPiConversationStorage } from "../src/storage.js";
import { payloadDigest } from "../src/contract.js";
import { guardMemoryContextModels } from "../src/memory-context.js";

const ghost = "memory-context-ghost", conversation = "memory-context-conversation";
const secret = "REVOKED_MEMORY_MARKER", derived = "DERIVED_FROM_REVOKED_MEMORY";
const localModel = "mlx-community/Qwen3.6-35B-A3B-4bit";
function envelope(id, prompt) {
  const body = { method: "conversation.input", ghost_id: ghost, conversation_id: conversation, turn_id: id, prompt, privacy: "private", attachments: [] };
  return { protocol_version: "ghost-lifetime/1", command_id: id, payload_digest: payloadDigest(body), actor_ref: ghost, authority_epoch: 1, expected_revision: null, correlation_id: id, body };
}
function fixture({ revokeAtRecall = false, revokeAtAnswer = false, unstamped = false } = {}) {
  let revoked = false, recalled = false, revokeDuringAnswer = revokeAtAnswer; const requests = [], callbacks = [], runs = new Map(), assignments = new Map();
  const stamp = () => revoked ? "b".repeat(64) : "a".repeat(64);
  const transport = async input => {
    callbacks.push(input);
    switch (input.method) {
      case "conversation.assignment.inspect": return { status: "success", data: { assignment: assignments.get(input.assignment_id), skills: [] } };
      case "inference.inspect": return { status: "success", data: { inference_scope: "local", authority_epoch: 1 } };
      case "documents.capabilities": return { status: "success", data: { available_tools: [] } };
      case "memory.capabilities": return { status: "success", data: { available_tools: revoked ? [] : ["memory_recall"], context_revision: stamp() } };
      case "memory.context.inspect": return { status: "success", data: { context_revision: stamp(), memory_permitted: !revoked } };
      case "memory.recall": {
        const context_revision = stamp(); recalled = true;
        if (revokeAtRecall) revoked = true;
        return { status: "success", summary: "Scoped memory evidence", artifacts: [], next_actions: [], data: { ...(unstamped ? {} : { context_revision }), evidence: [{ reference: "source-1", text: secret }], scopes: [{ binding: "shared", partial: false }] } };
      }
      case "conversation.turn.inspect": return { status: "success", data: { run: runs.get(input.turn_id) ?? { turn_id: input.turn_id, ghost_id: ghost, conversation_id: conversation, state: "queued", cancel_requested: false, cancel_command_id: null, submission_id: null, entry_id: null, reason_code: null, latest_status_command_id: null, created_at_ms: 1, updated_at_ms: 1 } } };
      case "conversation.turn_status": {
        const run = { turn_id: input.turn_id, ghost_id: ghost, conversation_id: conversation, state: input.arguments.status, cancel_requested: false, cancel_command_id: null, submission_id: input.arguments.submission_id, entry_id: input.arguments.entry_id, reason_code: input.arguments.reason_code, latest_status_command_id: input.invocation_id, created_at_ms: 1, updated_at_ms: 2 };
        runs.set(input.turn_id, run); return { status: "success", data: { run } };
      }
      case "conversation.reply":
        if (input.memory_context_revision !== undefined && (revoked || input.memory_context_revision !== stamp())) return { status: "error", error_code: "memory_context_revoked", retry_class: "never", data: null };
        return { status: "success", data: { turn_id: input.turn_id } };
      default: throw new Error(`Unexpected memory context callback ${input.method}`);
    }
  };
  const localModelProvider = createLocalModelProvider({ baseUrl: "http://127.0.0.1:8768/v1", modelId: localModel, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    let message;
    if (!recalled && body.tools.some(tool => tool.function.name === "memory_recall")) message = { role: "assistant", content: null, tool_calls: [{ id: "memory-recall-call", type: "function", function: { name: "memory_recall", arguments: JSON.stringify({ query: "shared facts" }) } }] };
    else if (JSON.stringify(body.messages).includes(secret)) { message = { role: "assistant", content: derived }; if (revokeDuringAnswer) revoked = true; }
    else message = { role: "assistant", content: "Fresh response without prior memory." };
    return new Response(JSON.stringify({ id: `memory-completion-${requests.length}`, object: "chat.completion", model: localModel, choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", localModelProvider, invoke: async () => { throw new Error("Private memory must never use the public provider"); } });
  return { provider, transport, requests, callbacks, assignments, revoke: () => { revoked = true; }, revokeNextAnswer: () => { revokeDuringAnswer = true; } };
}
async function opened(root, f) { return openGhostRuntime({ root, mode: "broker", modelProvider: f.provider, hostToolTransport: f.transport }); }
async function status(root, turn) { const index = await openGhostIndex(root, ghost); try { return await index.get("SELECT status FROM ghost_canonical_turn_runs WHERE turn_id = ?", turn); } finally { await index.close(); } }

test("revoked memory and its derived answers are discarded before a later Owner prompt, reopen and compaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-memory-revoke-")); const f = fixture(); let runtime;
  try {
    runtime = await opened(root, f);
    await runtime.handle(envelope("memory-turn", "Recall the permitted shared evidence.")); await runtime.waitForIdle(ghost, conversation);
    assert.equal(f.requests.length, 2); assert.equal(JSON.stringify(f.requests[1]).includes(secret), true);
    assert.equal((await status(root, "memory-turn")).status, "answered");
    f.revoke();
    await runtime.handle(envelope("fresh-turn", "Answer a new unrelated request.")); await runtime.waitForIdle(ghost, conversation);
    assert.equal(f.requests.length, 3);
    assert.equal(JSON.stringify(f.requests[2]).includes(secret), false); assert.equal(JSON.stringify(f.requests[2]).includes(derived), false);
    assert.equal((await status(root, "fresh-turn")).status, "answered");
    await runtime.close(); runtime = null;
    runtime = await opened(root, f);
    await runtime.handle(envelope("after-reopen", "Continue with clean context only.")); await runtime.waitForIdle(ghost, conversation);
    assert.equal(f.requests.length, 4); assert.equal(JSON.stringify(f.requests[3]).includes(secret), false); assert.equal(JSON.stringify(f.requests[3]).includes(derived), false);
    assert.equal(f.requests.some(request => JSON.stringify(request.messages).includes("context summarization assistant")), false);
    const index = await openGhostIndex(root, ghost);
    try { assert.ok((await index.get("SELECT cutoff_entry_id FROM ghost_memory_context_boundaries WHERE conversation_id = ?", conversation)).cutoff_entry_id > 0); assert.ok((await index.all("SELECT * FROM ghost_memory_context_provenance WHERE conversation_id = ?", conversation)).length >= 1); } finally { await index.close(); }
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("a grant revoked before memory delivery or a missing provenance stamp withholds all retrieved bytes", async () => {
  for (const options of [{ revokeAtRecall: true }, { unstamped: true }]) {
    const root = await mkdtemp(join(tmpdir(), "ghost-memory-withhold-")); const f = fixture(options); let runtime;
    try {
      runtime = await opened(root, f); await runtime.handle(envelope("blocked-memory", "Recall the scoped source.")); await runtime.waitForIdle(ghost, conversation);
      assert.equal(f.requests.length, 2); assert.equal(JSON.stringify(f.requests[1]).includes(secret), false);
      assert.equal(f.callbacks.some(input => input.method === "conversation.reply" && input.arguments.text.includes(secret)), false);
    } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("revocation during a model answer withholds derived output and the next Owner turn rebuilds cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-memory-inflight-")); const f = fixture({ revokeAtAnswer: true }); let runtime;
  try {
    runtime = await opened(root, f); await runtime.handle(envelope("inflight-memory", "Recall and answer.")); await runtime.waitForIdle(ghost, conversation);
    assert.equal(f.requests.length, 2); assert.equal(f.callbacks.some(input => input.method === "conversation.reply" && input.arguments.text.includes(derived)), false);
    assert.notEqual((await status(root, "inflight-memory")).status, "answered");
    await runtime.handle(envelope("next-clean-owner", "A new unrelated request.")); await runtime.waitForIdle(ghost, conversation);
    assert.equal(f.requests.length, 3); assert.equal(JSON.stringify(f.requests[2]).includes(secret), false);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("a resumed compaction model call cannot summarize contaminated history", async () => {
  let calls = 0; const raw = { completeSimple: () => { calls += 1; }, getModel: () => "model" };
  const models = guardMemoryContextModels(raw, () => ({ contaminated: true }));
  assert.throws(() => models.completeSimple({}, { messages: [{ content: secret }] }), error => error.code === "memory_compaction_disabled");
  assert.equal(calls, 0); assert.equal(models.getModel(), "model");
});


test("an inherited memory-derived turn cannot rebuild itself after inference has already used old evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-memory-inherited-")); const f = fixture(); let runtime;
  try {
    runtime = await opened(root, f); await runtime.handle(envelope("source-owner-turn", "Recall the shared source.")); await runtime.waitForIdle(ghost, conversation);
    f.revokeNextAnswer();
    await runtime.handle(envelope("derived-owner-turn", "Answer from the previously recalled context.")); await runtime.waitForIdle(ghost, conversation);
    assert.equal(f.requests.length, 3); assert.equal(JSON.stringify(f.requests[2]).includes(secret), true);
    assert.notEqual((await status(root, "derived-owner-turn")).status, "answered");
    assert.equal(f.callbacks.some(input => input.method === "conversation.reply" && input.turn_id === "derived-owner-turn"), false);
    await runtime.handle(envelope("subsequent-owner-turn", "A clean unrelated request.")); await runtime.waitForIdle(ghost, conversation);
    assert.equal(f.requests.length, 4); assert.equal(JSON.stringify(f.requests[3]).includes(secret), false);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("legacy memory entries with missing provenance remain unreadable after reopen instead of adopting current grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-memory-legacy-")); const f = fixture(); let runtime;
  try {
    runtime = await opened(root, f); await runtime.handle(envelope("legacy-source-turn", "Recall source data.")); await runtime.waitForIdle(ghost, conversation);
    await runtime.close(); runtime = null;
    const index = await openGhostIndex(root, ghost);
    try { await index.run("DELETE FROM ghost_memory_context_provenance WHERE conversation_id = ?", conversation); } finally { await index.close(); }
    runtime = await opened(root, f); await runtime.handle(envelope("legacy-clean-turn", "Use fresh Owner input only.")); await runtime.waitForIdle(ghost, conversation);
    assert.equal(f.requests.length, 3); assert.equal(JSON.stringify(f.requests[2]).includes(secret), false); assert.equal(JSON.stringify(f.requests[2]).includes(derived), false);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

function modelMessage(content, stopReason = "stop") { return { role: "assistant", content: [{ type: "text", text: content }], api: "openai-completions", provider: "test", model: "test", stopReason, timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; }
const fakeModel = { api: "openai-completions", provider: "test", id: "test" };

test("cancelling a buffered memory-derived stream aborts the original inference and exposes no source-bearing event", async () => {
  const controller = new AbortController(); let sourceAborted = false, started;
  const ready = new Promise(resolve => { started = resolve; });
  const models = guardMemoryContextModels({ streamSimple(_model, _context, options) {
    const source = createAssistantMessageEventStream();
    options.signal.addEventListener("abort", () => { sourceAborted = true; source.push({ type: "error", reason: "aborted", error: modelMessage(secret, "aborted") }); source.end(); }, { once: true });
    source.push({ type: "text_delta", delta: secret, partial: modelMessage(secret) }); started(); return source;
  } }, () => ({ contaminated: true, validate: async () => {}, filter: async messages => messages }));
  const events = models.streamSimple(fakeModel, { messages: [] }, { signal: controller.signal });
  await ready; controller.abort();
  const observed = []; for await (const event of events) observed.push(event);
  assert.equal(sourceAborted, true); assert.equal(JSON.stringify(observed).includes(secret), false);
  assert.equal((await events.result()).stopReason, "aborted");
});

test("buffered output is bounded and aborted/revoked resumed compaction calls never reach a provider", async () => {
  let controllerSignal;
  const models = guardMemoryContextModels({ streamSimple(_model, _context, options) {
    controllerSignal = options.signal; const source = createAssistantMessageEventStream();
    source.push({ type: "done", reason: "stop", message: modelMessage("x".repeat(4 * 1024 * 1024 + 1)) }); source.end(); return source;
  }, completeSimple() { throw new Error("must not run"); }, complete() { throw new Error("must not run"); } }, () => ({ contaminated: true, validate: async () => {}, filter: async messages => messages }));
  const events = models.streamSimple(fakeModel, { messages: [] }, {}); const observed = [];
  for await (const event of events) observed.push(event);
  assert.equal((await events.result()).stopReason, "error"); assert.equal(controllerSignal.aborted, true);
  assert.equal(observed.every(event => event.error?.content.length === 0), true);
  for (const method of ["completeSimple", "complete"]) assert.throws(() => models[method](fakeModel, { messages: [{ content: secret }] }, { signal: AbortSignal.abort() }), error => error.code === "memory_compaction_disabled");
});


test("reopening a saved compaction summarize checkpoint after revocation or abort makes no model call and commits no summary", async () => {
  for (const abortRequested of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "ghost-memory-compaction-reopen-")); const f = fixture(); let runtime;
    try {
      runtime = await opened(root, f); await runtime.handle(envelope("before-saved-compaction", "Recall allowed evidence.")); await runtime.waitForIdle(ghost, conversation);
      await runtime.close(); runtime = null; f.revoke();
      const stored = await openPiConversationStorage(root, ghost, conversation);
      let taskId;
      try {
        const conv = await stored.database.get("SELECT id FROM conversations LIMIT 1");
        const last = await stored.database.get("SELECT MAX(id) AS id FROM entries WHERE conversation_id = ?", conv.id);
        taskId = (await stored.database.get("SELECT MAX(id) AS id FROM tasks")).id + 100;
        const record = { id: taskId, conversationId: conv.id, kind: "pi.compaction", version: 1, input: { reason: "manual" }, background: false, abortRequested,
          state: { status: "running", checkpoint: { phase: "summarize", attempt: 1, model: { provider: "ghost-local", modelId: localModel }, thinkingLevel: "off", streamOptions: {}, maxTokens: 100, tail: last.id, firstKept: last.id } } };
        await stored.database.run("INSERT INTO tasks (id,conversation_id,kind,status,abort_requested,background,record) VALUES (?,?,'pi.compaction','running',?,0,?)", taskId, conv.id, abortRequested ? 1 : 0, JSON.stringify(record));
      } finally { await stored.database.close(); }
      const before = f.requests.length;
      runtime = await opened(root, f);
      const body = { method: "runtime.reconcile", ghost_id: ghost, conversation_id: conversation };
      await runtime.handle({ protocol_version: "ghost-lifetime/1", command_id: "reconcile-memory-compaction", payload_digest: payloadDigest(body), actor_ref: ghost, authority_epoch: 1, expected_revision: null, correlation_id: "reconcile-memory-compaction", body });
      await runtime.waitForIdle(ghost, conversation);
      assert.equal(f.requests.length, before);
      await runtime.close(); runtime = null;
      const checked = await openPiConversationStorage(root, ghost, conversation);
      try {
        const task = JSON.parse((await checked.database.get("SELECT record FROM tasks WHERE id = ?", taskId)).record);
        assert.equal(task.state.status, "terminal"); assert.notEqual(task.state.outcome.status, "completed");
        const summaries = await checked.database.all("SELECT record FROM entries WHERE json_extract(record, '$.kind') = 'pi.compaction'");
        assert.equal(summaries.length, 0);
      } finally { await checked.database.close(); }
    } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
  }
});


test("a scoped Work assignment after Owner memory revocation never receives private Owner history or memory authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-memory-assignment-scope-")); const f = fixture(); let runtime;
  try {
    runtime = await opened(root, f); await runtime.handle(envelope("private-memory-owner", "Recall permitted personal evidence.")); await runtime.waitForIdle(ghost, conversation);
    f.revoke(); const callbackBoundary = f.callbacks.length;
    const assignment = { id: "scoped-assignment", source_command_id: "source-scoped-assignment", ghost_id: ghost, conversation_id: conversation,
      goal_id: "scope-goal", goal_revision: 1, work_id: "scope-work", prompt: "A separate scoped Work with no personal memory capability.", privacy: "private", origin_kind: "owner_goal", parent_work_id: null, root_goal_id: "scope-goal" };
    f.assignments.set(assignment.id, assignment);
    const body = { method: "conversation.assignment", ghost_id: ghost, conversation_id: conversation, goal_id: assignment.goal_id, goal_revision: 1, work_id: assignment.work_id, prompt: assignment.prompt, privacy: "private" };
    const request = { protocol_version: "ghost-lifetime/1", command_id: assignment.id, payload_digest: payloadDigest(body), actor_ref: ghost, authority_epoch: 1, expected_revision: null, correlation_id: assignment.id, body };
    assert.equal((await runtime.handle(request)).status, "success"); await runtime.waitForIdle(ghost, conversation);
    assert.equal(f.requests.length, 3); assert.equal(JSON.stringify(f.requests[2]).includes(secret), false); assert.equal(JSON.stringify(f.requests[2]).includes(derived), false);
    assert.equal(f.requests[2].tools.some(tool => tool.function.name.startsWith("memory_")), false);
    assert.equal(f.callbacks.slice(callbackBoundary).some(input => input.method.startsWith("memory.")), false);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});


test("a pending memory-derived answer is not resent after lost ACK, revocation and reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-memory-reply-reopen-")); const f = fixture(); let runtime, replies = 0;
  const originalTransport = f.transport;
  f.transport = async input => {
    if (input.method === "conversation.reply") {
      replies += 1; assert.equal(input.memory_context_revision, "a".repeat(64));
      if (replies === 1) { f.revoke(); throw new Error("ACK lost after original journal projection"); }
    }
    return originalTransport(input);
  };
  try {
    runtime = await opened(root, f); await runtime.handle(envelope("pending-memory-reply", "Recall and answer.")); await runtime.waitForIdle(ghost, conversation);
    assert.equal(replies, 1); const before = f.requests.length;
    await runtime.close(); runtime = null;
    runtime = await opened(root, f); await runtime.handle(envelope("pending-memory-reply", "Recall and answer.")); await runtime.waitForIdle(ghost, conversation);
    assert.equal(replies, 1); assert.equal(f.requests.length, before);
    const index = await openGhostIndex(root, ghost);
    try { assert.equal((await index.get("SELECT reply_state FROM ghost_canonical_turns WHERE turn_id = ?", "pending-memory-reply")).reply_state, "blocked"); } finally { await index.close(); }
    await runtime.handle(envelope("after-blocked-reply", "A fresh independent request.")); await runtime.waitForIdle(ghost, conversation);
    assert.equal(f.requests.length, before + 1); assert.equal(JSON.stringify(f.requests.at(-1)).includes(secret), false);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("Host denial between final context inspection and reply projection blocks the stored reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-memory-reply-race-")); const f = fixture(); let runtime;
  const originalTransport = f.transport;
  f.transport = input => { if (input.method === "conversation.reply") f.revoke(); return originalTransport(input); };
  try {
    runtime = await opened(root, f); await runtime.handle(envelope("reply-race", "Recall permitted evidence.")); await runtime.waitForIdle(ghost, conversation);
    const index = await openGhostIndex(root, ghost);
    try { assert.equal((await index.get("SELECT reply_state FROM ghost_canonical_turns WHERE turn_id = ?", "reply-race")).reply_state, "blocked"); } finally { await index.close(); }
    assert.equal(f.callbacks.find(input => input.method === "conversation.reply").memory_context_revision, "a".repeat(64));
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
