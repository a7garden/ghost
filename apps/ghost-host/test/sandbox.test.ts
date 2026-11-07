import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Work } from "@ghost/contract";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv, ShellExecOptions } from "@earendil-works/pi-durable/env";
import type { Config } from "../src/config.ts";
import { sha256 } from "../src/core/ids.ts";
import { CONTAINER_IMAGE, containerName, createSandbox } from "../src/sandbox/index.ts";
import { MemoryArtifacts } from "./support.ts";

const context: Context = { abortSignal: undefined, value: () => undefined, toString: () => "sandbox-test" };

function localConfig(root: string): Config {
  return {
    root,
    host: "127.0.0.1",
    port: 62062,
    publicOrigin: "http://127.0.0.1:62062",
    uiDir: null,
    sandbox: { kind: "local" },
    memory: null,
    voice: null,
    apns: null,
  };
}

let seq = 0;
function makeWork(ghostId = "ghost-1"): Work {
  seq += 1;
  const id = `work-${seq}-${crypto.randomUUID()}`;
  return {
    id,
    parentId: null,
    rootId: id,
    ghostId,
    originConversationId: "conversation-1",
    conversationId: null,
    title: "sandbox test",
    brief: "prove the workspace is confined",
    acceptance: { criteria: "", checks: [], reviewer: null },
    state: "running",
    revision: 1,
    revisionsUsed: 0,
    deadlineAt: null,
    result: null,
    verdict: null,
    reason: null,
    createdAt: 0,
    startedAt: null,
    endedAt: null,
    updatedAt: 0,
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ghost-sandbox-"));
}

async function execCapture(
  env: ExecutionEnv,
  command: string | readonly string[],
  options?: ShellExecOptions,
): Promise<{ result: Awaited<ReturnType<ExecutionEnv["exec"]>>; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const result = await env.exec(
    command,
    {
      ...options,
      onOutput: (text, _context, info) => {
        if (info.stream === "stdout") stdout += text;
        else stderr += text;
      },
    },
    context,
  );
  return { result, stdout, stderr };
}

describe("local sandbox", () => {
  test("each Work gets its own workspace directory under sandboxes/<ghost>/<work>", () => {
    const root = tempRoot();
    const sandbox = createSandbox(localConfig(root), new MemoryArtifacts());
    const work = makeWork("ghost-7");
    const workspace = sandbox.workspacePath(work);
    expect(workspace).toBe(join(root, "sandboxes", "ghost-7", work.id, "workspace"));
    expect(existsSync(workspace)).toBe(true);
    expect(statSync(workspace).mode & 0o777).toBe(0o700);
    // Created on demand, and stable across calls.
    expect(sandbox.workspacePath(work)).toBe(workspace);
  });

  test("writes and reads inside the workspace work", async () => {
    const root = tempRoot();
    const sandbox = createSandbox(localConfig(root), new MemoryArtifacts());
    const work = makeWork();
    const env = await sandbox.envFor(work);
    const workspace = sandbox.workspacePath(work);

    expect((await env.writeFile("notes.txt", "hello", context)).ok).toBe(true);
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("hello");
    const read = await env.readTextFile("notes.txt", context);
    expect(read.ok && read.value).toBe("hello");
    // Absolute paths inside the workspace are allowed.
    expect((await env.writeFile(join(workspace, "inside.txt"), "in", context)).ok).toBe(true);
    expect((await env.exists(join(workspace, "inside.txt"), context)).ok).toBe(true);
  });

  test("paths that climb out of the workspace are refused", async () => {
    const root = tempRoot();
    const sandbox = createSandbox(localConfig(root), new MemoryArtifacts());
    const work = makeWork();
    const env = await sandbox.envFor(work);
    const workspace = sandbox.workspacePath(work);

    const escape = await env.writeFile("../escaped.txt", "no", context);
    expect(escape.ok).toBe(false);
    expect(!escape.ok && escape.error.code).toBe("permission_denied");

    const absolute = await env.writeFile("/tmp/ghost-sandbox-escape.txt", "no", context);
    expect(absolute.ok).toBe(false);
    expect(!absolute.ok && absolute.error.code).toBe("permission_denied");

    const read = await env.readTextFile("../escaped.txt", context);
    expect(read.ok).toBe(false);

    expect(existsSync(join(root, "escaped.txt"))).toBe(false);
    expect(existsSync("/tmp/ghost-sandbox-escape.txt")).toBe(false);
    expect(existsSync(join(workspace, "escaped.txt"))).toBe(false);
  });

  test("a symlink pointing outside the workspace is refused", async () => {
    const root = tempRoot();
    const sandbox = createSandbox(localConfig(root), new MemoryArtifacts());
    const work = makeWork();
    const env = await sandbox.envFor(work);
    const workspace = sandbox.workspacePath(work);

    const outside = join(root, "outside.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(workspace, "door"));

    const read = await env.readTextFile("door", context);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error.code).toBe("permission_denied");

    const write = await env.writeFile("door/planted.txt", "no", context);
    expect(write.ok).toBe(false);
    expect(existsSync(join(root, "planted.txt"))).toBe(false);
  });

  test("a dangling symlink is refused instead of planted through", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    const sandbox = createSandbox(localConfig(root), new MemoryArtifacts());
    const work = makeWork();
    const env = await sandbox.envFor(work);
    const workspace = sandbox.workspacePath(work);

    // The target does not exist yet: a write must not create it at the outside destination.
    symlinkSync(join(outside, "planted.txt"), join(workspace, "door"));

    const write = await env.writeFile("door", "planted", context);
    expect(write.ok).toBe(false);
    expect(!write.ok && write.error.code).toBe("permission_denied");
    expect(existsSync(join(outside, "planted.txt"))).toBe(false);

    const read = await env.readTextFile("door", context);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error.code).toBe("permission_denied");

    // Same refusal when the symlink hides in the middle of the path, pointing inside the workspace.
    mkdirSync(join(workspace, "real"));
    symlinkSync(join(workspace, "real"), join(workspace, "alias"));
    const through = await env.writeFile("alias/through.txt", "no", context);
    expect(through.ok).toBe(false);
    expect(existsSync(join(workspace, "real", "through.txt"))).toBe(false);
  });

  test("a symlinked .ghost-tmp is refused", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    const sandbox = createSandbox(localConfig(root), new MemoryArtifacts());
    const work = makeWork();
    const env = await sandbox.envFor(work);
    symlinkSync(outside, join(sandbox.workspacePath(work), ".ghost-tmp"));

    const dir = await env.createTempDir(undefined, context);
    expect(dir.ok).toBe(false);
    expect(!dir.ok && dir.error.code).toBe("permission_denied");

    const file = await env.createTempFile({ suffix: ".log" }, context);
    expect(file.ok).toBe(false);

    // Nothing was created through the link.
    expect(readdirSync(outside)).toEqual([]);
  });

  test("exec runs in the workspace", async () => {
    const root = tempRoot();
    const sandbox = createSandbox(localConfig(root), new MemoryArtifacts());
    const work = makeWork();
    const env = await sandbox.envFor(work);
    const workspace = sandbox.workspacePath(work);

    const where = await execCapture(env, "pwd");
    expect(where.result.ok).toBe(true);
    expect(where.stdout.trim()).toBe(realpathSync(workspace));

    const wrote = await execCapture(env, "echo hello > made-by-shell.txt");
    expect(wrote.result.ok).toBe(true);
    expect(readFileSync(join(workspace, "made-by-shell.txt"), "utf8").trim()).toBe("hello");

    // A working directory outside the workspace is refused.
    const outside = await execCapture(env, "pwd", { cwd: ".." });
    expect(outside.result.ok).toBe(false);
  });

  test("stageInputs copies verified bytes and refuses tampered ones", async () => {
    const root = tempRoot();
    const artifacts = new MemoryArtifacts();
    const sandbox = createSandbox(localConfig(root), artifacts);
    const work = makeWork();
    const workspace = sandbox.workspacePath(work);
    const childId = "child-1";

    const artifact = await artifacts.put(new TextEncoder().encode("answer"), "answer.txt", "text/plain");
    await sandbox.stageInputs(work, [{ childId, name: "answer.txt", digest: artifact.digest }]);
    expect(readFileSync(join(workspace, "inputs", childId, "answer.txt"), "utf8")).toBe("answer");

    // Staging the same bytes again is a no-op.
    await sandbox.stageInputs(work, [{ childId, name: "answer.txt", digest: artifact.digest }]);

    // Bytes that do not match the digest are refused.
    artifacts.bytes.set(artifact.digest, new TextEncoder().encode("tampered"));
    await expect(sandbox.stageInputs(work, [{ childId, name: "answer.txt", digest: artifact.digest }])).rejects.toThrow(
      /does not match its bytes/,
    );
    expect(readFileSync(join(workspace, "inputs", childId, "answer.txt"), "utf8")).toBe("answer");

    // A name with a path separator is refused.
    const other = await artifacts.put(new TextEncoder().encode("x"), "x.txt", "text/plain");
    artifacts.bytes.set(other.digest, new TextEncoder().encode("x"));
    await expect(sandbox.stageInputs(work, [{ childId, name: "../escape.txt", digest: other.digest }])).rejects.toThrow(
      /unsafe artifact name/,
    );
    expect(existsSync(join(workspace, "escape.txt"))).toBe(false);
  });

  test("an existing staged file with different bytes is an error", async () => {
    const root = tempRoot();
    const artifacts = new MemoryArtifacts();
    const sandbox = createSandbox(localConfig(root), artifacts);
    const work = makeWork();
    const workspace = sandbox.workspacePath(work);
    const childId = "child-2";

    const first = await artifacts.put(new TextEncoder().encode("one"), "result.txt", "text/plain");
    await sandbox.stageInputs(work, [{ childId, name: "result.txt", digest: first.digest }]);

    const second = await artifacts.put(new TextEncoder().encode("two"), "result.txt", "text/plain");
    await expect(sandbox.stageInputs(work, [{ childId, name: "result.txt", digest: second.digest }])).rejects.toThrow(
      /already exists with different bytes/,
    );
    expect(readFileSync(join(workspace, "inputs", childId, "result.txt"), "utf8")).toBe("one");
  });

  test("stageInputs refuses a symlinked inputs directory", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    const artifacts = new MemoryArtifacts();
    const sandbox = createSandbox(localConfig(root), artifacts);
    const work = makeWork();
    const workspace = sandbox.workspacePath(work);
    const artifact = await artifacts.put(new TextEncoder().encode("answer"), "answer.txt", "text/plain");

    // `inputs` itself replaced by a symlink to a host directory.
    symlinkSync(outside, join(workspace, "inputs"));
    await expect(
      sandbox.stageInputs(work, [{ childId: "child-1", name: "answer.txt", digest: artifact.digest }]),
    ).rejects.toThrow(/symbolic link/i);
    expect(existsSync(join(outside, "answer.txt"))).toBe(false);

    // `inputs/<childId>` replaced by a symlink: the child's artifact must not land outside.
    rmSync(join(workspace, "inputs"));
    mkdirSync(join(workspace, "inputs"), { mode: 0o700 });
    symlinkSync(outside, join(workspace, "inputs", "child-2"));
    await expect(
      sandbox.stageInputs(work, [{ childId: "child-2", name: "answer.txt", digest: artifact.digest }]),
    ).rejects.toThrow(/symbolic link/i);
    expect(existsSync(join(outside, "answer.txt"))).toBe(false);
  });

  test("container names stay distinct for Works created in the same millisecond", () => {
    // Two UUIDv7 ids share their first 12 characters whenever they share the timestamp prefix.
    const first = `0195dcbe4a1f7-aaaa-bbbb-cccc`;
    const second = `0195dcbe4a1f7-dddd-eeee-ffff`;
    expect(first.slice(0, 12)).toBe(second.slice(0, 12));

    const a = containerName(first);
    const b = containerName(second);
    expect(a.startsWith("ghost-")).toBe(true);
    expect(b.startsWith("ghost-")).toBe(true);
    expect(a).toMatch(/^ghost-[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });

  test("the local kind reports no container", () => {
    const root = tempRoot();
    const sandbox = createSandbox(localConfig(root), new MemoryArtifacts());
    expect(sandbox.status("ghost-1").state).toBe("none");
  });
});

