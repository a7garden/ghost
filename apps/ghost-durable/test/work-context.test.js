import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,rm,mkdir,cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { openGhostRuntime } from '../src/runtime.js';
import { createBrokerModelProvider,createLocalModelProvider } from '../src/models.js';
import { callbackCommandId } from '../src/host-transport.js';
import { workWaitBody } from '../src/work-wait.js';
import { payloadDigest } from '../src/contract.js';
import { openGhostIndex,openPiConversationStorage } from '../src/storage.js';
const ghost='same-ghost', conversation='same-owner-conversation';
const command=(id,body)=>({protocol_version:'ghost-lifetime/1',command_id:id,payload_digest:payloadDigest(body),actor_ref:ghost,authority_epoch:1,expected_revision:null,correlation_id:id,body});
const completion=(request,message)=>({id:request.id,status:200,body:{id:request.id,object:'chat.completion',model:'minimax-code/MiniMax-M2.7',created:1,choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}});
const tool=(name,args)=>({role:'assistant',content:null,tool_calls:[{id:'shared-call-id',type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const until=async predicate=>{for(let n=0;n<200;n++){if(await predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Controlled work did not progress while Owner inference remained pending');};

function fixture({park=false,required=false}={}) {
  let sourceRevoked=false,ownerHistoryRevoked=false;
  let waitReceipt=null,waitPhase="waiting",waitObserved=0;
  const runs=new Map(),calls=[],claims=new Map(),requests=[],steps=new Map();let ownerPending=false,releaseOwner;
  const ownerGate=new Promise(resolve=>{releaseOwner=resolve;});
  const assignments=new Map(['one','two'].map((name,i)=>{
    const id=`assignment-${name}`,work=`work-${name}`;
    return [id,{id,source_command_id:`source-${name}`,ghost_id:ghost,conversation_id:conversation,goal_id:`goal-${name}`,goal_revision:1,work_id:work,privacy:required?'private':'public',prompt:`Produce ${name} from immutable input only.`,origin_kind:'owner_goal',parent_work_id:null,root_goal_id:`goal-${name}`}];
  }));
  const descriptor=a=>({kind:'ghost-work-context/1',ref:`wc-${(a.id.endsWith('one')?'a':'b').repeat(64)}`,assignment_id:a.id,work_id:a.work_id,goal_revision:1,owner_revision:1,authority_epoch:1});
  const host=async input=>{
    calls.push(input);
    if(input.method==='inference.inspect') {if(ownerHistoryRevoked&&!input.context_ref)throw new Error('Unbound Owner inference history revoked');if(input.assignment_id)assert.equal(input.context_ref,descriptor(assignments.get(input.assignment_id)).ref);return {status:'success',data:{inference_scope:input.inference_scope}};}
    if(['memory.capabilities','documents.capabilities'].includes(input.method))return {status:'success',data:{available_tools:[]}};
    if(input.method==='conversation.turn.inspect')return {status:'success',data:{run:runs.get(input.turn_id)??{turn_id:input.turn_id,ghost_id:ghost,conversation_id:conversation,state:'queued',cancel_requested:false,cancel_command_id:null,submission_id:null,entry_id:null,reason_code:null,latest_status_command_id:null,created_at_ms:1,updated_at_ms:1}}};
    if(input.method==='conversation.turn_status'){const run={turn_id:input.turn_id,ghost_id:ghost,conversation_id:conversation,state:input.arguments.status,cancel_requested:false,cancel_command_id:null,submission_id:input.arguments.submission_id,entry_id:input.arguments.entry_id,reason_code:input.arguments.reason_code,latest_status_command_id:input.invocation_id,created_at_ms:1,updated_at_ms:2};runs.set(input.turn_id,run);return {status:'success',data:{run}};}
    if(input.method==='conversation.assignment.inspect'){if(ownerHistoryRevoked&&!input.context_ref)throw new Error('Unbound Owner history revoked');const a=assignments.get(input.assignment_id);return {status:'success',data:{assignment:a,execution_context:descriptor(a),execution:{engine:'pi',version:1},...(required?{work_memory:{available_tools:['work_memory_recall'],required:true,status:'ready',context_revision:'c'.repeat(64)},publications:{version:'ghost-memory-publication/1',required:true,references:[{reference:'publication-ref',citation:'publication://controlled',view_revision:'d'.repeat(64)}]}}:{}),...(a.id==='assignment-one'&&waitReceipt?{work_wait:{receipt:waitReceipt,phase:waitPhase}}:{})}};}
    if(input.method==='work.memory.context.inspect')return sourceRevoked?{status:'error',data:{}}:{status:'success',data:{memory_permitted:true,context_revision:'c'.repeat(64)}};
    if(input.method==='memory.publication.context.inspect')return sourceRevoked?{status:'error',data:{}}:{status:'success',data:{memory_permitted:true,context_revision:'e'.repeat(64),dependencies:[{reference:'publication-ref',view_revision:'d'.repeat(64)}]}};
    if(input.method==='work.context.claim'){const a=assignments.get(input.assignment_id);assert.equal(input.context_ref,descriptor(a).ref);const value={...input.arguments};if(claims.has(a.id))assert.deepEqual(value,claims.get(a.id));else claims.set(a.id,value);return {status:'success',data:{context_ref:input.context_ref}};}
    if(input.method==='work.wait'){waitReceipt??={kind:'pi-work-wait/1',assignment_id:input.assignment_id,work_id:input.work_id,goal_revision:1,owner_revision:1,generation_task_id:input.generation_task_id,authority_epoch:1,wait_command_id:callbackCommandId(ghost,conversation,input.invocation_id,'work.wait'),wait_payload_digest:payloadDigest(workWaitBody(input)),wait_for:input.arguments.wait_for,execution_id:'execution-work-one'};return {status:'success',summary:'Original wait committed',artifacts:[],next_actions:[],data:{wait_receipt:waitReceipt}};}
    if(input.method==='work.wait.inspect'){waitObserved++;return {status:'success',summary:'Original wait inspected',artifacts:[],next_actions:[],data:{wait_receipt:waitReceipt,phase:waitPhase}};}
    if(input.method==='work.children')return {status:'success',summary:'Scoped children',artifacts:[],next_actions:[],data:{}};
    if(input.method==='work.execute')return {status:'success',summary:'Durable synthetic effect receipt',artifacts:[],next_actions:[],data:{receipt:{assignment_id:input.assignment_id,work_id:input.work_id,generation_task_id:input.generation_task_id,task_id:input.task_id,call_id:input.call_id,input_digest:input.input_digest,execution_id:`execution-${input.work_id}`,state:'complete'}}};
    if(input.method==='work.execution.complete')return {status:'success',data:{assignment_id:input.assignment_id,work_id:input.work_id,task_id:input.task_id,execution_id:`execution-${input.work_id}`,accepted:false}};
    if(input.method==='conversation.reply')return {status:'success',data:{turn_id:input.turn_id}};
    throw new Error(`Unexpected callback ${input.method}`);
  };
  const invoke=async (request,signal)=>{
    requests.push(request);
    const system=request.body.messages.filter(m=>['system','developer'].includes(m.role)).map(m=>m.content).join('\n');
    const a=[...assignments.values()].find(a=>system.includes(`"assignment_id":"${a.id}"`));
    if(!a){ownerPending=true;await Promise.race([ownerGate,new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})]);return completion(request,{role:'assistant',content:'Owner remains responsible; background progress is independently verified.'});}
    assert.ok(!JSON.stringify(request.body.messages).includes('OWNER-ONLY-PRIVATE-MARKER'));
    const other=a.id.endsWith('one')?'two':'one';assert.ok(!JSON.stringify(request.body.messages).includes(`Produce ${other} from immutable input only.`));
    const n=steps.get(a.id)??0;steps.set(a.id,n+1);
    return completion(request,n===0?tool('work_children',{work_id:a.work_id}):n===1?tool('write',{path:'answer.txt',content:a.work_id}):park&&a.id==='assignment-one'&&n===2?tool('work_wait',{work_id:a.work_id,wait_for:['child-dependency']}):park&&a.id==='assignment-one'&&n===3?tool('edit',{path:'answer.txt',edits:[{oldText:a.work_id,newText:'resumed-original'}]}):{role:'assistant',content:`Produced ${a.work_id}; independent Host acceptance is pending.`});
  };
  const local=createLocalModelProvider({baseUrl:'http://127.0.0.1:8768/v1',modelId:'fixture/local',fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body);const frame=await invoke({id:'controlled-local',body},options.signal);frame.body.model=body.model;return new Response(JSON.stringify(frame.body),{headers:{'content-type':'application/json'}});}});
  const provider=createBrokerModelProvider({modelRef:'minimax-code/MiniMax-M2.7',invoke,localModelProvider:local});
  return {host,provider,calls,claims,requests,runs,assignments,descriptor,releaseOwner,get ownerPending(){return ownerPending;},get waitObserved(){return waitObserved;},get waitPhase(){return waitPhase;},set waitPhase(value){waitPhase=value;},set sourceRevoked(value){sourceRevoked=value;},set ownerHistoryRevoked(value){ownerHistoryRevoked=value;}};
}

test('same Ghost Work contexts progress before Owner inference returns and reopen the exact context without a second effect',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ghost-isolated-work-'));const f=fixture();let runtime;
  try{
    runtime=await openGhostRuntime({root,mode:'broker',modelProvider:f.provider,hostToolTransport:f.host,onDiagnostic:diagnostic=>console.error('controlled-diagnostic',diagnostic)});
    assert.equal((await runtime.handle(command('owner-input',{method:'conversation.input',ghost_id:ghost,conversation_id:conversation,turn_id:'owner-turn',prompt:'OWNER-ONLY-PRIVATE-MARKER keep this Owner turn pending while work progresses.',privacy:'public',attachments:[]}))).status,'success');
    await until(()=>f.ownerPending);
    for(const a of f.assignments.values()){
      const body={method:'conversation.assignment',ghost_id:ghost,conversation_id:conversation,goal_id:a.goal_id,goal_revision:1,work_id:a.work_id,prompt:a.prompt,privacy:a.privacy};
      const replies=await Promise.all([runtime.handle(command(a.id,body)),runtime.handle(command(a.id,body))]);assert.deepEqual(replies[0],replies[1]);const ack=replies[0];assert.equal(ack.status,'success',JSON.stringify(ack));assert.equal(ack.data.context_ref,f.descriptor(a).ref);assert.ok(ack.data.storage_ref.includes('/work-contexts/'));
    }
    try { await until(()=>f.calls.filter(c=>c.method==='work.execution.complete').length===2); } catch(error) { console.error('controlled-state',JSON.stringify({calls:f.calls.map(c=>[c.method,c.assignment_id,c.context_ref]),runs:[...f.runs],requests:f.requests.map(r=>r.body.messages.filter(m=>['system','developer'].includes(m.role)).map(m=>m.content))}));throw error; }
    assert.equal(f.runs.get('owner-turn').state,'running','Owner generation has not returned');
    assert.equal(f.claims.size,2);assert.equal(new Set([...f.claims.values()].map(c=>c.provider_session_id)).size,2);
    const children=f.calls.filter(c=>c.method==='work.children');assert.equal(children.length,2);assert.equal(new Set(children.map(c=>c.invocation_id)).size,2,'same numeric SDK IDs and call IDs cannot collide across contexts');
    assert.ok(children.every(c=>c.context_ref&&c.ghost_id===ghost&&c.conversation_id===conversation));
    f.releaseOwner();await runtime.waitForIdle(ghost,conversation);
    const index=await openGhostIndex(root,ghost);let before;
    try{before=await index.all('SELECT * FROM ghost_work_contexts ORDER BY assignment_id');assert.equal(before.length,2);assert.equal((await index.all('SELECT * FROM ghost_conversations')).length,1,'no fake canonical conversation is registered');}finally{await index.close();}
    const count=f.requests.length,effects=f.calls.filter(c=>c.method==='work.execute').length;
    await runtime.close();runtime=await openGhostRuntime({root,mode:'broker',modelProvider:f.provider,hostToolTransport:f.host,onDiagnostic:diagnostic=>console.error('controlled-diagnostic',diagnostic)});
    const reconcile=await runtime.handle(command('reconcile',{method:'runtime.reconcile',ghost_id:ghost,conversation_id:conversation}));assert.equal(reconcile.status,'success');await runtime.waitForIdle(ghost,conversation);
    assert.equal(f.requests.length,count);assert.equal(f.calls.filter(c=>c.method==='work.execute').length,effects);
    const reopened=await openGhostIndex(root,ghost);try{assert.deepEqual(await reopened.all('SELECT * FROM ghost_work_contexts ORDER BY assignment_id'),before);}finally{await reopened.close();}
  }finally{f.releaseOwner();await runtime?.close();await rm(root,{recursive:true,force:true});}
});

test('parked isolated Work retains original generation/wait/provider across reopen and Owner cancellation leaves it live',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ghost-isolated-wait-')),f=fixture({park:true});let runtime;
  try{
    runtime=await openGhostRuntime({root,mode:'broker',modelProvider:f.provider,hostToolTransport:f.host});
    await runtime.handle(command('owner-input',{method:'conversation.input',ghost_id:ghost,conversation_id:conversation,turn_id:'owner-turn',prompt:'OWNER-ONLY-PRIVATE-MARKER hold Owner reasoning.',privacy:'public',attachments:[]}));
    await until(()=>f.ownerPending);
    for(const a of f.assignments.values())assert.equal((await runtime.handle(command(a.id,{method:'conversation.assignment',ghost_id:ghost,conversation_id:conversation,goal_id:a.goal_id,goal_revision:1,work_id:a.work_id,prompt:a.prompt,privacy:a.privacy}))).status,'success');
    await until(()=>f.waitObserved>0&&f.calls.some(c=>c.method==='work.execution.complete'&&c.work_id==='work-two'));
    assert.equal(f.runs.get('owner-turn').state,'running');
    const cancellation=await runtime.handle(command('cancel-owner',{method:'conversation.cancel_turn',ghost_id:ghost,conversation_id:conversation,turn_id:'owner-turn'}));assert.equal(cancellation.status,'success');
    await until(()=>f.runs.get('owner-turn')?.state==='cancelled');
    assert.equal(f.calls.some(c=>c.method==='work.execution.complete'&&c.work_id==='work-one'),false);
    const originalClaim={...f.claims.get('assignment-one')},requestCount=f.requests.length;
    const beforeEffects=f.calls.filter(c=>c.method==='work.execute'&&c.work_id==='work-one');assert.equal(beforeEffects.length,1);
    const oldWait=f.calls.find(c=>c.method==='work.wait');
    await runtime.close();runtime=null;f.ownerHistoryRevoked=true;
    runtime=await openGhostRuntime({root,mode:'broker',modelProvider:f.provider,hostToolTransport:f.host});
    await runtime.handle(command('reconcile-after-wait',{method:'runtime.reconcile',ghost_id:ghost,conversation_id:conversation}));
    await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.requests.length,requestCount,'cold parked context admits no inference before exact dependency release');
    f.waitPhase='resolved';await runtime.waitForIdle(ghost,conversation);
    const effects=f.calls.filter(c=>c.method==='work.execute'&&c.work_id==='work-one');assert.deepEqual(effects.map(c=>c.operation),['write','edit']);
    assert.equal(new Set(effects.map(c=>c.generation_task_id)).size,1);assert.equal(effects[0].generation_task_id,oldWait.generation_task_id);
    assert.deepEqual(f.claims.get('assignment-one'),originalClaim);assert.equal(f.calls.filter(c=>c.method==='work.execution.complete'&&c.work_id==='work-one').length,1);
    for(const replay of f.calls.filter(c=>c.method==='work.wait'))assert.deepEqual(replay,oldWait,'same waiter request including context and invocation identity replays exactly');
    assert.equal(f.runs.get('owner-turn').state,'cancelled');
    const count=f.requests.length;await runtime.handle(command('new-owner-input',{method:'conversation.input',ghost_id:ghost,conversation_id:conversation,turn_id:'new-owner-turn',prompt:'Owner history remains independently fenced.',privacy:'public',attachments:[]}));await runtime.waitForIdle(ghost,conversation);assert.equal(f.requests.length,count,'an isolated Work claim never authorizes unbound Owner history');
  }finally{f.releaseOwner();await runtime?.close();await rm(root,{recursive:true,force:true});}
});

