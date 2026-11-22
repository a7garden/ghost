import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { validate, type HerdrOutput, type HerdrPaneView, type HerdrView } from "@ghost/contract";
import { CommandError, invalid } from "../core/errors.ts";
import type { HerdrPort } from "./ports.ts";

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
const Failure = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.Optional(Type.String()) }) });

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PANE = /^[A-Za-z0-9]{1,16}:[A-Za-z0-9]{1,16}$/;
const STATUSES: readonly HerdrPaneView["status"][] = ["idle", "working", "blocked", "done", "unknown"];

const PROBE_MS = 5_000;
const MAX_SESSIONS = 8;
const MAX_PANES = 100;
export const OUTPUT_LINES = 300;
const OUTPUT_BYTES = 64 * 1024;
const ENV_KEPT = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"];

const isExecutable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The herdr executable: where its installer puts it, then PATH. */
export function findHerdr(dirs?: string[]): string | null {
  const home = homedir();
  const path = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs ?? [...new Set([join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", ...path])]) {
    const candidate = join(dir, "herdr");
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

/**
 * The coding agents running in the owner's herdr sessions, read through the `herdr` CLI. Herdr is only looked at:
 * the Host lists panes and reads their terminal text and never sends input, starts, moves or closes anything.
 * The environment is rebuilt without herdr's own `HERDR_*` variables, so a Host started from a herdr pane still
 * reads the sessions it names rather than the pane it happened to start in.
 */
export class Herdr implements HerdrPort {
  constructor(private readonly executable: string | null = findHerdr()) {}

  private async run(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
    for (const name of ENV_KEPT) if (process.env[name] !== undefined) env[name] = process.env[name]!;
    const child = Bun.spawn([this.executable!, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
    const timer = setTimeout(() => child.kill(), PROBE_MS);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, out, err };
    } finally {
      clearTimeout(timer);
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
    return { code: null, message: (result.err.trim() || result.out.trim() || "herdr did not answer").slice(0, 300) };
  }

  private async panes(session: string): Promise<HerdrPaneView[]> {
    const result = await this.run(["--session", session, "api", "snapshot"]);
    if (result.code !== 0) throw new CommandError("unavailable", Herdr.reason(result).message);
    let parsed: unknown;
    try { parsed = JSON.parse(result.out); } catch { throw new CommandError("unavailable", "herdr gave an unreadable snapshot"); }
    if (!validate(Snapshot, parsed)) throw new CommandError("unavailable", "herdr gave a snapshot in a shape this Host does not know");
    const { workspaces, tabs, panes } = parsed.result.snapshot;
    const workspace = new Map(workspaces.map((entry) => [entry.workspace_id, entry.label ?? ""]));
    const tab = new Map(tabs.map((entry) => [entry.tab_id, entry.label ?? ""]));
    return panes.flatMap((pane): HerdrPaneView[] => {
      if (pane.agent === undefined || pane.agent === null) return [];
      const status = STATUSES.find((known) => known === pane.agent_status) ?? "unknown";
      const tabLabel = tab.get(pane.tab_id) ?? "";
      return [{
        session,
        id: pane.pane_id,
        workspace: workspace.get(pane.workspace_id) ?? "",
        tab: tabLabel,
        agent: pane.agent,
        status,
        cwd: pane.foreground_cwd ?? pane.cwd ?? null,
        title: tabLabel || pane.terminal_title_stripped || pane.pane_id,
      }];
    });
  }

  async overview(): Promise<HerdrView> {
    if (this.executable === null) return { available: false, note: null, panes: [] };
    const listed = await this.run(["session", "list", "--json"]);
    let names: string[];
    try {
      const parsed: unknown = JSON.parse(listed.out);
      if (listed.code !== 0 || !validate(Sessions, parsed)) throw new Error();
      names = parsed.sessions.filter((entry) => entry.running && SESSION.test(entry.name)).map((entry) => entry.name).slice(0, MAX_SESSIONS);
    } catch {
      return { available: true, note: Herdr.reason(listed).message, panes: [] };
    }
    const looked = await Promise.allSettled(names.map((name) => this.panes(name)));
    const panes = looked.flatMap((entry) => (entry.status === "fulfilled" ? entry.value : [])).slice(0, MAX_PANES);
    const failed = looked.flatMap((entry, index) => (entry.status === "rejected" ? [`${names[index]}: ${entry.reason instanceof Error ? entry.reason.message : "failed"}`] : []));
    return { available: true, note: failed.length > 0 ? failed.join("; ") : null, panes };
  }

  async output(session: string, pane: string): Promise<HerdrOutput | null> {
    if (!SESSION.test(session) || !PANE.test(pane)) throw invalid("not a herdr session or pane id");
    if (this.executable === null) throw new CommandError("unavailable", "herdr is not installed on this Mac");
    const [panes, read] = await Promise.all([
      this.panes(session),
      this.run(["--session", session, "pane", "read", pane, "--source", "recent-unwrapped", "--lines", String(OUTPUT_LINES)]),
    ]);
    const view = panes.find((entry) => entry.id === pane);
    if (view === undefined) return null;
    if (read.code !== 0) {
      const why = Herdr.reason(read);
      if (why.code === "pane_not_found") return null;
      throw new CommandError("unavailable", why.message);
    }
    return { pane: view, text: terminalText(read.out) };
  }
}
