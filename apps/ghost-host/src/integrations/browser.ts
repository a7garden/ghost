import { randomBytes, createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, linkSync, unlinkSync, readFileSync, writeFileSync, statSync, lstatSync, readdirSync, rmSync, realpathSync, openSync, closeSync, fstatSync, readSync, constants as FS } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "../config.ts";
import { CommandError } from "../core/errors.ts";
import { NoEffect, KnownOutcome } from "../core/effects.ts";
import type { BrowserCommandResult, BrowserLiveInput, BrowserLiveEvent, BrowserLogin, BrowserPort, BrowserRunOptions, BrowserSessionRef, VaultField } from "./ports.ts";
import { createEgressProxy, type EgressProxy } from "./egress-proxy.ts";
import { assertFetchableUrl } from "./netguard.ts";
import { startObscura, type ObscuraProcess } from "./obscura.ts";
import { confineDirChain, readFileNoFollow } from "../sandbox/workspace-env.ts";
import { LoginCapture, UnknownOwnerText, isPanLike, type LoginEdit, type LoginPage } from "./login-capture.ts";
import { ChromeLoginObserver, type LoginObserver } from "./browser-login.ts";
import { ChromeViewportFrames } from "./browser-frames.ts";
import { responsibleLauncher } from "./responsible.ts";

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
  subscribers: Map<(event: BrowserLiveEvent) => void, number>;
  maxFps: number;
  renderer?: ChromeViewportFrames;
  damage?: string;
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
  /** Tabs whose screenshots stay refused until their URL changes: a password fill or the owner's live-view text. */
  lockedTabs: Map<string, string>;
  active: boolean;
  bridge?: LiveBridge;
  notice?: string;
  login?: LoginCapture;
  captureArmed?: boolean;
  unknownOwnerText?: UnknownOwnerText;
  unknownNumericDigits?: Set<string>;
  unknownNumericPage?: string;
  unknownDigitCount?: number;
  modelPasswords?: Set<string>;
  loginObserver?: LoginObserver;
  loginNeedsRecovery?: "headless" | "native";
  loginResetPage?: boolean;
  loginRecovery?: Promise<void>;
  // Recovery isolation lasts for this Host Session, including later handoffs.
  // Explicit close/newSession is the existing reset boundary; old saved state is retained.
  privateRestoreKey?: string;
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
  private readonly chrome: string;
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
  /** Sessions an owner approval or handoff still depends on; see `retainWhile`. */
  private held: (ref: BrowserSessionRef) => boolean = () => false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
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
    // Chrome answers to macOS privacy itself; under the Host its updater looked like Ghost modifying apps.
    this.chrome = responsibleLauncher(base, "chrome-launch", expand(this.config.chrome ?? CHROME));
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
  private async invoke(session: Session, argv: string[], options?: { stdin?: string; timeoutMs?: number; batch?: boolean; authorize?: () => void }): Promise<BrowserCommandResult> {
    if (argv[0] !== "close" && (session.loginObserver?.ended || session.loginNeedsRecovery)) throw new CommandError("unavailable","Trusted browser observation ended; take a new explicit action to reconnect");
    if (["open","back","forward","reload","close"].includes(argv[0]!) || argv[0] === "tab" && argv[1] !== "list") session.unknownOwnerText?.reset();
    if (session.bridge && ["open", "back", "forward", "reload", "close"].includes(argv[0]!)) {
      session.bridge.frame = undefined; session.bridge.damage = undefined; session.bridge.renderer?.invalidate();
    }
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
        session.unknownNumericDigits?.clear();
        session.unknownNumericPage = undefined; session.unknownDigitCount = 0;
        session.screenshotsBlocked = false;
        session.lockedTabs.clear();
      }
    }
    if (argv[0] === "close") {
      session.loginResetPage = false;
      session.loginNeedsRecovery = undefined;
      session.loginEpoch = (session.loginEpoch ?? 0) + 1;
      session.loginStarting = undefined;
      session.loginObserver?.close(); session.loginObserver = undefined; session.login?.clear(); session.login = undefined;
      // Closing a runtime for handoff is not the end of its Host privacy session.
      for (const entry of session.secrets) entry.ownerScope = undefined;
      session.ownerRedactions?.clear();
    } else if (!obscura && (this.onLogin || session.headed || session.captureArmed) && !session.loginObserver && !session.loginBootstrapping) {
      // Install Chrome's isolated preload on a blank document before any site's own scripts run.
      // --restore and the network init still apply to this bootstrap just as to the real navigation.
      session.loginBootstrapping = true;
      try {
        if (!(await this.invokeCli(session, ["open", "about:blank"])).ok) throw new CommandError("unavailable", "Could not initialize trusted browser input capture");
        await this.ensureLogin(session);
      } finally { session.loginBootstrapping = false; }
    }
    // An awaited bootstrap may itself lose observation before the real command.
    if (argv[0] !== "close" && (session.loginObserver?.ended || session.loginNeedsRecovery)) throw new CommandError("unavailable","Trusted browser observation ended; take a new explicit action to reconnect");
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
              if (current === session && session.obscuraIdle === idle && !this.isHeld(session)) {
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
  private async invokeCli(session: Session, argv: string[], options?: { stdin?: string; timeoutMs?: number; batch?: boolean; authorize?: () => void }): Promise<BrowserCommandResult> {
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
      : ["--restore", session.privateRestoreKey ?? `ghost-${session.ref.ghostId}`,
      "--executable-path", this.chrome,
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
    options?.authorize?.();
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
      if (timedOut || exceeded) throw new CommandError("unavailable", timedOut ? "Browser command deadline exceeded; outcome may be unknown" : "Browser command output limit exceeded; outcome may be unknown");
      if (exit !== 0) {
        // CLI errors may echo selectors, page values or credentials. Recognize only
        // fixed categories; never forward raw stdout/stderr, even for ordinary reads.
        if (options?.stdin === undefined && !options?.batch) {
          let failure: unknown;
          try { failure = JSON.parse(out); } catch {}
          const reason = failure && typeof failure === "object" && "error" in failure ? failure.error : null;
          if (typeof reason === "string") {
            if (/^Selector '[\s\S]*' did not match any element$/.test(reason) || reason.startsWith("Element not found:"))
              throw new CommandError("not_found", "Browser selector matched no element; take a fresh snapshot and choose an existing selector");
            if (/^Element ref [\s\S]+ is stale/.test(reason) || /^Element is detached(?:$|[:.])/.test(reason))
              throw new CommandError("conflict", "Browser element is stale or detached; take a fresh snapshot before the next action");
          }
        }
        throw new CommandError("unavailable", `Browser command failed (exit ${exit}); outcome may be unknown`);
      }
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
    const existing = this.sessionMap.get(ref.conversationId);
    if (existing && existing.ref.ghostId !== ref.ghostId) throw new CommandError("forbidden", "Browser session owner changed");
    while (!existing && this.sessionMap.size >= MAX_SESSIONS) {
      const idle = [...this.sessionMap].find(([, session]) => !session.active && !this.isHeld(session));
      if (!idle) {
        if ([...this.sessionMap.values()].some((session) => session.active)) { await this.available.promise; continue; }
        throw new CommandError("unavailable", "Every browser session is waiting for the owner's approval or handoff; wait for an answer or close a browser session");
      }
      const [id, victim] = idle;
      const closed = await this.invoke(victim, ["close"]);
      if (!closed.ok) throw new CommandError("unavailable", "Browser session eviction failed");
      this.disconnect(victim, "evicted");
      this.clearFiles(victim);
      this.sessionMap.delete(id);
    }
    const session: Session = existing ?? { ref, headed: false, handoffUrl: null, handoffFallback: false, secrets: [], screenshotsBlocked: false, lockedTabs: new Map(), active: false };
    session.active = true;
    this.sessionMap.delete(ref.conversationId);
    this.sessionMap.set(ref.conversationId, session);
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
    return Promise.allSettled([...this.sessionMap.values()].filter((session) => !session.active && this.isHeld(session)).map((session) => this.touch(session))).then(() => {});
  }
  private isHeld(session: Session) {
    try { return this.held(session.ref); } catch { return false; }
  }
  /** A read that resets both idle timers; it never admits a session that was closed meanwhile. */
  private touch(session: Session) {
    return this.chain(session.ref, async () => {
      if (this.stopping || this.sessionMap.get(session.ref.conversationId) !== session || session.active) return;
      session.active = true;
      try { await this.invoke(session, ["get", "url"]); }
      finally { this.release(session); }
    });
  }
  assertVaultFill(ref: BrowserSessionRef, field: VaultField, origin: string) {
    if (this.sessionMap.get(ref.conversationId)?.engine === "obscura" &&
      (!["username", "password", "totp"].includes(field) || !this.config.obscura?.loginOrigins?.includes(origin))) {
      throw new NoEffect("Vault login is unavailable on this Obscura site");
    }
  }
  private protectValue(session: Session, value: string, field: VaultField): void {
    // A username is an identifier, not a secret: redacting it also hid every URL that carries it, so `currentUrl`
    // refused all later proposals and fills. 2026.11.11 : 아이디는 가리지 않는다.
    if (field !== "username") {
      for (const entry of session.secrets) if (entry.ownerScope && entry.variants.includes(value)) entry.ownerScope = undefined;
      if (value && !session.secrets.some(entry => entry.variants.includes(value) && (field !== "card_number" || entry.cardPattern !== undefined))) {
        const json = JSON.stringify(value).slice(1, -1);
        const html = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
        let encoded = value;
        try { encoded = encodeURIComponent(value); } catch {}
        const variants = [...new Set([value, encoded, encoded.replaceAll("%20", "+"), html, html.replaceAll("&#39;", "&#x27;"), json])].sort((a, b) => b.length - a.length);
        const digits = field === "card_number" ? value.replace(/\D/g, "") : "";
        session.secrets.push({ variants, ...(digits ? { cardPattern: new RegExp(digits.split("").join("[\\s-]*"), "g") } : {}) });
      }
    }
    if (field.startsWith("card_") || field === "value") session.screenshotsBlocked = true;
  }
  captureCredential(ref: BrowserSessionRef, input: { origin: string; ref?: string; selector?: string }): Promise<string> {
    return this.exclusive(ref, () => this.enqueueSession(ref, async session => this.withModelCapture(session, async () => {
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
    })));
  }
  run(ref: BrowserSessionRef, argv: string[], options?: BrowserRunOptions) {
    return this.enqueueSession(ref, async (session) => {
      if ((["click", "fill", "type", "press", "select", "check", "uncheck", "upload", "download"].includes(argv[0]!) || options?.sensitive) && !options?.authorize) throw new NoEffect("Browser mutation requires live Host authorization");
      options?.authorize?.();
      // This decision is already authoritative and needs no live Chrome state.
      // In particular, do not consult a closing/failed observer before denying
      // pixels that remain private across navigation and browser replacement.
      if (argv[0] === "screenshot" && session.screenshotsBlocked) throw new CommandError("forbidden","Screenshots are disabled after a card or secret-value fill; close the browser session to reset");
      return this.withModelCapture(session, async () => {
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
            options?.authorize?.();
            this.commitDownload(destination, staged);
          } catch { throw new KnownOutcome("Download could not be saved: existing destination or workspace symlink"); }
        }
      } finally { if (staged) rmSync(staged, { force: true }); }
      // Native owner input may arrive while the screenshot command is already in flight.
      if (argv[0] === "screenshot" && session.screenshotsBlocked) throw new CommandError("forbidden","Screenshots are disabled after a card or secret-value fill; close the browser session to reset");
      if (argv[0] === "close" && result.ok) { this.disconnect(session, "closed"); this.clearFiles(session); this.sessionMap.delete(ref.conversationId); }
      else if (result.ok) this.requestChromeFrame(session);
      if ((!session.secrets.length && !session.unknownNumericDigits?.size) || options?.stdin !== undefined || argv[0] === "screenshot") return result;
      const redactText = (text: string, protocol?: readonly {start:number;end:number}[]) => {
        let mask: Uint8Array | undefined;
        const mark = (current: Uint8Array | undefined, start: number, end: number) => {
          if (protocol) {
            let low=0, high=protocol.length;
            while (low<high) { const middle=(low+high)>>>1; if (protocol[middle]!.start<=start) low=middle+1; else high=middle; }
            const span=protocol[low-1];
            if (span && end<=span.end) return current;
          }
          const next=current ?? new Uint8Array(text.length);
          next.fill(1,start,end); return next;
        };
        // Unknown editors supply no trustworthy cursor/value metadata. A code can
        // be assembled from old and new fragments, never one inserted packet.
        // Keep this bounded privacy-only mask out of URL/operation authority checks.
        if (session.unknownNumericDigits?.size) for (const match of text.matchAll(/\d(?:[\d\s-]*\d)?/g)) {
          const digits = match[0].replace(/\D/g,"");
          for (const digit of session.unknownNumericDigits) if (digits.includes(digit)) { mask=mark(mask,match.index,match.index+match[0].length); break; }
        }
        // Match every secret against the original string. Replacement markers and protocol tokens
        // must never split a secret match or become input to another redaction pass.
        for (const secret of session.secrets) {
          for (const variant of secret.variants) if (variant) {
            for (let start = text.indexOf(variant); start >= 0; start = text.indexOf(variant,start+1)) mask=mark(mask,start,start+variant.length);
          }
          if (secret.cardPattern) for (const match of text.matchAll(secret.cardPattern)) mask=mark(mask,match.index,match.index+match[0].length);
        }
        if (!mask) return text;
        let output = "";
        for (let start=0;start<text.length;) {
          const hidden = mask[start] === 1;
          let end = start+1;
          while (end<text.length && (mask[end] === 1) === hidden) end++;
          output += hidden ? "[redacted]" : text.slice(start,end);
          start = end;
        }
        return output;
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
      let data: unknown;
      const native = result.data;
      if (command[0] === "snapshot" && result.ok) {
        const mismatch = () => new CommandError("unavailable","Browser snapshot attribution is missing or invalid; update the Host browser build");
        if (!native || typeof native !== "object" || !("snapshot" in native) || typeof native.snapshot !== "string" || !("refs" in native) || !native.refs || typeof native.refs !== "object" || Array.isArray(native.refs) || !("snapshotAttribution" in native)) throw mismatch();
        const tree=native.snapshot, attribution=native.snapshotAttribution, nativeRefs=native.refs;
        if (!attribution || typeof attribution !== "object" || !("version" in attribution) || attribution.version !== 1 || !("spans" in attribution) || !Array.isArray(attribution.spans)) throw mismatch();
        const spans=attribution.spans;
        const boundary = (position: number) => !(tree.charCodeAt(position-1)>=0xD800 && tree.charCodeAt(position-1)<=0xDBFF && tree.charCodeAt(position)>=0xDC00 && tree.charCodeAt(position)<=0xDFFF);
        let previousEnd=0;
        if (!spans.every((span: unknown): span is {start:number;end:number} => {
          if (!span || typeof span !== "object" || !("start" in span) || typeof span.start !== "number" || !("end" in span) || typeof span.end !== "number" || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start<previousEnd || span.end<=span.start || span.end>tree.length || !boundary(span.start) || !boundary(span.end)) return false;
          previousEnd=span.end; return true;
        })) throw mismatch();
        const refs: Record<string,{role:string;name:string}> = {};
        for (const [id,entry] of Object.entries(nativeRefs)) {
          if (!/^e[0-9]{1,30}$/.test(id) || !entry || typeof entry !== "object" || Object.keys(entry).some(key=>key !== "role" && key !== "name") || !("role" in entry) || typeof entry.role !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(entry.role) || !("name" in entry) || typeof entry.name !== "string") throw mismatch();
          refs[id]={role:entry.role,name:redactText(entry.name)};
        }
        if (Object.keys(refs).length && !spans.length && tree.length) throw mismatch();
        const entries: [string,unknown][] = [];
        for (const [key,value] of Object.entries(native)) {
          // Attribution is consumed here: its offsets would be stale after secret replacement.
          if (key === "snapshotAttribution") continue;
          if (key === "snapshot") entries.push([key,redactText(tree,spans)]);
          else if (key === "refs") entries.push([key,refs]);
          else if (key === "removedRefs") {
            if (!Array.isArray(value) || !value.every(ref=>typeof ref === "string" && /^@?e[0-9]{1,30}$/.test(ref))) throw mismatch();
            entries.push([key,value]);
          } else if (key === "origin") entries.push([key,redact(value)]);
          else entries.push([redactText(key),redact(value)]);
        }
        data=Object.fromEntries(entries);
      } else data=redact(result.data);
      return {ok:result.ok,data,error:result.error === null ? null : redactText(result.error)};
      });
    });
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
  private registerSecret(session: Session, value: string, scope?: string, sensitive = false) {
    if (scope) {
      const previous = session.ownerRedactions?.get(scope);
      if (previous?.ownerScope === scope) { const index = session.secrets.indexOf(previous); if (index >= 0) session.secrets.splice(index,1); }
    }
    if (!value) return;
    const digits = sensitive && /^[\d\s-]+$/.test(value) ? value.replace(/\D/g,"") : "";
    const cardPattern = digits.length >= 12 && digits.length <= 19 ? new RegExp(digits.split("").join("[\\s-]*"),"g") : undefined;
    const existing = session.secrets.find(entry => entry.variants.includes(value));
    if (existing) { if (!scope) existing.ownerScope = undefined; if (cardPattern) existing.cardPattern = cardPattern; return; }
    const html = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    let encoded = value; try { encoded = encodeURIComponent(value); } catch {}
    const entry = { variants:[...new Set([value, encoded, encoded.replaceAll("%20", "+"), html, html.replaceAll("&#39;", "&#x27;"), JSON.stringify(value).slice(1,-1)])].sort((a,b) => b.length-a.length), ...(scope ? {ownerScope:scope} : {}), ...(cardPattern ? {cardPattern} : {}) };
    session.secrets.push(entry);
    if (scope) (session.ownerRedactions ??= new Map()).set(scope,entry);
  }
  private protectOwnerValue(session: Session, value: string, scope?: string, sensitive = false) {
    if (isPanLike(value)) {
      this.protectValue(session,value,"card_number");
      const pattern = new RegExp(value.replace(/\D/g,"").split("").join("(?:[\\s+-]|%(?:20|0[9a-dA-D]|2[dDbB]))*"),"g");
      for (const entry of session.secrets) if (entry.cardPattern && entry.variants.includes(value)) entry.cardPattern = pattern;
      // Keep complete PANs ahead of previously typed prefixes when masking receipt text.
      session.secrets.sort((a,b)=>(b.cardPattern?.source.length ?? 0)-(a.cardPattern?.source.length ?? 0));
    } else {
      if (sensitive) session.screenshotsBlocked = true;
      this.registerSecret(session,value,scope,sensitive);
    }
  }
  private protectUnknownInput(session: Session, page: LoginPage | null, scope: string, edit: LoginEdit | null) {
    const trail = session.unknownOwnerText ??= new UnknownOwnerText();
    if (!page || !edit) { trail.reset(); return; }
    // A screenshot can expose even the first byte, before PAN/code recognition.
    session.lockedTabs.set(page.targetId,page.url);
    const document = JSON.stringify([page.targetId,page.documentId]);
    if (session.unknownNumericPage !== document) {
      const previousDocument = session.unknownNumericPage;
      session.unknownNumericPage = document;
      if (previousDocument !== undefined) session.unknownDigitCount = 0;
    }
    if (edit.type === "insert") {
      // A bounded digit set also protects short numeric fields and cursor edits,
      // without turning single digits into URL/operation authority.
      const digits = session.unknownNumericDigits ??= new Set<string>();
      for (const digit of edit.text.matchAll(/\d/g)) { digits.add(digit[0]); session.unknownDigitCount = Math.min(3,(session.unknownDigitCount ?? 0)+1); }
      // Resetting a trail must not make a code assembled across edits or separate
      // unknown boxes photographable on a later receipt/navigation.
      if (session.unknownDigitCount === 3) session.screenshotsBlocked = true;
    } else if (edit.type === "unknown") {
      // Missing/oversized event data is not a DOM-value fallback. Protect all
      // numeric renderings and pixels, without inventing any credential bytes.
      const digits = session.unknownNumericDigits ??= new Set<string>();
      for (const digit of "0123456789") digits.add(digit);
      session.screenshotsBlocked = true;
    }
    for (const value of trail.edit(JSON.stringify([page.targetId,page.documentId,page.url,scope]),edit)) {
      if (isPanLike(value)) {
        if (!session.login?.protectPan(page,value)) this.protectOwnerValue(session,value,undefined,true);
      } else this.protectOwnerValue(session,value,undefined,true);
    }
  }
  private hasProtectedValue(session: Session, value: string) {
    return session.secrets.some(secret => secret.variants.some(variant => variant && value.includes(variant)) || !!secret.cardPattern && value.search(secret.cardPattern) >= 0);
  }
  private protectNativeGap(session: Session) {
    session.screenshotsBlocked = true;
    const digits = session.unknownNumericDigits ??= new Set<string>();
    for (const digit of "0123456789") digits.add(digit);
  }
  private async recoverLogin(session: Session) {
    if (session.loginRecovery) { await session.loginRecovery; return; }
    const previous = session.loginObserver;
    const mode = session.loginNeedsRecovery ?? (previous?.ended ? session.headed ? "native" : "headless" : undefined);
    if (!mode) return;
    const recovery = (async () => {
      // Wait for earlier owner work to settle; its original caller still gets
      // its failure. Do not replay it or let that prior failure poison this action.
      await session.ownerBusy?.catch(() => {});
      if (session.loginObserver !== previous) return;
      session.loginNeedsRecovery = mode;
      const resetPage = mode === "native" || session.loginResetPage === true;
      clearTimeout(session.captureTimer);
      session.loginEpoch = (session.loginEpoch ?? 0)+1;
      session.loginStarting = undefined;
      session.loginObserver = undefined;
      session.login?.clear(); session.login = undefined;
      session.unknownOwnerText?.reset();
      // A new isolated world changes its document token, not necessarily the DOM.
      // Carry the privacy-only digit count into its first observed document.
      session.unknownNumericPage = undefined;
      previous?.close();
      session.loginBootstrapping = true;
      try {
        if (resetPage) {
          // Native gaps may contain unseen bytes; an unobservable headless page
          // may immediately kill another observer. Neither document is reused.
          clearInterval(session.headedPoll);
          session.promoting = true; session.ownerGeneration = (session.ownerGeneration ?? 0)+1;
          if (mode === "native") this.protectNativeGap(session);
          this.disconnect(session,"engine_changed");
          // Keep the recovery marker intact through teardown. The native helper
          // awaits actual process reap before a fresh restore identity is selected.
          if (!(await this.invokeCli(session,["close"])).ok) throw new CommandError("unavailable","Could not close the unobservable browser");
          session.headed = false; session.handoffUrl = null; session.handoffFallback = true;
          // Retain the old saved state, but never reload its possibly unseen
          // cookies/localStorage into this recovered session's private runtime.
          session.privateRestoreKey = `private-${randomUUID()}`;
          if (!(await this.invokeCli(session,["open","about:blank"])).ok) throw new CommandError("unavailable","Could not initialize a private browser after capture ended");
        } else {
          // Non-mutating native bootstrap retains an existing page, or starts a
          // blank browser if its daemon/browser exited. No failed action replays.
          if (!(await this.invokeCli(session,["tab","list"])).ok) throw new CommandError("unavailable","Could not reinitialize private browser observation");
        }
        await this.startLogin(session);
        session.loginNeedsRecovery = undefined;
        session.loginResetPage = false;
      } catch (error) {
        // Do not retry this action. A subsequent explicit action can reset a
        // document that could not support a fresh isolated observer in place.
        session.loginResetPage = true;
        throw error;
      } finally {
        session.loginBootstrapping = false;
        if (resetPage) session.promoting = false;
      }
      const notice = resetPage ? "Private input capture ended. The browser was reset to a blank page with separate saved state; earlier saved state was retained. Take a fresh snapshot before continuing." : "Private input capture reconnected. Earlier login ownership was discarded; take a fresh snapshot before continuing.";
      session.notice = `${session.notice ?? ""}\n${notice}`.trim();
      if (resetPage) throw new CommandError("conflict","Private input capture ended; the browser was reset. Use the fresh page rather than replaying input");
    })();
    session.loginRecovery = recovery;
    try { await recovery; } finally { if (session.loginRecovery === recovery) session.loginRecovery = undefined; }
  }
  private async withModelCapture<T>(session: Session, perform: () => Promise<T>): Promise<T> {
    await this.recoverLogin(session);
    session.modelCaptureDepth = (session.modelCaptureDepth ?? 0) + 1;
    try { await session.loginObserver?.updateMode?.(); return await perform(); }
    finally { session.modelCaptureDepth = (session.modelCaptureDepth ?? 1) - 1; await session.loginObserver?.updateMode?.(); }
  }
  private ownerActivity(session: Session) {
    const activity = "The owner used this browser. Cached refs and observations were discarded; take a fresh browser_snapshot before acting.";
    if (!session.notice?.includes(activity)) session.notice = `${session.notice ?? ""}\n${activity}`.trim();
  }
  private async ensureLogin(session: Session) {
    if (session.loginNeedsRecovery || session.loginObserver?.ended) throw new CommandError("unavailable","Private browser observation needs a new explicit action");
    if (session.engine === "obscura" || session.loginObserver) return;
    if (session.loginStarting) return session.loginStarting;
    const starting = this.startLogin(session);
    session.loginStarting = starting;
    try { await starting; }
    catch (error) {
      // A failed initial install can also leave a visible native window without
      // observation. Only the next explicit action may recover that gap.
      if (session.loginStarting === starting && !session.loginObserver && this.sessionMap.get(session.ref.conversationId) === session) {
        session.login?.clear(); session.loginEpoch = (session.loginEpoch ?? 0)+1;
        session.loginNeedsRecovery = session.headed ? "native" : "headless";
        session.loginResetPage = true;
        if (session.headed) this.protectNativeGap(session);
      }
      throw error;
    } finally { if (session.loginStarting === starting) session.loginStarting = undefined; }
  }
  private async startLogin(session: Session) {
    const epoch = session.loginEpoch ?? 0;
    const capture = session.login ??= new LoginCapture(async (login) => {
      if (epoch !== (session.loginEpoch ?? 0)) return;
      const id = await this.onLogin?.(session.ref, login);
      if (id) session.notice = `${session.notice ?? ""}\nThe owner's login was saved to vault item ${id}. Use browser_fill_secret for this login.`.trim();
    }, (value,scope,sensitive) => { if (epoch === (session.loginEpoch ?? 0)) this.protectOwnerValue(session,value,scope,sensitive); }, password => session.modelPasswords?.has(password) === true);
    const result = await this.invokeCli(session,["get","cdp-url"]);
    if (!result.ok || !result.data || typeof result.data !== "object" || !("cdpUrl" in result.data) || typeof result.data.cdpUrl !== "string") throw new CommandError("unavailable","Trusted Chrome input capture is unavailable");
    const observer = await ChromeLoginObserver.start(result.data.cdpUrl,capture,{
      nativeAllowed: () => epoch === (session.loginEpoch ?? 0) && session.headed && !session.modelCaptureDepth && !session.ownerCaptureDepth && !session.secretGate && !this.stopping,
      isCurrent: () => epoch === (session.loginEpoch ?? 0) && session.headed && !this.stopping,
      ownerApiActive: () => epoch === (session.loginEpoch ?? 0) && !!session.ownerCaptureDepth,
      activity: () => { if (epoch === (session.loginEpoch ?? 0)) { session.captureArmed = true; this.ownerActivity(session); } },
      secret: (page,kind) => { if (epoch === (session.loginEpoch ?? 0)) { if (kind === "sensitive") session.screenshotsBlocked = true; else session.lockedTabs.set(page.targetId,page.url); } },
      privacy: (page,scope,edit) => { if (epoch === (session.loginEpoch ?? 0)) this.protectUnknownInput(session,page,scope,edit); },
      ended: (observer,reason) => {
        if (epoch !== (session.loginEpoch ?? 0) || session.loginObserver !== observer) return;
        session.login?.clear(); session.loginStarting = undefined;
        session.loginEpoch = (session.loginEpoch ?? 0)+1;
        session.loginNeedsRecovery = session.headed ? "native" : "headless";
        session.loginResetPage = reason.cause === "controller-ack" || reason.cause.startsWith("protocol-");
        if (session.headed) this.protectNativeGap(session);
      },
      windowClosed: observer => { if (epoch === (session.loginEpoch ?? 0) && session.loginObserver === observer && session.headed) void this.resumeClosedWindow(session).catch(() => {}); },
    });
    if (epoch !== (session.loginEpoch ?? 0) || this.sessionMap.get(session.ref.conversationId) !== session || observer.ended || this.stopping) { observer.close(); throw new CommandError("unavailable","Browser input session changed"); }
    session.loginObserver = observer;
  }
  private async capture(session: Session, finished = false) {
    // A timer/poll is not a fresh owner/model action and cannot re-establish
    // authority after a gap. Explicit entry points perform recovery separately.
    if (session.loginNeedsRecovery || session.loginObserver?.ended) return;
    if (!session.captureArmed && (!finished || !session.loginObserver)) return;
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
        while (session.secretGate || session.ownerBusy) await (session.secretGate ?? session.ownerBusy);
        if (this.stopping || this.sessionMap.get(session.ref.conversationId) !== session || session.promoting) return;
        const capture = this.capture(session);
        session.ownerBusy = capture;
        try { await capture; } finally {
          if (session.ownerBusy === capture) {
            session.ownerBusy = undefined;
            // Damage and in-flight JPEGs may have been discarded while metadata capture owned the page.
            this.requestChromeFrame(session);
          }
        }
      }).catch(() => {});
    }, 450).unref();
  }
  private dropLiveViewer(bridge: LiveBridge, subscriber: (event: BrowserLiveEvent) => void) {
    const fps = bridge.subscribers.get(subscriber);
    if (!bridge.subscribers.delete(subscriber)) return;
    if (fps === bridge.maxFps) {
      bridge.maxFps = 0;
      for (const value of bridge.subscribers.values()) bridge.maxFps = Math.max(bridge.maxFps,value);
    }
    if (!bridge.maxFps && bridge.renderer) { bridge.renderer.invalidate(); bridge.frame = undefined; }
  }
  private endLiveViewers(bridge: LiveBridge, reason: string) {
    bridge.frame = undefined; bridge.renderer?.invalidate();
    for (const sink of bridge.subscribers.keys()) {
      try { sink({type:"end",reason}); } catch { /* A closed owner stream cannot abort the remaining viewers. */ }
    }
    bridge.subscribers.clear(); bridge.maxFps = 0;
  }
  private requestChromeFrame(session: Session) {
    const bridge = session.bridge;
    if (session.engine === "obscura" || !bridge?.targetId || !bridge.maxFps || session.ownerBusy || session.promoting || bridge.socket?.readyState !== WebSocket.OPEN) return;
    if (!bridge.renderer) {
      const current = (): boolean => !this.stopping && this.sessionMap.get(session.ref.conversationId) === session && session.bridge === bridge && bridge.renderer === created && bridge.subscribers.size > 0 && !session.ownerBusy && !session.promoting && bridge.socket?.readyState === WebSocket.OPEN;
      const created: ChromeViewportFrames = new ChromeViewportFrames({
        isCurrent: current,
        getCdpUrl: async () => {
          if (!current()) throw new CommandError("unavailable","Browser frame session changed");
          const endpoint = await this.invoke(session,["get","cdp-url"],{timeoutMs:5000});
          if (!current() || !endpoint.ok || !endpoint.data || typeof endpoint.data !== "object" || !("cdpUrl" in endpoint.data) || typeof endpoint.data.cdpUrl !== "string") throw new CommandError("unavailable","Private browser frames are unavailable");
          return endpoint.data.cdpUrl;
        },
        onFrame: frame => {
          if (!current()) return;
          bridge.frame = frame; bridge.width = frame.width; bridge.height = frame.height;
          for (const sink of bridge.subscribers.keys()) {
            try { sink(frame); } catch { this.dropLiveViewer(bridge,sink); }
          }
        },
        onError: () => {
          if (!current()) return;
          bridge.renderer = undefined; created.close();
          this.endLiveViewers(bridge,"renderer_changed");
        },
      });
      bridge.renderer = created;
    }
    bridge.renderer.request({targetId:bridge.targetId,viewport:session.ownerViewport,maxFps:bridge.maxFps});
  }
  private disconnect(session: Session, reason?: string) {
    const bridge = session.bridge;
    if (bridge) {
      clearTimeout(bridge.retry);
      const renderer = bridge.renderer; bridge.renderer = undefined; renderer?.close(); bridge.damage = undefined;
      bridge.frame = undefined; bridge.targetId = undefined;
      const socket = bridge.socket; bridge.socket = undefined; socket?.close();
      if (reason) {
        this.endLiveViewers(bridge,reason); session.bridge = undefined;
      }
    }
    if (reason && reason !== "engine_changed") {
      clearTimeout(session.captureTimer); clearInterval(session.headedPoll);
      session.loginEpoch = (session.loginEpoch ?? 0) + 1; session.loginStarting = undefined;
      session.loginNeedsRecovery = undefined;
      session.loginResetPage = false;
      session.loginObserver?.close(); session.loginObserver = undefined;
      session.login?.clear(); session.login = undefined; session.secrets = []; session.notice = undefined;
      session.modelPasswords?.clear(); session.captureArmed = false;
      session.ownerRedactions?.clear();
      session.unknownOwnerText?.reset();
      session.unknownNumericDigits?.clear();
      session.unknownNumericPage = undefined; session.unknownDigitCount = 0;
    }
  }
  private async resumeClosedWindow(session: Session) {
    if (!session.headed || this.sessionMap.get(session.ref.conversationId) !== session) return;
    // A stream/window callback is not a fresh action. Preserve gap policy and
    // retired restore state until explicit recovery can isolate the runtime.
    const blocked = () => this.stopping || this.sessionMap.get(session.ref.conversationId) !== session ||
      session.loginNeedsRecovery || session.loginObserver?.ended || session.loginRecovery;
    if (blocked()) return;
    let prepared = false;
    try {
      await this.enqueueSession(session.ref,async current => {
        if (current !== session || !session.headed || blocked()) return;
        await session.ownerBusy;
        if (!session.headed || blocked()) return;
        let url = session.bridge?.page?.url ?? session.handoffUrl ?? "about:blank";
        if (this.hasProtectedValue(session,url)) url = "about:blank";
        if (url !== "about:blank") await assertFetchableUrl(url,"closed window URL");
        // Keep native observation and its epoch live through every queue/URL
        // await: a reopened native window can still receive genuine input.
        // A terminal callback must quarantine that state, not be invalidated
        // by this legacy path before it can record the gap.
        if (!session.headed || blocked()) return;
        session.headed = false; clearInterval(session.headedPoll);
        session.promoting = true; session.ownerGeneration = (session.ownerGeneration ?? 0) + 1;
        session.loginEpoch = (session.loginEpoch ?? 0) + 1; session.loginStarting = undefined;
        session.login?.clear(); // Closing a window is never an assertion that a login succeeded.
        prepared = true;
        this.disconnect(session,"engine_changed");
        if (blocked()) return;
        if (!(await this.invoke(session,["close"])).ok) throw new Error("Window close failed");
        if (blocked()) return;
        if (!(await this.invoke(session,["open",url])).ok) throw new Error("Window resume failed");
        if (blocked()) return;
        if (session.ownerViewport && !(await this.invoke(session,["set","viewport",String(session.ownerViewport.width),String(session.ownerViewport.height)])).ok) throw new Error("Window viewport restore failed");
      });
    } catch {
      // Do not turn an observed gap into a destructive Session reset merely
      // because an already-pending window/URL operation also failed.
      if (!blocked()) {
        this.disconnect(session,"window_closed"); this.clearFiles(session); this.sessionMap.delete(session.ref.conversationId);
      }
    } finally { if (prepared) session.promoting = false; }
  }
  private connect(session: Session): Promise<WebSocket> {
    if (session.promoting) return Promise.reject(new CommandError("conflict","브라우저를 전환하고 있어요. 새 화면을 기다려 주세요"));
    const bridge: LiveBridge = session.bridge ??= { subscribers: new Map(), maxFps: 0, width: 0, height: 0 };
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
              const changed = bridge.page?.url !== url || bridge.targetId !== targetId;
              if (changed) { bridge.frame = undefined; bridge.damage = undefined; bridge.renderer?.invalidate(); }
              bridge.targetId = targetId;
              bridge.page = { type: "page", url, title: tab.title.slice(0,512) };
              for (const sink of bridge.subscribers.keys()) sink(bridge.page);
              if (changed) this.requestChromeFrame(session);
            }
          } else if (event.type === "frame" && typeof event.data === "string" && event.data.length > 0 && event.data.length <= Math.ceil(8 * 1024 * 1024 * 4 / 3) && /^[A-Za-z0-9+/]*={0,2}$/.test(event.data) && bridge.width && bridge.height) {
            if (session.engine !== "obscura") {
              if (!bridge.subscribers.size) { bridge.damage = undefined; bridge.frame = undefined; }
              else if (event.data !== bridge.damage) { bridge.damage = event.data; this.requestChromeFrame(session); }
            } else {
              // Obscura is damage-driven: retain exactly one bounded native frame for late viewers.
              bridge.frame = { type: "frame", data: event.data, width: bridge.width, height: bridge.height };
              for (const sink of bridge.subscribers.keys()) sink(bridge.frame);
            }
          }
        } catch { /* Malformed upstream messages are never observations. */ }
      };
      socket.onclose = () => {
        clearTimeout(timeout); reject(new CommandError("unavailable", "Browser stream closed"));
        if (bridge.socket !== socket) return;
        bridge.damage = undefined; this.endLiveViewers(bridge,"renderer_changed");
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
    const bridge: LiveBridge = session.bridge ??= { subscribers: new Map(), maxFps: 0, width: 0, height: 0 };
    if (bridge.subscribers.size >= 4) throw new CommandError("conflict", "At most four live clients may watch a browser session");
    let lastFrame = Number.NEGATIVE_INFINITY, receivedFrame = false;
    let pendingFrame: Extract<BrowserLiveEvent,{type:"frame"}> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let pageUrl = bridge.page?.url, targetId = bridge.targetId;
    const stop = () => { clearTimeout(timer); timer = undefined; pendingFrame = undefined; this.dropLiveViewer(bridge,subscriber); };
    const subscriber = (event: BrowserLiveEvent) => {
      if (event.type === "frame") {
        const now = performance.now(), delay = 1000 / options.maxFps - (now - lastFrame);
        if (delay > 0) {
          pendingFrame = event;
          timer ??= setTimeout(() => {
            timer = undefined;
            const latest = pendingFrame; pendingFrame = undefined;
            if (latest) try { subscriber(latest); } catch { stop(); }
          },Math.ceil(delay)).unref();
          return;
        }
        clearTimeout(timer); timer = undefined; pendingFrame = undefined;
        lastFrame = now; receivedFrame = true;
      } else if (event.type === "end" || event.type === "page" && (event.url !== pageUrl || bridge.targetId !== targetId)) {
        clearTimeout(timer); timer = undefined; pendingFrame = undefined;
      }
      if (event.type === "page") { pageUrl = event.url; targetId = bridge.targetId; }
      sink(event);
    };
    bridge.subscribers.set(subscriber,options.maxFps);
    bridge.maxFps = Math.max(bridge.maxFps,options.maxFps);
    try { await this.connect(session); } catch (error) { stop(); throw error; }
    if (bridge.page) subscriber(bridge.page);
    if (bridge.frame && !receivedFrame) subscriber(bridge.frame);
    this.requestChromeFrame(session);
    return stop;
  }
  input(ref: BrowserSessionRef, input: BrowserLiveInput): Promise<void> {
    const session = this.existing(ref), generation = session.ownerGeneration ?? 0;
    if (session.promoting) return Promise.reject(new CommandError("conflict","브라우저를 전환하고 있어요. 새 화면을 기다려 주세요"));
    const next = (session.ownerQueue ?? Promise.resolve()).then(async () => {
      while (session.secretGate) await session.secretGate;
      this.existing(ref);
      if (session.promoting || generation !== (session.ownerGeneration ?? 0)) throw new CommandError("conflict","브라우저가 바뀌었어요. 새 화면에서 다시 선택해 주세요");
      if (input.type !== "viewport") await this.recoverLogin(session);
      if (this.sessionMap.get(ref.conversationId) !== session || generation !== (session.ownerGeneration ?? 0)) throw new CommandError("conflict","Browser input session changed; use the fresh page");
      if (input.type === "viewport") {
        session.bridge?.renderer?.invalidate();
        session.ownerBusy = this.invoke(session,["set","viewport",String(input.width),String(input.height)]).then(result => {
          if (!result.ok) throw new CommandError("unavailable","Browser viewport could not resize");
          session.ownerViewport = { width: input.width, height: input.height };
          if (session.bridge) { session.bridge.frame = undefined; session.bridge.damage = undefined; }
          session.notice = `${session.notice ?? ""}\nThe owner resized the browser. Cached refs and observations were discarded; take a fresh browser_snapshot before acting.`.trim();
        });
        try { await session.ownerBusy; } finally { session.ownerBusy = undefined; }
        this.requestChromeFrame(session);
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
        const inserted = input.type === "text" ? input.text : input.type === "key" && input.event === "down" ? input.text : undefined;
        // Owner bytes are private even when an iframe/shadow focus has no top-level descriptor.
        if (inserted && isPanLike(inserted)) this.protectOwnerValue(session,inserted,undefined,true);
        try {
          await this.ensureLogin(session);
          await session.loginObserver?.updateMode?.();
          const observes = input.type === "text" || input.type === "key" && input.event === "down" || input.type === "mouse" && input.event === "down";
          const before = observes && session.loginObserver ? await session.loginObserver.snapshot(session.bridge?.targetId,input.type === "mouse" ? {x:input.x,y:input.y} : undefined) : null;
          if (observes && !before) throw new CommandError("unavailable","Trusted browser input metadata is unavailable");
          const focused = before?.fields.find(field => field.id === before.focused);
          const clicked = before?.fields.find(field => field.id === before.clicked);
          if (before && (input.type === "key" && input.event === "down" && input.key === "Enter" || clicked?.kind === "submit")) session.login?.submit(before,(clicked?.kind === "submit" ? clicked : focused)?.form ?? "");
          if (input.type === "navigate" || input.type === "mouse" && input.event === "down" || input.type === "key" && input.event === "down" && (/^(?:Tab|Enter|Escape|Arrow.*|Home|End|PageUp|PageDown)$/.test(input.key) || ((input.modifiers ?? 0)&6) !== 0)) session.unknownOwnerText?.reset();
          let edit: LoginEdit | null = inserted !== undefined ? {type:"insert",text:inserted} : null;
          if (input.type === "key" && input.event === "down" && (input.key === "Backspace" || input.key === "Delete")) edit = (input.modifiers ?? 0)&7 ? {type:"unknown"} : {type:input.key === "Backspace" ? "backspace" : "delete"};
          if (before && !focused && edit) this.protectUnknownInput(session,before,session.loginObserver?.privacyScope ?? "unknown",edit);
          else if (focused) session.unknownOwnerText?.reset();
          if (before && focused && edit) {
            session.login?.edit(before,focused,edit);
            if (focused.kind === "sensitive") session.screenshotsBlocked = true;
            // Any field may hold a code the classifier missed (a bare tel "코드" box reads as username); the Ghost
            // continues on this page, so its pixels stay private until the URL changes. 2026.11.11
            else session.lockedTabs.set(before.targetId,before.url);
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
      this.requestChromeFrame(session);
    });
    session.ownerQueue = next.catch(() => {}); return next;
  }
  handoff(ref: BrowserSessionRef, url: string | null, options: { headed?: boolean } = {}) {
    this.existing(ref);
    return this.enqueueSession(ref, async (session) => {
      await this.recoverLogin(session);
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
        if (this.hasProtectedValue(session,url)) throw new CommandError("forbidden","Cannot reopen a URL containing a protected value");
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
      await this.recoverLogin(session);
      clearTimeout(session.captureTimer); clearInterval(session.headedPoll);
      await session.ownerBusy;
      await this.capture(session, true);
      if (session.loginNeedsRecovery || session.loginObserver?.ended) throw new CommandError("unavailable","Private browser observation ended during handoff completion");
      // A live-view handoff never left headless mode: the Ghost continues on the page the owner left. A session
      // lost to a host restart is new and empty either way, so there is nothing to reopen.
      if (!session.headed && session.handoffUrl === null) return { fallback: false };
      if (session.headed) {
        try {
          const current = await this.invoke(session, ["get", "url"]);
          const url = typeof current.data === "string" ? current.data : current.data && typeof current.data === "object" && "url" in current.data ? current.data.url : null;
          if (!current.ok || typeof url !== "string") throw new Error("No headed page URL");
          if (this.hasProtectedValue(session,url)) throw new Error("Protected handoff URL");
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
    if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
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
