import { randomBytes, createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, linkSync, unlinkSync, readFileSync, writeFileSync, statSync, lstatSync, readdirSync, rmSync, realpathSync, openSync, closeSync, fstatSync, readSync, constants as FS } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "../config.ts";
import { CommandError } from "../core/errors.ts";
import { NoEffect, KnownOutcome } from "../core/effects.ts";
import type { BrowserCommandResult, BrowserLiveInput, BrowserLiveEvent, BrowserLogin, BrowserPort, BrowserRunOptions, BrowserSessionRef, VaultField } from "./ports.ts";
import { createEgressProxy, type EgressProxy } from "./egress-proxy.ts";
import { assertFetchableUrl } from "./netguard.ts";
import { startObscura, type ObscuraProcess } from "./obscura.ts";
import { confineDirChain, readFileNoFollow } from "../sandbox/workspace-env.ts";
import { LoginCapture, type LoginEdit, type LoginPage } from "./login-capture.ts";
import { ChromeLoginObserver, type LoginObserver } from "./browser-login.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CAP = 512 * 1024;
const MAX_SESSIONS = 4;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_DOWNLOAD_FILES = 32;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const KEY_CODES: Readonly<Record<string,number>> = { Enter:13, Tab:9, Backspace:8, Delete:46, Escape:27, ArrowLeft:37, ArrowUp:38, ArrowRight:39, ArrowDown:40, Home:36, End:35 };
const NETWORK_INIT = `(() => {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate"]) {
    Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
  }
})();`;
// Neither raw CDP keyDown nor agent-browser press Meta+A performs Mac editing selection.
// Owner-only static action; stdin keeps the boundary fixed and the response contains no form values.
const SELECT_ALL_SCRIPT = `(() => { try {
  const e = document.activeElement;
  if (!e || e.disabled) return "refused:not_editable";
  if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) {
    e.select(); return "filled";
  }
  let root = e;
  if (e.isContentEditable) while (root.parentElement?.isContentEditable) root = root.parentElement;
  else if (e !== document.body && e !== document.documentElement) return "refused:not_editable";
  const selection = window.getSelection();
  if (!selection) return "refused:not_editable";
  const range = document.createRange(); range.selectNodeContents(root);
  selection.removeAllRanges(); selection.addRange(range);
  return "filled";
} catch { return "refused:not_editable"; } })()`;
interface LiveBridge {
  socket?: WebSocket;
  connecting?: Promise<WebSocket>;
  subscribers: Set<(event: BrowserLiveEvent) => void>;
  width: number; height: number; page?: Extract<BrowserLiveEvent, { type: "page" }>;
  frame?: Extract<BrowserLiveEvent, { type: "frame" }>;
  targetId?: string;
  retry?: ReturnType<typeof setTimeout>;
}
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
  secrets: { variants: string[]; cardPattern?: RegExp; ownerScope?: string }[];
  ownerRedactions?: Map<string,{variants:string[];ownerScope?:string}>;
  screenshotsBlocked: boolean;
  passwordScreenshots: Map<string, string>;
  active: boolean;
  bridge?: LiveBridge;
  notice?: string;
  login?: LoginCapture;
  captureArmed?: boolean;
  modelPasswords?: Set<string>;
  loginObserver?: LoginObserver;
  loginBootstrapping?: boolean;
  loginStarting?: Promise<void>;
  loginEpoch?: number;
  modelCaptureDepth?: number;
  ownerCaptureDepth?: number;
  captureTimer?: ReturnType<typeof setTimeout>;
  headedPoll?: ReturnType<typeof setInterval>;
  ownerQueue?: Promise<unknown>;
  secretGate?: Promise<void>;
  ownerBusy?: Promise<unknown>;
  promoting?: boolean;
  ownerGeneration?: number;
  ownerViewport?: { width: number; height: number };
}

