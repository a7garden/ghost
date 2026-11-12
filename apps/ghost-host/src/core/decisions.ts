import { CAPABILITY_GRANT, GOAL_ADOPT, HOST_TOOLS, reviewOf, type CapabilityRequest, type Decision, type DecisionReview, type VaultItem, type Work } from "@ghost/contract";
import { updateGhost } from "./commands.ts";
import type { Core } from "./core.ts";
import { NoEffect } from "./effects.ts";
import { conflict, invalid } from "./errors.ts";
import { digestOf, newId } from "./ids.ts";
import { classifyEffect, decisionTool, evaluateStoredPolicy, type PolicyReceipt } from "./policy-context.ts";

export type OpenDecision = Omit<Decision, "id" | "state" | "answer" | "createdAt" | "resolvedAt">;

export type Resolution = { outcome: "approve" | "deny" | "answer"; answer?: string };

/** Who settled a decision: the owner, the main Ghost for them, or the Host after the owner's wait ran out. */
export type ResolvedBy = "owner" | "main" | "timeout";

const MINUTE = 60_000;

/** How long a decision the main may settle stays off the owner's devices before they hear of it anyway. */
const MAIN_REVIEW_GRACE = 5 * MINUTE;

/** The main Ghost's note on a decision; a result summary of three to six sentences fits in any language. */
export const NOTE_MAX = 2000;

/** How the main writes its note on a result: the owner reads it as the card's summary, the full report one click below. */
const RESULT_NOTE =
  "Write note as a summary of three to six sentences in the owner's language: what you checked against each criterion, what you found, and the next step. The owner reads it as the result card's summary, so say it in your own words rather than copying the report.";

/** The facts a result acceptance is checked against: which Work, and its acceptance criteria. */
function resultLines(decision: Decision): string[] {
  if (decision.kind !== "accept_result") return [];
  const criteria = typeof decision.proposal?.criteria === "string" ? decision.proposal.criteria.trim() : "";
  return [
    `This is a result acceptance for Work ${decision.workId ?? "(none)"}: compare the attached report with the acceptance criteria and approve only what the criteria ask for.`,
    criteria ? `Acceptance criteria:\n${criteria.slice(0, 2000)}` : "No acceptance criteria were set.",
  ];
}

