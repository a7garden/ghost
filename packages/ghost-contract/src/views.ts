import { Type, type Static } from "typebox";
import { Activity, ActivityRun, Connection } from "./autonomy.ts";
import {
  ArtifactRef,
  Avatar,
  Conversation,
  Decision,
  Device,
  DeviceGrant,
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
  Timestamp,
  Work,
  nullable,
} from "./entities.ts";

export const Principal = Type.Union([
  Type.Object({ kind: Type.Literal("owner") }),
  Type.Object({ kind: Type.Literal("device"), deviceId: Id, name: Type.String(), grants: Type.Array(DeviceGrant) }),
]);
export type Principal = Static<typeof Principal>;

export const Runtime = Type.Object({
  /** False when no model provider can run conversations. */
  ready: Type.Boolean(),
  detail: Type.String(),
  version: Type.String(),
});
export type Runtime = Static<typeof Runtime>;

/** Owner-only /api/providers/:id/oauth; tokens never cross this boundary. */
export const OAuthStatus = Type.Object({
  state: Type.Union([Type.Literal("pending"), Type.Literal("done"), Type.Literal("failed"), Type.Literal("cancelled")]),
  userCode: nullable(Type.String()),
  verificationUri: nullable(Type.String()),
  expiresAt: Timestamp,
  message: nullable(Type.String()),
});
export type OAuthStatus = Static<typeof OAuthStatus>;

/** GET /api/state. A device sees only what its grants cover; owner-only collections are empty for devices. */
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
  deviceName: Type.String({ minLength: 1, maxLength: 128 }),
});
export type PairingClaim = Static<typeof PairingClaim>;

export const PairingResult = Type.Object({ deviceId: Id, token: Type.String() });
export type PairingResult = Static<typeof PairingResult>;

/** GET /api/providers/catalog (owner only). Cached provider presets and model metadata; public API catalogs are not account-verified. */
export const ProviderCatalog = Type.Array(ProviderPreset, { maxItems: 64 });
export type ProviderCatalog = Static<typeof ProviderCatalog>;

/** GET /api/skills (owner only). Skills under the configured skill roots that a Ghost may be given. */
export const SkillCatalog = Type.Object({
  skills: Type.Array(Type.Object({ name: SkillName, description: Type.String({ maxLength: 2048 }) }), { maxItems: 512 }),
});
export type SkillCatalog = Static<typeof SkillCatalog>;

/** GET /api/spaces/:id/pages?query= (owner only) */
export const PageSummary = Type.Object({
  pageId: Type.String(),
  locator: Type.String(),
  title: Type.String(),
  /** `pdc-markdown/1`, `pdc-html/1`, or a read-only legacy profile. */
  profile: Type.String(),
});
export type PageSummary = Static<typeof PageSummary>;

/** GET /api/spaces/:id/pages/:pageId (owner only) */
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
