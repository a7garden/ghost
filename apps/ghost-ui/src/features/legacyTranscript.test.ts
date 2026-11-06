import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { LegacyTranscript, legacyHistoryPath, legacyHistoryRequested } from './LegacyTranscript';
import type { Profile } from '../client/types';

const profile: Profile = { id: 'original-legacy-uuid', name: '원래 Ghost', persona: '기존 원문', policy: { external_worker: true }, conversations: [
  { id: 'original-conversation', title: '기존 대화', model: 'legacy', offline: true, messages: [{ role: 'user', text: '원래 사용자 입력' }, { role: 'assistant', text: '보존된 결과 원문' }], tasks: [{ id: 'original-work', name: '과거 작업', phase: 'complete', output: '원래 산출물', partial: '' }] },
] };
it('keeps original identities and transcript reachable without any registry or managed-name inference', () => {
  const path = legacyHistoryPath(profile.id, profile.conversations[0]!.id);
  expect(path).toBe('/ghosts/original-legacy-uuid?history=1&conversation=original-conversation');
  expect(legacyHistoryRequested(path)).toBe(true);
  expect(legacyHistoryRequested('/ghosts/bot-looking-name')).toBe(false);
  const html = renderToStaticMarkup(createElement(LegacyTranscript, { profile, route: path, navigate: () => {} }));
  for (const text of ['원래 사용자 입력', '보존된 결과 원문', '과거 작업 · 기록된 상태: complete', '대화로 돌아가기']) expect(html).toContain(text);
  expect(html).toContain('aria-haspopup="dialog"');
  for (const action of ['OMP', '만들기', '메시지 보내기', '설정 저장', '<textarea', '<form']) expect(html).not.toContain(action);
});
it('does not substitute another transcript when an explicit original conversation is absent', () => {
  const html = renderToStaticMarkup(createElement(LegacyTranscript, { profile, route: legacyHistoryPath(profile.id, 'different-conversation'), navigate: () => {} }));
  expect(html).toContain('해당 대화 기록을 찾을 수 없습니다');
  expect(html).not.toContain('보존된 결과 원문');
});
