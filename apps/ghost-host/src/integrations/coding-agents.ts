import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CodingAgentId, CodingPrefs } from "@ghost/contract";
import type { CodingAgentInfo, CodingAgentPort } from "./ports.ts";

type Readiness = Pick<CodingAgentInfo, "ready" | "note">;

/**
 * How to run each supported coding agent headless (the prompt is one argv word, never a shell string) and, where
 * the agent can say, whether its login still works. `status` gets the argv to probe with, so an agent that cannot
 * say stays ready.
 */
const ADAPTERS: Record<CodingAgentId, {
  name: string;
  argv(path: string, prompt: string, cwd: string): string[];
  status?: { args: string[]; read(code: number, out: string): Readiness };
}> = {
  omp: { name: "omp", argv: (path, prompt, cwd) => [path, "-p", "--no-session", "--cwd", cwd, "--thinking", "medium", prompt] },
  claude: {
    name: "Claude Code",
    argv: (path, prompt) => [path, "-p", "--permission-mode", "bypassPermissions", prompt],
    status: {
      args: ["auth", "status"],
      read(_code, out) {
        let status: unknown;
        try { status = JSON.parse(out); } catch { return { ready: true, note: null }; }
        if (typeof status !== "object" || status === null) return { ready: true, note: null };
        if ("loggedIn" in status && status.loggedIn === false) return { ready: false, note: "로그인이 필요합니다(claude auth login)." };
        const expires = "loginExpiresAt" in status && typeof status.loginExpiresAt === "string" ? Date.parse(status.loginExpiresAt) : NaN;
        if (Number.isNaN(expires)) return { ready: true, note: null };
        const day = new Date(expires).toLocaleDateString("ko-KR", { year: "numeric", month: "numeric", day: "numeric" });
        return expires <= Date.now() ? { ready: false, note: `로그인이 ${day}에 만료됐습니다(claude auth login).` } : { ready: true, note: `로그인이 ${day}까지 유효합니다.` };
      },
    },
  },
  codex: {
    name: "Codex",
    argv: (path, prompt, cwd) => [path, "exec", "--cd", cwd, "--sandbox", "workspace-write", prompt],
    status: { args: ["login", "status"], read: (code) => (code === 0 ? { ready: true, note: null } : { ready: false, note: "로그인이 필요합니다(codex login)." }) },
  },
};

/** First match wins when nobody names an agent. */
export const CODING_AGENT_ORDER: readonly CodingAgentId[] = ["omp", "claude", "codex"];

const CACHE_MS = 60_000;

const isExecutable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Runs `path args` for at most five seconds. An agent can be a script whose interpreter sits beside it
 * (`#!/usr/bin/env node`), so the probe's PATH starts with its own directory.
 */
async function probe(path: string, args: string[], searchDirs: string[]): Promise<{ code: number; out: string } | null> {
  const env = { ...process.env, PATH: [dirname(path), ...searchDirs, "/usr/bin", "/bin"].join(":") };
  const child = Bun.spawn([path, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env });
  const timer = setTimeout(() => child.kill(), 5_000);
  try {
    const out = await new Response(child.stdout).text();
    return { code: await child.exited, out };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The coding agents installed on this Mac, found where their installers put them and by PATH. Detection runs each
 * candidate's `--version` and, where the agent has one, its login status; results are cached for a minute unless the
 * caller asks for a fresh look. Nothing is configured, installed or started beyond that.
 */
export class CodingAgents implements CodingAgentPort {
  private cached: { at: number; agents: CodingAgentInfo[] } | null = null;
  private readonly dirs: string[];

  constructor(options: { dirs?: string[] } = {}) {
    const home = homedir();
    const path = (process.env.PATH ?? "").split(":").filter(Boolean);
    this.dirs = options.dirs ?? [...new Set([join(home, ".bun/bin"), join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", ...path])];
  }

  async detect(refresh = false): Promise<CodingAgentInfo[]> {
    if (!refresh && this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.agents;
    const found = await Promise.all(CODING_AGENT_ORDER.map(async (id): Promise<CodingAgentInfo | null> => {
      const adapter = ADAPTERS[id];
      for (const dir of this.dirs) {
        const path = join(dir, id);
        if (!isExecutable(path)) continue;
        const version = await probe(path, ["--version"], this.dirs);
        if (version?.code !== 0) continue;
        const state = adapter.status ? await probe(path, adapter.status.args, this.dirs) : null;
        const readiness = adapter.status && state ? adapter.status.read(state.code, state.out) : { ready: true, note: null };
        return { id, name: adapter.name, path, version: version.out.split("\n").find((line) => line.trim())?.trim().slice(0, 80) || null, ...readiness };
      }
      return null;
    }));
    const agents = found.filter((agent): agent is CodingAgentInfo => agent !== null);
    this.cached = { at: Date.now(), agents };
    return agents;
  }

  command(agent: CodingAgentInfo, prompt: string, cwd: string): string[] {
    return ADAPTERS[agent.id].argv(agent.path, prompt, cwd);
  }
}

/**
 * The agent a run uses: the one asked for if it is installed, on and ready, otherwise the owner's default, otherwise
 * the first ready one in preference order. A reason, never a silent fallback, when a named agent cannot be used.
 */
export function pickCodingAgent(agents: readonly CodingAgentInfo[], prefs: CodingPrefs, requested?: CodingAgentId): { agent: CodingAgentInfo } | { problem: string } {
  if (requested) {
    const named = agents.find((agent) => agent.id === requested);
    if (!named) return { problem: `${requested} is not installed on this Mac; code_agents lists what is` };
    if (prefs.disabled.includes(named.id)) return { problem: `${named.name} is turned off by the owner in Settings` };
    if (!named.ready) return { problem: `${named.name} is not ready: ${named.note ?? "unknown reason"}` };
    return { agent: named };
  }
  const usable = agents.filter((agent) => agent.ready && !prefs.disabled.includes(agent.id));
  const chosen = usable.find((agent) => agent.id === prefs.default) ?? usable[0];
  if (chosen) return { agent: chosen };
  if (agents.length === 0) return { problem: "No coding agent is installed on this Mac" };
  return { problem: `No coding agent can run now: ${agents.map((agent) => `${agent.name} ${prefs.disabled.includes(agent.id) ? "is turned off in Settings" : `is not ready (${agent.note ?? "unknown reason"})`}`).join("; ")}` };
}
