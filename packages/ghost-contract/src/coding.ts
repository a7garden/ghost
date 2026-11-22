import { Type, type Static } from "typebox";
import { nullable, Timestamp } from "./entities.ts";

/**
 * Coding is herdr, the terminal workspace manager the owner already works in: the Host never runs a coding agent of
 * its own. It reads, starts and talks to agents inside one herdr session, so what the app shows is what the owner sees
 * in herdr. These are the agents the app can start there.
 */
export const CodingAgentId = Type.Union([Type.Literal("omp"), Type.Literal("claude"), Type.Literal("codex")]);
export type CodingAgentId = Static<typeof CodingAgentId>;

/** When an agent in the session in use tells the owner (a push and an inbox entry): never, only when it waits for an answer, or also when it finishes. */
export const CodingNotify = Type.Union([Type.Literal("off"), Type.Literal("blocked"), Type.Literal("all")]);
export type CodingNotify = Static<typeof CodingNotify>;

/** The owner's choices: which herdr session coding uses (null: herdr's default session, the one `herdr` attaches to), the agent a new session starts with, and when agents notify. */
export const CodingPrefs = Type.Object({
  session: nullable(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" })),
  agent: nullable(CodingAgentId),
  notify: CodingNotify,
});
export type CodingPrefs = Static<typeof CodingPrefs>;

/** What herdr reports a pane's agent doing; `unknown` is an agent herdr cannot classify, not one that stopped. */
export const HerdrStatus = Type.Union([Type.Literal("idle"), Type.Literal("working"), Type.Literal("blocked"), Type.Literal("done"), Type.Literal("unknown")]);
export type HerdrStatus = Static<typeof HerdrStatus>;

/** Every agent kind `herdr agent start` can start (`herdr agent start --help`). The three the app sets up integrations for are `CodingAgentId`. */
export const HERDR_AGENT_KINDS = [
  "omp",
  "claude",
  "codex",
  "pi",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "mastracode",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "qwen",
  "letta",
  "maki",
  "muse",
] as const;
export const HerdrAgentKind = Type.Union([
  Type.Literal("omp"),
  Type.Literal("claude"),
  Type.Literal("codex"),
  Type.Literal("pi"),
  Type.Literal("gemini"),
  Type.Literal("cursor"),
  Type.Literal("devin"),
  Type.Literal("agy"),
  Type.Literal("cline"),
  Type.Literal("mastracode"),
  Type.Literal("opencode"),
  Type.Literal("copilot"),
  Type.Literal("kimi"),
  Type.Literal("kiro"),
  Type.Literal("droid"),
  Type.Literal("amp"),
  Type.Literal("grok"),
  Type.Literal("hermes"),
  Type.Literal("kilo"),
  Type.Literal("qodercli"),
  Type.Literal("qwen"),
  Type.Literal("letta"),
  Type.Literal("maki"),
  Type.Literal("muse"),
]);
export type HerdrAgentKind = Static<typeof HerdrAgentKind>;

/** A pane of the session in use: a terminal, with the agent herdr recognises in it (null for a plain shell). */
export const HerdrPaneView = Type.Object({
  id: Type.String(),
  workspaceId: Type.String(),
  tabId: Type.String(),
  workspace: Type.String(),
  tab: Type.String(),
  agent: nullable(Type.String()),
  status: HerdrStatus,
  cwd: nullable(Type.String()),
  title: Type.String(),
  focused: Type.Boolean(),
  /** The Host opened this terminal or started its agent. */
  owned: Type.Boolean(),
  /** The terminal identity herdr reports for the pane, when it does: what a coding run binds to, so a reused terminal is never mistaken for the run's. */
  terminalId: Type.Optional(Type.String()),
  /** The 맡긴 일 whose coding run works in this pane; the Host decorates the owner's view with it. */
  codingWorkId: Type.Optional(Type.String()),
  /** That run's id, matching WorkDetail.codingRuns. */
  codingRunId: Type.Optional(Type.String()),
  /** herdr's own count of the pane's state changes (installed 0.9.5 PaneInfo `state_change_seq`), when it reports one: a watcher compares it to see what it missed between looks. */
  stateChangeSeq: Type.Optional(Type.Integer({ minimum: 0 })),
  /** herdr's count of the agent's completed turns (PaneInfo `completion_seq`), null when the pane has no agent; a coding run reads it to observe fast turns without a working poll. */
  completionSeq: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  /** The agent session identity herdr reports for the pane (PaneInfo `agent_session`), when it does. */
  agentSessionId: Type.Optional(Type.String()),
});
export type HerdrPaneView = Static<typeof HerdrPaneView>;

export const HerdrTabView = Type.Object({ id: Type.String(), label: Type.String(), status: HerdrStatus, panes: Type.Array(HerdrPaneView) });
export type HerdrTabView = Static<typeof HerdrTabView>;

/** A workspace (herdr's project-level container) with its tabs and panes; `worktree` is set when it is a git worktree workspace. */
export const HerdrWorkspaceView = Type.Object({
  id: Type.String(),
  label: Type.String(),
  status: HerdrStatus,
  worktree: nullable(Type.Object({ path: Type.String(), branch: nullable(Type.String()) })),
  tabs: Type.Array(HerdrTabView),
});
export type HerdrWorkspaceView = Static<typeof HerdrWorkspaceView>;

/**
 * The whole herdr session in use (`session`), as herdr's own sidebar shows it: workspaces, their tabs, their panes.
 * `available` is false when no `herdr` binary is found; `note` says why a look failed, such as a session that is not
 * running. The Host never starts a herdr server.
 */
export const HerdrView = Type.Object({ available: Type.Boolean(), session: Type.String(), note: nullable(Type.String()), workspaces: Type.Array(HerdrWorkspaceView) });
export type HerdrView = Static<typeof HerdrView>;

/** A pane as it stands with the end of its terminal, as text. */
export const HerdrOutput = Type.Object({ pane: HerdrPaneView, text: Type.String() });
export type HerdrOutput = Static<typeof HerdrOutput>;

/** Whether herdr's hook for an agent is installed (`herdr integration status`); herdr uses it for lifecycle state and to restore the same agent session after a restart. */
export const HerdrIntegration = Type.Union([Type.Literal("current"), Type.Literal("outdated"), Type.Literal("missing")]);
export type HerdrIntegration = Static<typeof HerdrIntegration>;

/**
 * Everything the connection to herdr depends on, in the order the owner fixes it: herdr installed, its config valid, a
 * server running in the session in use and compatible with the client, then each agent installed on the Mac with its
 * herdr integration. The Host reads this; it installs only an integration, and only when the owner asks.
 */
export const CodingSetup = Type.Object({
  herdr: Type.Object({ path: nullable(Type.String()), version: nullable(Type.String()) }),
  config: Type.Object({ ok: Type.Boolean(), note: nullable(Type.String()) }),
  /** The session coding reads and starts agents in, and every session herdr knows. */
  session: Type.String(),
  sessions: Type.Array(Type.Object({ name: Type.String(), running: Type.Boolean() })),
  /** The server of the session in use; null when it is not running. `restartNeeded`: herdr was updated and the server still runs the old build. */
  server: nullable(Type.Object({ version: nullable(Type.String()), compatible: Type.Boolean(), restartNeeded: Type.Boolean() })),
  agents: Type.Array(Type.Object({
    id: CodingAgentId,
    name: Type.String(),
    /** Where the executable is on this Mac; null when it is not installed. */
    path: nullable(Type.String()),
    integration: HerdrIntegration,
  })),
  /** Every herdr agent kind whose executable is on this Mac, for choosing what to start. */
  kinds: Type.Array(HerdrAgentKind),
  prefs: CodingPrefs,
});
export type CodingSetup = Static<typeof CodingSetup>;

/**
 * The owner starts an agent in herdr: a repository (or any directory), the first instruction and, optionally, the
 * agent (default: the owner's choice), a branch name and whether to work in a fresh git worktree (default yes in a git
 * repository), so the checkout stays clean. It opens a workspace in herdr and prompts the agent there.
 */
export const CodingStart = Type.Object({
  repo: Type.String({ minLength: 1, maxLength: 4096 }),
  task: Type.String({ minLength: 1, maxLength: 24_000 }),
  agent: Type.Optional(CodingAgentId),
  branch: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  worktree: Type.Optional(Type.Boolean()),
});
export type CodingStart = Static<typeof CodingStart>;

const PaneRef = { pane: Type.String({ pattern: "^[A-Za-z0-9]{1,16}:[A-Za-z0-9]{1,16}$" }) };
const Ref = Type.String({ pattern: "^[A-Za-z0-9]{1,16}(:[A-Za-z0-9]{1,16})?$" });
const Label = Type.String({ minLength: 1, maxLength: 80 });
const Dir = Type.String({ minLength: 1, maxLength: 4096 });
const Task = Type.String({ minLength: 1, maxLength: 24_000 });
/** The agent's own command-line arguments (`omp --continue`, `--model …`), passed after `--` to `herdr agent start`. */
const AgentArgs = Type.Array(Type.String({ maxLength: 400 }), { maxItems: 16 });

/**
 * A new workspace in herdr, the owner's "space": a directory, a label (default: herdr's own), and for a git repository
 * a fresh worktree on a new branch (`worktree`, default false here). With `agent` it starts that agent in the first
 * pane and, with `task`, gives it its first instruction; without, the workspace is a plain shell.
 */
export const HerdrWorkspaceCreate = Type.Object({
  cwd: Dir,
  label: Type.Optional(Label),
  worktree: Type.Optional(Type.Boolean()),
  branch: Type.Optional(Label),
  agent: Type.Optional(HerdrAgentKind),
  args: Type.Optional(AgentArgs),
  task: Type.Optional(Task),
});
export type HerdrWorkspaceCreate = Static<typeof HerdrWorkspaceCreate>;

/** A new tab in a workspace; `cwd` defaults to the workspace's. Agent and task as in a new workspace. */
export const HerdrTabCreate = Type.Object({
  workspace: Type.String({ pattern: "^[A-Za-z0-9]{1,16}$" }),
  label: Type.Optional(Label),
  cwd: Type.Optional(Dir),
  agent: Type.Optional(HerdrAgentKind),
  args: Type.Optional(AgentArgs),
  task: Type.Optional(Task),
});
export type HerdrTabCreate = Static<typeof HerdrTabCreate>;

/** Split a pane; the new pane is a plain shell, or an agent when `agent` is given. */
export const HerdrSplit = Type.Object({
  ...PaneRef,
  direction: Type.Union([Type.Literal("right"), Type.Literal("down")]),
  agent: Type.Optional(HerdrAgentKind),
  args: Type.Optional(AgentArgs),
  task: Type.Optional(Task),
});
export type HerdrSplit = Static<typeof HerdrSplit>;

/** Start an agent in a pane that is a shell at its prompt, and optionally give it its first instruction. */
export const HerdrAgentStart = Type.Object({ ...PaneRef, agent: HerdrAgentKind, args: Type.Optional(AgentArgs), task: Type.Optional(Task) });
export type HerdrAgentStart = Static<typeof HerdrAgentStart>;

/** What can be renamed or closed. A workspace id is `w1`, a tab `w1:t1`, a pane `w1:p1`. Closing ends the processes in it. */
export const HerdrTarget = Type.Union([Type.Literal("workspace"), Type.Literal("tab"), Type.Literal("pane")]);
export type HerdrTarget = Static<typeof HerdrTarget>;
export const HerdrRename = Type.Object({ target: HerdrTarget, id: Ref, label: Label });
export type HerdrRename = Static<typeof HerdrRename>;
export const HerdrClose = Type.Object({ target: HerdrTarget, id: Ref });
export type HerdrClose = Static<typeof HerdrClose>;

/**
 * How a follow-up reaches an agent that is still working. `steer` redirects the current turn (the agent reads it at its next
 * step); `queue` waits for the turn to finish. Only agents with a distinct queue key (omp: Ctrl+Q) differ; every other
 * agent receives the message the way its own Enter does. The Host ignores the choice while the agent is idle.
 */
export const HerdrDelivery = Type.Union([Type.Literal("steer"), Type.Literal("queue")]);
export type HerdrDelivery = Static<typeof HerdrDelivery>;

/** A follow-up instruction submitted to the agent in a pane, as herdr submits a prompt (refused while the agent waits at a dialog). */
export const HerdrPrompt = Type.Object({ ...PaneRef, text: Task, delivery: Type.Optional(HerdrDelivery) });
export type HerdrPrompt = Static<typeof HerdrPrompt>;

/** The next messages the owner is likely to send, each exactly as they would type it, most likely first. Empty when suggestions are off or nothing is worth offering. */
export const NextMessageSuggestions = Type.Object({ suggestions: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 4 }) });
export type NextMessageSuggestions = Static<typeof NextMessageSuggestions>;

