import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import type { State } from '@ghost/contract';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui';
import { ghostPresence, liveWorks, pendingDecisions, toneFor } from '../../features/ghostState';
import { relativeTime, useNow } from '../../features/time';
import { decisionHeading, decisionLabel } from '../../features/decisionText';
import { uiTerms } from '../../uiText';
import { DotAvatar } from '../DotAvatar';
import { StateGlyph, type GlyphState } from './StateGlyph';

type Entry = { id: string; glyph: GlyphState; title: string; meta: string; at: number; go(): void };

/**
 * The workspace's pulse in the title bar: who is working and what waits on the owner.
 * Silent when nothing moves; opens into every live item across Ghosts.
 */
export function ActivityIsland({ state, navigate }: { state: State; navigate(path: string): void }) {
  const [open, setOpen] = useState(false);
  const now = useNow();
  const names = new Map(state.ghosts.map(ghost => [ghost.id, ghost.name]));
  const decisions = pendingDecisions(state).sort((a, b) => a.createdAt - b.createdAt);
  const waitingWorks = new Set(decisions.map(decision => decision.workId).filter(Boolean));
  const works = liveWorks(state).filter(work => !waitingWorks.has(work.id));
  const talking = state.conversations.filter(conversation => conversation.kind === 'direct' && conversation.busy);
  const active = state.ghosts.map(ghost => ({ ghost, presence: ghostPresence(ghost, state) })).filter(item => item.presence.state !== 'idle');
  const moving = works.filter(work => work.state !== 'blocked').length + talking.length;
  const asks = decisions.length + works.filter(work => work.state === 'blocked').length;
  if (!asks && !moving) return null;

  const go = (path: string) => () => { setOpen(false); navigate(path); };
  const attention: Entry[] = [
    ...decisions.map(decision => ({ id: decision.id, glyph: 'attention' as const, title: decisionHeading(decision, state),
      meta: `${names.get(decision.ghostId) ?? 'Ghost'} · ${decisionLabel[decision.kind]}`, at: decision.createdAt,
      go: go(`/inbox?decision=${encodeURIComponent(decision.id)}`) })),
    ...works.filter(work => work.state === 'blocked').map(work => ({ id: work.id, glyph: 'blocked' as const, title: work.title,
      meta: names.get(work.ghostId) ?? 'Ghost', at: work.updatedAt, go: go(`/work/${encodeURIComponent(work.id)}`) })),
  ];
  const running: Entry[] = [
    ...talking.map(conversation => ({ id: conversation.id, glyph: 'running' as const, title: conversation.title || '대화',
      meta: `${names.get(conversation.ghostId) ?? 'Ghost'} · 응답 중`, at: conversation.lastActivityAt,
      go: go(`/ghosts/${encodeURIComponent(conversation.ghostId)}?conversation=${encodeURIComponent(conversation.id)}`) })),
    ...works.filter(work => work.state !== 'blocked').map(work => ({ id: work.id, glyph: work.state as GlyphState, title: work.title,
      meta: names.get(work.ghostId) ?? 'Ghost', at: work.updatedAt, go: go(`/work/${encodeURIComponent(work.id)}`) })),
  ];
  const summary = [asks ? `확인 필요 ${asks}` : '', moving ? `진행 중 ${moving}` : ''].filter(Boolean).join(', ');

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" className="island" data-attention={asks > 0 || undefined} aria-label={`활동: ${summary}`}>
        <span className="island__faces" aria-hidden="true">
          {active.slice(0, 3).map(({ ghost }) => <DotAvatar key={ghost.id} profileId={ghost.id} tone={toneFor(ghost.id)} size={18}/>)}
        </span>
        {asks > 0 && <span className="island__count" data-tone="amber"><i aria-hidden="true"/>{asks}</span>}
        {moving > 0 && <span className="island__count" data-tone="signal"><i aria-hidden="true"/>{moving}</span>}
      </button>
    </PopoverTrigger>
    <PopoverContent side="bottom" align="center" sideOffset={8} aria-label="활동" className="island-panel w-[min(380px,calc(100vw-16px))] p-1.5">
      {attention.length > 0 && <IslandGroup title="확인 필요" entries={attention} now={now}
        more={{ label: uiTerms.inbox, go: go('/inbox') }}/>}
      {running.length > 0 && <IslandGroup title="진행 중" entries={running} now={now}
        more={{ label: uiTerms.work, go: go('/work') }}/>}
    </PopoverContent>
  </Popover>;
}

function IslandGroup({ title, entries, now, more }: { title: string; entries: Entry[]; now: number; more: { label: string; go(): void } }) {
  return <section className="island-panel__group">
    <header className="island-panel__head">
      <h2>{title}</h2>
      <button type="button" onClick={more.go}>{more.label}<ArrowRight size={12} aria-hidden="true"/></button>
    </header>
    <ul>{entries.slice(0, 6).map(entry => <li key={entry.id}>
      <button type="button" className="island-panel__row" onClick={entry.go}>
        <StateGlyph state={entry.glyph} size={15}/>
        <span className="island-panel__copy"><span>{entry.title}</span><small>{entry.meta}</small></span>
        <time className="tabular">{relativeTime(entry.at, now)}</time>
      </button>
    </li>)}</ul>
  </section>;
}
