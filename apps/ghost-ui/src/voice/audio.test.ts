import { expect, it } from 'vitest';
import { encodeWav, resampleMono, VoiceActivityDetector } from './audio';

it('produces mono PCM16 WAV with bounded/clipped samples', async () => {
  const wav = encodeWav(new Float32Array([-2, -1, 0, 1, 2]));
  const bytes = await wav.arrayBuffer(), view = new DataView(bytes);
  expect(wav.type).toBe('audio/wav'); expect(bytes.byteLength).toBe(54);
  expect(new TextDecoder().decode(new Uint8Array(bytes, 0, 4))).toBe('RIFF');
  expect(view.getUint16(22, true)).toBe(1); expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getInt16(44, true)).toBe(-32768); expect(view.getInt16(52, true)).toBe(32767);
});
it('resamples 44.1/48 kHz to exactly one second without changing DC amplitude', () => {
  for (const rate of [44100, 48000]) {
    const samples = resampleMono(new Float32Array(rate).fill(0.25), rate);
    expect(samples.length).toBe(16000); expect(samples.every(value => Math.abs(value - 0.25) < 0.00001)).toBe(true);
  }
});
it('classifies speech probability rather than loudness and ignores persistent noise', () => {
  let starts = 0; const segments: Float32Array[] = [];
  const vad = new VoiceActivityDetector(() => starts++, samples => segments.push(samples));
  const push = (probability: number, count: number, amplitude = .2) => { for (let i = 0; i < count; i++) vad.push(new Float32Array(512).fill(amplitude), 16000, probability); };
  push(.01, 100); expect(starts).toBe(0);
  push(.99, 20, .005); expect(starts).toBe(1);
  push(.01, 60, .4); expect(segments).toHaveLength(1); expect(vad.isSpeaking).toBe(false);
});
it('keeps a one-second thinking pause and continuous ninety-second speech in one turn', () => {
  const segments: Float32Array[] = [];
  const vad = new VoiceActivityDetector(() => {}, samples => segments.push(samples));
  const push = (probability: number, count: number) => { for (let i = 0; i < count; i++) vad.push(new Float32Array(512).fill(.1), 16000, probability); };
  push(.99, 50); push(.01, 31); expect(segments).toHaveLength(0);
  push(.99, 2813); expect(segments).toHaveLength(0); expect(vad.isSpeaking).toBe(true);
  push(.01, 50); expect(segments).toHaveLength(1); expect(segments[0].length / 16000).toBeGreaterThan(90);
});
it('does not silently submit a truncated payload at the explicit capacity limit', () => {
  let limits=0; const segments: Float32Array[]=[];
  const vad = new VoiceActivityDetector(() => {}, samples => segments.push(samples), { maximumMs: 1000 }, () => limits++);
  for(let i=0;i<40;i++)vad.push(new Float32Array(512).fill(.1),16000,.99);
  expect(limits).toBe(1);expect(segments).toHaveLength(0);
  vad.reset();for(let i=0;i<50;i++)vad.push(new Float32Array(512),16000,.01);
  expect(segments).toHaveLength(0);
});
it('bounded uncertain classification cannot hold a finished turn indefinitely', () => {
  const segments:Float32Array[]=[];const vad=new VoiceActivityDetector(()=>{},samples=>segments.push(samples));
  for(let i=0;i<20;i++)vad.push(new Float32Array(512).fill(.1),16000,.99);
  for(let i=0;i<80;i++)vad.push(new Float32Array(512).fill(.1),16000,.4);
  expect(segments).toHaveLength(1);
});
