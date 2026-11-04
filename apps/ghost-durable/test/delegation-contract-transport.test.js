import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostToolTransport } from "../src/host-transport.js";
import { payloadDigest } from "../src/contract.js";

test("sealed delegation forwards only its reference with revision and outer memory provenance", async () => {
  const requests = [];
  const transport = createHostToolTransport({ hostRoot: "/tmp/delegation-contract-fixture", callbackToken: "fixture", localCallbackToken: "fixture-local", authorityEpoch: 4, dispatch: async request => {
    requests.push(request);
    const method = request.envelope.body.method;
    return { ok: true, result: { status: "success", summary: "fixture", artifacts: [], next_actions: [], data: method === "work.inspect" ? { work: { id: "parent", goal_id: "goal", goal_revision: 7, owner: "ghost" } } : method === "goal.inspect" ? { goal: { id: "goal", revision: 7, accountable_ghost: "ghost", reply_conversation: "conversation", acceptance_spec: {} } } : {} } };
  } });
  const args = { parent_work_id: "parent", contract_ref: `dc-${"a".repeat(64)}` };
  const input = { method: "work.delegate", ghost_id: "ghost", conversation_id: "conversation", invocation_id: "same-call", inference_scope: "local", conversation_disclosure: "non_public", work_memory_context_revision: "b".repeat(64), arguments: args };
  await transport(input);
  await transport(input);
  const mutations = requests.filter(request => request.envelope.body.method === "work.delegate");
  assert.equal(mutations.length, 2);
  assert.deepEqual(mutations[0], mutations[1]);
  const envelope = mutations[0].envelope;
  assert.deepEqual(envelope.body, { method: "work.delegate", ...args, work_memory_context_revision: "b".repeat(64) });
  assert.equal(envelope.expected_revision, 7);
  assert.equal(envelope.actor_ref, "ghost");
  assert.equal(envelope.payload_digest, payloadDigest(envelope.body));
  for (const bad of [{ contract_ref: null }, { contract_ref: "invented" }, { summary: "override" }, { target_ghost_id: "other" }, { acceptance_spec: {} }, { artifact_refs: [] }, { work_memory_context_revision: "c".repeat(64) }]) {
    await assert.rejects(transport({ ...input, arguments: { ...args, ...bad } }));
  }
  assert.equal(requests.filter(request => request.envelope.body.method === "work.delegate").length, 2, "malformed or mixed authority cannot reach mutation");
});

test("ordinary delegation without input artifacts commits an empty canonical array", async () => {
  const requests = [];
  const transport = createHostToolTransport({
    hostRoot: "/tmp/delegation-no-attachment-fixture", callbackToken: "fixture", authorityEpoch: 4,
    dispatch: async ({ envelope }) => {
      requests.push(envelope);
      const data = envelope.body.method === "work.inspect"
        ? { work: { id: "parent", goal_id: "goal", goal_revision: 7, owner: "ghost" } }
        : envelope.body.method === "goal.inspect"
          ? { goal: { id: "goal", revision: 7, accountable_ghost: "ghost", reply_conversation: "conversation", acceptance_spec: {} } }
          : {};
      return { ok: true, result: { status: "success", summary: "fixture", artifacts: [], next_actions: [], data } };
    },
  });
  const args = { parent_work_id: "parent", target_ghost_id: "specialist", summary: "Write a synthetic result.", acceptance_spec: { delegation_allowed: false } };
  await transport({ method: "work.delegate", ghost_id: "ghost", conversation_id: "conversation",
    invocation_id: "no-input", inference_scope: "public", conversation_disclosure: "public", arguments: args });
  const delegated = requests.find(envelope => envelope.body.method === "work.delegate");
  assert.deepEqual(delegated.body, { method: "work.delegate", ...args, artifact_refs: [] });
  assert.equal(delegated.expected_revision, 7);
  assert.equal(delegated.payload_digest, payloadDigest(delegated.body));
});
