import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { VoicePanel } from './VoicePanel';
import type { VoiceCall } from './VoicePanel';
import type { VoiceState } from './controller';

function render(phase: VoiceState['phase'], collapsed = false, attempted = true) {
  const active = !['idle', 'connecting', 'error'].includes(phase);
  const call: VoiceCall = { state: { phase, active, speaking: phase === 'speaking', muted: phase === 'muted', capturing: active, transcript: '', error: phase === 'error' ? '로컬 서버 연결 실패' : '', pendingTurns: 0, runningTasks: 1 }, attempted, start: () => {}, end: () => {}, mute: () => {}, cancelWork: () => {} };
  return renderToStaticMarkup(createElement(VoicePanel, { call, profileName: 'Ghost', enabled: true, runningTasks: 1, collapsed, onCollapse: () => {}, onDismiss: () => {} }));
}
it('shows connecting, listening, thinking and actual playback statuses', () => {
  for (const [phase, label] of [['connecting', '연결 중…'], ['listening', '듣고 있어요'], ['working', '생각 중…'], ['speaking', '말하는 중…']] as const) {
    const html = render(phase); expect(html).toContain('전화 중'); expect(html).toContain(label);
  }
});
it('keeps an explicit end control when collapsed and separates work cancellation', () => {
  const collapsed = render('listening', true), expanded = render('listening');
  expect(collapsed).toContain('통화 종료'); expect(collapsed).not.toContain('음성 통화 카드 닫기');
  expect(expanded).toContain('작업 취소'); expect(expanded).toContain('통화 종료');
});
it('requires an explicit start, exposes retry errors, and lets an ended card restart or dismiss', () => {
  expect(render('idle', false, false)).toContain('통화 시작');
  expect(render('error')).toContain('로컬 서버 연결 실패'); expect(render('error')).toContain('다시 연결');
  expect(render('idle')).toContain('통화 종료됨'); expect(render('idle')).toContain('다시 통화'); expect(render('idle')).toContain('음성 통화 카드 닫기');
});
