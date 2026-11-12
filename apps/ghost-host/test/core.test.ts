import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { type Principal } from "@ghost/contract";
import { Access } from "../src/core/access.ts";
import { execute, updateGhost } from "../src/core/commands.ts";
import { Core } from "../src/core/core.ts";
import { KnownOutcome } from "../src/core/effects.ts";
import { digestOf } from "../src/core/ids.ts";
import { snapshot } from "../src/core/state.ts";
import { FakeEngine, MemorySecrets, harness, noSandbox, tempDir } from "./support.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { MIGRATIONS } from "../src/ledger/schema.ts";
import type { Submission } from "../src/core/ports.ts";

const owner = { kind: "owner" } as const satisfies Principal;
const uuid = () => crypto.randomUUID();

/** Seed the actual old schema, rather than dropping selected columns from today's database. */
function historicalGhosts(path: string, version: 2 | 3, names: string[]): string[] {
  const db = new Database(path);
  try {
    return db.transaction(() => {
      for (const migration of MIGRATIONS.slice(0, version)) db.exec(migration);
      db.exec(`PRAGMA user_version = ${version}`);
      const ghost = db.query(`INSERT INTO ghosts (id, name, persona, look, is_default, state, direct_conversation_id, created_at, updated_at)
        VALUES (?, ?, '', '{"avatarId":null}', ?, 'active', ?, 1, 1)`);
      const conversation = db.query(`INSERT INTO conversations (id, ghost_id, kind, title, created_at, last_activity_at)
        VALUES (?, ?, 'direct', ?, 1, 1)`);
      return names.map((name, index) => {
        const id = uuid();
        const conversationId = uuid();
        ghost.run(id, name, index === 0 ? 1 : 0, conversationId);
        conversation.run(conversationId, id, name);
        return id;
      });
    })();
  } finally {
    db.close();
  }
}

function setup() {
  const h = harness();
  const ghost = h.core.createGhost({ name: "Primary", persona: "Helpful." });
  const helper = h.core.createGhost({ name: "Helper", persona: "Does parts." });
  return { ...h, ghost, helper };
}

/** Simulate one finished run of a conversation. */
function runSettles(core: Core, conversationId: string) {
  core.activity(conversationId, true, Date.now());
  core.activity(conversationId, false, Date.now());
}

