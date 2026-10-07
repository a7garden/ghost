/* Native credentials never enter this page. Only call-bound operations are
 * available through the origin-checked WKWebView request/reply bridge. */
'use strict';
const el = id => document.getElementById(id);
const request = payload => {
  const bridge = window.webkit?.messageHandlers?.ghostVoice;
  if (!bridge) return Promise.reject(new Error('Ghost iPhone 앱에서 통화 화면을 열어 주세요.'));
  return bridge.postMessage(payload);
};
let peer, media, events, timer, deadline, ending;
let started = null, phase = 'idle', generation = 0, answered = false;
const terminal = new Set(['complete', 'failed', 'cancelled', 'uncertain', 'waiting_owner']);
const functions = new Set(), jobs = new Set();
const live = () => ['active', 'reconnecting'].includes(phase);
function showError(error) { el('error').textContent = error?.message || String(error); }
function render() {
  el('status').textContent = {
    idle: '음성 통화', connecting: '통화 연결 중', active: jobs.size ? '작업 진행 중 · 통화 중' : 'Ghost와 통화 중',
    reconnecting: '음성 연결 복구 중', ending: '통화 종료 확인 중', ended: '통화 종료', unconfirmed: '서버 종료 확인 필요',
  }[phase];
  el('start').hidden = !['idle', 'ended'].includes(phase);
  el('end').hidden = ['idle', 'ended'].includes(phase);
  el('end').disabled = phase === 'ending';
  el('end').textContent = phase === 'unconfirmed' ? '서버 종료 다시 확인' : phase === 'connecting' ? '연결 취소' : '통화 종료';
  el('mute').hidden = !media || !['connecting', 'active', 'reconnecting'].includes(phase);
  const muted = media?.getAudioTracks().every(track => !track.enabled) ?? false;
  el('mute').textContent = muted ? '마이크 켜기' : '마이크 끄기';
  el('mute').setAttribute('aria-pressed', String(muted));
}
function transition(next) { phase = next; render(); }
function stopMedia() {
  generation++;
  clearInterval(timer); clearTimeout(deadline);
  if (events) { events.onmessage = events.onopen = events.onclose = null; events.close(); }
  if (peer) { peer.onconnectionstatechange = peer.ontrack = null; peer.close(); }
  media?.getTracks().forEach(track => track.stop());
  events = peer = media = null; el('audio').srcObject = null;
  answered = false; jobs.clear();
}
window.ghostStop = () => { stopMedia(); transition('ended'); };
function end() {
  if (ending) return ending;
  const retrying = phase === 'unconfirmed';
  stopMedia(); transition('ending');
  ending = (async () => {
    try { await request({ operation: 'end' }); if (retrying) el('error').textContent = ''; transition('ended'); }
    catch {
      transition('unconfirmed');
      showError(new Error('마이크는 닫혔습니다. 서버 종료를 다시 확인하거나 진행 중 화면에서 통화를 종료해 주세요.'));
    } finally { ending = null; }
  })();
  return ending;
}
function armDeadline(milliseconds, message, epoch) {
  clearTimeout(deadline);
  deadline = setTimeout(() => {
    if (epoch !== generation) return;
    showError(new Error(message)); void end();
  }, milliseconds);
}
function updateConnection(epoch) {
  if (epoch !== generation || !peer) return;
  if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
    showError(new Error('음성 연결이 끊겼습니다.')); void end(); return;
  }
  if (answered && peer.connectionState === 'connected' && events?.readyState === 'open') {
    clearTimeout(deadline);
    if (started === null) started = Date.now();
    transition('active');
  } else if (live() && phase !== 'reconnecting') {
    transition('reconnecting');
    armDeadline(15000, '음성 연결을 복구하지 못했습니다. 다시 통화해 주세요.', epoch);
  }
}
async function onEvent(event, epoch) {
  if (!live() || epoch !== generation) return;
  if (['conversation.item.input_audio_transcription.completed', 'response.output_audio_transcript.done', 'response.audio_transcript.done'].includes(event.type)) {
    const role = event.type.startsWith('conversation.') ? 'user' : 'assistant';
    if (typeof event.transcript === 'string' && event.transcript.trim()) {
      el('caption').textContent = event.transcript;
      await request({ operation: 'event', role, transcript: event.transcript, event_id: event.event_id || event.item_id + ':' + role });
    }
  }
  if (event.type === 'response.function_call_arguments.done' && event.name === 'delegate_work' && !functions.has(event.call_id)) {
    functions.add(event.call_id);
    const { prompt } = JSON.parse(event.arguments);
    const submitted = await request({ operation: 'work', function_id: event.call_id, prompt });
    if (epoch !== generation) return;
    jobs.add(event.call_id); render();
    while (live() && epoch === generation) {
      const conversation = await request({ operation: 'snapshot' });
      if (epoch !== generation) return;
      const task = conversation.tasks?.find(t => t.id === submitted.task_id && terminal.has(t.phase));
      if (task && phase === 'active' && events?.readyState === 'open') {
        events.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify({ phase: task.phase, output: task.output }) } }));
        events.send(JSON.stringify({ type: 'response.create' }));
        jobs.delete(event.call_id); render(); return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
