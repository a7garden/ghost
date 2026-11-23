export const TERMINAL_HISTORY_BYTES = 1024 * 1024;

/** A fixed byte ring with absolute positions. Views are consumed synchronously before the next write. */
export class TerminalReplay {
  private storage: Uint8Array | undefined;
  private end = 0;

  append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const ring = this.storage ??= new Uint8Array(TERMINAL_HISTORY_BYTES);
    const retained = bytes.subarray(Math.max(0, bytes.length - ring.length));
    this.end += bytes.length;
    const offset = (this.end - retained.length) % ring.length;
    const first = Math.min(retained.length, ring.length - offset);
    ring.set(retained.subarray(0, first), offset);
    if (first < retained.length) ring.set(retained.subarray(first));
  }

  replay(after: number | undefined): { offset: number; reset: boolean; chunks: Uint8Array[] } {
    const first = Math.max(0, this.end - TERMINAL_HISTORY_BYTES);
    const reset = after === undefined || after < first || after > this.end;
    const offset = reset ? first : after;
    const ring = this.storage;
    if (!ring || offset === this.end) return { offset, reset, chunks: [] };
    const start = offset % ring.length;
    const length = this.end - offset;
    const head = ring.subarray(start, start + length);
    return { offset, reset, chunks: head.length === length ? [head] : [head, ring.subarray(0, length - head.length)] };
  }
}
