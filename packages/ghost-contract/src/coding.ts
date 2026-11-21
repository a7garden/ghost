import { Type, type Static } from "typebox";
import { Id, nullable, Timestamp } from "./entities.ts";

/** The coding agents the Host knows how to run headless. */
export const CodingAgentId = Type.Union([Type.Literal("omp"), Type.Literal("claude"), Type.Literal("codex")]);
export type CodingAgentId = Static<typeof CodingAgentId>;

/** What the owner chose: the agent `code_run` prefers and the ones it must never use. */
export const CodingPrefs = Type.Object({
  default: nullable(CodingAgentId),
  disabled: Type.Array(CodingAgentId, { uniqueItems: true, maxItems: 3 }),
});
export type CodingPrefs = Static<typeof CodingPrefs>;

/** One coding agent found on the Host's Mac. `ready` is false when it is installed but cannot run a task, and `note` says why or what to know. */
export const CodingAgentView = Type.Object({
  id: CodingAgentId,
  name: Type.String(),
  path: Type.String(),
  version: nullable(Type.String()),
  ready: Type.Boolean(),
  note: nullable(Type.String()),
});
export type CodingAgentView = Static<typeof CodingAgentView>;

export const CodingAgentsView = Type.Object({
  agents: Type.Array(CodingAgentView),
  default: nullable(CodingAgentId),
  disabled: Type.Array(CodingAgentId),
});
export type CodingAgentsView = Static<typeof CodingAgentsView>;

/** One thing a coding agent did, normalised across agents: what it said, a tool it called, what that returned, or a Host note. */
export const CodingStep = Type.Object({
  at: Timestamp,
  kind: Type.Union([Type.Literal("say"), Type.Literal("tool"), Type.Literal("result"), Type.Literal("note")]),
  text: Type.String({ maxLength: 4096 }),
});
export type CodingStep = Static<typeof CodingStep>;

/**
 * One `code_run` as a session the owner can open: which agent ran where, whether it still runs, and the command that
 * continues it in a terminal. `interrupted` is a run the Host lost track of (restart mid-run), not one that failed.
 */
export const CodingSessionView = Type.Object({
  id: Id,
  agent: CodingAgentId,
  workId: nullable(Id),
  callId: Type.String(),
  task: Type.String(),
  cwd: Type.String(),
  branch: nullable(Type.String()),
  nativeId: nullable(Type.String()),
  resumeCommand: nullable(Type.String()),
  startedAt: Timestamp,
  endedAt: nullable(Timestamp),
  state: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("failed"), Type.Literal("interrupted")]),
  exitCode: nullable(Type.Integer()),
});
export type CodingSessionView = Static<typeof CodingSessionView>;

export const CodingSessionList = Type.Object({ sessions: Type.Array(CodingSessionView) });
export type CodingSessionList = Static<typeof CodingSessionList>;

/** A session with the steps from `after` on; ask again with `next` to follow a running one. */
export const CodingSessionDetail = Type.Object({
  session: CodingSessionView,
  steps: Type.Array(CodingStep),
  next: Type.Integer({ minimum: 0 }),
});
export type CodingSessionDetail = Static<typeof CodingSessionDetail>;
