import { afterEach, describe, expect, test, vi } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import fixture from "./fixtures/update-signature.json";
import { signingKey, updateFixture, type FixtureOptions, type UpdateFixture } from "./fixtures/update-helper.ts";
import { verifyMinisign } from "../src/update/signature.ts";
import { shutdownForUpdate, Updater } from "../src/update/index.ts";
import { sha256, validateTarball } from "../src/update/archive.ts";
import { atomicWrite } from "../src/update/storage.ts";
import { newer } from "../src/update/github.ts";

const fixtures: UpdateFixture[] = [];
async function setup(options: FixtureOptions = {}) {
  const value = await updateFixture(options); fixtures.push(value); return value;
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.updater.close(); rmSync(f.temp, { recursive: true, force: true }); } });

async function until(predicate: () => boolean) {
  // Integration polling exercises the real idle timer around platform tar subprocesses.
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await Bun.sleep(5); }
  throw new Error("condition did not settle");
}

/** A small ustar member used to exercise paths that platform tar refuses to create. */
function unsafeArchive(name: string, type = "0") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000755\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
  header.write("00000000000\0", 124); header.write("00000000000\0", 136);
  header.fill(32, 148, 156); header.write(type, 156); header.write("ustar\0", 257); header.write("00", 263);
  if (type === "2") header.write("/tmp/escape", 157);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
}

describe("minisign", () => {
  test("public fixture verifies; tampering, wrong keys, malformed signatures fail", () => {
    const bytes = Buffer.from(fixture.data);
    expect(verifyMinisign(fixture.pubkey, fixture.signature, bytes)).toBe(true);
    expect(verifyMinisign(fixture.pubkey, fixture.signature, Buffer.from(`${fixture.data}!`))).toBe(false);
    expect(verifyMinisign(signingKey().pubkey, fixture.signature, bytes)).toBe(false);
    for (const signature of ["", "not-base64", Buffer.from("bad\n").toString("base64")]) expect(verifyMinisign(fixture.pubkey, signature, bytes)).toBe(false);
    const key = signingKey();
    expect(verifyMinisign(key.pubkey, key.sign(bytes), bytes)).toBe(true);
  });
});

