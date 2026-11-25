import { SESSION_MODEL_ROLE, type OrchestrationConfig } from '@ghost/contract';

export type ImportSelection = { agents: string[]; roles: string[]; fallbacks: string[]; limits: boolean };

/** Names the import panel offers for selection; the session role is owned by the draft, never the import. */
export function selectableItems(preview: OrchestrationConfig): Omit<ImportSelection, 'limits'> {
  return {
    agents: preview.agents.map(agent => agent.name),
    roles: Object.keys(preview.modelRoles).filter(name => name !== SESSION_MODEL_ROLE),
    fallbacks: Object.keys(preview.fallbackChains),
  };
}

/** Merge selected preview items into the draft: imported replaces same-name entries, everything else is kept. */
export function mergeImport(draft: OrchestrationConfig, preview: OrchestrationConfig, selection: ImportSelection): OrchestrationConfig {
  const agents = [...draft.agents];
  for (const agent of preview.agents) {
    if (!selection.agents.includes(agent.name)) continue;
    const index = agents.findIndex(row => row.name === agent.name);
    if (index >= 0) agents[index] = agent;
    else if (agents.length < 128) agents.push(agent);
  }
  const modelRoles = { ...draft.modelRoles };
  for (const [name, model] of Object.entries(preview.modelRoles)) {
    if (name === SESSION_MODEL_ROLE || !selection.roles.includes(name)) continue;
    if (!Object.hasOwn(modelRoles, name) && Object.keys(modelRoles).length >= 128) continue;
    modelRoles[name] = model;
  }
  const fallbackChains = { ...draft.fallbackChains };
  for (const [role, chain] of Object.entries(preview.fallbackChains)) {
    if (selection.fallbacks.includes(role)) fallbackChains[role] = chain;
  }
  return { ...draft, agents, modelRoles, fallbackChains, limits: selection.limits ? { ...preview.limits } : draft.limits };
}
