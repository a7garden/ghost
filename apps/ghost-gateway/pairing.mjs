// Phone pairing: invitation / claim / owner-approval state machine.
//
// Secrets (the 8-char code, the 64-hex QR ticket, the phone's fresh key) are
// generated on the owner browser and the phone. This module sees only SHA-256
// digests of the code and ticket, and the digest of the phone key; raw secrets
// are never persisted or returned. Everything durable lives in the existing
// device registry under an additive `pairing` key, written through the same
// private atomic updateDevices transaction as device grants.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { validPairTargets, validScope } from './devices.mjs';

export const PAIRING_PROTOCOL = 'ghost-pairing';
export const PAIRING_BOOTSTRAP_CONTEXT = 'ghost-pairing-bootstrap-v1';
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const INVITATION_TTL_MS = 5 * 60 * 1000;
const CLAIM_TTL_MS = 5 * 60 * 1000;
const MAX_ACTIVE_INVITATIONS = 8;
const MAX_RECEIPTS = 64;
const MAX_RETIRED_INVITATIONS = 16;
const MAX_INVITATION_CLAIM_ATTEMPTS = 12;
const CLAIM_RATE_CAPACITY = 60;
const CLAIM_RATE_WINDOW_MS = 60 * 1000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex64 = /^[0-9a-f]{64}$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const sha256hex = value => createHash('sha256').update(value, 'utf8').digest('hex');

export function normalizePairingCode(text) {
  if (typeof text !== 'string') return null;
  const compact = text.toUpperCase().replace(/[\s-]/g, '');
  return compact.length === 8 && [...compact].every(ch => PAIRING_CODE_ALPHABET.includes(ch)) ? compact : null;
}

export const codeDigest = code => sha256hex(code);
export const ticketDigest = ticket => typeof ticket === 'string' && hex64.test(ticket) ? sha256hex(ticket) : null;

// Exact byte chain the PC bridge independently verifies:
// HMAC-SHA256(rootToken, 'ghost-pairing-bootstrap-v1' 0x00 nonce 0x00 origin)
export function bootstrapProof(rootToken, nonce, publicOrigin) {
  return createHmac('sha256', rootToken)
    .update(`${PAIRING_BOOTSTRAP_CONTEXT}\0`, 'utf8')
    .update(nonce, 'utf8')
    .update('\0', 'utf8')
    .update(publicOrigin, 'utf8')
    .digest('hex');
}

export function generatePairingSecrets() {
  const bytes = randomBytes(8);
  let code = '';
  for (let index = 0; index < 8; index++) code += PAIRING_CODE_ALPHABET[bytes[index] % 32];
  return { code, ticket: randomBytes(32).toString('hex') };
}

// 6-digit verification code bound to the exact invitation, claim, and phone
// key digest; derived, so it never needs a secret of its own at rest.
export function verificationCode(invitationId, claimId, tokenDigest) {
  const digest = createHash('sha256')
    .update(`${invitationId}:${claimId}:${tokenDigest}`, 'utf8').digest('hex');
  return (BigInt(`0x${digest}`) % 1000000n).toString().padStart(6, '0');
}

export function pairingRoute(method, path) {
  const bootstrap = /^\/pairing\/admin\/bootstrap\/([a-f0-9]{32})$/.exec(path);
  if (bootstrap && method === 'GET') return { kind: 'bootstrap', nonce: bootstrap[1] };
  if (method === 'GET' && path === '/pairing/targets') return { kind: 'targets' };
  if (method === 'POST' && path === '/pairing/invitations') return { kind: 'invitation_create' };
  if (method === 'GET' && path === '/pairing/invitations') return { kind: 'invitation_list' };
  const id = /^\/pairing\/invitations\/([0-9a-f-]{36})$/.exec(path);
  if (id && method === 'GET') return uuidPattern.test(id[1]) ? { kind: 'invitation_get', id: id[1].toLowerCase() } : null;
  const approve = /^\/pairing\/invitations\/([0-9a-f-]{36})\/approve$/.exec(path);
  if (approve && method === 'POST') return uuidPattern.test(approve[1]) ? { kind: 'invitation_approve', id: approve[1].toLowerCase() } : null;
  const cancel = /^\/pairing\/invitations\/([0-9a-f-]{36})\/cancel$/.exec(path);
  if (cancel && method === 'POST') return uuidPattern.test(cancel[1]) ? { kind: 'invitation_cancel', id: cancel[1].toLowerCase() } : null;
  if (method === 'POST' && path === '/pairing/claims') return { kind: 'claim_create' };
  const status = /^\/pairing\/claims\/([0-9a-f-]{36})\/status$/.exec(path);
  if (status && method === 'POST') return uuidPattern.test(status[1]) ? { kind: 'claim_status', id: status[1].toLowerCase() } : null;
  return null;
}

