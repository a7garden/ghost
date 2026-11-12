import {
  DEFAULT_APPROVAL_POLICY,
  type Activity,
  type ApprovalPolicy,
  type EffectClass,
  type PolicyAutoResolve,
  type PolicyConditions,
  type PolicyContext,
  type PolicyDecision,
  type PolicyEvaluation,
  type PolicyReviewer,
  type PolicyRule,
} from "@ghost/contract";

const RANK: Record<PolicyDecision, number> = { allow: 0, review: 1, owner: 2, deny: 3 };

type Resolved = PolicyEvaluation["reviewers"][number];

/** A rule after its limits: an exceeded allow or review becomes owner and loses its automatic settlement. */
type Applied = { rule: PolicyRule; decision: PolicyDecision; autoResolve: PolicyAutoResolve | null; note: string | null };

/**
 * Decide who settles an effect. Pure: the same effect, context and rules always give the same result.
 * Every matching rule counts and the strictest wins, so a narrower allow never opens what a broader owner or
 * deny rule holds. No matching rule: owner for anything external, irreversible or outside the workspace.
 */
export function evaluatePolicy(effect: EffectClass, context: PolicyContext, rules: readonly PolicyRule[]): PolicyEvaluation {
  const matched = rules.filter((rule) => matches(rule, effect, context));
  if (matched.length === 0) {
    const internal = effect.target.kind === "workspace" && effect.reversible && !effect.external;
    return {
      decision: internal ? "allow" : "owner", ruleIds: [], decidedBy: [], reviewers: [], autoResolve: null,
      reason: internal ? "No rule matched; a reversible change inside the workspace is allowed." : "No rule matched; external, irreversible or outside-workspace effects go to the owner.",
    };
  }
  const applied = matched.map((rule) => apply(rule, effect, context));
  let decision = applied.reduce<PolicyDecision>((top, entry) => (RANK[entry.decision] > RANK[top] ? entry.decision : top), "allow");
  const deciding = applied.filter((entry) => entry.decision === decision);
  const ruleIds = matched.map((rule) => rule.id);
  const decidedBy = deciding.map((entry) => entry.rule.id);
  const notes = deciding.flatMap((entry) => (entry.note ? [entry.note] : []));
  if (decision === "allow" || decision === "deny") {
    return { decision, ruleIds, decidedBy, reviewers: [], autoResolve: null, reason: `${decision === "deny" ? "Denied" : "Allowed"} by ${list(decidedBy)}.` };
  }
  const autoResolve = merge(deciding.map((entry) => entry.autoResolve));
  if (decision === "review") {
    const reviewers = resolve(deciding.map((entry) => entry.rule.reviewer), context);
    if (reviewers.length > 0) return { decision, ruleIds, decidedBy, reviewers, autoResolve, reason: `${list(decidedBy)} sends this to a reviewer.` };
    // A Ghost never settles its own effect: with no other reviewer available the owner decides.
    decision = "owner";
    notes.push("no reviewer other than the proposing Ghost is available");
  }
  // Whoever any matching review or owner rule names looks first and leaves a view for the owner.
  const advisors = resolve(applied.filter((entry) => RANK[entry.rule.decision] >= RANK.review && RANK[entry.rule.decision] <= RANK.owner).map((entry) => entry.rule.reviewer), context);
  return {
    decision, ruleIds, decidedBy, reviewers: advisors, autoResolve,
    reason: `${list(decidedBy)} needs the owner${notes.length ? `: ${notes.join("; ")}` : ""}.`,
  };
}

function list(ids: string[]): string {
  return `${ids.length === 1 ? "rule" : "rules"} ${ids.join(", ")}`;
}

