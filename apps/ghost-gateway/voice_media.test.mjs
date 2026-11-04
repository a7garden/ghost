import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { createGateway } from './server.mjs';
import { issueDevice } from './devices.mjs';

const mediaOrigin = 'http://127.0.0.1:62080';
const mediaToken = 'media-control-token-0123456789abcdef0123456789abcdef';
const voiceMedia = {
  origin: mediaOrigin,
  controlToken: mediaToken,
  ghostID: '11111111-1111-4111-8111-111111111111',
  conversationID: '22222222-2222-4222-8222-222222222222',
};
const startID = '33333333-3333-4333-8333-333333333333';

function scope({ ghostIDs = [voiceMedia.ghostID], conversationIDs = [voiceMedia.conversationID], capabilities = ['lifetime.read', 'lifetime.write'] } = {}) {
  return { kind: 'lifetime', ghost_ids: ghostIDs, conversation_ids: conversationIDs, capabilities };
}

async function fixture(t, { voice = voiceMedia, scoped = false, deviceScope, capabilities, fetchMedia, fetchHost } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-voice-media-'));
  const devices = join(dir, 'devices.json');
  const device = await issueDevice(devices, 'Test phone', deviceScope ?? (scoped ? scope({ capabilities }) : undefined));
  const dispatchedMedia = [];
  const server = createGateway({
    root: dir, devices, origin: 'https://ghost.example', lifetimeAuthorityEpoch: 1,
    voiceMedia: voice,
    discoverHost: async () => ({ origin: 'http://127.0.0.1:54321', token: 'host-private' }),
    fetchMedia: fetchMedia ?? (async (url, options) => {
      dispatchedMedia.push({ url, options });
      if (url.endsWith('/hangup')) return Response.json({ state: 'ended' });
      if (url.includes('/starts/')) return Response.json({ state: 'live', pc_id: 'pc#1' });
      return Response.json({ sdp: 'v=0\r\nanswer', type: 'answer', pc_id: 'pc#1' });
    }),
    fetchHost: fetchHost ?? (async (url, options) => {
      if (new URL(url).pathname === '/api/v1/snapshot') {
        return Response.json({ workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', lifetime_authority: { authority_epoch: 1, dispatch_enabled: true } });
      }
      const body = options.body ? JSON.parse(Buffer.from(options.body).toString('utf8')) : null;
      if (body?.command?.envelope?.body?.method === 'registry.inspect') {
        return Response.json({ ok: true, result: { status: 'success', summary: 'ok', object_refs: [], artifacts: [], next_actions: [], error_code: null, retry_class: 'same_id', data: { registry: [{ ghost_id: voiceMedia.ghostID, kind: 'primary', conversation_id: voiceMedia.conversationID, roles: [], mode: 'active' }] } } });
      }
      return Response.json({ ok: true, result: { status: 'success' } });
    }),
    apns: { enabled: false, missing: [] },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.stopMediaFence?.();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  function call(path, { method = 'POST', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method,
        headers: { Host: 'ghost.example', Authorization: `Bearer ${device.token}`, ...headers } }, res => {
        let data = ''; res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
      });
      req.on('error', reject); req.end(body);
    });
  }
  return { dir, devices, device, call, dispatchedMedia, server };
}

const jsonHeaders = { 'Content-Type': 'application/json' };
const offerBody = JSON.stringify({ sdp: 'v=0\r\noffer', type: 'offer', start_id: startID });

test('offer forwards to the bound media service with the control token and installation identity', async t => {
  const f = await fixture(t);
  const result = await f.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody });
  assert.equal(result.status, 200);
  const answer = JSON.parse(result.data);
  assert.equal(answer.type, 'answer');
  assert.equal(answer.pc_id, 'pc#1');
  const { url, options } = f.dispatchedMedia[0];
  assert.equal(url, `${mediaOrigin}/offer`);
  assert.equal(options.headers.Authorization, `Bearer ${mediaToken}`);
  assert.equal(options.headers['X-Ghost-CSRF'], mediaToken);
  assert.equal(options.headers['X-Ghost-Media-Device'], f.device.id);
  assert.equal(options.headers.Origin, undefined);
  assert.equal(options.redirect, 'error');
  assert.equal(JSON.parse(options.body).start_id, startID);
  // The durable start record binds pc and installation before the answer is used.
  const registry = JSON.parse(await readFile(f.devices, 'utf8'));
  assert.deepEqual(registry.devices[0].media, [{
    start_id: startID, pc_id: 'pc#1', since: registry.devices[0].media[0].since, fence: registry.devices[0].media[0].fence,
  }]);
});

