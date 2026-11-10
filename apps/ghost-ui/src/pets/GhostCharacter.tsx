import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { LookFace, LookMark, LookShape } from '@ghost/contract';
import type { PetState } from './sprites';
import { faceColor, isHexColor } from './appearance';
import { startGhostLife } from './ghostLife';

/** Below this size idle life (blinks, glances) would only add noise to dense lists. */
const LIFE_MIN_SIZE = 28;
/** Large portraits turn to follow a nearby pointer. */
const FOLLOW_MIN_SIZE = 56;

/**
 * The built-in Ghost: the approved face (two bar eyes, a small round mouth) on a body.
 * A body shape, a face style and one accent let many agents read apart while staying a single family.
 * Every body shares the round body's top (y 212) and width so accents sit the same on each.
 */
function Body({ shape }: { shape: LookShape }) {
  switch (shape) {
    case 'egg': return <ellipse cx="500" cy="520" rx="262" ry="308" fill="var(--g-body)"/>;
    case 'squircle': return <rect x="212" y="212" width="576" height="576" rx="188" fill="var(--g-body)"/>;
    case 'sheet': return <path d="M212 500A288 288 0 0 1 788 500V770Q716 830 644 770Q572 830 500 770Q428 830 356 770Q284 830 212 770Z" fill="var(--g-body)"/>;
    default: return <circle cx="500" cy="500" r="288" fill="var(--g-body)"/>;
  }
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

/**
 * Accents. Those behind the body are drawn in the body color so they belong to the Ghost;
 * those worn in front (bow, ear cups) take the face color so they read on the body.
 * Glasses are part of the face so they turn with it.
 */
function Mark({ mark, front }: { mark: LookMark; front: boolean }) {
  const ink = 'var(--g-body)', face = 'var(--g-face)';
  if (mark === 'ring') return front
    ? <path d="M138 575 A372 92 -12 0 0 862 425" fill="none" stroke={ink} strokeWidth="26" strokeLinecap="round"/>
    : <path d="M862 425 A372 92 -12 0 0 138 575" fill="none" stroke={ink} strokeWidth="26" strokeLinecap="round" opacity=".45"/>;
  if (front) switch (mark) {
    case 'bow': return <g fill={face} stroke={ink} strokeWidth="16" strokeLinejoin="round" transform="rotate(-20 652 262)"><path d="M652 262 L566 208 Q546 262 566 316Z"/><path d="M652 262 L738 208 Q758 262 738 316Z"/><circle cx="652" cy="262" r="30"/></g>;
    case 'headphones': return <g fill={face} stroke={ink} strokeWidth="18"><rect x="140" y="406" width="72" height="140" rx="36"/><rect x="788" y="406" width="72" height="140" rx="36"/></g>;
    default: return null;
  }
  switch (mark) {
    case 'halo': return <ellipse cx="500" cy="158" rx="150" ry="34" fill="none" stroke={ink} strokeWidth="24"/>;
    case 'antenna': return <g fill={ink}><rect x="488" y="128" width="24" height="96" rx="12"/><circle cx="500" cy="126" r="34"/></g>;
    case 'sprout': return <g fill={ink}><path d="M500 214 C500 170 470 140 418 138 C420 186 452 214 500 214Z"/><path d="M500 214 C500 160 536 122 600 120 C598 178 556 214 500 214Z"/></g>;
    case 'spark': return <path fill={ink} d="M790 170 C798 222 818 242 870 250 C818 258 798 278 790 330 C782 278 762 258 710 250 C762 242 782 222 790 170Z"/>;
    case 'crown': return <path fill={ink} stroke={ink} strokeWidth="18" strokeLinejoin="round" d="M372 262 L352 134 L432 196 L500 110 L568 196 L648 134 L628 262Z"/>;
    case 'ears': return <g fill={ink} stroke={ink} strokeWidth="24" strokeLinejoin="round"><path d="M300 330 L322 166 L440 250Z"/><path d="M700 330 L678 166 L560 250Z"/></g>;
    case 'horns': return <g fill={ink}><path d="M352 300 C318 252 300 190 332 136 C352 190 392 228 432 262Z"/><path d="M648 300 C682 252 700 190 668 136 C648 190 608 228 568 262Z"/></g>;
    case 'headphones': return <path d="M176 476 A324 324 0 0 1 824 476" fill="none" stroke={ink} strokeWidth="28" strokeLinecap="round"/>;
    default: return null;
  }
}

export function GhostCharacter({ size = 48, state = 'idle', animate = true, color, fallback, shape = 'round', face = 'bars', mark = 'none', className = '' }: {
  size?: number;
  state?: PetState;
  animate?: boolean;
  /** The Ghost's chosen body color; empty or `auto` means it never chose one. */
  color?: string;
  /** Body color when the Ghost never chose one (a stable hue from its id). */
  fallback?: string;
  shape?: LookShape;
  face?: LookFace;
  mark?: LookMark;
  className?: string;
}) {
  const svg = useRef<SVGSVGElement>(null), body = useRef<SVGGElement>(null), faceGroup = useRef<SVGGElement>(null);
  const eyes = useRef<SVGGElement>(null), mouth = useRef<SVGEllipseElement>(null);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    let stop = () => {};
    const update = () => {
      stop();
      if (!svg.current || !body.current || !faceGroup.current || !eyes.current || !mouth.current) return;
      const moving = animate && !media.matches && !document.hidden;
      const life = moving && size >= LIFE_MIN_SIZE;
      stop = startGhostLife({ svg: svg.current, body: body.current, face: faceGroup.current, eyes: eyes.current, mouth: mouth.current },
        { talk: moving && state === 'running', life, follow: life && size >= FOLLOW_MIN_SIZE });
    };
    update(); media.addEventListener('change', update); document.addEventListener('visibilitychange', update);
    return () => { stop(); media.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); };
  }, [state, animate, size]);
  const chosen = color && color !== 'auto' ? color : undefined;
  const style = { width: size, height: size } as CSSProperties;
  const tone = chosen ?? fallback;
  const bodyFill = tone ?? 'var(--ghost-ink)';
  const faceFill = tone && isHexColor(tone) ? faceColor(tone) : 'var(--ghost-canvas)';
  return <svg ref={svg} className={`ghost-character ${className}`} style={style} viewBox="100 100 800 800" fill="none" aria-hidden="true" data-ghost-state={state}>
    <g ref={body} style={{ '--g-body': bodyFill, '--g-face': faceFill } as CSSProperties}>
      <Mark mark={mark} front={false}/>
      <Body shape={shape}/>
      <g ref={faceGroup} fill="var(--g-face)">
        <g ref={eyes}><Eyes face={face}/></g>
        <ellipse ref={mouth} cx="500" cy="484" rx="15" ry="15"/>
        {mark === 'glasses' && <g fill="none" stroke="var(--g-face)" strokeWidth="16" strokeLinecap="round"><circle cx="423" cy="417" r="54"/><circle cx="577" cy="417" r="54"/><path d="M477 410 Q500 396 523 410"/></g>}
      </g>
      <Mark mark={mark} front/>
    </g>
  </svg>;
}
