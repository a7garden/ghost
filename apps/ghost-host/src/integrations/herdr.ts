import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { HERDR_AGENT_KINDS, validate, type CodingAgentId, type CodingPrefs, type CodingSetup, type CodingStart, type HerdrAgentKind, type HerdrAgentStart, type HerdrAnswer, type HerdrAsk, type HerdrChangedFile, type HerdrChanges, type HerdrChat, type HerdrClose, type HerdrControlCommand, type HerdrControlRelease, type HerdrDiff, type HerdrFrame, type HerdrInput, type HerdrIntegration, type HerdrOutput, type HerdrPaneView, type HerdrRename, type HerdrSplit, type HerdrTabCreate, type HerdrView, type HerdrWorkspaceCreate, type HerdrWorkspaceView } from "@ghost/contract";
import type { HerdrDelivery } from "@ghost/contract";
import { CommandError, conflict, invalid, notFound } from "../core/errors.ts";
import { detectHerdrAsk } from "./herdr-ask.ts";
import { HerdrChatReader } from "./herdr-chat.ts";
import { ControlLeases, type ControlPane, type HerdrControlRequest, type HerdrControlStream } from "./herdr-control.ts";
import { HERDR_PANE as PANE, HERDR_SESSION as SESSION, HERDR_TERMINAL, HerdrState, TerminalSize } from "./herdr-state.ts";
import type { HerdrPort, HerdrRun, HerdrWait } from "./ports.ts";
export { mergeHerdrFrames as mergeFrames } from "./herdr-control.ts";

/** Only the fields the Host reads of herdr's `api snapshot`; everything else in it is ignored. */
const Snapshot = Type.Object({
  result: Type.Object({
    snapshot: Type.Object({
      workspaces: Type.Array(Type.Object({
        workspace_id: Type.String(),
        label: Type.Optional(Type.String()),
        number: Type.Optional(Type.Number()),
        agent_status: Type.Optional(Type.String()),
        worktree: Type.Optional(Type.Object({ checkout_path: Type.String(), branch: Type.Optional(Type.Union([Type.String(), Type.Null()])) })),
      })),
      tabs: Type.Array(Type.Object({
        tab_id: Type.String(),
        workspace_id: Type.String(),
        label: Type.Optional(Type.String()),
        number: Type.Optional(Type.Number()),
        agent_status: Type.Optional(Type.String()),
      })),
      panes: Type.Array(Type.Object({
        pane_id: Type.String(),
        terminal_id: Type.Optional(Type.String()),
        workspace_id: Type.String(),
        tab_id: Type.String(),
        /** Absent, not null, on a pane with no agent. */
        agent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        agent_status: Type.Optional(Type.String()),
        state_change_seq: Type.Optional(Type.Integer({ minimum: 0 })),
        completion_seq: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
        agent_session: Type.Optional(Type.Union([Type.Null(), Type.Object({ agent: Type.String(), kind: Type.String(), value: Type.String() })])),
        focused: Type.Optional(Type.Boolean()),
        cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        foreground_cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        terminal_title_stripped: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      })),
    }),
  }),
});
const Sessions = Type.Object({ sessions: Type.Array(Type.Object({ name: Type.String(), running: Type.Boolean() })) });
/** What `workspace create`, `worktree create` and `tab create` answer with: the first pane of the new container, and the checkout when it is a worktree. */
const Created = Type.Object({
  result: Type.Object({
    root_pane: Type.Object({ pane_id: Type.String(), terminal_id: Type.Optional(Type.String()) }),
    workspace: Type.Optional(Type.Object({ worktree: Type.Optional(Type.Object({ checkout_path: Type.String() })) })),
  }),
});
/** What `pane split` answers with. */
const Split = Type.Object({ result: Type.Object({ pane: Type.Object({ pane_id: Type.String(), terminal_id: Type.Optional(Type.String()) }) }) });
const Started = Type.Object({ result: Type.Object({ agent: Type.Object({ pane_id: Type.String(), terminal_id: Type.String() }) }) });
const PaneGeometry = Type.Object({ result: Type.Object({ pane: Type.Object({
  terminal_id: Type.String({ pattern: HERDR_TERMINAL.source }),
  scroll: Type.Optional(Type.Object({ viewport_rows: Type.Integer({ minimum: 1, maximum: 65535 }), offset_from_bottom: Type.Integer({ minimum: 0 }) })),
}) }) });
const PaneLayout = Type.Object({ result: Type.Object({ layout: Type.Object({ panes: Type.Array(Type.Object({
  pane_id: Type.String(), rect: Type.Object({ width: TerminalSize.properties.cols, height: TerminalSize.properties.rows }),
})) }) }) });
const PaneSessions = Type.Object({
  result: Type.Object({ panes: Type.Array(Type.Object({
    pane_id: Type.String(),
    agent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    agent_session: Type.Optional(Type.Union([Type.Null(), Type.Object({
      agent: Type.String(), kind: Type.String(), value: Type.String(),
    })])),
  })) }),
});
/** What `terminal session observe` says when the pane it shows is gone. */
const Closed = Type.Object({ type: Type.Literal("terminal.closed") });
/** One line of `terminal session observe`. */
const Frame = Type.Object({ type: Type.Literal("terminal.frame"), bytes: Type.String(), full: Type.Boolean(), seq: Type.Integer(), width: Type.Integer(), height: Type.Integer() });
const Failure = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.Optional(Type.String()) }) });

const WORKSPACE = /^[A-Za-z0-9]{1,16}$/;
const STATUSES: readonly HerdrPaneView["status"][] = ["idle", "working", "blocked", "done", "unknown"];
const GIT = "/usr/bin/git";

/** The agents the app can start, in the order one is picked when the owner has no preference. */
export const CODING_AGENTS: readonly { id: CodingAgentId; name: string }[] = [
  { id: "omp", name: "omp" },
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
];

