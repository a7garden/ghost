import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { HerdrCommands, HerdrSlashCommand } from "@ghost/contract";

const TTL_MS = 10 * 60_000;
const RPC_TIMEOUT_MS = 15_000;
const RPC_MAX_FRAME_CHARS = 1024 * 1024;
const MAX_COMMANDS = 500;
const MAX_FRONTMATTER_BYTES = 32 * 1024;
const OMP_COMMAND = "get_available_commands";
const RPC_ID = "ghost-commands";
const NAME = /^[\p{L}\p{M}\p{N}_.-]+(?::[\p{L}\p{M}\p{N}_.-]+)*$/u;

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

// Claude Code's interactive built-ins. Account-, platform- and plugin-specific commands are not inferred.
// https://code.claude.com/docs/en/commands#all-commands
const CLAUDE_BUILTINS: readonly [name: string, description: string, hint?: string][] = [
  ["add-dir", "Add a working directory", "<path>"],
  ["agents", "Manage subagents"],
  ["background", "Detach this session to run in the background", "[prompt]"],
  ["branch", "Branch the current conversation", "[name]"],
  ["btw", "Ask a side question without changing the conversation", "[question]"],
  ["cd", "Change the working directory", "<path>"],
  ["clear", "Start a fresh conversation", "[name]"],
  ["compact", "Summarize the conversation to free context", "[focus]"],
  ["config", "Open settings"],
  ["context", "Show context usage"],
  ["copy", "Copy an assistant response", "[N]"],
  ["diff", "Show file changes"],
  ["effort", "Set the model's reasoning effort", "[level]"],
  ["exit", "Exit Claude Code"],
  ["export", "Export the conversation", "[filename]"],
  ["fast", "Toggle fast mode", "[on|off]"],
  ["feedback", "Report a problem", "[report]"],
  ["focus", "Toggle focus view"],
  ["fork", "Copy the conversation into a new background session", "[name]"],
  ["goal", "Set or clear a session goal", "[condition|clear]"],
  ["help", "Show help and available commands"],
  ["hooks", "View hook configuration"],
  ["ide", "Manage editor integrations"],
  ["init", "Create a starter CLAUDE.md"],
  ["keybindings", "Open keyboard shortcut settings"],
  ["login", "Sign in to Claude Code"],
  ["logout", "Sign out of Claude Code"],
  ["mcp", "Manage MCP servers"],
  ["memory", "Edit project instructions and manage memory"],
  ["model", "Choose the model", "[model]"],
  ["output-style", "Choose a response style", "[style]"],
  ["permissions", "Manage tool permissions"],
  ["plan", "Enter plan mode", "[description]"],
  ["plugin", "Manage plugins", "[subcommand]"],
  ["recap", "Show a short session summary"],
  ["release-notes", "Open the changelog"],
  ["reload-plugins", "Reload enabled plugins", "[--force]"],
  ["reload-skills", "Rescan skills and commands"],
  ["rename", "Rename the current session", "[name]"],
  ["restart", "Restart Claude Code and resume this session"],
  ["resume", "Resume a previous conversation", "[session]"],
  ["rewind", "Restore a conversation or file checkpoint"],
  ["skills", "List available skills"],
  ["status", "Show version, model and account status"],
  ["tasks", "List background tasks"],
  ["terminal-setup", "Install terminal keybindings"],
  ["theme", "Choose a terminal theme", "[theme]"],
  ["tui", "Switch terminal rendering mode", "[classic|fullscreen]"],
  ["usage", "Show plan usage and limits"],
];

function ompCommands(raw: unknown[]): HerdrCommands {
  const commands: HerdrSlashCommand[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!object(item) || typeof item.name !== "string" || item.name.length > 64 || !NAME.test(item.name) || seen.has(item.name)) continue;
    const { name, source } = item;
    // omp treats ':' as an argument separator except in the explicit /skill:NAME syntax.
    if (source === "skill" ? !/^skill:[^:]+$/.test(name) : name.includes(":")) continue;
    if (source !== "builtin" && source !== "skill" && source !== "file" && source !== "extension" && source !== "custom" && source !== "mcp_prompt") continue;
    seen.add(name);
    commands.push({ name, description: field(item.description, 300), hint: field(object(item.input) ? item.input.hint : null, 120) || null,
      source: source === "builtin" || source === "skill" ? source : "custom" });
    if (commands.length === MAX_COMMANDS) break;
  }
  return { commands };
}

