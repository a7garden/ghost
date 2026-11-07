import { randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  ExecutionError,
  FileError,
  LineScanner,
  StreamDecoder,
  err,
  ok,
  toError,
  type BinaryReader,
  type DirReader,
  type FileInfo,
  type FileWatcher,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/**
 * Kills a command's process group, then the process itself; the second attempt
 * covers children that escaped the group.
 */
export function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function fileErrorFrom(error: unknown, path?: string): FileError {
  if (error instanceof FileError) return error;
  const cause = toError(error);
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case "ENOENT":
      return new FileError("not_found", cause.message, path, cause);
    case "EACCES":
    case "EPERM":
      return new FileError("permission_denied", cause.message, path, cause);
    case "ENOTDIR":
      return new FileError("not_directory", cause.message, path, cause);
    case "EISDIR":
      return new FileError("is_directory", cause.message, path, cause);
    case "ELOOP":
      // O_NOFOLLOW reports a final-component symlink as ELOOP (EMLINK on some BSDs).
      return new FileError("invalid", "Refusing to follow a symbolic link", path, cause);
    case "EINVAL":
      return new FileError("invalid", cause.message, path, cause);
    default:
      return new FileError("unknown", cause.message, path, cause);
  }
}

/** Refuse when the directory holding `host` has a symlink planted in its chain; `ENOENT` passes so the caller's own syscall reports the missing path. */
function ensureRealParent(host: string): void {
  const parent = dirname(host);
  if (realpathSync(parent) !== parent)
    throw new FileError("permission_denied", `Refusing to operate through a swapped directory: ${parent}`, parent);
}

/**
 * Directory components of `host` below `base`, which the caller passes already resolved (never a
 * symlink, never climbing out).
 */
function parentSegments(base: string, host: string): string[] {
  const parent = dirname(host);
  if (parent === base) return [];
  return parent.slice(base.length + 1).split("/");
}

/**
 * Walk `segments` below the real directory `base`, refusing any symlink and any non-directory
 * component. With `create`, missing components become real 0700 directories one `mkdir` at a
 * time (never a recursive mkdir, which would traverse a planted symlink); without, the walk
 * stops at the first missing component and the deepest verified directory is returned. Every
 * component is re-`lstat`ed after a lost race, so nothing that appeared in between is followed.
 */
export function confineDirChain(base: string, segments: readonly string[], create: boolean): string {
  let current = base;
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    const next = join(current, segment);
    let stats: Stats | null = null;
    try {
      stats = lstatSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw fileErrorFrom(error, next);
    }
    if (stats === null) {
      if (!create) return current;
      try {
        mkdirSync(next, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error;
      }
      stats = lstatSync(next); // whatever appeared must be our own directory, or it is refused below
    }
    if (stats.isSymbolicLink())
      throw new FileError("permission_denied", `Refusing symbolic link in path: ${next}`, next);
    if (!stats.isDirectory()) throw new FileError("not_directory", `Not a directory: ${next}`, next);
    current = next;
  }
  return current;
}