/** Owner decisions. Opening one notifies; resolving one wakes whoever waits on it. */
export class Decisions {
  /** Applies an approved document proposal; registered by the documents integration. */
  private documentApplier: ((decision: Decision, authorize: () => void) => Promise<string>) | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly core: Core) {}

  /** Reconcile pending reviews and settle expired recommendations twice a minute. */
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

  onDocumentApproved(apply: (decision: Decision, authorize: () => void) => Promise<string>) {
    this.documentApplier = apply;
  }

  /** Must run inside a ledger transaction. */
  open(input: OpenDecision & { id?: string }): Decision {
    const decision = this.withReview({ ...input, id: input.id ?? newId(), state: "pending", answer: null, createdAt: Date.now(), resolvedAt: null });
    this.ledger.putDecision(decision);
    if (decision.state !== "pending") this.ledger.afterCommit(() => void this.followUp(decision).catch((error) => this.core.log("policy decision follow-up failed", String(error))));
    else {
      if (this.mainReviews(decision)) this.ledger.afterCommit(() => void this.askMain(decision).catch((error) => this.reviewUnavailable(decision, error)));
      if (!this.delegable(decision)) this.notifyOwner(decision);
    }
    return decision;
  }

  private reviewUnavailable(decision: Decision, error: unknown) {
    this.core.log("policy review unavailable", String(error));
    this.ledger.tx(() => {
      const current = this.ledger.decision(decision.id);
      if (current.state !== "pending") return;
      const noted = { ...current, detail: `${current.detail}\n\nConfigured reviewer unavailable: ${String(error)}. Configure the reviewer or decide explicitly as owner.`, proposal: { ...current.proposal, policyReviewUnavailable: true, review: { ...reviewOf(current.proposal), expiresAt: null } } };
      this.ledger.putDecision(noted);
      this.notifyOwner(noted);
    });
  }

  /** The owner's alert for a decision. Its id is deterministic, so a repeat is ignored. Must run inside a ledger transaction. */
  private notifyOwner(decision: Decision) {
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
    const live = this.evaluateDecision(decision);
    const authorized = decision.proposal?.policy as PolicyReceipt | undefined;
    if (resolution.outcome !== "deny" && live && (live.evaluation.decision === "deny" || (authorized && live.rulesDigest !== authorized.rulesDigest))) throw conflict("Policy changed while this decision waited; open a fresh proposal. " + live.evaluation.reason);
    if (by === "timeout" && (!live?.evaluation.autoResolve || !this.safeAutomatic(decision, live))) throw conflict("live policy does not permit automatic settlement");
    if (by === "main" && !this.reversible(decision)) throw conflict("only the owner can settle this decision");
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

  /** Startup: finish committed answers, restore pending reviews and retry their deterministic admissions. */
  async recover() {
    for (const decision of this.ledger.decisionsAwaitingFollowUp()) await this.followUp(decision);
    await this.settleExpired();
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
      case "accept_result": {
        if (!decision.workId || decision.state === "cancelled") break;
        const by = reviewOf(decision.proposal)?.resolvedBy;
        const reviewerName = (decision.proposal?.reviewedBy as { name?: string } | undefined)?.name ?? "the policy reviewer";
        // 2026-11-12 owner decision: the verdict names who settled the result, not always the owner.
        const base = decision.state === "approved"
          ? by === "main"
            ? `Accepted by ${reviewerName} for the owner after checking the report against the acceptance criteria.`
            : by === "timeout"
              ? "Accepted after the owner's wait ran out."
              : "Accepted by the owner."
          : by === "main"
            ? `${reviewerName} asked for changes.`
            : by === "timeout"
              ? "The Host asked for changes after the owner's wait ran out."
              : "The owner asked for changes.";
        const answer = decision.answer?.trim();
        // The main's settle note says what it checked and what to fix; the Ghost that did the Work needs it.
        const note = by === "main" ? reviewOf(decision.proposal)?.mainNote?.trim() : undefined;
        const reasons = by === "main" ? [base, note, answer].filter(Boolean).join(" ") : (answer ?? base);
        this.core.works.applyVerdict(decision.workId, {
          outcome: decision.state === "approved" ? "pass" : "revise",
          source: "owner",
          reasons,
          at: decision.resolvedAt ?? Date.now(),
        });
        break;
      }
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
    const reviewerName = (decision.proposal?.reviewedBy as { name?: string } | undefined)?.name ?? "The policy reviewer";
    const who = by === "timeout" ? "The owner did not answer in time, so the Host took your recommended answer for" : by === "main" ? `${reviewerName} answered for the owner` : "The owner answered";
    const granted = this.grantCapability(decision, by ?? "owner");
    const goal = this.core.goals.settleProposal(decision);
    const text = granted
      ? `${who} "${decision.title}": ${decision.answer ?? CAPABILITY_GRANT}\n${granted}`
      : decision.state === "answered"
        ? `${who} "${decision.title}": ${decision.answer ?? ""}${goal ? `\n${goal}` : ""}`
        : `${by === "main" ? `${reviewerName} declined` : "The owner declined"} to answer "${decision.title}".${goal ? `\n${goal}` : ""}`;
    if (decision.workId) this.core.works.resumeFromWaiting(decision.workId);
    // The granted tools must be configured before the turn that reads the answer starts.
    if (granted) await this.core.openConversation(decision.conversationId);
    await this.core.engine.submit(decision.conversationId, { text, origin: "decision", requestId: `decision:${decision.id}` });
  }

  /**
   * The grant and its marker commit together; replaying a failed answer delivery never undoes a later revocation.
   */
  private grantCapability(decision: Decision, by: ResolvedBy): string | null {
    const request = decision.proposal?.capability as CapabilityRequest | undefined;
    if (!request || !(decision.state === "approved" || (decision.state === "answered" && grants(decision.answer)))) return null;
    if (by !== "owner" && !request.grantedAt) {
      const confirmation = this.ask(decision.conversationId, decision.title, decision.detail, decision.options, `capability-owner:${decision.id}`, { capability: request, forceOwner: true });
      return `This delegated answer did not grant authority. Owner decision ${confirmation.id} is ${confirmation.state}.`;
    }
    const ghost = this.ledger.ghost(request.ghostId);
    if (ghost.deletedAt !== null) return null;
    this.ledger.tx(() => {
      const current = this.ledger.decision(decision.id);
      if ((current.proposal?.capability as CapabilityRequest | undefined)?.grantedAt) return;
      const fresh = this.ledger.ghost(ghost.id);
      const tools = request.tools.filter((tool) => !fresh.tools.includes(tool));
      const pc = request.hostExecution && !fresh.hostExecution;
      const host = [...(pc ? ["PC 직접 실행"] : []), ...HOST_TOOLS.filter((tool) => tools.includes(tool))];
      if (tools.length > 0 || pc) updateGhost(this.core, fresh.id, { tools: [...fresh.tools, ...tools], ...(pc ? { hostExecution: true } : {}) });
      if (host.length > 0) {
        this.core.notify({
          id: `grant:decision:${decision.id}`, kind: "message", ghostId: fresh.id, conversationId: decision.conversationId, workId: decision.workId, decisionId: decision.id,
          title: `${fresh.name}에게 ${host.join(", ")} 허용`,
          body: `${by === "owner" ? "소유자가" : by === "main" ? "메인 Ghost가" : "기다리는 시간이 지나"} ${fresh.name}의 요청을 허용했습니다. 설정 › Ghost에서 되돌릴 수 있습니다.`,
        });
      }
      this.ledger.putDecision({ ...current, proposal: { ...current.proposal, capability: { ...request, grantedAt: Date.now() } } });
    });
    const work = decision.workId ? this.ledger.work(decision.workId) : null;
    return [
      `Granted${request.tools.length ? `: ${request.tools.join(", ")}` : ""}${request.hostExecution ? `${request.tools.length ? " and" : ":"} direct PC execution` : ""}. The tools are yours from your next step.`,
      work?.toolScope && request.tools.some((tool) => !work.toolScope!.includes(tool)) ? "This Work's own activity scope still excludes some of them; they apply to your other conversations." : "",
      request.hostExecution && work && work.execution?.kind !== "host" ? "PC execution applies to Works created to run on the Mac; this Work keeps its environment." : "",
    ].filter(Boolean).join(" ");
  }

  /**
   * Reversible: a question with a recommended answer (never a vault form or browser handoff), a new document
   * page, a standing activity that cannot send on its own or touch the PC, and a Mac command whose stated risk
   * speaks of no loss. Sending, spending, card entry, deletion and overwrites always wait for the owner.
   * 2026-11-12 owner decision: a result acceptance that carries the result report is reversible too, so the
   * main Ghost may settle it for the owner after checking the report against the acceptance criteria.
   */
  reversible(decision: Decision): boolean {
    const receipt = this.evaluateDecision(decision);
    if (!receipt || decision.kind === "reconcile_effect" || decision.proposal?.secureForm || decision.proposal?.browserHandoff) return false;
    if (decision.proposal?.goal && !this.safeAutomatic(decision, receipt)) return false;
    if (decision.kind === "accept_result" && (!decision.proposal?.result || typeof decision.proposal.criteria !== "string" || !decision.proposal.criteria.trim())) return false;
    return receipt.evaluation.decision === "review" || (receipt.evaluation.decision === "allow" && receipt.classification.reversible);
  }

  private evaluateDecision(decision: Decision, reserve = false): PolicyReceipt | null {
    if (decision.kind === "reconcile_effect") return null;
    if (decision.effectId) {
      const receipt = this.core.effects.recheck(this.ledger.effect(decision.effectId));
      if (receipt.evaluation.decision !== "deny" && (decision.proposal?.forceOwner || decision.proposal?.secureForm || decision.proposal?.browserHandoff)) receipt.evaluation = { ...receipt.evaluation, decision: "owner", reviewers: [], autoResolve: null, reason: "Owner authorization is required to widen configuration or provide credentials." };
      return receipt;
    }
    const tool = decisionTool(decision);
    const proposal = decision.proposal ?? {};
    let classification = classifyEffect(this.core, decision.conversationId, tool, proposal);
    // Answering a question performs no I/O; any resulting mutation is checked separately.
    if (tool === "ask_owner") classification = { ...classification, reversible: typeof reviewOf(proposal)?.answer === "string" };
    if (tool === "complete") classification = { ...classification, reversible: !!proposal.result && typeof proposal.criteria === "string" && proposal.criteria.trim().length > 0 };
    if (tool === "goal_propose") classification = { ...classification, target: { kind: "host", id: digestOf(proposal.goal) } };
    if (tool === "capability_request") {
      const capability = proposal.capability as CapabilityRequest;
      classification = { ...classification, target: { kind: capability.hostExecution || capability.tools.some((name) => HOST_TOOLS.includes(name)) ? "mac" : "host", id: capability.ghostId }, reversible: true, external: false };
    }
    const prior = proposal.policy as PolicyReceipt | undefined;
    const receipt = evaluateStoredPolicy(this.core, decision.conversationId, classification, prior, reserve);
    if (tool === "complete" && receipt.evaluation.decision === "allow") receipt.evaluation = { ...receipt.evaluation, decision: "owner", reviewers: [], autoResolve: null, reason: "Policy cannot accept an unverified completion claim. Checks, an independent reviewer or the owner must verify this result." };
    if (receipt.evaluation.decision !== "deny" && (proposal.forceOwner || proposal.secureForm || proposal.browserHandoff || proposal.capability)) receipt.evaluation = { ...receipt.evaluation, decision: "owner", reviewers: proposal.capability ? receipt.evaluation.reviewers : [], autoResolve: null, reason: "Owner authorization is required to widen configuration or provide credentials." };
    return receipt;
  }

  private safeAutomatic(decision: Decision, receipt: PolicyReceipt): boolean {
    if (decision.kind === "reconcile_effect" || decision.kind === "accept_result" || decision.proposal?.secureForm || decision.proposal?.browserHandoff || decision.proposal?.forceOwner || decision.proposal?.policyReviewUnavailable || decision.proposal?.capability) return false;
    const facts = receipt.classification;
    if (decision.proposal?.goal) return receipt.evaluation.decidedBy.length > 0 && receipt.evaluation.decidedBy.every((id) => {
      const rule = this.ledger.policyRule(id);
      return rule.createdBy.kind === "owner" && rule.tool === "goal_propose" && rule.when.targetKind === "host" && rule.when.targetId === facts.target.id && rule.maxPerDay !== undefined;
    });
    // Opaque effects and unreadable amounts never advance on silence.
    if (facts.amount) return facts.amount.value !== null && facts.target.id !== null && receipt.evaluation.decidedBy.length > 0 && receipt.evaluation.decidedBy.every((id) => {
      const rule = this.ledger.policyRule(id);
      return rule.createdBy.kind === "owner" && rule.when.amount === true && rule.when.targetKind === facts.target.kind && rule.when.targetId === facts.target.id
        && !!rule.maxAmount && rule.maxAmount.currency === facts.amount!.currency && facts.amount!.value! <= rule.maxAmount.value;
    });
    if (!facts.reversible) return false;
    return true;
  }

  private automatic(decision: Decision): boolean {
    const live = this.evaluateDecision(decision);
    return !!live && live.evaluation.autoResolve !== null && this.safeAutomatic(decision, live);
  }

  private withReview(decision: Decision): Decision {
    const receipt = this.evaluateDecision(decision, true);
    if (!receipt) return decision;
    const prior = reviewOf(decision.proposal);
    const automatic = receipt.evaluation.autoResolve;
    const expiresAt = automatic && this.safeAutomatic(decision, receipt) ? decision.createdAt + automatic.afterMinutes * MINUTE : null;
    const review: DecisionReview = decision.kind === "question"
      ? { ...prior, ...(decision.proposal?.goal && this.safeAutomatic(decision, receipt) ? { recommend: "answer" as const, answer: GOAL_ADOPT } : prior?.answer ? { recommend: "answer" as const, answer: prior.answer } : {}), expiresAt }
      : { ...prior, recommend: "approve", expiresAt };
    const mayApprove = decision.kind !== "question" && !(decision.proposal?.secureForm || decision.proposal?.browserHandoff);
    const adopt = !!decision.proposal?.goal && receipt.evaluation.decision === "allow" && this.safeAutomatic(decision, receipt);
    const state = receipt.evaluation.decision === "deny" ? "denied" : adopt ? "answered" : receipt.evaluation.decision === "allow" && mayApprove ? "approved" : "pending";
    const conversation = this.ledger.conversation(decision.conversationId);
    const scopeId = decision.workId ? this.ledger.work(decision.workId).scopeId : this.ledger.setting<{ scopeId: string | null }>(`context:${conversation.id}`, { scopeId: null }).scopeId;
    return { ...decision, state, answer: adopt ? GOAL_ADOPT : decision.answer, resolvedAt: state === "pending" ? null : Date.now(), detail: `${decision.detail}\n\n${receipt.evaluation.reason}`, proposal: { ...decision.proposal, scopeId: decision.proposal?.scopeId ?? scopeId, policy: receipt, review } };
  }

  reviewer(decision: Decision) {
    const receipt = this.evaluateDecision(decision);
    for (const ref of receipt?.evaluation.reviewers ?? []) {
      const ghost = ref.kind === "ghost" ? this.ledger.ghost(ref.ghostId) : this.ledger.defaultGhost();
      if (ghost && ghost.id !== decision.ghostId && ghost.state === "active" && ghost.deletedAt === null) return { ghost, slot: ref.kind === "slot" ? ref.slot : null };
    }
    return null;
  }

  /**
   * Another Ghost's decision the main looks over first, while the owner lets it (2026-11-10). It may settle only
   * reversible ones; on the rest it leaves its view for the owner. Not a vault form, a browser handoff or an
   * unknown outside effect: only the owner can fill in or see those.
   */
  private mainReviews(decision: Decision): boolean {
    return decision.state === "pending" && !decision.proposal?.secureForm && !decision.proposal?.browserHandoff && !!this.reviewer(decision);
  }

  /**
   * The main may decide this one for the owner, not only comment on it. The owner handing it over overrides a
   * per-Ghost owner-only setting for that one decision, never reversibility.
   */
  private delegable(decision: Decision): boolean {
    return this.mainReviews(decision) && this.reversible(decision);
  }

  private handedOver(decision: Decision): boolean {
    return typeof reviewOf(decision.proposal)?.delegatedAt === "number";
  }

  /**
   * The owner hands one decision to the main Ghost to settle now (2026-11-11), so a quick pass through
   * 확인할 일 need not stop on it. Only what the main could settle anyway: reversible, another Ghost's,
   * delegation not turned off. Must run inside a ledger transaction; the wake follows the commit.
   */
  delegate(decisionId: string): Decision {
    const decision = this.ledger.decision(decisionId);
    if (decision.state !== "pending") throw conflict(`decision is already ${decision.state}`);
    const main = this.reviewer(decision)?.ghost;
    if (!main || main.state !== "active") throw conflict("there is no active main Ghost to hand this to");
    if (main.id === decision.ghostId) throw conflict("the main Ghost cannot settle its own requests");
    if (!this.mainReviews(decision)) throw conflict("handing decisions to the main Ghost is turned off, or this one is the owner's alone");
    if (!this.reversible(decision)) throw conflict("only reversible decisions can be handed to the main Ghost");
    if (this.handedOver(decision)) return decision;
    const review: DecisionReview = { expiresAt: null, ...reviewOf(decision.proposal), delegatedAt: Date.now() };
    const handed: Decision = { ...decision, proposal: { ...decision.proposal, review } };
    this.ledger.putDecision(handed);
    this.ledger.afterCommit(() => void this.askMainToSettle(handed).catch((error) => this.core.log("delegated decision wake failed", String(error))));
    return handed;
  }

  /** The main Ghost decides for the owner, or leaves its view on the card. Only the main's tool calls this. */
  async settleForOwner(mainId: string, decisionId: string, choice: { outcome: "approve" | "deny" | "answer" | "leave"; answer?: string; note: string }) {
    const decision = this.ledger.decision(decisionId);
    if (decision.state !== "pending") throw conflict(`decision is already ${decision.state}`);
    if (decision.ghostId === mainId) throw conflict("the main Ghost cannot settle its own requests");
    if (this.reviewer(decision)?.ghost.id !== mainId) throw conflict("this Ghost is not the live policy reviewer");
    if (!this.mainReviews(decision)) throw conflict("the owner decides this one themselves");
    if (choice.outcome !== "leave" && !this.delegable(decision)) throw conflict("only the owner can settle this decision; leave your view with outcome leave");
    const { delegatedAt, ...prior } = reviewOf(decision.proposal) ?? { expiresAt: null };
    // Leaving a handed-over decision gives it back: it returns to the owner's queue with the main's note.
    const kept = choice.outcome !== "leave" && delegatedAt !== undefined ? { delegatedAt } : {};
    const review: DecisionReview = { ...prior, ...kept, mainNote: choice.note.slice(0, NOTE_MAX) };
    const reviewer = this.reviewer(decision);
    const noted: Decision = { ...decision, proposal: { ...decision.proposal, review, reviewedBy: { ghostId: mainId, name: this.ledger.ghost(mainId).name, slot: reviewer?.slot ?? null } } };
    this.ledger.tx(() => {
      this.ledger.putDecision(noted);
      // Left for the owner: now it is theirs, so they hear of it if they have not already.
      if (choice.outcome === "leave") this.notifyOwner(noted);
    });
    if (choice.outcome === "leave") return "Left for the owner with your note on the card.";
    await this.resolve(decisionId, { outcome: choice.outcome, ...(choice.answer ? { answer: choice.answer } : {}) }, "main");
    // One alert per decision: a result's own outcome (Work done or failed; a revision is not news yet) and a grant's notice already tell the owner.
    if (decision.kind !== "accept_result" && !this.ledger.findNotification(`grant:decision:${decision.id}`)) {
      this.ledger.tx(() => this.core.notify({
        id: `decision-main:${decision.id}`, kind: "message", ghostId: mainId, conversationId: decision.conversationId, workId: decision.workId, decisionId: decision.id,
        title: decision.title.slice(0, 256), body: choice.note.slice(0, NOTE_MAX),
      }));
    }
    return "Settled for the owner; they were told why.";
  }

  /** Re-derive missing pending reviews, retry main admission and take expired recommendations. */
  async settleExpired(now = Date.now()) {
    for (let decision of this.ledger.pendingDecisions()) {
      try {
        const live = this.evaluateDecision(decision);
        const prior = decision.proposal?.policy as PolicyReceipt | undefined;
        if (live && (live.evaluation.decision === "deny" || prior && prior.rulesDigest !== live.rulesDigest)) {
          await this.resolve(decision.id, { outcome: "deny", answer: "Policy changed while this approval waited. " + live.evaluation.reason });
          continue;
        }
      } catch (error) {
        this.reviewUnavailable(decision, error);
        continue;
      }
      // Pending rows from before review metadata existed must not wait forever after an upgrade.
      // Keep existing deadlines (including explicit opt-outs); backfill from the original opening time.
      if (!reviewOf(decision.proposal)?.recommend && this.reversible(decision)) {
        // Earlier iterations await; re-read so a decision resolved or cancelled meanwhile is never written back as pending.
        const fresh = this.ledger.tx(() => {
          const current = this.ledger.decision(decision.id);
          if (current.state !== "pending" || reviewOf(current.proposal)?.recommend) return null;
          const reviewed = this.withReview(current);
          this.ledger.putDecision(reviewed);
          return reviewed;
        });
        if (!fresh) continue;
        decision = fresh;
      }
      try {
        // A hand-over whose wake was lost (crash after commit) is retried with the same request id.
        if (this.handedOver(decision)) await this.askMainToSettle(decision);
        else await this.askMain(decision);
      } catch (error) {
        this.reviewUnavailable(decision, error);
      }
      // The owner hears of a decision the main has not settled in time; one they handed over is already theirs to watch.
      if (now - decision.createdAt >= MAIN_REVIEW_GRACE || !this.delegable(decision)) {
        this.ledger.tx(() => {
          const current = this.ledger.decision(decision.id);
          if (current.state === "pending" && !this.handedOver(current)) this.notifyOwner(current);
        });
      }
      const review = reviewOf(decision.proposal);
      // Settings read now, not when the decision opened: turning automation off stops what is already waiting.
      if (!review?.recommend || typeof review.expiresAt !== "number" || !Number.isFinite(review.expiresAt) || review.expiresAt > now || !this.automatic(decision)) continue;
      try {
        await this.resolve(decision.id, review.recommend === "answer" ? { outcome: "answer", answer: review.answer } : { outcome: "approve" }, "timeout");
      } catch (error) {
        this.core.log(`decision ${decision.id} auto-settle skipped`, String(error));
      }
    }
  }

  /** Wake the main Ghost's direct conversation to look at one decision; a quiet reply never reaches the owner. */
  private async askMain(decision: Decision) {
    const reviewer = this.reviewer(decision);
    const main = reviewer?.ghost;
    const current = this.ledger.decision(decision.id);
    if (!main || current.state !== "pending" || !this.mainReviews(current) || reviewOf(current.proposal)?.mainNote !== undefined) return;
    const asker = this.ledger.ghost(current.ghostId).name;
    const review = reviewOf(current.proposal);
    const settle = this.delegable(current);
    const lines = [
      settle
        ? `[Decision review] ${asker} needs a decision the owner would normally make. It is reversible, so you may decide it for the owner.`
        : current.kind === "accept_result"
          ? `[Decision review] ${asker} needs a result accepted that only the owner can settle (no result report or no acceptance criteria to check it against). You cannot settle it; look it over for the owner.`
          : `[Decision review] ${asker} needs a decision only the owner can make (it sends, spends, deletes or enters a card). You cannot settle it; look it over for the owner.`,
      `Decision ${decision.id}: ${decision.title}`,
      decision.detail.slice(0, 4000),
      decision.options.length ? `Options: ${decision.options.join(" | ")}` : "",
      ...resultLines(current),
      review?.answer ? `${asker} recommends: ${review.answer}` : "",
      current.kind === "accept_result"
        ? settle
          ? `Settle it with decision_settle: approve only if the report meets every criterion, deny (asking for changes) if it falls short, or leave it if only the owner can judge. ${RESULT_NOTE} Then reply only [quiet].`
          : `Call decision_settle with outcome "leave". ${RESULT_NOTE} Then reply only [quiet].`
        : settle
          ? `If it clearly serves what the owner wants, settle it with decision_settle (approve, deny or answer) and a one-sentence reason in the owner's language. If only the owner can judge, use outcome "leave" with your recommendation so they see it. Then reply only [quiet].`
          : `Check it against what you know (the owner's earlier words, the recipient, the amount, the files, the result against its brief). If there is something the owner should know to decide — a mismatch, a risk, a confirmation that it matches — call decision_settle with outcome "leave" and one or two sentences in the owner's language, ending with what you recommend. Then reply only [quiet].`,
    ].filter(Boolean);
    const submission = { text: lines.join("\n\n"), origin: "schedule" as const, requestId: `decision-review:${decision.id}`, sourceConversationId: decision.conversationId, scopeId: (decision.proposal?.policy as PolicyReceipt | undefined)?.scopeId ?? null };
    if (this.core.engine.wake) await this.core.engine.wake(main.id, submission, { slot: reviewer?.slot ?? undefined, decisionId: decision.id });
    else {
      if (reviewer?.slot) throw conflict(`Reviewer slot ${reviewer.slot} requires a configured wake engine; ask the owner to decide explicitly`);
      await this.core.engine.submit(main.directConversationId, submission);
    }
  }

  /** Wake the main to settle a decision the owner handed over; it leaves it back only when it truly cannot judge. */
  private async askMainToSettle(decision: Decision) {
    const reviewer = this.reviewer(decision);
    const main = reviewer?.ghost;
    const current = this.ledger.decision(decision.id);
    if (!main || current.state !== "pending" || !this.handedOver(current)) return;
    const asker = this.ledger.ghost(current.ghostId).name;
    const review = reviewOf(current.proposal);
    const lines = [
      `[Decision handed over] The owner handed ${asker}'s decision to you to settle now. It is reversible.`,
      `Decision ${current.id}: ${current.title}`,
      current.detail.slice(0, 4000),
      current.options.length ? `Options: ${current.options.join(" | ")}` : "",
      ...resultLines(current),
      review?.answer ? `${asker} recommends: ${review.answer}` : "",
      current.kind === "accept_result"
        ? `Decide it with decision_settle: approve only if the report meets every criterion, otherwise deny (asking for changes). Use outcome "leave" only if you cannot judge it at all; that gives it back to the owner. ${RESULT_NOTE} Then reply only [quiet].`
        : `Decide it with decision_settle (approve, deny or answer) and a one-sentence reason in the owner's language. Use outcome "leave" only if you cannot judge it at all; that gives it back to the owner with your note. Then reply only [quiet].`,
    ].filter(Boolean);
    const submission = { text: lines.join("\n\n"), origin: "schedule" as const, requestId: `decision-delegate:${current.id}`, sourceConversationId: current.conversationId, scopeId: (current.proposal?.policy as PolicyReceipt | undefined)?.scopeId ?? null };
    if (this.core.engine.wake) await this.core.engine.wake(main.id, submission, { slot: reviewer?.slot ?? undefined, decisionId: current.id });
    else {
      if (reviewer?.slot) throw conflict(`Reviewer slot ${reviewer.slot} requires a configured wake engine; ask the owner to decide explicitly`);
      await this.core.engine.submit(main.directConversationId, submission);
    }
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
              return await apply(decision, () => {
                this.core.effects.authorize(decision.conversationId, `decision:${decision.id}`);
                const live = this.evaluateDecision(decision);
                const approved = decision.proposal?.policy as PolicyReceipt | undefined;
                if (live?.evaluation.decision === "deny" || approved && live?.rulesDigest !== approved.rulesDigest) throw new NoEffect("Document policy changed while the write waited; nothing was saved");
              });
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

/** Only exact affirmative tokens grant; “허용하지 마세요” must never open the Mac. */
function grants(answer: string | null): boolean {
  const text = (answer ?? "").trim().replace(/[.!。]+$/, "").toLowerCase();
  return [CAPABILITY_GRANT, "allow", "grant", "approve", "yes", "예", "네"].includes(text);
}
