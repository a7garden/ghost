import { describe, expect, it } from 'vitest';
import type { State } from '@ghost/contract';
import { ghostAgenda } from './GhostAgenda';

const state = (patch: Partial<State>) => ({ schedules: [], activities: [], autonomy: [], ...patch }) as unknown as State;
const schedule = (id: string, nextAt: number | null, extra: Record<string, unknown> = {}) =>
  ({ id, ghostId: 'g1', conversationId: 'c', prompt: id, spec: { kind: 'at', at: nextAt ?? 0 }, nextAt, state: 'active', createdAt: 0, ...extra });

describe('ghostAgenda', () => {
  it('lists this Ghost’s schedules, activities and own plan soonest first, paused last, finished and others left out', () => {
    const items = ghostAgenda(state({
      schedules: [schedule('late', 300), schedule('soon', 100), schedule('paused', 50, { state: 'paused' }), schedule('done', 10, { state: 'done' }), schedule('other', 20, { ghostId: 'g2' })],
      activities: [{ id: 'a1', ghostId: 'g1', name: 'PR 살피기', paused: false, nextAt: 200, deletedAt: null }, { id: 'a2', ghostId: 'g1', name: '지움', paused: false, nextAt: 1, deletedAt: 5 }],
      autonomy: [{ ghostId: 'g1', enabled: true, nextAt: 150, intent: '다시 본다', setBy: 'self', watch: [], lastWakeAt: null, wakesToday: 0 }],
    } as never), 'g1');
    expect(items.map(item => item.id)).toEqual(['soon', 'plan:g1', 'a1', 'late', 'paused']);
  });

  it('leaves out the own look when the drive is off', () => {
    const items = ghostAgenda(state({ autonomy: [{ ghostId: 'g1', enabled: false, nextAt: 150, intent: '', setBy: 'host', watch: [], lastWakeAt: null, wakesToday: 0 }] } as never), 'g1');
    expect(items).toEqual([]);
  });
});

it('inside a project the agenda keeps only that project’s activities', () => {
  const items = ghostAgenda(state({
    schedules: [schedule('mine', 100)],
    activities: [{ id: 'in', ghostId: 'g1', scopeId: 's1', name: '이 프로젝트', paused: false, nextAt: 200, deletedAt: null }, { id: 'out', ghostId: 'g1', scopeId: 's2', name: '다른 프로젝트', paused: false, nextAt: 100, deletedAt: null }, { id: 'none', ghostId: 'g1', scopeId: null, name: '프로젝트 없음', paused: false, nextAt: 50, deletedAt: null }],
    autonomy: [{ ghostId: 'g1', enabled: true, nextAt: 10, intent: '', setBy: 'self', watch: [], lastWakeAt: null, wakesToday: 0 }],
  } as never), 'g1', 's1');
  expect(items.map(item => item.id)).toEqual(['in']);
});
