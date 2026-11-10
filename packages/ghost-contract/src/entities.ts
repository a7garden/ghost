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

/**
 * Host execution is unrestricted PC access, not filesystem confinement. With `worktree` the cwd must be
 * a git repository: the Host gives the Work its own worktree on branch `ghost/<work>` and runs there,
 * so the owner's checkout is never edited and Works on different worktrees run concurrently.
 */
export const ExecutionTarget = Type.Union([
  Type.Object({ kind: Type.Literal("container") }),
  Type.Object({ kind: Type.Literal("host"), cwd: Type.String({ minLength: 1, maxLength: 4096 }), worktree: Type.Optional(Type.Boolean()) }),
]);
export type ExecutionTarget = Static<typeof ExecutionTarget>;

/** Selectable Ghost grants. Lifecycle tools (including ask_parent/ask_peer/answer_question), self_adapt/capability_request, Host memory and main-only management/work_steer are fixed, not selectable. Host and desktop tools reach the owner's Mac outside the sandbox, and finance tools read the owner's brokerage accounts; none is granted by default. */
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
  Type.Literal("activity_propose"),
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("edit"),
  Type.Literal("bash"),
  Type.Literal("publish_artifact"),
  Type.Literal("delegate"),
  Type.Literal("document_spaces"),
  Type.Literal("document_list"),
  Type.Literal("document_read"),
  Type.Literal("document_propose"),
  Type.Literal("web_search"),
  Type.Literal("web_read"),
  Type.Literal("reach"),
  Type.Literal("skill_read"),
  Type.Literal("host_status"),
  Type.Literal("host_services"),
  Type.Literal("host_disk_scan"),
  Type.Literal("host_disk_usage"),
  Type.Literal("host_list"),
  Type.Literal("host_read"),
  Type.Literal("host_nodes"),
  Type.Literal("host_command_propose"),
  Type.Literal("browser_open"),
  Type.Literal("browser_snapshot"),
  Type.Literal("browser_screenshot"),
  Type.Literal("browser_read"),
  Type.Literal("browser_click"),
  Type.Literal("browser_fill"),
  Type.Literal("browser_type"),
  Type.Literal("browser_press"),
  Type.Literal("browser_select"),
  Type.Literal("browser_check"),
  Type.Literal("browser_scroll"),
  Type.Literal("browser_navigate"),
  Type.Literal("browser_tabs"),
  Type.Literal("browser_wait"),
  Type.Literal("browser_upload"),
  Type.Literal("browser_download"),
  Type.Literal("browser_propose"),
  Type.Literal("browser_handoff"),
  Type.Literal("browser_fill_secret"),
  Type.Literal("browser_close"),
  Type.Literal("vault_list"),
  Type.Literal("vault_request"),
  Type.Literal("vault_generate_login"),
  Type.Literal("connection_list"),
  Type.Literal("connection_register"),
  Type.Literal("connection_request"),
  Type.Literal("desktop_apps"),
  Type.Literal("desktop_snapshot"),
  Type.Literal("desktop_screenshot"),
  Type.Literal("desktop_click"),
  Type.Literal("desktop_fill"),
  Type.Literal("desktop_type"),
  Type.Literal("desktop_select"),
  Type.Literal("desktop_check"),
  Type.Literal("desktop_scroll"),
  Type.Literal("desktop_press"),
  Type.Literal("desktop_launch"),
  Type.Literal("desktop_focus"),
  Type.Literal("desktop_wait"),
  Type.Literal("desktop_pointer"),
  Type.Literal("desktop_keys"),
  Type.Literal("desktop_propose"),
  Type.Literal("toss_read"),
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
  "activity_propose",
  "read",
  "write",
  "edit",
  "bash",
  "publish_artifact",
  "delegate",
  "document_spaces",
  "document_list",
  "document_read",
  "document_propose",
  "web_search",
  "web_read",
  "reach",
  "skill_read",
  "host_status",
  "host_services",
  "host_disk_scan",
  "host_disk_usage",
  "host_list",
  "host_read",
  "host_nodes",
  "host_command_propose",
  "browser_open",
  "browser_snapshot",
  "browser_screenshot",
  "browser_read",
  "browser_click",
  "browser_fill",
  "browser_type",
  "browser_press",
  "browser_select",
  "browser_check",
  "browser_scroll",
  "browser_navigate",
  "browser_tabs",
  "browser_wait",
  "browser_upload",
  "browser_download",
  "browser_propose",
  "browser_handoff",
  "browser_fill_secret",
  "browser_close",
  "vault_list",
  "vault_request",
  "vault_generate_login",
  "connection_list",
  "connection_register",
  "connection_request",
  "desktop_apps",
  "desktop_snapshot",
  "desktop_screenshot",
  "desktop_click",
  "desktop_fill",
  "desktop_type",
  "desktop_select",
  "desktop_check",
  "desktop_scroll",
  "desktop_press",
  "desktop_launch",
  "desktop_focus",
  "desktop_wait",
  "desktop_pointer",
  "desktop_keys",
  "desktop_propose",
  "toss_read",
];

