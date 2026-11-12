import type { WorkState } from '@ghost/contract';
import { glyphLabel, workGlyph } from './StateGlyph';

const steps = ['접수', '진행', '검증', '완료'] as const;

/** Where a Work stands on its way to an accepted result, and how that step reads. */
export function lifecyclePosition(state: WorkState, needsOwner: boolean): { step: number; tone: 'signal' | 'amber' | 'danger' | 'success' | 'muted'; moving: boolean } {
  switch (state) {
    case 'queued': return { step: 0, tone: 'muted', moving: false };
    case 'running': return { step: 1, tone: needsOwner ? 'amber' : 'signal', moving: !needsOwner };
    case 'waiting': return { step: 1, tone: needsOwner ? 'amber' : 'muted', moving: false };
    case 'blocked': return { step: 1, tone: 'amber', moving: false };
    case 'verifying': return { step: 2, tone: needsOwner ? 'amber' : 'signal', moving: !needsOwner };
    case 'done': return { step: 3, tone: 'success', moving: false };
    case 'failed': return { step: 1, tone: 'danger', moving: false };
    case 'cancelled': return { step: 1, tone: 'muted', moving: false };
  }
}

/** The step and the state the glyph shows, e.g. "진행 · 실패" or "검증 · 확인 필요"; color alone never carries it. */
export function lifecycleLabel(state: WorkState, needsOwner: boolean): string {
  const step = steps[lifecyclePosition(state, needsOwner).step];
  const reading = glyphLabel[workGlyph(state, needsOwner)];
  return reading === step ? step : `${step} · ${reading}`;
}

/**
 * Four segments from 접수 to 완료. Passed segments are solid ink, the current one carries
 * the state color (and a travelling sheen while the Ghost is actually working).
 */
export function LifecycleTrack({ state, needsOwner = false, compact = false, decorative = false, stageOnly = false, className = '' }: {
  state: WorkState; needsOwner?: boolean; compact?: boolean;
  /** Beside a StateGlyph that already speaks the state, the track stays out of the accessible name. */
  decorative?: boolean;
  /** Say the stage alone ("진행"), for a lane that already shows the state word next to it. */
  stageOnly?: boolean; className?: string;
}) {
  const { step, tone, moving } = lifecyclePosition(state, needsOwner);
  const ended = state === 'cancelled' || state === 'failed';
  return <div className={`lifecycle ${className}`} data-compact={compact || undefined} data-tone={tone}
    {...decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': stageOnly ? steps[lifecyclePosition(state, needsOwner).step] : lifecycleLabel(state, needsOwner) }}>
    <div className="lifecycle__bars">
      {steps.map((name, index) => <span key={name} className="lifecycle__bar"
        data-phase={index < step ? 'past' : index === step ? 'current' : ended ? 'void' : 'future'}
        data-moving={index === step && moving || undefined}/>)}
    </div>
    {!compact && <div className="lifecycle__labels" aria-hidden="true">
      {steps.map((name, index) => <span key={name} data-current={index === step || undefined}>{name}</span>)}
    </div>}
  </div>;
}
