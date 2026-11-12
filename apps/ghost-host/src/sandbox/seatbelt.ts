import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * macOS Seatbelt (sandbox-exec) boundary for the workspace execution kind. The kernel, not this
 * process, refuses what the profile denies; `SeatbeltPolicy` is the one ordered rule set both the
 * generated profile and the Host-side path checks read, so a refusal names the same boundary
 * either way. Paths are passed as `sandbox-exec -D` parameters (or, for the two git regexes,
 * escaped into the pattern), never spliced raw into the profile text. Writable roots and git
 * plumbing keep their trusted lexical spelling: resolving mutable symlinks would expand grants.
 */

/** `/usr/bin/sandbox-exec`; the only way a confined argv is started. */
export const SEATBELT_EXEC = "/usr/bin/sandbox-exec";

/**
 * System locations a confined process may read so the common toolchain runs (python3, node, bun,
 * git, ffmpeg, blender, uv, cargo, swift, perl, Homebrew). Credential stores are not in it.
 */
export const TOOLCHAIN_READ_PATHS = [
  "/System", "/usr", "/bin", "/sbin", "/Library/Apple", "/Library/Developer", "/Applications", "/opt/homebrew",
  "/private/etc", "/private/var/db/timezone", "/private/var/db/dyld", "/private/var/db/receipts",
  "/private/var/tmp", "/Users/Shared",
];

/**
 * The current user's macOS scratch directories (DARWIN_USER_TEMP_DIR and CACHE_DIR). Toolchain
 * shims (`/usr/bin/python3`, `/usr/bin/git` route through xcrun) cache there, so the confined
 * process needs read-write; the dirs are per-user scratch, never credentials. The state root
 * deny still wins, so a Ghost test root placed under `tmpdir()` stays sealed.
 */
export function userTempRoots(): string[] {
  const user = realBelow(dirname(tmpdir()));
  return user === null ? [] : [`${user}/T`, `${user}/C`];
}

/** Real path of `path`, or null when nothing at or above it exists. */
export function realBelow(path: string): string | null {
  const segments = path.split("/");
  for (let index = segments.length; index > 1; index -= 1) {
    const ancestor = segments.slice(0, index).join("/") || "/";
    let stats;
    try {
      stats = statSync(ancestor);
    } catch {
      continue;
    }
    const real = realpathSync(ancestor);
    return resolve(real, ...segments.slice(index));
  }
  return null;
}

/** `path` is `root` or lives under it. Both must be real paths already. */
export const insidePath = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/** Credential, key and secret locations a confined process must never read. */
export function secretPaths(home: string, stateRoot: string): string[] {
  return [
    stateRoot,
    `${home}/.ssh`, `${home}/.gnupg`, `${home}/.aws`, `${home}/.config/gcloud`, `${home}/.kube`,
    `${home}/.docker`, `${home}/.ollama`, `${home}/.netrc`, `${home}/.npmrc`,
    `${home}/.cargo/credentials.toml`, `${home}/.cargo/credentials`,
    "/Library/Keychains", "/System/Library/Keychains", "/private/etc/ssh", "/var/db/Keychains",
  ];
}

/** macOS privacy (TCC) folders: reading one unattended would hang on a consent prompt. */
export const privacyPaths = (home: string): string[] =>
  ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music", "Library"].map((name) => `${home}/${name}`);

export interface SeatbeltBoundary {
  /** Trusted lexical roots beneath canonical owner/state parents; never resolve Work-controlled links. */
  writeRoots: string[];
  /** Real directories readable on top of the toolchain set; they override the privacy deny. */
  readRoots: string[];
  /** Read-only roots that beat the secret deny: a reviewed Work's own directories. */
  viewRoots?: string[];
  /** Git plumbing derived from the owner's canonical common directory, not Work-writable metadata. */
  git?: { objects: string; refs: string[] };
  /** Loopback port of the Host egress proxy; null denies all network. */
  proxyPort: number | null;
}

export interface SeatbeltPolicy {
  home: string;
  stateRoot: string;
  writeRoots: string[];
  readRoots: string[];
  viewRoots: string[];
  /** Per-user macOS scratch dirs; kernel-writable, unlike the read-only toolchain tier. */
  tempRoots: string[];
  git: { objects: string; refs: string[] } | null;
  proxyPort: number | null;
  secrets: string[];
  privacy: string[];
  toolchain: string[];
}

/** Normalize to real paths, dropping unknown or non-absolute ones. */
function realPaths(paths: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) continue;
    const real = realBelow(path);
    if (real !== null) seen.add(real);
  }
  return [...seen].sort();
}

