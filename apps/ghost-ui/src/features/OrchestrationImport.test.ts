import { describe, expect, it } from 'vitest';
import type { OrchestrationConfig, OrchestrationModelRole } from '@ghost/contract';
import { mergeImport, selectableItems } from './OrchestrationImport';

const role = (patch: Partial<OrchestrationModelRole> = {}): OrchestrationModelRole => ({ provider: 'faux', model: 'mini', thinking: null, ...patch });
const config = (patch: Partial<OrchestrationConfig> = {}): OrchestrationConfig => ({
  enabled: true,
  modelRoles: { session: { provider: null, model: null, thinking: null } },
  fallbackChains: {},
  limits: { maxConcurrency: 4, maxDepth: 1 },
  agents: [{ name: 'scout', description: 'Search', modelRole: 'session', instructions: '', tools: ['read'], readOnly: true, canDelegateTo: [] }],
  positions: { agents: {}, roles: {} },
  ...patch,
});

describe('selectableItems', () => {
  it('offers preview agents, roles and fallback chains but never the session role', () => {
    const preview = config({
      modelRoles: { session: { provider: null, model: null, thinking: null }, worker: role() },
      fallbackChains: { worker: [role({ model: 'backup' })] },
      agents: [
        { name: 'scout', description: '', modelRole: 'session', instructions: '', tools: ['read'], readOnly: true, canDelegateTo: [] },
        { name: 'worker', description: '', modelRole: 'worker', instructions: '', tools: ['read'], readOnly: true, canDelegateTo: [] },
      ],
    });
    expect(selectableItems(preview)).toEqual({ agents: ['scout', 'worker'], roles: ['worker'], fallbacks: ['worker'] });
  });
});

describe('mergeImport', () => {
  const imported = { name: 'scout', description: 'Imported scout', modelRole: 'imported-role', instructions: 'NEW', tools: ['read' as const], readOnly: true, canDelegateTo: [] };
  const preview = config({
    modelRoles: { session: { provider: null, model: null, thinking: null }, 'imported-role': role() },
    fallbackChains: { 'imported-role': [role({ model: 'backup' })] },
    limits: { maxConcurrency: 9, maxDepth: 3 },
    agents: [imported, { ...imported, name: 'fresh', description: 'Fresh agent' }],
  });
  const all = { agents: ['scout', 'fresh'], roles: ['imported-role'], fallbacks: ['imported-role'], limits: true };

  it('replaces same-name entries, keeps the rest and appends new agents', () => {
    const merged = mergeImport(config(), preview, all);
    expect(merged.agents.map(agent => [agent.name, agent.description])).toEqual([['scout', 'Imported scout'], ['fresh', 'Fresh agent']]);
    expect(merged.modelRoles['imported-role']).toEqual(role());
    expect(merged.fallbackChains['imported-role']).toEqual([role({ model: 'backup' })]);
    expect(merged.limits).toEqual({ maxConcurrency: 9, maxDepth: 3 });
  });

  it('keeps draft entries for unchecked items and draft limits when limits are unchecked', () => {
    const merged = mergeImport(config(), preview, { agents: ['fresh'], roles: [], fallbacks: [], limits: false });
    expect(merged.agents.map(agent => agent.name)).toEqual(['scout', 'fresh']);
    expect(merged.agents[0]?.description).toBe('Search');
    expect(merged.modelRoles).toEqual({ session: { provider: null, model: null, thinking: null } });
    expect(merged.fallbackChains).toEqual({});
    expect(merged.limits).toEqual({ maxConcurrency: 4, maxDepth: 1 });
  });

  it('never lets the import replace the session role', () => {
    const hostile = config({ modelRoles: { session: role(), other: role() } });
    const merged = mergeImport(config(), hostile, { agents: [], roles: ['session', 'other'], fallbacks: [], limits: false });
    expect(merged.modelRoles.session).toEqual({ provider: null, model: null, thinking: null });
    expect(merged.modelRoles.other).toEqual(role());
  });

  it('keeps chains of the draft that the preview does not select', () => {
    const draft = config({ fallbackChains: { session: [role({ model: 'chain-a' })] } });
    const merged = mergeImport(draft, preview, { agents: [], roles: [], fallbacks: ['imported-role'], limits: false });
    expect(merged.fallbackChains).toEqual({ session: [role({ model: 'chain-a' })], 'imported-role': [role({ model: 'backup' })] });
  });
});
