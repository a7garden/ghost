import type { CollaborationMessage, Delegation, Snapshot } from '../client/types';

// Fictional protocol-shaped records, only returned by the explicit demo client.
export function exampleCollaboration(snapshot: Snapshot, d: Delegation): CollaborationMessage[] {
  const task = snapshot.profiles.find(p => p.id === d.target)?.conversations.find(c => c.id === d.conversation_id)?.tasks.find(t => t.id === d.task_id);
  const writing = d.id === 'collab-writing';
  const events: CollaborationMessage['event'][] = [
    { type: 'requested', prompt: writing ? '처음 사용하는 사람을 위한 Ghost 소개를 정리해 줘. 문서는 저장 전에 검토를 받아줘.' : '관리 화면의 키보드 탐색과 접근성을 확인해 줘. 발견한 내용을 정리해서 알려줘.' },
    { type: 'accepted' },
    { type: 'progress', phase: task?.phase, summary: writing ? '소개 초안을 완성했어요. 저장하기 전에 당신의 확인을 기다리고 있어요.' : '탐색 메뉴와 대화 입력의 포커스 흐름을 확인하고 있어요.' },
  ];
  if (d.state === 'complete') events.push({ type: 'result', phase: 'complete', summary: task?.output || '검토한 결과를 전달했습니다.', artifacts: writing ? ['Ghost 소개'] : [] });
  if (d.state === 'cancelled') events.push({ type: 'cancel_requested', reason: '사용자가 협업을 중단했습니다.' }, { type: 'cancel_receipt', phase: 'cancelled', uncertain_effects: [] });
  return events.map((event, index) => ({ protocol: 'ghost-collaboration/1', message_id: `${d.id}-${index}`, correlation_id: d.id, sequence: index + 1, from: ['requested', 'cancel_requested'].includes(event.type) ? d.owner : d.target, to: ['requested', 'cancel_requested'].includes(event.type) ? d.target : d.owner, created_ms: new Date('2026-10-03T00:30:00+09:00').getTime() + index * 120000, event }));
}
