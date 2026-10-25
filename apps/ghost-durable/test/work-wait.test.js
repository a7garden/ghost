import assert from "node:assert/strict";
import {test} from "node:test";
import {createWorkWaitTask,verifiedWorkWaitReceipt,workWaitBody,waitForWork} from "../src/work-wait.js";
import {callbackCommandId} from "../src/host-transport.js";
import {payloadDigest} from "../src/contract.js";
const request={method:"work.wait",invocation_id:"original",ghost_id:"ghost",conversation_id:"conversation",assignment_id:"assignment",work_id:"work",generation_task_id:7,wait_goal_revision:3,arguments:{work_id:"work",wait_for:["child"]}};
const receipt={kind:"pi-work-wait/1",assignment_id:"assignment",work_id:"work",generation_task_id:7,goal_revision:3,owner_revision:1,authority_epoch:1,execution_id:"execution",wait_command_id:callbackCommandId("ghost","conversation","original","work.wait"),wait_payload_digest:payloadDigest(workWaitBody(request)),wait_for:["child"]};
const response=phase=>({status:"success",data:{wait_receipt:receipt,phase}});
function runtime(){const r={state:null,conversationId:1,now:()=>10,sleep:async()=>{},commit:async fn=>{r.state=await fn({doc:async()=>r.doc});},doc:{assignment_id:"assignment"}};return r;}
test("wait child admits only original request after a lost ACK and polls only its exact receipt",async()=>{
 const calls=[];let lost=true;const task=createWorkWaitTask({dispatch:async input=>{calls.push(input);if(lost){lost=false;throw Error("lost ACK");}return response(input.method==="work.wait"?undefined:"waiting");},validate:async()=>{}});const r=runtime();
 let t={input:{request}};await task.definition.phases.admit(t,r,{});assert.equal(r.state.checkpoint.phase,"retry");
 await task.definition.phases.retry({...t,state:r.state},r,{});await task.definition.phases.admit(t,r,{});
 assert.deepEqual(calls[0],calls[1]);assert.equal(r.state.checkpoint.phase,"poll");
 await task.definition.phases.poll({...t,state:r.state},r,{});assert.equal(r.state.checkpoint.phase,"sleep");
 assert.equal(calls[2].method,"work.wait.inspect");assert.deepEqual(calls[2].arguments,{wait_command_id:receipt.wait_command_id,wait_payload_digest:receipt.wait_payload_digest,wait_for:["child"]});
});
test("changed receipt/target and revoked authority settle unknown and persist a durable inference fence",async()=>{
 assert.equal(verifiedWorkWaitReceipt({...receipt,wait_for:["other"]},request),false);
 assert.equal(verifiedWorkWaitReceipt({...receipt,wait_payload_digest:"0".repeat(64)},request),false);
 for(const mode of ["receipt","authority","rejected"]){const r=runtime();const task=createWorkWaitTask({doc:{},validate:async()=>{if(mode==="authority")throw Error("revoked");},dispatch:async()=>{if(mode==="rejected")throw Object.assign(Error("known refused"),{code:"host_callback_rejected"});return{status:"success",data:{wait_receipt:{...receipt,generation_task_id:8}}};}});
 await task.definition.phases.admit({input:{request}},r,{});assert.equal(r.state.status,"terminal");assert.equal(r.state.outcome.result.error_code,"pi_wait_unconfirmed");assert.equal(r.doc.wait_failed,"original");}
});
test("original owned child and intent are committed before dispatch and duplicate/mutated intents are rejected",async()=>{
 const task=createWorkWaitTask({dispatch:async()=>{throw Error("must not call in transaction");},validate:async()=>{}}),run={assignment_id:"assignment",generation_task_id:7},records=[];let created=0;
 const api={taskId:9,conversationId:1,commit:async fn=>fn({doc:async()=>run,scanTasks:async()=>({items:records}),createTask:async(_task,input,options)=>{assert.deepEqual(run.wait_intent,request);created++;records.push({id:10,owner:options.ownership.taskId,input});return 10;}}),waitForTask:async()=>({state:{outcome:{status:"completed",result:response("resolved")}}})};
 await waitForWork({api,task,request,context:{},doc:{}});await waitForWork({api,task,request,context:{},doc:{}});assert.equal(created,1);
 await assert.rejects(waitForWork({api,task,request:{...request,arguments:{work_id:"work",wait_for:["changed"]}},context:{},doc:{}}));
});
