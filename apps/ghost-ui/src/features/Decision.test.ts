import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Decision, State, Work } from '@ghost/contract';
import { HostProvider } from '../host/context';
import { DecisionCard, autoSettleText, cardDetail, chatDecisions, decisionCommand, denyReasonPrompt, documentProposal, highRiskApproval, recommendedOption, resolvedText } from './Decision';
import { browserHandoffProposal, decisionChip, emptySecureForm, secureFormBody, secureFormProposal } from './decisionText';

const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'd1', kind: 'approve_effect', ghostId: 'sage', conversationId: 'c1', workId: null, effectId: 'e1',
  title: '파일 저장 승인', detail: '메모에 한 줄을 추가합니다.', options: [], proposal: null, state: 'pending',
  answer: null, createdAt: 1, resolvedAt: null, ...patch,
});

const loginRequest = { kind: 'login' as const, origin: 'https://app.example.com', title: '예시 로그인', reason: '로그인이 필요합니다.' };

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

  it('never lets a secure-form question through the answer path, and still denies it', () => {
    const secure = decision({ kind: 'question', proposal: { secureForm: loginRequest } });
    expect(decisionCommand(secure, 'answer', '사용자@example.com 비밀번호1234')).toEqual({ error: '이 결정은 금고 화면에서만 답합니다.' });
    expect(decisionCommand(secure, 'deny')).toEqual({ type: 'decision.resolve', decisionId: 'd1', outcome: 'deny' });
  });

  it('answers a handoff question normally', () => {
    const handoff = decision({ kind: 'question', proposal: { browserHandoff: { url: 'https://example.com/form', reason: '화면에서 직접 확인해 주세요.' } } });
    expect(decisionCommand(handoff, 'answer', '다 했어요')).toEqual({ type: 'decision.resolve', decisionId: 'd1', outcome: 'answer', answer: '다 했어요' });
    expect(decisionCommand(handoff, 'deny')).toEqual({ type: 'decision.resolve', decisionId: 'd1', outcome: 'deny' });
  });
});

