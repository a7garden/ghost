import { useSyncExternalStore } from 'react';
import type { LedgerEvent, LedgerEventData, LiveEvent, State } from '@ghost/contract';
import type { HostClient } from './client';
import { SnapshotCache } from './snapshotCache';

export type Connection = 'connecting' | 'live' | 'offline';

/** A dropped stream stays unannounced this long: a resume or a blip reconnects inside it. */
export const SILENT_MS = 4_000;
/** After this long the drop is confirmed: backoff has reached its cap and failed once more. */
export const CONFIRM_MS = 20_000;
/** A reopened stream that has not failed for this long counts as live (it sends no open frame). */
const PROOF_MS = 1_000;
const SAVE_DELAY_MS = 2_000;

type Keyed = { id: string };

function upsert<T extends Keyed>(items: T[], item: T): T[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index < 0) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

const remove = <T extends Keyed>(items: T[], id: string) => items.filter((item) => item.id !== id);

/** Apply one ledger change to a snapshot. Pure; exported for tests. */
export function applyEvent(state: State, data: LedgerEventData): State {
  switch (data.type) {
    case 'ghost':
      return { ...state, ghosts: upsert(state.ghosts, data.ghost) };
    case 'conversation':
      return { ...state, conversations: upsert(state.conversations, data.conversation) };
    case 'conversation.removed':
      return { ...state, conversations: remove(state.conversations, data.id) };
    case 'work':
      return { ...state, works: upsert(state.works, data.work) };
    case 'goal':
      return { ...state, goals: upsert(state.goals ?? [], data.goal) };
    case 'milestone':
      return { ...state, milestones: upsert(state.milestones ?? [], data.milestone) };
    case 'decision':
      return { ...state, decisions: upsert(state.decisions, data.decision) };
    case 'effect':
      return state;
    case 'notification':
      return { ...state, notifications: upsert(state.notifications, data.notification) };
    case 'schedule':
      return { ...state, schedules: upsert(state.schedules, data.schedule) };
    case 'schedule.removed':
      return { ...state, schedules: remove(state.schedules, data.id) };
    case 'space':
      return { ...state, spaces: upsert(state.spaces, data.space) };
    case 'space.removed':
      return { ...state, spaces: remove(state.spaces, data.id) };
    case 'avatar':
      return { ...state, avatars: upsert(state.avatars, data.avatar) };
    case 'avatar.removed':
      return { ...state, avatars: remove(state.avatars, data.id) };
    case 'device':
      return { ...state, devices: upsert(state.devices, data.device) };
    case 'device.removed':
      return { ...state, devices: remove(state.devices, data.id) };
    case 'activity':
      return { ...state, activities: upsert(state.activities ?? [], data.activity) };
    case 'activity_run':
      return { ...state, activityRuns: upsert(state.activityRuns ?? [], data.run) };
    case 'connection':
      return { ...state, connections: upsert(state.connections ?? [], data.connection) };
    case 'connection.removed':
      return { ...state, connections: remove(state.connections ?? [], data.id) };
    case 'settings':
      return { ...state, settings: data.settings };
    case 'sandbox': {
      const others = state.sandboxes.filter((sandbox) => sandbox.ghostId !== data.sandbox.ghostId);
      return { ...state, sandboxes: [...others, data.sandbox] };
    }
    case 'autonomy': {
      const others = (state.autonomy ?? []).filter((plan) => plan.ghostId !== data.plan.ghostId);
      return { ...state, autonomy: [...others, data.plan] };
    }
    case 'adaptation': {
      const others = (state.adaptations ?? []).filter((item) => item.ghostId !== data.adaptation.ghostId);
      return { ...state, adaptations: [...others, data.adaptation] };
    }
    case 'duty':
      return { ...state, duty: data.duty };
  }
}

type Snapshot = {
  state: State | null;
  connection: Connection;
  error: string | null;
  /** Start of the current retry window while offline; display status derives from its age. */
  offlineSince: number | null;
};
type LiveListener = (event: LiveEvent) => void;

/**
 * Live host state: one snapshot plus the event stream, reconnecting with the last
 * seq. Effects and transcripts are fetched on demand; live conversation frames go
 * to whoever watches that conversation. The last live snapshot is cached so a cold
 * start draws it at once; it stays unproven (`stale`) until the Host answers.
 */
export class HostStore {
  private snapshot: Snapshot;
  private readonly listeners = new Set<() => void>();
  private readonly liveListeners = new Map<string, Set<LiveListener>>();
  private readonly effectListeners = new Set<(event: LedgerEvent) => void>();
  private abort: AbortController | null = null;
  private stopped = false;
  private runtimeRevision = 0;
  /** The snapshot needs a fresh read before streaming: cached, refreshed or reset. */
  private stale = true;
  private delay = 500;
  private wakeSleep: (() => void) | null = null;
  private graceTimers: ReturnType<typeof setTimeout>[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly client: HostClient, private readonly cache: SnapshotCache | null = SnapshotCache.forPage()) {
    this.snapshot = { state: cache?.read() ?? null, connection: 'connecting', error: null, offlineSince: null };
  }

