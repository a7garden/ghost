import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGhostRuntime } from '../src/runtime.js';
import { createBrokerModelProvider } from '../src/models.js';
import { createHostToolTransport } from '../src/host-transport.js';
import { payloadDigest } from '../src/contract.js';

const fixtureRoots = new Set();
after(async () => {
  for (const root of fixtureRoots) await rm(root, { recursive: true, force: true });
});

const reference=`bsc-${'a'.repeat(64)}`;
const args={display_name:'Reusable labels',purpose:'Apply the accepted label procedure to new inputs',source_contract_ref:reference};
const descriptor=turn=>({kind:'ghost-bot-creation-descriptor/1',state:'available',mode:'create',turn_id:turn,ghost_id:'ghost',conversation_id:'conversation',
  verifier:'VERIFIER_SENTINEL_MUST_NOT_ENTER_CONTEXT',source_contracts:[{source_contract_ref:reference,source_work_id:'accepted-source',template_ref:{id:'labels',revision:2,digest:'b'.repeat(64)},
    instructions_digest:'c'.repeat(64),input_schema_digest:'d'.repeat(64),output_schema_digest:'e'.repeat(64),input_contract:{kind:'label-input/1'},output_contract:{type:'string'},
    required_capabilities:['read','write','publish_artifact'],artifact_path:'answer.json',input:'INSTANCE_SENTINEL_MUST_NOT_ENTER_CONTEXT'}]});

test('bot source-contract transport forwards only an exact opaque ref or the existing explicit contract',async()=>{
  const callbacks=[];
  const transport=createHostToolTransport({hostRoot:'/tmp/ghost-source-contract-fixture',callbackToken:'fixture',authorityEpoch:1,dispatch:async request=>{
    callbacks.push(request);return {ok:true,result:{status:'success',summary:'Controlled Host candidate receipt',object_refs:[],artifacts:[],next_actions:[],error_code:null,retry_class:'same_id',data:{candidate_id:'candidate',candidate_digest:'f'.repeat(64)}}};
  }});
  const scope={ghost_id:'ghost',conversation_id:'conversation',turn_id:'create-turn',invocation_id:'source-prepare',inference_scope:'public',conversation_disclosure:'public'};
  await transport({...scope,method:'bot.prepare',arguments:args});
  assert.deepEqual(callbacks[0].envelope.body,{method:'bot.prepare',turn_id:'create-turn',arguments:args});
  assert.equal(callbacks[0].envelope.actor_ref,'ghost');
  const legacy={...args,source_work_ids:['accepted-source']};
  await transport({...scope,invocation_id:'legacy-ref-array',method:'bot.prepare',arguments:legacy});
  assert.deepEqual(callbacks[1].envelope.body.arguments,legacy,'existing typed ref+array body stays byte-shape compatible');
  const explicit={display_name:'Custom',purpose:'A new custom task',input_contract:{type:'object'},output_contract:{type:'number'},instructions:'Count the input records.',required_capabilities:['read','write','publish_artifact'],source_work_ids:[]};
  await transport({...scope,invocation_id:'custom-prepare',method:'bot.prepare',arguments:explicit});
  assert.deepEqual(callbacks[2].envelope.body.arguments,explicit);
  // Mixed fields are transported only when they satisfy the explicit shape;
  // the Host must compare them with its authoritative snapshot, not drop them.
  await transport({...scope,invocation_id:'mixed-prepare',method:'bot.prepare',arguments:{...explicit,source_contract_ref:reference,source_work_ids:['accepted-source']}});
  for (const invalid of [{...args,source_contract_ref:'arbitrary'}, {...args,source_work_ids:[]}, {...args,source_work_ids:'[\"accepted-source\"]'}, {...args,source_work_ids:['first','second']}, {...args,owner_approved:true}, {...args,input:{}}, {...args,source_contract_ref:undefined}]) {
    await assert.rejects(transport({...scope,invocation_id:'invalid-prepare',method:'bot.prepare',arguments:invalid}));
  }
  assert.equal(callbacks.length,4);
});

