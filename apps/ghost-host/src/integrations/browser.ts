import { randomBytes, createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, linkSync, unlinkSync, readFileSync, writeFileSync, statSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Config } from "../config.ts";
import { CommandError } from "../core/errors.ts";
import type { BrowserCommandResult, BrowserPort, BrowserRunOptions, BrowserSessionRef } from "./ports.ts";
import { createEgressProxy, type EgressProxy } from "./egress-proxy.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CAP = 512 * 1024;
const MAX_SESSIONS = 4;
const expand = (path: string) => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
const nameFor = (id: string) => `ghost-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
interface Session {
  ref: BrowserSessionRef;
  headed: boolean;
  secrets: { value: string; cardPattern?: RegExp }[];
  screenshotOrigin: string | null;
  active: boolean;
}

export function createBrowser(config: Config, deps: { root: string; log: (...a: unknown[]) => void }): BrowserPort | null {
  if (!config.browser) return null;
  return new AgentBrowser(config.browser, deps.root);
}

/** A private HOME/config/key and namespace prevent owner plugins and sessions from entering Ghost. */
export class AgentBrowser implements BrowserPort {
  private readonly home: string;
  private readonly configPath: string;
  private readonly namespace: string;
  private readonly socketDir: string;
  private readonly key: string;
  private readonly sessions = new Map<string, Session>();
  private proxy: Promise<EgressProxy> | null = null;
  /** Admission is serialized; independent conversations may run concurrently. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly sessionQueues = new Map<string, Promise<unknown>>();
  private available = Promise.withResolvers<void>();
  private stopping = false;
  private initialized = false;
  private shutdownPromise: Promise<void> | null = null;
  constructor(private readonly config: NonNullable<Config["browser"]>, private readonly root: string) {
    const base = join(resolve(root), "browser");
    this.home = join(base, "home");
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.configPath = join(base, "config.json");
    writeFileSync(this.configPath, "{}", { mode: 0o600 });
    const rootHash = createHash("sha256").update(resolve(root)).digest("hex");
    this.namespace = `g${rootHash.slice(0, 12)}`;
    // macOS sockaddr_un permits only 103 path bytes; sockets are ephemeral, not login state.
    this.socketDir = `/tmp/ghost-browser-${rootHash.slice(0, 16)}`;
    try { mkdirSync(this.socketDir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const socketDir = lstatSync(this.socketDir);
    if (!socketDir.isDirectory() || socketDir.isSymbolicLink() || socketDir.uid !== process.getuid?.() || (socketDir.mode & 0o077) !== 0) throw new Error("Unsafe browser socket directory");
    const keyPath = join(base, "key");
    const temporaryKey = `${keyPath}.${randomUUID()}`;
    writeFileSync(temporaryKey, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    try { linkSync(temporaryKey, keyPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { unlinkSync(temporaryKey); }
    this.key = readFileSync(keyPath, "utf8");
    if (!/^[a-f0-9]{64}$/.test(this.key)) throw new Error("Invalid browser encryption key");
    chmodSync(keyPath, 0o600);
  }
  private enqueue<T>(perform: () => Promise<T>): Promise<T> {
    const next = this.queue.then(perform);
    this.queue = next.catch(() => {});
    return next;
  }
  private enqueueSession<T>(ref: BrowserSessionRef, perform: (session: Session) => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new CommandError("unavailable", "Browser is shutting down"));
    const previous = this.sessionQueues.get(ref.conversationId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const session = await this.enqueue(() => this.admit(ref));
      try { return await perform(session); }
      finally {
        session.active = false;
        this.available.resolve();
        this.available = Promise.withResolvers<void>();
      }
    });
    const settled = next.catch(() => {});
    this.sessionQueues.set(ref.conversationId, settled);
    void settled.then(() => {
      if (this.sessionQueues.get(ref.conversationId) === settled) this.sessionQueues.delete(ref.conversationId);
    });
    return next;
  }
  private async invoke(session: Session, argv: string[], options?: { stdin?: string; timeoutMs?: number }): Promise<BrowserCommandResult> {
    const proxy = await (this.proxy ??= createEgressProxy());
    const name = nameFor(session.ref.conversationId);
    const download = join(this.root, "browser", "downloads", name);
    mkdirSync(download, { recursive: true, mode: 0o700 });
    const screenshot = argv[0] === "screenshot" ? join(download, `${randomUUID()}.png`) : null;
    const command = screenshot ? ["screenshot", screenshot, ...argv.slice(1)] : argv;
    const args = [expand(this.config.executable), "--session", name, "--namespace", this.namespace,
      "--restore", `ghost-${session.ref.ghostId}`, "--config", this.configPath,
      "--executable-path", expand(this.config.chrome ?? CHROME),
      "--args", `--proxy-server=${proxy.url},--proxy-bypass-list=<-loopback>,--force-webrtc-ip-handling-policy=disable_non_proxied_udp`,
      "--content-boundaries", "--max-output", "48000", "--idle-timeout", `${this.config.idleTimeoutMinutes ?? 10}m`,
      "--download-path", download, "--screenshot-dir", download, ...(session.headed ? ["--headed"] : []), "--json", ...command];
    const env = { HOME: this.home, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp",
      AGENT_BROWSER_ENCRYPTION_KEY: this.key, AGENT_BROWSER_NO_VERSION_CHECK: "1", AGENT_BROWSER_SOCKET_DIR: this.socketDir };
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try { child = Bun.spawn(args, { cwd: this.home, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }); }
    catch { throw new CommandError("unavailable", "Browser executable could not start"); }
    let exceeded = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => { child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 500); };
    const deadline = setTimeout(() => { timedOut = true; stop(); }, Math.min(options?.timeoutMs ?? 45_000, 90_000));
    const capture = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > CAP) { exceeded = true; stop(); }
        else chunks.push(next.value);
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    try {
      const stdout = capture(child.stdout);
      const stderr = capture(child.stderr);
      if (options?.stdin !== undefined) child.stdin.write(options.stdin);
      child.stdin.end();
      const [out, , exit] = await Promise.all([stdout, stderr, child.exited]);
      if (timedOut || exceeded || exit !== 0) throw new CommandError("unavailable", timedOut ? "Browser command deadline exceeded; outcome may be unknown" : "Browser command failed; outcome may be unknown");
      let parsed: { success?: boolean; data?: unknown };
      try { parsed = JSON.parse(out); } catch { throw new CommandError("unavailable", "Browser returned an invalid response"); }
      // Secret eval responses are an allowlisted status only. Never forward raw output or an error.
      if (options?.stdin !== undefined) {
        const value = parsed.data && typeof parsed.data === "object" && "result" in parsed.data ? parsed.data.result : null;
        const status = value === "filled" ? "filled" : "refused";
        return { ok: parsed.success === true && status === "filled", data: { status }, error: status === "filled" ? null : "Secret fill refused" };
      }
      if (screenshot && parsed.success === true) {
        if (statSync(screenshot).size > 8 * 1024 * 1024) return { ok: true, data: { path: screenshot }, error: null };
        return { ok: true, data: { image: readFileSync(screenshot).toString("base64"), path: screenshot }, error: null };
      }
      return { ok: parsed.success === true, data: parsed.data ?? null, error: parsed.success === true ? null : "Browser action failed" };
    } finally {
      clearTimeout(deadline); clearTimeout(killTimer);
    }
  }
  private async admit(ref: BrowserSessionRef): Promise<Session> {
    if (!this.initialized) {
      // A crashed host may leave daemons pointing at its now-dead proxy. This private namespace
      // belongs to this root only; close those daemons before restoring any new session.
      const orphan: Session = { ref, headed: false, secrets: [], screenshotOrigin: null, active: false };
      if (!(await this.invoke(orphan, ["close", "--all"])).ok) throw new CommandError("unavailable", "Could not close interrupted browser sessions");
      this.initialized = true;
    }
    const existing = this.sessions.get(ref.conversationId);
    if (existing && existing.ref.ghostId !== ref.ghostId) throw new CommandError("forbidden", "Browser session owner changed");
    while (!existing && this.sessions.size >= MAX_SESSIONS) {
      const idle = [...this.sessions].find(([, session]) => !session.active);
      if (!idle) { await this.available.promise; continue; }
      const [id, victim] = idle;
      const closed = await this.invoke(victim, ["close"]);
      if (!closed.ok) throw new CommandError("unavailable", "Browser session eviction failed");
      this.sessions.delete(id);
    }
    const session: Session = existing ?? { ref, headed: false, secrets: [], screenshotOrigin: null, active: false };
    session.active = true;
    this.sessions.delete(ref.conversationId);
    this.sessions.set(ref.conversationId, session);
    return session;
  }
  run(ref: BrowserSessionRef, argv: string[], options?: BrowserRunOptions) {
    return this.enqueueSession(ref, async (session) => {
      if (options?.sensitive) {
        const { value, field, origin } = options.sensitive;
        if (value && !session.secrets.some((entry) => entry.value === value && (field !== "card_number" || entry.cardPattern !== undefined))) {
          const digits = field === "card_number" ? value.replace(/\D/g, "") : "";
          session.secrets.push({ value, ...(digits ? { cardPattern: new RegExp(digits.split("").join("[\\s-]*"), "g") } : {}) });
        }
        if (field.startsWith("card_") || field === "value") session.screenshotOrigin = origin;
      }
      if (argv[0] === "screenshot" && session.screenshotOrigin) {
        const page = await this.invoke(session, ["get", "url"]);
        const url = page.data && typeof page.data === "object" && "url" in page.data ? page.data.url : null;
        let origin: string | null = null;
        try { if (typeof url === "string") origin = new URL(url).origin; } catch {}
        if (!page.ok || origin === null || origin === session.screenshotOrigin) throw new CommandError("forbidden", "Screenshots are disabled on this origin after a card or secret-value fill; navigate to a different origin or close the session");
        session.screenshotOrigin = null;
      }
      const result = await this.invoke(session, argv, options);
      if (!session.secrets.length || options?.stdin !== undefined || argv[0] === "screenshot") return result;
      const redactText = (text: string) => {
        for (const secret of session.secrets) {
          text = text.replaceAll(secret.value, "[redacted]");
          if (secret.cardPattern) text = text.replace(secret.cardPattern, "[redacted]");
        }
        return text;
      };
      const redact = (value: unknown): unknown => {
        if (typeof value === "string") return redactText(value);
        if (typeof value === "number") {
          const rendered = String(value);
          const redacted = redactText(rendered);
          return redacted === rendered ? value : redacted;
        }
        if (Array.isArray(value)) return value.map(redact);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [redactText(key), redact(child)]));
        return value;
      };
      return { ok: result.ok, data: redact(result.data), error: result.error === null ? null : redactText(result.error) };
    });
  }
  handoff(ref: BrowserSessionRef, url: string | null) {
    return this.enqueueSession(ref, async (session) => {
      if (!(await this.invoke(session, ["close"])).ok) throw new CommandError("unavailable", "Could not save browser state");
      session.secrets = [];
      session.screenshotOrigin = null;
      session.headed = true;
      if (!(await this.invoke(session, ["open", url ?? "about:blank"])).ok) throw new CommandError("unavailable", "Could not open browser handoff");
    });
  }
  endHandoff(ref: BrowserSessionRef) { return this.close(ref); }
  close(ref: BrowserSessionRef) {
    return this.enqueueSession(ref, async (session) => {
      if (!(await this.invoke(session, ["close"])).ok) throw new CommandError("unavailable", "Could not close browser session");
      this.sessions.delete(ref.conversationId);
    });
  }
  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    this.shutdownPromise = Promise.allSettled([...this.sessionQueues.values()]).then(() => this.enqueue(async () => {
      let failure: unknown;
      for (const [id, session] of this.sessions) {
        try {
          if (!(await this.invoke(session, ["close"])).ok) throw new Error("Browser session did not close");
          this.sessions.delete(id);
        } catch (error) { failure = error; }
      }
      if (this.proxy) { await (await this.proxy).close(); this.proxy = null; }
      if (failure) throw failure;
    }));
    return this.shutdownPromise;
  }
}
