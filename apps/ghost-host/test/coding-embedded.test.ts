import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { CodingEvent, CodingItem, CodingPrompt, CodingSession, CodingSessionCreate, Work } from "@ghost/contract";
import { ghostCodingSessionId, type CodingChanges, type CodingRequester, type CodingSessionsPort, type CodingSettled } from "../src/coding/ports.ts";
import type { Submission } from "../src/core/ports.ts";
import { createCodingTools } from "../src/tools/coding.ts";
import { FakeEngine, harness, hostTaskId, tempDir } from "./support.ts";

const firstTask = { repo: "/tmp", task: "Implement the change", branch: "change" };
const wakeId = (id: string, turn = 1) => `session:${id}:turn:${turn}`;
const context = { abortSignal: undefined } as Context;

class Sessions implements CodingSessionsPort {
  readonly creates: { input: CodingSessionCreate; requester: CodingRequester }[] = [];
  readonly prompts: { id: string; input: CodingPrompt }[] = [];
  readonly aborts: string[] = [];
  readonly closes: string[] = [];
  readonly listeners = new Set<(settled: CodingSettled) => void>();
  readonly history: CodingSettled[] = [];
  readonly transcript: CodingItem[] = [];
  private readonly sessions = new Map<string, CodingSession>();
  private readonly observers = new Map<string, Set<(event: CodingEvent) => void>>();
  observations: CodingChanges = {
    files: [{ path: "observed.ts", status: "modified", additions: 3, deletions: 1 }],
    diff: "+observable change", commits: ["abcd observed change"], dirty: true, truncated: false,
  };
  reads = 0;
  subscriptions = 0;
  beforeChanges?: () => void;
  beforeCreate?: (requester: Extract<CodingRequester, { kind: "ghost" }>, id: string) => Promise<void>;

  list() { this.reads++; return [...this.sessions.values()]; }
  get(id: string) { return this.sessions.get(id) ?? null; }
  async create(input: CodingSessionCreate, requester: CodingRequester) {
    this.creates.push({ input, requester });
    const id = requester.kind === "owner" ? "owner-session" : ghostCodingSessionId(requester);
    if (requester.kind === "ghost") await this.beforeCreate?.(requester, id);
    const now = Date.now();
    const session: CodingSession = {
      id, title: "Isolated session", state: input.prompt ? "working" : "idle", cwd: `/tmp/wt/${id}`,
      repo: input.repo ?? null, branch: `ghost/${input.branch ?? "fix"}`, base: "abc", model: { provider: "test", model: "test" }, thinking: "off",
      workId: requester.kind === "ghost" ? requester.workId : null, turn: input.prompt ? 1 : 0, pendingDialog: null,
      usage: { input: 0, output: 0, cost: 0 }, createdAt: now, updatedAt: now,
    };
    this.sessions.set(id, session);
    return session;
  }
  async prompt(id: string, input: CodingPrompt) {
    this.prompts.push({ id, input });
    if (input.mode === "steer") return { disposition: "queued" as const };
    this.set({ ...this.get(id)!, turn: this.get(id)!.turn + 1, state: "working" });
    return { disposition: "started" as const };
  }
  async abort(id: string) {
    this.aborts.push(id);
    this.settle(id, "aborted");
  }
  async close(id: string) { this.closes.push(id); this.set({ ...this.get(id)!, state: "closed" }); }
  async answer(id: string) { this.set({ ...this.get(id)!, state: "working", pendingDialog: null }); }
  async rename(id: string, patch: { title?: string }) { return this.set({ ...this.get(id)!, ...patch }); }
  items(_id: string, options?: { limit?: number }) { return this.transcript.slice(-(options?.limit ?? 100)); }
  async changes(_id: string) { this.beforeChanges?.(); return this.observations; }
  busy() { return this.list().some(({ state }) => state === "working" || state === "waiting"); }
  file() { return null; }
  subscribe(id: string, listener: (event: CodingEvent) => void) {
    const listeners = this.observers.get(id) ?? new Set();
    this.observers.set(id, listeners);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  onSettled(listener: (settled: CodingSettled) => void) {
    this.subscriptions++;
    this.listeners.add(listener);
    for (const settled of this.history) listener(settled);
    return () => { this.listeners.delete(listener); };
  }

  private set(before: CodingSession) {
    const session = { ...before, updatedAt: Date.now() };
    this.sessions.set(session.id, session);
    for (const listener of this.observers.get(session.id) ?? []) listener({ type: "session", session });
    return session;
  }
  emit(settled: CodingSettled) { for (const listener of this.listeners) listener(settled); }
  settle(id: string, outcome: CodingSettled["outcome"], finalText: string | null = null) {
    const state = outcome === "waiting" ? "waiting" : outcome === "interrupted" || outcome === "failed" ? "failed" : "idle";
    const pendingDialog = outcome === "waiting" ? { id: "dialog", kind: "confirm" as const, title: "Choose a direction", createdAt: Date.now() } : null;
    const session = this.set({ ...this.get(id)!, state, pendingDialog });
    const settled = { session, turn: session.turn, outcome, finalText };
    if (outcome !== "waiting") this.history.push(settled);
    this.emit(settled);
    return settled;
  }
}

class Engine extends FakeEngine {
  readonly reportAttempts: Submission[] = [];
  beforeReport?: () => Promise<void>;
  loseAck = false;

