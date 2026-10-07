import { useEffect, useRef, useState } from 'react';
import { CELL, FRAME_COUNTS, frameDuration, lookFrame, rowFor, rowsFor } from './sprites';
import type { PetState, SpriteVersion } from './sprites';

export function PetSprite({ source, version = 2, size = 96, state = 'idle', animate = true, follow = false }: { source: string; version?: SpriteVersion; size?: number; state?: PetState; animate?: boolean; follow?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [look, setLook] = useState<{ row: number; column: number } | null>(null);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => { const media = matchMedia('(prefers-reduced-motion: reduce)'); const change = () => setReduced(media.matches); media.addEventListener('change', change); const visibility = () => setVisible(!document.hidden); document.addEventListener('visibilitychange', visibility); return () => { media.removeEventListener('change', change); document.removeEventListener('visibilitychange', visibility); }; }, []);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const row = rowFor(state); let column = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const show = (r: number, c: number) => { el.style.backgroundPosition = `${c / 7 * 100}% ${r / (rowsFor(version) - 1) * 100}%`; };
    const tick = () => { show(row, column); const duration = frameDuration(row, column); column = (column + 1) % FRAME_COUNTS[row]; timer = setTimeout(tick, duration); };
    if (look && follow && animate && !reduced) { show(look.row, look.column); return; }
    show(row, 0);
    if (animate && !reduced && visible) tick();
    return () => { clearTimeout(timer); };
  }, [state, version, source, animate, reduced, visible, follow, look]);
  return <span ref={ref} className="pet-sprite" aria-hidden="true" data-pet-state={state}
    onPointerMove={e => { if (!follow || version !== 2 || !animate || reduced) return; const rect = e.currentTarget.getBoundingClientRect(); const frame = lookFrame(e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2); setLook(previous => previous?.row === frame.row && previous.column === frame.column ? previous : frame); }}
    onPointerLeave={() => setLook(null)}
    style={{ width: size, height: size * CELL.height / CELL.width, backgroundImage: `url("${source}")`, backgroundSize: `800% ${rowsFor(version) * 100}%` }}/>;
}
