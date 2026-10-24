import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGhostRuntime } from "../src/runtime.js";
import { createBrokerModelProvider } from "../src/models.js";
import { payloadDigest } from "../src/contract.js";
import { openGhostIndex } from "../src/storage.js";

test("only exact Host bot evaluation root provenance admits the evaluation assignment", async () => {
  for (const [origin, parent, rootGoal, accepted] of [["bot_evaluation", null, "goal", true], ["bot_evaluation", "parent", "goal", false], ["bot_evaluation", null, "foreign", false], ["model_approved_bot", null, "goal", false]]) {
    const root = await mkdtemp(join(tmpdir(), "ghost-bot-eval-origin-")); let runtime, calls = 0; const runs = new Map();
    const assignment = { id: "assignment", source_command_id: "source", ghost_id: "ghost", conversation_id: "conversation", goal_id: "goal", goal_revision: 1, work_id: "work", prompt: "Evaluate immutable candidate.", privacy: "public", origin_kind: origin, parent_work_id: parent, root_goal_id: rootGoal };
    const transport = async input => {
      if (input.method === "inference.inspect") return { status: "success", data: { inference_scope: "public", authority_epoch: 1 } };
      if (input.method === "conversation.assignment.inspect") return { status: "success", data: { assignment, execution: { engine: "pi", version: 1 } } };
      if (input.method === "conversation.turn.inspect") return { status: "success", data: { run: runs.get(input.turn_id) ?? { turn_id: input.turn_id, ghost_id: "ghost", conversation_id: "conversation", state: "queued", cancel_requested: false, cancel_command_id: null, submission_id: null, entry_id: null, reason_code: null, latest_status_command_id: null, created_at_ms: 1, updated_at_ms: 1 } } };
      if (input.method === "conversation.turn_status") { const run = { turn_id: input.turn_id, ghost_id: "ghost", conversation_id: "conversation", state: input.arguments.status, cancel_requested: false, cancel_command_id: null, submission_id: input.arguments.submission_id, entry_id: input.arguments.entry_id, reason_code: input.arguments.reason_code, latest_status_command_id: input.invocation_id, created_at_ms: 1, updated_at_ms: 2 }; runs.set(input.turn_id, run); return { status: "success", data: { run } }; }
      if (input.method === "work.execution.complete") return { status: "success", data: { assignment_id: "assignment", work_id: "work", task_id: input.task_id } };
      throw new Error(`Unexpected callback ${input.method}`);
    };
    const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => { calls++; return { id: request.id, status: 200, body: { id: "completion", object: "chat.completion", model: "minimax-code/MiniMax-M2.7", created: 1, choices: [{ index: 0, message: { role: "assistant", content: "Evaluation output remains subject to independent Host verification." }, finish_reason: "stop" }] } }; } });
    try {
      runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: transport });
      const body = { method: "conversation.assignment", ghost_id: "ghost", conversation_id: "conversation", goal_id: "goal", goal_revision: 1, work_id: "work", prompt: assignment.prompt, privacy: "public" };
      const receipt = await runtime.handle({ protocol_version: "ghost-lifetime/1", command_id: "assignment", payload_digest: payloadDigest(body), actor_ref: "ghost", authority_epoch: 1, expected_revision: null, correlation_id: "source", body });
      assert.equal(receipt.status, accepted ? "success" : "error", JSON.stringify(receipt));
      await runtime.waitForIdle("ghost", "conversation"); assert.equal(calls, accepted ? 1 : 0);
      if (!accepted) assert.equal(receipt.error_code, "goal_assignment_inspection_invalid");
      if (accepted) {
        await runtime.close(); runtime = null;
        const index = await openGhostIndex(root, "ghost");
        try {
          // Recreate the preceding release's constraint, with a valid legacy
          // assignment row. Reopening must preserve its immutable identity.
          await index.run("UPDATE ghost_canonical_assignments SET assignment_origin = 'owner_goal'");
          const schema = await index.get("SELECT sql FROM sqlite_master WHERE name = 'ghost_canonical_assignments'");
          await index.transaction(async transaction => {
            await transaction.exec("ALTER TABLE ghost_canonical_assignments RENAME TO legacy_test_assignments");
            await transaction.exec(schema.sql.replace(", 'bot_evaluation'", ""));
            await transaction.exec("INSERT INTO ghost_canonical_assignments SELECT * FROM legacy_test_assignments");
            await transaction.exec("DROP TABLE legacy_test_assignments");
          });
        } finally { await index.close(); }
        runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: transport });
        // Open the Ghost through a read-only runtime command; no new model run.
        const inspectBody = { method: "conversation.inspect", ghost_id: "ghost", conversation_id: "conversation" };
        await runtime.handle({ protocol_version: "ghost-lifetime/1", command_id: "reopen-inspect", payload_digest: payloadDigest(inspectBody), actor_ref: "ghost", authority_epoch: 1, expected_revision: null, correlation_id: "source", body: inspectBody });
        const reopened = await openGhostIndex(root, "ghost");
        try {
          assert.equal((await reopened.get("SELECT sql FROM sqlite_master WHERE name = 'ghost_canonical_assignments'")).sql.includes("'bot_evaluation'"), true);
          assert.equal((await reopened.get("SELECT assignment_id FROM ghost_canonical_assignments")).assignment_id, "assignment");
        } finally { await reopened.close(); }
        assert.equal(calls, 1);
      }
    } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
  }
});