export function createBrowser(config: Config, deps: { root: string; onLogin?: (ref: BrowserSessionRef, login: BrowserLogin) => Promise<string | void> | string | void }): BrowserPort | null {
  if (!config.browser) return null;
  return new AgentBrowser(config.browser, deps.root, deps.onLogin);
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
  private readonly sessionMap = new Map<string, Session>();
  private proxy: Promise<EgressProxy> | null = null;
  /** Admission is serialized; independent conversations may run concurrently. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly sessionQueues = new Map<string, Promise<unknown>>();
  private available = Promise.withResolvers<void>();
  private stopping = false;
  private initialized = false;
  private shutdownPromise: Promise<void> | null = null;
  constructor(private readonly config: NonNullable<Config["browser"]>, private readonly root: string, private readonly onLogin?: (ref: BrowserSessionRef, login: BrowserLogin) => Promise<string | void> | string | void) {
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
    this.socketDir = `/tmp/ghost-browser-${rootHash.slice(0, 16)}`;
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
    if (!socketDir.isDirectory() || socketDir.isSymbolicLink() || socketDir.uid !== process.getuid?.() || (socketDir.mode & 0o077) !== 0) throw new Error("Unsafe browser socket directory");
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
    this.disconnect(session, "download_limit");
    this.sessionMap.delete(session.ref.conversationId);
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
    if (session.bridge && ["open", "back", "forward", "reload", "close"].includes(argv[0]!)) session.bridge.frame = undefined;
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
        try { session.obscura = await startObscura(expand(executable), proxy.url, this.root); }
        catch (error) { session.engine = undefined; throw error; }
        session.secrets = [];
        session.screenshotsBlocked = false;
        session.passwordScreenshots.clear();
      }
    }
    if (argv[0] === "close") {
      session.loginEpoch = (session.loginEpoch ?? 0) + 1;
      session.loginStarting = undefined;
      session.loginObserver?.close(); session.loginObserver = undefined; session.login?.clear(); session.login = undefined;
      session.secrets = session.secrets.filter(entry => !entry.ownerScope); session.ownerRedactions?.clear();
    } else if (!obscura && this.onLogin && !session.loginObserver && !session.loginBootstrapping) {
      // Install Chrome's isolated preload on a blank document before any site's own scripts run.
      // --restore and the network init still apply to this bootstrap just as to the real navigation.
      session.loginBootstrapping = true;
      try {
        if (!(await this.invokeCli(session, ["open", "about:blank"])).ok) throw new CommandError("unavailable", "Could not initialize trusted browser input capture");
        await this.ensureLogin(session);
      } finally { session.loginBootstrapping = false; }
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
            if (this.sessionMap.get(session.ref.conversationId) !== session) return;
            void this.enqueueSession(session.ref, async (current) => {
              if (current === session && session.obscuraIdle === idle) {
                await this.invoke(session, ["close"]);
                this.disconnect(session, "idle_timeout"); this.clearFiles(session);
                this.sessionMap.delete(session.ref.conversationId);
              }
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
      const orphan: Session = { ref, headed: false, handoffUrl: null, handoffFallback: false, secrets: [], screenshotsBlocked: false, passwordScreenshots: new Map(), active: false };
      if (!(await this.invoke(orphan, ["close", "--all"])).ok) throw new CommandError("unavailable", "Could not close interrupted browser sessions");
      this.initialized = true;
      for (const name of ["downloads", "staging"]) rmSync(join(this.root, "browser", name), { recursive: true, force: true });
    }
    const existing = this.sessionMap.get(ref.conversationId);
    if (existing && existing.ref.ghostId !== ref.ghostId) throw new CommandError("forbidden", "Browser session owner changed");
    while (!existing && this.sessionMap.size >= MAX_SESSIONS) {
      const idle = [...this.sessionMap].find(([, session]) => !session.active);
      if (!idle) { await this.available.promise; continue; }
      const [id, victim] = idle;
      const closed = await this.invoke(victim, ["close"]);
      if (!closed.ok) throw new CommandError("unavailable", "Browser session eviction failed");
      this.disconnect(victim, "evicted");
      this.clearFiles(victim);
      this.sessionMap.delete(id);
    }
    const session: Session = existing ?? { ref, headed: false, handoffUrl: null, handoffFallback: false, secrets: [], screenshotsBlocked: false, passwordScreenshots: new Map(), active: false };
    session.active = true;
    this.sessionMap.delete(ref.conversationId);
    this.sessionMap.set(ref.conversationId, session);
    return session;
  }
  assertVaultFill(ref: BrowserSessionRef, field: VaultField, origin: string) {
    if (this.sessionMap.get(ref.conversationId)?.engine === "obscura" &&
      (!["username", "password", "totp"].includes(field) || !this.config.obscura?.loginOrigins?.includes(origin))) {
      throw new NoEffect("Vault login is unavailable on this Obscura site");
    }
  }
  run(ref: BrowserSessionRef, argv: string[], options?: BrowserRunOptions) {
    return this.enqueueSession(ref, async (session) => this.withModelCapture(session, async () => {
      if (session.captureArmed && !session.secretGate) {
        await session.ownerBusy;
        await this.capture(session);
      }
      if (options?.engine) {
        if (argv[0] !== "open" || session.engine && session.engine !== options.engine) throw new NoEffect("Close the browser session before choosing a different engine");
        if (options.engine === "obscura" && !this.supportsObscura) throw new NoEffect("Obscura is not configured");
      }
      session.engine ??= options?.engine ?? "chrome";
      if (session.engine === "obscura" && options?.transfer) throw new NoEffect("Obscura file transfers are unavailable");
      if (options?.sensitive) {
        session.captureArmed = false;
        session.login?.clear();
        if (options.sensitive.field === "password") (session.modelPasswords ??= new Set()).add(options.sensitive.value);
        const { value, field } = options.sensitive;
        this.assertVaultFill(ref, field, options.sensitive.origin);
        for (const entry of session.secrets) if (entry.ownerScope && entry.variants.includes(value)) entry.ownerScope = undefined;
        if (value && !session.secrets.some((entry) => entry.variants.includes(value) && (field !== "card_number" || entry.cardPattern !== undefined))) {
          const json = JSON.stringify(value).slice(1, -1);
          const html = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
          let encoded = value;
          try { encoded = encodeURIComponent(value); } catch {}
          const variants = [...new Set([value, encoded, encoded.replaceAll("%20", "+"), html, html.replaceAll("&#39;", "&#x27;"), json])].sort((a, b) => b.length - a.length);
          const digits = field === "card_number" ? value.replace(/\D/g, "") : "";
          session.secrets.push({ variants, ...(digits ? { cardPattern: new RegExp(digits.split("").join("[\\s-]*"), "g") } : {}) });
        }
        if (field.startsWith("card_") || field === "value") session.screenshotsBlocked = true;
        if (field === "password") {
          const tab = this.activeTab((await this.invoke(session, ["tab", "list"])).data);
          if (!tab) throw new CommandError("forbidden", "Secret fill refused (not_password_field)");
          session.passwordScreenshots.set(tab.id, tab.url);
        }
      }
      if (argv[0] === "screenshot") {
        if (session.screenshotsBlocked) throw new CommandError("forbidden", "Screenshots are disabled after a card or secret-value fill; close the browser session to reset");
        if (session.passwordScreenshots.size) {
          const tab = this.activeTab((await this.invoke(session, ["tab", "list"])).data);
          if (!tab || session.passwordScreenshots.get(tab.id) === tab.url) throw new CommandError("forbidden", "Screenshots are disabled after a password fill until that tab's URL changes");
          if (tab) session.passwordScreenshots.delete(tab.id);
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
      if (argv[0] === "close" && result.ok) { this.disconnect(session, "closed"); this.clearFiles(session); this.sessionMap.delete(ref.conversationId); }
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
    }));
  }
  sessions() { return [...this.sessionMap.values()].map((s) => ({ ...s.ref, engine: s.engine ?? "chrome" as const, headed: s.headed })); }
  private existing(ref: BrowserSessionRef) {
    const session = this.sessionMap.get(ref.conversationId);
    if (!session || session.ref.ghostId !== ref.ghostId) throw new CommandError("not_found", "Browser session not found");
    return session;
  }
  takeNotice(ref: BrowserSessionRef) {
    const session = this.sessionMap.get(ref.conversationId), notice = session?.notice ?? null;
    if (session) session.notice = undefined;
    return notice;
  }
  async exclusive<T>(ref: BrowserSessionRef, perform: () => Promise<T>): Promise<T> {
    const session = this.existing(ref);
    while (session.secretGate) await session.secretGate;
    const gate = Promise.withResolvers<void>(); session.secretGate = gate.promise;
    try { await session.ownerBusy; return await perform(); }
    finally { session.secretGate = undefined; gate.resolve(); await session.loginObserver?.updateMode?.(); }
  }
  private registerSecret(session: Session, value: string, scope?: string) {
    if (scope) {
      const previous = session.ownerRedactions?.get(scope);
      if (previous?.ownerScope === scope) { const index = session.secrets.indexOf(previous); if (index >= 0) session.secrets.splice(index,1); }
    }
    if (!value) return;
    const existing = session.secrets.find(entry => entry.variants.includes(value));
    if (existing) { if (!scope) existing.ownerScope = undefined; return; }
    const html = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    let encoded = value; try { encoded = encodeURIComponent(value); } catch {}
    const entry = { variants:[...new Set([value, encoded, encoded.replaceAll("%20", "+"), html, html.replaceAll("&#39;", "&#x27;"), JSON.stringify(value).slice(1,-1)])].sort((a,b) => b.length-a.length), ...(scope ? {ownerScope:scope} : {}) };
    session.secrets.push(entry);
    if (scope) (session.ownerRedactions ??= new Map()).set(scope,entry);
  }
  private async withModelCapture<T>(session: Session, perform: () => Promise<T>): Promise<T> {
    session.modelCaptureDepth = (session.modelCaptureDepth ?? 0) + 1;
    try { await session.loginObserver?.updateMode?.(); return await perform(); }
    finally { session.modelCaptureDepth = (session.modelCaptureDepth ?? 1) - 1; await session.loginObserver?.updateMode?.(); }
  }
  private ownerActivity(session: Session) {
    const activity = "The owner used this browser. Cached refs and observations were discarded; take a fresh browser_snapshot before acting.";
    if (!session.notice?.includes(activity)) session.notice = `${session.notice ?? ""}\n${activity}`.trim();
  }
  private async ensureLogin(session: Session) {
    if (!this.onLogin || session.engine === "obscura" || session.loginObserver) return;
    if (session.loginStarting) return session.loginStarting;
    const starting = this.startLogin(session);
    session.loginStarting = starting;
    try { await starting; } finally { if (session.loginStarting === starting) session.loginStarting = undefined; }
  }
  private async startLogin(session: Session) {
    const epoch = session.loginEpoch ?? 0;
    const capture = session.login ??= new LoginCapture(async (login) => {
      if (epoch !== (session.loginEpoch ?? 0)) return;
      const id = await this.onLogin!(session.ref, login);
      if (id) session.notice = `${session.notice ?? ""}\nThe owner's login was saved to vault item ${id}. Use browser_fill_secret for this login.`.trim();
    }, (value,scope) => { if (epoch === (session.loginEpoch ?? 0)) this.registerSecret(session,value,scope); }, password => session.modelPasswords?.has(password) === true);
    const result = await this.invokeCli(session,["get","cdp-url"]);
    if (!result.ok || !result.data || typeof result.data !== "object" || !("cdpUrl" in result.data) || typeof result.data.cdpUrl !== "string") throw new CommandError("unavailable","Trusted Chrome input capture is unavailable");
    const observer = await ChromeLoginObserver.start(result.data.cdpUrl,capture,{
      nativeAllowed: () => epoch === (session.loginEpoch ?? 0) && session.headed && !session.modelCaptureDepth && !session.ownerCaptureDepth && !session.secretGate && !this.stopping,
      isCurrent: () => epoch === (session.loginEpoch ?? 0) && session.headed && !this.stopping,
      ownerApiActive: () => epoch === (session.loginEpoch ?? 0) && !!session.ownerCaptureDepth,
      activity: () => { if (epoch === (session.loginEpoch ?? 0)) { session.captureArmed = true; this.ownerActivity(session); } },
      password: page => { if (epoch === (session.loginEpoch ?? 0)) session.passwordScreenshots.set(page.targetId,page.url); },
      windowClosed: () => { if (epoch === (session.loginEpoch ?? 0) && session.headed) void this.resumeClosedWindow(session).catch(() => {}); },
    });
    if (epoch !== (session.loginEpoch ?? 0) || this.stopping) { observer.close(); throw new CommandError("unavailable","Browser input session changed"); }
    session.loginObserver = observer;
  }
  private async capture(session: Session, finished = false) {
    if (!this.onLogin || !session.captureArmed && !finished) return;
    let page: LoginPage | null = null;
    try {
      await this.ensureLogin(session);
      page = await session.loginObserver!.snapshot(session.bridge?.targetId);
    } catch {
      if (!finished) { session.login?.clear(); throw new CommandError("unavailable","Trusted browser login capture is unavailable"); }
    }
    if (this.sessionMap.get(session.ref.conversationId) === session) await session.login?.observe(page,finished);
  }
  private scheduleCapture(session: Session) {
    clearTimeout(session.captureTimer);
    session.captureTimer = setTimeout(() => {
      session.ownerQueue = (session.ownerQueue ?? Promise.resolve()).then(async () => {
        while (session.secretGate) await session.secretGate;
        if (this.sessionMap.get(session.ref.conversationId) !== session) return;
        session.ownerBusy = this.capture(session);
        try { await session.ownerBusy; } finally { session.ownerBusy = undefined; }
      }).catch(() => {});
    }, 450).unref();
  }
  private disconnect(session: Session, reason?: string) {
    const bridge = session.bridge;
    if (bridge) {
      clearTimeout(bridge.retry);
      bridge.frame = undefined; bridge.targetId = undefined;
      const socket = bridge.socket; bridge.socket = undefined; socket?.close();
      if (reason) {
        for (const sink of bridge.subscribers) sink({ type: "end", reason });
        bridge.subscribers.clear(); session.bridge = undefined;
      }
    }
    if (reason && reason !== "engine_changed") {
      clearTimeout(session.captureTimer); clearInterval(session.headedPoll);
      session.loginEpoch = (session.loginEpoch ?? 0) + 1; session.loginStarting = undefined;
      session.loginObserver?.close(); session.loginObserver = undefined;
      session.login?.clear(); session.login = undefined; session.secrets = []; session.notice = undefined;
      session.modelPasswords?.clear(); session.captureArmed = false;
      session.ownerRedactions?.clear();
    }
  }
  private async resumeClosedWindow(session: Session) {
    if (!session.headed || this.sessionMap.get(session.ref.conversationId) !== session) return;
    let url = session.bridge?.page?.url ?? session.handoffUrl ?? "about:blank";
    if (session.secrets.some(secret => secret.variants.some(value => value && url.includes(value)))) url = "about:blank";
    session.headed = false; clearInterval(session.headedPoll);
    session.promoting = true; session.ownerGeneration = (session.ownerGeneration ?? 0) + 1;
    session.loginEpoch = (session.loginEpoch ?? 0) + 1; session.loginStarting = undefined;
    session.login?.clear(); // Closing a window is never an assertion that a login succeeded.
    this.disconnect(session,"engine_changed");
    try {
      await this.enqueueSession(session.ref,async current => {
        if (current !== session) return;
        await session.ownerBusy;
        if (url !== "about:blank") await assertFetchableUrl(url,"closed window URL");
        if (!(await this.invoke(session,["close"])).ok) throw new Error("Window close failed");
        if (this.stopping || this.sessionMap.get(session.ref.conversationId) !== session) return;
        if (!(await this.invoke(session,["open",url])).ok) throw new Error("Window resume failed");
        if (session.ownerViewport && !(await this.invoke(session,["set","viewport",String(session.ownerViewport.width),String(session.ownerViewport.height)])).ok) throw new Error("Window viewport restore failed");
      });
    } catch {
      this.disconnect(session,"window_closed"); this.clearFiles(session); this.sessionMap.delete(session.ref.conversationId);
    } finally { session.promoting = false; }
  }
  private connect(session: Session): Promise<WebSocket> {
    if (session.promoting) return Promise.reject(new CommandError("conflict","브라우저를 전환하고 있어요. 새 화면을 기다려 주세요"));
    const bridge = session.bridge ??= { subscribers: new Set(), width: 0, height: 0 };
    if (bridge.connecting) return bridge.connecting;
    if (bridge.socket?.readyState === WebSocket.OPEN) return Promise.resolve(bridge.socket);
    bridge.frame = undefined;
    bridge.connecting = (async () => {
      const status = await this.invoke(session, ["stream", "status"], { timeoutMs: 5000 });
      if (session.promoting || session.bridge !== bridge) throw new CommandError("conflict","브라우저가 바뀌었어요. 새 화면을 기다려 주세요");
      const port = status.data && typeof status.data === "object" && "port" in status.data ? status.data.port : null;
      if (!status.ok || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new CommandError("unavailable", "Browser stream is unavailable");
      const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
      // No Origin header: agent-browser deliberately refuses browser-page clients.
      const socket = new WebSocket(`ws://127.0.0.1:${port}/?maxFps=15`); bridge.socket = socket;
      const timeout = setTimeout(() => { socket.close(); reject(new CommandError("unavailable", "Browser stream timed out")); }, 5000);
      socket.onerror = () => { clearTimeout(timeout); reject(new CommandError("unavailable", "Browser stream failed")); };
      socket.onmessage = (message) => {
        if (bridge.socket !== socket) return;
        if (typeof message.data !== "string" || message.data.length > 12 * 1024 * 1024) return;
        try {
          const event = JSON.parse(String(message.data));
          if (event.type === "status") {
            if (bridge.frame && (Number.isFinite(event.viewportWidth) && event.viewportWidth > 0 && event.viewportWidth !== bridge.frame.width || Number.isFinite(event.viewportHeight) && event.viewportHeight > 0 && event.viewportHeight !== bridge.frame.height)) bridge.frame = undefined;
            if (Number.isFinite(event.viewportWidth) && event.viewportWidth > 0) bridge.width = event.viewportWidth;
            if (Number.isFinite(event.viewportHeight) && event.viewportHeight > 0) bridge.height = event.viewportHeight;
            if (bridge.width && bridge.height) { clearTimeout(timeout); resolve(socket); }
          } else if (event.type === "tabs" && Array.isArray(event.tabs)) {
            const tab = event.tabs.find((tab: { active?: boolean }) => tab.active);
            if (!event.tabs.length && bridge.page) {
              if (session.headed) void this.resumeClosedWindow(session).catch(() => {});
              else { this.disconnect(session, "session_ended"); this.sessionMap.delete(session.ref.conversationId); this.clearFiles(session); }
              return;
            }
            if (tab && typeof tab.url === "string" && typeof tab.title === "string") {
              const targetId = typeof tab.targetId === "string" ? tab.targetId.slice(0,128) : undefined;
              const url = tab.url.slice(0,8192);
              if (bridge.page && bridge.page.url !== url || bridge.targetId !== undefined && bridge.targetId !== targetId) bridge.frame = undefined;
              bridge.targetId = targetId;
              bridge.page = { type: "page", url, title: tab.title.slice(0,512) };
              for (const sink of bridge.subscribers) sink(bridge.page);
            }
          } else if (event.type === "frame" && typeof event.data === "string" && event.data.length > 0 && event.data.length <= Math.ceil(8 * 1024 * 1024 * 4 / 3) && /^[A-Za-z0-9+/]*={0,2}$/.test(event.data) && bridge.width && bridge.height) {
            // Damage-driven engines may remain static between viewers: retain exactly one bounded frame.
            bridge.frame = { type: "frame", data: event.data, width: bridge.width, height: bridge.height };
            for (const sink of bridge.subscribers) sink(bridge.frame);
          }
        } catch { /* Malformed upstream messages are never observations. */ }
      };
      socket.onclose = () => {
        clearTimeout(timeout); reject(new CommandError("unavailable", "Browser stream closed"));
        if (bridge.socket !== socket) return;
        bridge.frame = undefined;
        bridge.socket = undefined; this.retryStream(session);
      };
      return await promise;
    })().finally(() => { bridge.connecting = undefined; });
    return bridge.connecting;
  }
  private retryStream(session: Session) {
    const bridge = session.bridge;
    if (!bridge || !bridge.subscribers.size && !session.headed || this.stopping || this.sessionMap.get(session.ref.conversationId) !== session) return;
    clearTimeout(bridge.retry);
    bridge.retry = setTimeout(() => { void this.connect(session).catch(() => this.retryStream(session)); }, 750).unref();
  }
  async live(ref: BrowserSessionRef, options: { maxFps: number }, sink: (event: BrowserLiveEvent) => void) {
    const session = this.existing(ref);
    if (session.promoting) throw new CommandError("conflict","브라우저를 전환하고 있어요. 새 화면을 기다려 주세요");
    const bridge = session.bridge ??= { subscribers: new Set(), width: 0, height: 0 };
    if (bridge.subscribers.size >= 4) throw new CommandError("conflict", "At most four live clients may watch a browser session");
    let lastFrame = Number.NEGATIVE_INFINITY, receivedFrame = false;
    const subscriber = (event: BrowserLiveEvent) => {
      if (event.type === "frame") { const now = performance.now(); if (now - lastFrame < 1000 / options.maxFps) return; lastFrame = now; receivedFrame = true; }
      sink(event);
    };
    bridge.subscribers.add(subscriber);
    try { await this.connect(session); } catch (error) { bridge.subscribers.delete(subscriber); throw error; }
    if (bridge.page) sink(bridge.page);
    if (bridge.frame && !receivedFrame) subscriber(bridge.frame);
    return () => { bridge.subscribers.delete(subscriber); };
  }
  input(ref: BrowserSessionRef, input: BrowserLiveInput): Promise<void> {
    const session = this.existing(ref), generation = session.ownerGeneration ?? 0;
    if (session.promoting) return Promise.reject(new CommandError("conflict","브라우저를 전환하고 있어요. 새 화면을 기다려 주세요"));
    const next = (session.ownerQueue ?? Promise.resolve()).then(async () => {
      while (session.secretGate) await session.secretGate;
      this.existing(ref);
      if (session.promoting || generation !== (session.ownerGeneration ?? 0)) throw new CommandError("conflict","브라우저가 바뀌었어요. 새 화면에서 다시 선택해 주세요");
      if (input.type === "viewport") {
        session.ownerBusy = this.invoke(session,["set","viewport",String(input.width),String(input.height)]).then(result => {
          if (!result.ok) throw new CommandError("unavailable","Browser viewport could not resize");
          session.ownerViewport = { width: input.width, height: input.height };
          if (session.bridge) session.bridge.frame = undefined;
          session.notice = `${session.notice ?? ""}\nThe owner resized the browser. Cached refs and observations were discarded; take a fresh browser_snapshot before acting.`.trim();
        });
        try { await session.ownerBusy; } finally { session.ownerBusy = undefined; }
        return;
      }
      if (session.engine === "obscura") {
        await this.handoff(ref,null,{headed:false});
        throw new CommandError("conflict","안전한 Chrome 브라우저로 전환했어요. 새 화면에서 다시 선택해 주세요");
      }
      const perform = async () => {
        this.ownerActivity(session);
        session.captureArmed = true;
        session.ownerCaptureDepth = (session.ownerCaptureDepth ?? 0) + 1;
        try {
          await this.ensureLogin(session);
          await session.loginObserver?.updateMode?.();
          const observes = input.type === "text" || input.type === "key" && input.event === "down" || input.type === "mouse" && input.event === "down";
          const before = observes && session.loginObserver ? await session.loginObserver.snapshot(session.bridge?.targetId,input.type === "mouse" ? {x:input.x,y:input.y} : undefined) : null;
          if (this.onLogin && observes && !before) throw new CommandError("unavailable","Trusted browser input metadata is unavailable");
          const focused = before?.fields.find(field => field.id === before.focused);
          const clicked = before?.fields.find(field => field.id === before.clicked);
          if (before && (input.type === "key" && input.event === "down" && input.key === "Enter" || clicked?.kind === "submit")) session.login?.submit(before,(clicked?.kind === "submit" ? clicked : focused)?.form ?? "");
          const inserted = input.type === "text" ? input.text : input.type === "key" && input.event === "down" ? input.text : undefined;
          let edit: LoginEdit | null = inserted !== undefined ? {type:"insert",text:inserted} : null;
          if (input.type === "key" && input.event === "down" && (input.key === "Backspace" || input.key === "Delete")) edit = (input.modifiers ?? 0)&7 ? {type:"unknown"} : {type:input.key === "Backspace" ? "backspace" : "delete"};
          if (before && focused && edit) {
            session.login?.edit(before,focused,edit);
            if (focused.kind === "password") session.passwordScreenshots.set(before.targetId,before.url);
          }
          if (input.type === "navigate" || input.type === "text") {
            const result = input.type === "navigate" ? await this.invoke(session, [input.action])
              : await this.invoke(session, ["batch", "--bail", "--omit-command"], { stdin: JSON.stringify([["keyboard", "inserttext", input.text]]), batch: true });
            if (!result.ok) throw new CommandError("unavailable", "Browser input failed");
          } else if (input.type === "key" && input.event === "down" && input.key.toLowerCase() === "a" && ((input.modifiers ?? 0) & 6) !== 0 && ((input.modifiers ?? 0) & 9) === 0) {
            const selected = session.engine === "chrome" && session.loginObserver ? await session.loginObserver.selectAll?.(session.bridge?.targetId) : (await this.invoke(session,["eval","--stdin"],{stdin:SELECT_ALL_SCRIPT})).ok;
            if (!selected) throw new CommandError("unavailable", "Browser selection is unavailable on the focused element");
          } else {
            const socket = await this.connect(session), bridge = session.bridge!;
            const keyObserved = input.type === "key" && input.event === "down" ? session.loginObserver?.ownerKey?.(input.key) : undefined;
            socket.send(JSON.stringify(input.type === "mouse" ? {
              type: "input_mouse", eventType: { down: "mousePressed", up: "mouseReleased", move: "mouseMoved", wheel: "mouseWheel" }[input.event],
              x: Math.min(bridge.width, Math.max(0, input.x)), y: Math.min(bridge.height, Math.max(0, input.y)), button: input.button ?? (input.event === "move" || input.event === "wheel" ? "none" : "left"),
              clickCount: input.clickCount ?? 1, deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0, modifiers: input.modifiers ?? 0,
            } : { type: "input_keyboard", eventType: input.event === "down" ? "keyDown" : "keyUp", key: input.key, code: input.code, text: input.text ?? (input.event === "down" && input.key === "Enter" && !((input.modifiers ?? 0) & 7) ? "\r" : undefined), windowsVirtualKeyCode: input.keyCode ?? KEY_CODES[input.key], modifiers: input.modifiers ?? 0 }));
            await keyObserved;
          }
          if (observes) await this.capture(session);
          this.scheduleCapture(session);
        } catch (error) {
          session.login?.clear();
          throw error;
        } finally {
          session.ownerCaptureDepth = (session.ownerCaptureDepth ?? 1) - 1;
          await session.loginObserver?.updateMode?.();
        }
      };
      session.ownerBusy = perform();
      try { await session.ownerBusy; } finally { session.ownerBusy = undefined; }
    });
    session.ownerQueue = next.catch(() => {}); return next;
  }
  handoff(ref: BrowserSessionRef, url: string | null, options: { headed?: boolean } = {}) {
    this.existing(ref);
    return this.enqueueSession(ref, async (session) => {
      const headed = options.headed !== false;
      if (headed ? session.headed : session.engine === "chrome") return;
      session.promoting = true;
      session.ownerGeneration = (session.ownerGeneration ?? 0) + 1;
      let cookies: unknown = null;
      try {
        await session.ownerBusy;
        await session.bridge?.connecting?.catch(() => {});
        if (url === null) {
          const current = await this.invoke(session,["get","url"]);
          const raw = current.data && typeof current.data === "object" && "url" in current.data ? current.data.url : current.data;
          if (!current.ok || typeof raw !== "string") throw new CommandError("unavailable","Could not read the browser URL");
          url = raw;
        }
        if (url !== "about:blank") await assertFetchableUrl(url,"takeover page URL");
        if (session.secrets.some(secret => secret.variants.some(value => value && url!.includes(value)))) throw new CommandError("forbidden","Cannot reopen a URL containing a protected value");
        if (session.engine === "obscura") {
          const exported = await this.invoke(session, ["cookies", "get"]);
          if (!exported.ok) throw new CommandError("unavailable", "Could not migrate browser cookies");
          cookies = exported.data;
        } else if (session.captureArmed) await this.capture(session);
        this.disconnect(session,"engine_changed");
        if (!(await this.invoke(session, ["close"])).ok) throw new CommandError("unavailable", "Could not save browser state");
        // Obscura's CDP pages are connection-scoped and have no isolated realm. Owner interaction uses Chrome.
        // Cookies survive migration; DOM/localStorage/JS state cannot transfer. Chrome remains the session engine.
        session.engine = "chrome"; session.headed = headed; session.handoffUrl = headed ? url : null; session.handoffFallback = false;
        if (!(await this.invoke(session, ["open", cookies ? "about:blank" : url])).ok) throw new CommandError("unavailable", "Could not open the owner browser");
        if (cookies) {
          const staging = this.sessionDirs(session)[1]!; mkdirSync(staging, { recursive: true, mode: 0o700 });
          const path = join(staging, randomUUID());
          try {
            const data = typeof cookies === "object" && "cookies" in cookies ? cookies.cookies : cookies;
            writeFileSync(path, JSON.stringify({cookies:data,origins:[]}), { flag: "wx", mode: 0o600 });
            if (!(await this.invoke(session, ["state", "load", path])).ok) throw new CommandError("unavailable", "Could not restore browser cookies");
          } finally { rmSync(path, { force: true }); cookies = null; }
          if (!(await this.invoke(session, ["open", url])).ok) throw new CommandError("unavailable", "Could not open migrated page");
        }
        if (session.ownerViewport && !(await this.invoke(session,["set","viewport",String(session.ownerViewport.width),String(session.ownerViewport.height)])).ok) throw new CommandError("unavailable","Could not restore the owner viewport");
        if (headed) {
          session.captureArmed = true;
          await this.capture(session);
          session.headedPoll = setInterval(() => {
            if (session.secretGate || session.ownerBusy || session.active || this.stopping) return;
            session.ownerBusy = this.capture(session).finally(() => { session.ownerBusy = undefined; });
          }, 1500).unref();
        }
        session.notice = `${session.notice ?? ""}\nThe browser runtime changed. Cached refs and observations were discarded; take a fresh browser_snapshot before acting.`.trim();
      } finally { cookies = null; session.promoting = false; }
    });
  }
  endHandoff(ref: BrowserSessionRef) {
    return this.enqueueSession(ref, async (session) => {
      clearTimeout(session.captureTimer); clearInterval(session.headedPoll);
      await session.ownerBusy;
      await this.capture(session, true);
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
        this.disconnect(session);
        if (!(await this.invoke(session, ["close"])).ok) throw new CommandError("unavailable", "Could not save browser handoff state");
        session.headed = false;
        this.clearFiles(session);
      }
      // Retain the captured URL on this session: a failed reopen can be explicitly retried.
      if (!(await this.invoke(session, ["open", session.handoffUrl!])).ok) throw new CommandError("unavailable", "Could not resume the browser headlessly");
      if (session.ownerViewport && !(await this.invoke(session,["set","viewport",String(session.ownerViewport.width),String(session.ownerViewport.height)])).ok) throw new CommandError("unavailable","Could not restore the owner viewport");
      this.retryStream(session);
      return { fallback: session.handoffFallback };
    });
  }
  close(ref: BrowserSessionRef) {
    return this.enqueueSession(ref, async (session) => {
      try { await this.capture(session); } catch { session.login?.clear(); }
      if (!(await this.invoke(session, ["close"])).ok) throw new CommandError("unavailable", "Could not close browser session");
      this.disconnect(session, "closed");
      this.clearFiles(session);
      this.sessionMap.delete(ref.conversationId);
    });
  }
  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    for (const session of this.sessionMap.values()) this.disconnect(session, "shutdown");
    this.shutdownPromise = Promise.allSettled([...this.sessionQueues.values()]).then(() => this.enqueue(async () => {
      let failure: unknown;
      for (const [id, session] of this.sessionMap) {
        try {
          if (!(await this.invoke(session, ["close"])).ok) throw new Error("Browser session did not close");
          this.clearFiles(session);
          this.sessionMap.delete(id);
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
