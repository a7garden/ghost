import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('public/voice.js', import.meta.url), 'utf8');
function fixture({ getMedia, remoteFails = false, bridge } = {}) {
  const elements = new Map(), calls = [], sent = [], tracks = [{ enabled: true, stopped: false, stop() { this.stopped = true; } }];
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks };
  let channel, peer, now = Date.now(), timerID = 0;
  const timeouts = new Map(), intervals = new Map();
  class Peer {
    iceGatheringState = 'complete'; localDescription = { sdp: 'offer' }; connectionState = 'new';
    constructor() { peer = this; }
    addTrack() {}
    async createOffer() { return this.localDescription; }
    async setLocalDescription() {}
    async setRemoteDescription() { if (remoteFails) throw new Error('answer rejected'); }
    close() { this.closed = true; }
    createDataChannel() { channel = { readyState: 'connecting', send(value) { sent.push(JSON.parse(value)); }, close() { this.readyState = 'closed'; } }; return channel; }
  }
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, disabled: false, handlers: {}, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(event, fn) { this.handlers[event] = fn; }, async play() {} });
    return elements.get(id);
  } };
  const window = { addEventListener() {}, webkit: { messageHandlers: { ghostVoice: { async postMessage(value) {
    calls.push(value);
    if (bridge) { const response = await bridge(value); if (response !== undefined) return response; }
    if (value.operation === 'start') return { call_id: 'test', sdp: 'answer', expires_ms: now + 300000 };
    if (value.operation === 'work') return { task_id: 'saved-task' };
    if (value.operation === 'snapshot') return { tasks: [{ id: 'saved-task', phase: 'complete', output: 'saved result' }] };
    return {};
  } } } } };
  runInNewContext(source, {
    document, window, navigator: { mediaDevices: { getUserMedia: getMedia ?? (async () => stream) } }, RTCPeerConnection: Peer,
    setInterval: cb => { intervals.set(++timerID, cb); return timerID; }, clearInterval: id => intervals.delete(id),
    setTimeout: (cb, delay) => { timeouts.set(++timerID, { cb, at: now + delay }); return timerID; }, clearTimeout: id => timeouts.delete(id),
    Date: { now: () => now }, MediaStream: class {},
  });
  return {
    elements, calls, tracks, stream, sent, window, channel: () => channel, click: id => elements.get(id).handlers.click(),
    state(value) { peer.connectionState = value; peer.onconnectionstatechange?.(); },
    openChannel() { channel.readyState = 'open'; channel.onopen?.(); },
    connect() { this.state('connected'); this.openChannel(); },
    advance(milliseconds) {
      now += milliseconds;
      for (const cb of intervals.values()) cb();
      for (const [id, { cb, at }] of timeouts) if (at <= now) { timeouts.delete(id); cb(); }
    },
  };
}

