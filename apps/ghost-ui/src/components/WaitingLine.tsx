import { ArrowRight } from 'lucide-react';
import type { Decision, State } from '@ghost/contract';
import { PresenceAvatar } from './agent';
import { pendingDecisions } from '../features/ghostState';
import { decisionChip, decisionHeading } from '../features/decisionText';
import { relativeTime } from '../features/time';

/** Pending decisions, oldest first: the one that has waited longest leads. Pure; tests pin it. */
export function waitingDecisions(state: State): Decision[] {
  // 무엇이 「답을 기다림」인지는 pendingDecisions 한 곳이 정한다 — 홈 줄과 탭 배지가 어긋나지 않게.
  return [...pendingDecisions(state)].sort((a, b) => a.createdAt - b.createdAt);
}

/** The phone shows the longest-waiting request and takes its answer to 확인할 일. */
export function WaitingLine({ state, now, navigate }: { state: State; now: number; navigate(path: string): void }) {
  const waiting = waitingDecisions(state);
  const decision = waiting[0];
  if (!decision) return null;
  const more = waiting.length - 1;
  const name = state.ghosts.find(ghost => ghost.id === decision.ghostId)?.name;
  return <section className="waiting-line" aria-labelledby="waiting-line-title">
    <header className="home__band-head">
      <h2 id="waiting-line-title" className="section-title">확인 필요</h2>
      {more > 0 && <button type="button" className="link-quiet" aria-label={`확인할 일에서 나머지 ${more}건 보기`}
        onClick={() => navigate('/inbox')}>나머지 보기<ArrowRight size={13} aria-hidden="true"/></button>}
    </header>
    <ul>
      <li>
        <button type="button" onClick={() => navigate(`/inbox?decision=${encodeURIComponent(decision.id)}`)}>
          <span className="waiting-line__mark" aria-hidden="true"><PresenceAvatar ghostId={decision.ghostId} state="attention" size={24}/></span>
          <span className="waiting-line__copy">
            <span className="waiting-line__question">{decisionHeading(decision, state)}</span>
            <span className="waiting-line__meta">{name ?? 'Ghost'} · {decisionChip(decision)}</span>
          </span>
          <time className="tabular">{relativeTime(decision.createdAt, now)}</time>
        </button>
      </li>
    </ul>
  </section>;
}
