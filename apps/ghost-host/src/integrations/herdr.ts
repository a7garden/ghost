import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { validate, type CodingAgentId, type CodingPrefs, type CodingSetup, type CodingStart, type HerdrIntegration, type HerdrKeys, type HerdrOutput, type HerdrPaneView, type HerdrView } from "@ghost/contract";
import { CommandError, conflict, invalid, notFound } from "../core/errors.ts";
import type { HerdrPort, HerdrRun, HerdrWait } from "./ports.ts";

/** Only the fields the Host reads of herdr's `api snapshot`; everything else in it is ignored. */
const Snapshot = Type.Object({
  result: Type.Object({
    snapshot: Type.Object({
      workspaces: Type.Array(Type.Object({ workspace_id: Type.String(), label: Type.Optional(Type.String()) })),
      tabs: Type.Array(Type.Object({ tab_id: Type.String(), label: Type.Optional(Type.String()) })),
      panes: Type.Array(Type.Object({
        pane_id: Type.String(),
        workspace_id: Type.String(),
        tab_id: Type.String(),
        /** Absent, not null, on a pane with no agent. */
        agent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        agent_status: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        foreground_cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        terminal_title_stripped: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      })),
    }),
  }),
});
const Sessions = Type.Object({ sessions: Type.Array(Type.Object({ name: Type.String(), running: Type.Boolean() })) });
/** What `workspace create` and `worktree create` answer with: the first pane of the new workspace, and the checkout when it is a worktree. */
const Created = Type.Object({
  result: Type.Object({
    root_pane: Type.Object({ pane_id: Type.String() }),
    workspace: Type.Object({ worktree: Type.Optional(Type.Object({ checkout_path: Type.String() })) }),
  }),
});
const Failure = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.Optional(Type.String()) }) });

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PANE = /^[A-Za-z0-9]{1,16}:[A-Za-z0-9]{1,16}$/;
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
const MAX_PANES = 150;
export const OUTPUT_LINES = 300;
const OUTPUT_BYTES = 64 * 1024;
const ENV_KEPT = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"];
const NO_PREFS: CodingPrefs = { session: null, agent: null };

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
export function terminalText(raw: string): string {
  const lines = raw.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const text = lines.slice(-OUTPUT_LINES).join("\n");
  return text.length > OUTPUT_BYTES ? text.slice(-OUTPUT_BYTES) : text;
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

async function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([GIT, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out: (out.trim() || err.trim()).slice(-20_000) };
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
  return report;
}

/** Herdr's error codes as the Host's: a thing that is not there, a thing that must be answered first, or herdr itself being unable. */
function failure(code: string | null, message: string): CommandError {
  if (code === "pane_not_found" || code === "agent_not_found") return notFound(message);
  if (code === "agent_blocked") return conflict(message);
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

  /** `executable` undefined: find herdr where its installer puts it, again on every use until it is found, so installing it while the Host runs is noticed. Null or a path is taken as given. */
  constructor(
    private readonly given?: string | null,
    private readonly options: { prefs?: () => CodingPrefs; agentDirs?: string[] } = {},
  ) {}

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

  private async run(args: string[], limitMs = PROBE_MS, signal?: AbortSignal): Promise<{ code: number; out: string; err: string }> {
    const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
    for (const name of ENV_KEPT) if (process.env[name] !== undefined) env[name] = process.env[name]!;
    const child = Bun.spawn([this.executable!, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
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

  /** Runs a session command and returns its JSON, or throws herdr's reason. */
  private async call(args: string[], limitMs = PROBE_MS, signal?: AbortSignal): Promise<unknown> {
    if (this.executable === null) throw new CommandError("unavailable", "herdr is not installed on this Mac");
    const result = await this.run(["--session", this.session, ...args], limitMs, signal);
    const why = Herdr.reason(result);
    if (result.code !== 0 || why.code !== null) throw failure(why.code, why.message);
    try { return JSON.parse(result.out); } catch { throw new CommandError("unavailable", "herdr gave an unreadable answer"); }
  }

  private async panes(): Promise<HerdrPaneView[]> {
    const parsed = await this.call(["api", "snapshot"]);
    if (!validate(Snapshot, parsed)) throw new CommandError("unavailable", "herdr gave a snapshot in a shape this Host does not know");
    const { workspaces, tabs, panes } = parsed.result.snapshot;
    const workspace = new Map(workspaces.map((entry) => [entry.workspace_id, entry.label ?? ""]));
    const tab = new Map(tabs.map((entry) => [entry.tab_id, entry.label ?? ""]));
    return panes.flatMap((pane): HerdrPaneView[] => {
      if (pane.agent === undefined || pane.agent === null) return [];
      const tabLabel = tab.get(pane.tab_id) ?? "";
      return [{
        id: pane.pane_id,
        workspace: workspace.get(pane.workspace_id) ?? "",
        tab: tabLabel,
        agent: pane.agent,
        status: STATUSES.find((known) => known === pane.agent_status) ?? "unknown",
        cwd: pane.foreground_cwd ?? pane.cwd ?? null,
        title: tabLabel || pane.terminal_title_stripped || pane.pane_id,
      }];
    }).slice(0, MAX_PANES);
  }

  /** One agent pane of the session in use; a pane that is not an agent pane is not there as far as the app is concerned. */
  private async agentPane(id: string): Promise<HerdrPaneView> {
    if (!PANE.test(id)) throw invalid("not a herdr pane id");
    const view = (await this.panes()).find((entry) => entry.id === id);
    if (view === undefined) throw notFound(`herdr pane ${id}`);
    return view;
  }

  async overview(): Promise<HerdrView> {
    const session = this.session;
    if (this.executable === null) return { available: false, session, note: null, panes: [] };
    try {
      return { available: true, session, note: null, panes: await this.panes() };
    } catch (error) {
      if (error instanceof CommandError && error.code === "unavailable") return { available: true, session, note: error.message, panes: [] };
      throw error;
    }
  }

  async output(id: string): Promise<HerdrOutput> {
    const pane = await this.agentPane(id);
    if (this.executable === null) throw new CommandError("unavailable", "herdr is not installed on this Mac");
    const read = await this.run(["--session", this.session, "pane", "read", id, "--source", "recent-unwrapped", "--lines", String(OUTPUT_LINES)]);
    if (read.code !== 0) {
      const why = Herdr.reason(read);
      throw failure(why.code, why.message);
    }
    return { pane, text: terminalText(read.out) };
  }

  async setup(): Promise<CodingSetup> {
    const prefs = this.prefs;
    const session = this.session;
    const installed = Object.fromEntries(CODING_AGENTS.map(({ id }) => [id, findProgram(id, this.options.agentDirs)])) as Record<CodingAgentId, string | null>;
    const agents = (integration: Map<string, HerdrIntegration>): CodingSetup["agents"] =>
      CODING_AGENTS.map(({ id, name }) => ({ id, name, path: installed[id], integration: integration.get(id) ?? "missing" }));
    if (this.executable === null) {
      return { herdr: { path: null, version: null }, config: { ok: true, note: null }, session, sessions: [], server: null, agents: agents(new Map()), prefs };
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

  async start(input: CodingStart, wait?: HerdrWait): Promise<HerdrRun> {
    if (!isAbsolute(input.repo) || !existsSync(input.repo) || !statSync(input.repo).isDirectory()) throw invalid(`${input.repo} is not an absolute path of an existing directory`);
    const repo = realpathSync(input.repo);
    const agent = this.pickAgent(input.agent);
    const top = input.worktree === false ? null : await git(["rev-parse", "--show-toplevel"], repo);
    const inRepository = top !== null && top.code === 0;
    const first = input.task.trim().split("\n")[0]!;
    let pane: string;
    let checkout = repo;
    let branch: string | null = null;
    let base: string | null = null;
    if (inRepository) {
      base = (await git(["rev-parse", "HEAD"], top.out)).out;
      const wanted = slugOf(input.branch ?? first);
      for (let attempt = 1; ; attempt++) {
        branch = `ghost/${wanted}${attempt === 1 ? "" : `-${attempt}`}`;
        try {
          const created = await this.call(["worktree", "create", "--cwd", top.out, "--branch", branch, "--no-focus"], START_MS);
          if (!validate(Created, created) || created.result.workspace.worktree === undefined) throw new CommandError("unavailable", "herdr made a workspace this Host cannot read");
          pane = created.result.root_pane.pane_id;
          checkout = created.result.workspace.worktree.checkout_path;
          break;
        } catch (error) {
          // A branch or folder that exists already is a name taken; any other refusal is the answer.
          if (attempt < 10 && error instanceof CommandError && /already exists/.test(error.message)) continue;
          throw error;
        }
      }
    } else {
      const created = await this.call(["workspace", "create", "--cwd", repo, "--no-focus"], START_MS);
      if (!validate(Created, created)) throw new CommandError("unavailable", "herdr made a workspace this Host cannot read");
      pane = created.result.root_pane.pane_id;
    }
    // The name only has to be unique among live agents; the pane id is what the Host addresses it by.
    const name = `ghost-${slugOf(input.branch ?? first).slice(0, 18).replace(/-+$/, "")}-${crypto.randomUUID().slice(0, 4)}`;
    let settled: HerdrRun["settled"];
    try {
      await this.call(["agent", "start", name, "--kind", agent, "--pane", pane, "--timeout", String(START_MS)], START_MS + 5_000);
      settled = await this.submit(pane, promptFor(input.task, branch), wait);
    } catch (error) {
      throw new HerdrStartError(error instanceof Error ? error.message : "the agent did not start", pane);
    }
    return { pane: await this.agentPane(pane), checkout, branch, base, settled };
  }

  /** Submits a prompt; with `wait`, until the agent settles, which it may not do in time. */
  private async submit(pane: string, text: string, wait?: HerdrWait): Promise<"settled" | "timeout" | "stalled" | "unwaited"> {
    if (wait === undefined) {
      await this.call(["agent", "prompt", pane, text]);
      return "unwaited";
    }
    try {
      await this.call(["agent", "prompt", pane, text, "--wait", "--timeout", String(wait.timeoutMs)], wait.timeoutMs + 15_000, wait.signal);
      return "settled";
    } catch (error) {
      if (error instanceof CommandError && /\b(timeout|agent_prompt_stalled)\b|timed out|stalled/i.test(error.message)) return /stalled/i.test(error.message) ? "stalled" : "timeout";
      throw error;
    }
  }

  async prompt(id: string, text: string, wait?: HerdrWait): Promise<HerdrRun> {
    const pane = await this.agentPane(id);
    const settled = await this.submit(id, text, wait);
    const after = await this.agentPane(id);
    // Only a caller that waits for the work reports on it, and it needs the branch the agent is on.
    const cwd = after.cwd ?? pane.cwd;
    const branch = wait !== undefined && cwd !== null && existsSync(cwd) && (await git(["rev-parse", "--show-toplevel"], cwd)).code === 0 ? (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).out : null;
    return { pane: after, checkout: cwd ?? "", branch, base: null, settled };
  }

  async keys(input: HerdrKeys): Promise<HerdrPaneView> {
    await this.agentPane(input.pane);
    await this.call(["agent", "send-keys", input.pane, ...input.keys]);
    return this.agentPane(input.pane);
  }
}
