// Test-only real SDK call-phase barrier. No production source or SDK records
// are modified; only this subprocess imports an extension with an extra hook.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBrokerModelProvider } from '../../src/models.js';
import { payloadDigest } from '../../src/contract.js';

export const ghost='source-crash-ghost', conversation='source-crash-conversation', turn='source-crash-owner';
export const ref=`bsc-${'a'.repeat(64)}`;
export const legacyArguments={display_name:'Reusable source',purpose:'Apply the pinned procedure',source_contract_ref:ref,source_work_ids:['original-accepted-work']};
export const inputBody={method:'conversation.input',ghost_id:ghost,conversation_id:conversation,turn_id:turn,prompt:'Make a reusable bot from the accepted task.',privacy:'public',attachments:[]};
export const frame=(id,body)=>({protocol_version:'ghost-lifetime/1',command_id:id,payload_digest:payloadDigest(body),actor_ref:'ghost',authority_epoch:1,expected_revision:null,correlation_id:id,body});
export function controlledHost(onPrepare=()=>{}) {
  const runs=new Map();
  return async input=>{
    if(input.method==='inference.inspect') return {status:'success',data:{inference_scope:'public'}};
    if(['memory.capabilities','documents.capabilities'].includes(input.method)) return {status:'success',data:{available_tools:[]}};
    if(input.method==='conversation.turn.inspect') return {status:'success',data:{task_contract:null,task_admission:null,bot_creation:{kind:'ghost-bot-creation-descriptor/1',state:'available',mode:'create',turn_id:turn,ghost_id:ghost,conversation_id:conversation,
      source_contracts:[{source_contract_ref:ref,source_work_id:'original-accepted-work',template_ref:{id:'source',revision:1,digest:'b'.repeat(64)},instructions_digest:'c'.repeat(64),input_schema_digest:'d'.repeat(64),output_schema_digest:'e'.repeat(64),input_contract:{type:'object'},output_contract:{type:'string'},required_capabilities:['read','write','publish_artifact'],artifact_path:'answer.json'}]},
      run:runs.get(turn)??{turn_id:turn,ghost_id:ghost,conversation_id:conversation,state:'running',cancel_requested:false,cancel_command_id:null,submission_id:null,entry_id:null,reason_code:null,latest_status_command_id:null,created_at_ms:1,updated_at_ms:1}}};
    if(input.method==='conversation.turn_status') {
      const run={turn_id:turn,ghost_id:ghost,conversation_id:conversation,state:input.arguments.status,cancel_requested:false,cancel_command_id:null,submission_id:input.arguments.submission_id,entry_id:input.arguments.entry_id,reason_code:input.arguments.reason_code,latest_status_command_id:input.invocation_id,created_at_ms:1,updated_at_ms:2};runs.set(turn,run);return {status:'success',data:{run}};
    }
    if(input.method==='bot.prepare') {await onPrepare(input);return {status:'success',data:{candidate_id:'original-candidate',candidate_digest:'f'.repeat(64),state:'draft'}};}
    if(input.method==='conversation.reply') return {status:'success',data:{turn_id:turn}};
    throw new Error(`Unexpected controlled source callback ${input.method}`);
  };
}
export function controlledProvider(message,onRequest=()=>{}) {
  return createBrokerModelProvider({modelRef:'minimax-code/MiniMax-M2.7',invoke:async request=>{
    onRequest(request);
    return {id:request.id,status:200,body:{id:'controlled-source-crash',object:'chat.completion',model:'minimax-code/MiniMax-M2.7',created:1,choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}};
  }});
}

if(process.argv[2]==='--child') {
  const root=process.argv[3];
  globalThis[Symbol.for('ghost.source-contract.call-barrier')]=async(call,api)=>{
    if(call.name!=='bot_prepare') return;
    const observation={stage:'call_pending',task_id:api.taskId,call_id:call.id,arguments:call.arguments};
    await writeFile(join(root,'call-pending.json'),JSON.stringify(observation));
    process.stdout.write(JSON.stringify(observation)+'\n');
    await new Promise(()=>{});
  };
  const sourceUrl=new URL('../../src/runtime.js',import.meta.url);
  let source=await readFile(sourceUrl,'utf8');
  const marker='    hooks: [{\n      task: GenerationTask.definition.name,';
  if(!source.includes(marker)) throw new Error('Actual generation hooks marker missing');
  source=source.replace(marker,"    hooks: [{ task: 'pi.tool', handlers: { beforeTool: async (call, api) => globalThis[Symbol.for('ghost.source-contract.call-barrier')](call, api) } }, {\n      task: GenerationTask.definition.name,");
  source=source.replace(/from (["'])([^"']+)\1/g,(statement,quote,specifier)=>{
    if(specifier.startsWith('node:')) return statement;
    const resolved=specifier.startsWith('.')?new URL(specifier,sourceUrl).href:import.meta.resolve(specifier);
    return `from ${quote}${resolved}${quote}`;
  });
  const {openGhostRuntime}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const hold=setInterval(()=>{},1000);
  // A valid historical ref+array call, represented by an actual SDK assistant
  // response. Fresh model declarations are narrower; call validation retains
  // registered compatibility and the name remains offered.
  const provider=controlledProvider({role:'assistant',content:null,tool_calls:[{id:'original-source-call',type:'function',function:{name:'bot_prepare',arguments:JSON.stringify(legacyArguments)}}]});
  const runtime=await openGhostRuntime({root:join(root,'durable'),mode:'broker',modelProvider:provider,hostToolTransport:controlledHost(()=>{throw new Error('Call barrier must precede Host I/O');})});
  const admitted=await runtime.handle(frame(turn,inputBody));process.stdout.write(JSON.stringify({stage:'input_admitted',status:admitted.status})+'\n');
  await runtime.waitForIdle(ghost,conversation);clearInterval(hold);await runtime.close();
}
