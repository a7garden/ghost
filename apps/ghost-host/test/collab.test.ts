import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check as checkValue } from "typebox/value";
import type { Context } from "@earendil-works/chord";
import type { Extension, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { Check, Work } from "@ghost/contract";
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
  const api = { conversationId: `pi-${conversation.id}`, callId, output: () => {} } as unknown as ToolExecutionApi;
  return tool(createWorkTools(s.core, sandbox), name).execute(args as never, api, {} as Context);
}
async function setup(path = ":memory:") {
  const s = harness(path);
  opened.push(s);
  const parentGhost = s.core.createGhost({ name: "Delegator", persona: "Lead" });
  const childGhost = s.core.createGhost({ name: "Child", persona: "Implement" });
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
  readonly attempts: string[] = [];
  override async submit(conversationId: string, submission: Submission) {
    this.attempts.push(submission.requestId);
    await super.submit(conversationId, submission);
    if (submission.requestId === this.crashOn) throw new Error("simulated interruption after Pi admission");
  }
}

describe("parent-first questions", () => {
  test("child asks, waits without nudges, parent wakes and answers, child resumes", async () => {
    const s = await setup();
    // Lifecycle tools remain usable even when selectable tools are revoked.
    s.ledger.tx(() => {
      s.ledger.putGhost({ ...s.parentGhost, tools: [] });
      s.ledger.putGhost({ ...s.childGhost, tools: [] });
    });
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
    const answered = await call(s, s.parent, "answer_child", { question_id: questionId, answer: "Use JSON." });
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
    const foreign = await call(s, other, "answer_child", { question_id: q.id, answer: "No" });
    expect(foreign.isError).toBe(true);
    expect(content(foreign)).toContain("not from a child");
    s.core.works.answerChild(s.parent.id, q.id, "A");
    expect(() => s.core.works.answerChild(s.parent.id, q.id, "Again")).toThrow("question is answered");
    const cancelled = s.core.works.askParent(s.child.id, "Another?", "cancelled-q");
    s.core.works.cancel(s.child.id);
    expect(s.ledger.findWorkQuestion(cancelled.id)?.state).toBe("cancelled");
    expect(() => s.core.works.answerChild(s.parent.id, cancelled.id, "No")).toThrow("question is cancelled");
    const direct = s.ledger.conversation(s.parentGhost.directConversationId);
    s.ledger.setPiConversationId(direct.id, "pi-direct");
    const refused = await tool(createWorkTools(s.core, sandbox), "ask_parent").execute({ question: "Q" }, { conversationId: "pi-direct" } as unknown as ToolExecutionApi, {} as Context);
    expect(refused.isError).toBe(true);
    expect(content(refused)).toContain("only a work conversation");
  });

  test("pending questions prevent completion and idle failure, but deadlines still expire", async () => {
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
    s.core.works.update(s.child.id, { deadlineAt: 1 });
    s.core.works.expire(Date.now());
    await s.core.idle();
    expect(s.ledger.work(s.child.id).state).toBe("failed");
    expect(s.ledger.findWorkQuestion("q")?.state).toBe("cancelled");
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
    recovered.core.works.answerChild(s.parent.id, "q", "A");
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
    expect(engine.attempts.filter((id) => id === "work-question:q:question")).toHaveLength(2);
    expect(engine.attempts.filter((id) => id === "work-question:q:answer")).toHaveLength(2);
  });

  test("idle parents get one counted reminder, then release unanswered children instead of hanging", async () => {
    const s = await setup();
    s.core.works.askParent(s.child.id, "Need a format", "idle-q");
    s.core.works.onIdle(s.child.id);
    await s.core.idle();
    s.core.works.onIdle(s.parent.id);
    await s.core.idle();
    expect(s.ledger.work(s.parent.id).state).toBe("running");
    expect(s.ledger.findWorkQuestion("idle-q")?.nudgeCount).toBe(1);
    const reminder = s.engine.to(s.parent.conversationId!).find((entry) => entry.requestId === `work:${s.parent.id}:qnudge:1`);
    expect(reminder?.text).toContain("answer_child");
    expect(reminder?.text).toContain("ask_owner");
    expect(reminder?.text).toContain("relay");
    s.core.works.onIdle(s.parent.id);
    await s.core.idle();
    expect(s.ledger.findWorkQuestion("idle-q")?.state).toBe("cancelled");
    expect(s.ledger.work(s.child.id).state).toBe("running");
    const notice = s.engine.to(s.child.conversationId!).find((entry) => entry.requestId === "work-question:idle-q:cancelled");
    expect(notice?.text).toContain("best judgment");
    expect(notice?.text).toContain("ask_owner");
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
      expect(notice?.text).toContain("ask_owner");
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
    expect(s.engine.to(s.child.conversationId!).find((entry) => entry.requestId === "work-question:reminder-refused:cancelled")?.text).toContain("ask_owner");
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
    s.core.works.answerChild(s.parent.id, "answer-retry", "A");
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
      s.core.works.answerChild(s.parent.id, "terminal-answer", "A");
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
    expect(s.ledger.findWorkQuestion("cancel-notice")?.cancellationSubmittedAt).toBeNull();
    expect(s.ledger.workQuestionsAwaitingSubmission().map((row) => row.id)).toEqual(["cancel-notice"]);
    engine.crashOn = null;
    s.core.works.recover();
    await s.core.idle();
    expect(s.ledger.findWorkQuestion("cancel-notice")?.cancellationSubmittedAt).not.toBeNull();
    expect(engine.to(s.child.conversationId!).filter((entry) => entry.requestId === "work-question:cancel-notice:cancelled")).toHaveLength(1);
    expect(engine.attempts.filter((id) => id === "work-question:cancel-notice:cancelled")).toHaveLength(2);
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
    s.core.works.answerChild(s.parent.id, "cap-15", "ANSWER ".repeat(1000));
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
      s.core.works.answerChild(s.parent.id, question.id, "A");
    }
    await s.core.idle();
    expect(() => s.core.works.askParent(s.child.id, "Still over budget", "after-answers")).toThrow("at most 16");
  });
});

describe("structured verification and revision lessons", () => {
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
    expect(childReport.text).toContain("memory_retain if you hold memory tools");
    expect(childReport.text).toContain("future briefs");
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

describe("collaboration migration 6", () => {
  test("fresh databases create questions and empty history", async () => {
    const s = await setup();
    expect(s.ledger.db.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
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
      expect(ledger.db.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
      expect(ledger.work("w").title).toBe("Existing");
      expect(ledger.reviseHistory("w")).toEqual([]);
      expect(ledger.db.query("SELECT revise_history FROM works WHERE id = 'w'").get()).toEqual({ revise_history: "[]" });
      expect(() => ledger.db.query("INSERT INTO work_questions (id,work_id,parent_work_id,question,state,created_at) VALUES ('q','w','w','Q','invalid',1)").run()).toThrow();
    } finally { ledger.close(); }
  });
});
