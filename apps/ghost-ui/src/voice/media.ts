import type { VoiceCapture, VoiceOutput } from './controller';

export class BrowserVoiceCapture implements VoiceCapture {
  private epoch = 0;
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private silent?: GainNode;
  async start(onSamples: (samples: Float32Array, rate: number) => void, onError: (error: Error) => void) {
    this.stop(); const epoch = this.epoch;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('이 화면에서 마이크 접근을 지원하지 않습니다. Ghost 데스크톱 앱에서 다시 열어 주세요.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (epoch !== this.epoch) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    try {
      const context = this.context = new AudioContext(); await context.resume();
      if (epoch !== this.epoch) return;
      const source = this.source = context.createMediaStreamSource(stream);
      // WebKit supports this bounded processor without loading executable blob
      // URLs or weakening the native CSP. It emits no microphone monitoring.
      const processor = this.processor = context.createScriptProcessor(2048, 1, 1);
      const silent = this.silent = context.createGain(); silent.gain.value = 0;
      processor.onaudioprocess = event => {
        event.outputBuffer.getChannelData(0).fill(0);
        if (epoch === this.epoch && stream.getAudioTracks().some(track => track.enabled)) onSamples(event.inputBuffer.getChannelData(0), context.sampleRate);
      };
      source.connect(processor); processor.connect(silent); silent.connect(context.destination);
      stream.getAudioTracks().forEach(track => { track.onended = () => { if (epoch === this.epoch) onError(new Error('마이크 연결이 종료되었습니다.')); }; });
    } catch (error) { if (epoch === this.epoch) this.stop(); throw error; }
  }
  mute(muted: boolean) { this.stream?.getAudioTracks().forEach(track => { track.enabled = !muted; }); }
  stop() {
    ++this.epoch;
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); this.stream = undefined;
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor?.disconnect(); this.source?.disconnect(); this.silent?.disconnect();
    this.processor = undefined; this.source = undefined; this.silent = undefined;
    const context = this.context; this.context = undefined; if (context && context.state !== 'closed') void context.close().catch(() => {});
  }
}

export class BrowserVoiceOutput implements VoiceOutput {
  private context?: AudioContext;
  private source?: AudioBufferSourceNode;
  private epoch = 0;
  private finish?: () => void;
  async prepare() { if (!this.context || this.context.state === 'closed') this.context = new AudioContext(); await this.context.resume(); }
  async play(audio: Blob, onStarted: () => void) {
    this.stop(); const epoch = this.epoch;
    if (audio.size > 6 * 1024 * 1024 || audio.type.split(';')[0] !== 'audio/wav') throw new Error('서버의 음성 출력 형식을 확인할 수 없습니다.');
    await this.prepare(); const context = this.context!;
    const decoded = await context.decodeAudioData(await audio.arrayBuffer());
    if (epoch !== this.epoch || context !== this.context) return;
    if (decoded.duration > 60 || !decoded.length) throw new Error('음성 출력 길이를 확인할 수 없습니다.');
    const source = this.source = context.createBufferSource(); source.buffer = decoded; source.connect(context.destination);
    await new Promise<void>((resolve, reject) => {
      this.finish = resolve;
      source.onended = () => { source.disconnect(); if (this.source === source) { this.source = undefined; this.finish = undefined; } resolve(); };
      try { source.start(); onStarted(); } catch (error) { this.finish = undefined; this.source = undefined; source.disconnect(); reject(error); }
    });
  }
  stop() {
    ++this.epoch; const source = this.source; this.source = undefined;
    if (source) { source.onended = null; try { source.stop(); } catch { /* ended already */ } source.disconnect(); }
    this.finish?.(); this.finish = undefined;
  }
  close() { this.stop(); const context = this.context; this.context = undefined; if (context && context.state !== 'closed') void context.close().catch(() => {}); }
}
