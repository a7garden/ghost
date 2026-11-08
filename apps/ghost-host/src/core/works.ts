import { Acceptance, TERMINAL_WORK_STATES, validate, type Verdict, type Work, type WorkResult } from "@ghost/contract";
import type { WorkQuestion } from "../ledger/ledger.ts";
import type { Core } from "./core.ts";
import { CommandError, conflict, invalid } from "./errors.ts";
import { digestOf, newId } from "./ids.ts";
import { verifyChecks } from "./verify.ts";

/** Automatic `revise` verdicts allowed before a Work fails. */
export const MAX_REVISIONS = 2;
/** Reminders sent when a work conversation stops without completing. */
const MAX_IDLE_NUDGES = 1;
/** Delegation depth below a root Work. */
export const MAX_DEPTH = 4;
/** Live children per parent. */
export const MAX_LIVE_CHILDREN = 8;

const EMPTY_ACCEPTANCE: Acceptance = { criteria: "", checks: [], reviewer: null };

export const isTerminal = (work: Work) => TERMINAL_WORK_STATES.includes(work.state);

export interface CreateWork {
  ghostId: string;
  title: string;
  brief: string;
  acceptance?: Acceptance;
  deadlineAt?: number | null;
  originConversationId: string;
  /** Deterministic id from a tool call (see `idFor`), so a replayed call finds its Work. */
  id?: string;
}

/**
 * The Work tree and its state machine (docs/architecture.md#work-state-machine).
 * Transitions are synchronous ledger writes; `kick` derives the engine calls.
 */
export class Works {
  constructor(private readonly core: Core) {}

  private get ledger() {
    return this.core.ledger;
  }

  /** A root Work from an owner request. A repeated `id` returns the Work it already created. */
  createRoot(input: CreateWork): Work {
    const existing = input.id ? this.ledger.findWork(input.id) : null;
    if (existing) return existing;
    const ghost = this.ledger.ghost(input.ghostId);
    if (ghost.state !== "active") throw conflict(`${ghost.name} is ${ghost.state}`);
    const origin = this.ledger.conversation(input.originConversationId);
    if (origin.kind !== "direct") throw invalid("a root Work reports to a direct conversation");
    const id = input.id ?? newId();
    const work = this.newWork({ ...input, id, parentId: null, rootId: id });
    this.ledger.tx(() => this.ledger.putWork(work));
    this.kick(work.id);
    return work;
  }

  /** A child Work delegated from a running parent. A repeated `id` returns the child it already created. */
  delegate(parentId: string, input: Omit<CreateWork, "originConversationId">): Work {
    const existing = input.id ? this.ledger.findWork(input.id) : null;
    if (existing) return existing;
    const parent = this.ledger.work(parentId);
    if (parent.state !== "running") throw conflict(`parent Work is ${parent.state}`);
    if (!parent.conversationId) throw conflict("parent Work has no conversation");
    const target = this.ledger.ghost(input.ghostId);
    if (target.deletedAt !== null) throw conflict(`${target.name} was deleted`);
    if (target.state !== "active") throw conflict(`${target.name} is ${target.state}`);
    if (target.id === parent.ghostId) throw conflict("a Work cannot delegate to its own Ghost");
    if (input.acceptance && !validate(Acceptance, input.acceptance)) throw invalid("invalid delegated acceptance checks");
    this.checkReviewer(input.acceptance?.reviewer ?? null, input.ghostId);
    if (this.depth(parent) + 1 > MAX_DEPTH) throw conflict(`delegation deeper than ${MAX_DEPTH} levels`);
    const live = this.ledger.children(parent.id).filter((child) => !isTerminal(child));
    if (live.length >= MAX_LIVE_CHILDREN) throw conflict(`at most ${MAX_LIVE_CHILDREN} live delegations per Work`);
    const deadlineAt = minDeadline(parent.deadlineAt, input.deadlineAt ?? null);
    const work = this.newWork({
      ...input,
      deadlineAt,
      id: input.id ?? newId(),
      parentId: parent.id,
      rootId: parent.rootId,
      originConversationId: parent.conversationId,
    });
    this.ledger.tx(() => this.ledger.putWork(work));
    this.kick(work.id);
    return work;
  }

