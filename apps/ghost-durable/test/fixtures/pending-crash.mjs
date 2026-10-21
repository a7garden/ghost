import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { openGhostRuntime } from "../../src/runtime.js";
import { payloadDigest } from "../../src/contract.js";
import { createFakeProvider } from "../fake-provider.js";

const root = process.argv[2];
const hold = setInterval(() => {}, 1000);
const provider = createFakeProvider([
  fauxAssistantMessage([fauxToolCall("work_submit", { work_id: "crash-work" })], { stopReason: "toolUse" }),
]);
const runtime = await openGhostRuntime({
  root: join(root, "durable"), mode: "fixture", modelProvider: provider,
  hostToolTransport: async invocation => {
    await writeFile(join(root, "effect.json"), JSON.stringify({ invocation_id: invocation.invocation_id, effect_count: 1 }));
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
