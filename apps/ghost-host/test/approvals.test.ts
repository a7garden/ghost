import { describe, expect, test } from "bun:test";
import { reviewOf } from "@ghost/contract";
import { harness } from "./support.ts";

const MINUTE = 60_000;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A main Ghost and a teammate whose Work asks; the main is created first and so is the default. */
async function team() {
  const h = harness();
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

describe("approvals that do not wait forever", () => {
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

  test("destructive commands are never reviewed, delegated or auto-approved", async () => {
    const t = await team();
    const decision = t.command("삭제: 파일이 영구 제거될 수 있습니다.");
    await tick();
    expect(reviewOf(decision.proposal)).toBeNull();
    expect(t.engine.to(t.main.directConversationId).some((item) => item.requestId === `decision-review:${decision.id}`)).toBe(false);
    await expect(t.core.decisions.settleForOwner(t.main.id, decision.id, { outcome: "approve", note: "x" })).rejects.toThrow("only the owner");
    await t.core.decisions.settleExpired(decision.createdAt + 24 * 60 * MINUTE);
    expect(t.ledger.decision(decision.id).state).toBe("pending");
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
    expect(t.engine.to(t.main.directConversationId).some((item) => item.requestId === `decision-review:${later.id}`)).toBe(false);
    await expect(t.core.decisions.settleForOwner(t.main.id, later.id, { outcome: "answer", answer: "A", note: "x" })).rejects.toThrow("themselves");
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
