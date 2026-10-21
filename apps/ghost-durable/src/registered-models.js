// Provider preferences are Host-owned; credentials stay on the server. Codex
// performs its own supported OAuth flow. This module never opens OAuth stores.
import { constants } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { codexCompletion } from '../../ghost-omp/codex-client.mjs';
import { completionToSse, validateLocalCompletion } from '../../ghost-omp/completion-codec.mjs';
import { restrictMemoryTools } from './models.js';

const MODELS = { codex: ['gpt-6-luna','gpt-6-sol','gpt-6.1-sol','gpt-6-astra'], 'zai-coding': ['glm-5.3'], minimax: ['MiniMax-M3.1-Flash-Preview'] };
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

export function createRegisteredModelProvider({ hostRoot, executable, localModelProvider, complete = codexCompletion, onDiagnostic = () => {} }) {
  const defaultSelection={provider:'codex',model:'gpt-6-luna',effort:'high'};
  const workRoot=join(hostRoot,'inference-tmp');
  const forConversation = (_publicGuard, localGuard, resolveMemoryTools, onMemoryToolsExposed, _context, binding) => {
    let selected=null;
    const models=createModels();
    const settings = async () => {
      if (typeof binding?.transport !== 'function') throw new Error('Registered inference needs its Host binding.');
      const disclosure=await binding.disclosure();
      const response=await binding.transport({ method:'inference.settings', invocation_id:randomUUID(), ghost_id:binding.ghostId, conversation_id:binding.conversationId,
        inference_scope:'selected',conversation_disclosure:disclosure,arguments:{} });
      if (response.status !== 'success') throw new Error('Host model selection could not be read.');
      return { ...response.data, disclosure };
    };
    const assertSelected = async () => {
      await binding.inspectAssignment();
      const current=await settings();
      if (!same(selected,current.selection) || (current.disclosure !== 'public' && !current.external_allowed)) throw new Error('Provider selection or external consent changed.');
      const result=await binding.transport({method:'inference.inspect',invocation_id:randomUUID(),ghost_id:binding.ghostId,conversation_id:binding.conversationId,
        inference_scope:'selected',conversation_disclosure:current.disclosure,arguments:{}});
      if (result.status !== 'success' || result.data?.inference_scope !== 'selected') throw new Error('Host authority blocks selected inference.');
    };
    const completions=openAICompletionsApi();
    const modelList=Object.entries(MODELS).flatMap(([provider,ids])=>ids.map(id=>({id:`${provider}/${id}`,name:id,api:'openai-completions',provider:'ghost-registered',baseUrl:'http://127.0.0.1:1/v1',
      reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65_536,maxTokens:8192})));
    const fetchModel=async(input,init)=>{
      const request=input instanceof Request ? input : new Request(input,init);
      if (request.url !== 'http://127.0.0.1:1/v1/chat/completions' || request.method !== 'POST') throw new Error('Unpinned provider request.');
      const body=await request.json();
      await assertSelected();
      if (body.model !== ref(selected).modelId || body.stream !== true) throw new Error('Model request does not match committed selection.');
      // History consent does not grant access to personal memory/document stores.
      await restrictMemoryTools(body,async()=>[],onMemoryToolsExposed);
      await mkdir(workRoot,{recursive:true,mode:0o700});
      const started=Date.now();
      try {
        const completion=await complete({executable,body:{...body,model:selected.model,stream:false},provider:selected.provider,effort:selected.effort,
          apiKey:selected.provider==='codex'?undefined:await readProviderKey(hostRoot,selected.provider),signal:request.signal,workRoot});
        completion.model=body.model;
        validateLocalCompletion(completion,body.model,(body.tools ?? []).map(tool=>tool.function?.name));
        return new Response(completionToSse(completion),{status:200,headers:{'content-type':'text/event-stream; charset=utf-8'}});
      } catch(error) {
        onDiagnostic({code:'registered_inference_failed',provider:selected.provider,elapsed_ms:Date.now()-started});
        throw error;
      }
    };
    const options=(opts)=>({...opts,fetch:fetchModel,apiKey:'ghost-owned-transport',maxRetries:0,maxRetryDelayMs:0});
    models.setProvider(createProvider({id:'ghost-registered',name:'Ghost registered providers',baseUrl:'http://127.0.0.1:1/v1',models:modelList,
      auth:{apiKey:{name:'Ghost scoped provider adapter',resolve:async()=>({auth:{}})}},
      api:{stream:(model,context,opts)=>completions.stream(model,context,options(opts)),streamSimple:(model,context,opts)=>completions.streamSimple(model,context,options(opts))}}));
    if(localModelProvider) models.setProvider(localModelProvider.forConversation(localGuard,resolveMemoryTools,onMemoryToolsExposed,_context));
    return {models,modelRef:ref(defaultSelection),localModelRef:localModelProvider?.modelRef,streamOptions:{maxRetries:0,maxRetryDelayMs:0,timeoutMs:180_000},
      async callbackScope() { return (await settings()).selection?.provider === 'local' ? 'local' : 'selected'; },
      async selectRegistered(privacy) {
        const current=await settings(), s=current.selection;
        if (current.disclosure !== privacy) throw new Error('Conversation disclosure changed during selection.');
        if(s?.provider==='local') {
          if(!localModelProvider || s.model!==localModelProvider.modelRef.modelId || privacy!=='non_public') throw new Error('The selected local route is unavailable.');
          selected=s; return {scope:'local',target:localModelProvider.modelRef};
        }
        if (!MODELS[s?.provider]?.includes(s.model) || !(s.provider==='zai-coding'?['low','high','max']:['low','medium','high','xhigh','max']).includes(s.effort) || !current.credentials_present || (privacy!=='public'&&!current.external_allowed)) throw new Error('Register the selected provider and allow this conversation before inference.');
        selected={...s}; return {scope:'selected',target:ref(s)};
      }};
  };
  const initial=forConversation(undefined,async()=>{throw new Error('Local inference requires a conversation binding.');});
  return {...initial,forConversation};
}
