import {
  OrchestrationConfig, SESSION_MODEL_ROLE, ORCHESTRATION_READ_TOOLS, ORCHESTRATION_TOOLS, orchestrationIssues, parse,
  type OrchestrationAgent, type OrchestrationModelRef, type CodingSession, type OrchestrationView,
} from "@ghost/contract";
import { invalid } from "../core/errors.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { CodingModels } from "../coding/models.ts";
import type { Secrets } from "../core/ports.ts";

const KEY = "orchestration.config";
const SESSION_OFF = "orchestration.session-off:";

export function defaultOrchestration(): OrchestrationConfig {
  const agent = (name: string, description: string, instructions: string, readOnly: boolean): OrchestrationAgent => ({
    name, description, instructions, readOnly, modelRole: SESSION_MODEL_ROLE, canDelegateTo: [],
    tools: [...(readOnly ? ORCHESTRATION_READ_TOOLS : ORCHESTRATION_TOOLS)],
  });
  return {
    enabled: true, modelRoles: { [SESSION_MODEL_ROLE]: { provider: null, model: null, thinking: null } },
    fallbackChains: {}, limits: { maxConcurrency: 4, maxDepth: 1 }, positions: { agents: {}, roles: {} },
    agents: [
      agent("scout", "Read and search the repository", "Read files and search the repository without changing it. Return a compact map of the relevant code, paths and evidence.", true),
      agent("worker", "Implement a bounded change in this worktree", "Implement only the requested change in this worktree. Preserve unrelated edits. Report what changed and any checks you actually ran.", false),
      agent("reviewer", "Review a diff or files without writing", "Review the requested diff or files read-only. Report actionable issues with severity, evidence, and file locations; distinguish observations from inference.", true),
    ],
  };
}

type Settings = Pick<Ledger, "setting" | "putSetting">;
export class OrchestrationStore {
  private config: OrchestrationConfig;
  private readonly listeners = new Set<(config: OrchestrationConfig) => void>();
  constructor(private readonly ledger: Settings) { this.config = ledger.setting(KEY, defaultOrchestration()); }
  get(): OrchestrationConfig { return this.config; }
  set(input: unknown): OrchestrationConfig {
    const config = parse(OrchestrationConfig, input);
    const issue = orchestrationIssues(config)[0];
    if (issue) throw invalid(`Invalid orchestration: ${issue.name} (${issue.code}${issue.ref ? `: ${issue.ref}` : ""})`);
    this.ledger.putSetting(KEY, config);
    this.config = config;
    for (const listener of this.listeners) listener(config);
    return config;
  }
  subscribe(listener: (config: OrchestrationConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  sessionEnabled(id: string): boolean { return !this.ledger.setting(SESSION_OFF + id, false); }
  setSessionEnabled(id: string, enabled: boolean): void { this.ledger.putSetting(SESSION_OFF + id, !enabled); }
}

// The API, Ghost conversations and open coding sessions share the committed settings.
const stores = new WeakMap<Settings, OrchestrationStore>();
export function orchestrationStore(ledger: Settings): OrchestrationStore {
  let store = stores.get(ledger);
  if (!store) { store = new OrchestrationStore(ledger); stores.set(ledger, store); }
  return store;
}

export function orchestrationInventory(ledger: Pick<Ledger, "providers">, secrets: Secrets, models: CodingModels): Omit<OrchestrationView, "config"> {
  return { providersWithCredentials: ledger.providers().filter(row => secrets.credential(row.id)).map(row => row.id), models: models.list() };
}

export function modelChain(config: OrchestrationConfig, role: string, parent: Pick<CodingSession, "model" | "thinking">): OrchestrationModelRef[] {
  const resolve = (name: string): OrchestrationModelRef | undefined => {
    if (!Object.hasOwn(config.modelRoles, name)) return;
    const ref = config.modelRoles[name]!;
    return ref.provider === null ? { ...parent.model, thinking: parent.thinking } : ref;
  };
  const primary = resolve(role);
  if (!primary) throw invalid(`unknown model role: ${role}`);
  const seen = new Set([JSON.stringify([primary.provider, primary.model, primary.thinking])]);
  const result = [primary];
  for (const entry of config.fallbackChains[role] ?? []) {
    const ref = "role" in entry ? resolve(entry.role) : entry;
    if (!ref) continue;
    const key = JSON.stringify([ref.provider, ref.model, ref.thinking]);
    if (!seen.has(key)) { result.push(ref); seen.add(key); }
  }
  return result;
}