async function readOmpCommands(executable: string, cwd: string, home: string): Promise<HerdrCommands> {
  const child = Bun.spawn([executable, "--mode", "rpc", "--no-session"], {
    cwd, detached: true, stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: { HOME: home, PATH: `${dirname(executable)}:/usr/bin:/bin` },
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error("omp command listing timed out")), RPC_TIMEOUT_MS);
  try {
    return await Promise.race([response(), deadline.promise]);
  } finally {
    clearTimeout(timer);
    // Kill the group too: startup can launch configured extensions or MCP servers.
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    void reader.cancel().catch(() => {});
    await child.exited;
  }

  async function response(): Promise<HerdrCommands> {
    let sent = false;
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("omp exited before returning commands");
      pending += decoder.decode(value, { stream: true });
      let start = 0;
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n", start)) {
        if (end - start > RPC_MAX_FRAME_CHARS) throw new Error("omp RPC frame too large");
        let frame: unknown;
        try { frame = JSON.parse(pending.slice(start, end)); } catch { /* Ignore non-RPC startup messages. */ }
        start = end + 1;
        if (!object(frame)) continue;
        if (!sent && frame.type === "ready" && frame.protocolVersion === 1) {
          // Version 1 is newline-delimited JSON; negotiation is optional.
          sent = true;
          child.stdin.write(`${JSON.stringify({ id: RPC_ID, type: OMP_COMMAND })}\n`);
          child.stdin.flush();
        } else if (sent && frame.type === "response" && frame.id === RPC_ID && frame.command === OMP_COMMAND) {
          if (frame.success !== true || !object(frame.data) || !Array.isArray(frame.data.commands)) throw new Error("omp RPC command listing failed");
          return ompCommands(frame.data.commands);
        }
      }
      if (pending.length - start > RPC_MAX_FRAME_CHARS) throw new Error("omp RPC frame too large");
      pending = pending.slice(start);
    }
  }
}

async function frontmatter(path: string): Promise<Record<string, unknown> | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) return null;
      const buffer = Buffer.allocUnsafe(MAX_FRONTMATTER_BYTES);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?$/m.exec(buffer.toString("utf8", 0, bytesRead));
      if (!header || header.index !== 0) return null;
      const parsed: unknown = Bun.YAML.parse(header[1]!);
      return object(parsed) ? parsed : null;
    } finally {
      await file.close();
    }
  } catch { return null; }
}

async function scanClaude(dir: string, commands: Map<string, HerdrSlashCommand>, prefix = ""): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const namespace = `${prefix}${entry.name}`;
      if (namespace.length < 63 && NAME.test(namespace)) await scanClaude(path, commands, `${namespace}:`);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const name = `${prefix}${entry.name.slice(0, -3)}`;
      if (name.length > 64 || !NAME.test(name) || commands.size >= MAX_COMMANDS && !commands.has(name)) continue;
      const meta = await frontmatter(path);
      if (meta?.["user-invocable"] === false) continue;
      commands.set(name, { name, description: field(meta?.description, 300), hint: field(meta?.["argument-hint"], 120) || null, source: "custom" });
    }
  }
}

export class HerdrCommandsProvider {
  private readonly cache = new Map<string, { expires: number; result: HerdrCommands }>();
  private readonly inFlight = new Map<string, Promise<HerdrCommands>>();

  constructor(
    private readonly executable: () => string | null,
    private readonly home = homedir(),
    private readonly log: (message: string, error?: unknown) => void = console.warn,
  ) {}

  async list(agent: string | null, cwd: string | null): Promise<HerdrCommands> {
    if (agent === "claude") {
      const commands = new Map<string, HerdrSlashCommand>(CLAUDE_BUILTINS.map(([name, description, hint]) =>
        [name, { name, description, hint: hint ?? null, source: "builtin" }]));
      // Personal commands win over project commands of the same name, as in Claude Code.
      if (cwd && isAbsolute(cwd) && cwd !== this.home) await scanClaude(join(cwd, ".claude/commands"), commands);
      await scanClaude(join(this.home, ".claude/commands"), commands);
      return { commands: [...commands.values()] };
    }
    if (agent !== "omp" || !cwd || !isAbsolute(cwd)) return { commands: [] };
    const now = Date.now();
    const cached = this.cache.get(cwd);
    if (cached && now < cached.expires) return cached.result;
    const pending = this.inFlight.get(cwd);
    if (pending) return pending;
    for (const [path, entry] of this.cache) if (entry.expires <= now) this.cache.delete(path);
    const request = this.loadOmp(cwd).finally(() => this.inFlight.delete(cwd));
    this.inFlight.set(cwd, request);
    return request;
  }

  private async loadOmp(cwd: string): Promise<HerdrCommands> {
    try {
      const executable = this.executable();
      if (executable === null) throw new Error("omp was not found");
      const result = await readOmpCommands(executable, cwd, this.home);
      this.cache.set(cwd, { expires: Date.now() + TTL_MS, result });
      return result;
    } catch (error) {
      this.log("Could not list omp slash commands", error);
      return { commands: [] };
    }
  }
}
