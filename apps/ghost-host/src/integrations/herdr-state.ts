import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { validate } from "@ghost/contract";

export const HERDR_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const HERDR_PANE = /^[A-Za-z0-9]{1,16}:[A-Za-z0-9]{1,16}$/;
export const HERDR_TERMINAL = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

export const TerminalSize = Type.Object({ cols: Type.Integer({ minimum: 1, maximum: 65535 }), rows: Type.Integer({ minimum: 1, maximum: 65535 }) });
export type TerminalSize = Static<typeof TerminalSize>;
const MaybeSize = Type.Union([TerminalSize, Type.Null()]);
const RecordSchema = Type.Object({
  session: Type.String({ pattern: HERDR_SESSION.source }),
  pane: Type.String({ pattern: HERDR_PANE.source }),
  terminal_id: Type.String({ pattern: HERDR_TERMINAL.source }),
  baseline: MaybeSize,
  // Distinguish changes to the desktop layout/viewport from a resize we wrote ourselves.
  layout: Type.Optional(MaybeSize),
  size: Type.Optional(MaybeSize),
  priorSize: Type.Optional(MaybeSize),
  startedAt: Type.Integer(),
});
export type LeaseRecord = Static<typeof RecordSchema>;
const LeaseFile = Type.Array(RecordSchema);
const OwnedFile = Type.Record(Type.String({ pattern: HERDR_SESSION.source }), Type.Array(Type.String({ pattern: HERDR_TERMINAL.source })));

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function save(root: string | undefined, name: string, value: unknown): void {
  if (root === undefined) return;
  const path = join(root, name);
  const temporary = `${path}.tmp`;
  try {
    // A SIGKILL may leave the temporary file, but readers only use the previous complete rename.
    rmSync(temporary, { force: true });
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export class HerdrState {
  private readonly owned = new Map<string, Set<string>>();
  readonly leases = new Map<string, LeaseRecord>();

  constructor(private readonly root?: string) {
    if (root === undefined) return;
    const owned = readJson(join(root, "herdr-owned.json"));
    if (validate(OwnedFile, owned)) for (const [session, ids] of Object.entries(owned)) this.owned.set(session, new Set(ids));
    const leases = readJson(join(root, "herdr-leases.json"));
    if (validate(LeaseFile, leases)) for (const lease of leases) this.leases.set(`${lease.session}/${lease.pane}`, lease);
  }

  owns(session: string, terminal: string): boolean {
    return this.owned.get(session)?.has(terminal) ?? false;
  }

  ownedTerminals(session: string): ReadonlySet<string> | undefined {
    return this.owned.get(session);
  }

  claim(session: string, terminal: string): void {
    if (!HERDR_SESSION.test(session) || !HERDR_TERMINAL.test(terminal)) return;
    const previous = this.owned.get(session);
    if (previous?.has(terminal)) return;
    this.saveOwned(session, new Set([...(previous ?? []), terminal]));
  }

  prune(session: string, knownBeforeRead: ReadonlySet<string>, present: Set<string>): void {
    const previous = this.owned.get(session);
    if (!previous) return;
    // A command can create a pane while the snapshot is in flight; that terminal was not eligible for pruning.
    const keep = new Set([...previous].filter((terminal) => !knownBeforeRead.has(terminal) || present.has(terminal)));
    if (keep.size !== previous.size) this.saveOwned(session, keep);
  }

  private saveOwned(session: string, next: Set<string>): void {
    const entries = new Map(this.owned);
    if (next.size) entries.set(session, next);
    else entries.delete(session);
    save(this.root, "herdr-owned.json", Object.fromEntries([...entries].map(([session, ids]) => [session, [...ids]])));
    if (next.size) this.owned.set(session, next);
    else this.owned.delete(session);
  }

  setLease(key: string, next: LeaseRecord | null): void {
    const entries = new Map(this.leases);
    if (next === null) entries.delete(key);
    else entries.set(key, next);
    save(this.root, "herdr-leases.json", [...entries.values()]);
    if (next === null) this.leases.delete(key);
    else this.leases.set(key, next);
  }
}
