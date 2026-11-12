import type { Decision, EffectClass, EffectTaint, PolicyEvaluation, PolicyRule } from "@ghost/contract";
import type { Core } from "./core.ts";
import { forbidden } from "./errors.ts";
import { digestOf } from "./ids.ts";
import { evaluatePolicy } from "./policy.ts";

/** Only Host adapters construct this, never tool arguments or MCP annotations. */
export type ObservedEffect = Omit<EffectClass, "tool" | "taint">;
export type PolicyReceipt = { classification: EffectClass; evaluation: PolicyEvaluation; rulesDigest: string; scopeId: string | null; ghostId: string; day: string; reserved: string[]; positions: Record<string, number> };
const cleanTaint: EffectTaint = { untrustedInput: false, privateData: false };

export function markPolicyRead(core: Core, conversationId: string, flags: Partial<EffectTaint>): void {
  core.ledger.tx(() => {
    const visited = new Set<string>();
    let current: string | null = conversationId;
    while (current && !visited.has(current)) {
      visited.add(current);
      const before = core.ledger.setting<EffectTaint>(`policy:taint:${current}`, cleanTaint);
      core.ledger.putSetting(`policy:taint:${current}`, { untrustedInput: before.untrustedInput || !!flags.untrustedInput, privateData: before.privateData || !!flags.privateData });
      current = core.ledger.setting<string | null>(`subagent:parent:${current}`, null);
    }
  });
}

export function policyTaint(core: Core, conversationId: string): EffectTaint {
  const flags = { ...cleanTaint };
  const visited = new Set<string>();
  let current: string | null = conversationId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const stored = core.ledger.setting<EffectTaint>(`policy:taint:${current}`, cleanTaint);
    flags.untrustedInput ||= stored.untrustedInput;
    flags.privateData ||= stored.privateData;
    const conversation = core.ledger.conversation(current);
    const work = conversation.workId ? core.ledger.work(conversation.workId) : null;
    if (work?.activityId) {
      const source = core.ledger.activity(work.activityId).source.kind;
      flags.untrustedInput ||= source !== "schedule";
      flags.privateData ||= source !== "schedule";
    }
    current = core.ledger.setting<string | null>(`subagent:parent:${current}`, null) ?? work?.originConversationId ?? null;
  }
  return flags;
}

export function classifyEffect(core: Core, conversationId: string, tool: string, input: unknown, observed?: ObservedEffect): EffectClass {
  const conversation = core.ledger.conversation(conversationId);
  const work = conversation.workId ? core.ledger.work(conversation.workId) : null;
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  let facts: ObservedEffect = { target: { kind: "mac", id: null }, access: "write", reversible: false, external: true, amount: null };
  if (["write", "edit", "publish_artifact"].includes(tool)) facts = { ...facts, target: { kind: work?.execution?.kind === "host" ? "mac" : "workspace", id: work?.id ?? null }, external: false, reversible: true };
  // Workspace shell has public egress. It is not proof that an opaque command cannot send or spend.
  if (tool === "bash" && work?.execution?.kind === "container") facts = { ...facts, target: { kind: "workspace", id: work.id }, external: false, reversible: true };
  if (tool === "mail_send" || tool === "mail_update") facts = { ...facts, target: { kind: "mail_account", id: typeof args.account === "string" ? args.account : null }, external: tool === "mail_send", reversible: tool === "mail_update" };
  if (tool === "document_write" || tool === "document_propose") facts = { ...facts, target: { kind: "document_vault", id: typeof args.scopeId === "string" ? args.scopeId : null }, external: false, reversible: !(args.pageId ?? args.page_id) };
  if (tool === "connection_request" || tool.startsWith("conn.")) facts = { ...facts, target: { kind: "connection", id: typeof args.connectionId === "string" ? args.connectionId : null } };
  if (tool.startsWith("mcp.")) facts = { ...facts, target: { kind: "mcp_server", id: tool.split(".")[1] ?? null } };
  if (tool.startsWith("browser_")) facts = { ...facts, target: { kind: "browser_origin", id: null } };
  if (tool === "browser_close") facts = { ...facts, reversible: true, external: false };
  if (["self_adapt", "vault_generate_login", "activity_propose", "capability_request", "ask_owner", "vault_request", "goal_propose", "complete", "config_propose"].includes(tool)) facts = { ...facts, target: { kind: "host", id: null }, external: false };
  if (tool === "self_adapt" || tool === "vault_generate_login") facts = { ...facts, reversible: true };
  const taint = policyTaint(core, conversationId);
  return { ...(observed ?? facts), tool, taint };
}

