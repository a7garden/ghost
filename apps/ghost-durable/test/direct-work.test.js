import assert from "node:assert/strict";
import { test } from "node:test";
import { createDirectWorkTools, directWorkInvocationId, validateDirectWorkIdentity, verifiedDirectWorkReceipt, assertPinnedExecutionTools } from "../src/direct-work.js";
import { payloadDigest } from "../src/contract.js";

const scope = { originKind: "goal_assignment", assignmentId: "assignment", workId: "work", inferenceScope: "public", conversationDisclosure: "public" };
function setup(transport, currentScope = scope, execution = { engine: "pi", version: 1 }) {
  const tools = createDirectWorkTools({ hostToolTransport: transport, ghostId: "ghost", conversationId: "conversation",
    resolveToolScope: async () => currentScope, controllerContext: { assignment: { id: "assignment", work_id: "work", execution }, generationTaskId: async () => 7 } });
  return Object.fromEntries(tools.map(tool => [tool.name, tool]));
}
const api = { taskId: 8, callId: "call-1" };

test("direct Pi tools use same Ghost, Work and stable SDK call identity without any local environment", async () => {
  const calls = [];
  const tools = setup(async input => { calls.push(input); return { status: "success", data: { receipt: { assignment_id: input.assignment_id, work_id: input.work_id, generation_task_id: input.generation_task_id, task_id: input.task_id, call_id: input.call_id, input_digest: input.input_digest, execution_id: "pi-fixture", state: "complete" } } }; });
  for (const tool of Object.values(tools)) assert.equal(tool.replay, "unsafe");
  await tools.write.execute({ path: "result.txt", content: "result" }, api, {});
  const [input] = calls;
  assert.equal(input.method, "work.execute");
  assert.equal(input.ghost_id, "ghost");
  assert.equal(input.assignment_id, "assignment");
  assert.equal(input.work_id, "work");
  assert.equal(input.generation_task_id, 7);
  assert.equal(input.task_id, 8);
  assert.equal(input.call_id, "call-1");
  assert.equal(input.input_digest, payloadDigest({ operation: "write", arguments: input.arguments }));
  assert.equal(input.invocation_id, directWorkInvocationId({ ghostId: "ghost", conversationId: "conversation", assignmentId: "assignment", workId: "work", taskId: 8, callId: "call-1" }));
  assert.deepEqual(Object.keys(input.arguments).sort(), ["content", "path"]);
});

test("owner turns, wrong Work, absent isolation binding and cancelled calls cannot reach the Host execution adapter", async () => {
  let calls = 0;
  const transport = async () => { calls += 1; };
  for (const tools of [setup(transport, { ...scope, originKind: "owner" }), setup(transport, { ...scope, workId: "other" }), setup(transport, scope, null)]) {
    assert.equal((await tools.bash.execute({ command: "true" }, api, {})).isError, true);
  }
  assert.equal((await setup(transport).bash.execute({ command: "true" }, api, { abortSignal: AbortSignal.abort() })).isError, true);
  assert.equal(calls, 0);
});

test("a lost effect receipt blocks subsequent direct calls instead of inventing a replacement identity", async () => {
  let calls = 0;
  const tools = setup(async () => { calls += 1; throw new Error("ACK lost"); });
  const result = await tools.bash.execute({ command: "append-effect" }, api, {});
  assert.equal(result.details.error_code, "pi_effect_unconfirmed");
  assert.equal((await tools.bash.execute({ command: "append-effect" }, { taskId: 9, callId: "new-call" }, {})).isError, true);
  assert.equal(calls, 1);
});

test("wire rejects altered input bytes or caller identity before dispatch", () => {
  const identity = { ghostId: "ghost", conversationId: "conversation", assignmentId: "assignment", workId: "work", generationTaskId: 7, taskId: 8, callId: "call-1", operation: "read", args: { path: "result.txt" } };
  const input = { ...identity, inputDigest: payloadDigest({ operation: identity.operation, arguments: identity.args }), invocationId: directWorkInvocationId(identity) };
  assert.doesNotThrow(() => validateDirectWorkIdentity(input));
  for (const change of [{ inputDigest: "0".repeat(64) }, { workId: "other" }, { args: { path: "other" } }, { generationTaskId: null }]) {
    assert.throws(() => validateDirectWorkIdentity({ ...input, ...change }), /bound assignment/);
  }
});


