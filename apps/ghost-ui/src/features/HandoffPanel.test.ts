import { describe, expect, it } from 'vitest';
import type { BrowserLoginShelf, ShadeStatus } from '@ghost/contract';
import { handoffHost, savedLine, shadeHint } from './HandoffPanel';
import { shadeNextStep } from './ShadeSettings';

const status = (patch: Partial<ShadeStatus> = {}): ShadeStatus => ({ state: 'ready', writable: true, saveLogins: true, ...patch });
const shelf = (patch: Partial<BrowserLoginShelf> = {}): BrowserLoginShelf => ({
  origin: 'https://app.example.com', saved: null, items: [], shade: { status: status(), items: [] }, ...patch,
});
const saved = (patch: Partial<NonNullable<BrowserLoginShelf['saved']>> = {}): NonNullable<BrowserLoginShelf['saved']> => ({
  itemId: 'i1', username: 'owner@example.com', origin: 'https://app.example.com', at: 1, created: true, shade: false, ...patch,
});

describe('handoff login card', () => {
  it('names the host of the handoff page and tolerates text that is not a URL', () => {
    expect(handoffHost('https://app.example.com:8443/login?x=1')).toBe('app.example.com:8443');
    expect(handoffHost('Mac의 Chrome 창')).toBe('Mac의 Chrome 창');
  });

  it('tells a new save from a reuse, and says when Shade holds it too', () => {
    expect(savedLine(saved())).toBe('로그인 정보를 금고에 저장했어요 · owner@example.com');
    expect(savedLine(saved({ shade: true }))).toBe('로그인 정보를 금고에 저장했어요 · owner@example.com · Shade에도 저장');
    expect(savedLine(saved({ created: false }))).toBe('저장된 로그인으로 로그인했어요 · owner@example.com');
    expect(savedLine(saved({ username: '' }))).toContain('app.example.com');
  });

  it('explains Shade only when it is the reason nothing is offered', () => {
    expect(shadeHint(shelf({ shade: { status: status({ state: 'locked' }), items: [] } }))).toContain('잠금');
    expect(shadeHint(shelf({ shade: { status: status({ state: 'agent_off' }), items: [] } }))).toContain('에이전트 접근');
    expect(shadeHint(shelf({ shade: { status: status({ state: 'unavailable' }), items: [] } }))).toBeNull();
    expect(shadeHint(shelf())).toBeNull();
    expect(shadeHint(shelf({ items: [{ id: 'v', title: 't', username: 'u', hasPassword: true, hasTotp: false }], shade: { status: status({ state: 'locked' }), items: [] } }))).toBeNull();
  });

  it('points the settings row at the one step Shade still needs', () => {
    expect(shadeNextStep(status({ state: 'locked' }))).toContain('잠금');
    expect(shadeNextStep(status({ state: 'agent_off' }))).toContain('에이전트 접근');
    expect(shadeNextStep(status({ writable: false }))).toContain('에이전트 쓰기');
    expect(shadeNextStep(status())).toBeNull();
  });
});
