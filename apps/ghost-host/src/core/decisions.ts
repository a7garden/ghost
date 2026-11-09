import type { Decision, Work } from "@ghost/contract";
import type { Core } from "./core.ts";
import { NoEffect } from "./effects.ts";
import { conflict, invalid } from "./errors.ts";
import { newId } from "./ids.ts";

export type OpenDecision = Omit<Decision, "id" | "state" | "answer" | "createdAt" | "resolvedAt">;

export type Resolution = { outcome: "approve" | "deny" | "answer"; answer?: string };

/** The answer a question settles to when the owner does not reply within `waitMs`. */
export interface QuestionFallback {
  answer: string;
  waitMs: number;
}

/**
 * A question's `proposal` holds its default and when it applies; the ledger never rewrites a proposal.
 * `defaulted` is derived: answered with the default at or after the wait ended. An owner reply that
 * lands after the wait with the same text means the same thing, so the two need no distinction.
 */
export interface QuestionDefault {
  default: string;
  expiresAt: number;
  defaulted: boolean;
}

export function questionDefault(decision: Decision): QuestionDefault | null {
  if (decision.kind !== "question" || !decision.proposal) return null;
  const { default: answer, expiresAt } = decision.proposal;
  if (typeof answer !== "string" || typeof expiresAt !== "number") return null;
  const defaulted = decision.state === "answered" && decision.answer === answer && decision.resolvedAt !== null && decision.resolvedAt >= expiresAt;
  return { default: answer, expiresAt, defaulted };
}

/** Owner decisions. Opening one notifies; resolving one wakes whoever waits on it. */
export class Decisions {
  /** Applies an approved document proposal; registered by the documents integration. */
  private documentApplier: ((decision: Decision) => Promise<string>) | null = null;

  constructor(private readonly core: Core) {}

  private get ledger() {
    return this.core.ledger;
  }

  onDocumentApproved(apply: (decision: Decision) => Promise<string>) {
    this.documentApplier = apply;
  }

  /**
   * Must run inside a ledger transaction. `notify: false` is for a decision the owner's standing grant
   * settles at once: it stays as the record of what was done, without asking anyone.
   */
  open(input: OpenDecision & { id?: string }, options: { notify?: boolean } = {}): Decision {
    const decision: Decision = { ...input, id: input.id ?? newId(), state: "pending", answer: null, createdAt: Date.now(), resolvedAt: null };
    this.ledger.putDecision(decision);
    if (options.notify === false) return decision;
    this.core.notify({
      id: `decision:${decision.id}`,
      kind: "decision",
      ghostId: decision.ghostId,
      conversationId: decision.conversationId,
      workId: decision.workId,
      decisionId: decision.id,
      title: decision.title,
      body: decision.detail.slice(0, 500),
    });
    return decision;
  }

  /** Must run inside a ledger transaction. */
  openAcceptance(work: Work, note: string | null) {
    if (this.ledger.pendingDecisions({ workId: work.id }).some((decision) => decision.kind === "accept_result")) return;
    this.open({
      kind: "accept_result",
      ghostId: work.ghostId,
      conversationId: work.conversationId ?? work.originConversationId,
      workId: work.id,
      effectId: null,
      title: `「${work.title}」 결과 확인`,
      detail: [note, work.result?.summary].filter(Boolean).join("\n\n"),
      options: [],
      proposal: work.result ? { result: work.result, criteria: work.acceptance.criteria } : null,
    });
  }

  /**
   * A question from a Ghost. Returns the decision; the answer arrives as a submission.
   * With a `fallback`, an unanswered question settles itself to the default once the wait ends
   * (`expire`), so a Ghost does not stand still while the owner is away.
   */
  ask(conversationId: string, title: string, detail: string, options: string[], id?: string, fallback?: QuestionFallback): Decision {
    const existing = id ? this.ledger.findDecision(id) : null;
    if (existing) return existing;
    const conversation = this.ledger.conversation(conversationId);
    const proposal = fallback ? { default: fallback.answer, expiresAt: Date.now() + fallback.waitMs } : null;
    return this.ledger.tx(() =>
      this.open({
        id,
        kind: "question",
        ghostId: conversation.ghostId,
        conversationId,
        workId: conversation.workId,
        effectId: null,
        title,
        detail,
        options,
        proposal,
      }),
    );
  }

  /**
   * Settle every pending question whose wait ended to its default. Called by the scheduler tick.
   * The answer commits first; the follow-up is the ordinary idempotent one, so `recover` finishes it after a crash.
   */
  expire(now: number) {
    for (const pending of this.ledger.pendingDecisions()) {
      const fallback = questionDefault(pending);
      if (!fallback || fallback.expiresAt > now) continue;
      const resolved = this.ledger.tx(() => {
        // The owner may have answered since the list was read.
        const current = this.ledger.decision(pending.id);
        if (current.state !== "pending") return null;
        const next: Decision = { ...current, state: "answered", answer: fallback.default, resolvedAt: Math.max(now, fallback.expiresAt) };
        this.ledger.putDecision(next);
        return next;
      });
      if (resolved) void this.core.lane(`decision:${resolved.id}`, () => this.followUp(resolved));
    }
  }

