// One local console: the Rust host owns execution and data; this process owns
// its lifetime and the separate browser bridge. Credentials stay in the host.
import { spawn } from 'node:child_process';
import { access, readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { discover } from '../server/bridge.mjs';

const configPath = process.env.GHOST_CONSOLE_CONFIG || join(homedir(), '.config/ghost/console.json');
let config;
try { config = JSON.parse(await readFile(configPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('Ghost 콘솔 설정 파일을 읽지 못했습니다.'); config = {}; }
const root = process.env.GHOST_ROOT || config.root;
const model = process.env.GHOST_MODEL || config.model;
const auth = process.env.GHOST_AUTH_FILE || config.auth_file;
const packageTrust = config.package_trust || join(homedir(), '.config/ghost/package-publishers.json');
if (typeof packageTrust !== 'string' || !isAbsolute(packageTrust)) throw new Error('package_trust 경로는 절대 경로여야 합니다.');
const port = Number(process.env.PORT || config.port || 62062);
const binary = process.env.GHOST_BIN || fileURLToPath(new URL('../../../target/debug/ghost', import.meta.url));
const hostMode = process.env.GHOST_HOST_MODE || config.host_mode || 'managed';
if (!['managed', 'external'].includes(hostMode)) throw new Error('Ghost host_mode must be managed or external.');
if (!root || !isAbsolute(root) || (hostMode === 'managed' && (!model || typeof model !== 'string')) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('GHOST_ROOT(절대 경로), GHOST_MODEL과 콘솔 포트를 설정하세요. README의 콘솔 실행 안내를 참고하세요.');
}
if (hostMode === 'managed') await access(binary).catch(() => { throw new Error('Rust 호스트를 먼저 빌드하세요: cargo build --features workspace-ui'); });
await access(new URL('../dist/index.html', import.meta.url)).catch(() => { throw new Error('콘솔 화면을 먼저 빌드하세요: npm run build'); });
if (hostMode === 'managed' && auth) await access(auth).catch(() => { throw new Error('설정된 모델 인증 파일을 읽을 수 없습니다.'); });
if (hostMode === 'managed') await mkdir(root, { recursive: true, mode: 0o700 });

let host, ui, stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  process.emit('ghost-console-shutdown');
  process.exitCode = code;
  await Promise.all([ui, host].filter(Boolean).map(child => new Promise(resolve => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(kill); resolve(); });
    child.kill('SIGTERM');
  })));
}
process.once('SIGINT', () => void stop(0));
process.once('SIGTERM', () => void stop(0));
function watch(child, name) {
  child.once('error', () => { console.error(`${name} 실행에 실패했습니다.`); void stop(1); });
  child.once('exit', code => { if (!stopping) { console.error(`${name} 종료 (${code ?? 'signal'})`); void stop(code || 1); } });
}
try {
  if (hostMode === 'external') {
    // Authenticate before starting a UI. An unreachable/stale endpoint never
    // falls back to spawning a competing writer on this root.
    await discover(root);
  } else {
  host = spawn(binary, ['--root', root, 'serve', '--headless', '--model', model], {
    env: { ...process.env, ...(auth ? { GHOST_AUTH_FILE: auth } : {}) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  watch(host, 'Rust 호스트');
  await new Promise((resolve, reject) => {
    const lines = createInterface({ input: host.stdout });
    const timer = setTimeout(() => finish(new Error('Rust 호스트 시작 시간 초과')), 15000);
    const ended = () => finish(new Error('Rust 호스트가 준비 전에 종료되었습니다.'));
    const finish = error => { clearTimeout(timer); lines.close(); host.off('exit', ended); host.off('error', ended); error ? reject(error) : resolve(); };
    host.once('exit', ended); host.once('error', ended);
    lines.on('line', line => {
      try { const ready = JSON.parse(line); if (ready.mode === 'headless' && ready.protocol_version === 1) finish(); }
      catch { /* only a valid readiness record starts the UI */ }
    });
  });
  }
  if (!stopping) {
    // Only UI runtime paths and the root are passed to the browser server.
    const uiEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|TMPDIR|TEMP|TMP|LANG|LC_.*|SYSTEMROOT)$/i.test(key)));
    ui = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url))], {
      env: { ...uiEnv, GHOST_PACKAGE_TRUST: packageTrust, GHOST_ROOT: root, PORT: String(port), GHOST_CONSOLE_OWNER_PID: String(process.pid) }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    watch(ui, 'Ghost 콘솔');
  }
} catch (error) { console.error(error.message); await stop(1); }
