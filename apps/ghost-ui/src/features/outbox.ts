import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { Command, CommandRequest, Timestamp, nullable, type CommandOf, type Message } from '@ghost/contract';
import { useHost } from '../host/context';
import { HostError } from '../host/client';
import { useHostState } from '../host/store';

/**
 * Owner messages on their way to the Host (2026-11-12). A message joins the conversation the moment it is
 * sent and carries its state on its own row until the Host's copy arrives:
 *
 * - `sending`  goes to the Host, one at a time per conversation, in the order written.
 * - `queued`   waits for the connection: written while offline, or its first send never reached the Host.
 *              When the connection comes back every queued message gets one automatic send.
 * - `failed`   the Host refused it, or its automatic send failed too. Only the owner sends it again.
 * - `accepted` the Host took it; the row stays until the transcript shows it.
 *
 * Every send of one message reuses its request id and exact command, so the Host runs it at most once.
 * Unsent messages persist in localStorage word for word; accepted ones are the Host's to keep.
 */

export type MessageSend = CommandOf<'message.send'>;
export type OutboxState = 'sending' | 'queued' | 'failed' | 'accepted';

export interface OutboxEntry {
  requestId: string;
  command: MessageSend;
  state: OutboxState;
  /** The one automatic send a queued message gets has started; later failures wait for the owner. */
  auto: boolean;
  createdAt: number;
  /** When it first went to the Host. Never sent, never in the transcript. */
  firstAttemptAt: number | null;
  /** Same-text owner messages already in the transcript when it was written: never its confirmation. */
  skip: string[];
  /** The Host's reason for the last failure. */
  error?: string;
}

export type Outbox = readonly OutboxEntry[];
export type SendOutcome = { ok: true } | { ok: false; connectionLost: boolean; error: string };

export const OUTBOX_KEY = 'ghost:outbox';
/** How far before its first send a transcript message may be stamped and still be this one (clock skew). */
export const CONFIRM_WINDOW_MS = 30_000;
/** How long a row queued while the connection reads live waits before its automatic send. */
export const QUEUED_WHILE_LIVE_MS = 3_000;

const sameText = (entry: OutboxEntry, message: Message) => message.role === 'user' && (message.origin === 'owner' || message.origin === null)
  && message.conversationId === entry.command.conversationId && message.text.trim() === entry.command.text.trim();

/**
 * A new message. It waits in the queue while the connection is down or an earlier message of the
 * same conversation is still queued, so messages never overtake each other.
 */
export function submit(box: Outbox, input: { requestId: string; command: MessageSend; now: number; live: boolean; transcript: readonly Message[] }): Outbox {
  const conversationId = input.command.conversationId;
  const behind = box.some(entry => entry.command.conversationId === conversationId && entry.state === 'queued');
  const entry: OutboxEntry = {
    requestId: input.requestId, command: input.command, state: input.live && !behind ? 'sending' : 'queued', auto: false,
    createdAt: input.now, firstAttemptAt: null, skip: [], error: undefined,
  };
  entry.skip = input.transcript.filter(message => sameText(entry, message)).map(message => message.id);
  return [...box, entry];
}

/** The connection is live again: each queued message gets its one automatic send, in order. */
export function release(box: Outbox): Outbox {
  return box.some(entry => entry.state === 'queued')
    ? box.map(entry => entry.state === 'queued' ? { ...entry, state: 'sending', auto: true } : entry)
    : box;
}

/** What to send next: the first waiting message of each conversation that has nothing in flight. */
export function nextAttempts(box: Outbox, inFlight: ReadonlySet<string>): OutboxEntry[] {
  const busy = new Set(box.filter(entry => inFlight.has(entry.requestId)).map(entry => entry.command.conversationId));
  const next: OutboxEntry[] = [];
  for (const entry of box) {
    if (entry.state !== 'sending' || busy.has(entry.command.conversationId)) continue;
    busy.add(entry.command.conversationId);
    next.push(entry);
  }
  return next;
}

const patch = (box: Outbox, requestId: string, change: (entry: OutboxEntry) => OutboxEntry | null): Outbox => {
  const index = box.findIndex(entry => entry.requestId === requestId);
  if (index < 0) return box;
  const next = change(box[index]!);
  return next ? box.map((entry, at) => at === index ? next : entry) : box.filter((_, at) => at !== index);
};

