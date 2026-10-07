import { encodeWav, resampleMono, VoiceActivityDetector } from './audio';
import { SpeechProbabilityStream, SPEECH_RATE } from './speechProbability';
import type { SpeechClassifierFactory } from './speechProbability';

export type VoiceConfiguration = { available: boolean; reason?: string; settings_version: number; stt_model?: string; tts_model?: string };
export type VoiceReply = { id: string; taskId: string; text: string };
export type VoiceState = { phase: 'idle' | 'connecting' | 'listening' | 'transcribing' | 'working' | 'speaking' | 'muted' | 'error'; active: boolean; muted: boolean; speaking: boolean; capturing: boolean; pendingTurns: number; runningTasks: number; transcript: string; error: string; config?: VoiceConfiguration; preparingSpeech?: boolean };
export interface VoiceTransport {
  configure(signal: AbortSignal): Promise<VoiceConfiguration>;
  transcribe(wav: Blob, signal: AbortSignal): Promise<{ text: string }>;
  synthesize(reply: VoiceReply, signal: AbortSignal): Promise<Blob>;
}
export interface VoiceCapture { start(onSamples: (samples: Float32Array, rate: number) => void, onError: (error: Error) => void): Promise<void>; stop(): void; mute(muted: boolean): void }
export interface VoiceOutput { prepare(): Promise<void>; play(audio: Blob, onStarted: () => void): Promise<void>; stop(): void; close(): void }
export type VoiceCallbacks = { submitTranscript(text: string): Promise<void>; cancelWork(): Promise<void>; onState(state: VoiceState): void; onSpeakingChange?(speaking: boolean): void };

