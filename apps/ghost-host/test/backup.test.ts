import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_FORMAT, backup, type BackupManifest } from "../src/backup.ts";
import { sha256 } from "../src/core/ids.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { tempDir } from "./support.ts";

describe("ghost backup", () => {
  test("copies both databases while they are open for writing and lists external spaces", () => {
    const root = tempDir();
    const ledger = new Ledger(join(root, "ledger.db"));
    ledger.tx(() => ledger.putSpace({ id: "s1", name: "Notes", path: "/Users/someone/Notes", grants: [], createdAt: 1 }));
    const pi = new Database(join(root, "pi.db"));
    pi.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')");

    const dir = join(tempDir(), "snapshot");
    const manifest = backup(root, dir, 42);

    expect(manifest.format).toBe(BACKUP_FORMAT);
    expect(manifest.files.map((file) => file.path)).toEqual(["ledger.db", "pi.db"]);
    for (const file of manifest.files) expect(sha256(readFileSync(join(dir, file.path)))).toBe(file.sha256);
    expect(manifest.external_spaces).toEqual([{ path: "/Users/someone/Notes" }]);
    expect(JSON.parse(readFileSync(join(dir, "backup.json"), "utf8")) as BackupManifest).toEqual(manifest);
    const copy = new Database(join(dir, "pi.db"), { readonly: true });
    expect(copy.query("SELECT v FROM t").get()).toEqual({ v: "kept" });
    copy.close();
    pi.close();
    ledger.close();
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
