import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check as checkValue } from "typebox/value";
import type { Context } from "@earendil-works/chord";
import type { Extension, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { Check, GhostTool, Work } from "@ghost/contract";
import { idFor } from "../src/core/ids.ts";
import { conflict } from "../src/core/errors.ts";
import type { Core } from "../src/core/core.ts";
import type { ArtifactStore, Submission } from "../src/core/ports.ts";
import type { SandboxEnvFactory } from "../src/integrations/ports.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { MIGRATIONS } from "../src/ledger/schema.ts";
import { createReviewTools } from "../src/tools/review.ts";
import { createWorkTools } from "../src/tools/work.ts";
import { FakeEngine, harness } from "./support.ts";

interface Harness {
  core: Core;
  ledger: Ledger;
  engine: FakeEngine;
  artifacts: ArtifactStore;
}
const opened: Harness[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) {
    await h.core.idle();
    h.core.stop();
    h.ledger.close();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sandbox: SandboxEnvFactory = {
  envFor: async () => { throw new Error("these tests do not execute sandbox commands"); },
  workspacePath: () => "",
  stageInputs: async () => {},
  release: async () => {},
};
function tool(extension: Extension, name: string): ToolRegistration {
  const found = extension.tools?.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}
const content = (result: ToolExecutionResult) => (result.content ?? []).map((block) => block.type === "text" ? block.text : "").join("");
async function call(s: Harness, work: Work, name: string, args: unknown, callId = name) {
  const conversation = s.ledger.conversation(s.ledger.work(work.id).conversationId!);
  s.ledger.setPiConversationId(conversation.id, `pi-${conversation.id}`);
  const api = { conversationId: `pi-${conversation.id}`, taskId: `task:${callId}`, callId: callId, output: () => {} } as unknown as ToolExecutionApi;
  return tool(createWorkTools(s.core, sandbox), name).execute(args as never, api, {} as Context);
}
async function setup(path = ":memory:", tools?: GhostTool[]) {
  const s = harness(path);
  opened.push(s);
  const parentGhost = s.core.createGhost({ name: "Delegator", persona: "Lead", tools });
  const childGhost = s.core.createGhost({ name: "Child", persona: "Implement", tools });
  const root = s.core.works.createRoot({ ghostId: parentGhost.id, title: "Parent", brief: "B", originConversationId: parentGhost.directConversationId });
  await s.core.idle();
  const child = s.core.works.delegate(root.id, { ghostId: childGhost.id, title: "Part", brief: "B" });
  await s.core.idle();
  return { ...s, parentGhost, childGhost, parent: s.ledger.work(root.id), child: s.ledger.work(child.id) };
}

// A fake engine is the same idempotent Pi boundary as support.ts, with an injected
// crash after admission but before the ledger delivery marker can commit.
class InterruptedSubmission extends FakeEngine {
  crashOn: string | null = null;
  override async submit(conversationId: string, submission: Submission) {
    await super.submit(conversationId, submission);
    if (submission.requestId === this.crashOn) throw new Error("simulated interruption after Pi admission");
  }
}

describe("parent-first questions", () => {
  test("child asks, waits without nudges, parent wakes and answers, child resumes", async () => {
    // Intrinsic lifecycle tools work without optional tool grants at Work admission.
    const s = await setup(":memory:", []);
    s.core.works.onIdle(s.parent.id);
    await s.core.idle();
    expect(s.ledger.work(s.parent.id).state).toBe("waiting");
    const before = s.ledger.seq();
    const asked = await call(s, s.child, "ask_parent", { question: "Which format?" }, "q1");
    expect(asked.isError).toBeFalsy();
    const questionId = idFor(s.child.conversationId!, "q1");
    expect(s.ledger.findWorkQuestion(questionId)?.state).toBe("pending");
    expect(s.ledger.seq()).toBeGreaterThan(before);
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    expect(s.ledger.work(s.child.id).state).toBe("waiting");
    expect(s.ledger.idleNudges(s.child.id)).toBe(0);
    expect(s.ledger.work(s.parent.id).state).toBe("running");
    const submission = s.engine.to(s.parent.conversationId!).find((entry) => entry.requestId === `work-question:${questionId}:question`)!;
    expect(submission.text).toContain(s.child.id);
    expect(submission.text).toContain(questionId);
    expect(submission.text).toContain("Which format?");
    const replay = await call(s, s.child, "ask_parent", { question: "Which format?" }, "q1");
    expect(replay.isError).toBeFalsy();
    expect(s.ledger.workQuestions(s.child.id)).toHaveLength(1);
    const answered = await call(s, s.parent, "answer_question", { question_id: questionId, answer: "Use JSON." });
    expect(answered.isError).toBeFalsy();
    await s.core.idle();
    const question = s.ledger.findWorkQuestion(questionId)!;
    expect(question.state).toBe("answered");
    expect(question.answer).toBe("Use JSON.");
    expect(question.submittedAt).not.toBeNull();
    expect(question.answerSubmittedAt).not.toBeNull();
    expect(s.ledger.work(s.child.id).state).toBe("running");
    expect(s.engine.to(s.child.conversationId!).find((entry) => entry.requestId === `work-question:${questionId}:answer`)?.text).toContain("Use JSON.");
  });

  test("root, direct, non-parent, answered and cancelled calls are refused", async () => {
    const s = await setup();
    const rootAsk = await call(s, s.parent, "ask_parent", { question: "Q" });
    expect(rootAsk.isError).toBe(true);
    expect(content(rootAsk)).toContain("root Works use ask_owner");
    const q = s.core.works.askParent(s.child.id, "Q", "q");
    const other = s.core.works.createRoot({ ghostId: s.parentGhost.id, title: "Other", brief: "B", originConversationId: s.parentGhost.directConversationId });
    await s.core.idle();
    const foreign = await call(s, other, "answer_question", { question_id: q.id, answer: "No" });
    expect(foreign.isError).toBe(true);
    expect(content(foreign)).toContain("not addressed to this Work");
    s.core.works.answerQuestion(s.parent.id, q.id, "A");
    expect(() => s.core.works.answerQuestion(s.parent.id, q.id, "Again")).toThrow("question is answered");
    const cancelled = s.core.works.askParent(s.child.id, "Another?", "cancelled-q");
    s.core.works.cancel(s.child.id);
    expect(s.ledger.findWorkQuestion(cancelled.id)?.state).toBe("cancelled");
    expect(() => s.core.works.answerQuestion(s.parent.id, cancelled.id, "No")).toThrow("question is cancelled");
    const direct = s.ledger.conversation(s.parentGhost.directConversationId);
    s.ledger.setPiConversationId(direct.id, "pi-direct");
    const refused = await tool(createWorkTools(s.core, sandbox), "ask_parent").execute({ question: "Q" }, { conversationId: "pi-direct" } as unknown as ToolExecutionApi, {} as Context);
    expect(refused.isError).toBe(true);
    expect(content(refused)).toContain("only a work conversation");
  });

  test("pending questions prevent completion and idle failure, and a due date never fails a waiting Work", async () => {
    const s = await setup();
    s.core.works.askParent(s.child.id, "Q", "q");
    expect(() => s.core.works.complete(s.child.id, { summary: "done", artifacts: [] })).toThrow("question to the parent is pending");
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    s.core.works.kick(s.child.id);
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    expect(s.ledger.work(s.child.id).state).toBe("waiting");
    expect(s.ledger.idleNudges(s.child.id)).toBe(0);
    // R3: the owner's due date no longer fails a Work that is waiting on an answer.
    s.core.works.update(s.child.id, { deadlineAt: 1 });
    s.core.works.expire(Date.now());
    await s.core.idle();
    expect(s.ledger.work(s.child.id).state).toBe("waiting");
    expect(s.ledger.findWorkQuestion("q")?.state).toBe("pending");
    // The owner's due date still fails a Work that is working.
    s.core.works.answerQuestion(s.parent.id, "q", "A");
    await s.core.idle();
    expect(s.ledger.work(s.child.id).state).toBe("running");
    s.core.works.expire(Date.now());
    await s.core.idle();
    expect(s.ledger.work(s.child.id).state).toBe("failed");
    expect(s.ledger.findWorkQuestion("q")?.state).toBe("answered");
  });

  test("restart retries questions and answers admitted before delivery markers exactly once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ghost-collab-restart-"));
    roots.push(directory);
    const path = join(directory, "ledger.db");
    const s = await setup(path);
    const engine = new InterruptedSubmission();
    s.core.attach(engine);
    engine.crashOn = "work-question:q:question";
    s.core.works.askParent(s.child.id, "Q", "q");
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    expect(s.ledger.findWorkQuestion("q")?.submittedAt).toBeNull();
    s.core.stop();
    s.ledger.close();
    opened.splice(opened.findIndex((entry) => entry.core === s.core), 1);
    const recovered = harness(path);
    opened.push(recovered);
    recovered.core.attach(engine);
    engine.crashOn = null;
    await recovered.core.start();
    await recovered.core.idle();
    expect(engine.to(s.parent.conversationId!).filter((entry) => entry.requestId === "work-question:q:question")).toHaveLength(1);
    expect(recovered.ledger.findWorkQuestion("q")?.submittedAt).not.toBeNull();
    engine.crashOn = "work-question:q:answer";
    recovered.core.works.answerQuestion(s.parent.id, "q", "A");
    await recovered.core.idle();
    expect(recovered.ledger.findWorkQuestion("q")?.answerSubmittedAt).toBeNull();
    recovered.core.stop();
    recovered.ledger.close();
    opened.splice(opened.indexOf(recovered), 1);
    const again = harness(path);
    opened.push(again);
    again.core.attach(engine);
    engine.crashOn = null;
    await again.core.start();
    await again.core.idle();
    again.core.works.recover();
    await again.core.idle();
    expect(again.ledger.findWorkQuestion("q")?.answerSubmittedAt).not.toBeNull();
    expect(again.ledger.work(s.child.id).state).toBe("running");
    expect(engine.to(s.child.conversationId!).filter((entry) => entry.requestId === "work-question:q:answer")).toHaveLength(1);
  });

  test("idle parents get two counted reminders, then release unanswered children instead of hanging", async () => {
    const s = await setup();
    s.core.works.askParent(s.child.id, "Need a format", "idle-q");
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    s.core.works.onIdle(s.parent.id);
    await s.core.idle();
    expect(s.ledger.work(s.parent.id).state).toBe("running");
    expect(s.ledger.findWorkQuestion("idle-q")?.nudgeCount).toBe(1);
    const reminder = s.engine.to(s.parent.conversationId!).find((entry) => entry.requestId === `work:${s.parent.id}:qnudge:1`);
    s.core.works.onIdle(s.parent.id);
    await s.core.idle();
    expect(s.ledger.findWorkQuestion("idle-q")?.nudgeCount).toBe(2);
    expect(s.engine.to(s.parent.conversationId!).some((entry) => entry.requestId === `work:${s.parent.id}:qnudge:2`)).toBe(true);
    s.core.works.onIdle(s.parent.id);
    await s.core.idle();
    expect(s.ledger.findWorkQuestion("idle-q")?.state).toBe("cancelled");
    expect(s.ledger.work(s.child.id).state).toBe("running");
    const notice = s.engine.to(s.child.conversationId!).find((entry) => entry.requestId === "work-question:idle-q:cancelled");
    expect(notice?.text).toContain("best judgment");
    // Later question batches must not collide with the first reminder's request id.
    s.core.works.askParent(s.child.id, "Another question", "idle-q2");
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    s.core.works.onIdle(s.parent.id);
    await s.core.idle();
    expect(s.engine.to(s.parent.conversationId!).find((entry) => entry.requestId === `work:${s.parent.id}:qnudge:2`)).toBeDefined();
  });

  test("an owner escalation keeps the child question pending rather than exhausting reminders", async () => {
    const s = await setup();
    s.core.works.askParent(s.child.id, "Owner-only choice", "escalated");
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    s.core.decisions.ask(s.parent.conversationId!, "Choose", "Owner-only choice", [], "owner-choice");
    s.core.works.onIdle(s.parent.id);
    await s.core.idle();
    expect(s.ledger.work(s.parent.id).state).toBe("waiting");
    expect(s.ledger.findWorkQuestion("escalated")?.state).toBe("pending");
    expect(s.ledger.findWorkQuestion("escalated")?.nudgeCount).toBe(0);
    expect(s.engine.to(s.parent.conversationId!).some((entry) => entry.requestId.includes(":qnudge:"))).toBe(false);
  });

  test("refused parent submissions and missing parent conversations cancel and notify the child", async () => {
    for (const failure of ["refusal", "missing-conversation"]) {
      const s = await setup();
      if (failure === "refusal") {
        const submit = s.engine.submit.bind(s.engine);
        s.engine.submit = async (conversationId, submission) => {
          if (submission.requestId === "work-question:unreachable:question") throw conflict("no model credential");
          await submit(conversationId, submission);
        };
      } else {
        s.ledger.tx(() => s.ledger.putWork({ ...s.parent, conversationId: null }));
      }
      s.core.works.askParent(s.child.id, "Q", "unreachable");
      s.core.works.onIdle(s.child.id);
      await s.core.idle();
      expect(s.ledger.findWorkQuestion("unreachable")?.state).toBe("cancelled");
      expect(s.ledger.findWorkQuestion("unreachable")?.cancellationSubmittedAt).not.toBeNull();
      expect(s.ledger.work(s.child.id).state).toBe("running");
      const notice = s.engine.to(s.child.conversationId!).find((entry) => entry.requestId === "work-question:unreachable:cancelled");
      expect(notice?.text).toContain("parent could not be reached");
      expect(s.ledger.workQuestionsAwaitingSubmission()).toHaveLength(0);
    }
  });

  test("a refused parent reminder releases its children", async () => {
    const s = await setup();
    s.core.works.askParent(s.child.id, "Q", "reminder-refused");
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    const submit = s.engine.submit.bind(s.engine);
    s.engine.submit = async (conversationId, submission) => {
      if (submission.requestId.includes(":qnudge:")) throw conflict("model unavailable");
      await submit(conversationId, submission);
    };
    s.core.works.onIdle(s.parent.id);
    await s.core.idle();
    expect(s.ledger.findWorkQuestion("reminder-refused")?.state).toBe("cancelled");
    expect(s.ledger.work(s.child.id).state).toBe("running");
  });

  test("refused answers remain recoverable, then deliver once when the child is reachable", async () => {
    const s = await setup();
    s.core.works.askParent(s.child.id, "Q", "answer-retry");
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    const submit = s.engine.submit.bind(s.engine);
    s.engine.submit = async (conversationId, submission) => {
      if (submission.requestId === "work-question:answer-retry:answer") throw conflict("no child credential");
      await submit(conversationId, submission);
    };
    s.core.works.answerQuestion(s.parent.id, "answer-retry", "A");
    await s.core.idle();
    expect(s.ledger.findWorkQuestion("answer-retry")?.state).toBe("answered");
    expect(s.ledger.findWorkQuestion("answer-retry")?.answerSubmittedAt).toBeNull();
    expect(s.ledger.workQuestionsAwaitingSubmission().map((row) => row.id)).toEqual(["answer-retry"]);
    s.engine.submit = submit;
    s.core.works.recover();
    await s.core.idle();
    s.core.works.recover();
    await s.core.idle();
    expect(s.ledger.findWorkQuestion("answer-retry")?.answerSubmittedAt).not.toBeNull();
    expect(s.engine.to(s.child.conversationId!).filter((entry) => entry.requestId === "work-question:answer-retry:answer")).toHaveLength(1);
    expect(s.ledger.work(s.child.id).state).toBe("running");
  });

  test("cancelling or recovering a settled child closes answered-but-undelivered rows", async () => {
    for (const settle of ["cancel", "recover-terminal"]) {
      const s = await setup();
      s.core.works.askParent(s.child.id, "Q", "terminal-answer");
      await s.core.idle();
      const submit = s.engine.submit.bind(s.engine);
      s.engine.submit = async (conversationId, submission) => {
        if (submission.requestId === "work-question:terminal-answer:answer") throw conflict("no child credential");
        await submit(conversationId, submission);
      };
      s.core.works.answerQuestion(s.parent.id, "terminal-answer", "A");
      await s.core.idle();
      expect(s.ledger.workQuestionsAwaitingSubmission()).toHaveLength(1);
      if (settle === "cancel") s.core.works.cancel(s.child.id);
      else s.ledger.tx(() => s.ledger.putWork({ ...s.ledger.work(s.child.id), state: "failed", endedAt: Date.now() }));
      s.core.works.recover();
      await s.core.idle();
      expect(s.ledger.findWorkQuestion("terminal-answer")?.state).toBe("cancelled");
      expect(s.ledger.workQuestionsAwaitingSubmission()).toHaveLength(0);
    }
  });

  test("cancelled-question notices survive interruption and recover with the same request id", async () => {
    const s = await setup();
    const engine = new InterruptedSubmission();
    s.core.attach(engine);
    s.core.works.askParent(s.child.id, "Q", "cancel-notice");
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    engine.crashOn = "work-question:cancel-notice:cancelled";
    s.core.works.onIdle(s.parent.id);
    await s.core.idle();
    s.core.works.onIdle(s.parent.id);
    await s.core.idle();
    // Two reminders are allowed now, so the third idle is the one that cancels.
    s.core.works.onIdle(s.parent.id);
    await s.core.idle();
    expect(s.ledger.findWorkQuestion("cancel-notice")?.cancellationSubmittedAt).toBeNull();
    expect(s.ledger.workQuestionsAwaitingSubmission().map((row) => row.id)).toEqual(["cancel-notice"]);
    engine.crashOn = null;
    s.core.works.recover();
    await s.core.idle();
    expect(s.ledger.findWorkQuestion("cancel-notice")?.cancellationSubmittedAt).not.toBeNull();
    expect(engine.to(s.child.conversationId!).filter((entry) => entry.requestId === "work-question:cancel-notice:cancelled")).toHaveLength(1);
  });

  test("questions have a lifetime budget and status shows only eight bounded entries", async () => {
    const s = await setup();
    for (let i = 0; i < 16; i++) {
      s.core.works.askParent(s.child.id, `Question ${i}: ${"x".repeat(8000)}`, `cap-${String(i).padStart(2, "0")}`);
    }
    await s.core.idle();
    const refused = await call(s, s.child, "ask_parent", { question: "Seventeenth" }, "over-limit");
    expect(refused.isError).toBe(true);
    expect(content(refused)).toContain("at most 16 questions per Work");
    expect(s.core.works.askParent(s.child.id, "Replay", "cap-00").id).toBe("cap-00");
    s.core.works.answerQuestion(s.parent.id, "cap-15", "ANSWER ".repeat(1000));
    await s.core.idle();
    const ownStatus = content(await call(s, s.child, "work_status", {}));
    expect(ownStatus).toContain("latest 8 of 16");
    expect(ownStatus.match(/^- cap-/gm)).toHaveLength(8);
    expect(ownStatus).not.toContain("- cap-00");
    expect(ownStatus).toContain("- cap-15");
    expect(ownStatus).toContain("[truncated]");
    expect(ownStatus).not.toContain("x".repeat(513));
    expect(ownStatus).not.toContain("ANSWER ".repeat(100));
    const parentStatus = content(await call(s, s.parent, "work_status", {}));
    expect(parentStatus).toContain("latest 8 of 15");
    expect(parentStatus.match(/^- cap-/gm)).toHaveLength(8);
    expect(parentStatus).not.toContain("- cap-00");
    expect(parentStatus).not.toContain("x".repeat(513));
    // Settled rows still consume the lifetime budget.
    for (const question of s.ledger.workQuestions(s.child.id).filter((row) => row.state === "pending")) {
      s.core.works.answerQuestion(s.parent.id, question.id, "A");
    }
    await s.core.idle();
    expect(() => s.core.works.askParent(s.child.id, "Still over budget", "after-answers")).toThrow("at most 16");
  });
});

