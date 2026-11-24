import type { CallLine } from './call-state';

const MAX_LINES = 12;

/** The call's own transcript: a short, ordered list that engines edit by line id and publish as a snapshot. */
export class LineBook {
  private lines: CallLine[] = [];

  constructor(private readonly publish: (lines: CallLine[]) => void) {}

  has(id: string): boolean {
    return this.lines.some(line => line.id === id);
  }

  /** Add the line, or replace the text and liveness of the one with this id. */
  upsert(id: string, speaker: CallLine['speaker'], text: string, live: boolean) {
    const index = this.lines.findIndex(line => line.id === id);
    const line = { id, speaker, text, live };
    if (index < 0) this.lines = [...this.lines, line].slice(-MAX_LINES);
    else if (this.lines[index]!.text === text && this.lines[index]!.live === live) return;
    else this.lines = this.lines.map((item, at) => at === index ? line : item);
    this.publish(this.lines);
  }

  /** Give a line its durable id and final text, keeping its place. Adds it if the old id is unknown. */
  settle(from: string, to: string, speaker: CallLine['speaker'], text: string) {
    const index = this.lines.findIndex(line => line.id === from);
    if (index < 0) { this.upsert(to, speaker, text, false); return; }
    this.lines = this.lines.map((item, at) => at === index ? { id: to, speaker, text, live: false } : item);
    this.publish(this.lines);
  }

  /** Replace everything, for engines that derive the whole transcript from a stream. */
  replace(lines: CallLine[]) {
    this.lines = lines.slice(-MAX_LINES);
    this.publish(this.lines);
  }
}
