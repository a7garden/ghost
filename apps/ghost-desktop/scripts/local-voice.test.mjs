import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startLocalVoice } from './local-voice.mjs';

const fixtureSource = `
const http = require('node:http');
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
const mode=MODE;
if(mode==='exit') process.exit(1);
if(mode==='ignore-term') process.on('SIGTERM',()=>{});
if(mode==='never-ready') setInterval(()=>{},1000);
else http.createServer((req,res)=>{
  const identity={service:'ghost-local-speech',version:1,pid:process.pid,offline:true};
  if(mode==='environment') identity.env_checks={
    credential_inherited:process.env.GHOST_LIFECYCLE_TEST_CREDENTIAL!==undefined,
    auth_file_inherited:process.env.GHOST_VOICE_TEST_API_KEY!==undefined,
    home_present:typeof process.env.HOME==='string' && process.env.HOME.length>0,
    locale_forwarded:process.env.LC_GHOST_TEST_LANGUAGE==='ko_KR.UTF-8',
    offline:process.env.HF_HUB_OFFLINE==='1' && process.env.TRANSFORMERS_OFFLINE==='1',
    python_isolated:process.env.PYTHONDONTWRITEBYTECODE==='1' && process.env.PYTHONUNBUFFERED==='1',
  };
  if(mode==='bad-pid') identity.pid+=1;
  if(mode==='bad-service') identity.service='external-service';
  if(mode==='bad-version') identity.version=2;
  if(mode==='online') identity.offline=false;
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify(identity));
}).listen(port,'127.0.0.1');
`;
async function fixture(mode='ready') {
  const root = await mkdtemp(join(tmpdir(),'ghost-owned-voice-test-'));
  const resourcesRoot=join(root,'resources'),configRoot=join(root,'config');
  await mkdir(join(resourcesRoot,'voice'),{recursive:true});await mkdir(configRoot);
  const python=join(root,'python');await symlink(process.execPath,python);
  await writeFile(join(resourcesRoot,'voice/server.py'),fixtureSource.replace('MODE',JSON.stringify(mode)));
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const descriptor={enabled:true,python,port};
  await writeFile(join(configRoot,'local-voice.json'),JSON.stringify(descriptor));
  return {root,resourcesRoot,configRoot,descriptor,options:{resourcesRoot,configRoot,startupTimeoutMs:1000,shutdownTimeoutMs:100,killTimeoutMs:100},cleanup:()=>rm(root,{recursive:true,force:true})};
}
function alive(pid) {try{process.kill(pid,0);return true;}catch{return false;}}

