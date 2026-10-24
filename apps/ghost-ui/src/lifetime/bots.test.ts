import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Envelope, Response, Snapshot } from '../../../../contracts/lifetime/bindings.ts';
import { botAvailability, botDefinitionCommand, botLifecycleCommand, parseBotSurface } from './bots';
import { BotStatusList } from './BotRoster';
import { createLifetimeClient } from './client';
import type { LifetimeStorage, LifetimeTransport } from './types';

const target = { ghost_id: '11111111-1111-4111-8111-111111111111', conversation_id: '22222222-2222-4222-8222-222222222222' };
const definition = { ghost_id: '33333333-3333-4333-8333-333333333333', revision: 2, digest: 'a'.repeat(64) };
const bot = { ...target, ghost_id: definition.ghost_id, display_name: '비교 담당', purpose: '제품을 비교합니다.', required_capabilities: ['read'], input_contract: { input: '제품 두 개' }, output_contract: { output: '비교 결과' }, definition_ref: definition, mode: 'active' as const, lifecycle_revision: 2, lifecycle_expected_revision: 2, admission_allowed: true, managed: true as const };
const operation = { action: 'create', candidate_id: 'candidate', candidate_digest: 'b'.repeat(64), ghost_id: bot.ghost_id, display_name: bot.display_name, purpose: bot.purpose, state: 'failed', blocker: 'independent_evaluation_failed', source_turn_id: 'owner-turn', operation_id: 'original-operation', definition_ref: definition, mode: 'active', lifecycle_revision: 0, lifecycle_expected_revision: null };
const response = (data: unknown): Response => ({ status: 'success', summary: '', object_refs: [], artifacts: [], next_actions: [], error_code: null, retry_class: 'same_id', data });
const snapshot: Snapshot = { protocol_version: 'ghost-lifetime/1', contract_revision: 1, mode: 'enabled', goals: [], work: [], bindings: [], artifacts: [], acceptances: [] };
const authority = { workspace_id: target.ghost_id, actor_ref: 'owner', authority_epoch: 1, dispatch_enabled: true };
function storage(): LifetimeStorage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, listKeys: () => [...values.keys()] };
}

describe('Owner conversation bot surface', () => {
  it('restores failed provisioning from a cold Host response without treating it as ready', () => {
    const restored = parseBotSurface(response(JSON.parse(JSON.stringify({ target, truncated: false, bots: [], operations: [operation] }))), target);
    const html = renderToStaticMarkup(createElement(BotStatusList, { surface: restored }));
    expect(html).toContain('생성 실패');
    expect(html).toContain('평가를 통과하지 못했습니다.');
    expect(html).not.toContain('사용 가능');
    expect(restored.operations[0]!.operation_id).toBe('original-operation');
  });
  it('cold reload preserves reconciliation identity without claiming readiness or retrying creation', () => {
    const restored = parseBotSurface(response(JSON.parse(JSON.stringify({ target, truncated: false, bots: [], operations: [{ ...operation, state: 'reconcile_required', blocker: 'provisioning_effect_unconfirmed' }] }))), target);
    const html = renderToStaticMarkup(createElement(BotStatusList, { surface: restored }));
    expect(html).toContain('확인 필요');
    expect(html).toContain('기존 준비 결과를 확인해야 합니다.');
    expect(html).not.toContain('생성 완료');
    expect(restored.operations[0]!.operation_id).toBe(operation.operation_id);
    expect(restored.operations[0]!.ghost_id).toBe(operation.ghost_id);
  });
  it('keeps declared optional memory degraded and required unavailable memory blocked on cold reload', () => {
    const degraded = { ...bot, memory: { state: 'degraded', required: false, reason: 'memory_permission_missing' } };
    const restored = parseBotSurface(response(JSON.parse(JSON.stringify({ target, truncated: false, bots: [degraded], operations: [] }))), target);
    expect(restored.bots[0]!.memory).toEqual(degraded.memory);
    expect(() => parseBotSurface(response({ target, truncated: false, bots: [{ ...degraded, memory: { ...degraded.memory, required: true } }], operations: [] }), target)).toThrow();
  });
  it('rejects another selected pair and conflicting identities instead of widening the roster', () => {
    expect(() => parseBotSurface(response({ target: { ...target, ghost_id: bot.ghost_id }, truncated: false, bots: [bot], operations: [] }), target)).toThrow();
    expect(() => parseBotSurface(response({ target, truncated: false, bots: [bot, bot], operations: [] }), target)).toThrow();
    expect(() => parseBotSurface(response({ target, truncated: false, bots: [{ ...bot, definition_ref: { ...definition, ghost_id: target.ghost_id } }], operations: [] }), target)).toThrow();
    expect(() => parseBotSurface(response({ target, truncated: false, bots: [{ ...bot, mode: 'paused', admission_allowed: true }], operations: [] }), target)).toThrow();
    expect(() => parseBotSurface(response({ target, truncated: false, bots: [], operations: [{ ...operation, state: 'model_says_ready' }] }), target)).toThrow();
  });
  it('does not infer readiness from completed provisioning when current admission is unavailable', () => {
    expect(botAvailability({ ...bot, admission_allowed: false })).toBe('준비 확인 필요');
    expect(botAvailability({ ...bot, mode: 'paused', admission_allowed: false })).toBe('일시정지');
    expect(botAvailability({ ...bot, mode: 'retired', admission_allowed: false })).toBe('사용 종료');
  });
  it('pins lifecycle and definition changes without any capability, memory, or credential fields', () => {
    expect(botLifecycleCommand(bot, 'paused')).toEqual({ body: { method: 'bot.lifecycle.set', ghost_id: bot.ghost_id, mode: 'paused' }, expectedRevision: 2 });
    const update = botDefinitionCommand(bot, 'update', 'New exact instructions');
    expect(update).toEqual({ method: 'bot.update.prepare', ghost_id: bot.ghost_id, definition_ref: definition, instructions: 'New exact instructions' });
    const clone = botDefinitionCommand(bot, 'clone', '새 비교 담당');
    expect(Object.keys(clone).sort()).toEqual(['definition_ref', 'display_name', 'ghost_id', 'method']);
    (update.definition_ref as typeof definition).revision = 99;
    expect(bot.definition_ref.revision).toBe(2);
    expect(() => botLifecycleCommand({ ...bot, mode: 'retired' }, 'active')).toThrow();
    expect(() => botDefinitionCommand(bot, 'update', '가'.repeat(12000))).toThrow();
  });
});

