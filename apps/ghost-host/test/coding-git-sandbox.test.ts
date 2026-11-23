import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CodingSession } from "@ghost/contract";
import type { Dialogs } from "../src/coding/dialogs.ts";
import { codingBash } from "../src/coding/tools.ts";
import { changesFor, prepareWorkspace, worktreeGit } from "../src/coding/workspace.ts";

/** Real macOS Seatbelt tests: everything here proves the kernel boundary, not just our checks. */
const darwin = process.platform === "darwin";

/** The owner's own git configuration never decides what a coding session may write. */
const GIT_ENV = "GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null";
const IDENTITY = "-c user.email=ghost@local -c user.name=Ghost";

type BashResult = { content?: { type: string; text?: string }[]; isError?: boolean };
type BashTool = { execute(toolCallId: string, params: { command: string }, signal?: AbortSignal): Promise<BashResult> };

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Seatbelt confinement is proven by the kernel, so these tests need real time for real forks. */
const TEST_TIMEOUT = 60_000;

function git(cwd: string, args: string[]): string {
  const child = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr.toString()}`);
  return child.stdout.toString().trim();
}

/** The owner approval dialog: every ask is recorded, and every answer declines. */
function stubDialogs(): { dialogs: Dialogs; asks: () => number } {
  let asks = 0;
  const dialogs = { ask: async () => { asks += 1; return { value: "no" }; } } as unknown as Dialogs;
  return { dialogs, asks: () => asks };
}

async function run(tool: BashTool, command: string): Promise<{ text: string; failed: boolean }> {
  const result = await tool.execute("call", { command });
  const text = (result.content ?? []).map(part => part.text ?? "").join("\n");
  return { text, failed: result.isError === true };
}

/**
 * A git repository outside the Host state root, a coding session worktree cut from it and the
 * bash tool of that session. The fixture lives under /private/tmp, outside the per-user scratch
 * directories the profile allows, so a refusal there really is a refusal.
 */
function fixture() {
  // The Host's own temporary directory is the one git's xcrun shim caches in. A Work-hosted
  // test process inherits a private scratch directory instead, which makes every git call fall
  // back to a slow toolchain scan; point the session at the real per-user directory, exactly
  // where the Host runs it.
  const previousTemp = process.env.TMPDIR;
  const userTemp = Bun.spawnSync(["getconf", "DARWIN_USER_TEMP_DIR"], { stdout: "pipe" }).stdout.toString().trim();
  if (userTemp) process.env.TMPDIR = userTemp;
  cleanups.push(() => {
    if (previousTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemp;
  });
  const root = mkdtempSync("/private/tmp/ghost-coding-git-");
  const state = join(root, "state");
  const repo = join(root, "repo");
  const sessions = join(root, "sessions");
  mkdirSync(state, { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  git(repo, ["init", "-q"]);
  writeFileSync(join(repo, "README"), "one\n");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  const session = prepareWorkspace(state, repo, sessions, "s1", true, "ghost/coding-git");
  const metadata = worktreeGit(session);
  if (!metadata) throw new Error("fixture: the session has no worktree metadata");
  // A per-worktree config file, so the session has something to try to rewrite.
  writeFileSync(join(metadata.admin, "config.worktree"), "[core]\n\tautocrlf = false\n");
  const { dialogs, asks } = stubDialogs();
  const tool = codingBash(state, session.cwd, dialogs, metadata, new Set<number>()) as unknown as BashTool;
  return { root, state, repo, session, common: metadata.common, admin: metadata.admin, branch: metadata.branch, tool, dialogs, asks };
}

describe.skipIf(!darwin)("coding session git sandbox", () => {
  test("a session commits on its own branch without asking the owner", async () => {
    const f = fixture();
    expect(f.branch).toBe("ghost/coding-git");
    const ref = join(f.common, "refs", "heads", "ghost", "coding-git");
    const before = readFileSync(ref, "utf8").trim();
    const edit = await run(f.tool, "printf change > CHANGE");
    expect(edit.failed).toBe(false);
    const add = await run(f.tool, `${GIT_ENV} git ${IDENTITY} add -A`);
    expect(add.failed).toBe(false);
    const commit = await run(f.tool, `${GIT_ENV} git ${IDENTITY} commit -m "coding commit"`);
    expect(commit.failed).toBe(false);
    // The owner never had to approve the sandboxed git writes.
    expect(f.asks()).toBe(0);
    const sha = readFileSync(ref, "utf8").trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sha).not.toBe(before);
    expect(git(f.session.cwd, ["rev-parse", "HEAD"])).toBe(sha);
    // The owner's repository sees the same commit on the session's branch.
    expect(git(f.repo, ["log", "-1", "--format=%s", "ghost/coding-git"])).toBe("coding commit");
  }, TEST_TIMEOUT);

  test("a fast-forward merge writes ORIG_HEAD inside the session's own admin directory", async () => {
    const f = fixture();
    await run(f.tool, "printf change > CHANGE");
    await run(f.tool, `${GIT_ENV} git ${IDENTITY} add -A`);
    const commit = await run(f.tool, `${GIT_ENV} git ${IDENTITY} commit -m "coding commit"`);
    expect(commit.failed).toBe(false);
    const before = git(f.session.cwd, ["rev-parse", "HEAD"]);
    // A second branch, cut from the session's commit and carried by another worktree.
    const other = join(f.root, "other");
    git(f.repo, ["worktree", "add", "-q", "-b", "other", other, "ghost/coding-git"]);
    writeFileSync(join(other, "OTHER"), "other\n");
    git(other, ["add", "."]);
    git(other, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "other"]);
    const merge = await run(f.tool, `${GIT_ENV} git ${IDENTITY} merge --ff-only other`);
    expect(merge.failed).toBe(false);
    expect(f.asks()).toBe(0);
    // ORIG_HEAD is the worktree's own file: it lands in the admin directory, never in the common one.
    expect(existsSync(join(f.admin, "ORIG_HEAD"))).toBe(true);
    expect(readFileSync(join(f.admin, "ORIG_HEAD"), "utf8").trim()).toBe(before);
    expect(existsSync(join(f.common, "ORIG_HEAD"))).toBe(false);
    expect(git(f.session.cwd, ["rev-parse", "HEAD"])).not.toBe(before);
  }, TEST_TIMEOUT);

  test("a worktree moved to another branch earns no git write at all", async () => {
    const f = fixture();
    await run(f.tool, "printf change > CHANGE");
    // The session's worktree now points at a branch the session does not own.
    writeFileSync(join(f.admin, "HEAD"), "ref: refs/heads/other\n");
    const metadata = worktreeGit(f.session);
    expect(metadata?.branch).toBeNull();
    const tool = codingBash(f.state, f.session.cwd, f.dialogs, metadata, new Set<number>()) as unknown as BashTool;
    // Nothing in the common directory is writable any more, not even the worktree's own index.
    const add = await run(tool, `${GIT_ENV} git ${IDENTITY} add -A`);
    expect(add.failed).toBe(true);
    expect(add.text).toContain("Operation not permitted");
    const index = join(f.admin, "index");
    const before = existsSync(index) ? readFileSync(index) : null;
    const again = await run(tool, `${GIT_ENV} git ${IDENTITY} add -A`);
    expect(again.failed).toBe(true);
    expect(existsSync(index) ? readFileSync(index) : null).toEqual(before);
  }, TEST_TIMEOUT);

  test("the admin directory grants its own git files, never its identity files", async () => {
    const f = fixture();
    await run(f.tool, "printf change > CHANGE");
    // The files git itself rewrites are writable.
    for (const name of ["ORIG_HEAD", "COMMIT_EDITMSG", join("logs", "HEAD")]) {
      const path = join(f.admin, name);
      const result = await run(f.tool, `printf written > '${path}'`);
      expect({ name, failed: result.failed }).toEqual({ name, failed: false });
      expect(readFileSync(path, "utf8")).toBe("written");
    }
    // The identity files are not. A rewritten commondir would point the Host's own git calls
    // (which run outside the session's sandbox) at a repository the session chooses, and that
    // repository's config can run a command.
    for (const name of ["commondir", "gitdir", "config.worktree"]) {
      const path = join(f.admin, name);
      const before = existsSync(path) ? readFileSync(path) : null;
      const overwrite = await run(f.tool, `printf forged > '${path}'`);
      const remove = await run(f.tool, `rm '${path}'`);
      await run(f.tool, "printf forged > forged");
      const rename = await run(f.tool, `mv forged '${path}'`);
      expect({
        name,
        overwrite: overwrite.failed && overwrite.text.includes("Operation not permitted"),
        remove: remove.failed && remove.text.includes("Operation not permitted"),
        rename: rename.failed && rename.text.includes("Operation not permitted"),
      }).toEqual({ name, overwrite: true, remove: true, rename: true });
      expect(existsSync(path) ? readFileSync(path) : null).toEqual(before);
    }
    // The Host still observes the real repository, not one the session pointed it at.
    expect(worktreeGit(f.session)?.common).toBe(f.common);
    const changes = await changesFor(f.session as unknown as CodingSession);
    expect(changes.files.map(file => file.path)).toContain("CHANGE");
    // HEAD itself is writable, and a worktree moved to another branch loses every git grant.
    const head = await run(f.tool, `printf 'ref: refs/heads/other\\n' > '${join(f.admin, "HEAD")}'`);
    expect(head.failed).toBe(false);
    expect(worktreeGit(f.session)?.branch).toBeNull();
  }, TEST_TIMEOUT);

  test("a repointed admin directory stops the Host's own git calls", async () => {
    const f = fixture();
    // The sandbox refuses this write; simulate a session that managed it anyway.
    writeFileSync(join(f.admin, "commondir"), "/private/tmp/ghost-elsewhere\n");
    expect(() => worktreeGit(f.session)).toThrow();
    // The Host's own change observation fails closed instead of following the session.
    await expect(changesFor(f.session as unknown as CodingSession)).rejects.toThrow();
  }, TEST_TIMEOUT);

  test("the common directory stays read-only outside the session's own branch and admin directory", async () => {
    const f = fixture();
    const other = join(f.root, "other");
    git(f.repo, ["worktree", "add", "-q", "-b", "other", other, "ghost/coding-git"]);
    const denied: { path: string; label: string }[] = [
      { path: join(f.common, "hooks", "pre-commit"), label: "hook" },
      { path: join(f.common, "config"), label: "config" },
      { path: join(f.common, "refs", "heads", "other"), label: "another branch ref" },
      { path: join(f.common, "packed-refs"), label: "packed refs" },
      { path: join(f.common, "worktrees", basename(other), "HEAD"), label: "another worktree's admin directory" },
    ];
    for (const target of denied) {
      const before = existsSync(target.path) ? readFileSync(target.path) : null;
      const result = await run(f.tool, `printf forged > '${target.path}'`);
      const after = existsSync(target.path) ? readFileSync(target.path) : null;
      const unchanged = before === null ? after === null : after !== null && after.equals(before);
      expect({
        label: target.label,
        failed: result.failed,
        denied: result.text.includes("Operation not permitted"),
        unchanged,
      }).toEqual({ label: target.label, failed: true, denied: true, unchanged: true });
    }
  }, TEST_TIMEOUT);
});
