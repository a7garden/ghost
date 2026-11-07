import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Sandbox, Work } from "@ghost/contract";
import { FileError, ok, type Result } from "@earendil-works/pi-durable/env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Config } from "../config.ts";
import { sha256 } from "../core/ids.ts";
import type { ArtifactStore, SandboxControl } from "../core/ports.ts";
import type { SandboxEnvFactory } from "../integrations/ports.ts";
import { CLI_TIMEOUT_MS, ContainerDriver, listContainers, runCli, type ContainerRow } from "./container.ts";
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
export function createSandbox(config: Config, artifacts: ArtifactStore): SandboxEnvFactory & SandboxControl {
  const container =
    config.sandbox.kind === "apple-container"
      ? { cli: config.sandbox.cli, image: config.sandbox.image }
      : null;
  if (container !== null && (container.cli.length === 0 || container.image.length === 0))
    throw new Error("sandbox: kind apple-container needs a container CLI path and a pinned image");

  let lsCache: { at: number; rows: Result<ContainerRow[], Error> } | null = null;

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

  const envFor = async (work: Work): Promise<ExecutionEnv> => {
    const workspace = workspacePath(work);
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

  /** A settled Work's container is deleted; its workspace stays for inspection. */
  const release = async (work: Work): Promise<void> => {
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

  return { envFor, workspacePath, stageInputs, status, control, release };
}
