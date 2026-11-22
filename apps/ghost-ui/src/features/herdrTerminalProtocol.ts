import type { HerdrInput } from '@ghost/contract';

export function decodeHerdrFrame(bytes: string): Uint8Array {
  const binary = atob(bytes);
  const decoded = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i);
  return decoded;
}

type Input = Omit<HerdrInput, 'pane'>;
type Entry = { input: Input } | { run(): Promise<void>; drop(): void };
const MAX_TEXT = 65_536;

/** One writer per pane. Never replay ambiguous input; preserve raw/control-byte order around keys and prompts. */
export class HerdrInputQueue {
  private readonly pending: Entry[] = [];
  private sending = false;
  private closed = false;

  constructor(private readonly send: (input: Input) => Promise<unknown>, private readonly onError: (error: unknown) => void) {}

  text(text: string) {
    if (this.closed) return;
    for (let start = 0; start < text.length;) {
      const tail = this.pending.at(-1);
      const last = tail && 'input' in tail ? tail.input : undefined;
      const free = MAX_TEXT - (last?.text?.length ?? 0);
      let end = Math.min(start + free, text.length);
      const next = text.charCodeAt(end);
      // Do not split a UTF-16 surrogate pair at the request boundary.
      if (next >= 0xdc00 && next <= 0xdfff && end > start) end--;
      if (last?.text !== undefined && end > start) {
        last.text += text.slice(start, end);
      } else {
        end = Math.min(start + MAX_TEXT, text.length);
        const boundary = text.charCodeAt(end);
        if (boundary >= 0xdc00 && boundary <= 0xdfff) end--;
        this.pending.push({ input: { text: text.slice(start, end) } });
      }
      start = end;
    }
    void this.drain();
  }

  key(key: string) {
    if (this.closed) return;
    this.pending.push({ input: { keys: [key] } });
    void this.drain();
  }

  afterInput(action: () => Promise<boolean>): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this.pending.push({ run: async () => {
      try { resolve(await action()); }
      catch (error) { resolve(false); throw error; }
    }, drop: () => resolve(false) });
    void this.drain();
    return promise;
  }

  close() {
    this.closed = true;
    for (const entry of this.pending.splice(0)) if ('drop' in entry) entry.drop();
  }

  private async drain() {
    if (this.sending) return;
    this.sending = true;
    try {
      for (let entry = this.pending.shift(); entry; entry = this.pending.shift()) {
        try {
          if ('input' in entry) await this.send(entry.input);
          else await entry.run();
        } catch (error) {
          // A failed prefix must never leave a queued Enter or paste suffix executing on its own.
          for (const pending of this.pending.splice(0)) if ('drop' in pending) pending.drop();
          if (!this.closed) this.onError(error);
        }
      }
    } finally { this.sending = false; }
  }
}
