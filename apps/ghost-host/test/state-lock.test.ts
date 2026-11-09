import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openApp, serve, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { acquireRootLock } from "../src/state-lock.ts";
import { tempDir } from "./support.ts";

// Cross-process marker arrival needs the real OS event loop, not fake-clock advances.
async function until(path: string, limitMs = 10_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`${path} never appeared`);
}

function snapshot(root: string): string[] {
  return readdirSync(root).sort().map((name) => {
    const stats = statSync(join(root, name));
    return stats.isDirectory() ? `${name}/` : `${name}:${stats.size}:${stats.mtimeMs}`;
  });
}

describe("the state root lock", () => {
  test("same-process ownership is exclusive and close is idempotent", () => {
    const root = tempDir();
    const lock = acquireRootLock(root);
    try {
      expect(lock.root).toBe(realpathSync(root));
      expect(() => acquireRootLock(root)).toThrow("already owned");
    } finally {
      lock.close();
      lock.close();
    }
    acquireRootLock(root).close();
  });

  test("a failed ledger open releases ownership before opening Pi", async () => {
    const root = tempDir();
    writeFileSync(join(root, "ledger.db"), "this is not a database");
    await expect(openApp(loadConfig({}, root))).rejects.toThrow();
    expect(existsSync(join(root, "pi.db"))).toBe(false);
    acquireRootLock(root).close();
  });

  test("a failed Pi open cleans up the already-created core and permits reopening", async () => {
    const root = tempDir();
    writeFileSync(join(root, "pi.db"), "this is not a database");
    await expect(openApp(loadConfig({}, root))).rejects.toThrow();
    acquireRootLock(root).close();
    unlinkSync(join(root, "pi.db"));
    const reopened = await openApp(loadConfig({}, root));
    await reopened.close();
  });

  test("serve startup failure closes its open app and releases ownership", async () => {
    const root = tempDir();
    writeFileSync(join(root, "host.json"), "not valid JSON");
    await expect(serve(loadConfig({}, root))).rejects.toThrow();
    acquireRootLock(root).close();
    const reopened = await openApp(loadConfig({}, root));
    await reopened.close();
  });

  test("a second openApp is refused without touching stores or host.json", async () => {
    const root = tempDir();
    let app: App | undefined;
    try {
      app = await openApp(loadConfig({}, root));
      app.ledger.tx(() => app!.ledger.putSpace({ id: "s1", name: "Notes", path: "/Users/someone/Notes", createdAt: 1 }));
      const before = snapshot(root);
      await expect(openApp(loadConfig({}, root))).rejects.toThrow("already owned");
      expect(snapshot(root)).toEqual(before);
      expect(existsSync(join(root, "host.json"))).toBe(false);
      await Promise.all([app.close(), app.close()]);
      app = undefined;
      acquireRootLock(root).close();
    } finally {
      await app?.close();
    }
  });

  test("symlink and normalized aliases share ownership", async () => {
    const parent = tempDir();
    const real = join(parent, "real");
    const aliasA = join(parent, "alias-a");
    const aliasB = join(parent, "alias-b");
    mkdirSync(real);
    symlinkSync(real, aliasA);
    symlinkSync(real, aliasB);
    const app = await openApp(loadConfig({}, aliasA));
    try {
      await expect(openApp(loadConfig({}, `${real}/../real/.`))).rejects.toThrow("already owned");
      await expect(openApp(loadConfig({}, aliasB))).rejects.toThrow("already owned");
    } finally {
      await app.close();
    }
    const reopened = await openApp(loadConfig({}, aliasB));
    await reopened.close();
  });

  test("a catalog close failure does not skip closing the engine or releasing ownership", async () => {
    const root = tempDir();
    const app = await openApp(loadConfig({}, root));
    const closeCatalog = app.core.catalog.close.bind(app.core.catalog);
    app.core.catalog.close = async () => {
      await closeCatalog();
      throw new Error("catalog close failed");
    };
    try {
      await expect(app.close()).rejects.toThrow("failed to close");
      const reopened = await openApp(loadConfig({}, root));
      await reopened.close();
    } finally {
      app.core.catalog.close = closeCatalog;
      await app.close();
    }
  });

  test("an engine close failure retains ownership until a successful retry", async () => {
    const root = tempDir();
    const app = await openApp(loadConfig({}, root));
    const closeEngine = app.engine.close.bind(app.engine);
    app.engine.close = async () => { throw new Error("engine still live"); };
    try {
      await expect(app.close()).rejects.toThrow("failed to close");
      await expect(openApp(loadConfig({}, root))).rejects.toThrow("already owned");
      // The ledger stays usable while Pi has not been proven closed.
      expect(app.ledger.ghosts()).toEqual([]);
      app.engine.close = closeEngine;
      await app.close();
      acquireRootLock(root).close();
    } finally {
      app.engine.close = closeEngine;
      await app.close();
    }
  });

  test("the kernel releases ownership when a live holder is killed", async () => {
    const root = tempDir();
    const work = tempDir();
    const marker = join(work, "ready");
    const source = join(import.meta.dir, "..", "src", "state-lock.ts");
    const holder = join(work, "holder.ts");
    writeFileSync(holder, [
      `import { acquireRootLock } from ${JSON.stringify(source)};`,
      `import { writeFileSync } from "node:fs";`,
      `const lock = acquireRootLock(${JSON.stringify(root)});`,
      // A live OS-process handle is required here; fake timers cannot keep it alive.
      `setInterval(() => { void lock.root; }, 1000);`,
      `writeFileSync(${JSON.stringify(marker)}, "held");`,
    ].join("\n"));
    const child = Bun.spawn([process.execPath, holder], { stdout: "ignore", stderr: "inherit" });
    try {
      await until(marker);
      expect(child.exitCode).toBeNull();
      expect(() => acquireRootLock(root)).toThrow("already owned");
      child.kill("SIGKILL");
      await child.exited;
      acquireRootLock(root).close();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 15_000);
});
