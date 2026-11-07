import type { Ghost, State, Work } from '@ghost/contract';
import { TERMINAL_WORK_STATES } from '@ghost/contract';

export type Tone = 'mint' | 'peach' | 'lilac' | 'sky';
export type DotState = 'working' | 'attention' | 'idle' | 'offline';

export const stateLabel: Record<DotState, string> = { working: '진행 중', attention: '확인 필요', idle: '대기 중', offline: '연결 확인' };

export function toneFor(id: string): Tone {
  return (['mint', 'peach', 'lilac', 'sky'] as Tone[])[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 4];
}

export const liveWork = (work: Work) => !TERMINAL_WORK_STATES.includes(work.state);

/** Work of one Ghost that is moving or waiting; newest change first. */
export function ghostLiveWork(state: State, ghostId: string): Work[] {
  return state.works.filter(work => work.ghostId === ghostId && liveWork(work))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Live work the whole workspace is running; newest change first. */
export function liveWorks(state: State): Work[] {
  return state.works.filter(liveWork).sort((a, b) => b.updatedAt - a.updatedAt);
}

export const pendingDecisions = (state: State) => state.decisions.filter(decision => decision.state === 'pending');

/** Only states that need a glance get a mark; an idle Ghost stays quiet. */
export function dotState(ghost: Ghost, state: State): DotState {
  const hasWork = state.works.some(work => work.ghostId === ghost.id && liveWork(work));
  const attention = pendingDecisions(state).some(decision => decision.ghostId === ghost.id)
    || state.works.some(work => work.ghostId === ghost.id && (work.state === 'blocked' || work.state === 'failed'));
  if (attention) return 'attention';
  if (hasWork || state.conversations.some(conversation => conversation.ghostId === ghost.id && conversation.busy)) return 'working';
  return 'idle';
}
