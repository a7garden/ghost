import { errorMessage, type CallMedia, type MediaOptions } from './media';

type Fragment = { start: number; end: number; delta: string };

function waitForIce(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  // iOS 17.0 WKWebView does not have Promise.withResolvers.
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      window.clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', change);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(signal.reason);
    const change = () => { if (peer.iceGatheringState === 'complete') finish(); };
    const timer = window.setTimeout(() => finish(new Error('음성 연결 주소를 준비하지 못했습니다.')), 10_000);
    peer.addEventListener('icegatheringstatechange', change);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else change();
  });
}

export function connectRealtime(stream: MediaStream, options: MediaOptions): CallMedia {
  const { client, call, signal, failed, ended, captions, audioBlocked } = options;
  const peer = new RTCPeerConnection();
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.setAttribute('playsinline', '');
  audio.hidden = true;
  document.body.append(audio);
  let disconnect: number | undefined;
  const play = () => {
    if (!audio.srcObject || audio.muted || signal.aborted) return;
    void audio.play().then(() => { if (!signal.aborted) audioBlocked(false); }, reason => {
      if (signal.aborted || audio.muted) return;
      if (reason instanceof DOMException && reason.name === 'NotAllowedError') audioBlocked(true);
      else failed(errorMessage(reason, '통화 음성을 재생할 수 없습니다.'));
    });
  };
  signal.addEventListener('abort', () => {
    window.clearTimeout(disconnect);
    peer.close();
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  }, { once: true });
  peer.ontrack = ({ track }) => {
    if (signal.aborted || track.kind !== 'audio') return;
    audio.srcObject = new MediaStream([track]);
    play();
  };
  peer.onconnectionstatechange = () => {
    window.clearTimeout(disconnect);
    if (signal.aborted) return;
    if (peer.connectionState === 'failed') failed('음성 연결이 끊겼습니다.');
    if (peer.connectionState === 'disconnected') disconnect = window.setTimeout(() => failed('음성 연결이 끊겼습니다.'), 3_000);
  };
  const tracks = stream.getAudioTracks();
  for (const track of tracks) {
    peer.addTrack(track, stream);
    track.addEventListener('ended', () => failed('마이크 연결이 끊겼습니다.'), { signal });
  }
  const events = peer.createDataChannel('oai-events');
  signal.addEventListener('abort', () => events.close(), { once: true });
  events.onclose = () => { if (!signal.aborted) failed('음성 연결이 끊겼습니다.'); };
  events.onerror = () => { if (!signal.aborted) failed('음성 세션에 연결하지 못했습니다.'); };

  const fragments: Record<'owner' | 'ghost', Fragment[]> = { owner: [], ghost: [] };
  const closeFromProvider = () => {
    events.onclose = null;
    events.onerror = null;
    peer.onconnectionstatechange = null;
    window.clearTimeout(disconnect);
    for (const track of tracks) track.enabled = false;
    audio.pause();
    audio.srcObject = null;
    peer.close();
    ended();
  };
  const started = new Promise<void>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    events.onmessage = ({ data }) => {
      if (signal.aborted || typeof data !== 'string') return;
      let event;
      try { event = JSON.parse(data); } catch { return; }
      switch (event?.type) {
        case 'session.started': resolve(); break;
        case 'session.closed': closeFromProvider(); break;
        case 'session.input_transcript.delta':
        case 'session.output_transcript.delta': {
          const { delta, start_ms: start, end_ms: end } = event;
          if (typeof delta !== 'string' || !Number.isFinite(start) || !Number.isFinite(end)) break;
          const side = event.type === 'session.input_transcript.delta' ? 'owner' : 'ghost';
          const parts = fragments[side];
          parts.push({ delta, start, end });
          parts.sort((a, b) => a.start - b.start);
          // Live transcripts have no turn id. Keep a short timeline per speaker and show the latest phrase.
          let first = parts.length - 1;
          while (first > 0 && parts.length - first < 40 && parts[first]!.start - parts[first - 1]!.end <= 1_100) first--;
          if (first) parts.splice(0, first);
          captions({ [side]: parts.map(part => part.delta).join('') });
          break;
        }
      }
    };
  });
  const negotiated = (async () => {
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIce(peer, signal);
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error('음성 연결을 제안하지 못했습니다.');
    const answer = await client.offer(call.id, { sdp }, signal);
    signal.throwIfAborted();
    await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  })();

  return {
    connected: Promise.all([negotiated, started]).then(() => {}),
    setMicMuted(muted) { for (const track of tracks) track.enabled = !muted; },
    setSpeakerMuted(muted) { audio.muted = muted; if (!muted) play(); },
    resumeAudio: play,
  };
}
