import { describe, expect, it, vi } from 'vitest';
import { importCodexPet, parseManifest, spritePath } from './codexImport';
import { faceColor } from './appearance';
import { spriteVersionOf } from './sprites';
const manifest = { displayName: '카구야', description: '원본 설명', spriteVersionNumber: 2, spritesheetPath: 'assets/original.webp', custom: { untouched: true } };
const file = (name: string, contents: string | Uint8Array, path: string) => {
  const f = new File([typeof contents === 'string' ? contents : Uint8Array.from(contents)], name);
  Object.defineProperty(f, 'webkitRelativePath', { value: path }); return f;
};
describe('Codex folder import', () => {
  it('takes the manifest name and description, the declared nested path, and original image bytes', async () => {
    const pixels = new Uint8Array([0, 23, 87, 255]), sprite = file('original.webp', pixels, 'pet/assets/original.webp');
    const decode = vi.fn(async (f: File) => ({ image: `data:image/webp;base64,${btoa(String.fromCharCode(...new Uint8Array(await f.arrayBuffer())))}`, spriteVersion: 2 as const }));
    const pet = await importCodexPet([file('pet.json', JSON.stringify(manifest), 'pet/pet.json'), sprite], decode);
    expect(decode).toHaveBeenCalledWith(sprite);
    expect(pet.name).toBe(manifest.displayName); expect(pet.description).toBe(manifest.description);
    expect(pet.design).toEqual({ kind: 'codex', spriteVersion: 2 });
    expect(spriteVersionOf(pet.design)).toBe(2);
    expect(Uint8Array.from(atob(pet.image.split(',')[1]), s => s.charCodeAt(0))).toEqual(pixels);
  });
  it('rejects traversal, absolute paths, remote URLs and ambiguous folders', async () => {
    for (const path of ['../a.webp', '/a.webp', 'C:\\a.webp', 'https://example.test/a.webp', '%2e%2e/a.webp', 'a//b.webp']) expect(() => spritePath(path)).toThrow();
    const m = file('pet.json', JSON.stringify(manifest), 'a/pet.json');
    await expect(importCodexPet([m, file('pet.json', '{}', 'b/pet.json')])).rejects.toThrow('하나');
    await expect(importCodexPet([m])).rejects.toThrow('찾을 수 없습니다');
  });
  it('rejects unsupported versions and a manifest/image version mismatch', async () => {
    expect(() => parseManifest(JSON.stringify({ ...manifest, spriteVersionNumber: 3 }))).toThrow('v1 또는 v2');
    await expect(importCodexPet([file('pet.json', JSON.stringify(manifest), 'pet/pet.json'), file('original.webp', 'bytes', 'pet/assets/original.webp')], async () => ({ image: 'data:image/webp;base64,AQID', spriteVersion: 1 }))).rejects.toThrow('일치하지');
  });
  it('marks legacy manifests without a version as v1', async () => {
    const legacy = { displayName: 'Legacy', spritesheetPath: 'spritesheet.png' };
    const pet = await importCodexPet([file('pet.json', JSON.stringify(legacy), 'pet/pet.json'), file('spritesheet.png', 'bytes', 'pet/spritesheet.png')], async () => ({ image: 'data:image/png;base64,AQID', spriteVersion: 1 }));
    expect(pet.design).toEqual({ kind: 'codex', spriteVersion: 1 });
    expect(spriteVersionOf(pet.design)).toBe(1);
  });
});
it('chooses a contrasting face for a Ghost body color', () => {
  expect(faceColor('#000000')).toBe('#ffffff'); expect(faceColor('#ffffff')).toBe('#000000');
});
