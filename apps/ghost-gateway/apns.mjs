// APNs token-based alert sender for the durable notification outbox.
//
// The Host's `lifetime_notifications` rows are the only source of truth. This
// module is a wake-up transport: it sends an opaque notification id and a
// minimal phrase, marks `transport_accepted` after Apple accepts the request,
// and never carries work content, transcripts, or replies. Missing provider
// credentials disable sending entirely while inbox reads and acknowledgements
// keep working, so text/outbox development never depends on APNs.
import { createHash, createSign, randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { connect as connectH2 } from 'node:http2';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scopeHasPair } from './devices.mjs';

const HEX = /^[0-9a-f]{32,128}$/;
const MAX_NOTIFICATIONS_PER_RECIPIENT = 100;
const MAX_DEVICES_PER_TICK = 64;
const APNS_HOSTS = { sandbox: 'api.sandbox.push.apple.com', production: 'api.push.apple.com' };
const EVENT_PHRASES = {
  result: { title: 'Ghost', body: '맡긴 작업의 결과가 도착했습니다.' },
  acceptance: { title: 'Ghost', body: '맡긴 작업이 수용됐습니다.' },
  briefing: { title: 'Ghost', body: '브리핑이 준비됐습니다.' },
};

export function readApnsConfig(env = process.env) {
  const keyPath = env.GHOST_APNS_KEY_PATH, keyId = env.GHOST_APNS_KEY_ID;
  const teamId = env.GHOST_APNS_TEAM_ID, topic = env.GHOST_APNS_TOPIC;
  const environment = env.GHOST_APNS_ENVIRONMENT;
  const missing = [
    ['GHOST_APNS_KEY_PATH', keyPath], ['GHOST_APNS_KEY_ID', keyId],
    ['GHOST_APNS_TEAM_ID', teamId], ['GHOST_APNS_TOPIC', topic],
    ['GHOST_APNS_ENVIRONMENT', environment],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) return { enabled: false, missing };
  if (environment !== 'sandbox' && environment !== 'production') {
    return { enabled: false, missing: ['GHOST_APNS_ENVIRONMENT must be sandbox or production'] };
  }
  for (const [name, value] of [['GHOST_APNS_KEY_ID', keyId], ['GHOST_APNS_TEAM_ID', teamId]]) {
    if (!/^[A-Z0-9]{10}$/.test(value)) return { enabled: false, missing: [`${name} must be a 10-character Apple identifier`] };
  }
  return { enabled: true, keyPath, keyId, teamId, topic, environment, host: APNS_HOSTS[environment] };
}

