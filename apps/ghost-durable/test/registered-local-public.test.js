import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {createRegisteredModelProvider} from '../src/registered-models.js';
import {createLocalModelProvider} from '../src/models.js';
import {createHostToolTransport} from '../src/host-transport.js';
import {openGhostRuntime} from '../src/runtime.js';
import {payloadDigest} from '../src/contract.js';
const success=data=>({status:'success',summary:'Controlled scoped receipt',object_refs:[],artifacts:[],next_actions:[],error_code:null,retry_class:'same_id',data});
const selection={provider:'local',model:'fixture/local-public',effort:'off'};

test('only metadata callback bootstrap can use an authenticated known-disclosure hint',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ghost-registered-hint-'));let disclosure='unknown',inference=0,capabilities=0;const calls=[];
 const local=createLocalModelProvider({baseUrl:'http://127.0.0.1:9/v1',modelId:selection.model,fetchImpl:async()=>{inference++;throw Error('No inference authorized by metadata bootstrap');}});
 const binding={ghostId:'g',conversationId:'c',disclosure:async()=>disclosure,inspectAssignment:async()=>{},transport:async input=>{calls.push(input);return success({selection,credentials_present:true,external_allowed:false});}};
 const provider=createRegisteredModelProvider({hostRoot:root,localModelProvider:local}).forConversation(undefined,async()=>{assert.ok(['public','non_public'].includes(disclosure),'actual local guard must use committed disclosure');},async()=>{capabilities++;return [];},undefined,undefined,binding);
 try {
  await assert.rejects(provider.callbackScope(),error=>error.code==='inference_disclosure_unknown');assert.equal(calls.length,0);
  assert.equal(await provider.callbackScope('public'),'local');assert.equal(calls[0].method,'inference.settings');assert.equal(calls[0].conversation_disclosure,'public');
  await assert.rejects(provider.selectRegistered('public'),error=>error.code==='inference_disclosure_unknown');
  const model=provider.models.getModel(local.modelRef.provider,local.modelRef.modelId);
  const denied=await provider.models.complete(model,{messages:[{role:'user',content:'uncommitted',timestamp:1}]},provider.streamOptions);assert.equal(denied.stopReason,'error');assert.equal(inference,0);
  disclosure='non_public';assert.equal(await provider.callbackScope('public'),'local');assert.equal(calls.at(-1).conversation_disclosure,'non_public','a hint cannot override known protected state');
  await assert.rejects(provider.selectRegistered('public'),error=>error.code==='inference_disclosure_changed');
  disclosure='public';assert.equal((await provider.selectRegistered('public')).scope,'local');
  assert.equal(inference,0);assert.equal(capabilities,0,'settings bootstrap grants no memory/document exposure');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('local public callbacks use only the local bearer and keep mailbox disclosure conservative',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ghost-local-public-transport-')),owner='a'.repeat(64),posts=[];
 const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url.startsWith('/api/v1/bootstrap/')){const nonce=req.url.split('/').at(-1);res.end(JSON.stringify({protocol:'ghost-control',version:1,proof:createHmac('sha256',owner).update('ghost-control-bootstrap-v1\0').update(nonce).digest('hex')}));return;}
  let text='';for await(const part of req)text+=part;posts.push({path:req.url,authorization:req.headers.authorization,csrf:req.headers['x-ghost-csrf'],body:JSON.parse(text)});res.end(JSON.stringify({ok:true,result:success({inference_scope:'local'})}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  await writeFile(join(root,'.ghost-control.json'),JSON.stringify({protocol:'ghost-control',protocol_version:1,host:'127.0.0.1',port:server.address().port,token:owner}),{mode:0o600});
  const transport=createHostToolTransport({hostRoot:root,callbackToken:'public-fixture',localCallbackToken:'local-fixture',authorityEpoch:1});
  const input={method:'inference.inspect',invocation_id:'public-local-inspection',ghost_id:'g',conversation_id:'c',inference_scope:'local',conversation_disclosure:'public',arguments:{}};
  assert.equal((await transport(input)).status,'success');
  await transport({...input,method:'mailbox.send',invocation_id:'public-local-message',arguments:{recipient_ids:['other'],summary:'bounded public facts',object_refs:[]}});
  assert.equal(posts.length,2);for(const post of posts){assert.equal(post.path,'/api/v1/pi/local-action');assert.equal(post.authorization,'Bearer local-fixture');assert.equal(post.csrf,'local-fixture');}
  assert.equal(posts[1].body.envelope.body.privacy,'local_only');
  const missing=createHostToolTransport({hostRoot:root,callbackToken:'public-fixture',authorityEpoch:1});assert.equal((await missing({...input,invocation_id:'no-local-bearer'})).error_code,'local_callback_unavailable');
  await assert.rejects(transport({...input,conversation_disclosure:'unknown'}));
  await assert.rejects(transport({...input,inference_scope:'public',conversation_disclosure:'non_public'}));
  assert.equal(posts.length,2,'unknown scope or missing local credentials never falls back to public endpoint');
 }finally{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});

test('fresh public Work selected local reaches the actual SDK transport with fresh local authority and no Owner source tools',async()=>{
 for(const blocked of [false,true]) {
  const root=await mkdtemp(join(tmpdir(),'ghost-local-public-work-'));let runtime;const requests=[],calls=[];
  const ghost='selected-local-ghost',conversation='public-canonical-pair';
  const a={id:'public-assignment',source_command_id:'original-owner-source',ghost_id:ghost,conversation_id:conversation,goal_id:'public-goal',goal_revision:1,work_id:'public-work',privacy:'public',prompt:'PUBLIC-WORK-ONLY immutable instructions',origin_kind:'owner_goal',parent_work_id:null,root_goal_id:'public-goal'};
  const context={kind:'ghost-work-context/1',ref:`wc-${'d'.repeat(64)}`,assignment_id:a.id,work_id:a.work_id,goal_revision:1,owner_revision:1,authority_epoch:1};
  const dispatch=createHostToolTransport({hostRoot:root,callbackToken:'public-fixture',localCallbackToken:'local-fixture',authorityEpoch:1,dispatch:async request=>{
   const body=request.envelope.body;let data;
   if(body.method==='inference.settings')data={selection,credentials_present:true,external_allowed:false};
   else if(body.method==='conversation.assignment.inspect')data={assignment:a,execution_context:context,execution:{engine:'pi',version:1}};
   else if(body.method==='work.context.claim')data={context_ref:context.ref};
   else if(body.method==='inference.inspect'){
    if(blocked)return {ok:true,result:{...success(null),status:'error',error_code:'authority_fenced'}};
    assert.equal(request.context_ref,context.ref);assert.equal(body.assignment_id,a.id);assert.equal(body.work_id,a.work_id);data={inference_scope:'local'};
   }else throw Error(`Unexpected callback ${body.method}`);
   return {ok:true,result:success(data)};
  }});
  const host=async input=>{calls.push(input);return dispatch(input);};
  const local=createLocalModelProvider({baseUrl:'http://127.0.0.1:9/v1',modelId:selection.model,fetchImpl:async(_url,options)=>{
   const body=JSON.parse(options.body);requests.push(body);return new Response(JSON.stringify({id:'controlled-local',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'Advisory only; independent acceptance remains separate.'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
  }});
  const provider=createRegisteredModelProvider({hostRoot:root,localModelProvider:local,complete:async()=>{throw Error('No external/Codex fallback');},fetchImpl:async()=>{throw Error('No external fallback');}});
  try{
   runtime=await openGhostRuntime({root,mode:'broker',modelProvider:provider,hostToolTransport:host});
   const body={method:'conversation.assignment',ghost_id:ghost,conversation_id:conversation,goal_id:a.goal_id,goal_revision:1,work_id:a.work_id,prompt:a.prompt,privacy:'public'};
   const command={protocol_version:'ghost-lifetime/1',command_id:a.id,payload_digest:payloadDigest(body),actor_ref:ghost,authority_epoch:1,expected_revision:null,correlation_id:a.id,body};
   const admitted=await runtime.handle(command);assert.equal(admitted.status,'success',JSON.stringify(admitted));await runtime.waitForIdle(ghost,conversation);
   assert.equal(calls[0].method,'inference.settings');assert.equal(calls[0].conversation_disclosure,'public','authenticated initial hint is metadata bootstrap only');
   assert.equal(requests.length,blocked?0:1,'fresh final Host authority gates actual selected local invocation');
   assert.ok(calls.some(call=>call.method==='inference.inspect'&&call.inference_scope==='local'&&call.conversation_disclosure==='public'));
   assert.equal(calls.some(call=>call.method.startsWith('memory.')||call.method.startsWith('documents.')),false,'absent Work refs must not query Owner capability APIs');
   if(!blocked){const wire=JSON.stringify(requests[0]);assert.ok(wire.includes(a.prompt));assert.equal(requests[0].tools.some(tool=>/^(memory_|document_|source_view_|work_memory_)/u.test(tool.function?.name??'')),false,'selecting local grants no Owner memory/document tools');}
  }finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
 }
});
