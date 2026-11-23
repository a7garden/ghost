import captureModule from './capture.worklet.js?url&no-inline';
import { captionRole } from './call-state';
import { encodeWav, PcmFrames, VoiceActivity } from './capture';
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

export function connectLocal(stream: MediaStream, context: AudioContext, options: MediaOptions): CallMedia {
  const { client, store, call, signal, captions, failed } = options;
  const tracks = stream.getAudioTracks();
  const output = context.createGain();
  output.connect(context.destination);
  let speakerMuted = false;
  let micMuted = false;
  let capturing = false;
  let nextAt = 0;
  let voiceTurn = false;
  let offset = 0;
  let spokenPrefix = '';
  let cancelling = Promise.resolve();
  let submissions = Promise.resolve();
  let streamedOwner = false;
  let streamedGhost = false;
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
  const voice = new VoiceActivity();
  const framer = new PcmFrames(context.sampleRate, frame => {
    const { started, finished, utterance } = voice.push(frame, !speakerMuted && playback.playing);
    if (started) {
      capturing = true;
      if (playback.busy) {
        stopSpeech();
        voiceTurn = false; // Ignore any final/partial frames of the interrupted answer.
        cancelling = client.send({ type: 'message.cancel', conversationId: call.conversationId }).then(() => {}, reported);
      }
    }
    if (finished) capturing = false;
    if (!utterance) return;
    const requestId = crypto.randomUUID();
    submissions = submissions.then(async () => {
      if (signal.aborted) return;
      const { text } = await client.transcribe(call.id, encodeWav(utterance), signal);
      await cancelling;
      if (signal.aborted || !text.trim()) return;
      await client.send({ type: 'message.send', conversationId: call.conversationId, callId: call.id, text: text.trim() }, requestId);
    }).catch(reported);
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
      if (side === 'owner') { streamedOwner = true; captions({ owner: message.text }); }
      if (side === 'ghost') { streamedGhost = true; captions({ ghost: message.text }); }
      if (message.role === 'user') {
        voiceTurn = side === 'owner';
        stopSpeech();
      } else if (message.role === 'assistant') {
        if (side === 'ghost' && message.toolCalls.length === 0) {
          enqueueReply(message.text, true);
          voiceTurn = false;
        }
        offset = 0;
        spokenPrefix = '';
      }
    } else if (event.live.running && event.live.partial && event.live.partial !== '[quiet]') {
      streamedGhost = true;
      captions({ ghost: event.live.partial });
      enqueueReply(event.live.partial, false);
    }
  });
  // A local reattach restores captions, but never speaks history or replays a prior utterance.
  void client.conversation(call.conversationId).then(page => {
    if (signal.aborted) return;
    for (let index = page.messages.length - 1; index >= 0 && !(streamedOwner && streamedGhost); index--) {
      const message = page.messages[index]!;
      const side = captionRole(message, call);
      if (side === 'owner' && !streamedOwner) { streamedOwner = true; captions({ owner: message.text }); }
      if (side === 'ghost' && !streamedGhost) { streamedGhost = true; captions({ ghost: message.text }); }
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
  };
}
