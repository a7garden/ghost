import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = token => createHash('sha256').update(token).digest('hex');
export async function readDevices(path) {
  if (!isAbsolute(path)) throw new Error('Use an absolute device registry path.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('Device registry must be an owner-only regular file (0600).');
    const registry = JSON.parse(await file.readFile('utf8'));
    if (registry.version !== 1 || !Array.isArray(registry.devices) || registry.devices.some(d => typeof d.id !== 'string' || !/^[a-f0-9]{64}$/.test(d.digest))) throw new Error('Invalid device registry.');
    return registry;
  } finally { await file.close(); }
}

// Loaded for each request: revocation takes effect without a server restart.
export async function authenticate(path, authorization) {
  if (typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(authorization)) return null;
  const digest = Buffer.from(hash(authorization.slice(7)), 'hex');
  const registry = await readDevices(path);
  return registry.devices.find(d => timingSafeEqual(Buffer.from(d.digest, 'hex'), digest)) ?? null;
}

export async function updateDevices(path, change) {
  if (!isAbsolute(path)) throw new Error('Use an absolute device registry path.');
  const lock = await open(`${path}.lock`, 'wx', 0o600);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    let registry;
    try { registry = await readDevices(path); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      registry = { version: 1, devices: [] };
    }
    const result = change(registry);
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(registry, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path);
    return result;
  } finally {
    await unlink(temp).catch(() => {});
    await lock.close();
    await unlink(`${path}.lock`);
  }
}

export async function issueDevice(path, name) {
  if (!name?.trim() || name.length > 100) throw new Error('Device name must be 1–100 characters.');
  const token = randomBytes(32).toString('hex'), id = randomUUID();
  await updateDevices(path, registry => registry.devices.push({ id, name: name.trim(), digest: hash(token), created_at: new Date().toISOString() }));
  return { id, name: name.trim(), token };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [verb, path, value] = process.argv.slice(2);
  try {
    if (verb === 'issue') console.log(JSON.stringify(await issueDevice(path, value)));
    else if (verb === 'list') console.log(JSON.stringify((await readDevices(path)).devices.map(({ digest, ...device }) => device), null, 2));
    else if (verb === 'revoke') await updateDevices(path, registry => { registry.devices = registry.devices.filter(d => d.id !== value); });
    else throw new Error('Usage: node devices.mjs issue|list|revoke /absolute/devices.json [name|id]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
