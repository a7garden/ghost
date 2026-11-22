import { describe, expect, it } from 'vitest';
import type { HerdrChat, HerdrChatItem, HerdrPaneView, HerdrWorkspaceView } from '@ghost/contract';
import { agentGroups, choiceVariant, elapsedLabel, foldChat, groupAgents, isUnread, mergeChat, stepLines, trackActivity } from './herdrInboxModel';

const pane: HerdrPaneView = { id: 'w1:p1', workspaceId: 'w1', tabId: 'w1:t1', workspace: 'ghost', tab: 'coding', agent: 'omp', status: 'working', cwd: '/dev/trees/coding', title: '코딩 화면', focused: true, owned: false };
const tree = (...panes: HerdrPaneView[]): HerdrWorkspaceView[] => [
  { id: 'w1', label: 'ghost', status: 'blocked', worktree: { branch: 'coding-ui', path: '/dev/trees/coding' }, tabs: [
    { id: 'w1:t1', label: 'coding', status: 'blocked', panes },
  ] },
];

describe('Coding inbox', () => {
  it('shows attention, working, unread, then idle, with recent changes first within each group', () => {
    const blocked = { ...pane, id: 'w1:p2', status: 'blocked' } as const;
    const another = { ...blocked, id: 'w1:p3' };
    const idle = { ...pane, id: 'w1:p4', status: 'idle' } as const;
    const finished = { ...pane, id: 'w1:p5', status: 'done' } as const;
    const prior = trackActivity({}, tree(pane, blocked), null, 100);
    const current = tree(pane, blocked, another, idle, finished, { ...pane, id: 'w1:p6', agent: null });
    const groups = groupAgents(current, trackActivity(prior, current, null, 200), null);
    expect(agentGroups.flatMap(group => groups[group].map(row => row.pane.id))).toEqual(['w1:p3', 'w1:p2', 'w1:p1', 'w1:p5', 'w1:p4']);
    expect(groups.working[0]?.location).toBe('ghost · coding-ui');
  });

  it('marks each completion once, persists reading and does not mark the open pane unread', () => {
    const working = trackActivity({}, tree(pane), null, 100);
    const done = { ...pane, status: 'done' } as const;
    const finished = trackActivity(working, tree(done), null, 200);
    expect(isUnread(done, finished[done.id], null)).toBe(true);
    expect(isUnread(done, finished[done.id], pane.id)).toBe(false);
    const opened = trackActivity(finished, tree(done), pane.id, 300);
    const reloaded = trackActivity(JSON.parse(JSON.stringify(opened)), tree(done), null, 400);
    expect(isUnread(done, reloaded[done.id], null)).toBe(false);
    expect(isUnread(done, trackActivity(trackActivity(reloaded, tree(pane), null, 500), tree(done), null, 600)[done.id], null)).toBe(true);
  });

  it('only marks approval as primary and reserves the destructive outline styling for denial', () => {
    expect(choiceVariant).toEqual({ approve: 'default', trust: 'secondary', deny: 'outline', neutral: 'outline' });
    expect(elapsedLabel(1000, 181_000)).toBe('3분');
  });
});

describe('Coding transcript', () => {
  const user = { kind: 'user', id: 'u1', at: 100, text: '수정해 주세요' } as const;
  const thinking = { kind: 'thinking', id: 't1', at: 200 } as const;
  const call = { kind: 'tool', id: 'tool1', at: 300, name: 'edit', ok: null, summary: 'file.ts' } as const;
  const agent = { kind: 'agent', id: 'a1', at: 2000, text: '고쳤습니다' } as const;
  const note = { kind: 'note', id: 'n1', at: null, text: '이전 대화' } as const;
  const delta = (items: HerdrChatItem[], reset = false): HerdrChat => ({ pane: pane.id, source: 'omp', cursor: '1839', title: null, items, reset });
  it('replaces existing ids even after later messages, and replaces the entire transcript on reset', () => {
    const updated = { ...call, ok: false };
    const existing = [user, thinking, call, agent];
    expect(mergeChat(existing, delta([updated, note]))).toEqual([user, thinking, updated, agent, note]);
    expect(mergeChat(existing, delta([note], true))).toEqual([note]);
    expect(mergeChat(existing, delta([]))).toBe(existing);
  });
  it('keeps actions taken after a reply below that reply', () => {
    const extra = { ...call, id: 'tool2', at: 3000 };
    const final = { ...agent, id: 'a2', at: 4000 };
    const rows = foldChat([user, thinking, call, agent, extra, final, note, { ...thinking, id: 't2' }]);
    expect(rows.map(row => row.kind)).toEqual(['user', 'steps', 'agent', 'steps', 'agent', 'note', 'steps']);
    expect(rows[1]).toMatchObject({ steps: [thinking, call], from: 100, to: 2000 });
    expect(rows[3]).toMatchObject({ steps: [extra], from: 2000, to: 4000 });
  });
  it('counts consecutive steps that read the same into one line, and never folds a failure into successes', () => {
    const think = (id: string) => ({ kind: 'thinking', id, at: 1 } as const);
    const run = (id: string, ok: boolean | null, summary = 'bun test', name = 'bash') =>
      ({ kind: 'tool', id, at: 2, name, summary, ok } as const);
    const lines = stepLines([think('t1'), think('t2'), run('a', true), run('b', true), run('c', false),
      run('d', null), run('e', true), run('f', true, 'file.ts', 'read'), run('g', true, 'file.ts', 'edit')]);
    expect(lines.map(({ step, count }) => [step.id, count])).toEqual([
      ['t1', 2], ['a', 2], ['c', 1], ['d', 1], ['e', 1], ['f', 1], ['g', 1],
    ]);
  });
});
