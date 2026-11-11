import { createHash, randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, DesktopConfig } from "../config.ts";
import { CommandError } from "../core/errors.ts";
import type { DesktopPort, DesktopResult, DesktopStatus } from "./ports.ts";

/** The helper and any Geist worker under it stop after this long without a request. */
const IDLE_MS = 15 * 60_000;
const STARTUP_MS = 10_000;
const STOP_MS = 8_000;
/** A reply carries at most one window image (Geist caps PNGs at 16 MiB) as base64 inside JSON. */
const MAX_LINE = 48 * 1024 * 1024;

export function createDesktop(config: Config, deps: { root: string }): DesktopPort | null {
  if (!config.desktop || process.platform !== "darwin") return null;
  return new GhostControl(config.desktop, join(deps.root, "desktop"));
}

type Reply = Record<string, unknown>;
type Child = Bun.Subprocess<"pipe", "pipe", "ignore">;
interface Waiter { resolve(reply: Reply): void; reject(error: Error): void; valid(reply: Reply): boolean }

async function exitedWithin(child: Child, ms: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => resolve(false), ms);
  try { return await Promise.race([child.exited.then(() => true, () => true), promise]); }
  finally { clearTimeout(timer); }
}

/**
 * The Host's side of Ghost Control: one long-lived helper process whose children inherit its macOS privacy
 * identity, spoken to over newline-delimited JSON. Every request waits for the previous one.
 */
export class GhostControl implements DesktopPort {
  private child: Child | null = null;
  private runtime: string | null = null;
  private started: Promise<void> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closing: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private pending = 0;
  private readonly waiters = new Map<number, Waiter>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | undefined;
  private stopping = false;
  /** One Geist session for this state root; snapshot ownership per conversation is kept by the tools. */
  private readonly geistSession: string;

  constructor(private readonly config: DesktopConfig, private readonly state: string) {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    chmodSync(state, 0o700);
    const hash = createHash("sha256").update(state).digest("hex");
    this.geistSession = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  }