test('unconfigured media transport returns 503 without forwarding', async t => {
  const f = await fixture(t, { voice: null });
  const result = await f.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody });
  assert.equal(result.status, 503);
  assert.equal(f.dispatchedMedia.length, 0);
});

test('malformed offers never reach the media service', async t => {
  const f = await fixture(t);
  for (const body of [
    JSON.stringify({ sdp: '', type: 'offer', start_id: startID }),
    JSON.stringify({ sdp: 'v=0', type: 'answer', start_id: startID }),
    JSON.stringify({ sdp: 'v=0\r\noffer', type: 'offer' }),
    JSON.stringify({ sdp: 'v=0\r\noffer', type: 'offer', start_id: 'not-a-uuid' }),
    JSON.stringify({ sdp: 42, type: 'offer', start_id: startID }),
    JSON.stringify({ sdp: 'x'.repeat(70_000), type: 'offer', start_id: startID }),
    'not json',
  ]) {
    const result = await f.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body });
    assert.equal(result.status, 400, body.slice(0, 20));
  }
  assert.equal(f.dispatchedMedia.length, 0);
});

test('read-only devices can never advertise, offer, or control; teardown stays available', async t => {
  const f = await fixture(t, { scoped: true, capabilities: ['lifetime.read'] });
  const bootstrap = JSON.parse((await f.call('/mobile/v1/bootstrap', { method: 'GET' })).data);
  assert.equal(bootstrap.voice_media, null);
  assert.equal((await f.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody })).status, 403);
  assert.equal((await f.call('/mobile/v1/voice/sessions/pc1/cancel_turn', { headers: jsonHeaders, body: JSON.stringify({ turn_id: randomUUID() }) })).status, 403);
  assert.equal((await f.call('/mobile/v1/voice/starts/' + startID, { method: 'GET' })).status, 403);
  assert.equal(f.dispatchedMedia.length, 0);
  // Ending media is privilege-reducing and must always stay reachable.
  assert.equal((await f.call('/mobile/v1/voice/sessions/pc%231/hangup')).status, 200);
  assert.equal(f.dispatchedMedia.length, 1);
});

test('write-capable scoped devices keep full pair-scoped access', async t => {
  const f = await fixture(t, { scoped: true });
  assert.equal((await f.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody })).status, 200);
  const outside = await issueDevice(f.devices, 'Outside phone', scope({ conversationIDs: [randomUUID()] }));
  const outsiderCall = (path, options) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: f.server.address().port, path, method: options.method ?? 'POST',
      headers: { Host: 'ghost.example', Authorization: `Bearer ${outside.token}`, 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject); req.end(options.body);
  });
  assert.equal((await outsiderCall('/mobile/v1/voice/offer', { body: offerBody })).status, 403);
  assert.equal(f.dispatchedMedia.length, 1);
});

