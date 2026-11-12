import { TERMINAL_WORK_STATES, type Effect } from "@ghost/contract";
import type { Core } from "./core.ts";
import { CommandError, conflict } from "./errors.ts";
import { digestOf, newId } from "./ids.ts";
import { classifyEffect, evaluateStoredPolicy, type ObservedEffect, type PolicyReceipt } from "./policy-context.ts";

const MAX_RESULT = 16_384;

export interface BeginEffect {
  conversationId: string;
  callId: string;
  tool: string;
  /** Hashed for identity; a retry of the same call must carry the same input. */
  input: unknown;
  summary: string;
  classification?: ObservedEffect;
}

/** Host-only API journals; these names are not model tools or tool exclusion scopes. */
const COMMAND_EFFECT_TOOLS = ["message.cancel", "sandbox.control", "document.save", "provider.upsert", "provider.delete", "connection.upsert", "connection.delete", "connection.oauth", "mail.send", "mail.update"] as const;
export type CommandEffectTool = typeof COMMAND_EFFECT_TOOLS[number];

export interface BeginCommandEffect extends Omit<BeginEffect, "tool" | "callId"> {
  tool: CommandEffectTool;
  requestId: string;
}

/** What `begin` returns: run the effect, or replay a known outcome. */
export type EffectStart = { kind: "run"; effect: Effect } | { kind: "replay"; effect: Effect };

/**
 * `pending` is committed before I/O and becomes `done` after; restart reconciles
 * interrupted executions while preserving unexecuted owner-approval proposals.
 */
/**
 * 2026-11-10 owner decision: an uncertain outcome goes back to the Ghost, which can look at files, the shell,
 * pages and documents itself. The owner is asked only about what happened outside, where only they can see:
 * a mail or PR comment sent, a purchase-like click. Owner API commands keep their own reconciliation.
 */
const OWNER_CONFIRMS: Record<string, { title: string; check: string }> = {
  activity_action: { title: "메일 답장이나 PR 댓글이 실제로 보내졌나요?", check: "보낸편지함이나 PR 댓글에서 확인해 주세요." },
  connection_request: { title: "서비스에 요청한 변경이 실제로 처리됐나요?", check: "해당 서비스의 기록에서 확인해 주세요. 같은 요청을 다시 보내지는 않습니다." },
  browser_propose: { title: "브라우저에서 누르려던 버튼이 실제로 눌렸나요?", check: "주문 · 결제 내역이나 해당 사이트에서 확인해 주세요." },
  desktop_propose: { title: "PC에서 누르려던 버튼이 실제로 눌렸나요?", check: "해당 앱 화면에서 확인해 주세요." },
  mail_send: { title: "메일이 실제로 보내졌나요?", check: "보낸편지함에서 확인해 주세요." },
};

export class Effects {
  /** Executors run by the host after the owner approves an effect (browser mutations). */
  private readonly approved = new Map<string, (effect: Effect) => Promise<string>>();
  private readonly waiting = new Map<string, () => Promise<string>>();

  constructor(private readonly core: Core) {}

  private get ledger() {
    return this.core.ledger;
  }

  begin(input: BeginEffect): EffectStart {
    if ((COMMAND_EFFECT_TOOLS as readonly string[]).includes(input.tool)) throw new CommandError("invalid", "API effects require command admission");
    return this.start(input, "tool");
  }

  /** Explicit owner actions have independent exclusion, but identical replay guards. */
  beginCommand(input: BeginCommandEffect): EffectStart {
    if (!(COMMAND_EFFECT_TOOLS as readonly string[]).includes(input.tool)) throw new CommandError("invalid", "unknown API effect tool");
    const { requestId, ...effect } = input;
    return this.start({ ...effect, callId: `api:${requestId}` }, "command");
  }

