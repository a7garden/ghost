// Opt-in disposable external-inference bridge. The caller supplies every
// identity, endpoint and command; no installed Host or credential discovery is
// allowed and no loopback local route exists here.
import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import { openGhostRuntime } from "../src/runtime.js";
import { createRegisteredModelProvider } from "../src/registered-models.js";
import { createHostToolTransport } from "../src/host-transport.js";

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const pending = new Map(); let callbackId = 0, runtime, calls = 0, chain = Promise.resolve(), allowWorkParks=false, parkCommand=null;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
async function command(frame) {
  if (frame.type === "config") {
    if (runtime || !isAbsolute(frame.root) || !isAbsolute(frame.host_root)
      || frame.model !== undefined
      || frame.authority_epoch !== 1) throw new Error("Invalid explicit external bot canary configuration.");
    if(frame.allow_work_parks!==undefined && typeof frame.allow_work_parks!=="boolean") throw Error("Invalid work park fixture option");
    allowWorkParks=frame.allow_work_parks===true;
    // Owner-committed registered selection only (default zai-coding/glm-5.3).
    const provider = createRegisteredModelProvider({ hostRoot: frame.host_root,
      fetchImpl: async (...args) => { if (++calls > 40) throw new Error("Bot canary model budget exceeded."); return fetch(...args); },
      onDiagnostic: value => process.stderr.write(`${JSON.stringify({ code: value.code, name: value.name ?? null, cause_code: value.cause_code ?? null })}\n`) });
    const transport = createHostToolTransport({ hostRoot: frame.host_root, callbackToken: "stdio-bot-canary-no-http-credential", authorityEpoch: 1,
      dispatch: (request, scope) => new Promise(resolve => { const id = ++callbackId; pending.set(id, {resolve,request,scope}); emit({ type: "callback", id, request, inference_scope: scope?.inferenceScope ?? null }); }) });
    runtime = await openGhostRuntime({ root: frame.root, mode: "broker", modelProvider: provider, hostToolTransport: transport,
      onDiagnostic: value => process.stderr.write(`${JSON.stringify({ code: value.code, name: value.name ?? null, cause_code: value.cause_code ?? null })}\n`) });
    emit({ type: "configured" }); return;
  }
  if (frame.type === "stop") { await runtime?.close(); emit({ type: "stopped", model_calls: calls }); lines.close(); return; }
  if (!runtime || frame.type !== "command" || frame.command?.body?.privacy && frame.command.body.privacy !== "public") throw new Error("Invalid bot canary command.");
  const receipt = await runtime.handle(frame.command);
  let timer, parkedReceipt=null;
  const parked=new Promise(resolve=>{if(allowWorkParks) parkCommand={ghost:frame.command.body.ghost_id,conversation:frame.command.body.conversation_id,resolve};});
  try { parkedReceipt=await Promise.race([parked,runtime.waitForIdle(frame.command.body.ghost_id, frame.command.body.conversation_id),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Bot canary command deadline exceeded.")), allowWorkParks ? 300000 : 120000); })]); }
  finally { clearTimeout(timer);parkCommand=null; }
  emit({ type: "command_result", id: frame.id, receipt, model_calls: calls,...(parkedReceipt?{parked:parkedReceipt}:{}) });
}
lines.on("line", line => {
  if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error("Bot canary frame exceeds bound.");
  const frame = JSON.parse(line);
  if (frame.type === "callback_result") {
    const pendingCall=pending.get(frame.id);pending.delete(frame.id);pendingCall?.resolve(frame.frame);
    const request=pendingCall?.request,result=frame.frame?.result,r=result?.data?.wait_receipt;
    if(allowWorkParks && parkCommand && request?.ghost_id===parkCommand.ghost && request?.conversation_id===parkCommand.conversation
      && request.envelope.body.method==="work.wait.inspect" && frame.frame?.ok===true && result.status==="success" && result.data.phase==="waiting"
      && r?.kind==="pi-work-wait/1" && r.assignment_id===request.envelope.body.assignment_id && r.work_id===request.envelope.body.work_id
      && r.generation_task_id===request.envelope.body.generation_task_id && r.wait_command_id===request.envelope.body.wait_command_id
      && r.wait_payload_digest===request.envelope.body.wait_payload_digest && r.authority_epoch===request.envelope.authority_epoch
      && JSON.stringify(r.wait_for)===JSON.stringify(request.envelope.body.wait_for)) parkCommand.resolve(r);
  }
  else chain = chain.then(() => command(frame)).catch(async () => { emit({ type: "failure", error_code: "bot_canary_failed", model_calls: calls }); await runtime?.close(); process.exitCode = 1; lines.close(); });
});
lines.on("close", () => { for (const call of pending.values()) call.resolve({ ok: false }); pending.clear(); });
