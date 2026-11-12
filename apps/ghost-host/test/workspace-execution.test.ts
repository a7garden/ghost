import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Work } from "@ghost/contract";
import type { Config } from "../src/config.ts";
import { createSandbox, type SandboxService } from "../src/sandbox/index.ts";
import { MemoryArtifacts } from "./support.ts";

/** Real macOS Seatbelt tests: everything here proves the kernel boundary, not just our checks. */
const darwin = process.platform === "darwin";
const context: Context = BACKGROUND_CONTEXT;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  // Outside DARWIN_USER_* scratch (var/folders): a fixture there would overlap the profile's
  // per-user temp allowance and make refusals meaningless.
  const root = mkdtempSync("/private/tmp/ghost-workspace-");
  const state = join(root, "state");
  const projects = join(root, "projects");
  mkdirSync(state, { recursive: true });
  mkdirSync(projects, { recursive: true });
  const config: Config = {
    root: state, host: "127.0.0.1", port: 62062, publicOrigin: null, uiDir: null,
    sandbox: { kind: "local" }, mac: { roots: [projects], watch: null },
    voice: null, apns: null, skills: null, reach: null, browser: null,
  };
  const sandbox: SandboxService = createSandbox(config, new MemoryArtifacts());
  cleanups.push(async () => {
    await sandbox.close();
    rmSync(root, { recursive: true, force: true });
  });
  let seq = 0;
  const work = (execution?: Work["execution"]): Work => {
    seq += 1;
    const id = `work-${seq}-${crypto.randomUUID()}`;
    return {
      id, rootId: id, parentId: null, ghostId: "ghost-1", originConversationId: "direct-1", conversationId: null,
      title: "workspace execution", brief: "prove the boundary", acceptance: { criteria: "", checks: [], reviewer: null },
      state: "running", revision: 1, revisionsUsed: 0, deadlineAt: null, result: null, verdict: null, reason: null,
      createdAt: 0, startedAt: null, endedAt: null, updatedAt: 0,
      ...(execution ? { execution } : {}),
    };
  };
  return { root, state, projects, config, sandbox, work };
}

async function shell(env: ExecutionEnv, command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const result = await env.exec(command, { timeout: 60, onOutput: (chunk, _ctx, info) => {
    if (info.stream === "stdout") stdout += chunk;
    else stderr += chunk;
  } }, context);
  if (!result.ok) throw result.error;
  return { exitCode: result.value.exitCode, stdout, stderr };
}

describe.skipIf(!darwin)("workspace execution boundary", () => {
  test("runs the Mac toolchain and writes inside its own directory", async () => {
    const f = fixture();
    const work = f.work({ kind: "workspace" });
    const env = await f.sandbox.envFor(work);
    cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
    const python = await shell(env, "python3 -c 'import sys; print(sys.version_info[0])'");
    expect(python.exitCode).toBe(0);
    expect(python.stdout.trim()).toBe("3");
    const git = await shell(env, "git --version");
    expect(git.exitCode).toBe(0);
    const wrote = await shell(env, `printf work > out.txt && cat out.txt`);
    expect(wrote.exitCode).toBe(0);
    expect(wrote.stdout.trim()).toBe("work");
    expect(readFileSync(join(f.sandbox.workspacePath(work), "out.txt"), "utf8")).toBe("work");
  });

  test("refuses a write outside the workspace and names the boundary", async () => {
    const f = fixture();
    const work = f.work({ kind: "workspace" });
    const env = await f.sandbox.envFor(work);
    cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
    const outside = join(f.root, "outside.txt");
    const refused = await shell(env, `printf x > ${outside}`);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("sandbox:");
    expect(refused.stderr).toContain("write");
    expect(existsSync(outside)).toBe(false);
  });

  test("refuses reading the Ghost state root and ~/.ssh, allows the toolchain", async () => {
    const f = fixture();
    const env = await f.sandbox.envFor(f.work({ kind: "workspace" }));
    cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
    const state = await shell(env, `ls ${f.state}`);
    expect(state.exitCode).not.toBe(0);
    expect(state.stderr).toContain("sandbox:");
    const ssh = await shell(env, "cat ~/.ssh/config");
    expect(ssh.exitCode).not.toBe(0);
    expect(ssh.stderr).toContain("sandbox:");
    expect(ssh.stderr).toContain("secret");
    // In-process file operations agree with the kernel's answer.
    const read = await env.readTextFile(join(f.state, "ledger.db"), context);
    expect(read.ok).toBe(false);
  });

  test("denies direct network while the egress proxy is reachable through the environment", async () => {
    const f = fixture();
    const env = await f.sandbox.envFor(f.work({ kind: "workspace" }));
    cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
    const proxy = await shell(env, "printf '%s' \"$HTTP_PROXY\"");
    expect(proxy.exitCode).toBe(0);
    expect(proxy.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const direct = await shell(env, "env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy curl -sS --max-time 5 http://example.com");
    expect(direct.exitCode).not.toBe(0);
    expect(direct.stderr).toContain("sandbox:");
    expect(direct.stderr).toContain("egress proxy");
  });

  test("a repository cwd gets its own worktree; the owner checkout stays clean", async () => {
    const f = fixture();
    const repo = join(f.projects, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    git(["init", "-q"]);
    writeFileSync(join(repo, "README"), "one\n");
    git(["add", "."]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    const work = f.work({ kind: "workspace", cwd: repo });
    const env = await f.sandbox.envFor(work);
    cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
    const committed = await shell(env, "printf two > README && git add README && git -c user.email=g@ghost -c user.name=Ghost commit -qm work && git rev-parse --abbrev-ref HEAD");
    expect(committed.exitCode).toBe(0);
    expect(committed.stdout.trim()).toBe(`ghost/${work.id}`);
    // The owner's checkout never saw the edit; the branch carries it.
    expect(readFileSync(join(repo, "README"), "utf8")).toBe("one\n");
    const branch = Bun.spawnSync(["git", "-C", repo, "log", "-1", "--format=%s", `ghost/${work.id}`], { stdout: "pipe" });
    expect(branch.stdout.toString().trim()).toBe("work");
  });

  test("the reviewer reads the reviewed workspace and cannot write to it", async () => {
    const f = fixture();
    const work = f.work({ kind: "workspace" });
    const reviewed = await f.sandbox.envFor(work);
    cleanups.push(() => reviewed.cleanup(BACKGROUND_CONTEXT));
    await shell(reviewed, "printf evidence > proof.txt");
    const reviewer = f.sandbox.reviewEnvFor!(work, "review-conversation-1");
    cleanups.push(() => reviewer.cleanup(BACKGROUND_CONTEXT));
    const read = await shell(reviewer, `cat "$GHOST_REVIEWED_WORKSPACE/proof.txt"`);
    expect(read.exitCode).toBe(0);
    expect(read.stdout.trim()).toBe("evidence");
    const write = await shell(reviewer, `printf forged > "$GHOST_REVIEWED_WORKSPACE/proof.txt"`);
    expect(write.exitCode).not.toBe(0);
    expect(write.stderr).toContain("sandbox:");
    const scratch = await shell(reviewer, "printf note > notes.txt && cat notes.txt");
    expect(scratch.exitCode).toBe(0);
  });
});
