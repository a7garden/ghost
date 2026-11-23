import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { CodingRun, HerdrChanges, HerdrChat, HerdrChatItem, HerdrPaneView, HerdrView, Work } from "@ghost/contract";
import { budgetSpent } from "../src/core/budget.ts";
import type { Core } from "../src/core/core.ts";
import type { Submission } from "../src/core/ports.ts";
import { workDetail } from "../src/core/state.ts";
import { CodingWatcher } from "../src/integrations/coding-watch.ts";
import type { HerdrPort, HerdrRun } from "../src/integrations/ports.ts";
import { FakeEngine, harness, tempDir } from "./support.ts";

const REPO = "/tmp";
const CHECKOUT = "/nonexistent-ghost-test-checkout";
const reportId = (run: CodingRun) => `run:${run.id}:turn:${run.turn}`;
const codingInput = { repo: REPO, task: "Implement the requested change" };

class HerdrFixture implements Pick<HerdrPort, "session" | "overview" | "start" | "prompt" | "chat" | "changes" | "ask" | "output" | "interrupt" | "close"> {
  session = "owner";
  pane: HerdrPaneView & { terminalId: string } = {
    id: "w1:p1", terminalId: "terminal-1", workspaceId: "w1", tabId: "w1:t1", workspace: "repo", tab: "agent", agent: "omp",
    status: "idle", cwd: null, title: "coding agent", focused: false, owned: true, completionSeq: 4, stateChangeSeq: 8, agentSessionId: "agent-session-1",
  };
  starts = 0;
  closes = 0;
  readonly writes: { session: string; text: string }[] = [];
  readonly interrupts: string[] = [];
  readonly sessions: string[] = [];
  readonly items: HerdrChatItem[] = [];
  transcriptAvailable = false;
  idleOnInterrupt = true;
  statusOnAck: HerdrPaneView["status"] = "idle";
  beforePrompt?: () => void | Promise<void>;
  beforeOverview?: () => void | Promise<void>;

  state(status: HerdrPaneView["status"], completed = false) {
    this.pane = {
      ...this.pane, status, stateChangeSeq: (this.pane.stateChangeSeq ?? 0) + 1,
      ...(completed ? { completionSeq: (this.pane.completionSeq ?? 0) + 1 } : {}),
    };
  }
  async overview(session = this.session): Promise<HerdrView> {
    this.sessions.push(session);
    await this.beforeOverview?.();
    return {
      available: true, session, note: null, workspaces: session === "owner" ? [{
        id: "w1", label: "repo", worktree: { path: CHECKOUT, branch: "ghost/topic" }, status: this.pane.status,
        tabs: [{ id: "w1:t1", label: "agent", status: this.pane.status, panes: [{ ...this.pane }] }],
      }] : [],
    };
  }
  private run(): HerdrRun {
    return { pane: { ...this.pane }, checkout: CHECKOUT, branch: "ghost/topic", base: null, settled: "unwaited" };
  }
  async start(input: Parameters<HerdrPort["start"]>[0], wait?: Parameters<HerdrPort["start"]>[1], opened?: Parameters<HerdrPort["start"]>[2], guard?: Parameters<HerdrPort["start"]>[3]) {
    expect(wait).toBeUndefined();
    guard?.authorize("open");
    this.starts++;
    opened?.(this.run());
    guard?.authorize("launch", this.pane);
    await this.beforePrompt?.();
    guard?.authorize("prompt", this.pane);
    this.writes.push({ session: guard?.session ?? this.session, text: input.task });
    this.state(this.statusOnAck);
    return this.run();
  }
  async prompt(pane: string, text: string, wait?: Parameters<HerdrPort["prompt"]>[2], guard?: Parameters<HerdrPort["prompt"]>[3]) {
    expect(wait).toBeUndefined();
    await this.beforePrompt?.();
    if (!guard || pane !== this.pane.id || guard.terminalId !== this.pane.terminalId || guard.agent !== this.pane.agent || !["idle", "done"].includes(this.pane.status)) throw new Error("wrong or busy terminal");
    guard.authorize(this.pane);
    this.writes.push({ session: guard.session, text });
    this.state(this.statusOnAck);
    return this.run();
  }
  async chat(pane: string, after: string | null): Promise<HerdrChat> {
    return { pane, source: this.transcriptAvailable ? "omp" : null, title: null, model: null, items: this.items.slice(Number(after)), cursor: String(this.items.length), reset: false };
  }
  async ask() { return null; }
  async changes(): Promise<HerdrChanges> {
    return { git: true, branch: "owner-branch", base: "d0c0aa0", commits: [], files: [], truncated: false };
  }
  async output() { return { pane: { ...this.pane }, text: "terminal tail" }; }
  async interrupt(session: string, pane: string, terminalId: string, guard?: { agent: string; authorize: (pane?: HerdrPaneView) => void }) {
    expect(session).toBe("owner");
    expect(pane).toBe(this.pane.id);
    expect(terminalId).toBe(this.pane.terminalId);
    expect(guard?.agent).toBe(this.pane.agent ?? undefined);
    guard?.authorize({ ...this.pane });
    this.interrupts.push(terminalId);
    if (this.idleOnInterrupt) this.state("idle");
  }