/** Open `path` for reading without following a symlink in any component; the caller closes the fd. */
function openReadNoFollow(path: string): number {
  // Nonblocking, so opening a FIFO does not wait for a writer.
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    ensureRealParent(path); // the open must not have gone through a swapped directory
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

/** Read a regular file without following symlinks in any component of `path`; errors are mapped `FileError`s. */
export function readFileNoFollow(path: string): Buffer {
  try {
    const fd = openReadNoFollow(path);
    try {
      return readFileSync(fd); // reads the opened inode, not whatever the path names now
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw fileErrorFrom(error, path);
  }
}

/**
 * Write (truncate) or append `content` to `path` without following symlinks: the parent chain is
 * verified real before and after the open, the final component is opened `O_NOFOLLOW`, and the
 * existing-file case never carries `O_CREAT`, so a redirected open cannot create anything and
 * truncation happens only once confinement is confirmed. A create that turned out to be
 * redirected is unlinked again. Callers confine the parent chain themselves first.
 */
export function writeFileNoFollow(path: string, content: string | Uint8Array, mode: "write" | "append"): void {
  ensureRealParent(path); // fail before any side effect
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  let fd: number;
  let created = false;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error;
    fd = openSync(path, fsConstants.O_WRONLY | (mode === "append" ? fsConstants.O_APPEND : 0) | fsConstants.O_NOFOLLOW, 0o600);
  }
  try {
    ensureRealParent(path);
    if (!created && mode === "write") ftruncateSync(fd, 0);
    let written = 0;
    while (written < bytes.byteLength) written += writeSync(fd, bytes, written);
  } catch (error) {
    if (created) {
      try {
        unlinkSync(path); // remove what a redirected open planted outside
      } catch {
        // Best effort: the file may already be gone.
      }
    }
    throw error;
  } finally {
    closeSync(fd);
  }
}

/** The workspace's private scratch directory, created and verified as a real directory (never a model-planted symlink). */
export function ensureTempRoot(workspaceReal: string): string {
  return confineDirChain(workspaceReal, [".ghost-tmp"], true);
}

/** Execution of one command, as `Shell.exec` — host shell (local) or Apple container (container). */
export type ExecFn = (
  command: string | readonly string[],
  options: ShellExecOptions | undefined,
  context: Context,
) => Promise<Result<ShellExecResult, ExecutionError>>;

export interface WorkspaceEnvOptions {
  /** Workspace directory on the host. Must exist; its resolved path is where the files live. */
  hostRoot: string;
  /**
   * How the caller names the workspace root; defaults to `hostRoot` as given (local). An Apple
   * container names it `/workspace`, so file operations map `/workspace/x` onto the host workspace.
   */
  logicalRoot?: string;
  /** Pi filesystem namespace id. Distinct workspaces and containers must not share one. */
  id?: string;
  /** Replaces host shell execution (Apple container). */
  exec?: ExecFn;
}

/**
 * A Pi `ExecutionEnv` confined to one Work's workspace directory.
 *
 * Every path argument is mapped onto the workspace before it reaches the host filesystem:
 * relative paths resolve from the workspace root, `..` cannot climb out of it, absolute paths
 * outside it (and `~`, `file://` forms) are refused, and every component is `lstat`ed, so any
 * symlink — dangling or not — is refused instead of followed. Reads and writes open the mapped
 * path without following symlinks (`O_NOFOLLOW` on the final component, the parent directory
 * re-resolved before and after the open), so a directory swapped for a symlink after `map()`
 * cannot redirect I/O. Temporary files and directories are created inside the workspace's own
 * verified `.ghost-tmp`, keeping tool diagnostics readable.
 *
 * This confines the *filesystem namespace only, and it is not isolation*: with the local kind,
 * `exec` runs a host shell whose commands can still reach anything the host user can (absolute
 * redirections, subshells, arbitrary programs). It exists for tests and development. Isolation
 * is the `apple-container` kind, whose `exec` runs inside a container; its file operations stay
 * on the host workspace with exactly this confinement.
 */
export class WorkspaceEnv extends NodeExecutionEnv {
  override readonly id: string;
  /** Caller-facing workspace root: the workspace itself (local) or `/workspace` (container). */
  readonly logicalRoot: string;
  /** Workspace on the host with symlinks resolved; every mapped path is checked against this. */
  readonly hostRoot: string;
  /** Process groups of commands still running (container exec); `cleanup` kills them. */
  readonly children = new Set<number>();

  private readonly tempRoot: string;
  private readonly runExec: ExecFn | null;

  constructor(options: WorkspaceEnvOptions) {
    const hostRoot = realpathSync(options.hostRoot);
    const logicalRoot = options.logicalRoot ?? options.hostRoot;
    super({ cwd: logicalRoot });
    this.hostRoot = hostRoot;
    this.logicalRoot = logicalRoot;
    this.id = options.id ?? `ghost-ws:${hostRoot}`;
    this.tempRoot = join(hostRoot, ".ghost-tmp");
    this.runExec = options.exec ?? null;
  }

  /** `true` when `path` is the root itself or lives under it. */
  private inside(path: string): boolean {
    return path === this.hostRoot || path.startsWith(`${this.hostRoot}/`);
  }

  /**
   * Resolve a caller path against the workspace root and refuse anything that names another
   * tree: absolute paths outside the workspace, `..` climbing out, `~`, `file://`. `resolve`
   * collapses every `.`/`..`, so the walk that follows sees plain segments only.
   *
   * The workspace is accepted under both spellings it has: the path the caller holds and its
   * resolved path (a state root behind a symlink, e.g. `/var` on macOS).
   */
  private logical(path: string): { root: string; resolved: string } {
    if (path.startsWith("~")) throw new FileError("invalid", `Refusing ~ path; use workspace-relative or ${this.logicalRoot}/ paths`, path);
    if (path.startsWith("file://")) throw new FileError("invalid", `Refusing file:// URL: ${path}`, path);
    const resolved = isAbsolute(path) ? resolve(path) : resolve(this.logicalRoot, path);
    for (const root of [this.logicalRoot, this.hostRoot]) {
      if (resolved === root || resolved.startsWith(`${root}/`)) return { root, resolved };
    }
    throw new FileError("permission_denied", `Path escapes the workspace: ${path}`, path);
  }

  /**
   * Map a caller path onto the host workspace. Each component is `lstat`ed, and any symlink —
   * dangling or not — is refused instead of followed. Beyond a missing component nothing can
   * resolve further, so the remainder joins lexically inside the last real directory; `resolve`
   * has already collapsed every `.`/`..`, so those joins only ever descend.
   */
  private map(path: string): string {
    const { root, resolved } = this.logical(path);
    if (resolved === root) return this.hostRoot;
    const segments = resolved.slice(root.length + 1).split("/");
    let current = this.hostRoot;
    let index = 0;
    let missing = false;
    while (index < segments.length) {
      const segment = segments[index]!;
      if (segment === "" || segment === ".") {
        index += 1;
        continue;
      }
      const next = `${current}/${segment}`;
      let stats: Stats;
      try {
        stats = lstatSync(next);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          missing = true; // nothing below resolves; the remainder joins lexically
          break;
        }
        throw fileErrorFrom(error, path);
      }
      index += 1;
      if (stats.isSymbolicLink()) throw new FileError("permission_denied", `Path uses a symbolic link: ${path}`, path);
      current = next;
    }
    const host = missing ? `${current}/${segments.slice(index).join("/")}` : current;
    if (!this.inside(host)) throw new FileError("permission_denied", `Path escapes the workspace: ${path}`, path);
    return host;
  }

  /** Host path back to the caller's naming (identity for local, `/workspace/...` for container). */
  private toLogical(hostPath: string): string {
    return `${this.logicalRoot}${hostPath.slice(this.hostRoot.length)}`;
  }

  private mapped(path: string): { ok: true; value: string } | { ok: false; error: FileError } {
    try {
      return { ok: true, value: this.map(path) };
    } catch (error) {
      return { ok: false, error: fileErrorFrom(error, path) };
    }
  }

  override async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    try {
      return ok(this.logical(path).resolved);
    } catch (error) {
      return err(fileErrorFrom(error, path));
    }
  }

  override async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    try {
      return ok(this.logical(join(...parts)).resolved);
    } catch (error) {
      return err(fileErrorFrom(error, join(...parts)));
    }
  }

  override async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const target = this.mapped(path);
    return target.ok ? super.canonicalPath(target.value, context) : err(target.error);
  }

  override async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const target = this.mapped(path);
    if (!target.ok) return err(target.error);
    try {
      const fd = openReadNoFollow(target.value);
      try {
        return ok(readFileSync(fd, "utf8"));
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      return err(fileErrorFrom(error, path));
    }
  }

  override async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const target = this.mapped(path);
    if (!target.ok) return err(target.error);
    let fd: number;
    try {
      fd = openReadNoFollow(target.value);
    } catch (error) {
      return err(fileErrorFrom(error, path));
    }
    return ok(new ConfinedTextLineReader(fd, target.value));
  }

  override async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
    const opened = await this.openTextLineReader(path, context);
    if (!opened.ok) return opened;
    const lines: string[] = [];
    try {
      while (options?.maxLines === undefined || lines.length < options.maxLines) {
        const line = await opened.value.readLine(context);
        if (!line.ok) return line;
        if (line.value === undefined) break;
        lines.push(line.value.text);
      }
      return ok(lines);
    } finally {
      await opened.value.close(context);
    }
  }

  override async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const target = this.mapped(path);
    if (!target.ok) return err(target.error);
    try {
      const fd = openReadNoFollow(target.value);
      try {
        return ok(readFileSync(fd));
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      return err(fileErrorFrom(error, path));
    }
  }

  override async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    const target = this.mapped(path);
    if (!target.ok) return err(target.error);
    let fd: number;
    try {
      fd = openReadNoFollow(target.value);
    } catch (error) {
      return err(fileErrorFrom(error, path));
    }
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) {
        closeSync(fd);
        return err(
          stats.isDirectory()
            ? new FileError("is_directory", "EISDIR: illegal operation on a directory, read", path)
            : new FileError("invalid", "Not a regular file", path),
        );
      }
      return ok(new ConfinedBinaryReader(fd, target.value));
    } catch (error) {
      closeSync(fd);
      return err(fileErrorFrom(error, path));
    }
  }

  override async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    void context;
    const target = this.mapped(path);
    if (!target.ok) return err(target.error);
    try {
      confineDirChain(this.hostRoot, parentSegments(this.hostRoot, target.value), true);
      writeFileNoFollow(target.value, content, "write");
      return ok(undefined);
    } catch (error) {
      return err(fileErrorFrom(error, path));
    }
  }

  override async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    void context;
    const target = this.mapped(path);
    if (!target.ok) return err(target.error);
    try {
      confineDirChain(this.hostRoot, parentSegments(this.hostRoot, target.value), true);
      writeFileNoFollow(target.value, content, "append");
      return ok(undefined);
    } catch (error) {
      return err(fileErrorFrom(error, path));
    }
  }

  override async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    void context;
    const target = this.mapped(path);
    if (!target.ok) return err(target.error);
    if (!Number.isSafeInteger(size) || size < 0)
      return err(new FileError("invalid", "File size must be a non-negative safe integer", path));
    try {
      const fd = openSync(target.value, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
      try {
        ensureRealParent(target.value);
        ftruncateSync(fd, size);
      } finally {
        closeSync(fd);
      }
      return ok(undefined);
    } catch (error) {
      return err(fileErrorFrom(error, path));
    }
  }

  override async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    void context;
    const target = this.mapped(path);
    if (!target.ok) return err(target.error);
    try {
      const fd = openSync(target.value, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
      try {
        ensureRealParent(target.value);
        if (fstatSync(fd).isDirectory()) return err(new FileError("is_directory", "Is a directory", path));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return ok(undefined);
    } catch (error) {
      return err(fileErrorFrom(error, path));
    }
  }

  override async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    void context;
    const source = this.mapped(sourcePath);
    if (!source.ok) return err(source.error);
    const destination = this.mapped(destinationPath);
    if (!destination.ok) return err(destination.error);
    try {
      // `rename` never follows a symlink in its final components, but a swapped parent directory
      // would move the entry out of (or into) the workspace; re-verify both chains immediately
      // before the syscall.
      ensureRealParent(source.value);
      ensureRealParent(destination.value);
      renameSync(source.value, destination.value);
      return ok(undefined);
    } catch (error) {
      return err(fileErrorFrom(error, sourcePath));
    }
  }

  override async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    void context;
    const target = this.mapped(path);
    if (!target.ok) return err(target.error);
    try {
      if (target.value !== this.hostRoot) ensureRealParent(target.value);
    } catch (error) {
      return err(fileErrorFrom(error, path));
    }
    return super.fileInfo(target.value, context);
  }

  override async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    void context;
    const target = this.mapped(path);
    if (!target.ok) return err(target.error);
    try {
      if (target.value !== this.hostRoot) ensureRealParent(target.value);
    } catch (error) {
      return err(fileErrorFrom(error, path));
    }
    return super.listDir(target.value, context);
  }

  override async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    void context;
    const target = this.mapped(path);
    if (!target.ok) return err(target.error);
    try {
      if (target.value !== this.hostRoot) ensureRealParent(target.value);
    } catch (error) {
      return err(fileErrorFrom(error, path));
    }
    return super.openDirReader(target.value, context);
  }

  override async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const target = this.mapped(path);
    return target.ok ? super.exists(target.value, context) : err(target.error);
  }

  override async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    void context;
    const target = this.mapped(path);
    if (!target.ok) return err(target.error);
    if (target.value === this.hostRoot) return ok(undefined); // the workspace itself always exists
    const recursive = options?.recursive ?? true;
    try {
      // One mkdir per missing component; a recursive mkdir would traverse a planted symlink.
      confineDirChain(this.hostRoot, parentSegments(this.hostRoot, target.value), recursive);
      try {
        mkdirSync(target.value, { mode: 0o700 });
      } catch (error) {
        const existing = lstatSync(target.value); // EEXIST: decide like `mkdir {recursive}` would
        if (!(recursive && existing.isDirectory())) throw error;
      }
      return ok(undefined);
    } catch (error) {
      return err(fileErrorFrom(error, path));
    }
  }

  override async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    void context;
    const target = this.mapped(path);
    if (!target.ok) return err(target.error);
    try {
      if (target.value !== this.hostRoot) ensureRealParent(target.value);
      rmSync(target.value, { recursive: options?.recursive ?? false, force: options?.force ?? false });
      return ok(undefined);
    } catch (error) {
      return err(fileErrorFrom(error, path));
    }
  }

  override async watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    const mapped: WatchTarget[] = [];
    for (const target of targets) {
      const resolved = this.mapped(target.path);
      if (!resolved.ok) return err(resolved.error);
      mapped.push({ ...target, path: resolved.value });
    }
    return super.watch(mapped, onChange, context);
  }

  /** Temporary directories live inside the workspace's verified `.ghost-tmp`, so diagnostics stay confined and readable. */
  override async createTempDir(prefix: string | undefined, _context: Context): Promise<Result<string, FileError>> {
    const safe = prefix ?? "tmp-";
    if (safe === "." || safe === ".." || !/^[A-Za-z0-9._-]+$/.test(safe))
      return err(new FileError("invalid", `Invalid temp prefix: ${JSON.stringify(safe.slice(0, 64))}`, this.tempRoot));
    try {
      const tempRoot = ensureTempRoot(this.hostRoot);
      return ok(this.toLogical(mkdtempSync(join(tempRoot, safe))));
    } catch (error) {
      return err(fileErrorFrom(error, this.tempRoot));
    }
  }

  override async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    const dir = await this.createTempDir("tmp-", context);
    if (!dir.ok) return dir;
    const file = join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
    try {
      writeFileNoFollow(this.map(file), "", "write");
    } catch (error) {
      return err(fileErrorFrom(error, file));
    }
    return ok(file);
  }

  override async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (this.runExec !== null) return this.runExec(command, options, context);
    try {
      // Confine the working directory; the commands themselves are not confined (see class doc).
      const cwd = options?.cwd === undefined ? this.hostRoot : this.map(options.cwd);
      return await super.exec(command, options === undefined ? { cwd } : { ...options, cwd }, context);
    } catch (error) {
      const cause = toError(error);
      return err(new ExecutionError("spawn_error", cause.message, cause));
    }
  }

  override async cleanup(context: Context): Promise<void> {
    for (const pid of this.children) killTree(pid);
    this.children.clear();
    return super.cleanup(context);
  }
}

