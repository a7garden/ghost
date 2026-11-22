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

/** One coding agent running in a pane of the session in use. */
export const HerdrPaneView = Type.Object({
  id: Type.String(),
  workspace: Type.String(),
  tab: Type.String(),
  agent: Type.String(),
  status: HerdrStatus,
  cwd: nullable(Type.String()),
  title: Type.String(),
});
export type HerdrPaneView = Static<typeof HerdrPaneView>;

/**
 * The agents of the herdr session in use (`session`). `available` is false when no `herdr` binary is found; `note` says
 * why a look failed, such as a session that is not running. The Host never starts a herdr server.
 */
export const HerdrView = Type.Object({ available: Type.Boolean(), session: Type.String(), note: nullable(Type.String()), panes: Type.Array(HerdrPaneView) });
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

/** A follow-up instruction typed into an agent pane, submitted as herdr submits a prompt. */
export const HerdrPrompt = Type.Object({ ...PaneRef, text: Type.String({ minLength: 1, maxLength: 24_000 }) });
export type HerdrPrompt = Static<typeof HerdrPrompt>;

/** Keys the owner may send to an agent pane: enough to interrupt it and to answer an approval dialog. */
export const HerdrKey = Type.Union([
  Type.Literal("esc"), Type.Literal("ctrl+c"), Type.Literal("enter"), Type.Literal("up"), Type.Literal("down"), Type.Literal("tab"),
  Type.Literal("y"), Type.Literal("n"), Type.Literal("1"), Type.Literal("2"), Type.Literal("3"),
]);
export type HerdrKey = Static<typeof HerdrKey>;
export const HERDR_KEYS = ["esc", "ctrl+c", "enter", "up", "down", "tab", "y", "n", "1", "2", "3"] as const satisfies readonly HerdrKey[];
export const HerdrKeys = Type.Object({ ...PaneRef, keys: Type.Array(HerdrKey, { minItems: 1, maxItems: 8 }) });
export type HerdrKeys = Static<typeof HerdrKeys>;

/** Install herdr's hook for one agent (writes into that agent's own config folder, as `herdr integration install` does). */
export const HerdrIntegrationInstall = Type.Object({ agent: CodingAgentId });
export type HerdrIntegrationInstall = Static<typeof HerdrIntegrationInstall>;
