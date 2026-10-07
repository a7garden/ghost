export const isGhostColor = (value: unknown): value is string => typeof value === 'string' && (value === 'auto' || /^#[0-9a-f]{6}$/i.test(value));
export function faceColor(color: string) {
  const channels = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722 > .179 ? '#000000' : '#ffffff';
}
