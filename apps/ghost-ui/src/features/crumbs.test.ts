import { expect, it } from 'vitest';
import type { Ghost, State, Work } from '@ghost/contract';
import { crumbsFor } from './crumbs';

const ghost: Ghost = { id: 'g1', name: '메인', persona: '', look: { avatarId: null }, model: null, isDefault: true, state: 'active', tools: [], directConversationId: 'c-main', createdAt: 1, updatedAt: 1 };
const work = (id: string, title: string, parentId: string | null): Work => ({
  id, parentId, rootId: 'w-root', ghostId: 'g1', originConversationId: 'c-main', conversationId: null, title, brief: 'b',
  acceptance: { criteria: '', checks: [] }, state: 'running', revision: 1, revisionsUsed: 0, deadlineAt: null, result: null, verdict: null, reason: null,
  createdAt: 1, startedAt: null, endedAt: null, updatedAt: 1,
});
const state = {
  ghosts: [ghost],
  conversations: [{ id: 'c-old', ghostId: 'g1', kind: 'direct', workId: null, title: '', model: null, busy: false, createdAt: 1, lastActivityAt: 1 }],
  works: [work('w-root', '상자 만들기', null), work('w-child', '스크립트', 'w-root')],
  spaces: [],
} as unknown as State;

it('trails an open thread through the threads it was delegated from, each step reopening that thread', () => {
  expect(crumbsFor('/ghosts/g1?thread=w-child', state)).toEqual([
    { label: '메인', path: '/ghosts/g1' },
    { label: '상자 만들기', path: '/ghosts/g1?thread=w-root' },
    { label: '스크립트', path: null },
  ]);
  // In an older conversation the thread links keep that conversation.
  expect(crumbsFor('/ghosts/g1?conversation=c-old&thread=w-root', state)).toEqual([
    { label: '메인', path: '/ghosts/g1' },
    { label: '이전 대화', path: '/ghosts/g1?conversation=c-old' },
    { label: '상자 만들기', path: null },
  ]);
});

it('walks a Work page up to its parents and the board, and degrades for unknown targets', () => {
  expect(crumbsFor('/work/w-child', state).map(crumb => crumb.path)).toEqual(['/work', '/work/w-root', null]);
  expect(crumbsFor('/work/missing', state)).toEqual([{ label: '맡긴 일', path: null }]);
  expect(crumbsFor('/settings?tab=team&ghost=g1', state)).toEqual([
    { label: '설정', path: '/settings' }, { label: 'Ghost', path: '/settings?tab=team' }, { label: '메인', path: null },
  ]);
  expect(crumbsFor('/nowhere', state)).toEqual([{ label: '찾을 수 없는 화면', path: null }]);
});
