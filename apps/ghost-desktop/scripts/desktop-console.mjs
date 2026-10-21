// Packaged paths are selected by the native host, never by renderer input.
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { startLocalVoice } from './local-voice.mjs';
let payload = {};
try { payload = JSON.parse(await readFile(new URL('../payload.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('앱 실행 설정을 읽지 못했습니다.'); }
const configDirectory = payload.console_config_directory || 'ghost';
if (!/^[A-Za-z0-9_-]+$/.test(configDirectory)) throw new Error('잘못된 앱 설정 경로입니다.');
const configPath = process.env.GHOST_CONSOLE_CONFIG || join(homedir(), '.config', configDirectory, 'console.json');
let config = {};
try { config = JSON.parse(await readFile(configPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('콘솔 설정을 읽지 못했습니다.'); }
// Existing settings and credential references are reused. First launch without
// settings uses the local mock provider and creates no credentials.
process.env.GHOST_ROOT ||= config.root || join(homedir(), 'Library/Application Support/Ghost');
process.env.GHOST_MODEL ||= config.model || 'mock';
process.env.GHOST_HOST_MODE ||= config.host_mode || payload.host_mode_default || 'managed';
process.env.GHOST_CONSOLE_CONFIG ||= configPath;
if (process.env.GHOST_DESKTOP_PORT) process.env.PORT = process.env.GHOST_DESKTOP_PORT;
process.env.GHOST_BIN = fileURLToPath(new URL('../host/ghost', import.meta.url));
// Host-owned optional local speech starts beside chat, without delaying it.
// The native supervisor owns this console's private process group as fallback.
const voiceAbort = new AbortController();
const voiceStart = process.env.GHOST_HOST_MODE === 'external' ? Promise.resolve({ stop: async () => {} }) : startLocalVoice({
  resourcesRoot: fileURLToPath(new URL('../', import.meta.url)),
  configRoot: dirname(process.env.GHOST_CONSOLE_CONFIG || join(homedir(), '.config/ghost/console.json')),
  signal: voiceAbort.signal,
});
const stopVoice = () => { voiceAbort.abort(); void voiceStart.then(service => service.stop()); };
process.once('SIGINT', stopVoice); process.once('SIGTERM', stopVoice);
process.once('ghost-console-shutdown', stopVoice);
await import('../ui/scripts/console.mjs');
