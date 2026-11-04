import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const maxArchive = 16 * 1024 * 1024;
const maxMembers = 256;
const validPath = path => typeof path === 'string' && path.length <= 240
  && path.split('/').every(part => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(part));
const slug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });
const palette = ['sky', 'mint', 'lilac', 'peach', 'sand', 'slate'];
const json = bytes => JSON.parse(decoder.decode(bytes));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const crcTable = Array.from({ length: 256 }, (_, index) => {
  for (let bit = 0; bit < 8; bit++) index = (index & 1 ? 0xedb88320 : 0) ^ (index >>> 1);
  return index >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Read the bounded single-disk ZIP subset used by .ghost. No archive members
// are extracted onto the filesystem. Local and central headers must agree.
function unzip(bytes) {
  check(bytes.length >= 22 && bytes.length <= maxArchive, '지원하는 패키지 크기를 벗어났습니다.');
  const end = bytes.length - 22;
  const u16 = p => bytes.readUInt16LE(p), u32 = p => bytes.readUInt32LE(p);
  const count = u16(end + 10), directory = u32(end + 16);
  check(u32(end) === 0x06054b50 && u32(end + 4) === 0 && u16(end + 8) === count
    && count > 0 && count <= maxMembers && u16(end + 20) === 0 && directory + u32(end + 12) === end, '지원하지 않는 ZIP 구조입니다.');
  let cursor = directory, localEnd = 0, total = 0;
  const files = new Map();
  const names = new Set();
  for (let i = 0; i < count; i++) {
    check(cursor + 46 <= end && u32(cursor) === 0x02014b50, 'ZIP 목록이 손상되었습니다.');
    const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16);
    const compressed = u32(cursor + 20), size = u32(cursor + 24), length = u16(cursor + 28), offset = u32(cursor + 42);
    const next = cursor + 46 + length + u16(cursor + 30) + u16(cursor + 32);
    const memberType = (u32(cursor + 38) >>> 16) & 0xf000;
    check(next <= end && u16(cursor + 34) === 0 && (memberType === 0 || memberType === 0x8000)
      && !(flags & ~0x0800) && (method === 0 || method === 8), '지원하지 않는 ZIP 항목입니다.');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + length);
    const name = decoder.decode(nameBytes);
    check(validPath(name) && !names.has(name.toLowerCase()), '패키지에 잘못되었거나 중복된 경로가 있습니다.');
    names.add(name.toLowerCase());
    check(offset === localEnd && offset + 30 + length <= directory && u32(offset) === 0x04034b50
      && u16(offset + 6) === flags && u16(offset + 8) === method && u32(offset + 14) === crc
      && u32(offset + 18) === compressed && u32(offset + 22) === size && u16(offset + 26) === length
      && bytes.subarray(offset + 30, offset + 30 + length).equals(nameBytes), 'ZIP 항목의 헤더가 일치하지 않습니다.');
    const dataOffset = offset + 30 + length + u16(offset + 28);
    localEnd = dataOffset + compressed;
    total += size;
    check(localEnd <= directory && total <= maxArchive && (method !== 0 || compressed === size), '압축을 푼 패키지가 너무 큽니다.');
    const raw = bytes.subarray(dataOffset, localEnd);
    const payload = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    check(payload.length === size && crc32(payload) === crc, 'ZIP 항목이 손상되었습니다.');
    files.set(name, payload);
    cursor = next;
  }
  check(cursor === end && localEnd === directory, 'ZIP 목록이 일치하지 않습니다.');
  return files;
}