test('populated legacy stores and swapped Work stores cannot acquire a new clean context seal',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ghost-work-seal-')),f=fixture();let runtime;
  try{
    runtime=await openGhostRuntime({root,mode:'broker',modelProvider:f.provider,hostToolTransport:f.host});
    const ack=await runtime.handle(command('ensure',{method:'conversation.ensure',ghost_id:ghost,conversation_id:conversation}));assert.equal(ack.status,'success');
    await runtime.close();runtime=null;
    const [one,two]=[...f.assignments.values()].map(f.descriptor),key=createHash('sha256').update(ghost).digest('hex');
    const target=join(root,key,'work-contexts',one.ref,'durable.sqlite');await mkdir(dirname(target),{recursive:true});await cp(join(root,ack.data.storage_ref),target);
    await assert.rejects(openPiConversationStorage(root,ghost,conversation,one),/no exact Work context seal/);
    await rm(dirname(target),{recursive:true});
    const store=await openPiConversationStorage(root,ghost,conversation,one);await store.database.close();
    const other=join(root,key,'work-contexts',two.ref,'durable.sqlite');await mkdir(dirname(other),{recursive:true});await cp(target,other);
    await assert.rejects(openPiConversationStorage(root,ghost,conversation,two),/identity mismatch/);
  }finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
});

