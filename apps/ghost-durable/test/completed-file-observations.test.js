import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { payloadDigest } from '../src/contract.js';
import { directWorkObservation } from '../src/direct-work-observation.js';
import { assignmentFileIdentity, fileExecutionId, projectCompletedFilePairs } from '../src/completed-file-observations.js';
const sha=value=>createHash('sha256').update(value,'utf8').digest('hex');
const clone=structuredClone;
function fixture() {
  const scope={originKind:'goal_assignment',contextRef:`wc-${'a'.repeat(64)}`,ghostId:'ghost-original',conversationId:'conversation-original',assignmentId:'assignment-original',workId:'work-original',goalRevision:2,generationTaskId:9,sdkConversationId:3,boundary:7};
  scope.executionId=fileExecutionId(scope);
  scope.assignmentIdentity=assignmentFileIdentity({id:scope.assignmentId,source_command_id:'source-original',ghost_id:scope.ghostId,conversation_id:scope.conversationId,goal_id:'goal-original',goal_revision:2,work_id:scope.workId,prompt:'Exact current requirements',origin_kind:'owner_goal',parent_work_id:null,root_goal_id:'goal-original'});
  const entries=[{id:8,conversationId:3,kind:'ghost.work-context-admission/1',data:{context_ref:scope.contextRef,assignment_id:scope.assignmentId,identity_digest:payloadDigest(scope.assignmentIdentity)},model:[]}],tasks=[];
  const add=(name,args,output)=>{
    const n=entries.length*10,a=n+1,r=n+2,owner=n+3,task=n+4,call=`call-${a}`;
    const assistant={role:'assistant',api:'openai-completions',provider:'fixture',model:'fixture/local',stopReason:'toolUse',timestamp:a,responseId:`response-${a}`,rawStopReason:'tool_calls',durationMs:1,content:[{type:'text',text:'Preserve this assistant text.'},{type:'toolCall',id:call,name,arguments:args}]};
    const receipt={assignment_id:scope.assignmentId,work_id:scope.workId,generation_task_id:9,task_id:task,call_id:call,input_digest:payloadDigest({operation:name,arguments:args}),execution_id:scope.executionId,state:'complete'};
    const response={status:'success',summary:'Pi tool effect observed',object_refs:[scope.executionId],artifacts:[],next_actions:[],retry_class:'same_id',error_code:null,data:{receipt,output}};
    const result={role:'toolResult',toolCallId:call,toolName:name,content:directWorkObservation(name,args,response),details:response,isError:false,timestamp:r,durationMs:1};
    entries.push({id:a,conversationId:3,kind:'pi.assistant',byTaskId:owner,model:[assistant]},{id:r,conversationId:3,kind:'pi.tool-result',byTaskId:task,data:{diagnostics:[]},model:[result]});
    tasks.push({id:owner,kind:'pi.generation',conversationId:3,state:{status:'terminal',outcome:{status:'completed',result:{entryId:a}}}},
      {id:task,kind:'pi.tool',conversationId:3,owner,input:{assistant:a,callId:call},abortRequested:false,state:{status:'terminal',outcome:{status:'completed',result:{entryId:r}}}});
    return {assistant,result,receipt,entry:entries.at(-2),resultEntry:entries.at(-1),task:tasks.at(-1)};
  };
  const input=JSON.stringify({records:Array.from({length:28},(_,i)=>({id:i,text:`Unicode 한글 ${'input-data-'.repeat(5)}`}))});
  const path=`owner-input-${'c'.repeat(64)}.json`;
  const oldCode=`# OLD FULL PROGRAM\n${'old_program_statement = 12345\n'.repeat(145)}`;
  const newCode=`# NEW FULL PROGRAM\n${'new_program_statement = 98765\n'.repeat(145)}`;
  const firstRead=add('read',{path},{content:input,sha256:sha(input)});
  const firstWrite=add('write',{path:'process.py',content:oldCode},{path:'process.py',sha256:sha(oldCode)});
  const lastRead=add('read',{path},{content:input,sha256:sha(input)});
  const lastWrite=add('write',{path:'process.py',content:newCode},{path:'process.py',sha256:sha(newCode)});
  const args=()=>({entries,contributions:entries.map(e=>e.model),tasks,scope,observedAtMs:100000});
  return {scope,entries,tasks,add,args,firstRead,firstWrite,lastRead,lastWrite,input,oldCode,newCode};
}
function projected(f){return projectCompletedFilePairs(f.args());}
function unchanged(f){assert.deepEqual(projected(f).messages,f.entries.flatMap(e=>e.model));}
function refresh(pair){pair.result.content=directWorkObservation(pair.assistant.content.at(-1).name,pair.assistant.content.at(-1).arguments,pair.result.details);}

