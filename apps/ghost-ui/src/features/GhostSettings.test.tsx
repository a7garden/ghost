import { describe, expect, it } from 'vitest';
import { GHOST_TOOLS, type Adaptation, type Ghost } from '@ghost/contract';
import { adaptationLine, canRemoveGhost, editFallbacks, packageDrift, removalCommands, settingsRoster, toggleSkill, toolGroups } from './GhostSettings';
import { toolLabels } from './toolLabels';

const ghost = (patch: Partial<Ghost> = {}): Ghost => ({
  id: 'g1', name: '연구원', persona: '', look: { avatarId: null }, model: null, isDefault: false, state: 'retired',
  tools: [], fallbacks: [], skills: [], attachments: [], deletedAt: null,
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
  it('removes any Ghost but the main one, once', () => {
    expect(canRemoveGhost(ghost({ state: 'active' }))).toBe(true);
    expect(canRemoveGhost(ghost({ state: 'paused' }))).toBe(true);
    expect(canRemoveGhost(ghost({ isDefault: true, state: 'active' }))).toBe(false);
    expect(canRemoveGhost(ghost({ deletedAt: 9 }))).toBe(false);
  });

  it('hands the removed Ghost\'s projects back to the main Ghost before removing it', () => {
    const scopes = [{ id: 's1', ghostId: 'g1' }, { id: 's2', ghostId: null }, { id: 's3', ghostId: 'other' }, { id: 's4', ghostId: 'g1' }];
    expect(removalCommands('g1', scopes)).toEqual([
      { type: 'scope.update', scopeId: 's1', ghostId: null },
      { type: 'scope.update', scopeId: 's4', ghostId: null },
      { type: 'ghost.delete', ghostId: 'g1' },
    ]);
  });
});

describe('package drift', () => {
  const entry = { persona: '개발자', tools: ['read', 'bash'], skills: ['anti-slop', 'absent'], missingSkills: ['absent'], look: { avatarId: null, body: '#3d5cf5', shape: 'squircle' as const }, version: 2 };
  const installed = ghost({ persona: '개발자', tools: ['bash', 'read'], skills: ['anti-slop'], look: { avatarId: null, body: '#3d5cf5', shape: 'squircle' }, source: { package: 'dev', version: 2 } });

  it('reads an untouched Ghost as its package, ignoring order and skills this Host lacks', () => {
    expect(packageDrift(installed, entry)).toBeNull();
  });

  it('names a newer package version before any local edit', () => {
    expect(packageDrift({ ...installed, persona: '고침', source: { package: 'dev', version: 1 } }, entry)).toBe('update');
  });

  it('notices an edited persona, tool list or look', () => {
    expect(packageDrift({ ...installed, persona: '고침' }, entry)).toBe('edited');
    expect(packageDrift({ ...installed, tools: ['read'] }, entry)).toBe('edited');
    expect(packageDrift({ ...installed, look: { avatarId: null, body: '#000000', shape: 'squircle' } }, entry)).toBe('edited');
  });
});

describe('settings roster', () => {
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
