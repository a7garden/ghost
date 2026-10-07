import { afterEach, expect, it, vi } from 'vitest';
import { BrowserVoiceCapture, BrowserVoiceOutput } from './media';
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
afterEach(() => vi.unstubAllGlobals());
it('releases a late microphone grant after the call was closed', async () => {
  const permission = deferred<MediaStream>(), stop = vi.fn();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => permission.promise) } });
  const capture = new BrowserVoiceCapture(); const started = capture.start(() => {}, () => {});
  capture.stop(); permission.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream); await started;
  expect(stop).toHaveBeenCalledTimes(1);
});
it('mutes tracks, removes callbacks, and closes graph/context when capture ends', async () => {
  const track = { enabled: true, stop: vi.fn(), onended: null as (() => void) | null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }, source = { connect: vi.fn(), disconnect: vi.fn() }, gain = { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }, close = vi.fn(async () => {});
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  vi.stubGlobal('AudioContext', class { state = 'running'; sampleRate = 48000; destination = {}; resume = async () => {}; close = close; createMediaStreamSource = () => source; createScriptProcessor = () => processor; createGain = () => gain; });
  const capture = new BrowserVoiceCapture(); await capture.start(() => {}, () => {});
  expect(gain.gain.value).toBe(0); capture.mute(true); expect(track.enabled).toBe(false);
  capture.stop(); expect(track.stop).toHaveBeenCalledTimes(1); expect(track.onended).toBeNull(); expect(processor.onaudioprocess).toBeNull(); expect(close).toHaveBeenCalledTimes(1);
});
it('does not start an audio source when decoding completes after barge-in', async () => {
  const decoded = deferred<{ duration: number; length: number }>(), source = vi.fn();
  vi.stubGlobal('AudioContext', class { state = 'running'; destination = {}; resume = async () => {}; close = async () => {}; decodeAudioData = async () => decoded.promise; createBufferSource = source; });
  const output = new BrowserVoiceOutput(); await output.prepare();
  const playback = output.play(new Blob(['fixture'], { type: 'audio/wav' }), vi.fn());
  for (let index = 0; index < 4; index++) await Promise.resolve();
  output.stop(); decoded.resolve({ duration: 1, length: 16000 }); await playback;
  expect(source).not.toHaveBeenCalled(); output.close();
});
