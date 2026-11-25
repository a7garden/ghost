import { Type, type Static } from "typebox";
import { Id, nullable, Timestamp } from "./entities.ts";

/**
 * A coding session is a Pi coding agent (`@earendil-works/pi-coding-agent`) running inside the Host, in a git worktree
 * of the owner's repository. The owner works with it in the app, and a Ghost can start and steer it. Its transcript is
 * Pi's own session file; these types are what the Host normalizes it into for the app and for Ghosts.
 */

export const CodingSessionState = Type.Union([
  Type.Literal("idle"), // waiting for the next prompt
  Type.Literal("working"), // a turn is running
  Type.Literal("waiting"), // a turn is paused on a dialog only the owner can answer
  Type.Literal("failed"), // the last turn ended with an error
  Type.Literal("closed"), // the owner closed it; the worktree and branch stay
]);
export type CodingSessionState = Static<typeof CodingSessionState>;

export const CodingThinking = Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]);
export type CodingThinking = Static<typeof CodingThinking>;

/** One image the owner or the agent shows: served by `GET /api/coding/sessions/:id/file?path=` from the session's cwd or artifacts. */
export const CodingImage = Type.Object({
  /** Path relative to the session's cwd, or an artifact sha256 for an image the owner attached. */
  path: Type.String({ minLength: 1, maxLength: 1024 }),
  mimeType: Type.String({ maxLength: 100 }),
  label: Type.Optional(Type.String({ maxLength: 200 })),
});
export type CodingImage = Static<typeof CodingImage>;

/**
 * What the agent asks the owner. `confirm`, `select` and `input` are Pi's own dialogs. `choices` is the mockup picker: a
 * few options, each with an optional image or an HTML file in the cwd (rendered as a static preview), and the owner
 * picks one (or says none). `form` is `present_ui`'s form, answered as a map of field ids to values.
 */
export const CodingDialogOption = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 600 })),
  image: Type.Optional(CodingImage),
  /** An HTML file in the session's cwd, shown as a sandboxed static preview (no script, no network). */
  html: Type.Optional(Type.String({ maxLength: 1024 })),
});
export type CodingDialogOption = Static<typeof CodingDialogOption>;

export const CodingDialog = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }),
  kind: Type.Union([Type.Literal("confirm"), Type.Literal("select"), Type.Literal("input"), Type.Literal("choices"), Type.Literal("approval")]),
  title: Type.String({ maxLength: 400 }),
  message: Type.Optional(Type.String({ maxLength: 4000 })),
  options: Type.Optional(Type.Array(CodingDialogOption, { maxItems: 12 })),
  placeholder: Type.Optional(Type.String({ maxLength: 200 })),
  /** `choices`: the owner may also answer with free text. */
  allowText: Type.Optional(Type.Boolean()),
  /** `approval`: the tool call waiting for the owner (a command outside the worktree, or one Ghost's policy asks about). */
  tool: Type.Optional(Type.Object({ name: Type.String(), summary: Type.String({ maxLength: 2000 }) })),
  createdAt: Timestamp,
});
export type CodingDialog = Static<typeof CodingDialog>;

/** The owner's answer: `value` for confirm (`"yes"`/`"no"`), select and input; `optionId` for choices; `text` for choices with allowText. `cancel` declines. */
export const CodingDialogAnswer = Type.Object({
  cancel: Type.Optional(Type.Boolean()),
  value: Type.Optional(Type.String({ maxLength: 8000 })),
  optionId: Type.Optional(Type.String({ maxLength: 80 })),
  text: Type.Optional(Type.String({ maxLength: 8000 })),
});
export type CodingDialogAnswer = Static<typeof CodingDialogAnswer>;

