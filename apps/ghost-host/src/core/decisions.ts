import type { Decision, VaultItem, Work } from "@ghost/contract";
import type { Core } from "./core.ts";
import { NoEffect } from "./effects.ts";
import { conflict, invalid } from "./errors.ts";
import { newId } from "./ids.ts";

export type OpenDecision = Omit<Decision, "id" | "state" | "answer" | "createdAt" | "resolvedAt">;

export type Resolution = { outcome: "approve" | "deny" | "answer"; answer?: string };

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

  /** Must run inside a ledger transaction. */
  open(input: OpenDecision & { id?: string }): Decision {
    const decision: Decision = { ...input, id: input.id ?? newId(), state: "pending", answer: null, createdAt: Date.now(), resolvedAt: null };
    this.ledger.putDecision(decision);
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
      title: `Accept "${work.title}"?`,
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

  async resolve(decisionId: string, resolution: Resolution) {
    const resolved = this.resolveState(decisionId, resolution);
    await this.followUp(resolved);
  }

  /** Commit the owner's answer before external follow-ups; API receipts join this transaction. */
  resolveState(decisionId: string, resolution: Resolution): Decision {
    const decision = this.ledger.decision(decisionId);
    if (decision.proposal?.secureForm && (resolution.outcome !== "deny" || resolution.answer !== undefined)) throw conflict("use the secure form to answer this request; ordinary answers are not accepted");
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
    const text =
      decision.state === "answered"
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
