import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Work } from '@ghost/contract';
import { WorkLane } from './WorkLane';

const work = (patch: Partial<Work> = {}) => ({
  id: 'w1', ghostId: 'sage', title: '홈 화면 검수 적용', state: 'running', reason: null,
  createdAt: 1, startedAt: 1, endedAt: null, updatedAt: 1, ...patch,
} as unknown as Work);

const render = (node: Work, needsOwner = false) => renderToStaticMarkup(createElement(WorkLane, {
  work: node, ghostName: '세이지', needsOwner, now: 60_000, onOpen() {},
}));

describe('lane state reading', () => {
  it('shows the state word on the lane, once in the eye and once for the reader', () => {
    const markup = render(work());
    expect(markup).toContain('<span class="lane__state" aria-hidden="true">진행 중</span>');
    expect(markup).toContain('class="sr-only">진행 중</span>');
  });

  it('says 확인 필요 while the owner is the one waited on', () => {
    expect(render(work(), true)).toContain('lane__state" aria-hidden="true">확인 필요<');
  });

  it('names the lifecycle stage alone, so the state is never read twice', () => {
    const markup = render(work({ state: 'verifying' }));
    expect(markup).toContain('role="img" aria-label="검증"');
    expect(markup).not.toContain('검증 · ');
  });
});
