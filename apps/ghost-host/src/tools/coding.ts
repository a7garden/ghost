import { Type } from "typebox";
import type { CodingRun, HerdrPaneView, Work } from "@ghost/contract";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { NoEffect } from "../core/effects.ts";
import { errorResult, requireAllowed, requireWork } from "./shared.ts";
import { visibleWorks } from "./direct.ts";
import type { HerdrPort } from "../integrations/ports.ts";

const text = (message: string): ToolExecutionResult => ({ content: [{ type: "text", text: message }] });

/** Guidance for a Ghost holding the coding tools: the Ghost scopes, verifies and integrates; the coding agent, in the owner's herdr, writes the code. */
export const CODING_INSTRUCTIONS = `Repository code is written by a coding agent running in the owner's herdr, the terminal workspace the owner codes in, not by you. code_agents says whether herdr is ready, which agents are installed, and which agents are live in the session now. For a change in a repository, run code_run in an owner-PC Work with the repository path and a task that carries what the agent lacks: the goal, files to read first, decided interfaces, protected files, observable acceptance and the narrowest check. code_run starts the agent and returns at once: herdr opens a new workspace on a new branch and git worktree, so the owner's checkout stays untouched, and the owner sees the agent working in their herdr and in the app's Coding tab. End your turn after starting; when the agent settles, its report is delivered to this Work's conversation, and while it works you can follow it with code_agents (the roster, or one pane in detail) or work_inspect. Its report is a claim: read the diff and run the project's check yourself, then integrate by the project's own rules (its AGENTS.md says whether to merge and push) and remove the worktree and branch you created once merged. To correct or extend a run, call code_run again with pane set to the run's pane so the same agent keeps its conversation and worktree instead of starting over; a run carries only a few such turns, so give each one a whole task. With pane you may also take over an idle agent pane the owner already started in herdr, when no other Work holds it: herdr did not isolate that pane, so it may be working in the owner's own checkout — name the protected files in the task and check the diff exactly where it worked. An agent waiting at a dialog waits for the owner, not for you: never answer a permission dialog for it. Do not edit repository files with write or edit, and do not write the code yourself when code_run fails; report what blocked it.`;

function owningWork(core: Core, workId: string): Pick<Work, "id" | "title" | "state"> | null {
  const work = core.ledger.work(workId);
  return work ? { id: work.id, title: work.title, state: work.state } : null;
}

