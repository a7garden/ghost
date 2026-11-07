import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, createWriteStream, openSync, type WriteStream } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { userInfo } from "node:os";
import type { Context } from "@earendil-works/chord";
import {
  ExecutionError,
  StreamDecoder,
  err,
  ok,
  toError,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { ensureTempRoot, killTree } from "./workspace-env.ts";

/** Longest single capture of container CLI output, like the legacy backend's bound. */
const OUTPUT_LIMIT = 64 * 1024;
/** Bound for a short container CLI call (ls, stop, delete). */
export const CLI_TIMEOUT_MS = 30_000;
/** `container run` may pull the pinned image on a cold cache. */
const RUN_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
/**
 * Conservative guest resource bounds, chosen flat for every Work: two CPUs and 2 GiB of memory
 * leave headroom on any macOS host while keeping one runaway Work from starving the others.
 */
const CONTAINER_CPUS = "2";
const CONTAINER_MEMORY = "2G";
/**
 * The guest never sees host environment variables: a fixed base, extended per call by
 * `options.env`. `inheritEnv` is deliberately ignored.
 */
const GUEST_BASE_ENV = [
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "HOME=/tmp",
  "TMPDIR=/tmp",
  "LANG=C.UTF-8",
];

/** One row of `container ls --format json`, narrowed to what status reporting needs. */
export interface ContainerRow {
  id: string;
  state: string;
}

export interface ContainerTarget {
  /** `container` CLI path. */
  cli: string;
  /** Pinned image reference (digest-pinned Ubuntu). */
  image: string;
  /** Container id: `ghost-<16 hex chars of the work id's sha256>`. */
  name: string;
  /** Real host workspace directory, bind-mounted read-writable at `/workspace`. */
  workspace: string;
  /** Caller-facing workspace root for spill diagnostics (`/workspace`). */
  logicalRoot: string;
}

export interface ContainerHooks {
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
  /** The set of containers visible to `ls` changed; callers drop their caches. */
  onChanged?: () => void;
}

interface CliOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

function timeoutMs(timeout: number | undefined): { ok: true; ms: number | undefined } | { ok: false; error: ExecutionError } {
  if (timeout === undefined) return { ok: true, ms: undefined };
  if (!Number.isFinite(timeout) || timeout <= 0)
    return { ok: false, error: new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds") };
  const ms = timeout * 1000;
  if (ms > MAX_TIMEOUT_MS)
    return { ok: false, error: new ExecutionError("timeout", `Invalid timeout: maximum is ${Math.floor(MAX_TIMEOUT_MS / 1000)} seconds`) };
  return { ok: true, ms };
}

/** Lexical-only confinement of a caller workdir against `/workspace`; the container does the rest. */
function workdirIn(cwd: string | undefined, root: string): Result<string, ExecutionError> {
  if (cwd === undefined) return ok(root);
  const resolved = isAbsolute(cwd) ? resolve(cwd) : resolve(root, cwd);
  if (resolved !== root && !resolved.startsWith(`${root}/`))
    return err(new ExecutionError("spawn_error", `Working directory escapes the workspace: ${cwd}`));
  return ok(resolved);
}

/** Run the container CLI, capture bounded output, kill the process group on timeout or abort. */
export async function runCli(cli: string, args: string[], timeout: number, context?: Context): Promise<Result<CliOutput, Error>> {
  const { promise, resolve: finish } = Promise.withResolvers<Result<CliOutput, Error>>();
  let child: ChildProcess;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (outcome: Result<CliOutput, Error>) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish(outcome);
  };
  try {
    child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
  } catch (error) {
    return err(toError(error));
  }
  timer = setTimeout(() => {
    if (child.pid) killTree(child.pid);
  }, timeout);
  const signal = context?.abortSignal;
  if (signal) {
    if (signal.aborted) killTree(child.pid!);
    else signal.addEventListener("abort", () => killTree(child.pid!), { once: true });
  }
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
  });
  child.on("error", (error) => settle(err(error)));
  child.on("close", (code, exitSignal) =>
    settle(ok({ code: code ?? (exitSignal ? 128 + (SIGNAL_NUMBERS[exitSignal] ?? 0) : 1), stdout, stderr })),
  );
  return promise;
}