  /** This fixture implements only the port methods the coding service and watcher use. */
  get port(): HerdrPort { return this as unknown as HerdrPort; }
  async close() { this.closes++; }
}

class CodingEngine extends FakeEngine {
  readonly reportAttempts: Submission[] = [];
  beforeReport?: () => void | Promise<void>;
  rejectAfterReport = false;

  override async submit(conversationId: string, submission: Submission, authorize?: () => void) {
    if (submission.requestId.startsWith("run:")) {
      this.reportAttempts.push(submission);
      await this.beforeReport?.();
    }
    authorize?.();
    await super.submit(conversationId, submission);
    if (submission.requestId.startsWith("run:") && this.rejectAfterReport) throw new Error("host missed the admission ACK");
  }
}

async function setup(path = ":memory:") {
  const h = harness(path);
  const herdr = new HerdrFixture();
  const engine = new CodingEngine();
  h.core.attach(engine);
  h.core.coding.attach(herdr.port);
  const ghost = h.core.createGhost({ name: "Builder", persona: "", hostExecution: true, tools: ["code_run"] });
  async function work(execution: Work["execution"] = { kind: "host", cwd: REPO }, budgetMinutes = 2) {
    const created = h.core.works.createRoot({ ghostId: ghost.id, originConversationId: ghost.directConversationId, title: "Fix", brief: "Fix the issue", execution: execution!, budgetMinutes });
    await h.core.idle();
    return h.ledger.work(created.id);
  }
  return { ...h, herdr, engine, ghost, work };
}

function textEntry(kind: "user" | "agent", text: string): HerdrChatItem {
  return { id: crypto.randomUUID(), kind, text, at: null };
}

async function approveAdoption(core: Core, workId: string): Promise<CodingRun> {
  const decision = core.ledger.pendingDecisions({ workId }).find(({ kind }) => kind === "approve_effect");
  expect(decision).toBeDefined();
  await core.decisions.resolve(decision!.id, { outcome: "approve" });
  await core.idle();
  const [run] = core.coding.list(workId);
  expect(run).toBeDefined();
  return run!;
}