/** Setup plus a second delegated sibling Work on its own Ghost, for peer-question scenarios. */
async function setupWithSibling(tools?: GhostTool[]) {
  const s = await setup(":memory:", tools);
  const peerGhost = s.core.createGhost({ name: "Peer", persona: "P", tools });
  const sibling = s.core.works.delegate(s.parent.id, { ghostId: peerGhost.id, title: "Sibling", brief: "B" });
  await s.core.idle();
  return { ...s, peerGhost, sibling: s.ledger.work(sibling.id) };
}

/** Hold a single conversation opening at the asynchronous admission boundary. */
function holdOpen(core: Core, conversationId: string) {
  const open = core.openConversation.bind(core);
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: opening, resolve: entered } = Promise.withResolvers<void>();
  core.openConversation = async (id) => {
    if (id === conversationId) {
      core.openConversation = open;
      entered();
      await gate;
    }
    return open(id);
  };
  return { opening, release };
}

async function setupActivityPeers() {
  const s = harness();
  opened.push(s);
  const tools: GhostTool[] = ["delegate"];
  const parentGhost = s.core.createGhost({ name: "Activity lead", persona: "Lead", tools, model: { provider: "test", model: "test-model" } });
  const childGhost = s.core.createGhost({ name: "Activity child", persona: "Child", tools });
  const peerGhost = s.core.createGhost({ name: "Activity peer", persona: "Peer", tools });
  const activity = s.core.activities.create({
    ghostId: parentGhost.id, name: "Bound collaboration", prompt: "Coordinate only this task.", acceptanceCriteria: "Verify the result.",
    execution: { kind: "container" }, tools, source: { kind: "schedule", spec: { kind: "at", at: Date.now() + 60_000 } },
    policy: { maxRunsPerDay: 2, maxConcurrent: 1, runTimeoutSeconds: 300, allowSelfCheck: false, minCheckSeconds: 60, externalActions: "deny", delivery: "changes" },
  });
  const admitted = await s.core.activities.run(activity.id);
  const run = s.ledger.findActivityRun(admitted.runIds[0]!)!;
  await s.core.idle();
  const child = s.core.works.delegate(run.workId!, { ghostId: childGhost.id, title: "Child", brief: "B" });
  const sibling = s.core.works.delegate(run.workId!, { ghostId: peerGhost.id, title: "Peer", brief: "B" });
  await s.core.idle();
  return { ...s, activity, parent: s.ledger.work(run.workId!), child: s.ledger.work(child.id), sibling: s.ledger.work(sibling.id) };
}

