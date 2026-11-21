import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodingAgentId, CodingAgentInfo, CodingAgentPort } from "./ports.ts";

/** Non-interactive invocation of each supported coding agent; the prompt is one argv word, never a shell string. */
const ADAPTERS: Record<CodingAgentId, { name: string; argv(path: string, prompt: string, cwd: string): string[] }> = {
  omp: { name: "omp", argv: (path, prompt, cwd) => [path, "-p", "--no-session", "--cwd", cwd, "--thinking", "medium", prompt] },
  claude: { name: "Claude Code", argv: (path, prompt) => [path, "-p", "--permission-mode", "bypassPermissions", prompt] },
  codex: { name: "Codex", argv: (path, prompt, cwd) => [path, "exec", "--cd", cwd, "--sandbox", "workspace-write", prompt] },
};

/** First match wins when a task names no agent. */
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

async function versionOf(path: string): Promise<string | null> {
  const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => child.kill(), 5_000);
  try {
    const out = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) return null;
    return out.split("\n").find((line) => line.trim())?.trim().slice(0, 80) ?? "";
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The coding agents installed on this Mac, found where their installers put them and by PATH. Detection runs each
 * candidate's `--version` once a minute at most; nothing is configured, installed or started beyond that.
 */
export class CodingAgents implements CodingAgentPort {
  private cached: { at: number; agents: CodingAgentInfo[] } | null = null;
  private readonly dirs: string[];

  constructor(options: { dirs?: string[] } = {}) {
    const home = homedir();
    const path = (process.env.PATH ?? "").split(":").filter(Boolean);
    this.dirs = options.dirs ?? [...new Set([join(home, ".bun/bin"), join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", ...path])];
  }

  async detect(): Promise<CodingAgentInfo[]> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.agents;
    const found = await Promise.all(CODING_AGENT_ORDER.map(async (id): Promise<CodingAgentInfo | null> => {
      for (const dir of this.dirs) {
        const path = join(dir, id);
        if (!isExecutable(path)) continue;
        const version = await versionOf(path);
        if (version !== null) return { id, name: ADAPTERS[id].name, path, version: version || null };
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
