import { mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_GHOST_PERMISSIONS, TERMINAL_WORK_STATES, type GhostPermissions, type Sandbox, type Work } from "@ghost/contract";
import { FileError, ok, type Result } from "@earendil-works/pi-durable/env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Config } from "../config.ts";
import { sha256 } from "../core/ids.ts";
import type { ArtifactStore, SandboxControl, SandboxSweep } from "../core/ports.ts";
import type { SandboxEnvFactory } from "../integrations/ports.ts";
import { CLI_TIMEOUT_MS, ContainerDriver, listContainers, listContainersAsync, runCli, type ContainerRow } from "./container.ts";
import { ContainerTracker } from "./tracker.ts";
import { confineDirChain, readFileNoFollow, WorkspaceEnv, writeFileNoFollow } from "./workspace-env.ts";

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

/** The reviewer's read-only container over the same Work. */
export function reviewContainerName(workId: string): string {
  return `${containerName(workId)}-r`;
}

/** How often the scheduler's tick may sweep; the tick itself runs every 30 seconds at most. */
const SWEEP_EVERY_MS = 60_000;
/**
 * How long a settled Work's directory is kept for inspection (2026-11-09). Its results are artifacts
 * in the ledger already; what is lost is the scratch state (checkouts, `node_modules`, build output).
 */
export const WORKSPACE_RETAIN_MS = 30 * 24 * 60 * 60_000;

export type SweepReason = "settled" | "stopped" | "idle";

/** Why a sweep deletes a container of this state root, or null to keep it. `idle` is asked last, only for a running container. */
export function sweepReason(work: Work | null, state: string, idle: () => boolean): SweepReason | null {
  if (work === null || TERMINAL_WORK_STATES.includes(work.state)) return "settled";
  if (state !== "running") return "stopped";
  return idle() ? "idle" : null;
}

/**
 * Whether a Work's directory may go. A failed root Work can be resumed into the same workspace, so it
 * stays; a failed child cannot be resumed.
 */
export function workspaceExpired(work: Work | null, now: number): boolean {
  if (work === null || work.endedAt === null || now - work.endedAt < WORKSPACE_RETAIN_MS) return false;
  return work.state === "done" || work.state === "cancelled" || (work.state === "failed" && work.parentId !== null);
}