test('owned server health uses exact identity and stop is idempotent',async()=>{
  const f=await fixture();const states=[];let local;
  try {
    local=await startLocalVoice({...f.options,onStatus:value=>states.push(value)});
    assert.equal(local.available,true);assert.equal(local.endpoint,`http://127.0.0.1:${f.descriptor.port}/v1`);assert(alive(local.pid));
    assert.deepEqual(states.map(x=>x.state),['starting','ready']);
    const first=await local.stop();const second=await local.stop();assert.deepEqual(first,second);assert.equal(first.stopped,true);assert.equal(alive(local.pid),false);
  }finally{await local?.stop();await f.cleanup();}
});
test('missing runtime and disabled config never prevent normal startup',async()=>{
  const f=await fixture();try{
    await rm(join(f.configRoot,'local-voice.json'));
    assert.equal((await startLocalVoice(f.options)).state,'disabled');
    assert.equal((await startLocalVoice({...f.options,descriptor:{enabled:false}})).state,'disabled');
    assert.equal((await startLocalVoice({...f.options,descriptor:{...f.descriptor,python:join(f.root,'missing/python')}})).state,'missing');
  }finally{await f.cleanup();}
});
test('invalid host descriptors cannot choose server or relative program',async()=>{
  const f=await fixture();try{
    for(const descriptor of [{...f.descriptor,python:'python'},{...f.descriptor,server:'/tmp/renderer.py'},{...f.descriptor,port:80},{...f.descriptor,python:process.execPath}]) {
      const result=await startLocalVoice({...f.options,descriptor});assert.equal(result.state,'invalid');
    }
  }finally{await f.cleanup();}
});
test('occupied port is refused even when external identity looks correct',async()=>{
  const f=await fixture();const external=createServer((req,res)=>{res.end(JSON.stringify({service:'ghost-local-speech',version:1,pid:process.pid,offline:true}));});
  external.listen(f.descriptor.port,'127.0.0.1');await once(external,'listening');
  try{
    const local=await startLocalVoice(f.options);assert.equal(local.state,'occupied');await local.stop();
    assert.equal(external.listening,true);assert.equal((await fetch(`http://127.0.0.1:${f.descriptor.port}/health`)).status,200);
  }finally{await new Promise(resolve=>external.close(resolve));await f.cleanup();}
});
test('wrong PID/service/version/offline and missing dependencies become unavailable',async()=>{
  for(const mode of ['bad-pid','bad-service','bad-version','online','exit']){
    const f=await fixture(mode);let local;
    try{local=await startLocalVoice({...f.options,startupTimeoutMs:250});assert.equal(local.state,'unavailable');assert.equal(local.available,false);}
    finally{await local?.stop();await f.cleanup();}
  }
});
test('SIGTERM-resistant owned service receives bounded SIGKILL',async()=>{
  const f=await fixture('ignore-term');let local;
  try{local=await startLocalVoice(f.options);assert.equal(local.available,true);const start=Date.now();const stopped=await local.stop();assert.equal(stopped.stopped,true);assert(Date.now()-start<750);assert.equal(alive(local.pid),false);}
  finally{await local?.stop();await f.cleanup();}
});
test('abort during startup and after ready drains only owned child',async()=>{
  const f=await fixture('never-ready');const controller=new AbortController();const states=[];
  try{
    const pending=startLocalVoice({...f.options,startupTimeoutMs:1000,signal:controller.signal,onStatus:value=>states.push(value)});
    setTimeout(()=>controller.abort(),100);const local=await pending;assert.equal(local.state,'cancelled');
    assert.equal(local.available,false);const stopped=states.find(x=>x.state==='stopped');assert(stopped);assert.equal(alive(stopped.pid),false);
  }finally{await f.cleanup();}
  const ready=await fixture();const abortReady=new AbortController();let local;
  try{
    local=await startLocalVoice({...ready.options,signal:abortReady.signal});assert.equal(local.available,true);abortReady.abort();
    assert.equal((await local.stop()).stopped,true);assert.equal(alive(local.pid),false);
  }finally{await local?.stop();await ready.cleanup();}
});


test('speech child receives cache/language environment and no unrelated credential marker',async()=>{
  const f=await fixture('environment');let local;
  const names=['GHOST_LIFECYCLE_TEST_CREDENTIAL','GHOST_VOICE_TEST_API_KEY','LC_GHOST_TEST_LANGUAGE'];
  const previous=new Map(names.map(name=>[name,process.env[name]]));
  try {
    process.env.GHOST_LIFECYCLE_TEST_CREDENTIAL='fixture-must-not-inherit';
    process.env.GHOST_VOICE_TEST_API_KEY='fixture-fake-api-key';
    process.env.LC_GHOST_TEST_LANGUAGE='ko_KR.UTF-8';
    local=await startLocalVoice(f.options);assert.equal(local.available,true);
    const health=await (await fetch(`http://127.0.0.1:${f.descriptor.port}/health`)).json();
    assert.deepEqual(health.env_checks,{credential_inherited:false,auth_file_inherited:false,
      home_present:true,locale_forwarded:true,offline:true,python_isolated:true});
  }finally {
    await local?.stop();
    for(const name of names){if(previous.get(name)===undefined) delete process.env[name];else process.env[name]=previous.get(name);}
    await f.cleanup();
  }
});
