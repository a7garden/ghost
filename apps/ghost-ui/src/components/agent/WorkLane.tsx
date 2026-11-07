import type { ReactNode } from 'react';
import type { Work } from '@ghost/contract';
import { DotAvatar } from '../DotAvatar';
import { toneFor } from '../../features/ghostState';
import { relativeTime } from '../../features/time';
import { LifecycleTrack } from './LifecycleTrack';
import { StateGlyph, workGlyph } from './StateGlyph';

/**
 * One Work as a lane: its state shape, title, who carries it and since when, and
 * where it stands on the lifecycle. Delegated children hang below on a branch line.
 */
export function WorkLane({ work, ghostName, needsOwner, now, onOpen, action, branch, showGhost = true }: {
  work: Work;
  ghostName: string;
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
  const note = work.state === 'failed' || work.state === 'blocked' || work.state === 'cancelled' ? work.reason : null;
  const at = work.endedAt ?? work.updatedAt;
  return <div className="lane" data-work-state={work.state} data-needs-owner={needsOwner || undefined}>
    <div className="lane__row">
      <button type="button" className="lane__main" onClick={onOpen}>
        <StateGlyph state={glyph}/>
        <span className="lane__copy">
          <span className="lane__title">{work.title}</span>
          <span className="lane__meta">
            {showGhost && <span className="lane__ghost"><DotAvatar profileId={work.ghostId} tone={toneFor(work.ghostId)} size={14}/>{ghostName}</span>}
            <time className="tabular">{relativeTime(at, now)}</time>
            {note && <span className="lane__note">{note}</span>}
          </span>
        </span>
        <LifecycleTrack state={work.state} needsOwner={needsOwner} compact className="lane__track"/>
      </button>
      {action && <span className="lane__action">{action}</span>}
    </div>
    {branch && <div className="lane__branch">{branch}</div>}
  </div>;
}
