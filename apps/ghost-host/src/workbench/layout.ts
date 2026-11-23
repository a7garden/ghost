import { WORKBENCH_MAX_RATIO, WORKBENCH_MIN_RATIO, type Layout, type WorkbenchDirection } from "@ghost/contract";
import { invalid, notFound } from "../core/errors.ts";

export function firstPane(layout: Layout | null): string | null {
  return layout === null ? null : layout.type === "pane" ? layout.paneId : firstPane(layout.first);
}

export function splitPane(layout: Layout | null, paneId: string, split?: { target: string; id: string; direction: WorkbenchDirection }): Layout {
  const pane: Layout = { type: "pane", paneId };
  if (layout === null && !split) return pane;
  if (layout === null || !split) throw invalid("분할할 패널과 방향을 선택하세요.");
  const next = mapLayout(layout, (node) => node.type === "pane" && node.paneId === split.target
    ? { type: "split", id: split.id, direction: split.direction === "right" ? "row" : "column", ratio: 0.5, first: node, second: pane }
    : node);
  if (next === layout) throw notFound("분할할 패널이 없습니다.");
  return next;
}

export function closePane(layout: Layout | null, paneId: string): Layout | null {
  if (!layout) return null;
  if (layout.type === "pane") return layout.paneId === paneId ? null : layout;
  const first = closePane(layout.first, paneId);
  const second = closePane(layout.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

/** Swap the two leaves, not their parent splits. Ratios describe slots, not panes. */
export function movePane(layout: Layout, paneId: string, targetId: string): Layout {
  if (paneId === targetId) return layout;
  let matches = 0;
  const next = mapLayout(layout, node => {
    if (node.type !== "pane" || (node.paneId !== paneId && node.paneId !== targetId)) return node;
    matches++;
    return { type: "pane", paneId: node.paneId === paneId ? targetId : paneId };
  });
  if (matches !== 2) throw notFound("이동할 패널이 없습니다.");
  return next;
}

export function resizeSplit(layout: Layout | null, splitId: string, requested: number): Layout {
  if (!layout) throw notFound("분할을 찾을 수 없습니다.");
  if (!Number.isFinite(requested)) throw invalid("분할 비율이 올바르지 않습니다.");
  const ratio = Math.max(WORKBENCH_MIN_RATIO, Math.min(WORKBENCH_MAX_RATIO, requested));
  let found = false;
  const next = mapLayout(layout, node => {
    if (node.type !== "split" || node.id !== splitId) return node;
    found = true;
    return ratio === node.ratio ? node : { ...node, ratio };
  });
  if (!found) throw notFound("분할을 찾을 수 없습니다.");
  return next;
}

function mapLayout(node: Layout, visit: (node: Layout) => Layout): Layout {
  const next = visit(node);
  if (next !== node || node.type === "pane") return next;
  const first = mapLayout(node.first, visit), second = mapLayout(node.second, visit);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}
