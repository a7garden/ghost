import { describe, expect, it } from 'vitest';
import type { Message } from '@ghost/contract';
import { begin, claims, confirm, discard, loadOutbox, nextAttempts, OUTBOX_KEY, release, retry, rowsFor, saveOutbox, settle, submit, type MessageSend, type Outbox } from './outbox';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const send = (text: string, conversationId = 'c1', extra: Partial<MessageSend> = {}): MessageSend => ({ type: 'message.send', conversationId, text, spaceIds: [], ...extra });
const message = (patch: Partial<Message>): Message => ({
  id: 'm1', conversationId: 'c1', role: 'user', origin: 'owner', text: '', toolCalls: [], tool: null, attachments: [], createdAt: 0, ...patch,
});
const post = (box: Outbox, n: number, text: string, opts: { live?: boolean; conversationId?: string; now?: number; transcript?: Message[] } = {}) =>
  submit(box, { requestId: id(n), command: send(text, opts.conversationId), now: opts.now ?? 1_000, live: opts.live ?? true, transcript: opts.transcript ?? [] });
const state = (box: Outbox) => box.map(entry => `${entry.command.text}:${entry.state}`);
const lost = { ok: false, connectionLost: true, error: 'Ghost 호스트에 연결할 수 없습니다.' } as const;
const refused = { ok: false, connectionLost: false, error: 'no model is configured' } as const;

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
    items,
  };
}

