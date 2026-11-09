import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Verdict } from '@ghost/contract';
import { VerdictStamp } from './WorkDetail';

const verdict = (patch: Partial<Verdict> = {}): Verdict => ({
  outcome: 'revise', source: 'review', reasons: '요약이 두 문단을 건너뜁니다.', at: 1, ...patch,
});

describe('VerdictStamp render', () => {
  it('shows reasons and hides empty evidence and scope', () => {
    const markup = renderToStaticMarkup(createElement(VerdictStamp, { verdict: verdict() }));
    expect(markup).toContain('수정 지시');
    expect(markup).toContain('사유');
    expect(markup).toContain('요약이 두 문단을 건너뜁니다.');
    expect(markup).not.toContain('근거');
    expect(markup).not.toContain('수정 범위');
  });

  it('shows the observed evidence and the bound of a revision when the verdict carries them', () => {
    const markup = renderToStaticMarkup(createElement(VerdictStamp, { verdict: verdict({
      evidence: 'src/report.ts:42 — 기대: 3문단, 실제: 1문단',
      scope: '요약 문단만 고칠 수 있습니다. 데이터 수집은 그대로 둡니다.',
    }) }));
    expect(markup).toContain('근거');
    expect(markup).toContain('src/report.ts:42');
    expect(markup).toContain('수정 범위');
    expect(markup).toContain('데이터 수집은 그대로 둡니다.');
  });

  it('keeps blank evidence and scope invisible', () => {
    const markup = renderToStaticMarkup(createElement(VerdictStamp, { verdict: verdict({ evidence: '  ', scope: '' }) }));
    expect(markup).not.toContain('근거');
    expect(markup).not.toContain('수정 범위');
  });
});
