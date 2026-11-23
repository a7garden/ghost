import { defineTool } from "./define.ts";
import { Type } from "typebox";
import type { CodingRun, CodingSession, HerdrPaneView, Work } from "@ghost/contract";
import { defineExtension, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { NoEffect } from "../core/effects.ts";
import { errorResult, requireAllowed, requireWork } from "./shared.ts";
import { visibleWorks } from "./direct.ts";
import type { HerdrPort } from "../integrations/ports.ts";

const text = (message: string): ToolExecutionResult => ({ output: [{ type: "text", text: message }] });

/** The Ghost scopes, verifies and integrates; the coding agent writes repository code. */
export const CODING_INSTRUCTIONS = `In an owner-PC Work, have a coding agent write repository code with code_run. Pass the absolute repo and a task with the goal, files to read first, boundaries, acceptance and the narrowest check. Omit agent (or say ghost) for an embedded coding session; explicitly choose omp, claude or codex for herdr. A new repository run uses an isolated worktree. Reuse the session or pane for follow-up; a working embedded session can be steered, while a herdr pane must be idle. An adopted owner pane may not be isolated. code_run returns on admission, not completion: end your turn and wait for the report. code_agents lists both executors and reads a session or pane in detail. The report separates the agent's untrusted claim from the Host's observations; inspect the diff and run the Work's own checks before integrating under the repository rules and calling complete. A dialog is for the owner alone: never answer it or send another prompt while it is open. If coding cannot start, report the blocker instead of editing the repository yourself.`;

function owningWork(core: Core, workId: string): Pick<Work, "id" | "title" | "state"> | null {
  const work = core.ledger.work(workId);
  return work ? { id: work.id, title: work.title, state: work.state } : null;
}

export function createCodingTools(core: Core, herdr: HerdrPort | null): Extension {
  const agents = defineTool({
    name: "code_agents",
    description:
      "List embedded coding sessions and the owner's herdr readiness, installed agents, and live panes. With session or pane, read that executor's recent evidence in bounded detail: the agent's untrusted claim beside what the Host observed. This tool never prompts, sends keys or closes anything.",
    parameters: Type.Object({
      pane: Type.Optional(Type.String({ minLength: 1, maxLength: 40, description: "One pane of the roster to read in bounded detail: its coding run, the agent's last claim and the observed facts" })),
      session: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "One embedded session's id; read its recent items and git changes" })),
    }),
    replay: "safe",
    async execute(args, api) {
      try {
        const authorize = () => {
          const scope = requireAllowed(core, api, "code_agents");
          if (!scope.ghost.hostExecution || scope.ghost.state !== "active") throw new NoEffect("code_agents requires current PC execution authority");
          if (scope.work && scope.work.execution?.kind !== "host") throw new NoEffect("code_agents requires an owner-PC Work");
          return scope;
        };
        if (args.pane !== undefined && args.session !== undefined) throw new NoEffect("pass only one of session and pane");
        let scope = authorize();
        const embedded = core.codingSessions;
        const visible = () => new Set(visibleWorks(core, scope).map((work) => work.id));
        const summarize = (session: CodingSession, canSee: Set<string>) => ({
          id: session.id, title: session.title, state: session.state, cwd: session.cwd, branch: session.branch,
          pendingDialog: session.pendingDialog !== null,
          ...(session.workId !== null && canSee.has(session.workId) ? { work: owningWork(core, session.workId) } : {}),
        });
        const report: Record<string, unknown> = { defaultExecutor: "ghost" };
        let detailWorkId: string | null = null;
        if (args.session !== undefined) {
          const session = embedded?.get(args.session);
          if (!embedded || !session) throw new NoEffect(`embedded session ${args.session} is not available`);
          if (session.workId !== null && !visible().has(session.workId)) throw new NoEffect(`session ${session.id} belongs to a Work this conversation cannot see`);
          const items = embedded.items(session.id, { limit: 20 });
          const changes = await embedded.changes(session.id).catch(() => null);
          scope = authorize();
          const current = embedded.get(session.id);
          detailWorkId = current?.workId ?? null;
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
        const herdrData = herdr && await Promise.all([herdr.setup(), herdr.overview()]).catch((error: unknown) => {
          if (args.pane !== undefined) throw error;
          return null;
        });
        scope = authorize();
        const canSee = visible();
        if (detailWorkId !== null && !canSee.has(detailWorkId)) throw new NoEffect("this conversation can no longer see the session's Work");
        report.sessions = embedded?.list().map((session) => summarize(session, canSee)) ?? [];
        if (!herdr || !herdrData) {
          if (args.pane !== undefined) throw new NoEffect("herdr coding is not available on this host");
          return text(JSON.stringify({ ...report, herdr: "unavailable", roster: [] }));
        }
        const [setup, view] = herdrData;
        if (setup.session !== view.session || herdr.session !== view.session) throw new NoEffect("the herdr session changed during inspection; read again");
        const installed = setup.agents.filter((agent) => agent.path !== null);
        const runs = core.coding.list();
        const matchingRun = (pane: HerdrPaneView) =>
          runs.findLast((run) => run.session === view.session && run.pane === pane.id && run.terminalId !== null && run.terminalId === pane.terminalId && run.agent === pane.agent) ?? null;
        const panes = view.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes)).filter((pane) => pane.agent !== null);
        Object.assign(report, {
          herdr: setup.herdr.path === null ? "not installed" : setup.server === null ? `installed (${setup.herdr.version ?? "unknown version"}), but no server is running in session ${setup.session}: the owner must open herdr` : "ready",
          session: setup.session,
          agents: setup.agents.map(({ id, name, path, integration }) => ({ id, name, installed: path !== null, integration })),
          usedByDefault: (installed.find((agent) => agent.id === setup.prefs.agent) ?? installed[0])?.id ?? null,
          ...(view.note !== null || !view.available ? { observationError: view.note ?? "herdr is unavailable" } : {}),
          roster: panes.map((pane) => {
            const run = matchingRun(pane);
            return {
              pane: pane.id, agent: pane.agent, status: pane.status,
              ...(run !== null && canSee.has(run.workId) ? { work: owningWork(core, run.workId), run: { id: run.id, state: run.state, turn: run.turn, stopPending: run.stopPending } } : {}),
            };
          }),
        });
        if (args.pane !== undefined) {
          const pane = panes.find((candidate) => candidate.id === args.pane);
          if (!pane) throw new NoEffect(`agent pane ${args.pane} is not in the live session`);
          const run = matchingRun(pane);
          if (run && !canSee.has(run.workId)) throw new NoEffect(`pane ${args.pane} belongs to a Work this conversation cannot see`);
          const evidence = await core.coding.inspect(args.pane);
          scope = authorize();
          const stillVisible = visible();
          if (herdr.session !== view.session) throw new NoEffect("the herdr session changed during inspection; read again");
          if (run && !stillVisible.has(run.workId)) throw new NoEffect("this conversation can no longer see the pane's Work");
          if (evidence && typeof evidence === "object" && "workId" in evidence
            && typeof evidence.workId === "string" && !stillVisible.has(evidence.workId)) throw new NoEffect("the pane's owning Work changed during inspection");
          report.detail = {
            run: run ? { id: run.id, state: run.state, turn: run.turn, deliveredTurn: run.deliveredTurn, branch: run.branch, checkout: run.checkout, stopPending: run.stopPending, updatedAt: run.updatedAt } : null,
            evidence,
          };
        }
        return text(JSON.stringify(report));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const run = defineTool({
    name: "code_run",
    description:
      "Give an owner-PC Work's coding agent a task and return on admission. Pass repo to open an isolated worktree, session to continue this Work's embedded session, or pane to continue or adopt an idle herdr pane. Embedded Ghost coding is the default; explicitly name omp, claude or codex with repo for herdr. Inspect the outcome with code_agents and verify it independently.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Absolute repository path for a new run; omit for an existing session or pane" })),
      pane: Type.Optional(Type.String({ minLength: 1, maxLength: 40, description: "The pane of an earlier code_run to carry on in its conversation and worktree, or an idle agent pane the owner started that no other Work holds; task is then the instruction given there" })),
      session: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "An embedded session opened by this Work" })),
      task: Type.String({ minLength: 1, maxLength: 24_000, description: "The goal, files to read first, decided interfaces, protected files, observable acceptance and the narrowest check to run" }),
      agent: Type.Optional(Type.Union([Type.Literal("ghost"), Type.Literal("omp"), Type.Literal("claude"), Type.Literal("codex")], { description: "Executor for a new run: ghost (embedded, default) or an explicit herdr agent" })),
      branch: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Short name for the branch and worktree, such as fix-login; defaults to one derived from the task" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireWork(requireAllowed(core, api, "code_run"));
        if (scope.work.execution?.kind !== "host") throw new NoEffect("code_run needs an owner-PC Work: create the Work with execution {kind:\"host\", cwd:\"/Users/garden/Workspace/Projects\"}");
        if (!scope.ghost.hostExecution) throw new NoEffect("PC execution was revoked by the owner");
        if ([args.repo, args.session, args.pane].filter((address) => address !== undefined).length !== 1) throw new NoEffect("pass exactly one of repo, session or pane");
        if (!api.callId) throw new NoEffect("code_run needs the model call id to journal the run under");
        if (args.pane === undefined && (args.agent === undefined || args.agent === "ghost")) {
          if (args.session !== undefined && args.branch !== undefined) throw new NoEffect("branch is only for a new run");
          const receipt = await core.coding.startEmbedded(scope.work.id, api.callId, {
            task: args.task,
            ...(args.session !== undefined ? { session: args.session } : { repo: args.repo!, ...(args.branch !== undefined ? { branch: args.branch } : {}) }),
          });
          return text(JSON.stringify({
            ...receipt, work: scope.work.id, agent: "ghost",
            note: "tracked; end this turn and wait for the report in this Work conversation. Read with code_agents; do not resend the prompt.",
          }));
        }
        if (args.session !== undefined || args.agent === "ghost") throw new NoEffect("use session with the embedded agent, or pane without an agent name");
        const run: CodingRun = await core.coding.start(scope.work.id, api.callId, {
          ...(args.repo !== undefined ? { repo: args.repo } : {}),
          ...(args.pane !== undefined ? { pane: args.pane } : {}),
          task: args.task,
          ...(args.agent !== undefined ? { agent: args.agent } : {}),
          ...(args.branch !== undefined ? { branch: args.branch } : {}),
        });
        return text(JSON.stringify({
          run: run.id,
          work: run.workId,
          pane: run.pane,
          terminalId: run.terminalId,
          agent: run.agent,
          branch: run.branch,
          checkout: run.checkout,
          state: run.state,
          turn: run.turn,
          note: "tracked; end this turn and wait for the report in this Work conversation. A starting state is not proof the agent began. Read with code_agents; do not resend the prompt.",
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  return defineExtension({ name: "ghost.coding", tools: [agents, run] });
}