/** Grant spelling must not depend on the current targets of Work-writable symlinks. */
function lexicalPaths(paths: readonly string[]): string[] {
  for (const path of paths) {
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("seatbelt: write grants require absolute paths");
  }
  return [...new Set(paths.map((path) => resolve(path)))].sort();
}

/**
 * Build the boundary's rule set. Tiers hold real paths and are decided in this order (last match
 * wins, mirroring SBPL): write roots, secrets, read roots inside privacy folders, privacy
 * folders, read roots, toolchain. So a write root inside the state root works, a read root the
 * owner configured inside a privacy folder opens exactly that folder, and no tier reopens a
 * secret path.
 */
export function buildSeatbeltPolicy(home: string, stateRoot: string, boundary: SeatbeltBoundary): SeatbeltPolicy {
  const objects = boundary.git ? lexicalPaths([boundary.git.objects])[0]! : null;
  const policy: SeatbeltPolicy = {
    home,
    stateRoot,
    writeRoots: lexicalPaths(boundary.writeRoots),
    readRoots: realPaths(boundary.readRoots),
    viewRoots: lexicalPaths(boundary.viewRoots ?? []),
    git: boundary.git && objects !== null ? { objects, refs: lexicalPaths(gitRefPlumbing(boundary.git.refs)) } : null,
    proxyPort: boundary.proxyPort,
    secrets: realPaths(secretPaths(home, stateRoot)),
    privacy: privacyPaths(home),
    toolchain: realPaths([...TOOLCHAIN_READ_PATHS, `${home}/.cargo`, `${home}/.rustup`, `${home}/.bun`, `${home}/.local`, `${home}/.gitconfig`]),
    tempRoots: realPaths(userTempRoots()),
  };
  return policy;
}

/**
 * Everything a Work's worktree commit touches for one branch ref, and nothing else: the ref
 * file, its lock, its reflog entry and the reflog directory that may not exist yet.
 */
export function gitRefPlumbing(refs: string[]): string[] {
  const plumbing: string[] = [];
  for (const ref of refs) {
    const reflog = ref.replace("/refs/heads/", "/logs/refs/heads/");
    plumbing.push(ref, `${ref}.lock`, reflog, `${reflog}.lock`, dirname(reflog));
  }
  return plumbing;
}

export type SeatbeltDecision = { ok: true } | { ok: false; why: "unwritable" | "secret" | "privacy" | "unreadable" };

/** The one decision function for Host-side path checks; the generated profile agrees with it. */
export function seatbeltDecision(policy: SeatbeltPolicy, realPath: string, mode: "read" | "write"): SeatbeltDecision {
  if (mode === "write")
    return policy.writeRoots.some((root) => insidePath(realPath, root)) ? { ok: true } : { ok: false, why: "unwritable" };
  if (policy.writeRoots.some((root) => insidePath(realPath, root)) || policy.viewRoots.some((root) => insidePath(realPath, root)))
    return { ok: true };
  if (policy.secrets.some((root) => insidePath(realPath, root))) return { ok: false, why: "secret" };
  if (policy.readRoots.some((root) => insidePath(realPath, root))) return { ok: true };
  if (policy.privacy.some((root) => insidePath(realPath, root))) return { ok: false, why: "privacy" };
  if (policy.toolchain.some((root) => insidePath(realPath, root)) || policy.tempRoots.some((root) => insidePath(realPath, root))) return { ok: true };
  return { ok: false, why: "unreadable" };
}

/** Why the boundary refused `realPath`, as a model-facing sentence naming the boundary. */
export function seatbeltRefusal(policy: SeatbeltPolicy, realPath: string, mode: "read" | "write"): string {
  const decision = seatbeltDecision(policy, realPath, mode);
  const why: "unwritable" | "secret" | "privacy" | "unreadable" = mode === "write" || decision.ok ? "unwritable" : decision.why;
  if (why === "unwritable")
    return `sandbox: write refused; this Work can only write inside ${describeRoots(policy.writeRoots)}. Write there (or copy the file in) instead of retrying this path`;
  if (why === "secret")
    return `sandbox: read refused; ${realPath} is a secret, credential or Ghost state path and is never readable inside the sandbox`;
  if (why === "privacy")
    return `sandbox: read refused; ${realPath} is a macOS privacy-guarded folder (Desktop, Documents, Downloads, Pictures, Movies, Music or Library) outside the configured read roots`;
  return `sandbox: read refused; ${realPath} is outside the readable roots of this Work. Ask the owner or use an allowed tool instead of retrying this path`;
}

function describeRoots(roots: string[]): string {
  return roots.slice(0, 4).join(", ") + (roots.length > 4 ? ` and ${roots.length - 4} more` : "");
}