export function httpError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

const terminal = status => status === 'approved' || status === 'cancelled' || status === 'expired' || status === 'revoked';

function validInvitation(invitation) {
  return isRecord(invitation)
    && typeof invitation.invitation_id === 'string' && uuidPattern.test(invitation.invitation_id)
    && typeof invitation.code_digest === 'string' && hex64.test(invitation.code_digest)
    && typeof invitation.ticket_digest === 'string' && hex64.test(invitation.ticket_digest)
    && typeof invitation.origin === 'string' && invitation.origin.startsWith('https://')
    && typeof invitation.created_at === 'string' && !Number.isNaN(Date.parse(invitation.created_at))
    && typeof invitation.expires_at === 'string' && !Number.isNaN(Date.parse(invitation.expires_at))
    && validScope(invitation.scope)
    && (!Object.hasOwn(invitation, 'requested_targets') || (invitation.scope.targets === undefined
      && validPairTargets(invitation.requested_targets) && invitation.requested_targets.length === 1
      && invitation.scope.ghost_ids.length === 1 && invitation.scope.conversation_ids.length === 1
      && invitation.requested_targets[0].ghost_id === invitation.scope.ghost_ids[0]
      && invitation.requested_targets[0].conversation_id === invitation.scope.conversation_ids[0]))
    && Number.isSafeInteger(invitation.epoch) && invitation.epoch > 0
    && ['open', 'pending', 'approved', 'cancelled', 'expired', 'revoked'].includes(invitation.status)
    && Number.isSafeInteger(invitation.attempts) && invitation.attempts >= 0
    && (invitation.claim === null || validClaim(invitation.claim))
    && (invitation.device_id === undefined || (typeof invitation.device_id === 'string' && uuidPattern.test(invitation.device_id)));
}

function validClaim(claim) {
  return isRecord(claim)
    && typeof claim.claim_id === 'string' && uuidPattern.test(claim.claim_id)
    && typeof claim.device_name === 'string' && claim.device_name.length >= 1 && claim.device_name.length <= 100
    && typeof claim.device_token_digest === 'string' && hex64.test(claim.device_token_digest)
    && typeof claim.verification_code === 'string' && /^[0-9]{6}$/.test(claim.verification_code)
    && typeof claim.created_at === 'string' && !Number.isNaN(Date.parse(claim.created_at))
    && typeof claim.expires_at === 'string' && !Number.isNaN(Date.parse(claim.expires_at));
}

