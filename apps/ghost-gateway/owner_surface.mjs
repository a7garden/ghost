// Scoped owner decision surface for lifetime devices.
//
// The Rust Host owns the durable owner-question ledger (exact normalized
// browser-action facts) and the per-Ghost home/browser lifecycle. This module
// is the HTTPS edge that lets one exact registered lifetime device read the
// pending questions for, decide, or drive lifecycle for the Ghosts in its own
// scope — never owner-wide. Every route first proves the Ghost's CURRENT
// registered conversation pair is inside the device's exact scope (Host
// registry truth via registry.inspect, scope-filtered — never a Cartesian
// reading of the two scope lists), and a decision additionally proves the
// paused execution is the current attempt of a current, uncancelled Work in
// the scoped snapshot and that every displayed fact still matches the durable
// action. The decision itself rides the Host control plane's authenticated
// computer verb, so the worker CASes the action with the authenticated
// approver and drives the deterministic browser.resume; only the real wake
// response comes back.
import { randomUUID } from 'node:crypto';

const ACTION_ID_PATTERN = /^ba-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const LIFECYCLE_OPERATIONS = new Set(['idle_stop', 'recreate', 'stop']);
const MAX_SCOPE_GHOSTS = 64;
const MAX_ACTIONS_PER_GHOST = 64;
const MAX_TEXT = 400;

export function ownerSurfaceRoute(method, url) {
  if (method === 'GET' && url === '/mobile/v1/lifetime/questions') return 'questions';
  if (method === 'POST' && url === '/mobile/v1/lifetime/questions/decision') return 'decision';
  if (method === 'POST' && url === '/mobile/v1/lifetime/computer/lifecycle') return 'lifecycle';
  return null;
}

function boundedText(value, maximum = MAX_TEXT) {
  return typeof value === 'string' && value.length <= maximum;
}

