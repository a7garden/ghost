import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserWaitTask, isBrowserOwnerWait, waitForBrowserOwner } from "../src/browser-wait.js";
import { createDirectWorkTools } from "../src/direct-work.js";

const request = { invocation_id: "original-invocation", operation: "browser", arguments: { operation: "click", ref: "observed-target", snapshot_id: 1 } };
const waiting = { status: "warning", data: { action_id: "original-owner-action", receipt: { state: "waiting_owner" } } };
const completed = { status: "success", data: { receipt: { state: "complete" } } };

test("re-entering a browser wait transaction finds the same owned child instead of creating a second task", async () => {
  const records = []; let created = 0;
  const task = createBrowserWaitTask({ dispatch: async () => completed, validate: async () => {}, verifyReceipt: () => true });
  const api = { taskId: 8, conversationId: 1, commit: async fn => fn({ scanTasks: async () => ({ items: records }), createTask: async (definition, input, options) => {
    created += 1; const id = 100 + created; records.push({ id, kind: definition.definition.name, owner: options.ownership.taskId, input }); return id;
  } }), waitForTask: async () => ({ state: { status: "terminal", outcome: { status: "completed", result: completed } } }) };
  for (let i = 0; i < 2; i += 1) assert.deepEqual(await waitForBrowserOwner({ api, task, input: request, response: waiting, context: {} }), completed);
  assert.equal(created, 1);
  await assert.rejects(waitForBrowserOwner({ api, task, input: { ...request, arguments: { operation: "click", ref: "changed" } }, response: waiting, context: {} }));
  assert.equal(created, 1);
});

test("a changed approval action or lost poll receipt stops the deterministic child without a retry phase", async () => {
  for (const dispatch of [async () => ({ ...waiting, data: { ...waiting.data, action_id: "other-action" } }), async () => { throw Error("ACK lost"); }]) {
    const task = createBrowserWaitTask({ dispatch, validate: async () => {}, verifyReceipt: () => true }); let state;
    await task.definition.phases.poll({ input: { request, action_id: waiting.data.action_id } }, { commit: async fn => { state = await fn(); }, now: () => 1 }, {});
    assert.equal(state.status, "terminal"); assert.equal(state.outcome.result.error_code, "pi_effect_unconfirmed");
  }
  assert.equal(isBrowserOwnerWait({ status: "warning", data: { receipt: { state: "pending" } } }), false);
});

test("only the receipt-mediated browser registration can recover safely; raw tools remain unsafe", () => {
  const browserWaitTask = createBrowserWaitTask({ dispatch: async () => completed, validate: async () => {}, verifyReceipt: () => true });
  const tools = createDirectWorkTools({ controllerContext: {}, browserWaitTask });
  for (const tool of tools) assert.equal(tool.replay, tool.name === "browser" ? "safe" : "unsafe");
  for (const operation of ["key", "scroll"]) {
    const schema = tools.find(tool => tool.name === "browser").parameters.anyOf.find(option => option.properties.operation.const === operation);
    assert.equal(schema.required.includes("ref"), true); assert.equal(schema.required.includes("snapshot_id"), true);
  }
});


test("aborting an approval child settles it without polling or performing an action", async () => {
  let dispatched = 0, state;
  const task = createBrowserWaitTask({ dispatch: async () => { dispatched += 1; return completed; }, validate: async () => {}, verifyReceipt: () => true });
  await task.definition.abort({ input: { request, action_id: waiting.data.action_id } }, { commit: async fn => { state = await fn(); } }, {});
  assert.equal(dispatched, 0); assert.deepEqual(state, { status: "terminal", outcome: { status: "aborted" } });
});
