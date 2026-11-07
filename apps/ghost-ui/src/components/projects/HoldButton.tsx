import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { cn } from '../../ui';

/**
 * Hold-to-confirm button: the action fires when the hold outlasts `duration`;
 * releasing early resets it. Pointer and keyboard both hold (Space/Enter down
 * starts the fill, up cancels), so keyboard users take the same path.
 */
export function HoldButton({ label, holdingLabel, duration = 1200, disabled, className, onComplete }: {
  label: string;
  /** Shown while the hold is running; defaults to the label. */
  holdingLabel?: string;
  duration?: number;
  disabled?: boolean;
  className?: string;
  onComplete(): void;
}) {
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const frame = useRef(0);
  const startedAt = useRef(0);

  const stop = () => {
    if (frame.current !== 0) cancelAnimationFrame(frame.current);
    frame.current = 0;
  };
  useEffect(() => stop, []);

  const start = () => {
    if (disabled || frame.current !== 0) return;
    setHolding(true);
    startedAt.current = performance.now();
    const tick = (now: number) => {
      const value = Math.min(1, (now - startedAt.current) / duration);
      setProgress(value);
      if (value >= 1) { stop(); setHolding(false); setProgress(0); onComplete(); return; }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };
  const cancel = () => {
    if (frame.current === 0) return;
    stop(); setHolding(false); setProgress(0);
  };

  return <button type="button" disabled={disabled} data-holding={holding || undefined}
    className={cn('hold-btn', className)}
    style={{ '--hold-progress': progress } as CSSProperties}
    onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); start(); }}
    onPointerUp={cancel}
    onPointerCancel={cancel}
    onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); start(); } }}
    onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') cancel(); }}
    onBlur={cancel}>
    <span className="hold-btn__fill" aria-hidden="true"/>
    <span className="hold-btn__label">{holding && holdingLabel ? holdingLabel : label}</span>
  </button>;
}
