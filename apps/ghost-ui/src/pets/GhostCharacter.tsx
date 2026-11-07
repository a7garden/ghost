import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { LookFace, LookMark } from '@ghost/contract';
import type { PetState } from './sprites';
import { faceColor } from './appearance';

/**
 * The built-in Ghost: the approved face (two bar eyes, a small round mouth) on a round body.
 * A face style and one accent let many agents read apart while staying a single family.
 */
const BODY = { cx: 500, cy: 500, r: 288 };
const rhythm = [1, 1.56, 1.13, 1.42, 1.08, 1.70, 1.20, 1.50, 1.04, 1];
export function ghostMotion(seconds: number) {
  const phase = ((seconds % 5) + 5) % 5 / 5, index = phase * (rhythm.length - 1), left = Math.floor(index);
  const ease = (1 - Math.cos((index - left) * Math.PI)) / 2;
  const open = rhythm[left] + (rhythm[Math.min(left + 1, rhythm.length - 1)] - rhythm[left]) * ease;
  return { x: 4 * Math.sin(2 * Math.PI * phase), y: 1.8 * (1 - Math.cos(2 * Math.PI * phase)), tilt: 2.4 * Math.sin(2 * Math.PI * phase), open };
}

function Eyes({ face }: { face: LookFace }) {
  switch (face) {
    case 'dots': return <><circle cx="423" cy="417" r="24"/><circle cx="577" cy="417" r="24"/></>;
    case 'tall': return <><rect x="404" y="384" width="38" height="66" rx="19"/><rect x="558" y="384" width="38" height="66" rx="19"/></>;
    case 'arcs': return <g fill="none" stroke="var(--g-face)" strokeWidth="26" strokeLinecap="round">
      <path d="M391 428 Q423 392 455 428"/><path d="M545 428 Q577 392 609 428"/>
    </g>;
    default: return <><rect x="384" y="403" width="78" height="27" rx="13.5"/><rect x="538" y="403" width="78" height="27" rx="13.5"/></>;
  }
}

/** Accents drawn in the body color so they belong to the Ghost, not to a badge. */
function Mark({ mark, front }: { mark: LookMark; front: boolean }) {
  const ink = 'var(--g-body)';
  if (mark === 'ring') return front
    ? <path d="M138 575 A372 92 -12 0 0 862 425" fill="none" stroke={ink} strokeWidth="26" strokeLinecap="round"/>
    : <path d="M862 425 A372 92 -12 0 0 138 575" fill="none" stroke={ink} strokeWidth="26" strokeLinecap="round" opacity=".45"/>;
  if (front) return null;
  switch (mark) {
    case 'halo': return <ellipse cx="500" cy="158" rx="150" ry="34" fill="none" stroke={ink} strokeWidth="24"/>;
    case 'antenna': return <g fill={ink}><rect x="488" y="128" width="24" height="96" rx="12"/><circle cx="500" cy="126" r="34"/></g>;
    case 'sprout': return <g fill={ink}><path d="M500 214 C500 170 470 140 418 138 C420 186 452 214 500 214Z"/><path d="M500 214 C500 160 536 122 600 120 C598 178 556 214 500 214Z"/></g>;
    case 'spark': return <path fill={ink} d="M790 170 C798 222 818 242 870 250 C818 258 798 278 790 330 C782 278 762 258 710 250 C762 242 782 222 790 170Z"/>;
    default: return null;
  }
}

export function GhostCharacter({ size = 48, state = 'idle', animate = true, color, fallback, face = 'bars', mark = 'none', className = '' }: {
  size?: number;
  state?: PetState;
  animate?: boolean;
  /** The Ghost's chosen body color; `auto` or empty follows the display preference. */
  color?: string;
  /** Body color when neither the Ghost nor the display preference chose one. */
  fallback?: string;
  face?: LookFace;
  mark?: LookMark;
  className?: string;
}) {
  const body = useRef<SVGGElement>(null), mouth = useRef<SVGEllipseElement>(null);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, started = 0;
    const render = (seconds: number) => {
      const p = seconds < 0 ? { x: 0, y: 0, tilt: 0, open: 1 } : ghostMotion(seconds);
      body.current?.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${p.tilt} 500 650)`);
      mouth.current?.setAttribute('ry', String(15 * p.open));
      mouth.current?.setAttribute('rx', String(15 * (1 + .12 * (p.open - 1))));
    };
    const tick = (now: number) => { if (!started) started = now; render((now - started) / 1000); frame = requestAnimationFrame(tick); };
    const update = () => { cancelAnimationFrame(frame); started = 0; render(-1); if (animate && state === 'running' && !media.matches && !document.hidden) frame = requestAnimationFrame(tick); };
    update(); media.addEventListener('change', update); document.addEventListener('visibilitychange', update);
    return () => { cancelAnimationFrame(frame); media.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); };
  }, [state, animate]);
  const chosen = color && color !== 'auto' ? color : undefined;
  const style = {
    width: size, height: size,
    ...(chosen ? { '--ghost-body-color': chosen, '--ghost-face-color': faceColor(chosen) }
      : fallback ? { '--ghost-body-fallback': fallback, '--ghost-face-fallback': faceColor(fallback) } : {}),
  } as CSSProperties;
  // A display-wide preference (--ghost-body-color on :root) still wins over the per-Ghost fallback.
  const bodyFill = chosen ? 'var(--ghost-body-color)' : 'var(--ghost-body-color, var(--ghost-body-fallback, var(--ghost-ink)))';
  const faceFill = chosen ? 'var(--ghost-face-color)' : 'var(--ghost-face-color, var(--ghost-face-fallback, var(--ghost-canvas)))';
  return <svg className={`ghost-character ${className}`} style={style} viewBox="100 100 800 800" fill="none" aria-hidden="true" data-ghost-state={state}>
    <g ref={body} style={{ '--g-body': bodyFill, '--g-face': faceFill } as CSSProperties}>
      <Mark mark={mark} front={false}/>
      <circle cx={BODY.cx} cy={BODY.cy} r={BODY.r} fill="var(--g-body)"/>
      <g fill="var(--g-face)">
        <Eyes face={face}/>
        <ellipse ref={mouth} cx="500" cy="484" rx="15" ry="15"/>
      </g>
      <Mark mark={mark} front/>
    </g>
  </svg>;
}
