import { describe, expect, spyOn, test } from "bun:test";
import { reviewOf, type Ghost } from "@ghost/contract";
import { join } from "node:path";
import type { Core } from "../src/core/core.ts";
import { harness, tempDir } from "./support.ts";

const MINUTE = 60_000;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A main Ghost and a teammate whose Work asks; the main is created first and so is the default. */
async function team(path = ":memory:") {
  const h = harness(path);
  const main = h.core.createGhost({ name: "Main", persona: "" });
  const mate = h.core.createGhost({ name: "Mate", persona: "" });
  const work = h.core.works.createRoot({ ghostId: mate.id, title: "T", brief: "B", originConversationId: mate.directConversationId });
  await h.core.idle();
  const conversationId = h.ledger.work(work.id).conversationId!;
  const ask = (recommended?: string, id = "q1") =>
    h.core.decisions.ask(conversationId, "어느 쪽으로 할까요?", "", ["A", "B"], id, recommended ? { review: { recommend: "answer", answer: recommended, expiresAt: null } } : null);
  /** A Mac command approval; `risk` decides whether it is reversible. */
  const command = (risk: string, callId = "c1") => {
    h.core.effects.onApproved("host_command_propose", async () => "ran");
    const effect = h.core.effects.propose({ conversationId, callId, tool: "host_command_propose", input: { callId }, summary: "cmd", title: "명령 실행", detail: "", proposal: { risk, command: "x", input: { callId } } });
    return h.ledger.pendingDecisions({ effectId: effect.id })[0]!;
  };
  return { ...h, main, mate, work, conversationId, ask, command };
}

function newPage(t: { core: Core; mate: Ghost }, id = "new-page") {
  return t.core.ledger.tx(() => t.core.decisions.open({
    id, kind: "document_review", ghostId: t.mate.id, conversationId: t.mate.directConversationId,
    workId: null, effectId: null, title: "New page", detail: "A new page for the project.", options: [],
    proposal: { spaceId: "space", title: "Plan", body: "The plan.", pageId: null, expectedHash: null },
  }));
}

