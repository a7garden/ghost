export const isHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
export const isGhostColor = (value: unknown): value is string => value === 'auto' || isHexColor(value);
export function faceColor(color: string) {
  const channels = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722 > .179 ? '#000000' : '#ffffff';
}

/** Body colors of the built-in Ghost: one ink, then hues that hold on light and dark surfaces. */
export const GHOST_PALETTE = [
  { name: '먹', color: '#1f2024' }, { name: '슬레이트', color: '#5d6675' }, { name: '빨강', color: '#ef4b3f' },
  { name: '주황', color: '#ff8a1f' }, { name: '호박', color: '#f2b600' }, { name: '라임', color: '#7cc242' },
  { name: '초록', color: '#1fa463' }, { name: '청록', color: '#14a6a6' }, { name: '하늘', color: '#2f9bff' },
  { name: '파랑', color: '#3d5cf5' }, { name: '보라', color: '#8a5cf6' }, { name: '분홍', color: '#f25ca2' },
] as const;

const DEFAULT_HUES = ['#3d5cf5', '#8a5cf6', '#14a6a6', '#ff8a1f', '#f25ca2', '#1fa463', '#2f9bff', '#ef4b3f'];

/** A Ghost that never chose a color still reads apart from the others: a stable hue from its id. */
export function defaultBodyColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return DEFAULT_HUES[hash % DEFAULT_HUES.length];
}