test("code run returns on ACK, not settlement, and idle does not manufacture a result", async () => {
  const h = await setup();
  const work = await h.work();
  h.herdr.beforePrompt = () => {
    const [run] = h.core.coding.list(work.id);
    expect(run).toMatchObject({ state: "starting", pane: "w1:p1", terminalId: "terminal-1" });
    expect(h.ledger.effectByCall(work.conversationId!, "first")?.state).toBe("pending");
  };
  const run = await h.core.coding.start(work.id, "first", codingInput);
  expect(run).toMatchObject({ state: "starting", turn: 1, deliveredTurn: 0, report: null, seenWorking: false });
  expect(h.ledger.effectByCall(work.conversationId!, "first")?.state).toBe("done");
  expect(h.herdr.writes).toHaveLength(1);
  expect(workDetail(h.core, work.id).codingRuns).toEqual([run]);
  const linked = h.core.coding.decorate(await h.herdr.overview()).workspaces[0]?.tabs[0]?.panes[0];
  expect(linked).toMatchObject({ codingRunId: run.id, codingWorkId: work.id });
  expect(() => h.core.works.complete(work.id, { summary: "too early", artifacts: [] })).toThrow(/coding turn/);
  h.core.works.onIdle(work.id);
  await h.core.coding.poll(run.startedAt + 200);
  expect(h.ledger.work(work.id).state).toBe("waiting");
  expect(h.core.coding.list(work.id)[0]?.state).toBe("starting");
  expect(h.engine.reportAttempts).toBeEmpty();
  expect(h.ledger.idleNudges(work.id)).toBe(0);
  await h.core.coding.poll(run.startedAt + 31_000);
  expect(h.core.coding.list(work.id)[0]).toMatchObject({ state: "stalled", deliveredTurn: 1 });
  expect(h.herdr.writes).toHaveLength(1);
});