const PROBE_MS = 8_000;
/** Starting an agent waits for it to be ready for input and, in a worktree, for git to check the branch out. */
const START_MS = 90_000;
const MAX_OBSERVERS = 12;
const KEEPALIVE_MS = 15_000;
export const OUTPUT_LINES = 300;
const OUTPUT_BYTES = 64 * 1024;
const HISTORY_MAX_LINES = 2_000;
const HISTORY_BYTES = 512 * 1024;
const DIFF_BYTES = 200 * 1024;
const MAX_FILES = 300;
const ENV_KEPT = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"];
const NO_PREFS: CodingPrefs = { session: null, agent: null, notify: "blocked" };

const AGENT_IDS: readonly unknown[] = CODING_AGENTS.map((agent) => agent.id);

/**
 * The owner's saved choice. A setting written before coding became herdr carries `default` (the agent `code_run`
 * preferred) and `disabled`; its default is the agent a new session starts with, the rest has no meaning any more.
 */
export function codingPrefs(saved: unknown): CodingPrefs {
  const value = (typeof saved === "object" && saved !== null ? saved : {}) as Record<string, unknown>;
  const agent = value.agent ?? value.default;
  return {
    session: typeof value.session === "string" && SESSION.test(value.session) ? value.session : null,
    agent: AGENT_IDS.includes(agent) ? (agent as CodingAgentId) : null,
    notify: value.notify === "off" || value.notify === "all" ? value.notify : "blocked",
  };
}

