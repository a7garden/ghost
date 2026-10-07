import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { PetState } from './sprites';
import { faceColor } from './appearance';

// Approved Ghost-small-mouth.svg geometry, with breathing room inside each avatar slot.
export const GHOST_BODY = 'M278 425 C278 309 377 215 500 215 C623 215 722 309 722 425 L722 695 C722 728 700 757 667 757 C636 757 619 727 587 727 C555 727 536 757 500 757 C464 757 445 727 413 727 C381 727 363 757 333 757 C300 757 278 728 278 695 Z';
const rhythm = [1, 1.56, 1.13, 1.42, 1.08, 1.70, 1.20, 1.50, 1.04, 1];
export function ghostMotion(seconds: number) {
  const phase = ((seconds % 5) + 5) % 5 / 5, index = phase * (rhythm.length - 1), left = Math.floor(index);
  const ease = (1 - Math.cos((index - left) * Math.PI)) / 2;
  const open = rhythm[left] + (rhythm[Math.min(left + 1, rhythm.length - 1)] - rhythm[left]) * ease;
  return { x: 4 * Math.sin(2 * Math.PI * phase), y: 1.8 * (1 - Math.cos(2 * Math.PI * phase)), tilt: 2.4 * Math.sin(2 * Math.PI * phase), open };
}
export function GhostCharacter({ size = 48, state = 'idle', animate = true, color, className = '' }: { size?: number; state?: PetState; animate?: boolean; color?: string; className?: string }) {
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
  const style = { width: size, height: size, ...(color && color !== 'auto' ? { '--ghost-body-color': color, '--ghost-face-color': faceColor(color) } : {}) } as CSSProperties;
  return <svg className={`ghost-character ${className}`} style={style} viewBox="100 100 800 800" fill="none" aria-hidden="true" data-ghost-state={state}>
    <g ref={body}>
      <path fill="var(--ghost-body-color, var(--color-text))" d={GHOST_BODY}/>
      <g fill="var(--ghost-face-color, var(--color-surface))">
        <rect x="384" y="403" width="78" height="27" rx="13.5"/>
        <rect x="538" y="403" width="78" height="27" rx="13.5"/>
        <ellipse ref={mouth} cx="500" cy="484" rx="15" ry="15"/>
      </g>
    </g>
  </svg>;
}
