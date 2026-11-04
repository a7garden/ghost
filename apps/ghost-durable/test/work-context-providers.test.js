import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openGhostRuntime} from '../src/runtime.js';
import {createBrokerModelProvider,createLocalModelProvider} from '../src/models.js';
import {createRegisteredModelProvider} from '../src/registered-models.js';
import {payloadDigest} from '../src/contract.js';

const ghost='provider-context-ghost',conversation='provider-canonical-conversation';
const envelope=(id,body)=>({protocol_version:'ghost-lifetime/1',command_id:id,payload_digest:payloadDigest(body),actor_ref:ghost,authority_epoch:1,expected_revision:null,correlation_id:id,body});
const complete=(model)=>({id:'controlled-response',object:'chat.completion',model,created:1,choices:[{index:0,message:{role:'assistant',content:'Bounded advisory; independent acceptance remains pending.'},finish_reason:'stop'}]});

for(const route of ['public','local','codex','zai-coding','minimax'])test(`${route} actual provider transport sees only its fresh Work context and zero requests on an unconfirmed claim`,async()=>{
  for(const denyClaim of [false,true]){
    const root=await mkdtemp(join(tmpdir(),'ghost-context-route-'));let runtime;const requests=[],runs=new Map(),calls=[];
    const a={id:'bound-assignment',source_command_id:'original-source',ghost_id:ghost,conversation_id:conversation,goal_id:'bound-goal',goal_revision:1,work_id:'bound-work',privacy:route==='local'?'private':'public',prompt:'WORK-ONLY-IMMUTABLE-PROCEDURE',origin_kind:'owner_goal',parent_work_id:null,root_goal_id:'bound-goal'};
    const context={kind:'ghost-work-context/1',ref:`wc-${'f'.repeat(64)}`,assignment_id:a.id,work_id:a.work_id,goal_revision:1,owner_revision:1,authority_epoch:1};
    const registered=['codex','zai-coding','minimax'].includes(route),model=route==='codex'?'gpt-6-luna':route==='zai-coding'?'glm-5.3':'MiniMax-M3.1-Flash-Preview';
    const workModel=route==='codex'?'gpt-6-sol':model;
    const host=async input=>{
      calls.push(input);
      if(input.method==='inference.settings'){
        const bound=input.assignment_id!==undefined || input.work_id!==undefined;
        if(bound || input.context_ref){assert.equal(input.assignment_id,a.id);assert.equal(input.work_id,a.work_id);}
        return {status:'success',data:{selection:{provider:route,model:bound?workModel:model,effort:bound?'max':'high'},credentials_present:true,external_allowed:true}};
      }
      if(input.method==='inference.inspect'){if(input.context_ref){assert.equal(input.assignment_id,a.id);assert.equal(input.work_id,a.work_id);}return {status:'success',data:{inference_scope:registered?'selected':route}};}
      if(['memory.capabilities','documents.capabilities'].includes(input.method))return {status:'success',data:{available_tools:[]}};
      if(input.method==='conversation.turn.inspect')return {status:'success',data:{orchestra:{tasks:['direct','routine-code'],default_task:'direct',independent_review:false},run:runs.get(input.turn_id)??{turn_id:input.turn_id,ghost_id:ghost,conversation_id:conversation,state:'queued',cancel_requested:false,cancel_command_id:null,submission_id:null,entry_id:null,reason_code:null,latest_status_command_id:null,created_at_ms:1,updated_at_ms:1}}};
      if(input.method==='conversation.turn_status'){const run={turn_id:input.turn_id,ghost_id:ghost,conversation_id:conversation,state:input.arguments.status,cancel_requested:false,cancel_command_id:null,submission_id:input.arguments.submission_id,entry_id:input.arguments.entry_id,reason_code:input.arguments.reason_code,latest_status_command_id:input.invocation_id,created_at_ms:1,updated_at_ms:2};runs.set(input.turn_id,run);return {status:'success',data:{run}};}
      if(input.method==='conversation.reply')return {status:'success',data:{turn_id:input.turn_id}};
      if(input.method==='conversation.assignment.inspect')return {status:'success',data:{assignment:a,execution_context:context,execution:{engine:'pi',version:1}}};
      if(input.method==='work.context.claim')return denyClaim?{status:'error',data:{}}:{status:'success',data:{context_ref:context.ref}};
      throw Error(`Unexpected controlled callback ${input.method}`);
    };
    if(registered&&route!=='codex'){await mkdir(join(root,'inference-credentials'));await writeFile(join(root,'inference-credentials',`${route}.json`),JSON.stringify({api_key:'synthetic-context-only-key'}),{mode:0o600});}
    const local=createLocalModelProvider({baseUrl:'http://127.0.0.1:8768/v1',modelId:'fixture/local-context',fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body);requests.push(body);return new Response(JSON.stringify(complete(body.model)),{headers:{'content-type':'application/json'}});}});
    const provider=registered?createRegisteredModelProvider({hostRoot:root,executable:'/usr/bin/false',complete:async request=>{requests.push({...request.body,reasoning:{effort:request.effort}});return complete(request.body.model);},fetchImpl:async(_url,options)=>{
      requests.push(JSON.parse(options.body));const item={type:'message',id:'context-message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Bounded advisory; independent acceptance pending.',annotations:[]}]};
      const events=[{type:'response.created',response:{id:'context-response'}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'context-response',status:'completed',output:[item],usage:{input_tokens:4,output_tokens:3,total_tokens:7}}}];return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
    }}):createBrokerModelProvider({modelRef:'minimax-code/MiniMax-M2.7',localModelProvider:local,invoke:async request=>{requests.push(request.body);return {id:request.id,status:200,body:complete(request.body.model)};}});
    try{
      runtime=await openGhostRuntime({root,mode:'broker',modelProvider:provider,hostToolTransport:host});
      assert.equal((await runtime.handle(envelope('owner-input',{method:'conversation.input',ghost_id:ghost,conversation_id:conversation,turn_id:'owner-turn',prompt:'OWNER-HISTORY-MARKER-MUST-NOT-BE-IN-WORK',privacy:a.privacy,attachments:[]}))).status,'success');await runtime.waitForIdle(ghost,conversation);
      assert.equal(requests.length,1,'same configured route positively reaches its real transport for Owner');
      assert.ok(JSON.stringify(requests[0]).includes('acceptance_spec.orchestra_task'));
      assert.equal((await runtime.handle(envelope(a.id,{method:'conversation.assignment',ghost_id:ghost,conversation_id:conversation,goal_id:a.goal_id,goal_revision:1,work_id:a.work_id,prompt:a.prompt,privacy:a.privacy}))).status,'success');await runtime.waitForIdle(ghost,conversation);
      assert.equal(requests.length,denyClaim?1:2);
      if(!denyClaim){
        const wire=JSON.stringify(requests[1]);
        assert.ok(wire.includes(a.prompt));
        assert.ok(!wire.includes('OWNER-HISTORY-MARKER-MUST-NOT-BE-IN-WORK'));
        assert.ok(!wire.includes('acceptance_spec.orchestra_task'));
        assert.ok(calls.some(c=>c.method==='inference.inspect'&&c.context_ref===context.ref));
        if(registered){
          assert.equal(requests[0].model,model);
          assert.equal(requests[0].reasoning.effort,'high');
          assert.equal(requests[1].model,workModel);
          assert.equal(requests[1].reasoning.effort,'max');
          assert.ok(calls.some(c=>c.method==='inference.settings'&&c.assignment_id===a.id&&c.work_id===a.work_id&&c.context_ref===undefined));
          assert.ok(calls.some(c=>c.method==='inference.settings'&&c.context_ref===context.ref));
        }
      }
      else assert.equal(requests.length,1,'failed beforeRequest/claim cannot reach actual provider or fallback');
    }finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
  }
});
