import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserPort, BrowserReply } from "./ports.ts";

/**
 * The owner's browser through the installed `agent-browser` CLI (2026-11-09).
 *
 * 업무 목차
 * - 실행 경로 · 환경: argv 만 쓰고 셸을 거치지 않는다. 환경 변수는 브라우저를 찾는 데 필요한 것만 넘긴다.
 * - Ghost 별 브라우저: `--session ghost-<id>` 과 `--profile <root>/browser/profiles/<id>`.
 *   Chrome 프로필은 한 번에 브라우저 하나만 연다(2026-11-09 Windows 실측: 두 번째 세션이 잠금 파일에서 실패) —
 *   그래서 대화마다 세션을 나누지 않고, 한 브라우저 안에서 대화마다 이름표를 단 탭을 쓴다.
 * - Ghost 별 대기열: 데몬의 활성 탭은 하나이고 ref(@eN)는 그 탭의 것이다. 탭 전환과 명령을 한 차례로 묶지 않으면
 *   다른 대화가 끼어들어 엉뚱한 탭을 누른다.
 * - Shade 로그인 허락: 플러그인은 데몬의 환경을 물려받으므로 호출마다 바뀌는 허락을 환경 변수로 넘길 수 없다.
 *   일회용 허락 파일을 쓰고 그 이름을 `auth login` 의 프로필 이름으로 넘긴다(`browser-credential.ts`).
 */

/** One CLI call never runs longer than this; a page that hangs a command is not the Ghost's to wait on forever. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Snapshots of large pages are big but bounded; beyond this the reply is refused instead of buffered. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
/** A grant file lives only long enough for the login it was written for. */
const GRANT_TTL_MS = 60_000;

/** Environment the CLI and its daemon need to find Chrome and their own state; nothing of the Host's. */
const ENV_KEYS = ["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG"];

export interface BrowserSettings {
  executable: string;
  /** Leading argv before agent-browser's own (tests run a Bun script fake). */
  prefix?: string[];
  /** The Host's state root; everything lives under `<root>/browser`. */
  root: string;
  /** The Shade agent CLI; null leaves vault sign-in off. */
  shade: string | null;
  /** How to run this Ghost binary's `browser-credential` subcommand: argv before the subcommand. */
  ghostCommand: string[];
  timeoutMs?: number;
}

/** A label agent-browser accepts: a letter first, then letters, digits, `-` or `_`. */
export const tabLabel = (conversationId: string) => `c${conversationId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
const sessionOf = (ghostId: string) => `ghost-${ghostId.replace(/[^A-Za-z0-9_-]/g, "_")}`;

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Quote one argument for a POSIX `sh` script line. */
const shQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
/** Quote one argument for a Windows `.cmd` line. */
const cmdQuote = (value: string) => `"${value.replaceAll('"', '""')}"`;

export class AgentBrowser implements BrowserPort {
  private readonly dir: string;
  private readonly config: string;
  private readonly timeoutMs: number;
  /** Per-Ghost tail of the queue; each call waits for the previous one of the same Ghost. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly settings: BrowserSettings) {
    this.dir = join(settings.root, "browser");
    this.config = join(this.dir, "agent-browser.json");
    this.timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.install();
  }

  get vault(): boolean {
    return this.settings.shade !== null;
  }

  /**
   * Lay out `<root>/browser`: profiles and grants are private (0700), and the agent-browser config
   * names the Shade plugin through a wrapper script, because a plugin entry is one command without args.
   * Rewritten at every start so a moved binary or Shade path takes effect.
   */
  private install() {
    for (const path of [this.dir, join(this.dir, "profiles"), join(this.dir, "grants"), join(this.dir, "scratch")]) {
      mkdirSync(path, { recursive: true });
      try {
        chmodSync(path, 0o700);
      } catch {
        // Windows has no POSIX modes; the user profile directory is already private.
      }
    }
    const plugins: unknown[] = [];
    if (this.settings.shade !== null) {
      const argv = [...this.settings.ghostCommand, "browser-credential", "--root", this.settings.root, "--shade", this.settings.shade];
      const windows = process.platform === "win32";
      const wrapper = join(this.dir, windows ? "shade-credential.cmd" : "shade-credential");
      writeFileSync(wrapper, windows ? `@${argv.map(cmdQuote).join(" ")}\r\n` : `#!/bin/sh\nexec ${argv.map(shQuote).join(" ")}\n`, { mode: 0o700 });
      plugins.push({ name: "shade", command: wrapper, capabilities: ["credential.read"] });
    }
    writeFileSync(this.config, `${JSON.stringify({ plugins }, null, 2)}\n`, { mode: 0o600 });
  }

  scratchPath(extension: string): string {
    return join(this.dir, "scratch", `${crypto.randomUUID()}.${extension}`);
  }

  grantLogin(grant: { itemId: string; origin: string }): string {
    // The token is also agent-browser's profile name for this login: a letter first, then hex.
    const token = `g${crypto.randomUUID().replaceAll("-", "")}`;
    writeFileSync(join(this.dir, "grants", `${token}.json`), JSON.stringify({ ...grant, expiresAt: Date.now() + GRANT_TTL_MS }), { mode: 0o600 });
    return token;
  }

