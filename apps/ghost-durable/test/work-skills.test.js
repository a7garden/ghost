import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { validatePinnedWorkSkills, assertPinnedWorkSkills, renderPinnedWorkSkills } from "../src/work-skills.js";
import { payloadDigest } from "../src/contract.js";
function skill(content = "Original pinned procedure", privacy = "public") { return { name: "procedure", sha256: createHash("sha256").update(content).digest("hex"), privacy, content }; }

test("Work skill manifest validates exact UTF-8 bytes, disclosure, explicit identity and bounded aggregate", () => {
  const original = skill();
  assert.deepEqual(validatePinnedWorkSkills([original], "public"), [original]);
  for (const invalid of [[{ ...original, content: "changed" }], [original, original], [{ ...original, path: "/ambient/skill" }], [skill("private marker", "private")], [{ ...original, name: "../escape" }], [skill("x".repeat(262145))]]) {
    assert.throws(() => validatePinnedWorkSkills(invalid, "public"), error => error.code === "work_skill_manifest_invalid");
  }
  assert.throws(() => validatePinnedWorkSkills([skill("A".repeat(262144)), { ...skill("B".repeat(262144)), name: "second" }, { ...skill("C"), name: "third" }], "public"), /aggregate/);
});

test("old Work pins never adopt a reloaded registry revision and missing legacy pin cannot admit new skill bytes", () => {
  const old = [skill()], next = [skill("New registry revision")];
  const pin = payloadDigest(old);
  assert.doesNotThrow(() => assertPinnedWorkSkills(pin, old));
  assert.throws(() => assertPinnedWorkSkills(pin, next), error => error.code === "work_skill_pin_conflict");
  assert.throws(() => assertPinnedWorkSkills(undefined, next), error => error.code === "work_skill_pin_conflict");
  assert.doesNotThrow(() => assertPinnedWorkSkills(undefined, []));
  assert.match(renderPinnedWorkSkills(old), /never grants identity/);
  assert.match(renderPinnedWorkSkills(old), /Original pinned procedure/);
});