/** Strict LF reader over a no-follow fd, mirroring the Node environment's reader. */
class ConfinedTextLineReader implements TextLineReader {
  private readonly decoder = new StreamDecoder();
  private readonly chunk = new Uint8Array(64 * 1024);
  private byteOffset = 0;
  private buffered = "";
  private ended = false;
  private closed = false;

  constructor(
    private readonly fd: number,
    private readonly path: string,
  ) {}

  async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    const aborted = context.abortSignal?.aborted;
    if (aborted) return err(new FileError("aborted", "aborted", this.path));
    if (this.closed) return err(new FileError("invalid", "Text line reader is closed", this.path));
    try {
      for (;;) {
        const newline = this.buffered.indexOf("\n");
        if (newline !== -1) {
          const text = this.buffered.slice(0, newline);
          this.buffered = this.buffered.slice(newline + 1);
          return ok({ text, terminated: true });
        }
        if (this.ended) {
          if (this.buffered.length === 0) return ok(undefined);
          const text = this.buffered;
          this.buffered = "";
          return ok({ text, terminated: false });
        }
        // Explicit positions allow an aborted read to be retried without skipping bytes.
        const bytesRead = readSync(this.fd, this.chunk, 0, this.chunk.length, this.byteOffset);
        this.byteOffset += bytesRead;
        if (bytesRead === 0) {
          this.buffered += this.decoder.decode();
          this.ended = true;
        } else {
          this.buffered += this.decoder.decode(this.chunk.subarray(0, bytesRead));
        }
      }
    } catch (error) {
      return err(fileErrorFrom(error, this.path));
    }
  }

  async close(_context: Context): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.buffered = "";
    try {
      closeSync(this.fd);
    } catch {
      // Closing is best-effort, including after cancellation or an earlier I/O failure.
    }
  }
}