  private newWork(input: CreateWork & { id: string; parentId: string | null; rootId: string }): Work {
    const now = Date.now();
    return {
      id: input.id,
      parentId: input.parentId,
      rootId: input.rootId,
      ghostId: input.ghostId,
      originConversationId: input.originConversationId,
      conversationId: null,
      title: input.title,
      brief: input.brief,
      acceptance: input.acceptance ?? EMPTY_ACCEPTANCE,
      state: "queued",
      revision: 1,
      revisionsUsed: 0,
      deadlineAt: input.deadlineAt ?? null,
      result: null,
      verdict: null,
      reason: null,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      updatedAt: now,
    };
  }

  private depth(work: Work): number {
    let depth = 0;
    let current = work;
    while (current.parentId) {
      current = this.ledger.work(current.parentId);
      depth++;
    }
    return depth;
  }

  /** Owner edit. Bumps the revision; a running Work receives the change as steering. */
  update(workId: string, change: Partial<Pick<Work, "title" | "brief" | "acceptance" | "deadlineAt">>): Work {
    const work = this.ledger.work(workId);
    if (isTerminal(work)) throw conflict(`Work is ${work.state}`);
    const next: Work = { ...work, ...stripUndefined(change), revision: work.revision + 1, updatedAt: Date.now() };
    this.ledger.tx(() => this.ledger.putWork(next));
    if (next.conversationId && (next.brief !== work.brief || digestOf(next.acceptance) !== digestOf(work.acceptance))) {
      const conversationId = next.conversationId;
      void this.core.lane(`work:${work.id}`, async () => {
        await this.core.openConversation(conversationId);
        await this.core.engine.submit(conversationId, {
          text: `The owner revised this Work (revision ${next.revision}).\n\n${describeWork(next)}`,
          origin: "work",
          requestId: `work:${work.id}:r${next.revision}:revised`,
          steer: true,
        });
      });
    }
    this.kick(work.id);
    return next;
  }

  /** A child asks its delegator before escalating to the owner. */
  askParent(workId: string, question: string, id: string): WorkQuestion {
    const work = this.ledger.work(workId);
    if (!work.parentId) throw invalid("root Works use ask_owner, not ask_parent");
    if (!question.trim() || question.length > 8192) throw invalid("question must contain 1–8192 characters");
    const existing = this.ledger.findWorkQuestion(id);
    if (existing) {
      if (existing.workId !== work.id) throw conflict("question belongs to another Work");
      return existing;
    }
    if (work.state !== "running") throw conflict(`Work is ${work.state}`);
    const parent = this.ledger.work(work.parentId);
    if (isTerminal(parent)) throw conflict(`parent Work is ${parent.state}`);
    const row: WorkQuestion = {
      id, workId, parentWorkId: parent.id, question, answer: null, state: "pending",
      createdAt: Date.now(), answeredAt: null, submittedAt: null, answerSubmittedAt: null,
    };
    this.ledger.tx(() => this.ledger.putWorkQuestion(row));
    this.deliverQuestion(row.id);
    return row;
  }

  answerChild(parentId: string, questionId: string, answer: string): WorkQuestion {
    const parent = this.ledger.work(parentId);
    if (parent.state !== "running" && parent.state !== "waiting") throw conflict(`parent Work is ${parent.state}`);
    const question = this.ledger.findWorkQuestion(questionId);
    if (!question || question.parentWorkId !== parent.id || this.ledger.work(question.workId).parentId !== parent.id) {
      throw invalid("question is not from a child of this Work");
    }
    if (question.state !== "pending") throw conflict(`question is ${question.state}`);
    if (isTerminal(this.ledger.work(question.workId))) throw conflict("child Work has settled");
    if (!answer.trim() || answer.length > 8192) throw invalid("answer must contain 1–8192 characters");
    const next: WorkQuestion = { ...question, answer, state: "answered", answeredAt: Date.now() };
    this.ledger.tx(() => this.ledger.putWorkQuestion(next));
    this.deliverQuestion(next.id);
    return next;
  }

