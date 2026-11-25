import { Type, type Static } from "typebox";

export const TerminalSize = Type.Object({
  cols: Type.Integer({ minimum: 2, maximum: 500 }),
  rows: Type.Integer({ minimum: 1, maximum: 300 }),
});
export type TerminalSize = Static<typeof TerminalSize>;

export const TerminalCreate = Type.Object({
  cwd: Type.String({ minLength: 1 }),
  command: Type.Optional(Type.String({ minLength: 1 })),
  args: Type.Optional(Type.Array(Type.String())),
  ...TerminalSize.properties,
});
export type TerminalCreate = Static<typeof TerminalCreate>;

export const TERMINAL_AGENTS = ["omp", "claude", "codex", "pi"] as const;
export const TerminalAgent = Type.Enum(TERMINAL_AGENTS);
export type TerminalAgent = Static<typeof TerminalAgent>;
export type TerminalState = "working" | "waiting" | "idle" | "exited";
export type TerminalView = TerminalSize & {
  id: string;
  cwd: string;
  agent: TerminalAgent | null;
  state: TerminalState;
  exitCode: number | null;
};
export type TerminalAgentEvent =
  | { type: "finished"; agent: TerminalAgent; reason: "quiet" | "exit" }
  | { type: "waiting"; agent: TerminalAgent; reason: "prompt" };

// The bearer offer is never selected or sent back by the WebSocket server.
export const TERMINAL_PROTOCOL = "ghost-terminal-v1";
export const TERMINAL_BEARER_PREFIX = "ghost-bearer.";
const Offset = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const TerminalClientFrame = Type.Union([
  Type.Object({ type: Type.Literal("input"), data: Type.String({ maxLength: 65_536 }), binary: Type.Optional(Type.Boolean()) }),
  Type.Object({ type: Type.Literal("resize"), ...TerminalSize.properties }),
]);
export type TerminalClientFrame = Static<typeof TerminalClientFrame>;

// After ready, binary frames advance the absolute byte offset, including replay.
export const TerminalServerFrame = Type.Union([
  Type.Object({ type: Type.Literal("ready"), offset: Offset, reset: Type.Boolean(), ...TerminalSize.properties }),
  Type.Object({ type: Type.Literal("replay-end") }),
  Type.Object({ type: Type.Literal("exit"), code: Type.Union([Type.Integer(), Type.Null()]) }),
]);
export type TerminalServerFrame = Static<typeof TerminalServerFrame>;
