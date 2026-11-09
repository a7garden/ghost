import { describe, expect, it } from 'vitest';
import { lifecycleLabel } from './LifecycleTrack';

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