function matches(rule: PolicyRule, effect: EffectClass, context: PolicyContext): boolean {
  if (rule.scopeId !== undefined && rule.scopeId !== context.scopeId) return false;
  if (rule.ghostId !== undefined && rule.ghostId !== context.ghostId) return false;
  if (rule.triggerId !== undefined && rule.triggerId !== context.triggerId) return false;
  if (!glob(rule.tool, effect.tool)) return false;
  const when = rule.when;
  if (when.targetKind !== undefined && when.targetKind !== effect.target.kind) return false;
  if (when.targetId !== undefined && (effect.target.id === null || !glob(when.targetId, effect.target.id))) return false;
  if (when.access !== undefined && when.access !== effect.access) return false;
  if (when.reversible !== undefined && when.reversible !== effect.reversible) return false;
  if (when.external !== undefined && when.external !== effect.external) return false;
  if (when.amount !== undefined && when.amount !== (effect.amount !== null)) return false;
  if (when.untrustedInput !== undefined && when.untrustedInput !== effect.taint.untrustedInput) return false;
  if (when.privateData !== undefined && when.privateData !== effect.taint.privateData) return false;
  return true;
}

/** `*` matches any run of characters; nothing else is special, so ids with dots or slashes stay literal. */
function glob(pattern: string, value: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === value;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (value.length < first.length + last.length || !value.startsWith(first) || !value.endsWith(last)) return false;
  let at = first.length;
  const end = value.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const found = value.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

function apply(rule: PolicyRule, effect: EffectClass, context: PolicyContext): Applied {
  const declared = rule.decision === "allow" || rule.decision === "deny" ? null : rule.autoResolve ?? null;
  if (rule.decision === "deny") return { rule, decision: "deny", autoResolve: null, note: null };
  const exceeded = limitExceeded(rule, effect, context);
  if (exceeded) return { rule, decision: "owner", autoResolve: null, note: `${rule.id} exceeded ${exceeded}` };
  if (rule.decision === "review" && !rule.reviewer) return { rule, decision: "owner", autoResolve: declared, note: `${rule.id} names no reviewer` };
  return { rule, decision: rule.decision, autoResolve: declared, note: null };
}

function limitExceeded(rule: PolicyRule, effect: EffectClass, context: PolicyContext): string | null {
  if (rule.maxPerDay !== undefined && (context.counts[rule.id] ?? 0) >= rule.maxPerDay) return `its limit of ${rule.maxPerDay} a day`;
  const limit = rule.maxAmount;
  const amount = effect.amount;
  // An amount the Host could not read, or in another currency, cannot be shown to be within the limit.
  if (limit && amount && (amount.value === null || amount.currency !== limit.currency || amount.value > limit.value)) return `its amount limit of ${limit.value} ${limit.currency}`;
  return null;
}

/** Automatic settlement survives only if every deciding rule grants it the same way; the longest wait applies. */
function merge(entries: (PolicyAutoResolve | null)[]): PolicyAutoResolve | null {
  const granted = entries.filter((entry): entry is PolicyAutoResolve => entry !== null);
  const first = granted[0];
  if (!first || granted.length !== entries.length || granted.some((entry) => entry.answer !== first.answer)) return null;
  return { afterMinutes: Math.max(...granted.map((entry) => entry.afterMinutes)), answer: first.answer };
}

/** Resolve `main`, drop the proposing Ghost and an absent main, keep rule order without duplicates. */
function resolve(refs: (PolicyReviewer | undefined)[], context: PolicyContext): Resolved[] {
  const out: Resolved[] = [];
  for (const ref of refs) {
    if (!ref) continue;
    const resolved: Resolved | null = ref.kind === "main" ? (context.mainGhostId ? { kind: "ghost", ghostId: context.mainGhostId } : null) : ref;
    if (!resolved || (resolved.kind === "ghost" && resolved.ghostId === context.ghostId)) continue;
    if (out.some((seen) => (seen.kind === "ghost" ? resolved.kind === "ghost" && seen.ghostId === resolved.ghostId : resolved.kind === "slot" && seen.slot === resolved.slot))) continue;
    out.push(resolved);
  }
  return out;
}

/**
 * One row of today's approval behavior. `main`: the main Ghost looks first (settles a review, leaves a view on an
 * owner card). `auto`: a reversible decision the Host settles when the owner's wait runs out.
 */
type Row = { id: string; tool: string; when?: PolicyConditions; decision: PolicyDecision; main?: true; auto?: PolicyAutoResolve["answer"] };

/**
 * Today's approval behavior as rules (2026-11-12). Each row cites the code it reproduces; the effect
 * classifications each tool must report are in the policy test table.
 */
const ROWS: readonly Row[] = [
  // Journaled and run without a decision.
  { id: "workspace", tool: "*", when: { targetKind: "workspace" }, decision: "allow" },
  { id: "scope-path", tool: "*", when: { targetKind: "scope_path" }, decision: "allow" },
  { id: "reads", tool: "*", when: { access: "read" }, decision: "allow" },
  { id: "host-state", tool: "*", when: { targetKind: "host" }, decision: "allow" },
  { id: "browser", tool: "browser_*", decision: "allow" },
  { id: "desktop", tool: "desktop_*", decision: "allow" },
  { id: "mail-update", tool: "mail_update", decision: "allow" },
  // tools/browser.ts guardAction: a high-impact target or a checkout page refuses the click; browser_propose asks.
  { id: "browser-click-irreversible", tool: "browser_click", when: { reversible: false }, decision: "deny" },
  { id: "browser-click-amount", tool: "browser_click", when: { amount: true }, decision: "deny" },
  { id: "browser-press-irreversible", tool: "browser_press", when: { reversible: false }, decision: "deny" },
  { id: "browser-press-amount", tool: "browser_press", when: { amount: true }, decision: "deny" },
  // tools/desktop.ts guard: sending, paying or deleting goes through desktop_propose.
  { id: "desktop-click-irreversible", tool: "desktop_click", when: { reversible: false }, decision: "deny" },
  { id: "desktop-press-irreversible", tool: "desktop_press", when: { reversible: false }, decision: "deny" },
  { id: "desktop-pointer-irreversible", tool: "desktop_pointer", when: { reversible: false }, decision: "deny" },
  { id: "desktop-keys-irreversible", tool: "desktop_keys", when: { reversible: false }, decision: "deny" },
  // core/decisions.ts OWNER_ONLY_EFFECTS, secure forms, browser handoffs and goal proposals: the owner alone.
  { id: "connection-write", tool: "connection_request", when: { access: "write" }, decision: "owner" },
  { id: "connection-register", tool: "connection_register", decision: "owner" },
  { id: "browser-handoff", tool: "browser_handoff", decision: "owner" },
  { id: "vault-form", tool: "vault_request", decision: "owner" },
  { id: "goal", tool: "goal_propose", decision: "owner" },
  // Not reversible: the owner settles, the main Ghost leaves its view first.
  { id: "browser-propose", tool: "browser_propose", decision: "owner", main: true },
  { id: "browser-fill-card", tool: "browser_fill_card", decision: "owner", main: true },
  { id: "desktop-propose", tool: "desktop_propose", decision: "owner", main: true },
  { id: "mail-send", tool: "mail_send", decision: "owner", main: true },
  { id: "host-command-irreversible", tool: "host_command_propose", when: { access: "write", reversible: false }, decision: "owner", main: true },
  { id: "document-edit", tool: "document_propose", when: { reversible: false }, decision: "owner", main: true },
  { id: "activity-propose-mac", tool: "activity_propose", when: { targetKind: "mac" }, decision: "owner", main: true },
  { id: "activity-propose-external", tool: "activity_propose", when: { external: true }, decision: "owner", main: true },
  { id: "question", tool: "ask_owner", when: { reversible: false }, decision: "owner", main: true },
  { id: "result-unchecked", tool: "complete", when: { reversible: false }, decision: "owner", main: true },
  // core/decisions.ts reversible(): the main Ghost may settle; withReview() adds the owner-wait timeout.
  { id: "host-command", tool: "host_command_propose", when: { access: "write", reversible: true }, decision: "review", main: true, auto: "approve" },
  { id: "document-new", tool: "document_propose", when: { reversible: true }, decision: "review", main: true, auto: "approve" },
  { id: "activity-propose", tool: "activity_propose", decision: "review", main: true, auto: "approve" },
  { id: "capability", tool: "capability_request", decision: "review", main: true, auto: "recommended" },
  // A request that opens the Mac never goes ahead on silence.
  { id: "capability-mac", tool: "capability_request", when: { targetKind: "mac" }, decision: "review", main: true },
  { id: "question-recommended", tool: "ask_owner", when: { reversible: true }, decision: "review", main: true, auto: "recommended" },
  // A result is never accepted on silence (2026-11-12).
  { id: "result", tool: "complete", when: { targetKind: "host", reversible: true }, decision: "review", main: true },
  { id: "document-write", tool: "document_write", when: { targetKind: "document_vault" }, decision: "allow" },
  { id: "outside-mac", tool: "*", when: { targetKind: "mac", access: "write", reversible: false }, decision: "owner" },
  { id: "browser-unknown-effect", tool: "browser_*", when: { targetKind: "browser_origin", reversible: false }, decision: "owner" },
  { id: "money", tool: "*", when: { amount: true }, decision: "owner" },
  { id: "rule-of-two", tool: "*", when: { access: "write", external: true, untrustedInput: true, privateData: true }, decision: "owner" },
];

const INSTALL = { kind: "install" } as const;

function ruleOf(row: Row, approvals: ApprovalPolicy, extra: Partial<PolicyRule> = {}): PolicyRule {
  const reviewer: PolicyReviewer | undefined = row.main && approvals.delegate === "reversible" ? { kind: "main" } : undefined;
  // With delegation off nobody but the owner settles; the owner-wait timeout still applies.
  const decision = row.decision === "review" && !reviewer ? "owner" : row.decision;
  return {
    id: row.id, tool: row.tool, when: row.when ?? {}, decision,
    ...(reviewer ? { reviewer } : {}),
    ...(row.auto && approvals.autoMinutes > 0 ? { autoResolve: { afterMinutes: approvals.autoMinutes, answer: row.auto } } : {}),
    revision: 1, createdBy: INSTALL, ...extra,
  };
}

/**
 * Today's behavior under the given approval settings. A Ghost the owner set to `owner` gets an owner twin of
 * every review rule: its decisions wait for the owner, the main Ghost still leaves its view.
 */
export function approvalRules(approvals: ApprovalPolicy = DEFAULT_APPROVAL_POLICY): PolicyRule[] {
  const rules = ROWS.map((row) => ruleOf(row, approvals));
  const owned = Object.entries(approvals.ghosts ?? {}).filter(([, mode]) => mode === "owner").map(([ghostId]) => ghostId).sort();
  for (const ghostId of owned) {
    for (const row of ROWS) {
      if (row.decision === "review") rules.push(ruleOf({ ...row, ...(row.id === "result" ? { when: { reversible: true } } : {}), decision: "owner", auto: undefined }, approvals, { id: `${row.id}:${ghostId}`, ghostId }));
    }
  }
  return rules;
}

export const DEFAULT_RULES: readonly PolicyRule[] = approvalRules();

/**
 * An activity's external-action setting as trigger-scoped rules (core/activities.ts action(), tools/connections.ts
 * connection_request). Dry runs refuse external actions in code, whatever the rules say.
 */
export function activityRules(activity: Pick<Activity, "id" | "policy">, approvals: ApprovalPolicy = DEFAULT_APPROVAL_POLICY): PolicyRule[] {
  const scoped = { triggerId: activity.id };
  const id = (name: string) => `activity:${activity.id}:${name}`;
  switch (activity.policy.externalActions) {
    case "deny":
      return [
        ruleOf({ id: id("action"), tool: "activity_action", decision: "deny" }, approvals, scoped),
        ruleOf({ id: id("connection-write"), tool: "connection_request", when: { access: "write" }, decision: "deny" }, approvals, scoped),
        ruleOf({ id: id("external-write"), tool: "*", when: { access: "write", external: true }, decision: "deny" }, approvals, scoped),
      ];
    case "approval":
      return [
        ruleOf({ id: id("action"), tool: "activity_action", decision: "owner", main: true }, approvals, scoped),
        ruleOf({ id: id("external-write"), tool: "*", when: { access: "write", external: true }, decision: "owner" }, approvals, scoped),
      ];
    case "allow":
      return [ruleOf({ id: id("action"), tool: "activity_action", decision: "allow" }, approvals, scoped)];
  }
}
