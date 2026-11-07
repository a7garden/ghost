import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./core/ids.ts";

export const BACKUP_FORMAT = "ghost-backup/2";
const DATABASES = ["ledger.db", "pi.db"] as const;

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
 * Consistent copies of the two databases, safe while the host serves (SQLite `VACUUM INTO`
 * from a read-only connection; WAL readers never block the writer). Artifacts are immutable
 * content-addressed files and secrets are small files; copy them alongside as files.
 */
export function backup(root: string, dir: string, now = Date.now()): BackupManifest {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} is not empty`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: BackupManifest["files"] = [];
  for (const name of DATABASES) {
    const source = join(root, name);
    if (!existsSync(source)) throw new Error(`${source} is missing`);
    const target = join(dir, name);
    const db = new Database(source, { readonly: true });
    try {
      db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    const copy = new Database(target, { readonly: true });
    try {
      const { integrity_check: result } = copy.query("PRAGMA integrity_check").get() as { integrity_check: string };
      if (result !== "ok") throw new Error(`${name} copy failed its integrity check: ${result}`);
    } finally {
      copy.close();
    }
    const bytes = readFileSync(target);
    files.push({ path: name, sha256: sha256(bytes), bytes: bytes.length });
  }
  const ledger = new Database(join(dir, "ledger.db"), { readonly: true });
  const spaces = (ledger.query("SELECT path FROM spaces ORDER BY path").all() as { path: string }[]).map(({ path }) => ({ path }));
  ledger.close();
  const manifest: BackupManifest = { format: BACKUP_FORMAT, complete: true, created_ms: now, files, external_spaces: spaces };
  const temporary = join(dir, ".backup.json.tmp");
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, join(dir, "backup.json"));
  return manifest;
}