describe("approvals that do not wait forever", () => {
  test("restart repairs persisted new-page reviews and takes the recommendation after the original wait", async () => {
    const path = join(tempDir(), "ledger.db");
    const t = await team(path);
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() - 2 * 60 * MINUTE);
    const opened = newPage(t);
    clock.mockRestore();
    await tick();
    // A pending row written before review metadata existed survives an upgrade unchanged.
    const { review: _review, ...proposal } = opened.proposal!;
    t.ledger.tx(() => t.ledger.putDecision({ ...opened, proposal }));
    t.core.stop();
    await t.core.idle();
    t.ledger.close();

    const restarted = harness(path);
    let writes = 0;
    restarted.core.decisions.onDocumentApproved(async () => { writes++; return "Saved Plan."; });
    await restarted.core.decisions.recover();
    const settled = restarted.ledger.decision(opened.id);
    expect(restarted.engine.to(t.main.directConversationId).filter(item => item.requestId === `decision-review:${opened.id}`)).toHaveLength(1);
    expect(settled.state).toBe("approved");
    expect(reviewOf(settled.proposal)).toMatchObject({ recommend: "approve", resolvedBy: "timeout", expiresAt: settled.createdAt + 30 * MINUTE });
    expect(writes).toBe(1);
    expect(restarted.engine.to(t.mate.directConversationId).at(-1)?.text).toBe("Saved Plan.");
    await restarted.core.decisions.recover();
    expect(writes).toBe(1);
    restarted.core.stop();
    restarted.ledger.close();
  });

  test("a legacy page the owner denies while the pass is running stays denied", async () => {
    const t = await team();
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() - 2 * 60 * MINUTE);
    const first = newPage(t, "page-a");
    const second = newPage(t, "page-b");
    clock.mockRestore();
    await tick();
    for (const opened of [first, second]) {
      const { review: _review, ...proposal } = opened.proposal!;
      t.ledger.tx(() => t.ledger.putDecision({ ...opened, proposal }));
    }
    const written: string[] = [];
    t.core.decisions.onDocumentApproved(async (decision) => { written.push(decision.id); return "Saved."; });
    const submit = t.engine.submit.bind(t.engine);
    t.engine.submit = async (conversationId, submission) => {
      // The owner denies the second page while the pass awaits the first page's review wake.
      if (submission.requestId === `decision-review:${first.id}`) await t.core.decisions.resolve(second.id, { outcome: "deny" });
      return submit(conversationId, submission);
    };
    await t.core.decisions.settleExpired();
    await t.core.decisions.settleExpired();
    expect(t.ledger.decision(second.id).state).toBe("denied");
    expect(written).toEqual([first.id]);
    t.core.stop();
    t.ledger.close();
  });

  test("a missed main-review admission is retried after restart even while the main is busy", async () => {
    const path = join(tempDir(), "ledger.db");
    const t = await team(path);
    t.core.activity(t.main.directConversationId, true, Date.now());
    const submit = t.engine.submit.bind(t.engine);
    t.engine.submit = async (conversationId, submission) => {
      if (submission.requestId.startsWith("decision-review:")) throw new Error("admission unavailable");
      await submit(conversationId, submission);
    };
    const opened = newPage(t);
    await tick();
    expect(t.engine.to(t.main.directConversationId)).toHaveLength(0);
    t.core.stop();
    await t.core.idle();
    t.ledger.close();

    const restarted = harness(path);
    let writes = 0;
    restarted.core.decisions.onDocumentApproved(async () => { writes++; return "Saved."; });
    await restarted.core.decisions.recover();
    await restarted.core.decisions.recover();
    expect(restarted.engine.to(t.main.directConversationId).filter(item => item.requestId === `decision-review:${opened.id}`)).toHaveLength(1);
    expect(restarted.ledger.decision(opened.id).state).toBe("pending");
    await restarted.core.decisions.settleExpired(opened.createdAt + 31 * MINUTE);
    expect(restarted.ledger.decision(opened.id).state).toBe("approved");
    expect(writes).toBe(1);
    restarted.core.stop();
    restarted.ledger.close();
  });

  test("a failed review admission is retried by the live clock without waiting for another restart", async () => {
    const t = await team();
    const submit = t.engine.submit.bind(t.engine);
    let unavailable = true;
    t.engine.submit = async (conversationId, submission) => {
      if (unavailable && submission.requestId.startsWith("decision-review:")) throw new Error("admission unavailable");
      await submit(conversationId, submission);
    };
    const decision = t.ask("B");
    await tick();
    unavailable = false;
    await t.core.decisions.settleExpired(decision.createdAt + MINUTE);
    expect(t.engine.to(t.main.directConversationId).find(item => item.requestId === `decision-review:${decision.id}`)).toBeTruthy();
    expect(t.ledger.decision(decision.id).state).toBe("pending");
    await t.core.decisions.settleExpired(decision.createdAt + 31 * MINUTE);
    expect(t.ledger.decision(decision.id).answer).toBe("B");
  });

  test("recovery never turns legacy document edits or an owner-only Ghost's new pages into automatic writes", async () => {
    const t = await team();
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() - 2 * 60 * MINUTE);
    const edit = newPage(t, "existing-page");
    const optedOut = newPage(t, "owner-only");
    clock.mockRestore();
    await tick();
    t.ledger.tx(() => {
      t.ledger.putDecision({ ...edit, proposal: { ...edit.proposal, pageId: "existing", review: undefined } });
      t.ledger.putDecision({ ...optedOut, proposal: { ...optedOut.proposal, review: undefined } });
      t.ledger.putSetting("approvals", { autoMinutes: 30, delegate: "reversible", ghosts: { [t.mate.id]: "owner" } });
    });
    let writes = 0;
    t.core.decisions.onDocumentApproved(async () => { writes++; return "Saved."; });
    await t.core.decisions.recover();
    expect(t.ledger.decision(edit.id).state).toBe("pending");
    expect(reviewOf(t.ledger.decision(edit.id).proposal)).toBeNull();
    expect(t.ledger.decision(optedOut.id).state).toBe("pending");
    expect(reviewOf(t.ledger.decision(optedOut.id).proposal)?.expiresAt).toBeNull();
    expect(writes).toBe(0);
  });

  test("recovery preserves a recommended answer's original deadline instead of starting the wait over", async () => {
    const t = await team();
    const createdAt = Date.now() - 2 * 60 * MINUTE;
    const clock = spyOn(Date, "now").mockReturnValue(createdAt);
    const question = t.ask("A");
    clock.mockRestore();
    t.ledger.tx(() => t.ledger.putDecision({
      ...question, createdAt,
      proposal: { ...question.proposal, review: { ...reviewOf(question.proposal), expiresAt: createdAt + 30 * MINUTE } },
    }));
    await t.core.decisions.recover();
    expect(t.ledger.decision(question.id).state).toBe("answered");
    expect(t.ledger.decision(question.id).answer).toBe("A");
    expect(reviewOf(t.ledger.decision(question.id).proposal)?.expiresAt).toBe(createdAt + 30 * MINUTE);
  });

  test("a recommended answer goes ahead after the owner's wait, and the Ghost is told it was the Host", async () => {
    const t = await team();
    const decision = t.ask("A");
    const review = reviewOf(decision.proposal)!;
    expect(review.answer).toBe("A");
    expect(review.expiresAt).toBe(decision.createdAt + 30 * MINUTE);

    await t.core.decisions.settleExpired(decision.createdAt + 29 * MINUTE);
    expect(t.ledger.decision(decision.id).state).toBe("pending");
    await t.core.decisions.settleExpired(decision.createdAt + 31 * MINUTE);
    const settled = t.ledger.decision(decision.id);
    expect(settled.state).toBe("answered");
    expect(settled.answer).toBe("A");
    expect(reviewOf(settled.proposal)?.resolvedBy).toBe("timeout");
    expect(t.engine.to(t.conversationId).at(-1)?.text).toContain("did not answer in time");
  });

  test("a question without a recommendation always waits for the owner", async () => {
    const t = await team();
    const decision = t.ask();
    expect(reviewOf(decision.proposal)).toBeNull();
    await t.core.decisions.settleExpired(decision.createdAt + 24 * 60 * MINUTE);
    expect(t.ledger.decision(decision.id).state).toBe("pending");
    expect(() => t.core.decisions.resolveState(decision.id, { outcome: "answer", answer: "A" }, "timeout")).toThrow("only the owner");
  });

  test("the main Ghost is asked first and may settle a teammate's reversible request, telling the owner why", async () => {
    const t = await team();
    const decision = t.command("설정 파일을 다시 읽습니다");
    await tick();
    const wake = t.engine.to(t.main.directConversationId).find((item) => item.requestId === `decision-review:${decision.id}`);
    expect(wake?.origin).toBe("schedule");
    expect(wake?.text).toContain("decision_settle");

    await t.core.decisions.settleForOwner(t.main.id, decision.id, { outcome: "approve", note: "설정만 다시 읽는 일이라 승인했습니다." });
    const settled = t.ledger.decision(decision.id);
    expect(settled.state).toBe("approved");
    expect(reviewOf(settled.proposal)?.resolvedBy).toBe("main");
    expect(reviewOf(settled.proposal)?.mainNote).toContain("승인했습니다");
    expect(t.ledger.notification(`decision-main:${decision.id}`)).toBeTruthy();
  });

  test("the main can leave its view on the card without deciding", async () => {
    const t = await team();
    const decision = t.ask("B");
    expect(await t.core.decisions.settleForOwner(t.main.id, decision.id, { outcome: "leave", note: "B 가 낫지만 직접 보시는 게 좋겠습니다." })).toContain("Left");
    const left = t.ledger.decision(decision.id);
    expect(left.state).toBe("pending");
    expect(reviewOf(left.proposal)?.mainNote).toContain("B 가 낫지만");
  });

  test("destructive commands are looked over by the main but never settled by it or by the clock", async () => {
    const t = await team();
    const decision = t.command("삭제: 파일이 영구 제거될 수 있습니다.");
    await tick();
    expect(reviewOf(decision.proposal)).toBeNull();
    const wake = t.engine.to(t.main.directConversationId).find((item) => item.requestId === `decision-review:${decision.id}`);
    expect(wake?.text).toContain("only the owner can make");
    await expect(t.core.decisions.settleForOwner(t.main.id, decision.id, { outcome: "approve", note: "x" })).rejects.toThrow("only the owner");

    await t.core.decisions.settleForOwner(t.main.id, decision.id, { outcome: "leave", note: "지우는 폴더가 빌드 결과물뿐입니다. 승인해도 됩니다." });
    const noted = t.ledger.decision(decision.id);
    expect(reviewOf(noted.proposal)).toEqual({ expiresAt: null, mainNote: "지우는 폴더가 빌드 결과물뿐입니다. 승인해도 됩니다." });
    await t.core.decisions.settleExpired(decision.createdAt + 24 * 60 * MINUTE);
    expect(t.ledger.decision(decision.id).state).toBe("pending");
    // The owner still approves it, and the note never changes what runs.
    await t.core.decisions.resolve(decision.id, { outcome: "approve" });
    expect(t.ledger.effect(decision.effectId!).state).toBe("done");
  });

  test("the main cannot settle its own requests", async () => {
    const t = await team();
    const direct = t.core.decisions.ask(t.main.directConversationId, "제 질문", "", ["A"], "own", { review: { recommend: "answer", answer: "A", expiresAt: null } });
    await expect(t.core.decisions.settleForOwner(t.main.id, direct.id, { outcome: "answer", answer: "A", note: "x" })).rejects.toThrow("own requests");
  });

  test("a Ghost set to owner-only keeps every decision with the owner, even ones already waiting", async () => {
    const t = await team();
    const waiting = t.ask("A", "before");
    t.ledger.putSetting("approvals", { autoMinutes: 30, delegate: "reversible", ghosts: { [t.mate.id]: "owner" } });
    await t.core.decisions.settleExpired(waiting.createdAt + 31 * MINUTE);
    expect(t.ledger.decision(waiting.id).state).toBe("pending");

    const later = t.ask("A", "after");
    await tick();
    expect(reviewOf(later.proposal)?.expiresAt).toBeNull();
    // The main still looks it over, but may only leave its view.
    expect(t.engine.to(t.main.directConversationId).find((item) => item.requestId === `decision-review:${later.id}`)?.text).toContain("only the owner can make");
    await expect(t.core.decisions.settleForOwner(t.main.id, later.id, { outcome: "answer", answer: "A", note: "x" })).rejects.toThrow("only the owner");
  });

  test("turning automation off keeps the recommendation but never settles", async () => {
    const t = await team();
    t.ledger.putSetting("approvals", { autoMinutes: 0, delegate: "none" });
    const decision = t.ask("A");
    await tick();
    expect(reviewOf(decision.proposal)).toMatchObject({ answer: "A", expiresAt: null });
    expect(t.engine.to(t.main.directConversationId).some((item) => item.requestId === `decision-review:${decision.id}`)).toBe(false);
  });
});

