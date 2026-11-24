import { Type, type Static } from "typebox";
import { Id, nullable, Timestamp } from "./entities.ts";

/** The latest turn of an agent run belonging to an existing Work; it is not a Work or a Ghost. */
export const CodingRun = Type.Object({
  id: Id,
  workId: Id,
  session: Type.String(),
  /** Populated only by older terminal-backed runs. */
  pane: Type.Optional(nullable(Type.String())),
  terminalId: Type.Optional(nullable(Type.String())),
  agent: nullable(Type.String()),
  checkout: nullable(Type.String()),
  branch: nullable(Type.String()),
  base: nullable(Type.String()),
  turn: Type.Integer({ minimum: 1 }),
  deliveredTurn: Type.Integer({ minimum: 0 }),
  state: Type.Union([
    Type.Literal("preparing"), Type.Literal("starting"), Type.Literal("working"), Type.Literal("blocked"),
    Type.Literal("settled"), Type.Literal("stalled"), Type.Literal("lost"), Type.Literal("uncertain"), Type.Literal("closed"),
  ]),
  startedAt: Timestamp,
  updatedAt: Timestamp,
  seenWorking: Type.Boolean(),
  prompt: Type.String({ maxLength: 24_000 }),
  cursor: Type.Optional(nullable(Type.String())),
  /** JSON: the untrusted agent claim and separately the Host's observations. Neither accepts the Work. */
  report: nullable(Type.String({ maxLength: 14_000 })),
  stopPending: Type.Boolean(),
});
export type CodingRun = Static<typeof CodingRun>;