  private async start(): Promise<void> {
    if (this.closing) await this.closing;
    if (this.started) return this.started;
    const executable = join(this.config.control, "Contents/MacOS/ghost-control");
    let child: Child;
    let runtime: string | null = null;
    try {
      // Geist keys its IPC namespace to its executable. Never share one worker across Host roots or restarts.
      const source = lstatSync(this.config.geist);
      if (!this.config.geist.startsWith("/") || !source.isFile() || source.uid !== process.getuid?.() || (source.mode & 0o022) !== 0 || (source.mode & 0o100) === 0) {
        throw new Error("untrusted Geist executable");
      }
      const runtimes = join(this.state, "runtime");
      mkdirSync(runtimes, { recursive: true, mode: 0o700 });
      chmodSync(runtimes, 0o700);
      runtime = mkdtempSync(join(runtimes, "geist-"));
      const geist = join(runtime, "geist");
      copyFileSync(this.config.geist, geist, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
      chmodSync(geist, 0o700);
      child = Bun.spawn([executable, "serve", "--agent-desktop", this.config.agentDesktop, "--geist", geist, "--state", this.state], {
        cwd: this.state, env: { PATH: "/usr/bin:/bin" }, stdin: "pipe", stdout: "pipe", stderr: "ignore",
        detached: true,
      });
    } catch {
      // No child was started, so this instance's new directory cannot belong to a live worker.
      if (runtime) rmSync(runtime, { recursive: true, force: true });
      throw new CommandError("unavailable", "Ghost Control could not start");
    }
    this.child = child;
    this.runtime = runtime;
    const { promise: started, resolve, reject } = Promise.withResolvers<void>();
    this.waiters.set(0, { resolve: () => resolve(), reject, valid: reply => reply.ready === true && reply.id === undefined });
    const deadline = setTimeout(() => this.fail(child, "startup timed out"), STARTUP_MS);
    this.started = started.finally(() => clearTimeout(deadline));
    void this.read(child);
    void child.exited.then(
      () => this.fail(child, "stopped"),
      () => this.fail(child, "could not be monitored"),
    );
    return this.started;
  }

  private fail(child: Child, reason: string): CommandError {
    const error = new CommandError("unavailable", `Ghost Control ${reason}; the outcome of the last PC action is unknown`);
    if (this.child !== child) return error;
    for (const waiter of this.waiters.values()) waiter.reject(error);
    this.waiters.clear();
    void this.stop(true);
    return error;
  }

  private async read(child: Child) {
    const reader = child.stdout.getReader();
    this.reader = reader;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (this.child === child) {
        const next = await reader.read();
        if (next.done) throw new Error(size ? "ended with an incomplete reply" : "closed its reply stream");
        let offset = 0;
        while (offset < next.value.length) {
          const newline = next.value.indexOf(10, offset);
          const end = newline < 0 ? next.value.length : newline;
          const length = end - offset;
          // Check the entire UTF-8 line before decoding or parsing, including a line ending in this chunk.
          if (size + length > MAX_LINE) throw new Error("exceeded the reply limit");
          chunks.push(next.value.subarray(offset, end));
          size += length;
          if (newline < 0) break;
          const bytes = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size);
          let parsed: unknown;
          try { parsed = JSON.parse(decoder.decode(bytes)); }
          catch { throw new Error("sent malformed JSON"); }
          chunks = [];
          size = 0;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("sent an invalid reply");
          const reply = parsed as Reply;
          const id = reply.ready === true ? 0 : reply.id;
          if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new Error("sent an invalid reply id");
          const waiter = this.waiters.get(id);
          if (!waiter || !waiter.valid(reply)) throw new Error("sent an unexpected or invalid reply");
          this.waiters.delete(id);
          waiter.resolve(reply);
          offset = newline + 1;
        }
      }
    } catch (error) {
      this.fail(child, error instanceof Error ? error.message : "could not read its reply");
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
      if (this.reader === reader) this.reader = null;
    }
  }

  private request(body: Reply, deadlineMs: number, authorize?: () => void): Promise<Reply> {
    if (this.stopping) return Promise.reject(new CommandError("unavailable", "PC control is shutting down"));
    clearTimeout(this.idle);
    this.pending++;
    const perform = async () => {
      await this.start();
      const child = this.child;
      if (!child) throw new CommandError("unavailable", "Ghost Control is not running");
      const id = this.nextId++;
      const line = `${JSON.stringify({ id, ...body })}\n`;
      const { promise: reply, resolve, reject } = Promise.withResolvers<Reply>();
      // A synchronous authorization/write failure must not leave an unhandled rejected waiter.
      void reply.catch(() => {});
      const valid = (value: Reply) => value.ready === undefined && (typeof value.error === "string" || (body.op === "status"
        ? typeof value.accessibility === "boolean" && typeof value.screenRecording === "boolean" && typeof value.idleSeconds === "number" && Number.isFinite(value.idleSeconds) && value.idleSeconds >= 0
        : typeof value.stdout === "string" && typeof value.timedOut === "boolean" && typeof value.truncated === "boolean"));
      this.waiters.set(id, { resolve, reject, valid });
      const deadline = setTimeout(() => this.fail(child, "request timed out"), deadlineMs);
      try {
        authorize?.();
        try {
          child.stdin.write(line);
          const [result] = await Promise.all([reply, child.stdin.flush()]);
          return result;
        } catch (error) {
          if (error instanceof CommandError) throw error;
          throw this.fail(child, "could not send its request");
        }
      } finally {
        clearTimeout(deadline);
        this.waiters.delete(id);
      }
    };
    const next = this.queue.then(perform, perform).finally(() => {
      this.pending--;
      if (this.stopping || this.pending || !this.child) return;
      this.idle = setTimeout(() => {
        this.idle = undefined;
        if (this.stopping || this.pending) return;
        // Idle close uses the same queue as requests. A new request either cancels it or waits for it.
        this.queue = this.queue.then(() => this.stop()).catch(() => {});
      }, IDLE_MS);
      this.idle.unref?.();
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private async run(tool: "agent-desktop" | "geist", args: string[], stdin: string | undefined, timeoutMs: number, authorize?: () => void) {
    const reply = await this.request({ op: "run", tool, args, ...(stdin === undefined ? {} : { stdin }), timeoutMs }, timeoutMs + 15_000, authorize);
    if (typeof reply.error === "string") throw new CommandError("unavailable", `Ghost Control refused the request: ${reply.error.slice(0, 2000)}`);
    return { stdout: typeof reply.stdout === "string" ? reply.stdout : "", timedOut: reply.timedOut === true, truncated: reply.truncated === true };
  }

  async agentDesktop(argv: string[], options?: { stdin?: string; timeoutMs?: number; authorize?: () => void }): Promise<DesktopResult> {
    const out = await this.run("agent-desktop", argv, options?.stdin, options?.timeoutMs ?? 30_000, options?.authorize);
    if (out.timedOut || out.truncated) return { ok: false, data: null, error: { code: out.timedOut ? "TIMEOUT" : "OUTPUT_LIMIT", message: "agent-desktop did not finish" }, delivered: true };
    let envelope: { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown; disposition?: { delivery?: unknown } } };
    try { envelope = JSON.parse(out.stdout); } catch { return { ok: false, data: null, error: { code: "INVALID_RESPONSE", message: "agent-desktop returned no JSON" }, delivered: true }; }
    if (envelope.ok === true) return { ok: true, data: envelope.data ?? null, error: null, delivered: true };
    const error = envelope.error ?? {};
    return {
      ok: false, data: null,
      error: { code: typeof error.code === "string" ? error.code : "FAILED", message: typeof error.message === "string" ? error.message.slice(0, 2000) : "agent-desktop failed" },
      delivered: error.disposition?.delivery !== "not_delivered",
    };
  }

  async geist(tool: string, args: Record<string, unknown>, options?: { timeoutMs?: number; authorize?: () => void }): Promise<DesktopResult> {
    const timeoutMs = options?.timeoutMs ?? 60_000;
    const out = await this.run("geist", ["--json", "--no-prompt", "--session", this.geistSession, "--timeout", String(timeoutMs), "tool", tool, JSON.stringify(args)], undefined, timeoutMs + 5_000, options?.authorize);
    if (out.timedOut || out.truncated) return { ok: false, data: null, error: { code: out.timedOut ? "TIMEOUT" : "OUTPUT_LIMIT", message: "Geist did not finish" }, delivered: true };
    let reply: { status?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown; uncertain?: unknown } | null };
    try { reply = JSON.parse(out.stdout); } catch { return { ok: false, data: null, error: { code: "INVALID_RESPONSE", message: "Geist returned no JSON" }, delivered: true }; }
    if (reply.status === "success" || reply.status === "warning") return { ok: true, data: reply.data ?? null, error: null, delivered: true };
    const error = reply.error ?? {};
    return {
      ok: false, data: null,
      error: { code: typeof error.code === "string" ? error.code : "FAILED", message: typeof error.message === "string" ? error.message.slice(0, 2000) : "Geist failed" },
      delivered: error.uncertain === true,
    };
  }

  async status(): Promise<DesktopStatus> {
    const reply = await this.request({ op: "status" }, 10_000);
    if (typeof reply.error === "string") throw new CommandError("unavailable", `Ghost Control refused the request: ${reply.error.slice(0, 2000)}`);
    return { accessibility: reply.accessibility === true, screenRecording: reply.screenRecording === true, idleSeconds: typeof reply.idleSeconds === "number" ? reply.idleSeconds : 0 };
  }

  async image(png: Uint8Array, maxEdge: number) {
    const tmp = join(this.state, "images");
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const name = randomUUID();
    const input = join(tmp, `${name}.png`), output = join(tmp, `${name}.jpg`);
    try {
      writeFileSync(input, png, { mode: 0o600, flag: "wx" });
      const sips = async (args: string[]) => {
        const child = Bun.spawn(["/usr/bin/sips", ...args], { stdout: "pipe", stderr: "ignore", timeout: 20_000 });
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let text = "", bytes = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.length;
            if (bytes > 64 * 1024) throw new CommandError("unavailable", "The image converter exceeded its output limit");
            text += decoder.decode(next.value, { stream: true });
          }
          text += decoder.decode();
          if (await child.exited !== 0) throw new CommandError("unavailable", "The window image could not be converted");
          return text;
        } catch (error) {
          try { child.kill("SIGKILL"); } catch { /* already exited */ }
          throw error;
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      };
      const size = (text: string) => ({ width: Number(/pixelWidth: (\d+)/.exec(text)?.[1]), height: Number(/pixelHeight: (\d+)/.exec(text)?.[1]) });
      const source = size(await sips(["-g", "pixelWidth", "-g", "pixelHeight", input]));
      const resize = Math.max(source.width, source.height) > maxEdge ? ["-Z", String(maxEdge)] : [];
      await sips([...resize, "-s", "format", "jpeg", "-s", "formatOptions", "80", input, "--out", output]);
      const result = size(await sips(["-g", "pixelWidth", "-g", "pixelHeight", output]));
      if (!Number.isInteger(result.width) || !Number.isInteger(result.height)) throw new CommandError("unavailable", "The window image could not be converted");
      return { data: readFileSync(output).toString("base64"), mimeType: "image/jpeg" as const, ...result };
    } finally {
      rmSync(input, { force: true });
      rmSync(output, { force: true });
    }
  }

  private stop(terminate = false): Promise<void> {
    if (this.closing) return this.closing;
    const child = this.child;
    if (!child) return Promise.resolve();
    const runtime = this.runtime;
    this.runtime = null;
    this.child = null;
    this.started = null;
    clearTimeout(this.idle);
    const reader = this.reader;
    this.reader = null;
    this.closing = (async () => {
      // EOF permits the helper to stop Geist normally; failures also interrupt the current runtime.
      try { void Promise.resolve(child.stdin.end()).catch(() => {}); } catch { /* already closed */ }
      if (terminate) {
        try { child.kill("SIGTERM"); } catch { /* already exited */ }
      }
      const exited = await exitedWithin(child, STOP_MS);
      const clean = exited && child.exitCode === 0 && child.signalCode == null;
      if (!clean) {
        // Only this helper's dedicated process group is ours. A daemon that leaves it needs helper-side cleanup.
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { if (!exited) { try { child.kill("SIGKILL"); } catch { /* already exited */ } } }
      }
      if (!exited) await exitedWithin(child, 2_000);
      void reader?.cancel().catch(() => {});
      // A failed/forced stop may leave a daemon outside our group; retain its executable for recovery.
      if (clean && runtime) {
        try { rmSync(runtime, { recursive: true, force: true }); } catch { /* retain on filesystem failure */ }
      }
    })().finally(() => { this.closing = null; });
    return this.closing;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    clearTimeout(this.idle);
    this.shutdownPromise = (async () => {
      // Requests already admitted finish; later requests are refused at admission.
      await this.queue;
      await this.stop();
    })();
    return this.shutdownPromise;
  }
}