// ES256 JWT for token-based provider authentication. Node emits DER-encoded
// ECDSA signatures; APNs requires the raw 64-byte r||s form.
export function providerJWT({ key, keyId, teamId }, now = Math.floor(Date.now() / 1000)) {
  const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const header = { alg: 'ES256', kid: keyId };
  const claims = { iss: teamId, iat: now };
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = decodeDERSignature(createSign('sha256').update(signingInput).sign(key));
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

function decodeDERSignature(der) {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error('Invalid DER signature.');
  let offset = 2, size = 0;
  const parts = [];
  while (parts.length < 2 && offset < der.length) {
    if (der[offset] !== 0x02) throw new Error('Invalid DER signature integer.');
    size = der[offset + 1];
    const value = der.subarray(offset + 2, offset + 2 + size);
    if (size < 1 || value.length !== size) throw new Error('Invalid DER signature integer.');
    parts.push(value);
    offset += 2 + size;
  }
  if (parts.length !== 2) throw new Error('Invalid DER signature pair.');
  const aligned = parts.map(part => {
    const trimmed = part[0] === 0 ? part.subarray(1) : part;
    if (trimmed.length > 32) throw new Error('Invalid signature integer length.');
    return Buffer.concat([Buffer.alloc(32 - trimmed.length), trimmed]);
  });
  return Buffer.concat(aligned);
}

export function alertPayload(notification) {
  const phrase = EVENT_PHRASES[notification.event_kind];
  if (!phrase) throw new Error('Unsupported notification event kind.');
  return {
    aps: { alert: phrase, sound: 'default' },
    notification_id: notification.id,
  };
}

// HTTP/2 delivery against api[.sandbox].push.apple.com. Resolves with the
// APNs status plus reason so callers can distinguish acceptance from a dead
// token. Exactly one settlement per call: the deadline cancels the active
// stream (RST) and destroys the session, and an oversized response is an
// error rather than a truncated success. Callers persist timeouts as unknown
// delivery outcomes — a timeout is never proof of non-delivery.
export function sendAlert({ host, jwt, topic, token, payload, expiration }, fetchApns = defaultFetchApns) {
  return fetchApns({ host, jwt, topic, token, payload, expiration });
}

async function defaultFetchApns({ host, jwt, topic, token, payload, expiration }) {
  if (!HEX.test(token)) throw new Error('Invalid APNs device token.');
  return await new Promise((resolve, reject) => {
    let settled = false, request = null, session = null, deadline = null, destroyTimer = null;
    const settle = (outcome, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { request?.close(); } catch { /* already reset */ }
      try { session?.close(); } catch { /* already closed */ }
      // A graceful h2 close waits on open streams; the deferred destroy
      // guarantees a stalled socket cannot outlive the settled operation.
      destroyTimer = setTimeout(() => { try { session?.destroy(); } catch { /* gone */ } }, 1000);
      destroyTimer.unref?.();
      if (error) reject(error); else resolve(outcome);
    };
    deadline = setTimeout(() => settle(null, new Error('apns_timeout')), 15000);
    deadline.unref?.();
    session = connectH2(`https://${host}`);
    session.on('error', error => settle(null, error));
    session.on('connect', () => {
      const body = JSON.stringify(payload);
      request = session.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `Bearer ${jwt}`,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        ...(expiration === undefined ? {} : { 'apns-expiration': String(expiration) }),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      request.setEncoding('utf8');
      let response = '';
      request.on('data', chunk => {
        response += chunk;
        if (response.length > 4096) settle(null, new Error('apns_response_overflow'));
      });
      request.on('response', headers => { request.apnsStatus = headers[':status']; });
      request.on('end', () => {
        let reason = null;
        try { reason = response ? JSON.parse(response).reason ?? null : null; } catch { reason = null; }
        settle({ status: request.apnsStatus ?? 0, reason });
      });
      request.on('error', error => settle(null, error));
      request.end(body);
    });
  });
}

const JOURNAL_VERSION = 1;
const MAX_JOURNAL_NOTIFICATIONS = 256;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_TARGETS_PER_NOTIFICATION = 128;
const activeWriterPaths = new Set();

// SQLite supplies a kernel-released cross-process lock, not another data store.
// Keep the guard FD open until SQLite closes: POSIX closes of the same inode
// can release a process's fcntl locks. Same-process contenders open no extra FD.
async function acquireOutboxWriter(devicesPath) {
  const parent = await realpath(dirname(devicesPath));
  const directory = await stat(parent);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.mode & 0o077) {
    throw new Error('outbox_directory_not_private');
  }
  const path = join(parent, `${basename(devicesPath)}.outbox-writer.sqlite`);
  if (activeWriterPaths.has(path)) return null;
  activeWriterPaths.add(path);
  let guard, database;
  const release = async () => {
    try { database?.close(); } finally {
      try { await guard?.close(); } finally { activeWriterPaths.delete(path); }
    }
  };
  try {
    guard = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const assertCurrent = async () => {
      const held = await guard.stat();
      const entry = await lstat(path);
      if (!held.isFile() || held.uid !== process.getuid?.() || held.mode & 0o077
        || held.nlink !== 1 || held.size > 65536 || !entry.isFile()
        || entry.dev !== held.dev || entry.ino !== held.ino) {
        throw new Error('outbox_writer_changed');
      }
    };
    await assertCurrent();
    database = new DatabaseSync(path, { timeout: 0 });
    database.exec('BEGIN EXCLUSIVE');
    await assertCurrent();
    return { release, assertCurrent };
  } catch (error) {
    await release();
    if (error.errcode === 5 || error.errcode === 6) return null;
    throw error;
  }
}
// These responses and transport failures do not establish non-delivery.
// Persist their uncertainty; never repeat the provider effect automatically.
const UNKNOWN_OUTCOMES = new Set([429, 500, 503]);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function tokenFingerprint(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 32);
}

