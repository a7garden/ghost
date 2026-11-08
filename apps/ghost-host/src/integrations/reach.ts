import type { Config } from "../config.ts";
import type { ReachChannel, ReachError, ReachItem, ReachPort, ReachResult } from "./ports.ts";

/** One `agent-reach` invocation (spawn, one JSON object on stdout) never runs longer than this. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** A child that ignores SIGTERM gets SIGKILL after this grace. */
const KILL_GRACE_MS = 2_000;
/** Bounded output: stdout beyond this is refused instead of buffered. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Bounded stderr kept for diagnostics. */
const MAX_STDERR_BYTES = 32 * 1024;
/** At most this many `agent-reach` children at once; further calls queue. */
const MAX_CONCURRENT = 4;

export interface ReachSettings {
  executable: string;
  /** Test override; production uses {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

type Json = unknown;

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Rejects with `message` when `promise` does not settle within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(message)), ms);
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Keeps the child's stderr from blocking it and preserves a bounded tail for diagnostics. */
async function drainStderr(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let tail = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return tail;
      tail = (tail + new TextDecoder().decode(chunk.value)).slice(-MAX_STDERR_BYTES);
    }
  } catch {
    return tail;
  }
}

/** Reads stdout as UTF-8 up to `cap`; kills the child (via `onOverflow`) and throws beyond it. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  onOverflow: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > cap) {
      onOverflow();
      throw new Error(`agent-reach output exceeded the size limit (${cap} bytes)`);
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The parts of one item the tools render; unknown shapes become nulls. */
function itemOf(value: unknown): ReachItem {
  const item = recordOf(value);
  return {
    title: asString(item.title),
    url: asString(item.url),
    author: asString(item.author),
    publishedAt: asString(item.published_at),
    text: asString(item.text),
  };
}

function errorOf(value: unknown): ReachError {
  const error = recordOf(value);
  return {
    code: asString(error.code) ?? "internal",
    message: asString(error.message) ?? "agent-reach reported a failure",
    hint: asString(error.hint),
  };
}

/** Maps one parsed CLI output object to the port's result shape. */
function resultOf(data: Json): ReachResult {
  const envelope = recordOf(data);
  const items = Array.isArray(envelope.items) ? envelope.items.map(itemOf) : [];
  return {
    ok: envelope.ok === true,
    channel: asString(envelope.channel),
    action: asString(envelope.action),
    items,
    error: envelope.ok === true || envelope.error === undefined || envelope.error === null ? null : errorOf(envelope.error),
  };
}

function channelsOf(data: Json): ReachChannel[] {
  const envelope = recordOf(data);
  const channels = Array.isArray(envelope.channels) ? envelope.channels : [];
  const parsed: ReachChannel[] = [];
  for (const raw of channels) {
    const channel = recordOf(raw);
    const name = asString(channel.name);
    if (!name) continue;
    const actions = Array.isArray(channel.actions) ? channel.actions : [];
    parsed.push({
      name,
      actions: actions
        .map((action) => asString(recordOf(action).name))
        .filter((name): name is string => name !== null)
        .map((name) => ({ name })),
    });
  }
  return parsed;
}

/**
 * The installed `agent-reach` CLI: one short-lived child per invocation. Read-only research;
 * management commands (login, setup, …) are refused by the tools above this port, never run here.
 */