describe("checking", () => {
  test("newer verified releases offer host and shell; redirects never receive credentials", async () => {
    const f = await setup();
    const checking = f.updater.check();
    expect(f.updater.check()).toBe(checking);
    const status = await checking;
    expect(status.latest?.version).toBe("2.2.0");
    expect(status.shell?.version).toBe("0.3.0");
    expect(status.phase).toBe("idle");
    for (const call of f.calls) {
      expect(call.init?.redirect).toBe("manual");
      const headers = new Headers(call.init?.headers);
      expect(headers.get("user-agent")).toBe("Ghost-Updater");
      expect(headers.get("authorization")).toBe(call.url.startsWith("https://api.github.com") ? "Bearer test-token" : null);
    }
    expect(statSync(join(f.root, "secrets", "update-github.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.root, "secrets")).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.root, "update", "state.json")).mode & 0o777).toBe(0o600);
    const restarted = new Updater(f.updaterOptions);
    expect(restarted.status().latest?.version).toBe("2.2.0");
    await restarted.close();
  });
  test.each(["2.1.0", "1.9.0"])("same or older %s is not offered", async (version) => {
    const f = await setup({ version });
    expect((await f.updater.check()).latest).toBeNull();
    expect(f.updater.status().shell).not.toBeNull();
  });
  test("failure advances exponential backoff; success resets it", async () => {
    const f = await setup();
    f.updater.settings({ autoCheck: true }); f.setFailure(true);
    for (const minutes of [5, 10, 20, 40, 60, 60]) {
      const status = await f.updater.check();
      expect(status.phase).toBe("error"); expect(status.error).not.toBeNull();
      expect(status.nextCheckAt! - status.checkedAt!).toBe(minutes * 60_000);
    }
    f.setFailure(false);
    const status = await f.updater.check();
    expect(status.nextCheckAt! - status.checkedAt!).toBe(60 * 60_000);
    expect(status.error).toBeNull();
  });
  test("development, invalid layout, and missing credential make no fetches", async () => {
    const f = await setup(); f.calls.length = 0;
    const development = new Updater({ ...f.updaterOptions, repository: null });
    expect((await development.check()).disabledReason).toBe("development");
    const layout = new Updater({ ...f.updaterOptions, execPath: join(f.temp, "missing") });
    expect((await layout.check()).disabledReason).toBe("layout");
    f.updater.settings({ token: null });
    expect((await f.updater.check()).hasCredential).toBe(false);
    expect(f.calls).toHaveLength(0);
    await development.close(); await layout.close();
  });
  test("semver prereleases compare numerically", () => {
    expect(newer("2.10.0", "2.9.0")).toBe(true);
    expect(newer("2.1.0", "2.1.0-beta.2")).toBe(true);
    expect(newer("2.1.0-beta.10", "2.1.0-beta.2")).toBe(true);
    expect(newer("2.1.0-beta", "2.1.0")).toBe(false);
  });
});

describe("installation", () => {
  test.each(["test-storage", "different-storage"])("stage, wait, backup and swap (%s)", async (storage) => {
    let idle = false;
    const f = await setup({ storage, idle: () => idle });
    await f.updater.check();
    expect(f.updater.install("2.2.0").phase).toBe("downloading");
    expect(() => f.updater.install("2.2.0")).toThrow();
    await until(() => f.updater.status().phase === "waiting" || f.updater.status().phase === "error");
    expect(f.updater.status().error).toBeNull();
    expect(readlinkSync(join(f.base, "current"))).toBe(`releases/${f.oldName}`);
    const name = "2.2.0-new123";
    expect(existsSync(join(f.base, "releases", name, "ghost"))).toBe(true);
    expect(existsSync(join(f.base, "backups"))).toBe(false);
    idle = true; await f.updater.settled();
    expect(f.updater.status().error).toBeNull();
    expect(readlinkSync(join(f.base, "current"))).toBe(`releases/${name}`);
    const backups = readdirSync(join(f.base, "backups")); expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(f.base, "backups", backups[0]!, "backup.json"), "utf8")).complete).toBe(true);
    expect(readFileSync(join(f.root, "update", "pending"), "utf8")).toBe(`${f.oldName} ${storage === "test-storage" ? "yes" : "no"} ${name}\n`);
    expect(readFileSync(join(f.root, "update", "attempts"), "utf8")).toBe("0\n");
    expect(f.shutdowns).toBe(1);
  });
  test("cancel while waiting leaves current untouched and removes staged release", async () => {
    const f = await setup({ idle: () => false }); await f.updater.check(); f.updater.install("2.2.0");
    await until(() => f.updater.status().phase === "waiting" || f.updater.status().phase === "error");
    expect(f.updater.status().phase).toBe("waiting");
    expect((await f.updater.cancel()).phase).toBe("idle");
    expect(readlinkSync(join(f.base, "current"))).toBe(`releases/${f.oldName}`);
    expect(readdirSync(join(f.base, "releases"))).toEqual([f.oldName]);
    expect(f.shutdowns).toBe(0);
  });
  test("cancel is rejected during backup/installing", async () => {
    const gate = Promise.withResolvers<void>();
    const f = await setup({ backup: async () => gate.promise }); await f.updater.check(); f.updater.install("2.2.0");
    await until(() => f.updater.status().phase === "installing" || f.updater.status().phase === "error");
    expect(f.updater.status().phase).toBe("installing");
    await expect(f.updater.cancel()).rejects.toThrow("설치 중");
    gate.resolve(); await f.updater.settled();
  });
  test("busy after backup discards that backup and waits again", async () => {
    let checks = 0, backups = 0;
    const f = await setup({ idle: () => ++checks !== 2, backup: (_root, dir) => { backups++; mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "backup.json"), "{}"); } });
    await f.updater.check(); f.updater.install("2.2.0"); await f.updater.settled();
    expect(backups).toBe(2); expect(readdirSync(join(f.base, "backups"))).toHaveLength(1);
    expect(f.shutdowns).toBe(1);
  });
  test.each(["sha", "traversal", "absolute", "symlink", "release", "unlisted", "preflight"])("rejects %s and removes staging", async (kind) => {
    const f = await setup({ releaseMismatch: kind === "release", unlisted: kind === "unlisted", preflightVersion: kind === "preflight" ? "0.0.0" : undefined });
    if (kind === "sha") f.manifest.host.sha256 = "0".repeat(64);
    if (["traversal", "absolute", "symlink"].includes(kind)) {
      const bytes = unsafeArchive(kind === "traversal" ? "../escape" : kind === "absolute" ? "/escape" : "escape", kind === "symlink" ? "2" : "0");
      f.setTarball(bytes); f.manifest.host.sha256 = sha256(bytes); f.manifest.host.bytes = bytes.length;
    }
    await f.updater.check(); f.updater.install("2.2.0"); await f.updater.settled();
    expect(f.updater.status().phase).toBe("error"); expect(f.updater.status().error).not.toBeNull();
    expect(readlinkSync(join(f.base, "current"))).toBe(`releases/${f.oldName}`);
    expect(readdirSync(join(f.base, "releases"))).toEqual([f.oldName]);
    expect(f.shutdowns).toBe(0);
  });
  test("unsafe tar entries fail before extraction", async () => {
    for (const [path, type] of [["../evil", "0"], ["/evil", "0"], ["link", "2"], ["hard", "1"]]) await expect(validateTarball(unsafeArchive(path!, type!))).rejects.toThrow();
  });
});