/**
 * The SBPL profile for `policy`. Paths ride in as `-D` parameters (`W` write, `R` read, `E`
 * evidence, `K` secrets, `V` privacy, `T` toolchain, `U` scratch, `O` git objects, `B` git refs).
 * A matching deny beats any allow, so each deny carries its own exceptions as a
 * `require-not(require-any(...))` filter: the state-root deny exempts the Work's own directories
 * inside it, a privacy-folder deny exempts the configured roots inside that folder. Nothing else
 * can reopen a secret path. Metadata reads stay allowed everywhere: `realpath` and `getcwd` stat
 * every ancestor of the workspace, which itself lives under the denied state root.
 */
export function seatbeltProfile(policy: SeatbeltPolicy): { profile: string; definitions: string[] } {
  const definitions: string[] = [];
  const paramPrefix = (prefix: string, roots: string[]): string[] =>
    roots.map((root, index) => {
      definitions.push(`${prefix}${index}=${root}`);
      return `${prefix}${index}`;
    });
  const allowSubpaths = (names: string[], operations: string[]): string =>
    names.flatMap((name) => operations.map((operation) => `(allow ${operation} (subpath (param "${name}")))`)).join("\n");
  // `(deny op (require-all (subpath ROOT) (require-not (require-any exceptions...))))`; with no
  // exception the inner filter collapses to a plain subpath.
  const denyExcept = (root: string, exceptions: string[], operations: string[]): string => {
    const inside = exceptions.filter((exception) => insidePath(exception, root)).map((exception) => {
      const escaped = exception.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return `(regex #"^${escaped}(/|$)")`;
    });
    const filter = inside.length === 0
      ? `(subpath "${root}")`
      : `(require-all (subpath "${root}") (require-not (require-any ${inside.join(" ")})))`;
    return operations.map((operation) => `(deny ${operation} ${filter})`).join("\n");
  };

  const rules = [
    allowSubpaths(paramPrefix("T", policy.toolchain), ["file-read*"]),
    allowSubpaths(paramPrefix("U", policy.tempRoots), ["file-read*", "file-write*", "file-write-xattr"]),
    allowSubpaths(paramPrefix("R", policy.readRoots), ["file-read*"]),
    policy.viewRoots.map((root) => {
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return `(allow file-read* (regex #"^${escaped}(/|$)"))`;
    }).join("\n"),
    // Regex filters match the kernel's resolved path without resolving the grant's spelling.
    // A symlink swapped before profile compilation must never grant its outside target.
    policy.writeRoots.map((root) => {
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return `(allow file-read* file-write* file-write-xattr (regex #"^${escaped}(/|$)"))`;
    }).join("\n"),
    // Privacy folders deny even under a read root, except the roots the owner configured there.
    policy.privacy
      .map((folder) => denyExcept(folder, [...policy.readRoots, ...policy.writeRoots, ...policy.viewRoots], ["file-read-data", "file-read-xattr"]))
      .join("\n"),
    // Secrets never reopen through read roots or the toolchain; only the Work's own directories
    // inside the state root (its workspace, and a reviewer's view of it) are exempt.
    policy.secrets
      .map((secret) => denyExcept(secret, [...policy.writeRoots, ...policy.viewRoots], ["file-read-data", "file-read-xattr", "file-write*", "file-write-xattr"]))
      .join("\n"),
  ];
  if (policy.git !== null) {
    definitions.push(`O0=${policy.git.objects}`);
    // This SBPL flavor has no `{n}` intervals; classes repeat instead.
    const objects = policy.git.objects.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // New loose objects only: create the fan-out dir and the object (or its temp name), write it,
    // unlink a temp a failed write leaves behind. Existing objects are never modified or removed.
    const fanout = `${objects}/[0-9a-f][0-9a-f]`;
    const objectFile = `${fanout}/(tmp_obj_[0-9A-Za-z]+|[0-9a-f]+)`;
    // A branch ref, its lock file and its reflog entry: lock, write, rename into place.
    const refRules = policy.git.refs.map((ref) => {
      const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const filter = `(regex #"^${escaped}$")`;
      return [`(allow file-write* file-write-create ${filter})`, `(allow file-unlink ${filter})`].join("\n");
    });
    rules.push([
      `(allow file-read* (subpath (param "O0")))`,
      `(allow file-write-xattr (subpath (param "O0")))`,
      `(allow file-write-data file-write-create (regex #"^${fanout}$"))`,
      `(allow file-write-data file-write-create (regex #"^${objectFile}$"))`,
      `(allow file-unlink (regex #"^${fanout}/tmp_obj_[0-9A-Za-z]+$"))`,
      refRules.join("\n"),
    ].join("\n"));
  }
  const outbound = policy.proxyPort === null ? "" : `(allow network* (remote ip "localhost:${policy.proxyPort}"))`;
  const profile = `(version 1)
(deny default)
(allow process*) (allow process-info* (target self))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/") (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null") (literal "/dev/zero"))
(allow file-write* (literal "/dev/null"))
;; The xcrun shim reads the Xcode license marker before running any developer tool.
(allow file-read* (literal "/Library/Preferences/com.apple.dt.Xcode.plist") (literal "/Library/Preferences/.GlobalPreferences.plist"))
(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center")
  (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.trustd.agent")
  (global-name "com.apple.fonts") (global-name "com.apple.fontobjects") (global-name "com.apple.FontServer")
  (global-name "com.apple.lsd.*") (global-name "com.apple.system.libinfo.user")
  (global-name "com.apple.system.logger") (global-name "com.apple.system.preset_services")
  (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.system.opendirectoryd.membership"))
(allow ipc-posix-shm-read-data) (allow ipc-posix-shm-write-create)
(allow ipc-posix-sem)
(allow file-ioctl)
${outbound}
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
${rules.filter(Boolean).join("\n")}
`;
  return { profile, definitions };
}
/**
 * Wrap `argv` so it runs inside `policy`: `/usr/bin/sandbox-exec -D name=path ... -p profile
 * <argv>`. Reused by the workspace shell and any other module that must run inside the same
 * boundary (an MCP stdio server, for example).
 */
