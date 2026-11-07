import { Type, type Static, type TSchema } from "typebox";

export const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const Id = Type.String({ minLength: 1, maxLength: 128 });
/** Epoch milliseconds. */
export const Timestamp = Type.Integer({ minimum: 0 });
export const Sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const Thinking = Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]);
export type Thinking = Static<typeof Thinking>;

export const ModelRef = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 128 }),
  model: Type.String({ minLength: 1, maxLength: 256 }),
  thinking: Type.Optional(Thinking),
});
export type ModelRef = Static<typeof ModelRef>;

/** Eye styles of the built-in Ghost portrait. */
export const LookFace = Type.Union([Type.Literal("bars"), Type.Literal("dots"), Type.Literal("arcs"), Type.Literal("tall")]);
export type LookFace = Static<typeof LookFace>;

/** Body silhouette of the built-in Ghost portrait; all share the round body's top and width. */
export const LookShape = Type.Union([Type.Literal("round"), Type.Literal("egg"), Type.Literal("squircle"), Type.Literal("sheet")]);
export type LookShape = Static<typeof LookShape>;

/** A single minimal accent on the built-in Ghost portrait. */
export const LookMark = Type.Union([
  Type.Literal("none"), Type.Literal("halo"), Type.Literal("antenna"), Type.Literal("sprout"), Type.Literal("ring"), Type.Literal("spark"),
  Type.Literal("crown"), Type.Literal("bow"), Type.Literal("ears"), Type.Literal("horns"), Type.Literal("headphones"), Type.Literal("glasses"),
]);
export type LookMark = Static<typeof LookMark>;

export const Look = Type.Object({
  avatarId: nullable(Id),
  body: Type.Optional(Type.String({ maxLength: 32 })),
  background: Type.Optional(Type.String({ maxLength: 32 })),
  shape: Type.Optional(LookShape),
  face: Type.Optional(LookFace),
  mark: Type.Optional(LookMark),
});
export type Look = Static<typeof Look>;

export const GhostState = Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("retired")]);
export type GhostState = Static<typeof GhostState>;

/** Tools the owner may grant a Ghost, by name. Lifecycle tools (ask_owner, complete, work_status, artifact_read, effect_list, verdict) and the main-only ghost_inspect/ghost_update are not selectable. */
export const GhostTool = Type.Union([
  Type.Literal("work_create"),
  Type.Literal("work_list"),
  Type.Literal("work_inspect"),
  Type.Literal("work_update"),
  Type.Literal("work_cancel"),
  Type.Literal("schedule_create"),
  Type.Literal("schedule_list"),
  Type.Literal("schedule_cancel"),
  Type.Literal("ghost_list"),
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("edit"),
  Type.Literal("bash"),
  Type.Literal("publish_artifact"),
  Type.Literal("delegate"),
  Type.Literal("memory_search"),
  Type.Literal("memory_recall"),
  Type.Literal("memory_retain"),
  Type.Literal("document_spaces"),
  Type.Literal("document_list"),
  Type.Literal("document_read"),
  Type.Literal("document_propose"),
]);
export type GhostTool = Static<typeof GhostTool>;

/** Every selectable tool, in contract order. */
export const GHOST_TOOLS: readonly GhostTool[] = [
  "work_create",
  "work_list",
  "work_inspect",
  "work_update",
  "work_cancel",
  "schedule_create",
  "schedule_list",
  "schedule_cancel",
  "ghost_list",
  "read",
  "write",
  "edit",
  "bash",
  "publish_artifact",
  "delegate",
  "memory_search",
  "memory_recall",
  "memory_retain",
  "document_spaces",
  "document_list",
  "document_read",
  "document_propose",
];

/** An explicit allow-list: unknown names and duplicates are schema errors. */
export const GhostToolList = Type.Array(GhostTool, { uniqueItems: true, maxItems: GHOST_TOOLS.length });