function uuidOf(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// One pending question exactly as the durable registry proposed it: the
// normalized action target (operation, URL, snapshot, target ref/role/name,
// value, profile scope) plus the identities a decision binds. A question from
// another authority generation or a malformed record is dropped, never
// normalized into a look-alike.
function normalizeBrowserAction(ghostID, value, authorityEpoch) {
  if (!isActionShape(value) || value.detail.authority_epoch !== authorityEpoch
    || value.requested_epoch !== authorityEpoch) return null;
  const detail = value.detail;
  return {
    ghost_id: ghostID,
    action_id: value.action_id,
    computer_id: value.computer_id,
    execution_id: value.execution_id,
    arguments_digest: value.arguments_digest,
    requested_epoch: value.requested_epoch,
    state: value.state,
    approved_by: value.approved_by,
    operation: detail.operation,
    url: detail.url,
    snapshot_id: detail.snapshot_id,
    target: detail.target,
    value: detail.value,
    profile_scope: detail.profile_scope,
    authority_epoch: detail.authority_epoch,
  };
}

function isActionShape(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof value.action_id === 'string' && ACTION_ID_PATTERN.test(value.action_id)
    && boundedText(value.computer_id, 200) && value.computer_id.length > 0
    && boundedText(value.execution_id) && value.execution_id.length > 0
    && typeof value.arguments_digest === 'string' && DIGEST_PATTERN.test(value.arguments_digest)
    && Number.isSafeInteger(value.requested_epoch) && value.requested_epoch > 0
    && value.state === 'pending'
    && value.approved_by === null
    && typeof value.detail === 'object' && value.detail !== null && !Array.isArray(value.detail)
    && boundedText(value.detail.operation, 32) && value.detail.operation.length > 0
    && boundedText(value.detail.url, 2048)
    && Number.isSafeInteger(value.detail.snapshot_id) && value.detail.snapshot_id >= 0
    && boundedText(value.detail.profile_scope, 32)
    && Number.isSafeInteger(value.detail.authority_epoch) && value.detail.authority_epoch > 0;
}

export function createOwnerSurface({
  json, bounded, isRecord, root, discoverHost, hostRequest,
  lifetimeHostAuthority, lifetimeSnapshot, lifetimeTargetPairs, lifetimeIdentity,
}) {
  // A gateway without a lifetime transport (voice-only deployments) still
  // starts; every owner-surface route then answers 503.
  const identityReady = lifetimeIdentity !== null && typeof lifetimeIdentity === 'object'
    && lifetimeIdentity.actor_ref === 'owner'
    && Number.isSafeInteger(lifetimeIdentity.authority_epoch) && lifetimeIdentity.authority_epoch > 0;

  const hostUnavailable = res => json(res, 502, { ok: false, error: 'host_unavailable_or_outcome_unknown' });

  async function readBody(req, res) {
    let body;
    try { body = JSON.parse((await bounded(req, 65536)).toString('utf8')); }
    catch (error) {
      if (error.message === 'size_limit') return { rejected: json(res, 413, { error: 'payload_too_large' }) };
      return { rejected: json(res, 400, { error: 'invalid_json' }) };
    }
    if (!isRecord(body)) return { rejected: json(res, 400, { error: 'invalid_json' }) };
    return { body };
  }

  async function computerAction(profileID, verb, actionID, device, authorization, res) {
    const host = await discoverHost(root);
    const action = { type: 'computer', profile_id: profileID, verb };
    if (actionID !== undefined) action.action_id = actionID;
    const command = { request_id: randomUUID(), command: { type: 'workspace', action } };
    return hostRequest(host, '/api/v1/action', 'POST', Buffer.from(JSON.stringify(command)), device, authorization, res);
  }

  // Trusted Host truth: the registered pair for one Ghost is granted only
  // when its ACTIVE registered conversation is inside this device's exact
  // scope. Scope lists alone never grant anything.
  async function grantedPairGhost(host, ghostID, device, authorization, res) {
    const registry = await lifetimeTargetPairs(host, device, authorization, res);
    if (registry.revoked || registry.clientClosed) return { blocked: registry };
    return {
      granted: registry.target_pairs.some(target =>
        target.ghost_id === ghostID && target.mode === 'active'),
    };
  }

  function currentScopedExecutions(snapshot) {
    const revisions = new Map(snapshot.goals.map(goal => [goal.id, goal.revision]));
    const executions = new Map();
    for (const work of snapshot.work) {
      if (typeof work.execution_id === 'string' && revisions.has(work.goal_id) &&
          revisions.get(work.goal_id) === work.goal_revision) {
        executions.set(work.execution_id, work);
      }
    }
    return executions;
  }

  // Questions for exactly the granted Ghosts in this device's scope. The
  // Host ledger stays the source of truth; anything the Host expired
  // (superseded, fenced, stale epoch) never reaches the surface.
  async function questions(req, res, device, authorization) {
    if (!device.scope.capabilities.includes('lifetime.read')) return json(res, 403, { error: 'capability_denied' });
    const ghostIDs = [...new Set(device.scope.ghost_ids)].sort();
    if (ghostIDs.length === 0 || ghostIDs.length > MAX_SCOPE_GHOSTS) return json(res, 403, { error: 'scope_denied' });
    const host = await discoverHost(root);
    const metadata = await lifetimeHostAuthority(host, device, authorization, res);
    if (metadata.revoked) return json(res, 401, { error: 'device_not_authorized' });
    if (metadata.clientClosed) return;
    const snapshotResult = await lifetimeSnapshot(host, device, authorization, res);
    if (snapshotResult.revoked) return json(res, 401, { error: 'device_not_authorized' });
    if (snapshotResult.clientClosed) return;
    const executions = currentScopedExecutions(snapshotResult.snapshot);
    const questions = [];
    for (const ghostID of ghostIDs) {
      const pair = await grantedPairGhost(host, ghostID, device, authorization, res);
      if (pair.blocked) {
        if (pair.blocked.revoked) return json(res, 401, { error: 'device_not_authorized' });
        if (pair.blocked.clientClosed) return;
      }
      if (!pair.granted) continue;
      let result;
      try {
        result = await computerAction(ghostID, 'pending_browser_actions', undefined, device, authorization, res);
      } catch {
        return hostUnavailable(res);
      }
      if (result.revoked) return json(res, 401, { error: 'device_not_authorized' });
      if (result.clientClosed) return;
      if (result.upstream.status < 200 || result.upstream.status >= 300
        || result.data?.ok !== true || !Array.isArray(result.data.result)) return hostUnavailable(res);
      if (result.data.result.length > MAX_ACTIONS_PER_GHOST) return hostUnavailable(res);
      for (const action of result.data.result) {
        const normalized = normalizeBrowserAction(ghostID, action, lifetimeIdentity.authority_epoch);
        const executionID = normalized?.execution_id.replace(/^worker:/, '');
        if (normalized && executions.get(executionID)?.owner === ghostID) questions.push(normalized);
      }
    }
    return json(res, 200, { ok: true, authority: metadata.authority, questions });
  }

  async function decision(req, res, device, authorization) {
    if (!device.scope.capabilities.includes('lifetime.write')) return json(res, 403, { error: 'capability_denied' });
    const read = await readBody(req, res);
    if (read.rejected) return read.rejected;
    const body = read.body;
    // The decision echoes the exact facts the owner saw: execution, arguments
    // digest, page snapshot, authority generation, and URL. A mismatch means
    // the surface changed under the owner and nothing is recorded.
    if (Object.keys(body).length !== 8
      || !uuidOf(body.ghost_id)
      || typeof body.action_id !== 'string' || !ACTION_ID_PATTERN.test(body.action_id)
      || (body.decision !== 'approve' && body.decision !== 'deny')
      || !boundedText(body.execution_id) || body.execution_id.length > 400
      || typeof body.arguments_digest !== 'string' || !DIGEST_PATTERN.test(body.arguments_digest)
      || !Number.isSafeInteger(body.snapshot_id) || body.snapshot_id < 0
      || !Number.isSafeInteger(body.requested_epoch) || body.requested_epoch <= 0
      || !boundedText(body.url, 2048)) {
      return json(res, 400, { error: 'invalid_decision' });
    }
    if (!device.scope.ghost_ids.includes(body.ghost_id)) return json(res, 403, { error: 'scope_denied' });
    const host = await discoverHost(root);
    const metadata = await lifetimeHostAuthority(host, device, authorization, res);
    if (metadata.revoked) return json(res, 401, { error: 'device_not_authorized' });
    if (metadata.clientClosed) return;
    if (body.decision === 'approve' && !metadata.authority.dispatch_enabled) {
      return json(res, 409, { error: 'dispatch_disabled' });
    }
    // Exact registered pair: the decision names a Ghost whose ACTIVE
    // registered conversation this device actually holds.
    const pair = await grantedPairGhost(host, body.ghost_id, device, authorization, res);
    if (pair.blocked) {
      if (pair.blocked.revoked) return json(res, 401, { error: 'device_not_authorized' });
      if (pair.blocked.clientClosed) return;
      return hostUnavailable(res);
    }
    if (!pair.granted) return json(res, 403, { error: 'scope_denied' });
    // The action must still be exactly what was displayed.
    let listing;
    try {
      listing = await computerAction(body.ghost_id, 'pending_browser_actions', undefined, device, authorization, res);
    } catch {
      return hostUnavailable(res);
    }
    if (listing.revoked) return json(res, 401, { error: 'device_not_authorized' });
    if (listing.clientClosed) return;
    if (listing.upstream.status < 200 || listing.upstream.status >= 300
      || listing.data?.ok !== true || !Array.isArray(listing.data.result)) return hostUnavailable(res);
    const action = listing.data.result.find(item => isActionShape(item) && item.action_id === body.action_id);
    if (!action) return json(res, 404, { error: 'question_no_longer_pending' });
    const rawExecution = action.execution_id.startsWith('worker:')
      ? action.execution_id.slice('worker:'.length) : action.execution_id;
    const factsMatch = action.execution_id === body.execution_id
      && action.arguments_digest === body.arguments_digest
      && action.requested_epoch === body.requested_epoch
      && action.detail.snapshot_id === body.snapshot_id
      && action.detail.url === body.url
      && rawExecution === (body.execution_id.startsWith('worker:')
        ? body.execution_id.slice('worker:'.length) : body.execution_id);
    if (!factsMatch) return json(res, 409, { error: 'stale_displayed_facts' });
    // Causal scope: the paused execution must be the current attempt of a
    // current, uncancelled Work inside this scoped snapshot. Approving a
    // cancelled Work would resume nothing and say nothing — refuse approve,
    // while a recorded denial of a cancelled Work stays truthful.
    const snapshotResult = await lifetimeSnapshot(host, device, authorization, res);
    if (snapshotResult.revoked) return json(res, 401, { error: 'device_not_authorized' });
    if (snapshotResult.clientClosed) return;
    const work = currentScopedExecutions(snapshotResult.snapshot).get(rawExecution);
    if (!work || work.owner !== body.ghost_id) return json(res, 409, { error: 'work_not_current' });
    if (body.decision === 'approve' && work.cancellation !== 'none') {
      return json(res, 409, { error: 'work_cancelled' });
    }
    let result;
    try {
      result = await computerAction(
        body.ghost_id,
        body.decision === 'approve' ? 'approve_browser_action' : 'deny_browser_action',
        body.action_id,
        device, authorization, res);
    } catch {
      return hostUnavailable(res);
    }
    if (result.revoked) return json(res, 401, { error: 'device_not_authorized' });
    if (result.clientClosed) return;
    if (result.upstream.status < 200 || result.upstream.status >= 300
      || result.data?.ok !== true || !isRecord(result.data.result)
      || !isRecord(result.data.result.action) || !isRecord(result.data.result.wake)) {
      return hostUnavailable(res);
    }
    // The Host's answer carries the worker's REAL browser.resume response
    // (resumed/executed, fresh_consent_required, or its real error) plus the
    // action's durable identities; pass it through unchanged.
    return json(res, 200, {
      ok: true,
      action: result.data.result.action,
      wake: result.data.result.wake,
    });
  }

  async function lifecycle(req, res, device, authorization) {
    if (!device.scope.capabilities.includes('lifetime.write')) return json(res, 403, { error: 'capability_denied' });
    const read = await readBody(req, res);
    if (read.rejected) return read.rejected;
    const body = read.body;
    if (Object.keys(body).length !== 2
      || !uuidOf(body.ghost_id)
      || !LIFECYCLE_OPERATIONS.has(body.operation)) {
      return json(res, 400, { error: 'invalid_lifecycle_request' });
    }
    if (!device.scope.ghost_ids.includes(body.ghost_id)) return json(res, 403, { error: 'scope_denied' });
    const host = await discoverHost(root);
    const metadata = await lifetimeHostAuthority(host, device, authorization, res);
    if (metadata.revoked) return json(res, 401, { error: 'device_not_authorized' });
    if (metadata.clientClosed) return;
    if (!metadata.authority.dispatch_enabled) return json(res, 409, { error: 'dispatch_disabled' });
    const pair = await grantedPairGhost(host, body.ghost_id, device, authorization, res);
    if (pair.blocked) {
      if (pair.blocked.revoked) return json(res, 401, { error: 'device_not_authorized' });
      if (pair.blocked.clientClosed) return;
      return hostUnavailable(res);
    }
    if (!pair.granted) return json(res, 403, { error: 'scope_denied' });
    let result;
    try {
      result = await computerAction(body.ghost_id, body.operation, undefined, device, authorization, res);
    } catch {
      return hostUnavailable(res);
    }
    if (result.revoked) return json(res, 401, { error: 'device_not_authorized' });
    if (result.clientClosed) return;
    if (result.upstream.status < 200 || result.upstream.status >= 300
      || result.data?.ok !== true || !isRecord(result.data.result)) return hostUnavailable(res);
    // Unknown-outcome and fenced lifecycle attempts pass through with their
    // real status and summary; the device never sees a flattened success.
    return json(res, 200, { ok: true, result: result.data.result });
  }

  return {
    async handle(routeKind, req, res, device, authorization) {
      if (!identityReady) return json(res, 503, { error: 'lifetime_transport_unconfigured' });
      if (routeKind === 'questions') return questions(req, res, device, authorization);
      if (routeKind === 'decision') return decision(req, res, device, authorization);
      if (routeKind === 'lifecycle') return lifecycle(req, res, device, authorization);
      return json(res, 404, { error: 'not_found' });
    },
  };
}

