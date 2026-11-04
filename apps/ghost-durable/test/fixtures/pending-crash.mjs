import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { openGhostRuntime } from "../../src/runtime.js";
import { payloadDigest } from "../../src/contract.js";
import { createFakeProvider } from "../fake-provider.js";

const root = process.argv[2];
const legacyAdmission = ["legacy-admission", "legacy-steer"].includes(process.argv[3]);
const legacySteer = process.argv[3] === "legacy-steer";
let openRuntime = openGhostRuntime;
if (legacyAdmission) {
  // Test-only pre-fence receiver: persist an actual safe SDK tool intent after
  // the old handler has sent its callback. Production source is never edited.
  const sourceUrl = new URL("../../src/runtime.js", import.meta.url);
  let source = await readFile(sourceUrl, "utf8");
  const start = source.indexOf("      // BEGIN model admission recovery fence\n");
  const endMarker = "      // END model admission recovery fence\n";
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < start) throw new Error("Historical admission fixture fence was not found");
  source = source.slice(0, start) + source.slice(end + endMarker.length);
  source = source.replaceAll(' && tool.name !== "work_submit"', "");
  source = source.replaceAll(' && tool.name !== "work_steer"', "");
  source = source.replace(/from (["'])([^"']+)\1/g, (statement, quote, specifier) => {
    if (specifier.startsWith("node:")) return statement;
    const resolved = specifier.startsWith(".") ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier);
    return `from ${quote}${resolved}${quote}`;
  });
  ({ openGhostRuntime: openRuntime } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`));
}
const hold = setInterval(() => {}, 1000);
const provider = createFakeProvider([
  fauxAssistantMessage([fauxToolCall(legacySteer ? "work_steer" : legacyAdmission ? "work_submit" : "work_cancel", { work_id: "crash-work", ...(legacySteer ? { prompt: "Original steering intent." } : {}) })], { stopReason: "toolUse" }),
]);
const runtime = await openRuntime({
  root: join(root, "durable"), mode: "fixture", modelProvider: provider,
  hostToolTransport: async invocation => {
    if (invocation.method !== (legacySteer ? "work.steer" : legacyAdmission ? "work.submit" : "work.cancel")) throw new Error("Unexpected crash-fixture callback");
    await writeFile(join(root, "effect.json"), JSON.stringify({ invocation_id: invocation.invocation_id, method: invocation.method, effect_count: 1 }));
    process.stdout.write(JSON.stringify({ stage: "effect_committed", invocation_id: invocation.invocation_id }) + "\n");
    await new Promise(() => {});
  },
});
const body = { method: "conversation.submit", ghost_id: "crash-ghost", conversation_id: "crash-conversation", prompt: "Recover the committed effect after a lost ACK.", privacy: "public", goal_id: "crash-goal", goal_revision: 1 };
const admitted = await runtime.handle({ protocol_version: "ghost-lifetime/1", command_id: "crash-input", payload_digest: payloadDigest(body), actor_ref: "crash-actor", authority_epoch: 1, expected_revision: null, correlation_id: "crash-input", body });
process.stdout.write(JSON.stringify({ stage: "input_admitted", status: admitted.status }) + "\n");
await runtime.waitForIdle("crash-ghost", "crash-conversation");
clearInterval(hold);
await runtime.close();
