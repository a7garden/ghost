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

/** One thing in a coding session, normalised across agents: what the agent said, a tool it called, what that returned, a Host note, or a message the owner sent into the session. */
export const CodingStep = Type.Object({
  at: Timestamp,
  kind: Type.Union([Type.Literal("say"), Type.Literal("tool"), Type.Literal("result"), Type.Literal("note"), Type.Literal("user")]),
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

/**
 * The owner starts a session in the app, with no Ghost between: a repository (or any directory), the first instruction
 * and, optionally, the agent, a branch name, whether to work in a fresh worktree (default yes in a git repository)
 * and an agent session already begun elsewhere to carry on (`resume`, with `repo` its working directory).
 */
export const CodingSessionStart = Type.Object({
  repo: Type.String({ minLength: 1, maxLength: 4096 }),
  task: Type.String({ minLength: 1, maxLength: 24_000 }),
  agent: Type.Optional(CodingAgentId),
  branch: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  worktree: Type.Optional(Type.Boolean()),
  resume: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9._-]{1,128}$" })),
});
export type CodingSessionStart = Static<typeof CodingSessionStart>;

/** A follow-up the owner sends into a session that is not running: it continues the same agent conversation in the same directory. */
export const CodingSessionMessage = Type.Object({ text: Type.String({ minLength: 1, maxLength: 24_000 }) });
export type CodingSessionMessage = Static<typeof CodingSessionMessage>;

/** What herdr reports a pane's agent doing; `unknown` is an agent herdr cannot classify, not one that stopped. */
export const HerdrStatus = Type.Union([Type.Literal("idle"), Type.Literal("working"), Type.Literal("blocked"), Type.Literal("done"), Type.Literal("unknown")]);
export type HerdrStatus = Static<typeof HerdrStatus>;

/** One coding agent running in a herdr pane. Pane ids belong to one herdr session, so `session` is part of what names it. */
export const HerdrPaneView = Type.Object({
  session: Type.String(),
  id: Type.String(),
  workspace: Type.String(),
  tab: Type.String(),
  agent: Type.String(),
  status: HerdrStatus,
  cwd: nullable(Type.String()),
  title: Type.String(),
});
export type HerdrPaneView = Static<typeof HerdrPaneView>;

/** The agents in every running herdr session; `available` is false when herdr is not installed on the Host's Mac, `note` says why a look failed. */
export const HerdrView = Type.Object({ available: Type.Boolean(), note: nullable(Type.String()), panes: Type.Array(HerdrPaneView) });
export type HerdrView = Static<typeof HerdrView>;

/** A pane as it stands with the end of its terminal, as text. Read-only: nothing the owner does here reaches the terminal. */
export const HerdrOutput = Type.Object({ pane: HerdrPaneView, text: Type.String() });
export type HerdrOutput = Static<typeof HerdrOutput>;