/**
 * Input for a pane's terminal, the keyboard of the web terminal: `text` is typed exactly as given, control characters
 * and escape sequences included (what a terminal emulator produces for a key press or a paste), then `keys` are sent
 * as herdr key names (`enter`, `esc`, `ctrl+c`, `shift+tab`, `up`, `f1`, …).
 */
export const HerdrInput = Type.Object({
  ...PaneRef,
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536 })),
  keys: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z0-9+_-]{1,24}$" }), { minItems: 1, maxItems: 16 })),
});
export type HerdrInput = Static<typeof HerdrInput>;

/**
 * One frame of a pane's live terminal, `GET /api/herdr/terminal?pane=&cols=&rows=` as server-sent events (`event: frame`,
 * data this object as JSON; `event: end` when the pane or the stream is gone). `bytes` is base64 of ANSI output to write
 * to a terminal emulator of `width` x `height` as it arrives; a `full` frame repaints everything. The view is rendered
 * by herdr at the requested size; the pane itself, and the owner's herdr, are not resized.
 */
export const HerdrFrame = Type.Object({ seq: Type.Integer(), full: Type.Boolean(), width: Type.Integer(), height: Type.Integer(), bytes: Type.String() });
export type HerdrFrame = Static<typeof HerdrFrame>;

/** Install herdr's hook for one agent (writes into that agent's own config folder, as `herdr integration install` does). */
export const HerdrIntegrationInstall = Type.Object({ agent: CodingAgentId });
export type HerdrIntegrationInstall = Static<typeof HerdrIntegrationInstall>;

