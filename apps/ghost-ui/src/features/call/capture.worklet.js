// The graph output is intentionally silent; the port is the only consumer of microphone samples.
class GhostCallCapture extends AudioWorkletProcessor {
  samples = new Float32Array(1024);
  used = 0;

  process(inputs) {
    const mono = inputs[0]?.[0];
    if (!mono) return true;
    for (let offset = 0; offset < mono.length;) {
      const count = Math.min(this.samples.length - this.used, mono.length - offset);
      this.samples.set(mono.subarray(offset, offset + count), this.used);
      this.used += count;
      offset += count;
      if (this.used === this.samples.length) {
        this.port.postMessage(this.samples, [this.samples.buffer]);
        this.samples = new Float32Array(1024);
        this.used = 0;
      }
    }
    return true;
  }
}

registerProcessor('ghost-call-capture', GhostCallCapture);
