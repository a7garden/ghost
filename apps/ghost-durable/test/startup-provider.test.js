import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {payloadDigest} from '../src/contract.js';
const ghost='startup-ghost',conversation='startup-conversation',turn='startup-turn';
function envelope(id,body){return {protocol_version:'ghost-lifetime/1',command_id:id,payload_digest:payloadDigest(body),actor_ref:'startup-owner',authority_epoch:1,expected_revision:null,correlation_id:id,body};}
async function eventually(predicate,message){const deadline=Date.now()+5000;while(Date.now()<deadline){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error(typeof message==='function'?message():message);}
async function setup(providerId,{credentials=true,allow=true,revoke=false,keyFile=true}={}){
 const root=await mkdtemp(join(tmpdir(),'ghost-entrypoint-provider-'));
 const owner='b'.repeat(64),frames=[],callbacks=[],runs=new Map(),state={credentials,allow,revoke};
 const selection={provider:providerId,model:providerId==='zai-coding'?'glm-5.3':'MiniMax-M3.1-Flash-Preview',effort:'high'};
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url.startsWith('/api/v1/bootstrap/')){res.end(JSON.stringify({protocol:'ghost-control',version:1,proof:createHmac('sha256',owner).update('ghost-control-bootstrap-v1\0').update(req.url.split('/').at(-1)).digest('hex')}));return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const payload=JSON.parse(Buffer.concat(chunks).toString()),body=payload.envelope.body;
  callbacks.push(body);assert.equal(req.headers.authorization,'Bearer startup-callback-token');
  let data={};
  if(body.method==='inference.settings'){
   const count=callbacks.filter(c=>c.method==='inference.settings').length;
   data={selection,credentials_present:state.credentials,external_allowed:state.allow&&!(state.revoke&&count>1)};
  }else if(body.method==='inference.inspect')data={inference_scope:'selected'};
  else if(body.method==='conversation.turn.inspect'){
   if(!runs.has(body.turn_id))runs.set(body.turn_id,{turn_id:body.turn_id,ghost_id:ghost,conversation_id:conversation,state:'queued',cancel_requested:false,cancel_command_id:null,submission_id:null,entry_id:null,reason_code:null,latest_status_command_id:null,created_at_ms:1,updated_at_ms:1});
   data={run:runs.get(body.turn_id)};
  }else if(body.method==='conversation.turn_status'){
   const run={...runs.get(body.turn_id),state:body.status,submission_id:body.submission_id,entry_id:body.entry_id,reason_code:body.reason_code,latest_status_command_id:payload.envelope.command_id,updated_at_ms:2};runs.set(body.turn_id,run);data={run};
  }
  res.end(JSON.stringify({ok:true,result:{status:'success',summary:'fixture',artifacts:[],next_actions:[],data}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 await writeFile(join(root,'.ghost-control.json'),JSON.stringify({protocol:'ghost-control',protocol_version:1,host:'127.0.0.1',port:server.address().port,token:owner}),{mode:0o600});
 await mkdir(join(root,'inference-credentials'));
 if(keyFile)await writeFile(join(root,'inference-credentials',`${providerId}.json`),JSON.stringify({api_key:'startup-fixture-key'}),{mode:0o600});
 let child,exited,output='',stderr='';
 const launch=async()=>{
 const frameCount=frames.length;
 child=spawn(process.execPath,['--import',fileURLToPath(new URL('./fixtures/startup-provider-preload.mjs',import.meta.url)),fileURLToPath(new URL('../src/main.js',import.meta.url)),'--root',join(root,'durable'),'--mode','broker'],{
  env:{HOME:root,TMPDIR:tmpdir(),PATH:'',GHOST_LIFETIME_HOST_ROOT:root,GHOST_PI_CALLBACK_TOKEN:'startup-callback-token',GHOST_PI_AUTHORITY_EPOCH:'1',GHOST_STARTUP_FIXTURE_ROOT:root},stdio:['pipe','pipe','pipe'],
 });
 output='';child.stdout.on('data',chunk=>{output+=chunk;let split;while((split=output.indexOf('\n'))>=0){frames.push(JSON.parse(output.slice(0,split)));output=output.slice(split+1);}});child.stderr.on('data',chunk=>stderr+=chunk);
 exited=new Promise(resolve=>child.once('close',code=>resolve(code)));
 await eventually(()=>frames.length>frameCount||child.exitCode!==null,()=>`No entrypoint handshake: ${stderr}`);assert.equal(child.exitCode,null,stderr);
 };
 const stop=async()=>{child.stdin.end();const timeout=setTimeout(()=>child.kill('SIGKILL'),1000);await exited;clearTimeout(timeout);};
 try{await launch();}catch(error){child?.kill('SIGKILL');await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});throw error;}
 const calls=async()=>{try{return (await readFile(join(root,'provider-calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
 return {frames,callbacks,runs,calls,selection,state,stderr:()=>stderr,
  async restart(){await stop();await launch();},
  send(id,body){child.stdin.write(JSON.stringify(envelope(id,body))+'\n');},
  async close(){await stop();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});},
 };
}
for(const providerId of ['zai-coding','minimax'])test(`broker entrypoint invokes ${providerId} with neither OMP package nor model executables`,async()=>{
 const f=await setup(providerId);
 try{
  assert.equal(f.frames[0].mode,'broker');
  f.send('startup-input',{method:'conversation.input',ghost_id:ghost,conversation_id:conversation,turn_id:turn,prompt:'Public synthetic provider startup fixture.',privacy:'private',attachments:[]});
  await eventually(async()=> (await f.calls()).length===1,()=>`No native model call: ${f.stderr()} ${JSON.stringify(f.frames)} ${JSON.stringify(f.callbacks)}`);
  const [call]=await f.calls();assert.equal(call.model,f.selection.model);assert.equal(call.effort,'high');assert.equal(call.credential_matches,true);
  assert.ok(f.callbacks.some(c=>c.method==='inference.inspect'));assert.ok(f.callbacks.filter(c=>c.method==='inference.settings').length>=2);
  assert.ok(call.tools.every(name=>!name.startsWith('memory_')&&!name.startsWith('document_')));
 }finally{await f.close();}
});
for(const [name,options] of [['missing credential',{credentials:false}],['missing conversation consent',{allow:false}],['revoked consent before fetch',{revoke:true}],['missing key file despite Host metadata',{keyFile:false}]])test(`entrypoint blocks ${name} before native inference`,async()=>{
 const f=await setup('zai-coding',options);
 try{
  f.send('blocked-input',{method:'conversation.input',ghost_id:ghost,conversation_id:conversation,turn_id:turn,prompt:'Synthetic startup guard fixture.',privacy:'private',attachments:[]});
  await eventually(()=>f.runs.get(turn)?.state==='failed',()=>`Guard did not produce a failed turn: ${f.stderr()} ${JSON.stringify(f.frames)} ${JSON.stringify(f.callbacks)}`);
  assert.equal((await f.calls()).length,0);assert.ok(f.callbacks.some(c=>c.method==='inference.settings'));
 }finally{await f.close();}
});

test('terminal credential block survives entrypoint restart and same-ID replay while a later eligible turn proceeds',async()=>{
 const f=await setup('zai-coding',{credentials:false});
 const body={method:'conversation.input',ghost_id:ghost,conversation_id:conversation,turn_id:turn,prompt:'BLOCKED_INPUT_MUST_NOT_REPLAY',privacy:'private',attachments:[]};
 try{
  f.send('blocked-replay',body);
  await eventually(()=>f.runs.get(turn)?.state==='failed',()=>f.stderr());
  assert.equal(f.runs.get(turn).reason_code,'admission_blocked');
  assert.equal((await f.calls()).length,0);
  const original=f.frames.find(frame=>frame.data?.command_id==='blocked-replay');assert.ok(original);
  f.state.credentials=true;
  await f.restart();
  const before=f.frames.length;
  f.send('blocked-replay',body);
  await eventually(()=>f.frames.length>before,'No same-ID replay response after restart');
  assert.deepEqual(f.frames.at(-1),original);
  f.send('eligible-next',{...body,turn_id:'eligible-turn',prompt:'New synthetic eligible turn.'});
  await eventually(async()=>(await f.calls()).length===1,()=>`Next turn remained blocked: ${f.stderr()}`);
  const calls=await f.calls();assert.equal(calls.length,1);assert.equal(calls[0].contains_blocked_input,false);
  assert.equal(f.runs.get(turn).state,'failed');
 }finally{await f.close();}
});

test('entrypoint refuses unknown disclosure before Host/provider calls',async()=>{
 const f=await setup('minimax');
 try{
  f.send('unknown-disclosure',{method:'conversation.input',ghost_id:ghost,conversation_id:conversation,turn_id:turn,prompt:'Synthetic unknown disclosure.',privacy:'unknown',attachments:[]});
  await eventually(()=>f.frames.some(frame=>frame.data?.command_id==='unknown-disclosure'),'No invalid disclosure response');
  assert.equal(f.frames.at(-1).status,'error');assert.equal(f.frames.at(-1).error_code,'invalid_envelope');
  assert.equal(f.callbacks.length,0);assert.equal((await f.calls()).length,0);
 }finally{await f.close();}
});