describe("peer questions", () => {
  test("a sibling asks another sibling, is answered exactly, and resumes without involving the parent", async () => {
    const s = await setupWithSibling([]);
    const rootRevision = s.ledger.work(s.parent.id).revision;
    const asked = await call(s, s.child, "ask_peer", { work_id: s.sibling.id, question: "Which key does your section use?" }, "peer-q");
    expect(asked.isError).toBeFalsy();
    const questionId = idFor(s.child.conversationId!, "peer-q");
    expect(s.ledger.findWorkQuestion(questionId)).toMatchObject({ recipientWorkId: s.sibling.id, state: "pending" });
    // A repeated call id finds its question instead of asking again.
    const replay = await call(s, s.child, "ask_peer", { work_id: s.sibling.id, question: "Which key?" }, "peer-q");
    expect(replay.isError).toBeFalsy();
    expect(s.ledger.workQuestions(s.child.id)).toHaveLength(1);
    const submission = s.engine.to(s.sibling.conversationId!).find((entry) => entry.requestId === `work-question:${questionId}:question`)!;
    expect(submission.text).toContain(s.child.id);
    expect(submission.text).toContain("Which key does your section use?");
    expect(s.engine.to(s.parent.conversationId!).some((entry) => entry.requestId.startsWith("work-question:"))).toBe(false);
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    expect(s.ledger.work(s.child.id).state).toBe("waiting");
    const answered = await call(s, s.sibling, "answer_question", { question_id: questionId, answer: "Use sortKey." });
    expect(answered.isError).toBeFalsy();
    await s.core.idle();
    expect(s.ledger.findWorkQuestion(questionId)).toMatchObject({ state: "answered", answer: "Use sortKey.", answerSubmittedAt: expect.any(Number) });
    expect(s.ledger.work(s.child.id).state).toBe("running");
    expect(s.engine.to(s.child.conversationId!).find((entry) => entry.requestId === `work-question:${questionId}:answer`)?.text).toContain("Use sortKey.");
    // The source root keeps its revision, deadline and acceptance untouched.
    expect(s.ledger.work(s.parent.id)).toMatchObject({ revision: rootRevision, deadlineAt: null, acceptance: { criteria: "", checks: [] } });
    expect(s.engine.to(s.parent.conversationId!).some((entry) => entry.requestId.startsWith("work-question:"))).toBe(false);
  });

  test("a committed answer survives provider completion before its first delivery, including Activity providers", async () => {
    for (const activity of [false, true]) {
      const s = activity ? await setupActivityPeers() : await setupWithSibling([]);
      const question = "  EXACT QUESTION\nwith whitespace  ";
      const answer = "  EXACT ANSWER\nwith whitespace  ";
      s.core.works.askPeer(s.child.id, s.sibling.id, question, "commit-before-complete");
      s.core.works.onIdle(s.child.id);
      await s.core.idle();
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();
      void s.core.lane("work-question:commit-before-complete", () => gate);
      s.core.works.answerQuestion(s.sibling.id, "commit-before-complete", answer);
      s.core.works.complete(s.sibling.id, { summary: "Done", artifacts: [] });
      s.core.works.applyVerdict(s.sibling.id, { outcome: "pass", source: "owner", reasons: "ok", at: Date.now() });
      expect(s.ledger.work(s.sibling.id).state).toBe("done");
      release();
      await s.core.idle();
      const deliveries = s.engine.to(s.child.conversationId!).filter((entry) => entry.requestId === "work-question:commit-before-complete:answer");
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.text).toContain(question);
      expect(deliveries[0]!.text).toContain(answer);
      expect(s.ledger.findWorkQuestion("commit-before-complete")).toMatchObject({ state: "answered", question, answer, answerSubmittedAt: expect.any(Number) });
      expect(s.ledger.work(s.child.id).state).toBe("running");
    }
  });

  test("inactive or deleted sources and expired source, recipient, or root cannot ask peers", async () => {
    for (const boundary of ["inactive", "deleted", "source-deadline", "recipient-deadline", "root-deadline"] as const) {
      const s = await setupWithSibling([]);
      s.ledger.tx(() => {
        if (boundary === "inactive" || boundary === "deleted") {
          s.ledger.putGhost({ ...s.childGhost, ...(boundary === "inactive" ? { state: "retired" as const } : { deletedAt: Date.now() }) });
        } else {
          const work = boundary === "source-deadline" ? s.child : boundary === "recipient-deadline" ? s.sibling : s.parent;
          s.ledger.putWork({ ...work, deadlineAt: 1 });
        }
      });
      expect((await call(s, s.child, "ask_peer", { work_id: s.sibling.id, question: "Not authorized" }, boundary)).isError).toBe(true);
      expect(() => s.core.works.askPeer(s.child.id, s.sibling.id, "Not authorized", `core-${boundary}`)).toThrow();
      await s.core.idle();
      expect(s.ledger.workQuestions(s.child.id)).toHaveLength(0);
      expect(s.engine.to(s.sibling.conversationId!).some((entry) => entry.requestId.startsWith("work-question:"))).toBe(false);
    }
  });

  test("inactive callers or requesters and ordinary expired Works cannot commit answers", async () => {
    for (const boundary of ["caller-inactive", "caller-deleted", "requester-inactive", "source-deadline", "recipient-deadline", "root-deadline"] as const) {
      const s = await setupWithSibling([]);
      s.core.works.askPeer(s.child.id, s.sibling.id, "Authorized question", "answer-admission");
      await s.core.idle();
      s.ledger.tx(() => {
        if (boundary === "caller-inactive" || boundary === "caller-deleted" || boundary === "requester-inactive") {
          const ghost = boundary === "requester-inactive" ? s.childGhost : s.peerGhost;
          s.ledger.putGhost({ ...ghost, ...(boundary === "caller-deleted" ? { deletedAt: Date.now() } : { state: "retired" as const }) });
        } else {
          const work = boundary === "source-deadline" ? s.child : boundary === "recipient-deadline" ? s.sibling : s.parent;
          s.ledger.putWork({ ...work, deadlineAt: 1 });
        }
      });
      expect((await call(s, s.sibling, "answer_question", { question_id: "answer-admission", answer: "Not authorized" })).isError).toBe(true);
      expect(() => s.core.works.answerQuestion(s.sibling.id, "answer-admission", "Not authorized")).toThrow();
      await s.core.idle();
      expect(s.ledger.findWorkQuestion("answer-admission")?.answer).toBeNull();
      expect(s.engine.to(s.child.conversationId!).some((entry) => entry.requestId === "work-question:answer-admission:answer")).toBe(false);
    }
  });

  test("cancellation or revoked recipient liveness during open cannot admit a stale question", async () => {
    for (const boundary of ["cancel-requester", "cancel-recipient", "block-recipient", "inactive-recipient", "expired-recipient"] as const) {
      const s = await setupWithSibling([]);
      const held = holdOpen(s.core, s.sibling.conversationId!);
      s.core.works.askPeer(s.child.id, s.sibling.id, "Stale question", "stale-question");
      s.core.works.onIdle(s.child.id);
      await held.opening;
      if (boundary === "cancel-requester") s.core.works.cancel(s.child.id);
      else if (boundary === "cancel-recipient") s.core.works.cancel(s.sibling.id);
      else if (boundary === "block-recipient") s.core.works.block(s.sibling.id, "owner reconciliation required");
      else s.ledger.tx(() => {
        if (boundary === "inactive-recipient") s.ledger.putGhost({ ...s.peerGhost, state: "retired" });
        else s.ledger.putWork({ ...s.ledger.work(s.sibling.id), deadlineAt: 1 });
      });
      held.release();
      await s.core.idle();
      expect(s.engine.to(s.sibling.conversationId!).some((entry) => entry.requestId === "work-question:stale-question:question")).toBe(false);
      expect(s.ledger.findWorkQuestion("stale-question")?.state).toBe("cancelled");
      expect(s.ledger.work(s.child.id).state).toBe(boundary === "cancel-requester" ? "cancelled" : "running");
    }
  });

  test("answers blocked during open remain journaled and retry on normal unblock, including a blocked root", async () => {
    for (const blockRoot of [false, true]) {
      const s = await setupWithSibling([]);
      s.core.works.askPeer(s.child.id, s.sibling.id, "Exact question", "blocked-answer");
      s.core.works.onIdle(s.child.id);
      await s.core.idle();
      const held = holdOpen(s.core, s.child.conversationId!);
      s.core.works.answerQuestion(s.sibling.id, "blocked-answer", "Exact answer");
      await held.opening;
      const blocked = blockRoot ? s.parent : s.child;
      s.core.works.block(blocked.id, "owner reconciliation required");
      held.release();
      await s.core.idle();
      expect(s.engine.to(s.child.conversationId!).some((entry) => entry.requestId === "work-question:blocked-answer:answer")).toBe(false);
      expect(s.ledger.findWorkQuestion("blocked-answer")).toMatchObject({ state: "answered", answer: "Exact answer", answerSubmittedAt: null });
      s.core.works.unblock(blocked.id, "The owner reconciled the effect.");
      await s.core.idle();
      const deliveries = s.engine.to(s.child.conversationId!).filter((entry) => entry.requestId === "work-question:blocked-answer:answer");
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.text).toContain("Exact answer");
      expect(s.ledger.findWorkQuestion("blocked-answer")?.answerSubmittedAt).not.toBeNull();
      expect(s.ledger.work(s.child.id).state).toBe("running");
    }
  });

  test("requester cancellation during answer open discards the answer without reviving the Work", async () => {
    const s = await setupWithSibling([]);
    s.core.works.askPeer(s.child.id, s.sibling.id, "Q", "cancel-open-answer");
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    const held = holdOpen(s.core, s.child.conversationId!);
    s.core.works.answerQuestion(s.sibling.id, "cancel-open-answer", "Committed answer");
    await held.opening;
    s.core.works.cancel(s.child.id);
    held.release();
    await s.core.idle();
    expect(s.engine.submissions.has("work-question:cancel-open-answer:answer")).toBe(false);
    expect(s.ledger.findWorkQuestion("cancel-open-answer")).toMatchObject({ state: "cancelled", answer: "Committed answer", answerSubmittedAt: null });
    expect(s.ledger.work(s.child.id).state).toBe("cancelled");
  });

  test("Activity revision changes during open are reauthorized even before cancellation reconciliation", async () => {
    for (const answering of [false, true]) {
      const s = await setupActivityPeers();
      if (answering) {
        s.core.works.askPeer(s.child.id, s.sibling.id, "Q", "revision-open");
        await s.core.idle();
      }
      const target = answering ? s.child : s.sibling;
      const held = holdOpen(s.core, target.conversationId!);
      if (answering) s.core.works.answerQuestion(s.sibling.id, "revision-open", "Committed data");
      else s.core.works.askPeer(s.child.id, s.sibling.id, "Q", "revision-open");
      await held.opening;
      // Exercise the live ledger boundary independently of the API's subsequent tree cancellation.
      s.ledger.tx(() => s.ledger.putActivity({ ...s.activity, revision: s.activity.revision + 1 }));
      held.release();
      await s.core.idle();
      expect(s.engine.submissions.has(`work-question:revision-open:${answering ? "answer" : "question"}`)).toBe(false);
      expect(s.engine.submissions.has("work-question:revision-open:cancelled")).toBe(false);
      expect(s.ledger.findWorkQuestion("revision-open")).toMatchObject(answering
        ? { state: "answered", answer: "Committed data", answerSubmittedAt: null }
        : { state: "cancelled", cancellationSubmittedAt: null });
      s.core.activities.pause(s.activity.id, true, true);
      await s.core.idle();
      expect(s.ledger.work(s.child.id).state).toBe("cancelled");
      expect(s.ledger.workQuestionsAwaitingSubmission()).toHaveLength(0);
    }
  });

  test("Activity revocation during question or answer open admits neither stale input nor direct fallback", async () => {
    for (const answering of [false, true]) {
      const s = await setupActivityPeers();
      const target = answering ? s.child : s.sibling;
      if (answering) {
        s.core.works.askPeer(s.child.id, s.sibling.id, "Bound question", "revoked-open");
        await s.core.idle();
      }
      const held = holdOpen(s.core, target.conversationId!);
      if (answering) s.core.works.answerQuestion(s.sibling.id, "revoked-open", "Bound answer");
      else s.core.works.askPeer(s.child.id, s.sibling.id, "Bound question", "revoked-open");
      await held.opening;
      s.core.activities.pause(s.activity.id, true, true);
      held.release();
      await s.core.idle();
      expect(s.engine.to(target.conversationId!).some((entry) => entry.requestId === `work-question:revoked-open:${answering ? "answer" : "question"}`)).toBe(false);
      expect(s.ledger.work(s.child.id).state).toBe("cancelled");
      expect(s.ledger.findWorkQuestion("revoked-open")?.state).toBe("cancelled");
      expect(s.engine.submissions.has("work-question:revoked-open:cancelled")).toBe(false);
    }
  });

  test("a cancellation notice rechecks the requester after open instead of reviving cancelled Work", async () => {
    // An expired-but-waiting requester now receives its notice: a due date no longer ends a waiting Work (R3).
    for (const boundary of ["cancelled", "inactive"] as const) {
      const s = await setupWithSibling([]);
      s.core.works.askPeer(s.child.id, s.sibling.id, "Q", "stale-notice");
      s.core.works.onIdle(s.child.id);
      await s.core.idle();
      const held = holdOpen(s.core, s.child.conversationId!);
      s.core.works.cancel(s.sibling.id);
      await held.opening;
      if (boundary === "cancelled") s.core.works.cancel(s.child.id);
      else s.ledger.tx(() => s.ledger.putGhost({ ...s.childGhost, state: "retired" }));
      held.release();
      await s.core.idle();
      expect(s.engine.to(s.child.conversationId!).some((entry) => entry.requestId === "work-question:stale-notice:cancelled")).toBe(false);
      expect(s.ledger.work(s.child.id).state).toBe(boundary === "cancelled" ? "cancelled" : "waiting");
      expect(s.ledger.workQuestionsAwaitingSubmission()).toHaveLength(0);
    }
  });

  test("ask_peer is scoped to live same-root participants and work_status lists them", async () => {
    const s = await setupWithSibling([]);
    const status = content(await call(s, s.child, "work_status", {}));
    expect(status).toContain("Participants in this root (address ask_peer to their Work ids):");
    expect(status).toContain(`- ${s.parent.id} — Delegator — "Parent" — running`);
    expect(status).toContain(`- ${s.sibling.id} — Peer — "Sibling" — running`);
    const self = await call(s, s.child, "ask_peer", { work_id: s.child.id, question: "Self?" }, "self-q");
    expect(self.isError).toBe(true);
    expect(content(self)).toContain("cannot ask itself");
    const unknown = await call(s, s.child, "ask_peer", { work_id: "nope", question: "Q" }, "unknown-q");
    expect(unknown.isError).toBe(true);
    expect(content(unknown)).toContain("participants of this root are listed by work_status");
    const foreignRoot = s.core.works.createRoot({ ghostId: s.peerGhost.id, title: "Other root", brief: "B", originConversationId: s.peerGhost.directConversationId });
    await s.core.idle();
    const crossRoot = await call(s, s.child, "ask_peer", { work_id: foreignRoot.id, question: "Q?" }, "cross-q");
    expect(crossRoot.isError).toBe(true);
    expect(content(crossRoot)).toContain("outside this Work's root");
    const cousin = s.core.works.delegate(s.sibling.id, { ghostId: s.childGhost.id, title: "Cousin", brief: "B" });
    await s.core.idle();
    const sameGhost = await call(s, s.child, "ask_peer", { work_id: cousin.id, question: "Q?" }, "same-ghost-q");
    expect(sameGhost.isError).toBe(true);
    expect(content(sameGhost)).toContain("another Ghost's Work");
    s.core.works.cancel(s.sibling.id);
    await s.core.idle();
    const settled = await call(s, s.child, "ask_peer", { work_id: s.sibling.id, question: "Q?" }, "dead-q");
    expect(settled.isError).toBe(true);
    expect(content(settled)).toContain("recipient Work is cancelled");
    const lateGhost = s.core.createGhost({ name: "Late", persona: "L", tools: [] });
    const late = s.core.works.delegate(s.parent.id, { ghostId: lateGhost.id, title: "Late", brief: "B" });
    await s.core.idle();
    s.core.works.update(late.id, { deadlineAt: 1 });
    const expired = await call(s, s.child, "ask_peer", { work_id: late.id, question: "Q?" }, "expired-q");
    expect(expired.isError).toBe(true);
    expect(content(expired)).toContain("recipient Work's deadline has passed");
    const direct = s.ledger.conversation(s.parentGhost.directConversationId);
    s.ledger.setPiConversationId(direct.id, "pi-direct-spoof");
    const spoofed = await tool(createWorkTools(s.core, sandbox), "ask_peer").execute({ work_id: s.sibling.id, question: "Q" }, { conversationId: "pi-direct-spoof" } as unknown as ToolExecutionApi, {} as Context);
    expect(spoofed.isError).toBe(true);
    expect(content(spoofed)).toContain("only a work conversation");
  });

  test("pending-question cycles are refused for peers and for ask_parent with an actionable error", async () => {
    const s = await setupWithSibling([]);
    s.core.works.askPeer(s.child.id, s.sibling.id, "Which format?", "cycle-a");
    await s.core.idle();
    const refused = await call(s, s.sibling, "ask_peer", { work_id: s.child.id, question: "Asking back at once" }, "cycle-b");
    expect(refused.isError).toBe(true);
    expect(content(refused)).toContain("pending-question cycle");
    expect(content(refused)).toContain(s.child.id);
    const firstId = "cycle-a";
    s.core.works.answerQuestion(s.sibling.id, firstId, "JSON.");
    await s.core.idle();
    const reverse = await call(s, s.sibling, "ask_peer", { work_id: s.child.id, question: "Now asking back" }, "cycle-b");
    expect(reverse.isError).toBeFalsy();
    await s.core.idle();
    expect(s.ledger.findWorkQuestion(idFor(s.sibling.conversationId!, "cycle-b"))?.state).toBe("pending");
    // ask_parent obeys the same rule: the parent's pending peer question to this child blocks the child's escalation.
    s.core.works.askPeer(s.parent.id, s.child.id, "Status?", "parent-to-child");
    await s.core.idle();
    const escalation = await call(s, s.child, "ask_parent", { question: "Escalating while the parent asked me" }, "child-up");
    expect(escalation.isError).toBe(true);
    expect(content(escalation)).toContain("pending-question cycle");
  });

  test("a cancelled or settled recipient releases incoming questions with a recoverable fallback", async () => {
    for (const settle of ["cancel", "complete"] as const) {
      const s = await setupWithSibling([]);
      const asked = await call(s, s.child, "ask_peer", { work_id: s.sibling.id, question: "Need the schema" }, "fallback-q");
      expect(asked.isError).toBeFalsy();
      const questionId = idFor(s.child.conversationId!, "fallback-q");
      s.core.works.onIdle(s.child.id);
      await s.core.idle();
      expect(s.ledger.work(s.child.id).state).toBe("waiting");
      if (settle === "cancel") {
        s.core.works.cancel(s.sibling.id);
      } else {
        s.core.works.complete(s.sibling.id, { summary: "Done", artifacts: [] });
        await s.core.idle();
        s.core.works.applyVerdict(s.sibling.id, { outcome: "pass", source: "owner", reasons: "ok", at: Date.now() });
      }
      await s.core.idle();
      expect(s.ledger.findWorkQuestion(questionId)?.state).toBe("cancelled");
      expect(s.ledger.work(s.child.id).state).toBe("running");
      const notice = s.engine.to(s.child.conversationId!).find((entry) => entry.requestId === `work-question:${questionId}:cancelled`);
      expect(notice).toBeDefined();
      expect(s.ledger.workQuestionsAwaitingSubmission()).toHaveLength(0);
    }
  });

  test("an idle peer recipient gets one reminder, then releases the asker instead of hanging", async () => {
    const s = await setupWithSibling([]);
    s.core.works.askPeer(s.child.id, s.sibling.id, "Need a key", "peer-nudge");
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    s.core.works.onIdle(s.sibling.id);
    await s.core.idle();
    expect(s.ledger.work(s.sibling.id).state).toBe("running");
    expect(s.ledger.findWorkQuestion("peer-nudge")?.nudgeCount).toBe(1);
    const reminder = s.engine.to(s.sibling.conversationId!).find((entry) => entry.requestId === `work:${s.sibling.id}:qnudge:1`);
    s.core.works.onIdle(s.sibling.id);
    await s.core.idle();
    expect(s.ledger.findWorkQuestion("peer-nudge")?.nudgeCount).toBe(2);
    s.core.works.onIdle(s.sibling.id);
    await s.core.idle();
    expect(s.ledger.findWorkQuestion("peer-nudge")?.state).toBe("cancelled");
    expect(s.ledger.work(s.child.id).state).toBe("running");
    const notice = s.engine.to(s.child.conversationId!).find((entry) => entry.requestId === "work-question:peer-nudge:cancelled");
    expect(notice?.text).toContain("peer did not answer after a reminder");
  });

  test("peer questions and answers survive restart boundaries exactly once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ghost-collab-peer-restart-"));
    roots.push(directory);
    const path = join(directory, "ledger.db");
    const s = await setup(path);
    const engine = new InterruptedSubmission();
    s.core.attach(engine);
    engine.crashOn = "work-question:peer-q:question";
    const peerGhost = s.core.createGhost({ name: "Peer", persona: "P", tools: [] });
    const sibling = s.core.works.delegate(s.parent.id, { ghostId: peerGhost.id, title: "Sibling", brief: "B" });
    await s.core.idle();
    const siblingConversationId = s.ledger.work(sibling.id).conversationId!;
    s.core.works.askPeer(s.child.id, sibling.id, "Which format?", "peer-q");
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    expect(s.ledger.findWorkQuestion("peer-q")?.submittedAt).toBeNull();
    s.core.stop();
    s.ledger.close();
    opened.splice(opened.findIndex((entry) => entry.core === s.core), 1);
    const recovered = harness(path);
    opened.push(recovered);
    recovered.core.attach(engine);
    engine.crashOn = null;
    await recovered.core.start();
    await recovered.core.idle();
    expect(engine.to(siblingConversationId).filter((entry) => entry.requestId === "work-question:peer-q:question")).toHaveLength(1);
    expect(recovered.ledger.findWorkQuestion("peer-q")?.submittedAt).not.toBeNull();
    engine.crashOn = "work-question:peer-q:answer";
    recovered.core.works.answerQuestion(recovered.ledger.work(sibling.id).id, "peer-q", "Use JSON.");
    await recovered.core.idle();
    expect(recovered.ledger.findWorkQuestion("peer-q")?.answerSubmittedAt).toBeNull();
    recovered.core.stop();
    recovered.ledger.close();
    opened.splice(opened.indexOf(recovered), 1);
    const again = harness(path);
    opened.push(again);
    again.core.attach(engine);
    engine.crashOn = null;
    await again.core.start();
    await again.core.idle();
    again.core.works.recover();
    await again.core.idle();
    expect(again.ledger.findWorkQuestion("peer-q")?.answerSubmittedAt).not.toBeNull();
    expect(again.ledger.work(s.child.id).state).toBe("running");
    expect(engine.to(s.child.conversationId!).filter((entry) => entry.requestId === "work-question:peer-q:answer")).toHaveLength(1);
  });

  test("an answered question still delivers exactly once after the recipient settles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ghost-collab-race-restart-"));
    roots.push(directory);
    const path = join(directory, "ledger.db");
    const s = await setup(path);
    const engine = new InterruptedSubmission();
    s.core.attach(engine);
    const peerGhost = s.core.createGhost({ name: "Peer", persona: "P", tools: [] });
    const sibling = s.core.works.delegate(s.parent.id, { ghostId: peerGhost.id, title: "Sibling", brief: "B" });
    await s.core.idle();
    const asked = await call(s, s.child, "ask_peer", { work_id: sibling.id, question: "EXACT RACE QUESTION" }, "race-q");
    expect(asked.isError).toBeFalsy();
    const questionId = idFor(s.child.conversationId!, "race-q");
    await s.core.idle();
    // The recipient answers, then completes and settles before the answer lane can retry.
    engine.crashOn = `work-question:${questionId}:answer`;
    expect((await call(s, sibling, "answer_question", { question_id: questionId, answer: "Use sortKey v2." })).isError).toBeFalsy();
    await s.core.idle();
    expect(s.ledger.findWorkQuestion(questionId)).toMatchObject({ state: "answered", answer: "Use sortKey v2.", answerSubmittedAt: null });
    s.core.works.complete(sibling.id, { summary: "Done", artifacts: [] });
    await s.core.idle();
    s.core.works.applyVerdict(sibling.id, { outcome: "pass", source: "owner", reasons: "ok", at: Date.now() });
    await s.core.idle();
    expect(s.ledger.work(sibling.id).state).toBe("done");
    // Settlement must not cancel an authorized answer. The restart's recovery delivers the
    // exact answer to the live requester; no in-harness retry ran before it.
    s.core.stop();
    s.ledger.close();
    opened.splice(opened.findIndex((entry) => entry.core === s.core), 1);
    const again = harness(path);
    opened.push(again);
    again.core.attach(engine);
    engine.crashOn = null;
    await again.core.start();
    await again.core.idle();
    const delivery = engine.to(again.ledger.work(s.child.id).conversationId!).filter((entry) => entry.requestId === `work-question:${questionId}:answer`);
    expect(delivery).toHaveLength(1);
    expect(delivery[0]!.text).toContain("Use sortKey v2.");
    expect(again.ledger.findWorkQuestion(questionId)).toMatchObject({ state: "answered", answer: "Use sortKey v2.", answerSubmittedAt: expect.any(Number) });
    expect(again.ledger.work(s.child.id).state).toBe("running");
    // Repeated recovery is a no-op: the same delivery identity never submits twice.
    again.core.works.recover();
    await again.core.idle();
    expect(engine.to(s.child.conversationId!).filter((entry) => entry.requestId === `work-question:${questionId}:answer`)).toHaveLength(1);
  });

  test("a recipient's review sees its answered incoming questions; an unrelated review sees neither side", async () => {
    const s = await setupWithSibling([]);
    const asked = await call(s, s.child, "ask_peer", { work_id: s.sibling.id, question: "UNIQUE PEER QUESTION" }, "review-peer-q");
    expect(asked.isError).toBeFalsy();
    const questionId = idFor(s.child.conversationId!, "review-peer-q");
    await s.core.idle();
    const answered = await call(s, s.sibling, "answer_question", { question_id: questionId, answer: "UNIQUE PEER ANSWER" });
    expect(answered.isError).toBeFalsy();
    await s.core.idle();
    s.core.works.complete(s.sibling.id, { summary: "Done", artifacts: [] });
    await s.core.idle();
    const siblingReview = s.ledger.conversations({ kind: "review" }).find((conversation) => conversation.workId === s.sibling.id)!;
    s.ledger.setPiConversationId(siblingReview.id, "pi-peer-review");
    const records = content(await tool(createReviewTools(s.core), "effect_list").execute({}, { conversationId: "pi-peer-review" } as unknown as ToolExecutionApi, {} as Context));
    expect(records).toContain(`${questionId} [answered] from Work ${s.child.id}`);
    expect(records).toContain("UNIQUE PEER QUESTION");
    expect(records).toContain("UNIQUE PEER ANSWER");
    const other = s.core.works.delegate(s.parent.id, { ghostId: s.childGhost.id, title: "Unrelated", brief: "B" });
    await s.core.idle();
    s.core.works.complete(other.id, { summary: "Done", artifacts: [] });
    await s.core.idle();
    const otherReview = s.ledger.conversations({ kind: "review" }).find((conversation) => conversation.workId === other.id)!;
    s.ledger.setPiConversationId(otherReview.id, "pi-unrelated-review");
    const unrelated = content(await tool(createReviewTools(s.core), "effect_list").execute({}, { conversationId: "pi-unrelated-review" } as unknown as ToolExecutionApi, {} as Context));
    expect(unrelated).toContain("No effects were recorded");
    expect(unrelated).not.toContain("UNIQUE PEER QUESTION");
    expect(unrelated).not.toContain("UNIQUE PEER ANSWER");
    expect(unrelated).not.toContain(questionId);
  });

  test("an ordinary root is bounded at 32 nodes counting settled Work; existing trees stay untouched", async () => {
    const s = await setup(":memory:", []);
    const settle = async (child: Work) => {
      await s.core.idle();
      s.core.works.complete(child.id, { summary: "Done", artifacts: [] });
      await s.core.idle();
      s.core.works.applyVerdict(child.id, { outcome: "pass", source: "owner", reasons: "ok", at: Date.now() });
      await s.core.idle();
    };
    await settle(s.child);
    const created: Work[] = [s.child];
    let refused: Error | null = null;
    for (let i = 0; i < 40; i++) {
      try {
        const child = s.core.works.delegate(s.parent.id, { ghostId: s.childGhost.id, title: `N${String(i).padStart(2, "0")}`, brief: "B" });
        created.push(child);
        await settle(child);
      } catch (error) {
        refused = error as Error;
        break;
      }
    }
    expect(created).toHaveLength(31);
    expect(refused?.message).toContain("limited to 32 Work nodes");
    expect(s.ledger.worksInRoot(s.parent.id)).toHaveLength(32);
    expect(s.ledger.work(created[0]!.id).state).toBe("done");
    expect(s.engine.to(s.parent.conversationId!).some((entry) => entry.origin === "child_result")).toBe(true);
    // A replayed delegation id still finds its Work after the budget is exhausted.
    expect(s.core.works.delegate(s.parent.id, { ghostId: s.childGhost.id, title: "Replay", brief: "B", id: created[0]!.id }).id).toBe(created[0]!.id);
  });
});

