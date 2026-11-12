import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ExecutionTarget, Sandbox, Work } from "@ghost/contract";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ExecutionError, FileError, err, ok, type Result } from "@earendil-works/pi-durable/env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Config } from "../config.ts";
import { sha256 } from "../core/ids.ts";
import type { ArtifactStore, SandboxControl } from "../core/ports.ts";
import type { SandboxEnvFactory } from "../integrations/ports.ts";
import { createEgressProxy, type EgressProxy } from "../integrations/egress-proxy.ts";
import { CLI_TIMEOUT_MS, ContainerDriver, listContainers, runCli, type ContainerRow } from "./container.ts";
import { buildSeatbeltPolicy, realBelow } from "./seatbelt.ts";
import { confineDirChain, readFileNoFollow, WorkspaceEnv, writeFileNoFollow } from "./workspace-env.ts";
import { HostExecutionEnv, HostMutationQueue, validateExecutionTarget } from "./host-env.ts";
import { ensureWorktree, repositoryOf, worktreeBranch } from "./worktree.ts";

export { validateExecutionTarget } from "./host-env.ts";

/** App-owned sandbox lifetime; conversation consumers only need SandboxEnvFactory. */
export interface SandboxService extends SandboxEnvFactory, SandboxControl {
  close(): Promise<void>;
}

/**
 * Digest-pinned Ubuntu image for Apple containers. The guest root is read-only, the network is
 * `none`, capabilities are dropped and only the Work's workspace is mounted.
 */
export const CONTAINER_IMAGE = "docker.io/library/ubuntu@sha256:08571ca13e00ca07a2a84eab83a959b4242e22cceb16486a11bef1428c9e93a7";
/** Hex characters of the work id's sha256 kept in the container name; 16 hex = 64 bits, far above any collision risk for same-millisecond ids. */
const NAME_HASH_CHARS = 16;
/** How long a `container ls` result stays fresh; starting or stopping a container drops it. */
const LS_TTL_MS = 2000;

/**
 * One container per live Work; the work's directory under `sandboxes/<ghost id>/` maps back to it.
 * The name comes from the full work id's hash, so two Works created in the same millisecond (which
 * share their id's timestamp prefix) never share a container.
 */
export function containerName(workId: string): string {
  return `ghost-${sha256(workId).slice(0, NAME_HASH_CHARS)}`;
}

/** A single path component: no separators, no dot segments, no empty name. */
function safeComponent(value: string, what: string): string {
  if (value.length === 0 || value === "." || value === ".." || /[/\\\0]/.test(value))
    throw new Error(`sandbox: unsafe ${what}: ${JSON.stringify(value.slice(0, 64))}`);
  return value;
}

/**
 * The Work sandboxes: one workspace directory per Work, and (for the Apple container kind) one
 * container per live Work.
 *
 * `kind: "local"` runs commands on the host — it is for tests and development and it is *not*
 * isolation. `kind: "apple-container"` runs commands inside an Apple container with only the
 * workspace mounted; its file operations stay on the host workspace, confined the same way.
 *
 * An explicit `work.execution` overrides that legacy default: `workspace` (the default for new
 * Works) runs the Mac toolchain inside a per-Work Seatbelt boundary; `host` uses unrestricted PC
 * file and shell access at the selected cwd, sharing a mutation queue across Works; with
 * `worktree` the cwd is the Work's own git worktree (branch `ghost/<work>`) with its own queue.
 * Its workspace is only staging, never a replacement cwd. `container` files stay confined at
 * `/workspace`; shell execution requires the Apple driver and cannot fall back to local
 * execution. Owner grants are checked by the caller, not inferred here.
 */
