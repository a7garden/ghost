import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { ORCHESTRATION_NAME_PATTERN, SESSION_MODEL_ROLE, type OrchestrationConfig, type OrchestrationModelRef, type OrchestrationView } from "@ghost/contract";
import { invalid } from "../core/errors.ts";
export const NAME = new RegExp(ORCHESTRATION_NAME_PATTERN);
export const asMap = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const unknownKeys = (value: Record<string, unknown>, except: string[], prefix: string) =>
  Object.keys(value).filter(key => !except.includes(key)).map(key => prefix + key);

/** Harness roots resolve per call so the import surface follows HOME, including in tests with fixture roots. */
export const homePath = (...segments: string[]) => join(process.env.HOME ?? homedir(), ...segments);

export function parseYaml(raw: string, source: string): Record<string, unknown> {
  try {
    const doc = parseDocument(raw, { schema: "core", uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) throw new Error();
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return asMap(value);
  } catch { throw invalid(`YAML cannot be read: ${source}`); }
}

export function readRegular(path: string, maxBytes: number): string {
  const fd = openSync(realpathSync(path), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error();
    const data = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return data.toString("utf8", 0, offset);
  } finally { closeSync(fd); }
}

/** Symlink-safe regular-file probe that never reads contents; used for source availability. */
export function isRegularFile(path: string): boolean {
  try {
    const fd = openSync(realpathSync(path), constants.O_RDONLY | constants.O_NONBLOCK);
    closeSync(fd);
    return true;
  } catch { return false; }
}

export function listFiles(directory: string, suffix: string): string[] {
  try { return readdirSync(directory).filter(filename => filename.endsWith(suffix)).sort(); } catch { return []; }
}

const EFFORTS = { minimal: "off", low: "low", medium: "medium", high: "high" } as const;

/**
 * Claude Code and Codex name models without a Ghost provider. Resolve the id against this device's
 * configured models and expose it as a role named after the model; unresolvable ids stay on the
 * session role and are reported as unmappable.
 */
export function roleForModel(config: OrchestrationConfig, inventory: Omit<OrchestrationView, "config">, model: string, effort: string | undefined, path: string, unmappable: string[]): string {
  const row = inventory.models.find(candidate => candidate.model === model);
  if (!row) { unmappable.push(`${path} (${model})`); return SESSION_MODEL_ROLE; }
  let thinking: OrchestrationModelRef["thinking"] = null;
  if (effort !== undefined) {
    const mapped = EFFORTS[effort as keyof typeof EFFORTS];
    if (!mapped || !row.thinking.includes(mapped)) unmappable.push(`${path}.reasoning (${effort})`);
    else thinking = mapped;
  }
  const base = model.replaceAll(/[^a-zA-Z0-9._-]/g, "-").replace(/^[._-]+/, "").slice(0, 80);
  for (let suffix = 1; suffix < 100; suffix++) {
    const candidate = suffix === 1 ? base : `${base.slice(0, 78)}-${suffix}`;
    if (candidate === SESSION_MODEL_ROLE || !NAME.test(candidate)) continue;
    const existing = config.modelRoles[candidate];
    if (existing === undefined) {
      if (Object.keys(config.modelRoles).length >= 128) break;
      config.modelRoles[candidate] = { provider: row.provider, model: row.model, thinking };
      return candidate;
    }
    if (existing.provider === row.provider && existing.model === row.model) {
      if (thinking !== null && existing.thinking !== thinking) unmappable.push(`${path}.reasoning (${effort})`);
      return candidate;
    }
  }
  unmappable.push(`${path} (${model})`);
  return SESSION_MODEL_ROLE;
}