describe("root Work", () => {
  test("starts once, verifies with the owner, and reports to the origin conversation", async () => {
    const { core, ledger, engine, ghost, artifacts } = setup();
    const work = core.works.createRoot({ ghostId: ghost.id, title: "Write a note", brief: "Write note.txt", originConversationId: ghost.directConversationId });
    core.works.kick(work.id);
    core.works.kick(work.id);
    await core.idle();

    const running = ledger.work(work.id);
    expect(running.state).toBe("running");
    expect(running.conversationId).not.toBeNull();
    expect(engine.to(running.conversationId!).filter((submission) => submission.origin === "work")).toHaveLength(1);

    const ref = await artifacts.put(new TextEncoder().encode("hello"), "note.txt", "text/plain");
    ledger.tx(() => ledger.addArtifact(work.id, ref));
    core.works.complete(work.id, { summary: "Wrote it.", artifacts: [ref] });
    await core.idle();

    expect(ledger.work(work.id).state).toBe("verifying");
    const [decision] = ledger.pendingDecisions({ workId: work.id });
    expect(decision?.kind).toBe("accept_result");

    await core.decisions.resolve(decision!.id, { outcome: "approve" });
    await core.idle();

    expect(ledger.work(work.id).state).toBe("done");
    const reports = engine.to(ghost.directConversationId).filter((submission) => submission.origin === "report");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.text).toContain("done");
    expect(ledger.notificationsForState().some((notification) => notification.workId === work.id && notification.kind === "work_done")).toBe(true);
  });

  test("an owner denial asks for a revision until the limit, then fails", async () => {
    const { core, ledger, engine, ghost } = setup();
    const work = core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await core.idle();
    for (let round = 0; round <= core.ledger.limits().revisions; round++) {
      core.works.complete(work.id, { summary: `try ${round}`, artifacts: [] });
      await core.idle();
      const [decision] = ledger.pendingDecisions({ workId: work.id });
      await core.decisions.resolve(decision!.id, { outcome: "deny", answer: "Not yet." });
      await core.idle();
    }
    const failed = ledger.work(work.id);
    expect(failed.state).toBe("failed");
    expect(engine.to(failed.conversationId!).filter((submission) => submission.origin === "verdict")).toHaveLength(core.ledger.limits().revisions);
  });

  test("checks decide without the owner", async () => {
    const { core, ledger, ghost, artifacts } = setup();
    const bytes = new TextEncoder().encode("42\n");
    const ref = await artifacts.put(bytes, "answer.txt", "text/plain");
    const work = core.works.createRoot({
      ghostId: ghost.id,
      title: "Answer",
      brief: "Write 42",
      originConversationId: ghost.directConversationId,
      acceptance: { criteria: "", checks: [{ kind: "artifact_sha256", name: "answer.txt", sha256: ref.digest }], reviewer: null },
    });
    await core.idle();
    ledger.tx(() => ledger.addArtifact(work.id, ref));
    core.works.complete(work.id, { summary: "42", artifacts: [ref] });
    await core.idle();
    expect(ledger.work(work.id).state).toBe("done");
    expect(ledger.work(work.id).verdict?.source).toBe("checks");
    expect(ledger.pendingDecisions({ workId: work.id })).toHaveLength(0);
  });

  test("completing with an artifact the Work did not publish is refused", async () => {
    const { core, ghost, artifacts } = setup();
    const work = core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await core.idle();
    const foreign = await artifacts.put(new TextEncoder().encode("x"), "x.txt", "text/plain");
    expect(() => core.works.complete(work.id, { summary: "s", artifacts: [foreign] })).toThrow();
  });

  test("going idle without completing is nudged twice, then fails", async () => {
    const { core, ledger, engine, ghost } = setup();
    const work = core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await core.idle();
    const conversationId = ledger.work(work.id).conversationId!;
    runSettles(core, conversationId);
    await core.idle();
    expect(ledger.work(work.id).state).toBe("running");
    expect(engine.to(conversationId).some((submission) => submission.requestId.includes(":nudge:1"))).toBe(true);
    runSettles(core, conversationId);
    await core.idle();
    // R4: a second idle nudge is allowed before the Work fails.
    expect(ledger.work(work.id).state).toBe("running");
    expect(engine.to(conversationId).some((submission) => submission.requestId.includes(":nudge:2"))).toBe(true);
    runSettles(core, conversationId);
    await core.idle();
    expect(ledger.work(work.id).state).toBe("failed");
  });

  test("the deadline fails live Work and aborts its conversation", async () => {
    const { core, ledger, engine, ghost } = setup();
    const work = core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId, deadlineAt: Date.now() + 1000 });
    await core.idle();
    core.works.expire(Date.now() + 2000);
    await core.idle();
    const failed = ledger.work(work.id);
    expect(failed.state).toBe("failed");
    expect(failed.reason).toContain("deadline");
    expect(engine.aborted).toContain(failed.conversationId!);
  });
});

describe("delegation", () => {
  test("a parent waits for its child and receives the child's outcome", async () => {
    const { core, ledger, engine, ghost, helper } = setup();
    const parent = core.works.createRoot({ ghostId: ghost.id, title: "Parent", brief: "Split it", originConversationId: ghost.directConversationId });
    await core.idle();
    const child = core.works.delegate(parent.id, { ghostId: helper.id, title: "Child", brief: "Do half" });
    await core.idle();
    expect(ledger.work(child.id).state).toBe("running");
    expect(ledger.work(child.id).originConversationId).toBe(ledger.work(parent.id).conversationId!);

    runSettles(core, ledger.work(parent.id).conversationId!);
    await core.idle();
    expect(ledger.work(parent.id).state).toBe("waiting");
    expect(() => core.works.complete(parent.id, { summary: "s", artifacts: [] })).toThrow();

    core.works.complete(child.id, { summary: "half done", artifacts: [] });
    await core.idle();
    expect(ledger.pendingDecisions({ workId: child.id })).toHaveLength(0);
    const review = ledger.conversations({ kind: "review" }).find((conversation) => conversation.workId === child.id);
    expect(review?.ghostId).toBe(ghost.id);
    expect(engine.to(review!.id)).toHaveLength(1);
    core.works.applyVerdict(child.id, { outcome: "pass", source: "review", reasons: "Looks right.", at: Date.now() });
    await core.idle();

    expect(ledger.work(child.id).state).toBe("done");
    expect(ledger.work(parent.id).state).toBe("running");
    const results = engine.to(ledger.work(parent.id).conversationId!).filter((submission) => submission.origin === "child_result");
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toContain("half done");
  });

  test("a child cannot outlive its parent's deadline and cancelling the parent cancels the child", async () => {
    const { core, ledger, engine, ghost, helper } = setup();
    const deadline = Date.now() + 60_000;
    const parent = core.works.createRoot({ ghostId: ghost.id, title: "P", brief: "B", originConversationId: ghost.directConversationId, deadlineAt: deadline });
    await core.idle();
    const child = core.works.delegate(parent.id, { ghostId: helper.id, title: "C", brief: "B", deadlineAt: deadline + 60_000 });
    expect(ledger.work(child.id).deadlineAt).toBe(deadline);
    await core.idle();
    core.works.cancel(parent.id);
    await core.idle();
    expect(ledger.work(child.id).state).toBe("cancelled");
    expect(engine.aborted).toContain(ledger.work(child.id).conversationId!);
  });
});

