import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Back and forward for the hash router. Browsers do not say whether history can move either way,
 * so every entry the app creates carries its position, and the furthest position lives in session
 * storage (it survives a reload, like the history it describes). Entries made by setting
 * `location.hash` directly get their position when they arrive.
 */
const KEY = 'ghost-ui:history-max';

function positionOf(value: unknown): number | null {
  if (!value || typeof value !== 'object' || !('ghostNav' in value)) return null;
  return typeof value.ghostNav === 'number' ? value.ghostNav : null;
}

function readMax(fallback: number): number {
  try { return Math.max(fallback, Number(sessionStorage.getItem(KEY) ?? 0) || 0); } catch { return fallback; }
}

function writeMax(max: number) {
  try { sessionStorage.setItem(KEY, String(max)); } catch { /* private mode: back/forward still work, only the hint resets */ }
}

export interface HistoryNav { canBack: boolean; canForward: boolean; back(): void; forward(): void; push(hash: string): void }

export function useHistoryNav(): HistoryNav {
  const [where, setWhere] = useState(() => {
    let position = positionOf(history.state);
    if (position === null) { position = 0; history.replaceState({ ...(history.state ?? {}), ghostNav: 0 }, ''); }
    return { position, max: readMax(position) };
  });

  // Events and pushes read the latest position directly; history writes stay out of state updaters.
  const latest = useRef(where);
  latest.current = where;
  const settle = useCallback((next: { position: number; max: number }) => { latest.current = next; setWhere(next); }, []);

  useEffect(() => {
    const arrive = () => {
      const current = latest.current;
      const known = positionOf(history.state);
      if (known !== null) {
        if (known !== current.position) settle({ position: known, max: Math.max(current.max, known) });
        return;
      }
      // A hash set directly is a new entry after the current one; anything beyond it is gone.
      const position = current.position + 1;
      history.replaceState({ ...(history.state ?? {}), ghostNav: position }, '');
      writeMax(position);
      settle({ position, max: position });
    };
    window.addEventListener('popstate', arrive);
    window.addEventListener('hashchange', arrive);
    return () => { window.removeEventListener('popstate', arrive); window.removeEventListener('hashchange', arrive); };
  }, [settle]);

  const push = useCallback((hash: string) => {
    const position = latest.current.position + 1;
    history.pushState({ ghostNav: position }, '', hash);
    writeMax(position);
    settle({ position, max: position });
  }, [settle]);

  return {
    canBack: where.position > 0,
    canForward: where.position < where.max,
    back: () => history.back(),
    forward: () => history.forward(),
    push,
  };
}
