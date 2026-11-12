import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import { homedir, constants as osConstants } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ExecutionTarget } from "@ghost/contract";
import {
  ExecutionError, FileError, StreamDecoder, err, ok, toError,
  type BinaryReader, type DirReader, type FileInfo, type FileWatcher, type Result,
  type ShellExecOptions, type ShellExecResult, type TextLineReader, type WatchChange, type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ensureTempRoot, killTree, WorkspaceEnv } from "./workspace-env.ts";
import { repositoryOf } from "./worktree.ts";
import { privacyGuardedCommand } from "./privacy-guard.ts";
import {
  explainSeatbeltRefusal, realBelow, seatbeltArgv, seatbeltDecision, seatbeltRefusal,
  type SeatbeltPolicy,
} from "./seatbelt.ts";

/** Both delivered output and spill storage are bounded; exceeding this fails and kills the command. */
export const HOST_OUTPUT_LIMIT = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Validate at admission and again when opening an environment. Never create an owner's cwd. */
export function validateExecutionTarget(target: ExecutionTarget): void {
  if (target.kind === "container" || target.kind === "workspace") return;
  if (target.kind !== "host" || typeof target.cwd !== "string" || !isAbsolute(target.cwd) || target.cwd.includes("\0"))
    throw new Error("Host execution requires an absolute PC working directory");
  const cwd = realpathSync(target.cwd);
  if (!statSync(cwd).isDirectory()) throw new Error(`Host execution cwd is not a directory: ${target.cwd}`);
  accessSync(cwd, constants.R_OK | constants.X_OK);
  if (target.worktree) repositoryOf(cwd);
}

/** One FIFO of PC mutations: shared by PC Works in owner directories, one per Work worktree. Reads need not take it. */
export class HostMutationQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(signal: AbortSignal, action: () => Promise<T>, cancelled: () => T): Promise<T> {
    const previous = this.tail;
    const slot = Promise.withResolvers<void>();
    // Even a cancelled waiter must retain its predecessor in the chain: later callers cannot bypass it.
    this.tail = previous.then(() => slot.promise);
    const interrupted = Promise.withResolvers<boolean>();
    const abort = () => interrupted.resolve(false);
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) return cancelled();
      const ready = await Promise.race([previous.then(() => true), interrupted.promise]);
      if (!ready || signal.aborted) return cancelled();
      return await action();
    } finally {
      signal.removeEventListener("abort", abort);
      slot.resolve();
    }
  }
}

interface HostEnvOptions {
  cwd: string;
  workspace: string;
  id: string;
  mutations: HostMutationQueue;
  deadlineAt: number | null;
  /** Revalidate live Work/PC/activity authority and return its opaque permission revision. */
  authorize?: () => string;
  /**
   * macOS Seatbelt boundary: when set, every command runs under `sandbox-exec` with this policy
   * and every file operation is checked against it (writes confined like the kernel confines
   * them, reads refused where the kernel refuses). Without it the environment is unrestricted.
   */
  boundary?: SeatbeltPolicy;
  /** Extra environment variables every confined command receives (review paths, for example). */
  extraProcessEnv?: Record<string, string>;
}

/**
 * PC filesystem and shell for one Work. Without a boundary it is intentionally unrestricted, not
 * a sandbox; the SDK supplies real file semantics (including absolute paths and symlinks) and
 * only mutations and exec are serialized. Commands that name or walk macOS privacy-guarded
 * folders are refused before they start: unattended, they would only hang on a consent prompt.
 * With a boundary (`options.boundary`, the workspace execution kind) every command runs under
 * `sandbox-exec` and every file operation is checked against the same policy, so the Host-side
 * answer and the kernel's answer agree. The separate confined workspace remains the
 * artifact/delegation/output staging location.
 */
