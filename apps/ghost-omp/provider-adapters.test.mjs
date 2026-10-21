import {test} from 'node:test';import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {readFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {runCodex} from './codex-client.mjs';import {generateImage,imageReceipt} from './images.mjs';
function spawnFake(events,observe){return(executable,args,options)=>{observe({executable,args,options});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.emit('close',1);return true;};child.stdin=new Writable({write(_chunk,_encoding,done){done();},final(done){done();setImmediate(()=>{child.stdout.end(events.map(e=>JSON.stringify(e)).join('\n'));child.emit('close',0);});}});return child;};}
test('official CLI keeps API keys in child env and rejects native execution or missing terminal receipts',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'ghost-cli-test-'));
 try{for(const native of [false,true]){
  let observed,catalog;const events=[{type:'turn.started'},...(native?[{type:'item.completed',item:{type:'command_execution'}}]:[{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({content:'ok',tool_calls:[]})}}]),{type:'turn.completed'}];
  const promise=runCodex({executable:'/usr/bin/false',cwd,prompt:'PRIVATE_PROMPT',schema:{},provider:'minimax',apiKey:'PRIVATE_API_KEY',model:'MiniMax-M3',effort:'high',isolateMcp:async()=>[],spawnImpl:spawnFake(events,value=>{observed=value;catalog=JSON.parse(readFileSync(JSON.parse(value.args.find(arg=>arg.startsWith('model_catalog_json=')).slice('model_catalog_json='.length)),'utf8'));})});
  if(native)await assert.rejects(promise);else assert.equal((await promise).value.content,'ok');
  assert.equal(observed.args.join(' ').includes('PRIVATE'),false);
  assert.equal(observed.options.env.GHOST_REGISTERED_PROVIDER_KEY,'PRIVATE_API_KEY');
  assert.equal(observed.options.env.OPENAI_API_KEY,undefined);
  assert.equal(observed.args.includes('read-only'),true);assert.equal(observed.args.includes('--yolo'),false);
  assert.equal(catalog.models[0].supports_reasoning_summaries,true);assert.equal(catalog.models[0].slug,'MiniMax-M3');assert.equal(catalog.models[0].default_reasoning_summary,'none');
 }
 await assert.rejects(runCodex({executable:'/usr/bin/false',cwd,prompt:'hello',schema:{},isolateMcp:async()=>[],spawnImpl:spawnFake([{type:'item.completed',item:{type:'agent_message',text:'{}'}}],()=>{})}));
 const threadID=randomUUID();
 const native=await runCodex({executable:'/usr/bin/false',cwd,prompt:'image',schema:{},images:true,isolateMcp:async()=>[],spawnImpl:spawnFake([{type:'thread.started',thread_id:threadID},{type:'item.completed',item:{type:'agent_message',text:'Image generated.'}},{type:'turn.completed'}],()=>{})});
 assert.equal(native.native_thread_id,threadID);assert.deepEqual(native.value.files,[]);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('image receipts prevent duplicate generation, preserve unknown, and enforce exact pair',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ghost-image-test-'));const pair={ghost_id:randomUUID(),conversation_id:randomUUID()};let calls=0;
 const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('test bytes')]);
 try{
  const args={root,id:randomUUID(),pair,provider:'codex',prompt:'PRIVATE_IMAGE_PROMPT',granted:true,generateNative:async()=>{calls++;return bytes;}};
  const first=await generateImage(args);assert.equal(first.state,'completed');assert.equal(calls,1);
  assert.equal((await generateImage(args)).digest,first.digest);assert.equal(calls,1);
  await assert.rejects(imageReceipt(root,args.id,{...pair,conversation_id:randomUUID()}));
  await assert.rejects(generateImage({...args,prompt:'different'}));assert.equal(calls,1);
  const pending={...args,id:randomUUID(),generateNative:async()=>{calls++;throw new Error('PRIVATE_RESPONSE');}};
  assert.equal((await generateImage(pending)).state,'effect_unknown');
  assert.equal((await generateImage(pending)).state,'effect_unknown');assert.equal(calls,2);
  const manifest=await readFile(join(root,'images',pending.id,'receipt.json'),'utf8');assert.equal(manifest.includes('PRIVATE'),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
