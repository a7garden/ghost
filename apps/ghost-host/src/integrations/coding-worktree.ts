import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const GIT = "/usr/bin/git";

/** Runs git in `cwd` and says how it ended; the caller decides what a non-zero code means. */
export interface Git {
  (args: string[], cwd: string): Promise<{ code: number; out: string }>;
}

/** A worktree that could not be made, in words the owner or the Ghost can act on. */
export class WorktreeError extends Error {}

/** The instruction a coding agent starts with: the task, then where it may work and how to finish. */
export function promptFor(task: string, branch: string | null): string {
  return [
    "# Task",
    task.trim(),
    "",
    "# Rules",
    "- Work only inside the current directory; follow its AGENTS.md and project conventions.",
    ...(branch === null
      ? ["- This directory is not a git repository; change files in place."]
      : [
          `- This directory is a git worktree on branch ${branch}. Stay on that branch; never push, merge, rebase or switch branches.`,
          "- When the work is complete and its checks pass, commit it on this branch with a clear message and stage files by name.",
        ]),
    "- Finish with a short summary: what changed, what you ran to check it, and anything left undone.",
  ].join("\n");
}

/** A new branch and worktree beside the repository's `wt` folder, so the canonical checkout is never touched. */
export async function openWorktree(git: Git, top: string, base: string, wanted: string): Promise<{ path: string; branch: string }> {
  const slug = wanted.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
  for (let attempt = 1; attempt <= 20; attempt++) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const branch = `ghost/${slug}${suffix}`;
    // A repository already inside a wt folder gets its worktrees beside it, not in wt/wt.
    const path = join(basename(dirname(top)) === "wt" ? dirname(top) : join(dirname(top), "wt"), `${basename(top)}-${slug}${suffix}`);
    if (existsSync(path) || (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], top)).code === 0) continue;
    const added = await git(["worktree", "add", "-b", branch, path, base], top);
    if (added.code !== 0) throw new WorktreeError(`could not create the worktree: ${added.out}`);
    return { path, branch };
  }
  throw new WorktreeError("could not find a free branch name; pass a different branch");
}
