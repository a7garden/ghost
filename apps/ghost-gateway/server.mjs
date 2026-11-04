import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { discover } from '../ghost-ui/server/bridge.mjs';
import { authenticate, readDevices, registerApnsToken, updateDevices } from './devices.mjs';
import { createNotificationOutbox, readApnsConfig } from './apns.mjs';
import { createOwnerSurface, ownerSurfaceRoute } from './owner_surface.mjs';
import { pairingRoute, createPairingService, bootstrapProof, startPairingAdvertiser } from './pairing.mjs';
import { imageOperation } from '../ghost-omp/images.mjs';

const MAX_BODY = 1_048_576, MAX_RESPONSE = 8 * MAX_BODY;
const MAX_OFFER_BYTES = 65_536, MAX_MEDIA_RESPONSE = 262_144;
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; media-src blob:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
};
function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { ...headers, ...extraHeaders, 'Content-Type': 'application/json; charset=utf-8' });
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
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lifetimeVersion = 'ghost-lifetime/1';
const readLifetimeMethods = new Set(['snapshot', 'goal.inspect', 'work.inspect', 'work.artifact', 'command.inspect', 'registry.inspect', 'conversation.inspect', 'conversation.turn.inspect']);
const writeLifetimeMethods = new Set(['goal.submit', 'goal.update', 'work.steer', 'work.cancel', 'work.delegate', 'conversation.input', 'conversation.cancel_turn']);

function route(method, path) {
  if (method === 'GET' && path === '/mobile/v1/snapshot') return '/api/v1/snapshot';
  if (method === 'POST' && path === '/mobile/v1/action') return '/api/v1/action';
  if (method === 'GET' && /^\/mobile\/v1\/events\/[a-f0-9-]{36}\/\d{1,16}$/i.test(path)) return path.replace('/mobile/v1/', '/api/v1/');
  return null;
}

function lifetimeRoute(method, path) {
  if (method === 'GET' && path === '/mobile/v1/lifetime/snapshot') return 'snapshot';
  if (method === 'POST' && path === '/mobile/v1/lifetime/action') return 'action';
  return null;
}

// The streaming media service is conversation-bound: one fixed Ghost and
// conversation, owned by its own loopback control token. The phone only ever
// speaks these four operations through this gateway.
function voiceMediaRoute(method, url) {
  const raw = url.split('?')[0].split('#')[0];
  if (raw.includes('%00') || raw.includes('../')) return null;
  if (method === 'POST' && raw === '/mobile/v1/voice/offer') return { kind: 'offer', pcID: null };
  const observe = /^\/mobile\/v1\/voice\/starts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(raw);
  if (observe && method === 'GET') return { kind: 'start_observe', startID: observe[1].toLowerCase() };
  const match = /^\/mobile\/v1\/voice\/sessions\/([^/]+)\/(ice|cancel_turn|hangup)$/.exec(raw);
  if (!match) return null;
  const expected = { ice: 'PATCH', cancel_turn: 'POST', hangup: 'POST' }[match[2]];
  if (method !== expected) return null;
  let pcID;
  try { pcID = decodeURIComponent(match[1]); } catch { return null; }
  // SmallWebRTC pc identifiers may contain '#' and '/'; the forward path is
  // percent-encoded, so only control characters and absurd length are refused.
  if (!pcID || pcID.length > 128 || /[\u0000-\u001f]/.test(pcID)) return null;
  return { kind: match[2], pcID };
}

function notificationRoute(method, url) {
  if (method !== 'POST') return null;
  if (url === '/mobile/v1/notifications/register') return 'register';
  if (url === '/mobile/v1/notifications/inspect') return 'inspect';
  if (url === '/mobile/v1/notifications/ack') return 'ack';
  return null;
}

// The media service's per-effect authority callback: it is the only process
// whose effects (Host transcript submission, playback) outlive HTTP admission,
// so it asks the revocation source immediately before every effect dispatch.
function internalVoiceRoute(method, url) {
  return method === 'POST' && url === '/internal/v1/voice/authority';
}

function parseMediaOrigin(value) {
  const url = new URL(value);
  const host = url.hostname;
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(host)
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
    throw new Error('GHOST_VOICE_MEDIA_ORIGIN must be a loopback http origin without path or credentials.');
  }
  return url.origin;
}

const notificationEventKinds = new Set(['result', 'acceptance', 'briefing']);
const notificationStates = new Set(['pending', 'transport_accepted', 'client_seen']);

function validateNotificationInbox(value) {
  if (!isRecord(value) || value.status !== 'success' || !isRecord(value.data)
    || !Array.isArray(value.data.notifications)) throw new Error('Host returned an invalid notification inbox.');
  for (const item of value.data.notifications) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || item.id.length > 400
      || typeof item.conversation_id !== 'string' || !uuidPattern.test(item.conversation_id)
      || typeof item.work_id !== 'string' || !item.work_id || item.work_id.length > 400
      || !Number.isSafeInteger(item.goal_revision) || item.goal_revision < 1
      || !notificationEventKinds.has(item.event_kind) || !notificationStates.has(item.state)) {
      throw new Error('Host returned an invalid notification record.');
    }
  }
  return value;
}

function validAckResult(result, recipientId, notificationId) {
  // A Host rejection (stale authority, unknown notification) must never be
  // reported as a recorded acknowledgement: require the exact bound outcome.
  return isRecord(result)
    && result.status === 'success'
    && isRecord(result.data)
    && result.data.recipient_id === recipientId
    && result.data.notification_id === notificationId
    && (result.data.state === 'transport_accepted' || result.data.state === 'client_seen');
}

function canonicalJSON(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Lifetime payload numbers must be safe integers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Lifetime payload must be plain JSON.');
  const keys = Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  return `{${keys.map(key => {
    if (value[key] === undefined) throw new Error('Lifetime payload cannot contain undefined values.');
    return `${JSON.stringify(key)}:${canonicalJSON(value[key])}`;
  }).join(',')}}`;
}

function payloadDigest(body) {
  return createHash('sha256').update(canonicalJSON(body), 'utf8').digest('hex');
}

function lifetimeActionRequest(identity, body) {
  const commandId = randomUUID();
  const envelope = {
    protocol_version: lifetimeVersion,
    command_id: commandId,
    payload_digest: payloadDigest(body),
    actor_ref: identity.actor_ref,
    authority_epoch: identity.authority_epoch,
    expected_revision: null,
    correlation_id: commandId,
    body,
  };
  return { request_id: randomUUID(), command: { type: 'lifetime', envelope } };
}

function namespacedCommandId(deviceId, commandId) {
  return `${deviceId}:${createHash('sha256').update(commandId, 'utf8').digest('hex')}`;
}

function bindingPairKey(ghostId, conversationId) {
  return JSON.stringify([ghostId, conversationId]);
}

function goalInScope(goal, bindingPairs) {
  return isRecord(goal)
    && typeof goal.accountable_ghost === 'string'
    && typeof goal.reply_conversation === 'string'
    && bindingPairs.has(bindingPairKey(goal.accountable_ghost, goal.reply_conversation));
}

function scopedSnapshot(snapshot, scope) {
  if (!isRecord(snapshot)
    || snapshot.protocol_version !== lifetimeVersion
    || snapshot.contract_revision !== 1
    || typeof snapshot.mode !== 'string'
    || !Array.isArray(snapshot.goals)
    || !Array.isArray(snapshot.work)
    || !Array.isArray(snapshot.bindings)
    || !Array.isArray(snapshot.artifacts)
    || !Array.isArray(snapshot.acceptances)) throw new Error('Host returned an invalid lifetime snapshot.');
  const bindings = snapshot.bindings.filter(binding => isRecord(binding)
    && typeof binding.ghost_id === 'string'
    && typeof binding.conversation_id === 'string'
    && scope.ghost_ids.includes(binding.ghost_id)
    && scope.conversation_ids.includes(binding.conversation_id));
  const bindingPairs = new Set(bindings.map(binding => bindingPairKey(binding.ghost_id, binding.conversation_id)));
  const goals = snapshot.goals.filter(goal => goalInScope(goal, bindingPairs));
  const goalIds = new Set(goals.map(goal => goal.id));
  const work = snapshot.work.filter(item => isRecord(item) && goalIds.has(item.goal_id) && scope.ghost_ids.includes(item.owner));
  const workIds = new Set(work.map(item => item.id));
  const acceptances = snapshot.acceptances.filter(item => isRecord(item) && workIds.has(item.work_id));
  const executions = new Set(work.map(item => item.execution_id).filter(value => typeof value === 'string'));
  return {
    protocol_version: snapshot.protocol_version,
    contract_revision: snapshot.contract_revision,
    mode: snapshot.mode,
    goals,
    work,
    bindings,
    artifacts: snapshot.artifacts.filter(artifact => isRecord(artifact) && executions.has(artifact.producing_attempt)),
    acceptances,
  };
}

function scopedTargetPairs(registry, scope) {
  if (!Array.isArray(registry)) throw new Error('Host returned an invalid Lifetime registry.');
  const ghosts = new Set(), conversations = new Set(), targets = [];
  for (const entry of registry) {
    if (!isRecord(entry)
      || typeof entry.ghost_id !== 'string' || !uuidPattern.test(entry.ghost_id)
      || typeof entry.conversation_id !== 'string' || !uuidPattern.test(entry.conversation_id)
      || !['primary', 'specialist'].includes(entry.kind)
      || !['active', 'draining'].includes(entry.mode)
      || !Array.isArray(entry.roles)
      || !entry.roles.every(role => typeof role === 'string' && role.trim())) {
      throw new Error('Host returned an invalid Lifetime conversation target.');
    }
    if (ghosts.has(entry.ghost_id) || conversations.has(entry.conversation_id)) {
      throw new Error('Host returned conflicting Lifetime conversation targets.');
    }
    ghosts.add(entry.ghost_id);
    conversations.add(entry.conversation_id);
    if (!scope.ghost_ids.includes(entry.ghost_id) || !scope.conversation_ids.includes(entry.conversation_id)) continue;
    targets.push({
      ghost_id: entry.ghost_id,
      kind: entry.kind,
      conversation_id: entry.conversation_id,
      roles: entry.roles,
      mode: entry.mode,
    });
  }
  return targets;
}

function safeLifetimeResponse(response, data, objectRefs = []) {
  return {
    status: response.status,
    summary: response.summary,
    object_refs: objectRefs,
    artifacts: [],
    next_actions: [],
    error_code: response.error_code,
    retry_class: response.retry_class,
    data,
  };
}

function scopedRegistryResponse(response, scope) {
  if (!isRecord(response) || response.status !== 'success' || !isRecord(response.data)) {
    throw new Error('Host returned an invalid Lifetime registry response.');
  }
  const targetPairs = scopedTargetPairs(response.data.registry, scope);
  return safeLifetimeResponse(response, { registry: targetPairs }, targetPairs.map(target => target.ghost_id));
}

