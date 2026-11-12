import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Access } from "../src/core/access.ts";
import { execute } from "../src/core/commands.ts";
import { budgetSpent } from "../src/core/budget.ts";
import { Core } from "../src/core/core.ts";
import type { RunEnd } from "../src/core/ports.ts";
import type { Submission } from "../src/core/ports.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { MIGRATIONS } from "../src/ledger/schema.ts";
import { FakeEngine, MemorySecrets, harness, noSandbox, tempDir } from "./support.ts";

const owner = { kind: "owner" } as const;

function setup() {
  const h = harness();
  const ghost = h.core.createGhost({ name: "Primary", persona: "Helpful." });
  const helper = h.core.createGhost({ name: "Helper", persona: "Does parts." });
  return { ...h, ghost, helper };
}

/** One finished run of a conversation; `quota` marks it as ended by a provider limit. */
function runSettles(core: Core, conversationId: string, ended?: RunEnd) {
  core.activity(conversationId, true, Date.now());
  core.activity(conversationId, false, Date.now(), ended);
}

const quotaEnd: RunEnd = { quota: true };

describe("execution budget (R3)", () => {
  test("the budget runs only while the Work works, and waiting, verifying and quota holds never spend it", async () => {
    const { core, ledger, ghost, helper, engine } = setup();
    const parent = core.works.createRoot({ ghostId: ghost.id, title: "P", brief: "B", originConversationId: ghost.directConversationId, budgetMinutes: 10080 });
    await core.idle();
    const parentId = ledger.work(parent.id).conversationId!;
    runSettles(core, parentId);
    await core.idle();

    // A delegated child puts the parent into waiting once its conversation idles again.
    core.works.delegate(parent.id, { ghostId: helper.id, title: "C", brief: "B", budgetMinutes: 10080 });
    runSettles(core, parentId);
    await core.idle();
    expect(ledger.work(parent.id).state).toBe("waiting");
    const waiting = ledger.work(parent.id);
    expect(waiting.budgetSince).toBeNull();
    const spentAtWait = budgetSpent(waiting);

    core.works.expire(Date.now() + 48 * 3600_000);
    await core.idle();
    expect(ledger.work(parent.id).state).toBe("waiting");
    expect(budgetSpent(ledger.work(parent.id))).toBe(spentAtWait);

    // Verifying likewise: complete folds the span and expiry leaves it alone.
    const child = ledger.children(parent.id)[0]!;
    core.works.complete(child.id, { summary: "done", artifacts: [] });
    await core.idle();
    expect(ledger.work(child.id).state).toBe("verifying");
    const verifyingSpent = budgetSpent(ledger.work(child.id));
    expect(ledger.work(child.id).budgetSince).toBeNull();
    core.works.expire(Date.now() + 48 * 3600_000);
    expect(budgetSpent(ledger.work(child.id))).toBe(verifyingSpent);
    expect(ledger.work(child.id).state).toBe("verifying");

    // A quota hold stops a running Work's clock without changing its state.
    const solo = core.works.createRoot({ ghostId: ghost.id, title: "S", brief: "B", originConversationId: ghost.directConversationId, budgetMinutes: 5 });
    await core.idle();
    const soloId = ledger.work(solo.id).conversationId!;
    runSettles(core, soloId, quotaEnd);
    expect(ledger.work(solo.id).hold).toBe("quota");
    expect(ledger.work(solo.id).state).toBe("running");
    const heldSpent = budgetSpent(ledger.work(solo.id));
    core.works.expire(Date.now() + 48 * 3600_000);
    expect(ledger.work(solo.id).state).toBe("running");
    expect(budgetSpent(ledger.work(solo.id))).toBe(heldSpent);
    expect(engine.aborted).not.toContain(soloId);
  });

  test("an exhausted budget pauses the Work and asks its origin instead of failing", async () => {
    const { core, ledger, engine, ghost, helper } = setup();
    const parent = core.works.createRoot({ ghostId: ghost.id, title: "P", brief: "B", originConversationId: ghost.directConversationId });
    await core.idle();
    const parentId = ledger.work(parent.id).conversationId!;
    runSettles(core, parentId);
    await core.idle();
    const child = core.works.delegate(parent.id, { ghostId: helper.id, title: "C", brief: "B", budgetMinutes: 30 });
    await core.idle();

    // 31 working minutes later the child pauses; its origin is the parent's conversation.
    const row = ledger.work(child.id);
    ledger.tx(() => ledger.putWork({ ...row, budgetUsedMs: 31 * 60_000, budgetSince: null }));
    core.works.expire(Date.now());
    await core.idle();

    const paused = ledger.work(child.id);
    expect(paused.state).toBe("blocked");
    expect(paused.hold).toBe("budget");
    expect(paused.reason).toContain("budget");
    const asked = engine.to(parentId).filter((submission) => submission.requestId === `work:${child.id}:budget:1`);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.text).toContain("work_decide");

    // The origin extends once; the same pause asks again and a second extension is refused.
    const extended = core.works.decide(child.id, "extend");
    expect(extended.state).toBe("running");
    expect(extended.budgetExtended).toBe(true);
    expect(extended.budgetUsedMs).toBe(0);
    await core.idle();
    const woken = engine.to(ledger.work(child.id).conversationId!).filter((submission) => submission.requestId === `work:${child.id}:budget:extend:${extended.revision}`);
    expect(woken).toHaveLength(1);

    ledger.tx(() => ledger.putWork({ ...ledger.work(child.id), budgetUsedMs: 91 * 60_000, budgetSince: null }));
    core.works.expire(Date.now());
    await core.idle();
    expect(ledger.work(child.id).state).toBe("blocked");
    expect(() => core.works.decide(child.id, "extend")).toThrow("already extended");

    // Stopping is the origin's other answer.
    const stopped = core.works.decide(child.id, "stop", "split instead");
    expect(stopped.state).toBe("cancelled");
    expect(stopped.reason).toContain("split instead");
  });

  test("only the owner sets or extends a due date; a Ghost-created Work carries none", async () => {
    const { core, ledger, ghost } = setup();
    const due = Date.now() + 86_400_000;

    // The owner command path sets it.
    const created = await execute(core, new Access(owner), { requestId: "r1", command: { type: "work.create", ghostId: ghost.id, title: "T", brief: "B", deadlineAt: due } }, { publicOrigin: "http://x", documents: null });
    const ownerWork = ledger.worksForState().find((work) => work.id === (created as { workId: string }).workId)!;
    expect(ownerWork.deadlineAt).toBe(due);
    const later = due + 3600_000;
    await execute(core, new Access(owner), { requestId: "r2", command: { type: "work.update", workId: ownerWork.id, deadlineAt: later } }, { publicOrigin: "http://x", documents: null });
    expect(ledger.work(ownerWork.id).deadlineAt).toBe(later);

    // The Ghost-facing creation path leaves the due date empty and names a budget instead.
    const ghostly = core.works.createRoot({ ghostId: ghost.id, title: "G", brief: "B", originConversationId: ghost.directConversationId, budgetMinutes: 20 });
    await core.idle();
    expect(ghostly.deadlineAt).toBeNull();
    expect(ghostly.budgetMinutes).toBe(20);
    // A delegated child inherits the owner's due date, never a Ghost-invented one.
    const helper = core.ledger.ghosts().find((item) => item.name === "Helper")!;
    const child = core.works.delegate(ghostly.id, { ghostId: helper.id, title: "C", brief: "B" });
    expect(child.deadlineAt).toBeNull();
    expect(child.budgetMinutes).toBe(90);
  });
});