export class HostExecutionEnv extends NodeExecutionEnv {
  override readonly id: string;
  readonly logicalRoot: string;
  private readonly staging: WorkspaceEnv;
  private readonly stopped = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly children = new Set<number>();
  private readonly boundary: SeatbeltPolicy | null;
  /** One confined single-root environment per real root, so its no-follow checks apply per path. */
  private readonly confinedRoots = new Map<string, WorkspaceEnv>();
  /** Routes unrestricted operations to the base class: `this.x` would recurse into this override. */
  private baseDelegate: NodeExecutionEnv | null = null;

  private get base(): NodeExecutionEnv {
    this.baseDelegate ??= new NodeExecutionEnv({ cwd: this.cwd });
    return this.baseDelegate;
  }

  constructor(private readonly options: HostEnvOptions) {
    validateExecutionTarget({ kind: "host", cwd: options.cwd });
    super({ cwd: options.cwd });
    this.id = options.id;
    this.logicalRoot = options.cwd;
    this.staging = new WorkspaceEnv({ hostRoot: options.workspace });
    this.boundary = options.boundary ?? null;
    if (this.boundary !== null && this.staging.hostRoot !== options.workspace)
      throw new FileError("permission_denied", "sandbox: refusing redirected staging root", options.workspace);
  }

  /** A caller path in this environment's spelling, resolved to the real path the boundary sees. */
  private realTarget(path: string): string | null {
    let spelling = path;
    if (spelling === "~") spelling = homedir();
    else if (spelling.startsWith("~/")) spelling = join(homedir(), spelling.slice(2));
    else if (spelling.startsWith("file://")) spelling = fileURLToPath(spelling);
    return realBelow(resolve(this.cwd, spelling));
  }

  /**
   * The environment and host path an operation on `path` must use: a confined single-root
   * environment for paths inside the boundary's roots (writes only there), this environment for
   * read-only system locations. `null` (not a FileError) means "no boundary": plain host I/O.
   */
  private within(path: string, mode: "read" | "write"): { env: NodeExecutionEnv; host: string } | FileError | null {
    if (this.boundary === null) return null;
    const real = this.realTarget(path);
    if (real === null) return new FileError("not_found", `No such path: ${path}`, path);
    const decision = seatbeltDecision(this.boundary, real, mode);
    if (!decision.ok) return new FileError("permission_denied", seatbeltRefusal(this.boundary, real, mode), path);
    if (mode === "write") return { env: this.confinedEnv(real, this.boundary.writeRoots), host: real };
    for (const roots of [this.boundary.writeRoots, this.boundary.viewRoots, this.boundary.readRoots]) {
      const root = roots.find((candidate) => real === candidate || real.startsWith(`${candidate}/`));
      if (root !== undefined) return { env: this.confinedEnv(real, [root]), host: real };
    }
    // System and toolchain reads stay on the unrestricted base: they are read-only locations.
    return { env: this.base, host: real };
  }

  private confinedEnv(real: string, roots: string[]): NodeExecutionEnv {
    const root = roots.find((candidate) => real === candidate || real.startsWith(`${candidate}/`));
    if (root === undefined) throw new Error(`host execution: path outside its roots: ${real}`);
    let env = this.confinedRoots.get(root);
    if (env === undefined) {
      env = new WorkspaceEnv({ hostRoot: root, id: `ghost-confined:${root}` });
      if (env.hostRoot !== root)
        throw new FileError("permission_denied", `sandbox: writable or reviewed root was redirected: ${root}`, root);
      this.confinedRoots.set(root, env);
    }
    return env;
  }

  private boundaryRead<T>(
    path: string,
    context: Context,
    op: (env: NodeExecutionEnv, host: string, stamp: string | undefined) => Promise<Result<T, FileError>>,
  ): Promise<Result<T, FileError>> {
    return this.readAuthorized((stamp) => {
      const target = this.within(path, "read");
      if (target instanceof FileError) return Promise.resolve(err(target));
      return op(target === null ? this.base : target.env, target === null ? path : target.host, stamp);
    });
  }

