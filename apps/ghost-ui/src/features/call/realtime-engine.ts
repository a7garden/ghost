import type { CallLevels, CallLine, MediaActivity } from './call-state';
import { Hysteresis, LevelMeter, rms } from './levels';
import { errorMessage, type CallMedia, type MediaOptions } from './media';

type Fragment = { speaker: CallLine['speaker']; start: number; end: number; delta: string };
type Tap = { analyser: AnalyserNode; waveform: Float32Array<ArrayBuffer> };

const PHRASE_GAP_MS = 1_100;
const LIVE_MS = 1_500;
const MAX_FRAGMENTS = 300;

/** Live transcripts have no turn id: phrases are runs of fragments with short gaps, merged across both speakers by audio time. */
export function phrases(fragments: readonly Fragment[], liveSpeakers: ReadonlySet<CallLine['speaker']>): CallLine[] {
  const out: { line: CallLine; start: number }[] = [];
  for (const speaker of ['owner', 'ghost'] as const) {
    const mine = fragments.filter(item => item.speaker === speaker).sort((a, b) => a.start - b.start);
    let current: { start: number; end: number; text: string } | null = null;
    const flush = (last: boolean) => {
      if (!current) return;
      const text = current.text.trim();
      if (text) out.push({ start: current.start, line: { id: `${speaker}:${current.start}`, speaker, text, live: last && liveSpeakers.has(speaker) } });
    };
    for (const part of mine) {
      if (current && part.start - current.end <= PHRASE_GAP_MS) {
        current.text += part.delta;
        current.end = Math.max(current.end, part.end);
      } else {
        flush(false);
        current = { start: part.start, end: part.end, text: part.delta };
      }
    }
    flush(true);
  }
  return out.sort((a, b) => a.start - b.start).map(item => item.line);
}

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
  const { client, call, signal, failed, ended, lines, audioBlocked } = options;
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
    remote = analyse(meter?.createMediaStreamSource(audio.srcObject));
    play();
  };
  peer.onconnectionstatechange = () => {
    window.clearTimeout(disconnect);
    if (signal.aborted) return;
    if (peer.connectionState === 'failed') failed('음성 연결이 끊겼습니다.');
    if (peer.connectionState === 'disconnected') disconnect = window.setTimeout(() => failed('음성 연결이 끊겼습니다.'), 3_000);
  };
  const tracks = stream.getAudioTracks();
  // Loudness for the call screen. Best effort: a context that cannot start leaves the meters at rest and the
  // transcript timing still tells the phase.
  const meter = typeof AudioContext === 'undefined' ? undefined : new AudioContext();
  const analyse = (node: AudioNode | undefined): Tap | undefined => {
    if (!meter || !node) return undefined;
    const analyser = meter.createAnalyser();
    analyser.fftSize = 1024;
    node.connect(analyser);
    return { analyser, waveform: new Float32Array(analyser.fftSize) };
  };
  const mic = analyse(meter?.createMediaStreamSource(stream));
  let remote: Tap | undefined;
  void meter?.resume().catch(() => {});
  signal.addEventListener('abort', () => { void meter?.close().catch(() => {}); }, { once: true });
  const inputMeter = new LevelMeter();
  const outputMeter = new LevelMeter();
  const hearing = new Hysteresis(.3, 300);
  const speaking = new Hysteresis(.08, 350);
  const sample = () => {
    for (const [tap, level] of [[mic, inputMeter], [remote, outputMeter]] as const) {
      if (!tap) continue;
      tap.analyser.getFloatTimeDomainData(tap.waveform);
      level.push(rms(tap.waveform));
    }
  };
  for (const track of tracks) {
    peer.addTrack(track, stream);
    track.addEventListener('ended', () => failed('마이크 연결이 끊겼습니다.'), { signal });
  }
  const events = peer.createDataChannel('oai-events');
  signal.addEventListener('abort', () => events.close(), { once: true });
  events.onclose = () => { if (!signal.aborted) failed('음성 연결이 끊겼습니다.'); };
  events.onerror = () => { if (!signal.aborted) failed('음성 세션에 연결하지 못했습니다.'); };

  const fragments: Fragment[] = [];
  const delivered = new Set<string>();
  const arrivedAt = { owner: -Infinity, ghost: -Infinity };
  let settle: number | undefined;
  const publishLines = () => {
    const now = performance.now();
    const live = new Set((['owner', 'ghost'] as const).filter(speaker => now - arrivedAt[speaker] < LIVE_MS));
    lines.replace(phrases(fragments, live));
    window.clearTimeout(settle);
    if (live.size) settle = window.setTimeout(publishLines, LIVE_MS + 50);
  };
  signal.addEventListener('abort', () => window.clearTimeout(settle), { once: true });
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
          const { delta, start_ms: start, end_ms: end, event_id: id } = event;
          if (typeof delta !== 'string' || !Number.isFinite(start) || !Number.isFinite(end)) break;
          if (typeof id === 'string') {
            if (delivered.has(id)) break;
            delivered.add(id);
          }
          const speaker = event.type === 'session.input_transcript.delta' ? 'owner' : 'ghost';
          fragments.push({ speaker, delta, start, end });
          arrivedAt[speaker] = performance.now();
          // Only the recent timeline is kept: the screen shows a short transcript.
          for (const mine of ['owner', 'ghost'] as const) {
            const count = fragments.filter(item => item.speaker === mine).length;
            for (let excess = count - MAX_FRAGMENTS; excess > 0; excess--) fragments.splice(fragments.findIndex(item => item.speaker === mine), 1);
          }
          publishLines();
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
    levels(): CallLevels {
      sample();
      return { input: inputMeter.read(), output: outputMeter.read() };
    },
    activity(): MediaActivity {
      sample();
      const now = performance.now();
      return {
        hearing: hearing.update(inputMeter.read(now), now) || now - arrivedAt.owner < 500,
        transcribing: false,
        speaking: speaking.update(outputMeter.read(now), now) || now - arrivedAt.ghost < 600,
      };
    },
  };
}
