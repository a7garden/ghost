import type { SpriteVersion } from './sprites';

const encoder = new TextEncoder();
export function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
// Stored ZIP entries: no dependency, no hidden installation, path traversal impossible.
export function zipFiles(files: { name: string; bytes: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const records: Uint8Array[] = [], directory: Uint8Array[] = []; let offset = 0;
  for (const file of files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.name) || file.name.startsWith('/') || file.name.split('/').includes('..')) throw new Error('잘못된 파일 이름입니다.');
    const name = encoder.encode(file.name), crc = crc32(file.bytes);
    const local = new Uint8Array(30 + name.length), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(12, 33, true);
    l.setUint32(14, crc, true); l.setUint32(18, file.bytes.length, true); l.setUint32(22, file.bytes.length, true); l.setUint16(26, name.length, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(14, 33, true);
    c.setUint32(16, crc, true); c.setUint32(20, file.bytes.length, true); c.setUint32(24, file.bytes.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true); central.set(name, 46);
    records.push(local, file.bytes); directory.push(central); offset += local.length + file.bytes.length;
  }
  const size = directory.reduce((sum, d) => sum + d.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, offset, true);
  const output = new Uint8Array(offset + size + end.length); let position = 0;
  for (const part of [...records, ...directory, end]) { output.set(part, position); position += part.length; }
  return output;
}
export function petBundle(name: string, description: string, version: SpriteVersion, dataURL: string) {
  const match = /^data:image\/(png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataURL);
  if (!match) throw new Error('내보낼 이미지가 올바르지 않습니다.');
  const filename = `spritesheet.${match[1]}`;
  const pixels = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
  const suffix = (crc32(encoder.encode(name)) ^ crc32(pixels)) >>> 0;
  const folder = `ghost-${name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pet'}-${suffix.toString(16).padStart(8, '0')}`;
  const manifest = { displayName: name, description, spriteVersionNumber: version, spritesheetPath: filename };
  return { filename: `${folder}.zip`, bytes: zipFiles([
    { name: `${folder}/pet.json`, bytes: encoder.encode(JSON.stringify(manifest, null, 2)) },
    { name: `${folder}/${filename}`, bytes: pixels },
  ]) };
}
export function downloadPet(name: string, description: string, version: SpriteVersion, dataURL: string) {
  const file = petBundle(name, description, version, dataURL);
  const url = URL.createObjectURL(new Blob([file.bytes], { type: 'application/zip' }));
  const link = document.createElement('a'); link.href = url; link.download = file.filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
