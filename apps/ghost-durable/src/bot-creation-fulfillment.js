import { ProtocolError } from './contract.js';

const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 400;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const id = value => Number.isSafeInteger(value) && value > 0;
const tools = new Set(['bot_prepare', 'bot_evaluate', 'bot_activate']);
const fail = () => { throw new ProtocolError('bot_creation_fulfillment_unconfirmed', 'Exact Owner bot creation progress was not confirmed.', 'never'); };

// Undefined is the legacy descriptor ABI. It gains no implicit continuation.
export function validateCreationFulfillment(value) {
  if (value === undefined) return undefined;
  if (!value || value.kind !== 'ghost-bot-creation-fulfillment/1'
    || !['unprepared', 'draft', 'evaluating', 'evaluated', 'provisioning', 'ready', 'failed', 'reconcile_required'].includes(value.state)
    || typeof value.activation_requested !== 'boolean'
    || ![null, 'prepare', 'evaluate', 'activate'].includes(value.next_action)
    || ![value.evaluation_goal_id, value.evaluation_work_id].every(item => item === null || bounded(item))
    || (value.evaluation_goal_id === null) !== (value.evaluation_work_id === null)) return fail();
  if (value.state === 'unprepared') {
    if (value.candidate_id !== null || value.candidate_digest !== null || value.next_action !== 'prepare'
      || value.activation_requested || value.evaluation_work_id !== null) return fail();
  } else if (!bounded(value.candidate_id) || !hex(value.candidate_digest)) return fail();
  if (value.next_action === 'evaluate' && (value.state !== 'draft' || value.evaluation_work_id !== null)) return fail();
  if (value.next_action === 'activate' && (!['evaluating', 'evaluated'].includes(value.state)
    || value.evaluation_work_id === null || value.activation_requested)) return fail();
  return Object.fromEntries(['kind', 'state', 'candidate_id', 'candidate_digest', 'activation_requested',
    'evaluation_goal_id', 'evaluation_work_id', 'next_action'].map(key => [key, value[key]]));
}

export async function initializeCreationFulfillment(index) {
  await index.exec(`CREATE TABLE IF NOT EXISTS ghost_bot_creation_fulfillment (
    turn_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, submission_id TEXT NOT NULL,
    candidate_id TEXT, candidate_digest TEXT, receipts_json TEXT NOT NULL DEFAULT '[]',
    continuation_generation INTEGER, continuation_json TEXT, terminal_json TEXT
  )`);
}