  private pendingQuestion(workId: string) {
    return this.ledger.workQuestions(workId).some((question) => question.state === "pending");
  }

  /** Journal first, submit second, mark last. Pi deduplicates either crash window. */
  private deliverQuestion(id: string) {
    void this.core.lane(`work-question:${id}`, async () => {
      const question = this.ledger.findWorkQuestion(id);
      if (!question || question.state === "cancelled") return;
      const child = this.ledger.work(question.workId);
      const parent = this.ledger.work(question.parentWorkId);
      if (isTerminal(child) || isTerminal(parent)) {
        if (question.state === "pending") this.ledger.tx(() => this.ledger.putWorkQuestion({ ...question, state: "cancelled" }));
        return;
      }
      const answering = question.state === "answered";
      if (answering ? question.answerSubmittedAt !== null : question.submittedAt !== null) return;
      const recipient = answering ? child : parent;
      if (!recipient.conversationId) throw conflict("question recipient has no work conversation");
      await this.core.openConversation(recipient.conversationId);
      await this.core.engine.submit(recipient.conversationId, {
        text: answering
          ? `Your delegating Ghost answered question ${question.id}.\n\n## Question\n${question.question}\n\n## Answer\n${question.answer}\n\nContinue this Work.`
          : `Child Work "${child.title}" (${child.id}) asks question ${question.id}.\n\n${question.question}\n\nAnswer promptly with \`answer_child\` using question_id "${question.id}". If only the owner can decide, use \`ask_owner\` and answer the child when resolved.`,
        origin: "work",
        requestId: `work-question:${question.id}:${answering ? "answer" : "question"}`,
      });
      this.ledger.tx(() => {
        const current = this.ledger.findWorkQuestion(id)!;
        // Cancellation/answering can happen while submit is in flight.
        this.ledger.putWorkQuestion({ ...current, ...(answering ? { answerSubmittedAt: Date.now() } : { submittedAt: Date.now() }) });
        if (!isTerminal(this.ledger.work(recipient.id))) this.resumeFromWaiting(recipient.id);
      });
    });
  }

  /** Cancel a Work and every live descendant, deepest first. */
  cancel(workId: string, reason = "cancelled by the owner") {
    const work = this.ledger.work(workId);
    if (isTerminal(work)) return work;
    for (const child of this.ledger.children(work.id)) this.cancel(child.id, "parent Work cancelled");
    const now = Date.now();
    const next: Work = { ...work, state: "cancelled", reason, endedAt: now, updatedAt: now };
    this.ledger.tx(() => {
      this.ledger.putWork(next);
      this.core.decisions.cancelFor(work.id);
      this.ledger.cancelWorkQuestions(work.id);
    });
    if (work.conversationId) {
      const conversationId = work.conversationId;
      void this.core.lane(`work:${work.id}`, () => this.core.engine.abort(conversationId));
    }
    this.settled(next);
    return next;
  }

  /** Re-queue a failed or blocked root Work. */
  resume(workId: string): Work {
    const work = this.ledger.work(workId);
    if (work.parentId) throw invalid("only a root Work can be resumed");
    if (work.state !== "failed" && work.state !== "blocked") throw conflict(`Work is ${work.state}`);
    if (this.core.effects.unresolved(work.id).length > 0) throw conflict("reconcile the unknown effect first");
    const now = Date.now();
    const next: Work = {
      ...work,
      state: work.conversationId ? "running" : "queued",
      revision: work.revision + 1,
      revisionsUsed: 0,
      verdict: null,
      reason: null,
      endedAt: null,
      updatedAt: now,
    };
    this.ledger.tx(() => {
      this.ledger.putWork(next);
      this.ledger.setIdleNudges(work.id, 0);
      this.ledger.markReported(work.id, null);
    });
    if (next.state === "running" && next.conversationId) {
      const conversationId = next.conversationId;
      void this.core.lane(`work:${work.id}`, async () => {
        await this.core.openConversation(conversationId);
        await this.core.engine.submit(conversationId, {
          text: `The owner resumed this Work (revision ${next.revision}). Continue from where you stopped.\n\n${describeWork(next)}`,
          origin: "work",
          requestId: `work:${work.id}:r${next.revision}:resumed`,
        });
      });
    }
    this.kick(work.id);
    return next;
  }

