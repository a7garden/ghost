import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { DotDetail } from './DotDetail';
import { ConversationContext } from './ConversationContext';
import { initialWorkspace } from '../fixtures/workspace';
import type { Snapshot } from '../client/types';

afterEach(() => vi.unstubAllGlobals());
function emptyWorkspace() {
  const snapshot = initialWorkspace(), profile = snapshot.profiles[0];
  snapshot.reviews = []; snapshot.goals = []; snapshot.spaces = []; snapshot.schedules = []; snapshot.delegations = []; snapshot.connectors.computer = false;
  profile.conversations = [{ id: 'test-chat', title: '테스트 대화', model: 'mock', selected_model: 'mock', model_available: true, offline: true, messages: [], tasks: [] }];
  return snapshot;
}
function renderChat(snapshot: Snapshot, wide = true) {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: wide, addListener() {}, removeListener() {} }), addEventListener() {}, removeEventListener() {} });
  const profile = snapshot.profiles[0];
  return renderToStaticMarkup(createElement(DotDetail, { profile, snapshot, mode: 'demo', action: async () => ({}), busy: false, connected: true, navigate: () => {}, route: `/ghosts/${profile.id}`, onReview: () => {} }));
}
it('shows the large introduction only in an empty thread and omits an empty right rail', () => {
  const snapshot = emptyWorkspace();
  const empty = renderChat(snapshot);
  expect(empty).toContain('dot-introduction'); expect(empty).toContain('prompt-suggestions'); expect(empty).not.toContain('<aside');
  snapshot.profiles[0].conversations[0].messages.push({ role: 'user', text: '안녕하세요' });
  const active = renderChat(snapshot);
  expect(active).not.toContain('dot-introduction'); expect(active).not.toContain('prompt-suggestions'); expect(active).toContain('안녕하세요');
  expect(active).toContain('이 대화의 모델'); expect(active).toContain('작업과 자료 보기');
});
it('places populated cards in a desktop deck and exposes them through the drawer button at narrow widths', () => {
  const snapshot = emptyWorkspace();
  snapshot.profiles[0].conversations[0].tasks.push({ id: 'task', name: '진행하는 일', phase: 'model_running', partial: '', output: '' });
  const desktop = renderChat(snapshot), narrow = renderChat(snapshot, false);
  expect(desktop).toContain('context-deck'); expect(desktop).toContain('진행하는 일');
  expect(desktop.match(/context-profile-card/g)).toHaveLength(1); expect(desktop).not.toContain('class="context-card '); expect(desktop).not.toContain('context-panel'); expect(desktop).not.toContain('context-stack-heading');
  expect(narrow).not.toContain('<aside'); expect(narrow).toContain('작업과 자료 보기 · 1개 항목');
  expect(narrow).not.toContain('dot-introduction');
});
it('keeps manually requested task history, reservation and tools management available', () => {
  const snapshot = emptyWorkspace(), profile = snapshot.profiles[0];
  profile.conversations[0].tasks.push({ id: 'past', name: '완료한 일', phase: 'complete', partial: '', output: '' });
  const common = { profile, snapshot, conversation: profile.conversations[0], busy: false, connected: true, navigate: () => {}, onReview: () => {}, onCancel: () => {}, onSchedule: () => {}, disclosure: {}, onDisclosure: () => {} };
  const automatic = renderToStaticMarkup(createElement(ConversationContext, common));
  const manual = renderToStaticMarkup(createElement(ConversationContext, { ...common, management: true }));
  expect(automatic).toContain('context-profile-card'); expect(automatic).not.toContain('class="context-card '); expect(automatic).toContain('연결된 실행 환경 없음'); expect(manual).toContain('완료한 일'); expect(manual).toContain('예약'); expect(manual).toContain('도구 연결');
});
it('respects a collapsed category across snapshots instead of reopening for a review count change', () => {
  const snapshot = emptyWorkspace(), profile = snapshot.profiles[0], conversation = profile.conversations[0];
  snapshot.reviews.push({ id: 'one', profile_id: profile.id, conversation_id: conversation.id, title: '검토', body: '', state: 'pending', space_id: '' });
  const render = () => renderToStaticMarkup(createElement(ConversationContext, { profile, snapshot, conversation, busy: false, connected: true, navigate: () => {}, onReview: () => {}, onCancel: () => {}, onSchedule: () => {}, disclosure: { reviews: false }, onDisclosure: () => {} }));
  expect(render()).toContain('aria-expanded="false"');
  snapshot.reviews.push({ ...snapshot.reviews[0], id: 'two' });
  expect(render()).toContain('aria-expanded="false"'); expect(render()).toContain('context-card-count">2');
});

it('names simultaneous responses and queued work instead of repeating an anonymous thinking block', () => {
  const snapshot = emptyWorkspace();
  snapshot.profiles[0].conversations[0].tasks = [
    { id: 'first', name: '자료 비교', phase: 'model_running', partial: '비교 초안', output: '' },
    { id: 'second', name: '출처 확인', phase: 'model_running', partial: '', output: '' },
    { id: 'queued', name: '정리본 저장', phase: 'queued', partial: '', output: '' },
  ];
  const html = renderChat(snapshot, false);
  expect(html).toContain(`aria-label="${snapshot.profiles[0].name} · 자료 비교 · 생각하는 중"`);
  expect(html).toContain(`aria-label="${snapshot.profiles[0].name} · 출처 확인 · 생각하는 중"`);
  expect(html).toContain('비교 초안');
  expect(html).toContain('<strong>정리본 저장</strong><span>대기 중</span>');
  expect(html).not.toContain('작업 진행 중');
});

it('keeps the Ghost identity visible in the conversation header at narrow widths', () => {
  const snapshot = emptyWorkspace(); snapshot.profiles[0].name = 'Research Ghost';
  const html = renderChat(snapshot, false);
  expect(html).toContain('<span class="conversation-profile-name">Research Ghost</span>');
  expect(html).toContain('테스트 대화 · Research Ghost 대화 이력');
  expect(html).toContain('이 대화의 모델</label>'); expect(html).toContain('role="combobox"');
});
