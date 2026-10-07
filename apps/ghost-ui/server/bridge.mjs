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
async function readVoiceBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 6 * 1024 * 1024) throw new Error('음성 요청 크기를 줄여 주세요.'); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw);
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.profile_id !== 'string' || typeof body.conversation_id !== 'string') throw new Error('음성 대화를 선택해 주세요.');
  return raw;
}
async function readBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 8 * LIMIT) throw new Error('요청 크기를 줄여 주세요.'); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw);
  if (typeof body.request_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.request_id) || !body.command || typeof body.command.type !== 'string') throw new Error('잘못된 명령 형식입니다.');
  if (size > LIMIT && !(body.command.type === 'workspace' && body.command.action?.type === 'create_avatar')) throw new Error('요청 크기를 줄여 주세요.');
  return raw;
}
function json(response, code, data) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
  response.end(JSON.stringify(data));
}
export function createBridge({ root = process.env.GHOST_ROOT } = {}) {
  const csrf = randomBytes(32).toString('hex');
  return async (req, res, next = () => json(res, 404, { error: 'not_found' })) => {
    if (!req.url?.startsWith('/ghost-api/')) return next();
    const expectedHost = `127.0.0.1:${req.socket.localPort}`;
    const origin = `http://${expectedHost}`;
    if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return json(res, 403, { error: '다른 출처의 요청은 허용하지 않습니다.' });
    if (req.url === '/ghost-api/bootstrap' && req.method === 'GET') return json(res, 200, { mode: root ? 'live' : 'demo', csrf, protocol: 'ghost-ui', protocol_version: 1, owner_pid: Number(process.env.GHOST_CONSOLE_OWNER_PID || process.pid) });
    if (!equal(req.headers['x-ghost-ui-csrf'], csrf)) return json(res, 403, { error: '페이지를 새로고침하고 다시 시도하세요.' });
    const voice = req.method === 'POST' && /^\/ghost-api\/voice\/(config|transcribe|synthesize)$/.test(req.url);
    const write = (req.url === '/ghost-api/action' || voice) && req.method === 'POST';
    const read = req.url === '/ghost-api/snapshot' && req.method === 'GET';
    if (!write && !read) return json(res, 404, { error: 'not_found' });
    if (write && (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json')) return json(res, 403, { error: '요청의 출처와 형식을 확인하세요.' });
    if (!root) return json(res, 503, { error: '예시 모드에는 연결된 호스트가 없습니다.' });
    try {
      const body = voice ? await readVoiceBody(req) : write ? await readBody(req) : undefined;
      const host = await discover(root);
      const disconnected = new AbortController();
      const closed = () => { if (!res.writableEnded) disconnected.abort(); };
      res.once('close', closed);
      const target = voice ? req.url.slice('/ghost-api/'.length) : write ? 'action' : 'snapshot';
      const upstream = await fetch(`${host.origin}/api/v1/${target}`, {
        method: write ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(voice ? 130000 : 30000)]), body,
        headers: { Authorization: `Bearer ${host.token}`, 'X-Ghost-CSRF': host.token, Origin: host.origin, 'Sec-Fetch-Site': 'same-origin', ...(write ? { 'Content-Type': 'application/json' } : {}) },
      });
      try { json(res, upstream.status, await boundedJSON(upstream)); }
      finally { res.off('close', closed); }
    } catch {
      // Do not include tokens, local paths, or transport dumps in browser errors.
      json(res, 502, { ok: false, error: 'Ghost 호스트에 연결하지 못했거나 요청 결과를 확인하지 못했습니다. 호스트를 확인한 뒤 같은 요청으로 다시 시도하세요.' });
    }
  };
}