test('completed pairs retain latest raw input/code and original rows; transient notes preserve portable text/metadata without orphan results',()=>{
  const f=fixture(),original=JSON.stringify({entries:f.entries,tasks:f.tasks}),result=projected(f);
  assert.equal(result.observations.length,2);assert.ok(result.savedWireBytes>5000);
  const wire=JSON.stringify(result.messages);
  assert.ok(!wire.includes(JSON.stringify(f.oldCode).slice(1,-1)));assert.ok(wire.includes(JSON.stringify(f.newCode).slice(1,-1)));
  assert.equal(result.messages.filter(m=>m.role==='toolResult'&&m.toolName==='read').length,1);
  assert.equal(result.messages.filter(m=>m.role==='toolResult'&&m.toolName==='write').length,1);
  for(const note of result.observations){assert.ok(Buffer.byteLength(JSON.stringify(note))<=1024);assert.equal(note.authority,'none');assert.equal(note.filesystem_state,'historical_not_current');assert.equal(note.untrusted,true);}
  const kept=result.messages.find(m=>m.role==='assistant'&&m.responseId===f.firstWrite.assistant.responseId);
  assert.deepEqual(kept,{...f.firstWrite.assistant,content:[f.firstWrite.assistant.content[0]]});
  const callIDs=result.messages.filter(m=>m.role==='assistant').flatMap(m=>m.content.filter(b=>b.type==='toolCall').map(b=>b.id));
  assert.deepEqual(result.messages.filter(m=>m.role==='toolResult').map(m=>m.toolCallId),callIDs);
  assert.equal(JSON.stringify({entries:f.entries,tasks:f.tasks}),original);
  assert.deepEqual(projected(f).observations,result.observations,'stable references have no clock-dependent identity');
});

test('identity, actual SDK completion, exact receipt, and write content proofs fail closed',()=>{
  const mutations=[
    f=>f.scope.ghostId='foreign',f=>f.scope.conversationId='foreign',f=>f.scope.assignmentIdentity.prompt+=' changed',f=>f.scope.workId='foreign',f=>f.scope.assignmentId='foreign',
    f=>f.scope.generationTaskId++,f=>f.scope.contextRef=`wc-${'d'.repeat(64)}`,f=>f.scope.executionId='e'.repeat(64),
    f=>f.scope.originKind='owner',f=>f.scope.sdkConversationId++,f=>f.entries.shift(),
    f=>f.tasks.splice(0),f=>f.tasks.forEach(t=>{if(t.kind==='pi.tool')t.state.status='pending';}),
    f=>f.tasks.forEach(t=>{if(t.kind==='pi.tool')t.owner=999;}),
    f=>f.tasks.forEach(t=>{if(t.kind==='pi.generation')t.state.outcome.result.entryId=999;}),
    f=>{for(const e of f.entries.filter(e=>e.kind==='pi.tool-result')){e.model[0].details.data.receipt.input_digest='f'.repeat(64);}},
  ];
  for(const change of mutations){const f=fixture();change(f);unchanged(f);}
  const f=fixture();f.firstWrite.receipt.state='unknown';refresh(f.firstWrite);
  assert.equal(projected(f).observations.some(n=>n.relation==='superseded_full_write'),false);
  const g=fixture();g.firstWrite.result.details.data.output.sha256='f'.repeat(64);refresh(g.firstWrite);
  assert.equal(projected(g).observations.some(n=>n.relation==='superseded_full_write'),false);
});

