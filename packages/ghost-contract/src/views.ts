import { Type, type Static } from "typebox";
import { Activity, ActivityRun, Connection } from "./autonomy.ts";
import { Duty } from "./duty.ts";
import {
  ArtifactRef,
  AutonomyPlan,
  Avatar,
  Conversation,
  Decision,
  Device,
  Effect,
  Ghost,
  Id,
  Live,
  Message,
  Notification,
  ProviderPreset,
  Sandbox,
  Schedule,
  SkillName,
  Settings,
  Space,
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
  expiresAt: Timestamp,
  message: nullable(Type.String()),
});
export type OAuthStatus = Static<typeof OAuthStatus>;

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
  spaces: Type.Array(Space),
  avatars: Type.Array(Avatar),
  settings: Settings,
  devices: Type.Array(Device),
  sandboxes: Type.Array(Sandbox),
  activities: Type.Optional(Type.Array(Activity)),
  activityRuns: Type.Optional(Type.Array(ActivityRun)),
  connections: Type.Optional(Type.Array(Connection)),
  autonomy: Type.Optional(Type.Array(AutonomyPlan)),
  /** 근무 상태. 이 기능 이전의 Host 는 보내지 않는다. */
  duty: Type.Optional(Duty),
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

/** GET /api/skills. Skills under the configured skill roots that a Ghost may be given. */
export const SkillCatalog = Type.Object({
  skills: Type.Array(Type.Object({ name: SkillName, description: Type.String({ maxLength: 2048 }) }), { maxItems: 512 }),
});
export type SkillCatalog = Static<typeof SkillCatalog>;

/** GET /api/spaces/:id/pages?query= */
export const PageSummary = Type.Object({
  pageId: Type.String(),
  locator: Type.String(),
  title: Type.String(),
  /** `pdc-markdown/1`, `pdc-html/1`, or a read-only legacy profile. */
  profile: Type.String(),
});
export type PageSummary = Static<typeof PageSummary>;

/** GET /api/spaces/:id/pages/:pageId */
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