describe("effects", () => {
  test("reconciliation and explicit resume ignore unexecuted approval proposals", async () => {
    const { core, ledger, ghost } = setup();
    try {
      const work = core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
      await core.idle();
      const conversationId = ledger.work(work.id).conversationId!;
      core.effects.onApproved("host_command_propose", async () => "approved");
      const proposal = core.effects.propose({
        conversationId, callId: "optional", tool: "host_command_propose", input: {}, summary: "optional",
        title: "optional", detail: "", proposal: {},
      });
      const uncertain = core.effects.begin({ conversationId, callId: "uncertain", tool: "activity_action", input: {}, summary: "uncertain" });
      core.effects.unknown(uncertain.effect.id, "lost reply");
      expect(ledger.work(work.id).state).toBe("blocked");
      expect(() => core.works.resume(work.id)).toThrow("unknown effect");
      const decision = ledger.pendingDecisions({ effectId: uncertain.effect.id })[0]!;
      await core.decisions.resolve(decision.id, { outcome: "deny" });
      await core.idle();
      expect(ledger.work(work.id).state).toBe("running");
      expect(ledger.effect(proposal.id).state).toBe("pending");
      expect(ledger.pendingDecisions({ effectId: proposal.id })).toHaveLength(1);
      core.works.block(work.id, "resumable test block");
      expect(core.works.resume(work.id).state).toBe("running");
      expect(ledger.effect(proposal.id).state).toBe("pending");
      await core.idle();
    } finally { ledger.close(); }
  });

  test("approval-pending proposals allow later writes and survive recovery", async () => {
    const { core, ledger, ghost } = setup();
    try {
      const conversationId = ghost.directConversationId;
      core.effects.onApproved("host_command_propose", async () => "approved");
      const proposal = core.effects.propose({
        conversationId, callId: "proposal", tool: "host_command_propose", input: {}, summary: "Optional change",
        title: "Optional change", detail: "", proposal: {},
      });
      expect(await core.effects.run({
        conversationId, callId: "write", tool: "write", input: {}, summary: "write",
      }, async () => "written")).toBe("written");
      core.effects.recoverInterrupted();
      expect(ledger.effect(proposal.id).state).toBe("pending");
      expect(ledger.pendingDecisions({ effectId: proposal.id })[0]?.kind).toBe("approve_effect");
      const running = core.effects.begin({ conversationId, callId: "running", tool: "bash", input: {}, summary: "running" });
      expect(() => core.effects.begin({ conversationId, callId: "after-running", tool: "write", input: {}, summary: "write" })).toThrow("still running");
      core.effects.finish(running.effect.id, "done");
      const uncertain = core.effects.begin({ conversationId, callId: "uncertain", tool: "activity_action", input: {}, summary: "uncertain" });
      core.effects.unknown(uncertain.effect.id, "lost reply");
      expect(() => core.effects.begin({ conversationId, callId: "after-unknown", tool: "write", input: {}, summary: "write" })).toThrow("owner reconciles");
    } finally { ledger.close(); }
  });

  test("complete withdraws optional proposals atomically without executing them", async () => {
    const { core, ledger, ghost } = setup();
    try {
      const work = core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
      await core.idle();
      const conversationId = ledger.work(work.id).conversationId!;
      let executions = 0;
      core.effects.onApproved("host_command_propose", async () => { executions++; return "executed"; });
      for (const callId of ["proposal-1", "proposal-2"]) core.effects.propose({
        conversationId, callId, tool: "host_command_propose", input: {}, summary: "optional",
        title: "optional", detail: "", proposal: {},
      });
      const proposals = core.effects.unresolved(work.id);
      const decisions = ledger.pendingDecisions({ workId: work.id });
      expect(core.works.complete(work.id, { summary: "Done without optional changes", artifacts: [] }).state).toBe("verifying");
      expect(executions).toBe(0);
      for (const proposal of proposals) {
        expect(ledger.effect(proposal.id)).toMatchObject({ state: "denied", result: "withdrawn: the Work completed without it" });
        expect(ledger.decision(decisions.find((decision) => decision.effectId === proposal.id)!.id).state).toBe("cancelled");
        await core.effects.resolveApproval(proposal.id, true);
      }
      expect(executions).toBe(0);
      await core.idle();
    } finally { ledger.close(); }
  });

  test("complete refuses unknown or executing effects without withdrawing proposals", async () => {
    const { core, ledger, ghost } = setup();
    try {
      const work = core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
      await core.idle();
      const conversationId = ledger.work(work.id).conversationId!;
      core.effects.onApproved("host_command_propose", async () => "executed");
      const proposal = core.effects.propose({
        conversationId, callId: "optional", tool: "host_command_propose", input: {}, summary: "optional",
        title: "optional", detail: "", proposal: {},
      });
      const running = core.effects.begin({ conversationId, callId: "running", tool: "activity_action", input: {}, summary: "running" });
      expect(() => core.works.complete(work.id, { summary: "done", artifacts: [] })).toThrow("unresolved");
      ledger.tx(() => ledger.putEffect({ ...running.effect, state: "unknown" }));
      expect(() => core.works.complete(work.id, { summary: "done", artifacts: [] })).toThrow("unresolved");
      expect(ledger.effect(proposal.id).state).toBe("pending");
      expect(ledger.pendingDecisions({ effectId: proposal.id })).toHaveLength(1);
      expect(ledger.work(work.id).state).toBe("running");
    } finally { ledger.close(); }
  });

  test("a replayed call returns its recorded result without running again", async () => {
    const { core, ledger, ghost } = setup();
    const work = core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await core.idle();
    const conversationId = ledger.work(work.id).conversationId!;
    let runs = 0;
    const input = { conversationId, callId: "call-1", tool: "bash", input: { command: "echo hi" }, summary: "echo hi" };
    const perform = async () => {
      runs++;
      return "hi";
    };
    expect(await core.effects.run(input, perform)).toBe("hi");
    expect(await core.effects.run(input, perform)).toBe("hi");
    expect(runs).toBe(1);
    await expect(core.effects.run({ ...input, input: { command: "rm -rf /" } }, perform)).rejects.toThrow("different input");
  });

  test("a known failure is recorded as done and does not block", async () => {
    const { core, ledger, ghost } = setup();
    const work = core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await core.idle();
    const conversationId = ledger.work(work.id).conversationId!;
    await expect(
      core.effects.run({ conversationId, callId: "c1", tool: "bash", input: { command: "false" }, summary: "false" }, async () => {
        throw new KnownOutcome('{"exitCode":1,"stdout":"","stderr":""}');
      }),
    ).rejects.toThrow();
    expect(ledger.work(work.id).state).toBe("running");
    expect(await core.effects.run({ conversationId, callId: "c2", tool: "bash", input: { command: "true" }, summary: "true" }, async () => "ok")).toBe("ok");
  });

  test("a change the Ghost can check itself never asks the owner after a restart", async () => {
    const path = join(tempDir(), "ledger.db");
    const first = harness(path);
    const ghost = first.core.createGhost({ name: "G", persona: "" });
    const work = first.core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await first.core.idle();
    const conversationId = first.ledger.work(work.id).conversationId!;
    first.core.effects.begin({ conversationId, callId: "c1", tool: "write", input: { path: "a.txt" }, summary: "write a.txt" });
    first.ledger.close();

    const second = harness(path);
    second.core.effects.recoverInterrupted();
    expect(second.ledger.pendingDecisions({ workId: work.id })).toHaveLength(0);
    expect(second.ledger.work(work.id).state).not.toBe("blocked");
    const effect = second.ledger.effectByCall(conversationId, "c1")!;
    expect(effect.state).toBe("done");
    expect(effect.result).toContain("Outcome uncertain");
    // Never run again on its own: the same call replays the recorded note.
    expect(await second.core.effects.run({ conversationId, callId: "c1", tool: "write", input: { path: "a.txt" }, summary: "write a.txt" }, async () => "again")).toContain("Outcome uncertain");
  });

  test("a pending \"did bash happen?\" card from before goes back to the Ghost at startup and the Work resumes", async () => {
    const { core, ledger, engine } = harness();
    const ghost = core.createGhost({ name: "G", persona: "" });
    const work = core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await core.idle();
    const conversationId = ledger.work(work.id).conversationId!;
    // The shape older Hosts left behind: an unknown bash effect, a blocked Work and an owner card.
    const start = core.effects.begin({ conversationId, callId: "c1", tool: "bash", input: { command: "ls" }, summary: "ls" });
    ledger.tx(() => {
      ledger.putEffect({ ...start.effect, state: "unknown", result: "the host stopped while this effect was running", endedAt: Date.now() });
      core.works.block(work.id, "unknown outcome of bash");
      ledger.putDecision({ id: "old", kind: "reconcile_effect", ghostId: ghost.id, conversationId, workId: work.id, effectId: start.effect.id,
        title: 'Did "bash" happen?', detail: "ls", options: [], proposal: null, state: "pending", answer: null, createdAt: Date.now(), resolvedAt: null });
    });
    core.effects.returnSelfCheckable();
    await core.idle();
    expect(ledger.decision("old").state).toBe("cancelled");
    expect(ledger.effect(start.effect.id).state).toBe("done");
    expect(ledger.work(work.id).state).toBe("running");
    expect(engine.to(conversationId).at(-1)?.text).toContain("Outcome uncertain");
  });

  test("an effect interrupted by a restart blocks the Work until the owner reconciles it", async () => {
    const path = join(tempDir(), "ledger.db");
    const first = harness(path);
    const ghost = first.core.createGhost({ name: "G", persona: "" });
    const work = first.core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await first.core.idle();
    const conversationId = first.ledger.work(work.id).conversationId!;
    const start = first.core.effects.begin({ conversationId, callId: "c1", tool: "activity_action", input: { title: "deploy" }, summary: "deploy" });
    expect(start.kind).toBe("run");
    first.ledger.close();

    const second = harness(path);
    second.core.effects.recoverInterrupted();
    expect(second.ledger.work(work.id).state).toBe("blocked");
    expect(() => second.core.effects.begin({ conversationId, callId: "c2", tool: "bash", input: { command: "ls" }, summary: "ls" })).toThrow("unresolved");
    const [decision] = second.ledger.pendingDecisions({ workId: work.id });
    expect(decision?.kind).toBe("reconcile_effect");

    await second.core.decisions.resolve(decision!.id, { outcome: "approve" });
    await second.core.idle();
    expect(second.ledger.work(work.id).state).toBe("running");
    expect(second.engine.to(conversationId).some((submission) => submission.origin === "decision")).toBe(true);
  });
});

