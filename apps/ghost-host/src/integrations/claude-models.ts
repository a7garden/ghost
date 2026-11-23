import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeModels } from "@ghost/contract";

const TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 40;
const READ_BYTES = 256 * 1024;
const SESSION_FILES = new Bun.Glob("**/*.jsonl");
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MODEL_ID = /^(?:(?:[a-z0-9-]+\.)?anthropic\.)?claude-[a-z0-9][a-z0-9.-]*(?::\d+)?(?:\[1m\])?$/i;

// https://code.claude.com/docs/en/model-config#model-aliases
const ALIASES: readonly [selector: string, name: string][] = [
  ["default", "Default"],
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
  ["opusplan", "Opus for planning, Sonnet for coding"],
  ["sonnet[1m]", "Sonnet (1M context)"],
  ["opus[1m]", "Opus (1M context)"],
];

type Session = { path: string; mtime: number };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function recentSessions(root: string): Promise<Session[]> {
  if (await realpath(root).catch(() => null) !== root) return [];
  const recent: Session[] = [];
  try {
    for await (const path of SESSION_FILES.scan({ cwd: root, absolute: true, followSymlinks: false })) {
      const stat = await lstat(path).catch(() => null);
      if (!stat?.isFile()) continue;
      const mtime = stat.mtimeMs;
      if (recent.length === MAX_SESSIONS && mtime < recent.at(-1)!.mtime) continue;
      const i = recent.findIndex((file) => mtime > file.mtime || (mtime === file.mtime && path < file.path));
      if (i < 0) {
        if (recent.length < MAX_SESSIONS) recent.push({ path, mtime });
      } else {
        if (recent.length === MAX_SESSIONS) recent.pop();
        recent.splice(i, 0, { path, mtime });
      }
    }
  } catch { /* A project directory may be removed during the scan. */ }
  return recent;
}

async function scanSession({ path, mtime }: Session, root: string, seen: Map<string, number>): Promise<void> {
  try {
    if (await realpath(path) !== path || !path.startsWith(`${root}/`)) return;
    const file = await open(path, OPEN_FLAGS);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size === 0) return;
      const start = Math.max(0, stat.size - READ_BYTES);
      // One byte of lookbehind tells whether the first line in the window is complete.
      const offset = Math.max(0, start - 1);
      const buffer = Buffer.allocUnsafe(stat.size - offset);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      const data = buffer.subarray(0, bytesRead);
      const first = start ? data.indexOf(10) + 1 : 0;
      if (start && first === 0) return;
      for (let end = data.length; end > first;) {
        const lf = data.lastIndexOf(10, end - 1);
        const from = Math.max(first, lf + 1);
        // Ignore large tool/user records without decoding them.
        const line = data.subarray(from, end);
        end = from - 1;
        if (!line.includes('"model"')) continue;
        let entry: unknown;
        try { entry = JSON.parse(line.toString("utf8")); } catch { continue; }
        if (!object(entry) || entry.type !== "assistant" || !object(entry.message)) continue;
        const { model } = entry.message;
        if (typeof model !== "string" || model.length > 256 || !MODEL_ID.test(model)) continue;
        const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        const at = Number.isFinite(timestamp) ? timestamp : mtime;
        if (at > (seen.get(model) ?? -Infinity)) seen.set(model, at);
      }
    } finally { await file.close(); }
  } catch { /* A removed or unreadable transcript does not hide other sessions. */ }
}

async function configuredModel(path: string): Promise<string | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > READ_BYTES) return null;
      const buffer = Buffer.allocUnsafe(stat.size);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const settings: unknown = JSON.parse(buffer.toString("utf8", 0, bytesRead));
      const model = object(settings) && typeof settings.model === "string" ? settings.model.trim() : "";
      return model && model.length <= 512 && model !== "<synthetic>" && !/[\s\p{C}]/u.test(model) ? model : null;
    } finally { await file.close(); }
  } catch { return null; }
}

function displayName(selector: string): string {
  const match = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(selector);
  if (!match) return selector;
  const [, family, major, minor, extended] = match;
  return `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor === undefined ? "" : `.${minor}`}${extended ? " (1M context)" : ""}`;
}

export class ClaudeModelCatalog {
  private cache: { expires: number; value: ClaudeModels } | undefined;
  private pending: Promise<ClaudeModels> | undefined;

  constructor(private readonly home = homedir(), private readonly now = Date.now) {}

  async list(): Promise<ClaudeModels> {
    if (this.cache && this.now() < this.cache.expires) return this.cache.value;
    return this.pending ??= this.load().finally(() => { this.pending = undefined; });
  }

  private async load(): Promise<ClaudeModels> {
    const home = await realpath(this.home).catch(() => this.home);
    const claude = join(home, ".claude");
    const root = join(claude, "projects");
    const [sessions, configured] = await Promise.all([recentSessions(root), configuredModel(join(claude, "settings.json"))]);
    const used = new Map<string, number>();
    for (const session of sessions) await scanSession(session, root, used);
    const options = new Map(ALIASES);
    for (const [selector] of [...used].sort((a, b) => b[1] - a[1])) {
      if (!options.has(selector)) options.set(selector, displayName(selector));
    }
    if (configured !== null && !options.has(configured)) options.set(configured, displayName(configured));
    const value: ClaudeModels = { models: [...options].map(([selector, name]) => ({ selector, name, provider: "Claude" })) };
    this.cache = { expires: this.now() + TTL_MS, value };
    return value;
  }
}