/**
 * What omp offers for starting a session in a directory, for the start form: the models it can use (`omp models`) with
 * the thinking levels each supports, and the directory's most recent conversations to continue (`omp --resume <id>`).
 */
export const OmpInfo = Type.Object({
  models: Type.Array(Type.Object({ selector: Type.String(), name: Type.String(), provider: Type.String(), thinking: Type.Array(Type.String()) })),
  sessions: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), updatedAt: Timestamp })),
});
export type OmpInfo = Static<typeof OmpInfo>;

/** One file a pane's work changed, relative to the commit its worktree was cut from (uncommitted and untracked included). */
export const HerdrChangedFile = Type.Object({
  path: Type.String(),
  status: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted"), Type.Literal("renamed"), Type.Literal("untracked")]),
  additions: nullable(Type.Integer()),
  deletions: nullable(Type.Integer()),
});
export type HerdrChangedFile = Static<typeof HerdrChangedFile>;

/**
 * What the agent in a pane has changed, read from git in the pane's directory: the branch, the commits since the
 * base, the files. `git` is false when the directory is not in a repository.
 */
export const HerdrChanges = Type.Object({
  git: Type.Boolean(),
  branch: nullable(Type.String()),
  base: nullable(Type.String()),
  commits: Type.Array(Type.Object({ sha: Type.String(), subject: Type.String() })),
  files: Type.Array(HerdrChangedFile),
  /** True when the file list was cut short. */
  truncated: Type.Boolean(),
});
export type HerdrChanges = Static<typeof HerdrChanges>;

