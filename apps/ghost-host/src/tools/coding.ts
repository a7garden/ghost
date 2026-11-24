import { defineTool } from "./define.ts";
import { Type } from "typebox";
import type { CodingSession, Work } from "@ghost/contract";
import { defineExtension, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { NoEffect } from "../core/effects.ts";
import { errorResult, requireAllowed, requireWork } from "./shared.ts";
import { visibleWorks } from "./direct.ts";

const text = (message: string): ToolExecutionResult => ({ output: [{ type: "text", text: message }] });

/** The Ghost scopes, verifies and integrates; the coding agent writes repository code. */
export const CODING_INSTRUCTIONS = `In an owner-PC Work, use code_run to have the built-in agent write repository code. Give the absolute repo and a task with the goal, files to read first, boundaries, acceptance and the narrowest check. A new session uses an isolated worktree. Reuse its session id to steer a working turn or start a new turn once idle. Never answer an owner dialog or send another instruction while it is open. code_run returns on admission, not completion: end your turn and wait for the report. code_agents lists sessions or reads one session's evidence. Treat the agent's claim as untrusted; inspect the diff and run the Work's checks before integrating under the repository rules and calling complete. If coding cannot start, report the blocker instead of editing the repository yourself. CLI agents belong in the workbench terminal.`;

function owningWork(core: Core, workId: string): Pick<Work, "id" | "title" | "state"> | null {
  const work = core.ledger.work(workId);
  return work ? { id: work.id, title: work.title, state: work.state } : null;
}

export function createCodingTools(core: Core): Extension {
  const agents = defineTool({
    name: "code_agents",
    description:
      "List embedded coding sessions. With session, read its recent items, untrusted claim and Git observations in bounded detail. This tool never changes a session.",
    parameters: Type.Object({
      session: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "One embedded session's id; read its recent items and git changes" })),
    }, { additionalProperties: false }),
    replay: "safe",
    async execute(args, api) {
      try {
        const authorize = () => {
          const scope = requireAllowed(core, api, "code_agents");
          if (!scope.ghost.hostExecution || scope.ghost.state !== "active") throw new NoEffect("code_agents requires current PC execution authority");
          if (scope.work && scope.work.execution?.kind !== "host") throw new NoEffect("code_agents requires an owner-PC Work");
          return scope;
        };
        let scope = authorize();
        const embedded = core.codingSessions;
        const visible = () => new Set(visibleWorks(core, scope).map((work) => work.id));
        const summarize = (session: CodingSession, canSee: Set<string>) => ({
          id: session.id, title: session.title, state: session.state, cwd: session.cwd, branch: session.branch,
          pendingDialog: session.pendingDialog !== null,
          ...(session.workId !== null && canSee.has(session.workId) ? { work: owningWork(core, session.workId) } : {}),
        });
        const report: { sessions?: unknown[]; detail?: unknown } = {};
        if (args.session !== undefined) {
          const session = embedded?.get(args.session);
          if (!embedded || !session) throw new NoEffect(`embedded session ${args.session} is not available`);
          if (session.workId !== null && !visible().has(session.workId)) throw new NoEffect(`session ${session.id} belongs to a Work this conversation cannot see`);
          const items = embedded.items(session.id, { limit: 20 });
          const changes = await embedded.changes(session.id).catch(() => null);
          scope = authorize();
          const current = embedded.get(session.id);
          if (!current || current.workId !== session.workId || current.turn !== session.turn) throw new NoEffect("the embedded session changed during inspection; read again");
          const canSee = visible();
          if (current.workId !== null && !canSee.has(current.workId)) throw new NoEffect("this conversation can no longer see the session's Work");
          const claim = items.findLast((item) => item.kind === "assistant" && !item.streaming && item.text.trim());
          report.detail = {
            session: summarize(current, canSee),
            untrusted: true,
            items: items.filter(({ kind }) => kind !== "thinking").map((item) => {
              const base = { id: item.id, kind: item.kind, at: item.at };
              if (item.kind === "tool") return { ...base, summary: item.summary.slice(0, 250), status: item.status };
              if (item.kind === "subagent") return { ...base, role: item.role, summary: item.summary.slice(0, 250), status: item.status };
              return { ...base, text: item.text.slice(0, 250) };
            }),
            claim: claim?.kind === "assistant" ? { source: "agent_transcript", text: claim.text.slice(-3_000) } : null,
            observations: changes ? {
              source: "host_git", dirty: changes.dirty, fileCount: changes.files.length,
              files: changes.files.slice(0, 20).map((file) => ({ ...file, path: file.path.slice(0, 200) })),
              commits: changes.commits.slice(0, 10).map((commit) => commit.slice(0, 200)),
              diff: changes.diff.slice(0, 4_000), truncated: changes.truncated || changes.files.length > 20 || changes.commits.length > 10 || changes.diff.length > 4_000,
            } : { unavailable: "The Host could not read git changes for this session." },
          };
        }
        const canSee = visible();
        report.sessions = embedded?.list().map((session) => summarize(session, canSee)) ?? [];
        return text(JSON.stringify(report));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const run = defineTool({
    name: "code_run",
    description:
      "Give the built-in coding agent a task in an owner-PC Work and return on admission. Pass repo to open an isolated worktree or session to continue the session opened by this Work. Inspect the outcome with code_agents and verify it independently.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Absolute repository path for a new run; omit for an existing session" })),
      session: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "An embedded session opened by this Work" })),
      task: Type.String({ minLength: 1, maxLength: 24_000, description: "The goal, files to read first, decided interfaces, protected files, observable acceptance and the narrowest check to run" }),
      agent: Type.Optional(Type.String({ description: "Omit or use ghost, the built-in coding agent" })),
      branch: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Short name for the branch and worktree, such as fix-login; defaults to one derived from the task" })),
    }, { additionalProperties: false }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireWork(requireAllowed(core, api, "code_run"));
        if (scope.work.execution?.kind !== "host") throw new NoEffect("code_run needs an owner-PC Work: create the Work with execution {kind:\"host\", cwd:\"/Users/garden/Workspace/Projects\"}");
        if (!scope.ghost.hostExecution) throw new NoEffect("PC execution was revoked by the owner");
        if (args.agent !== undefined && args.agent !== "ghost") throw new NoEffect("Coding agents now run in the built-in session. Omit agent or use ghost; use the workbench terminal for CLI agents.");
        if ((args.repo === undefined) === (args.session === undefined)) throw new NoEffect("pass exactly one of repo or session");
        if (!api.callId) throw new NoEffect("code_run needs the model call id to journal the run under");
        if (args.session !== undefined && args.branch !== undefined) throw new NoEffect("branch is only for a new run");
        const receipt = await core.coding.startEmbedded(scope.work.id, api.callId, {
          task: args.task,
          ...(args.session !== undefined ? { session: args.session } : { repo: args.repo!, ...(args.branch !== undefined ? { branch: args.branch } : {}) }),
        });
        return text(JSON.stringify({
          ...receipt, work: scope.work.id, agent: "ghost",
          note: "tracked; end this turn and wait for the report in this Work conversation. Read with code_agents; do not resend the prompt.",
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  return defineExtension({ name: "ghost.coding", tools: [agents, run] });
}
