import type { Verdict, Work, WorkState } from '@ghost/contract';
import { ArtifactPreview } from '../ArtifactPreview';
import type { Outcome } from '../wake';
import { Peek, type PeekFact } from './Peek';
import { InlineText } from '../MessageBody';
import { useHostSnapshot, useOpenWork } from './RefMark';
import { StateGlyph, glyphLabel, glyphTone, type GlyphState } from './StateGlyph';

const judge: Record<Verdict['source'], string> = { checks: '자동 검사', review: '검토 Ghost', owner: '직접 확인' };
const ruling: Record<Verdict['outcome'], string> = { pass: '통과', revise: '수정 요청', fail: '불합격' };

function duration(work: Work): string | null {
  if (!work.startedAt || !work.endedAt) return null;
  const minutes = Math.round((work.endedAt - work.startedAt) / 60_000);
  if (minutes < 1) return '1분 미만';
  return minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간 ${minutes % 60 ? `${minutes % 60}분` : ''}`.trim();
}

const knownStates: Record<string, true> = { queued: true, running: true, waiting: true, verifying: true, blocked: true, done: true, failed: true, cancelled: true };

/**
 * A Work coming back: the return of the branch its thread card opened. One line — state,
 * title, the files it made, why it failed when it did — and every audit fact (who judged it,
 * how long it took, its id) behind a hover. Opening it shows the whole thread.
 */
export function OutcomeLine({ outcome }: { outcome: Outcome }) {
  const state = useHostSnapshot();
  const openWork = useOpenWork();
  const work = state?.works.find(item => item.id === outcome.workId);
  const settled = (work?.state ?? outcome.state) as WorkState;
  const glyph: GlyphState = knownStates[settled] ? settled : 'done';
  const title = work?.title ?? outcome.title;
  const reason = settled === 'done' ? '' : (work?.reason ?? outcome.reason);
  const files = settled === 'done' ? (work?.result?.artifacts ?? []) : [];
  const assignee = work && state?.ghosts.find(ghost => ghost.id === work.ghostId)?.name;
  const took = work && duration(work);
  const facts: PeekFact[] = [
    ...(assignee ? [{ label: '담당', value: assignee }] : []),
    ...(work?.verdict ? [{ label: '판정', value: `${judge[work.verdict.source]} · ${ruling[work.verdict.outcome]}` }] : []),
    ...(took ? [{ label: '걸린 시간', value: took }] : []),
    ...(work && work.revisionsUsed > 0 ? [{ label: '수정', value: `${work.revisionsUsed}회` }] : []),
    { label: '식별자', value: outcome.workId, copy: true },
  ];
  return <div className="outcome" data-state={glyph} role="note" aria-label={`${title} ${glyphLabel[glyph]}`}
    data-rail="outcome" data-rail-tone={glyphTone(glyph)} data-rail-label={`${title} · ${glyphLabel[glyph]}`}>
    <Peek title={title} facts={facts}>
      <button type="button" className="outcome__head" aria-label={`${title}, ${glyphLabel[glyph]}`} onClick={() => openWork(outcome.workId)}>
        <StateGlyph state={glyph} size={15}/>
        <span className="outcome__title">{title}</span>
        <span className="outcome__state">{glyphLabel[glyph]}</span>
      </button>
    </Peek>
    {reason && <p className="outcome__reason"><InlineText text={reason}/></p>}
    {files.length > 0 && <div className="outcome__files">
      {files.map(artifact => <ArtifactPreview key={artifact.digest} artifact={artifact} variant="chip"/>)}
    </div>}
  </div>;
}