export function createPairingService({
  devices, origin: publicOrigin, epoch, hostRegistry, hostNames,
  now = () => new Date(),
}) {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Pairing requires a current lifetime authority epoch.');
  if (typeof publicOrigin !== 'string' || !publicOrigin.startsWith('https://')) throw new Error('Pairing requires the configured public HTTPS origin.');
  const claimRate = { tokens: CLAIM_RATE_CAPACITY, updated: 0 };

  function takeClaimRateToken() {
    const instant = now().getTime();
    claimRate.tokens = Math.min(CLAIM_RATE_CAPACITY,
      claimRate.tokens + Math.max(0, instant - claimRate.updated) * CLAIM_RATE_CAPACITY / CLAIM_RATE_WINDOW_MS);
    claimRate.updated = instant;
    if (claimRate.tokens < 1) return false;
    claimRate.tokens -= 1;
    return true;
  }

  function pairingState(registry) {
    if (registry.pairing === undefined) return { invitations: [], receipts: {} };
    const state = registry.pairing;
    if (!isRecord(state) || !Array.isArray(state.invitations)
      || !state.invitations.every(validInvitation) || !isRecord(state.receipts)) {
      throw new Error('Invalid pairing registry state.');
    }
    return state;
  }

  function pruneReceipts(state) {
    const entries = Object.entries(state.receipts);
    if (entries.length > MAX_RECEIPTS) {
      state.receipts = Object.fromEntries(entries.slice(entries.length - MAX_RECEIPTS));
    }
  }

  function expireIfDue(invitation, instant) {
    if ((invitation.status === 'open' || invitation.status === 'pending')
      && instant >= Date.parse(invitation.expires_at)) invitation.status = 'expired';
    if (invitation.status === 'pending' && invitation.claim
      && instant >= Date.parse(invitation.claim.expires_at)) invitation.status = 'expired';
    return invitation.status;
  }

  async function activeTargets() {
    const rows = await hostRegistry();
    if (!Array.isArray(rows)) throw httpError(503, 'pairing_scope_unavailable');
    const ghosts = new Set(), conversations = new Set();
    const targets = [];
    for (const row of rows) {
      if (!isRecord(row) || typeof row.ghost_id !== 'string' || !uuidPattern.test(row.ghost_id)
        || typeof row.conversation_id !== 'string' || !uuidPattern.test(row.conversation_id)
        || !['primary', 'specialist'].includes(row.kind) || !['active', 'draining'].includes(row.mode)
        || !Array.isArray(row.roles) || !row.roles.every(role => typeof role === 'string' && role.trim())
        || ghosts.has(row.ghost_id) || conversations.has(row.conversation_id)) {
        throw httpError(503, 'pairing_scope_unavailable');
      }
      ghosts.add(row.ghost_id);
      conversations.add(row.conversation_id);
      if (row.mode === 'active') targets.push({ ghost_id: row.ghost_id, conversation_id: row.conversation_id, kind: row.kind, roles: row.roles });
    }
    if (targets.filter(target => target.kind === 'primary').length > 1) throw httpError(503, 'pairing_scope_unavailable');
    return targets;
  }

  async function listTargets() {
    const targets = await activeTargets();
    const names = hostNames ? await hostNames().catch(() => new Map()) : new Map();
    return { targets: targets.map(target => {
      const name = names.get(target.ghost_id);
      return name ? { ...target, name } : target;
    }) };
  }

  function primaryTarget(targets) {
    const primaries = targets.filter(target => target.kind === 'primary');
    if (primaries.length !== 1) throw httpError(503, 'pairing_scope_unavailable');
    return primaries[0];
  }

  function samePair(left, right) {
    return left.ghost_id === right.ghost_id && left.conversation_id === right.conversation_id;
  }

  function selectedScope(targets, requested) {
    // Older desktop clients did not send selections. Their grants keep the
    // legacy singleton shape and can still pair to the designated default.
    const selected = requested ?? [primaryTarget(targets)];
    if (selected.some(pair => !targets.some(target => samePair(pair, target)))) throw httpError(409, 'invitation_stale_scope');
    // A singleton default has no pair ambiguity and retains the four-field
    // scope understood by existing iPhone builds.
    const explicitDefault = requested?.length === 1 && targets.some(target => target.kind === 'primary' && samePair(target, requested[0]));
    const scope = {
      kind: 'lifetime',
      ghost_ids: selected.map(pair => pair.ghost_id),
      conversation_ids: selected.map(pair => pair.conversation_id),
      capabilities: ['lifetime.read', 'lifetime.write'],
      ...(requested && !explicitDefault ? { targets: requested } : {}),
    };
    if (!validScope(scope)) throw httpError(503, 'pairing_scope_unavailable');
    return scope;
  }

  function requestedTargets(invitation) {
    return invitation.requested_targets ?? invitation.scope.targets;
  }

  function invitationReceipt(invitation) {
    return {
      invitation_id: invitation.invitation_id,
      origin: invitation.origin,
      expires_at: invitation.expires_at,
      scope: structuredClone(invitation.scope),
      status: invitation.status,
      ...(invitation.claim ? {
        claim: {
          claim_id: invitation.claim.claim_id,
          device_name: invitation.claim.device_name,
          verification_code: invitation.claim.verification_code,
          device_fingerprint: createHash('sha256').update(invitation.claim.device_token_digest, 'utf8').digest('hex').slice(0, 16),
          status: invitation.status,
        },
      } : {}),
    };
  }

  function findInvitation(state, { id, digest, byCode }) {
    return state.invitations.find(invitation => (id ? invitation.invitation_id === id : true)
      && (byCode ? invitation.code_digest === digest : invitation.ticket_digest === digest));
  }

  async function createInvitation(body) {
    if (!isRecord(body) || Object.keys(body).some(key => !['request_id', 'code_digest', 'ticket_digest', 'targets'].includes(key))
      || typeof body.request_id !== 'string' || !uuidPattern.test(body.request_id)
      || typeof body.code_digest !== 'string' || !hex64.test(body.code_digest)
      || typeof body.ticket_digest !== 'string' || !hex64.test(body.ticket_digest)
      || (Object.hasOwn(body, 'targets') && !validPairTargets(body.targets))) {
      throw httpError(400, 'invalid_invitation_request');
    }
    if (body.code_digest === body.ticket_digest) throw httpError(400, 'invalid_invitation_request');
    const requested = body.targets?.map(({ ghost_id, conversation_id }) => ({ ghost_id, conversation_id }))
      .sort((left, right) => left.ghost_id.localeCompare(right.ghost_id));
    // A receipt is still readable if its original selection has since become
    // stale or the registry is temporarily unavailable.
    const lookup = await activeTargets().then(targets => ({ targets }), error => ({ error }));
    const instant = now();
    return updateTransaction(registry => {
      const state = pairingState(registry);
      const existing = state.invitations.find(entry => entry.invitation_id === body.request_id);
      if (existing) {
        if (existing.code_digest !== body.code_digest || existing.ticket_digest !== body.ticket_digest
          || existing.origin !== publicOrigin
          || JSON.stringify(requestedTargets(existing)) !== JSON.stringify(requested)) throw httpError(409, 'invitation_conflict');
        expireIfDue(existing, instant.getTime());
        return invitationReceipt(existing);
      }
      // Time-bounded UUIDv7 nonces cannot become new authority after their
      // receipt has been retired; a delayed retry of an old QR stays dead.
      if (body.request_id[14] !== '7') throw httpError(400, 'invalid_invitation_request');
      const issuedAt = Number.parseInt(body.request_id.replaceAll('-', '').slice(0, 12), 16);
      if (issuedAt > instant.getTime() + 5000 || instant.getTime() >= issuedAt + INVITATION_TTL_MS) {
        throw httpError(409, 'invitation_expired');
      }
      if (state.invitations.filter(entry => entry.status === 'open' || entry.status === 'pending').length >= MAX_ACTIVE_INVITATIONS) {
        throw httpError(503, 'pairing_busy');
      }
      if (lookup.error) throw lookup.error;
      const scope = selectedScope(lookup.targets, requested);
      const invitation = {
        invitation_id: body.request_id,
        code_digest: body.code_digest,
        ticket_digest: body.ticket_digest,
        origin: publicOrigin,
        created_at: instant.toISOString(),
        expires_at: new Date(Math.min(instant.getTime(), issuedAt) + INVITATION_TTL_MS).toISOString(),
        scope,
        ...(requested && !scope.targets ? { requested_targets: requested } : {}),
        epoch,
        status: 'open',
        attempts: 0,
        claim: null,
      };
      state.invitations.push(invitation);
      return invitationReceipt(invitation);
    });
  }

  async function invitationMeta(id) {
    return updateTransaction(registry => {
      const state = pairingState(registry);
      const invitation = state.invitations.find(entry => entry.invitation_id === id);
      if (!invitation) throw httpError(404, 'invitation_not_found');
      expireIfDue(invitation, now().getTime());
      return invitationReceipt(invitation);
    });
  }

  // Operator recovery surface: every stored invitation receipt, lazily
  // expired, never any digest or secret. The owner UI restores pending
  // approval/open metadata from this after a refresh; an open invitation whose
  // code/ticket were lost can only be cancelled explicitly and re-issued —
  // never regenerated or re-minted automatically.
  async function listInvitations() {
    return updateTransaction(registry => {
      const state = pairingState(registry);
      const instant = now().getTime();
      return { invitations: state.invitations.map(invitation => {
        expireIfDue(invitation, instant);
        return invitationReceipt(invitation);
      }) };
    });
  }

  async function approveInvitation(id, body) {
    if (!isRecord(body) || Object.keys(body).length !== 3
      || typeof body.request_id !== 'string' || !uuidPattern.test(body.request_id)
      || typeof body.claim_id !== 'string' || !uuidPattern.test(body.claim_id)
      || typeof body.verification_code !== 'string' || !/^[0-9]{6}$/.test(body.verification_code)) {
      throw httpError(400, 'invalid_approval_request');
    }
    // Authority is re-proven at approval time: scope and epoch must still be
    // exactly the invitation's recorded generation.
    const lookup = await activeTargets().then(targets => ({ targets }), error => ({ error }));
    const instant = now();
    const outcome = await updateTransaction(registry => {
      const state = pairingState(registry);
      const invitation = state.invitations.find(entry => entry.invitation_id === id);
      if (!invitation) throw httpError(404, 'invitation_not_found');
      const status = expireIfDue(invitation, instant.getTime());
      if (invitation.status === 'approved') {
        if (invitation.approval?.request_id === body.request_id && invitation.approval?.claim_id === body.claim_id) {
          return invitation.approval.receipt;
        }
        throw httpError(409, 'invitation_already_approved');
      }
      if (status !== 'pending' || !invitation.claim || invitation.claim.claim_id !== body.claim_id) {
        return { denied: httpError(409, 'invitation_not_claimable') };
      }
      if (invitation.attempts >= MAX_INVITATION_CLAIM_ATTEMPTS) {
        return { denied: httpError(429, 'pairing_rate_limited') };
      }
      invitation.attempts += 1;
      if (invitation.epoch !== epoch) return { denied: httpError(409, 'invitation_stale_scope') };
      if (lookup.error) throw lookup.error;
      const requested = requestedTargets(invitation);
      const available = requested
        ? requested.every(pair => lookup.targets.some(target => samePair(pair, target)))
        : lookup.targets.some(target => target.kind === 'primary'
          && target.ghost_id === invitation.scope.ghost_ids[0] && target.conversation_id === invitation.scope.conversation_ids[0]);
      if (!available) {
        return { denied: httpError(409, 'invitation_stale_scope') };
      }
      const expected = verificationCode(invitation.invitation_id, invitation.claim.claim_id, invitation.claim.device_token_digest);
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(body.verification_code))) {
        // Denied attempts persist their bounded counter: the transaction must
        // commit the increment before the error is raised to the caller.
        return { denied: httpError(403, 'verification_code_mismatch') };
      }
      const deviceId = randomUUID();
      registry.devices.push({
        id: deviceId,
        name: invitation.claim.device_name,
        digest: invitation.claim.device_token_digest,
        created_at: instant.toISOString(),
        scope: structuredClone(invitation.scope),
      });
      invitation.status = 'approved';
      invitation.device_id = deviceId;
      invitation.approval = {
        request_id: body.request_id,
        claim_id: body.claim_id,
        receipt: { invitation_id: invitation.invitation_id, device_id: deviceId, status: 'approved' },
      };
      return invitation.approval.receipt;
    });
    if (outcome?.denied) throw outcome.denied;
    return outcome;
  }

  async function cancelInvitation(id, body) {
    if (!isRecord(body) || Object.keys(body).length !== 1
      || typeof body.request_id !== 'string' || !uuidPattern.test(body.request_id)) {
      throw httpError(400, 'invalid_cancel_request');
    }
    return updateTransaction(registry => {
      const state = pairingState(registry);
      const invitation = state.invitations.find(entry => entry.invitation_id === id);
      if (!invitation) throw httpError(404, 'invitation_not_found');
      if (invitation.status === 'approved') {
        // Revoking an approved invitation removes ONLY the device this
        // invitation created, and only while it still holds the exact
        // credential this invitation admitted.
        const digest = invitation.claim?.device_token_digest;
        const before = registry.devices.length;
        registry.devices = registry.devices.filter(device => !(device.id === invitation.device_id
          && digest !== undefined && device.digest === digest));
        if (registry.devices.length === before) throw httpError(409, 'device_unrevokable');
        invitation.status = 'revoked';
      } else if (invitation.status !== 'cancelled' && invitation.status !== 'revoked') {
        invitation.status = 'cancelled';
      }
      return { invitation_id: invitation.invitation_id, status: invitation.status };
    });
  }

  function claimFingerprint(body) {
    return createHash('sha256').update(JSON.stringify({
      request_id: body.request_id,
      device_name: body.device_name,
      device_token_digest: body.device_token_digest,
      code: body.code ?? null,
      invitation_id: body.invitation_id ?? null,
      ticket: body.ticket ?? null,
    }), 'utf8').digest('hex');
  }

  async function createClaim(body) {
    if (!takeClaimRateToken()) throw httpError(429, 'pairing_rate_limited');
    if (!isRecord(body)
      || typeof body.request_id !== 'string' || !uuidPattern.test(body.request_id)
      || typeof body.device_name !== 'string' || body.device_name.trim().length < 1 || body.device_name.length > 100
      || typeof body.device_token_digest !== 'string' || !hex64.test(body.device_token_digest)) {
      throw httpError(400, 'invalid_claim_request');
    }
    const hasCode = Object.prototype.hasOwnProperty.call(body, 'code');
    const hasTicket = Object.prototype.hasOwnProperty.call(body, 'ticket');
    const hasInvitation = Object.prototype.hasOwnProperty.call(body, 'invitation_id');
    const allowedKeys = new Set(['request_id', 'device_name', 'device_token_digest',
      ...(hasCode ? ['code'] : []), ...(hasTicket || hasInvitation ? ['invitation_id', 'ticket'] : [])]);
    if (new Set(Object.keys(body)).size !== allowedKeys.size || [...allowedKeys].some(key => !Object.prototype.hasOwnProperty.call(body, key))) {
      throw httpError(400, 'invalid_claim_request');
    }
    if (hasCode === (hasTicket || hasInvitation)) throw httpError(400, 'invalid_claim_request');
    let targetId = null, credentialDigest = null;
    if (hasCode) {
      const code = normalizePairingCode(body.code);
      if (!code) throw httpError(400, 'invalid_claim_request');
      credentialDigest = codeDigest(code);
    } else {
      if (typeof body.invitation_id !== 'string' || !uuidPattern.test(body.invitation_id)
        || typeof body.ticket !== 'string' || !hex64.test(body.ticket)) throw httpError(400, 'invalid_claim_request');
      targetId = body.invitation_id.toLowerCase();
      credentialDigest = ticketDigest(body.ticket);
    }
    const fingerprint = claimFingerprint(body);
    const instant = now();
    const claimOutcome = await updateTransaction(registry => {
      const state = pairingState(registry);
      const prior = state.receipts[body.request_id];
      if (prior !== undefined) {
        if (!isRecord(prior) || prior.kind !== 'claim' || prior.fingerprint !== fingerprint) {
          throw httpError(409, 'claim_conflict');
        }
        return prior.response;
      }
      const invitation = findInvitation(state, { id: targetId, digest: credentialDigest, byCode: hasCode });
      if (!invitation) throw httpError(404, 'invitation_not_found');
      if (invitation.attempts >= MAX_INVITATION_CLAIM_ATTEMPTS) {
        return { denied: httpError(429, 'pairing_rate_limited') };
      }
      invitation.attempts += 1;
      const status = expireIfDue(invitation, instant.getTime());
      if (status !== 'open' || invitation.claim) {
        return { denied: httpError(409, 'invitation_not_available') };
      }
      if (invitation.origin !== publicOrigin || invitation.epoch !== epoch) {
        return { denied: httpError(409, 'invitation_not_available') };
      }
      const claimId = randomUUID();
      const code = verificationCode(invitation.invitation_id, claimId, body.device_token_digest);
      invitation.status = 'pending';
      invitation.claim = {
        claim_id: claimId,
        device_name: body.device_name.trim(),
        device_token_digest: body.device_token_digest,
        verification_code: code,
        created_at: instant.toISOString(),
        expires_at: new Date(Math.min(instant.getTime() + CLAIM_TTL_MS, Date.parse(invitation.expires_at))).toISOString(),
      };
      const response = {
        claim_id: claimId,
        invitation_id: invitation.invitation_id,
        origin: invitation.origin,
        expires_at: invitation.claim.expires_at,
        status: 'pending',
        verification_code: code,
        scope: structuredClone(invitation.scope),
      };
      state.receipts[body.request_id] = { kind: 'claim', fingerprint, response };
      pruneReceipts(state);
      return response;
    });
    if (claimOutcome?.denied) throw claimOutcome.denied;
    return claimOutcome;
  }

  async function claimStatus(claimId, body, authorization) {
    if (!isRecord(body) || Object.keys(body).length !== 1
      || typeof body.request_id !== 'string' || !uuidPattern.test(body.request_id)) {
      throw httpError(400, 'invalid_status_request');
    }
    if (typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(authorization)) {
      throw httpError(404, 'claim_not_found');
    }
    const proofDigest = sha256hex(authorization.slice(7));
    const instant = now();
    return updateTransaction(registry => {
      const state = pairingState(registry);
      const invitation = state.invitations.find(entry => entry.claim?.claim_id === claimId);
      if (!invitation || invitation.claim.device_token_digest !== proofDigest) {
        throw httpError(404, 'claim_not_found');
      }
      const status = expireIfDue(invitation, instant.getTime());
      let outcome;
      if (invitation.status === 'approved') {
        const device = registry.devices.find(device => device.id === invitation.device_id
          && device.digest === invitation.claim.device_token_digest);
        // A device independently revoked at the registry is reported as
        // revoked, never silently re-added.
        outcome = device ? 'approved' : 'revoked';
      } else if (invitation.status === 'pending') {
        outcome = 'pending';
      } else {
        outcome = status;
      }
      return {
        claim_id: claimId,
        invitation_id: invitation.invitation_id,
        origin: invitation.origin,
        expires_at: invitation.claim.expires_at,
        status: outcome,
        verification_code: invitation.claim.verification_code,
        scope: structuredClone(invitation.scope),
        ...(outcome === 'approved' ? { device_id: invitation.device_id } : {}),
      };
    });
  }

  async function updateTransaction(change) {
    const { updateDevices } = await import('./devices.mjs');
    return updateDevices(devices, registry => {
      if (registry.pairing === undefined) registry.pairing = { invitations: [], receipts: {} };
      const state = pairingState(registry);
      const instant = now().getTime();
      for (const invitation of state.invitations) expireIfDue(invitation, instant);
      const retireable = state.invitations.filter(invitation => terminal(invitation.status)
        && instant >= Date.parse(invitation.expires_at));
      const retained = new Set(retireable.slice(-MAX_RETIRED_INVITATIONS).map(invitation => invitation.invitation_id));
      state.invitations = state.invitations.filter(invitation => !terminal(invitation.status)
        || instant < Date.parse(invitation.expires_at) || retained.has(invitation.invitation_id));
      const retainedIds = new Set(state.invitations.map(invitation => invitation.invitation_id));
      state.receipts = Object.fromEntries(Object.entries(state.receipts).filter(([, receipt]) =>
        isRecord(receipt) && isRecord(receipt.response) && retainedIds.has(receipt.response.invitation_id)));
      return change(registry);
    });
  }

  return { listTargets, createInvitation, invitationMeta, listInvitations, approveInvitation, cancelInvitation, createClaim, claimStatus };
}

