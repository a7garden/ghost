import { Type, type Static } from "typebox";
import { CodingThinking } from "./coding-session.ts";

export const SESSION_MODEL_ROLE = "session";
export const ORCHESTRATION_READ_TOOLS = ["read", "grep", "find", "ls"] as const;
export const ORCHESTRATION_TOOLS = [...ORCHESTRATION_READ_TOOLS, "edit", "write", "bash", "ask_owner_choices"] as const;
export const ORCHESTRATION_MAX_CONCURRENCY = 32;
export const ORCHESTRATION_MAX_DEPTH = 8;
export const ORCHESTRATION_NAME_PATTERN = "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$";
export const OrchestrationName = Type.String({ pattern: ORCHESTRATION_NAME_PATTERN });
const Tool = Type.Enum(ORCHESTRATION_TOOLS);
const Position = Type.Object({ x: Type.Number({ minimum: 0, maximum: 20_000 }), y: Type.Number({ minimum: 0, maximum: 20_000 }) }, { additionalProperties: false });
export const OrchestrationModelRef = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 120 }), model: Type.String({ minLength: 1, maxLength: 240 }),
  thinking: Type.Union([CodingThinking, Type.Null()]),
}, { additionalProperties: false });
export type OrchestrationModelRef = Static<typeof OrchestrationModelRef>;
export const OrchestrationModelRole = Type.Union([OrchestrationModelRef, Type.Object({
  provider: Type.Null(), model: Type.Null(), thinking: Type.Null(),
}, { additionalProperties: false })]);
export type OrchestrationModelRole = Static<typeof OrchestrationModelRole>;
export const OrchestrationFallback = Type.Union([OrchestrationModelRef, Type.Object({ role: OrchestrationName }, { additionalProperties: false })]);
export type OrchestrationFallback = Static<typeof OrchestrationFallback>;
export const OrchestrationAgent = Type.Object({
  name: OrchestrationName, description: Type.String({ maxLength: 400 }), modelRole: OrchestrationName,
  tools: Type.Array(Tool, { uniqueItems: true, maxItems: ORCHESTRATION_TOOLS.length }),
  instructions: Type.String({ maxLength: 40_000 }), readOnly: Type.Boolean(),
  canDelegateTo: Type.Array(OrchestrationName, { maxItems: 128, uniqueItems: true }),
}, { additionalProperties: false });
export type OrchestrationAgent = Static<typeof OrchestrationAgent>;
export const OrchestrationConfig = Type.Object({
  enabled: Type.Boolean(),
  modelRoles: Type.Record(OrchestrationName, OrchestrationModelRole, { maxProperties: 128, additionalProperties: false }),
  fallbackChains: Type.Record(OrchestrationName, Type.Array(OrchestrationFallback, { maxItems: 32 }), { maxProperties: 128, additionalProperties: false }),
  limits: Type.Object({
    maxConcurrency: Type.Integer({ minimum: 1, maximum: ORCHESTRATION_MAX_CONCURRENCY }),
    maxDepth: Type.Integer({ minimum: 1, maximum: ORCHESTRATION_MAX_DEPTH }),
  }, { additionalProperties: false }),
  agents: Type.Array(OrchestrationAgent, { maxItems: 128 }),
  positions: Type.Object({
    agents: Type.Record(OrchestrationName, Position, { maxProperties: 128, additionalProperties: false }),
    roles: Type.Record(OrchestrationName, Position, { maxProperties: 128, additionalProperties: false }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type OrchestrationConfig = Static<typeof OrchestrationConfig>;

export type OrchestrationIssue = {
  kind: "agent" | "role";
  name: string;
  code: "duplicate" | "unknown-role" | "unknown-agent" | "cycle" | "depth" | "read-only" | "reserved-role" | "credential" | "model" | "thinking";
  ref?: string;
};

export type OrchestrationView = {
  config: OrchestrationConfig;
  providersWithCredentials: string[];
  models: { provider: string; model: string; name: string; thinking: NonNullable<OrchestrationModelRef["thinking"]>[] }[];
};
export type OrchestrationImportPreview = { config: OrchestrationConfig; unmappable: string[]; issues: OrchestrationIssue[] };

/** Structural problems prevent saving; availability is advisory and may change without a config edit. */
export function orchestrationIssues(config: OrchestrationConfig, inventory?: Omit<OrchestrationView, "config">): OrchestrationIssue[] {
  const issues: OrchestrationIssue[] = [];
  const { modelRoles, fallbackChains, limits } = config;
  const agents = new Map<string, OrchestrationAgent>();
  const readTools = new Set<string>(ORCHESTRATION_READ_TOOLS);
  const available = inventory && new Map(inventory.models.map(row => [`${row.provider}/${row.model}`, row]));
  const credentials = inventory && new Set(inventory.providersWithCredentials);
  function checkModel(name: string, model: OrchestrationModelRef) {
    if (!credentials || !available) return;
    const ref = `${model.provider}/${model.model}`;
    const row = available.get(ref);
    const code = !credentials.has(model.provider) ? "credential" : !row ? "model"
      : model.thinking && !row.thinking.includes(model.thinking) ? "thinking" : null;
    if (code && !issues.some(issue => issue.name === name && issue.ref === ref && issue.code === code)) issues.push({ kind: "role", name, code, ref });
  }
  const inheritance = Object.hasOwn(modelRoles, SESSION_MODEL_ROLE) ? modelRoles[SESSION_MODEL_ROLE] : undefined;
  if (!inheritance || inheritance.provider !== null) issues.push({ kind: "role", name: SESSION_MODEL_ROLE, code: "reserved-role" });
  for (const [name, model] of Object.entries(modelRoles)) {
    if (model.provider !== null) checkModel(name, model);
    else if (name !== SESSION_MODEL_ROLE) issues.push({ kind: "role", name, code: "reserved-role" });
  }
  for (const [name, chain] of Object.entries(fallbackChains)) {
    if (!Object.hasOwn(modelRoles, name)) issues.push({ kind: "role", name, code: "unknown-role", ref: name });
    for (const entry of chain) {
      if ("role" in entry) {
        if (!Object.hasOwn(modelRoles, entry.role)) issues.push({ kind: "role", name, code: "unknown-role", ref: entry.role });
        else {
          const ref = modelRoles[entry.role]!;
          if (ref.provider !== null) checkModel(name, ref);
        }
      } else checkModel(name, entry);
    }
  }
  for (const agent of config.agents) {
    const { name, modelRole, tools, readOnly } = agent;
    if (agents.has(name)) issues.push({ kind: "agent", name, code: "duplicate" });
    agents.set(name, agent);
    if (!Object.hasOwn(modelRoles, modelRole)) issues.push({ kind: "agent", name, code: "unknown-role", ref: modelRole });
    if (readOnly && tools.some(tool => !readTools.has(tool))) issues.push({ kind: "agent", name, code: "read-only" });
  }
  // Find strongly connected components so cross-edges do not hide nodes in a cycle.
  type Visit = { index: number; low: number; stacked: boolean };
  const visits = new Map<string, Visit>();
  const stack: string[] = [];
  const cycles = new Set<string>();
  function visit(name: string): Visit {
    const node = { index: visits.size, low: visits.size, stacked: true };
    visits.set(name, node);
    stack.push(name);
    const children = agents.get(name)!.canDelegateTo;
    for (const child of children) {
      if (!agents.has(child)) { issues.push({ kind: "agent", name, code: "unknown-agent", ref: child }); continue; }
      const prior = visits.get(child);
      if (!prior) node.low = Math.min(node.low, visit(child).low);
      else if (prior.stacked) node.low = Math.min(node.low, prior.index);
    }
    if (node.low === node.index) {
      const cyclic = stack.at(-1) !== name || children.includes(name);
      for (let member = stack.pop()!; ; member = stack.pop()!) {
        visits.get(member)!.stacked = false;
        if (cyclic) cycles.add(member);
        if (member === name) break;
      }
    }
    return node;
  }
  for (const name of agents.keys()) if (!visits.has(name)) visit(name);

  const depths = new Map<string, number>();
  function depth(name: string): number {
    if (cycles.has(name)) return Infinity;
    const cached = depths.get(name);
    if (cached !== undefined) return cached;
    let length = 1;
    for (const child of agents.get(name)!.canDelegateTo) if (agents.has(child)) length = Math.max(length, 1 + depth(child));
    depths.set(name, length);
    return length;
  }
  for (const name of agents.keys()) {
    if (cycles.has(name)) issues.push({ kind: "agent", name, code: "cycle" });
    else if (depth(name) > limits.maxDepth) issues.push({ kind: "agent", name, code: "depth" });
  }
  return issues;
}