// This table fences the complete Owner turn, rather than each SDK generation:
// onYield hands the original run to a successor with a fresh task memo namespace.
export function createBotCreationFulfillment({ index, scope, inspect, inspectTerminal, readTurn, readEntry, readTask, diagnostic }) {
  const local = async turnId => {
    const turn = await readTurn(turnId);
    if (!turn || turn.origin_kind !== 'owner' || turn.cancel_requested || turn.cancel_confirmed
      || !['queued', 'running'].includes(turn.status) || typeof turn.submission_id !== 'string') return fail();
    return turn;
  };
  const current = async () => {
    const trusted = await scope();
    if (trusted.originKind !== 'owner' || !bounded(trusted.turnId)) return null;
    const turn = await local(trusted.turnId);
    const creation = await inspect(trusted);
    if (!creation || creation.fulfillment === undefined) return null;
    return { trusted, turn, view: validateCreationFulfillment(creation.fulfillment) };
  };
  const ensure = async (tx, state) => {
    const { turn, view } = state;
    await tx.run(`INSERT OR IGNORE INTO ghost_bot_creation_fulfillment
      (turn_id,conversation_id,submission_id,candidate_id,candidate_digest) VALUES (?,?,?,?,?)`,
    turn.turn_id, turn.conversation_id, turn.submission_id, view.candidate_id, view.candidate_digest);
    const row = await tx.get('SELECT * FROM ghost_bot_creation_fulfillment WHERE turn_id=?', turn.turn_id);
    if (row.conversation_id !== turn.conversation_id || row.submission_id !== turn.submission_id
      || (row.candidate_id !== null && (row.candidate_id !== view.candidate_id || row.candidate_digest !== view.candidate_digest))) return fail();
    if (row.candidate_id === null && view.candidate_id !== null) {
      await tx.run('UPDATE ghost_bot_creation_fulfillment SET candidate_id=?,candidate_digest=? WHERE turn_id=?',
        view.candidate_id, view.candidate_digest, turn.turn_id);
      row.candidate_id = view.candidate_id; row.candidate_digest = view.candidate_digest;
    }
    return row;
  };
  const evidence = async (assistantId, resultIds, api, context) => {
    const assistant = await readEntry(assistantId);
    if (!assistant || assistant.kind !== 'pi.assistant' || assistant.conversationId !== api.conversationId
      || assistant.byTaskId !== api.taskId) return fail();
    const calls = assistant.model?.flatMap(message => message.content ?? []).filter(part => part.type === 'toolCall') ?? [];
    const receipts = [];
    for (const resultId of resultIds) {
      const entry = await readEntry(resultId), message = entry?.model?.[0];
      if (!tools.has(message?.toolName)) continue;
      const call = calls.find(item => item.id === message.toolCallId && item.name === message.toolName);
      const task = id(entry.byTaskId) ? await readTask(entry.byTaskId) : null;
      if (!call || entry.kind !== 'pi.tool-result' || entry.conversationId !== api.conversationId
        || task?.kind !== 'pi.tool' || task.owner !== api.taskId || task.input.assistant !== assistantId
        || task.input.callId !== call.id || task.state.status !== 'terminal'
        || task.state.outcome?.result?.entryId !== resultId) return fail();
      const receipt = message.details;
      const effect = !message.isError && receipt?.status === 'success' ? 'success'
        : receipt?.data?.host_effect_class === 'no_effect' ? 'denied' : 'unknown';
      receipts.push({ method: message.toolName, call_id: call.id, generation_id: api.taskId, tool_task_id: task.id,
        assistant_id: assistantId, result_id: resultId, effect,
        candidate_id: receipt?.data?.candidate_id ?? null, candidate_digest: receipt?.data?.candidate_digest ?? null,
        host_state: receipt?.data?.state ?? null, error_code: receipt?.error_code ?? null,
        retry_class: receipt?.retry_class ?? null, host_effect_class: receipt?.data?.host_effect_class ?? null });
    }
    for (const call of calls.filter(item => tools.has(item.name))) {
      if (!receipts.some(item => item.call_id === call.id && item.tool_task_id
        && resultIds.includes(item.result_id))) receipts.push({ method: call.name, generation_id: api.taskId,
        assistant_id: assistantId, result_id: `missing:${assistantId}:${call.id}`, effect: 'unknown', reason: 'sdk_receipt_missing' });
    }
    return receipts;
  };
  const saveTerminal = async (state, result) => {
    await index.transaction(async tx => {
      await ensure(tx, state);
      await tx.run('UPDATE ghost_bot_creation_fulfillment SET terminal_json=? WHERE turn_id=?', JSON.stringify(result), state.turn.turn_id);
    });
    return result;
  };
  return {
    async hasBlockedReceipt(turnId) {
      const row = await index.get('SELECT receipts_json FROM ghost_bot_creation_fulfillment WHERE turn_id=?', turnId);
      return Boolean(row && JSON.parse(row.receipts_json).some(item => item.effect !== 'success'));
    },
    async afterTools(assistant, results, api, context) {
      const trusted = await scope();
      if (trusted.originKind !== 'owner' || !bounded(trusted.turnId)) return;
      let receipts;
      try { receipts = await evidence(assistant, results, api, context); }
      catch { receipts = [{ method: 'bot_receipt_unconfirmed', generation_id: api.taskId,
        assistant_id: assistant, result_id: `unconfirmed:${assistant}`, effect: 'unknown', reason: 'sdk_receipt_unconfirmed' }]; }
      if (!receipts.length) return;
      let state;
      try { state = await current(); } catch {
        // A successful mutation followed by failed inspection still has an
        // unresolved boundary. Preserve its actual SDK receipt before stopping.
        const turn = await readTurn(trusted.turnId);
        if (!turn || turn.origin_kind !== 'owner' || typeof turn.submission_id !== 'string') return fail();
        const prepared = receipts.find(item => bounded(item.candidate_id) && hex(item.candidate_digest));
        state = { turn, view: { candidate_id: prepared?.candidate_id ?? null, candidate_digest: prepared?.candidate_digest ?? null } };
        for (const receipt of receipts) receipt.inspection_unconfirmed = true;
      }
      if (!state) return; // old descriptors retain their existing behavior
      await index.transaction(async tx => {
        const row = await ensure(tx, state), retained = JSON.parse(row.receipts_json);
        for (const receipt of receipts) {
          if (retained.some(item => item.result_id === receipt.result_id)) continue;
          if (retained.length >= 16) return fail();
          retained.push(receipt);
        }
        await tx.run('UPDATE ghost_bot_creation_fulfillment SET receipts_json=? WHERE turn_id=?', JSON.stringify(retained), state.turn.turn_id);
      });
    },
    async onYield(_answer, api, context) {
      let state; try { state = await current(); } catch { return; }
      if (!state || state.view.state !== 'draft' || state.view.next_action !== 'evaluate') return;
      const continuation = await index.transaction(async tx => {
        const row = await ensure(tx, state), receipts = JSON.parse(row.receipts_json);
        // Any denied/uncertain mutation ends automatic continuation. A draft
        // observation cannot prove that a lost callback had no external effect.
        if (!receipts.length || receipts.some(item => item.effect !== 'success')
          || !receipts.some(item => item.method === 'bot_prepare' && item.candidate_id === state.view.candidate_id
            && item.candidate_digest === state.view.candidate_digest)
          || receipts.some(item => item.method !== 'bot_prepare')) return;
        if (row.continuation_generation !== null) {
          return row.continuation_generation === api.taskId ? JSON.parse(row.continuation_json) : undefined;
        }
        const value = `Host fulfillment check for the SAME authenticated Owner turn ${state.turn.turn_id}: candidate ${state.view.candidate_id} with immutable digest ${state.view.candidate_digest} is still draft. The Owner's existing creation request already covers its fixed independent evaluation. Use bot_evaluate once with exactly that candidate_id and candidate_digest; do not ask for the same permission, prepare a replacement, or retry a failed/unknown receipt. If its Host receipt arms activation_requested, report the actual evaluating/provisioning state and finish; otherwise use bot_activate once for the same candidate and digest. Ready requires the Host's readiness receipt. This is the only bounded continuation of this creation turn; do not poll.`;
        await tx.run('UPDATE ghost_bot_creation_fulfillment SET continuation_generation=?,continuation_json=? WHERE turn_id=? AND continuation_generation IS NULL',
          api.taskId, JSON.stringify(value), state.turn.turn_id);
        return value;
      });
      if (continuation === undefined) return;
      // Memo is task-scoped: only deterministic re-entry of this claimant may
      // replay it. The turn CAS above is what blocks successor generations.
      const saved = await api.memo('ghost.bot-creation-continuation/1', continuation, context);
      const fresh = await current();
      if (!fresh || fresh.turn.turn_id !== state.turn.turn_id || fresh.turn.submission_id !== state.turn.submission_id
        || JSON.stringify(fresh.view) !== JSON.stringify(state.view) || saved !== continuation) return;
      return { continue: saved };
    },
    async terminal(turnId) {
      let state;
      try {
        // Explicit original turn, including a settled effect_unknown turn. This
        // is read-only reconciliation, not active scope for inference/tools.
        const turn = await readTurn(turnId);
        if (!turn || turn.origin_kind !== 'owner' || turn.cancel_requested || turn.cancel_confirmed
          || !['queued', 'running', 'effect_unknown'].includes(turn.status) || typeof turn.submission_id !== 'string') return null;
        const creation = await inspectTerminal(turnId);
        if (!creation || creation.fulfillment === undefined) {
          const prior = await index.get('SELECT candidate_id FROM ghost_bot_creation_fulfillment WHERE turn_id=?', turnId);
          if (prior?.candidate_id !== undefined && prior.candidate_id !== null) return fail();
          return null;
        }
        state = { turn, view: validateCreationFulfillment(creation.fulfillment) };
      } catch {
        const row = await index.get('SELECT turn_id FROM ghost_bot_creation_fulfillment WHERE turn_id=?', turnId);
        if (!row) return null;
        const result = { turn_id: turnId, state: 'unknown', reason: 'inspection_unconfirmed' };
        await index.run('UPDATE ghost_bot_creation_fulfillment SET terminal_json=? WHERE turn_id=?', JSON.stringify(result), turnId);
        return result;
      }
      if (!state) return null;
      const row = await index.transaction(tx => ensure(tx, state)), receipts = JSON.parse(row.receipts_json);
      const result = { turn_id: turnId, candidate_id: state.view.candidate_id, candidate_digest: state.view.candidate_digest,
        actual_state: state.view.state, activation_requested: state.view.activation_requested };
      if (receipts.some(item => item.effect === 'unknown')) return saveTerminal(state, { ...result, state: 'unknown', reason: 'tool_effect_unconfirmed' });
      if (state.view.state === 'unprepared') return saveTerminal(state, { ...result, state: 'unprepared' });
      if (state.view.state === 'ready') return saveTerminal(state, { ...result, state: 'ready' });
      if (['failed', 'reconcile_required'].includes(state.view.state)) return saveTerminal(state, { ...result, state: 'blocked' });
      if (['evaluating', 'provisioning'].includes(state.view.state) && state.view.activation_requested
        && state.view.evaluation_goal_id !== null && state.view.evaluation_work_id !== null) return saveTerminal(state, { ...result, state: 'pending' });
      diagnostic({ code: 'bot_creation_incomplete', state: state.view.state });
      return saveTerminal(state, { ...result, state: 'incomplete' });
    },
    async observations(conversation) {
      const rows = await index.all('SELECT turn_id,candidate_id,candidate_digest,continuation_generation,terminal_json,receipts_json FROM ghost_bot_creation_fulfillment WHERE conversation_id=? ORDER BY rowid DESC LIMIT 16', conversation);
      return rows.map(row => ({ turn_id: row.turn_id, candidate_id: row.candidate_id, candidate_digest: row.candidate_digest,
        continuation_generation: row.continuation_generation, terminal: row.terminal_json === null ? null : JSON.parse(row.terminal_json), receipts: JSON.parse(row.receipts_json) }));
    },
  };
}
