import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { CodingRun, HerdrPaneView, HerdrView } from "@ghost/contract";
import { DEFAULT_RULES } from "../src/core/policy.ts";
import { policyTaint } from "../src/core/policy-context.ts";
import { createCodingTools } from "../src/tools/coding.ts";
import type { HerdrPort } from "../src/integrations/ports.ts";
import type { Core } from "../src/core/core.ts";
import type { Ledger } from "../src/ledger/ledger.ts";
import { harness, hostTaskId, tempDir } from "./support.ts";

const context = { abortSignal: undefined } as Context;
const openedHarnesses: { core: Core; ledger: Ledger }[] = [];
afterEach(async () => { for (const h of openedHarnesses.splice(0)) { h.core.stop(); await h.core.idle(); h.ledger.close(); } });

/** A herdr that only answers reads; every submitting method records the attempt and fails the test through the spy. */
function readHerdr() {
  const calls: { op: string; arg: unknown }[] = [];
  const refuse = (op: string) => async (arg: unknown): Promise<never> => {
    calls.push({ op, arg });
    throw new Error(`${op} must not be called by a read`);
  };
  const pane: HerdrPaneView = {
    id: "w1:p1", workspaceId: "w1", tabId: "w1:t1", workspace: "repo", tab: "work", agent: "omp", status: "working",
    cwd: "/Users/garden/Workspace/Projects/repo", title: "work", focused: false, owned: true, terminalId: "term-1",
  };
  const view: HerdrView = {
    available: true, session: "default", note: null,
    workspaces: [{ id: "w1", label: "repo", status: "working", worktree: null, tabs: [{ id: "w1:t1", label: "work", status: "working", panes: [pane] }] }],
  };
  return {
    calls,
    herdr: {
      session: "default",
      overview: async () => { calls.push({ op: "overview", arg: null }); return view; },
      setup: async () => {
        calls.push({ op: "setup", arg: null });
        return {
          herdr: { path: "/bin/herdr", version: "0.9.5" }, config: { ok: true, note: null }, session: "default",
          sessions: [{ name: "default", running: true }], server: { version: "0.9.5", compatible: true, restartNeeded: false },
          agents: [{ id: "omp", name: "omp", path: "/bin/omp", integration: "current" as const }, { id: "claude", name: "claude", path: null, integration: "missing" as const }, { id: "codex", name: "codex", path: null, integration: "missing" as const }],
          kinds: [], prefs: { session: null, agent: null, notify: "blocked" },
        };
      },
      prompt: refuse("prompt"),
      start: refuse("start"),
      input: refuse("input"),
      answer: refuse("answer"), ask: async () => null, chat: async () => ({ pane: "w1:p1", source: "omp", title: null, model: null, items: [], cursor: "c0", reset: false }),
      commands: refuse("commands"),
      changes: async () => ({ pane, git: false, branch: null, base: null, commits: [], files: [] }),
      diff: async () => ({ path: "", diff: "", truncated: false }),
      installIntegration: async () => {}, createWorkspace: refuse("createWorkspace"), createTab: refuse("createTab"), split: refuse("split"),
      startAgent: refuse("startAgent"), rename: refuse("rename"), close: refuse("close"),
      control: refuse("control"), controlSend: refuse("controlSend"), controlRelease: refuse("controlRelease"),
      terminal: refuse("terminal"),
    } as unknown as HerdrPort,
  };
}

/** The core coding service as the tools see it: list, inspect and start only, exactly the surface the shared contract allows. */
function stubCoding(runs: CodingRun[]) {
  const started: { workId: string; callId: string; input: Record<string, unknown> }[] = [];
  const service = {
    started,
    list: (workId?: string) => runs.filter(run => workId === undefined || run.workId === workId),
    inspect: async (pane: string) => ({ pane, claim: "changed b.txt; checked nothing", observed: { commits: 1, branch: "ghost/add-b" } }),
    start: async (workId: string, callId: string, input: Record<string, unknown>) => {
      started.push({ workId, callId, input });
      return runs.find(run => run.workId === workId) ?? runs[0]!;
    },
    decorate: (view: HerdrView) => view,
    pending: () => false, working: () => false, poll: async () => {}, cancel: () => {}, attach: () => {}, watch: () => {}, stop: () => {},
  };
  return service;
}

