import { resampleMono } from './audio';
export const SPEECH_RATE = 16000;
export const SPEECH_FRAME = 512;
export interface SpeechClassifier {
  classify(frame: Float32Array): Promise<number>;
  reset(): void;
  close(): Promise<void>;
}
export type SpeechClassifierFactory = (signal: AbortSignal) => Promise<SpeechClassifier>;

// Only a bounded, in-memory queue. A slow classifier fails visibly; it never
// switches back to treating loud environmental noise as speech.
export class SpeechProbabilityStream {
  private queued: Float32Array[] = [];
  private carry = new Float32Array(0);
  private samples = 0;
  private draining = false;
  private generation = 0;
  private closed = false;
  constructor(private classifier: SpeechClassifier, private onFrame: (frame: Float32Array, probability: number) => void, private onError: (error: Error) => void) {}
  push(input: Float32Array, rate: number) {
    if (this.closed) return;
    const samples = resampleMono(input, rate);
    if (samples.length + this.samples + this.carry.length > SPEECH_RATE * 2) {
      this.reset(); this.onError(new Error('음성 판정이 입력을 따라가지 못했습니다. 통화를 다시 시작해 주세요.')); return;
    }
    const joined = new Float32Array(this.carry.length + samples.length); joined.set(this.carry); joined.set(samples, this.carry.length);
    let at = 0;
    for (; at + SPEECH_FRAME <= joined.length; at += SPEECH_FRAME) { this.queued.push(joined.slice(at, at + SPEECH_FRAME)); this.samples += SPEECH_FRAME; }
    this.carry = joined.slice(at); void this.drain();
  }
  private async drain() {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      while (!this.closed && this.queued.length) {
        const frame = this.queued.shift()!, generation = this.generation; this.samples -= frame.length;
        const probability = await this.classifier.classify(frame);
        if (generation === this.generation && !this.closed) {
          if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('음성 판정 결과를 확인할 수 없습니다.');
          this.onFrame(frame, probability);
        }
      }
    } catch (error) {
      this.reset(); if (!this.closed) this.onError(error instanceof Error ? error : new Error('로컬 음성 판정을 시작하지 못했습니다.'));
    } finally { this.draining = false; }
  }
  reset() { ++this.generation; this.queued = []; this.samples = 0; this.carry = new Float32Array(0); this.classifier.reset(); }
  close() { if (this.closed) return; this.closed = true; this.reset(); void this.classifier.close().catch(() => {}); }
}