export const Ghost = Type.Object({
  id: Id,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  persona: Type.String({ maxLength: 8192 }),
  look: Look,
  /** Null follows the default model in settings. */
  model: nullable(ModelRef),
  isDefault: Type.Boolean(),
  state: GhostState,
  /** The persisted allow-list of optional tools; [] disables all of them. */
  tools: GhostToolList,
  directConversationId: Id,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Ghost = Static<typeof Ghost>;

export const ConversationKind = Type.Union([Type.Literal("direct"), Type.Literal("work"), Type.Literal("review")]);
export type ConversationKind = Static<typeof ConversationKind>;

export const Conversation = Type.Object({
  id: Id,
  ghostId: Id,
  kind: ConversationKind,
  workId: nullable(Id),
  title: Type.String({ maxLength: 256 }),
  /** Null follows the Ghost's model. */
  model: nullable(ModelRef),
  busy: Type.Boolean(),
  createdAt: Timestamp,
  lastActivityAt: Timestamp,
});
export type Conversation = Static<typeof Conversation>;

export const ArtifactRef = Type.Object({
  digest: Sha256,
  name: Type.String({ minLength: 1, maxLength: 256 }),
  mediaType: Type.String({ minLength: 1, maxLength: 128 }),
  size: Type.Integer({ minimum: 0 }),
});
export type ArtifactRef = Static<typeof ArtifactRef>;

/** Deterministic acceptance checks. Only owner-authored or parent-authored specs carry them. */
export const Check = Type.Union([
  Type.Object({ kind: Type.Literal("artifact_sha256"), name: Type.String({ minLength: 1 }), sha256: Sha256 }),
  Type.Object({ kind: Type.Literal("artifact_contains"), name: Type.String({ minLength: 1 }), text: Type.String({ minLength: 1 }) }),
  Type.Object({ kind: Type.Literal("command_exit_zero"), command: Type.String({ minLength: 1 }) }),
  Type.Object({ kind: Type.Literal("command_stdout"), command: Type.String({ minLength: 1 }), stdout: Type.String() }),
]);
export type Check = Static<typeof Check>;

export const Reviewer = Type.Union([
  Type.Object({ kind: Type.Literal("ghost"), ghostId: Id }),
  Type.Object({ kind: Type.Literal("model"), model: ModelRef }),
]);
export type Reviewer = Static<typeof Reviewer>;

export const Acceptance = Type.Object({
  criteria: Type.String({ maxLength: 8192 }),
  checks: Type.Array(Check, { maxItems: 16 }),
  reviewer: nullable(Reviewer),
});
export type Acceptance = Static<typeof Acceptance>;

export const WorkState = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("verifying"),
  Type.Literal("blocked"),
  Type.Literal("done"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);
export type WorkState = Static<typeof WorkState>;

export const TERMINAL_WORK_STATES: readonly WorkState[] = ["done", "failed", "cancelled"];

export const WorkResult = Type.Object({
  summary: Type.String({ maxLength: 16384 }),
  artifacts: Type.Array(ArtifactRef, { maxItems: 64 }),
});
export type WorkResult = Static<typeof WorkResult>;

export const VerdictOutcome = Type.Union([Type.Literal("pass"), Type.Literal("revise"), Type.Literal("fail")]);
export type VerdictOutcome = Static<typeof VerdictOutcome>;

export const Verdict = Type.Object({
  outcome: VerdictOutcome,
  source: Type.Union([Type.Literal("checks"), Type.Literal("review"), Type.Literal("owner")]),
  reasons: Type.String({ maxLength: 8192 }),
  at: Timestamp,
});
export type Verdict = Static<typeof Verdict>;

export const Work = Type.Object({
  id: Id,
  parentId: nullable(Id),
  rootId: Id,
  /** Assignee. */
  ghostId: Id,
  /** Where the request came from and where the report goes: a direct conversation for a root Work, the parent's work conversation for a child. */
  originConversationId: Id,
  /** The assignee's work conversation; null until the Work first runs. */
  conversationId: nullable(Id),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  brief: Type.String({ minLength: 1, maxLength: 32768 }),
  acceptance: Acceptance,
  state: WorkState,
  revision: Type.Integer({ minimum: 1 }),
  revisionsUsed: Type.Integer({ minimum: 0 }),
  deadlineAt: nullable(Timestamp),
  result: nullable(WorkResult),
  verdict: nullable(Verdict),
  /** Human-readable reason for failed, blocked or cancelled. */
  reason: nullable(Type.String({ maxLength: 4096 })),
  createdAt: Timestamp,
  startedAt: nullable(Timestamp),
  endedAt: nullable(Timestamp),
  updatedAt: Timestamp,
});
export type Work = Static<typeof Work>;

export const DecisionKind = Type.Union([
  Type.Literal("approve_effect"),
  Type.Literal("question"),
  Type.Literal("accept_result"),
  Type.Literal("document_review"),
  Type.Literal("reconcile_effect"),
]);
export type DecisionKind = Static<typeof DecisionKind>;

export const DecisionState = Type.Union([
  Type.Literal("pending"),
  Type.Literal("approved"),
  Type.Literal("denied"),
  Type.Literal("answered"),
  Type.Literal("cancelled"),
]);
export type DecisionState = Static<typeof DecisionState>;

export const Decision = Type.Object({
  id: Id,
  kind: DecisionKind,
  ghostId: Id,
  conversationId: Id,
  workId: nullable(Id),
  effectId: nullable(Id),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  detail: Type.String({ maxLength: 16384 }),
  /** Suggested answers for a question. */
  options: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 8 }),
  /** Kind-specific payload shown to the owner: the exact browser action, the document body, the result. */
  proposal: nullable(Type.Record(Type.String(), Type.Unknown())),
  state: DecisionState,
  answer: nullable(Type.String({ maxLength: 8192 })),
  createdAt: Timestamp,
  resolvedAt: nullable(Timestamp),
});
export type Decision = Static<typeof Decision>;

