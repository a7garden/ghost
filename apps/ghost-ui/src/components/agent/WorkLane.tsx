import type { ReactNode } from 'react';
import { TERMINAL_WORK_STATES, type Work } from '@ghost/contract';
import { DotAvatar } from '../DotAvatar';
import { toneFor } from '../../features/ghostState';
import { relativeTime } from '../../features/time';
import { workReason } from '../../features/workText';
import { StateGlyph, glyphLabel, workGlyph } from './StateGlyph';
import { LifecycleTrack } from './LifecycleTrack';

/**
 * One Work as a lane: its state shape and word, title, who carries it, since when, and why it stopped.
 * Delegated children hang below on a branch line.
 */
export function WorkLane({ work, ghostName, projectName, needsOwner, now, onOpen, action, branch, showGhost = true }: {
  work: Work;
  ghostName: string;
  /** The project the Work belongs to; omitted where the project is already the context. */
  projectName?: string;
  /** A pending decision on this Work turns waiting into 확인 필요. */
  needsOwner: boolean;
  now: number;
  onOpen(): void;
  action?: ReactNode;
  /** Child lanes, already rendered. */
  branch?: ReactNode;
  showGhost?: boolean;
}) {
  const glyph = workGlyph(work.state, needsOwner);
  const note = workReason(work);
  const at = work.endedAt ?? work.updatedAt;
  const live = !TERMINAL_WORK_STATES.includes(work.state);
  return <div className="lane" data-work-state={work.state} data-needs-owner={needsOwner || undefined}>
    <div className="lane__row">
      <div className="lane__entry relative flex min-w-0 flex-1">
        <button type="button" className="lane__main" onClick={onOpen}>
          <StateGlyph state={glyph} className="lane__mark"/>
          <span className="lane__copy">
            <span className="lane__title">{work.title}</span>
            <span className="lane__meta">
              {showGhost && <span className="lane__ghost"><DotAvatar profileId={work.ghostId} tone={toneFor(work.ghostId)} size={14}/><span className="truncate">{ghostName}</span></span>}
              {projectName && <span className="lane__project">{projectName}</span>}
              <span className="lane__state" aria-hidden="true">{glyphLabel[glyph]}</span>
              {note && <span className="lane__note">{note}</span>}
            </span>
          </span>
          <time className={`lane__time tabular shrink-0 whitespace-nowrap text-caption text-ink-3${live ? ' min-w-14 pb-2 text-right' : ''}`}>{relativeTime(at, now)}</time>
        </button>
        {live && <LifecycleTrack state={work.state} needsOwner={needsOwner} compact stageOnly className="lane__track pointer-events-none absolute end-3 top-1/2 mt-1.5"/>}
      </div>
      {action && <span className="lane__action">{action}</span>}
    </div>
    {branch && <div className="lane__branch">{branch}</div>}
  </div>;
}