  /** Tool `complete`: the assignee claims a result. Verification decides. */
  complete(workId: string, result: WorkResult): Work {
    const work = this.ledger.work(workId);
    if (work.state !== "running") throw conflict(`Work is ${work.state}`);
    if (this.ledger.children(work.id).some((child) => !isTerminal(child))) throw conflict("delegated Work is still live; wait for it before completing");
    if (this.pendingQuestion(work.id)) throw conflict("a question to the parent is pending; wait for its answer before completing");
    if (this.core.effects.unresolved(work.id).length > 0) throw conflict("an effect of this Work is unresolved");
    for (const artifact of result.artifacts) {
      if (!this.core.artifacts.has(artifact.digest) || !this.ledger.artifactWorkIds(artifact.digest).includes(work.id)) {
        throw invalid(`artifact ${artifact.name} was not published by this Work`);
      }
    }
    const next: Work = { ...work, state: "verifying", result, verdict: null, updatedAt: Date.now() };
    this.ledger.tx(() => this.ledger.putWork(next));
    this.kick(work.id);
    return next;
  }

  /** A verdict from checks, a reviewer or the owner. */
  applyVerdict(workId: string, verdict: Verdict) {
    const work = this.ledger.work(workId);
    if (work.state !== "verifying") return work;
    const now = Date.now();
    let next: Work;
    if (verdict.outcome === "pass") {
      next = { ...work, state: "done", verdict, endedAt: now, updatedAt: now };
    } else if (verdict.outcome === "revise" && work.revisionsUsed < MAX_REVISIONS) {
      next = { ...work, state: "running", verdict, revisionsUsed: work.revisionsUsed + 1, updatedAt: now };
    } else {
      next = { ...work, state: "failed", verdict, reason: verdict.reasons || "verification failed", endedAt: now, updatedAt: now };
    }
    this.ledger.tx(() => {
      this.ledger.putWork(next);
      if (verdict.outcome === "revise") this.ledger.appendReviseHistory(work.id, verdict);
      this.core.decisions.cancelFor(work.id, "accept_result");
      if (next.state === "running") this.ledger.setIdleNudges(work.id, 0);
    });
    if (next.state === "running" && next.conversationId) {
      const conversationId = next.conversationId;
      void this.core.lane(`work:${work.id}`, () =>
        this.core.engine.submit(conversationId, {
          text: [
            `Verification asked for a revision (${verdict.source}).`,
            `## Reasons\n${verdict.reasons}`,
            verdict.evidence === undefined ? "" : `## Evidence\n${verdict.evidence}`,
            verdict.scope === undefined ? "" : `## Scope\n${verdict.scope}`,
            "Change only what the scope allows; leave unrelated behavior untouched. Fix the result and call complete again.",
          ].filter(Boolean).join("\n\n"),
          origin: "verdict",
          requestId: `work:${work.id}:verdict:${next.revisionsUsed}`,
        }),
      );
    }
    if (isTerminal(next)) this.settled(next);
    if (isTerminal(next)) this.ledger.tx(() => this.ledger.cancelWorkQuestions(next.id));
    return next;
  }

