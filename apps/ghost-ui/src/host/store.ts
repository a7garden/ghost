import { useSyncExternalStore } from 'react';
import type { LedgerEvent, LedgerEventData, LiveEvent, State } from '@ghost/contract';
import type { HostClient } from './client';

export type Connection = 'connecting' | 'live' | 'offline';

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

type Snapshot = { state: State | null; connection: Connection; error: string | null };
type LiveListener = (event: LiveEvent) => void;

/**
 * Live host state: one snapshot plus the event stream, reconnecting with the last
 * seq. Effects and transcripts are fetched on demand; live conversation frames go
 * to whoever watches that conversation.
 */
export class HostStore {
  private snapshot: Snapshot = { state: null, connection: 'connecting', error: null };
  private readonly listeners = new Set<() => void>();
  private readonly liveListeners = new Map<string, Set<LiveListener>>();
  private readonly effectListeners = new Set<(event: LedgerEvent) => void>();
  private abort: AbortController | null = null;
  private stopped = false;
  private runtimeRevision = 0;

  constructor(readonly client: HostClient) {}

  get = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

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

  /** Drop the snapshot and reconnect, so the next loop refetches state. */
  refresh() {
    this.snapshot = { ...this.snapshot, state: null };
    this.restart();
  }

  start() {
    this.stopped = false;
    void this.loop();
  }

  stop() {
    this.stopped = true;
    this.runtimeRevision++;
    this.abort?.abort();
  }

  /** Reconnect so the stream carries the current set of watched conversations. */
  private restart() {
    this.abort?.abort();
  }

  private async loop() {
    let delay = 500;
    while (!this.stopped) {
      try {
        if (!this.snapshot.state) this.set({ state: await this.client.state(), error: null });
        this.abort = new AbortController();
        this.set({ connection: 'live', error: null });
        delay = 500;
        await this.client.stream(this.snapshot.state!.seq, [...this.liveListeners.keys()], {
          ledger: (event) => {
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
            const id = event.type === 'message' ? event.message.conversationId : event.live.conversationId;
            for (const listener of this.liveListeners.get(id) ?? []) listener(event);
          },
          reset: () => {
            this.snapshot = { ...this.snapshot, state: null };
            this.abort?.abort();
          },
        }, this.abort.signal);
      } catch (error) {
        if (this.stopped) return;
        if (this.abort?.signal.aborted) continue;
        this.set({ connection: 'offline', error: error instanceof Error ? error.message : String(error) });
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    }
  }
}

export function useHostState(store: HostStore) {
  // The snapshot getter doubles as the server snapshot so components also render in SSR tests.
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