  private authorize(expected?: string): Result<string | undefined, FileError> {
    try {
      const stamp = this.options.authorize?.();
      if (expected !== undefined && stamp !== expected)
        throw new Error("Host execution authority changed while this operation was waiting");
      return ok(stamp);
    } catch (error) {
      const cause = toError(error);
      return err(new FileError("permission_denied", `PC permission denied: ${cause.message}`, undefined, cause));
    }
  }

  private readAuthorized<T>(
    action: (stamp: string | undefined) => Promise<Result<T, FileError>>,
    expected?: string,
  ): Promise<Result<T, FileError>> {
    const permission = this.authorize(expected);
    return permission.ok ? action(permission.value) : Promise.resolve(err(permission.error));
  }

  override absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.readAuthorized(() => super.absolutePath(path, context));
  }
  override joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    return this.readAuthorized(() => super.joinPath(parts, context));
  }
  override readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.boundaryRead(path, context, (env, host) => env.readTextFile(host, context));
  }
  override readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    return this.boundaryRead(path, context, (env, host) => env.readTextLines(host, options, context));
  }
  override readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.boundaryRead(path, context, (env, host) => env.readBinaryFile(host, context));
  }
  override fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.boundaryRead(path, context, (env, host) => env.fileInfo(host, context));
  }
  override listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.boundaryRead(path, context, (env, host) => env.listDir(host, context));
  }
  override canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.boundaryRead(path, context, (env, host) => env.canonicalPath(host, context));
  }
  override exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.boundaryRead(path, context, (env, host) => env.exists(host, context));
  }
  override openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.boundaryRead(path, context, async (env, host, stamp) => {
      const opened = await env.openTextLineReader(host, context);
      if (!opened.ok) return opened;
      if (stamp === undefined) return opened;
      const reader = opened.value;
      const current = this.authorize(stamp);
      if (!current.ok) { await reader.close(BACKGROUND_CONTEXT); return err(current.error); }
      return ok({
        readLine: (ctx: Context) => this.readAuthorized(() => reader.readLine(ctx), stamp),
        close: (ctx: Context) => reader.close(ctx),
      } satisfies TextLineReader);
    });
  }
  override openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    return this.boundaryRead(path, context, async (env, host, stamp) => {
      const opened = await env.openBinaryReader(host, options, context);
      if (!opened.ok) return opened;
      if (stamp === undefined) return opened;
      const reader = opened.value;
      const current = this.authorize(stamp);
      if (!current.ok) { await reader.close(BACKGROUND_CONTEXT); return err(current.error); }
      return ok({
        info: (ctx: Context) => this.readAuthorized(() => reader.info(ctx), stamp),
        read: (offset: number, length: number, ctx: Context) => this.readAuthorized(() => reader.read(offset, length, ctx), stamp),
        scanLines: (scanOptions: Parameters<BinaryReader["scanLines"]>[0], ctx: Context) => this.readAuthorized(() => reader.scanLines(scanOptions, ctx), stamp),
        close: (ctx: Context) => reader.close(ctx),
      } satisfies BinaryReader);
    });
  }
  override openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.boundaryRead(path, context, async (env, host, stamp) => {
      const opened = await env.openDirReader(host, context);
      if (!opened.ok) return opened;
      if (stamp === undefined) return opened;
      const reader = opened.value;
      const current = this.authorize(stamp);
      if (!current.ok) { await reader.close(BACKGROUND_CONTEXT); return err(current.error); }
      return ok({
        next: (maxEntries: number, ctx: Context) => this.readAuthorized(() => reader.next(maxEntries, ctx), stamp),
        close: (ctx: Context) => reader.close(ctx),
      } satisfies DirReader);
    });
  }


  override watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
    const watched = this.boundary === null ? [...targets] : targets.map((target) => {
      const within = this.within(target.path, "read");
      return within instanceof FileError ? null : { ...target, path: within === null ? target.path : within.host };
    });
    if (watched.some((target) => target === null))
      return Promise.resolve(err(new FileError("permission_denied", "watch target is outside this environment's readable roots", targets[0]?.path)));
    return this.readAuthorized(async (stamp) => {
      let watcher: FileWatcher | undefined;
      let revoked = false;
      const opened = await super.watch(watched as WatchTarget[], (change) => {
        if (revoked) return;
        const permission = this.authorize(stamp);
        if (permission.ok) onChange(change);
        else {
          revoked = true;
          void watcher?.close(BACKGROUND_CONTEXT);
          onChange({ error: permission.error });
        }
      }, context);
      if (!opened.ok) return opened;
      watcher = opened.value;
      const current = this.authorize(stamp);
      if (!current.ok || revoked) {
        await watcher.close(BACKGROUND_CONTEXT);
        return err(current.ok ? new FileError("permission_denied", "PC watch authority revoked") : current.error);
      }
      return opened;
    });
  }

  private mutate<T, E>(
    context: Context,
    action: (context: Context, stamp: string | undefined) => Promise<Result<T, E>>,
    interrupted: (timedOut: boolean) => E,
    denied: (error: FileError) => E,
    timeoutMs?: number,
  ): Promise<Result<T, E>> {
    const permission = this.authorize();
    if (!permission.ok) return Promise.resolve(err<T, E>(denied(permission.error)));
    const deadline = new AbortController();
    let timedOut = false;
    const remaining = this.options.deadlineAt === null ? undefined : this.options.deadlineAt - Date.now();
    const duration = remaining === undefined ? timeoutMs : Math.min(remaining, timeoutMs ?? Infinity);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (duration !== undefined) {
      const expire = () => {
        timedOut = true;
        deadline.abort(new ExecutionError("timeout", "Command or Work deadline exceeded"));
      };
      if (duration <= 0) expire();
      else timer = setTimeout(expire, Math.min(duration, MAX_TIMEOUT_MS));
    }
    const signals = [this.stopped.signal, deadline.signal];
    if (context.abortSignal) signals.push(context.abortSignal);
    const signal = AbortSignal.any(signals);
    const derived = withAbortSignal(signal, context);
    const operation = this.options.mutations.run<Result<T, E>>(signal, () => {
      // Admission alone is insufficient: another Work may have held this Host's shared lock.
      const current = this.authorize(permission.value);
      return current.ok ? action(derived, permission.value) : Promise.resolve(err<T, E>(denied(current.error)));
    }, () => err<T, E>(interrupted(timedOut))).finally(() => clearTimeout(timer));
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }

  private fileMutation<T>(
    paths: readonly string[],
    context: Context,
    action: (context: Context, targets: { env: NodeExecutionEnv; host: string }[]) => Promise<Result<T, FileError>>,
  ): Promise<Result<T, FileError>> {
    return this.mutate<T, FileError>(
      context,
      async (ctx) => {
        const targets: { env: NodeExecutionEnv; host: string }[] = [];
        for (const path of paths) {
          // Without a boundary every path stays on the unrestricted base environment.
          const within = this.boundary === null ? null : this.within(path, "write");
          if (within instanceof FileError) return err(within);
          targets.push(within === null ? { env: this.base, host: path } : within);
        }
        // Every mutated path must live in one writable root; `rename` stays inside one tree.
        const envs = new Set(targets.map((target) => target.env));
        if (envs.size > 1)
          return err(new FileError("invalid", "A move between two writable roots is refused; copy the file instead", paths[0]));
        return action(ctx, targets);
      },
      (timedOut) => new FileError("aborted", timedOut ? "Work deadline exceeded" : "aborted"),
      (error) => error,
    );
  }

  override writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.fileMutation([path], context, (ctx, targets) => targets[0]!.env.writeFile(targets[0]!.host, content, ctx));
  }
  override appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.fileMutation([path], context, (ctx, targets) => targets[0]!.env.appendFile(targets[0]!.host, content, ctx));
  }
  override truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    return this.fileMutation([path], context, (ctx, targets) => targets[0]!.env.truncateFile(targets[0]!.host, size, ctx));
  }
  override flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.fileMutation([path], context, (ctx, targets) => targets[0]!.env.flushFile(targets[0]!.host, ctx));
  }
  override renameFile(source: string, destination: string, context: Context): Promise<Result<void, FileError>> {
    return this.fileMutation([source, destination], context, (ctx, targets) => targets[0]!.env.renameFile(targets[0]!.host, targets[1]!.host, ctx));
  }
  override createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.fileMutation([path], context, (ctx, targets) => targets[0]!.env.createDir(targets[0]!.host, options, ctx));
  }
  override remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    return this.fileMutation([path], context, (ctx, targets) => targets[0]!.env.remove(targets[0]!.host, options, ctx));
  }
  override createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.fileMutation([], context, (ctx) => this.staging.createTempDir(prefix, ctx));
  }
  override createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.fileMutation([], context, (ctx) => this.staging.createTempFile(options, ctx));
  }

  override exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const timeout = options?.timeout;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > MAX_TIMEOUT_MS))
      return Promise.resolve(err(new ExecutionError("timeout", "Invalid timeout: must be positive finite seconds within the platform timer limit")));
    return this.mutate(
      context,
      (ctx, stamp) => this.run(command, options, ctx, stamp),
      (timedOut) => new ExecutionError(timedOut ? "timeout" : "aborted", timedOut ? "Command or Work deadline exceeded" : "aborted"),
      (error) => new ExecutionError("spawn_error", error.message, error),
      timeout === undefined ? undefined : timeout * 1000,
    );
  }

  private async run(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context, stamp: string | undefined): Promise<Result<ShellExecResult, ExecutionError>> {
    const cwd = await this.absolutePath(options?.cwd ?? this.cwd, context);
    if (!cwd.ok) return err(new ExecutionError("spawn_error", cwd.error.message, cwd.error));
    if (this.boundary !== null) {
      const real = realBelow(cwd.value);
      if (real === null || !seatbeltDecision(this.boundary, real, "read").ok)
        return err(new ExecutionError("spawn_error", `workspace execution cannot run in ${cwd.value}: it is outside the readable roots`));
    }
    const refusal = privacyGuardedCommand(
      typeof command === "string" ? command : command.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" "),
      { home: homedir(), cwd: cwd.value },
    );
    if (refusal) return err(new ExecutionError("spawn_error", refusal));
    let argv = typeof command === "string" ? ["/bin/bash", "--noprofile", "--norc", "-c", command] : command;
    if (argv.length === 0) return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));
    if (this.boundary !== null) {
      try { argv = seatbeltArgv(this.boundary, [...argv]); }
      catch (error) { return err(new ExecutionError("spawn_error", toError(error).message)); }
    }
    const signal = context.abortSignal!;
    if (signal.aborted) return err(signal.reason instanceof ExecutionError ? signal.reason : new ExecutionError("aborted", "aborted"));
    const capture = new HostOutput(this.staging.hostRoot, options?.spill);
    const { promise, resolve } = Promise.withResolvers<Result<ShellExecResult, ExecutionError>>();
    {
      let finished = false;
      let finishing = false;
      let failure: ExecutionError | undefined;
      let decodedBytes = 0;
      let child: ChildProcess;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const stdout = new StreamDecoder();
      const stderr = new StreamDecoder();
      // Bounded tail of decoded output, so a sandbox refusal can be explained after exit.
      let tail = "";
      const kill = () => { if (child.pid !== undefined) killTree(child.pid); };
      const fail = (error: ExecutionError) => { failure ??= error; kill(); };
      const emit = (text: string, stream: "stdout" | "stderr") => {
        if (text === "" || failure || finished) return;
        decodedBytes += Buffer.byteLength(text);
        if (decodedBytes > HOST_OUTPUT_LIMIT) {
          fail(new ExecutionError("unknown", `PC command decoded output exceeded ${HOST_OUTPUT_LIMIT} bytes; command terminated`));
          return;
        }
        tail = (tail + text).slice(-8_000);
        try { options?.onOutput?.(text, context, { stream }); }
        catch (error) {
          const cause = toError(error);
          fail(new ExecutionError("callback_error", cause.message, cause));
        }
      };
      const done = (code: number | null, exitSignal: NodeJS.Signals | null) => {
        if (finished || finishing) return;
        finishing = true;
        clearTimeout(grace);
        signal.removeEventListener("abort", kill);
        // A shell can exit while a background child still owns stdio. Do not leave that child
        // running after releasing the global mutation lock, even on a successful shell exit.
        kill();
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (child.pid !== undefined) this.children.delete(child.pid);
        emit(stdout.decode(), "stdout");
        emit(stderr.decode(), "stderr");
        if (this.boundary !== null && failure === undefined && (code ?? 1) !== 0) {
          const explanation = explainSeatbeltRefusal(tail, { cwd: cwd.value, policy: this.boundary });
          if (explanation !== null) {
            try { options?.onOutput?.(`\n${explanation}\n`, context, { stream: "stderr" }); }
            catch { /* The caller's callback already failed once; the command result stands. */ }
          }
        }
        try { capture.close(); }
        catch (error) { failure ??= new ExecutionError("unknown", toError(error).message, toError(error)); }
        finished = true;
        if (signal.aborted) {
          failure = signal.reason instanceof ExecutionError ? signal.reason : new ExecutionError("aborted", "aborted");
        }
        if (failure) {
          failure.spillPath = capture.spillPath;
          resolve(err(failure));
        } else {
          // SIGKILL/SIGTERM and other signals must never look like a successful exit.
          resolve(ok({ exitCode: code ?? (exitSignal ? 128 + (osConstants.signals[exitSignal] ?? 0) : 1), ...(capture.spillPath ? { spillPath: capture.spillPath } : {}) }));
        }
      };
      try {
        const permission = this.authorize(stamp);
        if (!permission.ok) {
          resolve(err(new ExecutionError("spawn_error", permission.error.message, permission.error)));
          return promise;
        }
        child = spawn(argv[0]!, argv.slice(1), {
          cwd: cwd.value,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          // No inherited tokens, provider keys, BASH_ENV or startup-file configuration.
          // Explicit per-call values are permitted: the boundary (or full PC authority) still holds.
          env: {
            PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            HOME: homedir(),
            LANG: "en_US.UTF-8",
            TMPDIR: ensureTempRoot(this.staging.hostRoot),
            ...options?.env,
            ...(this.boundary === null ? {} : this.boundaryProcessEnv()),
          },
        });
      } catch (error) {
        capture.close();
        const cause = toError(error);
        resolve(err(new ExecutionError("spawn_error", cause.message, cause)));
        return promise;
      }
      if (child.pid !== undefined) this.children.add(child.pid);
      const feed = (stream: "stdout" | "stderr", decoder: StreamDecoder) => (chunk: Buffer) => {
        if (finished || finishing || failure) return;
        try { capture.feed(chunk); }
        catch (error) {
          const cause = toError(error);
          fail(new ExecutionError("unknown", cause.message, cause));
          return;
        }
        emit(decoder.decode(chunk), stream);
      };
      child.stdout?.on("data", feed("stdout", stdout));
      child.stderr?.on("data", feed("stderr", stderr));
      child.once("error", (error) => { failure = new ExecutionError("spawn_error", error.message, error); done(null, null); });
      child.once("exit", (code, exitSignal) => {
        if (finished) return;
        kill();
        // Drain already-buffered output, but never wait forever for inherited child descriptors.
        grace = setTimeout(() => done(code, exitSignal), 100);
      });
      child.once("close", done);
      signal.addEventListener("abort", kill, { once: true });
      if (signal.aborted) kill();
    }
    return promise;
  }

  /**
   * The environment every confined command runs with: a private HOME and TMPDIR inside the Work's
   * own scratch (no dotfiles appear in the workspace or the owner's home), caches redirected
   * there, toolchain homes still read from the real home, git identity from the owner's global
   * config, background git maintenance off, and the egress proxy as the only network. These
   * protected settings override per-call `options.env`; the kernel boundary still holds.
   */
  private boundaryProcessEnv(): Record<string, string> {
    const temp = ensureTempRoot(this.staging.hostRoot);
    const home = join(temp, "home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const cache = join(temp, "cache");
    const realHome = homedir();
    const proxy = this.boundary?.proxyPort ?? null;
    const proxyUrl = proxy === null ? null : `http://127.0.0.1:${proxy}`;
    const gitconfig = join(realHome, ".gitconfig");
    return {
      HOME: home,
      TMPDIR: temp,
      LANG: "en_US.UTF-8",
      XDG_CACHE_HOME: cache,
      UV_CACHE_DIR: join(cache, "uv"),
      NPM_CONFIG_CACHE: join(cache, "npm"),
      CLANG_MODULE_CACHE_PATH: join(cache, "clang"),
      CARGO_HOME: join(cache, "cargo"),
      ...(existsSync(join(realHome, ".rustup")) ? { RUSTUP_HOME: join(realHome, ".rustup") } : {}),
      ...(existsSync(gitconfig) ? { GIT_CONFIG_GLOBAL: gitconfig } : {}),
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "gc.auto",
      GIT_CONFIG_VALUE_0: "0",
      GIT_CONFIG_KEY_1: "maintenance.auto",
      GIT_CONFIG_VALUE_1: "false",
      HTTP_PROXY: proxyUrl ?? "", HTTPS_PROXY: proxyUrl ?? "", ALL_PROXY: proxyUrl ?? "",
      http_proxy: proxyUrl ?? "", https_proxy: proxyUrl ?? "", all_proxy: proxyUrl ?? "",
      no_proxy: "", NO_PROXY: "",
      ...this.options.extraProcessEnv,
    };
  }

  override async cleanup(context: Context): Promise<void> {
    this.stopped.abort();
    for (const pid of this.children) killTree(pid);
    await Promise.allSettled([...this.pending]);
    await this.staging.cleanup(context);
    await super.cleanup(context);
  }
}

