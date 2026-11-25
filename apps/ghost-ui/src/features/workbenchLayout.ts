/** The launch pad pane: a new agent being written. Agent panes hold a session id. */
export const LAUNCH = 'launch';
export const MAX_PANES = 3;
const MIN_SHARE = 0.2;

/** Side-by-side panes of one project on a wide screen: what each shows, its share of the width, and the active one. */
export type Layout = { panes: string[]; sizes: number[]; active: number };
export const emptyLayout: Layout = { panes: [], sizes: [], active: 0 };

const even = (count: number) => Array.from({ length: count }, () => 1 / count);
const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));

/** Shows `id` in the active pane, or activates the pane already showing it. */
export function show(layout: Layout, id: string): Layout {
  const at = layout.panes.indexOf(id);
  if (at >= 0) return at === layout.active ? layout : { ...layout, active: at };
  if (!layout.panes.length) return { panes: [id], sizes: [1], active: 0 };
  const panes = layout.panes.slice();
  panes[layout.active] = id;
  return { ...layout, panes };
}

/** Opens `id` in a new pane beside the active one; at the limit it takes the pane right of the active one. */
export function split(layout: Layout, id: string): Layout {
  const at = layout.panes.indexOf(id);
  if (at >= 0) return { ...layout, active: at };
  if (!layout.panes.length) return { panes: [id], sizes: [1], active: 0 };
  if (layout.panes.length >= MAX_PANES) {
    const target = layout.active === layout.panes.length - 1 ? layout.active - 1 : layout.active + 1;
    const panes = layout.panes.slice();
    panes[target] = id;
    return { ...layout, panes, active: target };
  }
  const panes = layout.panes.slice();
  panes.splice(layout.active + 1, 0, id);
  return { panes, sizes: even(panes.length), active: layout.active + 1 };
}

/** Closes one pane; its share goes to its neighbours. */
export function close(layout: Layout, index: number): Layout {
  if (index < 0 || index >= layout.panes.length) return layout;
  const panes = layout.panes.filter((_, at) => at !== index);
  if (!panes.length) return emptyLayout;
  const freed = layout.sizes[index] ?? 0;
  const sizes = layout.sizes.filter((_, at) => at !== index).map(size => size + freed / panes.length);
  const active = layout.active > index ? layout.active - 1 : Math.min(layout.active, panes.length - 1);
  return { panes, sizes, active };
}

/** Moves the border right of pane `index` by `delta` (a share of the width), keeping both sides usable. */
export function resize(layout: Layout, index: number, delta: number): Layout {
  const left = layout.sizes[index], right = layout.sizes[index + 1];
  if (left === undefined || right === undefined) return layout;
  const total = left + right;
  const min = Math.min(MIN_SHARE, total / 2);
  const next = Math.min(Math.max(left + delta, min), total - min);
  if (next === left) return layout;
  const sizes = layout.sizes.slice();
  sizes[index] = next;
  sizes[index + 1] = total - next;
  return { ...layout, sizes };
}

/** Drops panes whose agent is gone and repairs sizes; `keep` decides which ids still exist. */
export function prune(layout: Layout, keep: (id: string) => boolean): Layout {
  let next = layout;
  for (let at = layout.panes.length - 1; at >= 0; at--) if (layout.panes[at] !== LAUNCH && !keep(layout.panes[at]!)) next = close(next, at);
  const sum = next.sizes.reduce((total, size) => total + size, 0);
  if (next.panes.length && (next.sizes.length !== next.panes.length || Math.abs(sum - 1) > 0.001)) return { ...next, sizes: even(next.panes.length) };
  return next;
}

const storageKey = (scopeId: string | null) => `ghost.workbench.layout:${scopeId ?? 'none'}`;

export function loadLayout(scopeId: string | null): Layout {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(scopeId)) ?? 'null') as Partial<Layout> | null;
    if (!value || !Array.isArray(value.panes) || !value.panes.every(id => typeof id === 'string')) return emptyLayout;
    const panes = value.panes.slice(0, MAX_PANES);
    const sizes = Array.isArray(value.sizes) && value.sizes.length === panes.length && value.sizes.every(size => typeof size === 'number' && size > 0) ? value.sizes : even(panes.length);
    return prune({ panes, sizes, active: clamp(Number(value.active) || 0, Math.max(0, panes.length - 1)) }, () => true);
  } catch {
    return emptyLayout;
  }
}

/** Remembers the agent panes; a launch pad is a moment, not a place to return to. */
export function saveLayout(scopeId: string | null, layout: Layout) {
  const kept = layout.panes.includes(LAUNCH) ? close(layout, layout.panes.indexOf(LAUNCH)) : layout;
  try { localStorage.setItem(storageKey(scopeId), JSON.stringify(kept)); } catch { /* Storage may be full or disabled; the layout still works for this visit. */ }
}