// Session generation guards microphone/configuration acquisition. Output
// generation guards TTS and decode completions. Neither cancels durable work.
export class VoiceController {
  private session = 0;
  private outputEpoch = 0;
  private utteranceEpoch = 0;
  private sessionAbort?: AbortController;
  private transcriptionAbort?: AbortController;
  private outputAbort?: AbortController;
  private heardReplies = new Set<string>();
  private vad: VoiceActivityDetector;
  private speech?: SpeechProbabilityStream;
  private submitting = 0;
  state: VoiceState = { phase: 'idle', active: false, muted: false, speaking: false, capturing: false, pendingTurns: 0, runningTasks: 0, transcript: '', error: '' };
  constructor(private transport: VoiceTransport, private capture: VoiceCapture, private output: VoiceOutput, private callbacks: VoiceCallbacks, private classifierFactory: SpeechClassifierFactory = async signal => (await import('./speechClassifier')).createSpeechClassifier(signal)) {
    this.vad = new VoiceActivityDetector(() => {
      ++this.utteranceEpoch;
      this.transcriptionAbort?.abort(); this.transcriptionAbort = undefined;
      this.bargeIn();
    }, (samples, rate) => { void this.transcribe(samples, rate); }, {}, error => this.fail(error));
  }
  private publish(change: Partial<VoiceState> = {}) {
    const speakingBefore = this.state.speaking;
    this.state = { ...this.state, ...change, pendingTurns: this.submitting, preparingSpeech: Boolean(this.outputAbort) };
    if (!('phase' in change)) this.state.phase = this.state.error ? 'error' : !this.state.active ? 'idle' : this.state.muted ? 'muted' : this.state.speaking ? 'speaking' : this.transcriptionAbort ? 'transcribing' : this.submitting || this.state.runningTasks || this.outputAbort ? 'working' : 'listening';
    if (speakingBefore !== this.state.speaking) this.callbacks.onSpeakingChange?.(this.state.speaking);
    this.callbacks.onState({ ...this.state });
  }
  async start() {
    if (this.state.active || this.state.phase === 'connecting') return;
    const session = ++this.session, abort = this.sessionAbort = new AbortController();
    this.heardReplies.clear(); this.vad.reset(); this.publish({ phase: 'connecting', error: '', transcript: '', muted: false });
    try {
      // Resume audio directly from the user gesture, before asynchronous network
      // checks; unavailable providers still never acquire a microphone.
      const [config] = await Promise.all([this.transport.configure(abort.signal), this.output.prepare()]);
      if (session !== this.session) return;
      if (!config.available) throw new Error(config.reason || '설정에서 로컬 STT와 TTS 모델을 선택하고 연결을 확인해 주세요.');
      this.publish({ config, phase: 'connecting' });
      const classifier = await this.classifierFactory(abort.signal);
      if (session !== this.session) { await classifier.close(); return; }
      const speech = this.speech = new SpeechProbabilityStream(classifier, (frame, probability) => { if (session === this.session && this.state.active && !this.state.muted) this.vad.push(frame, SPEECH_RATE, probability); }, error => { if (session === this.session) this.fail(error); });
      await this.capture.start((samples, rate) => { if (session === this.session && this.state.active && !this.state.muted) speech.push(samples, rate); }, error => { if (session === this.session) this.fail(error); });
      if (session !== this.session) return;
      this.publish({ active: true, capturing: true, error: '' });
    } catch (error) { if (session === this.session) this.fail(error); }
  }
  private fail(error: unknown) {
    this.end(); this.publish({ phase: 'error', error: error instanceof Error ? error.message : '음성 연결을 확인할 수 없습니다.' });
  }
  end() {
    ++this.session; ++this.utteranceEpoch;
    this.sessionAbort?.abort(); this.transcriptionAbort?.abort(); this.transcriptionAbort = undefined;
    this.capture.stop(); this.speech?.close(); this.speech = undefined; this.vad.reset(); this.bargeIn(); this.output.close();
    this.publish({ active: false, capturing: false, muted: false, error: '', phase: 'idle' });
  }
  mute(muted: boolean) {
    if (!this.state.active) return;
    this.capture.mute(muted); this.speech?.reset(); this.vad.reset();
    if (muted) { ++this.utteranceEpoch; this.transcriptionAbort?.abort(); this.transcriptionAbort = undefined; }
    this.publish({ muted });
  }
  bargeIn() {
    ++this.outputEpoch; this.outputAbort?.abort(); this.outputAbort = undefined; this.output.stop();
    this.publish({ speaking: false });
  }
  setRunningTasks(count: number) { this.publish({ runningTasks: Math.max(0, count) }); }
  async cancelWork() {
    this.bargeIn();
    try { await this.callbacks.cancelWork(); } catch (error) { this.publish({ error: error instanceof Error ? error.message : '작업 취소 결과를 확인해 주세요.' }); }
  }
  private async transcribe(samples: Float32Array, rate: number) {
    const session = this.session, utterance = ++this.utteranceEpoch;
    this.transcriptionAbort?.abort(); const abort = this.transcriptionAbort = new AbortController();
    this.publish({ error: '' });
    try {
      const { text } = await this.transport.transcribe(encodeWav(resampleMono(samples, rate)), abort.signal);
      if (session !== this.session || utterance !== this.utteranceEpoch || abort.signal.aborted || !this.state.active || this.state.muted) return;
      this.transcriptionAbort = undefined;
      if (!text.trim()) { this.publish(); return; }
      this.submitting++; this.publish({ transcript: text.trim() });
      // The submission has its own durable receipt. Ending the call or speaking
      // again must not abort, replay, or cancel this action.
      try { await this.callbacks.submitTranscript(text.trim()); }
      finally { this.submitting--; if (session === this.session) this.publish(); }
    } catch (error) {
      if (session === this.session && utterance === this.utteranceEpoch && !abort.signal.aborted) this.publish({ error: error instanceof Error ? error.message : '발화를 텍스트로 바꾸지 못했습니다.' });
    } finally {
      if (this.transcriptionAbort === abort) { this.transcriptionAbort = undefined; this.publish(); }
    }
  }
  async speak(reply: VoiceReply) {
    if (!this.state.active || !reply.text.trim() || this.heardReplies.has(reply.id)) return;
    this.heardReplies.add(reply.id);
    // A result arriving while the owner speaks remains in the conversation;
    // it must not start talking over that new utterance.
    if (this.vad.isSpeaking) return;
    this.bargeIn();
    const session = this.session, epoch = this.outputEpoch, abort = this.outputAbort = new AbortController();
    this.publish({ error: '' });
    try {
      const audio = await this.transport.synthesize(reply, abort.signal);
      if (session !== this.session || epoch !== this.outputEpoch || abort.signal.aborted || !this.state.active) return;
      await this.output.play(audio, () => { if (session === this.session && epoch === this.outputEpoch) this.publish({ speaking: true, error: '' }); });
    } catch (error) {
      if (session === this.session && epoch === this.outputEpoch && !abort.signal.aborted) this.publish({ error: error instanceof Error ? error.message : '음성 출력을 재생하지 못했습니다.' });
    } finally {
      if (session === this.session && epoch === this.outputEpoch) { this.outputAbort = undefined; this.publish({ speaking: false }); }
    }
  }
}
