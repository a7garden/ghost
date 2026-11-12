import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { budgetSpent, MAX_DEFERRED_INPUTS } from "../src/core/budget.ts";
import { Core } from "../src/core/core.ts";
import type { Submission, SubmissionRecovery } from "../src/core/ports.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { workDecideTool } from "../src/tools/shared.ts";
import { FakeEngine, harness, MemorySecrets, noSandbox, tempDir } from "./support.ts";

const context = { abortSignal: undefined, value: () => undefined, toString: () => "test" } as unknown as Context;

async function fixture(path = ":memory:") {
  const f = harness(path);
  const ghost = f.core.createGhost({ name: "G", persona: "" });
  const work = f.core.works.createRoot({ ghostId: ghost.id, title: "Task", brief: "B", originConversationId: ghost.directConversationId, budgetMinutes: 1 });
  await f.core.idle();
  return { ...f, ghost, work: f.ledger.work(work.id) };
}

test("budget checkpoints count each running millisecond once and freeze the exhausted total", async () => {
  const clock = spyOn(Date, "now");
  let now = 1_800_000_000_000;
  clock.mockImplementation(() => now);
  const f = await fixture();
  try {
    for (let index = 1; index <= 3; index++) {
      now += 10_000;
      f.core.works.update(f.work.id, { title: `Step ${index}` });
      expect(budgetSpent(f.ledger.work(f.work.id), now)).toBe(index * 10_000);
      expect(f.ledger.work(f.work.id).budgetSince).toBe(now);
    }
    now += 31_000;
    f.core.works.expire(now);
    await f.core.idle();
    expect(f.ledger.work(f.work.id)).toMatchObject({ hold: "budget", budgetUsedMs: 61_000, budgetSince: null });
    now += 600_000;
    expect(budgetSpent(f.ledger.work(f.work.id), now)).toBe(61_000);
  } finally { f.core.stop(); await f.core.idle(); f.ledger.close(); clock.mockRestore(); }
});

test("owner budget increases and owner resume clear budget holds; an origin cannot bypass the grant", async () => {
  const f = await fixture();
  try {
    f.core.works.pauseForBudget(f.work.id);
    expect(() => f.core.works.update(f.work.id, { budgetMinutes: 2 }, "origin")).toThrow("work_decide");
    expect(() => f.core.works.update(f.work.id, { deadlineAt: Date.now() + 60_000 }, "origin")).toThrow("only the owner");
    f.core.works.update(f.work.id, { budgetMinutes: 2 });
    await f.core.idle();
    expect(f.ledger.work(f.work.id)).toMatchObject({ state: "running", hold: null, budgetMinutes: 2 });
    expect(f.engine.to(f.work.conversationId!).some((input) => input.requestId.includes("budget-raised"))).toBe(true);
    f.core.works.pauseForBudget(f.work.id);
    f.core.works.resume(f.work.id);
    await f.core.idle();
    expect(f.ledger.work(f.work.id)).toMatchObject({ state: "running", hold: null, budgetUsedMs: 0 });
    expect(f.ledger.work(f.work.id).budgetSince).not.toBeNull();
  } finally { f.core.stop(); await f.core.idle(); f.ledger.close(); }
});

