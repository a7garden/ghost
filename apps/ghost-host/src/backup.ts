import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./core/ids.ts";

export const BACKUP_FORMAT = "ghost-backup/2";
const DATABASES = ["ledger.db", "pi.db"] as const;
/** The vault store and its key, copied when present. The vault never shares a transaction with the ledger. */
const VAULT_DB = join("vault", "vault.db");
const VAULT_KEY = join("vault", "key");
/** Maximum wait for the first store's in-flight writer; later guards fail fast. */
const WRITER_LOCK_TIMEOUT_MS = 5_000;
/** One SQLite busy wait inside the writer-lock deadline (bun:sqlite overshoots a single long pragma). */
const BUSY_TIMEOUT_QUANTUM_MS = 250;

/**
 * `<dir>/backup.json`. Written last, so a manifest on disk means every listed file is
 * complete and integrity-checked. `external_spaces` are document vaults outside the root.
 */
export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  complete: true;
  created_ms: number;
  files: { path: string; sha256: string; bytes: number }[];
  external_spaces: { path: string }[];
}

/**
 * Freeze writers on all durable stores, in a fixed order, before copying any database.
 * Separate read connections perform VACUUM INTO while BEGIN IMMEDIATE guards
 * remain held. Release writers before integrity checks and hashing. WAL readers can
 * continue, but a host's synchronous write may block its event loop until its busy
 * timeout or our release. This uses SQLite file locks, including against older hosts.
 */
export function backup(root: string, dir: string, now = Date.now()): BackupManifest {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} is not empty`);
  const names: string[] = [...DATABASES];
  if (existsSync(join(root, "memory.db"))) names.push("memory.db");
  const sources = names.map((name) => {
    const source = join(root, name);
    if (!existsSync(source)) throw new Error(`${source} is missing`);
    return { name, source, target: join(dir, name) };
  });
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const guards: { db: Database; acquired: boolean }[] = [];
  const copied: string[] = [];
  const releaseWriters = () => {
    const errors: unknown[] = [];
    for (let index = guards.length - 1; index >= 0; index--) {
      const guard = guards[index]!;
      try {
        if (guard.acquired) {
          guard.db.exec("ROLLBACK");
          guard.acquired = false;
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        // Close also rolls back if explicit rollback failed. Never skip the other store.
        guard.db.close();
        guards.splice(index, 1);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "failed to release backup writer guards");
  };
  const discardCopies = () => {
    const errors: unknown[] = [];
    for (const path of copied.reverse()) {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error);
      }
    }
    try {
      rmdirSync(join(dir, "vault"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "failed to remove incomplete backup files");
  };

  try {
    for (const { name, source } of sources) {
      const guard = { db: new Database(source), acquired: false };
      guards.push(guard);
      // Never wait for Pi while excluding ledger writers: an in-flight Pi
      // transaction may need the host event loop, itself stalled on a ledger write.
      const timeoutMs = guards.length === 1 ? WRITER_LOCK_TIMEOUT_MS : 0;
      const started = Date.now();
      try {
        // bun:sqlite overshoots one long `busy_timeout` pragma (measured ~2.5× on bun 1.4.2:
        // a 5s pragma returned after ~12.5s), so wait in short quanta under an explicit deadline.
        guard.db.exec(`PRAGMA busy_timeout = ${timeoutMs === 0 ? 0 : BUSY_TIMEOUT_QUANTUM_MS}`);
        for (;;) {
          try {
            guard.db.exec("BEGIN IMMEDIATE");
            guard.acquired = true;
            break;
          } catch (error) {
            const retryDetail = error instanceof Error ? error.message : String(error);
            if (!/busy|locked/i.test(retryDetail) || Date.now() - started >= timeoutMs) throw error;
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/busy|locked/i.test(detail)) throw new Error(`${name} was still busy after ${Date.now() - started}ms; wrote no backup`, { cause: error });
        throw error;
      }
    }
    for (const { source, target } of sources) {
      const reader = new Database(source, { readonly: true });
      try {
        copied.push(target);
        reader.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
      } finally {
        reader.close();
      }
    }
    releaseWriters();

    const files: BackupManifest["files"] = [];
    for (const { name, target } of sources) {
      const copy = new Database(target, { readonly: true });
      try {
        const results = copy.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
        if (results.length !== 1 || results[0]!.integrity_check !== "ok") {
          throw new Error(`${name} copy failed its integrity check: ${results.map((row) => row.integrity_check).join("; ")}`);
        }
      } finally {
        copy.close();
      }
      const bytes = readFileSync(target);
      files.push({ path: name, sha256: sha256(bytes), bytes: bytes.length });
    }
    if (existsSync(join(root, VAULT_DB))) {
      mkdirSync(join(dir, "vault"), { recursive: true, mode: 0o700 });
      const target = join(dir, VAULT_DB);
      const reader = new Database(join(root, VAULT_DB), { readonly: true });
      try {
        copied.push(target);
        reader.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
      } finally {
        reader.close();
      }
      const copy = new Database(target, { readonly: true });
      try {
        const results = copy.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
        if (results.length !== 1 || results[0]!.integrity_check !== "ok") throw new Error("vault.db copy failed its integrity check");
      } finally {
        copy.close();
      }
      const bytes = readFileSync(target);
      files.push({ path: VAULT_DB, sha256: sha256(bytes), bytes: bytes.length });
      // Without its key the vault copy cannot be restored.
      const key = readFileSync(join(root, VAULT_KEY));
      copied.push(join(dir, VAULT_KEY));
      writeFileSync(join(dir, VAULT_KEY), key, { mode: 0o600 });
      files.push({ path: VAULT_KEY, sha256: sha256(key), bytes: key.length });
    }
    const ledger = new Database(join(dir, "ledger.db"), { readonly: true });
    let scopes: BackupManifest["external_spaces"];
    try {
      const scoped = ledger.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scopes'").get() !== null;
      const paths = scoped
        ? "SELECT DISTINCT json_extract(data, '$.vaultPath') AS path FROM scopes WHERE json_extract(data, '$.vaultPath') IS NOT NULL ORDER BY path"
        : "SELECT path FROM spaces ORDER BY path";
      scopes = (ledger.query(paths).all() as { path: string }[]).map(({ path }) => ({ path }));
    } finally {
      ledger.close();
    }
    const manifest: BackupManifest = { format: BACKUP_FORMAT, complete: true, created_ms: now, files, external_spaces: scopes };
    const temporary = join(dir, ".backup.json.tmp");
    copied.push(temporary);
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, join(dir, "backup.json"));
    return manifest;
  } catch (error) {
    const errors: unknown[] = [error];
    try { releaseWriters(); } catch (cleanupError) { errors.push(cleanupError); }
    try { discardCopies(); } catch (cleanupError) { errors.push(cleanupError); }
    if (errors.length > 1) throw new AggregateError(errors, "backup failed and cleanup was incomplete");
    throw error;
  }
}
