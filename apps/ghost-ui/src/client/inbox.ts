import type { Snapshot, Task } from './types';

/** The same visible items drive the inbox, overview and navigation counts. */
export function inboxItems(snapshot: Snapshot, connected = true) {
  const reviews = snapshot.reviews.filter(r => r.state === 'pending' || r.state === 'approved');
  const tasks = snapshot.profiles.flatMap(p => p.conversations.flatMap(c => c.tasks
    .filter(t => t.phase === 'failed' || t.phase === 'uncertain' || (
      t.phase === 'waiting_owner' && !reviews.some(r => r.profile_id === p.id && r.conversation_id === c.id)
    ))
    .map(t => ({ p, c, t }))));
  const completionCount = connected && (snapshot.capabilities.routing as { runtime_dispatch?: boolean } | undefined)?.runtime_dispatch === true
    ? snapshot.routing_results?.completion_outbox.length ?? 0 : 0;
  return { reviews, tasks, count: reviews.length + tasks.length + completionCount };
}

export function taskAttentionMessage(task: Task) {
  if (task.phase === 'waiting_owner') return '작업이 확인을 기다리고 있습니다. 대화에서 요청 내용을 확인해 주세요.';
  if (task.phase === 'uncertain') return '실제 실행 결과를 확인하지 못했습니다. 다시 요청하기 전에 대화의 실행 기록과 실제 결과를 확인해 주세요.';
  if (/interrupted; no automatic replay|command interrupted; inspect the saved state/i.test(task.output)) {
    return '모델 응답이 중단되었거나 요청이 거절되었습니다. 저장된 기록만으로는 두 원인을 구분할 수 없습니다. 대화의 실행 기록과 모델 설정을 확인해 주세요.';
  }
  return '작업이 실패했습니다. 대화의 실행 기록을 확인해 주세요.';
}
