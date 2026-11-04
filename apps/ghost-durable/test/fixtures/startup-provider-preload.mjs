import { registerHooks, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
// Real entrypoint, unavailable OMP and model subprocesses; only synthetic
// external responses and a real loopback fixture Host are allowed.
registerHooks({resolve(specifier,context,nextResolve){
 if(/ghost-omp|@oh-my-pi\/|oh-my-pi|omp-gateway/iu.test(specifier)) throw new Error('OMP is unavailable in this fixture.');
 return nextResolve(specifier,context);
}});
childProcess.spawn=()=>{throw new Error('No model subprocess executable is available.');};
childProcess.execFile=()=>{throw new Error('No model subprocess executable is available.');};
syncBuiltinESMExports();
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const request=input instanceof Request ? input : new Request(input,init);
 if(new URL(request.url).hostname==='127.0.0.1')return originalFetch(request);
 if(!['https://api.z.ai/api/v1/responses','https://api.minimax.io/v1/responses'].includes(request.url))throw new Error('Unexpected external request.');
 const body=await request.json();
 await appendFile(join(process.env.GHOST_STARTUP_FIXTURE_ROOT,'provider-calls.jsonl'),JSON.stringify({url:request.url,model:body.model,effort:body.reasoning?.effort,contains_blocked_input:JSON.stringify(body.input).includes('BLOCKED_INPUT_MUST_NOT_REPLAY'),credential_matches:request.headers.get('authorization')==='Bearer startup-fixture-key',tools:(body.tools??[]).map(tool=>tool.name)})+'\n');
 const item={type:'message',id:'msg_startup',role:'assistant',status:'completed',content:[{type:'output_text',text:'STARTUP_NATIVE_PROVIDER_VERIFIED',annotations:[]}]};
 const response={id:'resp_startup',status:'completed',output:[item],usage:{input_tokens:4,output_tokens:3,total_tokens:7}};
 const events=[{type:'response.created',response:{id:response.id}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
 return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
};
