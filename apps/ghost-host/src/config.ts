import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Everything the process reads at startup. Nothing else reads the environment. */
export interface Config {
  /** State root: ledger.db, pi.db, artifacts/, secrets/, sandboxes/, host.json. */
  root: string;
  /** Loopback bind for the owner API and UI. */
  host: string;
  port: number;
  /** Origin paired devices use (a TLS reverse proxy in front of `port`); null = the bound loopback address. */
  publicOrigin: string | null;
  /** Built web UI served at `/`; null serves no UI. */
  uiDir: string | null;
  sandbox:
    | { kind: "local" }
    | {
        kind: "apple-container";
        /** `container` CLI path. */
        cli: string;
        image: string;
      };
  memory: null | {
    /** oxibrain executable. */
    executable: string;
    dir: string;
    token: string;
    /** ghostId → oxibrain space id. */
    spaces: Record<string, string>;
  };
  /** Optional owner-enabled Mac capability; distinct from the API bind `host`. */
  mac?: null | { roots: string[]; watch: { ghostId: string; intervalMinutes?: number } | null };
  voice: null | { mediaOrigin: string; controlToken: string };
  apns: null | { teamId: string; keyId: string; keyPath: string; topic: string };
  /** Owner skill folders a Ghost's `skills` names point into; null serves no skills. */
  skills: null | { roots: string[] };
  /** Read-only web research through the installed `agent-reach` CLI; null turns it off. */
  reach: null | { executable: string };
  /** Host-owned browser sessions behind the public-internet egress proxy. */
  browser: null | { executable: string; chrome?: string; idleTimeoutMinutes?: number; obscura?: { executable: string; loginOrigins?: string[] } };
  /**
   * PC control: the signed Ghost Control bundle (the macOS privacy identity) and the two runtimes it runs.
   * A release finds its own copies beside the `ghost` executable; `"desktop": null` turns it off.
   */
  desktop?: null | DesktopConfig;
}

export interface DesktopConfig {
  /** `Ghost Control.app` bundle path. */
  control: string;
  agentDesktop: string;
  geist: string;
}

const expandHome = (path: string) => path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

/** The copies a release ships next to its `ghost` executable, when all three are there. */
function bundledDesktop(executable: string): DesktopConfig | null {
  const dir = dirname(executable);
  const found = { control: join(dir, "Ghost Control.app"), agentDesktop: join(dir, "agent-desktop"), geist: join(dir, "geist") };
  return existsSync(join(found.control, "Contents/MacOS/ghost-control")) && existsSync(found.agentDesktop) && existsSync(found.geist) ? found : null;
}

export const DEFAULT_ROOT = join(homedir(), "Library", "Application Support", "Ghost");
export const DEFAULT_PORT = 62062;

/**
 * `<root>/config.json` (optional) overlaid by `GHOST_*` environment variables.
 * Unknown keys are rejected so a typo does not silently disable a capability.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env, rootOverride?: string): Config {
  const root = resolve(rootOverride ?? env.GHOST_ROOT ?? DEFAULT_ROOT);
  const path = join(root, "config.json");
  const file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<Config>) : {};
  const allowed = new Set(["host", "port", "publicOrigin", "uiDir", "sandbox", "memory", "voice", "apns", "skills", "mac", "reach", "browser", "desktop"]);
  for (const key of Object.keys(file)) if (!allowed.has(key)) throw new Error(`config.json: unknown key ${key}`);
  const port = Number(env.GHOST_PORT ?? file.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("GHOST_PORT must be a TCP port (0 picks a free one)");
  const host = env.GHOST_HOST ?? file.host ?? "127.0.0.1";
  if (file.skills !== undefined && file.skills !== null && !(Array.isArray(file.skills.roots) && file.skills.roots.length > 0 && file.skills.roots.every((path) => typeof path === "string" && path.length > 0))) {
    throw new Error("config.json: skills.roots must be a non-empty list of paths");
  }
  if (file.mac != null) {
    if (typeof file.mac !== "object" || (file.mac.roots !== undefined && (!Array.isArray(file.mac.roots) || file.mac.roots.some((p) => typeof p !== "string" || !p.trim())))) throw new Error("config.json: mac.roots must be paths");
    const watch = file.mac.watch;
    if (watch != null && (typeof watch !== "object" || typeof watch.ghostId !== "string" || !watch.ghostId.trim() || (watch.intervalMinutes !== undefined && (!Number.isFinite(watch.intervalMinutes) || watch.intervalMinutes <= 0 || watch.intervalMinutes > 1440)))) throw new Error("config.json: invalid mac.watch");
  }
  if (file.browser != null) {
    const b = file.browser;
    if (typeof b !== "object" || typeof b.executable !== "string" || !b.executable.trim() ||
      (b.chrome !== undefined && (typeof b.chrome !== "string" || !b.chrome.trim())) ||
      (b.idleTimeoutMinutes !== undefined && (!Number.isFinite(b.idleTimeoutMinutes) || b.idleTimeoutMinutes <= 0 || b.idleTimeoutMinutes > 1440))) {
      throw new Error("config.json: invalid browser configuration");
    }
    if (b.obscura !== undefined) {
      const engine = b.obscura;
      if (!engine || typeof engine.executable !== "string" || !engine.executable.trim() ||
        (engine.loginOrigins !== undefined && (!Array.isArray(engine.loginOrigins) || !engine.loginOrigins.every((origin) => {
          try { return typeof origin === "string" && origin.startsWith("https://") && !origin.includes("*") && new URL(origin).origin === origin; }
          catch { return false; }
        })))) throw new Error("config.json: invalid Obscura executable or HTTPS login origins");
    }
  }
  let desktop: DesktopConfig | null;
  if (file.desktop === undefined) desktop = bundledDesktop(process.execPath);
  else if (file.desktop === null) desktop = null;
  else {
    const d = file.desktop;
    const paths = d && typeof d === "object" ? [d.control, d.agentDesktop, d.geist] : [];
    if (paths.length !== 3 || Object.keys(d!).length !== 3 || !paths.every((path) => typeof path === "string" && isAbsolute(expandHome(path)))) {
      throw new Error("config.json: desktop needs absolute control, agentDesktop and geist paths");
    }
    desktop = { control: expandHome(d!.control), agentDesktop: expandHome(d!.agentDesktop), geist: expandHome(d!.geist) };
  }
  return {
    root,
    host,
    port,
    publicOrigin: env.GHOST_PUBLIC_ORIGIN ?? file.publicOrigin ?? null,
    uiDir: env.GHOST_UI_DIR ?? file.uiDir ?? null,
    sandbox: file.sandbox ?? { kind: "local" },
    memory: file.memory ?? null,
    mac: file.mac ? { roots: (file.mac.roots ?? ["~/Workspace/Projects"]).map(expandHome), watch: file.mac.watch ?? null } : null,
    voice: file.voice ?? null,
    apns: file.apns ?? null,
    skills: file.skills ?? null,
    reach: file.reach ?? null,
    browser: file.browser ?? null,
    desktop,
  };
}