test('microphone denial never starts a provider call', async () => {
  const f = fixture({ getMedia: async () => { throw new Error('microphone denied'); } });
  await f.click('start');
  assert.equal(f.calls.filter(c => c.operation === 'start').length, 0);
  assert.match(f.elements.get('error').textContent, /microphone denied/);
});
test('closing while permission is pending stops late microphone tracks', async () => {
  let resolveMedia;
  const f = fixture({ getMedia: () => new Promise(resolve => { resolveMedia = resolve; }) });
  const starting = f.click('start'); f.window.ghostStop(); resolveMedia(f.stream); await starting;
  assert.ok(f.tracks.every(t => t.stopped));
  assert.equal(f.calls.filter(c => c.operation === 'start').length, 0);
});
test('SDP failure closes media and asks the server to end its call', async () => {
  const f = fixture({ remoteFails: true }); await f.click('start');
  assert.ok(f.tracks.every(t => t.stopped));
  assert.deepEqual(f.calls.map(c => c.operation), ['start', 'end']);
});
test('tool output is delivered only after the durable task result, and call end does not cancel it', async () => {
  const f = fixture(); await f.click('start'); f.connect();
  f.channel().onmessage({ data: JSON.stringify({ type: 'response.function_call_arguments.done', name: 'delegate_work', call_id: 'function-1', arguments: '{"prompt":"do work"}' }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.map(c => c.operation), ['start', 'work', 'snapshot']);
  assert.equal(JSON.parse(f.sent[0].item.output).output, 'saved result');
  // Duplicate model events cannot create a second submission from this client.
  f.channel().onmessage({ data: JSON.stringify({ type: 'response.function_call_arguments.done', name: 'delegate_work', call_id: 'function-1', arguments: '{"prompt":"do work"}' }) });
  await f.click('end');
  assert.equal(f.calls.filter(c => c.operation === 'work').length, 1);
  assert.equal(f.calls.at(-1).operation, 'end');
  assert.ok(f.tracks.every(t => t.stopped));
});

test('call becomes active only when both media and data are connected', async () => {
  const f = fixture(); await f.click('start'); f.advance(5000);
  assert.equal(f.elements.get('status').textContent, '통화 연결 중');
  assert.equal(f.elements.get('timer').textContent, '');
  assert.equal(f.elements.get('end').hidden, false);
  f.state('connected');
  assert.equal(f.elements.get('status').textContent, '통화 연결 중');
  f.openChannel(); f.advance(2000);
  assert.equal(f.elements.get('status').textContent, 'Ghost와 통화 중');
  assert.equal(f.elements.get('timer').textContent, '0:02');
  await f.click('end');
});

test('a transient disconnection preserves elapsed time and mute state while recovering', async () => {
  const f = fixture(); await f.click('start'); f.connect(); f.advance(2000); f.click('mute');
  f.state('disconnected'); f.advance(3000);
  assert.equal(f.elements.get('status').textContent, '음성 연결 복구 중');
  assert.equal(f.calls.filter(c => c.operation === 'end').length, 0);
  f.state('connected'); f.advance(2000);
  assert.equal(f.elements.get('timer').textContent, '0:07');
  assert.equal(f.elements.get('status').textContent, 'Ghost와 통화 중');
  assert.equal(f.elements.get('mute').attributes['aria-pressed'], 'true');
  assert.equal(f.tracks[0].enabled, false);
  await f.click('end');
});

test('an unrecoverable disconnection closes the microphone after the recovery deadline', async () => {
  const f = fixture(); await f.click('start'); f.connect(); f.state('disconnected'); f.advance(15000);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.tracks.every(t => t.stopped));
  assert.equal(f.calls.filter(c => c.operation === 'end').length, 1);
  assert.match(f.elements.get('error').textContent, /복구하지 못했습니다/);
});

test('a media connection timeout ends the signalling session', async () => {
  const f = fixture(); await f.click('start'); f.advance(30000);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.tracks.every(t => t.stopped));
  assert.match(f.elements.get('error').textContent, /연결 시간이 초과/);
  assert.equal(f.calls.at(-1).operation, 'end');
});

test('ending while microphone permission is pending is immediately available', async () => {
  let resolveMedia;
  const f = fixture({ getMedia: () => new Promise(resolve => { resolveMedia = resolve; }) });
  const starting = f.click('start');
  assert.equal(f.elements.get('end').hidden, false);
  await f.click('end'); resolveMedia(f.stream); await starting;
  assert.ok(f.tracks.every(t => t.stopped));
  assert.equal(f.calls.filter(c => c.operation === 'start').length, 0);
  assert.equal(f.elements.get('status').textContent, '통화 종료');
});

test('a failed server hangup offers retry and prevents another call until acknowledged', async () => {
  let endFailures = 1;
  const f = fixture({ bridge: async value => { if (value.operation === 'end' && endFailures-- > 0) throw new Error('offline'); } });
  await f.click('start'); f.connect(); await f.click('end');
  assert.ok(f.tracks.every(t => t.stopped));
  assert.equal(f.elements.get('status').textContent, '서버 종료 확인 필요');
  assert.equal(f.elements.get('start').hidden, true);
  await f.click('start');
  assert.equal(f.calls.filter(c => c.operation === 'start').length, 1);
  await f.click('end');
  assert.equal(f.calls.filter(c => c.operation === 'end').length, 2);
  assert.equal(f.elements.get('status').textContent, '통화 종료');
});

test('late signalling cannot reactivate audio after ending', async () => {
  let resolveStart;
  const f = fixture({ bridge: value => value.operation === 'start' ? new Promise(resolve => { resolveStart = resolve; }) : undefined });
  const starting = f.click('start');
  await new Promise(resolve => setImmediate(resolve));
  await f.click('end');
  resolveStart({ call_id: 'late', sdp: 'answer', expires_ms: Date.now() + 10000 });
  await starting;
  assert.ok(f.tracks.every(t => t.stopped));
  assert.equal(f.elements.get('status').textContent, '통화 종료');
  assert.equal(f.elements.get('start').hidden, false);
});
