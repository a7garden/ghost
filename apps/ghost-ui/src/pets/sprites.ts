// Codex desktop format, verified against its installed pet loader and renderer.
export const CELL = { width: 192, height: 208 };
export const FRAME_COUNTS = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8] as const;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export type SpriteVersion = 1 | 2;
export type PetState = 'idle' | 'running-right' | 'running-left' | 'waving' | 'jumping' | 'failed' | 'waiting' | 'running' | 'review';
export const STATES: { key: PetState; label: string }[] = [
  { key: 'idle', label: '대기' }, { key: 'running-right', label: '오른쪽 걷기' }, { key: 'running-left', label: '왼쪽 걷기' },
  { key: 'waving', label: '인사' }, { key: 'jumping', label: '점프' }, { key: 'failed', label: '실패' },
  { key: 'waiting', label: '확인 대기' }, { key: 'running', label: '작업 중' }, { key: 'review', label: '검토' },
];
export interface PetDesign { color: string; shape: 'ghost' | 'cloud' | 'round'; eyes: 'classic' | 'happy' | 'sleepy'; accessory: 'none' | 'sprout' | 'halo' | 'glasses'; }
export const COLORS = [
  { name: '민트', value: '#8bbca7' }, { name: '복숭아', value: '#e9af97' }, { name: '라일락', value: '#afa4d2' },
  { name: '하늘', value: '#93b9d1' }, { name: '크림', value: '#d6bf83' }, { name: '진주', value: '#c8ccd0' },
];
export const DEFAULT_DESIGN: PetDesign = { color: COLORS[0].value, shape: 'ghost', eyes: 'classic', accessory: 'none' };
export function isDesign(d: unknown): d is PetDesign {
  const v = d as PetDesign | undefined;
  return Boolean(v && /^#[0-9a-f]{6}$/i.test(v.color) && ['ghost', 'cloud', 'round'].includes(v.shape) && ['classic', 'happy', 'sleepy'].includes(v.eyes) && ['none', 'sprout', 'halo', 'glasses'].includes(v.accessory));
}
export const rowsFor = (version: SpriteVersion) => version === 2 ? 11 : 9;
export const rowFor = (state: PetState) => STATES.findIndex(s => s.key === state);
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
export function validatePixels(data: Uint8ClampedArray, width: number, height: number): SpriteVersion {
  const version = height === 1872 ? 1 : height === 2288 ? 2 : null;
  if (width !== 1536 || !version || data.length !== width * height * 4) throw new Error('1536 × 1872(v1) 또는 1536 × 2288(v2) 크기의 펫 스프라이트를 선택해 주세요.');
  for (let row = 0; row < rowsFor(version); row++) for (let column = 0; column < 8; column++) {
    let visible = 0, transparent = 0;
    for (let y = row * CELL.height; y < (row + 1) * CELL.height; y++) for (let x = column * CELL.width; x < (column + 1) * CELL.width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 0) visible++; else transparent++;
    }
    if (column < FRAME_COUNTS[row]) {
      if (visible < 32) throw new Error(`${row + 1}행 ${column + 1}번째 동작에 그림이 없습니다.`);
      if (transparent < CELL.width * CELL.height / 5) throw new Error(`${row + 1}행 ${column + 1}번째 동작의 배경을 투명하게 해 주세요.`);
    } else if (visible) throw new Error(`${row + 1}행 ${column + 1}번째 빈 칸에 그림이 있습니다.`);
  }
  return version;
}
export async function importSprite(file: File): Promise<{ data_url: string; sprite_version: SpriteVersion }> {
  if (!['image/png', 'image/webp'].includes(file.type)) throw new Error('PNG 또는 WebP 파일을 선택해 주세요.');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('이미지는 4 MiB 이하여야 합니다.');
  // Use the same data: source for decoding and storage; production CSP allows
  // local image data without opening blob: or remote image origins.
  const data_url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('파일을 읽을 수 없습니다.')); reader.readAsDataURL(file); });
  const img = new Image(); img.src = data_url;
  try { await img.decode(); } catch { throw new Error('손상된 이미지이거나 지원하지 않는 이미지 형식입니다.'); }
  if (img.width !== 1536 || ![1872, 2288].includes(img.height)) throw new Error('펫 스프라이트는 1536 × 1872(v1) 또는 1536 × 2288(v2) 크기여야 합니다.');
  const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) throw new Error('이미지를 읽을 수 없습니다.');
  ctx.drawImage(img, 0, 0);
  const sprite_version = validatePixels(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  return { data_url, sprite_version };
}