describe("handing a decision to the main Ghost", () => {
  const handOver = (t: Awaited<ReturnType<typeof team>>, id: string) => t.ledger.tx(() => t.core.decisions.delegate(id));

  test("the owner hands a reversible question over; the main is woken once and settles it for them", async () => {
    const t = await team();
    // Owner-only for this Ghost: the main could only comment, until the owner hands this one over.
    t.ledger.putSetting("approvals", { autoMinutes: 30, delegate: "reversible", ghosts: { [t.mate.id]: "owner" } });
    const decision = t.ask("A");
    handOver(t, decision.id);
    handOver(t, decision.id);
    await tick();
    const wakes = t.engine.to(t.main.directConversationId).filter((item) => item.requestId === `decision-delegate:${decision.id}`);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.text).toContain("handed");
    expect(typeof reviewOf(t.ledger.decision(decision.id).proposal)?.delegatedAt).toBe("number");

    await t.core.decisions.settleForOwner(t.main.id, decision.id, { outcome: "answer", answer: "A", note: "추천대로 A 로 답했습니다." });
    const settled = t.ledger.decision(decision.id);
    expect(settled.state).toBe("answered");
    expect(reviewOf(settled.proposal)?.resolvedBy).toBe("main");
  });

  test("a main that cannot judge gives it back to the owner's queue with its note", async () => {
    const t = await team();
    const decision = t.ask("B");
    handOver(t, decision.id);
    await t.core.decisions.settleForOwner(t.main.id, decision.id, { outcome: "leave", note: "직접 보셔야 합니다." });
    const back = reviewOf(t.ledger.decision(decision.id).proposal);
    expect(back?.delegatedAt).toBeUndefined();
    expect(back?.mainNote).toBe("직접 보셔야 합니다.");
  });

  test("what only the owner may settle cannot be handed over", async () => {
    const t = await team();
    const destructive = t.command("삭제: 파일이 영구 제거될 수 있습니다.");
    expect(() => handOver(t, destructive.id)).toThrow("reversible");
    const unrecommended = t.ask(undefined, "free");
    expect(() => handOver(t, unrecommended.id)).toThrow("reversible");
    const own = t.core.decisions.ask(t.main.directConversationId, "제 질문", "", ["A"], "own", { review: { recommend: "answer", answer: "A", expiresAt: null } });
    expect(() => handOver(t, own.id)).toThrow("own requests");
    t.ledger.putSetting("approvals", { autoMinutes: 30, delegate: "none" });
    const off = t.ask("A", "off");
    expect(() => handOver(t, off.id)).toThrow("turned off");
  });

  test("a lost hand-over wake is retried by the clock with the same request id", async () => {
    const t = await team();
    const submit = t.engine.submit.bind(t.engine);
    let fail = true;
    t.engine.submit = async (conversationId, submission) => {
      if (fail && submission.requestId.startsWith("decision-delegate:")) throw new Error("admission unavailable");
      return submit(conversationId, submission);
    };
    const decision = t.ask("A");
    handOver(t, decision.id);
    await tick();
    fail = false;
    await t.core.decisions.settleExpired();
    expect(t.engine.to(t.main.directConversationId).filter((item) => item.requestId === `decision-delegate:${decision.id}`)).toHaveLength(1);
  });
});
