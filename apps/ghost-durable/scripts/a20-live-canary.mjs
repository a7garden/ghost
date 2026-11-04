// Opt-in measured acceptance transport. No installed Host or credentials lookup.
import { createInterface } from 'node:readline';
import { isAbsolute, join } from 'node:path';
import { openGhostRuntime } from '../src/runtime.js';
import { createRegisteredModelProvider } from '../src/registered-models.js';
import { createHostToolTransport } from '../src/host-transport.js';
import { createInferenceMeter } from './a20-metrics.mjs';
import { verifiedA20WorkPark } from './a20-work-park.mjs';
import { validateFunctionalObservationMode, createFunctionalProviderProgress, createFunctionalIdleObserver,
  collectOpenRuntimeProgress } from './a04-functional-observer.mjs';
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const pending = new Map(); let callbackId = 0, runtime, chain = Promise.resolve(), allowWorkParks=false, parkCommand=null, ackOnAdmission=false;
const callbackCounts = new Map(); let fetchCalls = 0;
let meter = createInferenceMeter(fetch, { maxCalls: 40 }), functionalObserver = null;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
async function command(frame) {
  if (frame.type === 'config') {
    if (runtime || !isAbsolute(frame.root) || !isAbsolute(frame.host_root)
      || frame.model !== undefined || frame.authority_epoch !== 1) throw new Error('Invalid explicit A20 configuration');
    if (frame.allow_work_parks !== undefined && typeof frame.allow_work_parks !== 'boolean') throw new Error('Invalid A20 park configuration');
    if (frame.ack_on_admission !== undefined && typeof frame.ack_on_admission !== 'boolean') throw new Error('Invalid A04 admission ACK configuration');
    const functional = validateFunctionalObservationMode(frame);
    allowWorkParks=frame.allow_work_parks === true;
    ackOnAdmission=frame.ack_on_admission === true;
    const providerProgress = functional ? createFunctionalProviderProgress(fetch) : null;
    if (providerProgress) meter = createInferenceMeter(providerProgress.transportFetch, { maxCalls: 40 });
    // Registered Host-owned providers only: the Owner's committed inference
    // selection (default zai-coding/glm-5.3) drives every model request; this
    // canary never configures a loopback local route.
    const countingFetch = async (...args) => {
      fetchCalls += 1;
      process.stderr.write(`${JSON.stringify({ code: 'a04_fetch', n: fetchCalls, url: typeof args[0] === 'string' ? args[0] : args[0]?.url ?? null })}\n`);
      if (fetchCalls <= 6) {
        try {
          const { mkdir, writeFile } = await import('node:fs/promises');
          await mkdir(join(frame.host_root, 'inference-tmp'), { recursive: true });
          const body = args[1]?.body;
          await writeFile(join(frame.host_root, 'inference-tmp', `req-dump-${fetchCalls}.json`), typeof body === 'string' ? body : JSON.stringify(body ?? null));
        } catch { /* diagnostics only */ }
      }
      return meter.fetch(...args);
    };
    const provider = createRegisteredModelProvider({ hostRoot: frame.host_root,
      fetchImpl: providerProgress ? providerProgress.wrap(countingFetch) : countingFetch,
      onDiagnostic: value => meter.recordProviderDiagnostic(value) });
    providerProgress?.configureTimeout(provider.streamOptions.timeoutMs);
    const transport = createHostToolTransport({ hostRoot: frame.host_root, callbackToken: 'stdio-a20-no-http-credential', authorityEpoch: 1,
      dispatch: (request, scope) => {
        const method = request?.envelope?.body?.method ?? 'unknown';
        callbackCounts.set(method, (callbackCounts.get(method) ?? 0) + 1);
        const total = [...callbackCounts.values()].reduce((a, b) => a + b, 0);
        process.stderr.write(`${JSON.stringify({ code: 'a04_cb', n: total, m: method })}\n`);
        return new Promise(resolve => { const id = ++callbackId; pending.set(id, { resolve, request, scope }); emit({ type: 'callback', id, request, inference_scope: scope?.inferenceScope ?? null }); });
      } });
    runtime = await openGhostRuntime({ root: frame.root, mode: 'broker', modelProvider: provider, hostToolTransport: transport,
      onDiagnostic: value => process.stderr.write(`${JSON.stringify({ code: value.code, name: value.name ?? null })}\n`) });
    if (functional) functionalObserver = createFunctionalIdleObserver({
      waitForIdle: scope => runtime.waitForIdle(scope.ghost_id, scope.conversation_id),
      hasOpenScope: scope => [...runtime.sessions.values()].some(session => session.ghostId === scope.ghost_id && session.conversationId === scope.conversation_id),
      progress: scope => collectOpenRuntimeProgress(runtime, scope, providerProgress.snapshot()),
      metrics: () => meter.snapshot(), emit,
    });
    emit({ type: 'configured', ...(functional ? { observation_mode: frame.observation_mode } : {}) }); return;
  }
  if (frame.type === 'stop') { functionalObserver?.close(); await runtime?.close(); emit({ type: 'stopped', metrics: meter.snapshot() }); lines.close(); return; }
  if (!runtime || frame.type !== 'command') throw new Error('Invalid A20 command');
  const receipt = await runtime.handle(frame.command); let timer, parkedReceipt=null;
  if (receipt.status === 'success') functionalObserver?.admitted(frame.command.body, frame.id);
  if(ackOnAdmission){emit({type:'command_result',id:frame.id,receipt,metrics:meter.snapshot()});return;}
  const parked=new Promise(resolve=>{if(allowWorkParks) parkCommand={command:frame.command,resolve};});
  try { parkedReceipt=await Promise.race([parked,runtime.waitForIdle(frame.command.body.ghost_id, frame.command.body.conversation_id), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('A20 command deadline exceeded')), 120000); })]); }
  finally { clearTimeout(timer); parkCommand=null; }
  emit({ type: 'command_result', id: frame.id, receipt, metrics: meter.snapshot(), ...(parkedReceipt ? {parked:parkedReceipt} : {}) });
}
lines.on('line', line => {
  if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error('A20 frame exceeds bound');
  const frame = JSON.parse(line);
  if (frame.type === 'callback_result') {
    const call=pending.get(frame.id);pending.delete(frame.id);call?.resolve(frame.frame);
    const parked=allowWorkParks && parkCommand ? verifiedA20WorkPark(parkCommand.command,call?.request,frame.frame) : null;
    if(parked) parkCommand.resolve(parked);
  }
  else if(frame.type==='idle' && ackOnAdmission) {
    if (functionalObserver) void chain.then(() => functionalObserver.start(frame)).catch(() => emit({type:'observer_rejected',id:frame.id,reason_code:'observer_dispatch_unconfirmed'}));
    else void chain.then(async()=>{let timer;try{await Promise.race([runtime.waitForIdle(frame.ghost_id,frame.conversation_id),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('A04 idle observer deadline')),120000);})]);emit({type:'idle_result',id:frame.id,metrics:meter.snapshot()});}catch{emit({type:'idle_result',id:frame.id,error_code:'a04_idle_unconfirmed',metrics:meter.snapshot()});}finally{clearTimeout(timer);}});
  }
  else if(frame.type==='observation_status' && functionalObserver) {
    void chain.then(() => functionalObserver.status(frame)).catch(() => emit({type:'observer_rejected',id:frame.id,reason_code:'observer_dispatch_unconfirmed'}));
  }
  else chain = chain.then(() => command(frame)).catch(async () => { emit({ type: 'failure', error_code: 'a20_trial_failed', metrics: meter.snapshot() }); await runtime?.close(); process.exitCode = 1; lines.close(); });
});
lines.on('close', () => { functionalObserver?.close(); for (const call of pending.values()) call.resolve({ ok: false }); pending.clear(); });
