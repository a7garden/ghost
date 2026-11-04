import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { imageOperation } from '../../ghost-omp/images.mjs';

const LIMIT = 1_048_576;
// Must stay above the host's events wait cap (MAX_EVENTS_WAIT_MS = 25s in
// src/control/server.rs) so the bridge never aborts a long poll before the
// host answers.
const EVENTS_WAIT_TIMEOUT_MS = 35_000;
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
// Package attachment is an owner console operation. Reuse the same
// authenticated Host snapshot and bounded JSON parser as the console bridge.
export async function readHostSnapshot(root) {
  const host = await discover(root);
  const response = await fetch(`${host.origin}/api/v1/snapshot`, {
    redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${host.token}`, 'X-Ghost-CSRF': host.token, Origin: host.origin, 'Sec-Fetch-Site': 'same-origin' },
  });
  if (!response.ok) throw new Error('Ghost 호스트에 연결하지 못했습니다.');
  return boundedJSON(response);
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
async function readMobileBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new Error('Pairing request exceeds its bounded frame.');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.request_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.request_id)) {
    throw new Error('Invalid pairing request identity.');
  }
  return JSON.stringify(body);
}
async function readInferenceBody(request) {
  const chunks=[]; let size=0;
  for await (const chunk of request) { size+=chunk.length; if(size>16_384) throw new Error('Inference request limit.'); chunks.push(chunk); }
  const raw=Buffer.concat(chunks).toString('utf8');
  const value=JSON.parse(raw);
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Invalid inference settings.');
  return raw;
}

function mobileRoute(method, url) {
  const id = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  if (['GET', 'POST'].includes(method) && url === '/ghost-api/mobile/invitations') return '/pairing/invitations';
  if (method === 'GET' && new RegExp(`^/ghost-api/mobile/invitations/${id}$`, 'i').test(url)) {
    return url.replace('/ghost-api/mobile', '/pairing');
  }
  if (method === 'POST' && new RegExp(`^/ghost-api/mobile/invitations/${id}/(approve|cancel)$`, 'i').test(url)) {
    return url.replace('/ghost-api/mobile', '/pairing');
  }
  return null;
}
// Node fetch ignores Host overrides. These two fixed loopback pairing calls
// need the configured TLS proxy Host, without redirects or caller-selected URLs.
function pairingGatewayRequest(url, { headers, body, method = 'GET', timeout = 10000 }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers, signal: AbortSignal.timeout(timeout) }, response => {
      boundedJSON({ body: response }).then(value => resolve({
        status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, value,
      }), reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}


async function authenticatedPairingGateway(host, configuredOrigin, configuredPort) {
  const publicOrigin = new URL(configuredOrigin);
  if (publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password
      || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash) {
    throw new Error('Invalid configured pairing origin.');
  }
  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid configured gateway port.');
  const origin = `http://127.0.0.1:${port}`;
  const nonce = randomBytes(16).toString('hex');
  const response = await pairingGatewayRequest(`${origin}/pairing/admin/bootstrap/${nonce}`, {
    headers: { Host: publicOrigin.host }, timeout: 3000,
  });
  const proof = response.value;
  const expected = createHmac('sha256', host.token)
    .update('ghost-pairing-bootstrap-v1\0').update(nonce).update('\0').update(publicOrigin.origin).digest('hex');
  if (!response.ok || proof.protocol !== 'ghost-pairing' || proof.version !== 1
      || proof.origin !== publicOrigin.origin || !equal(proof.proof, expected)) {
    throw new Error('Pairing gateway does not belong to the authenticated Host.');
  }
  return { origin, publicOrigin };
}
function json(response, code, data) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
  response.end(JSON.stringify(data));
}
export function createBridge({
  root = process.env.GHOST_ROOT,
  gatewayOrigin = process.env.GHOST_GATEWAY_ORIGIN,
  gatewayPort = process.env.GHOST_GATEWAY_PORT ?? 8788,
} = {}) {
  const csrf = randomBytes(32).toString('hex');
  return async (req, res, next = () => json(res, 404, { error: 'not_found' })) => {
    if (!req.url?.startsWith('/ghost-api/')) return next();
    const expectedHost = `127.0.0.1:${req.socket.localPort}`;
    const origin = `http://${expectedHost}`;
    if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return json(res, 403, { error: '다른 출처의 요청은 허용하지 않습니다.' });
    if (req.url === '/ghost-api/bootstrap' && req.method === 'GET') return json(res, 200, { mode: root ? 'live' : 'demo', csrf, protocol: 'ghost-ui', protocol_version: 1, owner_pid: Number(process.env.GHOST_CONSOLE_OWNER_PID || process.pid) });
    if (!equal(req.headers['x-ghost-ui-csrf'], csrf)) return json(res, 403, { error: '페이지를 새로고침하고 다시 시도하세요.' });
    const voice = req.method === 'POST' && /^\/ghost-api\/voice\/(config|transcribe|synthesize)$/.test(req.url);
    const events = req.method === 'GET' && /^\/ghost-api\/events\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(\d+)$/.exec(req.url);
    const mobile = mobileRoute(req.method, req.url);
    const image = req.url === '/ghost-api/inference/images' && req.method === 'POST';
    const inference = req.url === '/ghost-api/inference/settings' || image;
    const write = ((req.url === '/ghost-api/action' || voice) && req.method === 'POST')
      || (inference && req.method === 'POST')
      || (mobile !== null && req.method === 'POST');
    const read = (req.url === '/ghost-api/snapshot' && req.method === 'GET')
      || Boolean(events)
      || (inference && req.method === 'GET')
      || (mobile !== null && req.method === 'GET');
    if (!write && !read) return json(res, 404, { error: 'not_found' });
    if (write && (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json')) return json(res, 403, { error: '요청의 출처와 형식을 확인하세요.' });
    if (!root) return json(res, 503, { error: '예시 모드에는 연결된 호스트가 없습니다.' });
    if (mobile && !gatewayOrigin) return json(res, 503, {
      error: 'PC의 HTTPS Ghost gateway 주소가 설정되지 않았습니다. 휴대폰에는 서버 주소나 기기 키를 입력하지 않습니다.',
    });
    try {
      const body = inference && write ? await readInferenceBody(req) : voice ? await readVoiceBody(req)
        : mobile && write ? await readMobileBody(req) : write ? await readBody(req) : undefined;
      const host = await discover(root);
      if(image) {
        const upstream=await fetch(`${host.origin}/api/v1/inference/settings`,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${host.token}`,Origin:host.origin,'X-Ghost-CSRF':host.token,'Sec-Fetch-Site':'same-origin'}});
        const configuration=await boundedJSON(upstream);
        if(!upstream.ok||!configuration.settings)throw new Error('Model settings unavailable.');
        return json(res,200,{ok:true,result:await imageOperation({root,input:JSON.parse(body),configuration,executable:process.env.GHOST_CODEX_EXECUTABLE,dynoExecutable:process.env.GHOST_DYNO_IMAGE_EXECUTABLE})});
      }
      if (mobile) {
        const gateway = await authenticatedPairingGateway(host, gatewayOrigin, gatewayPort);
        const upstream = await pairingGatewayRequest(`${gateway.origin}${mobile}`, {
          method: req.method, body,
          headers: {
            Host: gateway.publicOrigin.host, Origin: gateway.publicOrigin.origin,
            Authorization: `Bearer ${host.token}`, 'X-Ghost-CSRF': host.token,
            'Sec-Fetch-Site': 'same-origin', ...(write ? { 'Content-Type': 'application/json' } : {}),
          },
        });
        return json(res, upstream.status, upstream.value);
      }
      const disconnected = new AbortController();
      const closed = () => { if (!res.writableEnded) disconnected.abort(); };
      res.once('close', closed);
      let target, timeoutMs = 30000;
      if (voice) { target = req.url.slice('/ghost-api/'.length); timeoutMs = 130000; }
      else if (events) { target = `events/${events[1]}/${events[2]}`; timeoutMs = EVENTS_WAIT_TIMEOUT_MS; }
      else if (inference) target = 'inference/settings';
      else if (write) target = 'action';
      else target = 'snapshot';
      const waitHeader = events && typeof req.headers['x-ghost-events-wait-ms'] === 'string' ? { 'X-Ghost-Events-Wait-Ms': req.headers['x-ghost-events-wait-ms'] } : {};
      const upstream = await fetch(`${host.origin}/api/v1/${target}`, {
        method: write ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(timeoutMs)]), body,
        headers: { Authorization: `Bearer ${host.token}`, 'X-Ghost-CSRF': host.token, Origin: host.origin, 'Sec-Fetch-Site': 'same-origin', ...(write ? { 'Content-Type': 'application/json' } : {}), ...waitHeader },
      });
      try { json(res, upstream.status, await boundedJSON(upstream)); }
      finally { res.off('close', closed); }
    } catch {
      // Do not include tokens, local paths, or transport dumps in browser errors.
      json(res, 502, { ok: false, error: 'Ghost 호스트에 연결하지 못했거나 요청 결과를 확인하지 못했습니다. 호스트를 확인한 뒤 같은 요청으로 다시 시도하세요.' });
    }
  };
}
