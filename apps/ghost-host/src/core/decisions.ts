import { DESTRUCTIVE_RISK, reviewOf, type Decision, type DecisionReview, type VaultItem, type Work } from "@ghost/contract";
import type { Core } from "./core.ts";
import { NoEffect } from "./effects.ts";
import { conflict, invalid } from "./errors.ts";
import { newId } from "./ids.ts";

export type OpenDecision = Omit<Decision, "id" | "state" | "answer" | "createdAt" | "resolvedAt">;

export type Resolution = { outcome: "approve" | "deny" | "answer"; answer?: string };

/** Who settled a decision: the owner, the main Ghost for them, or the Host after the owner's wait ran out. */
export type ResolvedBy = "owner" | "main" | "timeout";

const MINUTE = 60_000;

/** Owner decisions. Opening one notifies; resolving one wakes whoever waits on it. */
export class Decisions {
  /** Applies an approved document proposal; registered by the documents integration. */
  private documentApplier: ((decision: Decision) => Promise<string>) | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly core: Core) {}

  /** Settle reversible decisions whose wait ran out; started with the Host, checked twice a minute. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.settleExpired().catch((error) => this.core.log("decision auto-settle failed", String(error))), 30_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private get ledger() {
    return this.core.ledger;
  }

  onDocumentApproved(apply: (decision: Decision) => Promise<string>) {
    this.documentApplier = apply;
  }

  /** Must run inside a ledger transaction. */
  open(input: OpenDecision & { id?: string }): Decision {
    const decision = this.withReview({ ...input, id: input.id ?? newId(), state: "pending", answer: null, createdAt: Date.now(), resolvedAt: null });
    this.ledger.putDecision(decision);
    // The main Ghost looks first at another Ghost's decision; after the commit, never inside it.
    if (this.mainReviews(decision)) queueMicrotask(() => void this.askMain(decision).catch((error) => this.core.log("main review wake failed", String(error))));
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
      title: `결과 확인: ${work.title}`.slice(0, 200),
      detail: [note, work.result?.summary].filter(Boolean).join("\n\n"),
      options: [],
      proposal: work.result ? { result: work.result, criteria: work.acceptance.criteria } : null,
    });
  }

  /** A question from a Ghost. Returns the decision; the answer arrives as a submission. */
  ask(conversationId: string, title: string, detail: string, options: string[], id?: string, proposal: Decision["proposal"] = null): Decision {
    const existing = id ? this.ledger.findDecision(id) : null;
    if (existing) return existing;
    const conversation = this.ledger.conversation(conversationId);
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
   * Cancel pending decisions of a Work (optionally one kind). Must run inside a transaction.
   * An unknown effect's reconciliation stays open: the truth about it is still owed.
   */
  cancelFor(workId: string, kind?: Decision["kind"]) {
    for (const decision of this.ledger.pendingDecisions({ workId })) {
      if (kind ? decision.kind !== kind : decision.kind === "reconcile_effect") continue;
      this.ledger.putDecision({ ...decision, state: "cancelled", resolvedAt: Date.now() });
    }
  }

  /** Only the write-only vault endpoint may answer a secure credential request. */
  resolveSecureFormState(decisionId: string, item: Pick<VaultItem, "id" | "kind" | "title">): Decision {
    const decision = this.ledger.decision(decisionId);
    if (decision.state !== "pending") throw conflict("secure form decision is no longer pending");
    const form = decision.proposal?.secureForm as { kind?: string } | undefined;
    if (decision.kind !== "question" || !form || form.kind !== item.kind) throw invalid("decision is not a matching secure form request");
    const resolved: Decision = {
      ...decision, state: "answered",
      answer: JSON.stringify({ id: item.id, kind: item.kind, title: item.title }),
      resolvedAt: Date.now(),
    };
    this.ledger.tx(() => this.ledger.putDecision(resolved));
    return resolved;
  }

  async resolve(decisionId: string, resolution: Resolution, by: ResolvedBy = "owner") {
    const resolved = this.resolveState(decisionId, resolution, by);
    await this.followUp(resolved);
  }

  /** Commit the owner's answer before external follow-ups; API receipts join this transaction. */
  resolveState(decisionId: string, resolution: Resolution, by: ResolvedBy = "owner"): Decision {
    const decision = this.ledger.decision(decisionId);
    if (decision.proposal?.secureForm && (resolution.outcome !== "deny" || resolution.answer !== undefined)) throw conflict("use the secure form to answer this request; ordinary answers are not accepted");
    if (decision.state !== "pending") throw conflict(`decision is already ${decision.state}`);
    if (by !== "owner" && !this.reversible(decision)) throw conflict("only the owner can settle this decision");
    const state = stateFor(decision, resolution);
    const review = reviewOf(decision.proposal);
    const proposal = by !== "owner" && review ? { ...decision.proposal, review: { ...review, resolvedBy: by } } : decision.proposal;
    const resolved: Decision = { ...decision, proposal, state, answer: resolution.answer ?? null, resolvedAt: Date.now() };
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
          reasons: decision.answer ?? (decision.state === "approved" ? "Accepted by the owner." : "The owner asked for changes."),
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
    const by = reviewOf(decision.proposal)?.resolvedBy;
    const who = by === "timeout" ? "The owner did not answer in time, so the Host took your recommended answer for" : by === "main" ? "The main Ghost answered for the owner" : "The owner answered";
    const text =
      decision.state === "answered"
        ? `${who} "${decision.title}": ${decision.answer ?? ""}`
        : `${by === "main" ? "The main Ghost declined" : "The owner declined"} to answer "${decision.title}".`;
    if (decision.workId) this.core.works.resumeFromWaiting(decision.workId);
    await this.core.engine.submit(decision.conversationId, { text, origin: "decision", requestId: `decision:${decision.id}` });
  }

  /**
   * Reversible: a question with a recommended answer (never a vault form or browser handoff), a new document
   * page, a standing activity that cannot send on its own or touch the PC, and a Mac command whose stated risk
   * speaks of no loss. Sending, spending, card entry, deletion and overwrites always wait for the owner.
   */
  reversible(decision: Decision): boolean {
    const proposal = decision.proposal;
    if (decision.kind === "question") return !!proposal && !proposal.secureForm && !proposal.browserHandoff && typeof reviewOf(proposal)?.answer === "string";
    if (decision.kind === "document_review") return !!proposal && !(proposal.pageId ?? proposal.page_id);
    if (decision.kind !== "approve_effect" || !decision.effectId || !proposal) return false;
    const tool = this.ledger.effect(decision.effectId).tool;
    if (tool === "activity_propose") {
      const config = proposal.config as { execution?: { kind?: string }; policy?: { externalActions?: string }; tools?: unknown } | undefined;
      const drivesPc = Array.isArray(config?.tools) && config.tools.some((tool) => typeof tool === "string" && tool.startsWith("desktop_"));
      return !!config && config.execution?.kind !== "host" && config.policy?.externalActions !== "allow" && !drivesPc;
    }
    return tool === "host_command_propose" && typeof proposal.risk === "string" && !DESTRUCTIVE_RISK.test(proposal.risk);
  }

  /** The owner may turn automatic settling off for one Ghost; its decisions then always wait for them. */
  private automatic(decision: Decision): boolean {
    return this.policy().ghosts?.[decision.ghostId] !== "owner";
  }

  /** Attach the recommendation and the time it goes ahead to a reversible decision. */
  private withReview(decision: Decision): Decision {
    if (!this.reversible(decision)) return decision;
    const { autoMinutes } = this.policy();
    const expiresAt = autoMinutes > 0 && this.automatic(decision) ? decision.createdAt + autoMinutes * MINUTE : null;
    const prior = reviewOf(decision.proposal);
    const review: DecisionReview = decision.kind === "question" ? { recommend: "answer", answer: prior!.answer, expiresAt } : { recommend: "approve", expiresAt };
    return { ...decision, proposal: { ...decision.proposal, review } };
  }

  private policy() {
    return this.ledger.settings().approvals ?? { autoMinutes: 30, delegate: "reversible" as const };
  }

  /**
   * Another Ghost's decision the main looks over first, while the owner lets it (2026-11-10). It may settle only
   * reversible ones; on the rest it leaves its view for the owner. Not a vault form, a browser handoff or an
   * unknown outside effect: only the owner can fill in or see those.
   */
  private mainReviews(decision: Decision): boolean {
    const main = this.ledger.defaultGhost();
    if (this.policy().delegate !== "reversible" || !main || main.state !== "active" || main.id === decision.ghostId) return false;
    if (decision.kind === "reconcile_effect" || decision.proposal?.secureForm || decision.proposal?.browserHandoff) return false;
    return true;
  }

  /** The main may decide this one for the owner, not only comment on it. */
  private delegable(decision: Decision): boolean {
    return this.mainReviews(decision) && this.automatic(decision) && this.reversible(decision);
  }

  /** The main Ghost decides for the owner, or leaves its view on the card. Only the main's tool calls this. */
  async settleForOwner(mainId: string, decisionId: string, choice: { outcome: "approve" | "deny" | "answer" | "leave"; answer?: string; note: string }) {
    const decision = this.ledger.decision(decisionId);
    if (decision.state !== "pending") throw conflict(`decision is already ${decision.state}`);
    if (decision.ghostId === mainId) throw conflict("the main Ghost cannot settle its own requests");
    if (!this.mainReviews(decision)) throw conflict("the owner decides this one themselves");
    if (choice.outcome !== "leave" && !this.delegable(decision)) throw conflict("only the owner can settle this decision; leave your view with outcome leave");
    const review: DecisionReview = { expiresAt: null, ...reviewOf(decision.proposal), mainNote: choice.note.slice(0, 1000) };
    const noted: Decision = { ...decision, proposal: { ...decision.proposal, review } };
    this.ledger.tx(() => this.ledger.putDecision(noted));
    if (choice.outcome === "leave") return "Left for the owner with your note on the card.";
    await this.resolve(decisionId, { outcome: choice.outcome, ...(choice.answer ? { answer: choice.answer } : {}) }, "main");
    this.ledger.tx(() => this.core.notify({
      id: `decision-main:${decision.id}`, kind: "message", ghostId: mainId, conversationId: decision.conversationId, workId: decision.workId, decisionId: decision.id,
      title: decision.title.slice(0, 256), body: choice.note.slice(0, 2000),
    }));
    return "Settled for the owner; they were told why.";
  }

  /** Take the recommendation of every reversible decision whose wait ran out. */
  async settleExpired(now = Date.now()) {
    for (const decision of this.ledger.pendingDecisions()) {
      const review = reviewOf(decision.proposal);
      // Settings read now, not when the decision opened: turning automation off stops what is already waiting.
      if (!review?.recommend || review.expiresAt === null || review.expiresAt > now || this.policy().autoMinutes === 0 || !this.automatic(decision) || !this.reversible(decision)) continue;
      try {
        await this.resolve(decision.id, review.recommend === "answer" ? { outcome: "answer", answer: review.answer } : { outcome: "approve" }, "timeout");
      } catch (error) {
        this.core.log(`decision ${decision.id} auto-settle skipped`, String(error));
      }
    }
  }

  /** Wake the main Ghost's direct conversation to look at one decision; a quiet reply never reaches the owner. */
  private async askMain(decision: Decision) {
    const main = this.ledger.defaultGhost();
    const current = this.ledger.decision(decision.id);
    if (!main || current.state !== "pending" || !this.mainReviews(current)) return;
    const asker = this.ledger.ghost(decision.ghostId).name;
    const review = reviewOf(decision.proposal);
    const settle = this.delegable(current);
    const lines = [
      settle
        ? `[Decision review] ${asker} needs a decision the owner would normally make. It is reversible, so you may decide it for the owner.`
        : `[Decision review] ${asker} needs a decision only the owner can make (it sends, spends, deletes, enters a card or accepts a result). You cannot settle it; look it over for the owner.`,
      `Decision ${decision.id}: ${decision.title}`,
      decision.detail.slice(0, 4000),
      decision.options.length ? `Options: ${decision.options.join(" | ")}` : "",
      review?.answer ? `${asker} recommends: ${review.answer}` : "",
      settle
        ? `If it clearly serves what the owner wants, settle it with decision_settle (approve, deny or answer) and a one-sentence reason in the owner's language. If only the owner can judge, use outcome "leave" with your recommendation so they see it. Then reply only [quiet].`
        : `Check it against what you know (the owner's earlier words, the recipient, the amount, the files, the result against its brief). If there is something the owner should know to decide — a mismatch, a risk, a confirmation that it matches — call decision_settle with outcome "leave" and one or two sentences in the owner's language, ending with what you recommend. Then reply only [quiet].`,
    ].filter(Boolean);
    await this.core.engine.submit(main.directConversationId, { text: lines.join("\n\n"), origin: "schedule", requestId: `decision-review:${decision.id}` });
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
