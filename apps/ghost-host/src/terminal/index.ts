import { closeSync, realpathSync, statSync, writeSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { TERMINAL_AGENTS, TerminalCreate, TerminalSize, parse, type TerminalAgent, type TerminalAgentEvent, type TerminalServerFrame, type TerminalView } from "@ghost/contract";
import { CommandError, invalid } from "../core/errors.ts";
import { TerminalActivity } from "./activity.ts";
import { agentName, TerminalProcesses } from "./processes.ts";
import { TerminalReplay } from "./replay.ts";

// Bun 1.4 implements this API; the Host's pinned Bun 1.3.3 type declarations predate it.
interface Pty {
  readonly closed: boolean;
  write(input: string | Uint8Array): number;
  resize(cols: number, rows: number): void;
  close(): void;
}

type PtySpawnOptions = {
  cwd: string;
  env: Record<string, string>;
  terminal: TerminalSize & { data(pty: Pty, bytes: Uint8Array): void; exit(): void };
};

function spawnPty(argv: string[], options: PtySpawnOptions): Bun.Subprocess & { terminal: Pty } {
  if (process.platform !== "darwin") return Bun.spawn(argv, options) as Bun.Subprocess & { terminal: Pty };
  const executable = Bun.which(argv[0]!, { cwd: options.cwd, PATH: options.env.PATH });
  if (!executable) throw invalid("터미널 명령을 실행할 수 없습니다.");
  // Bun 1.4.2 can block in wait4 if the PTY session leader exits before Bun
  // watches its PID, while macOS waits for Bun to drain that leader's output.
  // Keep the leader blocked on a private fd until spawn returns; exec keeps the
  // same PID and controlling tty, without consuming or echoing terminal input.
  // https://github.com/oven-sh/bun/issues/45300
  const child = Bun.spawn(["/bin/sh", "-c", "IFS= read -r ready <&3 || exit; exec 3<&-; exec \"$@\"", "ghost-pty", executable, ...argv.slice(1)], {
    ...options,
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  }) as Bun.Subprocess & { terminal: Pty };
  const gate = child.stdio[3];
  if (typeof gate !== "number") {
    child.kill("SIGKILL");
    throw new Error("missing PTY startup descriptor");
  }
  try { writeSync(gate, "\n"); }
  finally { closeSync(gate); }
  return child;
}

type Attacher = (frame: TerminalServerFrame | Uint8Array) => void;
type Entry = {
  view: TerminalView;
  pid: number;
  tty?: string;
  foreground: AgentProcess | null;
  launchAgent: AgentProcess | null;
  pty: Pty;
  exit: Promise<void>;
  closing: Promise<void> | null;
  stopRequested: boolean;
  history: TerminalReplay;
  activity: TerminalActivity;
  attachers: Set<Attacher>;
};

type AgentProcess = { pid: number; agent: TerminalAgent };

const POLL_MS = 500;
const QUIET_MS = 5_000;
const SAFE_ENV = /^(?:HOME|PATH|USER|LOGNAME|LANG|LC_[A-Z_]+|TMPDIR|SHELL|TZ|SSH_AUTH_SOCK)$/;
const DEFAULT_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function terminalPath(root: string): string {
  const home = homedir();
  // launchd need not inherit the owner's interactive PATH.
  const paths = new Set((process.env.PATH ?? "").split(":"));
  for (const bin of [".bun/bin", ".local/bin", ".cargo/bin"]) paths.add(join(home, bin));
  for (const bin of DEFAULT_PATH) paths.add(bin);
  for (const path of paths) {
    if (!isAbsolute(path) || inside(root, path)) paths.delete(path);
    else try { if (inside(root, realpathSync(path))) paths.delete(path); } catch { /* an optional directory can be missing */ }
  }
  return [...paths].join(":");
}

function shellEnvironment(root: string, rootAlias: string): Record<string, string> {
  // Build from an allowlist: model/provider credentials and all GHOST_* state/token
  // variables stay with the Host, even if configured under a novel environment key.
  const env: Record<string, string> = { TERM: "xterm-256color", COLORTERM: "truecolor" };
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || !SAFE_ENV.test(key) || key === "PATH") continue;
    if (value.includes(root) || value.includes(rootAlias)) continue;
    if (isAbsolute(value)) {
      try { if (inside(root, realpathSync(value))) continue; } catch { /* an optional path can be missing */ }
    }
    env[key] = value;
  }
  env.PATH = terminalPath(root);
  if (env.SHELL && (!isAbsolute(env.SHELL) || !Bun.which(env.SHELL))) delete env.SHELL;
  if (!env.HOME || !env.SHELL) {
    const user = userInfo();
    if (!inside(root, user.homedir)) env.HOME ??= user.homedir;
    const shell = user.shell;
    env.SHELL ??= shell && isAbsolute(shell) && !inside(root, shell) && Bun.which(shell)
      ? shell : process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  }
  return env;
}

