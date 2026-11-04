import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHostToolTransport } from '../src/host-transport.js';
import { createRegisteredModelProvider } from '../src/registered-models.js';
test('inference Work identity is a strict trusted outer pair and never model arguments',async()=>{
 const requests=[];
 const transport=createHostToolTransport({hostRoot:'/tmp/shared-skill-fixture',callbackToken:'fixture',authorityEpoch:1,dispatch:async request=>{
  requests.push(request);return {ok:true,result:{status:'success',summary:'scoped',artifacts:[],next_actions:[],data:{inference_scope:'public'}}};
 }});
 const scope={method:'inference.inspect',ghost_id:'ghost',conversation_id:'conversation',inference_scope:'public',conversation_disclosure:'public',arguments:{},invocation_id:'original'};
 await transport(scope);assert.deepEqual(requests[0].envelope.body,{method:'inference.inspect'});
 await transport({...scope,assignment_id:'assignment',work_id:'work',invocation_id:'bound'});
 assert.deepEqual(requests[1].envelope.body,{method:'inference.inspect',assignment_id:'assignment',work_id:'work'});
 for(const extra of [{assignment_id:'assignment'},{work_id:'work'},{assignment_id:null,work_id:'work'},{assignment_id:'assignment',work_id:null},{arguments:{assignment_id:'assignment',work_id:'work'}}]) await assert.rejects(transport({...scope,...extra}));
 assert.equal(requests.length,2);
});
test('selected production provider rechecks exact assignment pair before invoke and withholds revoked output',async()=>{
 const root=await mkdtemp(join(tmpdir(),'shared-skill-selected-'));let calls=0,allowed=true,seen=[];
 const selection={provider:'codex',model:'gpt-6.1-sol',effort:'high'};
 const provider=createRegisteredModelProvider({hostRoot:root,executable:'/usr/bin/false',complete:async({body})=>{calls++;allowed=false;return {model:body.model,choices:[{message:{role:'assistant',content:'revoked skill-derived output'},finish_reason:'stop'}]};}}).forConversation(undefined,async()=>{},undefined,undefined,undefined,{
  ghostId:'ghost',conversationId:'conversation',disclosure:async()=>'public',inspectAssignment:async()=>{},inferenceAssignment:()=>({assignment_id:'assignment',work_id:'work'}),
  transport:async request=>{
   if(request.method==='inference.settings')return {status:'success',data:{selection,external_allowed:true,credentials_present:true}};
   seen.push(request);assert.equal(request.assignment_id,'assignment');assert.equal(request.work_id,'work');return allowed?{status:'success',data:{inference_scope:'selected'}}:{status:'error',data:null};
  },
 });
 try {
  const route=await provider.selectRegistered('public');const model=provider.models.getModel(route.target.provider,route.target.modelId);const context={messages:[{role:'user',content:'hello',timestamp:1}]};
  const result=await provider.models.complete(model,context,provider.streamOptions);assert.equal(calls,1);assert.equal(result.stopReason,'error');assert.equal(result.content.some(p=>p.text==='revoked skill-derived output'),false);
  const blocked=await provider.models.complete(model,{messages:[{role:'user',content:'Compact retained skill-derived context without disclosing it.',timestamp:2}]},provider.streamOptions);assert.equal(blocked.stopReason,'error');assert.equal(calls,1);assert.ok(seen.length>=3);
 }finally{await rm(root,{recursive:true,force:true});}
});