  private start(input: BeginEffect, scope: "tool" | "command"): EffectStart {
    return this.ledger.tx(() => {
      const digest = digestOf(input.input);
      const existing = this.ledger.effectByCall(input.conversationId, input.callId);
      if (existing) {
        if (existing.inputDigest !== digest) throw conflict(`call ${input.callId} was recorded with different input`);
        if (existing.tool !== input.tool) throw conflict(`call ${input.callId} was recorded for a different tool`);
        if (existing.state === "done" || existing.state === "denied") return { kind: "replay", effect: existing };
        throw conflict(`the outcome of call ${input.callId} is ${existing.state}; it will not run again`);
      }
      if (scope === "tool") {
        const blocking = this.unresolvedInConversation(input.conversationId).find((effect) => !this.awaitingApproval(effect));
        if (blocking) {
          const name = `effect ${blocking.tool} (${blocking.callId}) is unresolved`;
          if (blocking.state === "unknown") throw conflict(`${name}; nothing else runs until the owner reconciles it`);
          throw conflict(`${name}: it is still running; continue with read-only steps until its result arrives`);
        }
      }
      const conversation = this.ledger.conversation(input.conversationId);
      const effect: Effect = {
        id: newId(),
        workId: conversation.workId,
        conversationId: input.conversationId,
        callId: input.callId,
        tool: input.tool,
        summary: input.summary.slice(0, 2048),
        inputDigest: digest,
        state: "pending",
        result: null,
        createdAt: Date.now(),
        endedAt: null,
      };
      if (scope === "tool") {
        const classification = classifyEffect(this.core, input.conversationId, input.tool, input.input, input.classification);
        if (classification.access !== "write") throw new CommandError("invalid", "reads must use unjournaled policyRead admission");
        const receipt = evaluateStoredPolicy(this.core, input.conversationId, classification, undefined, true);
        this.ledger.putSetting(`policy:effect:${effect.id}`, receipt);
        if (receipt.evaluation.decision === "deny") {
          this.ledger.putEffect({ ...effect, state: "denied", result: receipt.evaluation.reason, endedAt: Date.now() });
          return { kind: "replay", effect: this.ledger.effect(effect.id) };
        }
      }
      this.ledger.putEffect(effect);
      return { kind: "run", effect };
    });
  }

  /** The effect ran and its outcome is known (success or a known failure). */
  finish(effectId: string, result: string): Effect {
    return this.settle(effectId, "done", result);
  }

  /** The effect certainly did not happen. */
  deny(effectId: string, reason: string): Effect {
    return this.settle(effectId, "denied", reason);
  }

  /** The outcome cannot be known (process died, transport lost). Blocks the Work. */
  unknown(effectId: string, reason: string): Effect {
    const current = this.ledger.effect(effectId);
    // 2026-11-10: the owner was asked "did write happen?" and the Work waited on it. A change the Ghost can
    // look at itself is recorded as uncertain and handed back to it; it never runs again on its own.
    if (current.state === "pending" && this.selfCheckable(current)) {
      return this.settle(effectId, "done", `Outcome uncertain (${reason}). Inspect the result before relying on it. This call will never execute again.`);
    }
    const effect = this.settle(effectId, "unknown", reason);
    this.escalate(effect);
    return effect;
  }

  /** Everything a Ghost can look at itself: no owner reconciliation. */
  selfCheckable(effect: Effect): boolean {
    const receipt = this.ledger.setting<PolicyReceipt | null>(`policy:effect:${effect.id}`, null);
    if (receipt) return !receipt.classification.external && receipt.classification.reversible;
    return !(effect.tool in OWNER_CONFIRMS) && !(COMMAND_EFFECT_TOOLS as readonly string[]).includes(effect.tool) && ["write", "edit", "publish_artifact", "document_write"].includes(effect.tool);
  }

  /**
   * Startup: hand reconciliations that a Ghost can check back to it — cards opened before 2026-11-10
   * asked the owner "did bash happen?" and held the Work. The effect is recorded as uncertain and the Work resumes.
   */
  returnSelfCheckable() {
    for (const decision of this.ledger.pendingDecisions()) {
      if (decision.kind !== "reconcile_effect" || !decision.effectId) continue;
      const effect = this.ledger.effect(decision.effectId);
      if (effect.state !== "unknown" || !this.selfCheckable(effect)) continue;
      const note = `Outcome uncertain (${effect.result ?? "interrupted"}). Check the result yourself before relying on it; if it did not happen, do it again as a new step.`;
      this.ledger.tx(() => {
        this.ledger.putDecision({ ...decision, state: "cancelled", resolvedAt: Date.now() });
        this.ledger.putEffect({ ...effect, state: "done", result: note, endedAt: Date.now() });
      });
      if (effect.workId) this.core.works.unblock(effect.workId, `${effect.summary.slice(0, 200)}: ${note}`);
    }
  }

  private settle(effectId: string, state: Effect["state"], result: string): Effect {
    return this.ledger.tx(() => {
      const effect = this.ledger.effect(effectId);
      if (effect.state !== "pending" && effect.state !== "unknown") return effect;
      const next: Effect = { ...effect, state, result: result.slice(-MAX_RESULT), endedAt: Date.now() };
      this.ledger.putEffect(next);
      return next;
    });
  }

