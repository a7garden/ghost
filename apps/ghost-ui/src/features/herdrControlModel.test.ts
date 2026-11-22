import { afterEach, describe, expect, it, vi } from 'vitest';
import { HerdrControlError, HostError } from '../host/client';
import { controlComposerText, controlRailKey, initialTerminalLease, shouldControlTerminal, takenNote, terminalLeaseConsent, terminalLeaseReducer, TerminalResize, TerminalScrollLines, terminalProblem, type TerminalLeaseAction, type TerminalSize } from './herdrControlModel';

it('controls owned panes by default, respecting explicit Watch or a fit consent', () => {
  expect(shouldControlTerminal(true, null)).toBe(true);
  expect(shouldControlTerminal(false, null)).toBe(false);
  expect(shouldControlTerminal(false, 'fit')).toBe(true);
  expect(shouldControlTerminal(true, 'watch')).toBe(false);
});

it('maps Host control refusals to their distinct UI outcomes', () => {
  expect(terminalProblem(new HerdrControlError('confirm_required', 'fit'))).toBe('fit');
  expect(terminalProblem(new HerdrControlError('held', 'held'))).toBe('held');
  expect(terminalProblem(new HostError('not_found', 'closed'))).toBe('gone');
  expect(terminalProblem(new HostError('unavailable', 'reconnect'))).toBe('retry');
  expect(terminalProblem(new TypeError('offline'))).toBe('retry');
});

it('coalesces signed fractional cell scroll and splits large wheel bursts', () => {
  const scroll = new TerminalScrollLines();
  scroll.add(-7, 20);
  scroll.add(-30, 20);
  scroll.add(5, 20);
  expect(scroll.take()).toBe(-1);
  expect(scroll.ready).toBe(false);
  scroll.add(-10, 20);
  expect(scroll.take()).toBe(-1);
  scroll.add(13_000, 20);
  expect(scroll.take()).toBe(500);
  expect(scroll.ready).toBe(true);
  scroll.clear();
  expect(scroll.ready).toBe(false);
});

it('uses terminal cursor mode and bracketed paste for rail and composer bytes', () => {
  expect(controlRailKey('up', true)).toBe('\x1bOA');
  expect(controlRailKey('up', false)).toBe('\x1b[A');
  expect(controlRailKey('ctrl+c', true)).toBe('\x03');
  expect(controlComposerText('line 1\r\nline 2', true)).toBe('\x1b[200~line 1\rline 2\x1b[201~\r');
});

describe('controlled terminal resizing', () => {
  afterEach(() => vi.useRealTimers());
  const initial = { cols: 44, rows: 29 }, keyboard = { cols: 44, rows: 14 }, rotated = { cols: 72, rows: 19 };

  it('waits for the gesture and debounces to the latest fit', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => {});
    const resize = new TerminalResize(send, vi.fn());
    resize.start(initial);
    resize.pause(true);
    resize.request(keyboard);
    await vi.advanceTimersByTimeAsync(400);
    resize.request(rotated);
    resize.pause(false);
    await vi.advanceTimersByTimeAsync(249);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(rotated);
    resize.stop();
  });

  it('never retries stale geometry or sends more than four attempts', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<void>();
    const send = vi.fn<(size: TerminalSize) => Promise<void>>(async () => { throw new Error('lost'); }).mockImplementationOnce(() => pending.promise);
    const failure = vi.fn();
    const resize = new TerminalResize(send, failure);
    resize.start(initial);
    resize.request(keyboard);
    await vi.advanceTimersByTimeAsync(250);
    resize.request(rotated);
    pending.reject(new Error('stale'));
    await vi.advanceTimersByTimeAsync(8000);
    expect(send.mock.calls).toEqual([[keyboard], [rotated], [rotated], [rotated], [rotated]]);
    expect(failure).toHaveBeenCalledTimes(1);
    resize.stop();
  });
});

describe('terminal lease', () => {
  const fresh = () => initialTerminalLease(false);
  const run = (...actions: TerminalLeaseAction[]) => actions.reduce(terminalLeaseReducer, fresh());

  it('asks before fitting a pane the owner does not control, and remembers the yes', () => {
    const asked = run({ type: 'fit', owned: false });
    expect(asked.confirmation).toBe('fit');
    const fitted = terminalLeaseReducer(asked, { type: 'confirm' });
    expect(terminalLeaseConsent(fitted)).toBe('fit');
    expect(terminalLeaseConsent(terminalLeaseReducer(fitted, { type: 'watch' }))).toBe('watch');
    // A remembered yes returns to the lease without asking again.
    expect(terminalLeaseConsent(terminalLeaseReducer(terminalLeaseReducer(fitted, { type: 'watch' }), { type: 'fit', owned: false }))).toBe('fit');
  });

  it('falls back to watching with a note when another client takes the pane, and asks again when held', () => {
    expect(run({ type: 'ready' }, { type: 'problem', reason: 'taken' })).toMatchObject({ watch: true, leased: false, note: takenNote });
    const held = run({ type: 'problem', reason: 'held' });
    expect(held).toMatchObject({ watch: true, confirmation: 'held' });
    expect(terminalLeaseReducer(held, { type: 'confirm' })).toMatchObject({ watch: false, takeover: true, confirmation: null });
  });

  it('drops the lease, takeover and any question when leaving the live view', () => {
    expect(run({ type: 'problem', reason: 'held' }, { type: 'confirm' }, { type: 'ready' }, { type: 'leave' }))
      .toMatchObject({ leased: false, takeover: false, confirmation: null });
  });
});
