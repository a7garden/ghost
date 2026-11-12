import { Type, type Static } from "typebox";
import { ExecutionTarget, GhostToolList, Id, ScheduleSpec, Timestamp, WorkState, nullable } from "./entities.ts";

/** Catalog icon of a service: an HTTPS URL or a local artifact path served by this Host. */
export const ConnectionIconUrl = Type.String({
  maxLength: 2048,
  pattern: "^(https://\\S+|/api/artifacts/[a-f0-9]{64})$",
});

/** How a stored credential authenticates a mail account; absence is the legacy password login. */
export const MailAuthType = Type.Union([Type.Literal("password"), Type.Literal("oauth2")]);

/** Owner-configured IMAP (and optional SMTP) mail endpoint; the credential is an app password or an OAuth2 access token. */
export const MailConnectionConfig = Type.Object({
  kind: Type.Literal("mail"),
  host: Type.String({ minLength: 1, maxLength: 253 }),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  username: Type.String({ minLength: 1, maxLength: 320 }),
  mailbox: Type.String({ minLength: 1, maxLength: 256 }),
  smtpHost: nullable(Type.String({ minLength: 1, maxLength: 253 })),
  smtpPort: Type.Integer({ minimum: 1, maximum: 65535 }),
  smtpSecure: Type.Boolean(),
  /** Legacy rows without this field authenticate with the stored password/app password. */
  authType: Type.Optional(MailAuthType),
});
export type MailConnectionConfig = Static<typeof MailConnectionConfig>;

/**
 * Owner-configured API endpoints. Every field is required so the owner's UI sends the exact
 * configuration; credentials live only in the Host's secret store and the credential header
 * value is secret while static headers stay metadata.
 */
export const ApiConnectionConfig = Type.Object({
  kind: Type.Literal("api"),
  readPaths: Type.Optional(Type.Array(Type.Object({ method: Type.Union([Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("PATCH"), Type.Literal("DELETE")]), path: Type.String({ minLength: 1, maxLength: 2048, pattern: "^/[^?#\\\\\\s]*$" }) }), { maxItems: 128 })),
  baseUrl: Type.String({ minLength: 1, maxLength: 2048 }),
  /** Header that carries the credential (an API key belongs here, never in static headers). */
  authHeader: Type.String({ minLength: 1, maxLength: 128 }),
  /** Prefix before the credential in the auth header; an empty string sends the raw secret. */
  authPrefix: Type.String({ maxLength: 128 }),
  /** Relative identity endpoint used by connection.test (GET, path only). */
  testPath: Type.String({ minLength: 1, maxLength: 512 }),
  /** Static request headers, such as `Notion-Version`; credential-bearing header names are rejected. */
  headers: Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.String({ maxLength: 1024 })),
  /** Ghosts allowed authenticated REST use through connection_request. */
  ghostIds: Type.Array(Id, { maxItems: 256, uniqueItems: true }),
});
export type ApiConnectionConfig = Static<typeof ApiConnectionConfig>;

export const GitConnectionConfig = Type.Union([
  Type.Object({ kind: Type.Literal("github"), baseUrl: Type.String({ minLength: 1, maxLength: 2048 }) }),
  Type.Object({ kind: Type.Literal("gitea"), baseUrl: Type.String({ minLength: 1, maxLength: 2048 }) }),
]);

/** Owner-configured endpoints. Credentials live only in the Host's secret store. */
export const ConnectionConfig = Type.Union([GitConnectionConfig, ApiConnectionConfig, MailConnectionConfig]);
export type ConnectionConfig = Static<typeof ConnectionConfig>;

/** API grants change who may use an account, not the account's authentication identity. */
export function connectionCredentialScope(config: ConnectionConfig) {
  if (config.kind !== "api") return config;
  const { ghostIds: _grants, ...authentication } = config;
  return authentication;
}

export const Connection = Type.Object({
  id: Id,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  config: ConnectionConfig,
  /** Catalog id of a built-in service preset (`github`, `gmail`, `custom-api`, …); absent for owner-defined connections. */
  serviceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  /** Card icon from the service catalog; absent for owner-defined connections. */
  iconUrl: Type.Optional(ConnectionIconUrl),
  credentialVersion: nullable(Id),
  hasCredential: Type.Boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Connection = Static<typeof Connection>;

export const ActivitySource = Type.Union([
  Type.Object({ kind: Type.Literal("schedule"), spec: ScheduleSpec }),
  Type.Object({ kind: Type.Literal("commit"), scopeId: Id }),
  Type.Object({ kind: Type.Literal("poll"), connectionId: Id, path: Type.String({ minLength: 1, maxLength: 4096 }), itemsPointer: Type.String({ maxLength: 4096 }), idPointer: Type.String({ maxLength: 4096 }), pollSeconds: Type.Integer({ minimum: 60, maximum: 86400 }) }),
  Type.Object({
    kind: Type.Literal("pull_request"), connectionId: Id,
    repository: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", maxLength: 256 }),
    baseBranch: nullable(Type.String({ minLength: 1, maxLength: 256 })),
    labels: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32, uniqueItems: true }),
    includeDrafts: Type.Boolean(), includeExisting: Type.Boolean(),
    pollSeconds: Type.Integer({ minimum: 60, maximum: 86400 }),
  }),
  Type.Object({
    kind: Type.Literal("mail"), connectionId: Id,
    sender: nullable(Type.String({ minLength: 1, maxLength: 320 })),
    subjectContains: nullable(Type.String({ minLength: 1, maxLength: 256 })),
    unreadOnly: Type.Boolean(), includeExisting: Type.Boolean(),
    pollSeconds: Type.Integer({ minimum: 60, maximum: 86400 }),
  }),
]);
export type ActivitySource = Static<typeof ActivitySource>;

