import { describe, expect, it } from 'vitest';
import type { ConfigRevision, PolicyRule } from '@ghost/contract';
import { describeRule, isSystemRule } from './policyText';
import { revisionChanges, revisionSentence } from './configText';

const rule = (extra: Partial<PolicyRule>): PolicyRule => ({ id: 'r1', tool: '*', when: {}, decision: 'owner', revision: 1, createdBy: { kind: 'owner' }, ...extra });
const revision = (extra: Partial<ConfigRevision>): ConfigRevision => ({ id: 'v1', entity: 'scope', entityId: 's1', before: null, after: null, actor: { kind: 'owner', id: null }, reason: 'scope.create', at: 0, ...extra });

describe('describeRule', () => {
  it('reads a built-in rule as plain words, never as identifiers', () => {
    const text = describeRule(rule({ tool: 'browser_click', when: { reversible: false }, decision: 'deny', createdBy: { kind: 'install' } }), null);
    expect(text.subject).toBe('브라우저 클릭');
    expect(text.conditions).toEqual(['되돌릴 수 없는 일']);
    expect(text.outcome).toBe('막기');
    expect(text.reach).toBe('모든 Ghost · 모든 프로젝트');
  });

  it('names who looks first and what happens on silence', () => {
    const text = describeRule(rule({ tool: 'mail_send', decision: 'owner', reviewer: { kind: 'main' }, maxPerDay: 5, autoResolve: { afterMinutes: 90, answer: 'recommended' } }), null);
    expect(text.outcome).toBe('메인 Ghost가 먼저 보고 내가 확인');
    expect(text.extras).toEqual(['하루 5번까지만', '90분 안에 답이 없으면 추천대로 진행']);
  });

  it('keeps a pattern the owner typed as written', () => {
    expect(describeRule(rule({ tool: 'mcp.ui-smoke.*' }), null).subject).toBe('외부 도구 ui-smoke.*');
    expect(describeRule(rule({ tool: 'something_new' }), null).subject).toBe('something_new');
  });

  it('separates the Host-written rules from the owner’s', () => {
    expect(isSystemRule(rule({ createdBy: { kind: 'install' } }))).toBe(true);
    expect(isSystemRule(rule({ id: 'activity:a1:action' }))).toBe(true);
    expect(isSystemRule(rule({}))).toBe(false);
  });
});

describe('config history wording', () => {
  it('says who did what instead of showing the command', () => {
    const sentence = revisionSentence(revision({ after: { name: '비행 기록' } }), null);
    expect(sentence).toContain('비행 기록');
    expect(sentence).toContain('만들었습니다');
    expect(sentence).not.toContain('scope.create');
  });

  it('reads a revert and an unknown command neutrally', () => {
    expect(revisionSentence(revision({ reason: 'config.revert:v0' }), null)).toContain('되돌렸습니다');
    expect(revisionSentence(revision({ reason: 'something.else' }), null)).toContain('바꿨습니다');
  });

  it('lists changed fields as before and after, and a creation as new', () => {
    const edited = revisionChanges(revision({ reason: 'scope.update', before: { name: '가' }, after: { name: '나' } }), null);
    expect(edited.created).toBe(false);
    expect(edited.lines).toEqual([{ label: '이름', before: '가', after: '나' }]);
    expect(revisionChanges(revision({ after: { name: '가' } }), null).created).toBe(true);
  });
});