describe("startup confirmation", () => {
  test.each(["installed", "failed", "rolled_back"])("records %s durably", async (outcome) => {
    const f = await setup();
    const target = outcome === "installed" ? f.oldName : "2.2.0-new123";
    atomicWrite(join(f.root, "update", "pending"), `previous yes ${target}\n`);
    atomicWrite(join(f.root, "update", "attempts"), "2\n");
    if (outcome === "rolled_back") atomicWrite(join(f.root, "update", "result.json"), JSON.stringify({ outcome, from: "previous", to: target, at: 123 }));
    f.updater.confirmStartup();
    expect(f.updater.status().lastResult?.outcome).toBe(outcome);
    expect(existsSync(join(f.root, "update", "pending"))).toBe(false);
    expect(existsSync(join(f.root, "update", "attempts"))).toBe(false);
    expect(existsSync(join(f.root, "update", "result.json"))).toBe(false);
    const restarted = new Updater(f.updaterOptions); expect(restarted.status().lastResult?.outcome).toBe(outcome); await restarted.close();
  });
});

describe("crash and service safeguards", () => {
  test("construction removes abandoned staging/downloads and reinstall replaces an abandoned release", async () => {
    const f = await setup();
    const releases = join(f.base, "releases");
    mkdirSync(join(releases, ".staging-crash"));
    writeFileSync(join(releases, ".staging-crash", "partial"), "partial");
    writeFileSync(join(releases, ".download-crash.tar.gz"), "partial");
    const target = join(releases, "2.2.0-new123");
    mkdirSync(target); writeFileSync(join(target, "stale"), "old attempt");
    const restarted = new Updater(f.updaterOptions);
    expect(existsSync(join(releases, ".staging-crash"))).toBe(false);
    expect(existsSync(join(releases, ".download-crash.tar.gz"))).toBe(false);
    expect(existsSync(join(f.old, "ghost"))).toBe(true);
    await restarted.close();
    await f.updater.check(); f.updater.install("2.2.0"); await f.updater.settled();
    expect(f.updater.status().error).toBeNull();
    expect(existsSync(join(target, "stale"))).toBe(false);
    expect(f.shutdowns).toBe(1);
  });

  test("unmanaged release is disabled and makes no requests", async () => {
    const f = await setup();
    const manual = new Updater({ ...f.updaterOptions, env: {} });
    expect(manual.status().disabledReason).toBe("service");
    expect(manual.status().enabled).toBe(false);
    await manual.check(); expect(f.calls).toHaveLength(0);
    expect(() => manual.install("2.2.0")).toThrow("업데이트를 사용할 수 없습니다.");
    await manual.close();
  });

  test.each([2, 10])("partial backups are removed and consecutive failures are bounded (%s)", async (failures) => {
    let attempts = 0;
    const f = await setup({ backup: (_root, destination) => {
      attempts++;
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, "partial"), "partial");
      if (attempts <= failures) throw new Error("database busy");
    } });
    await f.updater.check(); f.updater.install("2.2.0"); await f.updater.settled();
    if (failures === 10) {
      expect(attempts).toBe(10); expect(f.updater.status().phase).toBe("error");
      expect(f.updater.status().error).toContain("백업을 완료하지 못했습니다");
      expect(readdirSync(join(f.base, "backups"))).toHaveLength(0);
      expect(readlinkSync(join(f.base, "current"))).toBe(`releases/${f.oldName}`);
    } else {
      expect(attempts).toBe(3); expect(f.shutdowns).toBe(1);
      expect(readdirSync(join(f.base, "backups"))).toHaveLength(1);
    }
  });

  test("startup keeps pending throughout a 60-second soak; close cancels confirmation", async () => {
    const f = await setup();
    atomicWrite(join(f.root, "update", "pending"), `previous yes ${f.oldName}\n`);
    const timer = setTimeout(() => {}, 60_000); clearTimeout(timer);
    const callbacks: (() => void)[] = [];
    const scheduled = vi.spyOn(globalThis, "setTimeout").mockImplementation(Object.assign((callback: TimerHandler, delay?: number) => {
      expect(delay).toBe(60_000);
      callbacks.push(() => { if (typeof callback === "function") callback(); });
      return timer;
    }, { __promisify__: setTimeout.__promisify__ }) as unknown as typeof setTimeout);
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    try {
      f.updater.start();
      expect(existsSync(join(f.root, "update", "pending"))).toBe(true);
      expect(f.updater.status().lastResult).toBeNull();
      callbacks[0]!();
      expect(f.updater.status().lastResult?.outcome).toBe("installed");
      expect(existsSync(join(f.root, "update", "pending"))).toBe(false);
      atomicWrite(join(f.root, "update", "pending"), `previous yes ${f.oldName}\n`);
      const restarted = new Updater(f.updaterOptions);
      restarted.start(); cleared.mockClear(); await restarted.close();
      expect(cleared).toHaveBeenCalledWith(timer);
      expect(existsSync(join(f.root, "update", "pending"))).toBe(true);
    } finally { scheduled.mockRestore(); cleared.mockRestore(); }
  });

  test("update shutdown signals immediately and forces launchd restart after its deadline", () => {
    const calls: (string | number)[] = [];
    const timer = setTimeout(() => {}, 60_000); clearTimeout(timer);
    let expire = () => {};
    const scheduled = vi.spyOn(globalThis, "setTimeout").mockImplementation(Object.assign((callback: TimerHandler, delay?: number) => {
      expect(delay).toBe(60_000);
      expire = () => { if (typeof callback === "function") callback(); };
      return timer;
    }, { __promisify__: setTimeout.__promisify__ }) as unknown as typeof setTimeout);
    try {
      shutdownForUpdate(() => { calls.push("SIGTERM"); }, (code) => { calls.push(code); });
      expect(calls).toEqual(["SIGTERM"]);
      expire(); expect(calls).toEqual(["SIGTERM", 75]);
    } finally { scheduled.mockRestore(); }
  });

  test.each(["state", "credential", "manifest", "result"])("corrupt optional %s never prevents startup", async (kind) => {
    const f = await setup(), logged: string[] = [];
    if (kind === "state") atomicWrite(join(f.root, "update", "state.json"), '{"autoCheck":"bad"}');
    if (kind === "credential") atomicWrite(join(f.root, "secrets", "update-github.json"), "null");
    if (kind === "manifest") atomicWrite(join(f.root, "update", "state.json"), JSON.stringify({ autoCheck: false, checkedAt: null, failures: 0, manifest: "not json", signature: "bad signature" }));
    if (kind === "result") atomicWrite(join(f.root, "update", "result.json"), "null");
    const restarted = new Updater({ ...f.updaterOptions, log: (message) => { logged.push(message); } });
    expect(() => restarted.confirmStartup()).not.toThrow();
    expect(logged.length).toBeGreaterThan(0);
    expect(restarted.status().latest).toBeNull();
    if (kind === "state") expect(restarted.status().autoCheck).toBe(true);
    if (kind === "credential") expect(restarted.status().hasCredential).toBe(false);
    if (kind === "result") expect(existsSync(join(f.root, "update", "result.json"))).toBe(false);
    await restarted.close();
  });
});
