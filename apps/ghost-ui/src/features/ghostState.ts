import type { Ghost, State, Work } from '@ghost/contract';
import { TERMINAL_WORK_STATES } from '@ghost/contract';
import { decisionHeading } from './decisionText';

export type Tone = 'mint' | 'peach' | 'lilac' | 'sky';
export type DotState = 'working' | 'attention' | 'idle';

export const stateLabel: Record<DotState, string> = { working: '진행 중', attention: '확인 필요', idle: '대기 중' };

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

/** What one Ghost is doing right now, in the owner's words; no line when idle. */
export interface Presence {
  state: DotState;
  line: string | null;
}

export function ghostPresence(ghost: Ghost, state: State): Presence {
  const decision = pendingDecisions(state).filter(item => item.ghostId === ghost.id).sort((a, b) => a.createdAt - b.createdAt)[0];
  if (decision) return { state: 'attention', line: decisionHeading(decision, state) };
  const works = ghostLiveWork(state, ghost.id);
  const stuck = works.find(work => work.state === 'blocked');
  if (stuck) return { state: 'attention', line: stuck.title };
  if (state.conversations.some(conversation => conversation.ghostId === ghost.id && conversation.kind === 'direct' && conversation.busy)) return { state: 'working', line: '응답 중' };
  const moving = works.find(work => work.state === 'running' || work.state === 'verifying') ?? works[0];
  if (moving) return { state: 'working', line: moving.title };
  // A failed root stays failed until resumed; it asks for a glance for a day, then the notification history keeps it.
  const failed = state.works.filter(work => work.ghostId === ghost.id && work.state === 'failed' && Date.now() - work.updatedAt < 86_400_000)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (failed) return { state: 'attention', line: failed.title };
  return { state: 'idle', line: null };
}