export function createSandbox(config: Config, artifacts: ArtifactStore): SandboxService {
  const container =
    config.sandbox.kind === "apple-container"
      ? { cli: config.sandbox.cli, image: config.sandbox.image }
      : null;
  if (container !== null && (container.cli.length === 0 || container.image.length === 0))
    throw new Error("sandbox: kind apple-container needs a container CLI path and a pinned image");

  let lsCache: { at: number; rows: Result<ContainerRow[], Error> } | null = null;
  let closed = false;
  const hostMutations = new HostMutationQueue();
  /** One confined environment per review conversation, freed with the reviewed Work. */
  const reviewEnvs = new Map<string, HostExecutionEnv>();
  const worktreeMutations = new Map<string, HostMutationQueue>();
  const hostEnvs = new Map<HostExecutionEnv, Work>();
  const closingHostEnvs = new Map<HostExecutionEnv, Promise<void>>();
  const closeHostEnvs = async (matches: (work: Work) => boolean): Promise<void> => {
    await Promise.all([...hostEnvs].filter(([, work]) => matches(work)).map(([env]) => {
      let closing = closingHostEnvs.get(env);
      if (!closing) {
        closing = env.cleanup(BACKGROUND_CONTEXT).then(() => {
          hostEnvs.delete(env);
        }).finally(() => closingHostEnvs.delete(env));
        closingHostEnvs.set(env, closing);
      }
      return closing;
    }));
  };

  const containerRows = (fresh = false): Result<ContainerRow[], Error> => {
    if (container === null) return ok([]);
    const now = Date.now();
    if (!fresh && lsCache !== null && now - lsCache.at < LS_TTL_MS) return lsCache.rows;
    const rows = listContainers(container.cli);
    lsCache = { at: now, rows };
    return rows;
  };

  const workspacePath = (work: Work): string => {
    const path = join(
      config.root,
      "sandboxes",
      safeComponent(work.ghostId, "ghost id"),
      safeComponent(work.id, "work id"),
      "workspace",
    );
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  };

  const envFor = async (work: Work, authorize?: () => string): Promise<ExecutionEnv> => {
    if (closed) throw new Error("sandbox: execution environments are closed");
    if (work.execution !== undefined) validateExecutionTarget(work.execution);
    const workspace = workspacePath(work);
    if (work.execution?.kind === "container" && container === null)
      return new WorkspaceEnv({
        hostRoot: workspace,
        logicalRoot: "/workspace",
        id: `ghost-container:${containerName(work.id)}`,
        exec: async () => err(new ExecutionError(
          "shell_unavailable",
          "Container shell execution requires an apple-container sandbox configuration; refusing to run on the PC",
        )),
      });
    if (work.execution?.kind === "workspace") return await workspaceEnvFor(work, workspace);
    if (work.execution?.kind === "host") {
      // A worktree Work edits only its own checkout, so it waits on its own queue instead of every PC Work's.
      const cwd = work.execution.worktree ? ensureWorktree(config.root, work, work.execution.cwd) : work.execution.cwd;
      let mutations = hostMutations;
      if (work.execution.worktree) {
        mutations = worktreeMutations.get(cwd) ?? new HostMutationQueue();
        worktreeMutations.set(cwd, mutations);
      }
      const env = new HostExecutionEnv({
        cwd,
        workspace,
        id: "ghost-host",
        mutations,
        deadlineAt: work.deadlineAt,
        authorize,
      });
      hostEnvs.set(env, work);
      return env;
    }
    if (container === null)
      return new WorkspaceEnv({ hostRoot: workspace, id: `ghost-ws:${work.ghostId}/${work.id}` });
    const name = containerName(work.id);
    let driver: ContainerDriver | null = null;
    const env = new WorkspaceEnv({
      hostRoot: workspace,
      logicalRoot: "/workspace",
      id: `ghost-container:${name}`,
      exec: (command, options, context) => driver!.exec(command, options, context),
    });
    driver = new ContainerDriver(
      { cli: container.cli, image: container.image, name, workspace: env.hostRoot, logicalRoot: "/workspace" },
      {
        onSpawn: (pid) => env.children.add(pid),
        onExit: (pid) => env.children.delete(pid),
        onChanged: () => {
          lsCache = null;
        },
      },
    );
    return env;
  };

  /** The single egress proxy every confined command shares; loopback only, closed with the service. */
  let egress: Promise<EgressProxy> | null = null;
  const egressPort = async (): Promise<number> => {
    egress ??= createEgressProxy();
    return Number(new URL((await egress).url).port);
  };

  /** Owner-configured readable project folders (`config.mac.roots` today; scopes supply more later). */
  const readRoots = (): string[] => {
    const roots: string[] = [];
    for (const root of config.mac?.roots ?? []) {
      const real = realBelow(root);
      if (real !== null) roots.push(real);
    }
    return roots;
  };

  const queueFor = (key: string): HostMutationQueue => {
    let mutations = worktreeMutations.get(key) ?? new HostMutationQueue();
    worktreeMutations.set(key, mutations);
    return mutations;
  };

  /**
   * The Work's own directory tree under the configured read roots: its worktree on branch
   * `ghost/<work>` when the cwd is a git repository (the owner's checkout is never edited), or
   * the directory itself, read-only, when it is not. Plus the git plumbing a commit touches.
   */
  const worktreeTarget = (work: Work, cwd: string): {
    cwd: string;
    writeRoots: string[];
    readRoots: string[];
    git: { objects: string; refs: string[] } | null;
  } => {
    const repo = work.execution?.kind === "workspace" && work.execution.worktree === false
      ? null
      : ensureWorktree(config.root, work, cwd);
    if (repo === null) return { cwd, writeRoots: [], readRoots: [cwd], git: null };
    const gitDir = (...flags: string[]) => {
      const child = Bun.spawnSync(["git", "-C", repo, "rev-parse", ...flags], { stdout: "pipe", stderr: "pipe" });
      const path = child.stdout.toString().trim();
      if (child.exitCode !== 0 || !isAbsolute(path)) throw new Error(`sandbox: git worktree metadata failed: ${child.stderr.toString().slice(0, 256)}`);
      return realpathSync(path);
    };
    const admin = gitDir("--absolute-git-dir");
    const common = gitDir("--path-format=absolute", "--git-common-dir");
    return {
      cwd: repo,
      writeRoots: [repo, admin],
      readRoots: [common],
      git: { objects: join(common, "objects"), refs: [join(common, "refs/heads", worktreeBranch(work.id))] },
    };
  };

  /**
   * The workspace execution kind: the Mac toolchain inside a Seatbelt boundary generated for this
   * one Work. Writes never leave its own directories; reads cover the toolchain and the configured
   * read roots; the network only reaches the Host egress proxy. It needs no hostExecution grant:
   * the boundary is the confinement.
   */
  const workspaceEnvFor = async (work: Work, workspace: string): Promise<ExecutionEnv> => {
    if (process.platform !== "darwin")
      return new WorkspaceEnv({
        hostRoot: workspace,
        id: `ghost-ws:${work.ghostId}/${work.id}`,
        exec: async () => err(new ExecutionError(
          "shell_unavailable",
          "Workspace execution requires macOS; refusing to run unconfined",
        )),
      });
    const realWorkspace = realpathSync(workspace);
    const writeRoots = [realWorkspace];
    const roots = [...readRoots()];
    let git: { objects: string; refs: string[] } | null = null;
    let cwd = realWorkspace;
    const target = work.execution;
    if (target?.kind === "workspace" && target.cwd !== undefined) {
      const real = realBelow(target.cwd);
      if (real === null || !statSync(real).isDirectory())
        throw new Error(`sandbox: workspace execution cwd is not a directory: ${target.cwd}`);
      const material = worktreeTarget(work, real);
      cwd = material.writeRoots.length > 0 ? material.cwd : realWorkspace;
      writeRoots.push(...material.writeRoots);
      roots.push(...material.readRoots, real);
      git = material.git;
    }
    const env = new HostExecutionEnv({
      cwd,
      workspace,
      id: `ghost-workspace:${work.ghostId}/${work.id}`,
      mutations: queueFor(cwd),
      deadlineAt: work.deadlineAt,
      boundary: buildSeatbeltPolicy(homedir(), config.root, {
        writeRoots,
        readRoots: roots,
        git: git ?? undefined,
        proxyPort: await egressPort(),
      }),
    });
    hostEnvs.set(env, work);
    return env;
  };

  /**
   * A reviewer's confined environment: its own scratch directory (writable), read-only access to
   * the reviewed Work's workspace and, when it has one, its worktree, and no network. The reviewer
   * can run the deliverable instead of trusting the summary, and cannot alter what it reviews.
   */
  const reviewEnvFor = (work: Work, conversationId: string): ExecutionEnv => {
    if (process.platform !== "darwin") throw new Error("review execution requires macOS");
    const cached = reviewEnvs.get(conversationId);
    if (cached !== undefined) return cached;
    const realWorkspace = realpathSync(workspacePath(work));
    const reviewDir = confineDirChain(dirname(realWorkspace), [`review-${sha256(conversationId).slice(0, 12)}`], true);
    const viewRoots = [realWorkspace];
    const worktree = join(config.root, "worktrees", work.ghostId, work.id);
    const roots = readRoots();
    const extra: Record<string, string> = { GHOST_REVIEWED_WORKSPACE: realWorkspace };
    if (existsSync(join(worktree, ".git"))) {
      const real = realpathSync(worktree);
      viewRoots.push(real);
      extra.GHOST_REVIEWED_WORKTREE = real;
      const child = Bun.spawnSync(["git", "-C", real, "rev-parse", "--path-format=absolute", "--git-common-dir"], { stdout: "pipe", stderr: "ignore" });
      const common = child.stdout.toString().trim();
      if (child.exitCode === 0 && isAbsolute(common)) roots.push(realpathSync(common));
    }
    const env = new HostExecutionEnv({
      cwd: reviewDir,
      workspace: reviewDir,
      id: `ghost-review:${conversationId}`,
      mutations: queueFor(`review:${conversationId}`),
      deadlineAt: work.deadlineAt,
      extraProcessEnv: extra,
      boundary: buildSeatbeltPolicy(homedir(), config.root, {
        writeRoots: [reviewDir],
        readRoots: roots,
        viewRoots,
        proxyPort: null,
      }),
    });
    reviewEnvs.set(conversationId, env);
    hostEnvs.set(env, work);
    return env;
  };

  /** Admission-time validation beyond the static shape: the workspace cwd must be owner-readable. */
  const validateExecution = (target: ExecutionTarget): void => {
    if (target.kind !== "workspace" || target.cwd === undefined) return;
    if (process.platform !== "darwin") throw new Error("Workspace execution requires macOS");
    if (!isAbsolute(target.cwd) || target.cwd.includes("\0")) throw new Error("Workspace execution cwd must be an absolute path");
    const real = realBelow(target.cwd);
    if (real === null || !statSync(real).isDirectory()) throw new Error(`Workspace execution cwd is not a directory: ${target.cwd}`);
    const roots = readRoots();
    if (!roots.some((root) => real === root || real.startsWith(`${root}/`)))
      throw new Error(`Workspace execution cwd must be inside a configured readable root (${roots.join(", ") || "none configured"}): ${target.cwd}`);
    if (target.worktree !== false) repositoryOf(real);
  };

  const stageInputs = async (
    work: Work,
    inputs: { childId: string; name: string; digest: string }[],
  ): Promise<void> => {
    if (inputs.length === 0) return;
    const workspace = realpathSync(workspacePath(work));
    for (const input of inputs) {
      const childId = safeComponent(input.childId, "child id");
      const name = safeComponent(input.name, "artifact name");
      const bytes = await artifacts.read(input.digest);
      if (sha256(bytes) !== input.digest)
        throw new Error(`sandbox: artifact ${input.digest} does not match its bytes; refusing to stage it`);
      // Every directory component is verified real below the workspace, one mkdir at a time, so a
      // symlink planted at `inputs` or `inputs/<childId>` is refused instead of written through.
      const dir = confineDirChain(workspace, ["inputs", childId], true);
      const target = join(dir, name);
      for (let attempt = 0; ; attempt += 1) {
        let existing: Uint8Array | null = null;
        try {
          existing = readFileNoFollow(target);
        } catch (error) {
          if (!(error instanceof FileError) || error.code !== "not_found") throw error;
        }
        if (existing !== null) {
          if (sha256(existing) === input.digest) break; // already staged with the same bytes
          throw new Error(`sandbox: inputs/${childId}/${name} already exists with different bytes`);
        }
        try {
          writeFileNoFollow(target, bytes, "write");
          break;
        } catch (error) {
          // Lost a race to a concurrent stage (EEXIST): re-read and decide. Anything else is fatal.
          if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST" || attempt > 0) throw error;
        }
      }
    }
  };

  /** Container names of the Works of one Ghost, read from the workspace directories on disk. */
  const ghostContainerNames = (ghostId: string): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(join(config.root, "sandboxes", safeComponent(ghostId, "ghost id")), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    return entries.map((workId) => containerName(workId));
  };

  const status = (ghostId: string): Sandbox => {
    if (container === null) return { ghostId, state: "none", detail: "local workspace execution; no container" };
    const names = new Set(ghostContainerNames(ghostId));
    const rows = containerRows();
    if (!rows.ok) return { ghostId, state: "error", detail: `container ls failed: ${rows.error.message}`.slice(0, 2048) };
    const mine = rows.value.filter((row) => names.has(row.id));
    if (mine.length === 0) return { ghostId, state: "none", detail: "" };
    const running = mine.filter((row) => row.state === "running");
    if (running.length > 0)
      return { ghostId, state: "running", detail: `${running.length} of ${mine.length} container(s) running` };
    if (mine.every((row) => row.state === "stopped"))
      return { ghostId, state: "stopped", detail: `${mine.length} container(s) stopped` };
    return {
      ghostId,
      state: "error",
      detail: `unexpected container state: ${mine.map((row) => `${row.id}:${row.state}`).join(", ")}`.slice(0, 2048),
    };
  };

  const control = async (ghostId: string, action: "stop" | "reset"): Promise<void> => {
    await closeHostEnvs((work) => work.ghostId === ghostId);
    if (container === null) return;
    const names = new Set(ghostContainerNames(ghostId));
    const rows = containerRows(true);
    lsCache = null;
    if (!rows.ok) throw new Error(`sandbox: container ls failed: ${rows.error.message}`);
    for (const row of rows.value) {
      if (!names.has(row.id)) continue;
      if (row.state === "running") {
        const stopped = await runCli(container.cli, ["stop", "--time", "2", row.id], CLI_TIMEOUT_MS);
        if (!stopped.ok || stopped.value.code !== 0)
          throw new Error(
            `sandbox: stopping ${row.id} failed: ${(!stopped.ok ? stopped.error.message : stopped.value.stderr).trim().slice(0, 512)}`,
          );
      }
      if (action === "reset") {
        const deleted = await runCli(container.cli, ["delete", "--force", row.id], CLI_TIMEOUT_MS);
        if (!deleted.ok || deleted.value.code !== 0)
          throw new Error(
            `sandbox: deleting ${row.id} failed: ${(!deleted.ok ? deleted.error.message : deleted.value.stderr).trim().slice(0, 512)}`,
          );
      }
    }
  };

  /** Stop settled Work processes or delete its container; staging and the owner's PC cwd stay. */
  const release = async (work: Work): Promise<void> => {
    await closeHostEnvs((live) => live.id === work.id);
    if (work.execution?.kind !== "container") return;
    if (container === null) return;
    const name = containerName(work.id);
    const rows = containerRows(true);
    lsCache = null;
    if (!rows.ok) throw new Error(`sandbox: container ls failed: ${rows.error.message}`);
    if (!rows.value.some((row) => row.id === name)) return;
    const deleted = await runCli(container.cli, ["delete", "--force", name], CLI_TIMEOUT_MS);
    if (!deleted.ok || deleted.value.code !== 0)
      throw new Error(`sandbox: deleting ${name} failed: ${(!deleted.ok ? deleted.error.message : deleted.value.stderr).trim().slice(0, 512)}`);
  };

  /** Stop Host processes before draining core lanes that may be waiting for their I/O. */
  const close = async (): Promise<void> => {
    closed = true;
    await closeHostEnvs(() => true);
    if (egress !== null) await egress.then((proxy) => proxy.close()).catch(() => undefined);
  };

  return { envFor, workspacePath, stageInputs, status, control, release, close, reviewEnvFor, validateExecution };
}