const lifetimeRunStates = new Set(['queued', 'running', 'answered', 'failed', 'cancelled', 'effect_unknown']);
const lifetimeRunReasonCodes = new Set(['model_request_failed', 'runtime_failure', 'admission_blocked', 'answer_unprojectable', 'owner_cancelled', 'effect_unconfirmed', 'reply_delivery_unconfirmed', 'authority_revoked']);
const lifetimeRunFields = new Set([
  'turn_id', 'ghost_id', 'conversation_id', 'state', 'cancel_requested', 'cancel_command_id',
  'submission_id', 'entry_id', 'reason_code', 'latest_status_command_id', 'created_at_ms', 'updated_at_ms',
]);

function boundedRunIdentifier(value, nullable = false, maximumBytes = 400) {
  return (nullable && value === null)
    || (typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximumBytes);
}

function scopedConversationRun(value, target) {
  if (!isRecord(value)
    || Object.keys(value).length !== lifetimeRunFields.size
    || Object.keys(value).some(field => !lifetimeRunFields.has(field))
    || !boundedRunIdentifier(value.turn_id)
    || value.ghost_id !== target.ghost_id
    || value.conversation_id !== target.conversation_id
    || value.turn_id !== target.turn_id
    || !lifetimeRunStates.has(value.state)
    || typeof value.cancel_requested !== 'boolean'
    || !boundedRunIdentifier(value.cancel_command_id, true)
    || !boundedRunIdentifier(value.submission_id, true, 512)
    || !boundedRunIdentifier(value.entry_id, true, 512)
    || !(value.reason_code === null || lifetimeRunReasonCodes.has(value.reason_code))
    || !boundedRunIdentifier(value.latest_status_command_id, true)
    || !Number.isSafeInteger(value.created_at_ms) || value.created_at_ms < 0
    || !Number.isSafeInteger(value.updated_at_ms) || value.updated_at_ms < value.created_at_ms) {
    throw new Error('Host returned an invalid or foreign conversation turn run.');
  }
  return {
    turn_id: value.turn_id,
    ghost_id: value.ghost_id,
    conversation_id: value.conversation_id,
    state: value.state,
    cancel_requested: value.cancel_requested,
    cancel_command_id: value.cancel_command_id,
    submission_id: value.submission_id,
    entry_id: value.entry_id,
    reason_code: value.reason_code,
    latest_status_command_id: value.latest_status_command_id,
    created_at_ms: value.created_at_ms,
    updated_at_ms: value.updated_at_ms,
  };
}

function conversationRunReferences(turns) {
  const references = new Set();
  const nonOwnerTurnIDs = new Set();
  const seenTurnIDs = new Set();
  for (const turn of turns) {
    if (!isRecord(turn)
      || !boundedRunIdentifier(turn.id)
      || !['user', 'assistant_advisory', 'host_fact'].includes(turn.kind)
      || !(turn.source_turn_id === null || boundedRunIdentifier(turn.source_turn_id))
      || turn.origin_report_id !== undefined && turn.origin_report_id !== null && (
        !boundedRunIdentifier(turn.origin_report_id)
        || turn.kind !== 'assistant_advisory' || turn.sender_kind !== 'ghost' || turn.source_turn_id !== null
      )
      || seenTurnIDs.has(turn.id)) {
      throw new Error('Host returned an invalid canonical conversation turn reference.');
    }
    seenTurnIDs.add(turn.id);
    if (turn.kind === 'user') references.add(turn.id);
    else {
      nonOwnerTurnIDs.add(turn.id);
      if (turn.source_turn_id !== null) references.add(turn.source_turn_id);
    }
  }
  return { references, nonOwnerTurnIDs };
}

function scopedConversationTurnResponse(response, body) {
  if (!isRecord(response) || !['success', 'warning', 'error'].includes(response.status)) {
    throw new Error('Host returned an invalid conversation turn response.');
  }
  if (body.method === 'conversation.turn.inspect'
    && response.status === 'warning' && response.error_code === 'not_found'
    && isRecord(response.data) && response.data.run === 'not_found') {
    return safeLifetimeResponse(response, { run: 'not_found' });
  }
  if (response.status !== 'success') {
    const noEffect = response.status === 'error' && isRecord(response.data) && response.data.host_effect_class === 'no_effect';
    return safeLifetimeResponse(response, noEffect ? { host_effect_class: 'no_effect' } : null);
  }
  if (!isRecord(response.data)) throw new Error('Host returned a conversation turn response without a run.');
  const run = scopedConversationRun(response.data.run, body);
  return safeLifetimeResponse(response, { run }, [run.turn_id]);
}

function scopedConversationInspectResponse(response, body) {
  if (!isRecord(response)) throw new Error('Host returned an invalid conversation response.');
  if (response.status !== 'success') return safeLifetimeResponse(response, null);
  const page = response.data;
  if (!isRecord(page)
    || page.ghost_id !== body.ghost_id
    || page.conversation_id !== body.conversation_id
    || !['public', 'private', 'local_only'].includes(page.privacy)
    || !Array.isArray(page.turns)
    || !Array.isArray(page.turn_runs)
    || typeof page.has_older !== 'boolean'
    || !(page.oldest_sequence === null || (Number.isSafeInteger(page.oldest_sequence) && page.oldest_sequence > 0))) {
    throw new Error('Host returned a conversation page outside the verified target.');
  }
  const { references, nonOwnerTurnIDs } = conversationRunReferences(page.turns);
  const seenRuns = new Set();
  const turnRuns = page.turn_runs.map(run => {
    const scoped = scopedConversationRun(run, {
      ghost_id: body.ghost_id,
      conversation_id: body.conversation_id,
      turn_id: run?.turn_id,
    });
    if (!references.has(scoped.turn_id) || nonOwnerTurnIDs.has(scoped.turn_id) || seenRuns.has(scoped.turn_id)) {
      throw new Error('Host returned an unrelated or duplicate conversation turn run.');
    }
    seenRuns.add(scoped.turn_id);
    return scoped;
  });
  return safeLifetimeResponse(response, {
    ghost_id: page.ghost_id,
    conversation_id: page.conversation_id,
    privacy: page.privacy,
    turns: page.turns,
    turn_runs: turnRuns,
    has_older: page.has_older,
    oldest_sequence: page.oldest_sequence,
  });
}

function scopedConversationInputResponse(response, commandId) {
  if (!isRecord(response)) throw new Error('Host returned an invalid conversation input response.');
  if (response.status !== 'success') {
    const noEffect = response.status === 'error' && isRecord(response.data) && response.data.host_effect_class === 'no_effect';
    return safeLifetimeResponse(response, noEffect ? { host_effect_class: 'no_effect' } : null);
  }
  const data = response.data;
  if (!isRecord(data)
    || data.turn_id !== commandId
    || !Number.isSafeInteger(data.sequence) || data.sequence < 1
    || typeof data.privacy !== 'string'
    || data.queued !== true) {
    throw new Error('Host returned an invalid committed conversation turn.');
  }
  return safeLifetimeResponse(response, {
    turn_id: data.turn_id,
    sequence: data.sequence,
    privacy: data.privacy,
    queued: true,
  }, [commandId]);
}

function receiptResponseInScope(response, snapshot, scope, expectedCommandId) {
  if (!isRecord(response)
    || !['success', 'warning', 'error'].includes(response.status)
    || !Array.isArray(response.object_refs)
    || !Array.isArray(response.artifacts)
    || !Array.isArray(response.next_actions)) return false;
  if (isRecord(response.data) && Object.prototype.hasOwnProperty.call(response.data, 'turn_id')) {
    const data = response.data;
    return response.status === 'success'
      && data.turn_id === expectedCommandId
      && Number.isSafeInteger(data.sequence) && data.sequence > 0
      && typeof data.privacy === 'string' && data.privacy.trim().length > 0
      && data.queued === true
      && response.object_refs.length === 1 && response.object_refs[0] === expectedCommandId
      && response.artifacts.length === 0 && response.next_actions.length === 0;
  }
  if (isRecord(response.data) && Object.prototype.hasOwnProperty.call(response.data, 'run')) {
    const value = response.data.run;
    if (response.status !== 'success' || !isRecord(value)) return false;
    let run;
    try {
      run = scopedConversationRun(value, {
        ghost_id: value.ghost_id,
        conversation_id: value.conversation_id,
        turn_id: value.turn_id,
      });
    } catch {
      return false;
    }
    const pairs = new Set(snapshot.bindings.map(binding => bindingPairKey(binding.ghost_id, binding.conversation_id)));
    return scope.ghost_ids.includes(run.ghost_id)
      && scope.conversation_ids.includes(run.conversation_id)
      && pairs.has(bindingPairKey(run.ghost_id, run.conversation_id))
      && (response.object_refs.length === 0 || (response.object_refs.length === 1 && response.object_refs[0] === run.turn_id))
      && response.artifacts.length === 0 && response.next_actions.length === 0;
  }
  const goals = new Map(snapshot.goals.map(goal => [goal.id, goal]));
  const work = new Map(snapshot.work.map(item => [item.id, item]));
  const executions = new Set(snapshot.work.map(item => item.execution_id).filter(value => typeof value === 'string'));
  const artifacts = new Set(snapshot.artifacts.map(artifact => `${artifact.digest}\\u0000${artifact.producing_attempt}\\u0000${artifact.locator}`));
  const pairs = new Set(snapshot.bindings.map(binding => bindingPairKey(binding.ghost_id, binding.conversation_id)));
  const visibleRefs = new Set([...goals.keys(), ...work.keys(), ...executions]);
  if (response.object_refs.some(ref => typeof ref !== 'string' || !visibleRefs.has(ref))) return false;
  if (response.artifacts.some(artifact => !isRecord(artifact)
    || !artifacts.has(`${artifact.digest}\\u0000${artifact.producing_attempt}\\u0000${artifact.locator}`))) return false;

  function valueInScope(value, key = '') {
    if (Array.isArray(value)) {
      if (key === 'work' && value.some(item => !valueInScope(item, 'work'))) return false;
      if (key === 'artifacts' && value.some(item => !valueInScope(item, 'artifact'))) return false;
      return value.every(item => valueInScope(item));
    }
    if (!isRecord(value)) return true;
    if (key === 'goal' && (!goals.has(value.id) || !goalInScope(value, pairs))) return false;
    if (key === 'work') {
      const current = work.get(value.id);
      if (!current || !goals.has(value.goal_id) || !scope.ghost_ids.includes(value.owner)) return false;
      if (value.execution_id !== null && !executions.has(value.execution_id)) return false;
    }
    if (key === 'binding') {
      if (typeof value.ghost_id !== 'string' || typeof value.conversation_id !== 'string'
        || !pairs.has(bindingPairKey(value.ghost_id, value.conversation_id))) return false;
    }
    if (key === 'artifact' && !artifacts.has(`${value.digest}\\u0000${value.producing_attempt}\\u0000${value.locator}`)) return false;
    if (typeof value.goal_id === 'string' && !goals.has(value.goal_id)) return false;
    if (typeof value.work_id === 'string' && !work.has(value.work_id)) return false;
    if (typeof value.ghost_id === 'string' && !scope.ghost_ids.includes(value.ghost_id)) return false;
    if (typeof value.accountable_ghost === 'string' && !scope.ghost_ids.includes(value.accountable_ghost)) return false;
    if (typeof value.conversation_id === 'string' && !scope.conversation_ids.includes(value.conversation_id)) return false;
    if (typeof value.reply_conversation === 'string' && !scope.conversation_ids.includes(value.reply_conversation)) return false;
    if (typeof value.execution_id === 'string' && !executions.has(value.execution_id)) return false;
    if (typeof value.producing_attempt === 'string' && !executions.has(value.producing_attempt)) return false;
    if (typeof value.artifact_digest === 'string' && !snapshot.artifacts.some(artifact => artifact.digest === value.artifact_digest)) return false;
    if (typeof value.accountable_ghost === 'string' && typeof value.reply_conversation === 'string'
      && !pairs.has(bindingPairKey(value.accountable_ghost, value.reply_conversation))) return false;
    if (typeof value.ghost_id === 'string' && typeof value.conversation_id === 'string'
      && !pairs.has(bindingPairKey(value.ghost_id, value.conversation_id))) return false;
    return Object.entries(value).every(([childKey, child]) => valueInScope(child, childKey));
  }
  return valueInScope(response.data);
}

