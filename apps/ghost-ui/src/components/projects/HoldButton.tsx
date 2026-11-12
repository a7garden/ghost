import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { cn } from '../../ui';

/**
 * Hold-to-confirm button: the action fires when the hold outlasts `duration`;
 * releasing early resets it. Pointer and keyboard both hold (Scope/Enter down
 * starts the fill, up cancels), so keyboard users take the same path. Assistive tech
 * that only sends a click (detail 0) gets a second step instead: the first click arms
 * "한 번 더 눌러 …" for a few seconds and a second click completes.
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
  const [armed, setArmed] = useState(false);
  const frame = useRef(0);
  const startedAt = useRef(0);
  const armTimer = useRef(0);
  // A Scope/Enter hold also ends in a click with detail 0; that click is not an AT activation.
  const keyHeld = useRef(false);

  const stop = () => {
    if (frame.current !== 0) cancelAnimationFrame(frame.current);
    frame.current = 0;
  };
  const disarm = () => { window.clearTimeout(armTimer.current); armTimer.current = 0; setArmed(false); };
  useEffect(() => () => { stop(); window.clearTimeout(armTimer.current); }, []);

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

  const activate = (event: MouseEvent<HTMLButtonElement>) => {
    // Pointer clicks (detail ≥ 1) belong to the hold; only synthesized clicks take the two-step path.
    if (event.detail !== 0 || disabled) return;
    if (keyHeld.current) { keyHeld.current = false; return; }
    if (armed) { disarm(); onComplete(); return; }
    setArmed(true);
    armTimer.current = window.setTimeout(() => { armTimer.current = 0; setArmed(false); }, 4000);
  };
  const isHoldKey = (key: string) => key === ' ' || key === 'Enter';

  return <button type="button" disabled={disabled} data-holding={holding || undefined} data-armed={armed || undefined}
    className={cn('hold-btn', className)}
    aria-description={armed ? undefined : `길게 눌러 ${label}`}
    title={`길게 눌러 ${label}`}
    style={{ '--hold-progress': progress } as CSSProperties}
    onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); start(); }}
    onPointerUp={cancel}
    onPointerCancel={cancel}
    onKeyDown={event => { if (isHoldKey(event.key)) { event.preventDefault(); keyHeld.current = true; if (!event.repeat) start(); } }}
    onKeyUp={event => {
      if (!isHoldKey(event.key)) return;
      event.preventDefault(); cancel();
      // The Scope activation click, if the engine still sends one, arrives in this same task.
      window.setTimeout(() => { keyHeld.current = false; }, 0);
    }}
    onClick={activate}
    onBlur={() => { keyHeld.current = false; cancel(); disarm(); }}>
    <span className="hold-btn__fill" aria-hidden="true"/>
    <span className="hold-btn__label" aria-live="polite">{armed ? `한 번 더 눌러 ${label}` : holding && holdingLabel ? holdingLabel : label}</span>
  </button>;
}
