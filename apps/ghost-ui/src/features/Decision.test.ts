import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Decision, State, Work } from '@ghost/contract';
import { HostProvider } from '../host/context';
import { DecisionCard, chatDecisions, decisionCommand, denyReasonPrompt, documentProposal, highRiskApproval, questionFallbackText, resolvedText } from './Decision';

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

  it('carries a trimmed reason on deny and drops an empty one', () => {
    const result = decision({ kind: 'accept_result' });
    expect(decisionCommand(result, 'deny', '  표를 날짜순으로  ')).toEqual({ type: 'decision.resolve', decisionId: 'd1', outcome: 'deny', answer: '표를 날짜순으로' });
    expect(decisionCommand(result, 'deny', '   ')).toEqual({ type: 'decision.resolve', decisionId: 'd1', outcome: 'deny' });
    expect(decisionCommand(decision({ kind: 'reconcile_effect' }), 'deny', '파일이 없음')).toEqual({ type: 'decision.resolve', decisionId: 'd1', outcome: 'deny', answer: '파일이 없음' });
    // Approve never carries text: only a question answers and only a deny explains.
    expect(decisionCommand(result, 'approve', '좋음')).toEqual({ type: 'decision.resolve', decisionId: 'd1', outcome: 'approve' });
  });

  it('asks for a reason only where the host passes it on', () => {
    expect(Object.keys(denyReasonPrompt).sort()).toEqual(['accept_result', 'document_review', 'reconcile_effect']);
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

describe('highRiskApproval', () => {
  const command = (risk: string) => decision({ proposal: { command: '"/bin/rm" "a"', cwd: '/p', reason: 'x', risk } });
  it('marks loss-speaking host commands and paying or account-changing browser clicks, nothing else', () => {
    expect(highRiskApproval(command('삭제: 파일이 영구 제거될 수 있습니다. 임시 파일'))).toBe(true);
    expect(highRiskApproval(command('Overwrites the build output'))).toBe(true);
    expect(highRiskApproval(command('읽기만 합니다'))).toBe(false);
    expect(highRiskApproval(decision({ proposal: { kind: 'browser', commit: 'payment' } }))).toBe(true);
    expect(highRiskApproval(decision({ proposal: { kind: 'browser', commit: 'account' } }))).toBe(true);
    expect(highRiskApproval(decision({ proposal: { kind: 'browser', commit: 'send' } }))).toBe(false);
    expect(highRiskApproval(decision({ kind: 'reconcile_effect', proposal: { command: 'x', risk: '삭제' } }))).toBe(false);
  });
});

describe('resolvedText', () => {
  it('says what the owner did', () => {
    expect(resolvedText('approve_effect', 'approve')).toBe('승인했습니다');
    expect(resolvedText('accept_result', 'deny')).toBe('수정을 요청했습니다');
    expect(resolvedText('question', 'answer')).toBe('답했습니다');
  });
});

describe('questionFallbackText', () => {
  it('says when and to what an unanswered question settles, only while it is pending', () => {
    const question = decision({ kind: 'question', proposal: { default: 'PDF', expiresAt: 31 * 60_000 } });
    expect(questionFallbackText(question, 60_000)).toBe('답이 없으면 30분 뒤 기본값으로 진행합니다: PDF');
    expect(questionFallbackText(question, 31 * 60_000)).toBe('답이 없으면 곧 기본값으로 진행합니다: PDF');
    expect(questionFallbackText(decision({ kind: 'question', proposal: { default: 'PDF', expiresAt: 3 * 60 * 60_000 } }), 0)).toBe('답이 없으면 3시간 뒤 기본값으로 진행합니다: PDF');
    expect(questionFallbackText({ ...question, state: 'answered' }, 0)).toBeNull();
    expect(questionFallbackText(decision({ kind: 'question' }), 0)).toBeNull();
    expect(questionFallbackText(decision({ proposal: { default: 'x', expiresAt: 1 } }), 0)).toBeNull();
  });
});

describe('documentProposal', () => {
  it('reads the proposal payload only for document decisions', () => {
    expect(documentProposal(decision())).toBeNull();
    expect(documentProposal(decision({ kind: 'document_review', proposal: { title: '회의록', body: '내용' } })))
      .toMatchObject({ title: '회의록', body: '내용' });
  });
});

describe('chatDecisions', () => {
  const work = (id: string, ghostId: string, patch: Partial<Work> = {}) =>
    ({ id, ghostId, parentId: null, rootId: id, originConversationId: 'other', ...patch }) as Work;
  const state = (decisions: Decision[], works: Work[]) => ({ decisions, works }) as unknown as State;

  it("gathers the Ghost's own decisions and those of threads begun in the conversation, oldest first", () => {
    const works = [
      work('root', 'kai', { originConversationId: 'c1' }),
      work('child', 'mo', { parentId: 'root', rootId: 'root', originConversationId: 'kai-work' }),
      work('elsewhere', 'mo'),
    ];
    const decisions = [
      decision({ id: 'own-direct', createdAt: 5 }),
      decision({ id: 'own-other-work', ghostId: 'sage', conversationId: 'w9', workId: 'w9', createdAt: 1 }),
      decision({ id: 'thread-root', ghostId: 'kai', workId: 'root', createdAt: 3 }),
      decision({ id: 'thread-child', ghostId: 'mo', workId: 'child', createdAt: 4 }),
      decision({ id: 'unrelated', ghostId: 'mo', workId: 'elsewhere', createdAt: 2 }),
      decision({ id: 'settled', state: 'approved', createdAt: 0 }),
    ];
    expect(chatDecisions(state(decisions, works), 'sage', 'c1').map(item => item.id))
      .toEqual(['own-other-work', 'thread-root', 'thread-child', 'own-direct']);
    expect(chatDecisions(state(decisions, works), 'sage', null).map(item => item.id)).toEqual(['own-other-work', 'own-direct']);
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
    const risky = renderToStaticMarkup(card(decision({ proposal: { command: 'rm', cwd: '/p', reason: '정리', risk: '삭제: 되돌릴 수 없음' } })));
    expect(risky).toContain('data-risk="high"');
  });
});
