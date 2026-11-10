import {
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { open, opendir, statfs } from "node:fs/promises";
import { isIP } from "node:net";
import { cpus, homedir, loadavg, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  HostCommand,
  HostPort,
  HostStatus,
  HostServices,
  HostNodes,
} from "./ports.ts";
import { assertFetchableUrl } from "./netguard.ts";
import { NoEffect } from "../core/effects.ts";

const GB = 1_073_741_824;
const PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
export interface HostOutput {
  exitCode: number | null;
  output: string;
  stdout: string;
  stderr: string;
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
  /** Host-internal only; never supplied by a tool caller. */
  inspection?: boolean;
}
export type HostRunner = (input: HostRun) => Promise<HostOutput>;

/** No shell, inherited credentials or surviving background descendants. Captures a shared byte budget. */
export const runHostCommand: HostRunner = async (input) => {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([input.program, ...input.args], {
      cwd: input.cwd,
      env: {
        PATH, HOME: input.home, LANG: "en_US.UTF-8",
        ...(input.inspection && input.program === "/usr/bin/git" ? {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "/bin/cat",
          // Command-scope config wins over repository config, including includes.
          GIT_CONFIG_COUNT: "15",
          GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
          GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false",
          GIT_CONFIG_KEY_2: "core.pager", GIT_CONFIG_VALUE_2: "/bin/cat",
          GIT_CONFIG_KEY_3: "diff.external", GIT_CONFIG_VALUE_3: "",
          GIT_CONFIG_KEY_4: "credential.helper", GIT_CONFIG_VALUE_4: "",
          GIT_CONFIG_KEY_5: "credential.interactive", GIT_CONFIG_VALUE_5: "false",
          GIT_CONFIG_KEY_6: "protocol.allow", GIT_CONFIG_VALUE_6: "never",
          GIT_CONFIG_KEY_7: "protocol.https.allow", GIT_CONFIG_VALUE_7: "always",
          GIT_CONFIG_KEY_8: "core.sshCommand", GIT_CONFIG_VALUE_8: "/usr/bin/false",
          GIT_CONFIG_KEY_9: "log.showSignature", GIT_CONFIG_VALUE_9: "false",
          GIT_CONFIG_KEY_10: "diff.submodule", GIT_CONFIG_VALUE_10: "short",
          GIT_CONFIG_KEY_11: "core.untrackedCache", GIT_CONFIG_VALUE_11: "false",
          GIT_CONFIG_KEY_12: "http.followRedirects", GIT_CONFIG_VALUE_12: "false",
          GIT_CONFIG_KEY_13: "log.mailmap", GIT_CONFIG_VALUE_13: "false",
          GIT_CONFIG_KEY_14: "format.pretty", GIT_CONFIG_VALUE_14: "medium",
        } : {}),
      },
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
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
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
  const capture = async (
    stream: ReadableStream<Uint8Array>,
    chunks: Uint8Array[],
    limit: number,
  ) => {
    let size = 0;
    const reader = stream.getReader();
    readers.push(reader);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const room = Math.max(0, limit - size);
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
  // Reserve capacity for both streams: diagnostic floods must not hide du's stdout total.
  const output = Promise.all([
    capture(child.stdout, stdoutChunks, Math.ceil(input.maxBytes / 2)),
    capture(child.stderr, stderrChunks, Math.floor(input.maxBytes / 2)),
  ]);
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
    try {
      await output;
    } finally {
      clearTimeout(drainTimer);
    }
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    return {
      exitCode,
      stdout,
      stderr,
      output: stdout + stderr,
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
  id_rsa: true,
  id_ed25519: true,
  id_dsa: true,
  id_ecdsa: true,
  id_ecdsa_sk: true,
  id_ed25519_sk: true,
  "cookies.binarycookies": true,
  ".git-credentials": true,
  ".gitconfig": true,
  ".bash_history": true,
  ".zsh_history": true,
};

// These are owner app-data locations, not forbidden names in a project tree.
const homeDotDirectories = [".docker", ".config", ".npm", ".password-store", ".1password", ".mozilla", ".thunderbird"];
const privateLibraryDirectories = [
  "Keychains", "Mail", "Messages", "Accounts", "Containers", "Group Containers",
  "Mobile Documents", "CloudStorage", "Safari", "Calendars", "Reminders", "HomeKit", "Cookies",
  "Suggestions", "IdentityServices", "Metadata/CoreSpotlight",
  "Application Support/Google/Chrome", "Application Support/Chromium",
  "Application Support/BraveSoftware", "Application Support/Microsoft Edge",
  "Application Support/Firefox", "Application Support/Thunderbird", "Application Support/AddressBook",
  "Application Support/CallHistoryDB", "Application Support/com.apple.TCC",
];
/**
 * macOS privacy (TCC) guards these for a background process: touching them from the Host asks for
 * consent and blocks its event loop until someone answers, and every release is a new identity.
 */
const privacyGuardedHomeDirectories = ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music"];
const privateNames: Record<string, true> = {
  private: true,
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
      /\.(pem|key|p12|sqlite|db)$|-(?:wal|shm|journal)$/.test(n)
    );
  });
export const privateTextPath = (path: string) =>
  path
    .split(sep)
    .some((part) => Object.hasOwn(privateNames, part.toLowerCase()));
export function sensitiveText(text: string): boolean {
  return (
    /macfra-approval-[a-f0-9]{64}|-----begin|bearer /i.test(text) ||
    /\b[a-f0-9]{48,}\b|(?:^|[\s"'=:])[a-z0-9+/_-]{64,}={0,2}(?=$|[\s"',;}])/i.test(text) ||
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
    .map((line) => (sensitiveText(line) ? "[REDACTED: sensitive text]" :
      line.replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
        .replace(/([?&](?:token|access_token|key|password)=)[^&\s]+/gi, "$1[REDACTED]")))
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

interface InspectionShape {
  paths: number[];
  git?: boolean;
  gitRemote?: boolean;
  findAction?: boolean;
  findRootEnd?: number;
  recursive?: boolean;
}

const inspectionPrograms: Record<string, string> = Object.fromEntries([
  "/bin/ls", "/bin/cat", "/usr/bin/head", "/usr/bin/tail", "/usr/bin/wc",
  "/usr/bin/sed", "/usr/bin/grep", "/usr/bin/which", "/usr/bin/stat",
  "/usr/bin/file", "/usr/bin/du", "/bin/df", "/usr/bin/find", "/bin/ps",
  "/usr/bin/sw_vers", "/usr/bin/uptime", "/usr/bin/plutil", "/bin/launchctl", "/usr/bin/git",
].map((program) => [basename(program), program]));
const inspectionProgram = (program: string) =>
  Object.hasOwn(inspectionPrograms, program) ? inspectionPrograms[program]! : program;

/** Deliberately small argv grammar, not a blacklist of dangerous command names. */
function inspectionShape(program: string, args: string[]): InspectionShape | null {
  if (!Array.isArray(args) || args.length > 64 ||
      args.some((arg) => typeof arg !== "string" || arg.length > 4096 || /[\0\r\n]/.test(arg)) ||
      args.join("").length > 12_000) return null;
  const paths: number[] = [];
  const operands = (start: number, flags: RegExp, valued: readonly string[] = []) => {
    let positional = false;
    for (let i = start; i < args.length; i++) {
      const arg = args[i]!;
      if (!positional && arg === "--") { positional = true; continue; }
      if (!positional && valued.includes(arg)) {
        if (!/^\d{1,9}$/.test(args[++i] ?? "")) return false;
      } else if (!positional && arg.startsWith("-")) {
        if (!flags.test(arg)) return false;
      } else {
        if (!arg || arg === "-" || /[;|&<>`$]/.test(arg)) return false; // never read stdin or shell snippets
        paths.push(i);
      }
    }
    return true;
  };
  switch (inspectionProgram(program)) {
    case "/bin/ls":
      return operands(0, /^-[1AacdfghiklmnopqrstuxFST]+$/) ? { paths } : null;
    case "/bin/cat":
      return operands(0, /^-[benstuv]+$/) && paths.length ? { paths } : null;
    case "/usr/bin/head":
    case "/usr/bin/tail": {
      let positional = false;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (!positional && arg === "--") { positional = true; continue; }
        if (!positional && arg === "-n") {
          if (!/^\+?\d{1,9}$/.test(args[++i] ?? "")) return null;
        } else if (!positional && /^-(?:[qvr]+|\d{1,9}|n\+?\d{1,9})$/.test(arg)) continue;
        else if (!positional && arg.startsWith("-")) return null;
        else {
          if (!arg || arg === "-" || /[;|&<>`$]/.test(arg)) return null;
          paths.push(i);
        }
      }
      return paths.length ? { paths } : null;
    }
    case "/usr/bin/sed": {
      if (args[0] !== "-n") return null;
      const print = /^(?:[1-9]\d*(?:,(?:[1-9]\d*|\$))?|\$)p$/;
      let i = 1;
      if (args[i] === "-e") {
        while (args[i] === "-e") if (!print.test(args[++i] ?? "")) return null; else i++;
      } else if (!print.test(args[i++] ?? "")) return null;
      if (args[i] === "--") i++;
      for (; i < args.length; i++) {
        if (!args[i] || args[i]!.startsWith("-") || /[;|&<>`$]/.test(args[i]!)) return null;
        paths.push(i);
      }
      return paths.length ? { paths } : null;
    }
    case "/usr/bin/grep": {
      let pattern = false;
      let positional = false;
      let recursive = false;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (!positional && arg === "--") { positional = true; continue; }
        if (!positional && arg === "-e") {
          if (args[++i] === undefined) return null;
          pattern = true;
        } else if (!positional && /^-[rRnclLiwxvEFIHhosq]+$/.test(arg)) {
          if (/[rR]/.test(arg)) recursive = true;
        }
        else if (!positional && /^-[CABm]\d{1,9}$/.test(arg)) continue;
        else if (!positional && /^-[CABm]$/.test(arg)) {
          if (!/^\d{1,9}$/.test(args[++i] ?? "")) return null;
        } else if (!positional && /^(?:--(?:include|exclude|exclude-dir)=.+|--color=never)$/.test(arg)) continue;
        else if (!positional && arg.startsWith("-")) return null;
        else {
          if (arg === "-") return null;
          paths.push(i);
        }
      }
      const hasPattern = pattern || paths.shift() !== undefined;
      return hasPattern && paths.length && paths.every((index) => args[index]) ? { paths, recursive } : null;
    }
    case "/usr/bin/which":
      return args.length > 0 && args.every((arg) => /^[a-zA-Z0-9_.+-]+$/.test(arg) && !arg.startsWith("-")) ? { paths } : null;
    case "/usr/bin/wc":
      return operands(0, /^-[clmw]+$/) && paths.length ? { paths } : null;
    case "/usr/bin/stat":
      return operands(0, /^-[lnqrsx]+$/) && paths.length ? { paths } : null;
    case "/usr/bin/file":
      return operands(0, /^-[bhiIN]+$/) && paths.length ? { paths } : null;
    case "/usr/bin/du":
      return operands(0, /^-[acdhkmnrsxP]+$/, ["-d"]) ? { paths } : null;
    case "/bin/df":
      return operands(0, /^-[HhiklmnPT]+$/) ? { paths } : null;
    case "/usr/bin/find": {
      let i = 0;
      if (args[0] === "-P" || args[0] === "-x") i++;
      while (i < args.length && !args[i]!.startsWith("-") && !["(", "!", ")"].includes(args[i]!))
        paths.push(i++);
      if (!paths.length) return null;
      const findRootEnd = i;
      let findAction = false;
      for (; i < args.length; i++) {
        const arg = args[i]!;
        if (["-print", "-ls", "-prune"].includes(arg)) { findAction = true; continue; }
        if (["-empty", "-a", "-and", "-o", "-or", "!", "-not", "(", ")", "-xdev"].includes(arg)) continue;
        if (["-name", "-iname", "-path", "-ipath"].includes(arg)) {
          if (!args[++i] || args[i]!.includes("/../")) return null;
        } else if (arg === "-type") {
          if (!/^[bcdflps]$/.test(args[++i] ?? "")) return null;
        } else if (["-mtime", "-mmin", "-ctime", "-cmin", "-atime", "-amin", "-size", "-maxdepth", "-mindepth"].includes(arg)) {
          if (!/^[+-]?\d{1,9}[ckMG]?$/i.test(args[++i] ?? "")) return null;
        } else if (arg === "-newer") {
          if (!args[++i] || args[i]!.startsWith("-")) return null;
          paths.push(i);
        } else return null;
      }
      return { paths, findAction, findRootEnd };
    }
    case "/bin/ps":
      // No environment or command arguments: they commonly contain credentials.
      return args.length === 0 || (args.length === 2 && args[0] === "-axo" &&
        /^(?:pid|ppid|pcpu|pmem|rss|vsz|stat|comm|etime|time)(?:=)?(?:,(?:pid|ppid|pcpu|pmem|rss|vsz|stat|comm|etime|time)(?:=)?)*$/.test(args[1]!))
        ? { paths } : null;
    case "/usr/bin/sw_vers":
      return args.length === 0 || (args.length === 1 && ["-productName", "-productVersion", "-buildVersion"].includes(args[0]!)) ? { paths } : null;
    case "/usr/bin/uptime":
      return args.length === 0 ? { paths } : null;
    case "/usr/bin/plutil":
      return args.length === 2 && args[0] === "-p" ? { paths: [1] } : null;
    case "/bin/launchctl":
      return (args[0] === "list" && args.length <= 2 &&
        (!args[1] || /^[a-zA-Z0-9._-]+$/.test(args[1]))) ||
        (args[0] === "print" && args.length === 2 &&
          /^(?:system|user\/\d+|gui\/\d+)(?:\/[a-zA-Z0-9._-]+)?$/.test(args[1]!))
        ? { paths } : null;
    case "/usr/bin/git": {
      let i = 0;
      for (; i < args.length; i++) {
        if (args[i] === "--no-optional-locks") continue;
        if (args[i] === "-C" && args[i + 1]) { paths.push(++i); continue; }
        break;
      }
      const sub = args[i++];
      const rest = args.slice(i);
      const all = (pattern: RegExp) => rest.every((arg) => pattern.test(arg));
      let allowed = false;
      switch (sub) {
        case "status": allowed = all(/^(?:--short|--branch|--porcelain(?:=v[12])?|--untracked-files=(?:no|normal|all))$/); break;
        case "log": allowed = all(/^(?:-\d{1,4}|--max-count=\d{1,4}|--oneline|--stat|--name-only|--all|--decorate(?:=short|=no)?|--no-decorate|--graph|--no-merges|--first-parent)$/); break;
        case "show":
        case "diff":
          allowed = rest.some((a) => a === "--stat" || a === "--name-only") &&
            all(/^(?:--stat|--name-only|--cached|--staged|--no-renames|--no-ext-diff|--no-textconv|HEAD(?:~\d{1,4}|\^\d?)?|[a-f0-9]{7,40})$/);
          break;
        case "branch": allowed = all(/^(?:--list|--all|--remotes|--verbose|-[arv]+|--show-current)$/); break;
        case "remote": allowed = rest.length === 1 && rest[0] === "-v"; break;
        case "rev-parse": allowed = rest.length > 0 && all(/^(?:--show-toplevel|--show-prefix|--git-dir|--is-inside-work-tree|--is-bare-repository|--short|--verify|--abbrev-ref|HEAD(?:~\d{1,4}|\^\d?)?)$/); break;
        case "stash": allowed = rest.length === 1 && rest[0] === "list"; break;
        case "config": allowed = rest.length === 2 && rest[0] === "--get" &&
          /^(?:user\.(?:name|email)|core\.(?:bare|repositoryformatversion|filemode|ignorecase)|remote\.[a-zA-Z0-9_-]+\.(?:url|fetch)|branch\.[a-zA-Z0-9_/-]+\.(?:remote|merge))$/.test(rest[1]!); break;
        case "ls-remote":
          // Literal destinations are limited to GitHub. Named remotes are resolved
          // and checked against the shared public-network guard before any request.
          allowed = rest.length > 0 && rest.every((arg, n) =>
            n === rest.length - 1
              ? /^(?:https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+|[a-zA-Z0-9][a-zA-Z0-9_-]*)$/.test(arg)
              : /^(?:--heads|--tags|--refs|--symref|--exit-code)$/.test(arg));
          break;
      }
      return allowed ? { paths, git: true, gitRemote: sub === "ls-remote" } : null;
    }
    default: return null;
  }
}

export const isReadOnlyHostCommand = (input: Pick<HostCommand, "program" | "args">) =>
  inspectionShape(input.program, input.args) !== null;
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
      stateRoot?: string;
      runner?: HostRunner;
      now?: () => number;
    } = {},
  ) {
    this.home = options.home ?? homedir();
    this.stateRoot = options.stateRoot ? resolve(expand(options.stateRoot, this.home)) : null;
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
  private readonly stateRoot: string | null;
  private readonly runner: HostRunner;
  private readonly now: () => number;
  private run(
    program: string,
    args: string[],
    timeoutMs = 6000,
    maxBytes = 24_000,
    cwd = this.home,
    inspection = false,
  ) {
    return this.runner({
      program,
      args,
      timeoutMs,
      maxBytes,
      cwd,
      home: this.home,
      inspection,
    });
  }
  private statePaths(): string[] {
    if (!this.stateRoot) return [];
    try { return [...new Set([this.stateRoot, realpathSync(this.stateRoot)])]; }
    catch { return [this.stateRoot]; }
  }
  private refuseStatePath(...paths: string[]) {
    if (this.statePaths().some((root) => paths.some((path) => inside(path, root))))
      throw new Error("Ghost state root is not available for inspection");
  }
  private homePrivatePaths(): string[] {
    const paths = [this.home, realpathSync(this.home)].flatMap((home) => [
      ...homeDotDirectories.map((name) => join(home, name)),
      ...privacyGuardedHomeDirectories.map((name) => join(home, name)),
      ...privateLibraryDirectories.map((name) => join(home, "Library", name)),
      join(home, ".local/share/keyrings"),
    ]);
    // Lexical only: resolving Mail, Messages, Safari or Containers from a LaunchAgent asks macOS
    // privacy (TCC) for consent and blocks the Host's event loop until someone answers.
    return [...new Set(paths)];
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
    this.refuseStatePath(path, canonical);
    if (this.homePrivatePaths().some((root) => [path, canonical].some((candidate) =>
      inside(candidate.toLowerCase(), root.toLowerCase()))))
      throw new Error("private home app-data path refused");
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
  private inspectionPath(path: string, base = this.home, gitMetadata = false, text = false): string {
    if (typeof path !== "string" || !path || path.length > 4096 || /[\0\r\n]/.test(path))
      throw new Error("invalid inspection path");
    const home = realpathSync(this.home);
    const raw = resolve(base, expand(path, this.home));
    const isPrivate = (candidate: string) => this.homePrivatePaths().some((root) => inside(candidate.toLowerCase(), root.toLowerCase()));
    // Refuse private app data before touching it: resolving it would itself ask macOS privacy for consent.
    this.refuseStatePath(raw);
    if (isPrivate(raw)) throw new Error("private home app-data path refused; use a non-private file inside owner home");
    const canonical = realpathSync(raw);
    this.refuseStatePath(raw, canonical);
    if (isPrivate(canonical)) throw new Error("private home app-data path refused");
    for (const candidate of [raw, canonical]) {
      const root = inside(candidate, home) ? home :
        candidate === raw && inside(candidate, this.home) ? this.home : null;
      if (!root) throw new Error("inspection path or symlink is outside owner home; use a non-private path inside owner home");
      const parts = relative(root, candidate).split(sep);
      // Git may inspect its own metadata, never arbitrary .git text via cat.
      const guarded = gitMetadata ? parts.filter((part) => part !== ".git").join(sep) : parts.join(sep);
      const project = this.roots.some((project) => {
        try { return inside(candidate, project) || inside(candidate, realpathSync(project)); } catch { return false; }
      });
      // Generic project data is not personal data; explicitly private directories remain guarded.
      const privateParts = project ? guarded.split(sep).filter((part) =>
        !["data", "store", "stores", "archive", "archives"].includes(part.toLowerCase())).join(sep) : guarded;
      if (secretPath(guarded) || (text && privateTextPath(privateParts)))
        throw new Error("secret or private inspection path refused; use a non-private, non-secret file inside owner home");
    }
    if (text) {
      // Trust configured root aliases, but never follow links below them or elsewhere in home.
      const roots = this.roots.flatMap((raw) => {
        try { return [{ raw, canonical: realpathSync(raw) }]; } catch { return []; }
      }).sort((a, b) => b.raw.length - a.raw.length);
      const project = roots.find((root) => inside(raw, root.raw) || inside(raw, root.canonical));
      const base = project ? (inside(raw, project.raw) ? project.raw : project.canonical) :
        inside(raw, this.home) ? this.home : home;
      let current = project?.canonical ?? home;
      for (const component of relative(base, raw).split(sep).filter(Boolean)) {
        current = join(current, component);
        if (lstatSync(current).isSymbolicLink())
          throw new Error("symlink reads refused; use the original non-private file path inside owner home");
      }
    }
    return canonical;
  }
  private gitDirectory(base: string): { directory: string; worktree: string | null } | null {
    const home = realpathSync(this.home);
    for (let dir = base;; dir = dirname(dir)) {
      const dotgit = join(dir, ".git");
      const worktree = existsSync(dotgit);
      const bare = !worktree && existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects"));
      if (worktree || bare) {
        let directory = this.inspectionPath(worktree ? dotgit : dir, dir, true);
        if (statSync(directory).isFile()) {
          if (statSync(directory).size > 4096) throw new Error("invalid git directory file");
          const match = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(directory, "utf8"));
          if (!match) throw new Error("invalid git directory file");
          directory = this.inspectionPath(match[1]!, dir, true);
        }
        if (!statSync(directory).isDirectory()) throw new Error("invalid git directory");
        const common = join(directory, "commondir");
        const metadata = [directory];
        if (existsSync(common)) {
          if (statSync(common).size > 4096) throw new Error("invalid git common directory");
          metadata.push(this.inspectionPath(readFileSync(common, "utf8").trim(), directory, true));
        }
        for (const root of metadata) {
          for (const name of ["config", "config.worktree", "index", "HEAD", "packed-refs", "objects", "refs", "logs", "info"]) {
            const path = join(root, name);
            if (existsSync(path)) this.inspectionPath(path, root, true);
          }
          if (existsSync(join(root, "objects/info/alternates")))
            throw new Error("alternate Git object stores are not supported for inspection");
        }
        return { directory, worktree: worktree ? dir : null };
      }
      if (dir === home) return null;
    }
  }
  private prepareInspection(input: HostCommand, shape: InspectionShape): HostCommand {
    const cwd = this.inspectionPath(input.cwd);
    if (!statSync(cwd).isDirectory()) throw new Error("cwd must be a directory");
    const args = [...input.args];
    let base = cwd;
    for (const index of shape.paths) {
      args[index] = this.inspectionPath(args[index]!, base, false,
        ["/bin/cat", "/usr/bin/head", "/usr/bin/tail", "/usr/bin/wc", "/usr/bin/plutil", "/usr/bin/sed", "/usr/bin/grep"].includes(input.program));
      if (shape.git) {
        if (!statSync(args[index]!).isDirectory()) throw new Error("git -C requires a directory");
        base = args[index]!;
      } else if (["/bin/cat", "/usr/bin/head", "/usr/bin/tail", "/usr/bin/wc", "/usr/bin/plutil", "/usr/bin/sed"].includes(input.program) &&
          !statSync(args[index]!).isFile()) {
        throw new Error("inspection requires regular files");
      }
      if (input.program === "/usr/bin/grep" &&
          !statSync(args[index]!).isFile() && !statSync(args[index]!).isDirectory())
        throw new Error("grep inspection requires regular files or directories");
      if (input.program === "/usr/bin/grep" && shape.recursive &&
          !this.roots.some((root) => {
            try { return inside(args[index]!, realpathSync(root)); } catch { return false; }
          }))
        throw new Error("recursive grep requires configured project paths; select a project directory or inspect a single non-private file");
    }
    if (input.program === "/usr/bin/du") {
      const roots = shape.paths.length ? shape.paths.map((index) => args[index]!) : [cwd];
      if (roots.some((root) => [...this.statePaths(), ...this.homePrivatePaths()].some((path) =>
        inside(path.toLowerCase(), root.toLowerCase()))))
        throw new Error("recursive disk measurement includes private home app-data");
    }
    if (shape.git) this.gitDirectory(base);
    const executable = realpathSync(input.program);
    if (!statSync(executable).isFile() || (statSync(executable).mode & 0o111) === 0)
      throw new Error("executable file required");
    // Retain the strict absolute allowlist spelling across revalidation.
    return { ...input, args, program: input.program, cwd };
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
          volumeId: String(statSync(path).dev),
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
    const kb = /^\s*(\d+)\s/m.exec(result.stdout)?.[1];
    if (!kb) throw new Error("disk usage unavailable");
    return {
      path: canonical,
      bytes: Number(kb) * 1024,
      partial: result.exitCode !== 0 || result.timedOut || result.truncated,
    };
  }
  async list(path: string) {
    const canonical = this.inspectionPath(path);
    const listing = await entries(canonical, 1001);
    const visible = listing.filter((e) => !secretPath(e.name));
    return {
      path: canonical,
      entries: visible.slice(0, 100).map((e) => ({
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
  async read(path: string, offset = 1, limit?: number) {
    if (!Number.isSafeInteger(offset) || offset < 1 || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)))
      throw new Error("invalid line range; use offset >= 1 and a positive integer limit");
    const canonical = this.inspectionPath(path, this.home, false, true);
    const file = await open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("regular UTF-8 file required; choose a text file inside owner home");
      const maxBytes = 8 * 1024 * 1024;
      if (info.size > maxBytes) throw new Error("file exceeds 8 MiB; use host_command_propose with tail or sed to inspect a bounded section");
      const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
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
      if (size > maxBytes || size > info.size) throw new Error("file grew during reading; retry host_read after the writer finishes");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)); }
      catch { throw new Error("invalid UTF-8 file refused; choose a UTF-8 text file"); }
      if (text.includes("\0")) throw new Error("binary file refused; choose a UTF-8 text file");
      let totalLines = 0;
      let cursor = 0;
      let start = -1;
      let end = 0;
      let endLine = offset - 1;
      let pageBytes = 0;
      while (cursor < text.length) {
        const newline = text.indexOf("\n", cursor);
        const next = newline < 0 ? text.length : newline + 1;
        totalLines++;
        if (totalLines >= offset && endLine === totalLines - 1 && (limit === undefined || totalLines < offset + limit)) {
          const bytes = Buffer.byteLength(text.slice(cursor, next));
          if (pageBytes + bytes <= 12_000) {
            if (start < 0) start = cursor;
            end = next;
            endLine = totalLines;
            pageBytes += bytes;
          }
        }
        cursor = next;
      }
      if (offset > Math.max(1, totalLines))
        throw new Error(`offset is past EOF (${totalLines} lines); use an offset from 1 to ${Math.max(1, totalLines)}`);
      if (text.length > 0 && start < 0)
        throw new Error(`line ${offset} exceeds 12 KB; use host_command_propose with sed -n '${offset}p' to inspect that line`);
      const selected = start < 0 ? "" : text.slice(start, end);
      return {
        path: canonical,
        text: sensitiveText(selected) ? "[REDACTED: sensitive text]" : selected,
        startLine: offset,
        endLine,
        totalLines,
        nextOffset: endLine < totalLines ? endLine + 1 : null,
        untrusted: true,
      };
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
            const kb = /^\s*(\d+)\s/m.exec(result.stdout)?.[1];
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
  private validateCommandInput(input: HostCommand) {
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
          typeof a !== "string" || a.length > 4096 || /[\0\r\n]/.test(a) ||
          (/[;|&<>`$]/.test(a) && !inspectionShape(input.program, input.args)),
      ) ||
      input.args.join("").length > 12_000
    )
      throw new Error("invalid arguments or shell metacharacter snippet; use program + args argv without a shell, one command per call");
  }
  validateCommand(input: HostCommand): HostCommand {
    this.validateCommandInput(input);
    const cwd = this.resolve(input.cwd, false, true);
    if (!statSync(cwd).isDirectory())
      throw new Error("cwd must be a directory");
    const program = inspectionProgram(input.program);
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
      throw new Error("absolute allowlisted executable required; use a read-only program name or its absolute path plus args argv without a shell, one command per call");
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
        "privileged, remote, shell or interpreter program refused; use program + args argv without a shell, one command per call",
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
  private async prepareRemote(input: HostCommand, shape: InspectionShape, deadline: number): Promise<HostCommand | null> {
    let base = input.cwd;
    for (const index of shape.paths) base = input.args[index]!;
    const repository = this.gitDirectory(base);
    const prefix = repository ? ["--git-dir", repository.directory] : [];
    const remote = input.args.at(-1)!;
    const resolveRemote = (name: string) => this.run("/usr/bin/git",
      [...prefix, "ls-remote", "--get-url", name],
      Math.min(6000, Math.max(1, deadline - Date.now())), 4096, base, true);
    const resolved = await resolveRemote(remote);
    if (resolved.exitCode !== 0 || resolved.timedOut || resolved.truncated) return null;
    const destination = resolved.stdout.trim();
    let url: URL;
    try {
      url = new URL(destination);
      if (url.protocol !== "https:" || url.username || url.password || url.hash ||
          isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) return null;
      if (remote.startsWith("https://") && destination !== remote) return null;
      await assertFetchableUrl(destination, "Git remote");
    } catch { return null; }
    // Git applies insteadOf and named-remote configuration again when given a URL.
    // Require a fixed point so the checked destination is the one Git will contact.
    const stable = await resolveRemote(destination);
    if (stable.exitCode !== 0 || stable.timedOut || stable.truncated ||
        stable.stdout.trim() !== destination) return null;
    // Repository HTTP routing must not bypass the destination's DNS/public-host check.
    const routing = await this.run("/usr/bin/git",
      [...prefix, "config", "--includes", "--name-only", "--get-regexp", "^(http\\..*(proxy|curloptresolve)|remote\\..*\\.proxy)$"],
      Math.min(6000, Math.max(1, deadline - Date.now())), 4096, base, true);
    if (routing.timedOut || routing.truncated || routing.exitCode !== 1 || Date.now() >= deadline) return null;
    return { ...input, args: [...input.args.slice(0, -1), destination] };
  }
  /** A refusal is not execution: the caller may offer the ordinary approval path. */
  async inspect(input: HostCommand) {
    this.validateCommandInput(input);
    input = { ...input, program: inspectionProgram(input.program) };
    const shape = inspectionShape(input.program, input.args);
    if (!shape) return null;
    const deadline = Date.now() + 90_000;
    let checked: HostCommand;
    try { checked = this.prepareInspection(input, shape); }
    catch { return null; }
    if (shape.gitRemote) {
      const remote = await this.prepareRemote(checked, shape, deadline);
      if (!remote) return null;
      checked = remote;
    }
    return this.runCommand(checked, shape, deadline);
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
    return this.runCommand(checked, null);
  }
  private async runCommand(checked: HostCommand, inspection: InspectionShape | null, deadline = Date.now() + 90_000) {
    let args = checked.args;
    if (inspection) {
      args = [...args];
      const ignored = [...Object.keys(secretNames),
        ".env*", "*secret*", "*credential*", "*api_key*", "*apikey*", "*.pem", "*.key", "*.p12", "*.sqlite", "*.db", "*-wal", "*-shm", "*-journal"];
      const privatePaths = [...this.statePaths(), ...this.homePrivatePaths()];
      if (checked.program === "/usr/bin/find") {
        const end = inspection.findRootEnd!;
        const predicates = args.slice(end);
        args = ["-P", ...args.slice(0, end).filter((a) => a !== "-P"), "(",
          ...ignored.flatMap((name, index) => [...(index ? ["-o"] : []), "-iname", name]),
          ...privatePaths.flatMap((path) => ["-o", "-ipath", path.replace(/[\\*?[\]]/g, "\\$&")]),
          ")", "-prune", "-o", "(", ...predicates, ...(!inspection.findAction ? ["-print"] : []), ")"];
      } else if (checked.program === "/usr/bin/grep") {
        const projectOnly = inspection.paths.every((index) => this.roots.some((root) => {
          try { return inside(args[index]!, realpathSync(root)); } catch { return false; }
        }));
        const privateNamesToSkip = Object.keys(privateNames).filter((name) =>
          !projectOnly || !["data", "store", "stores", "archive", "archives"].includes(name));
        const patterns = [...ignored, ...privateNamesToSkip].map((name) =>
          name.replace(/[a-z]/gi, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`));
        const guards = [
          "-p", "-D", "skip", "-I",
          ...patterns.flatMap((pattern) => [`--exclude=${pattern}`, `--exclude=*/${pattern}`,
            `--exclude-dir=${pattern}`, `--exclude-dir=*/${pattern}`]),
          ...privatePaths.map((path) => `--exclude-dir=${path.replace(/[\\*?[\]]/g, "\\$&")}`),
        ];
        // User includes must precede mandatory exclusions; -- still protects literal operands.
        let separator = args.length;
        for (let i = 0; i < args.length; i++) {
          if (["-e", "-C", "-A", "-B", "-m"].includes(args[i]!)) { i++; continue; }
          if (args[i] === "--") { separator = i; break; }
        }
        args.splice(separator, 0, ...guards);
      } else if (checked.program === "/usr/bin/du") {
        args.unshift("-P", ...ignored.flatMap((name) => [
          "-I", name.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`),
        ]));
      } else if (checked.program === "/bin/ps" && args.length === 0) {
        args = ["-axo", "pid,ppid,pcpu,pmem,comm"];
      } else if (inspection.git) {
        let base = checked.cwd;
        for (const index of inspection.paths) base = args[index]!;
        const repository = this.gitDirectory(base);
        const prefix = repository ? ["--git-dir", repository.directory,
          "-c", repository.worktree ? `core.worktree=${repository.worktree}` : "core.bare=true"] : [];
        // Even status/diff can run arbitrary clean/process filters through attributes.
        // Ask Git for config key names only, then disable every configured filter driver.
        const config = await this.run("/usr/bin/git",
          [...prefix, "config", "--includes", "--null", "--name-only", "--get-regexp", "^filter\\."],
          Math.min(6000, Math.max(1, deadline - Date.now())), 24_000, base, true);
        if (config.timedOut || config.truncated || (config.exitCode !== 0 && config.exitCode !== 1))
          throw new NoEffect("could not safely inspect Git filter configuration");
        const drivers = new Set<string>();
        for (const key of config.stdout.split("\0").filter(Boolean)) {
          const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key);
          if (!match || /[\0\r\n=]/.test(match[1]!))
            throw new NoEffect("unsupported Git filter configuration");
          drivers.add(match[1]!);
        }
        args.unshift(...prefix, ...[...drivers].flatMap((driver) =>
          ["clean", "smudge", "process", "required"].flatMap((key) =>
            ["-c", `filter.${driver}.${key}=${key === "required" ? "false" : ""}`])));
        const sub = args.find((arg) => ["log", "show", "diff", "status"].includes(arg));
        if (sub) args.splice(args.indexOf(sub) + 1, 0,
          ...(sub === "status" ? ["--ignore-submodules=all"] : ["--no-ext-diff", "--no-textconv", "--ignore-submodules=all"]));
      }
    }
    const result = await this.run(
      checked.program,
      args,
      Math.max(1, deadline - Date.now()),
      24_000,
      checked.cwd,
      inspection !== null,
    );
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      output: redactHostText(checked.program === "/bin/launchctl" && checked.args[0] === "print"
        ? result.output.split("\n").filter((line) =>
          /^\s*(?:pid|state|type|runs|last exit code|last terminating signal|active count)\s*=/.test(line)).join("\n")
        : result.output),
    };
  }
}