  /** Mark a live Work failed (deadline, engine error, refusal). */
  fail(workId: string, reason: string) {
    const work = this.ledger.work(workId);
    if (isTerminal(work)) return work;
    for (const child of this.ledger.children(work.id)) this.cancel(child.id, "parent Work failed");
    const now = Date.now();
    const next: Work = { ...work, state: "failed", reason, endedAt: now, updatedAt: now };
    this.ledger.tx(() => {
      this.ledger.putWork(next);
      this.core.decisions.cancelFor(work.id);
      this.ledger.cancelWorkQuestions(work.id);
    });
    if (work.conversationId) {
      const conversationId = work.conversationId;
      void this.core.lane(`work:${work.id}`, () => this.core.engine.abort(conversationId));
    }
    this.settled(next);
    return next;
  }

  /** An unknown effect stops the Work, and its conversation, until the owner reconciles it. */
  block(workId: string, reason: string) {
    const work = this.ledger.work(workId);
    if (isTerminal(work) || work.state === "blocked") return;
    this.ledger.tx(() => this.ledger.putWork({ ...work, state: "blocked", reason, updatedAt: Date.now() }));
    if (work.conversationId) {
      const conversationId = work.conversationId;
      void this.core.lane(`work:${work.id}`, () => this.core.engine.abort(conversationId));
    }
  }

  /** The owner settled the blocking effect; continue the run. */
  unblock(workId: string, note: string) {
    const work = this.ledger.work(workId);
    if (work.state !== "blocked" || this.core.effects.unresolved(work.id).length > 0) return;
    this.ledger.tx(() => {
      this.ledger.putWork({ ...work, state: "running", reason: null, updatedAt: Date.now() });
      this.ledger.setIdleNudges(work.id, 0);
    });
    if (work.conversationId) {
      const conversationId = work.conversationId;
      void this.core.lane(`work:${work.id}`, () =>
        this.core.engine.submit(conversationId, { text: note, origin: "decision", requestId: `work:${work.id}:unblocked:${digestOf(note).slice(0, 16)}` }),
      );
    }
  }

  /** The work conversation finished a run. */
  onIdle(workId: string) {
    const work = this.ledger.work(workId);
    if (work.state !== "running") return;
    const liveChildren = this.ledger.children(work.id).some((child) => !isTerminal(child));
    const pending = this.ledger.pendingDecisions({ workId: work.id }).length > 0;
    if (liveChildren || pending || this.pendingQuestion(work.id)) {
      this.ledger.tx(() => this.ledger.putWork({ ...work, state: "waiting", updatedAt: Date.now() }));
      this.kick(work.id);
      return;
    }
    const nudges = this.ledger.idleNudges(work.id);
    if (nudges >= MAX_IDLE_NUDGES) {
      this.fail(work.id, "the Ghost stopped without completing the Work");
      return;
    }
    this.ledger.tx(() => this.ledger.setIdleNudges(work.id, nudges + 1));
    const conversationId = work.conversationId!;
    void this.core.lane(`work:${work.id}`, () =>
      this.core.engine.submit(conversationId, {
        text: `You stopped without finishing. Call \`complete\` with the result, \`delegate\` part of the Work, or \`${work.parentId ? "ask_parent" : "ask_owner"}\` if you are blocked.`,
        origin: "work",
        requestId: `work:${work.id}:r${work.revision}:v${work.revisionsUsed}:nudge:${nudges + 1}`,
      }),
    );
  }

  /** The review conversation finished without a verdict: the owner decides. */
  onReviewIdle(workId: string) {
    const work = this.ledger.work(workId);
    if (work.state !== "verifying") return;
    this.ledger.tx(() => this.core.decisions.openAcceptance(work, "The reviewer did not return a verdict."));
  }

  /** Enforce deadlines. Called by the scheduler tick. */
  expire(now: number) {
    for (const work of this.ledger.worksInState("queued", "running", "waiting", "verifying", "blocked")) {
      if (work.deadlineAt !== null && work.deadlineAt <= now) this.fail(work.id, "the deadline passed");
    }
  }

