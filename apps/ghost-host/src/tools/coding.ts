import { Type } from "typebox";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Core } from "../core/core.ts";
import { KnownOutcome, NoEffect } from "../core/effects.ts";
import { errorResult, requireAllowed, requireWork } from "./shared.ts";
import type { CodingAgentPort, CodingEvent } from "../integrations/ports.ts";
import { pickCodingAgent } from "../integrations/coding-agents.ts";
import type { CodingPrefs } from "@ghost/contract";

const text = (message: string): ToolExecutionResult => ({ content: [{ type: "text", text: message }] });

const DEFAULT_MINUTES = 30;
const MAX_MINUTES = 120;
/** The agent's closing message is kept from the end of its output. */
const SUMMARY_CHARS = 3_000;
const GIT = "/usr/bin/git";
const NO_PREFS: CodingPrefs = { default: null, disabled: [] };

/** Guidance for a Ghost holding the coding tools: the Ghost scopes, verifies and integrates; the coding agent writes the code. */
export const CODING_INSTRUCTIONS = `Repository code is written by a coding agent installed on the owner's Mac, the tool the owner codes with, not by you. code_agents lists what is installed. For a change in a repository, run code_run in an owner-PC Work with the repository path and a task that carries what the agent lacks: the goal, files to read first, decided interfaces, protected files, observable acceptance and the narrowest check. The Host puts the agent in a new branch and worktree, so the owner's checkout stays untouched. Its summary is a claim: read the diff and run the project's check yourself, then integrate by the project's own rules (its AGENTS.md says whether to merge and push) and remove the worktree and branch you created once merged. Every run is a session the owner can read in the app; when its result is not right, call code_run again with continue_session set to the result's sessionId so the agent keeps its conversation and worktree instead of starting over. Do not edit repository files with write or edit, and do not write the code yourself when code_run fails; report what blocked it. Split work that needs more than about 30 minutes into several tasks.`;

const slugOf = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

function promptFor(task: string, branch: string | null): string {
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

interface Git {
  (args: string[], cwd: string): Promise<{ code: number; out: string }>;
}

function gitOver(env: ExecutionEnv, context: Context): Git {
  return async (args, cwd) => {
    let out = "";
    const result = await env.exec([GIT, ...args], { cwd, timeout: 60, onOutput: (chunk) => { out = (out + chunk).slice(-20_000); } }, context);
    if (!result.ok) throw new NoEffect(`git ${args[0]} did not run: ${result.error.message}`);
    return { code: result.value.exitCode, out: out.trim() };
  };
}

/** A new branch and worktree beside the repository's `wt` folder, so the canonical checkout is never touched. */
async function openWorktree(git: Git, top: string, base: string, wanted: string): Promise<{ path: string; branch: string }> {
  const slug = slugOf(wanted) || "task";
  for (let attempt = 1; attempt <= 20; attempt++) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const branch = `ghost/${slug}${suffix}`;
    // A repository already inside a wt folder gets its worktrees beside it, not in wt/wt.
    const path = join(basename(dirname(top)) === "wt" ? dirname(top) : join(dirname(top), "wt"), `${basename(top)}-${slug}${suffix}`);
    if (existsSync(path) || (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], top)).code === 0) continue;
    const added = await git(["worktree", "add", "-b", branch, path, base], top);
    if (added.code !== 0) throw new NoEffect(`could not create the worktree: ${added.out}`);
    return { path, branch };
  }
  throw new NoEffect("could not find a free branch name; pass a different branch");
}

