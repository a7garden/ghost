import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ghost, LedgerEventData, State } from '@ghost/contract';
import { applyEvent, HostStore } from './store';
import { HostClient, type StreamHandlers } from './client';
import { SnapshotCache } from './snapshotCache';
import { hostStatus } from '../features/hostStatus';

const baseState = (): State => ({
  seq: 7,
  principal: { kind: 'owner' },
  runtime: { ready: true, detail: '', version: '0.0.0' },
  ghosts: [],
  conversations: [],
  works: [],
  decisions: [],
  notifications: [],
  schedules: [],
  spaces: [],
  avatars: [],
  settings: { defaultModel: null, reviewModel: null, providers: [] },
  devices: [],
  sandboxes: [],
});

const ghost = (id: string, patch: Partial<Ghost> = {}): Ghost => ({
  id, name: id, persona: '', look: { avatarId: null }, model: null, isDefault: false, state: 'active',
  tools: [], fallbacks: [], skills: [], deletedAt: null,
  directConversationId: `conv-${id}`, createdAt: 1, updatedAt: 1, ...patch,
});

const event = (data: LedgerEventData) => data;

describe('applyEvent', () => {
  it('inserts a new ghost and updates an existing one by id', () => {
    let state = applyEvent(baseState(), event({ type: 'ghost', ghost: ghost('sage') }));
    expect(state.ghosts.map(row => row.id)).toEqual(['sage']);
    state = applyEvent(state, event({ type: 'ghost', ghost: ghost('milo') }));
    expect(state.ghosts.map(row => row.id)).toEqual(['sage', 'milo']);
    state = applyEvent(state, event({ type: 'ghost', ghost: ghost('sage', { name: '세이지', isDefault: true }) }));
    expect(state.ghosts.map(row => row.id)).toEqual(['sage', 'milo']);
    expect(state.ghosts[0]).toMatchObject({ name: '세이지', isDefault: true });
  });

  it('removes conversations and keeps the rest', () => {
    let state = applyEvent(baseState(), event({ type: 'conversation', conversation: { id: 'c1', ghostId: 'sage', kind: 'direct', workId: null, title: '대화', model: null, busy: false, createdAt: 1, lastActivityAt: 1 } }));
    state = applyEvent(state, event({ type: 'conversation', conversation: { id: 'c2', ghostId: 'sage', kind: 'direct', workId: null, title: '이전 대화', model: null, busy: false, createdAt: 1, lastActivityAt: 1 } }));
    expect(state.conversations).toHaveLength(2);
    state = applyEvent(state, event({ type: 'conversation.removed', id: 'c1' }));
    expect(state.conversations.map(row => row.id)).toEqual(['c2']);
    state = applyEvent(state, event({ type: 'conversation.removed', id: 'missing' }));
    expect(state.conversations.map(row => row.id)).toEqual(['c2']);
  });

  it('upserts work and decision rows by id', () => {
    const work = {
      id: 'w1', parentId: null, rootId: 'w1', ghostId: 'sage', originConversationId: 'c1', conversationId: null,
      title: '조사', brief: '조사해 줘', acceptance: { criteria: '', checks: [], reviewer: null }, state: 'queued' as const,
      revision: 1, revisionsUsed: 0, deadlineAt: null, result: null, verdict: null, reason: null,
      createdAt: 1, startedAt: null, endedAt: null, updatedAt: 1,
    };
    let state = applyEvent(baseState(), event({ type: 'work', work }));
    state = applyEvent(state, event({ type: 'work', work: { ...work, state: 'running' as const, updatedAt: 2 } }));
    expect(state.works).toHaveLength(1);
    expect(state.works[0]).toMatchObject({ state: 'running', updatedAt: 2 });
    state = applyEvent(state, event({ type: 'decision', decision: { id: 'd1', kind: 'question', ghostId: 'sage', conversationId: 'c1', workId: null, effectId: null, title: '어디로 갈까요', detail: '', options: ['서울', '부산'], proposal: null, state: 'pending', answer: null, createdAt: 1, resolvedAt: null } }));
    expect(state.decisions[0]).toMatchObject({ id: 'd1', state: 'pending' });
  });

  it('upserts goals and milestones from snapshots without optional arrays', () => {
    const goal = { id: 'g1', title: '방향', why: '', boundaries: '', signal: '', state: 'active' as const, proposedBy: null, createdAt: 1, updatedAt: 1, closedAt: null };
    const milestone = { id: 'm1', goalId: 'g1', title: '첫걸음', hypothesis: '', exit: '', outcome: '', state: 'planned' as const, workIds: [], createdBy: 'sage', settledBy: null, createdAt: 1, startedAt: null, endedAt: null };
    const initial = baseState();
    let state = applyEvent(initial, { type: 'goal', goal });
    state = applyEvent(state, { type: 'goal', goal: { ...goal, title: '새 방향', updatedAt: 2 } });
    state = applyEvent(state, { type: 'goal', goal: { ...goal, id: 'g2' } });
    state = applyEvent(state, { type: 'milestone', milestone });
    state = applyEvent(state, { type: 'milestone', milestone: { ...milestone, state: 'active', startedAt: 2 } });
    state = applyEvent(state, { type: 'milestone', milestone: { ...milestone, id: 'm2' } });
    expect(state.goals?.map(item => item.id)).toEqual(['g1', 'g2']);
    expect(state.goals?.[0].title).toBe('새 방향');
    expect(state.milestones?.map(item => item.id)).toEqual(['m1', 'm2']);
    expect(state.milestones?.[0]).toMatchObject({ state: 'active', startedAt: 2 });
    expect(initial.goals).toBeUndefined();
    expect(initial.milestones).toBeUndefined();
  });

  it('replaces settings wholesale and swaps sandbox rows per ghost', () => {
    let state = applyEvent(baseState(), event({ type: 'settings', settings: { defaultModel: { provider: 'zai', model: 'glm-5.3' }, reviewModel: null, providers: [] } }));
    expect(state.settings.defaultModel).toEqual({ provider: 'zai', model: 'glm-5.3' });
    state = applyEvent(state, event({ type: 'sandbox', sandbox: { ghostId: 'sage', state: 'running', detail: '' } }));
    state = applyEvent(state, event({ type: 'sandbox', sandbox: { ghostId: 'milo', state: 'stopped', detail: '' } }));
    state = applyEvent(state, event({ type: 'sandbox', sandbox: { ghostId: 'sage', state: 'error', detail: 'container lost' } }));
    expect(state.sandboxes.map(row => [row.ghostId, row.state])).toEqual([['milo', 'stopped'], ['sage', 'error']]);
  });

  it('swaps adaptation notes per ghost', () => {
    const notes = { ghostId: 'sage', notes: '창작물은 ~/Works에 두고 bun으로 검증한다', previous: null, by: 'owner' as const, reason: '처음 기록', updatedAt: 1, revision: 0 };
    let state = applyEvent(baseState(), event({ type: 'adaptation', adaptation: notes }));
    expect(state.adaptations?.map(row => row.ghostId)).toEqual(['sage']);
    state = applyEvent(state, event({ type: 'adaptation', adaptation: { ...notes, ghostId: 'milo', notes: '저장소는 pnpm으로', by: 'self' as const, reason: '', updatedAt: 2, revision: 1 } }));
    expect(state.adaptations?.map(row => row.ghostId)).toEqual(['sage', 'milo']);
    state = applyEvent(state, event({ type: 'adaptation', adaptation: { ...notes, notes: '경로가 바뀌어 다시 적는다', previous: notes.notes, by: 'self' as const, reason: '경로 바뀜', updatedAt: 3, revision: 2 } }));
    expect(state.adaptations).toHaveLength(2);
    expect(state.adaptations?.find(row => row.ghostId === 'sage')).toMatchObject({ notes: '경로가 바뀌어 다시 적는다', previous: notes.notes, updatedAt: 3 });
  });

  it('removes schedules, spaces, avatars and devices', () => {
    let state = applyEvent(baseState(), event({ type: 'space', space: { id: 'sp1', name: '메모', path: '/v', createdAt: 1 } }));
    state = applyEvent(state, event({ type: 'space.removed', id: 'sp1' }));
    expect(state.spaces).toEqual([]);
    state = applyEvent(state, event({ type: 'device', device: { id: 'dev1', name: 'iPhone', pushEnabled: true, alerts: { mutedKinds: [], mutedGhostIds: [] }, createdAt: 1, lastSeenAt: null } }));
    state = applyEvent(state, event({ type: 'device.removed', id: 'dev1' }));
    expect(state.devices).toEqual([]);
  });

  it('tracks activities, their runs and account connections', () => {
    const activity = {
      ghostId: 'sage', name: '메일 정리', prompt: '살펴봐', acceptanceCriteria: '요약이 남는다',
      source: { kind: 'schedule' as const, spec: { kind: 'every' as const, seconds: 300, startAt: 0 } },
      execution: { kind: 'container' as const }, tools: [],
      policy: { maxRunsPerDay: 10, maxConcurrent: 1, runTimeoutSeconds: 600, allowSelfCheck: false, minCheckSeconds: 900, externalActions: 'deny' as const, delivery: 'changes' as const },
      id: 'a1', revision: 1, paused: false, pauseReason: null, nextAt: null, cursor: null, lastCheckedAt: null,
      lastError: null, failureCount: 0, deletedAt: null, createdAt: 1, updatedAt: 1,
    };
    const run = {
      id: 'r1', activityId: 'a1', workId: null, trigger: 'manual' as const, sourceKey: 'k1', sourceItem: null,
      state: 'queued' as const, activityRevision: 1, reason: null, dryRun: false, noChange: false,
      createdAt: 1, endedAt: null, nextCheckAt: null, nextCheckReason: null, followupOf: null,
    };
    const connection = {
      id: 'c1', name: '소유자 GitHub', hasCredential: true, createdAt: 1, updatedAt: 1, credentialVersion: 'v1',
      config: { kind: 'github' as const, baseUrl: 'https://api.github.com' },
    };
    let state = applyEvent(baseState(), event({ type: 'activity', activity }));
    expect(state.activities?.map(row => row.id)).toEqual(['a1']);
    state = applyEvent(state, event({ type: 'activity_run', run }));
    expect(state.activityRuns?.[0]).toMatchObject({ id: 'r1', state: 'queued' });
    state = applyEvent(state, event({ type: 'connection', connection }));
    expect(state.connections?.map(row => row.id)).toEqual(['c1']);
    // Upserts replace by id; a deleted activity stays listed with deletedAt until the host drops it from the snapshot.
    state = applyEvent(state, event({ type: 'activity_run', run: { ...run, state: 'done' as const, endedAt: 2, createdAt: 1 } }));
    state = applyEvent(state, event({ type: 'activity', activity: { ...activity, paused: true, revision: 2, updatedAt: 2 } }));
    expect(state.activityRuns).toHaveLength(1);
    expect(state.activityRuns?.[0]).toMatchObject({ state: 'done' });
    expect(state.activities?.[0]).toMatchObject({ paused: true, revision: 2 });
    state = applyEvent(state, event({ type: 'connection.removed', id: 'c1' }));
    state = applyEvent(state, event({ type: 'connection.removed', id: 'missing' }));
    expect(state.connections).toEqual([]);
  });

  it('ignores effect events: they ride on work detail reads', () => {
    const before = baseState();
    const after = applyEvent(before, event({ type: 'effect', effect: { id: 'e1', workId: 'w1', conversationId: 'c9', callId: 'call', tool: 'bash', summary: 'ls', inputDigest: 'a'.repeat(64), state: 'done', result: null, createdAt: 1, endedAt: 2 } }));
    expect(after).toBe(before);
  });
});

