import type { Decision, Ghost, State, Work } from '@ghost/contract';
import { reviewOf, TERMINAL_WORK_STATES } from '@ghost/contract';
import { decisionHeading } from './decisionText';

export type Tone = 'mint' | 'peach' | 'lilac' | 'sky';
export type DotState = 'working' | 'attention' | 'idle';

export const stateLabel: Record<DotState, string> = { working: '진행 중', attention: '확인 필요', idle: '대기 중' };

export function toneFor(id: string): Tone {
  return (['mint', 'peach', 'lilac', 'sky'] as Tone[])[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 4];
}

export const liveWork = (work: Work) => !TERMINAL_WORK_STATES.includes(work.state);

/** Ghosts still in circulation: deleted and retired ones leave every list and picker; default leads, then 가나다순. */
export function visibleGhosts(ghosts: readonly Ghost[]): Ghost[] {
  return ghosts.filter(ghost => ghost.state !== 'retired' && ghost.deletedAt === null)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name, 'ko'));
}

/** Work of one Ghost that is moving or waiting; newest change first. */
export function ghostLiveWork(state: State, ghostId: string): Work[] {
  return state.works.filter(work => work.ghostId === ghostId && liveWork(work))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Live work the whole workspace is running; newest change first. */
export function liveWorks(state: State): Work[] {
  return state.works.filter(liveWork).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 주인이 메인 Ghost에게 넘겨, 메인이 판단 중인 결정. 메인이 못 정하면 Host가 표시를 지워 주인에게 돌아온다.
 * 2026.11.11 : 「맡기기」가 생겨 기다리는 결정 가운데 주인이 답할 차례가 아닌 것이 생겼다.
 */
export const handedOver = (decision: Decision) => decision.state === 'pending' && typeof reviewOf(decision.proposal)?.delegatedAt === 'number';

/** 주인이 답할 차례인 결정 — 배지 · 홈 · 펫 · 확인할 일이 모두 이것을 센다. 메인에게 맡긴 것은 빠진다. */
export const pendingDecisions = (state: State) => state.decisions.filter(decision => decision.state === 'pending' && !handedOver(decision));

/** What one Ghost is doing right now, in the owner's words; no line when idle. */
export interface Presence {
  state: DotState;
  line: string | null;
  /** Which branch matched, for ordering: 0 decision · 1 blocked · 2 responding · 3 running · 4 recent failure · 5 idle. */
  rank: number;
}

export const idlePresence: Presence = { state: 'idle', line: null, rank: 5 };

export function ghostPresence(ghost: Ghost, state: State): Presence {
  const decision = pendingDecisions(state).filter(item => item.ghostId === ghost.id).sort((a, b) => a.createdAt - b.createdAt)[0];
  if (decision) return { state: 'attention', line: decisionHeading(decision, state), rank: 0 };
  const works = ghostLiveWork(state, ghost.id);
  const stuck = works.find(work => work.state === 'blocked');
  if (stuck) return { state: 'attention', line: stuck.title, rank: 1 };
  if (state.conversations.some(conversation => conversation.ghostId === ghost.id && conversation.kind === 'direct' && conversation.busy)) return { state: 'working', line: '응답 중', rank: 2 };
  const moving = works.find(work => work.state === 'running' || work.state === 'verifying') ?? works[0];
  if (moving) return { state: 'working', line: moving.title, rank: 3 };
  // A failed root stays failed until resumed; it asks for a glance for a day, then the notification history keeps it.
  const failed = state.works.filter(work => work.ghostId === ghost.id && work.state === 'failed' && Date.now() - work.updatedAt < 86_400_000)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (failed) return { state: 'attention', line: failed.title, rank: 4 };
  return idlePresence;
}
