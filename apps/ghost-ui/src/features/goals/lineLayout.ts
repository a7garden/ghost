import type { Milestone, Work } from '@ghost/contract';

export const milestoneLabels: Record<Milestone['state'], string> = {
  active: '진행 중', planned: '예정', done: '완료', dropped: '접음',
};
export type GoalLineNode = { milestone: Milestone; phase: 'past' | 'now' | 'next' | 'later'; working: boolean };
export type GoalLineColumn = { phase: GoalLineNode['phase']; fork: boolean; nodes: GoalLineNode[] };

/** Chronology is independent of ledger arrival order; concurrent active steps share one column. */
export function goalLine(milestones: readonly Milestone[], works: readonly Work[]): GoalLineColumn[] {
  const working = new Set(works.filter(work => work.state === 'running' || work.state === 'verifying').map(work => work.id));
  const node = (milestone: Milestone, phase: GoalLineNode['phase']): GoalLineNode => ({
    milestone, phase, working: milestone.state === 'active' && milestone.workIds.some(id => working.has(id)),
  });
  const chronological = (a: Milestone, b: Milestone) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  const past = milestones.filter(item => item.state === 'done' || item.state === 'dropped')
    .sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt) || chronological(a, b));
  const active = milestones.filter(item => item.state === 'active').sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt) || chronological(a, b));
  const planned = milestones.filter(item => item.state === 'planned').sort(chronological);
  return [
    ...past.map(item => ({ phase: 'past' as const, fork: false, nodes: [node(item, 'past')] })),
    ...(active.length ? [{ phase: 'now' as const, fork: active.length === 2, nodes: active.map(item => node(item, 'now')) }] : []),
    ...planned.map((item, index) => {
      const phase = index < 2 ? 'next' as const : 'later' as const;
      return { phase, fork: false, nodes: [node(item, phase)] };
    }),
  ];
}