describe("provider quota admission (R1)", () => {
  test("admission follows owner, running Work, decision follow-up, then self-directed wakes", async () => {
    const { core, engine, ghost } = setup();
    const mate = core.createGhost({ name: "Mate", persona: "P" });
    core.quota.start();
    const now = Date.now();

    // Four conversations whose whole chain is the same exhausted provider.
    const third = core.createGhost({ name: "Third", persona: "P" });
    const ownerInput: Submission = { text: "owner asks", origin: "owner", requestId: "owner:1" };
    const workInput: Submission = { text: "work continues", origin: "work", requestId: "work:1" };
    const wakeInput: Submission = { text: "wake", origin: "schedule", requestId: "wake:1" };
    const decisionInput: Submission = { text: "decision", origin: "decision", requestId: "decision:1" };
    const work = core.works.createRoot({ ghostId: ghost.id, title: "W", brief: "B", originConversationId: ghost.directConversationId });
    await core.idle();
    const workConversation = ledgerWorkConversation(core, work.id)!;
    // The provider is exhausted by a fifth conversation's turn, which itself waits to resume.
    const scratch = core.createDirectConversation(third.id, "scratch");
    core.quota.turnEnded(scratch.id, { entryId: 11, origin: "schedule", providers: ["p"], serving: "p", hit: { provider: "p", reason: "usage limit", resumeAt: now + 3_600_000 } });
    for (const [conversationId, submission] of [
      [third.directConversationId, wakeInput],
      [ghost.directConversationId, ownerInput],
      [mate.directConversationId, decisionInput],
      [workConversation, workInput],
    ] as const) {
      core.quota.hold(conversationId, submission, ["p"], core.ledger.conversation(conversationId).kind);
    }
    const held = ["owner:1", "work:1", "decision:1", "wake:1"];

    core.quota.tick(now + 3_600_000);
    await core.idle();
    expect([...engine.submissions.keys()].filter((requestId) => held.includes(requestId))).toEqual(["owner:1"]);

    // The owner's run ends; the Work's turn is next, before the decision and the wake.
    core.quota.turnEnded(ghost.directConversationId, { entryId: 1, origin: "owner", providers: ["p"], serving: null, hit: null }, now + 3_600_001);
    await core.idle();
    expect([...engine.submissions.keys()].filter((requestId) => held.includes(requestId))).toEqual(["owner:1", "work:1"]);

    core.quota.turnEnded(workConversation, { entryId: 2, origin: "work", providers: ["p"], serving: null, hit: null }, now + 3_600_002);
    await core.idle();
    const order = [...engine.submissions.keys()].filter((requestId) => held.includes(requestId));
    expect(order).toEqual(["owner:1", "work:1", "decision:1"]);
    expect(order).not.toContain("wake:1");

    // A completed turn on the provider proves the quota is back; what is left flows in order.
    core.quota.turnEnded(mate.directConversationId, { entryId: 3, origin: "decision", providers: ["p"], serving: "p", hit: null }, now + 3_600_003);
    await core.idle();
    expect([...engine.submissions.keys()].filter((requestId) => held.includes(requestId)).at(-1)).toBe("wake:1");
    expect(core.quota.waiting(now + 3_600_003)).toEqual([]);
  });

  test("a quota-ended turn consumes no idle nudge and never fails the Work by itself", async () => {
    const { core, ledger, ghost } = setup();
    const work = core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await core.idle();
    const conversationId = ledger.work(work.id).conversationId!;
    for (let round = 0; round < 5; round++) runSettles(core, conversationId, quotaEnd);
    expect(ledger.work(work.id).state).toBe("running");
    expect(ledger.idleNudges(work.id)).toBe(0);
    expect(ledger.work(work.id).hold).toBe("quota");

    // Two idle nudges are allowed; the third stop still fails, as before, but only without quota.
    core.works.holdForQuota(work.id, false);
    runSettles(core, conversationId);
    runSettles(core, conversationId);
    expect(ledger.work(work.id).state).toBe("running");
    expect(ledger.idleNudges(work.id)).toBe(2);
    runSettles(core, conversationId);
    await core.idle();
    expect(ledger.work(work.id).state).toBe("failed");
    expect(ledger.work(work.id).reason).toContain("stopped without completing");
  });
});

