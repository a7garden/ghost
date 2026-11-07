import type { WorkState } from '@ghost/contract';

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

/**
 * Four segments from 접수 to 완료. Passed segments are solid ink, the current one carries
 * the state color (and a travelling sheen while the Ghost is actually working).
 */
export function LifecycleTrack({ state, needsOwner = false, compact = false, className = '' }: { state: WorkState; needsOwner?: boolean; compact?: boolean; className?: string }) {
  const { step, tone, moving } = lifecyclePosition(state, needsOwner);
  const ended = state === 'cancelled' || state === 'failed';
  return <div className={`lifecycle ${className}`} data-compact={compact || undefined} data-tone={tone}
    role="img" aria-label={`${steps[step]} 단계`}>
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
