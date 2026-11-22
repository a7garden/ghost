export const OBSERVED_TERMINAL_ROWS = 120;

/** Ignore observer padding, but keep room for the cursor on an otherwise empty prompt. */
export function terminalUsedRows(rows: number, cursorRow: number, textAt: (row: number) => string | undefined): number {
  for (let row = rows - 1; row > cursorRow; row--) {
    if (textAt(row)?.trimEnd()) return row + 1;
  }
  return cursorRow + 1;
}

export function followingTerminalTop(top: number, end: number, following: boolean): number {
  return following ? end : Math.min(top, end);
}

export type TerminalAnchor = { row: number; line: string; next: string };

export function terminalHistoryBoundary(base: number, rows: number, anchor: TerminalAnchor | null, textAt: (row: number) => string | undefined): number {
  if (!anchor) return base;
  for (let row = base + rows - 2; row >= anchor.row; row--) {
    if (textAt(row) === anchor.line && textAt(row + 1) === anchor.next) return Math.min(base, row - anchor.row);
  }
  return base;
}

export function terminalWheelOffset(deltaX: number, deltaY: number, mode: number, row: number, page: number): number {
  if (Math.abs(deltaX) >= Math.abs(deltaY)) return 0;
  return deltaY * (mode === 1 ? row : mode === 2 ? page : 1);
}

export function terminalDragOffset(dx: number, dy: number): number {
  return dy >= 8 && dy > Math.abs(dx) ? -dy : 0;
}

export function isHistoryPageKey(key: string, shift: boolean, scrolled: boolean): boolean {
  return scrolled ? key === 'PageUp' || key === 'PageDown' : shift && key === 'PageUp';
}