/** Synchronous `container ls` for `SandboxControl.status`, which has no `await`. */
export function runCliSync(cli: string, args: string[], timeout: number): Result<CliOutput, Error> {
  const result = spawnSync(cli, args, { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) return err(result.error);
  if (result.status !== 0)
    return err(new Error((result.stderr || `container ${args[0]} exited with ${result.status}`).trim().slice(0, 512)));
  return ok({ code: result.status, stdout: result.stdout, stderr: result.stderr });
}

/** Every container the CLI reports, running and stopped, narrowed to `{ id, state }`. */
export function listContainers(cli: string): Result<ContainerRow[], Error> {
  const listed = runCliSync(cli, ["ls", "--all", "--format", "json"], CLI_TIMEOUT_MS);
  if (!listed.ok) return listed;
  return parseContainerRows(listed.value.stdout);
}

/** The same listing without blocking the event loop; used while a command runs. */
export async function listContainersAsync(cli: string): Promise<Result<ContainerRow[], Error>> {
  const listed = await runCli(cli, ["ls", "--all", "--format", "json"], CLI_TIMEOUT_MS);
  if (!listed.ok) return err(toError(listed.error));
  if (listed.value.code !== 0)
    return err(new Error((listed.value.stderr || `container ls exited with ${listed.value.code}`).trim().slice(0, 512)));
  return parseContainerRows(listed.value.stdout);
}

function parseContainerRows(stdout: string): Result<ContainerRow[], Error> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return err(toError(error));
  }
  if (!Array.isArray(parsed)) return err(new Error("container ls: expected a JSON array"));
  const rows: ContainerRow[] = [];
  for (const row of parsed) {
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof id !== "string") continue;
    const state = (row as { status?: { state?: unknown } } | null)?.status?.state;
    rows.push({ id, state: typeof state === "string" ? state : "unknown" });
  }
  return ok(rows);
}

/**
 * Buffers output until the caller's spill thresholds are exceeded, then keeps the complete
 * output in a workspace file. The reported path is in the caller's naming, so the model can
 * read it back through the same confined environment.
 */
class SpillWriter {
  private target: { host: string; logical: string } | null = null;
  private stream: WriteStream | null = null;
  private prefix: Buffer[] = [];
  private seenBytes = 0;
  private seenNewlines = 0;

  constructor(
    private readonly afterBytes: number,
    private readonly afterLines: number,
    private readonly allocate: () => { host: string; logical: string },
  ) {}

  get spillPath(): string | undefined {
    return this.target?.logical;
  }

  async feed(chunk: Buffer): Promise<void> {
    if (this.target !== null) return this.write(chunk);
    this.seenBytes += chunk.length;
    for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, index + 1)) this.seenNewlines += 1;
    const lines = this.seenNewlines + (chunk[chunk.length - 1] === 0x0a ? 0 : 1);
    if (this.seenBytes <= this.afterBytes && lines <= this.afterLines) {
      this.prefix.push(chunk);
      return;
    }
    this.target = this.allocate();
    // The spill target lives in the workspace's verified `.ghost-tmp`; the open is create-only
    // and never follows a symlink, so a swapped path cannot redirect the output.
    const fd = openSync(
      this.target.host,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    this.stream = createWriteStream(this.target.host, { fd });
    const buffered = this.prefix;
    this.prefix = [];
    for (const bufferedChunk of buffered) await this.write(bufferedChunk);
    await this.write(chunk);
  }

  private write(chunk: Buffer): Promise<void> {
    const stream = this.stream!;
    const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<void>();
    if (stream.write(chunk)) resolvePromise();
    else {
      stream.once("drain", resolvePromise);
      stream.once("error", reject);
    }
    return promise;
  }

  async finish(): Promise<void> {
    const stream = this.stream;
    if (stream === null) return;
    const { promise, resolve: resolvePromise } = Promise.withResolvers<void>();
    stream.once("error", () => resolvePromise());
    stream.once("finish", resolvePromise);
    stream.end();
    await promise;
  }
}