test("a new completion sequence catches a fast turn; a report ACK lost before marking retries the same id and body on restart", async () => {
  const root = tempDir();
  const path = join(root, "ledger.db");
  const first = await setup(path);
  let second: ReturnType<typeof harness> | undefined;
  try {
    const work = await first.work();
    first.herdr.transcriptAvailable = true;
    const run = await first.core.coding.start(work.id, "first", codingInput);
    first.core.works.onIdle(work.id);
    first.herdr.items.push(
      { id: "projected-user", kind: "user", at: null, text: codingInput.task, codingReference: reportId(run) },
      textEntry("agent", "I ran a check"),
      { id: "private-tool", kind: "tool", name: "bash", summary: "do not include this", ok: false, at: null },
    );
    first.herdr.state("done", true);
    first.engine.rejectAfterReport = true;
    await first.core.coding.poll();
    const persisted = first.core.coding.list(work.id)[0]!;
    expect(persisted).toMatchObject({ state: "settled", deliveredTurn: 0, seenWorking: false });
    expect(JSON.parse(persisted.report!)).toMatchObject({ claim: { source: "agent_transcript", text: "I ran a check" }, observations: null });
    expect(persisted.report).not.toContain("do not include this");
    expect(first.ledger.work(work.id).state).toBe("waiting");
    expect(first.engine.submissions.has(reportId(run))).toBe(true);
    first.core.stop();
    await first.core.idle();
    first.ledger.close();

    second = harness(path);
    first.engine.rejectAfterReport = false;
    second.core.attach(first.engine); // The admission map stands in for Pi's durable request-id index.
    second.core.coding.attach(first.herdr.port);
    await second.core.start();
    await second.core.coding.poll();
    await second.core.coding.poll();
    expect(first.engine.reportAttempts).toHaveLength(2);
    expect(first.engine.reportAttempts[1]).toEqual(first.engine.reportAttempts[0]);
    expect(first.engine.to(work.conversationId!).filter((entry) => entry.requestId === reportId(run))).toHaveLength(1);
    expect(first.herdr.writes).toHaveLength(1);
    expect(second.core.coding.list(work.id)[0]).toMatchObject({ report: persisted.report, deliveredTurn: 1 });
    expect(second.ledger.work(work.id).state).toBe("running");
  } finally {
    if (second) {
      second.core.stop();
      await second.core.idle();
      second.ledger.close();
    } else {
      first.core.stop();
      await first.core.idle();
      first.ledger.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("an opened but unprompted terminal never replays input or counts startup activity as completion", async () => {
  const h = await setup();
  const work = await h.work();
  h.herdr.beforePrompt = () => { throw new Error("transport stopped before prompt dispatch"); };
  const run = await h.core.coding.start(work.id, "first", codingInput);
  expect(run).toMatchObject({ pane: h.herdr.pane.id, state: "starting" });
  const effect = h.ledger.effectByCall(work.conversationId!, "first")!;
  // A crash in the same window would leave the previously committed effect pending.
  h.ledger.tx(() => h.ledger.putEffect({ ...effect, state: "pending", result: null, endedAt: null }));
  h.core.coding.recover();
  h.herdr.state("working");
  await h.core.coding.poll();
  expect(h.core.coding.list(work.id)[0]).toMatchObject({ state: "uncertain", deliveredTurn: 1 });
  expect(h.ledger.effect(effect.id).state).toBe("done");
  expect(await h.core.coding.start(work.id, "first", codingInput)).toMatchObject({ id: run.id, state: "uncertain" });
  expect(h.herdr.starts).toBe(1);
  expect(h.herdr.writes).toBeEmpty();
});

test("adopting an existing owner pane reserves it without opening a workspace or attributing earlier transcript history", async () => {
  const h = await setup();
  const confined = await h.work({ kind: "workspace" });
  const work = await h.work();
  const input = { pane: h.herdr.pane.id, task: "Work in the existing checkout" };
  await expect(h.core.coding.start(confined.id, "not-pc", input)).rejects.toThrow(/owner-PC/);
  h.herdr.transcriptAvailable = true;
  h.herdr.pane = { ...h.herdr.pane, owned: false, cwd: CHECKOUT };
  h.herdr.items.push(textEntry("user", "owner's previous input"), textEntry("agent", "not our result"));
  await expect(h.core.coding.start(work.id, "adopt", input)).rejects.toThrow(/approval required/i);
  expect(h.herdr.writes).toBeEmpty();
  const run = await approveAdoption(h.core, work.id);
  expect(run).toMatchObject({ turn: 1, pane: h.herdr.pane.id, terminalId: h.herdr.pane.terminalId, checkout: CHECKOUT, branch: "owner-branch", base: "d0c0aa0" });
  expect(h.herdr.starts).toBe(0);
  expect(h.herdr.writes).toHaveLength(1);
  await h.core.coding.poll();
  expect(h.engine.reportAttempts).toBeEmpty();
  h.herdr.items.push(textEntry("user", h.herdr.writes[0]!.text), textEntry("agent", "this turn's result"));
  h.herdr.state("done", true);
  await h.core.coding.poll();
  const report = h.core.coding.list(work.id)[0]!.report!;
  expect(report).toContain("this turn's result");
  expect(report).not.toContain("not our result");
});

test("only this Work may reserve another turn on its exact idle pane, and preferences do not retarget it", async () => {
  const h = await setup();
  const work = await h.work();
  const stranger = await h.work();
  const run = await h.core.coding.start(work.id, "first", codingInput);
  const follow = { pane: run.pane!, task: "Follow up" };
  await expect(h.core.coding.start(stranger.id, "stolen", follow)).rejects.toThrow(/another live Work|reserved/);
  await expect(h.core.coding.start(work.id, "early", follow)).rejects.toThrow(/earlier coding turn/);
  h.herdr.state("done", true);
  await h.core.coding.poll();
  await expect(h.core.coding.start(stranger.id, "settled-still-held", follow)).rejects.toThrow(/another live Work/);
  for (const state of ["working", "blocked", "unknown"] as const) {
    h.herdr.state(state);
    await expect(h.core.coding.start(work.id, state, follow)).rejects.toThrow(state);
  }
  h.herdr.state("idle");
  h.herdr.session = "different-preference";
  for (let turn = 2; turn <= 4; turn++) {
    const next = await h.core.coding.start(work.id, `follow-${turn}`, follow);
    expect(next).toMatchObject({ id: run.id, terminalId: run.terminalId, pane: run.pane, session: "owner", turn });
    h.herdr.state("done", true);
    await h.core.coding.poll();
  }
  await expect(h.core.coding.start(work.id, "excess", follow)).rejects.toThrow(/at most 4/);
  h.herdr.pane = { ...h.herdr.pane, terminalId: "different-terminal" };
  await expect(h.core.coding.start(work.id, "reused", follow)).rejects.toThrow(/lost, reused/);
  expect(h.herdr.writes.map(({ session }) => session)).toEqual(["owner", "owner", "owner", "owner"]);
  h.core.works.cancel(work.id);
  h.herdr.session = "owner";
  h.herdr.pane = { ...h.herdr.pane, terminalId: run.terminalId! };
  await expect(h.core.coding.start(stranger.id, "terminal-owner-finished", follow)).rejects.toThrow(/approval required/i);
  const adopted = await approveAdoption(h.core, stranger.id);
  expect(adopted).toMatchObject({ workId: stranger.id, terminalId: run.terminalId, turn: 1 });
  expect(adopted.id).not.toBe(run.id);
});

test("a coding report does not clear a separate child Work wait", async () => {
  const h = await setup();
  const work = await h.work();
  const helper = h.core.createGhost({ name: "Helper", persona: "" });
  h.core.works.delegate(work.id, { ghostId: helper.id, title: "Independent task", brief: "Still live", execution: { kind: "workspace" } });
  const run = await h.core.coding.start(work.id, "first", codingInput);
  h.core.works.onIdle(work.id);
  h.herdr.state("done", true);
  await h.core.coding.poll();
  expect(h.engine.submissions.has(reportId(run))).toBe(true);
  expect(h.core.coding.pending(work.id)).toBe(false);
  expect(h.ledger.work(work.id).state).toBe("waiting");
});

test("an owner prompt after the managed prompt cannot donate a claim or a completion", async () => {
  const h = await setup();
  const work = await h.work();
  h.herdr.transcriptAvailable = true;
  const run = await h.core.coding.start(work.id, "first", codingInput);
  h.herdr.items.push(textEntry("user", h.herdr.writes[0]!.text), textEntry("agent", "old answer"), textEntry("user", "owner chose another task"), textEntry("agent", "not the run's answer"));
  h.herdr.state("done", true);
  await h.core.coding.poll();
  const settled = h.core.coding.list(work.id)[0]!;
  expect(settled).toMatchObject({ id: run.id, state: "uncertain", deliveredTurn: 1 });
  expect(JSON.parse(settled.report!)).toMatchObject({ claim: null });
  expect(settled.report).not.toContain("not the run's answer");
});

test("working while waiting consumes precisely the observed working span, blocked pauses, and budget expiry requests a stop", async () => {
  const h = await setup();
  const work = await h.work(undefined, 1);
  const run = await h.core.coding.start(work.id, "first", codingInput);
  h.core.works.onIdle(work.id);
  const waiting = h.ledger.work(work.id);
  expect(waiting.budgetSince).toBeNull();
  h.herdr.state("working");
  await h.core.coding.poll(run.startedAt + 500);
  expect(h.ledger.work(work.id).budgetSince).toBe(run.startedAt + 500);
  h.herdr.state("blocked");
  await h.core.coding.poll(run.startedAt + 1_500);
  const blocked = h.ledger.work(work.id);
  expect(blocked).toMatchObject({ state: "waiting", budgetSince: null, budgetUsedMs: waiting.budgetUsedMs + 1_000 });
  expect(h.ledger.findNotification(`${reportId(run)}:blocked`)).toMatchObject({ workId: work.id, conversationId: h.ghost.directConversationId });
  h.core.works.expire(run.startedAt + 200_000);
  expect(budgetSpent(h.ledger.work(work.id), run.startedAt + 200_000)).toBe(blocked.budgetUsedMs);
  h.herdr.state("working");
  await h.core.coding.poll(run.startedAt + 201_000);
  expect(h.core.coding.list(work.id)[0]?.turn).toBe(1);
  h.core.works.expire(run.startedAt + 262_000);
  expect(h.ledger.work(work.id)).toMatchObject({ state: "blocked", hold: "budget", budgetSince: null });
  await h.core.idle();
  await h.core.coding.poll();
  expect(h.herdr.interrupts).toEqual([run.terminalId!]);
  expect(h.herdr.closes).toBe(0);
  expect(h.herdr.writes).toHaveLength(1);
  expect(h.core.coding.list(work.id)[0]).toMatchObject({ state: "closed", stopPending: false });
  h.core.works.decide(work.id, "extend");
  const follow = await h.core.coding.start(work.id, "continued", { pane: run.pane!, task: "Continue deliberately" });
  expect(follow).toMatchObject({ id: run.id, turn: 2, terminalId: run.terminalId });
});

test("provider quota cannot wake a Work whose coding agent exhausted its budget during the hold", async () => {
  const h = await setup();
  const work = await h.work(undefined, 1);
  h.herdr.statusOnAck = "working";
  const run = await h.core.coding.start(work.id, "first", codingInput);
  h.core.quota.hold(work.conversationId!, { text: "Deferred input", origin: "work", requestId: "deferred-before-budget" }, [], "work");
  expect(h.ledger.work(work.id)).toMatchObject({ hold: "quota" });
  expect(h.ledger.work(work.id).budgetSince).not.toBeNull();
  h.core.works.expire(run.startedAt + 65_000);
  expect(h.ledger.work(work.id)).toMatchObject({ hold: "budget", state: "blocked" });
  h.core.quota.tick(run.startedAt + 65_000);
  await h.core.idle();
  expect(h.engine.submissions.has("deferred-before-budget")).toBe(false);
  expect(h.herdr.interrupts).toEqual([run.terminalId!]);
});

test("revocation stops the exact terminal once, keeps its worktree, and does not wake the Work", async () => {
  const h = await setup();
  const work = await h.work();
  h.herdr.statusOnAck = "working";
  h.herdr.idleOnInterrupt = false;
  const run = await h.core.coding.start(work.id, "first", codingInput);
  h.ledger.tx(() => h.ledger.putGhost({ ...h.ledger.ghost(h.ghost.id), hostExecution: false }));
  expect(h.ledger.work(work.id).state).toBe("cancelled");
  expect(h.core.coding.list(work.id)[0]).toMatchObject({ state: "closed", stopPending: true });
  await h.core.idle();
  await h.core.coding.poll();
  expect(h.herdr.interrupts).toEqual([run.terminalId!]);
  expect(h.herdr.closes).toBe(0);
  expect(h.core.coding.list(work.id)[0]).toMatchObject({ checkout: CHECKOUT, stopPending: true });
  h.herdr.state("idle");
  await h.core.coding.poll();
  expect(h.core.coding.list(work.id)[0]).toMatchObject({ stopPending: false, deliveredTurn: 0 });
  expect(h.engine.reportAttempts).toBeEmpty();
});

test("a replaced pane is lost, and cancel never interrupts its replacement", async () => {
  const h = await setup();
  const work = await h.work();
  h.herdr.statusOnAck = "working";
  const run = await h.core.coding.start(work.id, "first", codingInput);
  h.herdr.pane = { ...h.herdr.pane, terminalId: "new-terminal" };
  expect(h.core.coding.decorate(await h.herdr.overview()).workspaces[0]?.tabs[0]?.panes[0]?.codingRunId).toBeUndefined();
  await h.core.coding.poll();
  expect(h.core.coding.list(work.id)[0]).toMatchObject({ id: run.id, state: "lost", deliveredTurn: 1 });
  h.core.works.cancel(work.id);
  await h.core.idle();
  expect(h.herdr.interrupts).toBeEmpty();
  expect(h.herdr.closes).toBe(0);
});

test("stale Work revision is checked at the final prompt boundary, not just during admission", async () => {
  const h = await setup();
  const work = await h.work();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.herdr.beforePrompt = () => { entered.resolve(); return release.promise; };
  const start = h.core.coding.start(work.id, "first", codingInput);
  await entered.promise;
  h.core.works.update(work.id, { brief: "Changed by the owner" });
  release.resolve();
  const run = await start;
  await h.core.idle();
  expect(run.state).toBe("closed");
  expect(h.herdr.writes).toBeEmpty();
  expect(h.engine.reportAttempts).toBeEmpty();
});

test("a fenced report must not wake a newly resumed attempt after waiting for engine admission", async () => {
  const h = await setup();
  const work = await h.work();
  const run = await h.core.coding.start(work.id, "first", codingInput);
  h.core.works.onIdle(work.id);
  const entering = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.engine.beforeReport = () => { entering.resolve(); return release.promise; };
  h.herdr.state("done", true);
  const polling = h.core.coding.poll();
  await entering.promise;
  h.core.works.fail(work.id, "stopped this attempt");
  h.core.works.resume(work.id);
  release.resolve();
  await polling;
  await h.core.idle();
  expect(h.engine.submissions.has(reportId(run))).toBe(false);
  expect(h.core.coding.list(work.id)[0]).toMatchObject({ state: "closed", deliveredTurn: 0 });
  expect(h.ledger.work(work.id)).toMatchObject({ state: "running", revision: work.revision + 1 });
});

test("shutdown drains a relayed observation but leaves external execution for restart", async () => {
  const h = await setup();
  const work = await h.work();
  h.herdr.statusOnAck = "working";
  const run = await h.core.coding.start(work.id, "first", codingInput);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.herdr.beforeOverview = () => { entered.resolve(); return release.promise; };
  const poll = h.core.coding.poll();
  await entered.promise;
  h.core.stop();
  h.herdr.state("done", true);
  release.resolve();
  await poll;
  await h.core.idle();
  expect(h.herdr.interrupts).toBeEmpty();
  expect(h.engine.reportAttempts).toBeEmpty();
  expect(h.core.coding.list(work.id)[0]).toMatchObject({ id: run.id, state: "working", stopPending: false });
  h.ledger.close();
});

test("owner pane notifications still work, but a managed transition is not notified twice", async () => {
  const h = await setup();
  const work = await h.work();
  h.ledger.tx(() => h.ledger.putSetting("coding", { notify: "all" }));
  const watcher = new CodingWatcher(h.core, h.herdr.port, { clock: { now: () => 120_000, repeat: () => () => {} } });
  h.herdr.statusOnAck = "working";
  const run = await h.core.coding.start(work.id, "first", codingInput);
  await watcher.poll();
  const managedPane = h.herdr.pane;
  h.herdr.pane = { ...managedPane, agent: null, status: "unknown" };
  await watcher.poll();
  expect(h.ledger.notificationsForState().filter(({ id }) => id.startsWith("coding:"))).toBeEmpty();
  h.herdr.pane = managedPane;
  await watcher.poll();
  h.herdr.state("done", true);
  await h.core.coding.poll();
  await watcher.poll();
  expect(h.ledger.notificationsForState().filter(({ id }) => id.startsWith("coding:"))).toBeEmpty();
  h.herdr.pane = { ...h.herdr.pane, terminalId: "unmanaged" };
  h.herdr.state("working");
  await watcher.poll();
  h.herdr.state("done", true);
  await watcher.poll();
  expect(h.ledger.notificationsForState().find(({ id }) => id.startsWith("coding:"))).toMatchObject({ workId: null });
});