/** Tools that observe or change the owner's Mac. Granted only explicitly, never by default. */
export const HOST_TOOLS: readonly GhostTool[] = GHOST_TOOLS.filter((tool) => tool.startsWith("host_"));

/** The host-side browser: one session per conversation, logins kept per Ghost. */
export const BROWSER_TOOLS: readonly GhostTool[] = GHOST_TOOLS.filter((tool) => tool.startsWith("browser_"));

/** Vault metadata and requests; secret values never reach a model. */
export const VAULT_TOOLS: readonly GhostTool[] = GHOST_TOOLS.filter((tool) => tool.startsWith("vault_"));

/**
 * PC control: the owner's apps through accessibility and real input. Granted only explicitly, and usable only by a
 * Ghost the owner also allows PC 직접 실행, because driving the GUI reaches everything the owner's account can.
 */
export const DESKTOP_TOOLS: readonly GhostTool[] = GHOST_TOOLS.filter((tool) => tool.startsWith("desktop_"));

/**
 * The owner's brokerage accounts, read-only: holdings, transactions and orders reach the Ghost's model provider.
 * Granted only explicitly, never by default; each call also needs an API key the owner granted in the vault.
 */
export const FINANCE_TOOLS: readonly GhostTool[] = GHOST_TOOLS.filter((tool) => tool.startsWith("toss_"));

/** The allow-list a new Ghost gets when none is given: every selectable tool except host, PC control and finance tools. */
export const DEFAULT_GHOST_TOOLS: readonly GhostTool[] = GHOST_TOOLS.filter((tool) => !HOST_TOOLS.includes(tool) && !DESKTOP_TOOLS.includes(tool) && !FINANCE_TOOLS.includes(tool));

/** A skill directory name under the configured skills root. */
export const SkillName = Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" });
export const SkillList = Type.Array(SkillName, { uniqueItems: true, maxItems: 16 });

/** Models tried in order when the Ghost's model fails with a retryable, rate-limit or quota error. */
export const FallbackList = Type.Array(ModelRef, { maxItems: 3 });

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
  tools: GhostToolList,
  /** Fallback models after the Ghost's own model; empty means no fallback. */
  fallbacks: FallbackList,
  /** Skill names whose SKILL.md is part of this Ghost's instructions. */
  skills: SkillList,
  /** Grant for direct PC file/shell execution (owner or paired device). Never implied by sandbox tools. */
  hostExecution: Type.Optional(Type.Boolean()),
  /** Set once the owner deleted a retired Ghost; such Ghosts stay only so past Works keep their assignee. */
  deletedAt: nullable(Timestamp),
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
  /** The artifact cites recorded sources (`[S-…]`) only, and every quote placed right before a citation is in that source. */
  Type.Object({ kind: Type.Literal("artifact_citations"), name: Type.String({ minLength: 1 }) }),
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
  /** Automatic activities may suppress unchanged successful results, never failures. */
  noChange: Type.Optional(Type.Boolean()),
});
export type WorkResult = Static<typeof WorkResult>;