/** One file's unified diff against the same base; cut at 200 KB. */
export const HerdrDiff = Type.Object({ path: Type.String(), diff: Type.String(), truncated: Type.Boolean() });
export type HerdrDiff = Static<typeof HerdrDiff>;

/** A file the owner sent from the app (a screenshot from the phone): where it was saved on the Mac, for an agent to read by path (`@path`). */
export const HerdrUpload = Type.Object({ path: Type.String(), name: Type.String(), size: Type.Integer() });
export type HerdrUpload = Static<typeof HerdrUpload>;

/** What an option does, read from its words: approve runs it once, trust keeps allowing it, deny refuses; neutral is anything else. */
export const HerdrChoiceTone = Type.Union([Type.Literal("approve"), Type.Literal("trust"), Type.Literal("deny"), Type.Literal("neutral")]);
export type HerdrChoiceTone = Static<typeof HerdrChoiceTone>;

/** A single-choice menu an agent is waiting on (a tool approval, a question), read from its screen. The phone answers with one tap. */
export const HerdrAsk = Type.Object({
  pane: Type.String(),
  kind: Type.Union([Type.Literal("approval"), Type.Literal("question")]),
  /** The agent's own question, as on its screen. */
  title: Type.String(),
  /** What it wants to run or change (a command, a path), when the screen shows one. */
  detail: nullable(Type.String()),
  /** Options in screen order. `index` is the position, 0-based. */
  choices: Type.Array(Type.Object({ index: Type.Integer(), label: Type.String(), tone: HerdrChoiceTone })),
  /** The option the agent's cursor is on now. */
  selected: Type.Integer(),
});
export type HerdrAsk = Static<typeof HerdrAsk>;