/** True when one path is the other or lies inside it. */
function overlaps(a: string, b: string): boolean {
  const inside = (child: string, parent: string) => {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
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
 */
export function createSandbox(
  config: Config,
  artifacts: ArtifactStore,
  /** The owner's grants for a Ghost; read when its Work's container starts. */
  permissionsFor: (ghostId: string) => GhostPermissions = () => DEFAULT_GHOST_PERMISSIONS,
): SandboxEnvFactory & SandboxControl {
  const container =
    config.sandbox.kind === "apple-container"
      ? { cli: config.sandbox.cli, image: config.sandbox.image }
      : null;
  if (container !== null && (container.cli.length === 0 || container.image.length === 0))
    throw new Error("sandbox: kind apple-container needs a container CLI path and a pinned image");

  let lsCache: { at: number; rows: Result<ContainerRow[], Error> } | null = null;
  const tracker = new ContainerTracker();
  let sweeping: Promise<SandboxSweep> | null = null;
  let sweptAt = 0;

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

  /** The state root holds the ledger, Pi's store and provider secrets: never mount it, nor a folder containing it. */
  const mountRefusal = (path: string): string | null =>
    overlaps(resolve(path), resolve(config.root)) ? `${path} overlaps the Ghost state root and cannot be mounted` : null;

  const envFor = async (work: Work, options: { review?: boolean } = {}): Promise<ExecutionEnv> => {
    const workspace = workspacePath(work);
    // `local` runs on the host: it is for tests and development, so network and mounts do not apply.
    if (container === null)
      return new WorkspaceEnv({ hostRoot: workspace, id: `ghost-ws:${work.ghostId}/${work.id}${options.review ? ":review" : ""}` });
    const review = options.review === true;
    const name = review ? reviewContainerName(work.id) : containerName(work.id);
    const grantsNow = () => {
      const grants = permissionsFor(work.ghostId).sandbox;
      // A mount that became unsafe after it was granted is dropped rather than started.
      const mounts = grants.mounts.filter((mount) => mountRefusal(mount.path) === null);
      return { network: grants.network, mounts, cpus: grants.cpus, memoryGiB: grants.memoryGiB };
    };
    let driver: ContainerDriver | null = null;
    const env = new WorkspaceEnv({
      hostRoot: workspace,
      logicalRoot: "/workspace",
      id: `ghost-container:${name}`,
      exec: (command, options, context) => driver!.exec(command, options, context),
    });
    driver = new ContainerDriver(
      {
        cli: container.cli,
        image: container.image,
        name,
        workspace: env.hostRoot,
        logicalRoot: "/workspace",
        readOnly: review,
      },
      {
        onSpawn: (pid) => env.children.add(pid),
        onExit: (pid) => env.children.delete(pid),
        onChanged: () => {
          lsCache = null;
        },
        grants: grantsNow,
        tracker,
      },
    );
    return env;
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
    return entries.flatMap((workId) => [containerName(workId), reviewContainerName(workId)]);
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
    if (container === null) return;
    const names = new Set(ghostContainerNames(ghostId));
    const rows = containerRows(true);
    lsCache = null;
    if (!rows.ok) throw new Error(`sandbox: container ls failed: ${rows.error.message}`);
    for (const row of rows.value) {
      if (!names.has(row.id)) continue;
      tracker.forget(row.id);
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

  /** A settled Work's containers (its own and its reviewer's) are deleted; its workspace stays for inspection until a sweep retires it. */
  const release = async (work: Work): Promise<void> => {
    if (container === null) return;
    const rows = containerRows(true);
    lsCache = null;
    if (!rows.ok) throw new Error(`sandbox: container ls failed: ${rows.error.message}`);
    for (const name of [containerName(work.id), reviewContainerName(work.id)]) {
      if (!rows.value.some((row) => row.id === name)) continue;
      await deleteContainer(name);
    }
  };

  const deleteContainer = async (name: string): Promise<void> => {
    if (container === null) return;
    tracker.forget(name);
    lsCache = null;
    const deleted = await runCli(container.cli, ["delete", "--force", name], CLI_TIMEOUT_MS);
    if (!deleted.ok || deleted.value.code !== 0)
      throw new Error(`sandbox: deleting ${name} failed: ${(!deleted.ok ? deleted.error.message : deleted.value.stderr).trim().slice(0, 512)}`);
  };

  /** Every Work directory of this state root, as `{ ghostId, workId }`. */
  const workDirs = (): { ghostId: string; workId: string }[] => {
    const subdirs = (path: string) => {
      try {
        // Symlinks are not directories here, so a planted link is never followed or removed through.
        return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch {
        return [];
      }
    };
    const base = join(config.root, "sandboxes");
    return subdirs(base).flatMap((ghostId) => subdirs(join(base, ghostId)).map((workId) => ({ ghostId, workId })));
  };

  /**
   * 2026-11-09: frees what `release` alone leaves behind. Deletes containers of settled or unknown Works
   * (a failed release, a crash before it), stopped ones, and running ones idle for IDLE_MS; removes the
   * directories of Works settled for WORKSPACE_RETAIN_MS. Only containers named after this state root's
   * Work directories are touched: a development Host on the same Mac shares the container namespace.
   * Runs at most once per SWEEP_EVERY_MS and never twice at once; failures are reported, not thrown.
   */
  const sweep = (now: number, workOf: (workId: string) => Work | null): Promise<SandboxSweep> => {
    if (sweeping !== null) return sweeping;
    if (now - sweptAt < SWEEP_EVERY_MS) return Promise.resolve({ containers: [], workspaces: [], failures: [] });
    sweptAt = now;
    sweeping = sweepOnce(now, workOf).finally(() => {
      sweeping = null;
    });
    return sweeping;
  };

  const sweepOnce = async (now: number, workOf: (workId: string) => Work | null): Promise<SandboxSweep> => {
    const result: SandboxSweep = { containers: [], workspaces: [], failures: [] };
    const dirs = workDirs();
    const works = new Map(dirs.map(({ workId }) => [workId, workOf(workId)]));
    if (container !== null) {
      const owners = new Map(dirs.flatMap(({ workId }) => [[containerName(workId), workId], [reviewContainerName(workId), workId]] as const));
      const listed = await listContainersAsync(container.cli);
      lsCache = null;
      if (!listed.ok) {
        result.failures.push(`container ls failed: ${listed.error.message}`);
        return result;
      }
      for (const row of listed.value) {
        const workId = owners.get(row.id);
        if (workId === undefined) continue;
        const reason = sweepReason(works.get(workId) ?? null, row.state, () => tracker.idle(row.id));
        if (reason === null) continue;
        try {
          if (await tracker.retire(row.id, () => deleteContainer(row.id))) result.containers.push({ name: row.id, reason });
        } catch (error) {
          result.failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    for (const { ghostId, workId } of dirs) {
      if (!workspaceExpired(works.get(workId) ?? null, now)) continue;
      try {
        rmSync(join(config.root, "sandboxes", ghostId, workId), { recursive: true, force: true });
        result.workspaces.push(workId);
      } catch (error) {
        result.failures.push(`removing the workspace of ${workId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  };

  return { envFor, workspacePath, stageInputs, status, control, release, mountRefusal, sweep };
}