export const EffectState = Type.Union([Type.Literal("pending"), Type.Literal("done"), Type.Literal("unknown"), Type.Literal("denied")]);
export type EffectState = Static<typeof EffectState>;

export const Effect = Type.Object({
  id: Id,
  workId: nullable(Id),
  conversationId: Id,
  callId: Type.String({ minLength: 1, maxLength: 256 }),
  tool: Type.String({ minLength: 1, maxLength: 128 }),
  summary: Type.String({ maxLength: 2048 }),
  inputDigest: Sha256,
  state: EffectState,
  /** Bounded observed result (stdout tail, written path, published digest). */
  result: nullable(Type.String({ maxLength: 16384 })),
  createdAt: Timestamp,
  endedAt: nullable(Timestamp),
});
export type Effect = Static<typeof Effect>;

export const ScheduleSpec = Type.Union([
  Type.Object({ kind: Type.Literal("at"), at: Timestamp }),
  Type.Object({ kind: Type.Literal("every"), seconds: Type.Integer({ minimum: 60 }), startAt: Timestamp }),
]);
export type ScheduleSpec = Static<typeof ScheduleSpec>;

export const Schedule = Type.Object({
  id: Id,
  ghostId: Id,
  conversationId: Id,
  prompt: Type.String({ minLength: 1, maxLength: 8192 }),
  spec: ScheduleSpec,
  nextAt: nullable(Timestamp),
  state: Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("done")]),
  createdAt: Timestamp,
});
export type Schedule = Static<typeof Schedule>;

export const NotificationKind = Type.Union([
  Type.Literal("decision"),
  Type.Literal("work_done"),
  Type.Literal("work_failed"),
  Type.Literal("message"),
]);
export type NotificationKind = Static<typeof NotificationKind>;

export const Notification = Type.Object({
  id: Id,
  kind: NotificationKind,
  ghostId: nullable(Id),
  conversationId: nullable(Id),
  workId: nullable(Id),
  decisionId: nullable(Id),
  title: Type.String({ maxLength: 256 }),
  body: Type.String({ maxLength: 2048 }),
  createdAt: Timestamp,
  readAt: nullable(Timestamp),
});
export type Notification = Static<typeof Notification>;

export const DeviceGrant = Type.Object({
  ghostId: Id,
  /** Null grants every direct conversation of the Ghost. */
  conversationId: nullable(Id),
});
export type DeviceGrant = Static<typeof DeviceGrant>;

export const Device = Type.Object({
  id: Id,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  grants: Type.Array(DeviceGrant, { maxItems: 64 }),
  pushEnabled: Type.Boolean(),
  createdAt: Timestamp,
  lastSeenAt: nullable(Timestamp),
});
export type Device = Static<typeof Device>;

export const SpaceGrant = Type.Object({
  ghostId: Id,
  mode: Type.Union([Type.Literal("read"), Type.Literal("propose")]),
});
export type SpaceGrant = Static<typeof SpaceGrant>;

export const Space = Type.Object({
  id: Id,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  grants: Type.Array(SpaceGrant, { maxItems: 64 }),
  createdAt: Timestamp,
});
export type Space = Static<typeof Space>;

export const Avatar = Type.Object({
  id: Id,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  description: Type.String({ maxLength: 2048 }),
  imageDigest: Sha256,
  /** UI-owned sprite design data. */
  design: nullable(Type.Record(Type.String(), Type.Unknown())),
  createdAt: Timestamp,
});
export type Avatar = Static<typeof Avatar>;

export const ModelInfo = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 256 }),
  name: Type.String({ maxLength: 256 }),
  contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
});
export type ModelInfo = Static<typeof ModelInfo>;