/** The container smoke test runs a real container; it is opt-in because it needs the container CLI. */
const runContainer = process.env.GHOST_TEST_CONTAINER === "1";
const containerCli = "/opt/homebrew/Cellar/container/1.4.1/bin/container";

describe("apple container sandbox", () => {
  test.skipIf(!runContainer)("runs a command in a container with only the workspace mounted", async () => {
    const root = tempRoot();
    const config: Config = {
      ...localConfig(root),
      sandbox: { kind: "apple-container", cli: containerCli, image: CONTAINER_IMAGE },
    };
    const artifacts = new MemoryArtifacts();
    const sandbox = createSandbox(config, artifacts);
    const work = makeWork("ghost-container");
    const env = await sandbox.envFor(work);
    const workspace = sandbox.workspacePath(work);

    const echoed = await execCapture(env, "echo hello-from-container");
    expect(echoed.result.ok).toBe(true);
    expect(echoed.stdout).toContain("hello-from-container");

    // The guest sees the workspace at /workspace and nothing else.
    const where = await execCapture(env, "pwd");
    expect(where.stdout.trim()).toBe("/workspace");

    // /tmp is writable: HOME and TMPDIR point there, so git, heredocs and friends depend on it.
    const probe = await execCapture(env, "echo probe > /tmp/ghost-probe && cat /tmp/ghost-probe");
    expect(probe.result.ok).toBe(true);
    expect(probe.stdout.trim()).toBe("probe");

    // The network is `none`: loopback exists, no external interface does.
    const net = await execCapture(env, "cat /proc/net/dev");
    expect(net.result.ok).toBe(true);
    expect(net.stdout).toContain("lo");
    expect(net.stdout).not.toMatch(/eth\d|en\d/);

    // No DNS is configured inside the guest (--no-dns, and nothing to resolve to anyway).
    const dns = await execCapture(env, "cat /etc/resolv.conf 2>/dev/null || true");
    expect(dns.result.ok).toBe(true);
    expect(dns.stdout).not.toContain("nameserver");

    // Large output spills into the workspace's own verified .ghost-tmp.
    const spilled = await execCapture(env, "yes ghost-spill | head -n 5000", {
      spill: { afterBytes: 1024, afterLines: 100 },
    });
    expect(spilled.result.ok).toBe(true);
    const spillPath = spilled.result.ok ? spilled.result.value.spillPath : undefined;
    expect(spillPath).toBeDefined();
    expect(spillPath!.startsWith("/workspace/.ghost-tmp/")).toBe(true);
    const spillName = spillPath!.split("/").pop()!;
    expect(readFileSync(join(workspace, ".ghost-tmp", spillName), "utf8")).toContain("ghost-spill");

    // File operations stay on the host workspace, with the same confinement.
    expect((await env.writeFile("/workspace/from-host.txt", "written", context)).ok).toBe(true);
    expect(readFileSync(join(workspace, "from-host.txt"), "utf8")).toBe("written");
    const read = await env.readTextFile("/workspace/from-host.txt", context);
    expect(read.ok && read.value).toBe("written");
    expect((await env.writeFile("/etc/passwd", "no", context)).ok).toBe(false);

    // The container of this Work is reported as running, then removed by reset.
    expect(sandbox.status(work.ghostId).state).toBe("running");
    await sandbox.control(work.ghostId, "reset");
    expect(sandbox.status(work.ghostId).state).toBe("none");
    expect(containerName(work.id).startsWith("ghost-")).toBe(true);
  }, 300_000);
});