export const CodingSession = Type.Object({
  id: Id,
  title: Type.String({ maxLength: 200 }),
  state: CodingSessionState,
  /** The directory the agent works in: a worktree under the Host's state root for a repository session, or the given directory. */
  cwd: Type.String(),
  /** The owner's repository the worktree was cut from; null for a session started in a plain directory. */
  repo: nullable(Type.String()),
  branch: nullable(Type.String()),
  base: nullable(Type.String()),
  model: Type.Object({ provider: Type.String(), model: Type.String() }),
  thinking: CodingThinking,
  /** The 맡긴 일 this session works for, when a Ghost started it. */
  workId: nullable(Id),
  /** The Ghost that started this session through `code_run`; null for the owner's own session. */
  ghostId: nullable(Id),
  /** How many prompts have been sent: a Ghost's report names the turn it answers. */
  turn: Type.Integer({ minimum: 0 }),
  pendingDialog: nullable(CodingDialog),
  /** Tokens and cost so far, as Pi counts them. */
  usage: Type.Object({ input: Type.Integer({ minimum: 0 }), output: Type.Integer({ minimum: 0 }), cost: Type.Number({ minimum: 0 }) }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type CodingSession = Static<typeof CodingSession>;

/**
 * The transcript, normalized: one item per thing the owner sees, in order. An item keeps its id while it streams, so a
 * client replaces the item with the same id.
 */
export const CodingToolStatus = Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("error")]);
export type CodingToolStatus = Static<typeof CodingToolStatus>;

export const CodingItem = Type.Union([
  Type.Object({ id: Type.String(), kind: Type.Literal("user"), at: Timestamp, text: Type.String(), images: Type.Array(CodingImage) }),
  Type.Object({ id: Type.String(), kind: Type.Literal("assistant"), at: Timestamp, text: Type.String(), streaming: Type.Boolean() }),
  Type.Object({ id: Type.String(), kind: Type.Literal("thinking"), at: Timestamp, text: Type.String(), streaming: Type.Boolean() }),
  Type.Object({
    id: Type.String(),
    kind: Type.Literal("tool"),
    at: Timestamp,
    tool: Type.String(),
    /** A one-line summary of the arguments (`edit src/a.ts`, `bash bun test`). */
    summary: Type.String({ maxLength: 400 }),
    status: CodingToolStatus,
    /** Bounded output text; a unified diff for edit and write. */
    output: Type.String({ maxLength: 20_000 }),
    diff: Type.Optional(Type.String({ maxLength: 40_000 })),
    images: Type.Array(CodingImage),
    /** The subagent this call belongs to, when a subagent made it. */
    subagent: Type.Optional(Type.String()),
  }),
  /** A subagent the orchestration tool started (scout, worker, reviewer ...) with its latest status line. */
  Type.Object({
    id: Type.String(),
    kind: Type.Literal("subagent"),
    at: Timestamp,
    role: Type.String(),
    task: Type.String({ maxLength: 2000 }),
    status: CodingToolStatus,
    summary: Type.String({ maxLength: 4000 }),
  }),
  Type.Object({ id: Type.String(), kind: Type.Literal("notice"), at: Timestamp, level: Type.Union([Type.Literal("info"), Type.Literal("error")]), text: Type.String({ maxLength: 4000 }) }),
]);
export type CodingItem = Static<typeof CodingItem>;

/** What `GET /api/coding/sessions/:id/events` streams (server-sent events, one JSON per `data:`), and `GET .../items` pages. */
export const CodingEvent = Type.Union([
  Type.Object({ type: Type.Literal("session"), session: CodingSession }),
  Type.Object({ type: Type.Literal("item"), item: CodingItem }),
]);
export type CodingEvent = Static<typeof CodingEvent>;

export const CodingSessionCreate = Type.Object({
  /** The owner's repository (an absolute path): the Host cuts a worktree and a branch from it. */
  repo: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  /** Or a directory to work in directly, with no worktree. With neither repo nor cwd the owner's session works in an empty sandbox directory. */
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  branch: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  title: Type.Optional(Type.String({ maxLength: 200 })),
  model: Type.Optional(Type.Object({ provider: Type.String(), model: Type.String() })),
  thinking: Type.Optional(CodingThinking),
  /** The first prompt; the session starts working at once. */
  prompt: Type.Optional(Type.String({ maxLength: 24_000 })),
});
export type CodingSessionCreate = Static<typeof CodingSessionCreate>;

/** `steer` interrupts a running turn after its current tool calls; `follow_up` queues behind it; `prompt` is refused while a turn runs. */
export const CodingPrompt = Type.Object({
  text: Type.String({ maxLength: 24_000 }),
  mode: Type.Optional(Type.Union([Type.Literal("prompt"), Type.Literal("steer"), Type.Literal("follow_up")])),
  /** Images the owner attached: base64 data, kept in the session's artifacts. */
  images: Type.Optional(Type.Array(Type.Object({ mimeType: Type.String({ maxLength: 100 }), data: Type.String({ maxLength: 12_000_000 }), name: Type.Optional(Type.String({ maxLength: 200 })) }), { maxItems: 8 })),
});
export type CodingPrompt = Static<typeof CodingPrompt>;
