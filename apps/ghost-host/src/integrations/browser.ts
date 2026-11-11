import { randomBytes, createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, linkSync, unlinkSync, readFileSync, writeFileSync, statSync, lstatSync, readdirSync, rmSync, realpathSync, openSync, closeSync, fstatSync, readSync, constants as FS } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "../config.ts";
import { CommandError } from "../core/errors.ts";
import { NoEffect, KnownOutcome } from "../core/effects.ts";
import type { BrowserCommandResult, BrowserControl, BrowserFrame, BrowserPort, BrowserRunOptions, BrowserSessionRef, VaultField } from "./ports.ts";
import { createEgressProxy, type EgressProxy } from "./egress-proxy.ts";
import { assertFetchableUrl } from "./netguard.ts";
import { startObscura, type ObscuraProcess } from "./obscura.ts";
import { confineDirChain, readFileNoFollow } from "../sandbox/workspace-env.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CAP = 512 * 1024;
const MAX_SESSIONS = 4;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_DOWNLOAD_FILES = 32;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const NETWORK_INIT = `(() => {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate"]) {
    Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
  }
})();`;
const VIEWPORT_SCRIPT = `JSON.stringify({ w: innerWidth, h: innerHeight, url: location.href, title: document.title })`;
const expand = (path: string) => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
const nameFor = (id: string) => `ghost-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
interface Session {
  ref: BrowserSessionRef;
  engine?: BrowserRunOptions["engine"];
  obscura?: ObscuraProcess;
  obscuraIdle?: ReturnType<typeof setTimeout>;
  headed: boolean;
  handoffUrl: string | null;
  handoffFallback: boolean;
  secrets: { variants: string[]; cardPattern?: RegExp }[];
  screenshotsBlocked: boolean;
  /** Tabs whose screenshots stay refused until their URL changes: a password fill or the owner's live-view text. */
  lockedTabs: Map<string, string>;
  active: boolean;
}

export function createBrowser(config: Config, deps: { root: string }): BrowserPort | null {
  if (!config.browser) return null;
  return new AgentBrowser(config.browser, deps.root);
}

/** A private HOME/config/key and namespace prevent owner plugins and sessions from entering Ghost. */
export class AgentBrowser implements BrowserPort {
  get supportsObscura() { return this.config.obscura !== undefined; }
  private readonly home: string;
  private readonly configPath: string;
  private readonly initPath: string;
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
  /** Sessions an owner approval or handoff still depends on; see `retainWhile`. */
  private held: (ref: BrowserSessionRef) => boolean = () => false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly config: NonNullable<Config["browser"]>, private readonly root: string) {
    const base = join(resolve(root), "browser");
    this.home = join(base, "home");
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    // Private staged paths are canonical because the sandbox no-follow readers reject parent aliases.
    this.root = realpathSync(root);
    this.configPath = join(base, "config.json");
    writeFileSync(this.configPath, "{}", { mode: 0o600 });
    this.initPath = join(base, "network-init.js");
    writeFileSync(this.initPath, NETWORK_INIT, { mode: 0o600 });
    const rootHash = createHash("sha256").update(resolve(root)).digest("hex");
    this.namespace = `g${rootHash.slice(0, 12)}`;
    // macOS sockaddr_un permits only 103 path bytes; sockets are ephemeral, not login state.
    // Windows has neither /tmp nor POSIX ownership bits; it only hosts development and tests.
    this.socketDir = join(process.platform === "win32" ? tmpdir() : "/tmp", `ghost-browser-${rootHash.slice(0, 16)}`);
    this.ensureSocketDir();
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
  /** Create the 0700 socket directory if missing; refuse a symlink, a foreign owner or group/other access. */
  private ensureSocketDir() {
    try { mkdirSync(this.socketDir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const socketDir = lstatSync(this.socketDir);
    if (!socketDir.isDirectory() || socketDir.isSymbolicLink()) throw new Error("Unsafe browser socket directory");
    if (process.platform !== "win32" && (socketDir.uid !== process.getuid?.() || (socketDir.mode & 0o077) !== 0)) throw new Error("Unsafe browser socket directory");
  }
  private enqueue<T>(perform: () => Promise<T>): Promise<T> {
    const next = this.queue.then(perform);
    this.queue = next.catch(() => {});
    return next;
  }
  private enqueueSession<T>(ref: BrowserSessionRef, perform: (session: Session) => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new CommandError("unavailable", "Browser is shutting down"));
    return this.chain(ref, async () => {
      const session = await this.enqueue(() => this.admit(ref));
      try { return await perform(session); }
      finally { this.release(session); }
    });
  }
  private release(session: Session) {
    session.active = false;
    this.available.resolve();
    this.available = Promise.withResolvers<void>();
  }
  /** One conversation's commands run in order; independent conversations run concurrently. */
  private chain<T>(ref: BrowserSessionRef, perform: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(ref.conversationId) ?? Promise.resolve();
    const next = previous.then(perform);
    const settled = next.catch(() => {});
    this.sessionQueues.set(ref.conversationId, settled);
    void settled.then(() => {
      if (this.sessionQueues.get(ref.conversationId) === settled) this.sessionQueues.delete(ref.conversationId);
    });
    return next;
  }
  private sessionDirs(session: Session) {
    const name = nameFor(session.ref.conversationId);
    return [join(this.root, "browser", "downloads", name), join(this.root, "browser", "staging", name)];
  }
  private clearFiles(session: Session) {
    for (const path of this.sessionDirs(session)) rmSync(path, { recursive: true, force: true });
  }
  private checkBudget(session: Session) {
    let count = 0;
    let bytes = 0;
    const dirs = this.sessionDirs(session);
    while (dirs.length) {
      const directory = dirs.pop()!;
      if (!statSync(directory, { throwIfNoEntry: false })) continue;
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error("Unexpected staging symlink");
        if (stat.isDirectory()) dirs.push(path);
        else {
          count++; bytes += stat.size;
          if (count > MAX_DOWNLOAD_FILES || bytes > MAX_DOWNLOAD_BYTES) throw new Error("Download budget exceeded");
        }
      }
    }
  }
  private async stopDownloads(session: Session) {
    try {
      const closed = await this.invoke(session, ["close"], { timeoutMs: 5_000 });
      if (!closed.ok) throw new Error("Browser did not close");
    } catch {
      // A daemon that cannot be stopped must lose its network path, not continue downloading.
      const proxy = this.proxy; this.proxy = null; this.initialized = false;
      if (proxy) await (await proxy).close();
    }
    this.sessions.delete(session.ref.conversationId);
    this.clearFiles(session);
  }
  private activeTab(data: unknown) {
    if (!data || typeof data !== "object" || !("tabs" in data) || !Array.isArray(data.tabs)) return null;
    for (const tab of data.tabs) {
      if (tab && typeof tab === "object" && "active" in tab && tab.active && "targetId" in tab && typeof tab.targetId === "string" && "url" in tab && typeof tab.url === "string") return { id: tab.targetId, url: tab.url };
    }
    return null;
  }
  private workspace(workspace: string, input: string, createParent: boolean) {
    if (lstatSync(workspace).isSymbolicLink()) throw new CommandError("forbidden", "Workspace symlinks are refused");
    const base = realpathSync(workspace);
    const path = resolve(base, input);
    const rel = relative(base, path);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new CommandError("forbidden", "Path must stay inside the Work workspace");
    confineDirChain(base, rel.split("/").slice(0, -1), createParent);
    return path;
  }
  private stageUpload(path: string, staged: string) {
    const fd = openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      const current = lstatSync(path);
      if (realpathSync(dirname(path)) !== dirname(path) || !stat.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || stat.size > MAX_UPLOAD_BYTES) throw new CommandError("forbidden", "Upload must be a confined regular file no larger than 32 MiB");
      const buffer = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = readSync(fd, buffer, size, buffer.length - size, null);
        if (!read) break;
        size += read;
      }
      if (size > stat.size) throw new CommandError("forbidden", "Upload changed while being staged");
      writeFileSync(staged, buffer.subarray(0, size), { flag: "wx", mode: 0o600 });
    } finally { closeSync(fd); }
  }
  private commitDownload(path: string, staged: string) {
    if (realpathSync(dirname(path)) !== dirname(path)) throw new CommandError("forbidden", "Download directory was replaced");
    const fd = openSync(path, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      const current = lstatSync(path);
      if (realpathSync(dirname(path)) !== dirname(path) || stat.dev !== current.dev || stat.ino !== current.ino) throw new CommandError("forbidden", "Download directory was replaced");
      writeFileSync(fd, readFileNoFollow(staged));
    } catch (error) {
      // Remove only the inode this call just created, never a replacement planted by the container.
      try {
        const opened = fstatSync(fd); const current = lstatSync(path);
        if (opened.dev === current.dev && opened.ino === current.ino) unlinkSync(path);
      } catch {}
      throw error;
    } finally { closeSync(fd); }
  }
  private async invoke(session: Session, argv: string[], options?: { stdin?: string; timeoutMs?: number; batch?: boolean }): Promise<BrowserCommandResult> {
    const obscura = session.engine === "obscura";
    if (obscura) {
      clearTimeout(session.obscuraIdle);
      session.obscuraIdle = undefined;
      if (argv[0] !== "close" && !session.obscura?.running()) {
        if (argv[0] !== "open") throw new NoEffect("The Obscura session ended. Open the page again before continuing.");
        // An engine can die independently of the agent-browser daemon. Discard
        // that connection before supplying a new listener and bearer token.
        if (!(await this.invoke(session, ["close"])).ok) throw new NoEffect("Could not clear the previous Obscura connection");
        const executable = this.config.obscura?.executable;
        if (!executable) throw new NoEffect("Obscura is not configured");
        const proxy = await (this.proxy ??= createEgressProxy());
        try { session.obscura = await startObscura(expand(executable), proxy.url); }
        catch (error) { session.engine = undefined; throw error; }
        session.secrets = [];
        session.screenshotsBlocked = false;
        session.lockedTabs.clear();
      }
    }
    try { return await this.invokeCli(session, argv, options); }
    finally {
      if (obscura && session.obscura) {
        const process = session.obscura;
        if (argv[0] === "close") {
          await process.stop();
          session.obscura = undefined;
        } else {
          const idle = setTimeout(() => {
            if (this.sessions.get(session.ref.conversationId) !== session) return;
            void this.enqueueSession(session.ref, async (current) => {
              if (current === session && session.obscuraIdle === idle && !this.isHeld(session)) await this.invoke(session, ["close"]);
            }).catch(() => {});
          }, (this.config.idleTimeoutMinutes ?? 10) * 60_000);
          session.obscuraIdle = idle.unref();
        }
      }
    }
  }
  private async invokeCli(session: Session, argv: string[], options?: { stdin?: string; timeoutMs?: number; batch?: boolean }): Promise<BrowserCommandResult> {
    const proxy = await (this.proxy ??= createEgressProxy());
    const name = nameFor(session.ref.conversationId);
    const download = join(this.root, "browser", "downloads", name);
    mkdirSync(download, { recursive: true, mode: 0o700 });
    if (argv[0] !== "close") try { this.checkBudget(session); }
    catch { await this.stopDownloads(session); throw new CommandError("unavailable", "Browser download limit exceeded; session closed"); }
    const screenshot = argv[0] === "screenshot" ? join(download, `${randomUUID()}.${argv.includes("jpeg") ? "jpg" : "png"}`) : null;
    const command = screenshot ? ["screenshot", screenshot, ...argv.slice(1)] : argv;
    // Chromium needs the WebRTC init script; Obscura's OS policy limits all
    // outbound sockets to the Host proxy, including requests outside HTTP.
    const connection = session.engine === "obscura"
      ? (argv[0] !== "close" && session.obscura ? ["--cdp", session.obscura.websocket] : [])
      : ["--restore", `ghost-${session.ref.ghostId}`,
      "--executable-path", expand(this.config.chrome ?? CHROME),
      "--init-script", this.initPath,
      "--args", `--proxy-server=${proxy.url},--proxy-bypass-list=<-loopback>,--force-webrtc-ip-handling-policy=disable_non_proxied_udp`,
      ...(session.headed ? ["--headed"] : [])];
    const args = [expand(this.config.executable), "--session", name, "--namespace", this.namespace,
      "--config", this.configPath, ...connection,
      "--content-boundaries", "--max-output", "48000", "--idle-timeout", `${this.config.idleTimeoutMinutes ?? 10}m`,
      "--download-path", download, "--screenshot-dir", download, "--json", ...command];
    // /tmp is swept by macOS; the socket directory may vanish while the host keeps running.
    this.ensureSocketDir();
    const env = { HOME: this.home, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp",
      AGENT_BROWSER_ENCRYPTION_KEY: this.key, AGENT_BROWSER_NO_VERSION_CHECK: "1", AGENT_BROWSER_SOCKET_DIR: this.socketDir,
      ...(session.engine === "obscura" && session.obscura ? { AGENT_BROWSER_CDP_HEADERS: JSON.stringify(session.obscura.headers) } : {}) };
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try { child = Bun.spawn(args, { cwd: this.home, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }); }
    catch { throw new CommandError("unavailable", "Browser executable could not start"); }
    let exceeded = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => { child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 500); };
    const deadline = setTimeout(() => { timedOut = true; stop(); }, Math.min(options?.timeoutMs ?? 45_000, 90_000));
    let overflow = false;
    const budgetState: { closing: Promise<void> | null } = { closing: null };
    const budget = argv[0] === "close" ? null : setInterval(() => {
      try { this.checkBudget(session); }
      catch {
        overflow = true; stop();
        budgetState.closing ??= this.stopDownloads(session);
        void budgetState.closing.catch(() => {});
      }
    }, 100);
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
      if (budgetState.closing) await budgetState.closing;
      if (overflow) {
        this.clearFiles(session);
        throw new CommandError("unavailable", "Browser download limit exceeded; session closed");
      }
      if (argv[0] !== "close") try { this.checkBudget(session); }
      catch { await this.stopDownloads(session); throw new CommandError("unavailable", "Browser download limit exceeded; session closed"); }
      if (timedOut || exceeded || exit !== 0) throw new CommandError("unavailable", timedOut ? "Browser command deadline exceeded; outcome may be unknown" : "Browser command failed; outcome may be unknown");
      let parsed: { success?: boolean; data?: unknown };
      try { parsed = JSON.parse(out); } catch { throw new CommandError("unavailable", "Browser returned an invalid response"); }
      // An owner-input batch reports success only; its results may echo what the owner typed.
      if (options?.batch) {
        const ok = Array.isArray(parsed) && parsed.length > 0 && parsed.every((entry) => entry && typeof entry === "object" && "error" in entry && entry.error === null);
        return { ok, data: null, error: ok ? null : "Browser input failed" };
      }
      // Secret eval responses are an allowlisted status only. Never forward raw output or an error.
      if (options?.stdin !== undefined) {
        const value = parsed.data && typeof parsed.data === "object" && "result" in parsed.data ? parsed.data.result : null;
        if (value === "uncertain") return { ok: false, data: { status: "uncertain" }, error: "Secret fill outcome is uncertain" };
        const reason = typeof value === "string" && ["refused:origin_mismatch", "refused:not_password_field", "refused:frame", "refused:not_editable", "refused:not_granted"].includes(value) ? value.slice(8) : "not_editable";
        return { ok: parsed.success === true && value === "filled", data: value === "filled" ? { status: "filled" } : { status: "refused", reason }, error: value === "filled" ? null : `Secret fill refused (${reason})` };
      }
      if (screenshot && parsed.success === true) {
        if (statSync(screenshot).size > 8 * 1024 * 1024) throw new CommandError("unavailable", "Screenshot exceeds the 8 MiB image limit");
        return { ok: true, data: { image: readFileSync(screenshot).toString("base64") }, error: null };
      }
      return { ok: parsed.success === true, data: parsed.data ?? null, error: parsed.success === true ? null : "Browser action failed" };
    } finally {
      clearTimeout(deadline); clearTimeout(killTimer);
      clearInterval(budget ?? undefined);
      if (screenshot) rmSync(screenshot, { force: true });
    }
  }
  private async admit(ref: BrowserSessionRef): Promise<Session> {
    if (!this.initialized) {
      // A crashed host may leave daemons pointing at its now-dead proxy. This private namespace
      // belongs to this root only; close those daemons before restoring any new session.
      const orphan: Session = { ref, headed: false, handoffUrl: null, handoffFallback: false, secrets: [], screenshotsBlocked: false, lockedTabs: new Map(), active: false };
      if (!(await this.invoke(orphan, ["close", "--all"])).ok) throw new CommandError("unavailable", "Could not close interrupted browser sessions");
      this.initialized = true;
      for (const name of ["downloads", "staging"]) rmSync(join(this.root, "browser", name), { recursive: true, force: true });
    }
    const existing = this.sessions.get(ref.conversationId);
    if (existing && existing.ref.ghostId !== ref.ghostId) throw new CommandError("forbidden", "Browser session owner changed");
    while (!existing && this.sessions.size >= MAX_SESSIONS) {
      const idle = [...this.sessions].find(([, session]) => !session.active && !this.isHeld(session));
      if (!idle) {
        if ([...this.sessions.values()].some((session) => session.active)) { await this.available.promise; continue; }
        throw new CommandError("unavailable", "Every browser session is waiting for the owner's approval or handoff; wait for an answer or close a browser session");
      }
      const [id, victim] = idle;
      const closed = await this.invoke(victim, ["close"]);
      if (!closed.ok) throw new CommandError("unavailable", "Browser session eviction failed");
      this.clearFiles(victim);
      this.sessions.delete(id);
    }
    const session: Session = existing ?? { ref, headed: false, handoffUrl: null, handoffFallback: false, secrets: [], screenshotsBlocked: false, lockedTabs: new Map(), active: false };
    session.active = true;
    this.sessions.delete(ref.conversationId);
    this.sessions.set(ref.conversationId, session);
    return session;
  }
  /**
   * An owner approval answers within a day, but agent-browser and Obscura close a session after `idleTimeoutMinutes`
   * and admission evicts idle sessions. A held session is never evicted and is touched before its idle timeout, so the
   * approved click or fill still finds the page the owner saw.
   * 2026.11.11 : 승인 · 인계를 기다리는 세션이 10분 유휴 종료 · 축출로 사라져 승인해도 「URL 이 바뀜」으로 거절되던 것을 막는다.
   */
  retainWhile(held: (ref: BrowserSessionRef) => boolean) {
    this.held = held;
    if (this.keepalive) return;
    const every = Math.max(30_000, Math.min(5 * 60_000, (this.config.idleTimeoutMinutes ?? 10) * 30_000));
    this.keepalive = setInterval(() => this.touchHeld(), every);
    this.keepalive.unref?.();
  }
  /** Reset the idle timers of every held session that is not running a command. */
  touchHeld() {
    if (this.stopping) return Promise.resolve();
    return Promise.allSettled([...this.sessions.values()].filter((session) => !session.active && this.isHeld(session)).map((session) => this.touch(session))).then(() => {});
  }
  private isHeld(session: Session) {
    try { return this.held(session.ref); } catch { return false; }
  }
  /** A read that resets both idle timers; it never admits a session that was closed meanwhile. */
  private touch(session: Session) {
    return this.chain(session.ref, async () => {
      if (this.stopping || this.sessions.get(session.ref.conversationId) !== session || session.active) return;
      session.active = true;
      try { await this.invoke(session, ["get", "url"]); }
      finally { this.release(session); }
    });
  }
  assertVaultFill(ref: BrowserSessionRef, field: VaultField, origin: string) {
    if (this.sessions.get(ref.conversationId)?.engine === "obscura" &&
      (!["username", "password", "totp"].includes(field) || !this.config.obscura?.loginOrigins?.includes(origin))) {
      throw new NoEffect("Vault login is unavailable on this Obscura site");
    }
  }
  private protectValue(session: Session, value: string, field: VaultField): void {
    // A username is an identifier, not a secret: redacting it also hid every URL that carries it, so `currentUrl`
    // refused all later proposals and fills. 2026.11.11 : 아이디는 가리지 않는다.
    if (field !== "username") this.redactLater(session, value, field === "card_number");
    if (field.startsWith("card_") || field === "value") session.screenshotsBlocked = true;
  }
  private redactLater(session: Session, value: string, digitsOnly: boolean): void {
    if (value && !session.secrets.some(entry => entry.variants.includes(value) && (!digitsOnly || entry.cardPattern !== undefined))) {
      const json = JSON.stringify(value).slice(1, -1);
      const html = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
      let encoded = value;
      try { encoded = encodeURIComponent(value); } catch {}
      const variants = [...new Set([value, encoded, encoded.replaceAll("%20", "+"), html, html.replaceAll("&#39;", "&#x27;"), json])].sort((a, b) => b.length - a.length);
      const digits = digitsOnly ? value.replace(/\D/g, "") : "";
      session.secrets.push({ variants, ...(digits ? { cardPattern: new RegExp(digits.split("").join("[\\s-]*"), "g") } : {}) });
    }
  }
  /**
   * The Ghost continues on the page the owner left, so what the owner typed there (a card number, a PASS code, an ID
   * number) would reach the model through snapshots, reads and screenshots. It is redacted like a filled secret and
   * that tab's screenshots stay refused until its URL changes.
   * 2026.11.11 : 실시간 보기로 소유자가 넣은 글이 인계 뒤 모델에 그대로 보이던 것을 막는다.
   */
  private async protectOwnerInput(session: Session, text: string) {
    const value = text.trim();
    // Shorter input is a keystroke-sized edit; redacting it would blank ordinary words across every page.
    if (value.length >= 4) this.redactLater(session, value, value.replace(/\D/g, "").length >= 8);
    let tab: { id: string; url: string } | null = null;
    try { tab = this.activeTab((await this.invoke(session, ["tab", "list"])).data); } catch {}
    if (tab) session.lockedTabs.set(tab.id, tab.url);
    else session.screenshotsBlocked = true;
  }
  captureCredential(ref: BrowserSessionRef, input: { origin: string; ref?: string; selector?: string }): Promise<string> {
    return this.enqueueSession(ref, async session => {
      if ((input.ref === undefined) === (input.selector === undefined)) throw new NoEffect("Choose exactly one credential input");
      let origin: URL;
      try { origin = new URL(input.origin); } catch { throw new NoEffect("Choose an exact HTTPS issuer origin"); }
      if (origin.protocol !== "https:" || origin.origin !== input.origin) throw new NoEffect("Choose an exact HTTPS issuer origin");
      session.engine ??= "chrome";
      this.assertVaultFill(ref, "value", input.origin);
      if (input.ref !== undefined && !(await this.invoke(session, ["focus", input.ref])).ok) throw new NoEffect("The credential field changed");
      const selection = input.selector === undefined ? "const e = document.activeElement;" : `const fields = document.querySelectorAll(${JSON.stringify(input.selector)}); if (fields.length !== 1) return null; const e = fields[0];`;
      const script = `(() => { if (window.top !== window || location.origin !== ${JSON.stringify(input.origin)}) return null; ${selection} return e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? e.value : null; })()`;
      // invoke bypasses model-output redaction; only this Host-only method receives the value.
      const result = await this.invoke(session, ["eval", script]);
      const data = result.data;
      const value = result.ok && data && typeof data === "object" && "result" in data && typeof data.result === "string" ? data.result.trim() : "";
      if (!value || value.length > 16384 || /[\r\n\0]/.test(value)) throw new NoEffect("The issuer origin or credential field changed");
      this.protectValue(session, value, "value");
      return value;
    });
  }
  run(ref: BrowserSessionRef, argv: string[], options?: BrowserRunOptions) {
    return this.enqueueSession(ref, async (session) => {
      if (options?.engine) {
        if (argv[0] !== "open" || session.engine && session.engine !== options.engine) throw new NoEffect("Close the browser session before choosing a different engine");
        if (options.engine === "obscura" && !this.supportsObscura) throw new NoEffect("Obscura is not configured");
      }
      session.engine ??= options?.engine ?? "chrome";
      if (session.engine === "obscura" && options?.transfer) throw new NoEffect("Obscura file transfers are unavailable");
      if (options?.sensitive) {
        const { value, field } = options.sensitive;
        this.assertVaultFill(ref, field, options.sensitive.origin);
        this.protectValue(session, value, field);
        if (field === "password") {
          const tab = this.activeTab((await this.invoke(session, ["tab", "list"])).data);
          if (!tab) throw new CommandError("forbidden", "Secret fill refused (not_password_field)");
          session.lockedTabs.set(tab.id, tab.url);
        }
      }
      if (argv[0] === "screenshot") {
        if (session.screenshotsBlocked) throw new CommandError("forbidden", "Screenshots are disabled after a card or secret-value fill; close the browser session to reset");
        if (session.lockedTabs.size) {
          const tab = this.activeTab((await this.invoke(session, ["tab", "list"])).data);
          if (!tab || session.lockedTabs.get(tab.id) === tab.url) throw new CommandError("forbidden", "Screenshots are disabled after a password fill or the owner's typing until that tab's URL changes");
          if (tab) session.lockedTabs.delete(tab.id);
        }
      }
      let staged: string | null = null;
      let destination: string | null = null;
      let command = argv;
      if (options?.transfer) {
        const transfer = options.transfer;
        const staging = this.sessionDirs(session)[1]!;
        mkdirSync(staging, { recursive: true, mode: 0o700 });
        staged = join(staging, randomUUID());
        try {
          if (transfer.kind === "upload") {
            const source = this.workspace(transfer.workspace, transfer.path, false);
            this.stageUpload(source, staged);
          } else {
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(transfer.name)) throw new CommandError("invalid", "Download name must be a plain filename");
            destination = this.workspace(transfer.workspace, `downloads/${transfer.name}`, true);
            if (lstatSync(destination, { throwIfNoEntry: false })) throw new NoEffect("Download destination already exists");
          }
          command = [transfer.kind, argv[1]!, staged];
        } catch {
          rmSync(staged, { force: true });
          throw new NoEffect("Workspace transfer refused: missing file, existing destination or symlink");
        }
      }
      let result: BrowserCommandResult;
      try {
        result = await this.invoke(session, command, options);
        if (result.ok && staged && destination) {
          try {
            // Re-walk after Chrome's I/O: a container may have swapped directories while it ran.
            const transfer = options?.transfer;
            if (!transfer || transfer.kind !== "download") throw new Error("Missing destination");
            destination = this.workspace(transfer.workspace, `downloads/${transfer.name}`, true);
            this.commitDownload(destination, staged);
          } catch { throw new KnownOutcome("Download could not be saved: existing destination or workspace symlink"); }
        }
      } finally { if (staged) rmSync(staged, { force: true }); }
      if (argv[0] === "close" && result.ok) this.clearFiles(session);
      if (!session.secrets.length || options?.stdin !== undefined || argv[0] === "screenshot") return result;
      const redactText = (text: string) => {
        for (const secret of session.secrets) {
          for (const variant of secret.variants) text = text.replaceAll(variant, "[redacted]");
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
      if (session.engine === "obscura") throw new CommandError("unavailable", "Obscura handoff uses the live view in Ghost");
      if (!(await this.invoke(session, ["close"])).ok) throw new CommandError("unavailable", "Could not save browser state");
      session.lockedTabs.clear();
      this.clearFiles(session);
      session.headed = true;
      session.handoffUrl = url ?? "about:blank";
      session.handoffFallback = false;
      if (!(await this.invoke(session, ["open", session.handoffUrl])).ok) throw new CommandError("unavailable", "Could not open browser handoff");
    });
  }
  /** The owner's live view goes straight to `invoke`: the Ghost-facing screenshot blocks guard models, not the owner. */
  view(ref: BrowserSessionRef): Promise<BrowserFrame> {
    return this.enqueueSession(ref, async (session) => {
      const page = await this.invoke(session, ["eval", VIEWPORT_SCRIPT]);
      const raw = page.data && typeof page.data === "object" && "result" in page.data ? page.data.result : null;
      let info: { w?: unknown; h?: unknown; url?: unknown; title?: unknown } = {};
      try { if (typeof raw === "string") info = JSON.parse(raw); } catch {}
      const width = typeof info.w === "number" && info.w > 0 ? Math.round(info.w) : 0, height = typeof info.h === "number" && info.h > 0 ? Math.round(info.h) : 0;
      if (!page.ok || !width || !height) throw new CommandError("unavailable", "The browser page could not be read");
      const shot = await this.invoke(session, ["screenshot", "--screenshot-format", "jpeg", "--screenshot-quality", "60"]);
      if (!shot.ok || !shot.data || typeof shot.data !== "object" || !("image" in shot.data) || typeof shot.data.image !== "string") throw new CommandError("unavailable", "The browser screenshot failed");
      return { image: shot.data.image, mediaType: "image/jpeg", width, height, url: typeof info.url === "string" ? info.url.slice(0, 2048) : "", title: typeof info.title === "string" ? info.title.slice(0, 256) : "",
        ...(session.engine === "obscura" ? { windowAvailable: false } : {}) };
    });
  }
  control(ref: BrowserSessionRef, input: BrowserControl): Promise<void> {
    return this.enqueueSession(ref, async (session) => {
      const run = async (argv: string[], options?: { stdin?: string; batch?: boolean }) => {
        const result = await this.invoke(session, argv, options);
        if (!result.ok) throw new CommandError("unavailable", "Browser input failed");
        return result;
      };
      switch (input.type) {
        case "tap": {
          const page = await run(["eval", VIEWPORT_SCRIPT]);
          const raw = page.data && typeof page.data === "object" && "result" in page.data ? page.data.result : null;
          let size: { w?: unknown; h?: unknown } = {};
          try { if (typeof raw === "string") size = JSON.parse(raw); } catch {}
          if (typeof size.w !== "number" || typeof size.h !== "number") throw new CommandError("unavailable", "The browser page could not be read");
          const x = String(Math.round(Math.min(1, Math.max(0, input.x)) * (size.w - 1))), y = String(Math.round(Math.min(1, Math.max(0, input.y)) * (size.h - 1)));
          await run(["mouse", "move", x, y]); await run(["mouse", "down"]); await run(["mouse", "up"]);
          return;
        }
        case "text":
          // The owner may type a password here: it travels over stdin (a one-command batch), never in argv,
          // which also keeps text such as "--json" from being read as an agent-browser flag.
          try { await run(["batch", "--bail", "--omit-command"], { stdin: JSON.stringify([["keyboard", "inserttext", input.text]]), batch: true }); }
          // Even a failed batch may have typed part of the text.
          finally { await this.protectOwnerInput(session, input.text); }
          return;
        case "key": await run(["press", input.key]); return;
        case "scroll": await run(["scroll", input.dy < 0 ? "up" : "down", String(Math.min(10_000, Math.max(1, Math.round(Math.abs(input.dy)))))]); return;
        case "navigate": await run([input.action]); return;
      }
    });
  }
  endHandoff(ref: BrowserSessionRef) {
    return this.enqueueSession(ref, async (session) => {
      // A live-view handoff never left headless mode: the Ghost continues on the page the owner left. A session
      // lost to a host restart is new and empty either way, so there is nothing to reopen.
      if (!session.headed && session.handoffUrl === null) return { fallback: false };
      if (session.headed) {
        try {
          const current = await this.invoke(session, ["get", "url"]);
          const url = typeof current.data === "string" ? current.data : current.data && typeof current.data === "object" && "url" in current.data ? current.data.url : null;
          if (!current.ok || typeof url !== "string") throw new Error("No headed page URL");
          if (url !== "about:blank") await assertFetchableUrl(url, "handoff page URL");
          session.handoffUrl = url;
          session.handoffFallback = false;
        } catch {
          session.handoffUrl = "about:blank";
          session.handoffFallback = true;
        }
        if (!(await this.invoke(session, ["close"])).ok) throw new CommandError("unavailable", "Could not save browser handoff state");
        session.headed = false;
        session.lockedTabs.clear();
        this.clearFiles(session);
      }
      // Retain the captured URL on this session: a failed reopen can be explicitly retried.
      if (!(await this.invoke(session, ["open", session.handoffUrl!])).ok) throw new CommandError("unavailable", "Could not resume the browser headlessly");
      return { fallback: session.handoffFallback };
    });
  }
  close(ref: BrowserSessionRef) {
    return this.enqueueSession(ref, async (session) => {
      if (!(await this.invoke(session, ["close"])).ok) throw new CommandError("unavailable", "Could not close browser session");
      this.clearFiles(session);
      this.sessions.delete(ref.conversationId);
    });
  }
  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
    this.shutdownPromise = Promise.allSettled([...this.sessionQueues.values()]).then(() => this.enqueue(async () => {
      let failure: unknown;
      for (const [id, session] of this.sessions) {
        try {
          if (!(await this.invoke(session, ["close"])).ok) throw new Error("Browser session did not close");
          this.clearFiles(session);
          this.sessions.delete(id);
        } catch (error) { failure = error; }
      }
      if (this.proxy) { await (await this.proxy).close(); this.proxy = null; }
      if (failure) throw failure;
      // Every session of this root is closed; its ephemeral socket directory goes with them.
      rmSync(this.socketDir, { recursive: true, force: true });
    })).catch((error) => {
      this.shutdownPromise = null;
      throw error;
    });
    return this.shutdownPromise;
  }
}
