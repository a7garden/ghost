import { PolicyRule } from "./policy.ts";
import { CodingRun } from "./coding-run.ts";
import { McpServer } from "./mcp.ts";
import { ConfigRevision } from "./entities.ts";
import { Type, type Static } from "typebox";
import { Activity, ActivityRun, Connection } from "./autonomy.ts";
import { Duty } from "./duty.ts";
import { Goal, Milestone } from "./goals.ts";
import { Call } from "./calls.ts";
import {
  Adaptation,
  ArtifactRef,
  AutonomyPlan,
  Avatar,
  Conversation,
  Decision,
  AuthType,
  Device,
  Effect,
  Ghost,
  GhostPackage,
  Id,
  Live,
  Message,
  Notification,
  ProviderPreset,
  ProviderKind,
  Sandbox,
  Schedule,
  SkillList,
  SkillName,
  Settings,
  Scope,
  Sha256,
  Timestamp,
  Work,
  nullable,
} from "./entities.ts";

export const Principal = Type.Union([
  Type.Object({ kind: Type.Literal("owner") }),
  Type.Object({ kind: Type.Literal("device"), deviceId: Id, name: Type.String() }),
]);
export type Principal = Static<typeof Principal>;

export const Runtime = Type.Object({
  /** False when no model provider can run conversations. */
  ready: Type.Boolean(),
  detail: Type.String(),
  version: Type.String(),
});
export type Runtime = Static<typeof Runtime>;

/** /api/providers/:id/oauth for the owner or a paired device; tokens never cross this boundary. */
export const OAuthStatus = Type.Object({
  state: Type.Union([Type.Literal("pending"), Type.Literal("done"), Type.Literal("failed"), Type.Literal("cancelled")]),
  userCode: nullable(Type.String()),
  verificationUri: nullable(Type.String()),
  /** Browser sign-in address (Anthropic); the user opens it, the callback or a pasted code completes the login. */
  authUrl: nullable(Type.String()),
  expiresAt: Timestamp,
  message: nullable(Type.String()),
});
export type OAuthStatus = Static<typeof OAuthStatus>;

/**
 * GET /api/providers/local-auth: credentials other agents on the Host's Mac already hold, matched to the Ghost
 * provider that would receive them. Owner or paired device only; secret values never cross this boundary.
 */
export const LocalAuthSource = Type.Object({
  /** Stable per source credential: `<agent>:<key>`. */
  id: Type.String({ pattern: "^[a-z]{2,16}:[A-Za-z0-9._-]{1,64}$" }),
  agent: Type.Union([Type.Literal("codex"), Type.Literal("omp"), Type.Literal("pi")]),
  /** Display name of the agent, e.g. "Codex CLI". */
  agentName: Type.String({ maxLength: 64 }),
  kind: ProviderKind,
  authType: AuthType,
  /** Email, or the last characters of an API key, to tell several credentials apart. */
  account: nullable(Type.String({ maxLength: 256 })),
  /** The Ghost provider that receives it; `exists: false` means the import adds it from its preset. */
  target: Type.Object({
    providerId: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" }),
    name: Type.String({ maxLength: 128 }),
    exists: Type.Boolean(),
    hasCredential: Type.Boolean(),
  }),
});
export type LocalAuthSource = Static<typeof LocalAuthSource>;