export class AgentReach implements ReachPort {
  private readonly timeoutMs: number;
  readonly timeoutSeconds: number;
  private catalogPromise: Promise<ReachChannel[]> | null = null;
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly settings: ReachSettings) {
    this.timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timeoutSeconds = Math.max(1, Math.round(this.timeoutMs / 1000));
  }

  async search(query: string, limit: number): Promise<ReachResult> {
    return this.result(["web", "search", query, "--limit", String(Math.trunc(limit))]);
  }

  async read(url: string): Promise<ReachResult> {
    return this.result(["read", url]);
  }

  async run(channel: string, action: string, args: string[]): Promise<ReachResult> {
    return this.result([channel, action, ...args]);
  }

  /** The catalog is static for the life of the process; fetch it once. A failed fetch is retried on the next call. */
  catalog(): Promise<ReachChannel[]> {
    const attempt = (this.catalogPromise ??= this.invoke(["channels"]).then((data) => {
      const channels = channelsOf(data);
      if (channels.length === 0) throw new Error("agent-reach reported no channels");
      return channels;
    }));
    // Drop the cache only when this attempt is still the cached one; a later call may have replaced it.
    attempt.catch(() => {
      if (this.catalogPromise === attempt) this.catalogPromise = null;
    });
    return attempt;
  }

  private async result(argv: string[]): Promise<ReachResult> {
    return resultOf(await this.invoke(argv));
  }

  private async invoke(argv: string[]): Promise<Json> {
    await this.acquire();
    try {
      return await this.runChild(argv);
    } finally {
      this.release();
    }
  }

  /** Spawns `[executable, ...argv]` with a minimal environment and a bounded, timed read. */
  private async runChild(argv: string[]): Promise<Json> {
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn([this.settings.executable, ...argv], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // Only what the CLI needs to find its tools and home; host secrets stay out.
        // REACH_API_SUPERVISED keeps the CLI's own children (yt-dlp, ffmpeg) under its supervision,
        // so a host-side kill does not orphan them.
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", REACH_API_SUPERVISED: "1" },
      });
    } catch (error) {
      throw new Error(`cannot start agent-reach (${this.settings.executable}): ${error instanceof Error ? error.message : String(error)}`);
    }
    const killTimer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
    }, this.timeoutMs);
    // Overflow kills the child, so the pending stdout read below cannot hang.
    const stdout = readCapped(proc.stdout, MAX_OUTPUT_BYTES, () => {
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
    });
    const stderr = drainStderr(proc.stderr);
    try {
      let text: string;
      try {
        text = await withTimeout(stdout, this.timeoutMs, `agent-reach did not finish within ${this.timeoutMs} ms; it was stopped`);
      } catch (error) {
        void stdout.catch(() => {});
        throw error;
      }
      // The JSON object is complete; a lingering child has nothing more to say.
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
      const tail = await Promise.race([stderr, Bun.sleep(KILL_GRACE_MS).then(() => "")]);
      let data: Json;
      try {
        data = JSON.parse(text) as Json;
      } catch {
        throw new Error(`agent-reach did not print one JSON object${tail.trim() ? `: ${tail.trim().slice(0, 400)}` : ""}`);
      }
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new Error("agent-reach printed JSON that is not an object");
      }
      return data;
    } finally {
      clearTimeout(killTimer);
      void stderr.catch(() => {});
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
      const forced = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already exited.
        }
      }, KILL_GRACE_MS);
      try {
        await Promise.race([proc.exited, Bun.sleep(2 * KILL_GRACE_MS)]);
      } finally {
        clearTimeout(forced);
      }
    }
  }

  /** At most {@link MAX_CONCURRENT} children; the rest wait here for a handed-off slot. */
  private async acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT && this.waiters.length === 0) {
      this.active++;
      return;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiters.push(resolve);
    await promise;
  }

  /** The slot passes straight to the next waiter, so the limit can never be transiently exceeded. */
  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

/** `~` and `~/…` resolve against the host user's home. */
function expandHome(path: string): string {
  const home = process.env.HOME;
  if (path === "~") return home ?? path;
  if (path.startsWith("~/")) return home ? `${home}/${path.slice(2)}` : path;
  return path;
}

/** The reach port, or null when the host has no agent-reach configured. */
export function createReach(config: Config): ReachPort | null {
  const settings = config.reach;
  if (!settings) return null;
  if (typeof settings.executable !== "string" || settings.executable.trim() === "") {
    throw new Error("config.json: reach.executable must be the agent-reach path");
  }
  return new AgentReach({ executable: expandHome(settings.executable) });
}
