import { describe, expect, it } from 'vitest';
import { SESSION_MODEL_ROLE, orchestrationIssues, type OrchestrationConfig } from '@ghost/contract';
import { addNode, connectAgents, moveNode, removeNode, renameNode, reorderFallback } from './OrchestrationModel';

const seed = (): OrchestrationConfig => ({ enabled: true, limits: { maxConcurrency: 4, maxDepth: 2 }, agents: [], fallbackChains: {},
  modelRoles: { [SESSION_MODEL_ROLE]: { provider: null, model: null, thinking: null } }, positions: { agents: {}, roles: {} } });

describe('orchestration graph', () => {
  it('adds, moves, links, renames and removes agents without dangling edges', () => {
    const a = addNode(seed(), 'agents');
    const b = addNode(a.config, 'agents');
    const moved = moveNode(b.config, b.node, { x: 31, y: 88 });
    const connected = connectAgents(moved, a.node.name, b.node.name);
    expect(connected.agents[0]?.canDelegateTo).toEqual([b.node.name]);
    const renamed = renameNode(connected, b.node, 'reader')!;
    expect(renamed.agents[0]?.canDelegateTo).toEqual(['reader']);
    expect(renamed.positions.agents.reader).toEqual({ x: 31, y: 88 });
    const removed = removeNode(renamed, { kind: 'agents', name: 'reader' });
    expect(removed.agents[0]?.canDelegateTo).toEqual([]);
    expect(removed.positions.agents.reader).toBeUndefined();
  });

  it('keeps chain order and references when a model role is changed', () => {
    const a = addNode(seed(), 'roles', { provider: 'p', model: 'q' });
    const b = addNode(a.config, 'roles', { provider: 'p', model: 'r' });
    const config = b.config;
    config.fallbackChains[a.node.name] = [{ role: b.node.name }, { provider: 'x', model: 'y', thinking: 'low' }];
    config.fallbackChains[a.node.name] = reorderFallback(config.fallbackChains[a.node.name]!, 0, 1);
    const renamed = renameNode(config, b.node, 'secondary')!;
    expect(renamed.fallbackChains[a.node.name]).toEqual([{ provider: 'x', model: 'y', thinking: 'low' }, { role: 'secondary' }]);
    expect(removeNode(renamed, { kind: 'roles', name: 'secondary' }).fallbackChains[a.node.name]).toEqual([{ provider: 'x', model: 'y', thinking: 'low' }]);
  });

  it('points depth overflow, cycles, missing roles and credentials back to their nodes', () => {
    const a = addNode(seed(), 'agents');
    const b = addNode(a.config, 'agents');
    const c = addNode(b.config, 'agents');
    const sequence = connectAgents(connectAgents(c.config, a.node.name, b.node.name), b.node.name, c.node.name);
    expect(orchestrationIssues(sequence)).toContainEqual({ kind: 'agent', name: a.node.name, code: 'depth' });
    const cycle = connectAgents(sequence, c.node.name, a.node.name);
    expect(orchestrationIssues(cycle).filter(issue => issue.code === 'cycle').map(issue => issue.name).sort()).toEqual([a.node.name, b.node.name, c.node.name]);
    const role = addNode(cycle, 'roles', { provider: 'private', model: 'unknown' });
    role.config.agents[0]!.modelRole = 'removed';
    expect(orchestrationIssues(role.config, { models: [], providersWithCredentials: [] })).toEqual(expect.arrayContaining([
      { kind: 'agent', name: a.node.name, code: 'unknown-role', ref: 'removed' },
      { kind: 'role', name: role.node.name, code: 'credential', ref: 'private/unknown' },
    ]));
  });
});
