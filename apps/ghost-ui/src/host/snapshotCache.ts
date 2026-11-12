import { State, validate } from '@ghost/contract';

/** Largest serialized snapshot kept (UTF-16 units); a bigger one is not cached at all. */
export const SNAPSHOT_LIMIT = 2_000_000;
const PREFIX = 'ghost-ui:snapshot:';

export type SnapshotStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/** Storages forgotten in this page: a pending write must not bring the snapshot back. */
const sealed = new WeakSet<SnapshotStorage>();

function pageStorage(): SnapshotStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; }
  catch { return null; }
}

/** Short stable digest, so keys separate principals without spelling out the bearer token. */
function digest(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/** One snapshot per origin and principal; the bearer token is the principal (none: the Access owner). */
export function snapshotKey(origin: string, token: string | undefined): string {
  return PREFIX + digest(`${origin}\n${token ?? ''}`);
}

function dropSnapshots(storage: SnapshotStorage, keep: string | null) {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(PREFIX) && key !== keep) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

/**
 * The last live State, so a cold start draws real content before the Host answers. State carries
 * no secret values: vault values, provider and connection credentials and tokens never cross
 * /api/state (only `has*` flags do). Unreadable, mismatched or oversized entries are dropped.
 */
export class SnapshotCache {
  constructor(private readonly storage: SnapshotStorage, private readonly key: string) {}

  /** This page's cache; null where web storage is unavailable. */
  static forPage(): SnapshotCache | null {
    const storage = pageStorage();
    return storage ? new SnapshotCache(storage, snapshotKey(window.location.origin, window.__GHOST_TOKEN__)) : null;
  }

  read(): State | null {
    try {
      const raw = this.storage.getItem(this.key);
      if (raw === null) return null;
      const value: unknown = JSON.parse(raw);
      if (validate(State, value)) return value;
    } catch { /* torn JSON or unreadable storage */ }
    this.remove();
    return null;
  }

  write(state: State): void {
    if (sealed.has(this.storage)) return;
    const raw = JSON.stringify(state);
    if (raw.length > SNAPSHOT_LIMIT) { this.remove(); return; }
    try {
      // Another principal's snapshot (a re-pair, a rotated token) is never read again.
      dropSnapshots(this.storage, this.key);
      this.storage.setItem(this.key, raw);
    } catch { this.remove(); }
  }

  private remove() {
    try { this.storage.removeItem(this.key); } catch { /* storage unavailable */ }
  }
}

/** Unpaired, revoked or rejected: forget every snapshot of this origin for the rest of the page. */
export function clearSnapshots(storage: SnapshotStorage | null = pageStorage()): void {
  if (!storage) return;
  sealed.add(storage);
  try { dropSnapshots(storage, null); } catch { /* storage unavailable */ }
}
