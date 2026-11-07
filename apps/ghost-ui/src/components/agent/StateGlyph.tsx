import { TERMINAL_WORK_STATES, type WorkState } from '@ghost/contract';

/** Work lifecycle plus the owner-facing "needs you" reading of a waiting or blocked Work. */
export type GlyphState = WorkState | 'attention';

export const glyphLabel: Record<GlyphState, string> = {
  queued: '대기 중', running: '진행 중', waiting: '위임 결과 대기', verifying: '검증 중',
  blocked: '결과 미확정', done: '완료', failed: '실패', cancelled: '취소됨', attention: '확인 필요',
};

/** A live Work with a pending owner decision reads as 확인 필요, whichever step it is on. */
export const workGlyph = (state: WorkState, needsOwner: boolean): GlyphState =>
  needsOwner && state !== 'blocked' && !TERMINAL_WORK_STATES.includes(state) ? 'attention' : state;

/**
 * One shape per state, so state never depends on color alone:
 * hollow ring queued, spinning arc running, pause bars waiting, half disc verifying,
 * exclamation needs the owner, check done, cross failed, slash cancelled.
 */
export function StateGlyph({ state, size = 16, label, className = '' }: { state: GlyphState; size?: number; label?: boolean; className?: string }) {
  const tone = state === 'attention' || state === 'blocked' ? 'amber'
    : state === 'failed' ? 'danger'
      : state === 'done' ? 'success'
        : state === 'running' || state === 'verifying' ? 'signal' : 'muted';
  return <span className={`state-glyph ${className}`} data-tone={tone} data-state={state}>
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className={state === 'running' ? 'state-glyph__spin' : undefined}>
      {state === 'queued' && <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2.1"/>}
      {state === 'running' && <>
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeOpacity=".22" strokeWidth="1.75"/>
        <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
      </>}
      {state === 'waiting' && <>
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M6.6 6v4M9.4 6v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </>}
      {state === 'verifying' && <>
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M8 4.25a3.75 3.75 0 0 1 0 7.5z" fill="currentColor"/>
      </>}
      {(state === 'attention' || state === 'blocked') && <>
        <circle cx="8" cy="8" r="6.5" fill="currentColor"/>
        <path d="M8 4.8v3.7" stroke="var(--ghost-canvas)" strokeWidth="1.7" strokeLinecap="round"/>
        <circle cx="8" cy="11" r="1" fill="var(--ghost-canvas)"/>
      </>}
      {state === 'done' && <>
        <circle cx="8" cy="8" r="6.5" fill="currentColor"/>
        <path d="m5.3 8.2 1.8 1.8 3.6-3.8" fill="none" stroke="var(--ghost-canvas)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
      </>}
      {state === 'failed' && <>
        <circle cx="8" cy="8" r="6.5" fill="currentColor"/>
        <path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4" stroke="var(--ghost-canvas)" strokeWidth="1.6" strokeLinecap="round"/>
      </>}
      {state === 'cancelled' && <>
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5"/>
        <path d="m4.4 11.6 7.2-7.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </>}
    </svg>
    {label ? <span className="state-glyph__label">{glyphLabel[state]}</span> : <span className="sr-only">{glyphLabel[state]}</span>}
  </span>;
}