/** Caller holds the same ledger transaction as effect/decision admission. Reservations count before I/O. */
export function evaluateStoredPolicy(core: Core, conversationId: string, classification: EffectClass, prior?: PolicyReceipt, reserve = false): PolicyReceipt {
  const ledger = core.ledger;
  const conversation = ledger.conversation(conversationId);
  const work = conversation.workId ? ledger.work(conversation.workId) : null;
  const scopeId = prior ? prior.scopeId : work ? work.scopeId : ledger.setting<{ scopeId: string | null }>(`context:${conversation.id}`, { scopeId: null }).scopeId;
  const day = new Date(Date.now()).toISOString().slice(0, 10);
  const rules = ledger.policyRules();
  const counts = ledger.setting<Record<string, number>>(`policy:counts:${day}`, {});
  const effective = { ...counts };
  if (prior?.day === day) for (const id of prior.reserved) effective[id] = prior.positions?.[id] ?? Math.max(0, (effective[id] ?? 0) - 1);
  const main = ledger.defaultGhost();
  const fresh = { ...classification, taint: policyTaint(core, conversationId) };
  const evaluation = evaluatePolicy(fresh, { ghostId: conversation.ghostId, scopeId, triggerId: work?.activityId ?? null, mainGhostId: main?.state === "active" ? main.id : null, counts: effective }, rules);
  // A missing reviewer or slot cannot silently grant authority.
  evaluation.reviewers = evaluation.reviewers.filter((ref) => ref.kind === "slot"
    ? !!ledger.settings().slots?.[ref.slot] && !!main && main.id !== conversation.ghostId && main.state === "active"
    : ledger.ghosts().some((ghost) => ghost.id === ref.ghostId && ghost.state === "active" && ghost.deletedAt === null));
  const requiredReview = rules.some((rule) => evaluation.decidedBy.includes(rule.id) && rule.decision === "review");
  if ((evaluation.decision === "review" || requiredReview) && evaluation.reviewers.length === 0) {
    evaluation.decision = "owner";
    evaluation.autoResolve = null;
    evaluation.reason += " Configured reviewer or slot is unavailable; configure an active independent reviewer or ask the owner to decide explicitly.";
  }
  const reserved = prior?.day === day ? [...prior.reserved] : [];
  const positions = prior?.day === day ? { ...prior.positions } : {};
  if (reserve && evaluation.decision !== "deny") {
    for (const id of evaluation.ruleIds) if (!reserved.includes(id)) { positions[id] = counts[id] ?? 0; counts[id] = (counts[id] ?? 0) + 1; reserved.push(id); }
    ledger.putSetting(`policy:counts:${day}`, counts);
  }
  return { classification: fresh, evaluation, rulesDigest: digestOf(rules), scopeId, ghostId: conversation.ghostId, day, reserved, positions };
}

export function policyRead(core: Core, conversationId: string, classification: EffectClass | (ObservedEffect & { tool: string })): void {
  if (classification.access !== "read") throw forbidden("read admission requires a Host-observed read");
  core.ledger.tx(() => {
    const receipt = evaluateStoredPolicy(core, conversationId, classifyEffect(core, conversationId, classification.tool, null, classification));
    if (receipt.evaluation.decision !== "allow") throw forbidden(receipt.evaluation.reason);
    markPolicyRead(core, conversationId, { untrustedInput: ["browser_origin", "connection", "mcp_server", "mail_account"].includes(classification.target.kind), privateData: ["mail_account", "mac"].includes(classification.target.kind) });
  });
}

export function decisionTool(decision: Pick<Decision, "kind" | "proposal">): string {
  if (decision.kind === "accept_result") return "complete";
  if (decision.kind === "document_review") return "document_propose";
  if (decision.proposal?.secureForm) return "vault_request";
  if (decision.proposal?.browserHandoff) return "browser_handoff";
  if (decision.proposal?.capability) return "capability_request";
  if (decision.proposal?.goal) return "goal_propose";
  return "ask_owner";
}

/** Conservative structural proof: anything not provably tightening must be proposed to the owner. */
export function isPolicyTightening(before: PolicyRule | null, after: PolicyRule | null): boolean {
  if (!before) return after?.decision === "deny" || after?.decision === "owner" && after.autoResolve === undefined;
  if (!after) return false;
  const rank = { allow: 0, review: 1, owner: 2, deny: 3 };
  const { id: _a, revision: _b, createdBy: _c, decision: _d, maxPerDay: _e, maxAmount: _f, autoResolve: _g, ...oldMatch } = before;
  const { id: _h, revision: _i, createdBy: _j, decision: _k, maxPerDay: _l, maxAmount: _m, autoResolve: _n, ...newMatch } = after;
  return before.id === after.id && digestOf(before.createdBy) === digestOf(after.createdBy) && digestOf(oldMatch) === digestOf(newMatch) && rank[after.decision] >= rank[before.decision]
    && (before.maxPerDay === undefined || (after.maxPerDay !== undefined && after.maxPerDay <= before.maxPerDay))
    && (before.maxAmount === undefined || (after.maxAmount !== undefined && after.maxAmount.currency === before.maxAmount.currency && after.maxAmount.value <= before.maxAmount.value))
    && (after.autoResolve === undefined || (before.autoResolve !== undefined && after.autoResolve.answer === before.autoResolve.answer && after.autoResolve.afterMinutes >= before.autoResolve.afterMinutes));
}