  override async submit(conversationId: string, submission: Submission, authorize?: () => void) {
    const report = submission.requestId.startsWith("session:");
    if (report) {
      this.reportAttempts.push(submission);
      await this.beforeReport?.();
    }
    authorize?.();
    await super.submit(conversationId, submission);
    if (report && this.loseAck) throw new Error("report admitted; acknowledgement lost");
  }
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function setup(path = ":memory:", sessions = new Sessions(), engine = new Engine()) {
  const h = harness(path);
  h.core.setCodingSessions(sessions);
  h.core.attach(engine);
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    h.core.stop();
    await h.core.idle();
    h.ledger.close();
  };
  cleanups.push(shutdown);
  const tools = createCodingTools(h.core).tools!;
  async function call(conversationId: string, name: "code_run" | "code_agents", args: object, callId: string = crypto.randomUUID()) {
    const piId = h.ledger.piConversationId(conversationId) ?? `pi-${conversationId}`;
    h.ledger.setPiConversationId(conversationId, piId);
    const result = await tools.find((tool) => tool.name === name)!.execute(args as never, {
      conversationId: piId,
      taskId: hostTaskId(), callId, output: () => {}, diagnostic: () => {},
    } as unknown as ToolExecutionApi, context);
    const part = result.output?.[0];
    return { isError: result.isError === true, text: part?.type === "text" ? part.text : "" };
  }
  async function createWork(execution: Work["execution"] = { kind: "host", cwd: "/tmp" }) {
    if (h.ledger.ghosts().length === 0) h.core.createGhost({ name: "Main", persona: "" });
    const ghost = h.core.createGhost({ name: "Builder", persona: "", hostExecution: true, tools: ["code_run", "code_agents"] });
    const work = h.core.works.createRoot({ ghostId: ghost.id, originConversationId: ghost.directConversationId, title: "Fix", brief: "Fix the issue", execution: execution!, budgetMinutes: 1 });
    await h.core.idle();
    return { ghost, work: h.ledger.work(work.id), conversation: h.ledger.work(work.id).conversationId! };
  }
  return { ...h, sessions, engine, call, createWork, shutdown };
}

async function start(fixture: ReturnType<typeof setup>, conversation: string, callId = "first") {
  const result = await fixture.call(conversation, "code_run", firstTask, callId);
  if (result.isError) throw new Error(result.text);
  return JSON.parse(result.text) as { session: string; turn: number; disposition: string };
}

test("embedded code_run recovers a lost create ACK without opening a second session or dispatching another prompt", async () => {
  const root = tempDir();
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "ledger.db");
  const first = setup(path);
  const { ghost, work, conversation } = await first.createWork();
  const { session } = await start(first, conversation);
  expect(first.sessions.creates).toEqual([{ input: { repo: firstTask.repo, branch: firstTask.branch, prompt: firstTask.task }, requester: { kind: "ghost", ghostId: ghost.id, workId: work.id, callId: "first" } }]);
  const effect = first.ledger.effectByCall(conversation, "first")!;
  first.ledger.tx(() => first.ledger.putEffect({ ...effect, state: "pending", result: null, endedAt: null }));
  first.core.works.onIdle(work.id);
  await first.shutdown();
  first.sessions.settle(session, "interrupted");
  const second = setup(path, first.sessions, first.engine);
  await second.core.start();
  expect(await start(second, conversation)).toMatchObject({ session, turn: 1 });
  await second.core.idle();
  expect(first.sessions.creates).toHaveLength(1);
  expect(first.sessions.prompts).toEqual([]);
  expect(first.sessions.subscriptions).toBe(2);
  expect(first.sessions.listeners.size).toBe(1);
  expect(second.ledger.effectByCall(conversation, "first")?.state).toBe("done");
  expect(second.core.coding.list(work.id)[0]).toMatchObject({ session: `ghost:${session}`, state: "uncertain", deliveredTurn: 1 });
  expect(second.engine.submissions.get(wakeId(session))?.submission.text).toContain('"outcome":"interrupted"');
});

