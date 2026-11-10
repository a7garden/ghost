import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateFixture } from "./fixtures/update-helper.ts";
import { installService, launcherScript } from "../src/update/service.ts";
import { atomicWrite } from "../src/update/storage.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() { const f = await updateFixture(); roots.push(f.temp); await f.updater.close(); return f; }

async function run(script: string) {
  const child = Bun.spawn(["/bin/sh", script], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}

test.each([true, false])("launcher records outcome after four starts, rollback=%s", async (rollback) => {
  const f = await fixture();
  const next = "2.2.0-new123", previous = f.oldName;
  mkdirSync(join(f.base, "releases", next));
  writeFileSync(join(f.base, "releases", next, "ghost"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  rmSync(join(f.base, "current")); symlinkSync(`releases/${next}`, join(f.base, "current"));
  const { launcher } = await installService({ root: f.root, home: join(f.temp, "home"), execPath: join(f.base, "releases", next, "ghost"), noLoad: true, launchctl: async () => { throw new Error("launchctl must not run"); } });
  atomicWrite(join(f.root, "update", "pending"), `${previous} ${rollback ? "yes" : "no"} ${next}\n`);
  for (let i = 0; i < 4; i++) {
    expect((await run(launcher)).code).toBe(1);
    if (i < 3) expect(readFileSync(join(f.root, "update", "attempts"), "utf8")).toBe(`${i + 1}\n`);
  }
  expect(readlinkSync(join(f.base, "current"))).toBe(`releases/${rollback ? previous : next}`);
  const result = JSON.parse(readFileSync(join(f.root, "update", "result.json"), "utf8"));
  expect(result).toMatchObject({ outcome: rollback ? "rolled_back" : "failed", from: previous, to: next });
  expect(result.at).toBeGreaterThan(0);
  expect(existsSync(join(f.root, "update", "pending"))).toBe(false);
  expect(existsSync(join(f.root, "update", "attempts"))).toBe(false);
});

test("service writes escaped paths, plist and CLI link; launchctl uses argument vectors", async () => {
  const f = await fixture();
  const root = join(f.temp, "state ' <&>"), home = join(f.temp, "home ' <&>");
  mkdirSync(root);
  const calls: string[][] = [];
  // The old Host is still unloading for two polls, and the first bootstrap hits launchd's EIO.
  let unloading = 2, bootstraps = 0;
  const launchctl = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "bootout") return { code: 0, stderr: "" };
    if (args[0] === "print") return { code: unloading-- > 0 ? 0 : 113, stderr: "" };
    return { code: bootstraps++ === 0 ? 5 : 0, stderr: "Bootstrap failed: 5: Input/output error" };
  };
  const result = await installService({ root, home, execPath: join(f.old, "ghost"), uid: 501, launchctl, sleep: async () => {} });
  const print = ["print", "gui/501/com.a7.ghost"], bootstrap = ["bootstrap", "gui/501", result.plist];
  expect(calls).toEqual([["bootout", "gui/501/com.a7.ghost"], print, print, print, bootstrap, bootstrap]);
  expect(readlinkSync(result.link)).toBe(join(f.base, "current", "ghost"));
  expect(statSync(result.launcher).mode & 0o777).toBe(0o755);
  const plist = readFileSync(result.plist, "utf8");
  expect(plist).toContain("&apos; &lt;&amp;&gt;");
  expect(plist).toContain("<integer>63</integer>");
  const recorded = join(root, "argv");
  writeFileSync(join(f.old, "ghost"), `#!/bin/sh\nprintf '%s\\n' "$GHOST_ROOT" "$GHOST_SERVICE" "$@" > "$GHOST_ROOT/argv"\n`, { mode: 0o755 });
  expect((await run(result.launcher)).code).toBe(0);
  expect(readFileSync(recorded, "utf8")).toBe(`${root}\nlaunchd\nserve\n`);
});

test("service never overwrites a real CLI executable", async () => {
  const f = await fixture(), home = join(f.temp, "home");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const path = join(home, ".local", "bin", "ghost"); writeFileSync(path, "owner binary");
  await expect(installService({ root: f.root, home, execPath: join(f.old, "ghost"), noLoad: true })).rejects.toThrow("not a symlink");
  expect(readFileSync(path, "utf8")).toBe("owner binary");
});

test("launcher drops an untrusted pending record before path use and still starts the current release", async () => {
  const f = await fixture(), script = join(f.temp, "launch");
  writeFileSync(script, launcherScript(f.base, f.root));
  const current = readlinkSync(join(f.base, "current"));
  writeFileSync(join(f.old, "ghost"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$GHOST_ROOT/argv"\n`, { mode: 0o755 });
  atomicWrite(join(f.root, "update", "pending"), "../outside yes target\n");
  expect((await run(script)).code).toBe(0);
  expect(readFileSync(join(f.root, "argv"), "utf8")).toBe("serve\n");
  expect(readlinkSync(join(f.base, "current"))).toBe(current);
  expect(existsSync(join(f.root, "update", "pending"))).toBe(false);
  expect(existsSync(join(f.root, "update", "attempts"))).toBe(false);
});

test.each(["08", "00000000"])("launcher accepts leading-zero attempts %s", async (attempts) => {
  const f = await fixture(), script = join(f.temp, "launch");
  writeFileSync(script, launcherScript(f.base, f.root));
  atomicWrite(join(f.root, "update", "pending"), `previous no ${f.oldName}\n`);
  atomicWrite(join(f.root, "update", "attempts"), `${attempts}\n`);
  expect((await run(script)).code).toBe(1);
  if (attempts === "08") {
    expect(JSON.parse(readFileSync(join(f.root, "update", "result.json"), "utf8")).outcome).toBe("failed");
    expect(existsSync(join(f.root, "update", "pending"))).toBe(false);
  } else expect(readFileSync(join(f.root, "update", "attempts"), "utf8")).toBe("1\n");
});