  /**
   * Derive and perform the engine calls the Work's current state requires.
   * Safe to call any number of times: every submission has a deterministic request id.
   */
  kick(workId: string) {
    void this.core.lane(`work:${workId}`, () => this.reconcile(workId));
  }

  private async reconcile(workId: string) {
    const work = this.ledger.work(workId);
    switch (work.state) {
      case "queued":
        return this.start(work);
      case "waiting":
        return this.wake(work);
      case "verifying":
        return this.verify(work);
      case "done":
      case "failed":
      case "cancelled":
        return this.report(work);
      case "running":
        // A crash between the state change and the first submission leaves a running Work
        // with a silent conversation; the start request id makes this a no-op otherwise.
        if (!work.conversationId) return;
        await this.core.openConversation(work.conversationId);
        await this.core.engine.submit(work.conversationId, { text: describeWork(work), origin: "work", requestId: `work:${work.id}:start` });
        return;
      case "blocked":
        return;
    }
  }

  private async start(work: Work) {
    let conversationId = work.conversationId;
    if (!conversationId) {
      const conversation = this.core.newConversation(work.ghostId, "work", work.id, work.title);
      conversationId = conversation.id;
      const now = Date.now();
      this.ledger.tx(() => {
        this.ledger.putConversation(conversation);
        this.ledger.putWork({ ...work, conversationId: conversation.id, state: "running", startedAt: now, updatedAt: now });
      });
    } else {
      const now = Date.now();
      this.ledger.tx(() => this.ledger.putWork({ ...work, state: "running", startedAt: work.startedAt ?? now, updatedAt: now }));
    }
    await this.core.openConversation(conversationId);
    await this.core.engine.submit(conversationId, {
      text: describeWork(work),
      origin: "work",
      requestId: `work:${work.id}:start`,
    });
  }

  /** Crash recovery for a waiting Work whose children and decisions all settled while the host was down. */
  private async wake(work: Work) {
    const children = this.ledger.children(work.id);
    if (children.some((child) => !isTerminal(child))) return;
    if (this.ledger.pendingDecisions({ workId: work.id }).length > 0) return;
    if (this.pendingQuestion(work.id)) return;
    for (const child of children) await this.notifyParent(child);
    if (children.length > 0) return;
    this.resumeFromWaiting(work.id);
    await this.core.engine.submit(work.conversationId!, {
      text: "Nothing you were waiting on is pending any more. Continue.",
      origin: "work",
      requestId: `work:${work.id}:wake:${work.updatedAt}`,
    });
  }

  /** Back to running from waiting; a no-op in any other state. */
  resumeFromWaiting(workId: string) {
    const work = this.ledger.work(workId);
    if (work.state !== "waiting") return;
    this.ledger.tx(() => {
      this.ledger.putWork({ ...work, state: "running", updatedAt: Date.now() });
      this.ledger.setIdleNudges(work.id, 0);
    });
  }

  /** Deliver a settled child's outcome to its parent's conversation. Idempotent per child state. */
  private async notifyParent(child: Work) {
    if (!child.parentId) return;
    const parent = this.ledger.work(child.parentId);
    if (isTerminal(parent) || !parent.conversationId) return;
    const artifacts = child.state === "done" ? (child.result?.artifacts ?? []) : [];
    if (artifacts.length > 0 && this.core.sandbox.stageInputs) {
      await this.core.sandbox.stageInputs(parent, artifacts.map((artifact) => ({ childId: child.id, name: artifact.name, digest: artifact.digest })));
    }
    this.resumeFromWaiting(parent.id);
    const staged = artifacts.length > 0 && this.core.sandbox.stageInputs ? `\n\nIts files are in inputs/${child.id}/ in your workspace.` : "";
    await this.core.engine.submit(parent.conversationId, {
      text: this.describeReport(child) + staged,
      origin: "child_result",
      requestId: `work:${parent.id}:child:${child.id}:${child.state}:${child.revision}`,
    });
  }

