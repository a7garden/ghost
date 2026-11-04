import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { maxArchive, verifyPackage } from './package-format.mjs';

const API = '/ghost-packages/';
const ASSETS = '/ghost-package-assets/';
const isId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const types = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', svg: 'image/svg+xml',
  woff2: 'font/woff2', json: 'application/json',
};
function reply(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(JSON.stringify(value));
}
async function readUpload(req) {
  const length = Number(req.headers['content-length']);
  if (length > maxArchive) throw new Error('패키지가 너무 큽니다.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxArchive) { req.resume(); throw new Error('패키지가 너무 큽니다.'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function atomicWrite(path, bytes) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export function createPackageService({ root, trustFile = process.env.GHOST_PACKAGE_TRUST, validateTarget } = {}) {
  const cache = new Map();
  const verified = async (digest, keys) => {
    const file = join(root, 'archives', `${digest}.ghost`);
    const info = await stat(file, { bigint: true });
    if (!info.isFile() || info.size > BigInt(maxArchive)) throw new Error('설치한 패키지를 읽을 수 없습니다.');
    const stamp = `${info.ino}:${info.ctimeNs}:${JSON.stringify([...keys])}`;
    const cached = cache.get(digest);
    if (cached?.stamp === stamp) return cached.pkg;
    const pkg = verifyPackage(await readFile(file), keys);
    if (pkg.metadata.digest !== digest) throw new Error('설치한 패키지의 식별자가 일치하지 않습니다.');
    if (cache.size >= 8) cache.delete(cache.keys().next().value);
    cache.set(digest, { stamp, pkg });
    return pkg;
  };

  return async (req, res, next) => {
    const host = `127.0.0.1:${req.socket.localPort}`, origin = `http://${host}`;
    let url;
    try { url = new URL(req.url, origin); }
    catch { return reply(res, 400, {}); }
    const api = url.pathname.startsWith(API), asset = url.pathname.startsWith(ASSETS);
    if (!api && !asset) return next();
    if (req.headers.host !== host || url.origin !== origin) return reply(res, 403, {});
    const originHeader = req.headers.origin, fetchSite = req.headers['sec-fetch-site'];
    if (api && ((originHeader && originHeader !== origin) || (fetchSite && fetchSite !== 'same-origin')
      || req.headers['x-ghost-package-client'] !== '1')) return reply(res, 403, {});
    if (!root || !trustFile) return reply(res, 503, { error: '신뢰할 패키지 배포자를 먼저 설정하세요.' });
    try {
      let trust;
      try { trust = await readFile(trustFile, 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return asset ? reply(res, 404, {})
          : reply(res, 503, { error: '신뢰할 패키지 배포자를 먼저 설정하세요.' });
      }
      const keys = new Map(Object.entries(JSON.parse(trust)));
      if (asset) {
        const [, , digest, ...segments] = url.pathname.split('/');
        const path = segments.join('/'), type = path.split('.').at(-1);
        if (req.method !== 'GET' || !isDigest(digest) || !Object.hasOwn(types, type)
          || (type === 'html' && path !== 'index.html')) return reply(res, 404, {});
        const pkg = await verified(digest, keys);
        const bytes = pkg.files.get(`ui/dist/${path}`);
        if (!bytes || !pkg.metadata.ui?.views.length) return reply(res, 404, {});
        const source = `${origin}${ASSETS}${digest}/`;
        res.writeHead(200, {
          'Content-Type': types[type], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': `sandbox allow-scripts; default-src 'none'; script-src ${source}; style-src ${source} 'unsafe-inline'; img-src ${source} data:; font-src ${source}; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${origin}`,
          'Referrer-Policy': 'no-referrer',
          'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          // An opaque iframe may load package ES modules and fonts. These
          // are public signed artifacts, and the console APIs have no CORS.
          'Access-Control-Allow-Origin': '*',
        });
        res.end(bytes);
        return;
      }
      const operation = url.pathname.slice(API.length);
      const workspace = url.searchParams.get('workspace'), profile = url.searchParams.get('profile');
      if (operation === 'list' && req.method === 'GET' && isId(workspace)) {
        const profiles = [...new Set(url.searchParams.getAll('profile'))].slice(0, 200);
        const pairs = await Promise.all(profiles.filter(isId).map(async id => {
          try {
            const digest = await readFile(bindingPath(root, workspace, id), 'utf8');
            if (isDigest(digest)) return [id, (await verified(digest, keys)).metadata];
          } catch { /* Conversation remains available for missing or invalid packages. */ }
          return null;
        }));
        return reply(res, 200, Object.fromEntries(pairs.filter(Boolean)));
      }
      if (!['inspect', 'install'].includes(operation) || req.method !== 'POST') return reply(res, 404, {});
      if (originHeader !== origin || req.headers['content-type'] !== 'application/octet-stream') return reply(res, 403, {});
      const bytes = await readUpload(req), pkg = verifyPackage(bytes, keys);
      if (operation === 'install') {
        const { digest } = pkg.metadata;
        if (!isId(workspace) || !isId(profile) || url.searchParams.get('digest') !== digest) {
          return reply(res, 409, { error: '미리보기와 설치 대상이 일치하지 않습니다.' });
        }
        if (validateTarget && !(await validateTarget(workspace, profile))) {
          return reply(res, 409, { error: '현재 작업실에서 연결할 Ghost를 찾을 수 없습니다.' });
        }
        await mkdir(join(root, 'archives'), { recursive: true, mode: 0o700 });
        await mkdir(join(root, 'bindings'), { recursive: true, mode: 0o700 });
        await atomicWrite(join(root, 'archives', `${digest}.ghost`), bytes);
        await atomicWrite(bindingPath(root, workspace, profile), digest);
      }
      return reply(res, 200, pkg.metadata);
    } catch (error) {
      if (asset) return reply(res, 404, {});
      return reply(res, 400, { error: error.code ? '패키지를 읽을 수 없습니다.' : String(error.message).slice(0, 160) });
    }
  };
}

function bindingPath(root, workspace, profile) {
  return join(root, 'bindings', createHash('sha256').update(workspace).update('\0').update(profile).digest('hex'));
}
