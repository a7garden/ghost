import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { validate, type CodingAgentId, type CodingPrefs } from "@ghost/contract";
import type { CodingAgentInfo, CodingAgentPort, CodingEvent, CodingStream } from "./ports.ts";
import { CodingSessions } from "./coding-sessions.ts";

type Readiness = Pick<CodingAgentInfo, "ready" | "note">;

/** Message and tool-result content, which agents give as a plain string or as typed blocks. */
const Blocks = Type.Union([Type.String(), Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) }))]);

/** Only the fields the Host reads of each agent's events; everything else in them is ignored. */
const OmpEvent = Type.Object({
  type: Type.String(),
  id: Type.Optional(Type.String()),
  toolName: Type.Optional(Type.String()),
  args: Type.Optional(Type.Unknown()),
  result: Type.Optional(Type.Object({ content: Type.Optional(Blocks) })),
  message: Type.Optional(Type.Object({ role: Type.String(), content: Type.Optional(Blocks) })),
});

const ClaudeEvent = Type.Object({
  type: Type.String(),
  session_id: Type.Optional(Type.String()),
  result: Type.Optional(Type.String()),
  is_error: Type.Optional(Type.Boolean()),
  message: Type.Optional(Type.Object({
    content: Type.Optional(Type.Union([
      Type.String(),
      Type.Array(Type.Object({
        type: Type.String(),
        text: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        input: Type.Optional(Type.Unknown()),
        content: Type.Optional(Blocks),
      })),
    ])),
  })),
});

const CodexEvent = Type.Object({
  type: Type.String(),
  thread_id: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  error: Type.Optional(Type.Object({ message: Type.Optional(Type.String()) })),
  item: Type.Optional(Type.Object({
    type: Type.String(),
    text: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    aggregated_output: Type.Optional(Type.String()),
    exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    changes: Type.Optional(Type.Array(Type.Object({ path: Type.Optional(Type.String()), kind: Type.Optional(Type.String()) }))),
  })),
});

function blocksText(content: string | { type: string; text?: string | undefined }[] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("\n");
}
/** The argument that says most about a tool call, in the order worth showing. */
const ToolArgs = Type.Object({
  command: Type.Optional(Type.String()),
  cmd: Type.Optional(Type.String()),
  file_path: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  pattern: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});

/** A tool call's arguments as short text: its command, path or query when it has one, else the JSON. */
function brief(args: unknown): string {
  if (validate(ToolArgs, args)) {
    const first = [args.command, args.cmd, args.file_path, args.path, args.pattern, args.url, args.query, args.description].find((value) => value !== undefined && value.trim() !== "");
    if (first !== undefined) return first.trim().slice(0, 600);
  }
  return JSON.stringify(args ?? {}).slice(0, 600);
}

const say = (text: string): CodingEvent[] => (text.trim() === "" ? [] : [{ kind: "say", text: text.trim() }]);
const result = (text: string): CodingEvent[] => (text.trim() === "" ? [] : [{ kind: "result", text: text.trim() }]);

/** Turns one parsed line of an agent's stream into what the owner reads, and records the agent's session id and closing message on the stream. */
type Reader = (event: unknown, stream: LineStream) => CodingEvent[];

/** An agent's stdout as JSON lines: one event per line, read as the chunks arrive. */
class LineStream implements CodingStream {
  nativeId: string | null = null;
  final: string | null = null;
  private pending = "";

  constructor(private readonly read: Reader) {}

  feed(chunk: string): CodingEvent[] {
    this.pending += chunk;
    const lines = this.pending.split("\n");
    const rest = lines.pop() ?? "";
    // A line this long is not an event; its remainder fails to parse and is skipped.
    this.pending = rest.length > 8_000_000 ? "" : rest;
    return lines.flatMap((line) => this.line(line));
  }

  flush(): CodingEvent[] {
    const rest = this.pending;
    this.pending = "";
    return this.line(rest);
  }

  private line(text: string): CodingEvent[] {
    if (text.trim() === "") return [];
    let event: unknown;
    try { event = JSON.parse(text); } catch { return []; }
    return this.read(event, this);
  }
}

const readOmp: Reader = (event, stream) => {
  if (!validate(OmpEvent, event)) return [];
  switch (event.type) {
    case "session":
      if (event.id !== undefined) stream.nativeId = event.id;
      return [];
    case "tool_execution_start":
      return [{ kind: "tool", text: `${event.toolName ?? "tool"}: ${brief(event.args)}` }];
    case "tool_execution_end":
      return result(blocksText(event.result?.content));
    case "message_end": {
      if (event.message?.role !== "assistant") return [];
      const text = blocksText(event.message.content).trim();
      if (text !== "") stream.final = text;
      return say(text);
    }
    default:
      return [];
  }
};