  private async verify(work: Work) {
    if (!work.result) {
      this.fail(work.id, "verification started without a result");
      return;
    }
    const checks = this.inheritedChecks(work);
    if (checks.length > 0) {
      const outcome = await verifyChecks(this.core, work, checks);
      if (!outcome.pass || !work.parentId) {
        this.applyVerdict(work.id, { outcome: outcome.pass ? "pass" : "revise", source: "checks", reasons: outcome.reasons, at: Date.now() });
        return;
      }
    }
    // Child checks gate review; owner-authored root checks still decide acceptance.
    // Without an explicit reviewer, only a root Work falls through to the owner.
    const reviewer = work.acceptance.reviewer;
    if (reviewer || work.parentId) {
      await this.startReview(work, this.reviewerGhost(work));
      return;
    }
    this.ledger.tx(() => this.core.decisions.openAcceptance(work, null));
  }

  /** Checks come from the Work's own owner/parent-authored spec; a model never writes its own. */
  private inheritedChecks(work: Work) {
    return work.acceptance.checks;
  }

  /** A named reviewer must be an active, non-deleted Ghost other than the assignee. */
  private checkReviewer(reviewer: Acceptance["reviewer"], assigneeId: string) {
    if (reviewer?.kind !== "ghost") return;
    const ghost = this.ledger.ghost(reviewer.ghostId);
    if (ghost.deletedAt !== null) throw conflict(`${ghost.name} was deleted`);
    if (ghost.state !== "active") throw conflict(`${ghost.name} is ${ghost.state}`);
    if (ghost.id === assigneeId) throw invalid("the reviewer must be a Ghost other than the assignee");
  }

  /**
   * Which Ghost hosts the review conversation: the named reviewer Ghost; for a model reviewer
   * a Ghost other than the assignee (the delegator, else the default Ghost) so the result is
   * never judged under the producer's identity; for a child without one, its delegator.
   */
  private reviewerGhost(work: Work): string {
    const reviewer = work.acceptance.reviewer;
    if (reviewer?.kind === "ghost") return reviewer.ghostId;
    if (work.parentId) return this.ledger.work(work.parentId).ghostId;
    const fallback = this.ledger.defaultGhost();
    if (fallback && fallback.id !== work.ghostId) return fallback.id;
    return this.ledger.ghosts().find((ghost) => ghost.state === "active" && ghost.id !== work.ghostId)?.id ?? work.ghostId;
  }

  /** One review conversation per Work, kept even if the reviewer is edited later. */
  private async startReview(work: Work, reviewerGhostId: string) {
    const existing = this.ledger.conversations({ kind: "review" }).find((conversation) => conversation.workId === work.id);
    let conversationId = existing?.id;
    if (!conversationId) {
      const conversation = this.core.newConversation(reviewerGhostId, "review", work.id, `Review: ${work.title}`);
      conversationId = conversation.id;
      this.ledger.tx(() => this.ledger.putConversation(conversation));
    }
    await this.core.openConversation(conversationId);
    await this.core.engine.submit(conversationId, {
      text: describeReview(work),
      origin: "work",
      requestId: `review:${work.id}:r${work.revision}:v${work.revisionsUsed}`,
    });
  }

  private settled(work: Work) {
    this.kick(work.id);
  }


