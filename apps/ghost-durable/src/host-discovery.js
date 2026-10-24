// Lightweight Host discovery shared by the Pi callback boundary. Keep this
// module independent of UI image transports and optional execution packages.
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';

const LIMIT = 1_048_576;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function discover(root) {
  if (!isAbsolute(root) || (await lstat(root)).isSymbolicLink()) throw new Error('Ghost 상태 폴더는 실제 절대 경로여야 합니다.');
  const handle = await open(join(root, '.ghost-control.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let metadata;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('호스트 접속 정보의 소유자와 파일 권한을 확인하세요.');
    metadata = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  const m = metadata;
  if (m.protocol !== 'ghost-control' || m.protocol_version !== 1 || m.host !== '127.0.0.1' || !Number.isInteger(m.port) || m.port < 1 || m.port > 65535 || !/^[a-fA-F0-9]{64}$/.test(m.token)) throw new Error('지원하지 않는 호스트 접속 정보입니다.');
  const origin = `http://127.0.0.1:${m.port}`;
  const nonce = randomBytes(16).toString('hex');
  // Authenticate the bound process before sending the host's secret token.
  const r = await fetch(`${origin}/api/v1/bootstrap/${nonce}`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  const proof = await boundedJSON(r);
  const expected = createHmac('sha256', m.token).update('ghost-control-bootstrap-v1\0').update(nonce).digest('hex');
  if (!r.ok || proof.protocol !== 'ghost-control' || proof.version !== 1 || !equal(proof.proof, expected)) throw new Error('실행 중인 Ghost 호스트의 신원을 확인하지 못했습니다.');
  return { origin, token: m.token };
}
async function boundedJSON(response) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) { size += chunk.length; if (size > 8 * LIMIT) throw new Error('호스트 응답이 너무 큽니다.'); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