test("a report separates the claim and Host's git observation and reuses the frozen body after a lost submission ACK", async () => {
  const root = tempDir();
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "ledger.db");
  const first = setup(path);
  const { work, conversation } = await first.createWork();
  const { session } = await start(first, conversation);
  first.core.works.onIdle(work.id);
  expect(first.ledger.work(work.id).state).toBe("waiting");
  first.engine.loseAck = true;
  first.sessions.settle(session, "done", "I changed files that the Host did not observe.");
  await first.core.idle();
  const run = first.core.coding.list(work.id)[0]!;
  expect(run.deliveredTurn).toBe(0);
  expect(JSON.parse(run.report!)).toMatchObject({
    outcome: "done", untrusted: true,
    claim: { source: "agent_transcript", text: "I changed files that the Host did not observe." },
    observations: { source: "host_git", dirty: true, additions: 3, deletions: 1, commits: ["abcd observed change"] },
  });
  expect(first.engine.submissions.get(wakeId(session))?.conversationId).toBe(conversation);
  await first.shutdown();

  first.engine.loseAck = false;
  first.sessions.observations = { ...first.sessions.observations, dirty: false, commits: ["newer checkout"] };
  const second = setup(path, first.sessions, first.engine);
  await second.core.start();
  await second.core.idle();
  expect(second.engine.reportAttempts).toHaveLength(2);
  expect(second.engine.reportAttempts[1]).toEqual(second.engine.reportAttempts[0]);
  expect(second.engine.to(conversation).filter((entry) => entry.requestId === wakeId(session))).toHaveLength(1);
  expect(second.core.coding.list(work.id)[0]).toMatchObject({ deliveredTurn: 1, report: run.report });
  expect(second.ledger.work(work.id).state).toBe("running");
});

test("working redirects the same turn, idle starts a new turn, and all four instructions count", async () => {
  const f = setup();
  const { work, conversation } = await f.createWork();
  const { session } = await start(f, conversation);
  const second = await f.call(conversation, "code_run", { ...firstTask, branch: "duplicate", agent: "ghost" }, "duplicate");
  expect(second.text).toContain("already has an embedded session");
  const carry = async (callId: string) => await f.call(conversation, "code_run", { session, task: callId, agent: "ghost" }, callId);
  expect(JSON.parse((await carry("redirect-1")).text)).toMatchObject({ session, turn: 1, disposition: "queued" });
  expect(JSON.parse((await carry("redirect-2")).text)).toMatchObject({ session, turn: 1, disposition: "queued" });
  const old = f.sessions.settle(session, "done");
  await f.core.idle();
  expect(JSON.parse((await carry("new prompt")).text)).toMatchObject({ session, turn: 2, disposition: "started" });
  expect(f.sessions.prompts.map(({ input }) => input.mode)).toEqual(["steer", "steer", "prompt"]);
  expect((await carry("too many")).text).toContain("at most 4 coding instructions");
  expect(f.sessions.prompts).toHaveLength(3);
  f.sessions.emit(old);
  await f.core.idle();
  expect(f.engine.reportAttempts).toHaveLength(1);
  expect(f.core.coding.list(work.id)[0]).toMatchObject({ state: "working", turn: 2, deliveredTurn: 1 });
});

