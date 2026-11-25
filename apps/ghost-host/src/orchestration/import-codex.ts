import { join } from "node:path";
import {
  ORCHESTRATION_MAX_CONCURRENCY, ORCHESTRATION_READ_TOOLS, ORCHESTRATION_TOOLS, SESSION_MODEL_ROLE, orchestrationIssues,
  type OrchestrationImportPreview, type OrchestrationView,
} from "@ghost/contract";
import { invalid } from "../core/errors.ts";
import { defaultOrchestration } from "./config.ts";
import { NAME, asMap, homePath, isRegularFile, listFiles, readRegular, roleForModel, unknownKeys } from "./harness.ts";

const SANDBOXES: Record<string, boolean> = { "read-only": false, "workspace-write": true, "danger-full-access": true };

function toml(raw: string): Record<string, unknown> | null {
  try { return asMap(Bun.TOML.parse(raw)); } catch { return null; }
}

export function codexSource(directory = homePath(".codex")): { available: boolean; agents: number } {
  const agents = listFiles(join(directory, "agents"), ".toml").length + listFiles(join(directory, "prompts"), ".md").length;
  return { available: isRegularFile(join(directory, "config.toml")) || agents > 0, agents };
}

/** Read ~/.codex config.toml, subagent definitions and prompts; auth.json and session state are never touched. */
export function previewCodex(inventory: Omit<OrchestrationView, "config">, directory = homePath(".codex")): OrchestrationImportPreview {
  const config = defaultOrchestration();
  const unmappable: string[] = [];
  const effort = (value: unknown, path: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") { unmappable.push(path); return undefined; }
    return value;
  };
  let source: Record<string, unknown> = {};
  const configPath = join(directory, "config.toml");
  if (isRegularFile(configPath)) {
    const parsed = toml(readRegular(configPath, 512_000));
    if (!parsed) throw invalid("codex config.toml을 해석할 수 없습니다");
    source = parsed;
  } else if (codexSource(directory).agents === 0) throw invalid("Codex 설정을 찾을 수 없습니다");
  unmappable.push(...unknownKeys(source, ["model", "model_reasoning_effort", "profiles", "agents"], ""));
  if (source.model !== undefined) {
    if (typeof source.model !== "string") unmappable.push("model");
    else roleForModel(config, inventory, source.model, effort(source.model_reasoning_effort, "model_reasoning_effort"), "model", unmappable);
  }
  for (const [profile, value] of Object.entries(asMap(source.profiles))) {
    const path = `profiles.${profile}`;
    const table = asMap(value);
    unmappable.push(...unknownKeys(table, ["model", "model_reasoning_effort"], `${path}.`));
    if (typeof table.model !== "string") { unmappable.push(path); continue; }
    roleForModel(config, inventory, table.model, effort(table.model_reasoning_effort, `${path}.model_reasoning_effort`), `${path}.model`, unmappable);
  }
  const agentsTable = asMap(source.agents);
  unmappable.push(...unknownKeys(agentsTable, ["enabled", "max_concurrent_threads_per_session", "default_subagent_model", "default_subagent_reasoning_effort"], "agents."));
  const concurrency = agentsTable.max_concurrent_threads_per_session;
  if (concurrency !== undefined) {
    if (typeof concurrency === "number" && Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= ORCHESTRATION_MAX_CONCURRENCY) config.limits.maxConcurrency = concurrency;
    else unmappable.push("agents.max_concurrent_threads_per_session");
  }
  if (agentsTable.enabled === false) unmappable.push("agents.enabled");
  const subagent = agentsTable.default_subagent_model;
  if (subagent !== undefined) {
    if (typeof subagent !== "string") unmappable.push("agents.default_subagent_model");
    else roleForModel(config, inventory, subagent, effort(agentsTable.default_subagent_reasoning_effort, "agents.default_subagent_reasoning_effort"), "agents.default_subagent_model", unmappable);
  }
  const imported = new Set<string>();
  for (const filename of listFiles(join(directory, "agents"), ".toml")) {
    const path = `agents/${filename}`;
    try {
      const table = toml(readRegular(join(directory, "agents", filename), 48_000));
      if (!table) throw new Error();
      const { name, description, model, model_reasoning_effort, sandbox_mode, developer_instructions } = table;
      const instructions = typeof developer_instructions === "string" ? developer_instructions.trim() : "";
      if (typeof name !== "string" || !NAME.test(name) || imported.has(name) || typeof description !== "string" || description.length > 400 || instructions.length > 40_000) throw new Error();
      const existing = config.agents.findIndex(agent => agent.name === name);
      if (existing < 0 && config.agents.length >= 128) throw new Error();
      const writes = typeof sandbox_mode === "string" && SANDBOXES[sandbox_mode] === true;
      if (sandbox_mode === undefined) unmappable.push(`${path}.sandbox_mode (기본 권한)`);
      else if (typeof sandbox_mode !== "string" || SANDBOXES[sandbox_mode] === undefined) unmappable.push(`${path}.sandbox_mode (${String(sandbox_mode)})`);
      else if (sandbox_mode === "danger-full-access") unmappable.push(`${path}.sandbox_mode (danger-full-access)`);
      const agent = {
        name, description, instructions, readOnly: !writes, tools: [...(writes ? ORCHESTRATION_TOOLS : ORCHESTRATION_READ_TOOLS)],
        modelRole: typeof model === "string" ? roleForModel(config, inventory, model, effort(model_reasoning_effort, `${path}.model_reasoning_effort`), `${path}.model`, unmappable)
          : model === undefined ? SESSION_MODEL_ROLE : (unmappable.push(`${path}.model`), SESSION_MODEL_ROLE),
        canDelegateTo: [] as string[],
      };
      if (existing >= 0) config.agents[existing] = agent;
      else config.agents.push(agent);
      imported.add(name);
      unmappable.push(...unknownKeys(table, ["name", "description", "model", "model_reasoning_effort", "sandbox_mode", "developer_instructions"], `${path}.`));
    } catch { unmappable.push(path); }
  }
  for (const filename of listFiles(join(directory, "prompts"), ".md")) {
    const path = `prompts/${filename}`;
    try {
      const instructions = readRegular(join(directory, "prompts", filename), 48_000).trim();
      const name = filename.slice(0, -3);
      if (!instructions || !NAME.test(name) || imported.has(name) || config.agents.length >= 128) throw new Error();
      const heading = instructions.split(/\r?\n/, 1)[0]!.replace(/^#+\s*/, "").trim();
      if (heading.length > 400) unmappable.push(`${path}.description`);
      const existing = config.agents.findIndex(agent => agent.name === name);
      const agent = { name, description: (heading || name).slice(0, 400), instructions, readOnly: true, tools: [...ORCHESTRATION_READ_TOOLS], modelRole: SESSION_MODEL_ROLE, canDelegateTo: [] as string[] };
      if (existing >= 0) config.agents[existing] = agent;
      else config.agents.push(agent);
      imported.add(name);
    } catch { unmappable.push(path); }
  }
  if (isRegularFile(join(directory, "AGENTS.md"))) unmappable.push("AGENTS.md");
  return { config, unmappable, issues: orchestrationIssues(config, inventory) };
}