describe("artifact binding (R6)", () => {
  test("complete attaches the most recently published artifact of a name", async () => {
    const { core, ledger, ghost, artifacts } = setup();
    const work = core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await core.idle();
    const first = await artifacts.put(new TextEncoder().encode("v1"), "report.md", "text/markdown");
    ledger.tx(() => ledger.addArtifact(work.id, first));
    const second = await artifacts.put(new TextEncoder().encode("v2"), "report.md", "text/markdown");
    ledger.tx(() => ledger.addArtifact(work.id, second));
    core.works.complete(work.id, { summary: "s", artifacts: [second] });
    await core.idle();
    const result = ledger.work(work.id).result!;
    expect(result.artifacts[0]!.digest).toBe(second.digest);
  });
});

describe("limits as settings", () => {
  test("a changed limit applies without a restart", async () => {
    const { core, ledger } = setup();
    expect(ledger.limits().openGoals).toBe(3);
    core.goals.create({ title: "one" });
    core.goals.create({ title: "two" });
    core.goals.create({ title: "three" });
    expect(() => core.goals.create({ title: "four" })).toThrow("at most 3 goals");
    ledger.tx(() => ledger.putSetting("limits", { openGoals: 2 }));
    expect(() => core.goals.create({ title: "four" })).toThrow("at most 2 goals");
    ledger.tx(() => ledger.putSetting("limits", { openGoals: 4 }));
    expect(core.goals.create({ title: "four" }).title).toBe("four");
    expect(ledger.settings().limits).toMatchObject({ openGoals: 4, dailyWakes: 12 });

    // The owner's settings command edits one bound without clearing the others.
    await execute(core, new Access(owner), { requestId: "limits", command: { type: "settings.update", limits: { dailyWakes: 5 } } }, { publicOrigin: "http://x", documents: null });
    expect(ledger.limits()).toMatchObject({ openGoals: 4, dailyWakes: 5 });
  });
});