function sameDeviceAuthority(expected, current) {
  return Boolean(current)
    && current.id === expected.id
    && current.digest === expected.digest
    && JSON.stringify(current.scope ?? null) === JSON.stringify(expected.scope ?? null);
}

// The Rust host stays private on loopback. Only this optional HTTPS edge accepts
// device credentials, and it never forwards client-selected URLs or headers.
export function createGateway({
  root, devices, origin, lifetimeAuthorityEpoch, voiceMedia = null,
  apns = readApnsConfig(), providerKey = null, sendAlert, intervalMs, clock = () => new Date(),
  discoverHost = discover, fetchHost = fetch, fetchMedia = fetch,
}) {
  const publicOrigin = parseOrigin(origin);
  const lifetimeIdentity = Number.isSafeInteger(lifetimeAuthorityEpoch) && lifetimeAuthorityEpoch > 0
    ? { actor_ref: 'owner', authority_epoch: lifetimeAuthorityEpoch }
    : null;
  const rateLimits = new Map();
  let active = 0;

  // The gateway's own lifetime principal. Used for server-initiated outbox
  // polling; device requests keep their per-device envelope identity. Every
  // RPC carries an absolute deadline and honors an external abort signal so a
  // stalling Host can never hold a request slot, a poller pass, or a device
  // response socket open-ended.
  async function hostLifetimeAction(body, { timeoutMs = 30000, signal } = {}) {
    if (!lifetimeIdentity) throw new Error('Lifetime transport is not configured.');
    const host = await discoverHost(root);
    const action = lifetimeActionRequest(lifetimeIdentity, body);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const upstream = await fetchHost(`${host.origin}/api/v1/action`, {
        method: 'POST',
        body: Buffer.from(JSON.stringify(action)),
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${host.token}`,
          'X-Ghost-CSRF': host.token,
          Origin: host.origin,
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        },
      });
      const data = JSON.parse((await bounded(upstream.body, MAX_RESPONSE)).toString('utf8'));
      if (upstream.status < 200 || upstream.status >= 300 || data?.ok !== true || !isRecord(data.result)) {
        throw new Error('host_unavailable_or_outcome_unknown');
      }
      return data.result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // Device-triggered notification RPCs additionally fence on client close and
  // current device authority: revocation or narrowing aborts the request, and
  // no result is disclosed to an authority that changed mid-flight.
  async function fencedHostLifetimeAction(body, res, device, authorization, { timeoutMs = 30000 } = {}) {
    const controller = new AbortController();
    let revoked = false, checking = false;
    const revokePoll = setInterval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      void authenticate(devices, authorization).then(current => {
        if (!sameDeviceAuthority(device, current)) { revoked = true; controller.abort(); }
      }).catch(() => { revoked = true; controller.abort(); }).finally(() => { checking = false; });
    }, 250);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', onClose);
    try {
      const result = await hostLifetimeAction(body, { timeoutMs, signal: controller.signal });
      const current = await authenticate(devices, authorization).catch(() => null);
      if (!sameDeviceAuthority(device, current)) revoked = true;
      if (revoked) throw Object.assign(new Error('device_revoked'), { code: 'device_revoked' });
      return result;
    } catch (error) {
      if (revoked) throw Object.assign(new Error('device_revoked'), { code: 'device_revoked' });
      throw error;
    } finally {
      clearInterval(revokePoll);
      res.off('close', onClose);
    }
  }

  const notificationOutbox = createNotificationOutbox({
    config: apns, devicesPath: devices, readDevices, hostLifetimeAction,
    sendAlert, providerKey, intervalMs,
    log: message => console.error(`[ghost-gateway] ${message}`),
  });

  // Durable device↔session fence. Every admitted voice call is recorded in the
  // device registry before its answer is returned; a bounded sweep re-checks
  // each recorded authority and tears the media session down when the device
  // was revoked, re-issued, or narrowed. State survives gateway restarts
  // because it lives in the existing device JSON registry.
  const MEDIA_FENCE_INTERVAL_MS = 15000;
  const MEDIA_BINDING_TTL_MS = 24 * 3600 * 1000;
  let mediaFenceTimer = null;

  function mediaAuthorityFence(device) {
    return createHash('sha256').update(JSON.stringify([device.digest, device.scope ?? null])).digest('hex');
  }

  // Only terminal (ended) receipts age out, as bounded evidence housekeeping.
  // Unresolved or live records never age into a definite absence: while an
  // old fence is not truthfully closed, it keeps blocking new calls until the
  // media service proves its state or an operator resolves it deliberately.
  function isExpiredTerminalReceipt(record, nowMs) {
    return record.ended_at !== undefined
      && nowMs - Date.parse(record.ended_at) > MEDIA_BINDING_TTL_MS;
  }

  async function mutateMediaRegistry(change) {
    return updateDevices(devices, change);
  }

  // Pre-effect durable start record: written before the offer is forwarded so
  // absence later means the offer was never created through this gateway.
  // A device with an unresolved in-flight start cannot open a second one.
  async function ensureStartRecord(device, startID) {
    const fence = mediaAuthorityFence(device);
    return mutateMediaRegistry(registry => {
      const current = registry.devices.find(entry => entry.id === device.id);
      if (!current || current.digest !== device.digest
        || JSON.stringify(current.scope ?? null) !== JSON.stringify(device.scope ?? null)) {
        return { revoked: true };
      }
      current.media = current.media ?? [];
      const nowMs = Date.now();
      current.media = current.media.filter(record => !isExpiredTerminalReceipt(record, nowMs));
      const existing = current.media.find(entry => entry.start_id === startID);
      if (existing) return { record: existing };
      // Any unresolved record fences new calls regardless of age; only media
      // evidence or deliberate operator resolution closes it.
      const unresolved = current.media.find(entry => entry.pc_id === null
        && entry.ended_at === undefined);
      if (unresolved) return { unresolved: unresolved.start_id };
      if (current.media.length >= 4) {
        // Terminal receipts are housekeeping evidence, not live fences: the
        // oldest one yields to a genuinely new call.
        const terminal = current.media.filter(entry => entry.ended_at !== undefined)
          .sort((left, right) => Date.parse(left.since) - Date.parse(right.since));
        if (!terminal.length) return { full: true };
        current.media = current.media.filter(entry => entry !== terminal[0]);
      }
      const record = { start_id: startID, pc_id: null, since: new Date().toISOString(), fence };
      current.media.push(record);
      return { record };
    });
  }

  // Confirmed end (owner hangup, replayed ended answer, or fence teardown):
  // the start record survives with its ended receipt for truthful observation
  // until its bounded TTL; the sweep stops reaping once ended_at is set.
  async function markMediaEnded(pcID) {
    await mutateMediaRegistry(registry => {
      const now = new Date().toISOString();
      for (const entry of registry.devices) {
        for (const record of entry.media ?? []) {
          if (record.pc_id === pcID && record.ended_at === undefined) record.ended_at = now;
        }
      }
      return null;
    });
  }

  async function bindMediaAnswer(device, startID, pcID) {
    const fence = mediaAuthorityFence(device);
    return mutateMediaRegistry(registry => {
      const current = registry.devices.find(entry => entry.id === device.id);
      if (!current) return { revoked: true };
      const record = (current.media ?? []).find(entry => entry.start_id === startID);
      if (!record || record.fence !== fence) return { revoked: true };
      // The media service owns session truth: a replayed offer answered with a
      // different pc means the previously bound session no longer exists
      // there, so the durable fence always adopts the answered session.
      record.pc_id = pcID;
      return { record };
    });
  }

  function scheduleMediaFence() {
    if (!voiceMedia || mediaFenceTimer) return;
    mediaFenceTimer = setTimeout(() => {
      mediaFenceTimer = null;
      void sweepMediaFence();
    }, MEDIA_FENCE_INTERVAL_MS);
    mediaFenceTimer.unref?.();
  }

  async function sweepMediaFence() {
    if (!voiceMedia) return;
    let bindings;
    try {
      const registry = await readDevices(devices);
      bindings = registry.devices.flatMap(entry => (entry.media ?? []).map(record => ({ device: entry, record })));
    } catch {
      scheduleMediaFence(); // unknown registry state: retry on the next sweep
      return;
    }
    let pending = false;
    const now = Date.now();
    for (const { device, record } of bindings) {
      if (isExpiredTerminalReceipt(record, now)) {
        // Housekeeping of terminal evidence only; nothing unresolved is aged.
        await mutateMediaRegistry(registry => {
          const entry = registry.devices.find(candidate => candidate.id === device.id);
          if (entry && Array.isArray(entry.media)) {
            entry.media = entry.media.filter(candidate => candidate.start_id !== record.start_id);
            if (!entry.media.length) delete entry.media;
          }
          return null;
        }).catch(() => { pending = true; });
        continue;
      }
      if (record.ended_at !== undefined) continue;
      if (record.pc_id === null) {
        // Unresolved offers resolve only through media evidence or deliberate
        // operator resolution — never by aging.
        try {
          const result = await mediaRequest(`/starts/${encodeURIComponent(record.start_id)}`, 'GET', undefined, { abortOnClientClose: false, timeoutMs: 10000, deviceId: device.id });
          if (result.upstream.status === 404) {
            // The media service provably never created (or deadline-cancelled)
            // this offer: absence is evidence-backed, so the fence closes.
            await mutateMediaRegistry(registry => {
              const entry = registry.devices.find(candidate => candidate.id === device.id);
              if (entry && Array.isArray(entry.media)) {
                entry.media = entry.media.filter(candidate => candidate.start_id !== record.start_id);
                if (!entry.media.length) delete entry.media;
              }
              return null;
            }).catch(() => { pending = true; });
            continue;
          }
          if (result.upstream.status === 200 && isRecord(result.data) && result.data.state === 'live'
            && typeof result.data.pc_id === 'string' && result.data.pc_id.length <= 128) {
            await bindMediaAnswer(device, record.start_id, result.data.pc_id).catch(() => {});
            pending = true; // re-evaluated with its pc binding on the next sweep
            continue;
          }
          if (result.upstream.status === 200 && isRecord(result.data) && result.data.state === 'ended') {
            await mutateMediaRegistry(registry => {
              const entry = registry.devices.find(candidate => candidate.id === device.id);
              if (entry && Array.isArray(entry.media)) {
                for (const candidate of entry.media) {
                  if (candidate.start_id === record.start_id && candidate.ended_at === undefined) {
                    candidate.pc_id = typeof result.data.pc_id === 'string' ? result.data.pc_id : null;
                    candidate.ended_at = new Date().toISOString();
                  }
                }
              }
              return null;
            }).catch(() => { pending = true; });
            continue;
          }
        } catch { /* media unreachable: stays unknown */ }
        pending = true;
        continue;
      }
      const unbound = device.digest === undefined || mediaAuthorityFence(device) !== record.fence;
      if (!unbound) continue;
      // The installation was revoked, re-issued, or narrowed: end its media.
      try {
        const result = await mediaRequest(`/sessions/${encodeURIComponent(record.pc_id)}/hangup`, 'POST', undefined, { abortOnClientClose: false, timeoutMs: 10000, deviceId: device.id });
        if (result.upstream.status === 200) await markMediaEnded(record.pc_id);
        else pending = true; // unknown outcome: keep the binding for a bounded retry
      } catch {
        pending = true; // media service unreachable: retry on the next sweep
      }
    }
    if (pending) scheduleMediaFence();
  }

  // Truthful start observation for a reconciling client. Codes:
  // 200 {state:'live'|'ended', pc_id} — resolved against media evidence;
  // 404 voice_start_unknown — trustworthy absence for this device id: the
  // record is written before any offer leaves the gateway, and a pc-less
  // record is only closed when the media service itself reports provable
  // absence (deadline-cancelled creation, persisted across its restarts);
  // 502 voice_start_unknown_outcome — evidence exists but cannot resolve, the
  // client stays fenced (never aged into absence, never operator-guessed).
  async function observeMediaStart(res, device, req, startID) {
    let registry;
    try {
      registry = await readDevices(devices);
    } catch {
      return json(res, 502, { ok: false, error: 'voice_start_unknown_outcome' });
    }
    // Observation is keyed by device id: a start record is visible only to the
    // device entry that created it under its current authority fence. Evidence
    // belonging to another principal (or a re-paired/re-issued one) is
    // forbidden — it never reports trustworthy absence, so a foreign or new
    // controller can never clear an old fence.
    let record = null, foreign = false;
    for (const entry of registry.devices) {
      for (const candidate of entry.media ?? []) {
        if (candidate.start_id !== startID) continue;
        if (entry.id === device.id && candidate.fence === mediaAuthorityFence(device)) record = candidate;
        else foreign = true;
      }
    }
    if (record === null) {
      if (foreign) return json(res, 403, { ok: false, error: 'voice_start_forbidden' });
      return json(res, 404, { ok: false, error: 'voice_start_unknown' });
    }
    if (record.ended_at !== undefined) return json(res, 200, { state: 'ended', pc_id: record.pc_id });
    // Both resolved and unresolved records resolve through the media service's
    // own persisted start evidence; the gateway never guesses absence.
    try {
      const result = await mediaRequest(`/starts/${encodeURIComponent(startID)}`, 'GET', undefined, { res, timeoutMs: 10000, deviceId: device.id });
      if (result.upstream.status === 200 && isRecord(result.data)
        && (result.data.state === 'live' || result.data.state === 'ended')) {
        const pcID = typeof result.data.pc_id === 'string' && result.data.pc_id.length <= 128
          ? result.data.pc_id
          : record.pc_id;
        if (record.pc_id === null && pcID !== null && result.data.state === 'live') {
          await bindMediaAnswer(device, startID, pcID).catch(() => {});
        }
        if (result.data.state === 'ended' && record.ended_at === undefined) {
          await mutateMediaRegistry(registry => {
            const entry = registry.devices.find(candidate => candidate.id === device.id);
            if (entry && Array.isArray(entry.media)) {
              for (const candidate of entry.media) {
                if (candidate.start_id === startID && candidate.ended_at === undefined) {
                  candidate.pc_id = pcID;
                  candidate.ended_at = new Date().toISOString();
                }
              }
            }
            return null;
          }).catch(() => {});
        }
        return json(res, 200, { state: result.data.state, pc_id: pcID });
      }
      if (result.upstream.status === 404 && record.pc_id === null) {
        // The media service provably never created (or deadline-cancelled)
        // this offer: evidence-backed absence closes the fence.
        await mutateMediaRegistry(registry => {
          const entry = registry.devices.find(candidate => candidate.id === device.id);
          if (entry && Array.isArray(entry.media)) {
            entry.media = entry.media.filter(candidate => candidate.start_id !== startID);
            if (!entry.media.length) delete entry.media;
          }
          return null;
        }).catch(() => {});
        return json(res, 404, { ok: false, error: 'voice_start_unknown' });
      }
    } catch { /* media evidence unavailable: unknown */ }
    return json(res, 502, { ok: false, error: 'voice_start_unknown_outcome' });
  }

  // Voice media authorization: mutating admission and controls require the
  // exact registered pair plus lifetime.write; teardown stays available to
  // any device scoped to the pair (ending media must always win).
  function pairScoped(device) {
    if (!voiceMedia) return false;
    if (!device.scope) return true;
    return device.scope.capabilities.includes('lifetime.write')
      && device.scope.ghost_ids.includes(voiceMedia.ghostID)
      && device.scope.conversation_ids.includes(voiceMedia.conversationID);
  }

  function teardownAllowed(device) {
    if (!voiceMedia) return false;
    if (!device.scope) return true;
    return device.scope.ghost_ids.includes(voiceMedia.ghostID)
      && device.scope.conversation_ids.includes(voiceMedia.conversationID);
  }

  // Forward one bounded media control request to the loopback streaming
  // service. Hangup always completes: ending server-side media must win over
  // short-lived client or revocation state. The authenticated device
  // installation rides along so the media service can fence sessions and
  // controls to the installation that created them.
  async function mediaRequest(target, method, body, { res, abortOnClientClose = true, timeoutMs = 35000, deviceId = null } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onClose = abortOnClientClose && res
      ? () => { if (!res.writableEnded) controller.abort(); }
      : null;
    if (onClose) res.once('close', onClose);
    try {
      const upstream = await fetchMedia(`${voiceMedia.origin}${target}`, {
        method,
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${voiceMedia.controlToken}`,
          'X-Ghost-CSRF': voiceMedia.controlToken,
          ...(deviceId ? { 'X-Ghost-Media-Device': deviceId } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      });
      const data = JSON.parse((await bounded(upstream.body, MAX_MEDIA_RESPONSE)).toString('utf8'));
      return { upstream, data };
    } finally {
      clearTimeout(timeout);
      if (onClose) res.off('close', onClose);
    }
  }

  function takeRateToken(deviceId) {
    const now = Date.now(), capacity = 60, window = 60000;
    const current = rateLimits.get(deviceId) ?? { tokens: capacity, updated: now };
    current.tokens = Math.min(capacity, current.tokens + Math.max(0, now - current.updated) * capacity / window);
    current.updated = now;
    if (current.tokens < 1) {
      rateLimits.set(deviceId, current);
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((1 - current.tokens) * window / capacity)) };
    }
    current.tokens -= 1;
    rateLimits.set(deviceId, current);
    if (rateLimits.size > 512) {
      for (const [id, bucket] of rateLimits) {
        if (now - bucket.updated > window * 2) rateLimits.delete(id);
        if (rateLimits.size <= 512) break;
      }
      while (rateLimits.size > 512) rateLimits.delete(rateLimits.keys().next().value);
    }
    return { allowed: true, retryAfter: 0 };
  }

  async function hostRequest(host, target, method, body, device, authorization, res) {
    const initial = await authenticate(devices, authorization);
    if (!sameDeviceAuthority(device, initial)) return { revoked: true };
    const controller = new AbortController();
    let revoked = false, clientClosed = false, checking = false;
    const revokePoll = setInterval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      void authenticate(devices, authorization).then(current => {
        if (!sameDeviceAuthority(device, current)) { revoked = true; controller.abort(); }
      }).catch(() => { revoked = true; controller.abort(); }).finally(() => { checking = false; });
    }, 250);
    const timeout = setTimeout(() => controller.abort(), 60000);
    const onClose = () => {
      if (!res.writableEnded) { clientClosed = true; controller.abort(); }
    };
    res.once('close', onClose);
    try {
      const upstream = await fetchHost(`${host.origin}${target}`, {
        method,
        ...(body ? { body } : {}),
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${host.token}`,
          'X-Ghost-CSRF': host.token,
          Origin: host.origin,
          'Sec-Fetch-Site': 'same-origin',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
      const data = JSON.parse((await bounded(upstream.body, MAX_RESPONSE)).toString('utf8'));
      const current = await authenticate(devices, authorization).catch(() => null);
      if (!sameDeviceAuthority(device, current)) revoked = true;
      if (revoked) return { revoked: true };
      return { upstream, data };
    } catch (error) {
      if (revoked) return { revoked: true };
      if (clientClosed) return { clientClosed: true };
      throw error;
    } finally {
      clearInterval(revokePoll);
      clearTimeout(timeout);
      res.off('close', onClose);
    }
  }

  async function lifetimeHostAuthority(host, device, authorization, res) {
    if (!lifetimeIdentity) throw new Error('Lifetime transport is not configured.');
    const result = await hostRequest(host, '/api/v1/snapshot', 'GET', null, device, authorization, res);
    if (result.revoked || result.clientClosed) return result;
    const authority = result.data?.lifetime_authority;
    if (result.upstream.status < 200 || result.upstream.status >= 300
      || !isRecord(result.data) || !uuidPattern.test(result.data.workspace_id)
      || !isRecord(authority)
      || !Number.isSafeInteger(authority.authority_epoch) || authority.authority_epoch < 1
      || typeof authority.dispatch_enabled !== 'boolean'
      || authority.authority_epoch !== lifetimeIdentity.authority_epoch) {
      throw new Error('Host Lifetime authority is missing or does not match the configured generation.');
    }
    return {
      authority: {
        workspace_id: result.data.workspace_id,
        authority_epoch: authority.authority_epoch,
        dispatch_enabled: authority.dispatch_enabled,
      },
    };
  }

  async function lifetimeTargetPairs(host, device, authorization, res) {
    const action = lifetimeActionRequest(lifetimeIdentity, { method: 'registry.inspect' });
    const result = await hostRequest(host, '/api/v1/action', 'POST', Buffer.from(JSON.stringify(action)), device, authorization, res);
    if (result.revoked || result.clientClosed) return result;
    if (result.upstream.status < 200 || result.upstream.status >= 300
      || result.data?.ok !== true || !isRecord(result.data.result)) {
      throw new Error('Host Lifetime registry is unavailable.');
    }
    const response = scopedRegistryResponse(result.data.result, device.scope);
    return { target_pairs: response.data.registry, response };
  }

  async function lifetimeSnapshot(host, device, authorization, res) {
    const metadata = await lifetimeHostAuthority(host, device, authorization, res);
    if (metadata.revoked || metadata.clientClosed) return metadata;
    const action = lifetimeActionRequest(lifetimeIdentity, { method: 'snapshot' });
    const result = await hostRequest(host, '/api/v1/action', 'POST', Buffer.from(JSON.stringify(action)), device, authorization, res);
    if (result.revoked || result.clientClosed) return result;
    if (result.upstream.status < 200 || result.upstream.status >= 300 || result.data?.ok !== true || result.data?.result?.status !== 'success') {
      throw new Error('Host lifetime snapshot is unavailable.');
    }
    return { snapshot: scopedSnapshot(result.data.result.data, device.scope), authority: metadata.authority };
  }

  // Scoped owner decision surface: pending browser questions, exact
  // approve/deny decisions, and per-Ghost home/browser lifecycle for the
  // exact registered pairs in a lifetime device's own scope.
  const ownerSurface = createOwnerSurface({
    json, bounded, isRecord, root, discoverHost, hostRequest,
    lifetimeHostAuthority, lifetimeSnapshot, lifetimeTargetPairs, lifetimeIdentity,
  });

  // Phone pairing state machine: invitations and claims are recognized before
  // device authentication; owner approvals re-prove the exact current Root
  // registry Primary row and epoch before any device grant is written.
  const pairing = lifetimeIdentity ? createPairingService({
    devices,
    origin: publicOrigin.origin,
    epoch: lifetimeIdentity.authority_epoch,
    now: clock,
    hostRegistry: async () => {
      const result = await hostLifetimeAction({ method: 'registry.inspect' });
      if (!isRecord(result) || result.status !== 'success' || !isRecord(result.data)) {
        throw Object.assign(new Error('pairing_scope_unavailable'), { status: 503, code: 'pairing_scope_unavailable' });
      }
      return result.data.registry;
    },
  }) : null;

  const pairingTokenEqual = (present, expected) =>
    present.length === expected.length && timingSafeEqual(Buffer.from(present), Buffer.from(expected));

  async function handlePairing(req, res, match) {
    try {
      if (!pairing) return json(res, 503, { error: 'pairing_unconfigured' });
      if (match.kind === 'bootstrap') {
        // Unauthenticated identity proof: the bridge verifies this HMAC over
        // the exact byte chain (context 0x00 nonce 0x00 public origin) before
        // it ever forwards the Root Host token, and only to this loopback
        // gateway.
        const host = await discoverHost(root);
        return json(res, 200, {
          protocol: 'ghost-pairing', version: 1,
          origin: publicOrigin.origin,
          proof: bootstrapProof(host.token, match.nonce, publicOrigin.origin),
        });
      }
      let body = null;
      if (req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(res, 415, { error: 'json_required' });
        try { body = JSON.parse((await bounded(req, 4096)).toString('utf8')); }
        catch (error) {
          if (error.message === 'size_limit') return json(res, 413, { error: 'payload_too_large' });
          return json(res, 400, { error: 'invalid_json' });
        }
      }
      if (match.kind === 'claim_create') return json(res, 200, await pairing.createClaim(body));
      if (match.kind === 'claim_status') {
        return json(res, 200, await pairing.claimStatus(match.id, body, String(req.headers.authorization ?? '')));
      }
      // Owner-bridge admin routes: the exact Root Host token — resolved fresh
      // through the protected bootstrap discover, never a caller-supplied
      // value — must be presented as both Bearer credential and CSRF proof.
      const host = await discoverHost(root);
      const bearer = String(req.headers.authorization ?? '');
      const csrf = String(req.headers['x-ghost-csrf'] ?? '');
      if (!pairingTokenEqual(bearer, `Bearer ${host.token}`) || !pairingTokenEqual(csrf, host.token)) {
        return json(res, 401, { error: 'pairing_admin_unauthorized' });
      }
      if (match.kind === 'invitation_create') return json(res, 200, await pairing.createInvitation(body));
      if (match.kind === 'invitation_list') return json(res, 200, await pairing.listInvitations());
      if (match.kind === 'invitation_get') return json(res, 200, await pairing.invitationMeta(match.id));
      if (match.kind === 'invitation_approve') return json(res, 200, await pairing.approveInvitation(match.id, body));
      return json(res, 200, await pairing.cancelInvitation(match.id, body));
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      const code = typeof error?.code === 'string' ? error.code : 'pairing_unavailable';
      if (!res.writableEnded && !res.destroyed) return json(res, status, { error: code });
    }
  }

  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (req, res) => {
    res.setTimeout(70000, () => res.destroy());
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return json(res, 403, { error: 'local_proxy_required' });
    if (req.headers.host !== publicOrigin.host || (req.headers.origin && req.headers.origin !== publicOrigin.origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return json(res, 403, { error: 'origin_denied' });
    if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { service: 'ghost-gateway', version: 1 });
    if (active >= 24) return json(res, 503, { error: 'busy' });
    active++;
    try {
      if (internalVoiceRoute(req.method, req.url)) {
        if (!voiceMedia) return json(res, 503, { error: 'voice_media_unconfigured' });
        const bearer = String(req.headers.authorization ?? '');
        const csrf = String(req.headers['x-ghost-csrf'] ?? '');
        const tokenMatches = (present, expected) =>
          present.length === expected.length && timingSafeEqual(Buffer.from(present), Buffer.from(expected));
        const bearerOk = tokenMatches(bearer, `Bearer ${voiceMedia.controlToken}`);
        const csrfOk = tokenMatches(csrf, voiceMedia.controlToken);
        if (!bearerOk || !csrfOk) return json(res, 403, { error: 'voice_authority_unauthorized' });
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(res, 415, { error: 'json_required' });
        let body;
        try { body = JSON.parse((await bounded(req, 4096)).toString('utf8')); }
        catch {
          if (res.writableEnded || res.destroyed) return;
          return json(res, 400, { error: 'invalid_json' });
        }
        if (!isRecord(body) || typeof body.device_id !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.device_id)
          || typeof body.start_id !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.start_id)) {
          return json(res, 400, { error: 'invalid_device' });
        }
        let registry;
        try { registry = await readDevices(devices); }
        catch { return json(res, 503, { error: 'voice_authority_unavailable' }); }
        // The ask binds to the EXACT admission record of the calling session:
        // installation, exact pair, write capability, that record's
        // admission-time fence versus the current device generation, and a
        // non-ended state. An old call can never regain authority from a newer
        // call admitted on the same device — only its own live record
        // authorizes it, and anything else is the caller's unknown.
        const current = registry.devices.find(entry => entry.id === body.device_id);
        const authorized = Boolean(current) && pairScoped(current)
          && (current.media ?? []).some(record => record.start_id === body.start_id
            && record.ended_at === undefined
            && record.fence === mediaAuthorityFence(current));
        return json(res, 200, { authorized });
      }
      const pairingMatch = pairingRoute(req.method, req.url.split('?')[0]);
      if (pairingMatch) return handlePairing(req, res, pairingMatch);
      const device = await authenticate(devices, req.headers.authorization);
      if (!device) return json(res, 401, { error: 'device_not_authorized' });
      const scoped = device.scope !== undefined;
      if (scoped) {
        const rate = takeRateToken(device.id);
        if (!rate.allowed) return json(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(rate.retryAfter) });
      }
      if (req.method === 'GET' && req.url === '/mobile/v1/bootstrap') {
        const bootstrap = { protocol: 'ghost-mobile', version: 1, device: { id: device.id, name: device.name }, role: scoped ? 'lifetime' : 'owner' };
        const advertisedMedia = pairScoped(device)
          ? { offer: '/mobile/v1/voice/offer', ghost_id: voiceMedia.ghostID, conversation_id: voiceMedia.conversationID }
          : null;
        if (!scoped) {
          if (!advertisedMedia) return json(res, 200, { ...bootstrap, voice_media: null });
          const host = await discoverHost(root);
          const result = await hostRequest(host, '/api/v1/snapshot', 'GET', undefined, device, req.headers.authorization, res);
          if (result.revoked) return json(res, 401, { error: 'device_not_authorized' });
          if (result.clientClosed) return;
          if (result.upstream.status < 200 || result.upstream.status >= 300
            || !isRecord(result.data) || !uuidPattern.test(result.data.workspace_id)) {
            return json(res, 503, { error: 'host_workspace_unavailable' });
          }
          return json(res, 200, { ...bootstrap, workspace_id: result.data.workspace_id, voice_media: advertisedMedia });
        }
        if (!lifetimeIdentity) return json(res, 503, { error: 'lifetime_transport_unconfigured' });
        const host = await discoverHost(root);
        const metadata = await lifetimeHostAuthority(host, device, req.headers.authorization, res);
        if (metadata.revoked) return json(res, 401, { error: 'device_not_authorized' });
        if (metadata.clientClosed) return;
        const registry = await lifetimeTargetPairs(host, device, req.headers.authorization, res);
        if (registry.revoked) return json(res, 401, { error: 'device_not_authorized' });
        if (registry.clientClosed) return;
        return json(res, 200, {
          ...bootstrap,
          scope: device.scope,
          lifetime_identity: lifetimeIdentity,
          lifetime_host: metadata.authority,
          target_pairs: registry.target_pairs,
          voice_media: advertisedMedia,
        });
      }

      // Model selection is a separate bounded configuration ingress. Device
      // credentials can select only an exact registered pair; never register
      // API keys, change workspace defaults, or receive another pair's grants.
      const imageRoute=req.url === '/mobile/v1/inference/images' && req.method==='POST';
      if ((req.url === '/mobile/v1/inference/settings' && ['GET','POST'].includes(req.method)) || imageRoute) {
        if (!scoped || !lifetimeIdentity) return json(res,403,{error:'scope_required'});
        if (!device.scope.capabilities.includes('lifetime.read') || (req.method==='POST' && !device.scope.capabilities.includes('lifetime.write'))) return json(res,403,{error:'capability_denied'});
        const host=await discoverHost(root);
        const metadata=await lifetimeHostAuthority(host,device,req.headers.authorization,res);
        if(metadata.revoked) return json(res,401,{error:'device_not_authorized'});
        if(metadata.clientClosed) return;
        const registry=await lifetimeTargetPairs(host,device,req.headers.authorization,res);
        if(registry.revoked) return json(res,401,{error:'device_not_authorized'});
        if(registry.clientClosed) return;
        const keys=new Set(registry.target_pairs.map(pair=>`${pair.ghost_id}/${pair.conversation_id}`));
        let body, imageInput;
        if(req.method==='POST') {
          if(req.headers['content-type']?.split(';')[0].trim()!=='application/json') return json(res,415,{error:'json_required'});
          let value;
          try { value=JSON.parse((await bounded(req,8192)).toString('utf8')); } catch { return json(res,400,{error:'invalid_inference_configuration'}); }
          if(imageRoute) {
            if(!isRecord(value)||!keys.has(`${value.ghost_id}/${value.conversation_id}`)) return json(res,403,{error:'scope_denied'});
            imageInput=value;
          } else {
            const allowed=new Set(['operation','version','ghost_id','conversation_id','selection','allow_external']);
            if(!isRecord(value) || value.operation!=='select' || Object.keys(value).some(key=>!allowed.has(key)) || !keys.has(`${value.ghost_id}/${value.conversation_id}`)) return json(res,403,{error:'scope_denied'});
            body=Buffer.from(JSON.stringify(value));
          }
        }
        const result=await hostRequest(host,'/api/v1/inference/settings',imageRoute?'GET':req.method,body,device,req.headers.authorization,res);
        if(result.revoked) return json(res,401,{error:'device_not_authorized'});
        if(result.clientClosed) return;
        if(result.data?.ok!==true || !isRecord(result.data.settings)) return json(res,result.upstream.status,{ok:false,error:'model_settings_unavailable'});
        const value=result.data, settings=value.settings;
        if(imageRoute) {
          try {return json(res,200,{ok:true,result:await imageOperation({root,input:imageInput,configuration:value,executable:process.env.GHOST_CODEX_EXECUTABLE,dynoExecutable:process.env.GHOST_DYNO_IMAGE_EXECUTABLE})});}
          catch {return json(res,400,{ok:false,error:'image_request_rejected'});}
        }
        const filter=(entries)=>Object.fromEntries(Object.entries(entries??{}).filter(([key])=>keys.has(key)));
        return json(res,result.upstream.status,{ok:true,settings:{...settings,conversations:filter(settings.conversations),external_grants:filter(settings.external_grants)},providers:value.providers});
      }

      const media = voiceMediaRoute(req.method, req.url);
      const notifications = notificationRoute(req.method, req.url);
      const mobileLifetimeRoute = lifetimeRoute(req.method, req.url);
      const ownerSurfaceKind = ownerSurfaceRoute(req.method, req.url);
      const legacyTarget = route(req.method, req.url);
      if (media && !voiceMedia) return json(res, 503, { error: 'voice_media_unconfigured' });
      if (media && !(media.kind === 'hangup' ? teardownAllowed(device) : pairScoped(device))) return json(res, 403, { error: 'scope_denied' });
      if (!media && !notifications && !ownerSurfaceKind) {
        if (scoped && !mobileLifetimeRoute) return json(res, legacyTarget ? 403 : 404, { error: legacyTarget ? 'scope_denied' : 'not_found' });
        if (!scoped && mobileLifetimeRoute) return json(res, 403, { error: 'scope_required' });
        if (!mobileLifetimeRoute && !legacyTarget) return json(res, 404, { error: 'not_found' });
      }
      if ((mobileLifetimeRoute || ownerSurfaceKind) && !lifetimeIdentity) return json(res, 503, { error: 'lifetime_transport_unconfigured' });

      // Owner decision surface: exact-scope questions, decisions, and
      // lifecycle. Lifetime devices only; the module enforces capabilities
      // and per-Ghost scope against the Host's durable registry.
      if (ownerSurfaceKind) {
        if (!scoped) return json(res, 403, { error: 'scope_required' });
        if (req.method === 'POST' && req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
          return json(res, 415, { error: 'json_required' });
        }
        return ownerSurface.handle(ownerSurfaceKind, req, res, device, req.headers.authorization);
      }

      if (notifications) {
        if (notifications !== 'register' && !lifetimeIdentity) return json(res, 503, { error: 'lifetime_transport_unconfigured' });
        if (scoped && notifications !== 'register' && !device.scope.capabilities.includes(notifications === 'ack' ? 'lifetime.write' : 'lifetime.read')) {
          return json(res, 403, { error: 'capability_denied' });
        }
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(res, 415, { error: 'json_required' });
        let body;
        try { body = JSON.parse((await bounded(req, 65536)).toString('utf8')); }
        catch (error) {
          if (error.message === 'size_limit') return json(res, 413, { error: 'payload_too_large' });
          return json(res, 400, { error: 'invalid_json' });
        }
        if (!isRecord(body)) return json(res, 400, { error: 'invalid_json' });
        if (!sameDeviceAuthority(device, await authenticate(devices, req.headers.authorization))) return json(res, 401, { error: 'device_not_authorized' });
        if (notifications === 'register') {
          if (Object.keys(body).length !== 2
            || !['device_token', 'environment'].every(key => Object.prototype.hasOwnProperty.call(body, key))
            || typeof body.device_token !== 'string'
            || !/^[0-9a-f]{32,128}$/.test(body.device_token)
            || (body.environment !== 'sandbox' && body.environment !== 'production')) {
            return json(res, 400, { error: 'invalid_registration' });
          }
          await registerApnsToken(devices, device.id, body.device_token, body.environment);
          return json(res, 200, { registered: true });
        }
        if (!uuidPattern.test(body.recipient_id ?? '')) return json(res, 400, { error: 'invalid_recipient' });
        if (scoped && !device.scope.ghost_ids.includes(body.recipient_id)) return json(res, 403, { error: 'scope_denied' });
        const notificationRpcFailed = error => {
          if (error?.code === 'device_revoked') return json(res, 401, { error: 'device_not_authorized' });
          if (res.destroyed || res.writableEnded) return undefined;
          return json(res, 502, { ok: false, error: 'host_unavailable_or_outcome_unknown' });
        };
        if (notifications === 'inspect') {
          if (Object.keys(body).length !== 1) return json(res, 400, { error: 'invalid_inspection' });
          let result;
          try {
            result = validateNotificationInbox(await fencedHostLifetimeAction({
              method: 'notification.inspect', recipient_id: body.recipient_id, limit: 100,
            }, res, device, req.headers.authorization));
          } catch (error) {
            const failed = notificationRpcFailed(error);
            return failed;
          }
          if (scoped && result.data.notifications.some(item => !device.scope.conversation_ids.includes(item.conversation_id))) {
            return json(res, 502, { ok: false, error: 'host_notification_outside_device_scope' });
          }
          return json(res, 200, { ok: true, result });
        }
        if (Object.keys(body).length !== 3
          || typeof body.notification_id !== 'string' || !body.notification_id || body.notification_id.length > 400
          || !['transport_accepted', 'client_seen'].includes(body.state)) {
          return json(res, 400, { error: 'invalid_acknowledgement' });
        }
        // Resolve the notification under its recipient first: the exact
        // conversation must be inside the current device scope before any ack
        // is forwarded, and an unresolvable id is a definitive not-found.
        let inbox;
        try {
          inbox = validateNotificationInbox(await fencedHostLifetimeAction({
            method: 'notification.inspect', recipient_id: body.recipient_id, limit: 100,
          }, res, device, req.headers.authorization));
        } catch (error) {
          const failed = notificationRpcFailed(error);
          return failed;
        }
        const record = inbox.data.notifications.find(item => item.id === body.notification_id);
        if (!record) return json(res, 404, { ok: false, error: 'notification_not_found' });
        if (scoped && !device.scope.conversation_ids.includes(record.conversation_id)) {
          return json(res, 403, { error: 'scope_denied' });
        }
        let result;
        try {
          result = await fencedHostLifetimeAction({
            method: 'notification.ack', recipient_id: body.recipient_id,
            notification_id: body.notification_id, state: body.state,
          }, res, device, req.headers.authorization);
        } catch (error) {
          const failed = notificationRpcFailed(error);
          return failed;
        }
        if (!validAckResult(result, body.recipient_id, body.notification_id)) {
          return json(res, 502, { ok: false, error: 'host_acknowledgement_rejected' });
        }
        return json(res, 200, { ok: true, result });
      }

      if (media) {
        if (!sameDeviceAuthority(device, await authenticate(devices, req.headers.authorization))) return json(res, 401, { error: 'device_not_authorized' });
        if (media.kind === 'start_observe') {
          return observeMediaStart(res, device, req, media.startID);
        }
        if (media.kind === 'hangup') {
          if (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') {
            return json(res, 400, { error: 'hangup_body_invalid' });
          }
          try { await bounded(req, 0); } catch { return json(res, 400, { error: 'hangup_body_invalid' }); }
          try {
            const result = await mediaRequest(`/sessions/${encodeURIComponent(media.pcID)}/hangup`, 'POST', undefined, { res, abortOnClientClose: false, timeoutMs: 10000, deviceId: device.id });
            if (result.upstream.status === 200) await markMediaEnded(media.pcID).catch(() => {});
            return json(res, result.upstream.status === 200 ? 200 : 502, result.upstream.status === 200 ? result.data : { error: 'voice_media_unavailable_or_outcome_unknown' });
          } catch {
            return json(res, 502, { error: 'voice_media_unavailable_or_outcome_unknown' });
          }
        }
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(res, 415, { error: 'json_required' });
        let body;
        try { body = JSON.parse((await bounded(req, MAX_OFFER_BYTES * 4)).toString('utf8')); }
        catch (error) {
          if (error.message === 'size_limit') return json(res, 413, { error: 'payload_too_large' });
          return json(res, 400, { error: 'invalid_json' });
        }
        if (!isRecord(body)) return json(res, 400, { error: 'invalid_json' });
        if (media.kind === 'offer') {
          // One start identity per call attempt; retries and reconciliations
          // never create a second session.
          if (Object.keys(body).length !== 3 || body.type !== 'offer'
            || typeof body.sdp !== 'string' || !body.sdp || Buffer.byteLength(body.sdp, 'utf8') > MAX_OFFER_BYTES
            || typeof body.start_id !== 'string'
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.start_id)) {
            return json(res, 400, { error: 'offer_invalid' });
          }
        } else if (media.kind === 'ice') {
          const candidates = body.candidates;
          if (Object.keys(body).length !== 1 || !Array.isArray(candidates) || !candidates.length || candidates.length > 32
            || candidates.some(item => !isRecord(item) || Object.keys(item).length !== 3
              || typeof item.candidate !== 'string' || Buffer.byteLength(item.candidate, 'utf8') > 2048
              || typeof item.sdp_mid !== 'string' || item.sdp_mid.length > 128
              || !Number.isInteger(item.sdp_mline_index) || item.sdp_mline_index < 0 || item.sdp_mline_index > 16)) {
            return json(res, 400, { error: 'ice_candidates_invalid' });
          }
        } else if (Object.keys(body).length !== 1 || typeof body.turn_id !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.turn_id)) {
          return json(res, 400, { error: 'turn_target_invalid' });
        }
        try {
          if (media.kind === 'offer') {
            // Durable pre-effect start record: written before the offer is
            // forwarded, atomically with a final device authority check. A
            // second start while one is unresolved is refused without ever
            // claiming the older start is gone.
            const ensured = await ensureStartRecord(device, body.start_id).catch(() => null);
            if (!ensured || ensured.revoked) return json(res, 401, { error: 'device_not_authorized' });
            if (ensured.unresolved) return json(res, 409, { error: 'voice_start_unresolved' });
            if (ensured.full) return json(res, 409, { error: 'voice_start_limit' });
          }
          const target = media.kind === 'offer'
            ? '/offer'
            : `/sessions/${encodeURIComponent(media.pcID)}/${media.kind === 'ice' ? 'ice' : media.kind}`;
          const result = await mediaRequest(target, media.kind === 'ice' ? 'PATCH' : 'POST', Buffer.from(JSON.stringify(body)), { res, deviceId: device.id });
          if (result.upstream.status === 200) {
            if (media.kind === 'offer') {
              const answer = result.data;
              const endedReply = isRecord(answer) && answer.state === 'ended'
                && typeof answer.pc_id === 'string' && answer.pc_id.length > 0 && answer.pc_id.length <= 128;
              const answerReply = isRecord(answer) && answer.type === 'answer' && typeof answer.sdp === 'string' && answer.sdp
                && Buffer.byteLength(answer.sdp, 'utf8') <= MAX_OFFER_BYTES
                && typeof answer.pc_id === 'string' && answer.pc_id.length > 0 && answer.pc_id.length <= 128;
              if (!endedReply && !answerReply) return json(res, 502, { error: 'voice_answer_unavailable' });
              const current = await authenticate(devices, req.headers.authorization).catch(() => null);
              if (!sameDeviceAuthority(device, current)) {
                // Revoked mid-offer: never admit the answer; tear the created
                // session down instead of returning media to a dead authority.
                await mediaRequest(`/sessions/${encodeURIComponent(answer.pc_id)}/hangup`, 'POST', undefined, { abortOnClientClose: false, timeoutMs: 10000, deviceId: device.id }).catch(() => {});
                return json(res, 401, { error: 'device_not_authorized' });
              }
              if (answerReply) {
                const bound = await bindMediaAnswer(device, body.start_id, answer.pc_id).catch(() => null);
                if (!bound || bound.revoked) {
                  await mediaRequest(`/sessions/${encodeURIComponent(answer.pc_id)}/hangup`, 'POST', undefined, { abortOnClientClose: false, timeoutMs: 10000, deviceId: device.id }).catch(() => {});
                  return json(res, 401, { error: 'device_not_authorized' });
                }
                scheduleMediaFence();
              } else {
                await markMediaEnded(answer.pc_id).catch(() => {});
              }
              return json(res, 200, result.data);
            }
            const current = await authenticate(devices, req.headers.authorization).catch(() => null);
            if (!sameDeviceAuthority(device, current)) return json(res, 401, { error: 'device_not_authorized' });
            return json(res, 200, result.data);
          }
          const detail = isRecord(result.data) && typeof result.data.detail === 'string' ? result.data.detail : 'voice_media_unavailable';
          return json(res, result.upstream.status >= 400 && result.upstream.status < 500 ? result.upstream.status : 502, { error: detail });
        } catch {
          return json(res, 502, { error: 'voice_media_unavailable_or_outcome_unknown' });
        }
      }

      let bodyBuffer, requestBody;
      if (req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(res, 415, { error: 'json_required' });
        try { bodyBuffer = await bounded(req, MAX_BODY); }
        catch (error) {
          if (error.message === 'size_limit') return json(res, 413, { error: 'payload_too_large' });
          throw error;
        }
        try { requestBody = JSON.parse(bodyBuffer.toString('utf8')); }
        catch { return json(res, 400, { error: 'invalid_json' }); }
        if (!isRecord(requestBody) || !uuidPattern.test(requestBody.request_id) || !isRecord(requestBody.command) || typeof requestBody.command.type !== 'string') {
          return json(res, 400, { error: 'invalid_command' });
        }
        if (!scoped && requestBody.command.type === 'lifetime') return json(res, 403, { error: 'scope_required' });
      }

      const host = await discoverHost(root);
      if (!sameDeviceAuthority(device, await authenticate(devices, req.headers.authorization))) return json(res, 401, { error: 'device_not_authorized' });
      if (!scoped) {
        const result = await hostRequest(host, legacyTarget, req.method, bodyBuffer, device, req.headers.authorization, res);
        if (result.revoked) return json(res, 401, { error: 'device_not_authorized' });
        if (result.clientClosed) return;
        return json(res, result.upstream.status, result.data);
      }

      if (mobileLifetimeRoute === 'snapshot') {
        if (!device.scope.capabilities.includes('lifetime.read')) return json(res, 403, { error: 'capability_denied' });
        const result = await lifetimeSnapshot(host, device, req.headers.authorization, res);
        if (result.revoked) return json(res, 401, { error: 'device_not_authorized' });
        if (result.clientClosed) return;
        return json(res, 200, result.snapshot);
      }

      const command = requestBody.command;
      const original = command.envelope;
      if (command.type !== 'lifetime' || !isRecord(original)
        || typeof original.command_id !== 'string' || !original.command_id || original.command_id.length > 400
        || typeof original.correlation_id !== 'string' || !original.correlation_id
        || original.actor_ref !== lifetimeIdentity.actor_ref
        || original.authority_epoch !== lifetimeIdentity.authority_epoch
        || !(original.expected_revision === null || (Number.isSafeInteger(original.expected_revision) && original.expected_revision > 0))
        || !isRecord(original.body)
        || typeof original.body.method !== 'string'
        || typeof original.payload_digest !== 'string'
        || !/^[a-f0-9]{64}$/.test(original.payload_digest)) return json(res, 400, { error: 'invalid_lifetime_envelope' });
      let digest;
      try { digest = payloadDigest(original.body); }
      catch { return json(res, 400, { error: 'invalid_lifetime_envelope' }); }
      if (original.payload_digest !== digest) return json(res, 400, { error: 'invalid_lifetime_envelope' });

      const method = original.body.method;
      const capability = readLifetimeMethods.has(method) ? 'lifetime.read' : writeLifetimeMethods.has(method) ? 'lifetime.write' : null;
      if (!capability) return json(res, 403, { error: 'lifetime_method_denied' });
      if (!device.scope.capabilities.includes(capability)) return json(res, 403, { error: 'capability_denied' });
      const metadataOnlyMethod = ['registry.inspect', 'conversation.inspect', 'conversation.input', 'conversation.turn.inspect', 'conversation.cancel_turn'].includes(method);
      if (!metadataOnlyMethod && !device.scope.capabilities.includes('lifetime.read')) return json(res, 403, { error: 'target_scope_unverifiable' });
      if (method === 'registry.inspect' && Object.keys(original.body).length !== 1) return json(res, 400, { error: 'invalid_registry_lookup' });
      if (method === 'conversation.inspect'
        && (Object.keys(original.body).some(key => !['method', 'ghost_id', 'conversation_id', 'before_sequence', 'limit'].includes(key))
          || typeof original.body.ghost_id !== 'string' || !uuidPattern.test(original.body.ghost_id)
          || typeof original.body.conversation_id !== 'string' || !uuidPattern.test(original.body.conversation_id)
          || (original.body.before_sequence !== undefined && (!Number.isSafeInteger(original.body.before_sequence) || original.body.before_sequence < 1))
          || (original.body.limit !== undefined && (!Number.isSafeInteger(original.body.limit) || original.body.limit < 1 || original.body.limit > 100)))) {
        return json(res, 400, { error: 'invalid_conversation_lookup' });
      }
      if (method === 'conversation.input'
        && (Object.keys(original.body).length !== 6
          || Object.keys(original.body).some(key => !['method', 'ghost_id', 'conversation_id', 'text', 'privacy', 'attachments'].includes(key))
          || typeof original.body.ghost_id !== 'string' || !uuidPattern.test(original.body.ghost_id)
          || typeof original.body.conversation_id !== 'string' || !uuidPattern.test(original.body.conversation_id))) {
        return json(res, 400, { error: 'invalid_conversation_input' });
      }
      if ((method === 'conversation.turn.inspect' || method === 'conversation.cancel_turn')
        && (Object.keys(original.body).length !== 4
          || Object.keys(original.body).some(key => !['method', 'ghost_id', 'conversation_id', 'turn_id'].includes(key))
          || typeof original.body.ghost_id !== 'string' || !uuidPattern.test(original.body.ghost_id)
          || typeof original.body.conversation_id !== 'string' || !uuidPattern.test(original.body.conversation_id)
          || !boundedRunIdentifier(original.body.turn_id))) {
        return json(res, 400, { error: 'invalid_conversation_turn_request' });
      }
      if (method === 'command.inspect'
        && (Object.keys(original.body).length !== 2
          || typeof original.body.command_id !== 'string'
          || !original.body.command_id
          || original.body.command_id.length > 400)) return json(res, 400, { error: 'invalid_receipt_lookup' });

      let snapshotResult = null;
      if (metadataOnlyMethod) {
        const metadata = await lifetimeHostAuthority(host, device, req.headers.authorization, res);
        if (metadata.revoked) return json(res, 401, { error: 'device_not_authorized' });
        if (metadata.clientClosed) return;
        if ((method === 'conversation.input' || method === 'conversation.cancel_turn') && !metadata.authority.dispatch_enabled) return json(res, 409, { error: 'dispatch_disabled' });
        if (['conversation.inspect', 'conversation.input', 'conversation.turn.inspect', 'conversation.cancel_turn'].includes(method)) {
          const registry = await lifetimeTargetPairs(host, device, req.headers.authorization, res);
          if (registry.revoked) return json(res, 401, { error: 'device_not_authorized' });
          if (registry.clientClosed) return;
          if (!registry.target_pairs.some(target => target.ghost_id === original.body.ghost_id
            && target.conversation_id === original.body.conversation_id)) return json(res, 403, { error: 'scope_denied' });
        }
      } else {
        snapshotResult = await lifetimeSnapshot(host, device, req.headers.authorization, res);
        if (snapshotResult.revoked) return json(res, 401, { error: 'device_not_authorized' });
        if (snapshotResult.clientClosed) return;
        if (writeLifetimeMethods.has(method) && !snapshotResult.authority.dispatch_enabled) return json(res, 409, { error: 'dispatch_disabled' });

        if (method === 'goal.submit') {
          if (typeof original.body.ghost_id !== 'string' || typeof original.body.conversation_id !== 'string'
            || !snapshotResult.snapshot.bindings.some(binding => binding.ghost_id === original.body.ghost_id && binding.conversation_id === original.body.conversation_id)) {
            return json(res, 403, { error: 'scope_denied' });
          }
        } else if (method === 'goal.inspect' || method === 'goal.update') {
          if (!snapshotResult.snapshot.goals.some(goal => goal.id === original.body.goal_id)) return json(res, 404, { error: 'goal_not_found' });
        } else if (method === 'work.inspect' || method === 'work.steer' || method === 'work.cancel') {
          if (!snapshotResult.snapshot.work.some(work => work.id === original.body.work_id)) return json(res, 404, { error: 'work_not_found' });
        } else if (method === 'work.artifact') {
          // The device may only open results of work it is scoped to, for the
          // work's own current attempt, and only for a digest/locator pair the
          // scoped snapshot itself reported. The Host re-proves result
          // currency and verifies the bytes against the digest.
          if (Object.keys(original.body).length !== 5
            || typeof original.body.work_id !== 'string' || !original.body.work_id || original.body.work_id.length > 400
            || typeof original.body.execution_id !== 'string' || !original.body.execution_id || original.body.execution_id.length > 400
            || typeof original.body.digest !== 'string' || !/^[a-f0-9]{64}$/.test(original.body.digest)
            || typeof original.body.locator !== 'string' || !original.body.locator || original.body.locator.length > 1024
            || /[\u0000-\u001f]/.test(original.body.locator)) {
            return json(res, 400, { error: 'invalid_artifact_request' });
          }
          const work = snapshotResult.snapshot.work.find(item => item.id === original.body.work_id);
          if (!work) return json(res, 404, { error: 'work_not_found' });
          if (work.execution_id !== original.body.execution_id) return json(res, 403, { error: 'scope_denied' });
          if (!snapshotResult.snapshot.artifacts.some(artifact => artifact.digest === original.body.digest
            && artifact.locator === original.body.locator
            && artifact.producing_attempt === original.body.execution_id)) {
            return json(res, 404, { error: 'artifact_not_found' });
          }
        } else if (method === 'work.delegate') {
          // Delegation follows proven causal scope: the parent work must be in
          // this device's scoped snapshot, the target Ghost must be inside the
          // same scope, AND the target must hold an active registered pair in
          // the Host registry — scope lists alone never authorize delegation.
          if (Object.keys(original.body).length !== 6
            || typeof original.body.parent_work_id !== 'string' || !original.body.parent_work_id || original.body.parent_work_id.length > 400
            || typeof original.body.target_ghost_id !== 'string' || !uuidPattern.test(original.body.target_ghost_id ?? '')
            || typeof original.body.summary !== 'string'
            || !original.body.summary.trim() || Buffer.byteLength(original.body.summary, 'utf8') > 8192
            || !Array.isArray(original.body.artifact_refs) || original.body.artifact_refs.length > 32
            || !original.body.artifact_refs.every(ref => typeof ref === 'string' && ref && ref.length <= 400)
            || !isRecord(original.body.acceptance_spec)) {
            return json(res, 400, { error: 'invalid_delegation_request' });
          }
          const parent = snapshotResult.snapshot.work.find(item => item.id === original.body.parent_work_id);
          if (!parent) return json(res, 404, { error: 'work_not_found' });
          if (!device.scope.ghost_ids.includes(original.body.target_ghost_id)) return json(res, 403, { error: 'scope_denied' });
          const registry = await lifetimeTargetPairs(host, device, req.headers.authorization, res);
          if (registry.revoked) return json(res, 401, { error: 'device_not_authorized' });
          if (registry.clientClosed) return;
          if (!registry.target_pairs.some(target => target.ghost_id === original.body.target_ghost_id && target.mode === 'active')) {
            return json(res, 403, { error: 'scope_denied' });
          }
          // Referenced results must be artifacts of the parent work's own
          // current execution as reported in this scoped snapshot.
          const parentArtifacts = new Set(snapshotResult.snapshot.artifacts
            .filter(artifact => artifact.producing_attempt === parent.execution_id)
            .map(artifact => artifact.digest));
          if (!original.body.artifact_refs.every(ref => parent.execution_id && parentArtifacts.has(ref))) {
            return json(res, 403, { error: 'artifact_ref_outside_parent_work' });
          }
        }
      }

      const commandId = namespacedCommandId(device.id, original.command_id);
      const body = method === 'command.inspect'
        ? { ...original.body, command_id: namespacedCommandId(device.id, original.body.command_id) }
        : original.body;
      const envelope = { ...original, command_id: commandId, body, payload_digest: payloadDigest(body) };
      const forwarded = { ...requestBody, command: { ...command, envelope } };
      const result = await hostRequest(host, '/api/v1/action', 'POST', Buffer.from(JSON.stringify(forwarded)), device, req.headers.authorization, res);
      if (result.revoked) return json(res, 401, { error: 'device_not_authorized' });
      if (result.clientClosed) return;
      if (method === 'registry.inspect') {
        if (result.upstream.status < 200 || result.upstream.status >= 300 || result.data?.ok !== true || !isRecord(result.data.result)) {
          return json(res, 502, { ok: false, error: 'host_unavailable_or_outcome_unknown' });
        }
        return json(res, result.upstream.status, { ...result.data, result: scopedRegistryResponse(result.data.result, device.scope) });
      }
      if (method === 'conversation.inspect') {
        if (result.upstream.status < 200 || result.upstream.status >= 300 || result.data?.ok !== true || !isRecord(result.data.result)) {
          return json(res, result.upstream.status, result.data);
        }
        return json(res, result.upstream.status, {
          ...result.data,
          result: scopedConversationInspectResponse(result.data.result, original.body),
        });
      }
      if (method === 'conversation.turn.inspect' || method === 'conversation.cancel_turn') {
        if (result.upstream.status < 200 || result.upstream.status >= 300 || result.data?.ok !== true || !isRecord(result.data.result)) {
          return json(res, 502, { ok: false, error: 'host_unavailable_or_outcome_unknown' });
        }
        return json(res, result.upstream.status, {
          ok: true,
          result: scopedConversationTurnResponse(result.data.result, original.body),
        });
      }
      if (method === 'conversation.input') {
        if (result.upstream.status < 200 || result.upstream.status >= 300 || result.data?.ok !== true || !isRecord(result.data.result)) {
          return json(res, result.upstream.status, result.data);
        }
        return json(res, result.upstream.status, {
          ...result.data,
          result: scopedConversationInputResponse(result.data.result, commandId),
        });
      }
      if (method !== 'command.inspect') return json(res, result.upstream.status, result.data);
      if (result.upstream.status < 200 || result.upstream.status >= 300) {
        return json(res, 502, { ok: false, error: 'host_unavailable_or_outcome_unknown' });
      }

      const hostResponse = result.data?.ok === true && isRecord(result.data.result) ? result.data.result : null;
      const receipt = hostResponse?.data;
      const receiptScopeDenied = {
        status: 'warning',
        summary: 'Receipt exists but its result is outside this device’s readable scope; the original intent remains unresolved.',
        object_refs: [],
        artifacts: [],
        next_actions: ['reconcile_original_owner_and_effect_before_new_intent'],
        error_code: 'receipt_scope_denied',
        retry_class: 'reconcile_first',
        data: { command_id: original.body.command_id, found: false },
      };
      if (!hostResponse || !isRecord(receipt) || receipt.command_id !== namespacedCommandId(device.id, original.body.command_id)) {
        return json(res, 200, { ok: true, result: receiptScopeDenied });
      }
      if (hostResponse.status === 'warning' && hostResponse.error_code === 'not_found'
        && hostResponse.retry_class === 'reconcile_first' && receipt.found === false) {
        return json(res, 200, { ok: true, result: {
          status: 'warning',
          summary: 'No receipt exists in this device namespace.',
          object_refs: [],
          artifacts: [],
          next_actions: [],
          error_code: 'not_found',
          retry_class: 'reconcile_first',
          data: { command_id: original.body.command_id, found: false },
        } });
      }
      const expectedCommandId = namespacedCommandId(device.id, original.body.command_id);
      if (hostResponse.status !== 'success' || receipt.found !== true
        || !Number.isSafeInteger(receipt.authority_epoch) || receipt.authority_epoch < 1
        || !receiptResponseInScope(receipt.response, snapshotResult.snapshot, device.scope, expectedCommandId)) {
        return json(res, 200, { ok: true, result: receiptScopeDenied });
      }
      const originalResponse = receipt.response;
      const responseHasConversationData = isRecord(originalResponse?.data)
        && (Object.prototype.hasOwnProperty.call(originalResponse.data, 'turn_id')
          || Object.prototype.hasOwnProperty.call(originalResponse.data, 'host_effect_class')
          || Object.prototype.hasOwnProperty.call(originalResponse.data, 'run'));
      return json(res, result.upstream.status, {
        ok: true,
        result: {
          ...hostResponse,
          data: {
            ...receipt,
            command_id: original.body.command_id,
            ...(responseHasConversationData
              ? { response: Object.prototype.hasOwnProperty.call(originalResponse.data, 'run')
                ? scopedConversationTurnResponse(originalResponse, {
                  method: 'conversation.cancel_turn',
                  ghost_id: originalResponse.data.run.ghost_id,
                  conversation_id: originalResponse.data.run.conversation_id,
                  turn_id: originalResponse.data.run.turn_id,
                })
                : scopedConversationInputResponse(originalResponse, expectedCommandId) }
              : {}),
          },
        },
      });
    } catch (error) {
      if (error.message === 'size_limit') return json(res, 413, { error: 'payload_too_large' });
      json(res, 502, { ok: false, error: 'host_unavailable_or_outcome_unknown' });
    } finally { active--; }
  });
  server.notificationOutbox = notificationOutbox;
  server.stopMediaFence = () => {
    if (mediaFenceTimer) { clearTimeout(mediaFenceTimer); mediaFenceTimer = null; }
  };
  // Restart recovery: recorded media bindings are reaped again immediately.
  scheduleMediaFence();
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { GHOST_ROOT: root, GHOST_GATEWAY_DEVICES: devices, GHOST_GATEWAY_ORIGIN: origin } = process.env;
    if (!root || !devices || !origin) throw new Error('Set GHOST_ROOT, GHOST_GATEWAY_DEVICES, and GHOST_GATEWAY_ORIGIN.');
    const epochText = process.env.GHOST_LIFETIME_AUTHORITY_EPOCH;
    const lifetimeAuthorityEpoch = epochText === undefined ? undefined : Number(epochText);
    if (epochText !== undefined && (!/^[1-9]\d*$/.test(epochText) || !Number.isSafeInteger(lifetimeAuthorityEpoch))) throw new Error('GHOST_LIFETIME_AUTHORITY_EPOCH must be a positive safe integer.');
    const voiceMediaOrigin = process.env.GHOST_VOICE_MEDIA_ORIGIN;
    const voiceMedia = voiceMediaOrigin === undefined ? null : (() => {
      const controlToken = process.env.GHOST_VOICE_CONTROL_TOKEN;
      const ghostID = process.env.GHOST_VOICE_GHOST_ID, conversationID = process.env.GHOST_VOICE_CONVERSATION_ID;
      if (!controlToken || controlToken.length < 32 || controlToken.length > 128) throw new Error('GHOST_VOICE_CONTROL_TOKEN must be the streaming media control token (32–128 characters).');
      if (!uuidPattern.test(ghostID ?? '') || !uuidPattern.test(conversationID ?? '')) throw new Error('GHOST_VOICE_GHOST_ID and GHOST_VOICE_CONVERSATION_ID must be the streaming media conversation binding.');
      return { origin: parseMediaOrigin(voiceMediaOrigin), controlToken, ghostID, conversationID };
    })();
    const apnsConfig = readApnsConfig();
    const providerKey = apnsConfig.enabled ? readFileSync(apnsConfig.keyPath, 'utf8') : null;
    if (apnsConfig.enabled === false) {
      console.error(`[ghost-gateway] APNs delivery disabled: missing ${apnsConfig.missing.join(', ')}. Inbox reads and acknowledgements stay available.`);
    }
    const port = Number(process.env.GHOST_GATEWAY_PORT ?? 8788);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port.');
    const server = createGateway({ root, devices, origin, lifetimeAuthorityEpoch, voiceMedia, apns: apnsConfig, providerKey });
    server.listen(port, '127.0.0.1');
    server.notificationOutbox.start?.();
    // Real Bonjour advertisement for nearby automatic discovery: the TXT
    // record carries only the public HTTPS origin, never a ticket, code, or
    // key. A missing or failing advertiser is reported, never faked.
    let pairingAdvertiser = null;
    try {
      const advertisedOrigin = parseOrigin(origin).origin;
      pairingAdvertiser = await startPairingAdvertiser({ origin: advertisedOrigin, port });
      console.error(`[ghost-gateway] pairing advertiser active: _ghost-pair._tcp origin=${advertisedOrigin}`);
    } catch (error) {
      console.error(`[ghost-gateway] pairing advertiser unavailable: ${error.message}`);
    }
    const shutdown = () => {
      pairingAdvertiser?.stop();
      server.stopMediaFence?.(); server.notificationOutbox.stop?.(); server.close(); setTimeout(() => server.closeAllConnections(), 65000).unref();
    };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