export function createCodingTools(core: Core, coding: CodingAgentPort): Extension {
  const agents = defineTool({
    name: "code_agents",
    description: "List the coding agents installed on the owner's Mac (omp, Claude Code, Codex) with their versions, whether each is ready (an ended login makes it not ready), whether the owner turned it off, and which one code_run uses when you name none: the owner's default in Settings, else the first ready one.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api) {
      try {
        requireAllowed(core, api, "code_agents");
        const found = await coding.detect();
        const prefs = core.ledger.setting<CodingPrefs>("coding", NO_PREFS);
        const picked = pickCodingAgent(found, prefs);
        return text(found.length === 0
          ? "No coding agent is installed on this Mac."
          : JSON.stringify({ agents: found.map(({ id, name, version, ready, note }) => ({ id, name, version, ready, note, enabled: !prefs.disabled.includes(id) })), usedByDefault: "agent" in picked ? picked.agent.id : null }));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const run = defineTool({
    name: "code_run",
    description:
      "Hand a coding task to a coding agent installed on the owner's Mac (code_agents lists them) and wait for it. In a git repository the Host first creates a new branch and worktree next to the repository's wt folder, so the checkout the owner works in is never touched; the agent commits there and is told never to push or merge. Returns the agent's closing summary, the branch, the worktree path, the commits, the diff stat and a sessionId. Every run is kept as a session the owner can read in the app. To correct or extend a run, pass its sessionId as continue_session: the same agent carries on in the same conversation and worktree, and repo, agent and branch are not needed. Verify the diff and run the project's check yourself before you integrate; the agent's summary is a claim. Needs an owner-PC Work (execution host). A new run starts with no conversation, so give the agent everything it needs in task.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Absolute path of the repository (or directory) to change; not needed with continue_session" })),
      continue_session: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "The sessionId of an earlier code_run to carry on in its conversation and worktree; task is then the follow-up instruction" })),
      task: Type.String({ minLength: 1, maxLength: 24_000, description: "The goal, files to read first, decided interfaces, protected files, observable acceptance and the narrowest check to run" }),
      agent: Type.Optional(Type.Union([Type.Literal("omp"), Type.Literal("claude"), Type.Literal("codex")], { description: "Which agent; default the owner's choice in Settings, else the first ready one" })),
      branch: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Short name for the branch and worktree, such as fix-login; defaults to one derived from the task" })),
      timeout_minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MINUTES, description: `Default ${DEFAULT_MINUTES}; split larger changes into several tasks` })),
    }),
    replay: "unsafe",
    async execute(args, api, context) {
      try {
        const scope = requireWork(requireAllowed(core, api, "code_run"));
        if (scope.work.execution?.kind !== "host") throw new NoEffect("code_run needs an owner-PC Work: create the Work with execution {kind:\"host\", cwd:\"/Users/garden/Workspace/Projects\"}");
        if (!scope.ghost.hostExecution) throw new NoEffect("PC execution was revoked by the owner");
        if (!api.env) throw new NoEffect("no execution environment for this conversation");
        const env = api.env;
        const previous = args.continue_session === undefined ? null : coding.sessions.continuation(args.continue_session);
        if (args.continue_session !== undefined) {
          if (previous === null) throw new NoEffect(`session ${args.continue_session} cannot be continued: it is unknown or its agent never reported a session id; start a new code_run`);
          if (!existsSync(previous.cwd)) throw new NoEffect(`the worktree of session ${args.continue_session} no longer exists (${previous.cwd}); start a new code_run`);
          if (args.agent !== undefined && args.agent !== previous.agent) throw new NoEffect(`session ${args.continue_session} ran in ${previous.agent}; a session continues in the agent that started it`);
        }
        const where = previous?.cwd ?? args.repo;
        if (where === undefined) throw new NoEffect("pass repo, or continue_session to carry on an earlier run");
        if (!isAbsolute(where) || !existsSync(where) || !statSync(where).isDirectory()) throw new NoEffect(`${where} is not an absolute path of an existing directory`);
        const repo = realpathSync(where);
        const picked = pickCodingAgent(await coding.detect(), core.ledger.setting<CodingPrefs>("coding", NO_PREFS), previous?.agent ?? args.agent);
        if ("problem" in picked) throw new NoEffect(picked.problem);
        const agent = picked.agent;
        const minutes = args.timeout_minutes ?? DEFAULT_MINUTES;
        const recorded = await core.effects
          .run(
            {
              conversationId: scope.conversation.id,
              callId: api.callId,
              tool: "code_run",
              input: { repo, task: args.task, agent: agent.id, branch: args.branch ?? null, continue_session: args.continue_session ?? null, timeout_minutes: minutes },
              summary: `${agent.name}: ${args.task.trim().split("\n")[0]!.slice(0, 160)}`,
              // The change lands in a fresh branch worktree, so it is undone by deleting it; the agent itself can still reach anything the owner's account can.
              classification: { target: { kind: "mac", id: repo }, access: "write", reversible: true, external: true, amount: null },
            },
            async () => {
              const git = gitOver(env, context);
              let cwd = repo;
              let branch: string | null = null;
              let base: string | null = null;
              if (previous !== null) {
                ({ cwd, branch, base } = previous);
              } else {
                const top = await git(["rev-parse", "--show-toplevel"], repo);
                if (top.code === 0) {
                  base = (await git(["rev-parse", "HEAD"], top.out)).out;
                  const opened = await openWorktree(git, realpathSync(top.out), base, args.branch ?? args.task.trim().split("\n")[0]!);
                  cwd = opened.path;
                  branch = opened.branch;
                }
              }
              const session = coding.sessions.open({ agent: agent.id, workId: scope.work.id, callId: api.callId, task: args.task, cwd, branch, base });
              const stream = coding.stream(agent);
              let announced = false;
              const follow = (events: CodingEvent[]) => {
                for (const event of events) {
                  session.step(event.kind, event.text);
                  if (event.kind !== "result") api.output(`${event.text}\n`);
                }
                if (!announced && stream.nativeId !== null) {
                  session.native(stream.nativeId);
                  announced = true;
                }
              };
              let output = "";
              let exitCode = 1;
              let note = "";
              try {
                const result = await env.exec(
                  coding.command(agent, promptFor(args.task, branch), cwd, previous?.nativeId ?? null),
                  {
                    cwd,
                    timeout: minutes * 60,
                    env: { PATH: `${dirname(agent.path)}:${join(homedir(), ".bun/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` },
                    onOutput: (chunk, _context, info) => {
                      output = (output + chunk).slice(-SUMMARY_CHARS * 2);
                      if (info.stream === "stdout") follow(stream.feed(chunk));
                    },
                  },
                  context,
                );
                follow(stream.flush());
                if (result.ok) exitCode = result.value.exitCode;
                else if (result.error.code === "timeout" || result.error.code === "aborted") {
                  exitCode = 124;
                  note = result.error.code === "timeout" ? `timed out after ${minutes} minutes` : "aborted";
                  session.step("note", note);
                } else if (result.error.code === "spawn_error" || result.error.code === "shell_unavailable") {
                  session.step("note", `${agent.name} did not start: ${result.error.message}`);
                  throw new NoEffect(`${agent.name} did not start: ${result.error.message}`);
                } else throw result.error;
              } finally {
                session.end(exitCode);
              }
              const report: Record<string, unknown> = { agent: agent.id, version: agent.version, exitCode, ...(note ? { note } : {}), worktree: cwd, branch, sessionId: session.id };
              if (base !== null) {
                report.base = base.slice(0, 12);
                report.commits = (await git(["log", "--oneline", "-20", `${base}..HEAD`], cwd)).out.split("\n").filter(Boolean);
                report.diffStat = (await git(["diff", "--stat", base], cwd)).out.slice(-3_000);
                report.uncommitted = (await git(["status", "--short"], cwd)).out.slice(0, 1_500);
              }
              report.summary = (stream.final ?? output.trim()).slice(-SUMMARY_CHARS);
              const json = JSON.stringify(report);
              if (exitCode !== 0) throw new KnownOutcome(json);
              return json;
            },
          )
          .catch((error: unknown) => {
            if (error instanceof KnownOutcome) return error.message;
            throw error;
          });
        const report = JSON.parse(recorded) as { exitCode: number };
        if (report.exitCode !== 0) throw new Error(`The coding agent did not finish cleanly: ${recorded}`);
        return text(recorded);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  return defineExtension({ name: "ghost.coding", tools: [agents, run] });
}