  /**
   * Run `perform` as one journaled effect. A replay returns the recorded result
   * without running again; a throw that may have left an effect marks it unknown.
   */
  async run(input: BeginEffect, perform: () => Promise<string>): Promise<string> {
    const start = this.begin(input);
    if (start.kind === "run") {
      const receipt = this.recheck(start.effect);
      if (receipt.evaluation.decision !== "allow") {
        this.waiting.set(start.effect.id, perform);
        this.openApproval(start.effect, input.summary, receipt.evaluation.reason, { input: input.input });
        throw conflict(`Policy approval required (${start.effect.id}); nothing was performed. ${receipt.evaluation.reason}`);
      }
    }
    return this.perform(start, perform);
  }

  /** Journal an owner command without making it compete with Ghost tool mutations. */
  async runCommand(input: BeginCommandEffect, perform: () => Promise<string>): Promise<string> {
    return this.perform(this.beginCommand(input), perform);
  }

  /** An uncertain cancellation cannot replay and abort a newer run. */
  async cancelMessage(conversationId: string, requestId: string): Promise<void> {
    const start = this.beginCommand({
      conversationId, requestId, tool: "message.cancel",
      input: { type: "message.cancel", conversationId }, summary: "API message.cancel",
    });
    const result = await this.perform(start, async () => {
      await this.core.engine.abort(conversationId);
      return "cancelled";
    });
    if (result !== "cancelled") throw conflict("the cancellation outcome requires owner reconciliation; it is not a successful cancellation receipt");
  }