it('updates runtime readiness after provider settings change without a page reload', async () => {
  const initial: State = { ...baseState(), runtime: { ready: false, detail: 'no default model', version: '0.0.0' } };
  const ready: State = {
    ...initial, seq: 8,
    settings: { defaultModel: { provider: 'zai', model: 'glm-5.3' }, reviewModel: null, providers: [
      { id: 'zai', kind: 'zai', name: 'Z.AI', baseUrl: null, hasCredential: true, authType: 'api_key', models: [{ id: 'glm-5.3', name: 'GLM' }] },
    ] },
    runtime: { ready: true, detail: 'provider zai is ready', version: '0.0.0' },
  };
  class RuntimeClient extends HostClient {
    changed = false;
    snapshotKept = false;
    override async state() {
      if (this.changed) this.snapshotKept = store.get().state !== null;
      return this.changed ? ready : initial;
    }
    override async stream(_after: number, _conversations: string[], handlers: StreamHandlers, signal: AbortSignal) {
      const ended = Promise.withResolvers<void>();
      signal.addEventListener('abort', () => ended.resolve(), { once: true });
      if (!this.changed) {
        this.changed = true;
        handlers.ledger({ seq: 8, at: 1, data: { type: 'settings', settings: ready.settings } });
      }
      if (!signal.aborted) await ended.promise;
    }
  }
  const client = new RuntimeClient();
  const store = new HostStore(client);
  const observed = Promise.withResolvers<State>();
  const unsubscribe = store.subscribe(() => {
    const state = store.get().state;
    if (state?.runtime.ready) observed.resolve(state);
  });
  store.start();
  try {
    const state = await observed.promise;
    expect(state.runtime).toEqual(ready.runtime);
    expect(state.settings.defaultModel).toEqual({ provider: 'zai', model: 'glm-5.3' });
    expect(client.snapshotKept).toBe(true);
  } finally { unsubscribe(); store.stop(); }
});

