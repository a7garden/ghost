import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryQueryArguments, memoryQueryProperties } from "../src/memory-query.js";
import { createHostToolTransport } from "../src/host-transport.js";

test("temporal scope preserves exact signed timestamps and rejects rounded or coerced values", () => {
  assert.deepEqual(memoryQueryArguments({ as_of: 0, known_at: -1, planes: ["memory"] }), { as_of: 0, known_at: -1, planes: ["memory"] });
  assert.deepEqual(memoryQueryArguments({}), {});
  for (const value of [null, "2026-01-01", 1.1, Number.MAX_SAFE_INTEGER + 1, Infinity]) assert.throws(() => memoryQueryArguments({ as_of: value }));
  for (const planes of [[], ["memory", "memory"], ["elsewhere"], "memory"]) assert.throws(() => memoryQueryArguments({ planes }));
  const fields = memoryQueryProperties();
  assert.equal(fields.as_of.minimum, Number.MIN_SAFE_INTEGER);
  assert.equal(fields.known_at.maximum, Number.MAX_SAFE_INTEGER);
});

test("Owner and Work temporal wire fields never confer memory scope or lose unsupported document intent", async () => {
  const requests = [];
  const transport = createHostToolTransport({ hostRoot: "/tmp/memory-temporal-fixture", callbackToken: "fixture", localCallbackToken: "local-fixture", authorityEpoch: 1,
    dispatch: async input => { requests.push(input); return { ok: true, result: { status: "error", error_code: "unsupported_temporal_scope", summary: "Documents temporal scope is unsupported", artifacts: [], next_actions: [], data: { plane: "documents" } } }; } });
  const scope = { ghost_id: "ghost", conversation_id: "conversation", inference_scope: "local", conversation_disclosure: "non_public" };
  const temporal = { query: "historical agreement", as_of: 1000, known_at: 2000, planes: ["documents"] };
  for (const method of ["memory.search", "memory.recall", "work.memory.recall"]) {
    const work = method.startsWith("work.");
    const response = await transport({ ...scope, method, invocation_id: method, ...(work ? { assignment_id: "assignment", work_id: "work" } : { turn_id: "turn" }), arguments: temporal });
    assert.equal(response.error_code, "unsupported_temporal_scope");
    assert.deepEqual(requests.at(-1).envelope.body, { method, ghost_id: "ghost", conversation_id: "conversation", ...(work ? { assignment_id: "assignment", work_id: "work" } : { turn_id: "turn" }), ...temporal });
    for (const forbidden of [{ space: "private-other" }, { token: "secret" }, { as_of: null }, { known_at: Number.MAX_SAFE_INTEGER + 1 }]) await assert.rejects(transport({ ...scope, method, invocation_id: `${method}-invalid`, ...(work ? { assignment_id: "assignment", work_id: "work" } : { turn_id: "turn" }), arguments: { ...temporal, ...forbidden } }));
  }
  assert.equal(requests.length, 3);
});