describe("restart", () => {
  /** Close the ledger, reopen it in a fresh Core whose engine already holds `sent`, and start. */
  async function restart(path: string, first: ReturnType<typeof harness>, sent: Map<string, { conversationId: string; submission: Submission }>) {
    const ledger = new Ledger(path);
    const core = new Core({ ledger, artifacts: first.artifacts, sandbox: noSandbox, secrets: new MemorySecrets(), log: () => {} });
    const engine = new FakeEngine();
    for (const [requestId, item] of sent) engine.submissions.set(requestId, item);
    core.attach(engine);
    await core.start();
    await core.idle();
    core.stop();
    return { ledger, core, engine };
  }

  test("a Work running mid-turn gets no extra submission after a restart", async () => {
    const path = join(tempDir(), "ledger.db");
    const first = harness(path);
    const ghost = first.core.createGhost({ name: "G", persona: "" });
    const work = first.core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await first.core.idle();
    first.core.activity(first.ledger.work(work.id).conversationId!, true, Date.now());
    const sent = new Map(first.engine.submissions);
    first.ledger.close();

    const second = await restart(path, first, sent);
    expect([...second.engine.submissions.keys()].sort()).toEqual([...sent.keys()].sort());
    expect(second.ledger.work(work.id).state).toBe("running");
  });

  test("an idle running Work whose wake was lost is woken once, however often the host restarts", async () => {
    const path = join(tempDir(), "ledger.db");
    const first = harness(path);
    const ghost = first.core.createGhost({ name: "G", persona: "" });
    const work = first.core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await first.core.idle();
    const sent = new Map(first.engine.submissions);
    first.ledger.close();

    const second = await restart(path, first, sent);
    const recovered = [...second.engine.submissions.keys()].filter((requestId) => requestId.includes(":recover:"));
    expect(recovered).toHaveLength(1);
    const afterSecond = new Map(second.engine.submissions);
    second.ledger.close();

    const third = await restart(path, first, afterSecond);
    expect([...third.engine.submissions.keys()].filter((requestId) => requestId.includes(":recover:"))).toEqual(recovered);
    expect(third.ledger.work(work.id).state).toBe("running");
  });

  test("a root Work settled just before a crash still reports to the owner", async () => {
    const path = join(tempDir(), "ledger.db");
    const first = harness(path);
    const ghost = first.core.createGhost({ name: "G", persona: "" });
    const work = first.core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await first.core.idle();
    // Commit the terminal state without letting the report lane run, as a crash would.
    first.ledger.tx(() => first.ledger.putWork({ ...first.ledger.work(work.id), state: "failed", reason: "boom", endedAt: Date.now() }));
    const sent = new Map(first.engine.submissions);
    first.ledger.close();

    const second = await restart(path, first, sent);
    expect(second.engine.to(ghost.directConversationId).filter((submission) => submission.origin === "report")).toHaveLength(1);
    expect(second.ledger.notificationsForState().some((notification) => notification.workId === work.id && notification.kind === "work_failed")).toBe(true);
  });

  test("an owner answer committed just before a crash is still delivered", async () => {
    const path = join(tempDir(), "ledger.db");
    const first = harness(path);
    const ghost = first.core.createGhost({ name: "G", persona: "" });
    const question = first.core.decisions.ask(ghost.directConversationId, "Which?", "Pick one", ["A", "B"]);
    first.ledger.tx(() => first.ledger.putDecision({ ...question, state: "answered", answer: "B", resolvedAt: Date.now() }));
    const sent = new Map(first.engine.submissions);
    first.ledger.close();

    const second = await restart(path, first, sent);
    const delivered = second.engine.to(ghost.directConversationId).filter((submission) => submission.origin === "decision");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain("B");
    expect(second.ledger.decisionsAwaitingFollowUp()).toHaveLength(0);
  });
});

