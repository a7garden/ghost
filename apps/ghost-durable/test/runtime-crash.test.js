import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { openGhostRuntime } from "../src/runtime.js";
import { payloadDigest } from "../src/contract.js";
import { createFakeProvider } from "./fake-provider.js";

function within(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("durable crash fixture did not reach its barrier")), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
function request(id, method) {
  const body = { method, ghost_id: "crash-ghost", conversation_id: "crash-conversation" };
  return { protocol_version: "ghost-lifetime/1", command_id: id, payload_digest: payloadDigest(body), actor_ref: "crash-actor", authority_epoch: 1, expected_revision: null, correlation_id: id, body };
}

test("explicit reconciliation resumes a crashed tool slot without repeating a committed external effect", async t => {
  const repo = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const base = join(repo, ".lifetime-canary", "ghost-20261009T012047Z", "B6-tests", "crash");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, "lost-tool-ack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/pending-crash.mjs", import.meta.url)), root], { stdio: ["ignore", "pipe", "pipe"] });
  let fixtureStderr = "";
  child.stderr.on("data", (chunk) => {
    fixtureStderr = (fixtureStderr + chunk.toString()).slice(-4096);
  });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const stages = new Map();
  const committed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => { if (stages.size < 2) reject(new Error("fixture child exited before committing its effect")); });
    lines.on("line", line => {
      try { const stage = JSON.parse(line); stages.set(stage.stage, stage); if (stages.has("input_admitted") && stages.has("effect_committed")) resolve(); }
      catch (error) { reject(error); }
    });
  });
  try {
    await within(committed, 15_000);
  } catch (error) {
    throw new Error(`${error.message}; observed stages: ${[...stages.keys()].join(",")}; fixture stderr: ${fixtureStderr}`, { cause: error });
  }
  assert.equal(stages.get("input_admitted").status, "success");
  child.kill("SIGKILL");
  await exited;

  const original = JSON.parse(await readFile(join(root, "effect.json"), "utf8"));
  let resumedId;
  let markReplayed;
  const replayed = new Promise(resolve => { markReplayed = resolve; });
  const runtime = await openGhostRuntime({
    root: join(root, "durable"), mode: "fixture",
    modelProvider: createFakeProvider([fauxAssistantMessage([fauxText("Fixture turn completed.")])]),
    hostToolTransport: async invocation => {
      resumedId = invocation.invocation_id;
      assert.equal(resumedId, original.invocation_id);
      markReplayed();
      return { status: "success", data: { execution_id: "committed-fixture-execution" } };
    },
  });
  t.after(() => runtime.close());
  const inspected = await runtime.handle(request("read-before-recovery", "conversation.inspect"));
  assert.equal(inspected.status, "success");
  assert.equal(resumedId, undefined);
  const recovered = await runtime.handle(request("explicit-recovery", "runtime.reconcile"));
  assert.equal(recovered.status, "success");
  await within(replayed, 15_000);
  await runtime.waitForIdle("crash-ghost", "crash-conversation");
  const effect = JSON.parse(await readFile(join(root, "effect.json"), "utf8"));
  assert.equal(effect.effect_count, 1);
  assert.equal(resumedId, effect.invocation_id);
});