test("an owner dialog keeps the Work waiting without a model wake or an active coding budget", async () => {
  const f = setup();
  const { work, conversation } = await f.createWork();
  const { session } = await start(f, conversation);
  f.core.works.onIdle(work.id);
  expect(f.ledger.work(work.id).budgetSince).not.toBeNull();
  f.sessions.settle(session, "waiting");
  await f.core.idle();
  const waiting = f.ledger.work(work.id);
  expect(waiting).toMatchObject({ state: "waiting", budgetSince: null });
  expect(f.ledger.findNotification(`${wakeId(session)}:waiting`)).toMatchObject({ conversationId: conversation, workId: work.id });
  expect(f.engine.reportAttempts).toEqual([]);
  const refused = await f.call(conversation, "code_run", { session, task: "Do not jump the dialog" }, "while-waiting");
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("owner answer needed");
  expect(f.sessions.prompts).toEqual([]);
  f.core.works.expire(Date.now() + 120_000);
  expect(f.ledger.work(work.id).budgetUsedMs).toBe(waiting.budgetUsedMs);
  await f.sessions.answer(session);
  await f.core.idle();
  expect(f.ledger.work(work.id).budgetSince).not.toBeNull();
  f.sessions.settle(session, "done");
  await f.core.idle();
  expect(f.engine.reportAttempts.map(({ requestId }) => requestId)).toEqual([wakeId(session)]);
});

test("a report fenced at admission cannot wake a resumed Work attempt", async () => {
  const f = setup();
  const { work, conversation } = await f.createWork();
  const { session } = await start(f, conversation);
  f.core.works.onIdle(work.id);
  const entering = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.engine.beforeReport = () => { entering.resolve(); return release.promise; };
  f.sessions.settle(session, "done", "stale claim");
  await entering.promise;
  try {
    f.core.works.fail(work.id, "stopped this attempt");
    f.core.works.resume(work.id);
  } finally {
    release.resolve();
  }
  await f.core.idle();
  expect(f.engine.submissions.has(wakeId(session))).toBe(false);
  expect(f.ledger.work(work.id)).toMatchObject({ state: "running", revision: work.revision + 1 });
  const next = await f.call(conversation, "code_run", { session, task: "A new attempt" }, "resume");
  expect(JSON.parse(next.text)).toMatchObject({ session, turn: 2 });
});

test("a revoked Work reservation cannot cross the adapter's create boundary", async () => {
  const f = setup();
  const { work, conversation } = await f.createWork();
  const entering = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.sessions.beforeCreate = async (requester, id) => {
    entering.resolve();
    await release.promise;
    f.core.coding.authorizeEmbeddedCreate(requester, id);
  };
  const firing = f.call(conversation, "code_run", firstTask, "fenced");
  await entering.promise;
  try {
    f.core.works.cancel(work.id, "cancelled during setup");
  } finally {
    release.resolve();
  }
  const refused = await firing;
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("no longer reserved");
  await f.core.idle();
  expect(f.sessions.list()).toEqual([]);
  expect(f.engine.reportAttempts).toEqual([]);
});

for (const stop of ["cancel", "revoke", "budget"] as const) {
  test(`${stop} aborts only the bound embedded turn, preserving its session, branch and checkout`, async () => {
    const f = setup();
    const { ghost, work, conversation } = await f.createWork();
    const { session } = await start(f, conversation);
    const owner = await f.sessions.create({ cwd: "/tmp", prompt: "The owner's task" }, { kind: "owner" });
    f.core.works.onIdle(work.id);
    if (stop === "cancel") f.core.works.cancel(work.id, "owner stopped it");
    else if (stop === "revoke") f.ledger.tx(() => f.ledger.putGhost({ ...ghost, hostExecution: false }));
    else f.core.works.expire(Date.now() + 70_000);
    await f.core.idle();
    expect(f.sessions.aborts).toEqual([session]);
    expect(f.sessions.closes).toEqual([]);
    expect(f.sessions.get(session)).toMatchObject({ cwd: `/tmp/wt/${session}`, branch: "ghost/change", state: "idle" });
    expect(f.sessions.get(owner.id)?.state).toBe("working");
    expect(f.core.coding.list(work.id)[0]).toMatchObject({ state: "closed", stopPending: false, deliveredTurn: 0 });
    f.sessions.settle(owner.id, "done", "Never a Work report");
    await f.core.idle();
    expect(f.engine.reportAttempts).toEqual([]);
  });
}

