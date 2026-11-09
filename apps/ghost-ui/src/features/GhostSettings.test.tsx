import { describe, expect, it } from 'vitest';
import type { Ghost } from '@ghost/contract';
import { canDeleteGhost, editFallbacks, groupToggleNeedsConfirm, keepPersonaDraft, liveWorkCount, restorePersonaDraft, settingsRoster, toggleSkill } from './GhostSettings';

const ghost = (patch: Partial<Ghost> = {}): Ghost => ({
  id: 'g1', name: '연구원', persona: '', look: { avatarId: null }, model: null, isDefault: false, state: 'retired',
  tools: [], fallbacks: [], skills: [], deletedAt: null,
  directConversationId: 'conv-g1', createdAt: 1, updatedAt: 1, ...patch,
});
const model = (id: string) => ({ provider: 'p', model: id });

describe('fallback order edits', () => {
  it('reorders and removes only the addressed step without mutating the saved order', () => {
    const saved = [model('a'), model('b'), model('c')];
    const moved = editFallbacks(saved, { kind: 'move', index: 2, delta: -1 });
    expect(moved.map(ref => ref.model)).toEqual(['a', 'c', 'b']);
    expect(editFallbacks(moved, { kind: 'remove', index: 1 }).map(ref => ref.model)).toEqual(['a', 'b']);
    expect(saved.map(ref => ref.model)).toEqual(['a', 'b', 'c']);
  });

  it('cannot add a fourth step or move beyond either end', () => {
    const saved = [model('a'), model('b'), model('c')];
    expect(editFallbacks(saved, { kind: 'add', model: model('d') })).toEqual(saved);
    expect(editFallbacks(saved, { kind: 'move', index: 0, delta: -1 })).toEqual(saved);
    expect(editFallbacks(saved, { kind: 'move', index: 2, delta: 1 })).toEqual(saved);
    expect(editFallbacks(saved, { kind: 'replace', index: -1, model: model('d') })).toEqual(saved);
  });
});

describe('skill selection', () => {
  it('keeps selection unique and preserves other skills when one is removed', () => {
    const saved = ['pdf', 'web'];
    expect(toggleSkill(saved, 'web', true)).toEqual(['pdf', 'web']);
    expect(toggleSkill(saved, 'pdf', false)).toEqual(['web']);
    expect(saved).toEqual(['pdf', 'web']);
  });
});

describe('Ghost lifecycle', () => {
  it('allows deletion only after retirement and never for the main or an already deleted Ghost', () => {
    expect(canDeleteGhost(ghost())).toBe(true);
    expect(canDeleteGhost(ghost({ state: 'active' }))).toBe(false);
    expect(canDeleteGhost(ghost({ state: 'paused' }))).toBe(false);
    expect(canDeleteGhost(ghost({ isDefault: true }))).toBe(false);
    expect(canDeleteGhost(ghost({ deletedAt: 9 }))).toBe(false);
  });

  it('excludes deleted Ghosts, keeps retired Ghosts editable and puts the main first', () => {
    const roster = settingsRoster([
      ghost({ id: 'gone', deletedAt: 3 }),
      ghost({ id: 'newer', state: 'active', createdAt: 5 }),
      ghost({ id: 'main', isDefault: true, state: 'active', createdAt: 3 }),
      ghost({ id: 'retired', createdAt: 2 }),
    ]);
    expect(roster.map(item => item.id)).toEqual(['main', 'retired', 'newer']);
  });
});

describe('confirmations', () => {
  it('asks before a group head newly grants a Mac command or a vault login, never when turning off', () => {
    expect(groupToggleNeedsConfirm(['host_status', 'host_command_propose'], [], true)).toBe(true);
    expect(groupToggleNeedsConfirm(['browser_open', 'browser_login'], ['browser_open'], true)).toBe(true);
    expect(groupToggleNeedsConfirm(['host_status', 'host_command_propose'], ['host_command_propose'], true)).toBe(false);
    expect(groupToggleNeedsConfirm(['host_status', 'host_command_propose'], [], false)).toBe(false);
    expect(groupToggleNeedsConfirm(['read', 'write', 'edit', 'bash'], [], true)).toBe(false);
  });

  it('counts only the unsettled Work of this Ghost', () => {
    const works = [
      { ghostId: 'g1', state: 'running' as const }, { ghostId: 'g1', state: 'blocked' as const },
      { ghostId: 'g1', state: 'done' as const }, { ghostId: 'g2', state: 'queued' as const },
    ];
    expect(liveWorkCount(works, 'g1')).toBe(2);
    expect(liveWorkCount(works, 'g3')).toBe(0);
  });
});

describe('unsaved role instructions', () => {
  it('keeps a draft per Ghost and forgets it once it matches the stored text', () => {
    const drafts = new Map<string, { base: string; draft: string }>();
    keepPersonaDraft(drafts, 'g1', '새 지시', '옛 지시');
    keepPersonaDraft(drafts, 'g2', '같음', '같음');
    expect([...drafts]).toEqual([['g1', { base: '옛 지시', draft: '새 지시' }]]);
    keepPersonaDraft(drafts, 'g1', '새 지시', '새 지시');
    expect(drafts.size).toBe(0);
  });
  it('drops a parked draft once the stored text moved on elsewhere', () => {
    const drafts = new Map<string, { base: string; draft: string }>();
    keepPersonaDraft(drafts, 'g1', '내 수정', '옛 지시');
    expect(restorePersonaDraft(drafts, 'g1', '옛 지시')).toBe('내 수정');
    expect(restorePersonaDraft(drafts, 'g1', '다른 기기에서 바꾼 지시')).toBe('다른 기기에서 바꾼 지시');
    expect(drafts.size).toBe(0);
  });
});
