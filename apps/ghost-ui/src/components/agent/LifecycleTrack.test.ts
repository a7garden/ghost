import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LifecycleTrack, lifecycleLabel } from './LifecycleTrack';

describe('lifecycle accessible name', () => {
  it('names the step and the state the glyph shows', () => {
    expect(lifecycleLabel('failed', false)).toBe('진행 · 실패');
    expect(lifecycleLabel('verifying', true)).toBe('검증 · 확인 필요');
    expect(lifecycleLabel('queued', false)).toBe('접수 · 대기 중');
  });

  it('does not repeat a state that is the step itself', () => {
    expect(lifecycleLabel('done', false)).toBe('완료');
  });
});

describe('lifecycle track in a lane', () => {
  it('says the stage alone when the state is spoken next to it', () => {
    const markup = renderToStaticMarkup(createElement(LifecycleTrack, { state: 'verifying', stageOnly: true }));
    expect(markup).toContain('role="img" aria-label="검증"');
    expect(markup).not.toContain('검증 · ');
  });

  it('keeps the step and the state together everywhere else', () => {
    const markup = renderToStaticMarkup(createElement(LifecycleTrack, { state: 'verifying' }));
    expect(markup).toContain('role="img" aria-label="검증 · 검증 중"');
  });
});