test('actual Owner SDK uses fresh source-contract offer without copying hidden template or instance data',async()=>{
  for (const variant of ['fresh','changed','foreign','absent']) {
    const root=await mkdtemp(join(tmpdir(),'ghost-source-contract-'));let runtime,running=false,observations=0;const calls=[],requests=[],runs=new Map();
    const host=async input=>{
      calls.push(input);
      if(input.method==='inference.inspect') return {status:'success',data:{inference_scope:'public'}};
      if(['memory.capabilities','documents.capabilities'].includes(input.method)) return {status:'success',data:{available_tools:[]}};
      if(input.method==='conversation.turn.inspect') {
        if(running) observations++;
        const creation=descriptor(input.turn_id);
        if(variant==='changed' && observations>=2) creation.source_contracts[0].source_contract_ref=`bsc-${'9'.repeat(64)}`;
        if(variant==='foreign' && running) creation.turn_id='different-owner-turn';
        return {status:'success',data:{task_contract:null,task_admission:null,bot_creation:variant==='absent'?null:creation,run:runs.get(input.turn_id)??{
          turn_id:input.turn_id,ghost_id:'ghost',conversation_id:'conversation',state:'queued',cancel_requested:false,cancel_command_id:null,submission_id:null,entry_id:null,reason_code:null,latest_status_command_id:null,created_at_ms:1,updated_at_ms:1}}};
      }
      if(input.method==='conversation.turn_status') {
        if(input.arguments.status==='running') {running=true;observations=0;}
        const run={turn_id:input.turn_id,ghost_id:'ghost',conversation_id:'conversation',state:input.arguments.status,cancel_requested:false,cancel_command_id:null,
          submission_id:input.arguments.submission_id,entry_id:input.arguments.entry_id,reason_code:input.arguments.reason_code,latest_status_command_id:input.invocation_id,created_at_ms:1,updated_at_ms:2};runs.set(input.turn_id,run);return {status:'success',data:{run}};
      }
      if(input.method==='bot.prepare') {assert.deepEqual(input.arguments,args);return {status:'success',data:{candidate_id:'candidate',candidate_digest:'f'.repeat(64),state:'draft'}};}
      if(input.method==='conversation.reply') return {status:'success',data:{turn_id:input.turn_id}};
      throw new Error(`Unexpected source-contract callback ${input.method}`);
    };
    const provider=createBrokerModelProvider({modelRef:'minimax-code/MiniMax-M2.7',invoke:async request=>{
      requests.push(request);
      const prepare=variant==='fresh' && requests.length===1;
      return {id:request.id,status:200,body:{id:'controlled-source-contract',object:'chat.completion',model:'minimax-code/MiniMax-M2.7',created:1,choices:[{index:0,
        message:prepare?{role:'assistant',content:null,tool_calls:[{id:'prepare-source',type:'function',function:{name:'bot_prepare',arguments:JSON.stringify(args)}}]}:{role:'assistant',content:'The exact candidate is prepared; independent evaluation remains pending.'},finish_reason:prepare?'tool_calls':'stop'}]}};
    }});
    try {
      runtime=await openGhostRuntime({root,mode:'broker',modelProvider:provider,hostToolTransport:host});
      const body={method:'conversation.input',ghost_id:'ghost',conversation_id:'conversation',turn_id:'create-turn',prompt:'Make a reusable bot from the accepted task.',privacy:'public',attachments:[]};
      const frame={protocol_version:'ghost-lifetime/1',command_id:'create-turn',payload_digest:payloadDigest(body),actor_ref:'ghost',authority_epoch:1,expected_revision:null,correlation_id:'create-turn',body};
      assert.equal((await runtime.handle(frame)).status,'success');await runtime.waitForIdle('ghost','conversation');
      if(['changed','foreign'].includes(variant)) {assert.equal(requests.length,0,'changed current source authority blocks model I/O');assert.equal(calls.filter(c=>c.method==='bot.prepare').length,0);continue;}
      assert.equal(requests.length,variant==='fresh'?2:1);
      const system=requests[0].body.messages.filter(m=>['system','developer'].includes(m.role)).map(m=>m.content).join('\n');
      assert.equal(system.includes(reference),variant==='fresh');
      assert.equal(system.includes('VERIFIER_SENTINEL_MUST_NOT_ENTER_CONTEXT'),false);
      assert.equal(system.includes('INSTANCE_SENTINEL_MUST_NOT_ENTER_CONTEXT'),false);
      assert.equal(calls.filter(c=>c.method==='goal.create').length,0);
      assert.equal(calls.filter(c=>c.method==='bot.prepare').length,variant==='fresh'?1:0);
      const schema=requests[0].body.tools.find(t=>t.function.name==='bot_prepare').function.parameters;
      const sourceBranch=schema.anyOf.find(branch=>branch.required.includes('source_contract_ref'));
      assert.deepEqual([...sourceBranch.required].sort(),['display_name','purpose','source_contract_ref']);
      assert.equal(Object.hasOwn(sourceBranch.properties,'source_work_ids'),false,'fresh source action has no redundant Work-ID array');
      assert.equal(Object.hasOwn(schema.anyOf.find(branch=>branch.required.includes('instructions')).properties,'source_contract_ref'),false,'fresh custom schema has no impossible mixed source ref');
      await runtime.handle(frame);await runtime.waitForIdle('ghost','conversation');assert.equal(requests.length,variant==='fresh'?2:1,'same receiver frame does not prepare again');
    } finally {await runtime?.close();await rm(root,{recursive:true,force:true});}
  }
});