test("session inspection is bounded, separates observations, and does not reveal an invisible Work", async () => {
  const f = setup();
  const { ghost, work, conversation } = await f.createWork();
  const { session } = await start(f, conversation);
  f.sessions.transcript.push(
    { id: "thinking", at: 1, kind: "thinking", text: "hidden reasoning", streaming: false },
    { id: "tool", at: 1, kind: "tool", tool: "bash", summary: "Read a file", status: "done", output: "private tool output", images: [] },
    { id: "claim", at: 1, kind: "assistant", text: "Agent's claim", streaming: false },
  );
  const detail = await f.call(ghost.directConversationId, "code_agents", { session });
  expect(detail.isError).toBe(false);
  expect(JSON.parse(detail.text).detail).toMatchObject({
    session: { id: session, work: { id: work.id }, pendingDialog: false },
    claim: { text: "Agent's claim" }, observations: { diff: "+observable change", source: "host_git", dirty: true },
  });
  expect(detail.text).not.toContain("hidden reasoning");
  expect(detail.text).not.toContain("private tool output");
  const other = f.core.createGhost({ name: "Another", persona: "", hostExecution: true, tools: ["code_agents"] });
  const roster = await f.call(other.directConversationId, "code_agents", {});
  expect(JSON.parse(roster.text).sessions[0]).toMatchObject({ id: session, title: "Isolated session", state: "working" });
  expect(JSON.parse(roster.text).sessions[0]).not.toHaveProperty("work");
  expect((await f.call(other.directConversationId, "code_agents", { session })).text).toContain("cannot see");
});

test("both coding tools refuse revoked PC access and an owner-PC read cannot leak observations after revocation", async () => {
  const f = setup();
  const { ghost, conversation } = await f.createWork();
  const { session } = await start(f, conversation);
  f.sessions.beforeChanges = () => f.ledger.tx(() => f.ledger.putGhost({ ...ghost, hostExecution: false }));
  const inflight = await f.call(ghost.directConversationId, "code_agents", { session });
  expect(inflight.isError).toBe(true);
  expect(inflight.text).not.toContain("observable change");
  const noReads = f.sessions.reads;
  expect((await f.call(ghost.directConversationId, "code_agents", {})).isError).toBe(true);
  expect((await f.call(conversation, "code_run", { session, task: "Refused" })).isError).toBe(true);
  expect(f.sessions.reads).toBe(noReads);
  expect(f.sessions.prompts).toEqual([]);
});

test("explicit CLI agents are refused before a coding effect or session is created", async () => {
  const f = setup();
  const { work, conversation } = await f.createWork();
  for (const agent of ["omp", "claude", "codex"]) {
    const result = await f.call(conversation, "code_run", { ...firstTask, agent });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining("use the workbench terminal for CLI agents") });
  }
  expect(f.ledger.effectsForWork(work.id)).toEqual([]);
  expect(f.sessions.creates).toEqual([]);
  const allowed = await f.call(conversation, "code_run", { ...firstTask, agent: "ghost" });
  expect(JSON.parse(allowed.text)).toMatchObject({ agent: "ghost", disposition: "started", turn: 1 });
});

test("a coding report releases only its own wait, not a live child Work", async () => {
  const f = setup();
  const { work, conversation } = await f.createWork();
  const helper = f.core.createGhost({ name: "Helper", persona: "" });
  f.core.works.delegate(work.id, { ghostId: helper.id, title: "Independent task", brief: "Still live", execution: { kind: "workspace" } });
  const { session } = await start(f, conversation);
  f.core.works.onIdle(work.id);
  f.sessions.settle(session, "done");
  await f.core.idle();
  expect(f.engine.submissions.has(wakeId(session))).toBe(true);
  expect(f.core.coding.pending(work.id)).toBe(false);
  expect(f.ledger.work(work.id).state).toBe("waiting");
});

test("provider quota cannot wake a Work whose coding turn exhausted its budget during the hold", async () => {
  const f = setup();
  const { work, conversation } = await f.createWork();
  const { session } = await start(f, conversation);
  f.core.quota.hold(conversation, { text: "Deferred input", origin: "work", requestId: "deferred-before-budget" }, [], "work");
  expect(f.ledger.work(work.id)).toMatchObject({ hold: "quota", budgetSince: expect.any(Number) });
  const expiredAt = Date.now() + 65_000;
  f.core.works.expire(expiredAt);
  expect(f.ledger.work(work.id)).toMatchObject({ hold: "budget", state: "blocked" });
  f.core.quota.tick(expiredAt);
  await f.core.idle();
  expect(f.engine.submissions.has("deferred-before-budget")).toBe(false);
  expect(f.sessions.aborts).toEqual([session]);
});