test('closing during a real Work session open fences publication and releases every store and Ghost lock',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ghost-work-close-open-')),f=fixture();let runtime,closing,created=0;
  const provider={...f.provider,forConversation(...args){created++;const selected=f.provider.forConversation(...args);if(created===2)closing=runtime.close();return selected;}};
  try{
    runtime=await openGhostRuntime({root,mode:'broker',modelProvider:provider,hostToolTransport:f.host});
    await runtime.handle(command('ensure',{method:'conversation.ensure',ghost_id:ghost,conversation_id:conversation}));
    const a=f.assignments.get('assignment-one');
    const result=await runtime.handle(command(a.id,{method:'conversation.assignment',ghost_id:ghost,conversation_id:conversation,goal_id:a.goal_id,goal_revision:1,work_id:a.work_id,prompt:a.prompt,privacy:a.privacy}));
    assert.equal(result.status,'error');assert.equal(result.error_code,'runtime_closed');assert.ok(closing);await closing;
    assert.equal(runtime.sessionOpens.size,0);assert.equal(runtime.sessions.size,0);assert.equal(runtime.ghosts.size,0);assert.equal(f.requests.length,0);
    runtime=await openGhostRuntime({root,mode:'broker',modelProvider:f.provider,hostToolTransport:f.host});assert.equal((await runtime.handle(command('ensure-new',{method:'conversation.ensure',ghost_id:ghost,conversation_id:conversation}))).status,'success');
  }finally{f.releaseOwner();await runtime?.close();await rm(root,{recursive:true,force:true});}
});