export const ProviderKind = Type.Union([
  Type.Literal("openai"),
  Type.Literal("openai_compatible"),
  Type.Literal("anthropic"),
  Type.Literal("zai"),
  Type.Literal("minimax"),
  Type.Literal("google"),
]);
export type ProviderKind = Static<typeof ProviderKind>;

/** How the stored provider credential authenticates. */
export const AuthType = Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]);
export type AuthType = Static<typeof AuthType>;

export const Provider = Type.Object({
  id: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" }),
  kind: ProviderKind,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  baseUrl: nullable(Type.String({ maxLength: 2048 })),
  models: Type.Array(ModelInfo, { maxItems: 256 }),
  /** Credential kind while a valid credential exists; emitted by the host's settingsView, never stored in the ledger. */
  authType: Type.Optional(AuthType),
  hasCredential: Type.Boolean(),
});
export type Provider = Static<typeof Provider>;

export const Settings = Type.Object({
  defaultModel: nullable(ModelRef),
  reviewModel: nullable(ModelRef),
  providers: Type.Array(Provider, { maxItems: 64 }),
});
export type Settings = Static<typeof Settings>;

/**
 * A named provider the host offers for setup. `models` and `oauthModels` are
 * the bundled SDK's static chat catalogs — never account-verified — and the
 * recommendation ids only ever point into those catalogs. The custom
 * OpenAI-compatible preset carries empty catalogs and null urls.
 */
export const ProviderPreset = Type.Object({
  id: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" }),
  kind: ProviderKind,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  /** Default upstream address; null for the custom OpenAI-compatible provider. */
  baseUrl: nullable(Type.String({ maxLength: 2048 })),
  /** Official page where a key is managed; null when none applies. */
  credentialUrl: nullable(Type.String({ maxLength: 2048 })),
  models: Type.Array(ModelInfo, { maxItems: 256 }),
  /** ChatGPT-login catalog for the OpenAI preset; empty elsewhere. */
  oauthModels: Type.Array(ModelInfo, { maxItems: 256 }),
  recommendedModelId: nullable(Type.String({ maxLength: 256 })),
  recommendedOAuthModelId: nullable(Type.String({ maxLength: 256 })),
});
export type ProviderPreset = Static<typeof ProviderPreset>;

export const Sandbox = Type.Object({
  ghostId: Id,
  state: Type.Union([Type.Literal("none"), Type.Literal("stopped"), Type.Literal("running"), Type.Literal("error")]),
  detail: Type.String({ maxLength: 2048 }),
});
export type Sandbox = Static<typeof Sandbox>;

export const MessageRole = Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool"), Type.Literal("note")]);
export type MessageRole = Static<typeof MessageRole>;

/** Why a user-role message exists: who woke the Ghost. */
export const MessageOrigin = Type.Union([
  Type.Literal("owner"),
  Type.Literal("work"),
  Type.Literal("child_result"),
  Type.Literal("decision"),
  Type.Literal("schedule"),
  Type.Literal("verdict"),
  Type.Literal("report"),
]);
export type MessageOrigin = Static<typeof MessageOrigin>;

export const ToolCallView = Type.Object({
  callId: Type.String(),
  name: Type.String(),
  /** Bounded argument preview. */
  args: Type.String({ maxLength: 4096 }),
});
export type ToolCallView = Static<typeof ToolCallView>;

export const Message = Type.Object({
  /** Pi entry id. */
  id: Type.String(),
  conversationId: Id,
  role: MessageRole,
  origin: nullable(MessageOrigin),
  text: Type.String(),
  /** The model's reasoning before an assistant reply, when the provider streams it. Absent when empty. */
  thinking: Type.Optional(Type.String()),
  toolCalls: Type.Array(ToolCallView),
  /** Present on tool results. */
  tool: nullable(Type.Object({ callId: Type.String(), name: Type.String(), isError: Type.Boolean() })),
  attachments: Type.Array(ArtifactRef),
  createdAt: Timestamp,
});
export type Message = Static<typeof Message>;

export const LiveTool = Type.Object({
  callId: Type.String(),
  name: Type.String(),
  output: Type.String({ maxLength: 16384 }),
});
export type LiveTool = Static<typeof LiveTool>;

export const Live = Type.Object({
  conversationId: Id,
  running: Type.Boolean(),
  /** Streaming assistant text of the current generation. */
  partial: nullable(Type.String()),
  /** Streaming reasoning of the current generation, when the provider streams it. Absent when empty. */
  thinking: Type.Optional(Type.String()),
  tools: Type.Array(LiveTool),
});
export type Live = Static<typeof Live>;