test("work_decide authenticates the immediate delegator, rejecting root direct and sibling conversations", async () => {
  const f = await fixture();
  try {
    const helper = f.core.createGhost({ name: "Helper", persona: "" });
    const other = f.core.createGhost({ name: "Other", persona: "" });
    const child = f.core.works.delegate(f.work.id, { ghostId: helper.id, title: "C", brief: "B" });
    const sibling = f.core.works.delegate(f.work.id, { ghostId: other.id, title: "S", brief: "B" });
    await f.core.idle();
    const grandchild = f.core.works.delegate(child.id, { ghostId: f.ghost.id, title: "GC", brief: "B" });
    await f.core.idle();
    f.core.works.pauseForBudget(grandchild.id);
    const tool = workDecideTool(f.core);
    for (const [index, conversationId] of [f.ghost.directConversationId, f.work.conversationId!, f.ledger.work(sibling.id).conversationId!].entries()) {
      f.ledger.setPiConversationId(conversationId, `denied-${index}`);
      const result = await tool.execute({ work_id: grandchild.id, action: "extend" }, { conversationId: `denied-${index}` } as unknown as ToolExecutionApi, context);
      expect(result.isError).toBe(true);
      expect(f.ledger.work(grandchild.id).hold).toBe("budget");
    }
    f.ledger.setPiConversationId(f.ledger.work(child.id).conversationId!, "immediate-parent");
    const accepted = await tool.execute({ work_id: grandchild.id, action: "extend" }, { conversationId: "immediate-parent" } as unknown as ToolExecutionApi, context);
    expect(accepted.isError).toBeFalsy();
    expect(f.ledger.work(grandchild.id)).toMatchObject({ state: "running", budgetExtended: true });
  } finally { f.core.stop(); await f.core.idle(); f.ledger.close(); }
});

test("budget and repeat pauses of an activity root never bridge into a direct conversation, including recovery", async () => {
  const f = await fixture();
  try {
    f.ledger.tx(() => f.ledger.putWork({ ...f.ledger.work(f.work.id), activityId: "bounded-activity", activityRunId: "bounded-run" }));
    f.core.works.pauseForBudget(f.work.id);
    await f.core.idle();
    f.core.works.recover();
    await f.core.idle();
    // Only this Work's pause notices matter; unrelated self-directed wakes may share the direct conversation.
    expect(f.engine.to(f.ghost.directConversationId).filter((input) => input.requestId.startsWith(`work:${f.work.id}:`))).toEqual([]);
    // Recreate a running turn without widening its activity identity.
    f.ledger.tx(() => f.ledger.putWork({ ...f.ledger.work(f.work.id), state: "running", hold: null }));
    f.core.works.blockForRepeat(f.work.id, "source controlled refusal");
    f.core.works.recover();
    await f.core.idle();
    // Only this Work's pause notices matter; unrelated self-directed wakes may share the direct conversation.
    expect(f.engine.to(f.ghost.directConversationId).filter((input) => input.requestId.startsWith(`work:${f.work.id}:`))).toEqual([]);
  } finally { f.core.stop(); await f.core.idle(); f.ledger.close(); }
});

test("successive budget pauses and repeat continuations use durable distinct occurrences", async () => {
  const f = await fixture();
  try {
    f.core.works.pauseForBudget(f.work.id);
    await f.core.idle();
    f.core.works.decide(f.work.id, "extend");
    await f.core.idle();
    f.core.works.pauseForBudget(f.work.id);
    await f.core.idle();
    const budgets = f.engine.to(f.ghost.directConversationId).filter((input) => input.requestId.startsWith(`work:${f.work.id}:budget:`));
    expect(budgets.map((input) => input.requestId)).toEqual([`work:${f.work.id}:budget:1`, `work:${f.work.id}:budget:2`]);
    f.core.works.resume(f.work.id);
    await f.core.idle();
    for (let index = 0; index < 2; index++) {
      f.core.works.blockForRepeat(f.work.id, "same refusal");
      await f.core.idle();
      f.core.works.decide(f.work.id, "continue");
      await f.core.idle();
    }
    const repeats = f.engine.to(f.work.conversationId!).filter((input) => input.requestId.includes(":repeat:continue:"));
    expect(repeats).toHaveLength(2);
    expect(new Set(repeats.map((input) => input.requestId)).size).toBe(2);
    f.core.works.recover();
    await f.core.idle();
    expect(f.engine.to(f.work.conversationId!).filter((input) => input.requestId.includes(":repeat:continue:"))).toHaveLength(2);
  } finally { f.core.stop(); await f.core.idle(); f.ledger.close(); }
});