describe("structured verification and revision lessons", () => {
  test("reviewers can inspect recorded parent questions and answers even without external effects", async () => {
    const s = await setup();
    const asked = await call(s, s.child, "ask_parent", { question: "Should the report use JSON?" }, "review-question");
    expect(asked.isError).toBeFalsy();
    await s.core.idle();
    const question = s.ledger.workQuestions(s.child.id)[0]!;
    const answered = await call(s, s.parent, "answer_question", { question_id: question.id, answer: "Yes, use JSON." });
    expect(answered.isError).toBeFalsy();
    await s.core.idle();
    const other = s.core.works.delegate(s.parent.id, { ghostId: s.childGhost.id, title: "Unrelated child", brief: "B" });
    await s.core.idle();
    s.core.works.askParent(other.id, "UNRELATED QUESTION", "unrelated-question");
    await s.core.idle();
    s.core.works.complete(s.child.id, { summary: "Report prepared", artifacts: [] });
    await s.core.idle();
    const review = s.ledger.conversations({ kind: "review" }).find((conversation) => conversation.workId === s.child.id)!;
    s.ledger.setPiConversationId(review.id, "pi-question-review");
    const before = s.ledger.seq();
    const result = await tool(createReviewTools(s.core), "effect_list").execute({}, { conversationId: "pi-question-review" } as unknown as ToolExecutionApi, {} as Context);
    expect(result.isError).toBeFalsy();
    const records = content(result);
    expect(records).toContain("No effects were recorded");
    expect(records).toContain("Questions asked or received (host ledger records; latest 1 of 1)");
    expect(records).toContain(`${question.id} [answered]`);
    expect(records).toContain(s.parent.id);
    expect(records).toContain("Question: Should the report use JSON?");
    expect(records).toContain("Answer: Yes, use JSON.");
    expect(records).not.toContain("UNRELATED QUESTION");
    expect(records).not.toContain("unrelated-question");
    expect(s.ledger.seq()).toBe(before);
  });

  test("review question records show only the latest eight entries with bounded question and answer text", async () => {
    const s = await setup();
    for (let i = 0; i < 16; i++) {
      s.core.works.askParent(s.child.id, `Question ${i}: ${"q".repeat(8000)}`, `review-cap-${String(i).padStart(2, "0")}`);
    }
    await s.core.idle();
    for (const question of s.ledger.workQuestions(s.child.id)) {
      s.core.works.answerQuestion(s.parent.id, question.id, `Answer: ${"a".repeat(8000)}`);
    }
    await s.core.idle();
    s.core.works.complete(s.child.id, { summary: "Done", artifacts: [] });
    await s.core.idle();
    const review = s.ledger.conversations({ kind: "review" }).find((conversation) => conversation.workId === s.child.id)!;
    s.ledger.setPiConversationId(review.id, "pi-bounded-question-review");
    const result = await tool(createReviewTools(s.core), "effect_list").execute({}, { conversationId: "pi-bounded-question-review" } as unknown as ToolExecutionApi, {} as Context);
    const records = content(result);
    expect(records).toContain("latest 8 of 16");
    expect(records.match(/^- review-cap-/gm)).toHaveLength(8);
    expect(records).not.toContain("review-cap-00");
    expect(records).toContain("review-cap-08");
    expect(records).toContain("review-cap-15");
    expect(records.match(/\[truncated\]/g)).toHaveLength(16);
    expect(records).not.toContain("q".repeat(513));
    expect(records).not.toContain("a".repeat(513));
  });

  test("verdict evidence and scope persist, steer the assignee, and travel in child/root outcomes", async () => {
    const s = await setup();
    s.core.works.complete(s.child.id, { summary: "First", artifacts: [] });
    await s.core.idle();
    const review = s.ledger.conversations({ kind: "review" }).find((conversation) => conversation.workId === s.child.id)!;
    s.ledger.setPiConversationId(review.id, "pi-review");
    const verdict = tool(createReviewTools(s.core), "verdict");
    expect(checkValue(verdict.parameters!, { outcome: "revise", reasons: "Fix", evidence: "x".repeat(8193) })).toBe(false);
    expect(checkValue(verdict.parameters!, { outcome: "revise", reasons: "Fix", scope: "x".repeat(2049) })).toBe(false);
    const result = await verdict.execute({ outcome: "revise", reasons: "Wrong key", evidence: "result.json:2 has name, expected title", scope: "Change only the JSON key" }, { conversationId: "pi-review" } as unknown as ToolExecutionApi, {} as Context);
    expect(result.isError).toBeFalsy();
    await s.core.idle();
    const recorded = s.ledger.work(s.child.id).verdict!;
    expect(recorded.evidence).toBe("result.json:2 has name, expected title");
    expect(recorded.scope).toBe("Change only the JSON key");
    const revise = s.engine.to(s.child.conversationId!).find((submission) => submission.origin === "verdict")!;
    expect(revise.text).toContain("## Reasons\nWrong key");
    expect(revise.text).toContain(`## Evidence\n${recorded.evidence}`);
    expect(revise.text).toContain(`## Scope\n${recorded.scope}`);
    expect(revise.text).toContain("Change only what the scope allows");
    expect(s.ledger.reviseHistory(s.child.id)).toEqual([{ source: "review", reasons: recorded.reasons, evidence: recorded.evidence, scope: recorded.scope, at: recorded.at }]);
    s.core.works.complete(s.child.id, { summary: "Fixed", artifacts: [] });
    await s.core.idle();
    s.core.works.applyVerdict(s.child.id, { outcome: "pass", source: "review", reasons: "Good", at: Date.now() });
    await s.core.idle();
    const childReport = s.engine.to(s.parent.conversationId!).find((submission) => submission.origin === "child_result")!;
    expect(childReport.text).toContain("## Revision history");
    expect(childReport.text).toContain(recorded.evidence!);
    expect(childReport.text).toContain(recorded.scope!);
    s.core.works.complete(s.parent.id, { summary: "Root first", artifacts: [] });
    await s.core.idle();
    s.core.works.applyVerdict(s.parent.id, { outcome: "revise", source: "owner", reasons: "Keep format stable", at: Date.now() });
    await s.core.idle();
    s.core.works.complete(s.parent.id, { summary: "Root fixed", artifacts: [] });
    await s.core.idle();
    s.core.works.applyVerdict(s.parent.id, { outcome: "pass", source: "owner", reasons: "OK", at: Date.now() });
    await s.core.idle();
    expect(s.engine.to(s.parentGhost.directConversationId).find((submission) => submission.origin === "report")?.text).toContain("owner: Keep format stable");
  });

  test("delegate validates checks; child failures revise without review, passing checks still require review", async () => {
    const s = await setup();
    const checks: Check[] = [{ kind: "artifact_contains", name: "result.txt", text: "OK" }];
    const delegate = tool(createWorkTools(s.core, sandbox), "delegate");
    expect(checkValue(delegate.parameters!, { ghost_id: s.childGhost.id, title: "C", brief: "B", checks: Array(17).fill(checks[0]) })).toBe(false);
    expect(checkValue(delegate.parameters!, { ghost_id: s.childGhost.id, title: "C", brief: "B", checks: [{ kind: "command_exit_zero" }] })).toBe(false);
    const invalid = await call(s, s.parent, "delegate", { ghost_id: s.childGhost.id, title: "Bad", brief: "B", checks: [{ kind: "bad" }] });
    expect(invalid.isError).toBe(true);
    const delegated = await call(s, s.parent, "delegate", { ghost_id: s.childGhost.id, title: "Checked", brief: "B", checks }, "checked");
    expect(delegated.isError).toBeFalsy();
    await s.core.idle();
    const child = s.ledger.children(s.parent.id).find((candidate) => candidate.title === "Checked")!;
    expect(child.acceptance.checks).toEqual(checks);
    s.core.works.complete(child.id, { summary: "Missing file", artifacts: [] });
    await s.core.idle();
    expect(s.ledger.work(child.id).state).toBe("running");
    expect(s.ledger.work(child.id).verdict?.source).toBe("checks");
    expect(s.ledger.work(child.id).revisionsUsed).toBe(1);
    expect(s.ledger.conversations({ kind: "review" }).filter((conversation) => conversation.workId === child.id)).toHaveLength(0);
    const ref = await s.artifacts.put(new TextEncoder().encode("OK"), "result.txt", "text/plain");
    s.ledger.tx(() => s.ledger.addArtifact(child.id, ref));
    s.core.works.complete(child.id, { summary: "Present", artifacts: [ref] });
    await s.core.idle();
    expect(s.ledger.work(child.id).state).toBe("verifying");
    expect(s.ledger.conversations({ kind: "review" }).find((conversation) => conversation.workId === child.id)?.ghostId).toBe(s.parentGhost.id);
    expect(s.ledger.pendingDecisions({ workId: child.id })).toHaveLength(0);
    expect(s.ledger.reviseHistory(child.id)[0]?.source).toBe("checks");
  });

  test("passing child checks respect a named reviewer; root checks still decide without review", async () => {
    const s = await setup();
    const reviewer = s.core.createGhost({ name: "Reviewer", persona: "Judge" });
    const ref = await s.artifacts.put(new TextEncoder().encode("OK"), "result", "text/plain");
    const checks: Check[] = [{ kind: "artifact_sha256", name: "result", sha256: ref.digest }];
    const acceptance = { criteria: "", checks, reviewer: { kind: "ghost" as const, ghostId: reviewer.id } };
    const child = s.core.works.delegate(s.parent.id, { ghostId: s.childGhost.id, title: "Checked", brief: "B", acceptance });
    const root = s.core.works.createRoot({ ghostId: s.parentGhost.id, title: "Root", brief: "B", originConversationId: s.parentGhost.directConversationId, acceptance });
    await s.core.idle();
    s.ledger.tx(() => { s.ledger.addArtifact(child.id, ref); s.ledger.addArtifact(root.id, ref); });
    s.core.works.complete(child.id, { summary: "Done", artifacts: [ref] });
    s.core.works.complete(root.id, { summary: "Done", artifacts: [ref] });
    await s.core.idle();
    expect(s.ledger.work(child.id).state).toBe("verifying");
    expect(s.ledger.conversations({ kind: "review" }).find((conversation) => conversation.workId === child.id)?.ghostId).toBe(reviewer.id);
    expect(s.ledger.work(root.id).state).toBe("done");
    expect(s.ledger.work(root.id).verdict?.source).toBe("checks");
    expect(s.ledger.conversations({ kind: "review" }).some((conversation) => conversation.workId === root.id)).toBe(false);
  });

  test("history stays bounded after repeated resumed attempts and includes exhausted revisions", async () => {
    const s = await setup();
    for (let i = 0; i < 30; i++) {
      s.ledger.tx(() => s.ledger.appendReviseHistory(s.child.id, { outcome: "revise", source: "review", reasons: "\\\"".repeat(20000), evidence: "x".repeat(20000), scope: "y".repeat(5000), at: i }));
    }
    const history = s.ledger.reviseHistory(s.child.id);
    expect(JSON.stringify(history).length).toBeLessThanOrEqual(131072);
    expect(history.at(-1)?.at).toBe(29);
    expect(history.at(-1)?.reasons.length).toBe(8192);
    expect(history.at(-1)?.evidence?.length).toBe(8192);
    expect(history.at(-1)?.scope?.length).toBe(2048);
    for (let i = 0; i < 3; i++) {
      s.core.works.complete(s.child.id, { summary: "Attempt", artifacts: [] });
      await s.core.idle();
      s.core.works.applyVerdict(s.child.id, { outcome: "revise", source: "review", reasons: `revise-${i}`, at: Date.now() });
      await s.core.idle();
    }
    expect(s.ledger.work(s.child.id).state).toBe("failed");
    expect(s.ledger.work(s.child.id).revisionsUsed).toBe(2);
    expect(s.ledger.reviseHistory(s.child.id).at(-1)?.reasons).toBe("revise-2");
    expect(s.engine.to(s.parent.conversationId!).find((submission) => submission.origin === "child_result")?.text).toContain("revise-2");
  });
});

