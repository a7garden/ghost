import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openApp } from "../src/app.ts";
import { BACKUP_FORMAT, backup, type BackupManifest } from "../src/backup.ts";
import { loadConfig } from "../src/config.ts";
import { sha256 } from "../src/core/ids.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { tempDir } from "./support.ts";

// Real OS-process file handshakes cannot be advanced with this process's fake timers.
async function until(path: string, limitMs = 10_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`${path} never appeared`);
}

describe("ghost backup", () => {
  test("copies both open databases and lists external spaces", () => {
    const root = tempDir();
    const ledger = new Ledger(join(root, "ledger.db"));
    const pi = new Database(join(root, "pi.db"));
    try {
      ledger.tx(() => ledger.putSpace({ id: "s1", name: "Notes", path: "/Users/someone/Notes", grants: [], createdAt: 1 }));
      pi.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')");
      const dir = join(tempDir(), "snapshot");
      const manifest = backup(root, dir, 42);
      expect(manifest.format).toBe(BACKUP_FORMAT);
      expect(manifest.files.map((file) => file.path)).toEqual(["ledger.db", "pi.db"]);
      for (const file of manifest.files) expect(sha256(readFileSync(join(dir, file.path)))).toBe(file.sha256);
      expect(manifest.external_spaces).toEqual([{ path: "/Users/someone/Notes" }]);
      expect(JSON.parse(readFileSync(join(dir, "backup.json"), "utf8")) as BackupManifest).toEqual(manifest);
      const copy = new Database(join(dir, "pi.db"), { readonly: true });
      try { expect(copy.query("SELECT v FROM t").get()).toEqual({ v: "kept" }); } finally { copy.close(); }
    } finally {
      pi.close();
      ledger.close();
    }
  });

  test("copies the vault store together with its key", () => {
    const root = tempDir();
    const ledger = new Ledger(join(root, "ledger.db"));
    const pi = new Database(join(root, "pi.db"));
    mkdirSync(join(root, "vault"), { mode: 0o700 });
    const vault = new Database(join(root, "vault", "vault.db"));
    try {
      vault.exec("PRAGMA journal_mode = WAL; CREATE TABLE items (id TEXT); INSERT INTO items VALUES ('i1')");
      writeFileSync(join(root, "vault", "key"), new Uint8Array(32).fill(7), { mode: 0o600 });
      const dir = join(tempDir(), "snapshot");
      const manifest = backup(root, dir);
      expect(manifest.files.map((file) => file.path)).toEqual(["ledger.db", "pi.db", "vault/vault.db", "vault/key"]);
      for (const file of manifest.files) expect(sha256(readFileSync(join(dir, file.path)))).toBe(file.sha256);
      expect(statSync(join(dir, "vault", "key")).mode & 0o777).toBe(0o600);
      const copy = new Database(join(dir, "vault", "vault.db"), { readonly: true });
      try { expect(copy.query("SELECT id FROM items").get()).toEqual({ id: "i1" }); } finally { copy.close(); }
    } finally {
      vault.close();
      pi.close();
      ledger.close();
    }
  });

  test("backs up an openApp-owned root without taking host ownership", async () => {
    const root = tempDir();
    const app = await openApp(loadConfig({}, root));
    try {
      app.ledger.tx(() => app.ledger.putSpace({ id: "s1", name: "Notes", path: "/Users/someone/Notes", grants: [], createdAt: 1 }));
      const dir = join(tempDir(), "snapshot");
      const manifest = backup(root, dir);
      expect(manifest.complete).toBe(true);
      expect(manifest.external_spaces).toEqual([{ path: "/Users/someone/Notes" }]);
      for (const file of manifest.files) expect(sha256(readFileSync(join(dir, file.path)))).toBe(file.sha256);
    } finally {
      await app.close();
    }
  });

  test("both writers are excluded before either copy and released before integrity checks", async () => {
    const root = tempDir();
    const ledger = new Ledger(join(root, "ledger.db"));
    const pi = new Database(join(root, "pi.db"));
    const work = tempDir();
    const dir = join(tempDir(), "snapshot");
    const worker = join(work, "backup-worker.js");
    // Pause actual SQLite calls in the backup process, not a fake database. The parent
    // probes kernel writer locks at exact copy/check boundaries, independent of database
    // size or scheduler timing; every paused call subsequently runs the real operation.
    writeFileSync(worker, [
      `import { Database } from "bun:sqlite";`,
      `import { existsSync, writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { backup } from ${JSON.stringify(join(import.meta.dir, "..", "src", "backup.ts"))};`,
      `const work = ${JSON.stringify(work)};`,
      `function pause(phase) {`,
      `  writeFileSync(join(work, phase + ".ready"), "ready");`,
      `  const deadline = Date.now() + 15000;`,
      `  while (!existsSync(join(work, phase + ".continue"))) {`,
      `    if (Date.now() > deadline) throw new Error("handshake timed out: " + phase);`,
      `    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);`,
      `  }`,
      `}`,
      `let copies = 0;`,
      `const exec = Database.prototype.exec;`,
      `Database.prototype.exec = function(sql) {`,
      `  if (sql.startsWith("VACUUM INTO ")) pause("copy" + (++copies));`,
      `  return exec.call(this, sql);`,
      `};`,
      `let checking = false;`,
      `const query = Database.prototype.query;`,
      `Database.prototype.query = function(sql) {`,
      `  if (sql === "PRAGMA integrity_check" && !checking) { checking = true; pause("checking"); }`,
      `  return query.call(this, sql);`,
      `};`,
      `backup(${JSON.stringify(root)}, ${JSON.stringify(dir)});`,
    ].join("\n"));
    let child: Bun.Subprocess<"ignore", "ignore", "inherit"> | undefined;
    try {
      ledger.db.exec("CREATE TABLE pair_marker (k TEXT NOT NULL); INSERT INTO pair_marker VALUES ('pre'); PRAGMA busy_timeout = 0");
      pi.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 0; CREATE TABLE pair_marker (k TEXT NOT NULL); INSERT INTO pair_marker VALUES ('pre')");
      child = Bun.spawn([process.execPath, worker], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
      for (const phase of ["copy1", "copy2"]) {
        await until(join(work, `${phase}.ready`));
        // Each independent connection must be excluded, including Pi before ledger's
        // first copy. An implementation guarding just ledger cannot pass this probe.
        for (const db of [ledger.db, pi]) expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/busy|locked/i);
        expect(existsSync(join(dir, "backup.json"))).toBe(false);
        writeFileSync(join(work, `${phase}.continue`), "continue");
      }
      await until(join(work, "checking.ready"));
      // Both copies are complete, but no integrity check or hash has started yet.
      for (const db of [ledger.db, pi]) {
        db.exec("BEGIN IMMEDIATE; INSERT INTO pair_marker VALUES ('post'); COMMIT");
      }
      writeFileSync(join(work, "checking.continue"), "continue");
      expect(await child.exited).toBe(0);
      const manifest = JSON.parse(readFileSync(join(dir, "backup.json"), "utf8")) as BackupManifest;
      expect(manifest.complete).toBe(true);
      for (const name of ["ledger.db", "pi.db"]) {
        const copy = new Database(join(dir, name), { readonly: true });
        try { expect(copy.query("SELECT k FROM pair_marker").all()).toEqual([{ k: "pre" }]); } finally { copy.close(); }
      }
      for (const db of [ledger.db, pi]) expect(db.query("SELECT k FROM pair_marker ORDER BY rowid").all()).toEqual([{ k: "pre" }, { k: "post" }]);
    } finally {
      if (child) {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
      pi.close();
      ledger.close();
    }
  }, 20_000);

  test.each(["ledger.db", "pi.db"])("a busy %s bounds acquisition and releases every acquired guard", (held) => {
    const root = tempDir();
    const ledger = new Ledger(join(root, "ledger.db"));
    const pi = new Database(join(root, "pi.db"));
    pi.exec("PRAGMA journal_mode = WAL");
    const writer = new Database(join(root, held));
    const probe = new Database(join(root, "ledger.db"));
    const dir = join(tempDir(), "snapshot");
    try {
      writer.exec("BEGIN IMMEDIATE");
      expect(() => backup(root, dir)).toThrow(`${held} was still busy`);
      expect(existsSync(join(dir, "backup.json"))).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
      writer.exec("ROLLBACK");
      // In the Pi-held case, backup already acquired ledger; failure must release it.
      probe.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK");
      expect(backup(root, dir).complete).toBe(true);
    } finally {
      probe.close();
      writer.close();
      pi.close();
      ledger.close();
    }
  }, 10_000);

  test("a missing database fails before anything is written", () => {
    const root = tempDir();
    new Ledger(join(root, "ledger.db")).close();
    const dir = join(tempDir(), "snapshot");
    expect(() => backup(root, dir)).toThrow(/pi\.db is missing/);
    expect(existsSync(dir)).toBe(false);
  });

  test("an unreadable database fails and leaves no partial backup", () => {
    const root = tempDir();
    const ledger = new Ledger(join(root, "ledger.db"));
    try {
      writeFileSync(join(root, "pi.db"), "this is not a database");
      const dir = join(tempDir(), "snapshot");
      expect(() => backup(root, dir)).toThrow();
      expect(readdirSync(dir)).toEqual([]);
      ledger.db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK");
    } finally {
      ledger.close();
    }
  });

  test("metadata failure removes copies rather than publishing a complete manifest", () => {
    const root = tempDir();
    const ledger = new Database(join(root, "ledger.db"));
    const pi = new Database(join(root, "pi.db"));
    try {
      ledger.exec("PRAGMA journal_mode = WAL; CREATE TABLE unrelated (v TEXT)");
      pi.exec("PRAGMA journal_mode = WAL; CREATE TABLE unrelated (v TEXT)");
      const dir = join(tempDir(), "snapshot");
      expect(() => backup(root, dir)).toThrow(/spaces/);
      expect(readdirSync(dir)).toEqual([]);
      for (const db of [ledger, pi]) db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK");
    } finally {
      pi.close();
      ledger.close();
    }
  });

  test("refuses a non-empty target", () => {
    const root = tempDir();
    new Ledger(join(root, "ledger.db")).close();
    new Database(join(root, "pi.db")).close();
    const dir = tempDir();
    writeFileSync(join(dir, "other"), "x");
    expect(() => backup(root, dir)).toThrow("not empty");
  });
});