// Original Ghost artwork, drawn at runtime so the editor works fully offline.
export function createSpriteSheet(design: PetDesign): string {
  const canvas = document.createElement('canvas'); canvas.width = 1536; canvas.height = 2288;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('이 브라우저에서는 아바타를 만들 수 없습니다.');
  for (let row = 0; row < 11; row++) for (let column = 0; column < FRAME_COUNTS[row]; column++) {
    ctx.save(); ctx.translate(column * 192, row * 208); drawGhost(ctx, design, row, column); ctx.restore();
  }
  return canvas.toDataURL('image/png');
}
function drawGhost(ctx: CanvasRenderingContext2D, design: PetDesign, row: number, frame: number) {
  const phase = frame / FRAME_COUNTS[row] * Math.PI * 2;
  const walking = row === 1 || row === 2 || row === 7;
  const bob = Math.sin(phase) * (walking ? 6 : 3);
  const jump = row === 4 ? -Math.sin(frame / 4 * Math.PI) * 24 : 0;
  const look = row >= 9 ? (row - 9) * 8 + frame : -1;
  const dx = look < 0 ? (row === 1 ? 7 : row === 2 ? -7 : 0) : Math.sin(look * Math.PI / 8) * 9;
  const dy = look < 0 ? 0 : -Math.cos(look * Math.PI / 8) * 7;
  ctx.fillStyle = 'rgba(30,35,40,.12)'; ctx.beginPath(); ctx.ellipse(96, 184, 34 + jump / 3, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.translate(96 + (row === 5 ? Math.sin(phase) * 4 : 0), 121 + bob + jump);
  ctx.rotate(walking ? Math.sin(phase) * .08 : 0);
  const gradient = ctx.createLinearGradient(-38, -62, 45, 67);
  gradient.addColorStop(0, '#ffffff'); gradient.addColorStop(.22, design.color); gradient.addColorStop(1, shade(design.color, -.14));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  if (design.shape === 'ghost') {
    ctx.moveTo(-51, 48); ctx.bezierCurveTo(-52, 13, -56, -63, 0, -63); ctx.bezierCurveTo(56, -63, 52, 13, 51, 48);
    ctx.quadraticCurveTo(37, 31, 27, 48); ctx.quadraticCurveTo(13, 64, 0, 48); ctx.quadraticCurveTo(-13, 33, -27, 48); ctx.quadraticCurveTo(-38, 61, -51, 48);
  } else if (design.shape === 'cloud') {
    ctx.moveTo(-43, 44); ctx.bezierCurveTo(-78, 35, -68, -9, -48, -16); ctx.bezierCurveTo(-53, -64, -16, -72, 0, -49); ctx.bezierCurveTo(26, -79, 58, -49, 49, -18); ctx.bezierCurveTo(83, 1, 65, 47, 42, 43); ctx.bezierCurveTo(30, 66, 7, 63, 0, 49); ctx.bezierCurveTo(-13, 66, -37, 64, -43, 44);
  } else { ctx.ellipse(0, 0, 55, 61, 0, 0, Math.PI * 2); }
  ctx.closePath(); ctx.fill();
  // Floating hands make each action readable, including when rendered very small.
  ctx.fillStyle = design.color;
  for (const side of [-1, 1]) {
    const handY = row === 3 && side === 1 ? -36 + Math.sin(phase) * 14 : 10 + (walking ? Math.sin(phase) * 9 * side : 0);
    ctx.beginPath(); ctx.ellipse(side * 56, handY, 10, 16, side * -.4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#29323b'; ctx.strokeStyle = '#29323b'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
  const blink = row === 0 && frame === 2;
  for (const x of [-17, 17]) {
    ctx.beginPath();
    if (design.eyes === 'happy' || row === 3 || row === 4) { ctx.arc(x + dx, -9 + dy, 6, Math.PI, 0); ctx.stroke(); }
    else if (blink || design.eyes === 'sleepy') { ctx.moveTo(x - 5 + dx, -8 + dy); ctx.lineTo(x + 5 + dx, -8 + dy); ctx.stroke(); }
    else { ctx.ellipse(x + dx, -10 + dy, 4.8, row === 5 ? 5 : 8, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.beginPath(); ctx.moveTo(-5 + dx, 14 + dy); ctx.quadraticCurveTo(dx, row === 5 ? 7 + dy : 20 + dy, 5 + dx, 14 + dy); ctx.stroke();
  if (design.accessory === 'glasses') {
    for (const x of [-17, 17]) { ctx.beginPath(); ctx.arc(x + dx, -10 + dy, 12, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(-5 + dx, -11 + dy); ctx.lineTo(5 + dx, -11 + dy); ctx.stroke();
  }
  if (design.accessory === 'halo') {
    ctx.strokeStyle = '#e1b75e'; ctx.lineWidth = 5; ctx.beginPath(); ctx.ellipse(0, -79, 27, 7, -.12, 0, Math.PI * 2); ctx.stroke();
  }
  if (design.accessory === 'sprout') {
    ctx.strokeStyle = '#598369'; ctx.beginPath(); ctx.moveTo(0, -61); ctx.quadraticCurveTo(4, -77, -1, -83); ctx.stroke();
    ctx.fillStyle = '#7eab78'; ctx.beginPath(); ctx.ellipse(-10, -79, 13, 6, .45, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.ellipse(11, -86, 14, 7, -.5, 0, Math.PI * 2); ctx.fill();
  }
  if (row === 6) { ctx.fillStyle = '#29323b'; ctx.font = '600 26px sans-serif'; ctx.fillText('?', 44, -59 + Math.sin(phase) * 3); }
  if (row === 7 || row === 8) {
    ctx.fillStyle = '#f7f8f9'; ctx.strokeStyle = '#87929b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(-25, 28, 50, 33, 5); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-14, 39); ctx.lineTo(14, 39); ctx.moveTo(-14, 47); ctx.lineTo(row === 8 ? 5 : 14 + Math.sin(phase) * 4, 47); ctx.stroke();
  }
}
function shade(hex: string, amount: number) {
  const values = [1, 3, 5].map(i => Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) + amount * 255))));
  return `rgb(${values.join(',')})`;
}
