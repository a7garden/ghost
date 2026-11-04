import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = token => createHash('sha256').update(token).digest('hex');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lifetimeCapabilities = new Set(['lifetime.read', 'lifetime.write']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// APNs device tokens are opaque hex strings; the registry never sees push
// content, only the address Apple assigned to this installation.
function validApns(apns) {
  return isRecord(apns)
    && typeof apns.token === 'string'
    && /^[0-9a-f]{32,128}$/.test(apns.token)
    && (apns.environment === 'sandbox' || apns.environment === 'production')
    && typeof apns.updated_at === 'string'
    && !Number.isNaN(Date.parse(apns.updated_at));
}

export function validScope(scope) {
  if (!isRecord(scope)) return false;
  const keys = Object.keys(scope);
  return keys.length === 4
    && ['kind', 'ghost_ids', 'conversation_ids', 'capabilities'].every(key => Object.prototype.hasOwnProperty.call(scope, key))
    && scope.kind === 'lifetime'
    && Array.isArray(scope.ghost_ids) && scope.ghost_ids.length > 0
    && scope.ghost_ids.every(id => typeof id === 'string' && uuidPattern.test(id))
    && new Set(scope.ghost_ids).size === scope.ghost_ids.length
    && Array.isArray(scope.conversation_ids) && scope.conversation_ids.length > 0
    && scope.conversation_ids.every(id => typeof id === 'string' && uuidPattern.test(id))
    && new Set(scope.conversation_ids).size === scope.conversation_ids.length
    && Array.isArray(scope.capabilities) && scope.capabilities.length > 0
    && scope.capabilities.every(capability => lifetimeCapabilities.has(capability))
    && new Set(scope.capabilities).size === scope.capabilities.length;
}

function validMediaBinding(binding) {
  return isRecord(binding)
    && typeof binding.start_id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(binding.start_id)
    && (binding.pc_id === null || (typeof binding.pc_id === 'string' && binding.pc_id.length > 0 && binding.pc_id.length <= 128 && !/[\u0000-\u001f]/.test(binding.pc_id)))
    && typeof binding.since === 'string'
    && !Number.isNaN(Date.parse(binding.since))
    && typeof binding.fence === 'string'
    && /^[a-f0-9]{64}$/.test(binding.fence)
    && (binding.ended_at === undefined || (typeof binding.ended_at === 'string' && !Number.isNaN(Date.parse(binding.ended_at))))
    && (binding.resolved_by === undefined || binding.resolved_by === 'operator');
}

function validDevice(device) {
  return isRecord(device)
    && typeof device.id === 'string'
    && /^[a-f0-9]{64}$/.test(device.digest)
    && (!Object.prototype.hasOwnProperty.call(device, 'scope') || validScope(device.scope))
    && (!Object.prototype.hasOwnProperty.call(device, 'apns') || validApns(device.apns))
    && (!Object.prototype.hasOwnProperty.call(device, 'media') || (Array.isArray(device.media) && device.media.length <= 4 && device.media.every(validMediaBinding)));
}

// Idempotent token upsert; a replaced token is overwritten, not accumulated.
export async function registerApnsToken(path, deviceId, token, environment, now = new Date()) {
  if (!/^[0-9a-f]{32,128}$/.test(token)) throw new Error('Invalid APNs device token.');
  if (environment !== 'sandbox' && environment !== 'production') throw new Error('Invalid APNs environment.');
  return updateDevices(path, registry => {
    const device = registry.devices.find(d => d.id === deviceId);
    if (!device) throw new Error('Device not found.');
    device.apns = { token, environment, updated_at: now.toISOString() };
    return device;
  });
}

export async function clearApnsToken(path, deviceId) {
  return updateDevices(path, registry => {
    const device = registry.devices.find(d => d.id === deviceId);
    if (!device) throw new Error('Device not found.');
    delete device.apns;
    return device;
  });
}

export async function readDevices(path) {
  if (!isAbsolute(path)) throw new Error('Use an absolute device registry path.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('Device registry must be an owner-only regular file (0600).');
    const registry = JSON.parse(await file.readFile('utf8'));
    if (registry.version !== 1 || !Array.isArray(registry.devices) || registry.devices.some(device => !validDevice(device))) throw new Error('Invalid device registry.');
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
    const payload = JSON.stringify(registry, null, 2) + '\n';
    if (Buffer.byteLength(payload, 'utf8') > 65536) throw new Error('Device registry exceeds its readable capacity.');
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(payload); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path);
    return result;
  } finally {
    await unlink(temp).catch(() => {});
    await lock.close();
    await unlink(`${path}.lock`);
  }
}

export async function issueDevice(path, name, scope) {
  if (!name?.trim() || name.length > 100) throw new Error('Device name must be 1–100 characters.');
  if (scope !== undefined && !validScope(scope)) throw new Error('Invalid lifetime device scope.');
  const token = randomBytes(32).toString('hex'), id = randomUUID();
  const device = { id, name: name.trim(), digest: hash(token), created_at: new Date().toISOString(), ...(scope === undefined ? {} : { scope: structuredClone(scope) }) };
  await updateDevices(path, registry => registry.devices.push(device));
  return { id, name: name.trim(), token };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [verb, path, value, scopeText] = process.argv.slice(2);
  try {
    if (verb === 'issue') {
      const scope = scopeText === undefined ? undefined : JSON.parse(scopeText);
      console.log(JSON.stringify(await issueDevice(path, value, scope)));
    } else if (verb === 'list') console.log(JSON.stringify((await readDevices(path)).devices.map(({ digest, ...device }) => device), null, 2));
    else if (verb === 'revoke') await updateDevices(path, registry => { registry.devices = registry.devices.filter(d => d.id !== value); });
    else if (verb === 'media-resolve') {
      // Deliberate operator resolution of an unresolved media start fence when
      // the media service is unreachable and its state cannot be proven. The
      // record keeps its audit trail (resolved_by: "operator").
      if (!value || !scopeText || scopeText !== 'confirm') throw new Error('Usage: node devices.mjs media-resolve /absolute/devices.json <start_id> confirm');
      const resolved = await updateDevices(path, registry => {
        for (const device of registry.devices) {
          for (const record of device.media ?? []) {
            if (record.start_id === value && record.ended_at === undefined) {
              record.ended_at = new Date().toISOString();
              record.resolved_by = 'operator';
              return { device_id: device.id, start_id: record.start_id };
            }
          }
        }
        return null;
      });
      if (!resolved) throw new Error('No unresolved media record for that start id.');
      console.log(JSON.stringify(resolved));
    }
    else throw new Error('Usage: node devices.mjs issue|list|revoke|media-resolve /absolute/devices.json [name|id|start_id] [scope-json|confirm]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
