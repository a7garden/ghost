import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { discover } from '../ghost-ui/server/bridge.mjs';
import { authenticate } from './devices.mjs';

const MAX_BODY = 1_048_576, MAX_RESPONSE = 8 * MAX_BODY;
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; media-src blob:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
};
function json(res, status, body) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
export function parseOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('GHOST_GATEWAY_ORIGIN must be an HTTPS origin without credentials, path, query, or fragment.');
  return url;
}
async function bounded(source, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of source ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error('size_limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function route(method, path) {
  if (method === 'GET' && path === '/mobile/v1/snapshot') return '/api/v1/snapshot';
  if (method === 'POST' && path === '/mobile/v1/action') return '/api/v1/action';
  if (method === 'GET' && /^\/mobile\/v1\/events\/[a-f0-9-]{36}\/\d{1,16}$/i.test(path)) return path.replace('/mobile/v1/', '/api/v1/');
  return null;
}
const assets = new Map([
  ['/mobile/voice', ['voice.html', 'text/html; charset=utf-8']],
  ['/mobile/voice.js', ['voice.js', 'text/javascript; charset=utf-8']],
  ['/mobile/voice.css', ['voice.css', 'text/css; charset=utf-8']],
  ['/mobile/tokens.css', ['tokens.css', 'text/css; charset=utf-8']],
]);

// The Rust host stays private on loopback. Only this optional HTTPS edge accepts
// device credentials, and it never forwards client-selected URLs or headers.
export function createGateway({ root, devices, origin, discoverHost = discover, fetchHost = fetch }) {
  const publicOrigin = parseOrigin(origin);
  let active = 0;
  return createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (req, res) => {
    res.setTimeout(70000, () => res.destroy());
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return json(res, 403, { error: 'local_proxy_required' });
    if (req.headers.host !== publicOrigin.host || (req.headers.origin && req.headers.origin !== publicOrigin.origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return json(res, 403, { error: 'origin_denied' });
    if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { service: 'ghost-gateway', version: 1 });
    const asset = req.method === 'GET' && assets.get(req.url);
    if (asset) {
      try {
        const content = await readFile(new URL(`public/${asset[0]}`, import.meta.url));
        res.writeHead(200, { ...headers, 'Content-Type': asset[1] }); res.end(content);
      } catch { json(res, 404, { error: 'not_found' }); }
      return;
    }
    if (active >= 24) return json(res, 503, { error: 'busy' });
    active++;
    try {
      const device = await authenticate(devices, req.headers.authorization);
      if (!device) return json(res, 401, { error: 'device_not_authorized' });
      if (req.method === 'GET' && req.url === '/mobile/v1/bootstrap') return json(res, 200, { protocol: 'ghost-mobile', version: 1, device: { id: device.id, name: device.name }, role: 'owner', voice_path: '/mobile/voice' });
      const target = route(req.method, req.url);
      if (!target) return json(res, 404, { error: 'not_found' });
      let body;
      if (req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(res, 415, { error: 'json_required' });
        body = await bounded(req, MAX_BODY);
        let envelope;
        try { envelope = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid_json' }); }
        if (!/^[a-f0-9-]{36}$/i.test(envelope?.request_id) || typeof envelope?.command?.type !== 'string') return json(res, 400, { error: 'invalid_command' });
      }
      const host = await discoverHost(root);
      // Recheck after discovery so a revoked device cannot dispatch new work.
      if (!await authenticate(devices, req.headers.authorization)) return json(res, 401, { error: 'device_not_authorized' });
      const upstream = await fetchHost(`${host.origin}${target}`, {
        method: req.method, body, redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${host.token}`, 'X-Ghost-CSRF': host.token, Origin: host.origin, 'Sec-Fetch-Site': 'same-origin', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      });
      const data = JSON.parse((await bounded(upstream.body, MAX_RESPONSE)).toString('utf8'));
      if (!await authenticate(devices, req.headers.authorization)) return json(res, 401, { error: 'device_not_authorized' });
      json(res, upstream.status, data);
    } catch {
      // No retry: a lost response may follow a committed command. Preserve the
      // client's request_id and let the host's durable receipts reconcile it.
      json(res, 502, { ok: false, error: 'host_unavailable_or_outcome_unknown' });
    } finally { active--; }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { GHOST_ROOT: root, GHOST_GATEWAY_DEVICES: devices, GHOST_GATEWAY_ORIGIN: origin } = process.env;
    if (!root || !devices || !origin) throw new Error('Set GHOST_ROOT, GHOST_GATEWAY_DEVICES, and GHOST_GATEWAY_ORIGIN.');
    const port = Number(process.env.GHOST_GATEWAY_PORT ?? 8788);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port.');
    const server = createGateway({ root, devices, origin });
    server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ service: 'ghost-gateway', bind: `127.0.0.1:${port}`, public_origin: parseOrigin(origin).origin })));
    const shutdown = () => { server.close(); setTimeout(() => server.closeAllConnections(), 65000).unref(); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
