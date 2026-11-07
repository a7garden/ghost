import { MAX_IMAGE_BYTES, codexDesign } from './sprites';
import type { SpriteVersion } from './sprites';
import type { AvatarInput } from './PetEditor';
export type CodexManifest = Record<string, unknown> & { displayName: string; description?: string; spriteVersionNumber?: 1 | 2; spritesheetPath: string };
export function spritePath(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\\:%?#\u0000-\u001f]/.test(value) || value.startsWith('/')) throw new Error('spritesheetPath는 펫 폴더 안의 상대 경로여야 합니다.');
  const path = value.replace(/^\.\//, '');
  if (path.split('/').some(part => !part || part === '.' || part === '..') || !/\.(png|webp)$/i.test(path)) throw new Error('spritesheetPath에 PNG 또는 WebP의 상대 경로를 지정해 주세요.');
  return path;
}
export function parseManifest(text: string): CodexManifest {
  let m: unknown;
  try { m = JSON.parse(text); } catch { throw new Error('pet.json을 읽을 수 없습니다. JSON 형식을 확인해 주세요.'); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('pet.json은 객체 형식이어야 합니다.');
  const v = m as Record<string, unknown>, bytes = (s: string) => new TextEncoder().encode(s).length;
  if (typeof v.displayName !== 'string' || !v.displayName.trim() || bytes(v.displayName) > 240) throw new Error('pet.json의 displayName을 확인해 주세요.');
  if (v.description !== undefined && (typeof v.description !== 'string' || bytes(v.description) > 3000)) throw new Error('pet.json의 description을 확인해 주세요.');
  if (v.spriteVersionNumber !== undefined && v.spriteVersionNumber !== 1 && v.spriteVersionNumber !== 2) throw new Error('Codex 펫 v1 또는 v2를 선택해 주세요.');
  spritePath(v.spritesheetPath);
  return v as CodexManifest;
}
export async function readCodexSprite(file: File) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('이미지는 4 MiB 이하여야 합니다.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n);
  const webp = new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  if (!png && !webp) throw new Error('PNG 또는 WebP 스프라이트를 선택해 주세요.');
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  const image = `data:image/${png ? 'png' : 'webp'};base64,${btoa(chunks.join(''))}`;
  const element = new Image(); element.src = image;
  try { await element.decode(); } catch { throw new Error('스프라이트 이미지를 읽을 수 없습니다.'); }
  if (element.width !== 1536 || ![1872, 2288].includes(element.height)) throw new Error('펫 스프라이트는 1536 × 1872(v1) 또는 1536 × 2288(v2) 크기여야 합니다.');
  // Codex ignores unused atlas cells. Preserve the complete original, including those pixels.
  return { image, spriteVersion: element.height === 1872 ? 1 as const : 2 as const };
}
export async function importCodexPet(files: readonly File[], decode = readCodexSprite): Promise<AvatarInput> {
  const path = (file: File) => file.webkitRelativePath || file.name;
  const manifests = files.filter(file => path(file).split('/').at(-1) === 'pet.json');
  if (manifests.length !== 1) throw new Error('pet.json이 하나 들어 있는 펫 폴더를 선택해 주세요.');
  const manifest = manifests[0];
  if (manifest.size > 8 * 1024) throw new Error('pet.json은 8 KiB 이하여야 합니다.');
  const data = parseManifest(await manifest.text());
  const parent = path(manifest).slice(0, -'pet.json'.length);
  const matches = files.filter(file => path(file) === parent + spritePath(data.spritesheetPath));
  if (matches.length !== 1) throw new Error(`pet.json에 지정된 ${data.spritesheetPath} 파일을 찾을 수 없습니다. 폴더 전체를 선택해 주세요.`);
  const sprite = await decode(matches[0]);
  if (sprite.spriteVersion !== (data.spriteVersionNumber ?? 1)) throw new Error('pet.json의 버전과 스프라이트 크기가 일치하지 않습니다.');
  return { name: data.displayName, description: data.description ?? '', image: sprite.image, design: codexDesign(sprite.spriteVersion) };
}