const readClaude: Reader = (event, stream) => {
  if (!validate(ClaudeEvent, event)) return [];
  if (event.session_id !== undefined) stream.nativeId = event.session_id;
  const content = event.message?.content;
  switch (event.type) {
    case "assistant":
      if (typeof content !== "object") return [];
      return content.flatMap((block): CodingEvent[] => {
        if (block.type === "tool_use") return [{ kind: "tool", text: `${block.name ?? "tool"}: ${brief(block.input)}` }];
        if (block.type !== "text" || block.text === undefined) return [];
        if (block.text.trim() !== "") stream.final = block.text.trim();
        return say(block.text);
      });
    case "user":
      if (typeof content !== "object") return [];
      return content.flatMap((block) => (block.type === "tool_result" ? result(blocksText(block.content)) : []));
    case "result":
      if (event.result !== undefined && event.result.trim() !== "") stream.final = event.result.trim();
      return event.is_error === true ? [{ kind: "note", text: event.result ?? "Claude Code ended with an error" }] : [];
    default:
      return [];
  }
};

const readCodex: Reader = (event, stream) => {
  if (!validate(CodexEvent, event)) return [];
  const item = event.item;
  switch (event.type) {
    case "thread.started":
      if (event.thread_id !== undefined) stream.nativeId = event.thread_id;
      return [];
    case "item.started":
      return item?.type === "command_execution" ? [{ kind: "tool", text: `bash: ${item.command ?? ""}` }] : [];
    case "item.completed":
      if (item?.type === "agent_message" && item.text !== undefined) {
        if (item.text.trim() !== "") stream.final = item.text.trim();
        return say(item.text);
      }
      if (item?.type === "command_execution") {
        const output = (item.aggregated_output ?? "").trim();
        return result(typeof item.exit_code === "number" && item.exit_code !== 0 ? `${output}\n(exit ${item.exit_code})` : output);
      }
      if (item?.type === "file_change") return [{ kind: "tool", text: `edit: ${(item.changes ?? []).map((change) => `${change.path ?? "?"} (${change.kind ?? "?"})`).join(", ")}` }];
      return [];
    case "turn.failed":
      return [{ kind: "note", text: event.error?.message ?? "Codex turn failed" }];
    case "error":
      return event.message === undefined ? [] : [{ kind: "note", text: event.message }];
    default:
      return [];
  }
};

/**
 * How to run each supported coding agent headless with a JSON event stream the Host can follow (the prompt is one
 * argv word, never a shell string), how to continue one of its own sessions, and, where the agent can say, whether
 * its login still works. `status` gets the argv to probe with, so an agent that cannot say stays ready. Sessions are
 * kept by the agents themselves, so the owner can also open them with the agent's own resume command.
 */
const ADAPTERS: Record<CodingAgentId, {
  name: string;
  argv(path: string, prompt: string, cwd: string, resume: string | null): string[];
  read: Reader;
  status?: { args: string[]; read(code: number, out: string): Readiness };
}> = {
  omp: {
    name: "omp",
    argv: (path, prompt, cwd, resume) => [path, "-p", "--mode", "json", "--cwd", cwd, "--thinking", "medium", ...(resume === null ? [] : ["--resume", resume]), prompt],
    read: readOmp,
  },
  claude: {
    name: "Claude Code",
    argv: (path, prompt, _cwd, resume) => [path, "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", ...(resume === null ? [] : ["--resume", resume]), prompt],
    read: readClaude,
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
    // `exec resume` takes no --cd or --sandbox: the run's working directory is the session's, the sandbox a config override.
    argv: (path, prompt, cwd, resume) => resume === null
      ? [path, "exec", "--json", "--cd", cwd, "--sandbox", "workspace-write", prompt]
      : [path, "exec", "resume", "--json", "-c", 'sandbox_mode="workspace-write"', resume, prompt],
    read: readCodex,
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
  readonly sessions: CodingSessions;

  /** `sessionsDir` is where every run's session file goes. */
  constructor(sessionsDir: string, options: { dirs?: string[] } = {}) {
    const home = homedir();
    const path = (process.env.PATH ?? "").split(":").filter(Boolean);
    this.dirs = options.dirs ?? [...new Set([join(home, ".bun/bin"), join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", ...path])];
    this.sessions = new CodingSessions(sessionsDir);
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

  command(agent: CodingAgentInfo, prompt: string, cwd: string, resume: string | null): string[] {
    return ADAPTERS[agent.id].argv(agent.path, prompt, cwd, resume);
  }

  stream(agent: CodingAgentInfo): CodingStream {
    return new LineStream(ADAPTERS[agent.id].read);
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