function ledgerWorkConversation(core: Core, workId: string): string | null {
  return core.ledger.work(workId).conversationId;
}

/** Close the ledger, reopen it in a fresh Core whose engine already holds `sent`, and start. */
async function restart(path: string, first: ReturnType<typeof harness>, sent: Map<string, { conversationId: string; submission: Submission }>) {
  const ledger = new Ledger(path);
  const core = new Core({ ledger, artifacts: first.artifacts, sandbox: noSandbox, secrets: new MemorySecrets(), log: () => {} });
  const engine = new FakeEngine();
  for (const [requestId, item] of sent) engine.submissions.set(requestId, item);
  core.attach(engine);
  await core.start();
  await core.idle();
  return { ledger, core, engine, artifacts: first.artifacts };
}

describe("restart safety", () => {
  test("a pending quota resume and a budget-paused Work survive a restart without duplicate wakes", async () => {
    const path = join(tempDir(), "ledger.db");
    const first = harness(path);
    const ghost = first.core.createGhost({ name: "G", persona: "" });
    first.core.quota.start();

    const quotaWork = first.core.works.createRoot({ ghostId: ghost.id, title: "Q", brief: "B", originConversationId: ghost.directConversationId });
    await first.core.idle();
    const quotaConversation = first.ledger.work(quotaWork.id).conversationId!;
    first.core.quota.turnEnded(quotaConversation, {
      entryId: 7,
      origin: "work",
      providers: ["p"],
      serving: "p",
      hit: { provider: "p", reason: "usage limit", resumeAt: Date.now() + 3_600_000 },
    });
    expect(first.ledger.work(quotaWork.id).hold).toBe("quota");

    const paused = first.core.works.createRoot({ ghostId: ghost.id, title: "P", brief: "B", originConversationId: ghost.directConversationId, budgetMinutes: 30 });
    await first.core.idle();
    first.ledger.tx(() => first.ledger.putWork({ ...first.ledger.work(paused.id), budgetUsedMs: 31 * 60_000, budgetSince: null }));
    first.core.works.expire(Date.now());
    await first.core.idle();
    expect(first.ledger.work(paused.id).hold).toBe("budget");

    const sent = new Map(first.engine.submissions);
    first.core.stop();
    first.ledger.close();

    const second = await restart(path, first, sent);
    expect(second.ledger.work(quotaWork.id).hold).toBe("quota");
    expect(second.ledger.work(paused.id).state).toBe("blocked");
    expect(second.ledger.work(paused.id).hold).toBe("budget");
    // No recovery wake for a held Work, and no duplicate budget question.
    const afterStart = new Map(second.engine.submissions);
    expect([...afterStart.keys()].filter((requestId) => requestId.includes(":recover:"))).toEqual([]);
    expect(second.engine.to(ghost.directConversationId).filter((submission) => submission.requestId === `work:${paused.id}:budget:1`)).toHaveLength(1);

    // The resume fires exactly once, under the same request id, however often the host restarts.
    second.core.quota.tick(Date.now() + 3_600_001);
    await second.core.idle();
    const resumes = [...second.engine.submissions.keys()].filter((requestId) => requestId.startsWith(`quota-resume:${quotaConversation}`));
    expect(resumes).toEqual([`quota-resume:${quotaConversation}:1`]);
    const beforeThird = new Map(second.engine.submissions);
    second.core.stop();
    second.ledger.close();

    const third = await restart(path, second, beforeThird);
    expect([...third.engine.submissions.keys()].filter((requestId) => requestId.startsWith(`quota-resume:${quotaConversation}`))).toEqual(resumes);
    third.core.stop();
    third.ledger.close();
  });
});

