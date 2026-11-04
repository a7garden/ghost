// Provider preferences are Host-owned; credentials stay on the server. Codex
// performs its own supported OAuth flow. This module never opens OAuth stores.
import { constants } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModels, createProvider, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { codexCompletion } from './providers/codex-client.mjs';
import { completionToSse, validateLocalCompletion } from './providers/completion-codec.mjs';
import { restrictMemoryTools } from './models.js';
import { ProtocolError } from './contract.js';

const MODELS = { codex: ['gpt-6-luna','gpt-6-sol','gpt-6.1-sol','gpt-6-astra'], 'zai-coding': ['glm-5.3'], minimax: ['MiniMax-M3.1-Flash-Preview'] };
// Z.AI/MiniMax constrained decoding emits empty arguments for tools whose
// parameter schema is a top-level anyOf (measured 2026-10-25: read/bash on
// glm-5.3). The Host revalidates every executed call against the real schema,
// so the wire carries a merged-object view of the union instead.
function flattenAnyOfParameters(tool) {
  const parameters = tool?.parameters;
  if (!parameters || !Array.isArray(parameters.anyOf)) return tool;
  const merged = { type: 'object', properties: {}, required: [], additionalProperties: false };
  for (const variant of parameters.anyOf) {
    if (variant?.type !== 'object') continue;
    Object.assign(merged.properties, variant.properties ?? {});
    for (const name of variant.required ?? []) {
      if (merged.properties[name] !== undefined && !merged.required.includes(name)) merged.required.push(name);
    }
  }
  return { ...tool, parameters: merged };
}
// These are existing Host credential profiles, not aliases for Pi's built-in
// zai/minimax catalogs (which use different endpoints and protocols).
const ENDPOINTS = Object.freeze({ 'zai-coding': 'https://api.z.ai/api/v1', minimax: 'https://api.minimax.io/v1' });
const ref = (s) => ({ provider: 'ghost-registered', modelId: `${s.provider}/${s.model}` });
const same = (a,b) => a?.provider === b?.provider && a?.model === b?.model && a?.effort === b?.effort;
export async function readProviderKey(root, provider) {
  if (!['zai-coding','minimax'].includes(provider)) throw new Error('Unsupported credential provider.');
  const file = await open(join(root,'inference-credentials',`${provider}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st=await file.stat();
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0 || st.size > 8192) throw new Error('Provider credential permissions are invalid.');
    const key=JSON.parse(await file.readFile('utf8')).api_key;
    if (typeof key !== 'string' || key.length < 8 || key.length > 4096 || /\s/u.test(key)) throw new Error('Provider key is invalid.');
    return key;
  } finally { await file.close(); }
}

export function createRegisteredModelProvider({ hostRoot, executable, localModelProvider, complete = codexCompletion, fetchImpl = globalThis.fetch, onDiagnostic = () => {} }) {
  const defaultSelection={provider:'codex',model:'gpt-6-luna',effort:'high'};
  const workRoot=join(hostRoot,'inference-tmp');
  const forConversation = (_publicGuard, localGuard, resolveMemoryTools, onMemoryToolsExposed, _context, binding) => {
    let selected=null;
    const models=createModels();
    const settings = async (bootstrapDisclosure) => {
      if (typeof binding?.transport !== 'function') throw new Error('Registered inference needs its Host binding.');
      const committed=await binding.disclosure();
      // A fresh assignment's authenticated envelope can bootstrap metadata
      // routing before its disclosure is persisted. Only callbackScope uses
      // this hint; selection and every actual invocation read committed state.
      const disclosure=committed==='unknown' && ['public','non_public'].includes(bootstrapDisclosure) ? bootstrapDisclosure : committed;
      if(!['public','non_public'].includes(disclosure)) throw new ProtocolError('inference_disclosure_unknown','Committed disclosure is unavailable for registered inference.','same_id');
      const response=await binding.transport({ method:'inference.settings', invocation_id:randomUUID(), ghost_id:binding.ghostId, conversation_id:binding.conversationId,
        inference_scope:'selected',conversation_disclosure:disclosure,...binding.inferenceAssignment?.(),arguments:{} });
      if (response.status !== 'success') throw new Error('Host model selection could not be read.');
      return { ...response.data, disclosure };
    };
    let lastCommittedDisclosure=null;
    let scopeGenerationCache=null;
    const authorityInspect=(disclosure)=>binding.transport({method:'inference.inspect',invocation_id:randomUUID(),ghost_id:binding.ghostId,conversation_id:binding.conversationId,
      inference_scope:'selected',conversation_disclosure:disclosure,...binding.inferenceAssignment?.(),arguments:{}});
    const assertSelected = async (expected = selected) => {
      if (!expected || !same(expected, selected)) throw new Error('Provider selection changed.');
      await binding.inspectAssignment();
      const current=await settings();
      if (!same(expected,current.selection) || !current.credentials_present || !['public','non_public'].includes(current.disclosure)
        || (current.disclosure !== 'public' && !current.external_allowed)) throw new Error('Provider selection or external consent changed.');
      lastCommittedDisclosure=current.disclosure;
      const result=await authorityInspect(current.disclosure);
      if (result.status !== 'success' || result.data?.inference_scope !== 'selected') throw new Error('Host authority blocks selected inference.');
    };
    const completions=openAICompletionsApi();
    const responses=openAIResponsesApi();
    const modelList=Object.entries(MODELS).flatMap(([provider,ids])=>ids.map(id=>({id:`${provider}/${id}`,name:id,api:provider==='codex'?'openai-completions':'openai-responses',provider:'ghost-registered',baseUrl:ENDPOINTS[provider] ?? 'http://127.0.0.1:1/v1',
      reasoning:provider!=='codex',input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65_536,maxTokens:8192})));
    const fetchModel=async(input,init)=>{
      const request=input instanceof Request ? input : new Request(input,init);
      const expected=selected && {...selected};
      if (request.url !== 'http://127.0.0.1:1/v1/chat/completions' || request.method !== 'POST') throw new Error('Unpinned provider request.');
      const body=await request.json();
      await assertSelected(expected);
      if (body.model !== ref(expected).modelId || body.stream !== true) throw new Error('Model request does not match committed selection.');
      // History consent does not grant access to personal memory/document stores.
      await restrictMemoryTools(body,async()=>[],onMemoryToolsExposed);
      if (expected.provider !== 'codex') throw new Error('Only the Codex compatibility transport accepts completion frames.');
      if (typeof executable !== 'string' || !executable.startsWith('/')) throw new Error('Selected Codex inference requires the official Codex executable.');
      await mkdir(workRoot,{recursive:true,mode:0o700});
      const started=Date.now();
      try {
        const completion=await complete({executable,body:{...body,model:expected.model,stream:false},provider:expected.provider,effort:expected.effort,
          signal:request.signal,workRoot});
        await assertSelected(expected);
        request.signal.throwIfAborted();
        completion.model=body.model;
        validateLocalCompletion(completion,body.model,(body.tools ?? []).map(tool=>tool.function?.name));
        return new Response(completionToSse(completion),{status:200,headers:{'content-type':'text/event-stream; charset=utf-8'}});
      } catch(error) {
        onDiagnostic({code:'registered_inference_failed',provider:expected.provider,elapsed_ms:Date.now()-started});
        throw error;
      }
    };
    const options=(opts)=>({...opts,fetch:fetchModel,apiKey:'ghost-owned-transport',maxRetries:0,maxRetryDelayMs:0});
    const nativeOptions=(opts,model,allowedTools,onHttpFailure)=>{
      const expected=selected && {...selected};
      return {...opts,apiKey:'ghost-owned-transport',maxRetries:0,maxRetryDelayMs:0,transport:'sse',
        // Raw stream events include untrusted provider error payloads.
        onProviderStreamEvent:undefined,
        reasoningEffort:expected?.effort,reasoning:expected?.effort,
        fetch:async(input,init)=>{
          const request=input instanceof Request ? input : new Request(input,init);
          const endpoint=ENDPOINTS[expected?.provider];
          if (!endpoint || request.url!==`${endpoint}/responses` || request.method!=='POST') throw new Error('Unpinned native provider request.');
          const body=await request.json();
          if(body.model!==model.id || body.model!==ref(expected).modelId || body.stream!==true) throw new Error('Native request does not match committed selection.');
          await restrictMemoryTools(body,async()=>[],onMemoryToolsExposed);
          body.tools=(body.tools ?? []).map(flattenAnyOfParameters);
          for(const tool of body.tools ?? []) allowedTools.add(tool.name);
          body.model=expected.model;
          body.reasoning={...body.reasoning,effort:expected.effort};
          body.max_output_tokens=Math.min(Number.isSafeInteger(body.max_output_tokens)&&body.max_output_tokens>0?body.max_output_tokens:8192,8192);
          const encoded=JSON.stringify(body);
          if(Buffer.byteLength(encoded)>8*1024*1024) throw new Error('Native provider request exceeded its byte limit.');
          request.signal.throwIfAborted();
          await assertSelected(expected);
          const key=await readProviderKey(hostRoot,expected.provider);
          await assertSelected(expected);
          request.signal.throwIfAborted();
          const response=await fetchImpl(request.url,{method:'POST',redirect:'error',signal:request.signal,
            headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:encoded});
          // Recheck before exposing response headers or any stream bytes. This
          // catches revocation during transport, then every chunk is gated too.
          try { await assertSelected(expected);request.signal.throwIfAborted(); }
          catch(error) { await response.body?.cancel().catch(()=>{});throw error; }
          if(!response.ok) {
            onHttpFailure(response.status);
            await response.body?.cancel().catch(()=>{});
            throw new Error('Native provider returned an HTTP error.');
          }
          if(!response.body) throw new Error('Native provider returned no response body.');
          const reader=response.body.getReader();
          let responseBytes=0, lastGate=-65536;
          const bodyStream=new ReadableStream({async pull(controller){
            try {
              request.signal.throwIfAborted();
              const part=await reader.read();
              // The Host refuses selection changes for a conversation with an
              // active turn, so the selection identity cannot change mid-stream.
              // Authority/consent rechecks stay bounded: one per 64 KiB plus the
              // post-header and completion checks, so revocation is enforced
              // without a round trip per event.
              if(!lastCommittedDisclosure) throw new Error('Provider selection changed.');
              if(responseBytes-lastGate>=65536){
                lastGate=responseBytes;
                const gated=await authorityInspect(lastCommittedDisclosure);
                if (gated.status !== 'success' || gated.data?.inference_scope !== 'selected') throw new Error('Host authority blocks selected inference.');
              }
              request.signal.throwIfAborted();
              responseBytes+=part.value?.byteLength ?? 0;
              if(responseBytes>4*1024*1024) throw new Error('Native provider response exceeded its byte limit.');
              if(part.done) controller.close(); else controller.enqueue(part.value);
            } catch(error) { await reader.cancel().catch(()=>{});controller.error(error); }
          },cancel(reason){return reader.cancel(reason);}});
          return new Response(bodyStream,{status:response.status,statusText:response.statusText,headers:response.headers});
        }};
    };
    const streamNative=(method,model,context,opts)=>{
      const result=createAssistantMessageEventStream(), allowedTools=new Set();
      const expected=selected && {...selected};
      (async()=>{
        let errorMessage = 'Native provider request failed.';
        let aborted = false;
        let usage;
        try {
          const options = nativeOptions(opts, model, allowedTools, status => {
            errorMessage = `Native provider returned HTTP ${status}.`;
          });
          for await(const event of responses[method](model,context,options)){
            if(event.type==='error') {
              aborted = event.reason === 'aborted';
              usage = event.error.usage;
              break;
            }
            if(event.type==='done') {
              const terminal = event.message;
              usage = terminal.usage;
              await assertSelected(expected);
              opts?.signal?.throwIfAborted();
              const calls=terminal.content.filter(block=>block.type==='toolCall');
              if(calls.length>32 || calls.some(call=>!allowedTools.has(call.name)||call.arguments===null||typeof call.arguments!=='object'||Array.isArray(call.arguments))) {
                errorMessage = 'Native provider returned an unexposed or invalid tool call.';
                break;
              }
              if(!calls.length&&!terminal.content.some(block=>block.type==='text'&&block.text.trim())) {
                errorMessage = 'Native provider returned no answer or tool call.';
                break;
              }
              result.push(event);
              result.end();
              return;
            }
            // The SDK reuses its partial message and writes terminal errors
            // onto it. Forward a copy without the upstream error fields.
            const { errorMessage: _message, rawStopReason: _reason, ...partial } = event.partial;
            result.push({ ...event, partial });
          }
        } catch {
          // Transport, SDK and authority exceptions may contain private data.
        } finally {
          // The committed generation settled; later fences re-resolve scope
          // fresh so a selection change between turns is never masked.
          scopeGenerationCache=null;
        }
        const stopReason = aborted || opts?.signal?.aborted ? 'aborted' : 'error';
        const numberOrZero = value => Number.isFinite(value) ? value : 0;
        const failure = {
          role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), content: [], stopReason,
          errorMessage: stopReason === 'aborted' ? 'Request was aborted.' : errorMessage,
          usage: {
            input: numberOrZero(usage?.input), output: numberOrZero(usage?.output),
            cacheRead: numberOrZero(usage?.cacheRead), cacheWrite: numberOrZero(usage?.cacheWrite),
            totalTokens: numberOrZero(usage?.totalTokens), reasoning: numberOrZero(usage?.reasoning),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        result.push({ type: 'error', reason: stopReason, error: failure });
        result.end();
      })();
      return result;
    };
    models.setProvider(createProvider({id:'ghost-registered',name:'Ghost registered providers',baseUrl:'http://127.0.0.1:1/v1',models:modelList,
      auth:{apiKey:{name:'Ghost scoped provider adapter',resolve:async()=>({auth:{}})}},
      api:{'openai-completions':{stream:(model,context,opts)=>completions.stream(model,context,options(opts)),streamSimple:(model,context,opts)=>completions.streamSimple(model,context,options(opts))},
        'openai-responses':{stream:(model,context,opts)=>streamNative('stream',model,context,opts),streamSimple:(model,context,opts)=>streamNative('streamSimple',model,context,opts)}}}));
    if(localModelProvider) models.setProvider(localModelProvider.forConversation(localGuard,resolveMemoryTools,onMemoryToolsExposed,_context));
    return {models,modelRef:ref(defaultSelection),localModelRef:localModelProvider?.modelRef,localRouteConfig:localModelProvider?.localRouteConfig,streamOptions:{maxRetries:0,maxRetryDelayMs:0,timeoutMs:180_000},
      async callbackScope(bootstrapDisclosure) {
        // The Host refuses selection changes for a conversation with an active
        // turn, so within one committed generation the scope is stable; fences
        // re-resolve fresh between generations because the cache is cleared
        // when the generation stream settles.
        if (scopeGenerationCache) return scopeGenerationCache.value;
        return (await settings(bootstrapDisclosure)).selection?.provider === 'local' ? 'local' : 'selected';
      },
      async selectRegistered(privacy) {
        const current=await settings(), s=current.selection;
        if (current.disclosure !== privacy) throw new ProtocolError('inference_disclosure_changed','Conversation disclosure changed during selection.','same_id');
        if(s?.provider==='local') {
          if(!localModelProvider || s.model!==localModelProvider.modelRef.modelId || !['public','non_public'].includes(privacy)) throw new ProtocolError('local_provider_unavailable','The selected local route is unavailable.','same_id');
          selected=s; return {scope:'local',target:localModelProvider.modelRef};
        }
        if (!MODELS[s?.provider]?.includes(s.model) || !(s.provider==='zai-coding'?['low','high','max']:['low','medium','high','xhigh','max']).includes(s.effort)) throw new ProtocolError('inference_selection_unsupported','The selected provider, model or effort is unsupported.','same_id');
        if(!current.credentials_present) throw new ProtocolError('inference_credentials_missing','Register the selected provider before inference.','same_id');
        if(privacy!=='public'&&!current.external_allowed) throw new ProtocolError('inference_consent_required','Allow the selected provider for this conversation before inference.','same_id');
        selected={...s}; lastCommittedDisclosure=current.disclosure;
        scopeGenerationCache={value:s.provider==='local'?'local':'selected'};
        return {scope:'selected',target:ref(s)};
      }};
  };
  const initial=forConversation(undefined,async()=>{throw new Error('Local inference requires a conversation binding.');});
  return {...initial,forConversation};
}