function readWorkspace(files) {
  if (!files.has('ui/workspace.json')) {
    check(![...files.keys()].some(path => path.startsWith('ui/')), 'UI 메타데이터가 필요합니다.');
    return null;
  }
  const ui = json(files.get('ui/workspace.json'));
  check(ui?.schema === 'ghost-workspace/1' && ui.sdk === 'ghost-ui-sdk/1'
    && Array.isArray(ui.views) && ui.views.length <= 24 && Array.isArray(ui.requests) && ui.requests.length === 0,
  '지원하지 않는 작업실 또는 SDK 권한입니다.');
  check(ui.appearance?.portraitBackground === undefined || palette.includes(ui.appearance.portraitBackground), '초상화 색이 올바르지 않습니다.');
  const ids = new Set(), routes = new Set();
  for (const view of ui.views) {
    check(slug(view?.id) && !['chat', 'inbox', 'settings'].includes(view.id) && !ids.has(view.id)
      && typeof view.label === 'string' && view.label.trim() === view.label && view.label.length > 0 && view.label.length <= 48
      && typeof view.route === 'string' && /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(view.route) && !routes.has(view.route), '화면 ID, 이름 또는 경로가 올바르지 않습니다.');
    ids.add(view.id);
    routes.add(view.route);
  }
  check(ui.views.length ? ui.entry === 'dist/index.html' && files.has('ui/dist/index.html') && ids.has(ui.defaultView)
    : ui.entry === undefined && ui.defaultView === undefined, '작업실의 시작 화면이 올바르지 않습니다.');
  return {
    views: ui.views.map(({ id, label, route }) => ({ id, label, route })),
    defaultView: ui.defaultView, portraitBackground: ui.appearance?.portraitBackground,
  };
}

export function verifyPackage(bytes, trustedKeys) {
  const files = unzip(bytes);
  const manifestBytes = files.get('manifest.json'), signature = files.get('signature.ed25519');
  check(manifestBytes && manifestBytes.length <= 128 * 1024 && signature?.length === 64, '매니페스트 또는 서명이 없습니다.');
  const manifest = json(manifestBytes);
  const [publisher, packageId, ...extra] = typeof manifest?.id === 'string' ? manifest.id.split('/') : [];
  check(manifest?.schema === 'ghost-package/1' && slug(publisher) && slug(packageId) && !extra.length
    && typeof manifest.version === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(manifest.version)
    && typeof manifest.name === 'string' && manifest.name.trim().length > 0 && manifest.name.length <= 80
    && Array.isArray(manifest.files) && manifest.files.length === files.size - 2, '지원하지 않는 패키지 매니페스트입니다.');
  const pem = trustedKeys.get(publisher);
  check(pem, '신뢰 목록에 없는 배포자입니다.');
  const key = createPublicKey(pem);
  check(key.asymmetricKeyType === 'ed25519' && verify(null, manifestBytes, key, signature), '패키지 서명을 확인할 수 없습니다.');
  const covered = new Set(['manifest.json', 'signature.ed25519']);
  for (const item of manifest.files) {
    const path = item?.path;
    check(validPath(path) && /^(agent|ui)\//.test(path) && !covered.has(path), '매니페스트 파일 경로가 올바르지 않습니다.');
    const content = files.get(path);
    check(content && content.length === item.size && sha(content) === item.sha256, '패키지 파일 해시가 일치하지 않습니다.');
    covered.add(path);
  }
  const agent = json(files.get('agent/definition.json'));
  check(agent?.schema === 'ghost-agent/1' && files.has('agent/instructions.md'), 'Ghost 역할 정의가 필요합니다.');
  const ui = readWorkspace(files);
  return { metadata: { digest: sha(manifestBytes), id: manifest.id, name: manifest.name, version: manifest.version, ui }, files };
}

export function packPackage({ id, name, version }, payload, key) {
  const manifest = Buffer.from(JSON.stringify({ schema: 'ghost-package/1', id, name, version,
    files: [...payload].map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha(bytes) })) }));
  const files = new Map([['manifest.json', manifest], ['signature.ed25519', sign(null, manifest, key)], ...payload]);
  let offset = 0;
  const body = [], directory = [];
  for (const [path, bytes] of files) {
    check(validPath(path), '패키지 파일 경로가 올바르지 않습니다.');
    const name = Buffer.from(path), crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    body.push(local, name, bytes); directory.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  const index = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, index, end]);
}
