import { ArrowRight } from 'lucide-react';
import type { Decision, State } from '@ghost/contract';
import { DotAvatar } from './DotAvatar';
import { pendingDecisions, toneFor } from '../features/ghostState';
import { decisionChip, decisionHeading } from '../features/decisionText';
import { relativeTime } from '../features/time';

/** Lines shown before the rest fold into one 「나머지」 line. */
const SHOWN = 3;

/** Pending decisions, oldest first: the one that has waited longest leads. Pure; tests pin it. */
export function waitingDecisions(state: State): Decision[] {
  // 무엇이 「답을 기다림」인지는 pendingDecisions 한 곳이 정한다 — 홈 줄과 탭 배지가 어긋나지 않게.
  return [...pendingDecisions(state)].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 「기다림 줄」 — on the phone home, what waits on the owner as one line per question, above everything else.
 * Tapping a line opens that question in 확인할 일, where it is answered.
 * 2026.11.11 : 홈이 확인 카드를 통째로 다시 깔아 「확인할 일」 탭과 같은 것을 두 번 보였다.
 * 홈은 「답할 것이 있나」만 말하고, 답은 확인할 일에서 한다.
 */
export function WaitingLine({ state, now, navigate, className }: { state: State; now: number; navigate(path: string): void; className?: string }) {
  const waiting = waitingDecisions(state);
  if (!waiting.length) return null;
  const names = new Map(state.ghosts.map(ghost => [ghost.id, ghost.name]));
  const rest = waiting.length - SHOWN;
  return <section className={['waiting-line', className].filter(Boolean).join(' ')} aria-labelledby="waiting-line-title">
    <h2 id="waiting-line-title" className="section-title">답을 기다림<span className="count">{waiting.length}</span></h2>
    <ul>
      {waiting.slice(0, SHOWN).map(decision => <li key={decision.id}>
        <button type="button" onClick={() => navigate(`/inbox?decision=${encodeURIComponent(decision.id)}`)}>
          <DotAvatar profileId={decision.ghostId} tone={toneFor(decision.ghostId)} size={28}/>
          <span className="waiting-line__copy">
            <span className="waiting-line__question">{decisionHeading(decision, state)}</span>
            <span className="waiting-line__meta">{names.get(decision.ghostId) ?? 'Ghost'} · {decisionChip(decision)} · <time className="tabular">{relativeTime(decision.createdAt, now)}</time></span>
          </span>
          <ArrowRight aria-hidden="true"/>
        </button>
      </li>)}
      {rest > 0 && <li><button type="button" className="waiting-line__rest" onClick={() => navigate('/inbox')}>나머지 {rest}건<ArrowRight aria-hidden="true"/></button></li>}
    </ul>
  </section>;
}