/** Answer an ask: `title` must still match the screen, so a tap on a stale card does nothing. */
export const HerdrAnswer = Type.Object({ pane: Type.String(), index: Type.Integer({ minimum: 0, maximum: 20 }), title: Type.String() });
export type HerdrAnswer = Static<typeof HerdrAnswer>;

/** One entry of an agent's own conversation record (not its screen). Tool calls and thinking stay one-liners; the phone folds them. */
export const HerdrChatItem = Type.Union([
  Type.Object({ id: Type.String(), kind: Type.Literal("user"), at: nullable(Type.Integer()), text: Type.String(), /** The Host's coding-turn reference when this user record carries a managed prompt, so a long task correlates without reading the whole text. */ codingReference: Type.Optional(Type.String({ maxLength: 160 })) }),
  Type.Object({ id: Type.String(), kind: Type.Literal("agent"), at: nullable(Type.Integer()), text: Type.String() }),
  Type.Object({ id: Type.String(), kind: Type.Literal("tool"), at: nullable(Type.Integer()), name: Type.String(), summary: Type.String(), ok: nullable(Type.Boolean()) }),
  Type.Object({ id: Type.String(), kind: Type.Literal("thinking"), at: nullable(Type.Integer()) }),
  Type.Object({ id: Type.String(), kind: Type.Literal("note"), at: nullable(Type.Integer()), text: Type.String() }),
]);
export type HerdrChatItem = Static<typeof HerdrChatItem>;

/**
 * The agent's conversation record for a pane, read on the Mac from the file herdr says the pane's session writes
 * (`agent_session`). `source` is null when the pane has no readable record (a shell, an unknown agent); the phone then stays on the
 * terminal. `after` continues from `cursor`; `reset` means the record changed under the cursor and `items` replace everything.
 */
export const HerdrChat = Type.Object({
  pane: Type.String(),
  /** The model the session currently runs (omp: `provider/id`; Claude: its model id), from the session record; null when it has not said. */
  model: nullable(Type.String()),
  source: nullable(Type.Union([Type.Literal("omp"), Type.Literal("claude")])),
  title: nullable(Type.String()),
  items: Type.Array(HerdrChatItem),
  cursor: Type.String(),
  reset: Type.Boolean(),
});
export type HerdrChat = Static<typeof HerdrChat>;

