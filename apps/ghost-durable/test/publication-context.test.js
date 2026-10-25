import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGhostRuntime } from "../src/runtime.js";
import { createBrokerModelProvider, createLocalModelProvider } from "../src/models.js";
import { createHostToolTransport } from "../src/host-transport.js";
import { payloadDigest } from "../src/contract.js";
import { validatePublicationDescriptor } from "../src/publication-context.js";
import { openPiConversationStorage, openGhostIndex } from "../src/storage.js";
const ghost="publication-ghost",conversation="publication-conversation",secret="PUBLISHED_VIEW_BYTES_ONLY",derived="DERIVED_FROM_PUBLISHED_VIEW",revision="a".repeat(64),model="mlx-community/Qwen3.6-35B-A3B-4bit";
const reference={reference:"mp-opaque-reference",citation:"publication://opaque-view",view_revision:revision};
const assignment={id:"publication-assignment",source_command_id:"source",ghost_id:ghost,conversation_id:conversation,goal_id:"goal",goal_revision:1,work_id:"work",prompt:"Use the explicitly published source view.",privacy:"private",origin_kind:"owner_goal",parent_work_id:null,root_goal_id:"goal"};
function envelope(id,work=false) {const body=work?{method:"conversation.assignment",ghost_id:ghost,conversation_id:conversation,goal_id:"goal",goal_revision:1,work_id:"work",prompt:assignment.prompt,privacy:"private"}:{method:"conversation.input",ghost_id:ghost,conversation_id:conversation,turn_id:id,prompt:id==="source-turn"?"Read the permitted published source.":"Answer this independent new request.",privacy:"private",attachments:[]};return {protocol_version:"ghost-lifetime/1",command_id:work?assignment.id:id,payload_digest:payloadDigest(body),actor_ref:ghost,authority_epoch:1,expected_revision:null,correlation_id:id,body};}
function fixture({required=false,initialBlocked=false,revokeAtRead=false,revokeAtAnswer=false}={}) {
 let revoked=initialBlocked,read=false;const callbacks=[],requests=[],runs=new Map();
 const transport=async input=>{callbacks.push(input);switch(input.method){
 case "inference.inspect":return {status:"success",data:{inference_scope:"local",authority_epoch:1}};
 case "conversation.assignment.inspect":return {status:"success",data:{assignment,skills:[],publications:{version:"ghost-memory-publication/1",references:[reference],required}}};
 case "memory.capabilities":case "documents.capabilities":return {status:"success",data:{available_tools:[]}};
 case "memory.publication.capabilities":return {status:"success",data:{version:"ghost-memory-publication/1",references:[reference]}};
 case "memory.publication.context.inspect":return revoked?{status:"error",data:null}:{status:"success",data:{context_revision:"b".repeat(64),memory_permitted:true,dependencies:read||required?[{reference:reference.reference,view_revision:revision}]:[]}};
 case "memory.publication.read":read=true;if(revokeAtRead)revoked=true;return {status:"success",data:{view:{version:"source-view-publication/1",publication_id:"opaque-view",citation:reference.citation,view_revision:revision,range:{start:0,end:secret.length},bytes:secret,state:"current",extractable:false,independent_support:false,uncertainty:{contradiction_rate:0,single_source_fraction:1,staleness:0,trust_exclusion_fraction:1}},dependency:{reference:reference.reference,view_revision:revision}}};
 case "conversation.turn.inspect":return {status:"success",data:{run:runs.get(input.turn_id)??{turn_id:input.turn_id,ghost_id:ghost,conversation_id:conversation,state:"queued",cancel_requested:false,cancel_command_id:null,submission_id:null,entry_id:null,reason_code:null,latest_status_command_id:null,created_at_ms:1,updated_at_ms:1}}};
 case "conversation.turn_status":{const run={turn_id:input.turn_id,ghost_id:ghost,conversation_id:conversation,state:input.arguments.status,cancel_requested:false,cancel_command_id:null,submission_id:input.arguments.submission_id,entry_id:input.arguments.entry_id,reason_code:input.arguments.reason_code,latest_status_command_id:input.invocation_id,created_at_ms:1,updated_at_ms:2};runs.set(input.turn_id,run);return {status:"success",data:{run}};}
 case "work.execution.complete":return {status:"success",data:{assignment_id:input.assignment_id,work_id:input.work_id,task_id:input.task_id}};
 case "conversation.reply":return {status:"success",data:{turn_id:input.turn_id}};
 default:throw Error(`Unexpected publication callback ${input.method}`);
 }};
 const local=createLocalModelProvider({baseUrl:"http://127.0.0.1:8768/v1",modelId:model,fetchImpl:async(_url,options)=>{
  const body=JSON.parse(options.body);requests.push(body);
  const message=!read&&body.tools.some(tool=>tool.function.name==="source_view_read")?{role:"assistant",content:null,tool_calls:[{id:"read-view",type:"function",function:{name:"source_view_read",arguments:JSON.stringify({reference:reference.reference})}}]}:{role:"assistant",content:JSON.stringify(body.messages).includes(secret)?derived:"Fresh independent answer."};
  if(revokeAtAnswer&&message.content===derived)revoked=true;
  return new Response(JSON.stringify({id:`response-${requests.length}`,object:"chat.completion",model,choices:[{index:0,message,finish_reason:message.tool_calls?"tool_calls":"stop"}]}),{status:200,headers:{"content-type":"application/json"}});
 }});
 return {callbacks,requests,transport,provider:createBrokerModelProvider({modelRef:"minimax-code/MiniMax-M2.7",localModelProvider:local,invoke:async()=>{throw Error("No external model authorized");}}),revoke:()=>{revoked=true;}};
}
async function opened(root,f){return openGhostRuntime({root,mode:"broker",modelProvider:f.provider,hostToolTransport:f.transport});}
test("publication wire accepts only bound Host-issued references",async()=>{
 const requests=[];const transport=createHostToolTransport({hostRoot:"/tmp/publication-wire-fixture",callbackToken:"fixture",localCallbackToken:"fixture-local",authorityEpoch:1,dispatch:async input=>{requests.push(input);return {ok:true,result:{status:"success",summary:"fixture",artifacts:[],next_actions:[],data:{}}};}});
 const base={method:"memory.publication.read",invocation_id:"read",ghost_id:ghost,conversation_id:conversation,turn_id:"owner-turn",inference_scope:"local",conversation_disclosure:"non_public",arguments:{reference:reference.reference}};
 await transport(base);assert.deepEqual(requests[0].envelope.body,{method:base.method,ghost_id:ghost,conversation_id:conversation,turn_id:"owner-turn",reference:reference.reference});
 for(const extra of [{destination:"common"},{origin_token:"secret"},{work_id:"another-work"},{view_revision:revision}])await assert.rejects(transport({...base,arguments:{...base.arguments,...extra}}));
 await assert.rejects(transport({...base,inference_scope:"public"}));await assert.rejects(transport({...base,assignment_id:"assignment",work_id:"work"}));assert.equal(requests.length,1);
 assert.throws(()=>validatePublicationDescriptor({version:"ghost-memory-publication/1",references:[{...reference,origin:"private-root"}],required:false}));
});
test("Pi drops old published bytes and derived answers on fresh input and after reopen",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ghost-publication-context-")),f=fixture();let runtime;
 try{runtime=await opened(root,f);await runtime.handle(envelope("source-turn"));await runtime.waitForIdle(ghost,conversation);assert.equal(f.requests.length,2,JSON.stringify({tools:f.requests[0]?.tools.map(t=>t.function.name),callbacks:f.callbacks.map(c=>c.method)}));assert.ok(JSON.stringify(f.requests[1]).includes(secret));assert.ok(f.callbacks.some(input=>input.method==="conversation.reply"&&input.arguments.text===derived));
 f.revoke();await runtime.handle(envelope("fresh-turn"));await runtime.waitForIdle(ghost,conversation);assert.equal(f.requests.length,3);assert.ok(!JSON.stringify(f.requests[2]).includes(secret));assert.ok(!JSON.stringify(f.requests[2]).includes(derived));
 await runtime.close();runtime=null;runtime=await opened(root,f);await runtime.handle(envelope("after-reopen"));await runtime.waitForIdle(ghost,conversation);assert.equal(f.requests.length,4);assert.ok(!JSON.stringify(f.requests[3]).includes(secret));assert.ok(!JSON.stringify(f.requests[3]).includes(derived));
 const index=await openGhostIndex(root,ghost);try{assert.ok((await index.all("SELECT * FROM ghost_publication_context_provenance")).length>0);assert.ok((await index.get("SELECT cutoff_entry_id FROM ghost_publication_context_boundaries WHERE conversation_id=?",conversation)).cutoff_entry_id>0);}finally{await index.close();}
 }finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
});
for(const [title,options] of [["revoked before result delivery",{revokeAtRead:true}],["withdrawn while inference is running",{revokeAtAnswer:true}]])test(`Pi withholds publication-derived output when ${title}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),"ghost-publication-revoke-")),f=fixture(options);let runtime;
 try{runtime=await opened(root,f);await runtime.handle(envelope("source-turn"));await runtime.waitForIdle(ghost,conversation);assert.ok(f.callbacks.some(input=>input.method==="memory.publication.read"));if(options.revokeAtRead)assert.ok(f.requests.slice(1).every(request=>!JSON.stringify(request).includes(secret)));assert.ok(!f.callbacks.some(input=>input.method==="conversation.reply"&&JSON.stringify(input).includes(derived)));}
 finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
});
test("required inherited publication lineage gates first inference with no local recall",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ghost-publication-required-")),f=fixture({required:true,initialBlocked:true});let runtime;
 try{runtime=await opened(root,f);await runtime.handle(envelope("assignment",true));await runtime.waitForIdle(ghost,conversation);assert.equal(f.requests.length,0);assert.ok(f.callbacks.some(input=>input.method==="memory.publication.context.inspect"));assert.ok(!f.callbacks.some(input=>input.method==="work.execution.complete"));}
 finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
});

test("reopened publication-derived compaction checkpoint cannot call a provider or persist a summary",async()=>{
 for(const abortRequested of [false,true]) {
  const root=await mkdtemp(join(tmpdir(),"ghost-publication-compaction-")),f=fixture();let runtime;
  try{runtime=await opened(root,f);await runtime.handle(envelope("source-turn"));await runtime.waitForIdle(ghost,conversation);await runtime.close();runtime=null;f.revoke();
   const stored=await openPiConversationStorage(root,ghost,conversation);let taskId;
   try{const conv=await stored.database.get("SELECT id FROM conversations LIMIT 1"),last=await stored.database.get("SELECT MAX(id) AS id FROM entries WHERE conversation_id=?",conv.id);taskId=(await stored.database.get("SELECT MAX(id) AS id FROM tasks")).id+100;
    const record={id:taskId,conversationId:conv.id,kind:"pi.compaction",version:1,input:{reason:"manual"},background:false,abortRequested,state:{status:"running",checkpoint:{phase:"summarize",attempt:1,model:{provider:"ghost-local",modelId:model},thinkingLevel:"off",streamOptions:{},maxTokens:100,tail:last.id,firstKept:last.id}}};
    await stored.database.run("INSERT INTO tasks(id,conversation_id,kind,status,abort_requested,background,record) VALUES (?,?,'pi.compaction','running',?,0,?)",taskId,conv.id,abortRequested?1:0,JSON.stringify(record));
   }finally{await stored.database.close();}
   const before=f.requests.length;runtime=await opened(root,f);const body={method:"runtime.reconcile",ghost_id:ghost,conversation_id:conversation};await runtime.handle({protocol_version:"ghost-lifetime/1",command_id:"reconcile-publication",payload_digest:payloadDigest(body),actor_ref:ghost,authority_epoch:1,expected_revision:null,correlation_id:"reconcile-publication",body});await runtime.waitForIdle(ghost,conversation);assert.equal(f.requests.length,before);await runtime.close();runtime=null;
   const checked=await openPiConversationStorage(root,ghost,conversation);try{const record=JSON.parse((await checked.database.get("SELECT record FROM tasks WHERE id=?",taskId)).record);assert.equal(record.state.status,"terminal");assert.notEqual(record.state.outcome.status,"completed");assert.equal((await checked.database.all("SELECT record FROM entries WHERE json_extract(record,'$.kind')='pi.compaction'")).length,0);}finally{await checked.database.close();}
  }finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
 }
});

test('publication tools are absent from actual public inference and ungranted local Owner requests',async()=>{
 for(const route of ['public','local']) {
  const root=await mkdtemp(join(tmpdir(),'ghost-publication-inventory-')),f=fixture();let runtime;const publicRequests=[];
  const original=f.transport;f.transport=async input=>{
   if(input.method==='inference.inspect'){f.callbacks.push(input);return {status:'success',data:{inference_scope:route}};}
   if(input.method==='memory.publication.capabilities'){f.callbacks.push(input);assert.equal(route,'local','public inference must not query local publication capabilities');return {status:'success',data:{version:'ghost-memory-publication/1',references:[]}};}
   return original(input);
  };
  const provider=route==='local'?f.provider:createBrokerModelProvider({modelRef:'minimax-code/MiniMax-M2.7',invoke:async request=>{publicRequests.push(request.body);return {id:request.id,status:200,body:{id:'public-no-publications',object:'chat.completion',model:request.body.model,created:1,choices:[{index:0,message:{role:'assistant',content:'No source grant is available.'},finish_reason:'stop'}]}};}});
  try {
   runtime=await openGhostRuntime({root,mode:'broker',modelProvider:provider,hostToolTransport:f.transport});const input=envelope('source-turn');if(route==='public'){input.body.privacy='public';input.payload_digest=payloadDigest(input.body);}
   assert.equal((await runtime.handle(input)).status,'success');await runtime.waitForIdle(ghost,conversation);
   const requests=route==='local'?f.requests:publicRequests;assert.equal(requests.length,1);assert.equal(requests[0].tools.some(tool=>['source_view_list','source_view_read'].includes(tool.function?.name)),false);
   assert.equal(f.callbacks.some(input=>input.method==='memory.publication.read'),false);
  }finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
 }
});
