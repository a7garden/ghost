import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { GHOST_TOOLS, type Principal } from "@ghost/contract";
import { Access } from "../src/core/access.ts";
import { execute } from "../src/core/commands.ts";
import { Core } from "../src/core/core.ts";
import { KnownOutcome } from "../src/core/effects.ts";
import { snapshot } from "../src/core/state.ts";
import { MAX_REVISIONS } from "../src/core/works.ts";
import { FakeEngine, MemorySecrets, harness, noSandbox, tempDir } from "./support.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { Submission } from "../src/core/ports.ts";

const owner = { kind: "owner" } as const satisfies Principal;
const uuid = () => crypto.randomUUID();

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
    for (let round = 0; round <= MAX_REVISIONS; round++) {
      core.works.complete(work.id, { summary: `try ${round}`, artifacts: [] });
      await core.idle();
      const [decision] = ledger.pendingDecisions({ workId: work.id });
      await core.decisions.resolve(decision!.id, { outcome: "deny", answer: "Not yet." });
      await core.idle();
    }
    const failed = ledger.work(work.id);
    expect(failed.state).toBe("failed");
    expect(engine.to(failed.conversationId!).filter((submission) => submission.origin === "verdict")).toHaveLength(MAX_REVISIONS);
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
    expect(() => core.works.complete(work.id, { summary: "s", artifacts: [foreign] })).toThrow("was not published");
  });

  test("going idle without completing is nudged once, then fails", async () => {
    const { core, ledger, engine, ghost } = setup();
    const work = core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await core.idle();
    const conversationId = ledger.work(work.id).conversationId!;
    runSettles(core, conversationId);
    await core.idle();
    expect(ledger.work(work.id).state).toBe("running");
    expect(engine.to(conversationId).some((submission) => submission.requestId.includes(":nudge:"))).toBe(true);
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

  test("an effect interrupted by a restart blocks the Work until the owner reconciles it", async () => {
    const path = join(tempDir(), "ledger.db");
    const first = harness(path);
    const ghost = first.core.createGhost({ name: "G", persona: "" });
    const work = first.core.works.createRoot({ ghostId: ghost.id, title: "T", brief: "B", originConversationId: ghost.directConversationId });
    await first.core.idle();
    const conversationId = first.ledger.work(work.id).conversationId!;
    const start = first.core.effects.begin({ conversationId, callId: "c1", tool: "bash", input: { command: "deploy" }, summary: "deploy" });
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
    const access = new Access(ledger, owner);
    const requestId = uuid();
    const request = { requestId, command: { type: "work.create" as const, ghostId: ghost.id, title: "T", brief: "B" } };
    const first = await execute(core, access, request, { publicOrigin: "http://x", documents: null });
    const second = await execute(core, access, request, { publicOrigin: "http://x", documents: null });
    expect(second).toEqual(first);
    expect(ledger.worksForState()).toHaveLength(1);
    await expect(execute(core, access, { requestId, command: { ...request.command, title: "Other" } }, { publicOrigin: "http://x", documents: null })).rejects.toThrow("different command");
  });

  test("a device sees and acts only within its grants", async () => {
    const { core, ledger, ghost, helper } = setup();
    const visible = core.works.createRoot({ ghostId: ghost.id, title: "Mine", brief: "B", originConversationId: ghost.directConversationId });
    const hidden = core.works.createRoot({ ghostId: helper.id, title: "Theirs", brief: "B", originConversationId: helper.directConversationId });
    await core.idle();
    const device = new Access(ledger, { kind: "device", deviceId: "d1", name: "Phone", grants: [{ ghostId: ghost.id, conversationId: null }] });

    const state = snapshot(core, device);
    expect(state.ghosts.map((item) => item.id)).toEqual([ghost.id]);
    expect(state.works.map((item) => item.id)).toEqual([visible.id]);
    expect(state.settings.providers).toEqual([]);

    await expect(execute(core, device, { requestId: uuid(), command: { type: "work.cancel", workId: hidden.id } }, { publicOrigin: "http://x", documents: null })).rejects.toThrow("grants");
    await expect(execute(core, device, { requestId: uuid(), command: { type: "ghost.create", name: "X", persona: "" } }, { publicOrigin: "http://x", documents: null })).rejects.toThrow("owner");
    await execute(core, device, { requestId: uuid(), command: { type: "work.cancel", workId: visible.id } }, { publicOrigin: "http://x", documents: null });
    expect(ledger.work(visible.id).state).toBe("cancelled");
  });

  test("ghost.update changes tool permissions and rejects invalid allow-lists without changing them", async () => {
    const { core, ledger, helper } = setup();
    const access = new Access(ledger, owner);
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

  test("migrating a ledger from before tool allow-lists grants every established Ghost the full set", async () => {
    const path = join(tempDir(), "ghost-settings.db");
    const first = harness(path);
    const ghost = first.core.createGhost({ name: "G", persona: "" });
    first.core.createGhost({ name: "H", persona: "" });
    await first.core.idle();
    first.ledger.close();

    // Rewind to the schema that predates tool allow-lists.
    const db = new Database(path);
    db.exec("ALTER TABLE ghosts DROP COLUMN tools");
    db.exec("PRAGMA user_version = 2");
    db.close();

    const second = harness(path);
    expect(second.ledger.ghost(ghost.id).tools).toEqual([...GHOST_TOOLS]);
    expect(second.ledger.ghosts().every((item) => item.tools.length === GHOST_TOOLS.length)).toBe(true);
    // The migrated allow-list is an ordinary editable allow-list.
    const helper = second.ledger.ghosts().find((item) => item.name === "H")!;
    second.ledger.tx(() => second.ledger.putGhost({ ...helper, tools: ["read"], updatedAt: Date.now() }));
    expect(second.ledger.ghost(helper.id).tools).toEqual(["read"]);
    second.ledger.close();
  });
});