// Durable per-(notification, device, token-generation) attempt and outcome
// journal, written before every actual provider POST with the same atomic
// rename discipline as the device registry. It survives restarts, so a known
// acceptance retries only the Host ack, an unknown send is never blindly
// resent, and per-tick deduplication no longer evaporates on restart.
class OutboxJournal {
  constructor(path, now) {
    this.path = `${path}.outbox-journal.json`;
    this.now = now;
    this.notifications = [];
  }

  async load() {
    let raw;
    let file;
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.mode & 0o077
        || metadata.nlink !== 1 || metadata.size > MAX_JOURNAL_BYTES) throw new Error('invalid_outbox_journal');
      const chunks = [];
      let size = 0;
      for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: MAX_JOURNAL_BYTES })) {
        size += chunk.length;
        if (size > MAX_JOURNAL_BYTES) throw new Error('invalid_outbox_journal');
        chunks.push(chunk);
      }
      raw = Buffer.concat(chunks, size).toString('utf8');
    } finally { await file.close(); }
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== JOURNAL_VERSION || !Array.isArray(parsed.notifications)
      || parsed.notifications.length > MAX_JOURNAL_NOTIFICATIONS) throw new Error('invalid_outbox_journal');
    const valid = entry => isRecord(entry)
      && typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 500
      && typeof entry.recipient_id === 'string' && entry.recipient_id.length > 0 && entry.recipient_id.length <= 500
      && typeof entry.since === 'string' && !Number.isNaN(Date.parse(entry.since))
      && (entry.acked === true || entry.acked === false)
      && Array.isArray(entry.targets)
      && entry.targets.length <= MAX_TARGETS_PER_NOTIFICATION
      && entry.targets.every(target => isRecord(target)
        && typeof target.device_id === 'string' && target.device_id.length <= 128
        && typeof target.token === 'string' && /^[a-f0-9]{32}$/.test(target.token)
        && Number.isSafeInteger(target.attempts) && target.attempts >= 0
        && Number.isSafeInteger(target.unknown_attempts) && target.unknown_attempts >= 0
        && (target.outcome === 'accepted' || target.outcome === 'rejected' || target.outcome === null));
    if (!parsed.notifications.every(valid)
      || new Set(parsed.notifications.map(entry => entry.id)).size !== parsed.notifications.length) {
      throw new Error('invalid_outbox_journal');
    }
    this.notifications = parsed.notifications;
  }

  async save() {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: JOURNAL_VERSION, notifications: this.notifications }, null, 2) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, this.path);
    const directory = await open(dirname(this.path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    await unlink(temp).catch(() => {});
  }

  entry(id) {
    return this.notifications.find(item => item.id === id) ?? null;
  }

  ensure(notification, recipientId, nowMs) {
    let record = this.entry(notification.id);
    if (record) {
      if (record.recipient_id !== recipientId) throw new Error('outbox_recipient_conflict');
      return record;
    }
    if (this.notifications.length >= MAX_JOURNAL_NOTIFICATIONS) return null;
    record = {
      id: notification.id,
      recipient_id: recipientId,
      since: new Date(nowMs).toISOString(),
      acked: false,
      targets: [],
    };
    this.notifications.push(record);
    return record;
  }

  target(record, deviceId, tokenHash) {
    // Rotation cannot forget an accepted or indeterminate send to this device.
    let target = record.targets.find(item => item.device_id === deviceId
      && (item.outcome === 'accepted' || (item.outcome === null && item.attempts > 0)))
      ?? record.targets.find(item => item.device_id === deviceId && item.token === tokenHash);
    if (!target) {
      if (record.targets.length >= MAX_TARGETS_PER_NOTIFICATION) return null;
      target = { device_id: deviceId, token: tokenHash, attempts: 0, unknown_attempts: 0, outcome: null };
      record.targets.push(target);
    }
    return target;
  }

  prune() {
    // Inbox pagination, time, and device revocation cannot prove non-delivery.
    this.notifications = this.notifications.filter(item => !item.acked);
  }
}

