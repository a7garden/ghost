import { expect, it, vi } from 'vitest';
import { VoiceController } from './controller';
import { rms } from './audio';
import type { VoiceCapture, VoiceOutput, VoiceTransport, VoiceState } from './controller';
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
async function settle() { for (let index = 0; index < 300; index++) await Promise.resolve(); }
function fixture(overrides: Partial<VoiceTransport> = {}, submit = vi.fn(async () => {})) {
  let input: (samples: Float32Array, rate: number) => void = () => {};
  const capture: VoiceCapture = { start: vi.fn(async callback => { input = callback; }), stop: vi.fn(), mute: vi.fn() };
  const output: VoiceOutput = { prepare: vi.fn(async () => {}), play: vi.fn(async (_audio, started) => { started(); }), stop: vi.fn(), close: vi.fn() };
  const transport: VoiceTransport = { configure: vi.fn(async () => ({ available: true, settings_version: 7, stt_model: 'local/whisper', tts_model: 'local/kokoro' })), transcribe: vi.fn(async () => ({ text: '다음 작업도 해 주세요' })), synthesize: vi.fn(async () => new Blob([], { type: 'audio/wav' })), ...overrides };
  const cancel = vi.fn(async () => {}), states: VoiceState[] = [], speaking = vi.fn();
  const controller = new VoiceController(transport, capture, output, { submitTranscript: submit, cancelWork: cancel, onState: state => states.push(state), onSpeakingChange: speaking }, async () => ({ classify: async frame => rms(frame) > .018 ? .99 : .01, reset() {}, async close() {} }));
  const push = (amplitude: number, count: number) => { for (let index = 0; index < count; index++) input(new Float32Array(320).fill(amplitude), 16000); };
  const utterance = () => { push(0.1, 18); push(0, 75); };
  return { controller, transport, capture, output, submit, cancel, states, speaking, push, utterance };
}
it('does not open microphone when local roles are unavailable', async () => {
  const f = fixture({ configure: async () => ({ available: false, settings_version: 7, reason: '로컬 STT 미선택' }) });
  await f.controller.start(); expect(f.capture.start).not.toHaveBeenCalled(); expect(f.controller.state.error).toBe('로컬 STT 미선택'); expect(f.controller.state.active).toBe(false);
});
it('barge-in aborts pending synthesis and discards late output without cancelling work', async () => {
  const pending = deferred<Blob>(); let signal: AbortSignal | undefined;
  const f = fixture({ synthesize: vi.fn(async (_reply, s) => { signal = s; return pending.promise; }) });
  await f.controller.start(); f.controller.setRunningTasks(1);
  const speech = f.controller.speak({ id: 'reply', taskId: 'task', text: '첫 응답' });
  f.push(0.1, 5); await settle(); expect(signal?.aborted).toBe(true); expect(f.output.stop).toHaveBeenCalled();
  pending.resolve(new Blob([], { type: 'audio/wav' })); await speech;
  expect(f.output.play).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled(); expect(f.controller.state.runningTasks).toBe(1); expect(f.controller.state.capturing).toBe(true);
});
it('stops active playback on speech onset and reports mouth state only during playback', async () => {
  const finished = deferred<void>(); const f = fixture();
  f.output.play = vi.fn(async (_audio, started) => { started(); await finished.promise; });
  await f.controller.start(); const speech = f.controller.speak({ id: 'reply', taskId: 'task', text: '응답' }); await settle();
  expect(f.controller.state.speaking).toBe(true); expect(f.speaking).toHaveBeenCalledWith(true);
  f.push(0.1, 5); await settle(); expect(f.controller.state.speaking).toBe(false); expect(f.speaking).toHaveBeenLastCalledWith(false);
  finished.resolve(); await speech;
});
it('ends capture/output while submitted durable work continues, and cancel remains explicit', async () => {
  const work = deferred<void>(), submit = vi.fn(async () => work.promise), f = fixture({}, submit);
  await f.controller.start(); f.utterance(); await settle();
  expect(submit).toHaveBeenCalledWith('다음 작업도 해 주세요'); expect(f.controller.state.pendingTurns).toBe(1);
  f.controller.end(); expect(f.capture.stop).toHaveBeenCalled(); expect(f.output.close).toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled();
  work.resolve(); await settle(); expect(f.controller.state.active).toBe(false);
  await f.controller.cancelWork(); expect(f.cancel).toHaveBeenCalledTimes(1);
});
it('drops a late transcription after end or onset of another utterance', async () => {
  const pending = deferred<{ text: string }>(); let signal: AbortSignal | undefined;
  const f = fixture({ transcribe: async (_wav, s) => { signal = s; return pending.promise; } });
  await f.controller.start(); f.utterance(); await settle(); f.push(0.1, 5); await settle();
  expect(signal?.aborted).toBe(true); pending.resolve({ text: '오래된 발화' }); await settle(); expect(f.submit).not.toHaveBeenCalled();
  f.controller.end(); expect(f.controller.state.active).toBe(false);
});
it('mute drops an incomplete utterance and duplicate completed replies are not replayed', async () => {
  const f = fixture(); await f.controller.start(); f.push(0.1, 10); f.controller.mute(true); f.utterance(); await settle();
  expect(f.transport.transcribe).not.toHaveBeenCalled(); expect(f.capture.mute).toHaveBeenCalledWith(true);
  f.controller.mute(false); const reply = { id: 'r1', taskId: 't1', text: '결과' };
  await f.controller.speak(reply); await f.controller.speak(reply); expect(f.output.play).toHaveBeenCalledTimes(1);
});
it('does not let a cancelled start completion stop a newly started capture', async () => {
  const old = deferred<void>(); const f = fixture();
  const start = vi.fn().mockImplementationOnce(async () => old.promise).mockImplementationOnce(async () => {});
  f.capture.start = start;
  const original = f.controller.start(); await settle(); f.controller.end(); await f.controller.start();
  const calls = vi.mocked(f.capture.stop).mock.calls.length; old.resolve(); await original;
  expect(f.capture.stop).toHaveBeenCalledTimes(calls); expect(f.controller.state.active).toBe(true);
});
it('stays connecting and prevents a second microphone request while permission is pending', async () => {
  const permission = deferred<void>(), f = fixture();
  f.capture.start = vi.fn(async () => permission.promise);
  const started = f.controller.start(); await settle();
  expect(f.controller.state.phase).toBe('connecting'); expect(f.controller.state.active).toBe(false);
  await f.controller.start(); expect(f.capture.start).toHaveBeenCalledTimes(1);
  permission.resolve(); await started; expect(f.controller.state.phase).toBe('listening');
});
it('shows work while local TTS is preparing, then returns to listening without a false speaking animation',async()=>{
 const audio=deferred<Blob>(),f=fixture({synthesize:async()=>audio.promise});await f.controller.start();const response=f.controller.speak({id:'preparing',taskId:'task',text:'응답'});expect(f.controller.state.preparingSpeech).toBe(true);expect(f.controller.state.phase).toBe('working');expect(f.controller.state.speaking).toBe(false);audio.resolve(new Blob([],{type:'audio/wav'}));await response;expect(f.controller.state.preparingSpeech).toBe(false);expect(f.controller.state.phase).toBe('listening');
});
it('does not open the microphone when the bundled speech classifier fails to load',async()=>{
 const capture:VoiceCapture={start:vi.fn(),stop:vi.fn(),mute:vi.fn()},output:VoiceOutput={prepare:vi.fn(async()=>{}),play:vi.fn(),stop:vi.fn(),close:vi.fn()};const transport:VoiceTransport={configure:async()=>({available:true,settings_version:1}),transcribe:vi.fn(),synthesize:vi.fn()};const controller=new VoiceController(transport,capture,output,{submitTranscript:vi.fn(),cancelWork:vi.fn(),onState:vi.fn()},async()=>{throw new Error('판정 모델 없음');});await controller.start();expect(capture.start).not.toHaveBeenCalled();expect(controller.state.error).toBe('판정 모델 없음');expect(controller.state.active).toBe(false);
});
