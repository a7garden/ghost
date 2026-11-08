import {
  constants,
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { open, opendir, statfs } from "node:fs/promises";
import { cpus, homedir, loadavg, totalmem } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type {
  HostCommand,
  HostPort,
  HostStatus,
  HostServices,
  HostNodes,
} from "./ports.ts";
import { NoEffect } from "../core/effects.ts";

const GB = 1_073_741_824;
const PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
export interface HostOutput {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
}
export interface HostRun {
  program: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxBytes: number;
  home: string;
}
export type HostRunner = (input: HostRun) => Promise<HostOutput>;

/** No shell, inherited credentials or surviving background descendants. Captures a shared byte budget. */
export const runHostCommand: HostRunner = async (input) => {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([input.program, ...input.args], {
      cwd: input.cwd,
      env: { PATH, HOME: input.home, LANG: "en_US.UTF-8" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    throw new NoEffect(
      `process did not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let timedOut = false;
  let truncated = false;
  let size = 0;
  const chunks: Uint8Array[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const kill = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  };
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    readers.push(reader);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const room = Math.max(0, input.maxBytes - size);
        if (value.byteLength > room) truncated = true;
        if (room) {
          const part = value.slice(0, room);
          chunks.push(part);
          size += part.byteLength;
        }
      }
    } finally {
      reader.releaseLock();
    }
  };
  const output = Promise.all([capture(child.stdout), capture(child.stderr)]);
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, input.timeoutMs);
  try {
    const exitCode = await child.exited;
    kill();
    // An escaped descendant can retain a pipe even after the process group exits.
    const drainTimer = setTimeout(() => {
      truncated = true;
      for (const reader of readers) void reader.cancel().catch(() => {});
    }, 2000);
    try { await output; } finally { clearTimeout(drainTimer); }
    return {
      exitCode,
      output: Buffer.concat(chunks).toString("utf8"),
      timedOut,
      truncated,
    };
  } finally {
    clearTimeout(timer);
    kill();
  }
};

const secretNames: Record<string, true> = {
  ".git": true,
  ".ssh": true,
  ".aws": true,
  ".azure": true,
  ".gnupg": true,
  ".kube": true,
  ".npmrc": true,
  ".pypirc": true,
  ".netrc": true,
  ".ds_store": true,
  keychains: true,
  cookies: true,
  "login data": true,
  "web data": true,
  history: true,
  keystore: true,
  credentials: true,
  secrets: true,
  private: true,
  id_rsa: true,
  id_ed25519: true,
};
const privateNames: Record<string, true> = {
  finance: true,
  financial: true,
  trading: true,
  ledger: true,
  kev: true,
  jevk5: true,
  data: true,
  store: true,
  stores: true,
  notes: true,
  memories: true,
  records: true,
  backups: true,
  archive: true,
  archives: true,
};
export const secretPath = (path: string) =>
  path.split(sep).some((part) => {
    const n = part.toLowerCase();
    return (
      Object.hasOwn(secretNames, n) ||
      n.startsWith(".env") ||
      /secret|credential|api_key|apikey/.test(n) ||
      /\.(pem|key|p12|sqlite|db)$/.test(n)
    );
  });
export const privateTextPath = (path: string) =>
  path
    .split(sep)
    .some((part) => Object.hasOwn(privateNames, part.toLowerCase()));
export function sensitiveText(text: string): boolean {
  return (
    /macfra-approval-[a-f0-9]{64}|-----begin|bearer /i.test(text) ||
    /(?:^|[^a-z0-9])(?:ghp_|github_pat_|sk-|xoxb-|xoxp-|akia|glpat-)[a-z0-9]/i.test(
      text,
    ) ||
    /(?:^|[^a-z0-9])(?:api_key|apikey|api-key|access_token|refresh_token|private_key|password|client_secret|secret_key|token|secret|passwd|authorization)[\s'"]*[:=]/i.test(
      text,
    ) ||
    text
      .split(/[^a-z0-9_+\-=]/i)
      .some(
        (word) =>
          word.length >= 40 &&
          /[A-Z]/.test(word) &&
          /[a-z]/.test(word) &&
          /[0-9]/.test(word),
      )
  );
}
export const redactHostText = (text: string) =>
  text
    .split("\n")
    .map((line) => (sensitiveText(line) ? "[REDACTED: sensitive text]" : line))
    .join("\n");
const inside = (path: string, root: string) => {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
};
const expand = (path: string, home: string) =>
  path === "~"
    ? home
    : path.startsWith("~/")
      ? join(home, path.slice(2))
      : path;
async function entries(path: string, limit: number) {
  const result = [];
  const dir = await opendir(path);
  for await (const entry of dir) {
    result.push(entry);
    if (result.length >= limit) break;
  }
  return result;
}
export const storagePressure = (
  freeBytes: number,
  totalBytes: number,
): "critical" | "pressure" | "healthy" =>
  freeBytes < 5 * GB
    ? "critical"
    : freeBytes < 50 * GB || (totalBytes > 0 && freeBytes / totalBytes < 0.15)
      ? "pressure"
      : "healthy";

export class MacHost implements HostPort {
  readonly roots: string[];
  readonly caches: string[];
  constructor(
    options: {
      roots?: string[];
      home?: string;
      runner?: HostRunner;
      now?: () => number;
    } = {},
  ) {
    this.home = options.home ?? homedir();
    this.runner = options.runner ?? runHostCommand;
    this.now = options.now ?? Date.now;
    this.roots = (options.roots ?? [join(this.home, "Workspace/Projects")]).map(
      (p) => expand(p, this.home),
    );
    this.caches = [
      join(this.home, "Library/Caches"),
      join(this.home, ".cache"),
    ];
    if (this.roots.some((p) => !isAbsolute(p) || p.split(sep).includes("..")))
      throw new Error("host roots must be absolute paths without traversal");
  }
  private readonly home: string;
  private readonly runner: HostRunner;
  private readonly now: () => number;
  private run(
    program: string,
    args: string[],
    timeoutMs = 6000,
    maxBytes = 24_000,
    cwd = this.home,
  ) {
    return this.runner({
      program,
      args,
      timeoutMs,
      maxBytes,
      cwd,
      home: this.home,
    });
  }
  resolve(path: string, text = false, projectsOnly = false): string {
    if (
      path.length > 4096 ||
      path.includes("\0") ||
      !isAbsolute(path) ||
      path.split(sep).includes("..")
    )
      throw new Error(
        "use an absolute path inside configured roots without traversal",
      );
    const bases = (
      projectsOnly ? this.roots : [...this.roots, ...this.caches]
    ).flatMap((root) => {
      try {
        return [{ raw: root, canonical: realpathSync(root) }];
      } catch {
        return [];
      }
    });
    if (
      !bases.some(
        (root) => inside(path, root.raw) || inside(path, root.canonical),
      )
    )
      throw new Error("path is outside allowed roots");
    const canonical = realpathSync(path);
    if (!bases.some((root) => inside(canonical, root.canonical)))
      throw new Error("symlink escapes allowed roots");
    for (const candidate of [path, canonical]) {
      const root = bases.find(
        (r) => inside(candidate, r.raw) || inside(candidate, r.canonical),
      )!;
      const rel = relative(
        inside(candidate, root.raw) ? root.raw : root.canonical,
        candidate,
      );
      if (secretPath(rel) || (text && privateTextPath(rel)))
        throw new Error("secret or private path refused");
    }
    return canonical;
  }
  async status(): Promise<HostStatus> {
    const warnings: string[] = [];
    const disks = [];
    for (const path of [...new Set(["/", ...this.roots])]) {
      try {
        const s = await statfs(path);
        const totalBytes = s.blocks * s.bsize;
        const freeBytes = s.bavail * s.bsize;
        disks.push({
          path,
          totalBytes,
          freeBytes,
          pressure: storagePressure(freeBytes, totalBytes),
        });
      } catch {
        warnings.push(`capacity unavailable: ${path}`);
      }
    }
    const [memory, processes, ports] = await Promise.all([
      this.run("/usr/bin/memory_pressure", ["-Q"]),
      this.run("/bin/ps", ["-axo", "pcpu=,comm=", "-r"]),
      this.run(
        "/usr/sbin/lsof",
        ["-nP", "-iTCP", "-sTCP:LISTEN"],
        8000,
        128_000,
      ),
    ]);
    if (memory.exitCode !== 0 || memory.timedOut)
      warnings.push("memory pressure unavailable");
    if (processes.exitCode !== 0 || processes.truncated)
      warnings.push("process listing partial");
    if (
      ports.timedOut ||
      ports.truncated ||
      (ports.exitCode !== 0 && ports.exitCode !== 1)
    )
      warnings.push("listening port count unavailable or partial");
    const memoryFreePct = /percentage:\s*(\d+)%/.exec(memory.output)?.[1];
    return {
      collectedAt: this.now(),
      disks,
      ramBytes: totalmem(),
      memoryFreePct: memoryFreePct === undefined ? null : Number(memoryFreePct),
      cores: cpus().length,
      loadAverage: loadavg(),
      topProcesses: processes.output
        .trim()
        .split("\n")
        .slice(0, 5)
        .flatMap((line) => {
          const m = /^\s*([\d.]+)\s+(.+)$/.exec(line);
          return m ? [{ cpuPct: Number(m[1]), name: basename(m[2]!) }] : [];
        }),
      listeningPortCount: new Set(
        [...ports.output.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map((m) => m[1]),
      ).size,
      warnings,
    };
  }
  async services(): Promise<HostServices> {
    let files: Dirent[];
    try {
      files = (await entries(join(this.home, "Library/LaunchAgents"), 1001))
        .filter((e) => e.isFile() && e.name.endsWith(".plist"))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return { services: [], failed: [], partial: true };
      files = [];
    }
    let partial = files.length > 100;
    const until = this.now() + 6000;
    const listing = await this.run("/bin/launchctl", ["list"], 2000, 128_000);
    const loaded = new Map<string, { pid: number | null; lastExit: number }>();
    const known =
      listing.exitCode === 0 && !listing.truncated && !listing.timedOut;
    if (known)
      for (const line of listing.output.split("\n")) {
        const m = /^(\d+|-)\s+(-?\d+)\s+(.+)$/.exec(line);
        if (m)
          loaded.set(m[3]!, {
            pid: m[1] === "-" ? null : Number(m[1]),
            lastExit: Number(m[2]),
          });
      }
    else partial = true;
    const services: HostServices["services"] = [];
    for (const file of files.slice(0, 100)) {
      const remaining = until - this.now();
      if (remaining <= 0) {
        partial = true;
        break;
      }
      const result = await this.run(
        "/usr/bin/plutil",
        [
          "-extract",
          "Label",
          "raw",
          "-o",
          "-",
          join(this.home, "Library/LaunchAgents", file.name),
        ],
        Math.min(250, remaining),
        1024,
      );
      const label = result.output.trim();
      if (
        result.exitCode !== 0 ||
        result.truncated ||
        result.timedOut ||
        !/^[a-zA-Z0-9._-]{1,255}$/.test(label)
      ) {
        partial = true;
        continue;
      }
      const job = loaded.get(label);
      services.push({
        label,
        state: !known
          ? "unknown"
          : job?.pid
            ? "running"
            : job
              ? "loaded"
              : "unloaded",
        lastExit: job?.lastExit ?? null,
      });
    }
    return {
      services,
      failed: services.filter((s) => s.lastExit !== null && s.lastExit !== 0),
      partial,
    };
  }
  async nodes(): Promise<HostNodes> {
    const binary = [
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/usr/local/bin/tailscale",
      "/opt/homebrew/bin/tailscale",
      ...PATH.split(":").map((p) => join(p, "tailscale")),
    ].find(existsSync);
    if (!binary)
      return { nodes: [], healthWarnings: [], error: "Tailscale not found" };
    const result = await this.run(
      binary,
      ["status", "--json"],
      10_000,
      512_000,
    );
    if (result.exitCode !== 0 || result.truncated || result.timedOut)
      return {
        nodes: [],
        healthWarnings: [],
        error: "Tailscale status unavailable",
      };
    try {
      const json = JSON.parse(result.output);
      const peers = Array.isArray(json.Peer)
        ? json.Peer
        : Object.values(json.Peer ?? {});
      const nodes = [json.Self, ...peers]
        .filter(Boolean)
        .slice(0, 500)
        .map((n: Record<string, unknown>) => ({
          name: String(n.HostName ?? "?").slice(0, 255),
          online: n.Online === true,
          os: String(n.OS ?? "unknown").slice(0, 80),
          lastSeen: typeof n.LastSeen === "string" ? n.LastSeen : null,
        }));
      return {
        nodes,
        healthWarnings: Array.isArray(json.Health)
          ? json.Health.filter((v: unknown) => typeof v === "string")
              .slice(0, 20)
              .map((v: string) => redactHostText(v.slice(0, 1000)))
          : [],
        error: null,
      };
    } catch {
      return {
        nodes: [],
        healthWarnings: [],
        error: "invalid Tailscale status",
      };
    }
  }
  async diskUsage(path: string) {
    const canonical = this.resolve(path);
    if (!statSync(canonical).isDirectory())
      throw new Error("directory required");
    const result = await this.run(
      "/usr/bin/du",
      ["-sk", canonical],
      35_000,
      4000,
    );
    const kb = /^\s*(\d+)\s/.exec(result.output)?.[1];
    if (!kb) throw new Error("disk usage unavailable");
    return {
      path: canonical,
      bytes: Number(kb) * 1024,
      partial: result.exitCode !== 0 || result.timedOut || result.truncated,
    };
  }
  async list(path: string) {
    const canonical = this.resolve(path);
    const listing = await entries(canonical, 1001);
    const visible = listing.filter((e) => !secretPath(e.name));
    return {
      path: canonical,
      entries: visible
        .slice(0, 100)
        .map((e) => ({
          name: e.name,
          kind: e.isSymbolicLink()
            ? "symlink"
            : e.isDirectory()
              ? "directory"
              : "file",
        })),
      truncated: listing.length >= 1001 || visible.length > 100,
    };
  }
  async read(path: string) {
    const canonical = this.resolve(path, true);
    // Refuse symlinks in every component, then pin the final inode using O_NOFOLLOW.
    let current: string = sep;
    for (const component of path.split(sep).filter(Boolean)) {
      current = join(current, component);
      if (lstatSync(current).isSymbolicLink())
        throw new Error("symlink reads refused");
    }
    const file = await open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!(await file.stat()).isFile())
        throw new Error("regular UTF-8 file required");
      const buffer = Buffer.alloc(12_001);
      let size = 0;
      while (size < buffer.length) {
        const result = await file.read(
          buffer,
          size,
          buffer.length - size,
          null,
        );
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > 12_000) throw new Error("file exceeds 12 KB");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, size),
      );
      if (text.includes("\0")) throw new Error("binary file refused");
      return { path: canonical, text: sensitiveText(text) ? "[REDACTED: sensitive text]" : text, untrusted: true };
    } finally {
      await file.close();
    }
  }
  async diskScan() {
    const candidates = new Map<string, string>();
    const warnings: string[] = [];
    for (const root of [...this.roots, ...this.caches]) {
      try {
        candidates.set(
          this.resolve(root),
          this.caches.includes(root) ? "cache" : "root",
        );
        const listing = (await entries(root, 1001)).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        if (listing.length > 80)
          warnings.push(`${root}: first 80 entries only`);
        for (const e of listing.slice(0, 80)) {
          if (!e.isDirectory() || secretPath(e.name)) continue;
          const path = this.resolve(join(root, e.name));
          candidates.set(
            path,
            this.caches.includes(root) ? "cache" : "project",
          );
          if (this.roots.includes(root))
            for (const child of [
              "target",
              "build",
              "node_modules",
              ".next",
              "dist",
            ]) {
              try {
                const p = join(path, child);
                if (lstatSync(p).isDirectory())
                  candidates.set(this.resolve(p), "build");
              } catch {}
            }
        }
      } catch {
        warnings.push(`scan unavailable: ${root}`);
      }
    }
    const paths = [...candidates]
      .sort(
        (a, b) =>
          (a[1] === "build" ? 0 : a[1] === "cache" ? 1 : 2) -
          (b[1] === "build" ? 0 : b[1] === "cache" ? 1 : 2),
      )
      .slice(0, 180);
    if (candidates.size > 180) warnings.push("180 path limit reached");
    const until = this.now() + 75_000;
    let index = 0;
    const results: {
      path: string;
      category: string;
      bytes: number;
      partial: boolean;
    }[] = [];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (index < paths.length && this.now() < until) {
          const [path, category] = paths[index++]!;
          try {
            const p = this.resolve(path);
            const result = await this.run(
              "/usr/bin/du",
              ["-sk", p],
              Math.min(45_000, until - this.now()),
              4000,
            );
            const kb = /^\s*(\d+)\s/.exec(result.output)?.[1];
            if (!kb) throw new Error();
            results.push({
              path: p,
              category,
              bytes: Number(kb) * 1024,
              partial:
                result.exitCode !== 0 || result.timedOut || result.truncated,
            });
          } catch {
            warnings.push(`measurement failed: ${path}`);
          }
        }
      }),
    );
    if (index < paths.length) warnings.push("75 second budget reached");
    const disks = [];
    for (const path of this.roots) {
      try {
        const s = await statfs(path);
        disks.push({
          path,
          freeBytes: s.bavail * s.bsize,
          totalBytes: s.blocks * s.bsize,
          pressure: storagePressure(s.bavail * s.bsize, s.blocks * s.bsize),
        });
      } catch {}
    }
    return {
      collectedAt: this.now(),
      disks,
      entries: results.sort((a, b) => b.bytes - a.bytes).slice(0, 20),
      warnings: warnings.slice(0, 30),
    };
  }
  validateCommand(input: HostCommand): HostCommand {
    for (const text of [input.title, input.reason, input.risk])
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 2000 ||
        text.includes("\0")
      )
        throw new Error("title, reason and risk must be 1–2000 characters");
    if (
      !Array.isArray(input.args) ||
      input.args.length > 64 ||
      input.args.some(
        (a) =>
          typeof a !== "string" ||
          a.length > 4096 ||
          /[\0\r\n;|&<>`$]/.test(a),
      ) ||
      input.args.join("").length > 12_000
    )
      throw new Error("invalid arguments or shell metacharacter snippet");
    const cwd = this.resolve(input.cwd, false, true);
    if (!statSync(cwd).isDirectory())
      throw new Error("cwd must be a directory");
    const program = input.program;
    const system = [
      "/bin",
      "/usr/bin",
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/Cellar",
    ];
    const allowed = [
      ...system,
      join(this.home, ".cargo/bin"),
      join(this.home, ".bun/bin"),
      ...this.roots,
    ];
    if (
      typeof program !== "string" ||
      program.length > 4096 ||
      !isAbsolute(program) ||
      program.includes("\0") ||
      program.split(sep).includes("..") ||
      !allowed.some((root) => inside(program, root))
    )
      throw new Error("absolute allowlisted executable required");
    const canonical = realpathSync(program);
    const denied =
      /^(sudo|su|doas|security|osascript|tclsh|wish|ssh|scp|sftp|login|dscl|launchctl)$/;
    const interpreter =
      /^(sh|bash|zsh|fish|dash|env|python|ruby|perl|node|bun|deno|php|lua|js|jsc|osascript)(?:\d.*)?$/;
    if (
      [program, canonical].some(
        (p) => denied.test(basename(p)) || interpreter.test(basename(p)),
      )
    )
      throw new Error(
        "privileged, remote, shell or interpreter program refused",
      );
    if (
      ![
        ...system,
        join(this.home, ".rustup/toolchains"),
        join(this.home, ".cargo/bin"),
        join(this.home, ".bun/bin"),
        "/Applications/Docker.app/Contents/Resources/bin",
      ].some((root) => inside(canonical, root))
    )
      this.resolve(canonical, true, true);
    if (
      !statSync(canonical).isFile() ||
      (statSync(canonical).mode & 0o111) === 0
    )
      throw new Error("executable file required");
    return {
      ...input,
      program: canonical,
      args: [...input.args],
      cwd,
      risk: input.risk,
    };
  }
  async executeCommand(input: HostCommand) {
    let checked: HostCommand;
    try {
      checked = this.validateCommand(input);
      if (checked.cwd !== input.cwd || checked.program !== input.program)
        throw new Error("approved executable or cwd changed");
    } catch (error) {
      throw new NoEffect(
        error instanceof Error ? error.message : String(error),
      );
    }
    const result = await this.run(
      checked.program,
      checked.args,
      90_000,
      24_000,
      checked.cwd,
    );
    return { ...result, output: redactHostText(result.output) };
  }
}