/**
 * One Apple container per live Work, started lazily on first `exec`: read-only root, network
 * `none`, no DNS, capabilities dropped, no init reaping left to the guest (`--init`), bounded
 * resources (2 CPUs / 2 GiB) and a writable tmpfs at `/tmp`; only the Work's workspace is
 * bind-mounted at `/workspace` — no host home, credentials or other mounts. File operations
 * never enter the container; they run against the host workspace with the same confinement
 * (see `WorkspaceEnv`).
 */
export class ContainerDriver {
  constructor(
    private readonly target: ContainerTarget,
    private readonly hooks: ContainerHooks = {},
  ) {}

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    const timeout = timeoutMs(options?.timeout);
    if (!timeout.ok) return err(timeout.error);
    const workdir = workdirIn(options?.cwd, this.target.logicalRoot);
    if (!workdir.ok) return workdir;
    const started = await this.ensureRunning();
    if (!started.ok) return started;
    const envFlags = [...GUEST_BASE_ENV, ...Object.entries(options?.env ?? {}).map(([key, value]) => `${key}=${value}`)].flatMap(
      (entry) => ["-e", entry],
    );
    const argv = [
      this.target.cli,
      "exec",
      "-w",
      workdir.value,
      ...envFlags,
      ...userFlags(),
      this.target.name,
      ...(typeof command === "string" ? ["/bin/sh", "-lc", command] : [...command]),
    ];
    return this.run(argv, timeout.ms, context, options);
  }

  /** Start the container if it is not running; a stopped one is deleted and rebuilt fresh. */
  private async ensureRunning(): Promise<Result<null, ExecutionError>> {
    const listed = await listContainersAsync(this.target.cli);
    if (!listed.ok)
      return err(new ExecutionError("spawn_error", `container ls failed: ${listed.error.message}`, toError(listed.error)));
    const row = listed.value.find((candidate) => candidate.id === this.target.name);
    if (row?.state === "running") return ok(null);
    if (row) {
      const deleted = await runCli(this.target.cli, ["delete", "--force", this.target.name], CLI_TIMEOUT_MS);
      if (!deleted.ok || deleted.value.code !== 0)
        return err(
          new ExecutionError(
            "spawn_error",
            `container delete failed: ${(!deleted.ok ? deleted.error.message : deleted.value.stderr).trim().slice(0, 512)}`,
            deleted.ok ? undefined : toError(deleted.error),
          ),
        );
      this.hooks.onChanged?.();
    }
    const run = await runCli(
      this.target.cli,
      [
        "run",
        "--detach",
        "--name",
        this.target.name,
        "--os",
        "linux",
        "--arch",
        "arm64",
        ...userFlags(),
        "--cap-drop",
        "ALL",
        "--read-only",
        "--network",
        "none",
        "--no-dns",
        // `HOME` and `TMPDIR` point at /tmp, so git, heredocs and similar tools need it writable.
        "--tmpfs",
        "/tmp",
        "--init",
        "--cpus",
        CONTAINER_CPUS,
        "--memory",
        CONTAINER_MEMORY,
        "--workdir",
        "/workspace",
        "--mount",
        `source=${this.target.workspace},target=/workspace`,
        this.target.image,
        "/bin/sh",
        "-c",
        "exec sleep infinity",
      ],
      RUN_TIMEOUT_MS,
    );
    if (!run.ok || run.value.code !== 0)
      return err(
        new ExecutionError(
          "spawn_error",
          `container run failed: ${(!run.ok ? run.error.message : run.value.stderr).trim().slice(0, 512)}`,
          run.ok ? undefined : toError(run.error),
        ),
      );
    this.hooks.onChanged?.();
    return ok(null);
  }

  private newSpillTarget(): { host: string; logical: string } {
    const name = `pi-output-${randomUUID()}.log`;
    const host = join(ensureTempRoot(this.target.workspace), name);
    return { host, logical: `${this.target.logicalRoot}/.ghost-tmp/${name}` };
  }

  /** Stream `container exec` output through the caller's window, with spill, timeout and abort. */
  private run(
    argv: string[],
    timeout: number | undefined,
    context: Context,
    options: ShellExecOptions | undefined,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const { promise, resolve: settle } = Promise.withResolvers<Result<ShellExecResult, ExecutionError>>();
    {
      let child: ChildProcess;
      let settled = false;
      let timedOut = false;
      let callbackError: ExecutionError | undefined;
      let spillFailed: ExecutionError | undefined;
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      let exited = false;
      let stdoutEnded = false;
      let stderrEnded = false;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = context.abortSignal;
      const spill = options?.spill;
      const writer = spill === undefined ? null : new SpillWriter(spill.afterBytes, spill.afterLines, () => this.newSpillTarget());
      let spillChain: Promise<void> = Promise.resolve();

      const done = (result: Result<ShellExecResult, ExecutionError>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        settle(result);
      };
      const kill = () => {
        if (child.pid) killTree(child.pid);
      };

      try {
        child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
      } catch (error) {
        const cause = toError(error);
        done(err(new ExecutionError("spawn_error", cause.message, cause)));
        return promise;
      }
      const pid = child.pid;
      if (pid !== undefined) {
        this.hooks.onSpawn?.(pid);
        child.on("close", () => this.hooks.onExit?.(pid));
      }
      timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              kill();
            }, timeout);
      if (signal) {
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }

      const emit = (text: string, stream: "stdout" | "stderr") => {
        if (settled || text === "" || options?.onOutput === undefined || callbackError !== undefined) return;
        try {
          options.onOutput(text, context, { stream });
        } catch (error) {
          const cause = toError(error);
          callbackError = new ExecutionError("callback_error", cause.message, cause);
          kill();
        }
      };
      const stdoutDecoder = new StreamDecoder();
      const stderrDecoder = new StreamDecoder();
      const feed = (stream: "stdout" | "stderr", decoder: StreamDecoder) => (chunk: Buffer) => {
        emit(decoder.decode(chunk), stream);
        if (writer === null || chunk.length === 0) return;
        spillChain = spillChain.then(() => writer.feed(chunk)).catch((error: unknown) => {
          const cause = toError(error);
          spillFailed = new ExecutionError("unknown", `Failed to preserve complete shell output: ${cause.message}`, cause);
          kill();
        });
      };
      child.stdout?.on("data", feed("stdout", stdoutDecoder));
      child.stderr?.on("data", feed("stderr", stderrDecoder));

      const trySettle = () => {
        if (!exited || settled) return;
        if (!(stdoutEnded && stderrEnded)) {
          if (graceTimer === undefined)
            // No output reaches the caller after exec settled, even from a descendant holding stdio open.
            graceTimer = setTimeout(() => {
              stdoutEnded = true;
              stderrEnded = true;
              trySettle();
            }, 1000);
          return;
        }
        clearTimeout(graceTimer);
        void (async () => {
          await spillChain;
          await writer?.finish();
          emit(stdoutDecoder.decode(), "stdout");
          emit(stderrDecoder.decode(), "stderr");
          if (callbackError !== undefined) return done(err(callbackError));
          const interrupted = timedOut
            ? new ExecutionError("timeout", `timeout:${options?.timeout}`)
            : signal?.aborted
              ? new ExecutionError("aborted", "aborted")
              : undefined;
          if (interrupted !== undefined) {
            interrupted.spillPath = writer?.spillPath;
            return done(err(interrupted));
          }
          if (spillFailed !== undefined) return done(err(spillFailed));
          // A signal-killed process has no exit code; map it to the conventional 128 + signal number.
          const code = exitCode ?? (exitSignal !== null ? 128 + (SIGNAL_NUMBERS[exitSignal] ?? 0) : 1);
          done(ok({ exitCode: code, ...(writer?.spillPath === undefined ? {} : { spillPath: writer.spillPath }) }));
        })();
      };
      child.on("close", (code, closeSignal) => {
        exited = true;
        exitCode = code;
        exitSignal = closeSignal;
        trySettle();
      });
      child.stdout?.on("end", () => {
        stdoutEnded = true;
        trySettle();
      });
      child.stderr?.on("end", () => {
        stderrEnded = true;
        trySettle();
      });
      child.on("error", (error) => done(err(new ExecutionError("spawn_error", error.message, error))));
    }
    return promise;
  }
}

/** Run guest processes as the host user so workspace ownership stays consistent; omit when unknown. */
function userFlags(): string[] {
  try {
    const user = userInfo();
    return ["--uid", String(user.uid), "--gid", String(user.gid)];
  } catch {
    return [];
  }
}
