import { describe, expect, it, vi } from 'vitest';
import { importCodexPet, parseManifest, spritePath } from './codexImport';
import { faceColor, isGhostColor } from './appearance';
const manifest = { displayName: '카구야', description: '원본 설명', spriteVersionNumber: 2, spritesheetPath: 'assets/original.webp', custom: { untouched: true } };
const file = (name: string, contents: string | Uint8Array, path: string) => {
  const f = new File([typeof contents === 'string' ? contents : Uint8Array.from(contents)], name);
  Object.defineProperty(f, 'webkitRelativePath', { value: path }); return f;
};
describe('Codex folder import', () => {
  it('preserves manifest fields, the declared nested path, and original image bytes', async () => {
    const pixels = new Uint8Array([0, 23, 87, 255]), sprite = file('original.webp', pixels, 'pet/assets/original.webp');
    const decode = vi.fn(async (f: File) => ({ data_url: `data:image/webp;base64,${btoa(String.fromCharCode(...new Uint8Array(await f.arrayBuffer())))}`, sprite_version: 2 as const }));
    const pet = await importCodexPet([file('pet.json', JSON.stringify(manifest), 'pet/pet.json'), sprite], decode);
    expect(decode).toHaveBeenCalledWith(sprite);
    expect(pet.source_manifest).toEqual(manifest);
    expect(pet.name).toBe(manifest.displayName); expect(pet.description).toBe(manifest.description);
    expect(pet.design).toBeNull();
    expect(Uint8Array.from(atob(pet.data_url.split(',')[1]), s => s.charCodeAt(0))).toEqual(pixels);
  });
  it('rejects traversal, absolute paths, remote URLs and ambiguous folders', async () => {
    for (const path of ['../a.webp', '/a.webp', 'C:\\a.webp', 'https://example.test/a.webp', '%2e%2e/a.webp', 'a//b.webp']) expect(() => spritePath(path)).toThrow();
    const m = file('pet.json', JSON.stringify(manifest), 'a/pet.json');
    await expect(importCodexPet([m, file('pet.json', '{}', 'b/pet.json')])).rejects.toThrow('하나');
    await expect(importCodexPet([m])).rejects.toThrow('찾을 수 없습니다');
  });
  it('rejects unsupported versions and a manifest/image version mismatch', async () => {
    expect(() => parseManifest(JSON.stringify({ ...manifest, spriteVersionNumber: 3 }))).toThrow('v1 또는 v2');
    await expect(importCodexPet([file('pet.json', JSON.stringify(manifest), 'pet/pet.json'), file('original.webp', 'bytes', 'pet/assets/original.webp')], async () => ({ data_url: 'data:image/webp;base64,AQID', sprite_version: 1 }))).rejects.toThrow('일치하지');
  });
  it('uses v1 for legacy manifests without adding a field to the original', async () => {
    const legacy = { displayName: 'Legacy', spritesheetPath: 'spritesheet.png' };
    const pet = await importCodexPet([file('pet.json', JSON.stringify(legacy), 'pet/pet.json'), file('spritesheet.png', 'bytes', 'pet/spritesheet.png')], async () => ({ data_url: 'data:image/png;base64,AQID', sprite_version: 1 }));
    expect(pet.sprite_version).toBe(1); expect(pet.source_manifest).toEqual(legacy); expect(pet.source_manifest).not.toHaveProperty('spriteVersionNumber');
  });
});
it('validates persisted Ghost colors and chooses a contrasting face', () => {
  expect(isGhostColor('auto')).toBe(true); expect(isGhostColor('#a1B2C3')).toBe(true); expect(isGhostColor('url(https://example.test)')).toBe(false);
  expect(faceColor('#000000')).toBe('#ffffff'); expect(faceColor('#ffffff')).toBe('#000000');
});
