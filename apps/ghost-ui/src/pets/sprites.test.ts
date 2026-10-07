import { describe, expect, it } from 'vitest';
import { FRAME_COUNTS, frameDuration, isDesign, lookFrame, rowFor, validatePixels } from './sprites';
import { petBundle, zipFiles } from './archive';

function fixture(rows = 11) {
  const width = 1536, height = rows * 208, data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < rows; row++) for (let column = 0; column < FRAME_COUNTS[row]; column++) {
    for (let x = 70; x < 102; x++) for (let y = 70; y < 102; y++) data[((row * 208 + y) * width + column * 192 + x) * 4 + 3] = 255;
  }
  return { data, width, height };
}
describe('Codex pet compatibility', () => {
  it('accepts complete v1 and v2 grids', () => {
    for (const rows of [9, 11]) { const { data, width, height } = fixture(rows); expect(validatePixels(data, width, height)).toBe(rows === 9 ? 1 : 2); }
  });
  it('rejects static pictures, empty action frames, and pixels in unused cells', () => {
    const f = fixture();
    expect(() => validatePixels(f.data, 512, 512)).toThrow('1536');
    f.data.fill(0, 0, 1536 * 208 * 4); expect(() => validatePixels(f.data, f.width, f.height)).toThrow('그림이 없습니다');
    const g = fixture(); g.data[(7 * 192) * 4 + 3] = 1; expect(() => validatePixels(g.data, g.width, g.height)).toThrow('빈 칸');
  });
  it('rejects flattened opaque backgrounds', () => {
    const f = fixture(); for (let i = 3; i < f.data.length; i += 4) f.data[i] = 255;
    expect(() => validatePixels(f.data, f.width, f.height)).toThrow('투명');
  });
  it('maps state rows, variable idle timing and clockwise gaze starting at north', () => {
    expect(rowFor('review')).toBe(8); expect(rowFor('running')).toBe(7);
    expect(frameDuration(0, 0)).toBe(1680); expect(frameDuration(1, 7)).toBe(220);
    expect(lookFrame(0, -10)).toEqual({ row: 9, column: 0 });
    expect(lookFrame(10, 0)).toEqual({ row: 9, column: 4 });
    expect(lookFrame(0, 10)).toEqual({ row: 10, column: 0 });
    expect(lookFrame(-10, 0)).toEqual({ row: 10, column: 4 });
  });
  it('does not accept unknown design controls or paths in exported names', () => {
    expect(isDesign({ color: 'url(evil)', shape: 'ghost', eyes: 'classic', accessory: 'none' })).toBe(false);
    expect(() => zipFiles([{ name: '../pet.json', bytes: new Uint8Array() }])).toThrow();
    const result = petBundle('../../새싹', 'original', 2, 'data:image/png;base64,AQID');
    const decoded = new TextDecoder().decode(result.bytes);
    expect(result.filename).toMatch(/^ghost-pet-[a-f0-9]{8}\.zip$/);
    expect(petBundle('다른 고스트', 'original', 2, 'data:image/png;base64,AQID').filename).not.toBe(result.filename);
    expect(decoded).toContain('"spriteVersionNumber": 2');
    expect(decoded).toContain('"spritesheetPath": "spritesheet.png"');
    expect(decoded).toContain(`${result.filename.slice(0, -4)}/pet.json`);
  });
});