/** Owner API only, deliberately not a Core/tool dependency. The PTY grants an unrestricted OS shell,
 * so giving it to Ghost would bypass the conversation, Work and direct-PC execution boundaries. */
export class Terminals {
  private readonly root: string;
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private stopped = false;

  constructor(private readonly rootAlias: string, private readonly options: {
    pollMs?: number;
    quietMs?: number;
    onEvent?(terminal: TerminalView, event: TerminalAgentEvent): void;
    log?(message: string, error: unknown): void;
  } = {}) {
    this.root = realpathSync(rootAlias);
  }

  create(spec: TerminalCreate): string {
    if (this.stopped) throw new CommandError("unavailable", "터미널 서비스가 종료되었습니다.");
    const { cwd: requested, command, args, cols, rows } = parse(TerminalCreate, spec);
    if (!isAbsolute(requested)) throw invalid("작업 폴더의 절대 경로가 필요합니다.");
    let cwd: string;
    try {
      cwd = realpathSync(requested);
      if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch { throw invalid("작업 폴더가 없습니다."); }
    if (inside(this.root, cwd)) throw new CommandError("forbidden", "Ghost 상태 폴더에서는 터미널을 열 수 없습니다.");
    if (args?.length && command === undefined) throw invalid("인수를 전달할 명령이 필요합니다.");
    if (command?.includes("\0") || args?.some(arg => arg.includes("\0"))) throw invalid("터미널 명령과 인수에는 널 문자를 넣을 수 없습니다.");

    const id = crypto.randomUUID();
    const initialAgent = command ? agentName(command) : null;
    const view: TerminalView = { id, cwd, cols, rows, agent: initialAgent, state: initialAgent ? "working" : "idle", exitCode: null };
    const history = new TerminalReplay();
    const activity = new TerminalActivity(id, view, this.options.quietMs ?? QUIET_MS, event => {
      try { this.options.onEvent?.({ ...view }, event); }
      catch (error) { this.options.log?.("터미널 알림을 전송하지 못했습니다.", error); }
    });
    const attachers = new Set<Attacher>();
    const drained = Promise.withResolvers<void>();
    const env = shellEnvironment(this.root, this.rootAlias);
    const terminal = {
      cols, rows,
      data: (_pty: Pty, bytes: Uint8Array) => {
        history.append(bytes);
        activity.output(bytes, performance.now());
        for (const send of attachers) send(bytes);
      },
      exit: () => drained.resolve(),
    };
    let proc;
    try {
      proc = spawnPty(command ? [command, ...(args ?? [])] : [env.SHELL!, "-l"], { cwd, env, terminal });
    } catch {
      activity.dispose();
      throw invalid("터미널 명령을 실행할 수 없습니다.");
    }
    const launchAgent = initialAgent ? { pid: proc.pid, agent: initialAgent } : null;
    const entry: Entry = {
      view, pid: proc.pid, foreground: launchAgent, launchAgent,
      pty: proc.terminal, closing: null, stopRequested: false, history, activity, attachers,
      exit: proc.exited.then(async code => {
        // The process can exit before Bun delivers the last PTY read. Reap jobs that
        // inherited the slave so they cannot keep this terminal open after its leader dies.
        if (!entry.stopRequested) {
          try { TerminalProcesses.snapshot().kill(entry.pid, entry.tty, false); }
          catch (error) { this.options.log?.("터미널 하위 프로세스를 종료하지 못했습니다.", error); }
        }
        const deadline = Promise.withResolvers<void>();
        const timeout = setTimeout(deadline.resolve, 250);
        await Promise.race([drained.promise, deadline.promise]);
        clearTimeout(timeout);
        entry.pty.close();
        view.state = "exited";
        view.exitCode = code;
        activity.dispose();
        if (!entry.stopRequested && entry.foreground) activity.agentExited(entry.foreground.agent);
        for (const send of attachers) send({ type: "exit", code });
        attachers.clear();
        this.stopPollIfIdle();
      }),
    };
    this.entries.set(id, entry);
    this.timer ??= setInterval(() => void this.poll(), this.options.pollMs ?? POLL_MS);
    this.timer.unref();
    return id;
  }

  list(): TerminalView[] { return Array.from(this.entries.values(), entry => ({ ...entry.view })); }
  has(id: string): boolean { return this.entries.has(id); }

  availableAgents(): TerminalAgent[] {
    const PATH = terminalPath(this.root);
    return TERMINAL_AGENTS.filter(agent => Bun.which(agent, { PATH }) !== null);
  }

  busy(): boolean {
    for (const { view } of this.entries.values()) {
      if (view.agent !== null && (view.state === "working" || view.state === "waiting")) return true;
    }
    return false;
  }

  attach(id: string, after: number | undefined, send: Attacher): () => void {
    const entry = this.require(id);
    const { offset, reset, chunks } = entry.history.replay(after);
    const { cols, rows, state, exitCode } = entry.view;
    send({ type: "ready", offset, reset, cols, rows });
    for (const chunk of chunks) send(chunk);
    send({ type: "replay-end" });
    if (state === "exited") send({ type: "exit", code: exitCode });
    else entry.attachers.add(send);
    return () => { entry.attachers.delete(send); };
  }

  input(id: string, data: string, binary = false): void {
    const entry = this.require(id);
    if (entry.view.state === "exited" || entry.stopRequested || entry.pty.closed) return;
    entry.pty.write(binary ? Buffer.from(data, "latin1") : data);
  }

  resize(id: string, size: TerminalSize): void {
    const entry = this.require(id);
    const { cols, rows } = parse(TerminalSize, size);
    if (entry.view.state === "exited" || entry.stopRequested || entry.pty.closed || (entry.view.cols === cols && entry.view.rows === rows)) return;
    entry.pty.resize(cols, rows);
    entry.activity.resize({ cols, rows });
    Object.assign(entry.view, { cols, rows });
  }

  async closeTerminal(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.closing ??= (async () => {
      if (entry.view.state !== "exited") {
        const before = TerminalProcesses.snapshot();
        before.kill(entry.pid, before.tty(entry.pid) ?? entry.tty, before.contains(entry.pid));
        entry.stopRequested = true;
        await entry.exit;
      }
      this.entries.delete(id);
    })().catch(error => { entry.closing = null; throw error; });
    await entry.closing;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.stopPollIfIdle();
    const results = await Promise.allSettled(Array.from(this.entries.keys(), id => this.closeTerminal(id)));
    const failed = results.filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "터미널을 종료하지 못했습니다.");
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new CommandError("not_found", "터미널을 찾을 수 없습니다.");
    return entry;
  }

  private stopPollIfIdle(): void {
    if (!this.stopped) for (const entry of this.entries.values()) if (entry.view.state !== "exited") return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const sampledAt = performance.now();
      const processes = await TerminalProcesses.sample();
      if (!processes || this.stopped) return;
      const now = performance.now();
      for (const entry of this.entries.values()) {
        if (entry.stopRequested || entry.view.state === "exited" || !processes.contains(entry.pid)) continue;
        entry.tty = processes.tty(entry.pid) ?? entry.tty;
        const foreground = processes.foreground(entry.pid) ?? entry.launchAgent;
        const previous = entry.foreground;
        if (foreground?.pid !== previous?.pid || foreground?.agent !== previous?.agent) {
          if (previous && !processes.contains(previous.pid)) entry.activity.agentExited(previous.agent);
          entry.activity.resetAgent(now);
          entry.foreground = foreground;
          entry.view.agent = foreground?.agent ?? null;
        }
        entry.view.state = entry.activity.tick(entry.view.agent, now, sampledAt);
      }
    } catch (error) { this.options.log?.("터미널 상태를 읽지 못했습니다.", error); }
    finally { this.polling = false; }
  }
}
