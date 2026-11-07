// Codex desktop format, verified against its installed pet loader and renderer.
export const CELL = { width: 192, height: 208 };
export const FRAME_COUNTS = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8] as const;
export type SpriteVersion = 1 | 2;
export type PetState = 'idle' | 'running-right' | 'running-left' | 'waving' | 'jumping' | 'failed' | 'waiting' | 'running' | 'review';
export const STATES: { key: PetState; label: string }[] = [
  { key: 'idle', label: '대기' }, { key: 'running-right', label: '오른쪽 걷기' }, { key: 'running-left', label: '왼쪽 걷기' },
  { key: 'waving', label: '인사' }, { key: 'jumping', label: '점프' }, { key: 'failed', label: '실패' },
  { key: 'waiting', label: '확인 대기' }, { key: 'running', label: '작업 중' }, { key: 'review', label: '검토' },
];
export interface PetDesign { color: string; shape: 'ghost' | 'cloud' | 'round'; eyes: 'classic' | 'happy' | 'sleepy'; accessory: 'none' | 'sprout' | 'halo' | 'glasses'; }
export function isDesign(d: unknown): d is PetDesign {
  const v = d as PetDesign | undefined;
  return Boolean(v && /^#[0-9a-f]{6}$/i.test(v.color) && ['ghost', 'cloud', 'round'].includes(v.shape) && ['classic', 'happy', 'sleepy'].includes(v.eyes) && ['none', 'sprout', 'halo', 'glasses'].includes(v.accessory));
}
export const rowsFor = (version: SpriteVersion) => version === 2 ? 11 : 9;
export const rowFor = (state: PetState) => STATES.findIndex(s => s.key === state);
/**
 * Sprite layout of a persisted avatar design. UI-created pets are always v2;
 * imported Codex pets store `{ kind: 'codex', spriteVersion }` as their design.
 */
export function spriteVersionOf(design: unknown): SpriteVersion {
  if (isDesign(design)) return 2;
  const version = (design as { spriteVersion?: unknown } | null | undefined)?.spriteVersion;
  return version === 1 ? 1 : 2;
}
export function lookFrame(x: number, y: number) {
  const index = Math.round((Math.atan2(x, -y) * 180 / Math.PI + 360) % 360 / 22.5) % 16;
  return { row: 9 + Math.floor(index / 8), column: index % 8 };
}
export function frameDuration(row: number, column: number) {
  if (row === 0) return [280, 110, 110, 140, 140, 320][column] * 6;
  const regular = [0, 120, 120, 140, 140, 140, 150, 120, 150][row];
  const last = [0, 220, 220, 280, 280, 240, 260, 220, 280][row];
  return column === FRAME_COUNTS[row] - 1 ? last : regular;
}