test("an unrelated or malformed success receipt is unknown and cannot authorize another effect", async () => {
  let calls = 0;
  const tools = setup(async () => { calls += 1; return { status: "success", data: { receipt: { work_id: "other-work", state: "complete" } } }; });
  assert.equal((await tools.write.execute({ path: "a", content: "a" }, api, {})).details.error_code, "pi_effect_unconfirmed");
  await tools.write.execute({ path: "b", content: "b" }, { taskId: 9, callId: "call-2" }, {});
  assert.equal(calls, 1);
  assert.equal(verifiedDirectWorkReceipt({ status: "success", data: {} }, {}), false);
});

test("browser requires an explicit Work tool grant and uses the same effect identity", async () => {
  const calls = [];
  const transport = async input => { calls.push(input); return { status: "success", data: { receipt: { assignment_id: input.assignment_id, work_id: input.work_id, generation_task_id: input.generation_task_id, task_id: input.task_id, call_id: input.call_id, input_digest: input.input_digest, execution_id: "pi-browser-fixture", state: "complete" } } }; };
  assert.equal((await setup(transport).browser.execute({ operation: "snapshot" }, api, {})).isError, true);
  assert.equal(calls.length, 0);
  const granted = setup(transport, scope, { engine: "pi", version: 1, tools: ["browser"] });
  assert.equal((await granted.browser.execute({ operation: "snapshot" }, api, {})).isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, "browser");
  assert.equal(calls[0].work_id, "work");
  assert.deepEqual(calls[0].arguments, { operation: "snapshot" });
});


test("old Work execution tool inventory can shrink but never gain a reloaded tool", () => {
  assert.doesNotThrow(() => assertPinnedExecutionTools(["read", "write", "browser"], ["read"]));
  assert.doesNotThrow(() => assertPinnedExecutionTools(["read"], []));
  assert.throws(() => assertPinnedExecutionTools(["read"], ["read", "browser"]), error => error.code === "pi_tool_pin_conflict");
});

test("write and edit enforce the Host's 64 KiB UTF-8 limit before dispatch", async () => {
  let calls = 0;
  const tools = setup(async () => { calls += 1; });
  assert.equal((await tools.write.execute({ path: "answer.txt", content: "한".repeat(21846) }, api, {})).isError, true);
  assert.equal((await tools.edit.execute({ path: "answer.txt", edits: [{ oldText: "old", newText: "x".repeat(65537) }] }, api, {})).isError, true);
  assert.equal(calls, 0);
});

test("bash command recipes preserve reference input identity and refuse mixed or malformed authority", async () => {
  const calls = [];
  const tools = setup(async input => {
    calls.push(input);
    return { status: "success", data: { receipt: { assignment_id: input.assignment_id, work_id: input.work_id, generation_task_id: input.generation_task_id, task_id: input.task_id, call_id: input.call_id, input_digest: input.input_digest, execution_id: "recipe-execution", state: "complete" } } };
  });
  const args = { command_ref: `pc-${"a".repeat(64)}`, timeout: 12 };
  assert.equal((await tools.bash.execute(args, api, {})).isError, false);
  assert.deepEqual(calls[0].arguments, args);
  assert.equal(calls[0].input_digest, payloadDigest({ operation: "bash", arguments: args }));
  for (const bad of [{ command: "override" }, { command_ref: null }, { command_ref: "invented" }, { timeout: null }, { timeout: 181 }, { timeout: 1.5 }, { actor_ref: "owner" }]) {
    const changed = { ...args, ...bad };
    assert.equal((await tools.bash.execute(changed, api, {})).isError, true);
    assert.throws(() => validateDirectWorkIdentity({ ghostId: "ghost", conversationId: "conversation", assignmentId: "assignment", workId: "work", taskId: api.taskId, callId: api.callId, generationTaskId: 7, operation: "bash", args: changed, inputDigest: payloadDigest({ operation: "bash", arguments: changed }), invocationId: calls[0].invocation_id }));
  }
  assert.equal(calls.length, 1, "denied inputs never reach Host effects");
});