  private describeReport(work: Work) {
    const history = this.ledger.reviseHistory(work.id);
    if (history.length === 0) return describeOutcome(work);
    const compact = history.slice(-8).map((lesson, index) => [
      `${index + 1}. ${lesson.source}: ${lesson.reasons.slice(0, 600)}`,
      lesson.evidence ? `Evidence: ${lesson.evidence.slice(0, 400)}` : "",
      lesson.scope ? `Scope: ${lesson.scope.slice(0, 400)}` : "",
    ].filter(Boolean).join("\n")).join("\n\n");
    return `${describeOutcome(work)}\n\n## Revision history (${history.length} retained)\n${compact}\n\nKeep any durable constraint these revisions imply: use memory_retain if you hold memory tools; otherwise carry it into future briefs.`;
  }
  /** A settled Work reports to whoever waits: its parent's conversation, or the owner for a root Work. */
  private async report(work: Work) {
    if (this.core.sandbox.release) {
      try {
        await this.core.sandbox.release(work);
      } catch (error) {
        this.core.log(`releasing the sandbox of ${work.id} failed`, error);
      }
    }
    if (work.parentId) {
      await this.notifyParent(work);
    } else {
      if (work.state !== "cancelled") {
        this.ledger.tx(() =>
          this.core.notify({
            id: `work:${work.id}:${work.state}:${work.revision}`,
            kind: work.state === "done" ? "work_done" : "work_failed",
            ghostId: work.ghostId,
            conversationId: work.originConversationId,
            workId: work.id,
            decisionId: null,
            title: work.title,
            body: work.state === "done" ? (work.result?.summary ?? "").slice(0, 500) : (work.reason ?? "failed"),
          }),
        );
      }
      try {
        await this.core.engine.submit(work.originConversationId, {
          text: this.describeReport(work),
          origin: "report",
          requestId: `work:${work.id}:report:${work.state}:${work.revision}`,
        });
      } catch (error) {
        // A refusal (no model, no credential) is final for this report; the notification stands.
        if (!(error instanceof CommandError)) throw error;
        this.core.log(`report of ${work.id} not delivered`, error.message);
      }
    }
    this.ledger.tx(() => this.ledger.markReported(work.id, Date.now()));
  }

  /** Startup: deliver reports a crash cut off, and wake running Work whose wake was lost. */
  recover() {
    for (const question of this.ledger.workQuestionsAwaitingSubmission()) this.deliverQuestion(question.id);
    for (const work of this.ledger.unreportedWorks()) this.kick(work.id);
    for (const work of this.ledger.worksInState("running")) {
      const conversation = work.conversationId ? this.ledger.findConversation(work.conversationId) : null;
      // A busy conversation is resumed by the engine; an idle one may have lost the wake that
      // a transition committed just before the crash (resume, unblock, child result, revise).
      if (!conversation || conversation.busy) continue;
      const conversationId = conversation.id;
      void this.core.lane(`work:${work.id}`, () =>
        this.core.engine.submit(conversationId, {
          text: `The host restarted. Continue this Work from where you stopped; call \`work_status\` if you need to see what changed.\n\n${describeWork(work)}`,
          origin: "work",
          requestId: `work:${work.id}:recover:${work.updatedAt}`,
        }),
      );
    }
  }
}

function minDeadline(a: number | null, b: number | null) {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

export function describeWork(work: Work) {
  const parts = [`# ${work.title}`, work.brief];
  if (work.acceptance.criteria) parts.push(`## Done when\n${work.acceptance.criteria}`);
  if (work.acceptance.checks.length) {
    parts.push(`## Checked automatically\n${work.acceptance.checks.map((check) => `- ${JSON.stringify(check)}`).join("\n")}`);
  }
  if (work.deadlineAt) parts.push(`Deadline: ${new Date(work.deadlineAt).toISOString()}`);
  return parts.join("\n\n");
}

export function describeOutcome(work: Work) {
  const head = `Work "${work.title}" (${work.id}) is ${work.state}.`;
  if (work.state === "done" && work.result) {
    const artifacts = work.result.artifacts.map((artifact) => `- ${artifact.name} (${artifact.digest.slice(0, 12)}, ${artifact.size} bytes)`).join("\n");
    return [head, work.result.summary, artifacts && `Artifacts:\n${artifacts}`].filter(Boolean).join("\n\n");
  }
  return [head, work.reason].filter(Boolean).join("\n\n");
}

function describeReview(work: Work) {
  const result = work.result!;
  return [
    `Review the result of this Work and call \`verdict\` once.`,
    describeWork(work),
    `## Result\n${result.summary}`,
    result.artifacts.length ? `## Artifacts\n${result.artifacts.map((artifact) => `- ${artifact.name} (${artifact.digest})`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