test('errors, diagnostics, signed/opaque/mixed rounds, duplicate IDs and non-entry contributions remain raw',()=>{
  const changes=[
    f=>{f.firstWrite.result.isError=true;},f=>{f.firstWrite.resultEntry.data.diagnostics.push({kind:'error'});},
    f=>{f.firstWrite.result.details.status='error';refresh(f.firstWrite);},
    f=>{f.firstWrite.assistant.content[0].textSignature='signed';},f=>{f.firstWrite.assistant.content.push({type:'thinking',thinking:'opaque'});},
    f=>{f.firstWrite.assistant.api='openai-responses';},f=>{f.firstWrite.assistant.opaqueProviderField='opaque';},
    f=>{f.firstWrite.assistant.content.push(clone(f.firstWrite.assistant.content.at(-1)));},
    f=>{f.firstWrite.result.content=[{type:'text',text:'filtered'}];},
    f=>{f.lastWrite.assistant.content.at(-1).id=f.firstWrite.receipt.call_id;},
    f=>{f.entries.splice(4,0,{id:32,conversationId:3,kind:'fixture.interleaved',model:[]});},
  ];
  for(const change of changes){const f=fixture();change(f);assert.equal(projected(f).observations.some(n=>n.relation==='superseded_full_write'),false);}
  const f=fixture(),args=f.args();args.contributions=clone(args.contributions);args.contributions[1][0].content[0].text='Filtered assistant';
  assert.equal(projectCompletedFilePairs(args).observations.some(n=>n.relation==='exact_duplicate_read'),false);
  const g=fixture();g.entries.push({...clone(g.firstWrite.resultEntry),id:999});unchangedWrite(g);
  function unchangedWrite(value){assert.equal(projected(value).observations.some(n=>n.relation==='superseded_full_write'),false);}
});

test('read selection/full-file hashes must both match; latest-only, tiny, partial and nonfile actions are never folded',()=>{
  for(const change of [f=>f.lastRead.result.details.data.output.sha256='f'.repeat(64),f=>f.lastRead.assistant.content.at(-1).arguments.offset=2,
    f=>f.lastRead.result.details.data.output.content+='changed']){
    const f=fixture();change(f);refresh(f.lastRead);assert.equal(projected(f).observations.some(n=>n.relation==='exact_duplicate_read'),false);
  }
  const f=fixture();f.entries=f.entries.slice(0,5);f.args=()=>({entries:f.entries,contributions:f.entries.map(e=>e.model),tasks:f.tasks,scope:f.scope,observedAtMs:100});unchanged(f);
  const g=fixture();for(const p of [g.firstWrite,g.lastWrite]){p.assistant.content.at(-1).arguments.content='tiny';p.result.details.data.output.sha256=sha('tiny');p.receipt.input_digest=payloadDigest({operation:'write',arguments:p.assistant.content.at(-1).arguments});refresh(p);}
  assert.equal(projected(g).observations.some(n=>n.relation==='superseded_full_write'),false);
});


test('errors, edits, browser/memory and user data are preserved beside otherwise eligible pairs',()=>{
  const f=fixture();
  const failed=f.add('bash',{command:'run original program'},{success:false,exit_code:1,stderr:'original error remains visible'});failed.result.isError=true;
  const edit=f.add('edit',{path:'process.py',edits:[{oldText:'before',newText:'after'}]},{path:'process.py',sha256:'e'.repeat(64)});
  const memory=f.add('work_memory_recall',{query:'original query'},{content:'UNTRUSTED_PRIVATE_MARKER'});
  const browser=f.add('browser',{operation:'snapshot'},{content:'UNTRUSTED_PAGE_MARKER'});
  f.entries.push({id:f.entries.at(-1).id+100,conversationId:3,kind:'fixture.user',model:[{role:'user',content:'ORIGINAL_OWNER_DATA',timestamp:100}]});
  const originals=[failed,edit,memory,browser].flatMap(p=>[p.assistant,p.result]);
  const result=projected(f);assert.equal(result.observations.length,2);
  for(const original of originals)assert.ok(result.messages.includes(original),'unmodified original noneligible message object is retained');
  assert.ok(result.messages.some(m=>m.content==='ORIGINAL_OWNER_DATA'));
});


test('whole-view admission proof may precede the model boundary without resurrecting older messages',()=>{
  const f=fixture(),args=f.args();
  args.admissionEntries=f.entries;args.entries=f.entries.slice(1);args.contributions=args.entries.map(e=>e.model);args.scope={...f.scope,boundary:8};
  assert.equal(projectCompletedFilePairs(args).observations.length,2);
  const missing={...args,admissionEntries:[]};assert.deepEqual(projectCompletedFilePairs(missing).messages,args.contributions.flat());
  const repeated={...args,admissionEntries:[...f.entries,{...f.entries[0],id:999}]};assert.equal(projectCompletedFilePairs(repeated).observations.length,0);
});
