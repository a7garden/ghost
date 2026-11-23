export const PCM_RATE = 16_000;
const FRAME_MS = 20;
const FRAME_SIZE = PCM_RATE * FRAME_MS / 1_000;
const frames = (ms: number) => ms / FRAME_MS;
const PREROLL = frames(320);
const MAX_FRAMES = frames(30_000);

/** Integrate input samples over each output sample interval, including fractional boundaries. */
export class PcmFrames {
  private frame = new Int16Array(FRAME_SIZE);
  private used = 0;
  private remaining: number;
  private sum = 0;
  private readonly span: number;

  constructor(inputRate: number, private readonly emit: (frame: Int16Array) => void) {
    // Integer weights keep 44.1 kHz block boundaries exact.
    this.span = inputRate;
    this.remaining = this.span;
  }

  push(input: Float32Array) {
    for (const sample of input) {
      let weight = PCM_RATE;
      while (weight >= this.remaining) {
        this.sum += sample * this.remaining;
        weight -= this.remaining;
        const value = Math.max(-1, Math.min(1, this.sum / this.span));
        this.frame[this.used++] = Math.round(value * (value < 0 ? 32768 : 32767));
        if (this.used === FRAME_SIZE) {
          this.emit(this.frame);
          this.frame = new Int16Array(FRAME_SIZE);
          this.used = 0;
        }
        this.sum = 0;
        this.remaining = this.span;
      }
      this.sum += sample * weight;
      this.remaining -= weight;
    }
  }

  reset() {
    this.used = 0;
    this.remaining = this.span;
    this.sum = 0;
  }
}

/** Require sustained onset, retain the leading phoneme, and stop at a pause or the hard cap. */
export class VoiceActivity {
  private pre: Int16Array[] = [];
  private chunk: Int16Array[] | null = null;
  private streak = 0;
  private voiced = 0;
  private silence = 0;

  push(frame: Int16Array, audiblePlayback: boolean): { started?: true; finished?: true; utterance?: Int16Array[] } {
    let energy = 0;
    for (const sample of frame) energy += sample * sample;
    const loud = energy >= frame.length * ((audiblePlayback ? 0.028 : 0.014) * 32768) ** 2;

    if (this.chunk === null) {
      if (this.pre.length === PREROLL) this.pre.shift();
      this.pre.push(frame);
      this.streak = loud ? this.streak + 1 : 0;
      if (this.streak < frames(audiblePlayback ? 300 : 100)) return {};
      this.chunk = this.pre;
      this.pre = [];
      this.voiced = this.streak;
      this.streak = 0;
      return { started: true };
    }

    this.chunk.push(frame);
    if (loud) this.voiced++;
    this.silence = loud ? 0 : this.silence + 1;
    if (this.silence < frames(440) && this.chunk.length < MAX_FRAMES) return {};

    const utterance = this.voiced >= frames(300) ? this.chunk : undefined;
    // At the cap, continued speech is a new utterance, without reusing samples.
    this.reset();
    return { finished: true, utterance };
  }

  reset() {
    this.pre = [];
    this.chunk = null;
    this.streak = 0;
    this.voiced = 0;
    this.silence = 0;
  }
}

export function encodeWav(chunks: readonly Int16Array[]): ArrayBuffer {
  const dataBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const wav = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(wav);
  view.setUint32(0, 0x52494646); // RIFF
  view.setUint32(4, 36 + dataBytes, true);
  view.setUint32(8, 0x57415645); // WAVE
  view.setUint32(12, 0x666d7420); // fmt
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true);
  view.setUint32(24, PCM_RATE, true);
  view.setUint32(28, PCM_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461); // data
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) {
    view.setInt16(offset, sample, true);
    offset += 2;
  }
  return wav;
}
