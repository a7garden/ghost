import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openGhostIndex } from '../src/storage.js';
import { admitLocalRoutePin, assertLocalRoutePin, initializeLocalRoutePins } from '../src/local-route-pins.js';
test('local route admission pin survives cold reopen; a changed budget cannot migrate it during inspection', async () => {
  const root=await mkdtemp(join(tmpdir(),'ghost-route-pin-'));
  let index;
  try {
    index=await openGhostIndex(root,'ghost'); await initializeLocalRoutePins(index);
    const original={identity:'a'.repeat(64),maxOutputTokens:1024},changed={identity:'b'.repeat(64),maxOutputTokens:4096};
    await index.transaction(tx=>admitLocalRoutePin(tx,'work-original',original)); await index.close();
    index=await openGhostIndex(root,'ghost'); await initializeLocalRoutePins(index);
    await assert.rejects(assertLocalRoutePin(index,'work-original',changed),{code:'goal_assignment_route_conflict'});
    await assertLocalRoutePin(index,'work-original',original);
    await assertLocalRoutePin(index,'legacy-unpinned',original);
    await assert.rejects(assertLocalRoutePin(index,'legacy-unpinned',changed),{code:'goal_assignment_route_conflict'});
    assert.equal((await index.get('SELECT count(*) AS n FROM ghost_assignment_local_route_pins')).n,1);
    await index.transaction(tx=>admitLocalRoutePin(tx,'work-fresh',changed));
    await assertLocalRoutePin(index,'work-fresh',changed);
  } finally { await index?.close(); await rm(root,{recursive:true,force:true}); }
});
