import { Type, type Static } from "typebox";
import { Id, nullable } from "./entities.ts";

/**
 * Policy (docs/ghost-infrastructure.md section 4). Every action that reaches outside the conversation is an
 * effect, classified on fixed axes by where it lands, never by its tool name or command string. Rules are data
 * that decide who settles each effect; the Host enforces them.
 */

/**
 * Where an effect lands. `host` is the Host's own state (Ghost settings and grants, goals, activities,
 * credentials, questions to the owner); `mac` is the owner's Mac outside any scope path.
 */
export const EffectTargetKind = Type.Union([
  Type.Literal("workspace"),
  Type.Literal("scope_path"),
  Type.Literal("mac"),
  Type.Literal("document_vault"),
  Type.Literal("connection"),
  Type.Literal("mcp_server"),
  Type.Literal("browser_origin"),
  Type.Literal("mail_account"),
  Type.Literal("host"),
]);
export type EffectTargetKind = Static<typeof EffectTargetKind>;

/** `id` names the instance: scope path, space id, connection id, MCP server name, origin, mail account id. */
export const EffectTarget = Type.Object({
  kind: EffectTargetKind,
  id: nullable(Type.String({ minLength: 1, maxLength: 4096 })),
});
export type EffectTarget = Static<typeof EffectTarget>;

/** Reads change nothing; attached tools count as writes unless the owner marks them read-only. */
export const EffectAccess = Type.Union([Type.Literal("read"), Type.Literal("write")]);
export type EffectAccess = Static<typeof EffectAccess>;

/** Money the effect moves. A null value means the page showed spending the Host could not read. */
export const EffectAmount = Type.Object({
  value: nullable(Type.Number({ minimum: 0 })),
  currency: nullable(Type.String({ pattern: "^[A-Z]{3}$" })),
});
export type EffectAmount = Static<typeof EffectAmount>;

/** What the conversation that proposes the effect has read so far; the Host tracks it, never the model. */
export const EffectTaint = Type.Object({
  untrustedInput: Type.Boolean(),
  privateData: Type.Boolean(),
});
export type EffectTaint = Static<typeof EffectTaint>;

/** One effect on the fixed axes. `reversible` is false unless the tool can show otherwise. */
export const EffectClass = Type.Object({
  tool: Type.String({ minLength: 1, maxLength: 256 }),
  target: EffectTarget,
  access: EffectAccess,
  reversible: Type.Boolean(),
  /** True when something leaves the device for a third party (mail, post, comment, API write). */
  external: Type.Boolean(),
  amount: nullable(EffectAmount),
  taint: EffectTaint,
});
export type EffectClass = Static<typeof EffectClass>;

/** Strictest first: deny > owner > review > allow. */
export const PolicyDecision = Type.Union([Type.Literal("allow"), Type.Literal("review"), Type.Literal("owner"), Type.Literal("deny")]);
export type PolicyDecision = Static<typeof PolicyDecision>;

/** `main` is whichever Ghost is the default Ghost when the effect is evaluated. */
export const PolicyReviewer = Type.Union([
  Type.Object({ kind: Type.Literal("ghost"), ghostId: Id }),
  Type.Object({ kind: Type.Literal("slot"), slot: Type.String({ minLength: 1, maxLength: 128 }) }),
  Type.Object({ kind: Type.Literal("main") }),
]);
export type PolicyReviewer = Static<typeof PolicyReviewer>;

/**
 * Settle a waiting decision when nobody has answered in time. `approve` approves the effect; `recommended`
 * takes the answer the asking Ghost recommended (a question).
 */
export const PolicyAutoResolve = Type.Object({
  afterMinutes: Type.Integer({ minimum: 1, maximum: 1440 }),
  answer: Type.Union([Type.Literal("approve"), Type.Literal("recommended")]),
});
export type PolicyAutoResolve = Static<typeof PolicyAutoResolve>;

export const PolicyAmountLimit = Type.Object({
  value: Type.Number({ minimum: 0 }),
  currency: Type.String({ pattern: "^[A-Z]{3}$" }),
});
export type PolicyAmountLimit = Static<typeof PolicyAmountLimit>;

/** Glob over tool names or target ids: `*` matches any run of characters, everything else is literal. */
export const PolicyPattern = Type.String({ minLength: 1, maxLength: 4096 });

/** Axis values a rule requires; an absent field matches any value. */
export const PolicyConditions = Type.Object({
  targetKind: Type.Optional(EffectTargetKind),
  targetId: Type.Optional(PolicyPattern),
  access: Type.Optional(EffectAccess),
  reversible: Type.Optional(Type.Boolean()),
  external: Type.Optional(Type.Boolean()),
  /** True: only effects that carry an amount; false: only effects without one. */
  amount: Type.Optional(Type.Boolean()),
  untrustedInput: Type.Optional(Type.Boolean()),
  privateData: Type.Optional(Type.Boolean()),
});
export type PolicyConditions = Static<typeof PolicyConditions>;

export const PolicyAuthor = Type.Union([
  Type.Object({ kind: Type.Literal("install") }),
  Type.Object({ kind: Type.Literal("owner") }),
  Type.Object({ kind: Type.Literal("ghost"), ghostId: Id }),
]);
export type PolicyAuthor = Static<typeof PolicyAuthor>;

export const PolicyRule = Type.Object({
  id: Id,
  scopeId: Type.Optional(Id),
  ghostId: Type.Optional(Id),
  /** The standing trigger (today an activity) whose run proposes the effect. */
  triggerId: Type.Optional(Id),
  tool: PolicyPattern,
  when: PolicyConditions,
  decision: PolicyDecision,
  /**
   * Required for `review`: who may settle it. On `owner` it names who looks first and leaves a view for the
   * owner without settling. A review rule without a reviewer is enforced as `owner`.
   */
  reviewer: Type.Optional(PolicyReviewer),
  /** Past this many applications a day the rule asks the owner instead. */
  maxPerDay: Type.Optional(Type.Integer({ minimum: 1 })),
  /** Above this amount, in another currency or with an unreadable amount, the rule asks the owner instead. */
  maxAmount: Type.Optional(PolicyAmountLimit),
  /** Only on `review` and `owner`. */
  autoResolve: Type.Optional(PolicyAutoResolve),
  revision: Type.Integer({ minimum: 1 }),
  createdBy: PolicyAuthor,
});
export type PolicyRule = Static<typeof PolicyRule>;

/** Who proposes the effect and what the per-rule counters read; supplied by the Host at evaluation. */
export type PolicyContext = {
  ghostId: string;
  scopeId: string | null;
  triggerId: string | null;
  /** The current default Ghost, which a `main` reviewer resolves to; null when there is no active one. */
  mainGhostId: string | null;
  /** Applications of each rule today, by rule id, counted in that rule's own scope. */
  counts: Readonly<Record<string, number>>;
};

export const PolicyEvaluation = Type.Object({
  decision: PolicyDecision,
  /** Every matching rule, in rule order. */
  ruleIds: Type.Array(Id),
  /** The matching rules whose decision prevailed; empty when no rule matched. */
  decidedBy: Type.Array(Id),
  /** `review`: who may settle it. `owner`: who looks first and leaves a view. Never the proposing Ghost. */
  reviewers: Type.Array(Type.Union([
    Type.Object({ kind: Type.Literal("ghost"), ghostId: Id }),
    Type.Object({ kind: Type.Literal("slot"), slot: Type.String({ minLength: 1, maxLength: 128 }) }),
  ])),
  autoResolve: nullable(PolicyAutoResolve),
  reason: Type.String(),
});
export type PolicyEvaluation = Static<typeof PolicyEvaluation>;