function gather(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pc.removeEventListener('icegatheringstatechange', changed); reject(new Error('음성 연결 준비 시간이 초과됐습니다.')); }, 10000);
    function changed() { if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); pc.removeEventListener('icegatheringstatechange', changed); resolve(); } }
    pc.addEventListener('icegatheringstatechange', changed);
  });
}
async function start() {
  if (!['idle', 'ended'].includes(phase) || ending) return;
  const epoch = ++generation;
  started = null; el('timer').textContent = ''; el('caption').textContent = ''; el('error').textContent = '';
  functions.clear(); jobs.clear(); transition('connecting');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    if (epoch !== generation) { stream.getTracks().forEach(t => t.stop()); return; }
    media = stream; const pc = peer = new RTCPeerConnection(); render();
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    pc.ontrack = event => {
      if (epoch !== generation) return;
      el('audio').srcObject = event.streams[0] || new MediaStream([event.track]);
      el('audio').play().catch(error => { if (epoch === generation) showError(error); });
    };
    pc.onconnectionstatechange = () => updateConnection(epoch);
    events = pc.createDataChannel('oai-events');
    events.onopen = () => updateConnection(epoch);
    events.onclose = () => {
      if (epoch !== generation) return;
      showError(new Error('통화 데이터 연결이 끊겼습니다.')); void end();
    };
    events.onmessage = message => {
      try { void onEvent(JSON.parse(message.data), epoch).catch(error => { if (epoch === generation) showError(error); }); }
      catch (error) { if (epoch === generation) showError(error); }
    };
    await pc.setLocalDescription(await pc.createOffer()); await gather(pc);
    if (epoch !== generation) return;
    const result = await request({ operation: 'start', sdp: pc.localDescription.sdp });
    // Native signalling owns late-start cleanup, including a dismissed web view.
    if (epoch !== generation) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: result.sdp });
    if (epoch !== generation) return;
    answered = true;
    armDeadline(30000, '음성 연결 시간이 초과됐습니다. 다시 통화해 주세요.', epoch);
    updateConnection(epoch);
    timer = setInterval(() => {
      if (epoch !== generation) return;
      if (started !== null) {
        const seconds = Math.floor((Date.now() - started) / 1000);
        el('timer').textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
      }
      if (Date.now() >= result.expires_ms) void end();
    }, 1000);
  } catch (error) {
    if (epoch !== generation) return;
    showError(error); await end();
  }
}
el('start').addEventListener('click', start);
el('end').addEventListener('click', end);
el('mute').addEventListener('click', () => {
  if (!media) return;
  const muted = media.getAudioTracks().some(t => t.enabled);
  media.getAudioTracks().forEach(t => t.enabled = !muted); render();
});
window.addEventListener('pagehide', window.ghostStop);
render();
