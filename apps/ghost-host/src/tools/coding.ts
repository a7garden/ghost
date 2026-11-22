import { Type } from "typebox";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { KnownOutcome, NoEffect } from "../core/effects.ts";
import { CommandError } from "../core/errors.ts";
import { errorResult, requireAllowed, requireWork } from "./shared.ts";
import { gitReport, HerdrStartError } from "../integrations/herdr.ts";
import type { HerdrPort } from "../integrations/ports.ts";

const text = (message: string): ToolExecutionResult => ({ content: [{ type: "text", text: message }] });

const DEFAULT_MINUTES = 30;
const MAX_MINUTES = 120;
/** What the agent last wrote on its terminal is kept from the end. */
const SUMMARY_CHARS = 3_000;

/** Guidance for a Ghost holding the coding tools: the Ghost scopes, verifies and integrates; the coding agent, in the owner's herdr, writes the code. */
export const CODING_INSTRUCTIONS = `Repository code is written by a coding agent running in the owner's herdr, the terminal workspace the owner codes in, not by you. code_agents says whether herdr is ready and which agents are installed. For a change in a repository, run code_run in an owner-PC Work with the repository path and a task that carries what the agent lacks: the goal, files to read first, decided interfaces, protected files, observable acceptance and the narrowest check. herdr opens a new workspace on a new branch and git worktree, so the owner's checkout stays untouched, and the owner sees the agent working in their herdr and in the app's Coding tab. Its summary is a claim: read the diff and run the project's check yourself, then integrate by the project's own rules (its AGENTS.md says whether to merge and push) and remove the worktree and branch you created once merged. When the result is not right, call code_run again with pane set to the result's pane so the same agent keeps its conversation and worktree instead of starting over. Do not edit repository files with write or edit, and do not write the code yourself when code_run fails; report what blocked it. Split work that needs more than about 30 minutes into several tasks.`;