  get = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: Partial<Snapshot>) {
    const previous = this.snapshot;
    this.snapshot = { ...previous, ...next };
    if (this.snapshot.offlineSince !== previous.offlineSince) this.armGrace();
    if (this.snapshot.state !== previous.state && !this.stale) this.scheduleSave();
    for (const listener of this.listeners) listener();
  }

  /** Wake listeners as the silent and confirm windows end, so the derived status moves without new events. */
  private armGrace() {
    for (const timer of this.graceTimers) clearTimeout(timer);
    this.graceTimers = [];
    const since = this.snapshot.offlineSince;
    if (since === null) return;
    for (const edge of [SILENT_MS, CONFIRM_MS]) {
      const wait = since + edge - Date.now();
      if (wait >= 0) this.graceTimers.push(setTimeout(() => { if (this.snapshot.connection === 'offline') this.set({}); }, wait + 1));
    }
  }

  private scheduleSave() {
    if (!this.cache || this.saveTimer !== null) return;
    this.saveTimer = setTimeout(this.save, SAVE_DELAY_MS);
  }

  /** Write a pending snapshot now; the page may be frozen or gone next. */
  private save = () => {
    if (this.saveTimer === null) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const state = this.snapshot.state;
    if (state && !this.stale) this.cache?.write(state);
  };

  private saveWhenHidden = () => {
    if (document.visibilityState === 'hidden') this.save();
  };

  /** Receive live frames of one conversation while subscribed. */
  watchConversation(id: string, listener: LiveListener): () => void {
    let set = this.liveListeners.get(id);
    if (!set) this.liveListeners.set(id, (set = new Set()));
    set.add(listener);
    this.restart();
    return () => {
      set.delete(listener);
      if (set.size === 0) this.liveListeners.delete(id);
      this.restart();
    };
  }

  /** Every ledger event, including effects, for detail views that keep their own data. */
  onLedgerEvent(listener: (event: LedgerEvent) => void): () => void {
    this.effectListeners.add(listener);
    return () => this.effectListeners.delete(listener);
  }

  /** Reread the snapshot and reopen the stream; the mounted data stays until the fresh one replaces it. */
  refresh() {
    this.stale = true;
    this.resume();
  }

  /** Reopen the stream from the current seq, keeping the mounted data; a dropped stream gets a new grace window. */
  resume() {
    this.delay = 500;
    if (this.snapshot.connection === 'offline') this.set({ offlineSince: Date.now() });
    this.abort?.abort();
    this.wakeSleep?.();
  }

  start() {
    this.stopped = false;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.saveWhenHidden);
      window.addEventListener('pagehide', this.save);
    }
    void this.loop();
  }

  stop() {
    this.stopped = true;
    this.runtimeRevision++;
    this.abort?.abort();
    this.wakeSleep?.();
    for (const timer of this.graceTimers) clearTimeout(timer);
    this.graceTimers = [];
    this.save();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.saveWhenHidden);
      window.removeEventListener('pagehide', this.save);
    }
  }

  /** Reconnect so the stream carries the current set of watched conversations. */
  private restart() {
    this.abort?.abort();
  }

  /** Backoff wait that `resume` cuts short. */
  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.wakeSleep = null; resolve(); };
      const timer = setTimeout(done, ms);
      this.wakeSleep = done;
    });
  }

  private async loop() {
    this.delay = 500;
    while (!this.stopped) {
      // One controller per attempt: an abort during the snapshot read still ends only this attempt.
      const attempt = new AbortController();
      this.abort = attempt;
      // The stream sends no open frame: a fresh read, an event, or an attempt alive for PROOF_MS
      // proves the Host answers. Until then a dropped connection keeps its retry window.
      let proof: ReturnType<typeof setTimeout> | undefined;
      const proven = () => {
        clearTimeout(proof);
        if (this.abort !== attempt || attempt.signal.aborted || this.snapshot.connection === 'live') return;
        this.delay = 500;
        this.set({ connection: 'live', error: null, offlineSince: null });
      };
      try {
        if (!this.snapshot.state || this.stale) {
          const state = await this.client.state();
          this.stale = false;
          this.set({ state, error: null });
          proven();
        }
        if (this.snapshot.connection !== 'live') proof = setTimeout(proven, PROOF_MS);
        await this.client.stream(this.snapshot.state!.seq, [...this.liveListeners.keys()], {
          ledger: (event) => {
            proven();
            const state = this.snapshot.state;
            if (!state || event.seq <= state.seq) return;
            this.set({ state: { ...applyEvent(state, event.data), seq: event.seq } });
            for (const listener of this.effectListeners) listener(event);
            // Refresh only the host-owned readiness projection; keep views and their unsaved inputs mounted.
            if (event.data.type === 'settings') {
              const revision = ++this.runtimeRevision;
              void this.client.state().then(fresh => {
                const current = this.snapshot.state;
                if (this.stopped || revision !== this.runtimeRevision || !current) return;
                this.set({ state: { ...current, runtime: fresh.runtime }, error: this.snapshot.connection === 'live' ? null : this.snapshot.error });
              }).catch(reason => {
                if (this.stopped || revision !== this.runtimeRevision) return;
                this.set({ error: reason instanceof Error ? reason.message : '실행 상태를 갱신하지 못했습니다.' });
              });
            }
          },
          live: (event) => {
            proven();
            const id = event.type === 'message' ? event.message.conversationId : event.live.conversationId;
            for (const listener of this.liveListeners.get(id) ?? []) listener(event);
          },
          // The Host cannot bridge the gap: reread the snapshot, keeping the screen until it lands.
          reset: () => {
            this.stale = true;
            attempt.abort();
          },
        }, attempt.signal);
        clearTimeout(proof);
      } catch (error) {
        clearTimeout(proof);
        if (this.stopped) return;
        if (attempt.signal.aborted) continue;
        this.set({ connection: 'offline', offlineSince: this.snapshot.offlineSince ?? Date.now(), error: error instanceof Error ? error.message : String(error) });
        await this.sleep(this.delay);
        this.delay = Math.min(this.delay * 2, 10_000);
      }
    }
  }
}

export function useHostState(store: HostStore) {
  // The snapshot getter doubles as the server snapshot so components also render in SSR tests.
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
