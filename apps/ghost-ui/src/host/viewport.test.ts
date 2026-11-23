import { describe, expect, it } from 'vitest';
import { keyboardOpen } from './viewport';

describe('soft keyboard detection', () => {
  it('sees Safari, where only the visual viewport shrinks', () => {
    expect(keyboardOpen(874, 520, 874, true)).toBe(true);
    expect(keyboardOpen(874, 520, 874, false)).toBe(true);
  });
  it('sees the iPhone shell, where the layout viewport shrinks with the keyboard', () => {
    expect(keyboardOpen(478, 478, 874, true)).toBe(true);
  });
  it('does not take a shorter window, a collapsing toolbar or no focus for a keyboard', () => {
    expect(keyboardOpen(478, 478, 874, false)).toBe(false);
    expect(keyboardOpen(780, 780, 874, true)).toBe(false);
    expect(keyboardOpen(874, 874, 874, true)).toBe(false);
  });
});