describe("collaboration migration 6 and autonomy migration 7", () => {
  test("fresh databases create questions and empty history", async () => {
    const s = await setup();

    expect(s.ledger.reviseHistory(s.parent.id)).toEqual([]);
    expect(s.ledger.db.query("SELECT * FROM work_questions").all()).toEqual([]);
  });

  test("version 5 existing Works gain an empty history without changing their rows", () => {
    const root = mkdtempSync(join(tmpdir(), "ghost-collab-migrate-"));
    roots.push(root);
    const path = join(root, "ledger.db");
    const db = new Database(path);
    for (const migration of MIGRATIONS.slice(0, 5)) db.exec(migration);
    db.exec("PRAGMA user_version = 5");
    db.query(`INSERT INTO ghosts (id,name,persona,look,is_default,state,direct_conversation_id,created_at,updated_at)
      VALUES ('g','G','','{}',1,'active','c',1,1)`).run();
    db.query(`INSERT INTO conversations (id,ghost_id,kind,title,created_at,last_activity_at) VALUES ('c','g','direct','D',1,1)`).run();
    db.query(`INSERT INTO works (id,root_id,ghost_id,origin_conversation_id,title,brief,acceptance,state,revision,created_at,updated_at)
      VALUES ('w','w','g','c','Existing','B','{"criteria":"","checks":[],"reviewer":null}','queued',1,1,1)`).run();
    db.close();
    const ledger = new Ledger(path);
    try {

      expect(ledger.work("w").title).toBe("Existing");
      expect(ledger.reviseHistory("w")).toEqual([]);
      expect(ledger.db.query("SELECT revise_history FROM works WHERE id = 'w'").get()).toEqual({ revise_history: "[]" });
      expect(() => ledger.db.query("INSERT INTO work_questions (id,work_id,recipient_work_id,question,state,created_at) VALUES ('q','w','w','Q','invalid',1)").run()).toThrow();
    } finally { ledger.close(); }
  });

  test("version 6 preserves live questions, revision lessons and delivery identities across autonomy upgrade and writes", () => {
    const root = mkdtempSync(join(tmpdir(), "ghost-collab-upgrade-"));
    roots.push(root);
    const path = join(root, "ledger.db");
    const history = [{ source: "review" as const, reasons: "Keep the live behavior", evidence: "Recorded child evidence", scope: "Only the approved files", at: 20 }];
    const db = new Database(path);
    let oldWorks: unknown[];
    let oldQuestions: unknown[];
    try {
      db.transaction(() => {
        for (const migration of MIGRATIONS.slice(0, 6)) db.exec(migration);
        db.exec("PRAGMA user_version = 6");
        db.query(`INSERT INTO ghosts (id,name,persona,look,is_default,state,direct_conversation_id,created_at,updated_at,tools)
          VALUES ('g','Live Ghost','','{"avatarId":null}',1,'active','direct',1,2,'["read","delegate"]')`).run();
        db.query(`INSERT INTO conversations (id,ghost_id,kind,work_id,title,created_at,last_activity_at,pi_conversation_id)
          VALUES (?, 'g', ?, ?, ?, 1, 2, ?)`).run("direct", "direct", null, "Owner", "pi-direct");
        const insert = db.query(`INSERT INTO works
          (id,parent_id,root_id,ghost_id,origin_conversation_id,title,brief,acceptance,state,revision,revisions_used,
            idle_nudges,question_nudges,revise_history,reported_at,created_at,updated_at)
          VALUES (?,?,'parent','g','direct',?,'Live brief','{"criteria":"Keep production","checks":[],"reviewer":null}',?,3,1,1,7,?,NULL,1,2)`);
        insert.run("parent", null, "Parent", "running", "[]");
        insert.run("child", "parent", "Child", "waiting", JSON.stringify(history));
        const question = db.query(`INSERT INTO work_questions
          (id,work_id,parent_work_id,question,answer,state,created_at,answered_at,submitted_at,answer_submitted_at,
            nudge_count,cancellation_reason,cancellation_submitted_at)
          VALUES (?,'child','parent','Which scope?',?,?,10,?,?,?,1,?,?)`);
        question.run("pending", null, "pending", null, 11, null, null, null);
        question.run("answered", "Approved scope only", "answered", 12, 11, null, null, null);
        question.run("cancelled", null, "cancelled", null, 11, null, "Parent unavailable", null);
      })();
      oldWorks = db.query("SELECT * FROM works ORDER BY id").all();
      oldQuestions = db.query("SELECT * FROM work_questions ORDER BY id").all();
    } finally { db.close(); }

    const ledger = new Ledger(path);
    try {

      for (const row of ledger.db.query("SELECT * FROM works ORDER BY id").all()) {
        const { execution, activity_id, activity_run_id, tool_scope, budget_minutes, budget_used_ms, budget_since, budget_extended, hold, scope_id, attachments, slot, retry, scope_references, ...preserved } = row as Record<string, unknown>;
        expect([execution, activity_id, activity_run_id, tool_scope]).toEqual([null, null, null, null]);
        expect([budget_minutes, budget_used_ms, budget_extended, hold]).toEqual([90, 0, 0, null]);
        expect([scope_id, attachments, slot, retry, scope_references]).toEqual([null, "[]", null, null, "[]"]);
        // Migration 10 starts the clock only for rows still running.
        expect(budget_since === null || Number.isFinite(budget_since)).toBe(true);
        expect(oldWorks).toContainEqual(preserved);
      }
      // The recipient migration renames its column without losing values or delivery markers.
      expect(ledger.db.query("SELECT * FROM work_questions ORDER BY id").all()).toEqual(
        (oldQuestions as Record<string, unknown>[]).map(({ parent_work_id, ...rest }) => ({ ...rest, recipient_work_id: parent_work_id })),
      );
      expect(ledger.ghost("g")).toMatchObject({ hostExecution: false, tools: ["read", "delegate"], directConversationId: "direct" });
      expect(ledger.piConversationId("direct")).toBe("pi-direct");
      expect(ledger.reviseHistory("child")).toEqual(history);
      expect(ledger.workQuestionsAwaitingSubmission().map((question) => question.id)).toEqual(["answered", "cancelled"]);
      expect(ledger.activities()).toEqual([]);
      expect(ledger.connections()).toEqual([]);
      expect(ledger.activityRuns()).toEqual([]);
      ledger.tx(() => {
        ledger.putWork({ ...ledger.work("child"), title: "Edited after upgrade", execution: { kind: "container" }, toolScope: ["read"] });
        expect(ledger.nextQuestionNudge("parent")).toBe(8);
        const answered = ledger.findWorkQuestion("answered")!;
        ledger.putWorkQuestion({ ...answered, answerSubmittedAt: 30 });
      });
      expect(ledger.reviseHistory("child")).toEqual(history);
      expect(ledger.workQuestionsAwaitingSubmission().map((question) => question.id)).toEqual(["cancelled"]);
    } finally { ledger.close(); }

    const reopened = new Ledger(path);
    try {
      expect(reopened.work("child")).toMatchObject({ parentId: "parent", rootId: "parent", title: "Edited after upgrade", execution: { kind: "container" }, toolScope: ["read"] });
      expect(reopened.reviseHistory("child")).toEqual(history);
      expect(reopened.findWorkQuestion("answered")).toMatchObject({ recipientWorkId: "parent", answer: "Approved scope only", answerSubmittedAt: 30, nudgeCount: 1 });
      expect(reopened.findWorkQuestion("pending")).toMatchObject({ recipientWorkId: "parent", state: "pending", submittedAt: 11 });
      expect(reopened.findWorkQuestion("cancelled")).toMatchObject({ recipientWorkId: "parent", state: "cancelled", cancellationReason: "Parent unavailable", cancellationSubmittedAt: null });
      expect(reopened.db.query("SELECT question_nudges FROM works WHERE id = 'parent'").get()).toEqual({ question_nudges: 8 });
    } finally { reopened.close(); }
  });

  test("recipient migration preserves existing question rows and delivery markers in place", () => {
    const root = mkdtempSync(join(tmpdir(), "ghost-collab-migrate8-"));
    roots.push(root);
    const path = join(root, "ledger.db");
    const db = new Database(path);
    let rows: unknown[] = [];
    try {
      db.transaction(() => {
        // The schema of the release before the recipient rename: migrations 1 through 8.
        for (const migration of MIGRATIONS.slice(0, 8)) db.exec(migration);
        db.exec("PRAGMA user_version = 8");
        db.query(`INSERT INTO ghosts (id,name,persona,look,is_default,state,direct_conversation_id,created_at,updated_at)
          VALUES ('g','G','','{}',1,'active','c',1,1)`).run();
        db.query(`INSERT INTO conversations (id,ghost_id,kind,title,created_at,last_activity_at) VALUES ('c','g','direct','D',1,1)`).run();
        db.query(`INSERT INTO works (id,root_id,ghost_id,origin_conversation_id,title,brief,acceptance,state,revision,created_at,updated_at)
          VALUES ('w','w','g','c','Existing','B','{"criteria":"","checks":[],"reviewer":null}','queued',1,1,1)`).run();
        db.query(`INSERT INTO work_questions
          (id,work_id,parent_work_id,question,answer,state,created_at,answered_at,submitted_at,answer_submitted_at,nudge_count,cancellation_reason,cancellation_submitted_at)
          VALUES ('q','w','w','Which scope?','Answered scope','answered',10,11,12,13,1,NULL,14)`).run();
        rows = db.query("SELECT * FROM work_questions ORDER BY id").all();
      })();
    } finally { db.close(); }
    const ledger = new Ledger(path);
    try {
      expect(ledger.db.query("SELECT * FROM work_questions ORDER BY id").all()).toEqual(
        (rows as Record<string, unknown>[]).map(({ parent_work_id, ...rest }) => ({ ...rest, recipient_work_id: parent_work_id })),
      );
      expect(ledger.findWorkQuestion("q")).toMatchObject({ recipientWorkId: "w", state: "answered", answer: "Answered scope", submittedAt: 12, answerSubmittedAt: 13 });
      expect(ledger.workQuestionsAwaitingSubmission()).toEqual([]);
      ledger.tx(() => ledger.putWorkQuestion({ ...ledger.findWorkQuestion("q")!, answerSubmittedAt: 20 }));
      expect(ledger.findWorkQuestion("q")?.answerSubmittedAt).toBe(20);
    } finally { ledger.close(); }
  });
});
