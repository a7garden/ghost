import { describe, expect, it } from 'vitest';
import { keyInputOf, modifierBitsOf, viewportPoint } from './BrowserLiveView';

describe('viewportPoint', () => {
  it('scales by the shown image when the frame fits the box exactly', () => {
    const box = { left: 0, top: 0, width: 800, height: 500 };
    expect(viewportPoint(400, 250, box, { width: 1600, height: 1000 })).toEqual({ x: 800, y: 500 });
    expect(viewportPoint(0, 0, box, { width: 1600, height: 1000 })).toEqual({ x: 0, y: 0 });
  });

  it('shifts by the pillar boxes of a horizontal letterbox', () => {
    const box = { left: 0, top: 0, width: 800, height: 500 };
    // A square frame shows 500px wide with 150px pillars; the image spans x 150–650.
    expect(viewportPoint(150, 250, box, { width: 1000, height: 1000 })).toEqual({ x: 0, y: 500 });
    expect(viewportPoint(325, 250, box, { width: 1000, height: 1000 })).toEqual({ x: 350, y: 500 });
    expect(viewportPoint(650, 0, box, { width: 1000, height: 1000 })).toEqual({ x: 1000, y: 0 });
  });

  it('shifts by the bars of a vertical letterbox and keeps the box offset', () => {
    const box = { left: 10, top: 20, width: 800, height: 500 };
    // A 400×800 portrait shows 250px wide, centered: the image spans x 285–535.
    expect(viewportPoint(285, 20, box, { width: 400, height: 800 })).toEqual({ x: 0, y: 0 });
    expect(viewportPoint(410, 270, box, { width: 400, height: 800 })).toEqual({ x: 200, y: 400 });
    expect(viewportPoint(535, 520, box, { width: 400, height: 800 })).toEqual({ x: 400, y: 800 });
  });

  it('clamps points that land outside the shown image', () => {
    const box = { left: 0, top: 0, width: 800, height: 500 };
    expect(viewportPoint(-50, 0, box, { width: 1000, height: 1000 })).toEqual({ x: 0, y: 0 });
    expect(viewportPoint(750, 600, box, { width: 1000, height: 1000 })).toEqual({ x: 1000, y: 1000 });
  });
});

describe('keyInputOf', () => {
  it('forwards special keys in both phases, carrying shift', () => {
    expect(keyInputOf('Enter', 'Enter', 0, 'down')).toEqual({ type: 'key', event: 'down', key: 'Enter', code: 'Enter', modifiers: 0 });
    expect(keyInputOf('Tab', 'Tab', 8, 'down')).toEqual({ type: 'key', event: 'down', key: 'Tab', code: 'Tab', modifiers: 8 });
    expect(keyInputOf('ArrowLeft', 'ArrowLeft', 8, 'up')).toEqual({ type: 'key', event: 'up', key: 'ArrowLeft', code: 'ArrowLeft', modifiers: 8 });
    expect(keyInputOf('PageDown', 'PageDown', 0, 'down')).toEqual({ type: 'key', event: 'down', key: 'PageDown', code: 'PageDown', modifiers: 0 });
  });

  it('forwards special-key modifiers and leaves printables for the text field', () => {
    expect(keyInputOf('Enter', 'Enter', 2, 'down')).toEqual({ type: 'key', event: 'down', key: 'Enter', code: 'Enter', modifiers: 2 });
    expect(keyInputOf('Escape', 'Escape', 4, 'up')).toEqual({ type: 'key', event: 'up', key: 'Escape', code: 'Escape', modifiers: 4 });
    expect(keyInputOf('A', 'KeyA', 8, 'down')).toEqual({ type: 'key', event: 'down', key: 'A', code: 'KeyA', text: 'A', modifiers: 8 });
    expect(keyInputOf('a', 'KeyA', 2, 'down')).toEqual({ type: 'key', event: 'down', key: 'a', code: 'KeyA', modifiers: 2 });
    expect(keyInputOf('a', 'KeyA', 0, 'down')).toBeNull(); // printable text goes through the field
    expect(keyInputOf('ㅇ', 'KeyD', 0, 'down')).toBeNull(); // Hangul goes through the IME field
  });
});

describe('modifierBitsOf', () => {
  it('packs alt, ctrl, meta and shift in the host order', () => {
    const base = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(modifierBitsOf(base)).toBe(0);
    expect(modifierBitsOf({ ...base, altKey: true })).toBe(1);
    expect(modifierBitsOf({ ...base, ctrlKey: true })).toBe(2);
    expect(modifierBitsOf({ ...base, metaKey: true })).toBe(4);
    expect(modifierBitsOf({ ...base, shiftKey: true })).toBe(8);
    expect(modifierBitsOf({ ...base, altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  });
});
