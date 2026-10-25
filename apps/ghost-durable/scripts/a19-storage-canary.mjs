// Actual SDK persistence with a deterministic faux provider; no network inference.
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { openGhostRuntime } from "../src/runtime.js";
import { payloadDigest } from "../src/contract.js";
import { createFakeProvider } from "../test/fake-provider.js";
const [mode, root, ghost, conversation, epochText] = process.argv.slice(2);
const epoch = Number(epochText);
assert(["seed", "inspect"].includes(mode) && Number.isSafeInteger(epoch) && epoch > 0);
const runtime = await openGhostRuntime({
  root, mode: "fixture", modelProvider: createFakeProvider(mode === "seed"
    ? [fauxAssistantMessage([fauxText("A19 committed source-generation history.")])] : []),
  hostToolTransport: async () => ({status:"success",data:{available_tools:[],inference_scope:"public",authority_epoch:epoch}}),
});
function command(id, body) {
  return {protocol_version:"ghost-lifetime/1",command_id:id,payload_digest:payloadDigest(body),actor_ref:"owner",authority_epoch:epoch,expected_revision:null,correlation_id:id,body};
}
try {
  if (mode === "seed") {
    assert.equal((await runtime.handle(command("a19-history-ensure", {method:"conversation.ensure",ghost_id:ghost,conversation_id:conversation}))).status,"success");
    assert.equal((await runtime.handle(command("a19-history-submit", {method:"conversation.submit",ghost_id:ghost,conversation_id:conversation,prompt:"Keep this synthetic prior source-generation history.",privacy:"public",goal_id:"a19-storage-fixture",goal_revision:1}))).status,"success");
    await runtime.waitForIdle(ghost,conversation);
  }
  const result=await runtime.handle(command(`a19-history-inspect-${epoch}`,{method:"conversation.inspect",ghost_id:ghost,conversation_id:conversation}));
  assert.equal(result.status,"success");
  assert(JSON.stringify(result.data.committed_view).includes("A19 committed source-generation history."));
  process.stdout.write(JSON.stringify({ghost_id:result.data.ghost_id,conversation_id:result.data.conversation_id,pi_conversation_id:result.data.pi_conversation_id,storage_ref:result.data.storage_ref,committed_view:result.data.committed_view})+"\n");
} finally {await runtime.close();}
