import type { Snapshot, Delegation, DotState } from './types';
import { isRunning, phaseLabel } from './types';

export const finishedDelegation = (d: Delegation) => ['complete', 'cancelled', 'failed', 'uncertain'].includes(d.state);
export function delegationContext(snapshot: Snapshot, d: Delegation) {
  const owner = snapshot.profiles.find(p => p.id === d.owner), target = snapshot.profiles.find(p => p.id === d.target);
  const source = owner?.conversations.find(c => c.tasks.some(t => t.id === d.owner_task));
  const conversation = target?.conversations.find(c => c.id === d.conversation_id);
  const task = conversation?.tasks.find(t => t.id === d.task_id);
  const phase = finishedDelegation(d) || d.state === 'cancelling' ? d.state : task?.phase ?? d.state;
  const needsOwner = !finishedDelegation(d) && (phase === 'waiting_owner' || snapshot.reviews.some(r => r.profile_id === d.target && r.conversation_id === d.conversation_id && ['pending', 'approved'].includes(r.state)));
  const status: DotState = ['uncertain', 'failed'].includes(phase) || needsOwner ? 'attention' : isRunning(phase) || phase === 'running' || phase === 'cancelling' ? 'working' : 'idle';
  const label = needsOwner ? '확인 필요' : ({ running: '함께 작업 중', pending: '요청 전달 중', cancelling: '취소 확인 중' }[phase] ?? phaseLabel(phase));
  return { owner, target, source, conversation, task, phase, status, label, title: conversation?.title ?? '협업 요청', summary: task?.output || task?.partial || '' };
}

// Parallel tool delegations share their generation parent. Separate requests in
// the same conversation remain separate work groups; no inferred all-to-all graph.
export function collaborationGroups(snapshot: Snapshot) {
  const groups = new Map<string, { id: string; owner: string; title: string; sourceId?: string; delegations: Delegation[] }>();
  for (const d of snapshot.delegations) {
    const { source } = delegationContext(snapshot, d);
    const task = source?.tasks.find(t => t.id === d.owner_task);
    const root = task?.parent_id || d.owner_task || d.id;
    const key = `${d.owner}:${source?.id ?? ''}:${root}`;
    const group = groups.get(key) ?? { id: key, owner: d.owner, title: source?.title ?? '협업 요청', sourceId: source?.id, delegations: [] };
    group.delegations.push(d); groups.set(key, group);
  }
  return [...groups.values()];
}
