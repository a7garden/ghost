import { describe, expect, it } from 'vitest';
import { frameDuration, isDesign, lookFrame, rowFor, spriteVersionOf } from './sprites';

describe('stored avatar sprites', () => {
  it('maps state rows, variable idle timing and clockwise gaze starting at north', () => {
    expect(rowFor('review')).toBe(8); expect(rowFor('running')).toBe(7);
    expect(frameDuration(0, 0)).toBe(1680); expect(frameDuration(1, 7)).toBe(220);
    expect(lookFrame(0, -10)).toEqual({ row: 9, column: 0 });
    expect(lookFrame(10, 0)).toEqual({ row: 9, column: 4 });
    expect(lookFrame(0, 10)).toEqual({ row: 10, column: 0 });
    expect(lookFrame(-10, 0)).toEqual({ row: 10, column: 4 });
  });
  it('does not accept unknown design controls', () => {
    expect(isDesign({ color: 'url(evil)', shape: 'ghost', eyes: 'classic', accessory: 'none' })).toBe(false);
  });
  it('reads the sprite layout from a persisted design record', () => {
    expect(spriteVersionOf({ color: '#8bbca7', shape: 'ghost', eyes: 'classic', accessory: 'none', spriteVersion: 2 })).toBe(2);
    expect(spriteVersionOf({ kind: 'codex', spriteVersion: 1 })).toBe(1);
    expect(spriteVersionOf(null)).toBe(2);
    expect(spriteVersionOf({ kind: 'codex', spriteVersion: 3 })).toBe(2);
  });
});