/** Synchronous bounded spill writes avoid an unbounded async output queue. */
class HostOutput {
  private bytes = 0;
  private newlines = 0;
  private prefix: Buffer[] = [];
  private fd: number | undefined;
  spillPath: string | undefined;

  constructor(private readonly workspace: string, private readonly spill: ShellExecOptions["spill"]) {}

  feed(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > HOST_OUTPUT_LIMIT) throw new Error(`PC command output exceeded ${HOST_OUTPUT_LIMIT} bytes; command terminated`);
    if (!this.spill) return;
    if (this.fd !== undefined) { this.write(chunk); return; }
    for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, index + 1)) this.newlines += 1;
    const lines = this.newlines + (chunk[chunk.length - 1] === 0x0a ? 0 : 1);
    if (this.bytes <= this.spill.afterBytes && lines <= this.spill.afterLines) { this.prefix.push(chunk); return; }
    const path = join(ensureTempRoot(this.workspace), `pi-output-${randomUUID()}.log`);
    this.fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
    this.spillPath = path;
    for (const buffered of this.prefix) this.write(buffered);
    this.prefix = [];
    this.write(chunk);
  }

  private write(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) offset += writeSync(this.fd!, chunk, offset, chunk.length - offset);
  }

  close(): void {
    if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; }
    this.prefix = [];
  }
}
