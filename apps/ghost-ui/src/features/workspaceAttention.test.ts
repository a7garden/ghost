import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { initialWorkspace } from '../fixtures/workspace';
import { inboxItems } from '../client/inbox';
import { normalizeRoutingResults } from '../client/routingResults';
import { InboxView } from './WorkViews';
import { Overview } from './Overview';

function workspace() {
  const snapshot = initialWorkspace();
  snapshot.profiles.forEach(p => p.conversations.forEach(c => { c.tasks = []; }));
  snapshot.reviews = [];
  return snapshot;
}
const callbacks = { navigate: () => {}, onReview: () => {}, onAdd: () => {}, onAssign: () => {} };

it('counts exactly the review and task items shown in the inbox, including a failure without reviews', () => {
  const snapshot = workspace(), conversation = snapshot.profiles[0].conversations[0];
  conversation.tasks.push({ id: 'failure', name: '응답 생성', phase: 'failed', partial: '', output: 'model interrupted or rejected; credentials and raw transport errors omitted' });
  const overview = renderToStaticMarkup(createElement(Overview, { snapshot, mode: 'live', ...callbacks }));
  const inbox = renderToStaticMarkup(createElement(InboxView, { snapshot, ...callbacks }));
  expect(overview).toContain('확인 필요 1');
  expect(inbox.match(/class="inbox-item"/g)).toHaveLength(1);
  expect(inbox).not.toContain('확인이 필요한 항목 없음');
  expect(inbox).toContain('두 원인을 구분할 수 없습니다');
  expect(inbox).toContain('<summary>실행 기록</summary>');
  expect(inbox).toContain(conversation.tasks[0].output);
  expect(inbox).toContain('모델 설정');
});

it('shows an owner wait once when a document review already represents it, but retains other failures', () => {
  const snapshot = workspace(), profile = snapshot.profiles[0], conversation = profile.conversations[0];
  snapshot.reviews.push({ id: 'review', profile_id: profile.id, conversation_id: conversation.id, title: '검토 요청', body: '', state: 'approved', space_id: '' });
  conversation.tasks = ['waiting_owner', 'failed', 'uncertain', 'complete', 'cancelled'].map(phase => ({ id: phase, name: phase, phase, partial: '', output: '' }));
  const other = snapshot.profiles[1].conversations[0];
  other.tasks.push({ id: 'waiting', name: '확인 요청', phase: 'waiting_owner', partial: '', output: '' });
  const html = renderToStaticMarkup(createElement(InboxView, { snapshot, ...callbacks }));
  expect(inboxItems(snapshot).count).toBe(4);
  expect(html.match(/class="inbox-item"/g)).toHaveLength(4);
  expect(html).toContain('다시 요청하기 전에');
  expect(html).toContain('작업이 확인을 기다리고 있습니다');
});

it('counts completion results only when the inbox can display them', () => {
  const snapshot = workspace();
  snapshot.routing_results = normalizeRoutingResults({ results: [], completion_outbox: [{
    schema: 1, id: 'result', work_id: 'work', work_revision: 1, decision_revision: 1, intent_id: 'intent',
    profile_id: snapshot.profiles[0].id, conversation_id: 'entry', task_id: null, status: 'uncertain',
    current: true, verified: false, summary: '', model_output: null, receipts: [], artifacts: [],
    source_admission_id: 'admission', source_fragments: [], updated_ms: 1,
  }] });
  expect(inboxItems(snapshot).count).toBe(0);
  snapshot.capabilities.routing = { runtime_dispatch: true };
  expect(inboxItems(snapshot).count).toBe(1);
  expect(renderToStaticMarkup(createElement(InboxView, { snapshot, ...callbacks }))).toContain('data-completion-result="result"');
  expect(inboxItems(snapshot, false).count).toBe(0);
  expect(renderToStaticMarkup(createElement(InboxView, { snapshot, connected: false, ...callbacks }))).toContain('확인이 필요한 항목 없음');
});


it('keeps overview search available and only allocates the activity rail for running tasks', () => {
  const snapshot = workspace();
  const render = () => renderToStaticMarkup(createElement(Overview, { snapshot, mode: 'live', ...callbacks }));
  const idle = render();
  expect(idle).toContain('aria-label="Ghost 이름 또는 역할 검색"');
  expect(idle).not.toContain('class="work-section"');
  snapshot.profiles[0].conversations[0].tasks.push({ id: 'running', name: '자료 찾기', phase: 'model_running', partial: '', output: '' });
  expect(render()).toContain('class="work-section"');
  expect(render()).toContain('자료 찾기');
});
