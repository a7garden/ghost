import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ExecutionEnv, ShellExecOptions } from "@earendil-works/pi-durable/env";
import type { Work } from "@ghost/contract";
import { openApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { updateGhost } from "../src/core/commands.ts";
import { Core } from "../src/core/core.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { HostExecutionEnv, HOST_OUTPUT_LIMIT } from "../src/sandbox/host-env.ts";
import { CONTAINER_IMAGE, createSandbox, validateExecutionTarget, type SandboxService } from "../src/sandbox/index.ts";
import { FakeEngine, MemoryArtifacts, MemorySecrets } from "./support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(kind: Config["sandbox"] = { kind: "local" }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ghost-host-execution-")));
  const cwd = join(root, "pc-project");
  mkdirSync(cwd);
  const config: Config = {
    root: join(root, "state"), host: "127.0.0.1", port: 62062,
    publicOrigin: null, uiDir: null, sandbox: kind,
    voice: null, apns: null, skills: null, reach: null, browser: null,
  };
  const id = `work-${crypto.randomUUID()}`;
  const work: Work = {
    id, rootId: id, parentId: null, ghostId: "ghost-pc", originConversationId: "direct-pc", conversationId: null,
    title: "PC execution", brief: "Operate on the actual PC project", acceptance: { criteria: "", checks: [], reviewer: null },
    state: "running", revision: 1, revisionsUsed: 0, deadlineAt: null, budgetMinutes: 90, budgetUsedMs: 0, budgetSince: null, budgetExtended: false, hold: null, result: null, verdict: null, reason: null,
    createdAt: 0, startedAt: null, endedAt: null, updatedAt: 0, execution: { kind: "host", cwd },
  };
  const artifacts = new MemoryArtifacts();
  const sandbox = createSandbox(config, artifacts);
  const environments: ExecutionEnv[] = [];
  cleanups.push(async () => {
    await Promise.all(environments.map((env) => env.cleanup(BACKGROUND_CONTEXT)));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, cwd, config, work, artifacts, sandbox,
    async open(target = work, authorize?: () => string) {
      const env = await sandbox.envFor(target, authorize);
      environments.push(env);
      return env;
    },
  };
}

async function capture(env: ExecutionEnv, command: string | readonly string[], options?: ShellExecOptions, context: Context = BACKGROUND_CONTEXT) {
  let stdout = "";
  let stderr = "";
  const result = await env.exec(command, {
    ...options,
    onOutput(text, ctx, info) {
      if (info.stream === "stdout") stdout += text;
      else stderr += text;
      options?.onOutput?.(text, ctx, info);
    },
  }, context);
  return { result, stdout, stderr };
}

