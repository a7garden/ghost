import type { Ghost, State } from '@ghost/contract';
import { ghostLiveWork, ghostPresence, pendingDecisions } from '../features/ghostState';
import { decisionHeading } from '../features/decisionText';
import { ScrollRails } from '../ui/scroll-rail';

const workLabels = { queued: '대기', running: '진행 중', waiting: '기다리는 중', blocked: '막힘', verifying: '검토 중', done: '완료', failed: '실패', cancelled: '취소' };

export function companionActivity(ghost: Ghost, state: State) {
  const decisions = pendingDecisions(state).filter(item => item.ghostId === ghost.id).sort((a, b) => a.createdAt - b.createdAt);
  const works = ghostLiveWork(state, ghost.id).sort((a, b) => Number(b.state === 'blocked') - Number(a.state === 'blocked'));
  const presence = ghostPresence(ghost, state);
  const failed = presence.rank === 4 ? state.works.filter(work => work.ghostId === ghost.id && work.state === 'failed').sort((a, b) => b.updatedAt - a.updatedAt)[0] : undefined;
  const summary = decisions.length ? `확인할 일 ${decisions.length}` : works.length ? `맡긴 일 ${works.length}` : failed ? '실패한 일 1' : presence.line;
  return { decisions, works, failed, summary };
}

export function WorkShelf({ ghost, state, onOpen }: { ghost: Ghost; state: State; onOpen: (route: string) => void }) {
  const { decisions, works, failed } = companionActivity(ghost, state);
  return <section id="companion-work" className="companion-work" aria-label={`${ghost.name}의 맡긴 일`}>
    <div className="companion-work-scroll" tabIndex={0} aria-label="맡긴 일 목록">
      {decisions.length > 0 && <div className="companion-work-group" data-attention="true">
        <h2>확인할 일 <span>{decisions.length}</span></h2>
        {decisions.map(decision => <button type="button" className="companion-work-row" key={decision.id} onClick={() => onOpen(`/inbox?decision=${encodeURIComponent(decision.id)}`)}>
          <span className="companion-work-title">{decisionHeading(decision, state)}</span><span className="companion-work-state">확인 필요</span>
        </button>)}
      </div>}
      {(works.length > 0 || failed) && <div className="companion-work-group">
        <h2>맡긴 일 <span>{works.length + Number(Boolean(failed))}</span></h2>
        {[...works, ...(failed ? [failed] : [])].map(work => <button type="button" className="companion-work-row" data-attention={work.state === 'blocked' || work.state === 'failed'} key={work.id} onClick={() => onOpen(`/work/${encodeURIComponent(work.id)}`)}>
          <span className="companion-work-title">{work.title}</span><span className="companion-work-state">{workLabels[work.state]}</span>
        </button>)}
      </div>}
      {!decisions.length && !works.length && !failed && <p className="companion-work-empty">{ghostPresence(ghost, state).line || '진행 중인 일이 없습니다'}</p>}
    </div>
    <ScrollRails/>
  </section>;
}