export function seatbeltArgv(policy: SeatbeltPolicy, argv: string[]): string[] {
  if (argv.length === 0 || argv.some((word) => word.includes("\0"))) throw new Error("seatbelt: empty or unsafe argv");
  if (process.platform !== "darwin") throw new Error("seatbelt: workspace execution requires macOS");
  const { profile, definitions } = seatbeltProfile(policy);
  const parameters = definitions.flatMap((definition) => ["-D", definition]);
  return [SEATBELT_EXEC, ...parameters, "-p", profile, ...argv];
}

/** Bounded tail of command output, kept to explain a sandbox refusal. */
const TAIL_CHARS = 8_000;
const EPERM_LINE = /(operation not permitted|permission denied|errno\s*=\s*1\b|\beperm\b|\beacces\b|read-only file system|(?:^|\s)sandbox(?:-exec)?:)/i;
const PATH_IN_LINE = /(?:^|[\s"'`=(:;,])((?:\/|~\/)[^\s"'`):;,]*)/g;
const NETWORK_FAILURE = /(could not resolve host|getaddrinfo|name or service not known|network is unreachable|enotfound|connection attempt refused|couldn't connect)/i;

/**
 * The boundary refusal a failed command most likely hit, or null when the output does not look
 * like one. Names the refusing boundary (write outside the writable roots, denied read, network)
 * so the model changes approach instead of retrying the same command.
 */
export function explainSeatbeltRefusal(output: string, options: { cwd: string; policy: SeatbeltPolicy }): string | null {
  const lines = output.split("\n").filter((line) => EPERM_LINE.test(line)).slice(-8);
  for (const line of lines) {
    for (const match of line.matchAll(PATH_IN_LINE)) {
      const candidate = match[1]!.replace(/^~/, homedir());
      if (!isAbsolute(candidate)) continue;
      const real = realBelow(resolve(options.cwd, candidate));
      if (real === null) continue;
      const read = seatbeltDecision(options.policy, real, "read");
      const write = seatbeltDecision(options.policy, real, "write");
      // A secret or privacy refusal is a read boundary even when the command also could not write;
      // otherwise a blocked write explains the writable roots.
      if (!read.ok && (read.why === "secret" || read.why === "privacy")) return seatbeltRefusal(options.policy, real, "read");
      if (!write.ok) return seatbeltRefusal(options.policy, real, "write");
      if (!read.ok) return seatbeltRefusal(options.policy, real, "read");
    }
    if (NETWORK_FAILURE.test(line))
      return options.policy.proxyPort === null
        ? "sandbox: this environment has no network access at all; use the granted web tools instead"
        : `sandbox: the network is confined to the egress proxy at 127.0.0.1:${options.policy.proxyPort}; a tool that cannot use HTTP(S)_PROXY cannot reach the internet. Route the request through the proxy or use the granted web tools`;
  }
  if (lines.length === 0 && NETWORK_FAILURE.test(output.slice(-TAIL_CHARS))) {
    return options.policy.proxyPort === null
      ? "sandbox: this environment has no network access at all; use the granted web tools instead"
      : `sandbox: the network is confined to the egress proxy at 127.0.0.1:${options.policy.proxyPort}; a tool that cannot use HTTP(S)_PROXY cannot reach the internet. Route the request through the proxy or use the granted web tools`;
  }
  if (lines.length > 0)
    return "sandbox: the command hit the boundary (Operation not permitted) but named no path; it is outside what this Work may write or read. Stay inside its directories instead of retrying";
  return null;
}