describe("budget migration 10", () => {
  /** Seed the pre-migration schema at version 9 with one Works row shape per rule. */
  function seed(path: string) {
    const db = new Database(path);
    try {
      db.transaction(() => {
        for (const migration of MIGRATIONS.slice(0, 9)) db.exec(migration);
        db.exec("PRAGMA user_version = 9");
        db.query(`INSERT INTO ghosts (id, name, persona, look, is_default, state, direct_conversation_id, created_at, updated_at)
          VALUES ('g', 'G', '', '{"avatarId":null}', 1, 'active', 'c', 1, 1)`).run();
        db.query(`INSERT INTO conversations (id, ghost_id, kind, title, created_at, last_activity_at)
          VALUES ('c', 'g', 'direct', 'G', 1, 1)`).run();
        const insert = db.query(`INSERT INTO works
          (id, parent_id, root_id, ghost_id, origin_conversation_id, title, brief, acceptance, state, revision, revisions_used, deadline_at, created_at, updated_at, activity_id)
          VALUES (?, NULL, ?, 'g', 'c', ?, 'B', '{"criteria":"","checks":[],"reviewer":null}', ?, 1, 0, ?, ?, ?, ?)`);
        // A Ghost-set deadline: whole minutes off a non-aligned creation time.
        insert.run("ghostset", "ghostset", "Ghost set", "running", 1_731_392_001_234 + 90 * 60_000 + 123, 1_731_392_001_234, 1_731_392_001_234, null);
        // The owner's due date: the date-time picker lands on a whole minute.
        insert.run("ownerdue", "ownerdue", "Owner due", "running", 1_731_396_000_000, 1_731_392_001_234, 1_731_392_001_234, null);
        // A terminal row is untouched.
        insert.run("terminal", "terminal", "Done already", "done", 1_731_392_001_234 + 90 * 60_000 + 123, 1_731_392_001_234, 1_731_392_001_234, null);
        // An activity run keeps its owner-approved timeout as the due date and gets a budget no shorter.
        insert.run("activity", "activity", "Activity", "running", 1_731_392_001_234 + 30 * 60_000, 1_731_392_001_234, 1_731_392_001_234, "a1");
      })();
      return {
        ghostset: 1_731_392_001_234 + 90 * 60_000 + 123,
        ownerdue: 1_731_396_000_000,
        activity: 1_731_392_001_234 + 30 * 60_000,
      };
    } finally {
      db.close();
    }
  }

  test("live Ghost-set deadlines become budgets; owner due dates and terminal rows stay", () => {
    const path = join(tempDir(), "ledger.db");
    const times = seed(path);
    const ledger = new Ledger(path);
    const ghostset = ledger.work("ghostset");
    expect(ghostset.deadlineAt).toBeNull();
    expect(ghostset.budgetMinutes).toBe(90);
    expect(ghostset.budgetSince).not.toBeNull();
    expect(ghostset.budgetUsedMs).toBe(0);

    const ownerdue = ledger.work("ownerdue");
    expect(ownerdue.deadlineAt).toBe(times.ownerdue);
    expect(ownerdue.budgetMinutes).toBe(90);

    const terminal = ledger.work("terminal");
    expect(terminal.deadlineAt).toBe(times.ghostset);
    expect(terminal.budgetMinutes).toBe(90);
    expect(terminal.budgetSince).toBeNull();

    const activity = ledger.work("activity");
    expect(activity.deadlineAt).toBe(times.activity);
    expect(activity.budgetMinutes).toBe(30);
    ledger.close();
  });
});
