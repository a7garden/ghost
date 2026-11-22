import { describe, expect, it } from 'vitest';
import { followingTerminalTop, isHistoryPageKey, OBSERVED_TERMINAL_ROWS, terminalDragOffset, terminalHistoryBoundary,
  terminalUsedRows, terminalWheelOffset } from './herdrTerminalScroll';

describe('terminal scroll intent', () => {
  it('keeps signed wheel displacement and normalizes line and page deltas', () => {
    expect(terminalWheelOffset(3, -184, 0, 16, 480)).toBe(-184);
    expect(terminalWheelOffset(0, -3, 1, 16, 480)).toBe(-48);
    expect(terminalWheelOffset(0, 2, 2, 16, 480)).toBe(960);
    expect(terminalWheelOffset(-190, -40, 0, 16, 480)).toBe(0);
  });

  it('enters history for a downward drag, not a tap, side swipe or upward drag', () => {
    expect(terminalDragOffset(-3, 32)).toBe(-32);
    expect(terminalDragOffset(0, 7)).toBe(0);
    expect(terminalDragOffset(-45, 24)).toBe(0);
    expect(terminalDragOffset(5, -38)).toBe(0);
  });

  it('reserves Shift+PageUp while live and both page keys in history', () => {
    expect(isHistoryPageKey('PageUp', true, false)).toBe(true);
    expect(isHistoryPageKey('PageUp', false, false)).toBe(false);
    expect(isHistoryPageKey('PageDown', true, false)).toBe(false);
    expect(isHistoryPageKey('PageDown', false, true)).toBe(true);
    expect(isHistoryPageKey('PageUp', false, true)).toBe(true);
    expect(isHistoryPageKey('ArrowUp', true, true)).toBe(false);
  });
});

describe('live observer projection', () => {
  it('discards padding but retains non-empty lines after the cursor or a blank cursor line after output', () => {
    const textAt = (row: number) => row === 42 ? 'shell output' : '  ';
    expect(terminalUsedRows(OBSERVED_TERMINAL_ROWS, 35, textAt)).toBe(43);
    expect(terminalUsedRows(OBSERVED_TERMINAL_ROWS, 48, textAt)).toBe(49);
    expect(terminalUsedRows(OBSERVED_TERMINAL_ROWS, 0, () => undefined)).toBe(1);
  });

  it('follows growth and keyboard resize, preserving a paused offset unless the content shrinks past it', () => {
    expect(followingTerminalTop(90, 350, true)).toBe(350);
    expect(followingTerminalTop(90, 350, false)).toBe(90);
    expect(followingTerminalTop(90, 42, false)).toBe(42);
  });

  it('aligns history to the canonical top using the latest matching pair, with a safe tail fallback', () => {
    const text = ['head', 'prompt', 'context', 'older', 'prompt', 'context', 'tail', ''];
    const anchor = { row: 1, line: 'prompt', next: 'context' };
    expect(terminalHistoryBoundary(6, 2, anchor, row => text[row])).toBe(3);
    expect(terminalHistoryBoundary(6, 2, { ...anchor, next: 'different' }, row => text[row])).toBe(6);
  });
});
