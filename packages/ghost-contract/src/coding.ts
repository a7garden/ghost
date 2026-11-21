import { Type, type Static } from "typebox";
import { nullable } from "./entities.ts";

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
