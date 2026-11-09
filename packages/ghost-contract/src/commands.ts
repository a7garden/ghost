import { Type, type Static } from "typebox";
import { ActivityConfig, ConnectionConfig } from "./autonomy.ts";
import {
  Acceptance,
  ArtifactRef,
  ExecutionTarget,
  FallbackList,
  GhostToolList,
  SkillList,
  Id,
  Look,
  ModelInfo,
  ModelRef,
  ProviderKind,
  ScheduleSpec,
  Timestamp,
  GhostState,
  DeviceAlerts,
  nullable,
} from "./entities.ts";

const command = <K extends string, P extends Parameters<typeof Type.Object>[0]>(type: K, properties: P) =>
  Type.Object({ type: Type.Literal(type), ...properties }, { additionalProperties: false });

const Text = (max: number) => Type.String({ minLength: 1, maxLength: max });
const DataUrl = Type.String({ pattern: "^data:image/(png|webp);base64,[A-Za-z0-9+/=]+$", maxLength: 8_000_000 });

/** Every mutation a client can request. Reads are plain GET routes. */
export const Command = Type.Union([
  // Conversations
  command("message.send", {
    conversationId: Id,
    text: Text(32768),
    attachments: Type.Optional(Type.Array(ArtifactRef, { maxItems: 16 })),
    spaceIds: Type.Optional(Type.Array(Id, { maxItems: 8, uniqueItems: true })),
  }),
  command("message.cancel", { conversationId: Id }),
  command("conversation.create", { ghostId: Id, title: Type.Optional(Text(256)) }),
  command("conversation.update", {
    conversationId: Id,
    title: Type.Optional(Text(256)),
    model: Type.Optional(nullable(ModelRef)),
  }),

  // Work (맡긴 일)
  command("work.create", {
    ghostId: Id,
    title: Text(256),
    brief: Text(32768),
    spaceIds: Type.Optional(Type.Array(Id, { maxItems: 8, uniqueItems: true })),
    acceptance: Type.Optional(Acceptance),
    deadlineAt: Type.Optional(nullable(Timestamp)),
    execution: Type.Optional(ExecutionTarget),
    /** Direct conversation that receives the report; defaults to the Ghost's main direct conversation. */
    originConversationId: Type.Optional(Id),
  }),
  command("work.update", {
    workId: Id,
    title: Type.Optional(Text(256)),
    brief: Type.Optional(Text(32768)),
    acceptance: Type.Optional(Acceptance),
    deadlineAt: Type.Optional(nullable(Timestamp)),
  }),
  command("work.cancel", { workId: Id }),
  /** Re-queue a failed or blocked root Work with its current brief. */
  command("work.resume", { workId: Id }),

  // Decisions
  command("decision.resolve", {
    decisionId: Id,
    outcome: Type.Union([Type.Literal("approve"), Type.Literal("deny"), Type.Literal("answer")]),
    answer: Type.Optional(Text(8192)),
  }),

  // Ghosts
  command("ghost.create", {
    name: Text(128),
    persona: Type.String({ maxLength: 8192 }),
    model: Type.Optional(nullable(ModelRef)),
    look: Type.Optional(Look),
    /** Omit for the default set (every selectable tool except host tools); [] disables every optional tool. */
    tools: Type.Optional(GhostToolList),
    fallbacks: Type.Optional(FallbackList),
    skills: Type.Optional(SkillList),
    hostExecution: Type.Optional(Type.Boolean()),
  }),
  command("ghost.update", {
    ghostId: Id,
    name: Type.Optional(Text(128)),
    persona: Type.Optional(Type.String({ maxLength: 8192 })),
    model: Type.Optional(nullable(ModelRef)),
    look: Type.Optional(Look),
    state: Type.Optional(GhostState),
    tools: Type.Optional(GhostToolList),
    fallbacks: Type.Optional(FallbackList),
    skills: Type.Optional(SkillList),
    hostExecution: Type.Optional(Type.Boolean()),
  }),
  /** Remove a retired Ghost from every list. Past Works keep it as their assignee. */
  command("ghost.delete", { ghostId: Id }),
  command("ghost.set_default", { ghostId: Id }),
  command("sandbox.control", { ghostId: Id, action: Type.Union([Type.Literal("stop"), Type.Literal("reset")]) }),

  // Schedules
  command("schedule.create", {
    ghostId: Id,
    conversationId: Type.Optional(Id),
    prompt: Text(8192),
    spec: ScheduleSpec,
  }),
  command("schedule.update", {
    scheduleId: Id,
    prompt: Type.Optional(Text(8192)),
    spec: Type.Optional(ScheduleSpec),
    paused: Type.Optional(Type.Boolean()),
  }),
  command("schedule.delete", { scheduleId: Id }),

  // Owner-approved standing delegations and account-scoped connections.
  command("connection.upsert", {
    connectionId: Type.Optional(Id), name: Text(128), config: ConnectionConfig,
    /** Omit to preserve; null removes the stored credential. Never returned to clients. */
    credential: Type.Optional(nullable(Text(8192))),
  }),
  command("connection.delete", { connectionId: Id }),
  command("connection.test", { connectionId: Id }),
  command("activity.create", { config: ActivityConfig }),
  command("activity.update", { activityId: Id, expectedRevision: Type.Integer({ minimum: 1 }), config: ActivityConfig }),
  command("activity.pause", { activityId: Id, paused: Type.Boolean(), cancelRunning: Type.Optional(Type.Boolean()) }),
  command("activity.delete", { activityId: Id }),
  command("activity.run", { activityId: Id, dryRun: Type.Optional(Type.Boolean()) }),
  command("activity.stop_all", { ghostId: Type.Optional(Id) }),

  // Documents
  command("space.create", { name: Text(128), path: Text(4096) }),
  command("space.update", { spaceId: Id, name: Type.Optional(Text(128)) }),
  command("space.delete", { spaceId: Id }),
  /** Owner writes a page: new when `pageId` is null, otherwise an edit guarded by `expectedHash`. */
  command("document.save", {
    spaceId: Id,
    pageId: nullable(Type.String({ minLength: 1, maxLength: 256 })),
    expectedHash: nullable(Type.String({ minLength: 1, maxLength: 128 })),
    title: Text(512),
    body: Type.String({ maxLength: 1_048_576 }),
    profile: Type.Optional(Type.Union([Type.Literal("pdc-markdown/1"), Type.Literal("pdc-html/1")])),
  }),

  // Avatars
  command("avatar.create", {
    name: Text(128),
    description: Type.String({ maxLength: 2048 }),
    image: DataUrl,
    design: Type.Optional(nullable(Type.Record(Type.String(), Type.Unknown()))),
  }),
  command("avatar.delete", { avatarId: Id }),

  // Settings and providers
  command("settings.update", { defaultModel: Type.Optional(nullable(ModelRef)), reviewModel: Type.Optional(nullable(ModelRef)) }),
  command("provider.upsert", {
    id: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" }),
    kind: ProviderKind,
    name: Text(128),
    baseUrl: Type.Optional(nullable(Type.String({ maxLength: 2048 }))),
    models: Type.Array(ModelInfo, { maxItems: 256 }),
    /** Omit to keep the stored credential; null removes it. */
    apiKey: Type.Optional(nullable(Type.String({ minLength: 1, maxLength: 4096 }))),
  }),
  command("provider.delete", { providerId: Id }),

  // Devices
  command("device.pairing_start", {}),
  command("device.update", { deviceId: Id, name: Type.Optional(Text(128)) }),
  command("device.revoke", { deviceId: Id }),
  /** Device principal only. */
  command("device.push_register", {
    token: Type.String({ pattern: "^[a-f0-9]{16,256}$" }),
    environment: Type.Union([Type.Literal("sandbox"), Type.Literal("production")]),
  }),
  /** Device principal only; replaces this device's whole alert preference set. */
  command("device.alerts_update", { alerts: DeviceAlerts }),

  // Notifications
  command("notification.read", { notificationIds: Type.Array(Id, { minItems: 1, maxItems: 500 }) }),
]);
export type Command = Static<typeof Command>;
export type CommandType = Command["type"];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;

/** Commands a paired device may not send; a device may still revoke its own id. */
export const OWNER_ONLY_COMMANDS: readonly CommandType[] = ["device.pairing_start", "device.update", "device.revoke"];

export const CommandRequest = Type.Object({
  /** Client-chosen UUID; a retry with the same id and bytes returns the original outcome. */
  requestId: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
  command: Command,
});
export type CommandRequest = Static<typeof CommandRequest>;

export const ErrorCode = Type.Union([
  Type.Literal("invalid"),
  Type.Literal("not_found"),
  Type.Literal("forbidden"),
  Type.Literal("conflict"),
  Type.Literal("unavailable"),
  Type.Literal("internal"),
]);
export type ErrorCode = Static<typeof ErrorCode>;

export const ApiError = Type.Object({ code: ErrorCode, message: Type.String() });
export type ApiError = Static<typeof ApiError>;

export const CommandResponse = Type.Union([
  Type.Object({ ok: Type.Literal(true), result: Type.Record(Type.String(), Type.Unknown()) }),
  Type.Object({ ok: Type.Literal(false), error: ApiError }),
]);
export type CommandResponse = Static<typeof CommandResponse>;
