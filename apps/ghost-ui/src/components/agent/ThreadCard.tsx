import type { Work } from '@ghost/contract';
import { ExternalLink, PanelRight } from 'lucide-react';
import { DotAvatar } from '../DotAvatar';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../ui';
import { toneFor } from '../../features/ghostState';
import { relativeTime } from '../../features/time';
import { LifecycleTrack } from './LifecycleTrack';
import { StateGlyph, glyphLabel, glyphTone, workGlyph } from './StateGlyph';
import { TERMINAL_WORK_STATES } from '@ghost/contract';

/** A Work another Ghost carries for this thread, at any depth below it. */
export interface ThreadDelegate { work: Work; ghostName: string; needsOwner: boolean }

const SHOWN_DELEGATES = 4;

/**
 * A thread the conversation spun off: a 맡긴 일 started from here, shown where it began
 * and kept live — state, carrier, lifecycle, and the Ghosts it delegated parts to — so the
 * one durable chat shows its branches and the collaboration under them.
 */
export function ThreadCard({ work, ghostName, needsOwner, now, delegates = [], onOpen, onOpenPage }: {
  work: Work;
  ghostName: string;
  needsOwner: boolean;
  now: number;
  delegates?: ThreadDelegate[];
  onOpen(): void;
  onOpenPage?(): void;
}) {
  const glyph = workGlyph(work.state, needsOwner);
  const shown = delegates.slice(0, SHOWN_DELEGATES);
  // A settled thread folds to one line: its outcome returns below on its own line, so only the
  // branch mark stays. Live threads keep the carrier, lifecycle and their delegation.
  const settled = TERMINAL_WORK_STATES.includes(work.state);
  return <ContextMenu>
    <ContextMenuTrigger asChild>
      <div className="thread-card" data-kind="thread" data-settled={settled || undefined} data-rail="thread" data-rail-tone={glyphTone(glyph)} data-rail-label={work.title}>
        <button type="button" onClick={onOpen} aria-label={`스레드: ${work.title}, ${glyphLabel[glyph]}${delegates.length ? `, 위임 ${delegates.length}` : ''}`}>
          <StateGlyph state={glyph}/>
          <span className="thread-card__copy">
            <span className="thread-card__title">{work.title}</span>
            <span className="thread-card__meta">
              {settled
                ? <time className="tabular">{relativeTime(work.endedAt ?? work.updatedAt, now)}</time>
                : <>
                  <DotAvatar profileId={work.ghostId} tone={toneFor(work.ghostId)} size={14}/>{ghostName}
                  <span>{glyphLabel[glyph]}</span>
                  <time className="tabular">{relativeTime(work.updatedAt, now)}</time>
                </>}
            </span>
            {shown.length > 0 && !settled && <span className="thread-card__delegates" aria-hidden="true">
              {shown.map(({ work: child, ghostName: name, needsOwner: waiting }) => <span key={child.id} className="thread-card__delegate" title={`${name}: ${child.title}`}>
                <StateGlyph state={workGlyph(child.state, waiting)} size={12}/>
                <DotAvatar profileId={child.ghostId} tone={toneFor(child.ghostId)} size={14}/>
                <span className="truncate">{name}</span>
              </span>)}
              {delegates.length > shown.length && <span className="thread-card__delegate">+{delegates.length - shown.length}</span>}
            </span>}
          </span>
          {!settled && <LifecycleTrack state={work.state} needsOwner={needsOwner} compact/>}
        </button>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent aria-label="스레드 메뉴">
      <ContextMenuItem icon={<PanelRight/>} onSelect={onOpen}>스레드 열기</ContextMenuItem>
      {onOpenPage && <ContextMenuItem icon={<ExternalLink/>} onSelect={onOpenPage}>맡긴 일 페이지에서 보기</ContextMenuItem>}
    </ContextMenuContent>
  </ContextMenu>;
}
