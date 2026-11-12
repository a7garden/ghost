import { PolicyRule } from "./policy.ts";
import { McpServer } from "./mcp.ts";
import { ConfigRevision } from "./entities.ts";
import { Type, type Static, type TLiteral, type TSchema } from "typebox";
import { Activity, ActivityRun, Connection } from "./autonomy.ts";
import { Duty } from "./duty.ts";
import {
  Adaptation,
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
  Sandbox,
  Schedule,
  Settings,
  Scope,
  Timestamp,
  Work,
} from "./entities.ts";
import { Goal, Milestone } from "./goals.ts";

/** Literal `type` plus one literal key, so each member narrows to `{ type: "work"; work: Work }`. */
const upsert = <K extends string, Key extends string, S extends TSchema>(type: K, key: Key, schema: S) =>
  Type.Object({ type: Type.Literal(type), [key]: schema } as unknown as { type: TLiteral<K> } & Record<Key, S>);
const removed = <K extends string>(type: K) => Type.Object({ type: Type.Literal(type), id: Id });

/**
 * Ledger change events. Each carries the whole entity after the change, so a client
 * keeps state by upserting by id. Persisted with a seq; replayable after reconnect.
 */
export const LedgerEventData = Type.Union([
  upsert("policy_rule", "rule", PolicyRule),
  removed("policy_rule.removed"),
  upsert("mcp_server", "server", McpServer),
  removed("mcp_server.removed"),
  upsert("config_revision", "revision", ConfigRevision),
  upsert("ghost", "ghost", Ghost),
  removed("ghost.removed"),
  upsert("conversation", "conversation", Conversation),
  removed("conversation.removed"),
  upsert("work", "work", Work),
  upsert("decision", "decision", Decision),
  upsert("effect", "effect", Effect),
  upsert("notification", "notification", Notification),
  upsert("schedule", "schedule", Schedule),
  removed("schedule.removed"),
  upsert("scope", "scope", Scope),
  removed("scope.removed"),
  upsert("avatar", "avatar", Avatar),
  removed("avatar.removed"),
  upsert("device", "device", Device),
  removed("device.removed"),
  upsert("settings", "settings", Settings),
  upsert("sandbox", "sandbox", Sandbox),
  upsert("activity", "activity", Activity),
  removed("activity.removed"),
  upsert("activity_run", "run", ActivityRun),
  upsert("connection", "connection", Connection),
  removed("connection.removed"),
  upsert("autonomy", "plan", AutonomyPlan),
  upsert("adaptation", "adaptation", Adaptation),
  /** 근무 상태가 바뀌었다(원버튼 · 시간표 경계 · 시간표 수정). */
  upsert("duty", "duty", Duty),
  upsert("goal", "goal", Goal),
  upsert("milestone", "milestone", Milestone),
]);
export type LedgerEventData = Static<typeof LedgerEventData>;

export const LedgerEvent = Type.Object({
  seq: Type.Integer({ minimum: 1 }),
  at: Timestamp,
  data: LedgerEventData,
});
export type LedgerEvent = Static<typeof LedgerEvent>;

/** Conversation activity, not persisted as events (the transcript is in Pi). Sent only to subscribers of that conversation. */
export const LiveEvent = Type.Union([
  Type.Object({ type: Type.Literal("message"), message: Message }),
  Type.Object({ type: Type.Literal("live"), live: Live }),
]);
export type LiveEvent = Static<typeof LiveEvent>;

/**
 * GET /api/events?after=<seq>[&conversation=<id>...]  (text/event-stream)
 * - `event: ledger`, `id: <seq>`, `data: LedgerEvent`
 * - `event: live`, `data: LiveEvent` (only for requested conversations)
 * - `event: reset` when `after` is older than retained events: refetch /api/state.
 */
export type StreamFrame =
  | { event: "ledger"; data: LedgerEvent }
  | { event: "live"; data: LiveEvent }
  | { event: "reset"; data: { seq: number } };