test('bootstrap advertises the media pair only to allowed devices', async t => {
  const f = await fixture(t, { scoped: true });
  const ownerScoped = JSON.parse((await f.call('/mobile/v1/bootstrap', { method: 'GET' })).data);
  assert.deepEqual(ownerScoped.voice_media, { offer: '/mobile/v1/voice/offer', ghost_id: voiceMedia.ghostID, conversation_id: voiceMedia.conversationID });
  const outside = await issueDevice(f.devices, 'Outside phone', scope({ conversationIDs: [randomUUID()] }));
  const req = await new Promise((resolve, reject) => {
    const request_ = request({ hostname: '127.0.0.1', port: f.server.address().port, path: '/mobile/v1/bootstrap', method: 'GET',
      headers: { Host: 'ghost.example', Authorization: `Bearer ${outside.token}` } }, res => {
      let data = ''; res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    request_.on('error', reject); request_.end();
  });
  assert.equal(JSON.parse(req.data).voice_media, null);
});

test('voice authorizes the second exact pair but never a crossed combination of granted IDs', async t => {
  const otherGhost = randomUUID(), otherConversation = randomUUID();
  const pairs = { ...scope({ ghostIDs: [otherGhost, voiceMedia.ghostID], conversationIDs: [otherConversation, voiceMedia.conversationID] }), targets: [
    { ghost_id: otherGhost, conversation_id: otherConversation },
    { ghost_id: voiceMedia.ghostID, conversation_id: voiceMedia.conversationID },
  ] };
  const allowed = await fixture(t, { deviceScope: pairs });
  assert.equal((await allowed.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody })).status, 200);
  const crossed = await fixture(t, { deviceScope: pairs, voice: { ...voiceMedia, conversationID: otherConversation } });
  assert.equal(JSON.parse((await crossed.call('/mobile/v1/bootstrap', { method: 'GET' })).data).voice_media, null);
  assert.equal((await crossed.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody })).status, 403);
  assert.equal((await crossed.call('/mobile/v1/voice/sessions/pc%231/hangup')).status, 403);
  assert.equal(crossed.dispatchedMedia.length, 0);
});

test('ICE candidates are validated and opaque pc identifiers stay encoded', async t => {
  const f = await fixture(t);
  const pcID = 'pc#with/special';
  const body = JSON.stringify({ candidates: [{ candidate: 'candidate:1 1 UDP 2130706431 10.0.0.1 8998 typ host', sdp_mid: '0', sdp_mline_index: 0 }] });
  const result = await f.call(`/mobile/v1/voice/sessions/${encodeURIComponent(pcID)}/ice`, { method: 'PATCH', headers: jsonHeaders, body });
  assert.equal(result.status, 200);
  assert.equal(f.dispatchedMedia[0].url, `${mediaOrigin}/sessions/${encodeURIComponent(pcID)}/ice`);
  for (const bad of [
    JSON.stringify({ candidates: [] }),
    JSON.stringify({ candidates: [{ candidate: 1, sdp_mid: '0', sdp_mline_index: 0 }] }),
    JSON.stringify({ candidates: [{ candidate: 'c', sdp_mid: '0', sdp_mline_index: 99 }] }),
    JSON.stringify({ other: true }),
  ]) {
    assert.equal((await f.call(`/mobile/v1/voice/sessions/${encodeURIComponent(pcID)}/ice`, { method: 'PATCH', headers: jsonHeaders, body: bad })).status, 400, bad.slice(0, 30));
  }
  assert.equal(f.dispatchedMedia.length, 1);
  assert.equal((await f.call('/mobile/v1/voice/sessions//ice', { method: 'PATCH', headers: jsonHeaders, body })).status, 404);
});

test('turn cancellation requires one canonical turn id', async t => {
  const f = await fixture(t);
  const turn = randomUUID();
  const result = await f.call('/mobile/v1/voice/sessions/pc1/cancel_turn', { headers: jsonHeaders, body: JSON.stringify({ turn_id: turn }) });
  assert.equal(result.status, 200);
  assert.equal(f.dispatchedMedia[0].url, `${mediaOrigin}/sessions/pc1/cancel_turn`);
  assert.equal(JSON.parse(f.dispatchedMedia[0].options.body).turn_id, turn);
  assert.equal((await f.call('/mobile/v1/voice/sessions/pc1/cancel_turn', { headers: jsonHeaders, body: JSON.stringify({ turn_id: 'latest' }) })).status, 400);
});

test('hangup completes, records the durable ended receipt, and rejects bodies', async t => {
  const f = await fixture(t);
  const result = await f.call('/mobile/v1/voice/sessions/pc%232/hangup', { headers: { 'Content-Type': 'application/json' } });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.data), { state: 'ended' });
  assert.equal(f.dispatchedMedia[0].url, `${mediaOrigin}/sessions/pc%232/hangup`);
  assert.equal(f.dispatchedMedia[0].options.headers['X-Ghost-Media-Device'], f.device.id);
  assert.equal(f.dispatchedMedia[0].options.body, undefined);
  const withBody = await f.call('/mobile/v1/voice/sessions/pc2/hangup', { headers: jsonHeaders, body: '{}' });
  assert.equal(withBody.status, 400);
  assert.equal(f.dispatchedMedia.length, 1);
});