  /**
   * Cancel pending decisions of a Work (optionally one kind). Must run inside a transaction.
   * An unknown effect's reconciliation stays open: the truth about it is still owed.
   */
  cancelFor(workId: string, kind?: Decision["kind"]) {
    for (const decision of this.ledger.pendingDecisions({ workId })) {
      if (kind ? decision.kind !== kind : decision.kind === "reconcile_effect") continue;
      this.ledger.putDecision({ ...decision, state: "cancelled", resolvedAt: Date.now() });
    }
  }

  async resolve(decisionId: string, resolution: Resolution) {
    const resolved = this.resolveState(decisionId, resolution);
    await this.followUp(resolved);
  }

  /** Commit the owner's answer before external follow-ups; API receipts join this transaction. */
  resolveState(decisionId: string, resolution: Resolution): Decision {
    const decision = this.ledger.decision(decisionId);
    if (decision.state !== "pending") throw conflict(`decision is already ${decision.state}`);
    const state = stateFor(decision, resolution);
    const resolved: Decision = { ...decision, state, answer: resolution.answer ?? null, resolvedAt: Date.now() };
    this.ledger.tx(() => this.ledger.putDecision(resolved));
    return resolved;
  }

  /** Retry only domain-journaled follow-ups, never the already committed resolution. */
  async finishResolution(decisionId: string) {
    const decision = this.ledger.decisionsAwaitingFollowUp().find((item) => item.id === decisionId);
    if (decision) await this.followUp(decision);
  }

  /** Startup: finish follow-ups a crash interrupted after the owner's answer was committed. */
  async recover() {
    for (const decision of this.ledger.decisionsAwaitingFollowUp()) await this.followUp(decision);
  }

  /**
   * Act on a resolved decision. Every step is idempotent (guarded state transitions,
   * deterministic request ids, journaled writes), so a replay after a crash is safe.
   */
  private async followUp(decision: Decision) {
    switch (decision.kind) {
      case "question":
        if (decision.state === "cancelled") break;
        await this.answerQuestion(decision);
        break;
      case "accept_result":
        if (!decision.workId || decision.state === "cancelled") break;
        this.core.works.applyVerdict(decision.workId, {
          outcome: decision.state === "approved" ? "pass" : "revise",
          source: "owner",
          reasons: decision.answer ?? (decision.state === "approved" ? "사용자가 결과를 받아들였어요." : "사용자가 수정을 요청했어요."),
          at: decision.resolvedAt ?? Date.now(),
        });
        break;
      case "approve_effect":
        if (decision.effectId && decision.state !== "cancelled") await this.core.effects.resolveApproval(decision.effectId, decision.state === "approved");
        break;
      case "reconcile_effect":
        if (decision.effectId && decision.state !== "cancelled") this.core.effects.reconcile(decision.effectId, decision.state === "approved", decision.answer);
        break;
      case "document_review":
        if (decision.state !== "cancelled") await this.reviewDocument(decision);
        break;
    }
    this.ledger.tx(() => this.ledger.markFollowedUp(decision.id, Date.now()));
  }

  private async answerQuestion(decision: Decision) {
    const text = questionDefault(decision)?.defaulted
      ? `The owner did not answer "${decision.title}" in time. Continue with your default: ${decision.answer ?? ""}. Say in your result that you assumed it, so the owner can correct it.`
      : decision.state === "answered"
        ? `The owner answered "${decision.title}": ${decision.answer ?? ""}`
        : `The owner declined to answer "${decision.title}".`;
    if (decision.workId) this.core.works.resumeFromWaiting(decision.workId);
    await this.core.engine.submit(decision.conversationId, { text, origin: "decision", requestId: `decision:${decision.id}` });
  }

  /** The vault write is a journaled effect: a crash mid-write becomes an unknown the owner reconciles, never a second write. */
  private async reviewDocument(decision: Decision) {
    let text: string;
    if (decision.state !== "approved") text = `The owner declined the document proposal "${decision.title}".${decision.answer ? ` ${decision.answer}` : ""}`;
    else if (!this.documentApplier) text = `The document proposal "${decision.title}" was approved but no document space is available; nothing was saved.`;
    else {
      const apply = this.documentApplier;
      try {
        text = await this.core.effects.run(
          { conversationId: decision.conversationId, callId: `decision:${decision.id}`, tool: "document_write", input: decision.proposal, summary: `save "${decision.title}"` },
          async () => {
            try {
              return await apply(decision);
            } catch (error) {
              // The adapter checks before it writes and writes atomically: a thrown error means nothing was saved.
              throw new NoEffect(error instanceof Error ? error.message : String(error));
            }
          },
        );
      } catch (error) {
        text = `The approved document "${decision.title}" could not be saved: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    await this.core.engine.submit(decision.conversationId, { text, origin: "decision", requestId: `decision:${decision.id}` });
  }
}

function stateFor(decision: Decision, resolution: Resolution): Decision["state"] {
  if (resolution.outcome === "answer") {
    if (decision.kind !== "question") throw invalid("only a question takes an answer");
    if (!resolution.answer) throw invalid("answer text is required");
    return "answered";
  }
  return resolution.outcome === "approve" ? "approved" : "denied";
}