export const VerdictOutcome = Type.Union([Type.Literal("pass"), Type.Literal("revise"), Type.Literal("fail")]);
export type VerdictOutcome = Static<typeof VerdictOutcome>;

export const Verdict = Type.Object({
  outcome: VerdictOutcome,
  source: Type.Union([Type.Literal("checks"), Type.Literal("review"), Type.Literal("owner")]),
  reasons: Type.String({ maxLength: 8192 }),
  /** What the reviewer observed: failing check, file and line, expected vs actual. */
  evidence: Type.Optional(Type.String({ maxLength: 8192 })),
  /** The bound on a revision: what may change and what must stay untouched. */
  scope: Type.Optional(Type.String({ maxLength: 2048 })),
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
  /** Omitted legacy Works use the configured sandbox, never implicit host execution. */
  execution: Type.Optional(ExecutionTarget),
  activityId: Type.Optional(Id),
  activityRunId: Type.Optional(Id),
  /** Additional owner-approved activity allow-list; inherited by delegated children. */
  toolScope: Type.Optional(GhostToolList),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  /** Owner text is bounded to 32,768 characters; allow room for the durable project preface. */
  brief: Type.String({ minLength: 1, maxLength: 49152 }),
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
  detail: Type.String({ maxLength: 32768 }),
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

/**
 * `api` is a service credential (an optional client/key id in `username`, the secret in `value`) that only Host
 * integrations use; it is never filled into a page.
 */
export const VaultItemKind = Type.Union([Type.Literal("login"), Type.Literal("card"), Type.Literal("contact"), Type.Literal("secret"), Type.Literal("api")]);
export type VaultItemKind = Static<typeof VaultItemKind>;

export const VaultContact = Type.Object({
  name: Type.Optional(Type.String({ maxLength: 256 })),
  phone: Type.Optional(Type.String({ maxLength: 64 })),
  email: Type.Optional(Type.String({ maxLength: 256 })),
  address: Type.Optional(Type.String({ maxLength: 1024 })),
});
export type VaultContact = Static<typeof VaultContact>;

/**
 * What the owner and Ghosts may see of a vault item. Passwords, one-time-code seeds, card numbers,
 * security codes and secret values are write-only: no API or tool returns them.
 */
export const VaultItem = Type.Object({
  id: Id,
  kind: VaultItemKind,
  title: Type.String({ minLength: 1, maxLength: 256 }),
  /** Canonical https origin a login, secret or API credential belongs to. */
  origin: nullable(Type.String({ maxLength: 512 })),
  /** More exact https origins where the same login is entered, such as a separate login host (`https://login.example.com`). */
  extraOrigins: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 8 })),
  username: nullable(Type.String({ maxLength: 512 })),
  cardLast4: nullable(Type.String({ maxLength: 4 })),
  cardExpiry: nullable(Type.String({ maxLength: 16 })),
  contact: nullable(VaultContact),
  /** When to use this item, written by the owner; Ghosts read it to choose between items. */
  hints: Type.String({ maxLength: 1024 }),
  /** Ghosts allowed to use the item. */
  ghostIds: Type.Array(Id, { maxItems: 256 }),
  hasPassword: Type.Boolean(),
  hasTotp: Type.Boolean(),
  /** A one-time item from a secure form the owner chose not to keep; removed after this time. */
  expiresAt: nullable(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type VaultItem = Static<typeof VaultItem>;

/** `proposal.secureForm` of a `question` decision: the owner answers through the vault, never in chat. */
export const SecureFormRequest = Type.Object({
  kind: VaultItemKind,
  origin: nullable(Type.String({ maxLength: 512 })),
  title: nullable(Type.String({ maxLength: 256 })),
  reason: Type.String({ maxLength: 2048 }),
});
export type SecureFormRequest = Static<typeof SecureFormRequest>;

/**
 * `proposal.browserHandoff` of a `question` decision: the Ghost's browser waits for the owner. With `live`
 * the owner works it from any paired device through the Host's live view (and may open it as a Mac window);
 * without it (older decisions) a visible Mac window was opened when the question was asked.
 */
export const BrowserHandoff = Type.Object({
  url: nullable(Type.String({ maxLength: 2048 })),
  reason: Type.String({ maxLength: 2048 }),
  live: Type.Optional(Type.Boolean()),
});
export type BrowserHandoff = Static<typeof BrowserHandoff>;

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

/**
 * A Ghost's self-directed drive: the Host wakes its direct conversation at the time the Ghost (or the
 * main Ghost) planned, or earlier when a watched project Space changes. The owner can switch it off.
 */
export const AutonomyPlan = Type.Object({
  ghostId: Id,
  enabled: Type.Boolean(),
  nextAt: nullable(Timestamp),
  /** Why the Ghost will look again; empty before its first plan. */
  intent: Type.String({ maxLength: 1024 }),
  setBy: Type.Union([Type.Literal("self"), Type.Literal("main"), Type.Literal("host")]),
  watch: Type.Array(Id, { maxItems: 8 }),
  lastWakeAt: nullable(Timestamp),
  wakesToday: Type.Integer({ minimum: 0 }),
});
export type AutonomyPlan = Static<typeof AutonomyPlan>;
/** A Ghost's whole reply to a self-directed wake when nothing deserves the owner's attention. */
export const QUIET_REPLY = "[quiet]";
/** First line of the Host's self-directed wake. */
export const AUTONOMOUS_WAKE = "[Autonomous wake]";

/** Longest adaptation notes a Ghost keeps; they ride along in every direct and work instruction. */
export const ADAPTATION_MAX_CHARS = 4000;

/**
 * What a Ghost learned about working in this owner's environment (owner decision 2026-11-10): paths, command
 * forms, tools and habits that work here. The Ghost rewrites it itself, the main Ghost may correct a teammate's,
 * and the owner may edit or clear it. It is kept apart from the persona, so a persona shared elsewhere stays
 * portable while each installation adapts. Behavior only: tools and PC execution change through grants.
 */
export const Adaptation = Type.Object({
  ghostId: Id,
  notes: Type.String({ maxLength: ADAPTATION_MAX_CHARS }),
  /** The notes before the last change, so the owner can put them back. */
  previous: nullable(Type.String({ maxLength: ADAPTATION_MAX_CHARS })),
  by: Type.Union([Type.Literal("self"), Type.Literal("main"), Type.Literal("owner")]),
  /** Why the last change was made, in the owner's language. */
  reason: Type.String({ maxLength: 500 }),
  updatedAt: Timestamp,
  revision: Type.Integer({ minimum: 0 }),
});
export type Adaptation = Static<typeof Adaptation>;

/**
 * `proposal.capability` of a `question` decision: a Ghost asks for tools or PC execution it lacks. The main
 * Ghost may settle it for the owner; "허용" applies the grant before the answer reaches the Ghost.
 */
export const CapabilityRequest = Type.Object({
  ghostId: Id,
  tools: GhostToolList,
  hostExecution: Type.Boolean(),
  /** Committed with the grant, before answer delivery; recovery never re-grants after a later revocation. */
  grantedAt: Type.Optional(Timestamp),
});
export type CapabilityRequest = Static<typeof CapabilityRequest>;
/** The answer that grants a capability request; any other answer declines it. */
export const CAPABILITY_GRANT = "허용";
export const CAPABILITY_DECLINE = "거절";

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

/** Per-device push mute preferences; the in-app inbox is unaffected. */
export const DeviceAlerts = Type.Object({
  mutedKinds: Type.Array(NotificationKind, { maxItems: 8, uniqueItems: true }),
  mutedGhostIds: Type.Array(Id, { maxItems: 512, uniqueItems: true }),
});
export type DeviceAlerts = Static<typeof DeviceAlerts>;

export const Device = Type.Object({
  id: Id,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  pushEnabled: Type.Boolean(),
  alerts: DeviceAlerts,
  createdAt: Timestamp,
  lastSeenAt: nullable(Timestamp),
});
export type Device = Static<typeof Device>;

export const Space = Type.Object({
  id: Id,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  path: Type.String({ minLength: 1, maxLength: 4096 }),
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
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), { minItems: 1, maxItems: 2, uniqueItems: true })),
  reasoning: Type.Optional(Type.Boolean()),
  reasoningEfforts: Type.Optional(Type.Array(Type.Union([
    Type.Literal("none"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
    Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
  ]), { minItems: 1, maxItems: 7, uniqueItems: true })),
  reasoningToggle: Type.Optional(Type.Boolean()),
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
  /** Stored model entries, distinct from the effective catalog in `models`; settings projection only. */
  configuredModels: Type.Optional(Type.Array(ModelInfo, { maxItems: 256 })),
  /** Stored IDs outside the automatic catalog; settings projection only. */
  manualModelIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 256 })),
  /** Whether this endpoint automatically includes its compatible catalog; settings projection only. */
  automaticModels: Type.Optional(Type.Boolean()),
  /** Credential kind while a valid credential exists; emitted by the host's settingsView, never stored in the ledger. */
  authType: Type.Optional(AuthType),
  hasCredential: Type.Boolean(),
});
export type Provider = Static<typeof Provider>;