describe("explicit PC execution", () => {
  test("reads, edits and executes in the real cwd, independently of artifact staging", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "owner.txt"), "before");
    const env = await f.open();
    expect(env instanceof HostExecutionEnv).toBe(true);
    expect((await env.absolutePath("owner.txt", BACKGROUND_CONTEXT))).toEqual({ ok: true, value: join(f.cwd, "owner.txt") });
    expect(await env.readTextFile("owner.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "before" });
    expect((await env.writeFile("owner.txt", "edited", BACKGROUND_CONTEXT)).ok).toBe(true);
    const ran = await capture(env, "printf '%s\\n' \"$PWD\"; cat owner.txt; printf shell > generated.txt");
    expect(ran.result.ok && ran.result.value.exitCode).toBe(0);
    expect(ran.stdout).toBe(`${f.cwd}\nedited`);
    expect(readFileSync(join(f.cwd, "owner.txt"), "utf8")).toBe("edited");
    expect(readFileSync(join(f.cwd, "generated.txt"), "utf8")).toBe("shell");
    const staging = f.sandbox.workspacePath(f.work);
    expect(staging).not.toBe(f.cwd);
    expect(existsSync(join(staging, "owner.txt"))).toBe(false);
    // Host is deliberately not a confined file namespace; absolute paths and symlinks work.
    const outside = join(f.root, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(f.cwd, "linked.txt"));
    expect(await env.readTextFile("linked.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "outside" });
    expect((await env.writeFile(outside, "changed", BACKGROUND_CONTEXT)).ok).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("changed");
    expect((await capture(env, ["/bin/cat", "owner.txt"])).stdout).toBe("edited");
  });

  test("explicit Host bypasses the container driver even with unavailable container CLI", async () => {
    const f = fixture({ kind: "apple-container", cli: "/ghost-missing/container", image: CONTAINER_IMAGE });
    const env = await f.open();
    const ran = await capture(env, "printf pc");
    expect(ran.result.ok && ran.result.value.exitCode).toBe(0);
    expect(ran.stdout).toBe("pc");
    await f.sandbox.release(f.work); // Must not try to list/delete a nonexistent container.
    expect(existsSync(f.cwd)).toBe(true);
  });

  test("container without Apple keeps confined files usable but never falls back to a Host shell", async () => {
    const f = fixture();
    const containerWork: Work = { ...f.work, execution: { kind: "container" } };
    const container = await f.open(containerWork);
    const staging = f.sandbox.workspacePath(containerWork);
    expect(container.cwd).toBe("/workspace");
    expect((await container.writeFile("/workspace/container.txt", "confined", BACKGROUND_CONTEXT)).ok).toBe(true);
    expect(await container.readTextFile("container.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "confined" });
    expect(readFileSync(join(staging, "container.txt"), "utf8")).toBe("confined");
    expect((await container.writeFile(join(f.cwd, "pc-file"), "no", BACKGROUND_CONTEXT)).ok).toBe(false);
    symlinkSync(f.cwd, join(staging, "escape"));
    expect((await container.writeFile("escape/pc-file", "no", BACKGROUND_CONTEXT)).ok).toBe(false);
    const canary = join(f.cwd, "host-shell-canary");
    const refused = await capture(container, `printf unsafe > ${JSON.stringify(canary)}`);
    expect(!refused.result.ok && refused.result.error.code).toBe("shell_unavailable");
    expect(refused.stdout).toBe("");
    expect(existsSync(canary)).toBe(false);
    const direct = (await capture(container, ["/usr/bin/touch", canary])).result;
    expect(!direct.ok && direct.error.code).toBe("shell_unavailable");
    expect(existsSync(canary)).toBe(false);
  });

  test("omitted execution preserves the legacy local workspace", async () => {
    const f = fixture();
    const legacy = { ...f.work, execution: undefined };
    const env = await f.open(legacy);
    const staging = f.sandbox.workspacePath(legacy);
    expect((await env.writeFile("legacy.txt", "workspace", BACKGROUND_CONTEXT)).ok).toBe(true);
    expect(readFileSync(join(staging, "legacy.txt"), "utf8")).toBe("workspace");
    expect(existsSync(join(f.cwd, "legacy.txt"))).toBe(false);
    expect((await env.readTextFile(join(f.cwd, "owner.txt"), BACKGROUND_CONTEXT)).ok).toBe(false);
  });

  test("cwd validation refuses relative, absent and non-directory targets without creating them", async () => {
    const f = fixture();
    expect(() => validateExecutionTarget({ kind: "host", cwd: "relative" })).toThrow(/absolute/);
    const missing = join(f.cwd, "missing");
    await expect(f.open({ ...f.work, execution: { kind: "host", cwd: missing } })).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
    const file = join(f.cwd, "file.txt");
    writeFileSync(file, "not a directory");
    expect(() => validateExecutionTarget({ kind: "host", cwd: file })).toThrow(/directory/);
    expect(() => validateExecutionTarget({ kind: "container" })).not.toThrow();
  });

  test("serializes shell and file mutations across different Works and Ghosts", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "value"), "before");
    const first = await f.open();
    const second = await f.open({ ...f.work, id: "other-work", ghostId: "other-ghost" });
    const ready = Promise.withResolvers<void>();
    const running = capture(first, "printf ready; while ! test -f release; do sleep 0.01; done; cat value > observed", {
      onOutput(text) { if (text.includes("ready")) ready.resolve(); },
    });
    await ready.promise;
    const write = second.writeFile("value", "after", BACKGROUND_CONTEXT);
    const following = capture(second, "cat value");
    writeFileSync(join(f.cwd, "release"), "release process barrier");
    expect((await running).result.ok).toBe(true);
    expect((await write).ok).toBe(true);
    expect((await following).stdout).toBe("after");
    expect(readFileSync(join(f.cwd, "observed"), "utf8")).toBe("before");
  });

  test("cancelled queued mutations settle promptly and cannot let later callers bypass a running command", async () => {
    const f = fixture();
    const env = await f.open();
    const ready = Promise.withResolvers<void>();
    const running = capture(env, "printf ready; while ! test -f release; do sleep 0.01; done; printf done > order", {
      onOutput() { ready.resolve(); },
    });
    await ready.promise;
    const controller = new AbortController();
    const queued = env.writeFile("cancelled", "never", withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    controller.abort();
    const result = await queued;
    expect(!result.ok && result.error.code).toBe("aborted");
    const next = env.appendFile("order", "+next", BACKGROUND_CONTEXT);
    writeFileSync(join(f.cwd, "release"), "release process barrier");
    await running;
    expect((await next).ok).toBe(true);
    expect(readFileSync(join(f.cwd, "order"), "utf8")).toBe("done+next");
    expect(existsSync(join(f.cwd, "cancelled"))).toBe(false);
  });

  test("queued file and shell mutations reject changed permission stamps without performing IO", async () => {
    const f = fixture();
    let stamp = "owner-grant:activity-revision-1";
    const env = await f.open(f.work, () => stamp);
    const ready = Promise.withResolvers<void>();
    const running = capture(env, "printf ready; while ! test -f release; do sleep 0.01; done", {
      onOutput() { ready.resolve(); },
    });
    await ready.promise;
    const file = env.writeFile("stale-write", "must-not-write", BACKGROUND_CONTEXT);
    const shell = capture(env, "printf stale > stale-shell");
    stamp = "owner-grant:activity-revision-2";
    writeFileSync(join(f.cwd, "release"), "release process barrier");
    await running;
    const write = await file;
    expect(!write.ok && write.error.code).toBe("permission_denied");
    const execution = (await shell).result;
    expect(!execution.ok && execution.error.message).toContain("permission denied");
    expect(existsSync(join(f.cwd, "stale-write"))).toBe(false);
    expect(existsSync(join(f.cwd, "stale-shell"))).toBe(false);
    // A newly admitted operation obtains the new stamp rather than keeping an env-lifetime grant.
    expect((await capture(env, "printf current")).stdout).toBe("current");
  });

  test("revoked permission blocks reads, already-open readers and new mutations", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "owner.txt"), "private");
    let allowed = true;
    const env = await f.open(f.work, () => {
      if (!allowed) throw new Error("Owner revoked PC execution");
      return "owner-grant";
    });
    const binary = await env.openBinaryReader("owner.txt", undefined, BACKGROUND_CONTEXT);
    const text = await env.openTextLineReader("owner.txt", BACKGROUND_CONTEXT);
    const dir = await env.openDirReader(".", BACKGROUND_CONTEXT);
    if (!binary.ok || !text.ok || !dir.ok) throw new Error("Expected authorized readers");
    try {
      allowed = false;
      const read = await env.readTextFile("owner.txt", BACKGROUND_CONTEXT);
      expect(!read.ok && read.error.code).toBe("permission_denied");
      const binaryRead = await binary.value.read(0, 7, BACKGROUND_CONTEXT);
      expect(!binaryRead.ok && binaryRead.error.code).toBe("permission_denied");
      const textRead = await text.value.readLine(BACKGROUND_CONTEXT);
      expect(!textRead.ok && textRead.error.code).toBe("permission_denied");
      const directoryRead = await dir.value.next(1, BACKGROUND_CONTEXT);
      expect(!directoryRead.ok && directoryRead.error.code).toBe("permission_denied");
      const write = await env.writeFile("blocked", "never", BACKGROUND_CONTEXT);
      expect(!write.ok && write.error.code).toBe("permission_denied");
      const shell = (await capture(env, "printf blocked > blocked-shell")).result;
      expect(!shell.ok && shell.error.message).toContain("permission denied");
      expect(existsSync(join(f.cwd, "blocked"))).toBe(false);
      expect(existsSync(join(f.cwd, "blocked-shell"))).toBe(false);
    } finally {
      await Promise.all([
        binary.value.close(BACKGROUND_CONTEXT),
        text.value.close(BACKGROUND_CONTEXT),
        dir.value.close(BACKGROUND_CONTEXT),
      ]);
    }
  });
  for (const grant of ["hostExecution", "bash"] as const) {
    test(`revoking ${grant} kills active PC descendants and queued mutations even behind a stalled Work lane`, async () => {
      const f = fixture();
      const ledger = new Ledger(":memory:");
      const core = new Core({ ledger, artifacts: f.artifacts, sandbox: f.sandbox, secrets: new MemorySecrets(), log: () => {} });
      const engine = new FakeEngine();
      core.attach(engine);
      const lane = Promise.withResolvers<void>();
      cleanups.push(async () => { lane.resolve(); core.stop(); await core.idle(); ledger.close(); });
      const ghost = core.createGhost({ name: "PC worker", persona: "", hostExecution: true, tools: ["bash", "write"] });
      const created = core.works.createRoot({
        ghostId: ghost.id, title: "Run in the owner project", brief: "Exercise live authority",
        originConversationId: ghost.directConversationId, execution: { kind: "host", cwd: f.cwd },
      });
      await core.idle();
      const work = ledger.work(created.id);
      const env = await f.open(work);
      const ready = Promise.withResolvers<void>();
      const running = capture(env, "printf completed > completed; (while ! test -f release; do sleep 0.01; done; printf leaked > child-after) & printf ready; while ! test -f release; do sleep 0.01; done; printf leaked > shell-after; wait", {
        onOutput() { ready.resolve(); },
      });
      await ready.promise;
      const queuedFile = env.writeFile("queued-file", "must not run", BACKGROUND_CONTEXT);
      const queuedShell = capture(env, "printf leaked > queued-shell");
      const entered = Promise.withResolvers<void>();
      const stalled = core.run(`work:${work.id}`, () => { entered.resolve(); return lane.promise; });
      await entered.promise;
      updateGhost(core, ghost.id, grant === "hostExecution" ? { hostExecution: false } : { tools: ["write"] });
      expect(ledger.work(work.id).state).toBe("cancelled");
      const stopped = (await running).result;
      expect(!stopped.ok && stopped.error.code).toBe("aborted");
      expect((await queuedFile).ok).toBe(false);
      expect((await queuedShell).result.ok).toBe(false);
      // Cancellation must not pretend to roll back the write completed before revocation.
      expect(readFileSync(join(f.cwd, "completed"), "utf8")).toBe("completed");
      expect(ledger.work(work.id).execution).toEqual({ kind: "host", cwd: f.cwd });
      // Other owners still use the same global FIFO; a revoked Work must not strand it.
      const other = await f.open({ ...f.work, id: "unrelated-work", ghostId: "unrelated-ghost" });
      expect((await capture(other, "printf usable > unrelated")).result.ok).toBe(true);
      lane.resolve();
      await stalled;
      await core.idle();
      expect(engine.aborted).toContain(work.conversationId!);
      writeFileSync(join(f.cwd, "release"), "released after cancellation drained");
      // Real shell descendants use the OS clock; fake JS timers cannot expose a leaked child write.
      await Bun.sleep(100);
      for (const path of ["child-after", "shell-after", "queued-file", "queued-shell"]) expect(existsSync(join(f.cwd, path))).toBe(false);
      expect(readFileSync(join(f.cwd, "unrelated"), "utf8")).toBe("usable");
    });
  }

  test("abort kills shell children and leaves the mutation queue usable", async () => {
    const f = fixture();
    const env = await f.open();
    const ready = Promise.withResolvers<void>();
    const controller = new AbortController();
    const running = capture(env, "(sleep 0.25; printf leaked > leaked) & printf ready; wait", {
      onOutput() { ready.resolve(); },
    }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    await ready.promise;
    controller.abort();
    const result = (await running).result;
    expect(!result.ok && result.error.code).toBe("aborted");
    expect((await env.writeFile("after-cancel", "yes", BACKGROUND_CONTEXT)).ok).toBe(true);
    // Exercise real OS process-group cleanup: a fake JS clock cannot drive a shell descendant.
    await Bun.sleep(300);
    expect(existsSync(join(f.cwd, "leaked"))).toBe(false);
  });

  test("successful shell exit also cleans up background descendants", async () => {
    const f = fixture();
    const env = await f.open();
    const ran = await capture(env, "(sleep 0.25; printf leaked > leaked) & printf done");
    expect(ran.result.ok && ran.result.value.exitCode).toBe(0);
    // Let the real descendant's marker deadline pass; fake timers cannot advance its OS clock.
    await Bun.sleep(300);
    expect(existsSync(join(f.cwd, "leaked"))).toBe(false);
  });

  test("command timeout and Work deadline fail with timeout rather than successful exit", async () => {
    // Real deadlines deliberately exercise platform process termination, not a JS timer mock.
    const f = fixture();
    const env = await f.open();
    const timed = await capture(env, "sleep 30", { timeout: 0.05 });
    expect(!timed.result.ok && timed.result.error.code).toBe("timeout");
    const expiring = await f.open({ ...f.work, id: "deadline-work", deadlineAt: Date.now() + 60 });
    const expired = await capture(expiring, "sleep 30");
    expect(!expired.result.ok && expired.result.error.code).toBe("timeout");
    expect((await capture(env, "printf alive")).stdout).toBe("alive");
  });

  test("release aborts active and queued operations, never deletes the owner's cwd", async () => {
    const f = fixture();
    const env = await f.open();
    const ready = Promise.withResolvers<void>();
    const running = capture(env, "printf ready; sleep 30", { onOutput() { ready.resolve(); } });
    await ready.promise;
    const queued = env.writeFile("queued", "never", BACKGROUND_CONTEXT);
    await f.sandbox.release(f.work);
    expect(!(await running).result.ok).toBe(true);
    const write = await queued;
    expect(!write.ok && write.error.code).toBe("aborted");
    expect(existsSync(f.cwd)).toBe(true);
    expect(existsSync(join(f.cwd, "queued"))).toBe(false);
  });

  test("sandbox close aborts all Host environments and queued mutations without consulting Apple containers", async () => {
    const f = fixture({ kind: "apple-container", cli: "/ghost-missing/container", image: CONTAINER_IMAGE });
    const first = await f.open();
    const second = await f.open({ ...f.work, id: "other-work", ghostId: "other-ghost" });
    let disposals = 0;
    const cleanup = first.cleanup.bind(first);
    first.cleanup = async (context) => { disposals += 1; await cleanup(context); };
    const ready = Promise.withResolvers<void>();
    const running = capture(first, "printf ready; sleep 30", { onOutput() { ready.resolve(); } });
    await ready.promise;
    const queued = second.writeFile("shutdown-write", "never", BACKGROUND_CONTEXT);
    await Promise.all([f.sandbox.close(), f.sandbox.release(f.work)]);
    expect(disposals).toBe(1);
    expect(!(await running).result.ok).toBe(true);
    const write = await queued;
    expect(!write.ok && write.error.code).toBe("aborted");
    expect(existsSync(join(f.cwd, "shutdown-write"))).toBe(false);
    expect(existsSync(f.cwd)).toBe(true);
    await expect(f.open()).rejects.toThrow("closed");
    await expect(f.open({ ...f.work, execution: { kind: "container" } })).rejects.toThrow("closed");
    await f.sandbox.close();
    expect(disposals).toBe(1);
  });

  test("app close aborts Host I/O before draining lanes and still closes source connections and vault", async () => {
    const f = fixture();
    const app = await openApp(f.config);
    cleanups.push(() => app.close());
    const sources = app.core.activitySources;
    if (!sources) throw new Error("App did not initialize source connections");
    const order: string[] = [];
    const closeSources = sources.close.bind(sources);
    const closeEngine = app.engine.close.bind(app.engine);
    const closeVault = app.vault.close.bind(app.vault);
    sources.close = async () => { order.push("sources"); await closeSources(); };
    app.engine.close = async () => { order.push("engine"); await closeEngine(); };
    app.vault.close = () => { order.push("vault"); closeVault(); };
    const sandbox = app.core.sandbox as SandboxService;
    const env = await sandbox.envFor(f.work);
    const ready = Promise.withResolvers<void>();
    const running = capture(env, "printf ready; sleep 30", { onOutput() { ready.resolve(); } });
    const lane = app.core.run("host-shutdown", async () => { await running; });
    await ready.promise;
    await app.close();
    await lane;
    expect(!(await running).result.ok).toBe(true);
    expect(order).toEqual(["sources", "engine", "vault"]);
    await expect(sandbox.envFor(f.work)).rejects.toThrow("closed");
    expect(existsSync(f.cwd)).toBe(true);
  });

  test("does not inherit Host secrets or shell startup variables, even when inheritEnv is requested", async () => {
    const f = fixture();
    const env = await f.open();
    const previous = process.env.GHOST_PC_EXECUTION_SECRET;
    const previousStartup = process.env.BASH_ENV;
    const startup = join(f.cwd, "inherited-startup.sh");
    writeFileSync(startup, "printf inherited > startup-leaked");
    process.env.BASH_ENV = startup;
    process.env.GHOST_PC_EXECUTION_SECRET = "must-not-inherit";
    try {
      const ran = await capture(env, "printf '%s:%s' \"${GHOST_PC_EXECUTION_SECRET-unset}\" \"$PC_CALL_VALUE\"", {
        inheritEnv: true, env: { PC_CALL_VALUE: "explicit" },
      });
      expect(ran.stdout).toBe("unset:explicit");
      expect(existsSync(join(f.cwd, "startup-leaked"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GHOST_PC_EXECUTION_SECRET;
      else process.env.GHOST_PC_EXECUTION_SECRET = previous;
      if (previousStartup === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = previousStartup;
    }
  });

  test("caps delivered output and spill storage, failing and cleaning up a noisy command", async () => {
    const f = fixture();
    const env = await f.open();
    let bytes = 0;
    const result = await env.exec("yes noisy", {
      timeout: 5, spill: { afterBytes: 1024, afterLines: 100 },
      onOutput(text) { bytes += Buffer.byteLength(text); },
    }, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain("output exceeded");
    expect(bytes).toBeLessThanOrEqual(HOST_OUTPUT_LIMIT);
    if (result.ok) throw new Error("Expected an output-limit failure");
    expect(result.error.spillPath).toBeDefined();
    expect(statSync(result.error.spillPath!).size).toBeLessThanOrEqual(HOST_OUTPUT_LIMIT);
    expect((await capture(env, "printf alive")).stdout).toBe("alive");
  });

  test("invalid UTF-8 cannot expand delivered output beyond the decoded output cap", async () => {
    const f = fixture();
    const env = await f.open();
    let bytes = 0;
    const result = await env.exec(
      [process.execPath, "-e", `process.stdout.write(Buffer.alloc(${HOST_OUTPUT_LIMIT / 2}, 255))`],
      { timeout: 5, onOutput(text) { bytes += Buffer.byteLength(text); } },
      BACKGROUND_CONTEXT,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain("decoded output exceeded");
    expect(bytes).toBeLessThanOrEqual(HOST_OUTPUT_LIMIT);
  });

  test("keeps spills and child inputs in safe staging and refuses planted staging symlinks", async () => {
    const f = fixture();
    const env = await f.open();
    const staged = f.sandbox.workspacePath(f.work);
    const artifact = await f.artifacts.put(new TextEncoder().encode("child answer"), "answer.txt", "text/plain");
    await f.sandbox.stageInputs(f.work, [{ childId: "child", name: artifact.name, digest: artifact.digest }]);
    expect(await env.readTextFile(join(staged, "inputs", "child", artifact.name), BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "child answer" });
    expect(existsSync(join(f.cwd, "inputs"))).toBe(false);
    const spill = await capture(env, "printf 'one\\ntwo\\n'", { spill: { afterBytes: 1, afterLines: 1 } });
    if (!spill.result.ok || !spill.result.value.spillPath) throw new Error("Expected complete output spill");
    expect(spill.result.value.spillPath.startsWith(`${staged}/.ghost-tmp/`)).toBe(true);
    expect(readFileSync(spill.result.value.spillPath, "utf8")).toBe("one\ntwo\n");
    const outside = join(f.root, "do-not-touch");
    mkdirSync(outside);
    rmSync(join(staged, "inputs"), { recursive: true });
    symlinkSync(outside, join(staged, "inputs"));
    await expect(f.sandbox.stageInputs(f.work, [{ childId: "child", name: artifact.name, digest: artifact.digest }])).rejects.toThrow();
    expect(existsSync(join(outside, "child"))).toBe(false);
    rmSync(join(staged, ".ghost-tmp"), { recursive: true });
    symlinkSync(outside, join(staged, ".ghost-tmp"));
    const refused = await capture(env, "printf should-not-run");
    expect(refused.result.ok).toBe(false);
    expect(refused.stdout).toBe("");
  });

  test.skipIf(process.env.GHOST_TEST_CONTAINER !== "1")("explicit container isolates from PC cwd while explicit Host uses it", async () => {
    const f = fixture({ kind: "apple-container", cli: "/opt/homebrew/Cellar/container/1.4.1/bin/container", image: CONTAINER_IMAGE });
    writeFileSync(join(f.cwd, "pc-only.txt"), "private PC file");
    const containerWork: Work = { ...f.work, id: "explicit-container", execution: { kind: "container" } };
    const guest = await f.open(containerWork);
    try {
      expect((await guest.readTextFile(join(f.cwd, "pc-only.txt"), BACKGROUND_CONTEXT)).ok).toBe(false);
      const ran = await capture(guest, `pwd; test ! -e ${JSON.stringify(join(f.cwd, "pc-only.txt"))}`);
      expect(ran.result.ok && ran.result.value.exitCode).toBe(0);
      expect(ran.stdout.trim()).toBe("/workspace");
      const host = await f.open();
      expect((await capture(host, "cat pc-only.txt")).stdout).toBe("private PC file");
    } finally {
      await f.sandbox.release(containerWork);
    }
  }, 300_000);
});