/** POST /api/providers/local-auth/import. `replace` is required when the target already holds a credential. */
export const LocalAuthImport = Type.Object({
  sourceId: LocalAuthSource.properties.id,
  replace: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type LocalAuthImport = Static<typeof LocalAuthImport>;

export const LocalAuthResult = Type.Object({
  providerId: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" }),
  created: Type.Boolean(),
});
export type LocalAuthResult = Static<typeof LocalAuthResult>;

/** GET /api/state. Every authenticated principal receives the same snapshot except its own principal field. */
export const State = Type.Object({
  /** Apply events with a greater seq on top of this snapshot. */
  seq: Type.Integer({ minimum: 0 }),
  principal: Principal,
  runtime: Runtime,
  ghosts: Type.Array(Ghost),
  conversations: Type.Array(Conversation),
  /** Live Work plus the most recent settled Work. */
  works: Type.Array(Work),
  decisions: Type.Array(Decision),
  notifications: Type.Array(Notification),
  schedules: Type.Array(Schedule),
  scopes: Type.Array(Scope),
  policyRules: Type.Array(PolicyRule),
  mcpServers: Type.Array(McpServer),
  configRevisions: Type.Array(ConfigRevision),
  avatars: Type.Array(Avatar),
  settings: Settings,
  devices: Type.Array(Device),
  sandboxes: Type.Array(Sandbox),
  activities: Type.Optional(Type.Array(Activity)),
  activityRuns: Type.Optional(Type.Array(ActivityRun)),
  connections: Type.Optional(Type.Array(Connection)),
  autonomy: Type.Optional(Type.Array(AutonomyPlan)),
  /** What each Ghost learned about this environment; only Ghosts with notes appear. */
  adaptations: Type.Optional(Type.Array(Adaptation)),
  /** 근무 상태. 이 기능 이전의 Host 는 보내지 않는다. */
  duty: Type.Optional(Duty),
  /** Team goals with every milestone; the Host before goals sends neither. */
  goals: Type.Optional(Type.Array(Goal)),
  milestones: Type.Optional(Type.Array(Milestone)),
  /** Recent voice calls, newest first; the Host before calls sends none. */
  calls: Type.Optional(Type.Array(Call)),
});
export type State = Static<typeof State>;

/** GET /api/conversations/:id */
export const ConversationPage = Type.Object({
  conversation: Conversation,
  /** Oldest first. */
  messages: Type.Array(Message),
  /** Pass as `before` to load older messages; null at the beginning. */
  before: nullable(Type.String()),
  live: nullable(Live),
});
export type ConversationPage = Static<typeof ConversationPage>;

/** GET /api/works/:id */
export const WorkDetail = Type.Object({
  work: Work,
  ancestors: Type.Array(Work),
  children: Type.Array(Work),
  effects: Type.Array(Effect),
  decisions: Type.Array(Decision),
  artifacts: Type.Array(ArtifactRef),
  codingRuns: Type.Optional(Type.Array(CodingRun)),
});
export type WorkDetail = Static<typeof WorkDetail>;

/** POST /api/commands result for device.pairing_start */
export const PairingOffer = Type.Object({
  code: Type.String(),
  expiresAt: Timestamp,
  /** Origin the device should claim against. */
  origin: Type.String(),
});
export type PairingOffer = Static<typeof PairingOffer>;

/** POST /api/pairing/claim (unauthenticated, rate limited) */
export const PairingClaim = Type.Object({
  code: Type.String({ minLength: 6, maxLength: 32 }),
  /** Trimmed at claim; an empty name becomes "iPhone". */
  deviceName: Type.String({ maxLength: 128 }),
});
export type PairingClaim = Static<typeof PairingClaim>;

export const PairingResult = Type.Object({ deviceId: Id, token: Type.String() });
export type PairingResult = Static<typeof PairingResult>;

/** GET /api/providers/catalog. Cached provider presets and model metadata; public API catalogs are not account-verified. */
export const ProviderCatalog = Type.Array(ProviderPreset, { maxItems: 64 });
export type ProviderCatalog = Static<typeof ProviderCatalog>;

/** One usage window of a subscription (5 hours, a week, a month); `usedPercent` is 0–100. */
export const ProviderQuotaWindow = Type.Object({
  label: Type.String({ maxLength: 64 }),
  usedPercent: Type.Number({ minimum: 0, maximum: 100 }),
  /** When the window resets; null when the provider does not say. */
  resetsAt: nullable(Timestamp),
});
export type ProviderQuotaWindow = Static<typeof ProviderQuotaWindow>;

/**
 * GET /api/providers/quota. Subscription usage read from each provider's own account: Codex (ChatGPT login),
 * Z.AI and MiniMax (API key) from the configured providers, and Claude from the Claude Code login on this Mac.
 * Providers without a usage API are absent. `error` is set when the last read failed; `windows` then holds the
 * last good reading, if any. No credential crosses this boundary.
 */
export const ProviderQuota = Type.Object({
  /** The configured provider's id, or `claude-code` for the Claude Code login. */
  id: Type.String({ maxLength: 64 }),
  name: Type.String({ maxLength: 128 }),
  plan: nullable(Type.String({ maxLength: 64 })),
  windows: Type.Array(ProviderQuotaWindow, { maxItems: 16 }),
  error: nullable(Type.String({ maxLength: 256 })),
  /** When `windows` was read from the provider. */
  fetchedAt: nullable(Timestamp),
});
export type ProviderQuota = Static<typeof ProviderQuota>;

export const ProviderQuotas = Type.Array(ProviderQuota, { maxItems: 64 });
export type ProviderQuotas = Static<typeof ProviderQuotas>;

/** GET /api/skills. Skills under the configured skill roots that a Ghost may be given. */
export const SkillCatalog = Type.Object({
  skills: Type.Array(Type.Object({ name: SkillName, description: Type.String({ maxLength: 2048 }) }), { maxItems: 512 }),
});
export type SkillCatalog = Static<typeof SkillCatalog>;

/**
 * GET /api/ghost-packages. Every installable package with what installing it means here: the Ghost it is already
 * installed as, the main Ghost's projects it would take, and its skills this Host does not have (they are left out).
 * `errors` names owner package files that failed to load.
 */
export const GhostPackageCatalog = Type.Object({
  packages: Type.Array(Type.Object({
    ...GhostPackage.properties,
    installedGhostId: nullable(Id),
    suggestedScopeIds: Type.Array(Id, { maxItems: 256 }),
    missingSkills: SkillList,
  }), { maxItems: 256 }),
  errors: Type.Array(Type.Object({ path: Type.String({ maxLength: 4096 }), message: Type.String({ maxLength: 1024 }) }), { maxItems: 256 }),
});
export type GhostPackageCatalog = Static<typeof GhostPackageCatalog>;
export type GhostPackageEntry = GhostPackageCatalog["packages"][number];

/** GET /api/scopes/:id/pages?query= */
export const PageSummary = Type.Object({
  pageId: Type.String(),
  locator: Type.String(),
  title: Type.String(),
  /** `pdc-markdown/1`, `pdc-html/1`, or a read-only legacy profile. */
  profile: Type.String(),
});
export type PageSummary = Static<typeof PageSummary>;

/** GET /api/scopes/:id/pages/:pageId */
export const PageView = Type.Object({
  pageId: Type.String(),
  locator: Type.String(),
  title: Type.String(),
  profile: Type.String(),
  body: Type.String(),
  /** Pass back as `expectedHash` when saving an edit. */
  hash: Type.String(),
});
export type PageView = Static<typeof PageView>;

/** GET /api/update. The Host's own release update; the owner starts every install. */
export const UpdateStatus = Type.Object({
  /** A release build running from `<base>/releases/<name>/ghost` with `<base>/current` pointing at it, started by the `ghost service install` launcher. */
  enabled: Type.Boolean(),
  disabledReason: Type.Union([Type.Null(), Type.Literal("development"), Type.Literal("layout"), Type.Literal("service")]),
  hasCredential: Type.Boolean(),
  current: Type.Object({ version: Type.String(), commit: Type.String() }),
  autoCheck: Type.Boolean(),
  phase: Type.Union([
    Type.Literal("idle"),
    Type.Literal("checking"),
    Type.Literal("downloading"),
    Type.Literal("waiting"),
    Type.Literal("installing"),
    Type.Literal("error"),
  ]),
  /** The newest verified release, only when it is newer than the running Host. */
  latest: nullable(Type.Object({ version: Type.String(), commit: Type.String(), notes: Type.String(), publishedAt: Type.String() })),
  /** The desktop shell offered by the newest verified release; the shell compares it with its own version. */
  shell: nullable(Type.Object({ version: Type.String(), notes: Type.String() })),
  /** The iPhone shell offered by the newest verified release; the app compares its native build number. */
  ios: nullable(Type.Object({ version: Type.String(), build: Type.Integer({ minimum: 1 }), notes: Type.String() })),
  checkedAt: nullable(Timestamp),
  nextCheckAt: nullable(Timestamp),
  error: nullable(Type.String()),
  lastResult: nullable(
    Type.Object({
      outcome: Type.Union([Type.Literal("installed"), Type.Literal("rolled_back"), Type.Literal("failed")]),
      from: Type.String(),
      to: Type.String(),
      at: Timestamp,
    }),
  ),
});
export type UpdateStatus = Static<typeof UpdateStatus>;

/** PUT /api/memory/:ghostId. One owner edit; a replay of the same requestId is the same edit. */
export const MemoryWriteRequest = Type.Object({
  /** Virtual memory path, e.g. /me/topic.md, /team/<ghostId>/topic.md or /owner.md. */
  path: Type.String({ minLength: 1, maxLength: 256 }),
  content: Type.String({ maxLength: 32 * 1024 }),
  /** Exact hash of the version being replaced; null creates a new file only. */
  expectedHash: nullable(Sha256),
  requestId: Id,
});
export type MemoryWriteRequest = Static<typeof MemoryWriteRequest>;

/** DELETE /api/memory/:ghostId. Deletes keep every revision. */
export const MemoryDeleteRequest = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 256 }),
  expectedHash: Sha256,
  requestId: Id,
});
export type MemoryDeleteRequest = Static<typeof MemoryDeleteRequest>;

