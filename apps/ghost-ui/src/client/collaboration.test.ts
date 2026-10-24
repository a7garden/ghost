import { describe, expect, it } from 'vitest';
import { collaborationGroups, delegationContext } from './collaboration';
import { initialWorkspace } from '../fixtures/workspace';
import { normalizeSnapshot } from './normalize';

describe('collaboration lineage and status', () => {
  it('groups parallel delegations by their actual generation parent', () => {
    const groups = collaborationGroups(initialWorkspace());
    expect(groups).toHaveLength(1);
    expect(groups[0].delegations.map(d => d.target)).toEqual(['milo', 'nova']);
    expect(groups[0].owner).toBe('sage');
  });
  it('does not join independent requests just because they share a conversation', () => {
    const s = initialWorkspace();
    s.profiles[0].conversations[0].tasks.find(t => t.id === 'delegate-code')!.parent_id = 'another-request';
    expect(collaborationGroups(s)).toHaveLength(2);
  });
  it('shows owner review even when the delegation is broadly running', () => {
    const s = initialWorkspace(), ctx = delegationContext(s, s.delegations[0]);
    expect(ctx.status).toBe('attention'); expect(ctx.label).toBe('확인 필요');
  });
  it('never reports uncertain or failed collaboration as success', () => {
    for (const state of ['uncertain', 'failed']) {
      const s = initialWorkspace(); s.delegations[1].state = state;
      const ctx = delegationContext(s, s.delegations[1]);
      expect(ctx.status).toBe('attention'); expect(ctx.phase).toBe(state);
    }
  });
  it('keeps history readable when a participant or task is unavailable', () => {
    const s = initialWorkspace(); s.profiles = [];
    expect(() => collaborationGroups(s)).not.toThrow();
    expect(delegationContext(s, s.delegations[0]).target).toBeUndefined();
  });
  it('accepts older snapshots without a collaboration projection', () => {
    expect(normalizeSnapshot({ workspace_id: 'old', profiles: [] }).delegations).toEqual([]);
  });
});
