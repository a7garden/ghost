import { TERMINAL_WORK_STATES, type Acceptance, type ExecutionTarget, type GhostTool, type Verdict, type Work, type WorkResult } from "@ghost/contract";
import type { Core } from "./core.ts";
import { CommandError, conflict, invalid } from "./errors.ts";
import { digestOf, newId } from "./ids.ts";
import { verifyChecks } from "./verify.ts";
import { validateExecutionTarget } from "../sandbox/index.ts";

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
  execution?: ExecutionTarget;
  activityId?: string;
  activityRunId?: string;
  toolScope?: GhostTool[];
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
    this.checkExecution(input.ghostId, input.execution);
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
    this.checkReviewer(input.acceptance?.reviewer ?? null, input.ghostId);
    if (this.depth(parent) + 1 > MAX_DEPTH) throw conflict(`delegation deeper than ${MAX_DEPTH} levels`);
    const live = this.ledger.children(parent.id).filter((child) => !isTerminal(child));
    if (live.length >= MAX_LIVE_CHILDREN) throw conflict(`at most ${MAX_LIVE_CHILDREN} live delegations per Work`);
    const deadlineAt = minDeadline(parent.deadlineAt, input.deadlineAt ?? null);
    if (parent.activityId) this.core.activities.authorize(parent.id, "delegate");
    if (input.execution?.kind === "host" && parent.execution?.kind !== "host") throw invalid("delegation cannot elevate container work to PC execution");
    const execution = input.execution ?? (parent.execution?.kind === "host" && !target.hostExecution ? { kind: "container" as const } : parent.execution);
    this.checkExecution(target.id, execution);
    const toolScope = (input.toolScope ?? parent.toolScope)?.filter((tool) => (!parent.toolScope || parent.toolScope.includes(tool)) && target.tools.includes(tool));
    const work = this.newWork({
      ...input,
      deadlineAt,
      id: input.id ?? newId(),
      parentId: parent.id,
      rootId: parent.rootId,
      originConversationId: parent.conversationId,
      execution,
      activityId: parent.activityId,
      activityRunId: parent.activityRunId,
      toolScope,
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
      ...(input.execution ? { execution: input.execution } : {}),
      ...(input.activityId ? { activityId: input.activityId } : {}),
      ...(input.activityRunId ? { activityRunId: input.activityRunId } : {}),
      ...(input.toolScope ? { toolScope: input.toolScope } : {}),
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

  private checkExecution(ghostId: string, execution: ExecutionTarget | undefined) {
    if (!execution) return;
    if (execution.kind === "host" && !this.ledger.ghost(ghostId).hostExecution) throw invalid("the owner has not granted this Ghost direct PC execution");
    try { validateExecutionTarget(execution); }
    catch (error) { throw invalid(error instanceof Error ? error.message : "invalid execution target"); }
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
      this.core.decisions.cancelFor(work.id, "accept_result");
      if (next.state === "running") this.ledger.setIdleNudges(work.id, 0);
    });
    if (next.state === "running" && next.conversationId) {
      const conversationId = next.conversationId;
      void this.core.lane(`work:${work.id}`, () =>
        this.core.engine.submit(conversationId, {
          text: `Verification asked for a revision (${verdict.source}):\n${verdict.reasons}\n\nFix the result and call complete again.`,
          origin: "verdict",
          requestId: `work:${work.id}:verdict:${next.revisionsUsed}`,
        }),
      );
    }
    if (isTerminal(next)) this.settled(next);
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
    if (liveChildren || pending) {
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
        text: "You stopped without finishing. Call `complete` with the result, `delegate` part of the Work, or `ask_owner` if you are blocked.",
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
        await this.core.engine.submit(work.conversationId, { text: this.input(work), origin: "work", requestId: `work:${work.id}:start` });
        return;
      case "blocked":
        return;
    }
  }

  private input(work: Work): string {
    return [describeWork(work), work.activityId ? this.core.activities.context(work) : ""].filter(Boolean).join("\n\n");
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
      text: this.input(work),
      origin: "work",
      requestId: `work:${work.id}:start`,
    });
  }

  /** Crash recovery for a waiting Work whose children and decisions all settled while the host was down. */
  private async wake(work: Work) {
    const children = this.ledger.children(work.id);
    if (children.some((child) => !isTerminal(child))) return;
    if (this.ledger.pendingDecisions({ workId: work.id }).length > 0) return;
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
    const inputRoot = parent.execution?.kind === "host" ? `${this.core.sandbox.workspacePath?.(parent) ?? ""}/inputs/${child.id}/` : `inputs/${child.id}/`;
    const staged = artifacts.length > 0 && this.core.sandbox.stageInputs ? `\n\nIts files are in ${inputRoot} in your Work's staging workspace.` : "";
    await this.core.engine.submit(parent.conversationId, {
      text: describeOutcome(child) + staged,
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
      this.applyVerdict(work.id, { outcome: outcome.pass ? "pass" : "revise", source: "checks", reasons: outcome.reasons, at: Date.now() });
      return;
    }
    // Without checks or an explicit reviewer, a child is judged by the Ghost that delegated it;
    // only a root Work falls through to the owner.
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
      text: [describeReview(work), work.activityId ? this.core.activities.context(work) : ""].filter(Boolean).join("\n\n"),
      origin: "work",
      requestId: `review:${work.id}:r${work.revision}:v${work.revisionsUsed}`,
    });
  }

  private settled(work: Work) {
    this.kick(work.id);
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
      const activityOutcome = work.activityId ? this.core.activities.settled(work) : { notify: true };
      if (!activityOutcome.notify) {
        this.ledger.tx(() => this.ledger.markReported(work.id, Date.now()));
        return;
      }
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
      // Automated outcomes remain inspectable data, not new direct turns with the Ghost's full authority.
      if (!work.activityId) {
        try {
          await this.core.engine.submit(work.originConversationId, {
            text: describeOutcome(work),
            origin: "report",
            requestId: `work:${work.id}:report:${work.state}:${work.revision}`,
          });
        } catch (error) {
          // A refusal (no model, no credential) is final for this report; the notification stands.
          if (!(error instanceof CommandError)) throw error;
          this.core.log(`report of ${work.id} not delivered`, error.message);
        }
      }
    }
    this.ledger.tx(() => this.ledger.markReported(work.id, Date.now()));
  }

  /** Startup: deliver reports a crash cut off, and wake running Work whose wake was lost. */
  recover() {
    for (const work of this.ledger.unreportedWorks()) this.kick(work.id);
    for (const work of this.ledger.worksInState("running")) {
      const conversation = work.conversationId ? this.ledger.findConversation(work.conversationId) : null;
      // A busy conversation is resumed by the engine; an idle one may have lost the wake that
      // a transition committed just before the crash (resume, unblock, child result, revise).
      if (!conversation || conversation.busy) continue;
      const conversationId = conversation.id;
      void this.core.lane(`work:${work.id}`, () =>
        this.core.engine.submit(conversationId, {
          text: `The host restarted. Continue this Work from where you stopped; call \`work_status\` if you need to see what changed.\n\n${this.input(work)}`,
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
