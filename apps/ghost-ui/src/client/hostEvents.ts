// Host events mark freshness only: each long-poll resolves when the profile's
// durable session commits or the host wait cap elapses. The stream carries no
// rendered state; callers re-fetch the authoritative snapshot after a signal.
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
    const timer = setTimeout(resolve, ms);
    controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
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
      } catch {
        if (controller.signal.aborted) return;
        // A profile that vanished (recovery, deletion) would 4xx forever; stop
        // its loop and let the next profile-set change resubscribe.
        failures += 1;
        if (failures >= 3) return;
        await delay(errorBackoffMs);
      }
    }
  }));
  return () => { active.clear(); controller.abort(); };
}