const BINARY_READ_CHUNK = 1024 * 1024;

/** Positional reads over a no-follow fd to one opened regular file, mirroring the Node environment's reader. */
class ConfinedBinaryReader implements BinaryReader {
  private closed = false;

  constructor(
    private readonly fd: number,
    private readonly path: string,
  ) {}

  private closedResult(): FileError {
    return new FileError("invalid", "Binary reader is closed", this.path);
  }

  async info(context: Context): Promise<Result<FileInfo, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", this.path));
    if (this.closed) return err(this.closedResult());
    try {
      const stats = fstatSync(this.fd);
      return ok({ name: basename(this.path), path: this.path, kind: "file", size: stats.size, mtimeMs: stats.mtimeMs });
    } catch (error) {
      return err(fileErrorFrom(error, this.path));
    }
  }

  async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", this.path));
    if (this.closed) return err(this.closedResult());
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0)
      return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.path));
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < length) {
        const chunk = new Uint8Array(Math.min(length - total, BINARY_READ_CHUNK));
        const bytesRead = readSync(this.fd, chunk, 0, chunk.length, offset + total);
        if (bytesRead === 0) break;
        chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
    } catch (error) {
      return err(fileErrorFrom(error, this.path));
    }
    if (chunks.length === 1) return ok(chunks[0]!);
    const bytes = new Uint8Array(total);
    let position = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, position);
      position += chunk.length;
    }
    return ok(bytes);
  }

  async scanLines(
    options: { startLine: number; endLine?: number },
    context: Context,
  ): Promise<Result<{ newlines: number; start: number; end: number; firstLineEnd: number; lastLineStart: number; selectedBytes: number; firstLineBytes: number }, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", this.path));
    if (this.closed) return err(this.closedResult());
    let scanner: LineScanner;
    try {
      scanner = new LineScanner(options.startLine, options.endLine);
    } catch {
      return err(new FileError("invalid", "Invalid line range", this.path));
    }
    const chunk = new Uint8Array(64 * 1024);
    try {
      for (let position = 0; ; ) {
        const bytesRead = readSync(this.fd, chunk, 0, chunk.length, position);
        if (bytesRead === 0) return ok(scanner.finish());
        scanner.push(chunk.subarray(0, bytesRead));
        position += bytesRead;
      }
    } catch (error) {
      return err(fileErrorFrom(error, this.path));
    }
  }

  async close(_context: Context): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.fd);
    } catch {
      // Closing is best-effort.
    }
  }
}
