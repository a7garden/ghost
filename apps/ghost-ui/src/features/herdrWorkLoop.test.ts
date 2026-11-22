import { describe, expect, it } from 'vitest';
import type { HerdrPaneView, HerdrView, OmpInfo } from '@ghost/contract';
import { buildAgentArgs, defaultAgentOptions } from './herdrAgentArgs';
import { blockedAgentCount } from './herdrAttention';
import { changeStatus, diffLines } from './herdrChangesDisplay';
import { modifiedTerminalKey } from './herdrMobileInput';

const cwd = '/dev/app';
const info: OmpInfo = {
  models: [{ selector: 'maze/model', name: 'Maze', provider: 'Maze', thinking: ['low', 'high'] }],
  sessions: [{ id: 's1', title: '로그인', updatedAt: 10 }],
};

describe('agent arguments', () => {
  it('uses the selected conversation, model-supported thinking level and approval mode', () => {
    const options = { ...defaultAgentOptions, conversation: 'pick', directory: cwd, session: 's1', model: 'maze/model', thinking: 'high', approval: 'write' } as const;
    expect(buildAgentArgs('omp', options, cwd, info)).toEqual(['--resume', 's1', '--model', 'maze/model', '--thinking', 'high', '--approval-mode', 'write']);
    expect(buildAgentArgs('omp', options, '/dev/another', info)).not.toContain('--resume');
    expect(buildAgentArgs('omp', { ...options, session: 'not-offered', thinking: 'low' }, cwd, info)).not.toContain('--resume');
    expect(buildAgentArgs('omp', { ...options, model: 'gone' }, cwd, info)).toEqual(['--resume', 's1', '--approval-mode', 'write']);
    expect(buildAgentArgs('omp', { ...options, thinking: 'medium' }, cwd, info)).not.toContain('--thinking');
  });
  it('gates yolo on explicit confirmation and keeps Claude options limited to continue', () => {
    const options = { ...defaultAgentOptions, conversation: 'continue', session: 's1', model: 'maze/model', approval: 'yolo' } as const;
    expect(buildAgentArgs('omp', options, cwd, info)).toEqual(['--continue', '--model', 'maze/model']);
    expect(buildAgentArgs('omp', options, cwd, info, true)).toEqual(['--continue', '--model', 'maze/model', '--approval-mode', 'yolo']);
    expect(buildAgentArgs('claude', options, cwd, info, true)).toEqual(['--continue']);
    expect(buildAgentArgs('codex', options, cwd, info, true)).toEqual([]);
    expect(buildAgentArgs(undefined, options, cwd, info, true)).toEqual([]);
  });
});

it('maps one sticky printable terminal key without consuming Korean or pasted strings', () => {
  expect(modifiedTerminalKey('d', { ctrl: true, alt: false })).toBe('\x04');
  expect(modifiedTerminalKey('[', { ctrl: true, alt: false })).toBe('\x1b');
  expect(modifiedTerminalKey('k', { ctrl: false, alt: true })).toBe('\x1bk');
  expect(modifiedTerminalKey('C', { ctrl: true, alt: true })).toBe('\x1b\x03');
  for (const text of ['가', 'pwd', '\x1b[A', 'ArrowUp', '😀']) expect(modifiedTerminalKey(text, { ctrl: true, alt: true })).toBeNull();
});

it('distinguishes diff metadata and hunk rows from source lines starting with extra +/-', () => {
  const lines = diffLines('diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n---literal\n+++literal\n same\n\\ No newline at end of file');
  expect(lines.map(line => line.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'deletion', 'addition', 'context', 'meta']);
  expect(lines[5]?.text).toBe('+++literal');
  expect(Object.values(changeStatus).map(item => [item.mark, item.label])).toEqual([
    ['A', '추가'], ['M', '수정'], ['D', '삭제'], ['R', '이름 변경'], ['?', '추적 안 됨'],
  ]);
});

it('counts blocked live agents only, across every workspace and tab', () => {
  const pane: HerdrPaneView = { id: 'w1:p1', workspaceId: 'w1', tabId: 'w1:t1', workspace: 'app', tab: 'main', agent: 'omp', status: 'blocked', cwd, title: 'login', focused: true, owned: false };
  const view: HerdrView = { available: true, note: null, session: 'default', workspaces: [
    { id: 'w1', label: 'app', status: 'blocked', worktree: null, tabs: [
      { id: 'w1:t1', label: 'main', status: 'blocked', panes: [pane, { ...pane, id: 'w1:p2', agent: null }, { ...pane, id: 'w1:p3', status: 'working' }] },
    ] },
    { id: 'w2', label: 'other', status: 'blocked', worktree: null, tabs: [
      { id: 'w2:t1', label: 'dev', status: 'blocked', panes: [{ ...pane, id: 'w2:p1', agent: 'Claude Code' }] },
    ] },
  ] };
  expect(blockedAgentCount(view)).toBe(2);
  expect(blockedAgentCount({ ...view, note: 'offline' })).toBe(0);
  expect(blockedAgentCount({ ...view, available: false })).toBe(0);
  expect(blockedAgentCount(null)).toBe(0);
});