export function createCodingTools(core: Core, herdr: HerdrPort): Extension {
  const agents = defineTool({
    name: "code_agents",
    description: "Say whether the owner's herdr is ready for coding (installed, a server running in the session coding uses) and list the coding agents installed on the Mac (omp, Claude Code, Codex) with whether herdr's integration for each is installed, and which agent code_run starts when you name none: the owner's choice in Settings, else the first installed.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api) {
      try {
        requireAllowed(core, api, "code_agents");
        const setup = await herdr.setup();
        const installed = setup.agents.filter((agent) => agent.path !== null);
        return text(JSON.stringify({
          herdr: setup.herdr.path === null ? "not installed" : setup.server === null ? `installed (${setup.herdr.version ?? "unknown version"}), but no server is running in session ${setup.session}: the owner must open herdr` : "ready",
          session: setup.session,
          agents: setup.agents.map(({ id, name, path, integration }) => ({ id, name, installed: path !== null, integration })),
          usedByDefault: (installed.find((agent) => agent.id === setup.prefs.agent) ?? installed[0])?.id ?? null,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const run = defineTool({
    name: "code_run",
    description:
      "Hand a coding task to a coding agent in the owner's herdr (code_agents says whether it is ready) and wait for it. In a git repository herdr first opens a new workspace on a new branch and worktree, so the checkout the owner works in is never touched; the agent commits there and is told never to push or merge. The owner sees the agent working in herdr and in the app. Returns the agent's last words, its state, the branch, the worktree path, the commits, the diff stat and the pane. To correct or extend a run, pass its pane: the same agent carries on in the same conversation and worktree, and repo, agent and branch are not needed. If the agent has not settled when the time is up, or is waiting for the owner to answer a dialog, the result says so and the agent keeps running in herdr. Verify the diff and run the project's check yourself before you integrate; the agent's summary is a claim.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Absolute path of the repository (or directory) to change; not needed with pane" })),
      pane: Type.Optional(Type.String({ minLength: 1, maxLength: 40, description: "The pane of an earlier code_run to carry on in its conversation and worktree; task is then the follow-up instruction" })),
      task: Type.String({ minLength: 1, maxLength: 24_000, description: "The goal, files to read first, decided interfaces, protected files, observable acceptance and the narrowest check to run" }),
      agent: Type.Optional(Type.Union([Type.Literal("omp"), Type.Literal("claude"), Type.Literal("codex")], { description: "Which agent; default the owner's choice in Settings, else the first installed" })),
      branch: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Short name for the branch and worktree, such as fix-login; defaults to one derived from the task" })),
      timeout_minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MINUTES, description: `Default ${DEFAULT_MINUTES}; split larger changes into several tasks` })),
    }),
    replay: "unsafe",
    async execute(args, api, context) {
      try {
        const scope = requireWork(requireAllowed(core, api, "code_run"));
        if (scope.work.execution?.kind !== "host") throw new NoEffect("code_run needs an owner-PC Work: create the Work with execution {kind:\"host\", cwd:\"/Users/garden/Workspace/Projects\"}");
        if (!scope.ghost.hostExecution) throw new NoEffect("PC execution was revoked by the owner");
        if (args.pane === undefined && args.repo === undefined) throw new NoEffect("pass repo, or pane to carry on an earlier run");
        const minutes = args.timeout_minutes ?? DEFAULT_MINUTES;
        const wait = { timeoutMs: minutes * 60_000, signal: context.abortSignal };
        const where = args.pane ?? args.repo!;
        const recorded = await core.effects
          .run(
            {
              conversationId: scope.conversation.id,
              callId: api.callId,
              tool: "code_run",
              input: { where, task: args.task, agent: args.agent ?? null, branch: args.branch ?? null, timeout_minutes: minutes },
              summary: `${args.agent ?? "herdr"}: ${args.task.trim().split("\n")[0]!.slice(0, 160)}`,
              // The change lands in a fresh branch worktree, so it is undone by deleting it; the agent itself can still reach anything the owner's account can.
              classification: { target: { kind: "mac", id: args.repo ?? where }, access: "write", reversible: true, external: true, amount: null },
            },
            async () => {
              let started;
              try {
                started = args.pane !== undefined
                  ? await herdr.prompt(args.pane, args.task, wait)
                  : await herdr.start({ repo: args.repo!, task: args.task, ...(args.agent ? { agent: args.agent } : {}), ...(args.branch ? { branch: args.branch } : {}) }, wait);
              } catch (error) {
                // Before herdr opened anything nothing happened; after, the pane is the owner's to see and the Ghost's to name.
                if (error instanceof HerdrStartError) throw new KnownOutcome(JSON.stringify({ pane: error.pane, error: error.message }));
                if (error instanceof CommandError) throw new NoEffect(error.message);
                throw error;
              }
              const pane = started.pane;
              const last = await herdr.output(pane.id).then((output) => output.text.slice(-SUMMARY_CHARS), () => "");
              const report: Record<string, unknown> = { agent: pane.agent, pane: pane.id, status: pane.status, settled: started.settled, worktree: started.checkout, branch: started.branch };
              if (started.settled === "timeout") report.note = `still running after ${minutes} minutes; it keeps working in herdr`;
              if (started.settled === "stalled") report.note = "the agent did not start on the prompt; look at the pane in herdr";
              if (pane.status === "blocked") report.note = "the agent is waiting for the owner to answer a dialog in herdr";
              if (started.branch !== null) Object.assign(report, await gitReport(started.checkout, started.base));
              report.summary = last;
              const json = JSON.stringify(report);
              if (started.settled !== "settled" || pane.status === "blocked") throw new KnownOutcome(json);
              return json;
            },
          )
          .catch((error: unknown) => {
            if (error instanceof KnownOutcome) return error.message;
            throw error;
          });
        const report = JSON.parse(recorded) as { settled?: string; status?: string; error?: string };
        if (report.error !== undefined || report.settled !== "settled" || report.status === "blocked") throw new Error(`The coding agent did not finish cleanly: ${recorded}`);
        return text(recorded);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  return defineExtension({ name: "ghost.coding", tools: [agents, run] });
}
