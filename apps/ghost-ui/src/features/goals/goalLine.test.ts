import { describe, expect, it } from 'vitest';
import type { Milestone, Work } from '@ghost/contract';
import { goalLine } from './lineLayout';
import { goalError } from './goalError';
import { HostError } from '../../host/client';

const milestone = (id: string, patch: Partial<Milestone> = {}): Milestone => ({
  id, scopeId: null, goalId: 'g1', title: id, hypothesis: '', exit: '', outcome: '', state: 'planned', workIds: [],
  createdBy: 'sage', settledBy: null, createdAt: 1, startedAt: null, endedAt: null, ...patch,
});
const work = (id: string, state: Work['state']): Work => ({
  id, state, parentId: null, rootId: id, ghostId: 'sage', originConversationId: 'c1', conversationId: null,
  title: id, brief: '', acceptance: { criteria: '', checks: [], reviewer: null }, revision: 1, revisionsUsed: 0,
  deadlineAt: null, scopeId: null, attachments: [], slot: null, retry: null, budgetMinutes: 90, budgetUsedMs: 0, budgetSince: null, budgetExtended: false, hold: null, result: null, verdict: null, reason: null, createdAt: 1, updatedAt: 1, startedAt: null, endedAt: null,
});

describe('goalLine', () => {
  it('orders ended by end time, forks concurrent active steps and splits the first two plans from later', () => {
    const columns = goalLine([
      milestone('later', { createdAt: 30 }), milestone('active-b', { state: 'active', startedAt: 20 }),
      milestone('dropped', { state: 'dropped', createdAt: 0, endedAt: 9 }),
      milestone('next-b', { createdAt: 20 }), milestone('done', { state: 'done', createdAt: 2, endedAt: 5 }),
      milestone('next-a', { createdAt: 10 }), milestone('active-a', { state: 'active', startedAt: 10 }),
      milestone('later-b', { createdAt: 40 }),
    ], []);
    expect(columns.map(column => [column.phase, column.fork, column.nodes.map(node => node.milestone.id)])).toEqual([
      ['past', false, ['done']], ['past', false, ['dropped']], ['now', true, ['active-a', 'active-b']],
      ['next', false, ['next-a']], ['next', false, ['next-b']], ['later', false, ['later']], ['later', false, ['later-b']],
    ]);
  });

  it('signals only active milestones with a running or verifying linked Work', () => {
    const works = [work('run', 'running'), work('verify', 'verifying'), work('wait', 'waiting'), work('done', 'done')];
    for (const [workId, expected] of [['run', true], ['verify', true], ['wait', false], ['done', false], ['missing', false]] as const) {
      const columns = goalLine([milestone('a', { state: 'active', workIds: [workId] })], works);
      expect(columns[0].nodes[0].working).toBe(expected);
      expect(columns[0].fork).toBe(false);
    }
    expect(goalLine([milestone('p', { workIds: ['run'] })], works)[0].nodes[0].working).toBe(false);
    expect(goalLine([milestone('d', { state: 'done', workIds: ['run'] })], works)[0].nodes[0].working).toBe(false);
    expect(goalLine([], works)).toEqual([]);
  });

  it('does not reorder the supplied snapshot and resolves equal timestamps consistently', () => {
    const input = [milestone('b'), milestone('a')];
    expect(goalLine(input, []).map(column => column.nodes[0].milestone.id)).toEqual(['a', 'b']);
    expect(input.map(item => item.id)).toEqual(['b', 'a']);
  });
});

it('translates conflict without inventing its cause or exposing English host errors', () => {
  const text = goalError(new HostError('conflict', 'cap exceeded'));
  expect(text).toContain('현재 상태');
  expect(text).not.toContain('cap');
  expect(text).not.toContain('3개');
  expect(goalError(new Error('technical detail'))).not.toContain('technical');
});