/** One slash command the agent in a pane accepts, as it would be typed after the slash. */
export const HerdrSlashCommand = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.String({ maxLength: 300 }),
  /** What follows the name, when it takes an argument (for example `provider/model`); null when it takes none. */
  hint: nullable(Type.String({ maxLength: 120 })),
  source: Type.Union([Type.Literal("builtin"), Type.Literal("skill"), Type.Literal("custom")]),
});
export type HerdrSlashCommand = Static<typeof HerdrSlashCommand>;
export const HerdrCommands = Type.Object({ commands: Type.Array(HerdrSlashCommand, { maxItems: 500 }) });
export type HerdrCommands = Static<typeof HerdrCommands>;

/**
 * Driving a pane at the phone's own size (herdr `terminal session control`), as opposed to watching it
 * (`/api/herdr/terminal`, which never resizes anything). While a control lease is held the pane itself is resized to
 * `cols` x `rows`, so the app inside redraws for the phone and herdr-side scrollback and mouse work; herdr does not undo
 * that when the stream closes, so the Host records the size before the first resize and restores it (size, then scroll to
 * the bottom) on release, on stream loss after a short grace, and on its own start for leases a crash left behind.
 *
 * `GET /api/herdr/control?pane=&cols=&rows=[&fit=1][&takeover=1][&client=<uuid>]` opens the lease and streams
 * `event: lease` (HerdrControlLease), `event: frame` (HerdrFrame), then `event: end` (HerdrControlEnd).
 * Before streaming, 409 `confirm_required` asks for `fit=1` on an unowned pane; 409 `held` asks for `takeover=1`.
 * Reconnecting with the same `client` within 10 seconds keeps the pane's original baseline. Opening a different pane
 * for that client releases the first. `POST /api/herdr/control/send` and `/release` require the current `leaseId`;
 * an expired send is a conflict and an expired release does nothing.
 */
export const HerdrControlLease = Type.Object({
  pane: Type.String(),
  leaseId: Type.String({ format: "uuid" }),
  /** The size the pane had before the lease; null if it could not be read (then nothing can be restored). */
  baseline: nullable(Type.Object({ cols: Type.Integer(), rows: Type.Integer() })),
  /** True for a pane the app started itself (no confirmation was needed). */
  owned: Type.Boolean(),
});
export type HerdrControlLease = Static<typeof HerdrControlLease>;

export const HerdrControlEnd = Type.Object({ reason: Type.Union([Type.Literal("closed"), Type.Literal("taken"), Type.Literal("released"), Type.Literal("error")]) });
export type HerdrControlEnd = Static<typeof HerdrControlEnd>;

export const HerdrControlRelease = Type.Object({ ...PaneRef, leaseId: Type.String({ format: "uuid" }) });
export type HerdrControlRelease = Static<typeof HerdrControlRelease>;

export const HerdrControlCommand = Type.Union([
  Type.Object({ ...HerdrControlRelease.properties, type: Type.Literal("input"), text: Type.String({ minLength: 1, maxLength: 65_536 }) }),
  Type.Object({ ...HerdrControlRelease.properties, type: Type.Literal("resize"), cols: Type.Integer({ minimum: 20, maximum: 300 }), rows: Type.Integer({ minimum: 5, maximum: 120 }) }),
  Type.Object({
    ...HerdrControlRelease.properties,
    type: Type.Literal("scroll"),
    direction: Type.Union([Type.Literal("up"), Type.Literal("down")]),
    lines: Type.Integer({ minimum: 1, maximum: 500 }),
    source: Type.Optional(Type.Union([Type.Literal("wheel"), Type.Literal("page_key")])),
    column: Type.Optional(Type.Integer({ minimum: 0, maximum: 299 })),
    row: Type.Optional(Type.Integer({ minimum: 0, maximum: 119 })),
  }),
  Type.Object({
    ...HerdrControlRelease.properties,
    type: Type.Literal("mouse"),
    action: Type.Union([Type.Literal("down"), Type.Literal("up"), Type.Literal("drag"), Type.Literal("move")]),
    button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
    column: Type.Integer({ minimum: 0, maximum: 299 }),
    row: Type.Integer({ minimum: 0, maximum: 119 }),
    modifiers: Type.Optional(Type.Integer({ minimum: 0, maximum: 7 })),
  }),
]);
export type HerdrControlCommand = Static<typeof HerdrControlCommand>;