test('completion lost ACK reopens with exact receipt-only replay while terminal Host refuses fresh assignment inspection',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ghost-work-completion-replay-')),f=fixture();let runtime,terminal=false,committed=null;const completions=[];
  const host=async input=>{
    if(input.method==='conversation.assignment.inspect'&&terminal)throw new Error('Terminal Work is not a fresh inference grant');
    if(input.method==='work.execution.complete'){
      completions.push(input);
      if(committed){assert.deepEqual(input,committed.request);return committed.response;}
      const response=await f.host(input);committed={request:structuredClone(input),response};terminal=true;throw new Error('Controlled ACK lost after Host completion commit');
    }
    return f.host(input);
  };
  try{
    runtime=await openGhostRuntime({root,mode:'broker',modelProvider:f.provider,hostToolTransport:host});const a=f.assignments.get('assignment-one');
    const original=command(a.id,{method:'conversation.assignment',ghost_id:ghost,conversation_id:conversation,goal_id:a.goal_id,goal_revision:1,work_id:a.work_id,prompt:a.prompt,privacy:a.privacy});
    const ack=await runtime.handle(original);assert.equal(ack.status,'success');await runtime.waitForIdle(ghost,conversation);assert.ok(committed);
    const index=await openGhostIndex(root,ghost);let intent;try{assert.equal((await index.get('SELECT status FROM ghost_canonical_turn_runs WHERE turn_id=?',a.id)).status,'effect_unknown');intent=await index.get('SELECT * FROM ghost_assignment_completion_intents WHERE assignment_id=?',a.id);}finally{await index.close();}
    const count=f.requests.length,effects=f.calls.filter(c=>c.method==='work.execute').length,claim={...f.claims.get(a.id)};
    await runtime.close();runtime=await openGhostRuntime({root,mode:'broker',modelProvider:f.provider,hostToolTransport:host});
    assert.deepEqual(await runtime.handle(original),ack,'original cached admission receipt remains unchanged');await runtime.waitForIdle(ghost,conversation);
    const reopened=await openGhostIndex(root,ghost);try{assert.equal((await reopened.get('SELECT status FROM ghost_canonical_turn_runs WHERE turn_id=?',a.id)).status,'answered');assert.deepEqual(await reopened.get('SELECT * FROM ghost_assignment_completion_intents WHERE assignment_id=?',a.id),intent);}finally{await reopened.close();}
    assert.equal(f.requests.length,count);assert.equal(f.calls.filter(c=>c.method==='work.execute').length,effects);assert.equal(completions.length,2);assert.deepEqual(f.claims.get(a.id),claim);
  }finally{f.releaseOwner();await runtime?.close();await rm(root,{recursive:true,force:true});}
});

