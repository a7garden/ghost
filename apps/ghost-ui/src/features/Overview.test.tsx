import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { State, Work } from '@ghost/contract';
import { HostProvider } from '../host/context';
import { Overview } from './Overview';

const work = {
  id: 'w1', ghostId: 'sage', parentId: null, rootId: 'w1', originConversationId: 'c1', conversationId: null,
  title: '홈 화면 검수 적용', state: 'running', reason: null,
  createdAt: 1, startedAt: 1, endedAt: null, updatedAt: 1,
} as unknown as Work;

const state = {
  runtime: { ready: true, detail: '준비됨' },
  settings: { providers: [{ id: 'p1' }], defaultModel: 'model' },
  notifications: [], decisions: [], works: [work],
  ghosts: [{ id: 'sage', name: '세이지', persona: '차분한 작업자', state: 'active', deletedAt: null, isDefault: true }],
} as unknown as State;

describe('home counts', () => {
  it('names the live band without a number; the sidebar badge keeps the count', () => {
    const markup = renderToStaticMarkup(createElement(HostProvider, null, createElement(Overview, { state, navigate() {} })));
    expect(markup).toContain('<h2 id="home-live" class="section-title">진행 중</h2>');
    expect(markup).not.toContain('class="count"');
  });
});
