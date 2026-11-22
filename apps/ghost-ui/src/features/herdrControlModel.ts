import { HerdrControlError, HostError } from '../host/client';

export type TerminalSize = { cols: number; rows: number };
export type TerminalConsent = 'control' | 'watch' | null;
export type TerminalProblem = 'confirm' | 'held' | 'gone' | 'retry';

/** A pane the app owns drives itself; a borrowed pane only ever drives after an explicit 직접 조작. */
export function shouldControlTerminal(owned: boolean, consent: TerminalConsent): boolean {
  return consent !== 'watch' && (owned || consent === 'control');
}

export function terminalProblem(error: unknown): TerminalProblem {
  if (error instanceof HerdrControlError) return error.code === 'held' ? 'held' : 'confirm';
  if (error instanceof HostError && error.code === 'not_found') return 'gone';
  return 'retry';
}

export function sameTerminalSize(a: TerminalSize | undefined, b: TerminalSize | undefined): boolean {
  return a?.cols === b?.cols && a?.rows === b?.rows;
}

/** Preserve fractional drag/wheel distances between paints, not between leases. */
export class TerminalScrollLines {
  private lines = 0;

  add(pixels: number, cellHeight: number) {
    if (cellHeight > 0) this.lines += pixels / cellHeight;
  }

  take(): number {
    const lines = Math.max(-500, Math.min(500, Math.trunc(this.lines)));
    this.lines -= lines;
    return lines;
  }

  get ready(): boolean { return Math.abs(this.lines) >= 1; }
  clear() { this.lines = 0; }
}

/** Trailing resize, with one request in flight. A retry always uses the newest geometry. */
export class TerminalResize {
  private desired: TerminalSize | undefined;
  private accepted: TerminalSize | undefined;
  private active = false;
  private paused = false;
  private sending = false;
  private generation = 0;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly send: (size: TerminalSize) => Promise<void>, private readonly onError: (reason: unknown) => void) {}

  start(size: TerminalSize) {
    this.active = true;
    this.accepted = size;
    this.attempts = 0;
    this.schedule();
  }

  stop() {
    this.active = false;
    this.generation++;
    this.sending = false;
    clearTimeout(this.timer);
  }

  request(size: TerminalSize) {
    if (sameTerminalSize(this.desired, size)) return;
    this.desired = size;
    this.attempts = 0;
    this.schedule();
  }

  pause(paused: boolean) {
    this.paused = paused;
    this.schedule();
  }

  private schedule(delay = 250) {
    clearTimeout(this.timer);
    if (!this.active || this.paused || this.sending || this.attempts >= 4 || sameTerminalSize(this.accepted, this.desired) || !this.desired) return;
    this.timer = setTimeout(() => void this.flush(), delay);
  }

  private async flush() {
    const desired = this.desired!;
    const generation = this.generation;
    this.sending = true;
    let failed = false;
    try {
      await this.send(desired);
      if (generation !== this.generation) return;
      this.accepted = desired;
      this.attempts = 0;
    } catch (reason) {
      if (generation !== this.generation) return;
      if (sameTerminalSize(this.desired, desired)) {
        failed = true;
        if (++this.attempts === 4) this.onError(reason);
      }
    } finally {
      if (generation === this.generation) {
        this.sending = false;
        this.schedule(failed ? 250 * 2 ** this.attempts : 250);
      }
    }
  }
}

const controls: Record<string, string> = { esc: '\x1b', tab: '\t', enter: '\r', 'ctrl+c': '\x03' };
const arrows: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

export function controlRailKey(key: string, applicationCursorKeys: boolean): string | undefined {
  return controls[key] ?? (arrows[key] ? `\x1b${applicationCursorKeys ? 'O' : '['}${arrows[key]}` : undefined);
}

export function controlComposerText(text: string, bracketedPaste: boolean): string {
  const normalized = text.replace(/\r\n|\n/g, '\r');
  return bracketedPaste ? `\x1b[200~${normalized}\x1b[201~\r` : `${normalized}\r`;
}

/** One lease lifecycle for the terminal: who may drive it, what still needs the owner's yes, and what to tell them. */
export type TerminalLease = {
  /** The explicit 직접 조작 ask for a pane the app does not own; it never outlives the live view. */
  control: boolean;
  /** Read-only fallback after a problem, or while a takeover question is pending. */
  watch: boolean;
  leased: boolean;
  takeover: boolean;
  confirmation: 'held' | null;
  note: string;
};

export type TerminalLeaseAction =
  | { type: 'control' }
  | { type: 'watch'; note?: string }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'ready' }
  | { type: 'leave' }
  | { type: 'problem'; reason: 'confirm' | 'held' | 'taken' | 'released' };

export const takenNote = '다른 곳에서 이 패널을 가져갔어요.';

export function initialTerminalLease(): TerminalLease {
  return { control: false, watch: false, leased: false, takeover: false, confirmation: null, note: '' };
}

export function terminalLeaseConsent(lease: TerminalLease): TerminalConsent {
  return lease.watch ? 'watch' : lease.control ? 'control' : null;
}

export function terminalLeaseReducer(state: TerminalLease, action: TerminalLeaseAction): TerminalLease {
  switch (action.type) {
    case 'control':
      // The single intentional entry into direct control; the press itself is the consent to fit.
      return { ...state, control: true, watch: false, note: '' };
    case 'watch':
      return { ...state, control: false, watch: true, leased: false, takeover: false, confirmation: null, note: action.note ?? '' };
    case 'confirm':
      // Only the held question reaches here: the approved retry is itself an explicit ask to take direct control.
      return { ...state, control: true, watch: false, takeover: state.confirmation === 'held', confirmation: null, note: '' };
    case 'cancel':
      return { ...state, confirmation: null };
    case 'ready':
      return { ...state, leased: true };
    case 'leave':
      // Leaving the live view drops everything: a borrowed pane is resized only on a fresh explicit ask.
      return initialTerminalLease();
    case 'problem': {
      const watching = terminalLeaseReducer(state, { type: 'watch', note: action.reason === 'taken' ? takenNote : '' });
      // Someone else holds the pane: ask once, explicitly, before any takeover. Everything else just watches.
      return action.reason === 'held' ? { ...watching, confirmation: 'held' } : watching;
    }
  }
}