  /** Remove a grant the plugin did not consume (the login failed before resolving credentials). */
  revokeGrant(token: string) {
    rmSync(join(this.dir, "grants", `${token}.json`), { force: true });
  }

  run(ghostId: string, tab: string, args: string[]): Promise<BrowserReply> {
    return this.exclusive(ghostId, tab, (run) => run(args));
  }

  exclusive<T>(ghostId: string, tab: string, body: (run: (args: string[]) => Promise<BrowserReply>) => Promise<T>): Promise<T> {
    return this.queued(ghostId, async () => {
      const run = (args: string[]) => this.invoke(ghostId, args);
      await this.focus(ghostId, tab);
      return body(run);
    });
  }

  async closeTabs(ghostId: string, keep: (tab: string) => boolean): Promise<void> {
    await this.queued(ghostId, async () => {
      const listed = await this.invoke(ghostId, ["tab", "list"]);
      if (!listed.ok) return;
      const tabs = Array.isArray(listed.data.tabs) ? listed.data.tabs.map(recordOf) : [];
      for (const tab of tabs) {
        const label = typeof tab.label === "string" ? tab.label : null;
        if (label && label.startsWith("c") && !keep(label)) await this.invoke(ghostId, ["tab", "close", label]);
      }
    });
  }

  /** Make the conversation's tab active, opening a blank one under its label when it is gone. */
  private async focus(ghostId: string, tab: string) {
    const switched = await this.invoke(ghostId, ["tab", tab]);
    if (switched.ok) return;
    const opened = await this.invoke(ghostId, ["tab", "new", "--label", tab]);
    if (!opened.ok) throw new Error(`the browser could not open a tab: ${opened.error}`);
  }

  private queued<T>(ghostId: string, body: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(ghostId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(body);
    const tail = next.catch(() => {});
    this.queues.set(ghostId, tail);
    void tail.then(() => {
      if (this.queues.get(ghostId) === tail) this.queues.delete(ghostId);
    });
    return next;
  }

  /** One CLI call for the Ghost's browser: `--json` output parsed into a reply. */
  private async invoke(ghostId: string, args: string[]): Promise<BrowserReply> {
    const argv = [
      ...(this.settings.prefix ?? []),
      "--session", sessionOf(ghostId),
      "--profile", join(this.dir, "profiles", ghostId),
      "--config", this.config,
      "--json",
      ...args,
    ];
    const text = await this.spawn(argv);
    let parsed: Record<string, unknown>;
    try {
      parsed = recordOf(JSON.parse(text));
    } catch {
      return { ok: false, error: `agent-browser returned no JSON: ${text.slice(0, 300)}` };
    }
    if (parsed.success === true) return { ok: true, data: recordOf(parsed.data) };
    return { ok: false, error: typeof parsed.error === "string" ? parsed.error : "agent-browser reported a failure" };
  }

  private async spawn(argv: string[]): Promise<string> {
    const env: Record<string, string> = {};
    for (const key of ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn([this.settings.executable, ...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
    } catch (error) {
      throw new Error(`cannot start agent-browser (${this.settings.executable}): ${error instanceof Error ? error.message : String(error)}`);
    }
    const kill = () => {
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
    };
    const timer = setTimeout(kill, this.timeoutMs);
    try {
      const [stdout, stderr] = await Promise.all([readCapped(proc.stdout, MAX_OUTPUT_BYTES, kill), readCapped(proc.stderr, MAX_STDERR_BYTES, () => {}, true)]);
      await proc.exited;
      if (proc.signalCode !== null) throw new Error(`agent-browser did not finish within ${this.timeoutMs} ms; it was stopped`);
      return stdout.trim() || stderr.trim();
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Read a stream as UTF-8 up to `cap` bytes; beyond it kill the child, or (for stderr) keep the tail. */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number, onOverflow: () => void, tail = false): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    total += chunk.value.byteLength;
    text += decoder.decode(chunk.value, { stream: true });
    if (total > cap) {
      if (tail) {
        text = text.slice(-cap);
        continue;
      }
      onOverflow();
      throw new Error(`agent-browser output exceeded the size limit (${cap} bytes)`);
    }
  }
}

/** The configured browser, or null when the owner has not set one up. */
export function createBrowser(config: { root: string; browser?: null | { executable: string; shade?: string } }, ghostCommand: string[]): AgentBrowser | null {
  if (!config.browser) return null;
  if (config.browser.shade !== undefined && !existsSync(config.browser.shade)) {
    console.error(`[ghost] browser: Shade CLI not found at ${config.browser.shade}; vault sign-in is off`);
  }
  return new AgentBrowser({
    executable: config.browser.executable,
    root: config.root,
    shade: config.browser.shade !== undefined && existsSync(config.browser.shade) ? config.browser.shade : null,
    ghostCommand,
  });
}