const noCache = null;

/** Resolves once the store reaches a snapshot matching `done`. */
function until(store: HostStore, done: (snapshot: ReturnType<HostStore['get']>) => boolean) {
  return new Promise<void>((resolve) => {
    if (done(store.get())) { resolve(); return; }
    const unsubscribe = store.subscribe(() => { if (done(store.get())) { unsubscribe(); resolve(); } });
  });
}

const hold = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
});

describe('coming back and reconnecting', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('resume keeps the screen and reopens the stream from the current seq at once', async () => {
    class DroppingClient extends HostClient {
      reads = 0;
      afters: number[] = [];
      override async state() { this.reads++; return baseState(); }
      override async stream(after: number, _conversations: string[], _handlers: StreamHandlers, signal: AbortSignal) {
        this.afters.push(after);
        if (this.afters.length === 1) throw new Error('Load failed');
        await hold(signal);
      }
    }
    const client = new DroppingClient();
    const store = new HostStore(client, noCache);
    store.start();
    try {
      await until(store, s => s.connection === 'offline');
      const droppedAt = store.get().offlineSince!;
      expect(droppedAt).toEqual(expect.any(Number));
      store.resume();
      expect(store.get().state).not.toBeNull();
      expect(store.get().offlineSince).toBeGreaterThanOrEqual(droppedAt);
      await until(store, s => s.connection === 'live');
      expect(store.get()).toMatchObject({ offlineSince: null, error: null });
      expect(store.get().state).not.toBeNull();
      expect(client.afters).toEqual([7, 7]);
      expect(client.reads).toBe(1);
    } finally { store.stop(); }
  });

  it('refresh rereads the snapshot without blanking the screen', async () => {
    class CountingClient extends HostClient {
      reads = 0;
      override async state() { this.reads++; return { ...baseState(), seq: 7 + this.reads }; }
      override async stream(_after: number, _conversations: string[], _handlers: StreamHandlers, signal: AbortSignal) { await hold(signal); }
    }
    const client = new CountingClient();
    const store = new HostStore(client, noCache);
    const blanks: number[] = [];
    store.start();
    try {
      await until(store, s => s.connection === 'live');
      store.subscribe(() => { if (!store.get().state) blanks.push(Date.now()); });
      store.refresh();
      await until(store, s => s.state?.seq === 9);
      expect(blanks).toEqual([]);
    } finally { store.stop(); }
  });

  it('wakes the screen when the silent and confirm windows end', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    class DownClient extends HostClient {
      override async state() { return baseState(); }
      override async stream(): Promise<void> { throw new Error('Load failed'); }
    }
    const store = new HostStore(new DownClient(), noCache);
    const seen: string[] = [];
    store.subscribe(() => {
      const { connection, state, offlineSince } = store.get();
      const status = hostStatus(connection, Boolean(state), offlineSince, Date.now());
      seen.push(status.quiet ? 'quiet' : status.label);
    });
    store.start();
    try {
      await vi.advanceTimersByTimeAsync(4_100);
      expect(seen.at(-1)).toBe('재연결 중…');
      await vi.advanceTimersByTimeAsync(17_000);
      expect(seen.at(-1)).toBe('연결 끊김');
    } finally { store.stop(); }
  });
});

