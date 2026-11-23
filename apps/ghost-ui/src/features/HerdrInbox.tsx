import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, SquareTerminal } from 'lucide-react';
import type { HerdrWorkspaceView } from '@ghost/contract';
import { WorkingTime } from './HerdrParts';
import { HerdrAskCard, type HerdrAsks } from './HerdrAsk';
import { HerdrState, herdrPanePath } from './herdrDisplay';
import { agentGroupName, agentGroups, groupAgents, readCodingValue, trackActivity, writeCodingValue, type ActivityLog } from './herdrInboxModel';

const emptyLog: ActivityLog = {};
export function useHerdrActivity(session: string | null, workspaces: readonly HerdrWorkspaceView[], open: string | null) {
  const [observed, setObserved] = useState<{ session: string; log: ActivityLog }>();
  useEffect(() => {
    if (!session) return;
    setObserved(previous => {
      let log = previous?.session === session ? previous.log : emptyLog;
      if (previous?.session !== session) {
        try { log = JSON.parse(readCodingValue(`activity:${session}`) ?? '{}') ?? emptyLog; }
        catch { /* optional device state */ }
      }
      const next = trackActivity(log, workspaces, open, Date.now());
      return previous?.session === session && next === previous.log ? previous : { session, log: next };
    });
  }, [session, workspaces, open]);
  useEffect(() => {
    if (observed) writeCodingValue(`activity:${observed.session}`, JSON.stringify(observed.log));
  }, [observed]);
  return observed?.session === session ? observed.log : emptyLog;
}

export function HerdrInbox({ workspaces, open, log, asks, onSpaces }: {
  workspaces: readonly HerdrWorkspaceView[]; open: string | null; log: ActivityLog; asks: HerdrAsks; onSpaces(): void;
}) {
  const groups = useMemo(() => groupAgents(workspaces, log, open), [workspaces, log, open]);
  const root = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, { y: number; group: string }>());
  useLayoutEffect(() => {
    if (!root.current) return;
    const next = new Map<string, { y: number; group: string }>();
    const top = root.current.getBoundingClientRect().top;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const row of root.current.querySelectorAll<HTMLElement>('[data-agent-row]')) {
      const id = row.dataset.agentRow!;
      const group = row.dataset.agentGroup!;
      const y = row.getBoundingClientRect().top - top;
      const old = positions.current.get(id);
      next.set(id, { y, group });
      const change = old ? old.y - y : -6;
      if (Math.abs(change) < 2 && old?.group === group) continue;
      row.animate(reduced ? [{ opacity: .75 }, { opacity: 1 }] : [
        { opacity: old ? .9 : .45, transform: `translateY(${Math.max(-34, Math.min(34, change))}px)` },
        { opacity: 1, transform: 'translateY(0)' },
      ], { duration: reduced ? 125 : 195, easing: 'cubic-bezier(.2,.65,.3,1)' });
    }
    positions.current = next;
  }, [groups]);
  if (!agentGroups.some(group => groups[group].length)) return <div className="herdr-inbox-empty">
    <SquareTerminal size={23} aria-hidden="true"/>
    <p>열린 에이전트가 없습니다.</p>
    {workspaces.length > 0 && <button type="button" onClick={onSpaces}>스페이스 보기<ChevronRight size={14} aria-hidden="true"/></button>}
  </div>;
  return <div className="herdr-inbox" ref={root}>
    {agentGroups.map(group => groups[group].length ? <section key={group} className="herdr-inbox-group" data-group={group} aria-label={agentGroupName[group]}>
      <h2>{agentGroupName[group]}</h2>
      <ul>{groups[group].map(({ pane, changedAt }) => {
        const approval = group === 'blocked' ? asks.entries[pane.id] : undefined;
        const selected = open === pane.id;
        return <li key={pane.id} data-agent-row={pane.id} data-agent-group={group}>
          <a href={`#${herdrPanePath(pane.id)}`} aria-current={selected ? 'page' : undefined} className="herdr-agent-link" title={pane.workspace}>
            {group === 'shell' ? <SquareTerminal size={17} role="img" aria-label="셸"/> : <HerdrState status={pane.status} size={16} label={false} unread={group === 'done'}/>}
            <strong className="herdr-agent-title">{pane.title}</strong>
            {group === 'working' ? <WorkingTime since={changedAt}/> : group === 'blocked' && !approval
              ? <span className="herdr-ask-open">열기</span> : <ChevronRight aria-hidden="true" size={15} className="herdr-agent-chevron"/>}
          </a>
          {approval && <HerdrAskCard entry={approval} answer={index => void asks.answer(pane.id, index)}/>}
        </li>;
      })}</ul>
    </section> : null)}
  </div>;
}