export const ActivityPolicy = Type.Object({
  maxRunsPerDay: Type.Integer({ minimum: 1, maximum: 1000 }),
  maxConcurrent: Type.Integer({ minimum: 1, maximum: 8 }),
  runTimeoutSeconds: Type.Integer({ minimum: 30, maximum: 86400 }),
  allowSelfCheck: Type.Boolean(),
  minCheckSeconds: Type.Integer({ minimum: 60, maximum: 86400 }),
  externalActions: Type.Union([Type.Literal("deny"), Type.Literal("approval"), Type.Literal("allow")]),
  delivery: Type.Union([Type.Literal("changes"), Type.Literal("always")]),
});
export type ActivityPolicy = Static<typeof ActivityPolicy>;

/** Saving this configuration is an explicit standing delegation, not inferred from casual chat. */
export const ActivityConfig = Type.Object({
  scopeId: Type.Optional(nullable(Id)),
  ghostId: Id,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  prompt: Type.String({ minLength: 1, maxLength: 8192 }),
  acceptanceCriteria: Type.String({ minLength: 1, maxLength: 8192 }),
  source: ActivitySource,
  execution: ExecutionTarget,
  tools: GhostToolList,
  policy: ActivityPolicy,
});
export type ActivityConfig = Static<typeof ActivityConfig>;

export const Activity = Type.Object({
  ...ActivityConfig.properties,
  scopeId: nullable(Id),
  id: Id,
  revision: Type.Integer({ minimum: 1 }),
  paused: Type.Boolean(),
  pauseReason: nullable(Type.String({ maxLength: 2048 })),
  nextAt: nullable(Timestamp),
  cursor: nullable(Type.String({ maxLength: 262144 })),
  lastCheckedAt: nullable(Timestamp),
  lastError: nullable(Type.String({ maxLength: 2048 })),
  deferredUntil: Type.Optional(nullable(Timestamp)),
  deferredReason: Type.Optional(nullable(Type.String({ maxLength: 2048 }))),
  failureCount: Type.Integer({ minimum: 0 }),
  deletedAt: nullable(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Activity = Static<typeof Activity>;

/** Untrusted source data. The Host resolves its account and action target, never the model. */
export const ActivitySourceItem = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 512 }),
  version: Type.String({ minLength: 1, maxLength: 512 }),
  title: Type.String({ maxLength: 512 }),
  text: Type.String({ maxLength: 32768 }),
  url: nullable(Type.String({ maxLength: 2048 })),
  author: nullable(Type.String({ maxLength: 320 })),
  occurredAt: nullable(Timestamp),
  /** Bounded provider identifiers needed to reply to this exact item; never credentials. */
  target: Type.Record(Type.String(), Type.String({ maxLength: 2048 })),
});
export type ActivitySourceItem = Static<typeof ActivitySourceItem>;

/** Work remains execution authority; state and completion fields are projected from its row. */
export const ActivityRun = Type.Object({
  id: Id, activityId: Id,
  workId: nullable(Id),
  trigger: Type.Union([Type.Literal("schedule"), Type.Literal("source"), Type.Literal("self_check"), Type.Literal("manual"), Type.Literal("dry_run")]),
  sourceKey: Type.String({ maxLength: 1024 }),
  sourceItem: nullable(ActivitySourceItem),
  state: Type.Union([WorkState, Type.Literal("skipped")]),
  activityRevision: Type.Integer({ minimum: 1 }),
  reason: nullable(Type.String({ maxLength: 2048 })),
  dryRun: Type.Boolean(),
  noChange: Type.Boolean(),
  createdAt: Timestamp,
  endedAt: nullable(Timestamp),
  nextCheckAt: nullable(Timestamp),
  nextCheckReason: nullable(Type.String({ maxLength: 2048 })),
  followupOf: nullable(Id),
});
export type ActivityRun = Static<typeof ActivityRun>;

export const ActivityAction = Type.Object({
  kind: Type.Union([Type.Literal("mail_reply"), Type.Literal("pr_comment")]),
  body: Type.String({ minLength: 1, maxLength: 16384 }),
});
export type ActivityAction = Static<typeof ActivityAction>;
