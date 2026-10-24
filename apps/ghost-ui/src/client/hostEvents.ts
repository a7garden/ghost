// Host events mark freshness only: each long-poll resolves when the profile's
// durable session commits or the host wait cap elapses. The stream carries no
// rendered state; callers re-fetch the authoritative snapshot after a signal.
import { HttpStatusError } from './errors';
export interface HostEventPage { events: { revision: number }[]; latest: number }
export type HostEventsFetch = (profileId: string, after: number, signal: AbortSignal) => Promise<HostEventPage>;

export function subscribeHostEvents(
  fetchEvents: HostEventsFetch,
  profileIds: readonly string[],
  onEvent: () => void,
  errorBackoffMs = 2000,
): () => void {
  const controller = new AbortController();
  const active = new Set(profileIds);
  // Project tsconfig lib predates ES2024, so Promise.withResolvers is unavailable.
  const delay = (ms: number) => new Promise<void>(resolve => {
    if (controller.signal.aborted) return resolve();
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  void Promise.all([...active].map(async profileId => {
    let cursor = 0, failures = 0;
    while (active.has(profileId) && !controller.signal.aborted) {
      try {
        const previous = cursor;
        const page = await fetchEvents(profileId, cursor, controller.signal);
        if (!active.has(profileId) || controller.signal.aborted) return;
        failures = 0;
        cursor = page.latest;
        if (page.events.length) onEvent();
        // A well-behaved host holds each empty page for its wait cap; pace
        // instant empty replies anyway so a misbehaving one cannot spin.
        else if (cursor === previous) await delay(250);
      } catch (error) {
        if (controller.signal.aborted) return;
        // A vanished profile (4xx) fails forever: stop its loop and let the
        // next profile-set change resubscribe. Transient faults — bridge
        // restarts, network blips, 5xx — keep retrying with capped escalating
        // backoff so the event stream survives them.
        if (error instanceof HttpStatusError && error.status >= 400 && error.status < 500) return;
        failures += 1;
        await delay(Math.min(errorBackoffMs * 2 ** Math.min(failures - 1, 5), 30000));
      }
    }
  }));
  return () => { active.clear(); controller.abort(); };
}
