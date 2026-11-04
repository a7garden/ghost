import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// These fixtures use Node's module-loader hooks.
const fixtureNode = process.versions.bun ? Bun.which("node") : process.execPath;
assert.ok(fixtureNode, "The Node loader fixture requires a Node executable");

const preload=fileURLToPath(new URL('./fixtures/legacy-entry-retirement-preload.mjs',import.meta.url));
function invoke(root,args,input='UNREAD_INPUT_SENTINEL\n') {
  return spawnSync(fixtureNode,['--experimental-strip-types','--import',preload,...args],{
    cwd:root,timeout:5000,maxBuffer:65536,encoding:'utf8',input,
    env:{PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root,NODE_DISABLE_COMPILE_CACHE:'1',
      GHOST_RETIRED_ENTRY_TRAP_ROOT:root,GHOST_OMP_SESSION_DIR:join(root,'never-read-session')},
  });
}

for (const name of ['scoped-rpc.ts','subscription-native-bridge.ts']) {
  test(`retired ${name} entry rejects before SDK, configuration, credentials or runtime effects`,async()=>{
    const root=await mkdtemp(join(tmpdir(),'ghost-retired-entry-'));
    try {
      const entry=fileURLToPath(new URL(`../../ghost-omp/${name}`,import.meta.url));
      const result=invoke(root,[entry,'--package-root',join(root,'never-read-sdk'),'--config',join(root,'never-read-config')]);
      assert.equal(result.error,undefined,String(result.error));
      assert.equal(result.signal,null);
      assert.equal(result.status,1,result.stderr);
      assert.equal(result.stdout,'');
      assert.match(result.stderr,/legacy_execution_retired/u);
      assert.deepEqual(await readdir(root),[],'no runtime/configuration probe or model subprocess may run');
    } finally {await rm(root,{recursive:true,force:true});}
  });
}

test('retired exported subscription bridge does not inspect input, output or cancellation handles',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ghost-retired-export-'));
  try {
    const entry=new URL('../../ghost-omp/subscription-native-bridge.ts',import.meta.url).href;
    const code=`
      import {runSubscriptionNativeBridge} from ${JSON.stringify(entry)};
      const diagnostics=[];
      const io={diagnostics:{write(value){diagnostics.push(String(value));}}};
      for(const name of ['input','output','signal']) Object.defineProperty(io,name,{get(){throw new Error('UNEXPECTED_HANDLE_READ:'+name);}});
      const status=await runSubscriptionNativeBridge(io);
      if(status!==1||diagnostics.length!==1||!diagnostics[0].startsWith('legacy_execution_retired:')) throw new Error('retirement result changed');
      process.stdout.write(JSON.stringify({status,handles_read:false}));
    `;
    const result=invoke(root,['--input-type=module','--eval',code]);
    assert.equal(result.error,undefined,String(result.error));
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),{status:1,handles_read:false});
    assert.deepEqual(await readdir(root),[]);
  } finally {await rm(root,{recursive:true,force:true});}
});