function codingSetup() {
  const h = harness();
  openedHarnesses.push(h);
  h.core.createGhost({ name: "Main", persona: "" });
  const ghost = h.core.createGhost({ name: "Coder", persona: "", tools: ["code_agents", "code_run"], hostExecution: true });
  const direct = h.ledger.conversation(ghost.directConversationId);
  h.ledger.setPiConversationId(direct.id, "pi-coder");
  const scopeDir = realpathSync(tempDir());
  const work = h.core.works.createRoot({ ghostId: ghost.id, title: "Add b.txt", brief: "Add b", originConversationId: direct.id, execution: { kind: "host", cwd: scopeDir } });
  const run: CodingRun = {
    id: "run-1", workId: work.id, session: "default", pane: "w1:p1", terminalId: "term-1", agent: "omp",
    checkout: join(scopeDir, "wt", "repo-add-b"), branch: "ghost/add-b", base: "deadbeef",
    turn: 1, deliveredTurn: 0, state: "working", startedAt: 1, updatedAt: 2, seenWorking: true,
    prompt: "Add b.txt", cursor: "c1", report: null, stopPending: false,
  };
  const reads = readHerdr();
  const coding = stubCoding([run]);
  // The tools' dependency seam: the test installs its own coding service where Core exposes the real one.
  const codingSlot = h.core as unknown as { coding: typeof coding };
  codingSlot.coding = coding;
  const tools = createCodingTools(h.core, reads.herdr).tools!;
  const call = async (name: string, args: object, callId: string, conversation = "pi-coder", api?: Partial<ToolExecutionApi>) => {
    const out = await tools.find(tool => tool.name === name)!.execute(args as never,
      { conversationId: conversation, taskId: hostTaskId(), callId, output: () => {}, diagnostic: () => {}, ...api } as unknown as ToolExecutionApi, context);
    const part = out.output?.[0];
    return { isError: out.isError === true, text: part?.type === "text" ? part.text : "" };
  };
  return { ...h, ghost, direct, work, run, reads, coding, call };
}

test("code_agents reads the live session and its coding runs, and submits nothing", async () => {
  const s = codingSetup();
  const result = await s.call("code_agents", {}, "list-1");
  expect(result.isError).toBeFalsy();
  const report = JSON.parse(result.text);
  // Installation readiness is preserved beside the live roster.
  expect(report).toMatchObject({ herdr: "ready", session: "default", defaultExecutor: "ghost", usedByDefault: "omp" });
  expect(report.roster).toEqual([{ pane: "w1:p1", agent: "omp", status: "working", work: { id: s.work.id, title: "Add b.txt", state: expect.any(String) }, run: { id: "run-1", state: "working", turn: 1, stopPending: false } }]);
  expect(s.reads.calls.map(call => call.op)).toContain("overview");
  expect(s.reads.calls.filter(call => call.op !== "overview" && call.op !== "setup")).toEqual([]);
  // The roster words are untrusted agent output: the conversation is marked as having read it.
  expect(policyTaint(s.core, s.direct.id)).toMatchObject({ untrustedInput: true, privateData: true });
});

test("one pane's detail is bounded untrusted evidence for a conversation that may see the Work, and only the roster for anyone else", async () => {
  const s = codingSetup();
  const own = await s.call("code_agents", { pane: "w1:p1" }, "detail-1");
  expect(own.isError).toBeFalsy();
  const detail = JSON.parse(own.text).detail;
  expect(detail.run).toMatchObject({ id: "run-1", state: "working", turn: 1, branch: "ghost/add-b" });
  expect(detail.evidence).toMatchObject({ claim: "changed b.txt; checked nothing", observed: { branch: "ghost/add-b" } });
  // A different Ghost's conversation, not the main one and not the Work's owner, sees the pane but not the Work or the detail.
  const other = s.core.createGhost({ name: "Other", persona: "", tools: ["code_agents"], hostExecution: true });
  const otherDirect = s.core.ledger.conversation(other.directConversationId);
  s.ledger.setPiConversationId(otherDirect.id, "pi-other");
  const roster = JSON.parse((await s.call("code_agents", {}, "list-2", "pi-other")).text);
  expect(roster.roster).toEqual([{ pane: "w1:p1", agent: "omp", status: "working" }]);
  const refused = await s.call("code_agents", { pane: "w1:p1" }, "detail-2", "pi-other");
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("cannot see");
  expect(s.reads.calls.filter(call => call.op !== "overview" && call.op !== "setup")).toEqual([]);
});