describe('highRiskApproval', () => {
  const command = (risk: string) => decision({ proposal: { command: '"/bin/rm" "a"', cwd: '/p', reason: 'x', risk } });
  it('marks loss-speaking host commands and paying or account-changing browser clicks, nothing else', () => {
    expect(highRiskApproval(command('삭제: 파일이 영구 제거될 수 있습니다. 임시 파일'))).toBe(true);
    expect(highRiskApproval(command('Overwrites the build output'))).toBe(true);
    expect(highRiskApproval(command('읽기만 합니다'))).toBe(false);
    expect(highRiskApproval(decision({ proposal: { url: 'https://example.test', element: { role: 'button', name: '결제' } } }))).toBe(true);
    expect(highRiskApproval(decision({ proposal: { url: 'https://example.test', itemTitle: '테스트 카드' } }))).toBe(true);
    expect(highRiskApproval(decision({ proposal: { url: 'https://example.test' } }))).toBe(false);
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

describe('autoSettleText', () => {
  const review = (patch: Record<string, unknown>) => ({ review: { recommend: 'answer', answer: 'PDF', expiresAt: 31 * 60_000, ...patch } });
  it('says when and to what an unanswered decision settles, only while it is pending', () => {
    const question = decision({ kind: 'question', options: ['PDF', 'HTML'], proposal: review({}) });
    expect(autoSettleText(question, 60_000)).toBe('답이 없으면 30분 뒤 「PDF」(으)로 답합니다.');
    expect(autoSettleText(question, 31 * 60_000)).toBe('답이 없으면 곧 「PDF」(으)로 답합니다.');
    expect(autoSettleText(decision({ kind: 'question', proposal: review({ expiresAt: 3 * 60 * 60_000 }) }), 0)).toBe('답이 없으면 3시간 뒤 「PDF」(으)로 답합니다.');
    expect(autoSettleText(decision({ proposal: { review: { recommend: 'approve', expiresAt: 10 * 60_000 } } }), 0)).toBe('답이 없으면 10분 뒤 추천대로 승인합니다.');
    expect(autoSettleText({ ...question, state: 'answered' }, 0)).toBeNull();
    expect(autoSettleText(decision({ kind: 'question' }), 0)).toBeNull();
    expect(autoSettleText(decision({ kind: 'question', proposal: review({ expiresAt: null }) }), 0)).toBeNull();
  });

  it('puts the recommended answer first and marks it', () => {
    const question = decision({ kind: 'question', options: ['HTML', 'PDF'], proposal: review({}) });
    expect(recommendedOption(question)).toBe('PDF');
    const markup = renderToStaticMarkup(createElement(HostProvider, null, createElement(DecisionCard, { decision: question, ghostName: '세이지', onResolved() {} })));
    expect(markup.indexOf('PDF')).toBeLessThan(markup.indexOf('HTML'));
    expect(markup).toContain('data-recommended="true"');
    expect(markup).toContain('추천');
  });

  it('shows the main Ghost\'s view on the card', () => {
    const markup = renderToStaticMarkup(createElement(HostProvider, null, createElement(DecisionCard, {
      decision: decision({ proposal: { command: 'x', risk: '읽기만 합니다', review: { recommend: 'approve', expiresAt: null, mainNote: '설정만 읽습니다.' } } }), ghostName: '세이지', onResolved() {},
    })));
    expect(markup).toContain('메인 의견');
    expect(markup).toContain('설정만 읽습니다.');
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

describe('readable cards', () => {
  const render = (node: Decision) => renderToStaticMarkup(createElement(HostProvider, null, createElement(DecisionCard, {
    decision: node, ghostName: '세이지', onResolved() {},
  })));

  it('drops a heading the detail repeats, so a question never prints twice', () => {
    const old = decision({ kind: 'question', title: '어느 쪽으로 할까요?', detail: '어느 쪽으로 할까요?\n\n- A는 빠릅니다' });
    expect(cardDetail(old, old.title, null)).toBe('- A는 빠릅니다');
    expect(cardDetail(decision({ title: '같음', detail: '같음' }), '같음', null)).toBe('');
  });

  it('renders the detail as Markdown, not raw marks', () => {
    const markup = render(decision({ kind: 'question', title: '고를까요?', detail: '**중요**\n\n- 하나\n- 둘' }));
    expect(markup).toContain('<strong>중요</strong>');
    expect(markup).toContain('<li>하나</li>');
    expect(markup).not.toContain('**');
  });

  it('folds an unknown proposal instead of printing JSON inline', () => {
    const markup = render(decision({ proposal: { workId: 'w1', action: { kind: 'mail_reply', body: '안녕' } } }));
    expect(markup).toContain('<details');
    expect(markup).toContain('요청 원문 보기');
  });

  it('shows a card fill as site and card, not its JSON', () => {
    const markup = render(decision({ detail: '사이트: https://shop.example', proposal: { url: 'https://shop.example/pay', origin: 'https://shop.example', itemTitle: '회사 카드', last4: '1234', input: {} } }));
    expect(markup).toContain('회사 카드 •••• 1234');
    expect(markup).not.toContain('decision__detail');
  });

  it('describes a standing activity proposal in words', () => {
    const config = { name: '메일 정리', prompt: 'p', acceptanceCriteria: 'c', ghostId: 'sage',
      source: { kind: 'schedule', spec: { kind: 'every', seconds: 3600 } }, execution: { kind: 'container' }, tools: ['read'],
      policy: { maxRunsPerDay: 5, maxConcurrent: 1, runTimeoutSeconds: 600, allowSelfCheck: false, minCheckSeconds: 3600, externalActions: 'approval', delivery: 'changes' } };
    const markup = render(decision({ proposal: { config } }));
    expect(markup).toContain('지켜볼 것');
    expect(markup).toContain('파일 읽기');
    expect(markup).toContain('하루 5회');
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

  it('renders a secure form with fields, origin, reason and the vault checkbox, and no chat answer', () => {
    const card = decision({ kind: 'question', title: '예시 로그인', detail: '로그인이 필요합니다.',
      proposal: { secureForm: loginRequest } });
    const markup = renderToStaticMarkup(createElement(HostProvider, null, createElement(DecisionCard, {
      decision: card, ghostName: '세이지', onResolved() {},
    })));
    expect(markup).toContain('금고 요청');
    expect(markup).toContain('https://app.example.com');
    expect(markup).toContain('사용자 이름');
    expect(markup).toContain('비밀번호');
    expect(markup).toContain('일회용 코드 시드');
    expect(markup).toContain('금고에 저장');
    expect(markup).toContain('금고에 전달');
    expect(markup).toContain('type="password"');
    // The chat answer path is gone from the card.
    expect(markup).not.toContain('답변을 적어 주세요');
    expect(markup).not.toContain('답변 보내기');
  });

  it('renders the handoff note with the url, a completion button and deny', () => {
    const card = decision({ kind: 'question', title: '화면 확인', proposal: { browserHandoff: { url: 'https://example.com/form', reason: '로그인 화면을 직접 확인해 주세요.' } } });
    const markup = renderToStaticMarkup(createElement(HostProvider, null, createElement(DecisionCard, {
      decision: card, ghostName: '세이지', onResolved() {},
    })));
    expect(markup).toContain('브라우저 대기');
    expect(markup).toContain('Chrome 창을 열어 두었습니다');
    expect(markup).toContain('https://example.com/form');
    expect(markup).toContain('다 했어요');
    expect(markup).toContain('거부');
    // The ordinary answer path stays available beside it.
    expect(markup).toContain('답변 보내기');
  });
});

describe('secureFormProposal and browserHandoffProposal', () => {
  it('reads the payloads only from pending-shape questions of the matching kind', () => {
    expect(secureFormProposal(decision())).toBeNull();
    expect(secureFormProposal(decision({ kind: 'question' }))).toBeNull();
    expect(secureFormProposal(decision({ kind: 'question', proposal: { secureForm: loginRequest } }))).toEqual(loginRequest);
    expect(secureFormProposal(decision({ kind: 'question', proposal: { secureForm: { kind: 'customer', reason: 'x' } } }))).toBeNull();
    expect(browserHandoffProposal(decision({ kind: 'question', proposal: { browserHandoff: { url: null, reason: '확인' } } })))
      .toEqual({ url: null, reason: '확인' });
    expect(browserHandoffProposal(decision())).toBeNull();
  });
});

describe('decisionChip', () => {
  it('reads the proposal shape for questions and the kind label otherwise', () => {
    expect(decisionChip(decision({ kind: 'question', proposal: { secureForm: loginRequest } }))).toBe('금고 요청');
    expect(decisionChip(decision({ kind: 'question', proposal: { browserHandoff: { url: null, reason: '확인' } } }))).toBe('브라우저 대기');
    expect(decisionChip(decision({ kind: 'question' }))).toBe('답변 대기');
    expect(decisionChip(decision())).toBe('실행 승인');
  });
});

describe('secureFormBody', () => {
  it('builds a login answer with kind, a verbatim password and an optional code seed', () => {
    const values = { ...emptySecureForm, username: ' owner@example.com ', password: ' secret pass ', totp: ' JBSW Y3DP ' };
    expect(secureFormBody(loginRequest, values, true)).toEqual({
      body: { kind: 'login', username: 'owner@example.com', password: ' secret pass ', totp: 'JBSW Y3DP', save: true },
    });
    expect(secureFormBody(loginRequest, { ...emptySecureForm, username: 'a', password: 'p' }, false))
      .toEqual({ body: { kind: 'login', username: 'a', password: 'p', save: false } });
  });

  it('carries a typed origin only when the request has none', () => {
    const noOrigin = { kind: 'login' as const, origin: null, title: '예시 로그인', reason: '로그인이 필요합니다.' };
    const values = { ...emptySecureForm, origin: ' https://new.example.com ', username: 'a', password: 'p' };
    expect(secureFormBody(noOrigin, values, true))
      .toEqual({ body: { kind: 'login', username: 'a', password: 'p', origin: 'https://new.example.com', save: true } });
    expect(secureFormBody(noOrigin, { ...values, origin: ' ' }, true)).toEqual({ error: 'https://로 시작하는 주소를 입력해 주세요.' });
    expect('body' in secureFormBody(loginRequest, values, true) && secureFormBody(loginRequest, values, true).body.origin).toBeUndefined();
  });

  it('refuses an incomplete login before anything reaches the wire', () => {
    expect(secureFormBody(loginRequest, { ...emptySecureForm, password: 'p' }, true)).toEqual({ error: '사용자 이름을 입력해 주세요.' });
    expect(secureFormBody(loginRequest, { ...emptySecureForm, username: 'a' }, true)).toEqual({ error: '비밀번호를 입력해 주세요.' });
  });

  it('builds card, contact and secret answers with kind and a required holder name', () => {
    const card = { kind: 'card' as const, origin: null, title: '업무 카드', reason: '결제가 필요합니다.' };
    expect(secureFormBody(card, { ...emptySecureForm, cardNumber: '4242 4242', cardExpiry: '12/28', cardCvc: '123', cardName: ' 홍 ' }, true))
      .toEqual({ body: { kind: 'card', card: { number: '4242 4242', expiry: '12/28', cvc: '123', name: '홍' }, save: true } });
    expect(secureFormBody(card, { ...emptySecureForm, cardNumber: '4242', cardExpiry: '12/28', cardCvc: '123' }, true))
      .toEqual({ error: '카드 번호와 유효기간, CVC, 이름을 입력해 주세요.' });
    const contact = { kind: 'contact' as const, origin: null, title: null, reason: '연락처가 필요합니다.' };
    expect(secureFormBody(contact, { ...emptySecureForm, contactName: '홍길동', contactEmail: ' h@e.com ' }, true))
      .toEqual({ body: { kind: 'contact', contact: { name: '홍길동', email: 'h@e.com' }, save: true } });
    expect(secureFormBody(contact, emptySecureForm, true)).toEqual({ error: '한 항목 이상 입력해 주세요.' });
    const secret = { kind: 'secret' as const, origin: null, title: null, reason: '키가 필요합니다.' };
    expect(secureFormBody(secret, { ...emptySecureForm, value: ' raw value ' }, false))
      .toEqual({ body: { kind: 'secret', value: ' raw value ', save: false } });
    expect(secureFormBody(secret, emptySecureForm, true)).toEqual({ error: '값을 입력해 주세요.' });
  });
});
