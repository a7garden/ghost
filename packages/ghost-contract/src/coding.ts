import { Type, type Static } from "typebox";
import { nullable } from "./entities.ts";

/**
 * Coding is herdr, the terminal workspace manager the owner already works in: the Host never runs a coding agent of
 * its own. It reads, starts and talks to agents inside one herdr session, so what the app shows is what the owner sees
 * in herdr. These are the agents the app can start there.
 */
export const CodingAgentId = Type.Union([Type.Literal("omp"), Type.Literal("claude"), Type.Literal("codex")]);
export type CodingAgentId = Static<typeof CodingAgentId>;

/** The owner's choices: which herdr session coding uses (null: herdr's default session, the one `herdr` attaches to) and the agent a new session starts with. */
export const CodingPrefs = Type.Object({
  session: nullable(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" })),
  agent: nullable(CodingAgentId),
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
  task: Type.Optional(Task),
});
export type HerdrWorkspaceCreate = Static<typeof HerdrWorkspaceCreate>;

/** A new tab in a workspace; `cwd` defaults to the workspace's. Agent and task as in a new workspace. */
export const HerdrTabCreate = Type.Object({
  workspace: Type.String({ pattern: "^[A-Za-z0-9]{1,16}$" }),
  label: Type.Optional(Label),
  cwd: Type.Optional(Dir),
  agent: Type.Optional(HerdrAgentKind),
  task: Type.Optional(Task),
});
export type HerdrTabCreate = Static<typeof HerdrTabCreate>;

/** Split a pane; the new pane is a plain shell, or an agent when `agent` is given. */
export const HerdrSplit = Type.Object({
  ...PaneRef,
  direction: Type.Union([Type.Literal("right"), Type.Literal("down")]),
  agent: Type.Optional(HerdrAgentKind),
  task: Type.Optional(Task),
});
export type HerdrSplit = Static<typeof HerdrSplit>;

/** Start an agent in a pane that is a shell at its prompt, and optionally give it its first instruction. */
export const HerdrAgentStart = Type.Object({ ...PaneRef, agent: HerdrAgentKind, task: Type.Optional(Task) });
export type HerdrAgentStart = Static<typeof HerdrAgentStart>;

/** What can be renamed or closed. A workspace id is `w1`, a tab `w1:t1`, a pane `w1:p1`. Closing ends the processes in it. */
export const HerdrTarget = Type.Union([Type.Literal("workspace"), Type.Literal("tab"), Type.Literal("pane")]);
export type HerdrTarget = Static<typeof HerdrTarget>;
export const HerdrRename = Type.Object({ target: HerdrTarget, id: Ref, label: Label });
export type HerdrRename = Static<typeof HerdrRename>;
export const HerdrClose = Type.Object({ target: HerdrTarget, id: Ref });
export type HerdrClose = Static<typeof HerdrClose>;

/** A follow-up instruction submitted to the agent in a pane, as herdr submits a prompt (refused while the agent waits at a dialog). */
export const HerdrPrompt = Type.Object({ ...PaneRef, text: Task });
export type HerdrPrompt = Static<typeof HerdrPrompt>;

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