test("code_agents needs its Host task identity for the read it makes", async () => {
  const s = codingSetup();
  const result = await s.call("code_agents", {}, "no-task", "pi-coder", { taskId: undefined });
  expect(result.isError).toBe(true);
  expect(result.text).toContain("task identity");
});



test("revoked PC execution refuses both coding tools inside a host Work before anything is read or started", async () => {
  const s = codingSetup();
  await s.core.idle();
  const workConversation = s.ledger.work(s.work.id).conversationId!;
  s.ledger.setPiConversationId(workConversation, "pi-work");
  s.ledger.tx(() => s.ledger.putGhost({ ...s.ledger.ghost(s.ghost.id), hostExecution: false }));

  const run = await s.call("code_run", { repo: "/repo", task: "x" }, "revoked-run", "pi-work");
  expect(run.isError).toBe(true);
  expect(run.text).toContain("revoked");
  const agents = await s.call("code_agents", {}, "revoked-list", "pi-work");
  expect(agents.isError).toBe(true);
  expect(agents.text).toContain("revoked");
  expect(s.coding.started).toEqual([]);
  expect(s.reads.calls).toEqual([]);
});

test("code_run needs an owner-PC Work, and code_agents stays a direct and work tool", async () => {
  const s = codingSetup();
  await s.core.idle();
  const confined = s.core.works.createRoot({ ghostId: s.ghost.id, title: "Confined", brief: "b", originConversationId: s.direct.id });
  await s.core.idle();
  const confinedConversation = s.ledger.work(confined.id).conversationId!;
  s.ledger.setPiConversationId(confinedConversation, "pi-confined");
  const refused = await s.call("code_run", { repo: "/repo", task: "x" }, "confined-run", "pi-confined");
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("owner-PC Work");
  expect(s.coding.started).toEqual([]);
  const agents = await s.call("code_agents", {}, "confined-list", "pi-confined");
  expect(agents.isError).toBe(true);
  expect(s.reads.calls).toEqual([]);
});

test("direct pane reads need PC authority and discard results after grant revocation", async () => {
  const denied = codingSetup();
  denied.ledger.tx(() => denied.ledger.putGhost({ ...denied.ledger.ghost(denied.ghost.id), hostExecution: false }));
  expect((await denied.call("code_agents", {}, "direct-denied")).isError).toBe(true);
  expect(denied.reads.calls).toEqual([]);

  const revoked = codingSetup();
  const setup = revoked.reads.herdr.setup;
  revoked.reads.herdr.setup = async () => {
    await Promise.resolve();
    revoked.ledger.tx(() => revoked.ledger.putGhost({ ...revoked.ledger.ghost(revoked.ghost.id), hostExecution: false }));
    return setup();
  };
  const result = await revoked.call("code_agents", { pane: "w1:p1" }, "revoke-during-read");
  expect(result.isError).toBe(true);
  expect(result.text).not.toContain("changed b.txt");
});

test("an owner pane without a matching terminal and session is inspected without stale Work attribution", async () => {
  const s = codingSetup();
  s.run.session = "another-session";
  const result = await s.call("code_agents", { pane: "w1:p1" }, "unbound-pane");
  expect(result.isError).toBeFalsy();
  const report = JSON.parse(result.text);
  expect(report.roster[0]).not.toHaveProperty("work");
  expect(report.detail).toMatchObject({ run: null, evidence: { claim: "changed b.txt; checked nothing" } });
});

test("the explicit omp, claude and codex executors and an unqualified pane still use herdr", async () => {
  const s = codingSetup();
  await s.core.idle();
  const conversation = s.ledger.work(s.work.id).conversationId!;
  s.ledger.setPiConversationId(conversation, "pi-work");
  for (const agent of ["omp", "claude", "codex"] as const) {
    const input = { repo: "/repo", agent, task: "Inspect the fixture" };
    expect((await s.call("code_run", input, agent, "pi-work")).isError).toBeFalsy();
    expect(s.coding.started.at(-1)).toEqual({ workId: s.work.id, callId: agent, input });
  }
  const pane = { pane: "w1:p1", task: "Continue in the pane" };
  expect((await s.call("code_run", pane, "pane", "pi-work")).isError).toBeFalsy();
  expect(s.coding.started.at(-1)).toEqual({ workId: s.work.id, callId: "pane", input: pane });
});