describe('outbox', () => {
  it('keeps the written order: messages written offline go one at a time per conversation once the connection returns', () => {
    let box = post([], 1, 'A', { live: false });
    box = post(box, 2, 'B', { live: false });
    box = post(box, 3, 'C', { live: false, conversationId: 'c2' });
    expect(state(box)).toEqual(['A:queued', 'B:queued', 'C:queued']);
    expect(nextAttempts(box, new Set())).toEqual([]);

    box = release(box);
    expect(nextAttempts(box, new Set()).map(entry => entry.command.text)).toEqual(['A', 'C']);
    expect(nextAttempts(box, new Set([id(1)])).map(entry => entry.command.text)).toEqual(['C']);

    box = settle(begin(box, id(1), 2_000), id(1), { ok: true });
    expect(nextAttempts(box, new Set([id(3)])).map(entry => entry.command.text)).toEqual(['B']);
  });

  it('puts a message written while live behind messages still waiting for the connection', () => {
    let box = post([], 1, 'A', { live: false });
    box = post(box, 2, 'B', { live: true });
    expect(state(box)).toEqual(['A:queued', 'B:queued']);
    expect(rowsFor(box, 'c1').map(row => row.note)).toEqual([false, true]);
  });

  it('sends a failed message again with the same request id and command', () => {
    let box = post([], 1, 'hello');
    const sent = nextAttempts(box, new Set())[0]!;
    box = settle(begin(box, sent.requestId, 1_000), sent.requestId, refused);
    expect(state(box)).toEqual(['hello:failed']);
    expect(nextAttempts(box, new Set())).toEqual([]);

    box = retry(box, sent.requestId);
    const again = nextAttempts(box, new Set())[0]!;
    expect(again.requestId).toBe(id(1));
    expect(again.command).toEqual(sent.command);
  });

  it('gives a message that never reached the Host exactly one automatic send', () => {
    let box = post([], 1, 'hello');
    box = settle(begin(box, id(1), 1_000), id(1), lost);
    expect(state(box)).toEqual(['hello:queued']);

    box = release(box);
    expect(state(box)).toEqual(['hello:sending']);
    box = settle(begin(box, id(1), 2_000), id(1), lost);
    expect(state(box)).toEqual(['hello:failed']);
    expect(release(box)).toBe(box);
  });

  it('retires a row when the transcript shows its message, once per message and never before it was sent', () => {
    let box = post([], 1, 'same', { now: 10_000 });
    box = post(box, 2, 'same', { now: 10_000, live: false });
    box = begin(box, id(1), 10_000);
    const arrived = message({ id: 'm9', text: 'same', createdAt: 10_500 });

    box = confirm(box, [arrived]);
    expect(box.map(entry => entry.requestId)).toEqual([id(2)]);
    expect(confirm(box, [arrived])).toBe(box);
  });

  it('names the message that takes each sent row\'s place, so the row can hand over without a second entrance', () => {
    let box = post([], 1, 'same', { now: 10_000 });
    box = post(box, 2, 'later', { now: 10_000, live: false });
    box = begin(box, id(1), 10_000);
    expect(claims(box, [message({ id: 'm9', text: 'same', createdAt: 10_500 }), message({ id: 'm10', text: 'later', createdAt: 10_600 })]))
      .toEqual(new Map([[id(1), 'm9']]));
  });

  it('does not take an earlier message with the same text, or one from another conversation, as the confirmation', () => {
    const earlier = message({ id: 'm1', text: 'ok', createdAt: 9_000 });
    let box = post([], 1, 'ok', { now: 10_000, transcript: [earlier] });
    box = begin(box, id(1), 10_000);
    expect(confirm(box, [earlier, message({ id: 'm2', conversationId: 'c2', text: 'ok', createdAt: 10_100 })])).toBe(box);
    expect(confirm(box, [message({ id: 'm3', text: 'ok', createdAt: 10_000 - 31_000 })])).toBe(box);
    expect(confirm(box, [earlier, message({ id: 'm4', text: 'ok', createdAt: 10_200 })])).toEqual([]);
  });

  it('keeps a failed repeat of the same text failed when only the earlier message reached the transcript', () => {
    // The first "ok" already retired; the second was written before its copy arrived, then the Host refused it.
    let box = post([], 2, 'ok', { now: 10_200 });
    box = settle(begin(box, id(2), 10_200), id(2), refused);
    expect(confirm(box, [message({ id: 'm1', text: 'ok', createdAt: 10_100 })])).toBe(box);
    expect(state(box)).toEqual(['ok:failed']);
  });

  it('keeps unsent messages word for word across a reload', () => {
    const storage = memoryStorage();
    const text = '  첫 줄\n\n둘째 줄 — 그대로  ';
    const files = [{ digest: 'a'.repeat(64), name: 'plan.pdf', mediaType: 'application/pdf', size: 12 }];
    let box = submit([], { requestId: id(1), command: send(text, 'c1', { attachments: files }), now: 1, live: false, transcript: [] });
    box = post(box, 2, 'in flight', { conversationId: 'c2' });
    box = begin(box, id(2), 2);
    box = post(box, 3, 'accepted', { conversationId: 'c3' });
    box = settle(begin(box, id(3), 3), id(3), { ok: true });
    saveOutbox(storage, box);

    const loaded = loadOutbox(storage);
    expect(loaded.map(entry => entry.command.text)).toEqual([text, 'in flight']);
    expect(loaded[0]!.command.attachments).toEqual(files);
    expect(state(loaded)).toEqual([`${text}:queued`, 'in flight:queued']);
    expect(loaded[1]!.requestId).toBe(id(2));
  });

  it('asks the owner after a reload cuts off an automatic send', () => {
    const storage = memoryStorage();
    let box = release(post([], 1, 'hello', { live: false }));
    box = begin(box, id(1), 1);
    saveOutbox(storage, box);
    expect(state(loadOutbox(storage))).toEqual(['hello:failed']);
  });

  it('starts empty from missing or damaged storage and clears it when nothing is left to send', () => {
    const storage = memoryStorage();
    expect(loadOutbox(storage)).toEqual([]);
    storage.setItem(OUTBOX_KEY, '{not json');
    expect(loadOutbox(storage)).toEqual([]);
    storage.setItem(OUTBOX_KEY, JSON.stringify([{ requestId: 'nope', command: { type: 'message.send' } }]));
    expect(loadOutbox(storage)).toEqual([]);
    saveOutbox(storage, []);
    expect(storage.items.has(OUTBOX_KEY)).toBe(false);
  });

  it('hands a discarded message back whole and drops its row; a message on its way cannot be taken back', () => {
    const files = [{ digest: 'b'.repeat(64), name: 'a.png', mediaType: 'image/png', size: 3 }];
    let box = submit([], { requestId: id(1), command: send('되돌릴 글', 'c1', { attachments: files, spaceIds: ['s1'] }), now: 1, live: false, transcript: [] });
    box = post(box, 2, 'going', { conversationId: 'c2' });

    expect(discard(box, id(2)).command).toBeNull();
    const result = discard(box, id(1));
    expect(result.command).toEqual(send('되돌릴 글', 'c1', { attachments: files, spaceIds: ['s1'] }));
    expect(state(result.box)).toEqual(['going:sending']);
  });
});
