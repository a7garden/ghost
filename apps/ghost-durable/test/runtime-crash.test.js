import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { openGhostRuntime } from "../src/runtime.js";
import { payloadDigest } from "../src/contract.js";
import { createFakeProvider } from "./fake-provider.js";

const fixtureRoots = new Set();
after(async () => {
  for (const root of fixtureRoots) await rm(root, { recursive: true, force: true });
});

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

for (const legacyMode of [null, "legacy-admission", "legacy-steer"]) {
const legacyAdmission = legacyMode !== null;
const toolName = legacyMode === "legacy-steer" ? "work_steer" : "work_submit";
test(legacyAdmission
  ? `retained old safe ${toolName} task is fenced on reopen without relabeling its prior external effect`
  : "explicit reconciliation resumes a crashed tool slot without repeating a committed external effect", async t => {
  const repo = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const base = join(repo, ".lifetime-canary", "ghost-20261009T012047Z", "B6-tests", "crash");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, "lost-tool-ack-"));
  fixtureRoots.add(root);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/pending-crash.mjs", import.meta.url)), root, ...(legacyAdmission ? [legacyMode] : [])], { stdio: ["ignore", "pipe", "pipe"] });
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

  const originalBytes = await readFile(join(root, "effect.json"), "utf8");
  const original = JSON.parse(originalBytes);
  assert.equal(original.method, legacyAdmission ? toolName.replace("_", ".") : "work.cancel");
  const key = value => createHash("sha256").update(value).digest("hex");
  const databasePath = join(root, "durable", key("crash-ghost"), key("crash-conversation"), "durable.sqlite");
  let historicalAssistant;
  let assistantId;
  if (legacyAdmission) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const pending = database.prepare("SELECT record FROM tasks WHERE kind=? AND status='running'").all(JSON.stringify("pi.tool"))
        .map(row => JSON.parse(row.record));
      assert.equal(pending.length, 1);
      assert.equal(pending[0].state.checkpoint.phase, "execute");
      assert.equal(pending[0].state.checkpoint.replay, "safe");
      assert.equal(pending[0].state.checkpoint.arguments.work_id, "crash-work");
      assistantId = pending[0].input.assistant;
      historicalAssistant = database.prepare("SELECT record FROM entries WHERE id=?").get(assistantId).record;
      assert.ok(historicalAssistant.includes(`"name":"${toolName}"`));
    } finally { database.close(); }
  }
  let resumedId;
  const resumedCalls = [];
  let markReplayed;
  const replayed = new Promise(resolve => { markReplayed = resolve; });
  const runtime = await openGhostRuntime({
    root: join(root, "durable"), mode: "fixture",
    modelProvider: createFakeProvider([fauxAssistantMessage([fauxText("Fixture turn completed.")])]),
    hostToolTransport: async invocation => {
      resumedCalls.push(invocation);
      assert.equal(legacyAdmission, false, "a restored model admission handler must not send another Host callback");
      assert.equal(invocation.method, "work.cancel");
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
  if (!legacyAdmission) await within(replayed, 15_000);
  await within(runtime.waitForIdle("crash-ghost", "crash-conversation"), 15_000);
  const effect = JSON.parse(await readFile(join(root, "effect.json"), "utf8"));
  assert.equal(effect.effect_count, 1);
  assert.equal(await readFile(join(root, "effect.json"), "utf8"), originalBytes);
  if (legacyAdmission) {
    assert.equal(resumedId, undefined);
    assert.equal(resumedCalls.length, 0);
    const inspected = await runtime.handle(request("inspect-fenced-history", "conversation.inspect"));
    const receipt = inspected.data.durable_results.flatMap(entry => entry.model ?? [])
      .find(message => message.toolName === toolName);
    assert.equal(receipt.isError, true);
    assert.equal(receipt.details.status, "error");
    assert.equal(receipt.details.data?.host_effect_class, undefined, "the new fence cannot declare an old pending effect absent");
    assert.ok(receipt.details.summary.includes("prior submission or effect retains its original outcome"));
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare("SELECT record FROM entries WHERE id=?").get(assistantId).record, historicalAssistant);
    } finally { database.close(); }
  } else {
    assert.equal(resumedId, effect.invocation_id);
    assert.equal(resumedCalls.length, 1);
  }
});
}
