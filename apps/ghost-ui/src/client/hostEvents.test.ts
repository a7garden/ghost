import { describe, expect, it, vi } from 'vitest';
import { HttpStatusError } from './errors';
import { subscribeHostEvents } from './hostEvents';

type Page = { events: { revision: number }[]; latest: number };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
};

describe('subscribeHostEvents', () => {
  it('advances the cursor from the latest commit and keeps long-polling', async () => {
    const calls: Array<[string, number]> = [];
    let signal: AbortSignal | undefined;
    const first = deferred<Page>(), second = deferred<Page>();
    const fetchEvents = vi.fn((profileId: string, after: number, abort: AbortSignal) => {
      calls.push([profileId, after]);
      signal = abort;
      return calls.length === 1 ? first.promise : second.promise;
    });
    const onEvent = vi.fn();
    const stop = subscribeHostEvents(fetchEvents, ['p1'], onEvent);
    await vi.waitFor(() => expect(calls).toEqual([['p1', 0]]));
    first.resolve({ events: [{ revision: 3 }, { revision: 7 }], latest: 7 });
    await vi.waitFor(() => { expect(onEvent).toHaveBeenCalledTimes(1); expect(calls[1]).toEqual(['p1', 7]); });
    second.resolve({ events: [], latest: 7 });
    await vi.waitFor(() => expect(calls.length).toBe(3));
    expect(calls[2]).toEqual(['p1', 7]);
    stop();
    expect(signal?.aborted).toBe(true);
  });

  it('keeps retrying transient faults with capped escalating backoff', async () => {
    vi.useFakeTimers();
    try {
      const fetchEvents = vi.fn((_profileId: string, _after: number, _signal: AbortSignal) => Promise.reject(new Error('bridge restarting')));
      const onEvent = vi.fn();
      const stop = subscribeHostEvents(fetchEvents, ['p1'], onEvent, 1000);
      // Delays: 1000, 2000, 4000 — the fourth call lands at t=7000 and the
      // loop is still alive (never gives up on transient faults).
      await vi.advanceTimersByTimeAsync(3500);
      expect(fetchEvents).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(3500);
      expect(fetchEvents).toHaveBeenCalledTimes(4);
      expect(onEvent).not.toHaveBeenCalled();
      stop();
    } finally { vi.useRealTimers(); }
  });

  it('stops a profile loop permanently on a 4xx status', async () => {
    vi.useFakeTimers();
    try {
      const fetchEvents = vi.fn((_profileId: string, _after: number, _signal: AbortSignal) => Promise.reject(new HttpStatusError(404, 'profile missing')));
      const onEvent = vi.fn();
      const stop = subscribeHostEvents(fetchEvents, ['gone'], onEvent, 1000);
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchEvents).toHaveBeenCalledTimes(1);
      expect(onEvent).not.toHaveBeenCalled();
      stop();
    } finally { vi.useRealTimers(); }
  });

  it('survives an empty first page without advancing the cursor', async () => {
    const calls: Array<[string, number]> = [];
    let signal: AbortSignal | undefined;
    const first = deferred<Page>(), second = deferred<Page>();
    const fetchEvents = vi.fn((profileId: string, after: number, abort: AbortSignal) => {
      calls.push([profileId, after]);
      signal = abort;
      return calls.length === 1 ? first.promise : second.promise;
    });
    const stop = subscribeHostEvents(fetchEvents, ['fresh'], () => {}, 1);
    await vi.waitFor(() => expect(calls).toEqual([['fresh', 0]]));
    first.resolve({ events: [], latest: 0 });
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]).toEqual(['fresh', 0]);
    stop();
    expect(signal?.aborted).toBe(true);
  });
});
