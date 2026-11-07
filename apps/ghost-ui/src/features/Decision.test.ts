import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Decision } from '@ghost/contract';
import { HostProvider } from '../host/context';
import { DecisionCard, decisionCommand, documentProposal } from './Decision';

const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', kind: 'approve_effect', ghostId: 'sage', conversationId: 'c1', workId: null, effectId: 'e1',
  title: '파일 저장 승인', detail: '메모에 한 줄을 추가합니다.', options: [], proposal: null, state: 'pending',
  answer: null, createdAt: 1, resolvedAt: null, ...patch,
});

describe('decisionCommand', () => {
  it('approves and denies effect decisions with the decision id', () => {
    expect(decisionCommand(decision(), 'approve')).toEqual({ type: 'decision.resolve', decisionId: 'd1', outcome: 'approve' });
    expect(decisionCommand(decision(), 'deny')).toEqual({ type: 'decision.resolve', decisionId: 'd1', outcome: 'deny' });
  });

  it('answers a question with the chosen option text or the free answer', () => {
    const question = decision({ kind: 'question', options: ['서울', '부산'] });
    expect(decisionCommand(question, 'answer', '서울')).toEqual({ type: 'decision.resolve', decisionId: 'd1', outcome: 'answer', answer: '서울' });
    expect(decisionCommand(question, 'answer', '  제주도  ')).toEqual({ type: 'decision.resolve', decisionId: 'd1', outcome: 'answer', answer: '제주도' });
    expect(decisionCommand(question, 'answer', '   ')).toEqual({ error: '답변을 적어 주세요.' });
    expect(decisionCommand(question, 'approve')).toEqual({ type: 'decision.resolve', decisionId: 'd1', outcome: 'approve' });
  });

  it('refuses to re-resolve a settled decision', () => {
    expect(decisionCommand(decision({ state: 'approved' }), 'approve')).toEqual({ error: '이미 처리된 결정입니다.' });
  });

  it('sends plain approve for accept_result, document_review and reconcile_effect', () => {
    for (const kind of ['accept_result', 'document_review', 'reconcile_effect'] as const) {
      expect(decisionCommand(decision({ kind }), 'approve')).toEqual({ type: 'decision.resolve', decisionId: 'd1', outcome: 'approve' });
    }
  });
});

describe('documentProposal', () => {
  it('reads the proposal payload only for document decisions', () => {
    expect(documentProposal(decision())).toBeNull();
    expect(documentProposal(decision({ kind: 'document_review', proposal: { title: '회의록', body: '내용' } })))
      .toMatchObject({ title: '회의록', body: '내용' });
  });
});

describe('DecisionCard render', () => {
  it('labels each kind and renders question options as answer buttons', () => {
    const card = (node: Decision) => createElement(HostProvider, null, createElement(DecisionCard, {
      decision: node, ghostName: '세이지', onResolved() {}, onOpenWork() {},
    }));
    const question = renderToStaticMarkup(card(decision({ kind: 'question', options: ['서울', '부산'] })));
    expect(question).toContain('답변 대기');
    expect(question).toContain('서울');
    expect(question).toContain('부산');
    const review = renderToStaticMarkup(card(decision({ kind: 'document_review', proposal: { title: '회의록', body: '# 회의록\n본문' } })));
    expect(review).toContain('제안된 문서');
    expect(review).toContain('회의록');
  });
});
