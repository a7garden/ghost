import * as ort from 'onnxruntime-web/wasm';
import type { SpeechClassifier } from './speechProbability';
import { SPEECH_FRAME, SPEECH_RATE } from './speechProbability';

// Silero v6.0's official recurrent ONNX interface: 512 new samples, 64
// context samples, state [2, 1, 128], scalar 16k sample rate. Assets are bundled
// with Ghost and fetched from its own origin. No CDN, telemetry or audio upload.
export class SileroSpeechClassifier implements SpeechClassifier {
  private state = new Float32Array(256);
  private context = new Float32Array(64);
  private generation = 0;
  private closed = false;
  private pending?: Promise<ort.InferenceSession.ReturnType>;
  constructor(private session: ort.InferenceSession) {}
  async classify(frame: Float32Array) {
    if (this.closed || frame.length !== SPEECH_FRAME) throw new Error('음성 판정 프레임을 확인해 주세요.');
    const generation = this.generation, input = new Float32Array(576); input.set(this.context); input.set(frame, 64);
    const feeds = { input: new ort.Tensor('float32', input, [1, 576]), state: new ort.Tensor('float32', this.state.slice(), [2, 1, 128]), sr: new ort.Tensor('int64', new BigInt64Array([BigInt(SPEECH_RATE)]), []) };
    let outputs: ort.InferenceSession.ReturnType | undefined;
    try {
      const pending = this.session.run(feeds); this.pending = pending; outputs = await pending;
      if (generation !== this.generation || this.closed) return 0;
      const probability = Number(outputs.output.data[0]);
      this.state = Float32Array.from(outputs.stateN.data as Float32Array); this.context = frame.slice(-64);
      return probability;
    } finally {
      this.pending = undefined;
      Object.values(feeds).forEach(tensor => tensor.dispose());
      if (outputs) Object.values(outputs).forEach(tensor => tensor.dispose());
    }
  }
  reset() { ++this.generation; this.state = new Float32Array(256); this.context = new Float32Array(64); }
  async close() { if (this.closed) return; this.closed = true; this.reset(); await this.pending?.catch(() => {}); await this.session.release(); }
}
export async function createSpeechClassifier(signal: AbortSignal): Promise<SpeechClassifier> {
  ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.logLevel = 'error';
  const base = new URL('/voice-vad/', window.location.origin);
  ort.env.wasm.wasmPaths = { wasm: new URL('ort-wasm-simd-threaded.wasm', base).href, mjs: new URL('ort-wasm-simd-threaded.mjs', base).href };
  let session: ort.InferenceSession | undefined;
  try {
    const response = await fetch(new URL('silero-vad-v6.0.onnx', base), { signal, cache: 'force-cache', credentials: 'same-origin' });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 3 * 1024 * 1024) throw new Error('model');
    const bytes = await response.arrayBuffer(); if (bytes.byteLength !== 2327524) throw new Error('model');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== '597d30b3ec076608d059477bb14cfeffdf951bf5cae370d38f65d33bbfe82004') throw new Error('model');
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    if (signal.aborted) { await session.release(); throw new DOMException('Aborted', 'AbortError'); }
    return new SileroSpeechClassifier(session);
  } catch (error) {
    if (signal.aborted) throw error;
    if (session) await session.release().catch(() => {});
    throw new Error('앱의 로컬 음성 판정 모델을 불러오지 못했습니다. 앱을 다시 열어 주세요.');
  }
}
