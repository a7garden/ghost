import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, OAuthCredential } from "@earendil-works/pi-ai";
import { operationSignal, raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import type { Secrets } from "../core/ports.ts";

/** Provider ids become file names; this shape cannot traverse and matches the contract's provider id pattern. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Parse stored JSON into a canonical credential; legacy `{apiKey}` files read as API keys. */
function parseCredential(text: string): Credential | undefined {
  let stored: unknown;
  try {
    stored = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (stored === null || typeof stored !== "object") return undefined;
  const record = stored as Record<string, unknown>;
  if (record.type === "oauth") {
    if (typeof record.refresh !== "string" || typeof record.access !== "string" || typeof record.expires !== "number") return undefined;
    return stored as OAuthCredential;
  }
  const apiKey = record.type === "api_key" ? record.key : record.apiKey;
  return typeof apiKey === "string" && apiKey !== "" ? { type: "api_key", key: apiKey } : undefined;
}

/**
 * Shared credential bookkeeping behind the `Secrets` port: a per-provider
 * memory view plus pi-ai's `CredentialStore`. `modify` serializes writers per
 * provider (pi-ai runs OAuth refresh single-flight inside it); the
 * synchronous owner path (`put`/`delete`) bypasses that queue and bumps a
 * generation counter, so an in-flight `modify` publication — e.g. a refreshed
 * OAuth token — is discarded instead of resurrecting a replaced credential.
 */
export abstract class BaseSecrets implements Secrets {
  private readonly credentials = new Map<string, Credential>();
  private readonly generations = new Map<string, number>();
  private readonly chains = new Map<string, Promise<unknown>>();

  credential(providerId: string): Credential | undefined {
    this.check(providerId);
    return this.credentials.get(providerId);
  }

  has(providerId: string): boolean {
    return this.credential(providerId) !== undefined;
  }

  /** API key only; OAuth credentials resolve through `read`/`modify`. */
  get(providerId: string): string | null {
    const credential = this.credential(providerId);
    return credential?.type === "api_key" && credential.key ? credential.key : null;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.credential(providerId);
  }

  /** Credential metadata only — never secret material. */
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  /**
   * Serialized read-modify-write, one writer per provider at a time. The write
   * publishes only if no synchronous `put`/`delete` happened while `fn` ran;
   * otherwise the computed credential is stale and the store keeps whatever
   * the owner put there. Publication persists first, so a failed write leaves
   * memory and disk consistent and reports the failure. Aborting cancels only
   * the wait for the lock.
   */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const signal = operationSignal(options?.signal);
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const queued = (async () => {
      await previous.catch(() => {});
      signal.throwIfAborted();
      const generation = this.generations.get(providerId) ?? 0;
      const current = this.credential(providerId);
      const next = await fn(current);
      if ((this.generations.get(providerId) ?? 0) !== generation) return this.credential(providerId);
      if (next !== undefined) {
        this.persist(providerId, next);
        this.credentials.set(providerId, next);
      }
      return next ?? current;
    })();
    const tail = queued.catch(() => {});
    this.chains.set(providerId, tail);
    void tail.then(() => {
      if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
    });
    return raceWithAbortSignal(queued, signal);
  }

  /**
   * Remove the credential. Synchronous like `put`: the generation bump makes
   * any in-flight `modify` discard its write, so logout cannot be undone by a
   * refresh that was already running.
   */
  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    this.replace(providerId, undefined);
  }

  /** Owner path: replace the credential with an API key (null deletes). */
  put(providerId: string, apiKey: string | null): void {
    this.replace(providerId, apiKey === null ? undefined : { type: "api_key", key: apiKey });
  }

  /** Seed the memory view without persisting; only for store construction. */
  protected load(providerId: string, credential: Credential): void {
    this.credentials.set(providerId, credential);
  }

  private replace(providerId: string, credential: Credential | undefined): void {
    this.check(providerId);
    // Persist first: a failed write must leave memory and generation untouched,
    // so a failed owner replacement neither reports success nor discards an
    // in-flight refresh.
    this.persist(providerId, credential);
    this.generations.set(providerId, (this.generations.get(providerId) ?? 0) + 1);
    if (credential === undefined) this.credentials.delete(providerId);
    else this.credentials.set(providerId, credential);
  }

  private check(providerId: string): void {
    if (!PROVIDER_ID.test(providerId)) throw new Error(`invalid provider id ${JSON.stringify(providerId)}`);
  }

  /** Persist a memory mutation; file stores mirror it atomically. */
  protected abstract persist(providerId: string, credential: Credential | undefined): void;
}

/** Credentials per provider at `<root>/secrets/<providerId>.json`, 0600 files in a 0700 directory. */
export class FileSecrets extends BaseSecrets {
  private readonly dir: string;

  constructor(root: string) {
    super();
    this.dir = join(root, "secrets");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith(".json")) continue;
      const providerId = entry.slice(0, -".json".length);
      if (!PROVIDER_ID.test(providerId)) continue;
      try {
        const credential = parseCredential(readFileSync(join(this.dir, entry), "utf8"));
        if (credential) this.load(providerId, credential);
      } catch {
        // Unreadable or corrupt file: treat the credential as absent.
      }
    }
  }

  protected persist(providerId: string, credential: Credential | undefined): void {
    const file = join(this.dir, `${providerId}.json`);
    if (credential === undefined) {
      try {
        unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(credential), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  }
}