const isExecutable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** A program by name: where its installer puts it, then PATH. */
export function findProgram(name: string, dirs?: string[]): string | null {
  const home = homedir();
  const path = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs ?? [...new Set([join(home, ".bun/bin"), join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", ...path])]) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}


/** What a terminal gave back, ready to read: escape sequences and control bytes gone, trailing blanks trimmed, the end of it only. */
export function terminalText(raw: string, maxLines = OUTPUT_LINES, maxBytes = OUTPUT_BYTES): string {
  const lines = raw.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const text = lines.slice(-maxLines).join("\n");
  return text.length > maxBytes ? text.slice(-maxBytes) : text;
}

/** A terminal's text with its colours: SGR sequences and newlines kept, every other escape sequence and control byte gone, the end of it only. */
export function ansiText(raw: string, maxLines: number, maxBytes: number): string {
  const lines = raw
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[([0-9;:?]*)([ -\/]*)([@-~])/g, (sequence, _params: string, _inter: string, final: string) => (final === "m" && !sequence.includes("?") ? sequence : ""))
    .replace(/\u001b(?!\[[0-9;:]*m)/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let text = lines.slice(-maxLines).join("\n");
  if (text.length > maxBytes) {
    // Cut at a line start, never inside an escape sequence.
    text = text.slice(-maxBytes);
    const newline = text.indexOf("\n");
    text = newline < 0 ? "" : text.slice(newline + 1);
  }
  return text;
}

/** The instruction a coding agent starts with: the task, then where it may work and how to finish. */
export function promptFor(task: string, branch: string | null): string {
  return [
    "# Task",
    task.trim(),
    "",
    "# Rules",
    "- Work only inside the current directory; follow its AGENTS.md and project conventions.",
    ...(branch === null
      ? ["- This directory is not a git worktree made for this task; change files in place."]
      : [
          `- This directory is a git worktree on branch ${branch}. Stay on that branch; never push, merge, rebase or switch branches.`,
          "- When the work is complete and its checks pass, commit it on this branch with a clear message and stage files by name.",
        ]),
    "- Finish with a short summary: what changed, what you ran to check it, and anything left undone.",
  ].join("\n");
}

const slugOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";

async function git(args: string[], cwd: string, max = 20_000, keep: "tail" | "head" = "tail"): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([GIT, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const text = out.trim() || err.trim();
    return { code, out: keep === "tail" ? text.slice(-max) : text.slice(0, max) };
  } finally {
    clearTimeout(timer);
  }
}

/** What starting an agent came to after herdr had already opened a workspace for it: the pane is there, whatever the agent did next. */
export class HerdrStartError extends CommandError {
  constructor(message: string, readonly pane: string) {
    super("unavailable", message);
  }
}

/** The commits, diff and loose changes of a worktree since the commit it was cut from; without one, since the checkout it was cut from. */
export async function gitReport(checkout: string, base: string | null): Promise<Record<string, unknown>> {
  let from = base;
  if (from === null) {
    const main = /^worktree .*\nHEAD ([0-9a-f]+)/.exec((await git(["worktree", "list", "--porcelain"], checkout)).out)?.[1];
    from = main === undefined ? null : (await git(["merge-base", "HEAD", main], checkout)).out;
  }
  const report: Record<string, unknown> = {};
  if (from !== null && /^[0-9a-f]{7,40}$/.test(from)) {
    report.base = from.slice(0, 12);
    report.commits = (await git(["log", "--oneline", "-20", `${from}..HEAD`], checkout)).out.split("\n").filter(Boolean);
    report.diffStat = (await git(["diff", "--stat", from], checkout)).out.slice(-3_000);
  }
  report.uncommitted = (await git(["status", "--short"], checkout)).out.slice(0, 1_500);
  const [upstream, containing] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], checkout),
    git(["for-each-ref", "--format=%(refname:short)", "--contains=HEAD", "refs/remotes/"], checkout),
  ]);
  report.publication = {
    upstream: upstream.code === 0 ? upstream.out : null,
    remoteRefsContainingHead: containing.code === 0 ? containing.out.split("\n").filter(Boolean).slice(0, 30) : [],
    basis: "Local remote-tracking refs only; no fetch or network probe. Presence does not prove this agent pushed, and absence does not prove it did not.",
  };
  return report;
}

/** Herdr's error codes as the Host's: a thing that is not there, a thing that must be answered first, or herdr itself being unable. */
function failure(code: string | null, message: string): CommandError {
  if (code === "pane_not_found" || code === "agent_not_found") return notFound(message);
  if (code === "agent_blocked") return conflict(message);
  if (code !== null && code.startsWith("invalid")) return invalid(message);
  return new CommandError("unavailable", message);
}

/**
 * The owner's herdr, driven through its `herdr` CLI by argv, in one session: the one the owner is using. Coding is
 * herdr and nothing else: the Host never runs a coding agent itself and never starts a herdr server (a server it
 * started would be a second instance, not the owner's). It lists the agent panes, reads their terminals, opens a
 * workspace (a git worktree for a repository) with an agent in it, prompts and keys an agent, and reads what must be
 * set up for that to work. The environment is rebuilt without herdr's own `HERDR_*` variables, so a Host started inside
 * a herdr pane still reaches the session it names rather than the pane it happened to start in.
 */
export class Herdr implements HerdrPort {
  private found: string | null = null;
  private readonly transcripts: HerdrChatReader;
  private readonly answering = new Set<string>();
  private readonly state: HerdrState;
  private readonly controls: ControlLeases;

  /** `executable` undefined: find herdr where its installer puts it, again on every use until it is found, so installing it while the Host runs is noticed. Null or a path is taken as given. */
  constructor(
    private readonly given?: string | null,
    private readonly options: { prefs?: () => CodingPrefs; agentDirs?: string[]; transcriptHome?: string; root?: string; log?: (message: string, error?: unknown) => void } = {},
  ) {
    this.transcripts = new HerdrChatReader(options.transcriptHome);
    this.state = new HerdrState(options.root);
    this.controls = new ControlLeases({
      state: this.state,
      inspect: (session, pane, layout) => this.geometry(session, pane, layout),
      spawn: (session, terminal, size, takeover) => {
        if (this.executable === null) throw new CommandError("unavailable", "herdr가 설치되지 않았습니다.");
        return Bun.spawn([this.executable, "--session", session, "terminal", "session", "control", terminal,
          "--cols", String(size.cols), "--rows", String(size.rows), ...(takeover ? ["--takeover"] : [])],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: Herdr.env() });
      },
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
  }

  private get executable(): string | null {
    if (this.given !== undefined) return this.given;
    if (this.found === null || !isExecutable(this.found)) {
      this.found = findProgram("herdr", [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", ...(process.env.PATH ?? "").split(":").filter(Boolean)]);
    }
    return this.found;
  }

  private get prefs(): CodingPrefs {
    return this.options.prefs?.() ?? NO_PREFS;
  }

  /** The session coding uses: the owner's choice, else herdr's default, which is the one `herdr` attaches to. */
  get session(): string {
    return this.prefs.session ?? "default";
  }

  private static env(): Record<string, string> {
    const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
    for (const name of ENV_KEPT) if (process.env[name] !== undefined) env[name] = process.env[name]!;
    return env;
  }

  private async run(args: string[], limitMs = PROBE_MS, signal?: AbortSignal): Promise<{ code: number; out: string; err: string }> {
    const child = Bun.spawn([this.executable!, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: Herdr.env() });
    const timer = setTimeout(() => child.kill(), limitMs);
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, out, err };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** Herdr's own words for why a command failed, which it prints as JSON, else what it wrote. */
  private static reason(result: { out: string; err: string }): { code: string | null; message: string } {
    for (const text of [result.out, result.err]) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (validate(Failure, parsed)) return { code: parsed.error.code, message: parsed.error.message ?? parsed.error.code };
      } catch { /* not JSON */ }
    }
    return { code: null, message: (result.err.trim() || result.out.trim() || "herdr did not answer").slice(0, 400) };
  }

  /** Runs a session command and returns its JSON (null when it printed none), or throws herdr's reason. */
  private async call(args: string[], limitMs = PROBE_MS, signal?: AbortSignal, session = this.session): Promise<unknown> {
    if (this.executable === null) throw new CommandError("unavailable", "herdr is not installed on this Mac");
    const result = await this.run(["--session", session, ...args], limitMs, signal);
    const why = Herdr.reason(result);
    if (result.code !== 0 || why.code !== null) throw failure(why.code, why.message);
    // Some commands (`pane send-text`) print nothing on success; a caller that needs an answer validates what it gets.
    try { return JSON.parse(result.out); } catch { return null; }
  }

  /** The session as herdr's own sidebar shows it: workspaces, their tabs, their panes. */
  private async tree(session = this.session): Promise<HerdrWorkspaceView[]> {
    const owned = this.state.ownedTerminals(session);
    const parsed = await this.call(["api", "snapshot"], PROBE_MS, undefined, session);
    if (!validate(Snapshot, parsed)) throw new CommandError("unavailable", "herdr gave a snapshot in a shape this Host does not know");
    const { workspaces, tabs, panes } = parsed.result.snapshot;
    if (owned) {
      const terminals = panes.flatMap(({ terminal_id }) => terminal_id === undefined ? [] : [terminal_id]);
      if (terminals.length === panes.length) this.state.prune(session, owned, new Set(terminals));
    }
    const byNumber = (a: { number?: number | undefined }, b: { number?: number | undefined }) => (a.number ?? 0) - (b.number ?? 0);
    const status = (value: string | undefined): HerdrPaneView["status"] => STATUSES.find((known) => known === value) ?? "unknown";
    return [...workspaces].sort(byNumber).map((workspace) => ({
      id: workspace.workspace_id,
      label: workspace.label ?? "",
      status: status(workspace.agent_status),
      worktree: workspace.worktree === undefined ? null : { path: workspace.worktree.checkout_path, branch: workspace.worktree.branch ?? null },
      tabs: tabs.filter((tab) => tab.workspace_id === workspace.workspace_id).sort(byNumber).map((tab) => ({
        id: tab.tab_id,
        label: tab.label ?? "",
        status: status(tab.agent_status),
        panes: panes.filter((pane) => pane.tab_id === tab.tab_id).map((pane): HerdrPaneView => ({
          id: pane.pane_id,
          ...(pane.terminal_id === undefined ? {} : { terminalId: pane.terminal_id }),
          workspaceId: workspace.workspace_id,
          tabId: tab.tab_id,
          workspace: workspace.label ?? "",
          tab: tab.label ?? "",
          agent: pane.agent ?? null,
          status: status(pane.agent_status),
          ...(pane.state_change_seq === undefined ? {} : { stateChangeSeq: pane.state_change_seq }),
          ...(pane.completion_seq === undefined ? {} : { completionSeq: pane.completion_seq }),
          ...(pane.agent_session ? { agentSessionId: JSON.stringify([pane.agent_session.agent, pane.agent_session.kind, pane.agent_session.value]) } : {}),
          cwd: pane.foreground_cwd ?? pane.cwd ?? null,
          // An agent is named by its tab (herdr names the tab after the task); a shell by what it shows or where it is, so two shells in one tab differ.
          title: pane.agent ? tab.label || pane.terminal_title_stripped || pane.pane_id : pane.terminal_title_stripped || basename(pane.foreground_cwd ?? pane.cwd ?? "") || pane.pane_id,
          focused: pane.focused === true,
          owned: pane.terminal_id !== undefined && this.state.owns(session, pane.terminal_id),
        })),
      })),
    }));
  }

  /** One pane of the session in use, an agent or a plain shell. */
  private async pane(id: string, session = this.session): Promise<HerdrPaneView> {
    if (!PANE.test(id)) throw invalid("not a herdr pane id");
    const view = (await this.tree(session)).flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes)).find((entry) => entry.id === id);
    if (view === undefined) throw notFound(`herdr pane ${id}`);
    return view;
  }

  private async geometry(session: string, pane: string, withLayout: boolean): Promise<ControlPane | null> {
    let parsed: unknown;
    try { parsed = await this.call(["pane", "get", pane], 1_500, undefined, session); }
    catch (error) {
      if (error instanceof CommandError && error.code === "not_found") return null;
      throw error;
    }
    if (!validate(PaneGeometry, parsed)) throw new CommandError("unavailable", "터미널 정보를 읽을 수 없습니다.");
    const { terminal_id, scroll } = parsed.result.pane;
    let layout: TerminalSize | null = null;
    if (withLayout) {
      const result = await this.call(["pane", "layout", "--pane", pane], 1_500, undefined, session).catch(() => null);
      if (validate(PaneLayout, result)) {
        const rect = result.result.layout.panes.find((entry) => entry.pane_id === pane)?.rect;
        if (rect) layout = { cols: rect.width, rows: rect.height };
      }
    }
    return { terminal: terminal_id, offset: scroll?.offset_from_bottom ?? null, viewportRows: scroll?.viewport_rows ?? null, layout };
  }

  recoverControls(): Promise<void> { return this.controls.recover(); }
  shutdownControls(): Promise<void> { return this.controls.shutdown(); }

  control(request: HerdrControlRequest, principal: string, signal: AbortSignal): Promise<HerdrControlStream> {
    if (!PANE.test(request.pane)) throw invalid("not a herdr pane id");
    return this.controls.open(this.session, request, principal, signal);
  }

  controlSend(command: HerdrControlCommand, principal: string): Promise<void> {
    return this.controls.send(this.session, principal, command);
  }

  controlRelease({ pane, leaseId }: HerdrControlRelease, principal: string): Promise<void> {
    return this.controls.release(this.session, pane, leaseId, principal);
  }

  /** A pane that holds an agent; prompting a shell would type into it. */
  private async agentPane(id: string, session = this.session): Promise<HerdrPaneView> {
    const view = await this.pane(id, session);
    if (view.agent === null) throw invalid(`no agent runs in herdr pane ${id}`);
    return view;
  }

  async overview(session = this.session): Promise<HerdrView> {
    if (!SESSION.test(session)) throw invalid("not a herdr session name");
    if (this.executable === null) return { available: false, session, note: null, workspaces: [] };
    try {
      return { available: true, session, note: null, workspaces: await this.tree(session) };
    } catch (error) {
      if (error instanceof CommandError && error.code === "unavailable") return { available: true, session, note: error.message, workspaces: [] };
      throw error;
    }
  }

  /** The end of a pane's terminal as text; `ansi` keeps the colours (the history view), `lines` is how far back. */
  async output(id: string, options: { ansi?: boolean; lines?: number; session?: string } = {}): Promise<HerdrOutput> {
    const session = options.session ?? this.session;
    return this.readOutput(await this.pane(id, session), session, options);
  }

  private async readOutput(pane: HerdrPaneView, session: string, options: { ansi?: boolean; lines?: number } = {}): Promise<HerdrOutput> {
    if (this.executable === null) throw new CommandError("unavailable", "herdr is not installed on this Mac");
    const lines = Math.min(Math.max(Math.round(options.lines ?? OUTPUT_LINES), 1), HISTORY_MAX_LINES);
    const read = await this.run(["--session", session, "pane", "read", pane.id, "--source", "recent-unwrapped", "--lines", String(lines), ...(options.ansi ? ["--format", "ansi"] : [])], 15_000);
    if (read.code !== 0) {
      const why = Herdr.reason(read);
      throw failure(why.code, why.message);
    }
    return { pane, text: options.ansi ? ansiText(read.out, lines, HISTORY_BYTES) : terminalText(read.out, lines, lines > OUTPUT_LINES ? HISTORY_BYTES : OUTPUT_BYTES) };
  }

  private async currentAsk(id: string, session: string) {
    const pane = await this.pane(id, session);
    return pane.agent !== null && pane.status === "blocked" ? detectHerdrAsk(await this.readOutput(pane, session)) : null;
  }

  async ask(pane: string, session = this.session): Promise<HerdrAsk | null> {
    return (await this.currentAsk(pane, session))?.view ?? null;
  }

  async answer({ pane, title, index }: HerdrAnswer): Promise<HerdrPaneView> {
    const session = this.session;
    const key = `${session}/${pane}`;
    if (this.answering.has(key)) throw conflict("응답 대기 중");
    this.answering.add(key);
    try {
      const ask = await this.currentAsk(pane, session);
      if (!ask || ask.view.title !== title || !ask.view.choices[index]) throw conflict("질문이 바뀌었습니다.");
      await this.call(["pane", "send-keys", pane, ...ask.keys(index)], PROBE_MS, undefined, session);
      return await this.pane(pane, session);
    } finally {
      this.answering.delete(key);
    }
  }

  async chat(pane: string, after: string | null, session = this.session): Promise<HerdrChat> {
    if (!PANE.test(pane)) throw invalid("not a herdr pane id");
    const parsed = await this.call(["pane", "list", "--workspace", pane.split(":")[0]!], PROBE_MS, undefined, session);
    if (!validate(PaneSessions, parsed)) throw new CommandError("unavailable", "herdr gave a pane list in a shape this Host does not know");
    const listed = parsed.result.panes.find((item) => item.pane_id === pane);
    if (!listed) throw notFound(`herdr pane ${pane}`);
    const ref = listed.agent_session;
    return this.transcripts.read(pane, ref?.agent === listed.agent ? ref ?? null : null, after, `${session}/${pane}`);
  }

  /** The repository a pane works in, and the commit its work is measured from: where its worktree was cut, for the main checkout HEAD itself. */
  private async repository(id: string, session = this.session): Promise<{ cwd: string; branch: string | null; base: string } | null> {
    const cwd = (await this.pane(id, session)).cwd;
    if (cwd === null || !existsSync(cwd)) return null;
    if ((await git(["rev-parse", "--show-toplevel"], cwd)).code !== 0) return null;
    const head = await git(["rev-parse", "HEAD"], cwd);
    // A repository with no commit has nothing to measure from.
    if (head.code !== 0) return null;
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).out;
    const main = /^worktree .*\nHEAD ([0-9a-f]+)/.exec((await git(["worktree", "list", "--porcelain"], cwd)).out)?.[1];
    const merged = main === undefined ? null : await git(["merge-base", "HEAD", main], cwd);
    return { cwd, branch: branch === "HEAD" ? null : branch, base: merged !== null && merged.code === 0 && /^[0-9a-f]{7,40}$/.test(merged.out) ? merged.out : head.out };
  }

  async changes(id: string, session = this.session): Promise<HerdrChanges> {
    const repo = await this.repository(id, session);
    if (repo === null) return { git: false, branch: null, base: null, commits: [], files: [], truncated: false };
    const [numstat, names, untracked, log] = await Promise.all([
      git(["diff", "--numstat", "-M", repo.base], repo.cwd, 2_000_000, "head"),
      git(["diff", "--name-status", "-M", repo.base], repo.cwd, 2_000_000, "head"),
      git(["ls-files", "--others", "--exclude-standard"], repo.cwd, 2_000_000, "head"),
      git(["log", "--format=%h%x09%s", "-20", `${repo.base}..HEAD`], repo.cwd),
    ]);
    const counts = new Map<string, { additions: number | null; deletions: number | null }>();
    for (const line of numstat.out.split("\n")) {
      const [added, deleted, ...rest] = line.split("\t");
      const path = rest.at(-1);
      if (path === undefined || path === "") continue;
      // A rename prints `old => new` or `dir/{old => new}/file`; the count belongs to the new path.
      const target = path.replace(/\{[^}]* => ([^}]*)\}/, "$1").replace(/^.* => /, "").replace(/\/\//g, "/");
      counts.set(target, { additions: added === "-" ? null : Number(added), deletions: deleted === "-" ? null : Number(deleted) });
    }
    const kind: Record<string, HerdrChangedFile["status"]> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "added", T: "modified" };
    const files: HerdrChangedFile[] = [];
    for (const line of names.out.split("\n")) {
      const [code, ...paths] = line.split("\t");
      const path = paths.at(-1);
      if (code === undefined || path === undefined || path === "") continue;
      files.push({ path, status: kind[code[0]!] ?? "modified", ...(counts.get(path) ?? { additions: null, deletions: null }) });
    }
    for (const path of untracked.out.split("\n")) if (path !== "") files.push({ path, status: "untracked", additions: null, deletions: null });
    return {
      git: true,
      branch: repo.branch,
      base: repo.base.slice(0, 12),
      commits: log.out.split("\n").filter(Boolean).map((line) => ({ sha: line.slice(0, line.indexOf("\t")), subject: line.slice(line.indexOf("\t") + 1) })),
      files: files.slice(0, MAX_FILES),
      truncated: files.length > MAX_FILES,
    };
  }

  /** One changed file's diff against the same base. Only a path `changes` lists is answered, so a path cannot name anything else on the Mac. */
  async diff(id: string, path: string, session = this.session): Promise<HerdrDiff> {
    const repo = await this.repository(id, session);
    const listed = repo === null ? undefined : (await this.changes(id, session)).files.find((file) => file.path === path);
    if (repo === null || listed === undefined) throw notFound(`${path} is not a changed file of herdr pane ${id}`);
    const result = listed.status === "untracked"
      ? await git(["diff", "--no-index", "--no-color", "--", "/dev/null", path], repo.cwd, DIFF_BYTES + 1, "head")
      : await git(["diff", "--no-color", "-M", repo.base, "--", path], repo.cwd, DIFF_BYTES + 1, "head");
    return { path, diff: result.out.slice(0, DIFF_BYTES), truncated: result.out.length > DIFF_BYTES };
  }

  async setup(): Promise<CodingSetup> {
    const prefs = this.prefs;
    const session = this.session;
    const installed = Object.fromEntries(CODING_AGENTS.map(({ id }) => [id, findProgram(id, this.options.agentDirs)])) as Record<CodingAgentId, string | null>;
    const agents = (integration: Map<string, HerdrIntegration>): CodingSetup["agents"] =>
      CODING_AGENTS.map(({ id, name }) => ({ id, name, path: installed[id], integration: integration.get(id) ?? "missing" }));
    const kinds = HERDR_AGENT_KINDS.filter((kind) => findProgram(kind, this.options.agentDirs) !== null);
    if (this.executable === null) {
      return { herdr: { path: null, version: null }, config: { ok: true, note: null }, session, sessions: [], server: null, agents: agents(new Map()), kinds, prefs };
    }
    const [version, config, listed, status, integrations] = await Promise.all([
      this.run(["--version"]),
      this.run(["config", "check"]),
      this.run(["session", "list", "--json"]),
      this.run(["--session", session, "status"]),
      this.run(["integration", "status"]),
    ]);
    let sessions: CodingSetup["sessions"] = [];
    try {
      const parsed: unknown = JSON.parse(listed.out);
      if (validate(Sessions, parsed)) sessions = parsed.sessions.map(({ name, running }) => ({ name, running }));
    } catch { /* an unreadable list is no sessions */ }
    // `status` prints sections ("server:", "update:") of indented `key: value` lines.
    const sections = new Map<string, Map<string, string>>();
    let current: Map<string, string> | null = null;
    for (const line of status.out.split("\n")) {
      if (line !== "" && !line.startsWith(" ")) sections.set(line.replace(/:$/, ""), (current = new Map()));
      else if (current !== null && line.includes(":")) current.set(line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim());
    }
    const server = sections.get("server");
    const update = sections.get("update");
    const integration = new Map<string, HerdrIntegration>();
    for (const line of integrations.out.split("\n")) {
      const match = /^([a-z0-9-]+)(?: \(experimental\))?: (.+)$/.exec(line.trim());
      if (match) integration.set(match[1]!, match[2]!.startsWith("current") ? "current" : match[2]!.startsWith("not installed") ? "missing" : "outdated");
    }
    return {
      herdr: { path: this.executable, version: version.out.trim().replace(/^herdr\s+/, "") || null },
      config: config.code === 0 ? { ok: true, note: null } : { ok: false, note: (config.out.trim() || config.err.trim()).slice(0, 600) || "herdr rejected config.toml" },
      session,
      sessions,
      server: server?.get("status") === "running"
        ? { version: server.get("version") ?? null, compatible: server.get("endpoint_compatible") === "yes" && server.get("private_protocol_compatible") !== "no", restartNeeded: update?.get("restart_needed") === "yes" || update?.get("server_binary_stale") === "yes" }
        : null,
      agents: agents(integration),
      kinds,
      prefs,
    };
  }

  async installIntegration(agent: CodingAgentId): Promise<void> {
    if (this.executable === null) throw new CommandError("unavailable", "herdr is not installed on this Mac");
    const result = await this.run(["integration", "install", agent], 30_000);
    if (result.code !== 0) throw new CommandError("unavailable", Herdr.reason(result).message);
  }

  /** The agent a start uses: the one asked for, else the owner's, else the first installed. */
  private pickAgent(requested: CodingAgentId | undefined): CodingAgentId {
    const installed = (id: CodingAgentId) => findProgram(id, this.options.agentDirs) !== null;
    const wanted = requested ?? this.prefs.agent;
    if (wanted !== null && wanted !== undefined) {
      if (!installed(wanted)) throw invalid(`${CODING_AGENTS.find((agent) => agent.id === wanted)!.name} is not installed on this Mac`);
      return wanted;
    }
    const first = CODING_AGENTS.find((agent) => installed(agent.id));
    if (first === undefined) throw invalid("No coding agent (omp, Claude Code or Codex) is installed on this Mac");
    return first.id;
  }

  /**
   * Opens a workspace in herdr: a git worktree on a new `ghost/` branch when asked and `cwd` is in a repository (a name
   * that is taken gets `-2`, `-3` …), else a plain workspace. herdr names it unless `label` is given.
   */
  private async openWorkspace(input: { cwd: string; label?: string | undefined; worktree: boolean; branch?: string | undefined; seed: string }, session: string, authorize?: () => void): Promise<{ pane: string; checkout: string; branch: string | null; base: string | null }> {
    if (!isAbsolute(input.cwd) || !existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw invalid(`${input.cwd} is not an absolute path of an existing directory`);
    const cwd = realpathSync(input.cwd);
    const label = input.label === undefined ? [] : ["--label", input.label];
    const top = input.worktree ? await git(["rev-parse", "--show-toplevel"], cwd) : null;
    if (top !== null && top.code === 0) {
      const base = (await git(["rev-parse", "HEAD"], top.out)).out;
      const wanted = slugOf(input.branch ?? input.seed);
      for (let attempt = 1; ; attempt++) {
        const branch = `ghost/${wanted}${attempt === 1 ? "" : `-${attempt}`}`;
        try {
          authorize?.();
          const created = await this.call(["worktree", "create", "--cwd", top.out, "--branch", branch, ...label, "--no-focus"], START_MS, undefined, session);
          if (!validate(Created, created) || created.result.workspace?.worktree === undefined) throw new CommandError("unavailable", "herdr made a workspace this Host cannot read");
          if (created.result.root_pane.terminal_id) this.state.claim(session, created.result.root_pane.terminal_id);
          return { pane: created.result.root_pane.pane_id, checkout: created.result.workspace.worktree.checkout_path, branch, base };
        } catch (error) {
          // A branch or folder that exists already is a name taken; any other refusal is the answer.
          if (attempt < 10 && error instanceof CommandError && /already exists/.test(error.message)) continue;
          throw error;
        }
      }
    }
    authorize?.();
    const created = await this.call(["workspace", "create", "--cwd", cwd, ...label, "--no-focus"], START_MS, undefined, session);
    if (!validate(Created, created)) throw new CommandError("unavailable", "herdr made a workspace this Host cannot read");
    if (created.result.root_pane.terminal_id) this.state.claim(session, created.result.root_pane.terminal_id);
    return { pane: created.result.root_pane.pane_id, checkout: cwd, branch: null, base: null };
  }

  /** Starts an agent of `kind` in a pane that is a shell at its prompt. The name only has to be unique among live agents; the pane id is what the Host addresses it by. */
  private async launch(pane: string, kind: HerdrAgentKind, seed: string, session: string, args: readonly string[] = []): Promise<void> {
    const name = `ghost-${slugOf(seed).slice(0, 18).replace(/-+$/, "") || "agent"}-${crypto.randomUUID().slice(0, 4)}`;
    // The agent's own arguments go after `--`, as herdr asks.
    let started: unknown;
    try {
      started = await this.call(["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", String(START_MS), ...(args.length > 0 ? ["--", ...args] : [])], START_MS + 5_000, undefined, session);
    } catch (error) {
      // Herdr still gives a blocked startup its unique agent name. Only claim an identity it confirms.
      if (error instanceof CommandError && error.message.startsWith(`agent ${name} is blocked during startup`)) {
        const blocked = await this.call(["agent", "get", name], PROBE_MS, undefined, session).catch(() => null);
        if (validate(Started, blocked) && blocked.result.agent.pane_id === pane) this.state.claim(session, blocked.result.agent.terminal_id);
      }
      throw error;
    }
    if (validate(Started, started) && started.result.agent.pane_id === pane) this.state.claim(session, started.result.agent.terminal_id);
  }

  /** Whatever a creation did after herdr had already opened the pane: the pane is there, whatever the agent did next. */
  private async afterOpen<T>(pane: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw new HerdrStartError(error instanceof Error ? error.message : "the agent did not start", pane);
    }
  }

  async start(input: CodingStart, wait?: HerdrWait, prepared?: (opened: HerdrRun) => void, guard?: { session: string; authorize: (stage?: "open" | "launch" | "prompt", pane?: HerdrPaneView) => void }): Promise<HerdrRun> {
    const session = guard?.session ?? this.session;
    const agent = this.pickAgent(input.agent);
    const first = input.task.trim().split("\n")[0]!;
    guard?.authorize();
    const opened = await this.openWorkspace({ cwd: input.repo, worktree: input.worktree !== false, branch: input.branch, seed: first }, session, () => guard?.authorize("open"));
    const settled = await this.afterOpen(opened.pane, async () => {
      const opening = prepared || guard ? await this.pane(opened.pane, session) : null;
      if (prepared && opening) prepared({ pane: { ...opening, agent }, checkout: opened.checkout, branch: opened.branch, base: opened.base, settled: "unwaited" });
      guard?.authorize("launch");
      await this.launch(opened.pane, agent, input.branch ?? first, session);
      if (guard) {
        const current = await this.agentPane(opened.pane, session);
        if (!opening?.terminalId || current.terminalId !== opening.terminalId || current.agent !== agent || !["idle", "done"].includes(current.status)) throw conflict("the newly started coding terminal was replaced or is not ready for a prompt");
        guard.authorize("prompt", current);
      }
      return this.submit(opened.pane, promptFor(input.task, opened.branch), wait, session);
    });
    return { pane: await this.pane(opened.pane, session), checkout: opened.checkout, branch: opened.branch, base: opened.base, settled };
  }

  /** An agent and its first instruction in a pane that was just opened, when the owner asked for them. */
  private async populate(pane: string, input: { agent?: HerdrAgentKind | undefined; args?: string[] | undefined; task?: string | undefined }, branch: string | null, seed: string, session: string): Promise<void> {
    if (input.agent === undefined) {
      if (input.task !== undefined || input.args !== undefined) throw invalid("a first instruction or agent arguments need an agent to give them to");
      return;
    }
    const agent = input.agent;
    await this.afterOpen(pane, async () => {
      await this.launch(pane, agent, seed, session, input.args);
      if (input.task !== undefined) await this.submit(pane, branch === null ? input.task : promptFor(input.task, branch), undefined, session);
    });
  }

  async createWorkspace(input: HerdrWorkspaceCreate): Promise<HerdrPaneView> {
    const session = this.session;
    const seed = input.label ?? input.task?.trim().split("\n")[0] ?? basename(input.cwd);
    const opened = await this.openWorkspace({ cwd: input.cwd, label: input.label, worktree: input.worktree === true, branch: input.branch, seed }, session);
    await this.populate(opened.pane, input, opened.branch, seed, session);
    return this.pane(opened.pane, session);
  }

  async createTab(input: HerdrTabCreate): Promise<HerdrPaneView> {
    const session = this.session;
    if (!WORKSPACE.test(input.workspace)) throw invalid("not a herdr workspace id");
    if (input.cwd !== undefined && (!isAbsolute(input.cwd) || !existsSync(input.cwd) || !statSync(input.cwd).isDirectory())) throw invalid(`${input.cwd} is not an absolute path of an existing directory`);
    const created = await this.call(["tab", "create", "--workspace", input.workspace, ...(input.cwd === undefined ? [] : ["--cwd", realpathSync(input.cwd)]), ...(input.label === undefined ? [] : ["--label", input.label]), "--no-focus"], START_MS, undefined, session);
    if (!validate(Created, created)) throw new CommandError("unavailable", "herdr made a tab this Host cannot read");
    const { terminal_id, pane_id } = created.result.root_pane;
    if (terminal_id) this.state.claim(session, terminal_id);
    await this.populate(pane_id, input, null, input.label ?? "tab", session);
    return this.pane(pane_id, session);
  }

  async split(input: HerdrSplit): Promise<HerdrPaneView> {
    const session = this.session;
    await this.pane(input.pane, session);
    const made = await this.call(["pane", "split", input.pane, "--direction", input.direction, "--no-focus"], START_MS, undefined, session);
    if (!validate(Split, made)) throw new CommandError("unavailable", "herdr made a pane this Host cannot read");
    const { terminal_id, pane_id } = made.result.pane;
    if (terminal_id) this.state.claim(session, terminal_id);
    await this.populate(pane_id, input, null, "pane", session);
    return this.pane(pane_id, session);
  }

  async startAgent(input: HerdrAgentStart): Promise<HerdrPaneView> {
    const session = this.session;
    const pane = await this.pane(input.pane, session);
    if (pane.agent !== null) throw invalid(`herdr pane ${input.pane} already runs ${pane.agent}`);
    await this.populate(input.pane, input, null, pane.title, session);
    return this.pane(input.pane, session);
  }

  async rename(input: HerdrRename): Promise<void> {
    const valid = input.target === "workspace" ? WORKSPACE.test(input.id) : input.target === "tab" ? PANE.test(input.id) : PANE.test(input.id);
    if (!valid) throw invalid(`not a herdr ${input.target} id`);
    if (input.label.startsWith("-")) throw invalid("a label cannot start with a dash");
    await this.call([input.target, "rename", input.id, input.label]);
  }

  async close(input: HerdrClose): Promise<void> {
    if (!(input.target === "workspace" ? WORKSPACE : PANE).test(input.id)) throw invalid(`not a herdr ${input.target} id`);
    await this.call([input.target, "close", input.id]);
  }

  /** Submits a prompt; with `wait`, until the agent settles, which it may not do in time. */
  private async submit(pane: string, text: string, wait?: HerdrWait, session = this.session): Promise<"settled" | "timeout" | "stalled" | "unwaited"> {
    // herdr reads a word that starts like a flag as one, even after the pane.
    const safe = text.startsWith("-") ? ` ${text}` : text;
    if (wait === undefined) {
      await this.call(["agent", "prompt", pane, safe], PROBE_MS, undefined, session);
      return "unwaited";
    }
    try {
      await this.call(["agent", "prompt", pane, safe, "--wait", "--timeout", String(wait.timeoutMs)], wait.timeoutMs + 15_000, wait.signal, session);
      return "settled";
    } catch (error) {
      if (error instanceof CommandError && /\b(timeout|agent_prompt_stalled)\b|timed out|stalled/i.test(error.message)) return /stalled/i.test(error.message) ? "stalled" : "timeout";
      throw error;
    }
  }

  async prompt(id: string, text: string, wait?: HerdrWait, guard?: { session: string; terminalId: string; agent: string; authorize: (pane?: HerdrPaneView) => void }, delivery?: HerdrDelivery): Promise<HerdrRun> {
    const session = guard?.session ?? this.session;
    const pane = await this.agentPane(id, session);
    if (guard) {
      if (pane.terminalId !== guard.terminalId || pane.agent !== guard.agent) throw conflict("the coding terminal or agent was replaced; no prompt was sent");
      if (!["idle", "done"].includes(pane.status)) throw conflict("the coding agent is not ready for another prompt");
      guard.authorize(pane);
    }
    // Take a fresh status before sending raw bytes. `agent prompt` itself refuses blocked agents.
    const queueTarget = delivery === "queue" && pane.agent === "omp" && pane.status === "working"
      ? await this.agentPane(id, session) : null;
    let settled: HerdrRun["settled"] = "unwaited";
    if (queueTarget?.agent === "omp" && queueTarget.status === "working" && queueTarget.terminalId === pane.terminalId) {
      // Ctrl+Q is omp's default follow-up chord (packages/tui/src/app-keybindings.ts). Send
      // the entire paste and chord in one write; Ctrl+Q also approves in a blocked composer.
      const paste = `\x1b[200~${text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")}\x1b[201~\x11`;
      await this.sendInput({ pane: id, text: paste }, session);
    } else {
      settled = await this.submit(id, text, wait, session);
    }
    const after = await this.agentPane(id, session);
    // Only a caller that waits for the work reports on it, and it needs the branch the agent is on.
    const cwd = after.cwd ?? pane.cwd;
    const branch = wait !== undefined && cwd !== null && existsSync(cwd) && (await git(["rev-parse", "--show-toplevel"], cwd)).code === 0 ? (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).out : null;
    return { pane: after, checkout: cwd ?? "", branch, base: null, settled };
  }

  async interrupt(session: string, id: string, terminalId: string, guard?: { agent: string; authorize: (pane?: HerdrPaneView) => void }): Promise<void> {
    if (!SESSION.test(session) || !HERDR_TERMINAL.test(terminalId)) throw invalid("not a herdr terminal identity");
    const pane = await this.pane(id, session);
    if (pane.terminalId !== terminalId) throw conflict("the coding terminal was replaced; no input was sent");
    guard?.authorize(pane);
    if (guard && pane.agent !== guard.agent) throw conflict("the coding agent was replaced; no interrupt was sent");
    if (pane.agent === null || !["working", "blocked"].includes(pane.status)) return;
    // One ordered interrupt, never a close or an automatic prompt retry. The reconciler observes whether it stopped.
    await this.call(["agent", "send-keys", id, "Ctrl+c"], PROBE_MS, undefined, session);
  }

  /** The keyboard of a pane's web terminal: the text exactly as typed, then named keys. */
  async input(input: HerdrInput): Promise<void> {
    if (!PANE.test(input.pane)) throw invalid("not a herdr pane id");
    if (input.text === undefined && input.keys === undefined) throw invalid("nothing to send");
    await this.sendInput(input, this.session);
  }

  private async sendInput(input: HerdrInput, session: string): Promise<void> {
    // A NUL cannot travel in an argument, and no key a terminal sends needs one.
    if (input.text !== undefined) await this.call(["pane", "send-text", input.pane, input.text.replaceAll("\0", "")], PROBE_MS, undefined, session);
    if (input.keys !== undefined) await this.call(["pane", "send-keys", input.pane, ...input.keys], PROBE_MS, undefined, session);
  }

  private observers = 0;

  /**
   * A pane's live terminal as herdr renders it for a viewer of `cols` x `rows` (`terminal session observe`): the pane
   * and the owner's herdr are not resized, unlike a direct attach. Ends when the pane closes or `signal` aborts.
   */
  async terminal(id: string, cols: number, rows: number, signal: AbortSignal): Promise<AsyncGenerator<HerdrFrame>> {
    await this.pane(id);
    if (this.executable === null) throw new CommandError("unavailable", "herdr is not installed on this Mac");
    if (this.observers >= MAX_OBSERVERS) throw conflict("too many terminals are open; close one first");
    const size = [String(Math.min(Math.max(Math.round(cols), 20), 300)), String(Math.min(Math.max(Math.round(rows), 5), 120))];
    const executable = this.executable;
    const session = this.session;
    this.observers++;
    const self = this;
    return (async function* () {
      const child = Bun.spawn([executable, "--session", session, "terminal", "session", "observe", id, "--cols", size[0]!, "--rows", size[1]!], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: Herdr.env() });
      const stop = () => child.kill();
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      const stderr = new Response(child.stderr).text();
      const decoder = new TextDecoder();
      let pending = "";
      let frames = 0;
      let closed = false;
      try {
        for await (const chunk of child.stdout) {
          pending += decoder.decode(chunk, { stream: true });
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            let parsed: unknown;
            try { parsed = JSON.parse(line); } catch { continue; }
            if (validate(Frame, parsed)) {
              frames++;
              yield { seq: parsed.seq, full: parsed.full, width: parsed.width, height: parsed.height, bytes: parsed.bytes };
            } else if (validate(Closed, parsed)) {
              closed = true;
            }
          }
        }
        const code = await child.exited;
        if (signal.aborted || closed) return;
        // herdr says `terminal.closed` when the pane is gone; anything else that ends the stream (the server restarting, a crash) is not the pane's end.
        if (code !== 0 && frames === 0) {
          const why = Herdr.reason({ out: "", err: await stderr });
          throw failure(why.code, why.message);
        }
        throw new CommandError("unavailable", "the terminal stream stopped");
      } finally {
        signal.removeEventListener("abort", stop);
        child.kill();
        self.observers--;
      }
    })();
  }
}
