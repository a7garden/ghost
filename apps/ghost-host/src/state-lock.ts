import { Database } from "bun:sqlite";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** `<root>/lock.db`: the ownership lock. It never holds domain state. */
const LOCK_FILE = "lock.db";
/** Bounded acquisition: a competing host gets one second to exit before we fail. */
const BUSY_TIMEOUT_MS = 1_000;

// Keep ownership alive even if startup throws after a resource fails to close.
// Same-process aliases are refused without waiting on SQLite's busy timeout.
const heldRoots = new Map<string, RootLock>();

/** The held root lock. `close` releases it and is safe to call more than once. */
export interface RootLock {
  /** The canonicalized root this lock owns. */
  root: string;
  close(): void;
}

/**
 * Take exclusive ownership of a state root before any domain store is opened or
 * recovered. The lock is a write transaction (`BEGIN EXCLUSIVE`) held open on
 * `<root>/lock.db` for the App's lifetime: the OS drops the file locks when the
 * holder dies, so there is no PID file, TTL or heartbeat to go stale. Alias paths
 * (`realpathSync`) and the plain path all map to the same lock.
 */
export function acquireRootLock(root: string): RootLock {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(root);
  if (heldRoots.has(canonical)) throw new Error(`state root ${canonical} is already owned by a running ghost host`);
  const db = new Database(join(canonical, LOCK_FILE));
  let closed = false;
  const release = (): void => {
    if (closed) return;
    // SQLite close rolls back the transaction even when acquisition failed. Mark it
    // closed only after success so a failed close remains retryable.
    db.close();
    closed = true;
    heldRoots.delete(canonical);
  };
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // No owner row or committed state is needed: ownership is the kernel-held lock.
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    try {
      release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "root lock acquisition and cleanup failed");
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (/busy|locked/i.test(detail)) {
      throw new Error(`state root ${canonical} is already owned by a running ghost host (${join(canonical, LOCK_FILE)} is locked)`);
    }
    throw error;
  }
  const lock = { root: canonical, close: release };
  heldRoots.set(canonical, lock);
  return lock;
}
