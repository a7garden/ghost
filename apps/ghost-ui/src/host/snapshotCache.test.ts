import { expect, it } from 'vitest';
import type { State } from '@ghost/contract';
import { clearSnapshots, SNAPSHOT_LIMIT, SnapshotCache, snapshotKey, type SnapshotStorage } from './snapshotCache';

class MemoryStorage implements SnapshotStorage {
  readonly items = new Map<string, string>();
  quota = Infinity;
  get length() { return this.items.size; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (value.length > this.quota) throw new DOMException('quota', 'QuotaExceededError');
    this.items.set(key, value);
  }
  removeItem(key: string) { this.items.delete(key); }
}

const snapshotState = (patch: Partial<State> = {}): State => ({
  seq: 7,
  principal: { kind: 'owner' },
  runtime: { ready: true, detail: '', version: '0.0.0' },
  ghosts: [], conversations: [], works: [], decisions: [], notifications: [], schedules: [], spaces: [], avatars: [],
  settings: { defaultModel: null, reviewModel: null, providers: [] },
  devices: [], sandboxes: [],
  ...patch,
});

const key = snapshotKey('https://ghost.example', 'device-token');

it('reads back the last written snapshot', () => {
  const storage = new MemoryStorage();
  new SnapshotCache(storage, key).write(snapshotState({ seq: 42 }));
  expect(new SnapshotCache(storage, key).read()).toEqual(snapshotState({ seq: 42 }));
});

it('keeps one snapshot per origin and principal', () => {
  expect(snapshotKey('https://ghost.example', 'a')).not.toBe(snapshotKey('https://ghost.example', 'b'));
  expect(snapshotKey('https://ghost.example', undefined)).not.toBe(snapshotKey('https://other.example', undefined));
  const storage = new MemoryStorage();
  new SnapshotCache(storage, snapshotKey('https://ghost.example', 'old')).write(snapshotState());
  new SnapshotCache(storage, key).write(snapshotState());
  expect(new SnapshotCache(storage, snapshotKey('https://ghost.example', 'old')).read()).toBeNull();
  expect(storage.items.size).toBe(1);
});

it('drops torn or mismatched entries instead of drawing them', () => {
  const storage = new MemoryStorage();
  storage.setItem(key, '{"seq":');
  expect(new SnapshotCache(storage, key).read()).toBeNull();
  expect(storage.items.has(key)).toBe(false);
  const { ghosts: _dropped, ...withoutGhosts } = snapshotState();
  storage.setItem(key, JSON.stringify(withoutGhosts));
  expect(new SnapshotCache(storage, key).read()).toBeNull();
  expect(storage.items.has(key)).toBe(false);
});

it('does not keep a snapshot over the size cap, nor an older one in its place', () => {
  const storage = new MemoryStorage();
  const cache = new SnapshotCache(storage, key);
  cache.write(snapshotState());
  cache.write(snapshotState({ runtime: { ready: true, detail: 'x'.repeat(SNAPSHOT_LIMIT), version: '0.0.0' } }));
  expect(cache.read()).toBeNull();
});

it('survives a full storage', () => {
  const storage = new MemoryStorage();
  const cache = new SnapshotCache(storage, key);
  cache.write(snapshotState());
  storage.quota = 10;
  expect(() => cache.write(snapshotState({ seq: 8 }))).not.toThrow();
  expect(cache.read()).toBeNull();
});

it('forgets every snapshot on unpair and refuses later writes in the page', () => {
  const storage = new MemoryStorage();
  const cache = new SnapshotCache(storage, key);
  cache.write(snapshotState());
  storage.setItem('ghost-ui:theme', 'dark');
  clearSnapshots(storage);
  expect(cache.read()).toBeNull();
  cache.write(snapshotState({ seq: 9 }));
  expect(cache.read()).toBeNull();
  expect(storage.getItem('ghost-ui:theme')).toBe('dark');
});
