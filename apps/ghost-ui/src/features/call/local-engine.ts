import captureModule from './capture.worklet.js?url&no-inline';
import { captionRole, type CallLevels, type MediaActivity } from './call-state';
import { encodeWav, PcmFrames, VoiceActivity } from './capture';
import { LevelMeter, rms } from './levels';
import { errorMessage, type CallMedia, type MediaOptions } from './media';
import { SpeechQueue, speechSentences } from './speech';

export type LocalAudio = { context: AudioContext; resumed: Promise<void> };

/** Construct and resume Web Audio synchronously under the same gesture that opens the microphone. */
export function prepareLocalAudio(signal: AbortSignal): LocalAudio {
  if (typeof AudioContext === 'undefined') throw new Error('이 화면에서는 통화 음성을 재생할 수 없습니다.');
  const context = new AudioContext();
  signal.addEventListener('abort', () => { void context.close().catch(() => {}); }, { once: true });
  return { context, resumed: context.resume() };
}

const LIVE_LINE = 'ghost:live';

export function connectLocal(stream: MediaStream, context: AudioContext, options: MediaOptions): CallMedia {
  const { client, store, call, signal, lines, failed } = options;
  const tracks = stream.getAudioTracks();
  const output = context.createGain();
  output.connect(context.destination);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  output.connect(analyser);
  const waveform = new Float32Array(analyser.fftSize);
  const inputMeter = new LevelMeter();
  const outputMeter = new LevelMeter();
  let speakerMuted = false;
  let micMuted = false;
  let capturing = false;
  let transcribing = 0;
  let nextAt = 0;
  let voiceTurn = false;
  let offset = 0;
  let spokenPrefix = '';
  let lastFinal = '';
  let liveText = '';
  let cancelled = 0;
  let cancelling = Promise.resolve();
  let submissions = Promise.resolve();
  const pendingOwner: string[] = [];
  const seen = new Set<string>();
  const reported = (reason: unknown) => {
    if (!signal.aborted) failed(errorMessage(reason, '통화 음성을 처리하지 못했습니다.'));
  };

  const playback = new SpeechQueue<AudioBuffer>({
    async load(text, request) {
      const wav = await client.speak(call.id, { text }, request);
      request.throwIfAborted();
      return context.decodeAudioData(wav);
    },
    play(buffer, finished) {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(output);
      const start = nextAt > context.currentTime ? nextAt : context.currentTime + .02;
      source.onended = () => { source.disconnect(); finished(); };
      source.start(start);
      nextAt = start + buffer.duration;
      return () => { source.onended = null; source.stop(); source.disconnect(); };
    },
    failed: reported,
  });

  const stopSpeech = () => {
    playback.interrupt();
    nextAt = 0;
    offset = 0;
    spokenPrefix = '';
  };
  // What was cut off stays on screen as said, no longer live.
  const closeGhostLine = () => {
    if (lines.has(LIVE_LINE)) lines.settle(LIVE_LINE, `ghost:cut:${++cancelled}`, 'ghost', liveText);
  };

  const voice = new VoiceActivity();
  const framer = new PcmFrames(context.sampleRate, frame => {
    inputMeter.push(rms(frame, 32768));
    const { started, finished, utterance } = voice.push(frame, !speakerMuted && playback.playing);
    if (started) {
      capturing = true;
      if (playback.busy) {
        stopSpeech();
        closeGhostLine();
        voiceTurn = false; // Ignore any final/partial frames of the interrupted answer.
        cancelling = client.send({ type: 'message.cancel', conversationId: call.conversationId }).then(() => {}, reported);
      }
    }
    if (finished) capturing = false;
    if (!utterance) return;
    const requestId = crypto.randomUUID();
    transcribing++;
    submissions = submissions.then(async () => {
      if (signal.aborted) return;
      const { text } = await client.transcribe(call.id, encodeWav(utterance), signal);
      await cancelling;
      if (signal.aborted || !text.trim()) return;
      // The words appear as soon as they are recognized, not after the Ghost has accepted them.
      const id = `owner:${requestId}`;
      lines.upsert(id, 'owner', text.trim(), false);
      pendingOwner.push(id);
      await client.send({ type: 'message.send', conversationId: call.conversationId, callId: call.id, text: text.trim() }, requestId);
    }).catch(reported).finally(() => { transcribing--; });
  });

  const enqueueReply = (text: string, final: boolean) => {
    if (!voiceTurn || capturing || text.trim() === '[quiet]') return;
    // A replacement partial must not read a previously scheduled prefix again.
    if (offset > 0 && !text.startsWith(spokenPrefix)) return;
    const next = speechSentences(text, offset, final);
    if (next.offset === offset) return;
    playback.enqueue(next.sentences);
    offset = next.offset;
    spokenPrefix = text.slice(0, offset);
  };

  const unwatch = store.watchConversation(call.conversationId, event => {
    if (signal.aborted) return;
    if (event.type === 'message') {
      const message = event.message;
      if (seen.has(message.id)) return;
      seen.add(message.id);
      const side = captionRole(message, call);
      if (message.role === 'user') {
        voiceTurn = side === 'owner';
        stopSpeech();
        if (side === 'owner') {
          const pending = pendingOwner.shift();
          if (pending) lines.settle(pending, message.id, 'owner', message.text);
          else lines.upsert(message.id, 'owner', message.text, false);
        }
      } else if (message.role === 'assistant') {
        if (side === 'ghost') {
          lastFinal = message.text;
          liveText = '';
          lines.settle(LIVE_LINE, message.id, 'ghost', message.text);
          // Words before a tool call are the Ghost's opening answer: say them now, while the work runs.
          enqueueReply(message.text, true);
          if (message.toolCalls.length === 0) voiceTurn = false;
        }
        offset = 0;
        spokenPrefix = '';
      }
    } else if (event.live.running && event.live.partial && event.live.partial !== '[quiet]' && event.live.partial !== lastFinal) {
      liveText = event.live.partial;
      lines.upsert(LIVE_LINE, 'ghost', liveText, true);
      enqueueReply(liveText, false);
    }
  });
  // A local reattach restores the recent transcript, but never speaks history or replays a prior utterance.
  void client.conversation(call.conversationId).then(page => {
    if (signal.aborted) return;
    for (const message of page.messages) {
      const side = captionRole(message, call);
      if (!side || seen.has(message.id)) continue;
      seen.add(message.id);
      lines.upsert(message.id, side, message.text, false);
    }
  }).catch(reported);

  const source = context.createMediaStreamSource(stream);
  let capture: AudioWorkletNode | ScriptProcessorNode | undefined;
  const onState = () => { if (context.state !== 'running') reported(new Error('오디오 연결이 끊겼습니다.')); };
  signal.addEventListener('abort', () => {
    unwatch();
    stopSpeech();
    source.disconnect();
    capture?.disconnect();
    if (capture && 'port' in capture) capture.port.close();
    output.disconnect();
    analyser.disconnect();
  }, { once: true });
  for (const track of tracks) track.addEventListener('ended', () => reported(new Error('마이크 연결이 끊겼습니다.')), { signal });

  const connected = (async () => {
    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      await context.audioWorklet.addModule(captureModule);
      signal.throwIfAborted();
      const node = new AudioWorkletNode(context, 'ghost-call-capture', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
      node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => { if (!micMuted && !signal.aborted) framer.push(data); };
      node.onprocessorerror = () => reported(new Error('마이크 소리를 처리하지 못했습니다.'));
      capture = node;
    } else {
      const node = context.createScriptProcessor(1024, 1, 1);
      node.onaudioprocess = event => { if (!micMuted && !signal.aborted) framer.push(event.inputBuffer.getChannelData(0)); };
      capture = node;
    }
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(capture).connect(silent).connect(context.destination);
    signal.addEventListener('abort', () => silent.disconnect(), { once: true });
    context.addEventListener('statechange', onState, { signal });
    if (context.state !== 'running') throw new Error('오디오를 시작하지 못했습니다.');
  })();

  return {
    connected,
    setMicMuted(muted) {
      if (muted) { framer.reset(); voice.reset(); capturing = false; }
      micMuted = muted;
      for (const track of tracks) track.enabled = !muted;
    },
    setSpeakerMuted(muted) { speakerMuted = muted; output.gain.value = muted ? 0 : 1; },
    levels(): CallLevels {
      analyser.getFloatTimeDomainData(waveform);
      outputMeter.push(rms(waveform));
      return { input: inputMeter.read(), output: outputMeter.read() };
    },
    activity(): MediaActivity {
      return { hearing: capturing, transcribing: transcribing > 0, speaking: playback.busy };
    },
  };
}
