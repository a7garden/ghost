import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGhostRuntime } from '../src/runtime.js';
import { createBrokerModelProvider } from '../src/models.js';
import { payloadDigest } from '../src/contract.js';
import { callbackCommandId } from '../src/host-transport.js';
import { fileExecutionId } from '../src/completed-file-observations.js';
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';
const sha=value=>createHash('sha256').update(value,'utf8').digest('hex');
const ghost='file-pair-ghost',conversation='file-pair-conversation';
const a={id:'file-pair-assignment',source_command_id:'source-original',ghost_id:ghost,conversation_id:conversation,goal_id:'file-pair-goal',goal_revision:1,work_id:'file-pair-work',privacy:'public',prompt:'EXACT_OWNER_REQUIREMENTS: compute the complete input with granted tools; independent acceptance remains pending.',origin_kind:'owner_goal',parent_work_id:null,root_goal_id:'file-pair-goal'};
const context={kind:'ghost-work-context/1',ref:`wc-${'a'.repeat(64)}`,assignment_id:a.id,work_id:a.work_id,goal_revision:1,owner_revision:1,authority_epoch:1};
const command=(id,body)=>({protocol_version:'ghost-lifetime/1',command_id:id,payload_digest:payloadDigest(body),actor_ref:ghost,authority_epoch:1,expected_revision:null,correlation_id:id,body});
const assignmentFrame=()=>command(a.id,{method:'conversation.assignment',ghost_id:ghost,conversation_id:conversation,goal_id:a.goal_id,goal_revision:1,work_id:a.work_id,prompt:a.prompt,privacy:a.privacy});
const completion=(request,message)=>({id:request.id,status:200,body:{id:request.id,object:'chat.completion',model:'minimax-code/MiniMax-M2.7',created:1,choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}});