test("a crash between pause commit and notice delivery replays only that occurrence", async () => {
  const path = join(tempDir(), "pause-recovery.db");
  const f = await fixture(path);
  const original = f.engine.submit.bind(f.engine);
  f.engine.submit = async (conversationId, submission) => {
    if (submission.requestId === `work:${f.work.id}:budget:1`) throw new Error("crash before admission");
    await original(conversationId, submission);
  };
  f.core.works.pauseForBudget(f.work.id);
  await f.core.idle();
  f.core.stop();
  f.ledger.close();
  const ledger = new Ledger(path);
  const core = new Core({ ledger, artifacts: f.artifacts, secrets: new MemorySecrets(), sandbox: noSandbox, log: () => {} });
  const engine = new FakeEngine();
  core.attach(engine);
  try {
    core.works.recover();
    core.works.recover();
    await core.idle();
    expect(ledger.work(f.work.id).hold).toBe("budget");
    // Exactly one delivery of the interrupted occurrence; other direct-conversation wakes are out of scope here.
    expect(engine.to(f.ghost.directConversationId).map((input) => input.requestId).filter((requestId) => requestId.startsWith(`work:${f.work.id}:`))).toEqual([`work:${f.work.id}:budget:1`]);
  } finally { core.stop(); await core.idle(); ledger.close(); }
});

interface QuotaJournal {
  entries: Record<string, { reason: string; resumeAt: number; failures: number; probingBy: string | null }>;
  records: { conversationId: string; attempts: number; entryId: number; origin: "owner"; priority: number; providers: string[]; queue: Submission[]; releasing: string | null; updatedAt: number }[];
}

test("quota admission and release use a clear fallback even when the primary is exhausted", async () => {
  const f = await fixture();
  try {
    const id = f.ghost.directConversationId;
    const input: Submission = { text: "owner input", origin: "owner", requestId: "with-backup" };
    const journal: QuotaJournal = { entries: { primary: { reason: "429", resumeAt: Date.now() + 3600_000, failures: 1, probingBy: null } }, records: [] };
    f.ledger.putSetting("quota", journal);
    await f.core.quota.start();
    expect(f.core.quota.admitting(id, ["primary", "backup"], input.requestId)).toBe(true);
    f.core.quota.hold(id, input, ["primary", "backup"], "direct");
    f.core.quota.tick();
    await f.core.idle();
    expect(f.engine.to(id)).toEqual([input]);
    expect(f.core.quota.releaseProvider(id, input.requestId)).toBeNull();
  } finally { f.core.stop(); await f.core.idle(); f.ledger.close(); }
});

test("restart preserves more than 200 accepted inputs verbatim; backpressure occurs before accepting the next input", async () => {
  const path = join(tempDir(), "quota-queue.db");
  const f = await fixture(path);
  const id = f.ghost.directConversationId;
  await f.core.quota.start();
  const accepted = Array.from({ length: 250 }, (_, index): Submission => ({ requestId: `accepted:${index}`, origin: "owner", text: index === 249 ? "x".repeat(70_000) : `Input ${index}` }));
  for (const input of accepted) f.core.quota.hold(id, input, ["p"], "direct");
  f.core.stop();
  f.ledger.close();
  const ledger = new Ledger(path);
  const core = new Core({ ledger, artifacts: f.artifacts, secrets: new MemorySecrets(), sandbox: noSandbox, log: () => {} });
  const engine = new FakeEngine();
  core.attach(engine);
  try {
    await core.quota.start();
    expect(ledger.setting<QuotaJournal>("quota", { entries: {}, records: [] }).records[0]!.queue).toEqual(accepted);
    for (let index = accepted.length; index < MAX_DEFERRED_INPUTS; index++) core.quota.hold(id, { requestId: `accepted:${index}`, origin: "owner", text: "queued" }, ["p"], "direct");
    expect(() => core.quota.hold(id, { requestId: "overflow", origin: "owner", text: "not accepted" }, ["p"], "direct")).toThrow("accepted inputs");
    expect(ledger.setting<QuotaJournal>("quota", { entries: {}, records: [] }).records[0]!.queue).toHaveLength(MAX_DEFERRED_INPUTS);
    core.quota.tick();
    await core.idle();
    for (let index = 0; index < 250; index++) {
      expect(engine.to(id)[index]).toEqual(accepted[index]);
      core.quota.turnEnded(id, { entryId: index + 1, origin: "owner", providers: ["p"], serving: "p", hit: null });
      await core.idle();
    }
  } finally { core.stop(); await core.idle(); ledger.close(); }
});