export function createCodingTools(core: Core, herdr: HerdrPort): Extension {
  const agents = defineTool({
    name: "code_agents",
    description:
      "Say whether the owner's herdr is ready for coding (installed, a server running in the session coding uses), list the coding agents installed on the Mac (omp, Claude Code, Codex) with whether herdr's integration for each is installed, which agent code_run starts when you name none (the owner's choice in Settings, else the first installed), and the agents live in the session now: one line per pane with its agent, its state, and the 맡긴 일 that owns it when your conversation may see that Work. With pane, also that pane's coding run in bounded detail — its state and turn, the branch and worktree, and the agent's last claim beside what was observed; those are the agent's own untrusted words. Reading only: it never prompts, keys or closes anything.",
    parameters: Type.Object({
      pane: Type.Optional(Type.String({ minLength: 1, maxLength: 40, description: "One pane of the roster to read in bounded detail: its coding run, the agent's last claim and the observed facts" })),
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
        authorize();
        const [setup, view] = await Promise.all([herdr.setup(), herdr.overview()]);
        let scope = authorize();
        if (setup.session !== view.session || herdr.session !== view.session) throw new NoEffect("the herdr session changed during inspection; read again");
        const installed = setup.agents.filter((agent) => agent.path !== null);
        const runs = core.coding.list();
        let visible = new Set(visibleWorks(core, scope).map((work) => work.id));
        const matchingRun = (pane: HerdrPaneView) =>
          runs.findLast((run) => run.session === view.session && run.pane === pane.id && run.terminalId !== null && run.terminalId === pane.terminalId && run.agent === pane.agent) ?? null;
        const panes = view.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes)).filter((pane) => pane.agent !== null);
        const report: Record<string, unknown> = {
          herdr: setup.herdr.path === null ? "not installed" : setup.server === null ? `installed (${setup.herdr.version ?? "unknown version"}), but no server is running in session ${setup.session}: the owner must open herdr` : "ready",
          session: setup.session,
          agents: setup.agents.map(({ id, name, path, integration }) => ({ id, name, installed: path !== null, integration })),
          usedByDefault: (installed.find((agent) => agent.id === setup.prefs.agent) ?? installed[0])?.id ?? null,
          ...(view.note !== null || !view.available ? { observationError: view.note ?? "herdr is unavailable" } : {}),
          // The live session as herdr classifies it. Pane words are untrusted, so a line carries only the agent, its state and, when this conversation may see the Work, what owns it.
          roster: panes.map((pane) => {
            const run = matchingRun(pane);
            const owned = run !== null && visible.has(run.workId);
            return {
              pane: pane.id,
              agent: pane.agent,
              status: pane.status,
              ...(run !== null && owned ? { work: owningWork(core, run.workId), run: { id: run.id, state: run.state, turn: run.turn, stopPending: run.stopPending } } : {}),
            };
          }),
        };
        if (args.pane !== undefined) {
          const pane = panes.find((candidate) => candidate.id === args.pane);
          if (!pane) throw new NoEffect(`agent pane ${args.pane} is not in the live session`);
          const run = matchingRun(pane);
          if (run && !visible.has(run.workId)) throw new NoEffect(`pane ${args.pane} belongs to a Work this conversation cannot see`);
          const evidence = await core.coding.inspect(args.pane);
          scope = authorize();
          visible = new Set(visibleWorks(core, scope).map((work) => work.id));
          if (herdr.session !== view.session) throw new NoEffect("the herdr session changed during inspection; read again");
          if (run && !visible.has(run.workId)) throw new NoEffect("this conversation can no longer see the pane's Work");
          if (evidence && typeof evidence === "object" && "workId" in evidence
            && typeof evidence.workId === "string" && !visible.has(evidence.workId)) throw new NoEffect("the pane's owning Work changed during inspection");
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
      "Start a coding agent on a task in the owner's herdr (code_agents says whether it is ready) and return at once; the agent keeps working in herdr after this call and its report is delivered to this Work's conversation when it settles. In a git repository herdr first opens a new workspace on a new branch and worktree, so the checkout the owner works in is never touched; the agent commits there and is told never to push or merge. The owner sees the agent working in herdr and in the app. Follow it with code_agents (the roster, or its pane in detail) and work_inspect; the agent's summary is a claim, so verify the diff and run the project's check yourself before you integrate. To correct or extend a run, pass its pane: the same agent carries on in the same conversation and worktree, and repo, agent and branch are not needed. An idle agent pane the owner already started in herdr, that no other Work holds, can be taken over the same way — herdr did not isolate it, so it may be working in the owner's own checkout rather than a fresh worktree: name the protected files and check the diff where it worked.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Absolute path of the repository (or directory) to change; not needed with pane" })),
      pane: Type.Optional(Type.String({ minLength: 1, maxLength: 40, description: "The pane of an earlier code_run to carry on in its conversation and worktree, or an idle agent pane the owner started that no other Work holds; task is then the instruction given there" })),
      task: Type.String({ minLength: 1, maxLength: 24_000, description: "The goal, files to read first, decided interfaces, protected files, observable acceptance and the narrowest check to run" }),
      agent: Type.Optional(Type.Union([Type.Literal("omp"), Type.Literal("claude"), Type.Literal("codex")], { description: "Which agent; default the owner's choice in Settings, else the first installed" })),
      branch: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Short name for the branch and worktree, such as fix-login; defaults to one derived from the task" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireWork(requireAllowed(core, api, "code_run"));
        if (scope.work.execution?.kind !== "host") throw new NoEffect("code_run needs an owner-PC Work: create the Work with execution {kind:\"host\", cwd:\"/Users/garden/Workspace/Projects\"}");
        if (!scope.ghost.hostExecution) throw new NoEffect("PC execution was revoked by the owner");
        if (args.pane === undefined && args.repo === undefined) throw new NoEffect("pass repo, or pane to carry on an earlier run");
        if (!api.callId) throw new NoEffect("code_run needs the model call id to journal the run under");
        // The core coding service owns the effect, the pane reservation and the agent launch; the tool only passes the call through.
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