export function createNotificationOutbox({
  config, devicesPath, readDevices, hostLifetimeAction, sendAlert: deliver = sendAlert,
  providerKey, log = () => {}, now = Date.now, intervalMs = 20000,
}) {
  if (!config?.enabled) return { enabled: false, missing: config?.missing ?? [], async tick() { return { sent: 0, reason: 'disabled' }; }, start() { }, stop() { } };
  const state = { timer: null, running: false };
  async function tick() {
    if (state.running) return { sent: 0, reason: 'busy' };
    state.running = true;
    let writer;
    try {
      writer = await acquireOutboxWriter(devicesPath);
      if (!writer) return { sent: 0, reason: 'busy' };
      const journal = new OutboxJournal(devicesPath, now);
      await journal.load();
      const registry = await readDevices(devicesPath);
      const registered = registry.devices
        .filter(device => device.apns?.environment === config.environment && HEX.test(device.apns.token))
        .slice(0, MAX_DEVICES_PER_TICK);
      if (!registered.length) {
        journal.prune();
        await journal.save();
        return { sent: 0, reason: 'no_registered_devices' };
      }
      const jwt = providerJWT({ key: providerKey, keyId: config.keyId, teamId: config.teamId }, Math.floor(now() / 1000));
      const expiration = Math.floor(now() / 1000) + 24 * 3600;
      let ghosts = null, delivered = 0, unknown = 0, failures = 0;
      try {
        const registryResult = await hostLifetimeAction({ method: 'registry.inspect' });
        if (!isRecord(registryResult) || registryResult.status !== 'success') throw new Error('host_registry_rejected');
        ghosts = [...new Set((registryResult.data?.registry ?? []).map(entry => entry.ghost_id))].slice(0, 256);
      } catch {
        // Unknown Host state: no sends without current inbox evidence.
        ghosts = null;
      }
      if (ghosts) for (const ghost of ghosts) {
        let pending;
        try {
          const inbox = await hostLifetimeAction({ method: 'notification.inspect', recipient_id: ghost, limit: MAX_NOTIFICATIONS_PER_RECIPIENT });
          if (!isRecord(inbox) || inbox.status !== 'success' || !isRecord(inbox.data) || !Array.isArray(inbox.data.notifications)) {
            throw new Error('host_inbox_invalid');
          }
          for (const notification of inbox.data.notifications) {
            if (isRecord(notification) && ['transport_accepted', 'client_seen'].includes(notification.state)) {
              const recorded = journal.entry(notification.id);
              if (recorded?.recipient_id === ghost) recorded.acked = true;
            }
          }
          journal.prune();
          pending = inbox.data.notifications.filter(item => isRecord(item) && item.state === 'pending').slice(0, MAX_NOTIFICATIONS_PER_RECIPIENT);
        } catch {
          failures += 1;
          continue;
        }
        for (const notification of pending) {
          const entry = journal.ensure(notification, ghost, now());
          if (!entry) { failures += 1; log('notification journal capacity reached'); continue; }
          if (entry.acked) continue;
          const participants = [];
          let fanoutUnresolved = false;
          for (const device of registered) {
            // Current authority immediately before every delivery decision:
            // revocation, re-issuance, narrowing, or token replacement stops
            // this target within the same tick, matching scoped inbox access.
            let current;
            try {
              current = (await readDevices(devicesPath)).devices.find(candidate => candidate.id === device.id);
            } catch { fanoutUnresolved = true; failures += 1; continue; }
            if (!current) continue;
            if (current.apns?.environment !== config.environment || !HEX.test(current.apns.token)) continue;
            if (current.scope) {
              if (!current.scope.capabilities.includes('lifetime.read')) continue;
              if (!scopeHasPair(current.scope, ghost, notification.conversation_id)) continue;
            }
            const tokenHash = tokenFingerprint(current.apns.token);
            const target = journal.target(entry, current.id, tokenHash);
            if (!target) { fanoutUnresolved = true; failures += 1; continue; }
            participants.push(target);
            if (target.outcome === 'accepted' || target.outcome === 'rejected') continue;
            if (target.attempts > 0) { unknown += 1; continue; }
            // Durable intent before the actual POST: a crash between send and
            // outcome leaves an attempt without an outcome, which is treated
            // as unknown — never as proof of non-delivery.
            target.attempts += 1;
            await journal.save();
            await writer.assertCurrent();
            try {
              const outcome = await deliver({
                host: config.host, jwt, topic: config.topic, token: current.apns.token,
                payload: alertPayload(notification), expiration,
              });
              if (outcome.status === 200) {
                target.outcome = 'accepted';
                delivered += 1;
              } else if (outcome.status === 410 || (outcome.status === 400 && outcome.reason === 'BadDeviceToken')) {
                target.outcome = 'rejected';
                failures += 1;
                log(`apns token rejected status=${outcome.status} reason=${outcome.reason}`);
                // Removal deletes only the exact rejected registration; a
                // replacement token registered meanwhile survives untouched.
                await removeDeviceToken(devicesPath, current.id, current.apns.token, current.apns.environment);
              } else if (UNKNOWN_OUTCOMES.has(outcome.status)) {
                target.unknown_attempts += 1;
                unknown += 1;
                failures += 1;
                log(`apns delivery outcome unknown status=${outcome.status} reason=${outcome.reason}`);
              } else {
                target.outcome = 'rejected';
                failures += 1;
                log(`apns delivery rejected status=${outcome.status} reason=${outcome.reason}`);
              }
            } catch (error) {
              target.unknown_attempts += 1;
              unknown += 1;
              failures += 1;
              log(`apns transport failure: ${error.message}`);
            }
            await journal.save();
          }
          // Ack reconciliation from durable acceptance records: only when every
          // currently eligible participant reached a terminal outcome and at
          // least one acceptance exists. Unfinished fanout is never suppressed,
          // and the ack result is validated before counting as recorded.
          const terminal = target => target.outcome === 'accepted' || target.outcome === 'rejected';
          if (!fanoutUnresolved && participants.length && participants.every(terminal) && participants.some(target => target.outcome === 'accepted')) {
            try {
              await writer.assertCurrent();
              const ack = await hostLifetimeAction({
                method: 'notification.ack', recipient_id: ghost,
                notification_id: notification.id, state: 'transport_accepted',
              });
              if (isRecord(ack) && ack.status === 'success' && isRecord(ack.data)
                && ack.data.notification_id === notification.id && ack.data.recipient_id === ghost
                && ['transport_accepted', 'client_seen'].includes(ack.data.state)) {
                entry.acked = true;
                await journal.save();
              } else {
                failures += 1;
                log(`notification ack rejected for ${notification.id}`);
              }
            } catch (error) {
              failures += 1;
              log(`notification ack outcome unknown for ${notification.id}: ${error.message}`);
            }
          }
        }
      }
      journal.prune();
      await journal.save();
      return { sent: delivered, accepted: delivered, unknown, failures };
    } finally {
      try { await writer?.release(); } finally { state.running = false; }
    }
  }
  function start(overrides) {
    if (state.timer) return;
    state.timer = setInterval(() => { tick().catch(error => log(`notification outbox tick failed: ${error.message}`)); }, overrides ?? intervalMs);
    state.timer.unref?.();
  }
  function stop() {
    clearInterval(state.timer);
    state.timer = null;
  }
  return { enabled: true, tick, start, stop };
}

// A stale rejection (an old token snapshot racing a re-registration) must
// never delete the newer registration: removal applies only when the current
// registration is still exactly the rejected token/environment pair.
async function removeDeviceToken(devicesPath, deviceId, rejectedToken, rejectedEnvironment) {
  const { updateDevices } = await import('./devices.mjs');
  await updateDevices(devicesPath, registry => {
    const device = registry.devices.find(d => d.id === deviceId);
    if (device && device.apns?.token === rejectedToken && device.apns?.environment === rejectedEnvironment) {
      delete device.apns;
    }
    return device ?? null;
  });
}
