import { parse, TerminalServerFrame, type TerminalClientFrame, type TerminalSize } from '@ghost/contract';

export class TerminalWire {
  offset: number | undefined;
  private frameState: 'connecting' | 'replay' | 'live' | 'exited' = 'connecting';

  constructor(private readonly sink: {
    ready(size: TerminalSize, reset: boolean): void;
    bytes(bytes: Uint8Array): void;
    live(): void;
    exit(code: number | null): void;
  }) {}

  reconnect(): void { this.frameState = 'connecting'; }

  receive(data: unknown): boolean {
    if (data instanceof ArrayBuffer) {
      if (this.offset === undefined || (this.frameState !== 'replay' && this.frameState !== 'live')) return false;
      this.sink.bytes(new Uint8Array(data));
      this.offset += data.byteLength;
      return true;
    }
    if (typeof data !== 'string') return false;
    let frame: TerminalServerFrame;
    try { frame = parse(TerminalServerFrame, JSON.parse(data)); }
    catch { return false; }
    switch (frame.type) {
      case 'ready':
        if (this.frameState !== 'connecting' || (!frame.reset && this.offset !== frame.offset)) return false;
        this.offset = frame.offset;
        this.frameState = 'replay';
        this.sink.ready({ cols: frame.cols, rows: frame.rows }, frame.reset);
        return true;
      case 'replay-end':
        if (this.frameState !== 'replay') return false;
        this.frameState = 'live';
        this.sink.live();
        return true;
      case 'exit':
        if (this.frameState !== 'live') return false;
        this.frameState = 'exited';
        this.sink.exit(frame.code);
        return true;
    }
  }
}

/** A large paste stays in order and UTF-16 pairs cannot straddle WebSocket frames. */
export function* terminalInput(data: string, binary = false): Iterable<TerminalClientFrame> {
  for (let start = 0; start < data.length;) {
    let end = Math.min(start + 65_536, data.length);
    const next = data.charCodeAt(end);
    if (!binary && next >= 0xdc00 && next <= 0xdfff) end--;
    yield { type: 'input', data: data.slice(start, end), ...(binary ? { binary: true } : {}) };
    start = end;
  }
}