/** A send is starting. */
export function begin(box: Outbox, requestId: string, now: number): Outbox {
  return patch(box, requestId, entry => entry.state === 'sending' ? { ...entry, firstAttemptAt: entry.firstAttemptAt ?? now, error: undefined } : entry);
}

/**
 * A send ended. A first send that never reached the Host waits for the connection; any other failure,
 * including a failed automatic send, waits for the owner.
 */
export function settle(box: Outbox, requestId: string, outcome: SendOutcome): Outbox {
  return patch(box, requestId, entry => {
    if (entry.state !== 'sending') return entry;
    if (outcome.ok) return { ...entry, state: 'accepted', error: undefined };
    return { ...entry, state: outcome.connectionLost && !entry.auto ? 'queued' : 'failed', error: outcome.error };
  });
}

/** 다시 보내기: the same request id and command; it does not earn another automatic send. */
export function retry(box: Outbox, requestId: string): Outbox {
  return patch(box, requestId, entry => entry.state === 'failed' ? { ...entry, state: 'sending', auto: true, error: undefined } : entry);
}

/** 버리기: the row leaves and its message goes back to the composer. Messages in flight cannot be taken back. */
export function discard(box: Outbox, requestId: string): { box: Outbox; command: MessageSend | null } {
  const entry = box.find(item => item.requestId === requestId);
  if (!entry || (entry.state !== 'queued' && entry.state !== 'failed')) return { box, command: null };
  return { box: box.filter(item => item !== entry), command: entry.command };
}

/**
 * The rows the transcript already shows, each with the message that carries it. Message views carry
 * no request id, so a message matches by conversation, text and time — each transcript message
 * claims at most one row, oldest row first, and only rows that were actually sent.
 */
export function claims(box: Outbox, transcript: readonly Message[]): Map<string, string> {
  const claimed = new Map<string, string>();
  const taken = new Set<string>();
  for (const entry of box) {
    if (entry.firstAttemptAt === null) continue;
    const since = entry.firstAttemptAt - CONFIRM_WINDOW_MS;
    const free = (message: Message) => !taken.has(message.id) && !entry.skip.includes(message.id) && sameText(entry, message);
    // Its own copy first (recorded after the send began). The earlier window only covers clock skew, and never for a
    // failed row: a repeated text must not borrow the previous message's copy and hide that its own send failed.
    const match = transcript.find(message => free(message) && message.createdAt >= entry.firstAttemptAt!)
      ?? (entry.state === 'failed' ? undefined : transcript.find(message => free(message) && message.createdAt >= since));
    if (!match) continue;
    taken.add(match.id);
    claimed.set(entry.requestId, match.id);
  }
  return claimed;
}

/** The transcript shows a sent message: its row retires. */
export function confirm(box: Outbox, transcript: readonly Message[]): Outbox {
  const claimed = claims(box, transcript);
  return claimed.size ? box.filter(entry => !claimed.has(entry.requestId)) : box;
}

/** The rows one conversation shows; the queue's note appears once, on its last row. */
export function rowsFor(box: Outbox, conversationId: string | null): { entry: OutboxEntry; note: boolean }[] {
  const rows = box.filter(entry => entry.command.conversationId === conversationId);
  const last = rows.filter(entry => entry.state === 'queued').at(-1);
  return rows.map(entry => ({ entry, note: entry === last }));
}

// ── Storage ─────────────────────────────────────────────────────────────

/** What one stored row must be; the command is the exact one sent, so its request id stays valid. */
const StoredEntry = Type.Object({
  requestId: CommandRequest.properties.requestId,
  command: Command,
  state: Type.Union([Type.Literal('sending'), Type.Literal('queued'), Type.Literal('failed')]),
  auto: Type.Boolean(),
  createdAt: Timestamp,
  firstAttemptAt: nullable(Timestamp),
  skip: Type.Array(Type.String()),
  error: Type.Optional(Type.String()),
});

function readEntry(value: unknown): OutboxEntry | null {
  // Value.Check, not a compiled checker: the browser build runs without unsafe-eval.
  if (!Check(StoredEntry, value) || value.command.type !== 'message.send') return null;
  // A send cut off by a reload has an unknown outcome; the same request id makes sending it again safe.
  const state: OutboxState = value.state === 'sending' ? (value.auto ? 'failed' : 'queued') : value.state;
  return { ...value, command: value.command, state };
}