describe('snapshot cache', () => {
  class MemoryStorage {
    readonly items = new Map<string, string>();
    get length() { return this.items.size; }
    key(index: number) { return [...this.items.keys()][index] ?? null; }
    getItem(key: string) { return this.items.get(key) ?? null; }
    setItem(key: string, value: string) { this.items.set(key, value); }
    removeItem(key: string) { this.items.delete(key); }
  }

  it('draws the cached snapshot on the first read, then replaces it with a fresh one before streaming', async () => {
    const cache = new SnapshotCache(new MemoryStorage(), 'k');
    cache.write({ ...baseState(), seq: 3, ghosts: [ghost('cached')] });
    const fresh = { ...baseState(), seq: 11, ghosts: [ghost('fresh')] };
    const afters: number[] = [];
    class FreshClient extends HostClient {
      override async state() { return fresh; }
      override async stream(after: number, _conversations: string[], _handlers: StreamHandlers, signal: AbortSignal) { afters.push(after); await hold(signal); }
    }
    const store = new HostStore(new FreshClient(), cache);
    expect(store.get()).toMatchObject({ connection: 'connecting', state: { seq: 3, ghosts: [{ id: 'cached' }] } });
    store.start();
    try {
      await until(store, s => s.connection === 'live');
      expect(store.get().state).toEqual(fresh);
      expect(afters).toEqual([11]);
    } finally { store.stop(); }
    expect(cache.read()).toEqual(fresh);
  });

  it('keeps the cached screen while the Host is unreachable', async () => {
    const cache = new SnapshotCache(new MemoryStorage(), 'k');
    cache.write(baseState());
    class DownClient extends HostClient {
      override async state(): Promise<State> { throw new Error('Load failed'); }
    }
    const store = new HostStore(new DownClient(), cache);
    store.start();
    try {
      await until(store, s => s.connection === 'offline');
      const { connection, state, offlineSince } = store.get();
      expect(state).toEqual(baseState());
      expect(hostStatus(connection, Boolean(state), offlineSince, offlineSince!)).toMatchObject({ state: 'reconnecting', quiet: true });
    } finally { store.stop(); }
  });
});