test('a lost hangup response retries idempotently against the ended session', async t => {
  let calls = 0;
  const f = await fixture(t, {
    fetchMedia: async url => {
      if (url.endsWith('/hangup')) {
        calls += 1;
        if (calls === 1) throw new Error('loopback reset mid-request');
        return Response.json({ state: 'ended', already_ended: true });
      }
      return Response.json({});
    },
  });
  assert.equal((await f.call('/mobile/v1/voice/sessions/pc1/hangup')).status, 502);
  const retry = await f.call('/mobile/v1/voice/sessions/pc1/hangup');
  assert.equal(retry.status, 200);
  assert.deepEqual(JSON.parse(retry.data), { state: 'ended', already_ended: true });
});

test('start observation resolves through durable records and media evidence', async t => {
  const f = await fixture(t);
  // Unknown start: trustworthy absence because records precede any effect.
  const unknown = await f.call(`/mobile/v1/voice/starts/${startID}`, { method: 'GET' });
  assert.equal(unknown.status, 404);
  assert.deepEqual(JSON.parse(unknown.data), { ok: false, error: 'voice_start_unknown' });
  // Live start: the gateway probes the media service with the owner identity.
  await f.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody });
  const live = await f.call(`/mobile/v1/voice/starts/${startID}`, { method: 'GET' });
  assert.equal(live.status, 200);
  assert.deepEqual(JSON.parse(live.data), { state: 'live', pc_id: 'pc#1' });
  assert.equal(f.dispatchedMedia.at(-1).url, `${mediaOrigin}/starts/${startID}`);
  assert.equal(f.dispatchedMedia.at(-1).options.headers['X-Ghost-Media-Device'], f.device.id);
  // Media evidence expired or was lost: unknown, never fake-closed.
  f.dispatchedMedia.length = 0;
  const fMissing = await fixture(t, {
    fetchMedia: async url => {
      if (url.includes('/starts/')) return new Response('{"detail":"voice_start_unknown"}', { status: 404 });
      return Response.json({ sdp: 'v=0\r\nanswer', type: 'answer', pc_id: 'pc#1' });
    },
  });
  await fMissing.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody });
  const unresolved = await fMissing.call(`/mobile/v1/voice/starts/${startID}`, { method: 'GET' });
  assert.equal(unresolved.status, 502);
  assert.deepEqual(JSON.parse(unresolved.data), { ok: false, error: 'voice_start_unknown_outcome' });
});

test('an offer revoked mid-flight never admits media and tears the session down', async t => {
  const f = await fixture(t, {
    fetchMedia: async (url, options) => {
      if (url.endsWith('/offer')) {
        // The installation is re-issued while the offer is in flight: the
        // captured digest no longer matches the registry.
        const registry = JSON.parse(await readFile(f.devices, 'utf8'));
        registry.devices[0].digest = 'f'.repeat(64);
        await writeFile(f.devices, JSON.stringify(registry, null, 2) + '\n');
        return Response.json({ sdp: 'v=0\r\nanswer', type: 'answer', pc_id: 'pc#9' });
      }
      f.dispatchedMedia.push({ url, options });
      return Response.json({ state: 'ended' });
    },
  });
  const result = await f.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody });
  assert.equal(result.status, 401);
  assert.equal(JSON.parse(result.data).error, 'device_not_authorized');
  assert.ok(f.dispatchedMedia.some(entry => entry.url.endsWith('/sessions/pc%239/hangup')));
});