// Actual SDK generations and tool tasks, with a deterministic in-process
// transport. No native runtime, model service, or artifact acceptance is used.
async function controlled({revocation=null,proofAvailable=true}={}) {
  const root=await mkdtemp(join(tmpdir(),'ghost-file-pair-runtime-')),requests=[],effects=[],runs=new Map();
  const inputText=JSON.stringify({records:Array.from({length:28},(_,i)=>({id:i,text:`한글 unicode ${'immutable-input-'.repeat(4)}`}))});
  const oldCode=`# OLD_PROGRAM_BODY\n${'old_statement = 123456789\n'.repeat(175)}`;
  const newCode=`# NEW_PROGRAM_BODY\n${'new_statement = 987654321\n'.repeat(175)}`;
  const steps=[['read',{path:'input.json'}],['write',{path:'process.py',content:oldCode}],['read',{path:'input.json'}],['write',{path:'process.py',content:newCode}]];
  let runtime,revoked=false,wrapped=false;
  const executionId=fileExecutionId({ghostId:ghost,workId:a.work_id,goalRevision:1,assignmentId:a.id});
  const host=async inputFrame=>{
    const input=inputFrame;
    if(input.method==='inference.inspect')return {status:'success',data:{inference_scope:'public',authority_epoch:1}};
    if(['memory.capabilities','documents.capabilities'].includes(input.method))return {status:'success',data:{available_tools:[]}};
    if(input.method==='conversation.assignment.inspect')return revoked?{status:'error',data:{}}:{status:'success',data:{assignment:a,execution_context:context,skills:[],execution:{engine:'pi',version:1,tools:['read','write']}}};
    if(input.method==='work.context.claim'){assert.equal(input.context_ref,context.ref);if(!proofAvailable){const session=[...runtime.sessions.values()].find(s=>s.executionContext?.ref===context.ref);assert.ok(session);session.controllerContext.taskRecord=async()=>undefined;}return {status:'success',data:{context_ref:context.ref}};}
    if(input.method==='conversation.turn.inspect')return {status:'success',data:{run:runs.get(input.turn_id)??{turn_id:input.turn_id,ghost_id:ghost,conversation_id:conversation,state:'queued',cancel_requested:false,cancel_command_id:null,submission_id:null,entry_id:null,reason_code:null,latest_status_command_id:null,created_at_ms:1,updated_at_ms:1}}};
    if(input.method==='conversation.turn_status'){
      const run={turn_id:input.turn_id,ghost_id:ghost,conversation_id:conversation,state:input.arguments.status,cancel_requested:false,cancel_command_id:null,submission_id:input.arguments.submission_id,entry_id:input.arguments.entry_id,reason_code:input.arguments.reason_code,latest_status_command_id:callbackCommandId(ghost,conversation,input.invocation_id,input.method),created_at_ms:1,updated_at_ms:2};runs.set(input.turn_id,run);return {status:'success',data:{run}};
    }
    if(input.method==='work.execute'){
      assert.equal(input.context_ref,context.ref);assert.equal(input.assignment_id,a.id);assert.equal(input.work_id,a.work_id);
      assert.equal(input.input_digest,payloadDigest({operation:input.operation,arguments:input.arguments}));
      effects.push(input);
      const output=input.operation==='read'?{content:inputText,sha256:sha(inputText)}:{path:input.arguments.path,sha256:sha(input.arguments.content)};
      if(effects.length===4&&revocation==='before')revoked=true;
      if(effects.length===4&&revocation==='after'){
        const session=[...runtime.sessions.values()].find(s=>s.executionContext?.ref===context.ref);
        assert.ok(session);const get=session.controllerContext.taskRecord;
        session.controllerContext.taskRecord=async id=>{const record=await get(id);if(!wrapped){wrapped=true;revoked=true;}return record;};
      }
      return {status:'success',summary:'Pi tool effect observed',object_refs:[executionId],artifacts:[],next_actions:[],retry_class:'same_id',error_code:null,data:{receipt:{assignment_id:a.id,work_id:a.work_id,generation_task_id:input.generation_task_id,task_id:input.task_id,call_id:input.call_id,input_digest:input.input_digest,execution_id:executionId,state:'complete'},output}};
    }
    if(input.method==='work.execution.complete')return {status:'success',data:{assignment_id:a.id,work_id:a.work_id,task_id:input.task_id,execution_id:executionId,accepted:false}};
    if(input.method==='conversation.reply')return {status:'success',data:{turn_id:input.turn_id}};
    throw new Error(`Unexpected controlled callback ${input.method}`);
  };
  const provider=createBrokerModelProvider({modelRef:'minimax-code/MiniMax-M2.7',invoke:async request=>{
    requests.push(request);const step=steps[requests.length-1];
    return completion(request,step?{role:'assistant',content:`Controlled step ${requests.length}`,tool_calls:[{id:`file-call-${requests.length}`,type:'function',function:{name:step[0],arguments:JSON.stringify(step[1])}}]}:{role:'assistant',content:'Producer finished; independent verification is pending.'});
  }});
  try{
    runtime=await openGhostRuntime({root,mode:'broker',modelProvider:provider,hostToolTransport:host});
    assert.equal((await runtime.handle(assignmentFrame())).status,'success');await runtime.waitForIdle(ghost,conversation);
    assert.equal(effects.length,4);
    if(revocation){assert.equal(requests.length,4,'source revocation must block the next wire request, never fall back to unprojected history');if(revocation==='after')assert.ok(wrapped,'revocation occurs after real public task lookups');return;}
    assert.equal(requests.length,5);
    const last=requests.at(-1).body.messages,wire=JSON.stringify(last);
    const notes=last.filter(m=>m.role==='user'&&typeof m.content==='string'&&m.content.includes('ghost.completed-file-observation/1')).map(m=>JSON.parse(m.content));
    assert.equal(notes.length,proofAvailable?2:0,'projection needs actual public SDK task proof');
    assert.equal(notes.filter(n=>n.relation==='exact_duplicate_read').length,proofAvailable?1:0);
    assert.equal(notes.filter(n=>n.relation==='superseded_full_write').length,proofAvailable?1:0);
    assert.ok(wire.includes(a.prompt));assert.ok(wire.includes(JSON.stringify(inputText).slice(1,-1)));assert.equal(wire.includes('OLD_PROGRAM_BODY'),!proofAvailable);assert.ok(wire.includes('NEW_PROGRAM_BODY'));
    assert.equal(last.filter(m=>m.role==='tool').length,proofAvailable?2:4);
    const calls=last.flatMap(m=>m.tool_calls??[]).map(c=>c.id);assert.deepEqual(last.filter(m=>m.role==='tool').map(m=>m.tool_call_id),calls);
    const session=[...runtime.sessions.values()].find(s=>s.executionContext?.ref===context.ref);assert.ok(session);
    const before=await session.database.all('SELECT id,record FROM entries ORDER BY id');
    const originalTasks=await session.database.all('SELECT id,record FROM tasks ORDER BY id');
    const raw=before.flatMap(row=>JSON.parse(row.record).model??[]);
    assert.ok(JSON.stringify(raw).includes('OLD_PROGRAM_BODY'));assert.equal(raw.filter(m=>m.role==='toolResult').length,4);
    assert.ok(!JSON.stringify(raw).includes('ghost.completed-file-observation/1'),'no synthetic durable entry');
    // Compare only action rounds: headers/current requirements are identical.
    const wireActionBytes=Buffer.byteLength(JSON.stringify(last.filter(m=>['assistant','tool'].includes(m.role)||m.role==='user'&&m.content.includes('ghost.completed-file-observation/1'))));
    const wireTextTokenEstimate=estimateTextTokens(wire);
    const count=requests.length;
    await runtime.close();runtime=null;
    runtime=await openGhostRuntime({root,mode:'broker',modelProvider:provider,hostToolTransport:host});
    assert.equal((await runtime.handle(assignmentFrame())).status,'success');await runtime.waitForIdle(ghost,conversation);
    const reopened=[...runtime.sessions.values()].find(s=>s.executionContext?.ref===context.ref);assert.ok(reopened);
    assert.deepEqual(await reopened.database.all('SELECT id,record FROM entries ORDER BY id'),before,'all original entry/argument/receipt/timestamp bytes survive cold reopen');
    assert.deepEqual(await reopened.database.all('SELECT id,record FROM tasks ORDER BY id'),originalTasks,'completed task identities/outcomes are unchanged');
    assert.equal(requests.length,count);assert.equal(effects.length,4);
    return {wireActionBytes,wireTextTokenEstimate};
  }finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
}
test('actual isolated SDK assignment saves wire bytes, skips unavailable proof and preserves cold durable records',async()=>{
  const raw=await controlled({proofAvailable:false}),projected=await controlled();
  assert.ok(raw.wireActionBytes-projected.wireActionBytes>5000,'actual provider wire saves over 5KiB with 4KiB programs and 2KiB input equivalents');
  assert.ok(projected.wireActionBytes<raw.wireActionBytes*0.75);
  assert.ok(projected.wireTextTokenEstimate<raw.wireTextTokenEstimate,
    'SDK text-token estimate decreases for the complete captured wire; this is not actual tokenizer usage, reserve or task quality');
});
test('source revocation before optional projection blocks outbound inference',()=>controlled({revocation:'before'}));
test('source revocation during public task-proof lookup blocks outbound inference after projection',()=>controlled({revocation:'after'}));
