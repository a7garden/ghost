import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Work } from "@ghost/contract";

/** Branch of a Work's worktree. Work ids are host-generated, so the name needs no escaping. */
export const worktreeBranch = (workId: string) => `ghost/${workId}`;

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const child = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { ok: child.exitCode === 0, stdout: child.stdout.toString().trim(), stderr: child.stderr.toString().trim() };
}

/** The repository top level of `cwd`, or a reason it cannot carry a worktree. */
export function repositoryOf(cwd: string): string {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.stdout) throw new Error(`Worktree execution needs a git repository: ${cwd}`);
  if (git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok === false) throw new Error(`Worktree execution needs a repository with at least one commit: ${cwd}`);
  return realpathSync(top.stdout);
}

/**
 * The Work's own worktree at `<root>/worktrees/<ghost>/<work>` on branch `ghost/<work>`, created on first use
 * and reused after a restart. A delegated child starts from its parent's branch when that exists, otherwise
 * from the repository's HEAD. Nothing is ever removed here: the owner merges or deletes the branch.
 */
export function ensureWorktree(root: string, work: Work, cwd: string): string {
  const repo = repositoryOf(cwd);
  const path = join(root, "worktrees", work.ghostId, work.id);
  if (existsSync(join(path, ".git"))) return realpathSync(path);
  mkdirSync(join(root, "worktrees", work.ghostId), { recursive: true, mode: 0o700 });
  const branch = worktreeBranch(work.id);
  const hasBranch = git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
  const parentBranch = work.parentId ? worktreeBranch(work.parentId) : null;
  const base = parentBranch && git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${parentBranch}`]).ok ? parentBranch : "HEAD";
  const added = hasBranch ? git(repo, ["worktree", "add", path, branch]) : git(repo, ["worktree", "add", "-b", branch, path, base]);
  if (!added.ok) throw new Error(`git worktree add failed: ${added.stderr.slice(0, 512)}`);
  return realpathSync(path);
}
