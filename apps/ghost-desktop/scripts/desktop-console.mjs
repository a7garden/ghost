// Packaged paths are selected by the native host, never by renderer input.
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { startLocalVoice } from './local-voice.mjs';
let config = {};
try { config = JSON.parse(await readFile(process.env.GHOST_CONSOLE_CONFIG || join(homedir(), '.config/ghost/console.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('콘솔 설정을 읽지 못했습니다.'); }
// Existing settings and credential references are reused. First launch without
// settings uses the local mock provider and creates no credentials.
process.env.GHOST_ROOT ||= config.root || join(homedir(), 'Library/Application Support/Ghost');
process.env.GHOST_MODEL ||= config.model || 'mock';
if (process.env.GHOST_DESKTOP_PORT) process.env.PORT = process.env.GHOST_DESKTOP_PORT;
process.env.GHOST_BIN = fileURLToPath(new URL('../host/ghost', import.meta.url));
// Host-owned optional local speech starts beside chat, without delaying it.
// The native supervisor owns this console's private process group as fallback.
const voiceAbort = new AbortController();
const voiceStart = startLocalVoice({
  resourcesRoot: fileURLToPath(new URL('../', import.meta.url)),
  configRoot: dirname(process.env.GHOST_CONSOLE_CONFIG || join(homedir(), '.config/ghost/console.json')),
  signal: voiceAbort.signal,
});
const stopVoice = () => { voiceAbort.abort(); void voiceStart.then(service => service.stop()); };
process.once('SIGINT', stopVoice); process.once('SIGTERM', stopVoice);
process.once('ghost-console-shutdown', stopVoice);
await import('../ui/scripts/console.mjs');
