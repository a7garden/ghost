import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import {
  ORCHESTRATION_MAX_CONCURRENCY, ORCHESTRATION_MAX_DEPTH, ORCHESTRATION_NAME_PATTERN,
  ORCHESTRATION_READ_TOOLS, ORCHESTRATION_TOOLS, SESSION_MODEL_ROLE, orchestrationIssues,
  type OrchestrationFallback, type OrchestrationImportPreview, type OrchestrationModelRef, type OrchestrationView,
} from "@ghost/contract";
import { invalid } from "../core/errors.ts";
import { defaultOrchestration } from "./config.ts";

const NAME = new RegExp(ORCHESTRATION_NAME_PATTERN);
const asMap = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const keys = (value: Record<string, unknown>, except: string[], prefix: string) => Object.keys(value).filter(key => !except.includes(key)).map(key => prefix + key);

function yaml(raw: string, source: string): Record<string, unknown> {
  try {
    const doc = parseDocument(raw, { schema: "core", uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) throw new Error();
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return asMap(value);
  } catch { throw invalid(`omp YAML cannot be read: ${source}`); }
}

function readRegular(path: string, maxBytes: number): string {
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

function modelRef(value: unknown, path: string, unmappable: string[]): OrchestrationModelRef | null {
  const parts = typeof value === "string" ? /^([^/:*\s]{1,120})\/([^:*\s]{1,240})(?::([a-z-]+))?$/.exec(value) : null;
  if (!parts) { unmappable.push(path); return null; }
  const [, provider, model, raw] = parts;
  const thinking = raw === "off" || raw === "low" || raw === "medium" || raw === "high" ? raw : null;
  if (raw && thinking === null) unmappable.push(`${path}.thinking`);
  return { provider: provider!, model: model!, thinking };
}

/** Read only config.yml and registered agent definitions; many owner definitions are symlinks. */
export function previewOmp(inventory: Omit<OrchestrationView, "config">, directory = join(homedir(), ".omp", "agent")): OrchestrationImportPreview {
  let raw: string;
  try { raw = readRegular(join(directory, "config.yml"), 512_000); }
  catch { throw invalid("omp config.yml cannot be read"); }
  const source = yaml(raw, "config.yml");
  const config = defaultOrchestration();
  const unmappable = keys(source, ["modelRoles", "retry", "task"], "");
  const roles = asMap(source.modelRoles), retry = asMap(source.retry), task = asMap(source.task);
  unmappable.push(...keys(retry, ["fallbackChains"], "retry."), ...keys(task, ["maxConcurrency", "maxRecursionDepth", "agentModelOverrides"], "task."));
  if (source.modelRoles !== undefined && source.modelRoles !== roles) unmappable.push("modelRoles");
  for (const [role, value] of Object.entries(roles)) {
    const path = `modelRoles.${role}`;
    if (!NAME.test(role) || role === SESSION_MODEL_ROLE || Object.keys(config.modelRoles).length >= 128) { unmappable.push(path); continue; }
    const model = modelRef(value, path, unmappable);
    if (model) config.modelRoles[role] = model;
  }
  for (const [role, value] of Object.entries(asMap(retry.fallbackChains))) {
    const path = `retry.fallbackChains.${role}`;
    if (!Object.hasOwn(config.modelRoles, role) || !Array.isArray(value)) { unmappable.push(path); continue; }
    config.fallbackChains[role] = value.slice(0, 32).flatMap<OrchestrationFallback>((ref, index) => {
      if (typeof ref === "string" && ref.startsWith("@") && Object.hasOwn(config.modelRoles, ref.slice(1))) return [{ role: ref.slice(1) }];
      const model = modelRef(ref, `${path}[${index}]`, unmappable);
      return model ? [model] : [];
    });
    if (value.length > 32) unmappable.push(`${path}[32…]`);
  }
  function limit(key: string, max: number, fallback: number): number {
    const value = task[key];
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max) return value;
    unmappable.push(`task.${key}`);
    return fallback;
  }
  config.limits.maxConcurrency = limit("maxConcurrency", ORCHESTRATION_MAX_CONCURRENCY, config.limits.maxConcurrency);
  config.limits.maxDepth = limit("maxRecursionDepth", ORCHESTRATION_MAX_DEPTH, config.limits.maxDepth);
  function roleFor(value: unknown, path: string, fallback: string): string {
    if (value === undefined) return fallback;
    if (typeof value === "string" && value.startsWith("@") && Object.hasOwn(config.modelRoles, value.slice(1))) return value.slice(1);
    unmappable.push(path);
    return fallback;
  }
  let filenames: string[];
  try { filenames = readdirSync(join(directory, "agents")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") unmappable.push("agents/");
    filenames = [];
  }
  const imported = new Set<string>();
  for (const filename of filenames.sort()) {
    if (!filename.endsWith(".md")) continue;
    const path = `agents/${filename}`;
    try {
      const contents = readRegular(join(directory, path), 48_000);
      const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(contents);
      if (!match) throw new Error();
      const fields = yaml(match[1]!, path);
      const { name, description, model, readOnly, tools } = fields;
      const instructions = match[2]!.trim();
      if (typeof name !== "string" || !NAME.test(name) || imported.has(name) || typeof description !== "string" || description.length > 400 || instructions.length > 40_000) throw new Error();
      const existing = config.agents.findIndex(agent => agent.name === name);
      if (existing < 0 && config.agents.length >= 128) throw new Error();
      const safeTools = readOnly === false ? ORCHESTRATION_TOOLS : ORCHESTRATION_READ_TOOLS;
      // omp's implicit privileges cannot be inferred. Start imported agents read-only unless explicitly granted.
      if (readOnly === undefined) unmappable.push(`${path}.tools (omp 기본 권한)`);
      const allowed = Array.isArray(tools) ? safeTools.filter(tool => tools.includes(tool)) : [...ORCHESTRATION_READ_TOOLS];
      if (tools !== undefined && (!Array.isArray(tools) || tools.some(tool => !allowed.some(allowedTool => allowedTool === tool)))) unmappable.push(`${path}.tools`);
      const agent = { name, description, instructions, readOnly: readOnly !== false, tools: allowed,
        modelRole: roleFor(model, `${path}.model`, Object.hasOwn(config.modelRoles, "default") ? "default" : SESSION_MODEL_ROLE), canDelegateTo: [] };
      if (existing >= 0) config.agents[existing] = agent;
      else config.agents.push(agent);
      imported.add(name);
      unmappable.push(...keys(fields, ["name", "description", "model", "readOnly", "tools"], `${path}.`));
    } catch { unmappable.push(path); }
  }
  const overrides = asMap(task.agentModelOverrides);
  for (const [name, value] of Object.entries(overrides)) {
    const path = `task.agentModelOverrides.${name}`;
    const agent = config.agents.find(agent => agent.name === name);
    if (!agent) unmappable.push(path);
    else agent.modelRole = roleFor(value, path, agent.modelRole);
  }
  return { config, unmappable, issues: orchestrationIssues(config, inventory) };
}