export const MetricsFilter = Type.Object({
  scopeId: Type.Optional(nullable(Id)), ghostId: Type.Optional(Id), slot: Type.Optional(Type.String()), ruleId: Type.Optional(Id),
});
export type MetricsFilter = Static<typeof MetricsFilter>;
const MetricRatio = nullable(Type.Number());
export const MetricsView = Type.Object({
  filter: MetricsFilter,
  works: Type.Integer({ minimum: 0 }), completed: Type.Integer({ minimum: 0 }), rejected: Type.Integer({ minimum: 0 }),
  completionRate: MetricRatio, rejectionRate: MetricRatio,
  elapsedMsPerAcceptedWork: MetricRatio, tokensPerAcceptedWork: MetricRatio, costPerAcceptedWork: MetricRatio,
  ownerOverturnedVerdicts: Type.Integer({ minimum: 0 }), quotaWaitMs: Type.Number({ minimum: 0 }), repeatGuardHits: Type.Integer({ minimum: 0 }),
  observationHistoryComplete: Type.Boolean(), usageComplete: Type.Boolean(),
  rules: Type.Record(Type.String(), Type.Object({ approved: Type.Integer({ minimum: 0 }), denied: Type.Integer({ minimum: 0 }) })),
});
export type MetricsView = Static<typeof MetricsView>;

/** GET /api/folders?path=&hidden=: the sub-folders of one directory on the Host's Mac, for choosing a work folder. */
export const FolderListing = Type.Object({
  /** The directory shown, resolved to its real path. */
  path: Type.String(),
  /** Null at the filesystem root. */
  parent: nullable(Type.String()),
  home: Type.String(),
  /** True when the listing was cut at the entry limit. */
  truncated: Type.Boolean(),
  entries: Type.Array(Type.Object({ name: Type.String(), path: Type.String(), git: Type.Boolean() })),
  /** Places to start from: the home folder and the folders the owner already uses. */
  shortcuts: Type.Array(Type.Object({ label: Type.String(), path: Type.String() })),
});
export type FolderListing = Static<typeof FolderListing>;
