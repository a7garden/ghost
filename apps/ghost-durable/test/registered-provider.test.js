import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRegisteredModelProvider,readProviderKey} from '../src/registered-models.js';
import {createLocalModelProvider} from '../src/models.js';

test('registered provider requires exact consent, rechecks revocation, and withholds memory tools',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ghost-registered-test-'));
 let allowed=false,calls=0,selection={provider:'codex',model:'gpt-6-luna',effort:'high'},exposed;
 const transport=async({method})=>({status:'success',data:method==='inference.settings'?{selection,external_allowed:allowed,credentials_present:true}:{inference_scope:'selected'}});
 const provider=createRegisteredModelProvider({hostRoot:root,executable:'/usr/bin/false',complete:async({body,effort})=>{
   calls++;assert.equal(effort,'high');assert.equal(body.model,'gpt-6-luna');assert.equal(body.tools.some(t=>t.function.name==='memory_search'),false);
   return {model:body.model,choices:[{index:0,message:{role:'assistant',content:'verified'},finish_reason:'stop'}]};
 }}).forConversation(undefined,async()=>{},async()=>['memory_search'],(_,names)=>exposed=names,undefined,{transport,ghostId:'g',conversationId:'c',disclosure:async()=> 'non_public',inspectAssignment:async()=>{}});
 try {
   await assert.rejects(provider.selectRegistered('non_public'));
   assert.equal(calls,0);allowed=true;
   const route=await provider.selectRegistered('non_public'); assert.equal(route.scope,'selected');
   const model=provider.models.getModel(route.target.provider,route.target.modelId);
   const context={messages:[{role:'user',content:'hello',timestamp:1}],tools:[{name:'memory_search',description:'private',parameters:{type:'object',properties:{}}}]};
   let result=await provider.models.complete(model,context,provider.streamOptions);
   assert.equal(result.stopReason,'stop');assert.equal(calls,1);assert.deepEqual(exposed,[]);
   allowed=false;result=await provider.models.complete(model,context,provider.streamOptions);
   assert.equal(result.stopReason,'error');assert.equal(calls,1);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('local remains an explicit option and provider keys reject unsafe files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ghost-provider-key-'));
 try {
   const local=createLocalModelProvider({baseUrl:'http://127.0.0.1:8768/v1',modelId:'local/local-test'});
   const provider=createRegisteredModelProvider({hostRoot:root,executable:'/usr/bin/false',localModelProvider:local}).forConversation(undefined,async()=>{},undefined,undefined,undefined,
     {transport:async()=>({status:'success',data:{selection:{provider:'local',model:'local/local-test',effort:'off'}}}),disclosure:async()=>'non_public'});
   assert.equal((await provider.selectRegistered('non_public')).target.provider,'ghost-local');
   await mkdir(join(root,'inference-credentials'));
   const keyPath=join(root,'inference-credentials/minimax.json');
   await writeFile(keyPath,JSON.stringify({api_key:'unit-test-secret'}),{mode:0o600});
   assert.equal(await readProviderKey(root,'minimax'),'unit-test-secret');
   await symlink(keyPath,join(root,'inference-credentials/zai-coding.json'));
   await assert.rejects(readProviderKey(root,'zai-coding'));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Codex compatibility output is withheld when consent changes during inference',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ghost-codex-revoke-'));
 let allowed=true;
 const selection={provider:'codex',model:'gpt-6.1-sol',effort:'high'};
 const provider=createRegisteredModelProvider({hostRoot:root,executable:'/usr/bin/false',complete:async({body})=>{
  allowed=false;return {model:body.model,choices:[{message:{role:'assistant',content:'revoked output'},finish_reason:'stop'}]};
 }}).forConversation(undefined,async()=>{},undefined,undefined,undefined,{
  transport:async({method})=>({status:'success',data:method==='inference.settings'?{selection,credentials_present:true,external_allowed:allowed}:{inference_scope:'selected'}}),
  ghostId:'g',conversationId:'c',disclosure:async()=>'non_public',inspectAssignment:async()=>{},
 });
 try {
  const route=await provider.selectRegistered('non_public');
  const result=await provider.models.complete(provider.models.getModel(route.target.provider,route.target.modelId),{messages:[{role:'user',content:'hello',timestamp:1}]},provider.streamOptions);
  assert.equal(result.stopReason,'error');assert.equal(result.content.some(p=>p.text==='revoked output'),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
