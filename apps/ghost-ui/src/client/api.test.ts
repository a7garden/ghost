import { describe, expect, it, vi } from 'vitest';
import { CommandQueue, ConfirmedFailure } from './api';
import { normalizeSnapshot } from './normalize';
import { dotState, isRunning, phaseLabel } from './types';
import type { Client, Envelope } from './types';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const command = { type: 'submit', profile_id: 'p', conversation_id: 'c', prompt: 'hello', kind: 'prompt' };
const empty = { workspace_id: 'workspace-a', host_protocol_version: 1, profiles: [] };

describe('host snapshot compatibility', () => {
  it('accepts a headless host without optional adapters', () => {
    const snapshot = normalizeSnapshot(empty);
    expect(snapshot.profiles).toEqual([]);
    expect(snapshot.spaces).toEqual([]);
    expect(snapshot.connectors).toEqual({});
  });
  it('keeps a broken profile visible without breaking healthy profiles', () => {
    const snapshot = normalizeSnapshot({ ...empty, profiles: [{ id: 'broken', name: 'Sage', error: 'store unavailable' }, { id: 'ok', name: 'Milo', conversations: [] }] });
    expect(dotState(snapshot.profiles[0], [])).toBe('offline');
    expect(dotState(snapshot.profiles[1], [])).toBe('idle');
  });
  it('does not turn an unfamiliar phase into success', () => {
    const s = normalizeSnapshot({ ...empty, profiles: [{ id: 'p', conversations: [{ id: 'c', tasks: [{ id: 't', phase: 'future_phase' }] }] }] });
    const phase = s.profiles[0].conversations[0].tasks[0].phase;
    expect(phaseLabel(phase)).toBe('future_phase');
    expect(isRunning(phase)).toBe(false);
  });
  it('rejects unsupported protocol and unrelated JSON', () => {
    expect(() => normalizeSnapshot({ ...empty, host_protocol_version: 2 })).toThrow('버전');
    expect(() => normalizeSnapshot({ ok: false })).toThrow('형식');
  });
  it('distinguishes waiting for an owner from running', () => {
    const s = normalizeSnapshot({ ...empty, profiles: [{ id: 'p', conversations: [{ tasks: [{ phase: 'waiting_owner' }] }] }] });
    expect(dotState(s.profiles[0], [])).toBe('attention');
    expect(isRunning('waiting_owner')).toBe(false);
  });
});

describe('durable request IDs', () => {
  it('allows a new connection check after a confirmed failure without replaying uncertain writes', async () => {
    const storage = memoryStorage(), ids: string[] = [];
    const client = { action: async (e: Envelope) => { ids.push(e.request_id); throw new ConfirmedFailure('missing server'); } } as unknown as Client;
    const check = { type: 'workspace', action: { type: 'check_integration', id: 'fixture' } };
    await new CommandQueue(storage, 'a').send(client, check).catch(() => {});
    await new CommandQueue(storage, 'a').send(client, check).catch(() => {});
    expect(ids[0]).not.toBe(ids[1]);
    await new CommandQueue(storage, 'a').send(client, command).catch(() => {});
    await new CommandQueue(storage, 'a').send(client, command).catch(() => {});
    expect(ids[2]).toBe(ids[3]);
  });
  it('persists before dispatch and reuses the ID after an unknown outcome and refresh', async () => {
    const storage = memoryStorage(), envelopes: Envelope[] = [];
    const client = { mode: 'live', action: vi.fn(async (envelope: Envelope) => {
      expect(storage.getItem('a')).toContain(envelope.request_id);
      envelopes.push(envelope);
      if (envelopes.length === 1) throw new Error('timeout after commit');
      return { task_id: 'saved' };
    }) } as unknown as Client;
    await expect(new CommandQueue(storage, 'a').send(client, command)).rejects.toThrow('timeout');
    const result = await new CommandQueue(storage, 'a').send(client, command);
    expect(result).toEqual({ task_id: 'saved' });
    expect(envelopes[0]).toEqual(envelopes[1]);
    expect(storage.getItem('a')).toBe('{}');
  });
  it('gives a deliberate repeat after success a new ID', async () => {
    const storage = memoryStorage(), ids: string[] = [];
    const client = { action: async (e: Envelope) => { ids.push(e.request_id); return {}; } } as unknown as Client;
    const queue = new CommandQueue(storage, 'a');
    await queue.send(client, command); await queue.send(client, command);
    expect(ids[0]).not.toBe(ids[1]);
  });
  it('does not reuse a pending command across workspaces', async () => {
    const storage = memoryStorage(), ids: string[] = [];
    const client = { action: async (e: Envelope) => { ids.push(e.request_id); throw new Error('offline'); } } as unknown as Client;
    await new CommandQueue(storage, 'a').send(client, command).catch(() => {});
    await new CommandQueue(storage, 'b').send(client, command).catch(() => {});
    expect(ids[0]).not.toBe(ids[1]);
  });
  it('never dispatches when request persistence is unavailable', async () => {
    const action = vi.fn(), client = { action } as unknown as Client;
    const storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    await expect(new CommandQueue(storage, 'a').send(client, command)).rejects.toThrow('quota');
    expect(action).not.toHaveBeenCalled();
  });
  it('never dispatches when the pending journal is corrupt', async () => {
    const storage = memoryStorage(), action = vi.fn(); storage.setItem('a', '{invalid');
    await expect(new CommandQueue(storage, 'a').send({ action } as unknown as Client, command)).rejects.toThrow('기록');
    expect(action).not.toHaveBeenCalled();
  });
});

