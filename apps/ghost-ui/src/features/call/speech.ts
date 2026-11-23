const MAX_SPEECH_CHARS = 500;

/** Consume whole sentences. An unfinished streaming tail waits; a long sentence uses the endpoint's limit. */
export function speechSentences(text: string, offset = 0, final = true): { sentences: string[]; offset: number } {
  const sentences: string[] = [];
  const boundaries = /[!?。！？]+[”’"'」』)]*|\.+[”’"'」』)]*(?=\s|$)|\n+/gu;
  boundaries.lastIndex = offset;
  while (offset < text.length) {
    const match = boundaries.exec(text);
    let end = match ? boundaries.lastIndex : text.length;
    const complete = Boolean(match && (end < text.length || match[0].startsWith('\n')));
    if (end - offset > MAX_SPEECH_CHARS) {
      end = offset + MAX_SPEECH_CHARS;
      // Prefer a word boundary, but never split a UTF-16 surrogate pair.
      const word = text.lastIndexOf(' ', end);
      if (word > offset) end = word + Number(word < end);
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      boundaries.lastIndex = end;
    } else if (!complete && !final) {
      break;
    }
    const sentence = text.slice(offset, end).trim();
    if (sentence) sentences.push(sentence);
    offset = end;
  }
  return { sentences, offset };
}

type QueuePort<T> = {
  load(text: string, signal: AbortSignal): Promise<T>;
  play(audio: T, finished: () => void): () => void;
  failed(reason: unknown): void;
};

/** One synthesis at a time, one scheduled buffer ahead. Interrupting invalidates even a late decoder result. */
export class SpeechQueue<T> {
  private pending: string[] = [];
  private scheduled = new Set<() => void>();
  private loading: AbortController | null = null;

  constructor(private readonly port: QueuePort<T>) {}

  get busy() { return this.pending.length > 0 || this.loading !== null || this.playing; }
  get playing() { return this.scheduled.size > 0; }

  enqueue(sentences: string[]) {
    this.pending.push(...sentences);
    this.pump();
  }

  interrupt() {
    this.loading?.abort();
    this.loading = null;
    this.pending.length = 0;
    for (const stop of this.scheduled) stop();
    this.scheduled.clear();
  }

  private pump() {
    if (this.loading !== null || this.scheduled.size >= 2) return;
    const text = this.pending.shift();
    if (!text) return;
    const loading = this.loading = new AbortController();
    void this.port.load(text, loading.signal).then(audio => {
      if (loading.signal.aborted) return;
      const stop = this.port.play(audio, () => {
        this.scheduled.delete(stop);
        this.pump();
      });
      this.scheduled.add(stop);
      this.loading = null;
      this.pump();
    }).catch(reason => {
      if (loading.signal.aborted) return;
      this.interrupt();
      this.port.failed(reason);
    });
  }
}