/**
 * How long a decision may wait before the Host takes its recommendation, and whether the main Ghost may
 * decide reversible ones for the owner. 2026-11-10 owner decision: 30 minutes, reversible only.
 * Spending, card entry, sending and deleting always wait for the owner.
 */
export const ApprovalPolicy = Type.Object({
  /** Minutes before a recommended answer or a reversible approval goes ahead; 0 turns it off. */
  autoMinutes: Type.Integer({ minimum: 0, maximum: 1440 }),
  delegate: Type.Union([Type.Literal("reversible"), Type.Literal("none")]),
  /** Per-Ghost exception: `owner` makes every decision of that Ghost wait for the owner, whatever the defaults say. */
  ghosts: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Union([Type.Literal("auto"), Type.Literal("owner")]))),
});
export type ApprovalPolicy = Static<typeof ApprovalPolicy>;
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { autoMinutes: 30, delegate: "reversible" };
/** The language everything the owner reads is written in; Ghosts may reason in any language. */
export const OwnerLanguage = Type.String({ minLength: 2, maxLength: 32, pattern: "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$" });
export const DEFAULT_OWNER_LANGUAGE = "ko";

export const Settings = Type.Object({
  defaultModel: nullable(ModelRef),
  reviewModel: nullable(ModelRef),
  /** Model for Host memory consolidation; null follows defaultModel. */
  memoryModel: Type.Optional(nullable(ModelRef)),
  providers: Type.Array(Provider, { maxItems: 64 }),
  ownerLanguage: Type.Optional(OwnerLanguage),
  approvals: Type.Optional(ApprovalPolicy),
});
export type Settings = Static<typeof Settings>;

/**
 * A named provider the host offers for setup. Models combine the refreshed
 * external catalog with the bundled SDK fallback, not account verification.
 * OAuth models remain separate from the API-key catalog. The custom
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
  /** Project references captured at submission, independent of later renames/deletion. */
  spaces: Type.Optional(Type.Array(Type.Object({ id: Id, name: Type.String() }), { maxItems: 8 })),
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