// One Bonjour advertisement of the configured public HTTPS origin over the
// real macOS mDNS responder. The TXT record carries `origin` and nothing
// secret — never a ticket, code, or key. The caller owns the returned
// lifecycle: `stop()` terminates exactly this child process.
export function pairingAdvertisementRegistered(output) {
  // Apple's dns-sd pads a single-digit hour with a space, not a leading zero.
  return /(?:^|\n)[ \t]*\d{1,2}:\d{2}:\d{2}\.\d{3}\s+Got a reply for service [^\r\n]+: Name now registered and active(?:\r?\n|$)/.test(output);
}

export function startPairingAdvertiser({ origin, port, instance = 'ghost-pairing' }) {
  if (typeof origin !== 'string' || !origin.startsWith('https://')) {
    return Promise.reject(new Error('The pairing advertiser requires the configured public HTTPS origin.'));
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.reject(new Error('The pairing advertiser requires a valid local listen port.'));
  }
  return new Promise((resolve, reject) => {
    // dns-sd -R <instance> <type> <domain> <port> [txt key=value ...]
    const child = spawn('dns-sd', ['-R', instance, '_ghost-pair._tcp', 'local', String(port), `origin=${origin}`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let registrationOutput = '';
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      fn(value);
    };
    const guard = setTimeout(() => {
      child.kill();
      finish(reject, new Error('The pairing advertiser did not register within 5 seconds.'));
    }, 5000);
    child.on('error', error => finish(reject, error));
    child.stdout.on('data', chunk => {
      if (settled) return;
      // dns-sd prints a STARTING banner before the successful registration
      // callback. Only the callback proves nearby discovery is advertised.
      registrationOutput = (registrationOutput + chunk.toString('utf8')).slice(-2048);
      if (pairingAdvertisementRegistered(registrationOutput)) finish(resolve, {
        stop: () => { if (!child.killed) child.kill(); },
      });
    });
    child.on('exit', code => finish(reject, new Error(`The pairing advertiser exited early (code ${code}).`)));
  });
}