test('first inference in an empty isolated context authenticates required memory and publication at its real admission anchor',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ghost-work-required-anchor-')),f=fixture({required:true});let runtime;
  try{
    runtime=await openGhostRuntime({root,mode:'broker',modelProvider:f.provider,hostToolTransport:f.host});const a=f.assignments.get('assignment-one');
    const ack=await runtime.handle(command(a.id,{method:'conversation.assignment',ghost_id:ghost,conversation_id:conversation,goal_id:a.goal_id,goal_revision:1,work_id:a.work_id,prompt:a.prompt,privacy:a.privacy}));assert.equal(ack.status,'success');await runtime.waitForIdle(ghost,conversation);
    assert.equal(f.requests.length,3,'required-source guards allow the first real provider transport');assert.equal(f.calls.filter(c=>c.method==='work.execute').length,1);
    const memory=f.calls.filter(c=>c.method==='work.memory.context.inspect'),pub=f.calls.filter(c=>c.method==='memory.publication.context.inspect');assert.ok(memory.length>0&&pub.length>0);assert.ok([...memory,...pub].every(c=>c.context_ref===f.descriptor(a).ref&&c.conversation_id===conversation));
    const index=await openGhostIndex(root,ghost);try{
      const memoryRows=await index.all('SELECT * FROM ghost_work_memory_context_provenance'),publicationRows=await index.all('SELECT * FROM ghost_publication_context_provenance');
      assert.equal(memoryRows.length,1);assert.equal(publicationRows.length,1);assert.equal(memoryRows[0].conversation_id,f.descriptor(a).ref);assert.equal(publicationRows[0].conversation_id,f.descriptor(a).ref);assert.ok(memoryRows[0].anchor_entry_id>=1&&publicationRows[0].anchor_entry_id>=1);
    }finally{await index.close();}
    f.sourceRevoked=true;const count=f.requests.length;
    await runtime.close();runtime=await openGhostRuntime({root,mode:'broker',modelProvider:f.provider,hostToolTransport:f.host});await runtime.handle(command('reconcile-required',{method:'runtime.reconcile',ghost_id:ghost,conversation_id:conversation}));await runtime.waitForIdle(ghost,conversation);assert.equal(f.requests.length,count,'terminal context revocation cannot enable new inference');
  }finally{f.releaseOwner();await runtime?.close();await rm(root,{recursive:true,force:true});}
});

