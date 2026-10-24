import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { validateWorkInputArtifacts } from "../src/work-inputs.js";
function input() {
  const digest = "a".repeat(64), work_id = "child-work";
  return { work_id, goal_id: "child-goal", goal_revision: 1, execution_id: "child-execution",
    path: `input-${createHash("sha256").update(work_id).digest("hex")}-${digest}`,
    artifact: { digest, locator: "artifact://child/result", privacy: "public", producing_attempt: "child-execution" } };
}

test("child Work inputs preserve authoritative metadata and only deterministic local staged paths", () => {
  const record = input(); assert.deepEqual(validateWorkInputArtifacts([record], "public"), [record]);
  assert.deepEqual(validateWorkInputArtifacts([], "public"), []);
  for (const changed of [{ ...record, path: "../../secret" }, { ...record, work_id: "different-child" }, { ...record, artifact: { ...record.artifact, privacy: "private" } }, { ...record, goal_revision: 0 }, { ...record, owner_approved: true }]) assert.throws(() => validateWorkInputArtifacts([changed], "public"), error => error.code === "work_input_artifacts_invalid");
  assert.throws(() => validateWorkInputArtifacts([record, record], "public"), /staged path/);
});