describe("commands and access", () => {
  test("a repeated request id runs once; different bytes conflict", async () => {
    const { core, ledger, ghost } = setup();
    const access = new Access(owner);
    const requestId = uuid();
    const request = { requestId, command: { type: "work.create" as const, ghostId: ghost.id, title: "T", brief: "B" } };
    const first = await execute(core, access, request, { publicOrigin: "http://x", documents: null });
    const second = await execute(core, access, request, { publicOrigin: "http://x", documents: null });
    expect(second).toEqual(first);
    expect(ledger.worksForState()).toHaveLength(1);
    await expect(execute(core, access, { requestId, command: { ...request.command, title: "Other" } }, { publicOrigin: "http://x", documents: null })).rejects.toThrow("different command");
  });

  test("a device sees every Ghost's conversations and Work and can act across them", async () => {
    const { core, ledger, ghost, helper } = setup();
    const device = new Access({ kind: "device", deviceId: "d1", name: "Phone" });
    const later = core.createGhost({ name: "After pairing", persona: "" });
    const context = { publicOrigin: "http://x", documents: null };
    const workIds: string[] = [];
    for (const target of [ghost, helper, later]) {
      const created = await execute(core, device, {
        requestId: uuid(), command: { type: "work.create", ghostId: target.id, title: target.name, brief: "B" },
      }, context);
      workIds.push(created.workId as string);
      await execute(core, device, {
        requestId: uuid(), command: { type: "message.send", conversationId: target.directConversationId, text: "Hello" },
      }, context);
      await execute(core, device, {
        requestId: uuid(), command: { type: "message.cancel", conversationId: target.directConversationId },
      }, context);
      const question = core.decisions.ask(target.directConversationId, "Which?", "Choose", ["A", "B"]);
      await execute(core, device, {
        requestId: uuid(), command: { type: "decision.resolve", decisionId: question.id, outcome: "answer", answer: "A" },
      }, context);
    }
    await core.idle();

    const state = snapshot(core, device);
    const ownerState = snapshot(core, new Access(owner));
    for (const key of ["ghosts", "conversations", "works", "decisions", "notifications", "schedules", "spaces", "settings", "devices", "sandboxes", "activities", "activityRuns", "connections"] as const) {
      expect(state[key]).toEqual(ownerState[key]);
    }
    expect(state.ghosts.map((item) => item.id)).toContain(later.id);
    expect(state.works.map((item) => item.id).sort()).toEqual(workIds.sort());

    // Owner-equivalent: the device creates a Ghost like the owner can.
    const created = await execute(core, device, {
      requestId: uuid(), command: { type: "ghost.create", name: "X", persona: "" },
    }, context);
    expect(ledger.ghosts().some((row) => row.id === created.ghostId)).toBe(true);
    for (const workId of workIds) {
      core.works.fail(workId, "Retry this Work");
      await execute(core, device, { requestId: uuid(), command: { type: "work.resume", workId } }, context);
      await core.idle();
      await execute(core, device, { requestId: uuid(), command: { type: "work.update", workId, title: "Updated" } }, context);
      await execute(core, device, { requestId: uuid(), command: { type: "work.cancel", workId } }, context);
      expect(ledger.work(workId)).toMatchObject({ title: "Updated", state: "cancelled" });
    }
  });

  test("device management stays owner-only; a device may revoke itself", async () => {
    const { core, ledger } = setup();
    const device = new Access({ kind: "device", deviceId: "d2", name: "Phone" });
    const context = { publicOrigin: "http://x", documents: null };
    ledger.tx(() => {
      ledger.insertDevice({ id: "d2", name: "Phone", pushEnabled: false, alerts: { mutedKinds: [], mutedGhostIds: [] }, createdAt: Date.now(), lastSeenAt: null }, "hash-d2");
      ledger.insertDevice({ id: "d3", name: "Other", pushEnabled: false, alerts: { mutedKinds: [], mutedGhostIds: [] }, createdAt: Date.now(), lastSeenAt: null }, "hash-d3");
    });

    for (const request of [
      { requestId: uuid(), command: { type: "device.pairing_start" as const } },
      { requestId: uuid(), command: { type: "device.update" as const, deviceId: "d2", name: "Renamed" } },
      { requestId: uuid(), command: { type: "device.revoke" as const, deviceId: "d3" } },
    ]) {
      await expect(execute(core, device, request, context)).rejects.toThrow("needs the owner");
    }
    expect(ledger.devices().map((row) => row.id).sort()).toEqual(["d2", "d3"]);

    await execute(core, device, { requestId: uuid(), command: { type: "device.revoke", deviceId: "d2" } }, context);
    expect(ledger.devices().map((row) => row.id)).toEqual(["d3"]);
    expect(ledger.deviceByTokenHash("hash-d2")).toBeNull();
  });

  test("ghost.update changes tool permissions and rejects invalid allow-lists without changing them", async () => {
    const { core, ledger, helper } = setup();
    const access = new Access(owner);
    await core.idle();

    await execute(core, access, { requestId: uuid(), command: { type: "ghost.update", ghostId: helper.id, tools: ["read", "bash"] } }, { publicOrigin: "http://x", documents: null });
    expect(ledger.ghost(helper.id).tools).toEqual(["read", "bash"]);

    await execute(core, access, { requestId: uuid(), command: { type: "ghost.update", ghostId: helper.id, tools: [] } }, { publicOrigin: "http://x", documents: null });
    expect(ledger.ghost(helper.id).tools).toEqual([]);
    // Unknown names and duplicates are refused by the shared rule even for non-HTTP callers.
    await expect(
      execute(core, access, { requestId: uuid(), command: { type: "ghost.update", ghostId: helper.id, tools: ["time_travel"] as never } }, { publicOrigin: "http://x", documents: null }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      execute(core, access, { requestId: uuid(), command: { type: "ghost.update", ghostId: helper.id, tools: ["read", "read"] as never } }, { publicOrigin: "http://x", documents: null }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(ledger.ghost(helper.id).tools).toEqual([]);
  });

  test("grant removal cancels only affected live or queued Works, never additions or rolled-back edits", async () => {
    const { core, ledger, engine, helper } = setup();
    updateGhost(core, helper.id, { tools: ["read", "bash"], hostExecution: true });
    const reader = core.works.createRoot({
      ghostId: helper.id, title: "Read", brief: "Read only", originConversationId: helper.directConversationId,
      execution: { kind: "container" }, toolScope: ["read"],
    });
    const shell = core.works.createRoot({
      ghostId: helper.id, title: "Shell", brief: "Run a command", originConversationId: helper.directConversationId,
      execution: { kind: "container" }, toolScope: ["bash"],
    });
    await core.idle();
    updateGhost(core, helper.id, { name: "Renamed", tools: ["read", "bash", "write"] });
    expect(ledger.work(shell.id).state).toBe("running");
    expect(() => ledger.tx(() => {
      updateGhost(core, helper.id, { tools: ["read"] });
      throw new Error("rollback revocation");
    })).toThrow("rollback revocation");
    expect(ledger.work(shell.id).state).toBe("running");
    const queued = core.works.createRoot({
      ghostId: helper.id, title: "Queued shell", brief: "Must never start", originConversationId: helper.directConversationId,
      execution: { kind: "container" }, toolScope: ["bash"],
    });
    updateGhost(core, helper.id, { tools: ["read", "write"], hostExecution: false });
    expect(ledger.work(shell.id).state).toBe("cancelled");
    expect(ledger.work(queued.id).state).toBe("cancelled");
    expect(ledger.work(reader.id).state).toBe("running");
    await core.idle();
    expect(engine.aborted).toContain(ledger.work(shell.id).conversationId!);
    expect(ledger.work(queued.id).conversationId).toBeNull();
    expect(engine.aborted).not.toContain(ledger.work(reader.id).conversationId!);
  });

  test("migration preserves established action authority while removing obsolete memory permissions", async () => {
    const path = join(tempDir(), "ghost-settings.db");
    const ghostId = historicalGhosts(path, 2, ["G", "H"])[0]!;

    const second = harness(path);
    for (const established of second.ledger.ghosts()) {
      expect(established.tools).toContain("read");
      expect(established.tools).toContain("bash");
      expect(established.tools).toContain("document_read");
      expect(established.tools.some((name: string) => name.startsWith("memory_"))).toBe(false);
      expect(established.tools).not.toContain("host_read");
    }
    // The migrated allow-list is an ordinary editable allow-list.
    const helper = second.ledger.ghosts().find((item) => item.name === "H")!;
    second.ledger.tx(() => second.ledger.putGhost({ ...helper, tools: ["read"], updatedAt: Date.now() }));
    expect(second.ledger.ghost(helper.id).tools).toEqual(["read"]);
    second.core.stop();
    second.ledger.close();
  });

  test("migrating a ledger from before fallbacks and skills gives established Ghosts none and keeps them listed", async () => {
    const path = join(tempDir(), "ghost-fallbacks.db");
    const ghostId = historicalGhosts(path, 3, ["G"])[0]!;

    const second = harness(path);
    expect(second.ledger.ghost(ghostId)).toMatchObject({ fallbacks: [], skills: [], deletedAt: null });
    second.core.stop();
    second.ledger.close();
  });

  test("a schema-4 success receipt prevents an old retry from overwriting newer settings", async () => {
    const path = join(tempDir(), "old-receipts.db");
    const requestId = uuid();
    const command = { type: "settings.update", defaultModel: { provider: "old", model: "old-model" } } as const;
    const newerModel = { provider: "new", model: "new-model" };
    const db = new Database(path);
    try {
      db.transaction(() => {
        for (const migration of MIGRATIONS.slice(0, 4)) db.exec(migration);
        db.exec("PRAGMA user_version = 4");
        db.query("INSERT INTO settings (key, value) VALUES ('defaultModel', ?)").run(JSON.stringify(newerModel));
        db.query("INSERT INTO requests (id, principal, digest, outcome, created_at) VALUES (?, 'owner', ?, '{}', ?)")
          .run(requestId, digestOf(command), Date.now());
      })();
    } finally {
      db.close();
    }
    const { core, ledger } = harness(path);
    try {
      await execute(core, new Access(owner), { requestId, command }, { publicOrigin: "http://localhost", documents: null });
      expect(ledger.settings().defaultModel).toEqual(newerModel);
    } finally {
      core.stop();
      ledger.close();
    }
  });

  test("unfinished request identity still rejects changed bytes after receipt retention expires", async () => {
    const { core, ledger } = harness();
    const requestId = uuid();
    const command = { type: "settings.update", defaultModel: null } as const;
    ledger.tx(() => ledger.claimRequest(requestId, "owner", digestOf(command)));
    ledger.pruneHistory(Date.now() + 31 * 24 * 60 * 60 * 1000);
    try {
      await expect(execute(core, new Access(owner), {
        requestId, command: { type: "settings.update", defaultModel: { provider: "changed", model: "changed" } },
      }, { publicOrigin: "http://localhost", documents: null })).rejects.toThrow("different command");
      expect(ledger.settings().defaultModel).toBeNull();
    } finally {
      core.stop();
      ledger.close();
    }
  });
});
