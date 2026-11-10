import { describe, expect, it } from 'vitest';
import { GHOST_TOOLS, type Adaptation, type Ghost } from '@ghost/contract';
import { adaptationLine, canDeleteGhost, editFallbacks, settingsRoster, toggleSkill, toolGroups, toolLabels } from './GhostSettings';

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

describe('tool groups', () => {
  it('covers every contract tool, so none falls to 기타', () => {
    const grouped = toolGroups.flatMap(group => [...group.tools]);
    expect([...grouped].sort()).toEqual([...GHOST_TOOLS].sort());
    expect(GHOST_TOOLS.every(tool => Boolean(toolLabels[tool]))).toBe(true);
  });
});

describe('환경 적응 meta line', () => {
  const adaptation = (patch: Partial<Adaptation> = {}): Adaptation => ({
    ghostId: 'g1', notes: '창작물은 ~/Works에 둔다', previous: null, by: 'self', reason: null, updatedAt: 0, revision: 0, ...patch,
  });

  it('names who changed the notes last, when, and the reason when present', () => {
    expect(adaptationLine(adaptation({ by: 'self' }), 180_000)).toBe('스스로 · 3분 전');
    expect(adaptationLine(adaptation({ by: 'main', reason: '메모 경로 정리' }), 30_000)).toBe('메인 · 방금 · 메모 경로 정리');
    expect(adaptationLine(adaptation({ by: 'owner', reason: '명령을 bun으로 바꿈' }), 7_200_000)).toBe('소유자 · 2시간 전 · 명령을 bun으로 바꿈');
  });

  it('leaves the reason out when the last change had none', () => {
    expect(adaptationLine(adaptation({ by: 'owner', reason: '' }), 45_000)).toBe('소유자 · 1분 전');
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
