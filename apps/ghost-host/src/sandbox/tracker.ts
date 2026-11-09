/**
 * What the Host remembers about each Work container between `container ls` calls (2026-11-09).
 *
 * - A container the Host started or saw running is trusted without listing again, so a Work's
 *   commands do not each pay for an extra CLI round trip. A failed command drops that trust.
 * - Starts are single-flight per container: two commands of one Work never race two `container run`s.
 * - A container is retired (deleted) only while none of its commands runs, and a command that arrives
 *   during the retirement waits for it and then starts a fresh container.
 * - The owner's grants a container was started with are kept, so a grant change reaches the next start.
 *
 * State is in memory only. After a Host restart a running container is adopted with its grants unknown
 * and its idle clock starting at the first sweep that sees it.
 */

/** How long a container seen running is trusted without `container ls`. */
export const TRUST_MS = 5 * 60_000;
/**
 * A container with no command for this long is deleted; the next command starts a fresh one over the
 * same workspace. 30 minutes keeps a dev server or a watcher the Ghost started across a short pause,
 * while a Work waiting hours for the owner does not hold a VM's memory.
 */
export const IDLE_MS = 30 * 60_000;

interface Seen {
  /** When the container was last known to be running; 0 = must list again. */
  verifiedAt: number;
  /** When a command last started or finished in it. */
  usedAt: number;
  inFlight: number;
  /** The grants it was started with; null = adopted after a restart, unknown. */
  grants: string | null;
}

export class ContainerTracker {
  private readonly seen = new Map<string, Seen>();
  private readonly starting = new Map<string, Promise<unknown>>();
  private readonly retiring = new Map<string, Promise<void>>();

  constructor(private readonly now: () => number = Date.now) {}

  private entry(name: string): Seen {
    let seen = this.seen.get(name);
    if (seen === undefined) {
      seen = { verifiedAt: 0, usedAt: this.now(), inFlight: 0, grants: null };
      this.seen.set(name, seen);
    }
    return seen;
  }

  /** A command starts in `name`; the returned function ends it. */
  begin(name: string): () => void {
    const seen = this.entry(name);
    seen.inFlight += 1;
    seen.usedAt = this.now();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      // The entry may have been replaced by a retirement; count down the live one.
      const live = this.entry(name);
      live.inFlight = Math.max(0, live.inFlight - 1);
      live.usedAt = this.now();
    };
  }

  inFlight(name: string): number {
    return this.seen.get(name)?.inFlight ?? 0;
  }

  /** Resolves once a retirement of `name` in progress is over. */
  settled(name: string): Promise<void> {
    return this.retiring.get(name) ?? Promise.resolve();
  }

  /** Runs `start` once for concurrent callers of the same container. */
  once<T>(name: string, start: () => Promise<T>): Promise<T> {
    const pending = this.starting.get(name) as Promise<T> | undefined;
    if (pending !== undefined) return pending;
    const run = start().finally(() => this.starting.delete(name));
    this.starting.set(name, run);
    return run;
  }

  /** Known running with these grants, recently enough to skip `container ls`. */
  trusted(name: string, grants: string): boolean {
    const seen = this.seen.get(name);
    return seen !== undefined && seen.grants === grants && seen.verifiedAt > 0 && this.now() - seen.verifiedAt < TRUST_MS;
  }

  /**
   * `container ls` shows `name` running. True when it may be used as it is: started with these grants,
   * or adopted after a restart. False when it was started with other grants.
   */
  adopt(name: string, grants: string): boolean {
    const seen = this.entry(name);
    if (seen.grants !== null && seen.grants !== grants) return false;
    seen.grants = grants;
    seen.verifiedAt = this.now();
    return true;
  }

  /** The Host just started `name` with these grants. */
  started(name: string, grants: string): void {
    const seen = this.entry(name);
    seen.grants = grants;
    seen.verifiedAt = this.now();
  }

  /** A command failed; list again before trusting the container. */
  doubt(name: string): void {
    const seen = this.seen.get(name);
    if (seen !== undefined) seen.verifiedAt = 0;
  }

  /** The container is gone (deleted by release, the owner's reset, or a retirement). */
  forget(name: string): void {
    const seen = this.seen.get(name);
    if (seen === undefined) return;
    if (seen.inFlight === 0) this.seen.delete(name);
    else Object.assign(seen, { verifiedAt: 0, grants: null });
  }

  /** No command has run for IDLE_MS. A container first seen now starts its idle clock now. */
  idle(name: string): boolean {
    const seen = this.entry(name);
    return seen.inFlight === 0 && this.now() - seen.usedAt >= IDLE_MS;
  }

  /**
   * Deletes `name` with `remove` unless a command runs in it. The check and the claim happen in the
   * same turn of the event loop, so no command can slip in between; one that arrives later waits.
   */
  async retire(name: string, remove: () => Promise<void>): Promise<boolean> {
    if (this.inFlight(name) > 0 || this.retiring.has(name) || this.starting.has(name)) return false;
    const removing = remove().finally(() => {
      this.retiring.delete(name);
      this.forget(name);
    });
    this.retiring.set(name, removing.catch(() => undefined));
    await removing;
    return true;
  }
}
