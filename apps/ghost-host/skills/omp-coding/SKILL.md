---
name: omp-coding
description: How a Ghost hands repository code changes to omp, the owner's coding agent, from a Work on the owner's Mac. Read before changing code in any project under ~/Workspace/Projects.
---

# Code through omp

A Ghost is the assistant; omp is the coding agent. Code in a repository is written by omp, the same tool the owner codes with, so the result follows the project's `AGENTS.md`, skills and checks exactly as a human-driven change would. The Ghost scopes the task, runs omp, verifies the diff and integrates it. Do not edit repository files with `write` or `edit` yourself.

Use it for features, fixes, refactors, tests and docs inside a repository. Do not use it for reading, reports, or files outside a repository.

## Setup

The Work must run on the owner's PC: `execution {kind:"host", cwd:"/Users/garden/Workspace/Projects"}`. Read the project's `AGENTS.md` first; it decides checks, commit and push rules, and omp reads it too.

## Steps

1. **Isolate.** For a git repository, work in a branch worktree, never the canonical checkout:
   `git -C <repo> worktree add -b ghost/<slug> /Users/garden/Workspace/Projects/wt/<repo>-<slug> main`
   Use the default branch name the repository actually has. If the canonical checkout has unrelated uncommitted changes, leave them alone; the worktree does not include them. A directory that is not a git repository is edited in place.
2. **Brief.** Write the task as a file (for example `<worktree>/../<slug>.brief.md`) with: goal, files to read first, decided interfaces, protected files, acceptance you can observe, the narrowest check to run, and what is out of scope. Give omp the facts you have; it starts with no conversation. No secrets in the brief.
3. **Run.** One call, non-interactive, no saved session:
   `/Users/garden/.bun/bin/omp -p --no-session --cwd <worktree> --thinking medium @<brief file>`
   The Host shell's PATH has no `omp` or `bun`; use the absolute path. A worktree's checks that need `bun` run inside omp, which has its own environment, or with `/Users/garden/.bun/bin/bun`.
   Set the bash `timeout` (seconds) to what the Work's budget leaves. A change that needs more than about 30 minutes is split into several briefs, one worktree each. At most two omp runs at once, never two in the same worktree.
4. **Verify yourself.** omp's closing summary is a claim. Read `git -C <worktree> status --short` and `git -C <worktree> diff --stat`, read the changed code, and run the narrowest check that proves the acceptance. If there is no diff or the check fails, read omp's output, narrow the brief to the exact failure and run once more; then report the failure with its evidence instead of looping.
5. **Integrate** when the project's `AGENTS.md` asks for it: commit the files by name on the branch, update the branch from the default branch, fast-forward the default branch in the canonical checkout, push normally to the remotes the repository already has, then remove the worktree and delete the branch you created (`git worktree remove`, `git branch -d`). Never force-push, reset, stash or rewrite history, and never stage another person's uncommitted work. A draft, experiment or hold from the owner stops after the verified commit on the branch.
6. **Report** in the owner's language: what changed and why it is enough, the check you ran and its result, the commit hashes, and anything left undone.

## Limits

- Interactive omp, `--mode rpc` and extra extensions are not needed; keep the call as above.
- Do not paste omp's whole transcript into the report; quote only the lines that prove a claim.
- A failed or empty omp run is not a reason to write the code yourself. Report it and say what blocked it.
