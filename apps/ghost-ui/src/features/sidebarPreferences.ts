import { useEffect, useState } from 'react';

/** Sidebar roster preferences, kept per browser: pinned Ghosts and the overflow disclosure. */
export interface SidebarPreferences { pinned: string[]; expanded: boolean; }

const KEY = 'ghost-ui:sidebar';
const defaults: SidebarPreferences = { pinned: [], expanded: false };

/** Reads `ghost-ui:sidebar`; anything malformed falls back to the defaults. */
export function loadSidebarPreferences(): SidebarPreferences {
  try {
    const saved = typeof localStorage === 'undefined' ? null
      : JSON.parse(localStorage.getItem(KEY) ?? 'null') as { pinned?: unknown; expanded?: unknown } | null;
    const pinned = Array.isArray(saved?.pinned)
      ? [...new Set(saved.pinned.filter((id): id is string => typeof id === 'string'))] : [];
  return { pinned, expanded: saved?.expanded !== false };
  } catch { return defaults; }
}

export function saveSidebarPreferences(preferences: SidebarPreferences): void {
  try { localStorage.setItem(KEY, JSON.stringify(preferences)); } catch { /* 사설 모드 등에서 못 저장해도 동작에는 지장 없다 */ }
}

/** Sidebar preference state; unknown Ghost ids never surface, and every change persists at once. */
export function useSidebarPreferences(ghostIds: readonly string[]) {
  const [prefs, setPrefs] = useState(loadSidebarPreferences);
  useEffect(() => { saveSidebarPreferences(prefs); }, [prefs]);
  const known = new Set(ghostIds);
  return {
    pinned: prefs.pinned.filter(id => known.has(id)),
    expanded: prefs.expanded,
    togglePinned: (id: string) => setPrefs(current => ({ ...current,
      pinned: current.pinned.includes(id) ? current.pinned.filter(other => other !== id) : [...current.pinned, id] })),
    setExpanded: (expanded: boolean) => setPrefs(current => ({ ...current, expanded })),
  };
}