for (const status of ["missing", "pending", "done", "quota"] as const) {
  test(`a crash after quota release reconciles a ${status} Pi request without losing or duplicating the next input`, async () => {
    const path = join(tempDir(), "quota-release.db");
    const f = await fixture(path);
    const id = f.ghost.directConversationId;
    const resume: Submission = { requestId: `quota-resume:${id}:1`, text: "continue", origin: "owner" };
    const next: Submission = { requestId: "next-owner-input", text: "next", origin: "owner" };
    const journal: QuotaJournal = {
      entries: { p: { reason: "429", resumeAt: 1, failures: 1, probingBy: id } },
      records: [{ conversationId: id, attempts: 1, entryId: 10, origin: "owner", priority: 0, providers: ["p"], queue: [resume, next], releasing: resume.requestId, updatedAt: 1 }],
    };
    f.ledger.putSetting("quota", journal);
    f.core.stop(); f.ledger.close();
    const ledger = new Ledger(path);
    const core = new Core({ ledger, artifacts: f.artifacts, secrets: new MemorySecrets(), sandbox: noSandbox, log: () => {} });
    const engine = new FakeEngine();
    if (status !== "missing") engine.submissions.set(resume.requestId, { conversationId: id, submission: resume });
    const result: SubmissionRecovery = { status: status === "quota" ? "unanswered" : "done", entryId: 20, serving: status === "quota" ? null : "p", hit: status === "quota" ? { provider: "p", reason: "429", resumeAt: Date.now() + 3600_000 } : null };
    if (status === "done" || status === "quota") engine.outcomes.set(resume.requestId, result);
    core.attach(engine);
    try {
      await core.quota.start();
      await core.idle();
      const restored = ledger.setting<QuotaJournal>("quota", { entries: {}, records: [] });
      if (status === "quota") {
        expect(restored.records[0]!.queue.map((input) => input.requestId)).toEqual([`quota-resume:${id}:2`, next.requestId]);
        expect(engine.to(id)).toHaveLength(1);
      } else if (status === "done") {
        expect(engine.to(id)).toEqual([resume, next]);
      } else {
        expect(restored.records[0]!.releasing).toBe(resume.requestId);
        expect(engine.to(id)).toEqual([resume]);
        core.quota.tick(); await core.idle();
        expect(engine.to(id)).toHaveLength(1);
        core.quota.turnEnded(id, { entryId: 20, origin: "owner", providers: ["p"], serving: "p", hit: null });
        await core.idle();
        expect(engine.to(id)).toEqual([resume, next]);
      }
    } finally { core.stop(); await core.idle(); ledger.close(); }
  });
}

test("a later quota episode never reuses the resume identity of an already answered episode", async () => {
  const f = await fixture();
  const id = f.ghost.directConversationId;
  try {
    await f.core.quota.start();
    for (let episode = 1; episode <= 2; episode++) {
      f.core.quota.turnEnded(id, { entryId: episode * 10, origin: "owner", providers: ["p"], serving: null, hit: { provider: "p", reason: "429", resumeAt: 1 } });
      f.core.quota.tick();
      await f.core.idle();
      expect(f.engine.to(id).at(-1)?.requestId).toBe(`quota-resume:${id}:${episode}`);
      f.core.quota.turnEnded(id, { entryId: episode * 10 + 1, origin: "owner", providers: ["p"], serving: "p", hit: null });
      await f.core.idle();
    }
    expect(f.engine.to(id)).toHaveLength(2);
  } finally { f.core.stop(); await f.core.idle(); f.ledger.close(); }
});
