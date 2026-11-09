import { describe, expect, test } from "bun:test";
import { CommandError } from "../src/core/errors.ts";
import type { Submission } from "../src/core/ports.ts";
import { questionDefault } from "../src/core/decisions.ts";
import { FakeEngine, harness } from "./support.ts";

/** 2026-11-09: a root Work and a question no longer hold everything until the owner returns. */

function setup() {
  const h = harness();
  const ghost = h.core.createGhost({ name: "Primary", persona: "Helpful." });
  const helper = h.core.createGhost({ name: "Helper", persona: "Does parts." });
  return { ...h, ghost, helper };
}

async function completedRoot(s: ReturnType<typeof setup>, owner: boolean | undefined) {
  const acceptance = { criteria: "A note exists", checks: [], reviewer: null, ...(owner === undefined ? {} : { owner }) };
  const work = s.core.works.createRoot({ ghostId: s.helper.id, title: "Note", brief: "Write a note", acceptance, originConversationId: s.ghost.directConversationId });
  await s.core.idle();
  s.core.works.complete(work.id, { summary: "Wrote it.", artifacts: [] });
  await s.core.idle();
  return work;
}

describe("root Work acceptance", () => {
  test("owner: false is judged by a review conversation, and the owner only hears the outcome", async () => {
    const s = setup();
    const work = await completedRoot(s, false);
    expect(s.ledger.work(work.id).state).toBe("verifying");
    expect(s.ledger.pendingDecisions({ workId: work.id })).toHaveLength(0);
    const review = s.ledger.conversations({ kind: "review" }).find((conversation) => conversation.workId === work.id);
    expect(review).toBeDefined();
    // Never judged under the producer's identity.
    expect(review!.ghostId).not.toBe(s.helper.id);
    expect(s.engine.to(review!.id)).toHaveLength(1);

    s.core.works.applyVerdict(work.id, { outcome: "pass", source: "review", reasons: "Fine.", at: Date.now() });
    await s.core.idle();
    expect(s.ledger.work(work.id).state).toBe("done");
    expect(s.ledger.decisionsForWork(work.id)).toHaveLength(0);
    expect(s.ledger.notificationsForState().some((notification) => notification.workId === work.id && notification.kind === "work_done")).toBe(true);
  });

  test("absent or true keeps the owner's acceptance for rows and UI-created Work", async () => {
    for (const owner of [undefined, true]) {
      const s = setup();
      const work = await completedRoot(s, owner);
      expect(s.ledger.pendingDecisions({ workId: work.id }).map((decision) => decision.kind)).toEqual(["accept_result"]);
      expect(s.ledger.conversations({ kind: "review" })).toHaveLength(0);
    }
  });

  test("a review that cannot start falls back to the owner instead of staying in verifying", async () => {
    const s = setup();
    class NoReviewModel extends FakeEngine {
      override async submit(conversationId: string, submission: Submission) {
        if (submission.requestId.startsWith("review:")) throw new CommandError("unavailable", "no model for the reviewer");
        return super.submit(conversationId, submission);
      }
    }
    const engine = new NoReviewModel();
    s.core.attach(engine);
    const work = await completedRoot(s, false);
    const [decision] = s.ledger.pendingDecisions({ workId: work.id });
    expect(decision?.kind).toBe("accept_result");
    expect(decision?.detail).toContain("no model for the reviewer");
  });
});

describe("questions with a default", () => {
  test("an unanswered question settles to its default when the wait ends and the Work continues", async () => {
    const s = setup();
    const work = s.core.works.createRoot({ ghostId: s.ghost.id, title: "T", brief: "B", originConversationId: s.ghost.directConversationId });
    await s.core.idle();
    const conversationId = s.ledger.work(work.id).conversationId!;
    const asked = s.core.decisions.ask(conversationId, "Which format?", "PDF or HTML?", ["PDF", "HTML"], undefined, { answer: "PDF", waitMs: 60_000 });
    s.core.activity(conversationId, true, Date.now());
    s.core.activity(conversationId, false, Date.now());
    await s.core.idle();
    expect(s.ledger.work(work.id).state).toBe("waiting");

    s.core.decisions.expire(asked.createdAt + 59_000);
    await s.core.idle();
    expect(s.ledger.decision(asked.id).state).toBe("pending");

    s.core.decisions.expire(asked.createdAt + 60_000);
    s.core.decisions.expire(asked.createdAt + 61_000);
    await s.core.idle();
    const settled = s.ledger.decision(asked.id);
    expect(settled.state).toBe("answered");
    expect(settled.answer).toBe("PDF");
    expect(questionDefault(settled)?.defaulted).toBe(true);
    expect(s.ledger.work(work.id).state).toBe("running");
    const followUps = s.engine.to(conversationId).filter((submission) => submission.requestId === `decision:${asked.id}`);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]!.text).toContain("did not answer");
    expect(followUps[0]!.text).toContain("PDF");
  });

  test("the owner's own answer wins and is not overwritten by a later expiry", async () => {
    const s = setup();
    const asked = s.core.decisions.ask(s.ghost.directConversationId, "Which?", "Pick", [], undefined, { answer: "A", waitMs: 1_000 });
    await s.core.decisions.resolve(asked.id, { outcome: "answer", answer: "B" });
    s.core.decisions.expire(asked.createdAt + 10_000);
    await s.core.idle();
    const settled = s.ledger.decision(asked.id);
    expect(settled.answer).toBe("B");
    expect(questionDefault(settled)?.defaulted).toBe(false);
    expect(s.engine.to(s.ghost.directConversationId).find((submission) => submission.requestId === `decision:${asked.id}`)?.text).toContain("answered");
  });

  test("a question without a default waits for the owner", async () => {
    const s = setup();
    const asked = s.core.decisions.ask(s.ghost.directConversationId, "Which?", "Pick", []);
    s.core.decisions.expire(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await s.core.idle();
    expect(s.ledger.decision(asked.id).state).toBe("pending");
  });
});