describe('large avatar request persistence', () => {
  it('keeps one payload and a stable request ID after an unknown outcome and reload', async () => {
    const values = new Map<string, string>();
    const storage = { getItem: async (key: string) => values.get(key) ?? null, setItem: async (key: string, value: string) => { values.set(key, value); } };
    const command = { type: 'workspace', action: { type: 'create_avatar', avatar: { data_url: 'large-image-payload' } } };
    const ids: string[] = []; let failed = true;
    const client = { action: async (envelope: Envelope) => { ids.push(envelope.request_id); if (failed) throw new Error('lost response'); return { id: 'avatar' }; } } as unknown as Client;
    await expect(new CommandQueue(storage, 'images', true).send(client, command)).rejects.toThrow('lost response');
    expect(values.get('images')!.split('large-image-payload')).toHaveLength(2);
    failed = false;
    await new CommandQueue(storage, 'images', true).send(client, command);
    expect(ids[0]).toBe(ids[1]); expect(JSON.parse(values.get('images')!)).toEqual({});
  });
});


describe('conversation model selection receipts', () => {
  const choose = (model: string) => ({ type: 'workspace', action: { type: 'conversation_model', profile_id: 'p', conversation_id: 'c', model } });
  it('reuses an immediate uncertain retry but creates a fresh receipt after an intervening choice', async () => {
    const storage = memoryStorage(), ids: string[] = [];
    const client = { action: async (envelope: Envelope) => { ids.push(envelope.request_id); throw new Error('unknown outcome'); } } as unknown as Client;
    const queue = new CommandQueue(storage, 'selection');
    await queue.send(client, choose('local/a')).catch(() => {});
    await queue.send(client, choose('local/a')).catch(() => {});
    await queue.send(client, choose('local/b')).catch(() => {});
    await queue.send(client, choose('local/a')).catch(() => {});
    await queue.send(client, choose('local/a')).catch(() => {});
    expect(ids[0]).toBe(ids[1]); expect(ids[3]).not.toBe(ids[0]); expect(ids[3]).toBe(ids[4]);
  });
  it('clears superseded uncertain selections after the latest choice is confirmed', async () => {
    const storage = memoryStorage(); let fail = true;
    const client = { action: async () => { if (fail) throw new Error('lost reply'); return {}; } } as unknown as Client;
    const queue = new CommandQueue(storage, 'selection');
    await queue.send(client, choose('local/a')).catch(() => {});
    fail = false; await queue.send(client, choose('local/b'));
    expect(storage.getItem('selection')).toBe('{}');
  });
  it('allows a rejected model selection to be retried after the provider is fixed', async () => {
    const storage = memoryStorage(), ids: string[] = [];
    const client = { action: async (envelope: Envelope) => { ids.push(envelope.request_id); throw new ConfirmedFailure('provider unavailable'); } } as unknown as Client;
    const queue = new CommandQueue(storage, 'selection');
    await queue.send(client, choose('local/a')).catch(() => {});
    await queue.send(client, choose('local/a')).catch(() => {});
    expect(ids[0]).not.toBe(ids[1]);
  });
});
