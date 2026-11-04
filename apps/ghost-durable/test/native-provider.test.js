import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRegisteredModelProvider} from '../src/registered-models.js';
import {createStdioOmpInvoker} from '../src/models.js';

function events(item) {
 const response={id:'resp_test',status:'completed',output:[item],usage:{input_tokens:4,output_tokens:3,total_tokens:7}};
 return new Response([
  {type:'response.created',response:{id:response.id}},
  {type:'response.output_item.added',output_index:0,item:{...item,arguments:item.type==='function_call'?'':undefined}},
  {type:'response.output_item.done',output_index:0,item},
  {type:'response.completed',response},
 ].map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}
const textItem={type:'message',id:'msg_test',role:'assistant',status:'completed',content:[{type:'output_text',text:'verified',annotations:[]}]};
async function fixture(providerId,fetchImpl) {
 const root=await mkdtemp(join(tmpdir(),'ghost-native-provider-'));
 await mkdir(join(root,'inference-credentials'));
 await writeFile(join(root,'inference-credentials',`${providerId}.json`),JSON.stringify({api_key:'unit-test-provider-key'}),{mode:0o600});
 const state={selection:{provider:providerId,model:providerId==='zai-coding'?'glm-5.3':'MiniMax-M3.1-Flash-Preview',effort:'high'},allowed:true,present:true,authority:true,privacy:'non_public',calls:0,exposed:[]};
 const configured=createRegisteredModelProvider({hostRoot:root,fetchImpl:async(...args)=>{state.calls++;return fetchImpl(...args,state);},complete:()=>{throw new Error('Native route called Codex compatibility transport');}});
 const bound=configured.forConversation(undefined,async()=>{},()=>{throw new Error('External route asked for memory capabilities');},(_,names)=>state.exposed.push(names),undefined,{
  transport:async({method})=>({status:state.authority?'success':'blocked',data:method==='inference.settings'?{selection:state.selection,external_allowed:state.allowed,credentials_present:state.present}:{inference_scope:'selected'}}),
  ghostId:'g',conversationId:'c',disclosure:async()=>state.privacy,inspectAssignment:async()=>{if(!state.authority)throw new Error('revoked');},
 });
 const route=await bound.selectRegistered('non_public');
 return {root,state,bound,model:bound.models.getModel(route.target.provider,route.target.modelId),close:()=>rm(root,{recursive:true,force:true})};
}
const tools=[{name:'read_file',description:'Read a scoped file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}},{name:'memory_search',description:'private',parameters:{type:'object',properties:{}}},{name:'document_read_page',description:'private document',parameters:{type:'object',properties:{}}}];
const context={messages:[{role:'user',content:'read result.txt',timestamp:1}],tools};

for(const providerId of ['zai-coding','minimax']) test(`${providerId} uses Pi native responses with exact endpoint, key, effort and tool roundtrip`,async()=>{
 const requests=[];
 const f=await fixture(providerId,async(url,options)=>{
  requests.push({url,options,body:JSON.parse(options.body)});
  return events(requests.length===1?{type:'function_call',id:'fc_test',call_id:'call_test',name:'read_file',arguments:'{"path":"result.txt"}',status:'completed'}:textItem);
 });
 try {
  const first=await f.bound.models.complete(f.model,context,f.bound.streamOptions);
  assert.equal(first.stopReason,'toolUse',first.errorMessage);
  const call=first.content.find(block=>block.type==='toolCall');
  assert.equal(call.name,'read_file');assert.deepEqual(call.arguments,{path:'result.txt'});
  const final=await f.bound.models.completeSimple(f.model,{...context,messages:[...context.messages,first,{role:'toolResult',toolCallId:call.id,toolName:call.name,content:[{type:'text',text:'fixture contents'}],isError:false,timestamp:2}]},f.bound.streamOptions);
  assert.equal(final.stopReason,'stop',final.errorMessage);
  assert.equal(final.content[0].text,'verified');
  assert.equal(requests[0].url,providerId==='zai-coding'?'https://api.z.ai/api/v1/responses':'https://api.minimax.io/v1/responses');
  for(const {options,body} of requests){
   assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer unit-test-provider-key');
   assert.equal(body.model,f.state.selection.model);assert.equal(body.reasoning.effort,'high');
   assert.deepEqual(body.tools.map(tool=>tool.name),['read_file']);
  }
  assert.ok(requests[1].body.input.some(item=>item.type==='function_call_output'&&item.output.includes('fixture contents')));
  assert.deepEqual(f.state.exposed,[[],[]]);assert.equal(f.state.calls,2);
 }finally{await f.close();}
});

test('native route refuses selection, consent, credentials, disclosure and authority changes before fetch',async()=>{
 for(const mutate of [s=>s.selection={...s.selection,model:'unsupported'},s=>s.allowed=false,s=>s.present=false,s=>s.authority=false,s=>s.privacy='unknown']){
  const f=await fixture('zai-coding',async()=>{throw new Error('forbidden fetch');});
  try{mutate(f.state);const result=await f.bound.models.complete(f.model,context,f.bound.streamOptions);assert.equal(result.stopReason,'error');assert.equal(f.state.calls,0);}finally{await f.close();}
 }
});

test('native route blocks revoked response bytes and does not retry failed network calls',async()=>{
 for(const revoke of [true,false]){
  const f=await fixture('minimax',async(_url,_options,state)=>{if(revoke){state.allowed=false;return events(textItem);}throw new Error('private transport failure');});
  try{const result=await f.bound.models.complete(f.model,context,f.bound.streamOptions);assert.equal(result.stopReason,'error');assert.equal(result.content.some(p=>p.text==='verified'),false);assert.equal(f.state.calls,1);}finally{await f.close();}
 }
});

test('native route propagates cancellation without retrying or substituting another model',async()=>{
 const controller=new AbortController();
 const f=await fixture('minimax',async(_url,options)=>new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});controller.abort();}));
 try{const result=await f.bound.models.complete(f.model,context,{...f.bound.streamOptions,signal:controller.signal});assert.equal(result.stopReason,'aborted');assert.equal(f.state.calls,1);}finally{await f.close();}
});

test('concrete OMP transport is unavailable and production model modules have no OMP imports',async()=>{
 await assert.rejects(createStdioOmpInvoker(),/OMP inference was removed/);
 for(const name of ['models.js','registered-models.js','providers/codex-client.mjs','providers/completion-codec.mjs']){
  const source=await readFile(new URL(`../src/${name}`,import.meta.url),'utf8');
  assert.doesNotMatch(source,/from\s+["'][^"']*ghost-omp/u);
 }
});

test('native provider rejects an unexposed memory tool returned by the model',async()=>{
 const f=await fixture('zai-coding',async()=>events({type:'function_call',id:'fc_bad',call_id:'call_bad',name:'memory_search',arguments:'{}',status:'completed'}));
 try{const result=await f.bound.models.complete(f.model,context,f.bound.streamOptions);assert.equal(result.stopReason,'error');assert.deepEqual(result.content,[]);assert.match(result.errorMessage,/unexposed/);}finally{await f.close();}
});
