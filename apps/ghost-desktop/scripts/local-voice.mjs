// Optional app-owned speech service. Renderer input never selects an executable.
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';

const reasons = {
  disabled: '로컬 음성 자동 시작을 설정하지 않았습니다.',
  invalid: '로컬 음성 실행 설정을 확인해 주세요.',
  missing: '로컬 음성 런타임 또는 앱 리소스가 없습니다.',
  occupied: '로컬 음성 포트를 다른 프로세스가 사용 중입니다.',
  unavailable: '로컬 음성 서버를 시작하지 못했습니다. 일반 채팅은 계속 사용할 수 있습니다.',
  cancelled: '로컬 음성 서버 시작을 중단했습니다.',
  stopped: '앱이 시작한 로컬 음성 서버를 종료했습니다.',
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function localEnvironment() {
  const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG',
    'HF_HOME', 'HF_HUB_CACHE', 'XDG_CACHE_HOME']);
  // Inspect names before reading values. Unrelated SDK, bridge and provider
  // credentials never enter the local speech subprocess environment.
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (allowed.has(key) || /^LC_[A-Z0-9_]+$/.test(key)) env[key] = process.env[key];
  }
  return { ...env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };
}

async function descriptorFrom(configRoot) {
  try {
    const path = join(configRoot, 'local-voice.json');
    if ((await stat(path)).size > 8192) throw new Error('invalid');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('invalid');
  }
}
function validDescriptor(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['enabled', 'python', 'port'].includes(key))
    && value.enabled === true && typeof value.python === 'string'
    && value.python.length <= 4096 && isAbsolute(value.python)
    && /^python(?:3(?:\.\d+)?)?$/.test(basename(value.python))
    && Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535;
}
async function portAvailable(port) {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  await new Promise(resolve => socket.close(resolve));
}
function health(port, timeoutMs) {
  return new Promise(resolve => {
    let finished = false; let timer;
    const done = value => {
      if (finished) return;
      finished = true; clearTimeout(timer); resolve(value);
    };
    const req = request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET',
      timeout: timeoutMs, headers: { Accept: 'application/json', Host: `127.0.0.1:${port}` } }, response => {
      if (response.statusCode !== 200 || Number(response.headers['content-length'] || 0) > 8192) {
        response.destroy(); done(null); return;
      }
      const chunks = []; let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 8192) { response.destroy(); done(null); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { done(null); }
      });
      response.on('error', () => done(null));
      response.on('aborted', () => done(null));
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
    // Absolute deadline also bounds a server that trickles body chunks.
    timer = setTimeout(() => { req.destroy(); done(null); }, timeoutMs);
    req.end();
  });
}

/**
 * Start without awaiting this promise on the ordinary chat startup path.
 * configRoot is the native owner's private console configuration directory.
 * descriptor is an optional already-read HOST configuration, never renderer data.
 * Abort signal closes a still-starting child during native shutdown. Missing
 * dependencies or readiness leave normal chat available. No installation occurs.
 */
export async function startLocalVoice({ resourcesRoot, configRoot, descriptor,
  signal, onStatus = () => {}, startupTimeoutMs = 15000,
  shutdownTimeoutMs = 4000, killTimeoutMs = 1000 } = {}) {
  let child = null; let exited = false; let stopPromise = null;
  let ready = false; let abortListener = null;
  const notify = (state, reason, extra = {}) => {
    try { onStatus({ state, reason, ...extra }); } catch { /* A status observer cannot own service lifecycle. */ }
  };
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      if (!child || exited || child.pid === undefined) return { stopped: true, owned: false };
      const owned = child;
      const waitExit = async timeout => {
        const end = performance.now() + timeout;
        while (!exited && performance.now() < end) await delay(Math.min(25, Math.max(1, end - performance.now())));
        return exited;
      };
      // Child handles identify only the process launched here. Never search by
      // port/name, kill an arbitrary numeric PID, or terminate an external server.
      try { owned.kill('SIGTERM'); } catch { /* Only this child handle was attempted. */ }
      if (!await waitExit(shutdownTimeoutMs)) {
        try { owned.kill('SIGKILL'); } catch { /* Never fall back to arbitrary process lookup. */ }
        await waitExit(killTimeoutMs);
      }
      notify(exited ? 'stopped' : 'unavailable', exited ? reasons.stopped : reasons.unavailable, { pid: owned.pid, stopped: exited });
      return { stopped: exited, owned: true, pid: owned.pid };
    })();
    return stopPromise;
  };
  const failure = async code => {
    await stop();
    notify(code === 'disabled' ? 'disabled' : 'unavailable', reasons[code]);
    return { available: false, reason: reasons[code], state: code, stop };
  };
  if (!isAbsolute(resourcesRoot || '') || !isAbsolute(configRoot || '')
    || !Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 30000
    || !Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 4000
    || !Number.isInteger(killTimeoutMs) || killTimeoutMs < 1 || killTimeoutMs > 1000) return failure('invalid');
  try { descriptor ??= await descriptorFrom(configRoot); }
  catch { return failure('invalid'); }
  if (!descriptor || descriptor.enabled === false) return failure('disabled');
  if (!validDescriptor(descriptor)) return failure('invalid');
  if (signal?.aborted) return failure('cancelled');
  const server = join(resourcesRoot, 'voice', 'server.py');
  try {
    if (!(await stat(descriptor.python)).isFile() || !(await stat(server)).isFile()) return failure('missing');
  } catch { return failure('missing'); }
  try { await portAvailable(descriptor.port); }
  catch { return failure('occupied'); }
  if (signal?.aborted) return failure('cancelled');
  notify('starting', '로컬 음성 서버를 준비하고 있습니다.');
  try {
    child = spawn(descriptor.python, [server, '--port', String(descriptor.port)], {
      cwd: join(resourcesRoot, 'voice'),
      // Sharing the console's private process group lets the native supervisor
      // also drain this child if the Node owner itself is interrupted.
      detached: false, stdio: 'ignore',
      env: localEnvironment(),
    });
    child.once('exit', () => {
      exited = true;
      if (ready && !stopPromise) notify('unavailable', reasons.unavailable);
      if (abortListener) signal?.removeEventListener('abort', abortListener);
    });
    child.once('error', () => { exited = true; });
  } catch { return failure('unavailable'); }
  let cancelled = false;
  const abort = () => { cancelled = true; void stop(); };
  abortListener = abort;
  signal?.addEventListener('abort', abort, { once: true });
  // Close the small race between preflight/spawn and listener registration.
  if (signal?.aborted) abort();
  const end = performance.now() + startupTimeoutMs;
  while (!exited && !cancelled && performance.now() < end) {
    const value = await health(descriptor.port, Math.min(300, Math.max(1, end - performance.now())));
    if (!cancelled && !exited && value?.service === 'ghost-local-speech'
      && value.version === 1 && value.offline === true && value.pid === child.pid) {
      ready = true;
      const endpoint = `http://127.0.0.1:${descriptor.port}/v1`;
      notify('ready', '로컬 음성 서버가 준비됐습니다.', { endpoint, pid: child.pid });
      // The abort listener remains for the ready child's lifetime. No global
      // process handlers are installed; the native console owns shutdown.
      return { available: true, state: 'ready', endpoint, pid: child.pid, stop };
    }
    if (!exited && !cancelled) await delay(Math.min(100, Math.max(1, end - performance.now())));
  }
  signal?.removeEventListener('abort', abort);
  return failure(cancelled ? 'cancelled' : 'unavailable');
}
