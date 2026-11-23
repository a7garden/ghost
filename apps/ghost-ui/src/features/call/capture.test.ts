import { describe, expect, it } from 'vitest';
import { encodeWav, PcmFrames, VoiceActivity } from './capture';

const voiced = new Int16Array(320).fill(2_000);
const quiet = new Int16Array(320);

describe('voice capture', () => {
  it('writes a mono 16 kHz signed PCM16 RIFF/WAV with interleaved frame bytes', () => {
    const wav = encodeWav([Int16Array.of(32767, -32768), Int16Array.of(-2)]);
    const view = new DataView(wav);
    const ascii = (start: number, length: number) => new TextDecoder().decode(wav.slice(start, start + length));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 8)).toBe('WAVEfmt ');
    expect(ascii(36, 4)).toBe('data');
    expect(view.getUint32(4, true)).toBe(42);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect([44, 46, 48].map(offset => view.getInt16(offset, true))).toEqual([32767, -32768, -2]);
  });

  it('downsamples across render blocks at a fractional input rate', () => {
    const frames: Int16Array[] = [];
    const resampler = new PcmFrames(44_100, frame => frames.push(frame));
    resampler.push(new Float32Array(512).fill(-.5));
    resampler.push(new Float32Array(370).fill(-.5));
    expect(frames).toHaveLength(1);
    expect([...frames[0]!]).toEqual(Array(320).fill(-16384));
  });

  it('discards fewer than 300 ms of voiced noise and requires a pause to cut speech', () => {
    const vad = new VoiceActivity();
    for (let index = 0; index < 14; index++) vad.push(voiced, false);
    for (let index = 0; index < 21; index++) expect(vad.push(quiet, false).finished).toBeUndefined();
    expect(vad.push(quiet, false)).toEqual({ finished: true, utterance: undefined });
    for (let index = 0; index < 16; index++) vad.push(quiet, false);
    for (let index = 0; index < 15; index++) vad.push(voiced, false);
    for (let index = 0; index < 21; index++) expect(vad.push(quiet, false).finished).toBeUndefined();
    const { utterance } = vad.push(quiet, false);
    expect(utterance?.[0]).toBe(quiet);
    expect(utterance?.filter(frame => frame === voiced)).toHaveLength(15);
  });

  it('requires stronger and sustained speech to barge in and caps capture at 30 seconds', () => {
    const vad = new VoiceActivity();
    const residualEcho = new Int16Array(320).fill(700);
    for (let index = 0; index < 40; index++) expect(vad.push(residualEcho, true).started).toBeUndefined();
    for (let index = 0; index < 14; index++) expect(vad.push(voiced, true).started).toBeUndefined();
    expect(vad.push(voiced, true).started).toBe(true);
    for (let index = 16; index < 1499; index++) expect(vad.push(voiced, false).finished).toBeUndefined();
    expect(vad.push(voiced, false).utterance).toHaveLength(1500);
    expect(vad.push(voiced, false).started).toBeUndefined();
  });
});