test('required source revocation after first isolated inference fences the next invoke and cold recovery',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ghost-work-required-revoke-')),f=fixture({required:true});let runtime;
  const host=async input=>{const response=await f.host(input);if(input.method==='work.children')f.sourceRevoked=true;return response;};
  try{
    runtime=await openGhostRuntime({root,mode:'broker',modelProvider:f.provider,hostToolTransport:host});const a=f.assignments.get('assignment-one');
    const envelope=command(a.id,{method:'conversation.assignment',ghost_id:ghost,conversation_id:conversation,goal_id:a.goal_id,goal_revision:1,work_id:a.work_id,prompt:a.prompt,privacy:a.privacy});
    assert.equal((await runtime.handle(envelope)).status,'success');await runtime.waitForIdle(ghost,conversation);assert.equal(f.requests.length,1);assert.equal(f.calls.filter(c=>c.method==='work.execute').length,0);
    await runtime.close();runtime=await openGhostRuntime({root,mode:'broker',modelProvider:f.provider,hostToolTransport:host});await runtime.handle(envelope);await runtime.waitForIdle(ghost,conversation);assert.equal(f.requests.length,1);assert.equal(f.calls.filter(c=>c.method==='work.execute').length,0);
  }finally{f.releaseOwner();await runtime?.close();await rm(root,{recursive:true,force:true});}
});