test('the media authority callback binds to the exact admitted start record', async t => {
  const f = await fixture(t);
  const authorityCall = body => f.call('/internal/v1/voice/authority', {
    headers: { ...jsonHeaders, Authorization: `Bearer ${mediaToken}`, 'X-Ghost-CSRF': mediaToken },
    body: JSON.stringify(body),
  });
  // The media control token is the only credential this endpoint accepts.
  const deviceCreds = await f.call('/internal/v1/voice/authority', {
    headers: { ...jsonHeaders, Authorization: `Bearer ${f.device.token}`, 'X-Ghost-CSRF': f.device.token },
    body: JSON.stringify({ device_id: f.device.id, start_id: startID }),
  });
  assert.equal(deviceCreds.status, 403);
  await f.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody });
  const authorized = await authorityCall({ device_id: f.device.id, start_id: startID });
  assert.equal(authorized.status, 200);
  assert.deepEqual(JSON.parse(authorized.data), { authorized: true });
  // Another start id on the same device never authorizes this session.
  const other = await authorityCall({ device_id: f.device.id, start_id: randomUUID() });
  assert.deepEqual(JSON.parse(other.data), { authorized: false });
  // A stale authority generation (re-issue) cannot revive the old record even
  // when a newer generation call exists on the same device.
  const registry = JSON.parse(await readFile(f.devices, 'utf8'));
  const entry = registry.devices.find(candidate => candidate.id === f.device.id);
  entry.digest = 'f'.repeat(64);
  entry.media.push({
    start_id: randomUUID(), pc_id: 'pc#2', since: new Date().toISOString(),
    fence: 'a'.repeat(64),
  });
  await writeFile(f.devices, JSON.stringify(registry, null, 2) + '\n');
  const stale = await authorityCall({ device_id: f.device.id, start_id: startID });
  assert.deepEqual(JSON.parse(stale.data), { authorized: false });
});

test('unresolved starts close only on media evidence, never by aging', async t => {
  let mediaUp = true;
  const f = await fixture(t, {
    fetchMedia: async (url, options) => {
      if (url.endsWith('/offer')) throw new Error('loopback reset before answer');
      if (url.includes('/starts/')) {
        if (!mediaUp) throw new Error('media service down');
        return new Response('{"detail":"voice_start_unknown"}', { status: 404 });
      }
      return Response.json({ state: 'ended' });
    },
  });
  const lost = await f.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody });
  assert.equal(lost.status, 502);
  // With the media service reachable, its provable absence closes the fence
  // and prunes the record.
  const resolved = await f.call(`/mobile/v1/voice/starts/${startID}`, { method: 'GET' });
  assert.equal(resolved.status, 404);
  let registry = JSON.parse(await readFile(f.devices, 'utf8'));
  assert.equal(registry.devices[0].media, undefined);
  // A brand-new call is admitted again only because the old fence truthfully
  // closed; the observation itself must not fabricate closure.
  assert.equal((await f.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody })).status, 502);
  // When the media service is unreachable the record stays unknown: no
  // aging, no invented closure.
  await f.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody });
  mediaUp = false;
  const unknown = await f.call(`/mobile/v1/voice/starts/${startID}`, { method: 'GET' });
  assert.equal(unknown.status, 502);
  registry = JSON.parse(await readFile(f.devices, 'utf8'));
  assert.equal(registry.devices[0].media.length, 1);
  assert.equal(registry.devices[0].media[0].ended_at, undefined);
});

test('media rejections pass through bounded details and unknown outcomes stay unknown', async t => {
  const f = await fixture(t, {
    fetchMedia: async (url) => {
      if (url.endsWith('/offer')) return Response.json({ detail: 'voice_call_limit' }, { status: 429 });
      throw new Error('media-private failure detail');
    },
  });
  const limited = await f.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody });
  assert.equal(limited.status, 429);
  assert.deepEqual(JSON.parse(limited.data), { error: 'voice_call_limit' });
  const unknown = await f.call('/mobile/v1/voice/sessions/pc1/hangup');
  assert.equal(unknown.status, 502);
  assert.ok(!unknown.data.includes('media-private'));
});

test('an invalid media answer fails closed without leaking the body', async t => {
  const f = await fixture(t, {
    fetchMedia: async () => Response.json({ sdp: 'v=0', type: 'offer', pc_id: '', host_internal: 'secret' }),
  });
  const result = await f.call('/mobile/v1/voice/offer', { headers: jsonHeaders, body: offerBody });
  assert.equal(result.status, 502);
  assert.deepEqual(JSON.parse(result.data), { error: 'voice_answer_unavailable' });
});