  private async perform(start: EffectStart, perform: () => Promise<string>): Promise<string> {
    if (start.kind === "replay") {
      if (start.effect.state === "denied") throw new CommandError("forbidden", start.effect.result ?? "denied");
      return start.effect.result ?? "";
    }
    try {
      if (!(COMMAND_EFFECT_TOOLS as readonly string[]).includes(start.effect.tool)) this.authorize(start.effect.conversationId, start.effect.callId);
      const result = await perform();
      this.finish(start.effect.id, result);
      return result;
    } catch (error) {
      if (error instanceof KnownOutcome) {
        this.finish(start.effect.id, error.message);
        throw error;
      }
      if (error instanceof NoEffect) {
        this.deny(start.effect.id, error.message);
        throw error;
      }
      this.unknown(start.effect.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  unresolved(workId: string): Effect[] {
    return this.ledger.effectsForWork(workId).filter((effect) => effect.state === "pending" || effect.state === "unknown");
  }

  /** An unexecuted proposal is optional, not an in-flight external change. */
  awaitingApproval(effect: Effect): boolean {
    return effect.state === "pending" && this.ledger.pendingDecisions({ effectId: effect.id })
      .some((decision) => decision.kind === "approve_effect");
  }

  private unresolvedInConversation(conversationId: string): Effect[] {
    return [...this.ledger.effectsInState("unknown"), ...this.ledger.effectsInState("pending")].filter(
      (effect) => effect.conversationId === conversationId && !(COMMAND_EFFECT_TOOLS as readonly string[]).includes(effect.tool),
    );
  }

  /** At startup executing effects are interrupted; unexecuted proposals retain their approvals. */
  recoverInterrupted() {
    for (const effect of this.ledger.effectsInState("pending")) {
      if (this.awaitingApproval(effect)) continue;
      this.unknown(effect.id, "the host stopped while this effect was running");
    }
  }

  /** Open the owner reconciliation for an unknown effect and stop its Work. */
  private escalate(effect: Effect) {
    const conversation = this.ledger.conversation(effect.conversationId);
    this.ledger.tx(() => {
      if (effect.workId) this.core.works.block(effect.workId, `unknown outcome of ${effect.tool}`);
      if (this.ledger.pendingDecisions({ effectId: effect.id }).some((decision) => decision.kind === "reconcile_effect")) return;
      this.core.decisions.open({
        kind: "reconcile_effect",
        ghostId: conversation.ghostId,
        conversationId: conversation.id,
        workId: effect.workId,
        effectId: effect.id,
        // 2026-11-10: only outside effects reach here (OWNER_CONFIRMS), asked as a plain yes/no about what the owner can see.
        title: OWNER_CONFIRMS[effect.tool]?.title ?? "요청한 작업이 실제로 처리됐나요?",
        detail: [`Ghost가 처리하던 중에 연결이 끊겨 결과를 알 수 없습니다. ${OWNER_CONFIRMS[effect.tool]?.check ?? "직접 확인해 주세요."}`, `- 하려던 일: ${effect.summary}`].join("\n"),
        options: [],
        proposal: null,
      });
    });
  }

  /** The owner reconciled an unknown effect: `happened` records it done, otherwise denied. */
  reconcile(effectId: string, happened: boolean, note: string | null) {
    const effect = this.ledger.effect(effectId);
    const outcome = happened ? "The owner confirmed it happened." : "The owner confirmed it did not happen.";
    if (effect.state === "unknown") {
      this.ledger.tx(() => {
        this.ledger.putEffect({ ...effect, state: happened ? "done" : "denied", result: [effect.result, outcome, note].filter(Boolean).join("\n"), endedAt: Date.now() });
      });
    }
    // Unconditional: a replay after a crash between the two steps still releases the Work.
    if (effect.workId) this.core.works.unblock(effect.workId, `${effect.tool} (${effect.callId}): ${outcome}${note ? ` ${note}` : ""}`);
  }

  /** Register the executor for an approval-gated tool. */
  onApproved(tool: string, execute: (effect: Effect) => Promise<string>) {
    this.approved.set(tool, execute);
  }

  /** Persist a proposed effect as pending and ask the owner. The host runs it after approval. */
  propose(input: BeginEffect & { title: string; detail: string; proposal: Record<string, unknown> }): Effect {
    if (!this.approved.has(input.tool)) throw new Error(`no approval executor for ${input.tool}`);
    const start = this.begin(input);
    if (start.kind === "replay") return start.effect;
    this.openApproval(start.effect, input.title, input.detail, input.proposal);
    return start.effect;
  }

  proposalStatus(effect: Effect): string {
    const current = this.ledger.effect(effect.id);
    if (current.state === "done") return `${current.tool} (${current.id}): ${current.result ?? "completed"}`;
    if (current.state === "denied") return `Not performed (${current.id}): ${current.result ?? "policy denied"}`;
    if (current.state === "unknown") return `Outcome unknown (${current.id}); do not retry. Reconciliation is required.`;
    const receipt = this.ledger.setting<PolicyReceipt | null>(`policy:effect:${current.id}`, null);
    return receipt?.evaluation.decision === "allow"
      ? `Policy allowed the proposal (${current.id}); execution is scheduled. Only the follow-up receipt confirms the outcome. Do not retry.`
      : `Policy approval required (${current.id}); nothing has been performed. ${receipt?.evaluation.reason ?? ""} End the turn or continue unrelated steps; the decision arrives as a message.`;
  }

  private openApproval(effect: Effect, title: string, detail: string, proposal: Record<string, unknown>) {
    const conversation = this.ledger.conversation(effect.conversationId);
    this.ledger.tx(() => this.core.decisions.open({
      kind: "approve_effect", ghostId: conversation.ghostId, conversationId: conversation.id,
      workId: conversation.workId, effectId: effect.id, title, detail, options: [], proposal,
    }));
  }

  /** Live rules and accumulated taint are checked again immediately before adapter I/O. */
  recheck(effect: Effect): PolicyReceipt {
    return this.ledger.tx(() => {
      const prior = this.ledger.setting<PolicyReceipt | null>(`policy:effect:${effect.id}`, null);
      const receipt = evaluateStoredPolicy(this.core, effect.conversationId, prior?.classification ?? classifyEffect(this.core, effect.conversationId, effect.tool, null), prior ?? undefined, true);
      this.ledger.putSetting(`policy:effect:${effect.id}`, receipt);
      return receipt;
    });
  }

  /** Adapter dispatch hook: call again after queue/network waits, immediately before the mutation. */
  authorize(conversationId: string, callId: string): void {
    const effect = this.ledger.effectByCall(conversationId, callId);
    if (!effect || effect.state !== "pending") throw new NoEffect("There is no executable pending effect");
    this.assertAuthority(effect);
    const receipt = this.recheck(effect);
    if (receipt.evaluation.decision === "allow") return;
    const decision = this.ledger.decisionsAwaitingFollowUp().find((entry) => entry.effectId === effect.id && entry.kind === "approve_effect" && entry.state === "approved");
    const authorization = decision?.proposal?.policy as PolicyReceipt | undefined;
    if (receipt.evaluation.decision === "deny" || !authorization || receipt.rulesDigest !== authorization.rulesDigest || JSON.stringify(receipt.classification) !== JSON.stringify(authorization.classification)) throw new NoEffect("Live policy does not authorize this action. " + receipt.evaluation.reason);
  }

  private assertAuthority(effect: Effect): void {
    const conversation = this.ledger.conversation(effect.conversationId);
    const ghost = this.ledger.ghost(conversation.ghostId);
    const work = effect.workId ? this.ledger.work(effect.workId) : null;
    if (ghost.state !== "active" || ghost.deletedAt !== null) throw new NoEffect("The executing Ghost is no longer active");
    if (conversation.kind === "review" || conversation.kind === "subagent") throw new NoEffect("Read-only conversations cannot execute effects");
    if (conversation.kind === "wake" && this.ledger.setting<string | null>(`wake:decision:${conversation.id}`, null)) throw new NoEffect("Decision review wakes are read-only");
    if (["write", "edit", "bash", "publish_artifact", "activity_action"].includes(effect.tool) && conversation.kind !== "work") throw new NoEffect("This tool requires a Work conversation");
    const tool = effect.tool === "document_write" ? "document_propose" : effect.tool;
    const managedGhost = tool === "ghost_create" || tool === "ghost_update";
    if (managedGhost && (!ghost.isDefault || !["direct", "wake"].includes(conversation.kind))) throw new NoEffect("The main Ghost's configuration authority was revoked");
    const internal = managedGhost || ["self_adapt", "activity_action"].includes(tool);
    const matches = (pattern: string) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(tool);
    if (!internal && !ghost.tools.some(matches)) throw new NoEffect("The tool grant was revoked; nothing was performed");
    if (work?.toolScope && !internal && !work.toolScope.some(matches)) throw new NoEffect("This Work no longer permits the tool");
    if ((tool.startsWith("desktop_") || work?.execution?.kind === "host" && ["write", "edit", "bash", "publish_artifact"].includes(tool)) && !ghost.hostExecution) throw new NoEffect("PC execution was revoked");
    if (work && (!["running", "waiting", "verifying"].includes(work.state) || work.deadlineAt !== null && work.deadlineAt <= Date.now())) throw new NoEffect("The Work no longer permits execution");
    if (work?.activityId) this.core.activities.authorize(work.id, tool);
  }

  /** Owner resolved an `approve_effect` decision. */
  async resolveApproval(effectId: string, approved: boolean) {
    const effect = this.ledger.effect(effectId);
    if (effect.state === "unknown") return;
    if (effect.state !== "pending") {
      // Already settled (a replay after a crash): only the notice may be missing.
      await this.notifyResolved(effect, effect.result ?? effect.state);
      return;
    }
    let result: string;
    if (!approved) {
      result = "The owner denied this action; it was not performed.";
      this.deny(effect.id, result);
    } else {
      const retained = this.waiting.get(effect.id);
      const execute = retained ? async (_effect: Effect) => retained() : this.approved.get(effect.tool);
      if (!execute) {
        result = `No executor for ${effect.tool}; nothing was performed.`;
        this.deny(effect.id, result);
      } else {
        try {
          this.authorize(effect.conversationId, effect.callId);
          result = await execute(effect);
          this.finish(effect.id, result);
        } catch (error) {
          if (error instanceof NoEffect) {
            result = error.message;
            this.deny(effect.id, result);
          } else {
            result = error instanceof Error ? error.message : String(error);
            this.unknown(effect.id, result);
            return;
          }
        }
      }
    }
    this.waiting.delete(effect.id);
    await this.notifyResolved(effect, result);
  }

  private async notifyResolved(effect: Effect, result: string) {
    if (effect.workId) {
      const work = this.ledger.work(effect.workId);
      if (TERMINAL_WORK_STATES.includes(work.state) || work.state === "blocked") return;
      this.core.works.resumeFromWaiting(work.id);
    }
    return this.core.engine.submit(effect.conversationId, {
      text: `${effect.tool} (${effect.callId}): ${result}`,
      origin: "decision",
      requestId: `effect:${effect.id}:resolved`,
    });
  }
}

/** Thrown by a performer when the effect certainly did not happen. */
export class NoEffect extends Error {
  override name = "NoEffect";
}

/** Thrown by a performer when the effect ran and failed in a known way (non-zero exit, refused write). */
export class KnownOutcome extends Error {
  override name = "KnownOutcome";
}
