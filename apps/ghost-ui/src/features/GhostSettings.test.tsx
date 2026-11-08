import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Ghost, SkillCatalog } from '@ghost/contract';
import { HostClient } from '../host/client';
import { HostProvider } from '../host/context';
import {
  canDeleteGhost, deleteCommand, fallbacksCommand, GhostSheet, MAX_FALLBACKS,
  settingsRoster, skillsCommand, SkillsPanel,
} from './GhostSettings';

const ghost = (patch: Partial<Ghost> = {}): Ghost => ({
  id: 'g1', name: '연구원', persona: '', look: { avatarId: null }, model: null, isDefault: false, state: 'retired',
  tools: [], fallbacks: [], skills: [], deletedAt: null,
  directConversationId: 'conv-g1', createdAt: 1, updatedAt: 1, ...patch,
});

const model = (id: string) => ({ provider: 'p', model: id });

describe('fallbacksCommand', () => {
  it('saves add, remove and reorder as ghost.update payloads', () => {
    const base = [model('a'), model('b')];
    expect(fallbacksCommand('g1', base, { kind: 'add', model: model('c') }))
      .toEqual({ type: 'ghost.update', ghostId: 'g1', fallbacks: [model('a'), model('b'), model('c')] });
    expect(fallbacksCommand('g1', base, { kind: 'remove', index: 0 }))
      .toEqual({ type: 'ghost.update', ghostId: 'g1', fallbacks: [model('b')] });
    expect(fallbacksCommand('g1', base, { kind: 'move', index: 1, delta: -1 }))
      .toEqual({ type: 'ghost.update', ghostId: 'g1', fallbacks: [model('b'), model('a')] });
    expect(fallbacksCommand('g1', base, { kind: 'move', index: 0, delta: -1 }))
      .toEqual({ type: 'ghost.update', ghostId: 'g1', fallbacks: base });
    expect(fallbacksCommand('g1', base, { kind: 'replace', index: 1, model: model('d') }))
      .toEqual({ type: 'ghost.update', ghostId: 'g1', fallbacks: [model('a'), model('d')] });
  });

  it('caps the list at three and leaves out-of-range edits alone', () => {
    const full = [model('a'), model('b'), model('c')];
    expect(MAX_FALLBACKS).toBe(3);
    expect(fallbacksCommand('g1', full, { kind: 'add', model: model('d') }))
      .toEqual({ type: 'ghost.update', ghostId: 'g1', fallbacks: full });
    expect(fallbacksCommand('g1', full, { kind: 'move', index: 2, delta: 1 }))
      .toEqual({ type: 'ghost.update', ghostId: 'g1', fallbacks: full });
    expect(fallbacksCommand('g1', full, { kind: 'remove', index: 7 }))
      .toEqual({ type: 'ghost.update', ghostId: 'g1', fallbacks: full });
  });
});

describe('skillsCommand', () => {
  it('saves skill toggles as unique ghost.update payloads', () => {
    expect(skillsCommand('g1', [], 'pdf', true))
      .toEqual({ type: 'ghost.update', ghostId: 'g1', skills: ['pdf'] });
    expect(skillsCommand('g1', ['pdf', 'web'], 'web', true))
      .toEqual({ type: 'ghost.update', ghostId: 'g1', skills: ['pdf', 'web'] });
    expect(skillsCommand('g1', ['pdf', 'web'], 'pdf', false))
      .toEqual({ type: 'ghost.update', ghostId: 'g1', skills: ['web'] });
    expect(skillsCommand('g1', ['pdf'], 'pdf', true))
      .toEqual({ type: 'ghost.update', ghostId: 'g1', skills: ['pdf'] });
  });
});

describe('canDeleteGhost', () => {
  it('offers 삭제 only to a retired, non-default, not-yet-deleted Ghost', () => {
    expect(canDeleteGhost(ghost())).toBe(true);
    expect(canDeleteGhost(ghost({ state: 'active' }))).toBe(false);
    expect(canDeleteGhost(ghost({ isDefault: true }))).toBe(false);
    expect(canDeleteGhost(ghost({ deletedAt: 9 }))).toBe(false);
    expect(deleteCommand('g1')).toEqual({ type: 'ghost.delete', ghostId: 'g1' });
  });
});

describe('settingsRoster', () => {
  it('drops deleted Ghosts and keeps the main Ghost first', () => {
    const roster = settingsRoster([
      ghost({ id: 'gone', deletedAt: 3 }),
      ghost({ id: 'b', state: 'active', createdAt: 5 }),
      ghost({ id: 'main', isDefault: true, state: 'active' }),
    ]);
    expect(roster.map(item => item.id)).toEqual(['main', 'b']);
  });
});

describe('SkillsPanel', () => {
  const catalog = (skills: { name: string; description: string }[]): SkillCatalog => ({ skills });
  const panel = (found: SkillCatalog | null, skills: string[]) =>
    renderToStaticMarkup(createElement(SkillsPanel, { catalog: found, skills, onChange() {} }));

  it('hides entirely when the catalog is missing or empty', () => {
    expect(panel(null, ['pdf'])).toBe('');
    expect(panel({ skills: [] }, ['pdf'])).toBe('');
  });

  it('shows pills with the description on hover only and marks catalog-missing skills unavailable', () => {
    const html = panel(catalog([{ name: 'pdf', description: 'PDF를 요약한다' }]), ['pdf', 'gone']);
    expect(html).toContain('pdf');
    expect(html).toContain('title="PDF를 요약한다"');
    expect(html).not.toContain('>PDF를 요약한다');
    expect(html).toContain('data-unavailable');
    // Skills no longer in the catalog render after the catalog pills.
    expect(html.indexOf('gone')).toBeGreaterThan(html.indexOf('pdf'));
  });
});

describe('GhostSheet render', () => {
  const sheet = (node: Ghost) => renderToStaticMarkup(createElement(HostProvider, {
    client: new HostClient(),
    children: createElement(GhostSheet, { ghost: node, onChat() {} }),
  }));

  it('shows the destructive delete button only for a retired non-default Ghost', () => {
    expect(sheet(ghost())).toContain('삭제</button>');
    expect(sheet(ghost({ state: 'active' }))).not.toContain('삭제</button>');
    expect(sheet(ghost({ isDefault: true, state: 'retired' }))).not.toContain('삭제</button>');
  });

  it('renders fallback models in order with an add row while under the cap', () => {
    const html = sheet(ghost({ fallbacks: [model('m1'), model('m2')] }));
    expect(html).toContain('m1');
    expect(html.indexOf('m1')).toBeLessThan(html.indexOf('m2'));
    expect(html).toContain('대체 모델 추가');
    expect(sheet(ghost({ fallbacks: [model('a'), model('b'), model('c')] }))).not.toContain('대체 모델 추가');
  });
});
