import type { Work } from '@ghost/contract';
import { DotAvatar } from '../DotAvatar';
import { toneFor } from '../../features/ghostState';
import { relativeTime } from '../../features/time';
import { LifecycleTrack } from './LifecycleTrack';
import { StateGlyph, glyphLabel, workGlyph } from './StateGlyph';

/**
 * A thread the conversation spun off: a 맡긴 일 started from here, shown where it began
 * and kept live — state, carrier, lifecycle — so the one durable chat shows its branches.
 */
export function ThreadCard({ work, ghostName, needsOwner, now, onOpen }: {
  work: Work;
  ghostName: string;
  needsOwner: boolean;
  now: number;
  onOpen(): void;
}) {
  const glyph = workGlyph(work.state, needsOwner);
  return <div className="thread-card" data-kind="thread">
    <button type="button" onClick={onOpen} aria-label={`스레드: ${work.title}, ${glyphLabel[glyph]}`}>
      <StateGlyph state={glyph}/>
      <span className="thread-card__copy">
        <span className="thread-card__title">{work.title}</span>
        <span className="thread-card__meta">
          <DotAvatar profileId={work.ghostId} tone={toneFor(work.ghostId)} size={14}/>{ghostName}
          <span>{glyphLabel[glyph]}</span>
          <time className="tabular">{relativeTime(work.updatedAt, now)}</time>
        </span>
      </span>
      <LifecycleTrack state={work.state} needsOwner={needsOwner} compact/>
    </button>
  </div>;
}