export function loadOutbox(storage: Pick<Storage, 'getItem'>): Outbox {
  try {
    const saved: unknown = JSON.parse(storage.getItem(OUTBOX_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.flatMap(item => { const entry = readEntry(item); return entry ? [entry] : []; }) : [];
  } catch { return []; }
}

export function saveOutbox(storage: Pick<Storage, 'setItem' | 'removeItem'>, box: Outbox) {
  const unsent = box.filter(entry => entry.state !== 'accepted');
  try {
    if (unsent.length) storage.setItem(OUTBOX_KEY, JSON.stringify(unsent));
    else storage.removeItem(OUTBOX_KEY);
  } catch { /* Private mode may refuse storage; this screen still keeps the rows. */ }
}

// ── The app's outbox ────────────────────────────────────────────────────

const storage = typeof localStorage === 'undefined' ? null : localStorage;
let box: Outbox = storage ? loadOutbox(storage) : [];
const listeners = new Set<() => void>();
const inFlight = new Set<string>();
let sender: ((command: MessageSend, requestId: string) => Promise<unknown>) | null = null;

const get = () => box;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function commit(next: Outbox) {
  if (next === box) return;
  box = next;
  if (storage) saveOutbox(storage, next);
  for (const listener of listeners) listener();
}

function drive() {
  const send = sender;
  if (!send) return;
  for (const entry of nextAttempts(box, inFlight)) {
    inFlight.add(entry.requestId);
    commit(begin(box, entry.requestId, Date.now()));
    send(entry.command, entry.requestId).then(
      () => commit(settle(box, entry.requestId, { ok: true })),
      (reason: unknown) => commit(settle(box, entry.requestId, {
        ok: false,
        connectionLost: reason instanceof HostError && reason.code === 'network',
        error: reason instanceof Error ? reason.message : String(reason),
      })),
    ).finally(() => { inFlight.delete(entry.requestId); drive(); });
  }
}

/**
 * One conversation's outgoing rows and their actions. Sends run through the Host client; the
 * transcript retires rows the Host has recorded.
 */
export function useOutbox(conversationId: string | null, transcript: readonly Message[]) {
  const { client, store } = useHost();
  const live = useHostState(store).connection === 'live';
  const current = useSyncExternalStore(subscribe, get, get);
  const wasLive = useRef(false);
  // Messages that took the place of an outgoing row: the row already rose in, so the message must not.
  // Kept while this view lives — the mark has to outlive the row, or the entrance would start once it drops.
  const delivered = useRef(new Set<string>());
  // The Host's copy replaces its row in the same render; the store catches up in the effect below.
  const claimed = claims(current, transcript);
  for (const messageId of claimed.values()) delivered.current.add(messageId);

  useEffect(() => {
    const send = (command: MessageSend, requestId: string) => client.send(command, requestId);
    sender = send;
    return () => { if (sender === send) sender = null; };
  }, [client]);
  useEffect(() => {
    if (!live) { wasLive.current = false; return; }
    if (!wasLive.current) { wasLive.current = true; commit(release(box)); return; }
    // A send can fail on the network while the stream stays up, so the store never drops and never comes
    // back live; give such rows their one automatic send after a short pause instead of waiting forever.
    if (!current.some(entry => entry.state === 'queued')) return;
    const timer = setTimeout(() => commit(release(box)), QUEUED_WHILE_LIVE_MS);
    return () => clearTimeout(timer);
  }, [live, current]);
  useEffect(() => { commit(confirm(box, transcript)); }, [transcript]);
  useEffect(() => { drive(); }, [current, client]);

  return {
    rows: rowsFor(claimed.size ? current.filter(entry => !claimed.has(entry.requestId)) : current, conversationId),
    delivered: delivered.current as ReadonlySet<string>,
    post(command: MessageSend) {
      commit(submit(box, { requestId: crypto.randomUUID(), command, now: Date.now(), live, transcript }));
    },
    retry(requestId: string) { commit(retry(box, requestId)); },
    discard(requestId: string): MessageSend | null {
      const result = discard(box, requestId);
      commit(result.box);
      return result.command;
    },
  };
}