test('registered source schema preserves a cold legacy call while production Owner recovery stays fenced', {timeout:30000}, async t=>{
  const {spawn}=await import('node:child_process');
  const {once}=await import('node:events');
  const {createInterface}=await import('node:readline');
  const {fileURLToPath}=await import('node:url');
  const {readFile}=await import('node:fs/promises');
  const {createHash}=await import('node:crypto');
  const {DatabaseSync}=await import('node:sqlite');
  const fixture=await import('./fixtures/source-contract-call-crash.mjs');
  const root=await mkdtemp(join(tmpdir(),'ghost-source-call-crash-'));
  fixtureRoots.add(root);
  const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/source-contract-call-crash.mjs',import.meta.url)),'--child',root],{stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null){child.kill('SIGKILL');await exited;}});
  const lines=createInterface({input:child.stdout});t.after(()=>lines.close());
  const within=promise=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Source call barrier timed out: ${stderr}`)),15000);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
  const ready=new Promise((resolve,reject)=>{
    const stages=new Map();child.once('error',reject);child.once('exit',()=>{if(!stages.has('call_pending'))reject(new Error(`Child exited before call barrier: ${stderr}`));});
    lines.on('line',line=>{try {const value=JSON.parse(line);stages.set(value.stage,value);if(stages.has('input_admitted')&&stages.has('call_pending')) {assert.equal(stages.get('input_admitted').status,'success');resolve(stages.get('call_pending'));}}catch(error){reject(error);}});
  });
  const barrier=await within(ready);assert.deepEqual(barrier.arguments,fixture.legacyArguments);
  child.kill('SIGKILL');await exited;
  const hash=x=>createHash('sha256').update(x).digest('hex');
  const databasePath=join(root,'durable',hash(fixture.ghost),hash(fixture.conversation),'durable.sqlite');
  const database=new DatabaseSync(databasePath,{readOnly:true});let originalTask,assistantBytes;
  try {
    originalTask=JSON.parse(database.prepare('SELECT record FROM tasks WHERE id=?').get(barrier.task_id).record);
    assert.equal(originalTask.kind,'pi.tool');assert.equal(originalTask.state.checkpoint.phase,'call','kill before execute intent, so reopen must validate current registered schema');
    assert.equal(originalTask.input.callId,barrier.call_id);
    assistantBytes=database.prepare('SELECT record FROM entries WHERE id=?').get(originalTask.input.assistant).record;
    const originalAssistant=JSON.parse(assistantBytes).model[0];
    assert.deepEqual(originalAssistant.content.find(c=>c.type==='toolCall'&&c.id===barrier.call_id).arguments,fixture.legacyArguments);
  }finally{database.close();}
  const productionCalls=[];
  const runtime=await openGhostRuntime({root:join(root,'durable'),mode:'broker',modelProvider:fixture.controlledProvider({role:'assistant',content:'No implicit cold Owner continuation.'}),hostToolTransport:fixture.controlledHost(input=>productionCalls.push(input))});
  t.after(()=>runtime.close());
  const inspect={method:'conversation.inspect',ghost_id:fixture.ghost,conversation_id:fixture.conversation};
  assert.equal((await runtime.handle(fixture.frame('inspect-pending',inspect))).status,'success');
  const session=[...runtime.sessions.values()].find(value=>value.ghostId===fixture.ghost && value.conversationId===fixture.conversation);
  const registered=session.extension.tools.find(tool=>tool.name==='bot_prepare');
  assert.ok(registered,'read exact current registered compatibility tool before closing');
  const registeredParameters=registered.parameters;
  const registeredBytes=JSON.stringify(registeredParameters);
  assert.equal((await runtime.handle(fixture.frame('recover-original-call',{...inspect,method:'runtime.reconcile'}))).status,'success');
  await within(runtime.waitForIdle(fixture.ghost,fixture.conversation));
  assert.equal(productionCalls.length,0,'generic reconcile must not recover an uncertain cold Owner generation');
  const paused=new DatabaseSync(databasePath,{readOnly:true});
  try {
    const task=JSON.parse(paused.prepare('SELECT record FROM tasks WHERE id=?').get(barrier.task_id).record);
    assert.equal(task.state.checkpoint.phase,'call');assert.deepEqual(task.input,originalTask.input);
    assert.equal(paused.prepare('SELECT record FROM entries WHERE id=?').get(originalTask.input.assistant).record,assistantBytes);
  }finally{paused.close();}
  await runtime.close();

  // This is an SDK schema-ABI proof under an explicit test-owned receiver, not
  // a claim that production permits recovery of this uncertain Owner turn.
  // Reopen the SAME store and unchanged original task using public SDK APIs.
  const {Harness,createRegistry,defineExtension,defineTool}=await import('@earendil-works/pi-durable');
  const {BACKGROUND_CONTEXT}=await import('@earendil-works/chord/context');
  const {openPiConversationStorage}=await import('../src/storage.js');
  const calls=[],requests=[];
  const registry=createRegistry();
  const extension=defineExtension({name:session.extension.name,tools:[defineTool({name:registered.name,description:registered.description,
    parameters:registeredParameters,replay:'safe',executionMode:'sequential',execute:async(args,api)=>{
      calls.push({arguments:args,task_id:api.taskId,call_id:api.callId,invocation_id:`${fixture.ghost}:${fixture.conversation}:${api.taskId}:${api.callId}`});
      return {content:[{type:'text',text:'Controlled ABI receiver completed; no production candidate or acceptance claimed.'}],details:{fixture_owned:true}};
    }})]});
  registry.install(extension);
  const provider=fixture.controlledProvider({role:'assistant',content:'Controlled ABI task settled.'},request=>requests.push(request));
  const opened=await openPiConversationStorage(join(root,'durable'),fixture.ghost,fixture.conversation);
  // The standalone ABI receiver owns this public synthetic context explicitly.
  // The unbound broker.models intentionally refuses every inference request.
  const boundProvider=provider.forConversation(async()=>{},async()=>{},async()=>[],()=>{});
  const harness=await Harness.open(opened.storage,{registry,models:boundProvider.models,settings:{retry:{enabled:false,maxRetries:0}}},BACKGROUND_CONTEXT);
  t.after(()=>harness.close(BACKGROUND_CONTEXT));
  const conversation=await harness.root(BACKGROUND_CONTEXT);
  assert.equal(JSON.stringify(registeredParameters),registeredBytes,'fresh declaration projection never mutates registered schema');
  assert.equal((await harness.getTask(barrier.task_id,BACKGROUND_CONTEXT)).state.checkpoint.phase,'call');
  await within(harness.waitForTask(barrier.task_id,BACKGROUND_CONTEXT));
  await within(conversation.waitForIdle(BACKGROUND_CONTEXT));
  assert.equal(calls.length,1);assert.deepEqual(calls[0].arguments,fixture.legacyArguments);
  assert.equal(calls[0].task_id,barrier.task_id);assert.equal(calls[0].call_id,barrier.call_id);
  assert.equal(calls[0].invocation_id,`${fixture.ghost}:${fixture.conversation}:${barrier.task_id}:${barrier.call_id}`);
  const after=new DatabaseSync(databasePath,{readOnly:true});
  try {
    const task=JSON.parse(after.prepare('SELECT record FROM tasks WHERE id=?').get(barrier.task_id).record);
    assert.equal(task.state.outcome.status,'completed');assert.deepEqual(task.input,originalTask.input);
    assert.equal(after.prepare('SELECT record FROM entries WHERE id=?').get(originalTask.input.assistant).record,assistantBytes,'original assistant/call/arguments bytes are immutable');
    assert.equal(after.prepare('SELECT count(*) AS count FROM tasks WHERE kind=? AND json_extract(record,\'$.input.callId\')=?').get(JSON.stringify('pi.tool'),barrier.call_id).count,1);
  }finally{after.close();}
  assert.equal(requests.length,1,'only the controlled SDK continuation runs after explicit test-owned resume');
  const before=calls.length;
  await within(harness.waitForTask(barrier.task_id,BACKGROUND_CONTEXT));await within(conversation.waitForIdle(BACKGROUND_CONTEXT));
  assert.equal(calls.length,before,'settled original task is not replaced or dispatched again');
  assert.deepEqual(JSON.parse(await readFile(join(root,'call-pending.json'),'utf8')).arguments,fixture.legacyArguments);
});
