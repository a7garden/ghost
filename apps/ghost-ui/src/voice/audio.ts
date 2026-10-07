export function rms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

// Integrate source samples over each output interval. Unlike taking every nth
// sample, this keeps a constant signal constant at both 44.1 and 48 kHz.
export function resampleMono(samples: Float32Array, sourceRate: number, targetRate = 16000): Float32Array {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || targetRate <= 0) throw new Error('오디오 샘플 속도를 확인할 수 없습니다.');
  if (sourceRate === targetRate) return samples.slice();
  const ratio = sourceRate / targetRate;
  const result = new Float32Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < result.length; index++) {
    const start = index * ratio, end = Math.min((index + 1) * ratio, samples.length);
    let value = 0;
    for (let source = Math.floor(start); source < Math.ceil(end); source++) {
      value += samples[source] * (Math.min(end, source + 1) - Math.max(start, source));
    }
    result[index] = value / (end - start);
  }
  return result;
}

export function encodeWav(samples: Float32Array, sampleRate = 16000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => { const clipped = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + index * 2, clipped < 0 ? clipped * 32768 : clipped * 32767, true); });
  return new Blob([buffer], { type: 'audio/wav' });
}

type Chunk = { samples: Float32Array; milliseconds: number };
export type VadOptions = { threshold: number; releaseThreshold: number; onsetMs: number; minimumMs: number; silenceMs: number; uncertainMs: number; maximumMs: number; prerollMs: number; tailMs: number };
const defaults: VadOptions = { threshold: 0.5, releaseThreshold: 0.35, onsetMs: 96, minimumMs: 256, silenceMs: 1400, uncertainMs: 2400, maximumMs: 120000, prerollMs: 224, tailMs: 192 };

// Probability comes from the bundled speech model, never microphone RMS.
// The payload cap is an explicit failure, not a timer that submits half a long
// sentence. Only a speech-end pause emits a transcript request.
export class VoiceActivityDetector {
  private history: Chunk[] = [];
  private recording: Chunk[] = [];
  private onset = 0;
  private voiced = 0;
  private quiet = 0;
  private uncertain = 0;
  private duration = 0;
  private count = 0;
  private lastSpeech = 0;
  private active = false;
  readonly options: VadOptions;
  constructor(private onStart: () => void, private onSegment: (samples: Float32Array, rate: number) => void, options: Partial<VadOptions> = {}, private onLimit: (error: Error) => void = () => {}) { this.options = { ...defaults, ...options }; }
  reset() { this.history = []; this.recording = []; this.onset = this.voiced = this.quiet = this.uncertain = this.duration = this.count = this.lastSpeech = 0; this.active = false; }
  get isSpeaking() { return this.active; }
  get pendingMilliseconds() { return this.duration; }
  push(samples: Float32Array, rate: number, probability: number) {
    const milliseconds = samples.length * 1000 / rate;
    if (!milliseconds || !Number.isFinite(milliseconds)) return;
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('로컬 음성 판정 결과를 확인할 수 없습니다.');
    const chunk = { samples: samples.slice(), milliseconds }, speech = probability >= this.options.threshold, nonSpeech = probability < this.options.releaseThreshold;
    if (!this.active) {
      this.history.push(chunk);
      while (this.history.length > 1 && this.history.reduce((sum, item) => sum + item.milliseconds, 0) - this.history[0].milliseconds >= this.options.prerollMs) this.history.shift();
      this.onset = speech ? this.onset + milliseconds : 0;
      if (this.onset < this.options.onsetMs) return;
      this.active = true; this.recording = this.history; this.history = [];
      this.duration = this.recording.reduce((sum, item) => sum + item.milliseconds, 0);
      this.count = this.recording.reduce((sum, item) => sum + item.samples.length, 0); this.lastSpeech = this.count;
      this.voiced = this.onset; this.quiet = this.uncertain = 0; this.onStart(); return;
    }
    this.recording.push(chunk); this.duration += milliseconds; this.count += samples.length;
    if (speech) { this.voiced += milliseconds; this.quiet = this.uncertain = 0; this.lastSpeech = this.count; }
    else {
      this.uncertain += milliseconds;
      if (nonSpeech || this.quiet > 0) this.quiet += milliseconds;
      if (!nonSpeech) this.lastSpeech = this.count;
    }
    if (this.duration > this.options.maximumMs) { this.reset(); this.onLimit(new Error('발화가 너무 길어 전송하지 않았습니다. 잠깐 쉬어 나눠 말씀해 주세요.')); return; }
    if (this.quiet < this.options.silenceMs && this.uncertain < this.options.uncertainMs) return;
    const recorded = this.recording, valid = this.voiced >= this.options.minimumMs, end = Math.min(this.count, this.lastSpeech + Math.ceil(this.options.tailMs * rate / 1000));
    this.reset(); if (!valid) return;
    const result = new Float32Array(end); let offset = 0;
    for (const item of recorded) { const length = Math.min(item.samples.length, end - offset); if (length <= 0) break; result.set(item.samples.subarray(0, length), offset); offset += length; }
    this.onSegment(result, rate);
  }
}