describe('bot commands reuse the durable Owner client', () => {
  it('reads cold status during read-only recovery and rejects stale lifecycle revisions without optimistic changes', async () => {
    const store = storage(), sent: Envelope[] = [];
    const transport: LifetimeTransport = { snapshot: async () => snapshot, async request(envelope) {
      sent.push(envelope);
      if (envelope.body.method === 'bot.surface.inspect') return response({ target, truncated: false, bots: [{ ...bot, lifecycle_revision: 3, lifecycle_expected_revision: 3 }], operations: [] });
      return { ...response({ host_effect_class: 'no_effect' }), status: 'error', error_code: 'conflict', retry_class: 'new_revision', summary: 'revision changed' };
    } };
    const readonly = createLifetimeClient(transport, store, { ...authority, dispatch_enabled: false });
    expect(parseBotSurface(await readonly.request({ method: 'bot.surface.inspect', ...target }), target).bots[0]!.lifecycle_revision).toBe(3);
    const live = createLifetimeClient(transport, store, authority);
    const command = botLifecycleCommand(bot, 'paused');
    const rejected = await live.request(command.body, command.expectedRevision);
    expect(rejected.status).toBe('error');
    expect(sent.at(-1)!.expected_revision).toBe(2);
    expect(bot.mode).toBe('active');
    expect(await live.pendingCommands()).toEqual([]);
  });
  it('reconciles a lost clone receipt after restart without creating another identity', async () => {
    const store = storage();
    let original: Envelope | undefined, effects = 0;
    const receipt = response({ candidate_id: 'one-candidate', ghost_id: 'one-new-ghost', operation_id: 'one-operation' });
    const transport: LifetimeTransport = { snapshot: async () => snapshot, async request(envelope) {
      if (envelope.body.method === 'command.inspect') return response({ command_id: original!.command_id, authority_epoch: 1, payload_digest: original!.payload_digest, found: true, response: receipt });
      original = envelope; effects++; throw new Error('ACK lost');
    } };
    await expect(createLifetimeClient(transport, store, authority).request(botDefinitionCommand(bot, 'clone', 'Clone'))).rejects.toThrow('ACK lost');
    const reopened = createLifetimeClient(transport, store, authority);
    expect((await reopened.retry(original!.command_id)).data).toEqual(receipt.data);
    expect(effects).toBe(1);
    expect(await reopened.pendingCommands()).toEqual([]);
  });
  it('sends two different new inputs to the same selected bot with distinct command identities', async () => {
    const sent: Envelope[] = [];
    const transport: LifetimeTransport = { snapshot: async () => snapshot, request: async envelope => { sent.push(envelope); return response({ turn_id: `turn-${sent.length}` }); } };
    const client = createLifetimeClient(transport, storage(), authority);
    for (const text of ['Compare the first pair', 'Compare a different pair']) await client.request({ method: 'conversation.input', ghost_id: bot.ghost_id, conversation_id: bot.conversation_id, text, privacy: 'private', attachments: [] });
    expect(sent.map(value => value.body.ghost_id)).toEqual([bot.ghost_id, bot.ghost_id]);
    expect(sent[0]!.command_id).not.toBe(sent[1]!.command_id);
    expect(sent[0]!.body.text).not.toBe(sent[1]!.body.text);
  });
});
