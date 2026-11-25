import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Agent, CodingSession } from '@ghost/contract';
import type { HostClient } from '../host/client';
import { useHost } from '../host/context';

export type Attention = 'waiting' | 'done' | 'failed';
const WAITING = 'waiting';
type FeedCache = { sessions: ReadonlyMap<string, CodingSession>; attention: ReadonlyMap<string, Attention> };
// Retain observations when the owner visits another section, without polling while the workbench is closed.
const feeds = new WeakMap<HostClient, FeedCache>();

export function sessionAttention(before: CodingSession | undefined, next: CodingSession): Attention | null {
  if (next.state === 'waiting' && next.pendingDialog && next.pendingDialog.id !== before?.pendingDialog?.id) return WAITING;
  if (!before || !next.turn) return null;
  const settled = next.turn > before.turn || before.state === 'working' || before.state === 'waiting';
  if (settled && next.state === 'idle') return 'done';
  if (settled && next.state === 'failed') return 'failed';
  return null;
}

export function useWorkbenchAttention(agents: readonly Agent[] | null, focused: string | null) {
  const { client } = useHost();
  const [sessions, setSessions] = useState<ReadonlyMap<string, CodingSession>>(() => feeds.get(client)?.sessions ?? new Map());
  const seen = useRef(new Map(sessions));
  const serial = useRef(0);
  const streamSerial = useRef(new Map<string, number>());
  const [attention, setAttention] = useState<ReadonlyMap<string, Attention>>(() => feeds.get(client)?.attention ?? new Map());
  const [visible, setVisible] = useState(() => !document.hidden);
  const active = visible ? focused : null;
  useEffect(() => { feeds.set(client, { sessions, attention }); }, [client, sessions, attention]);

  const targets = useRef({ agents, active });
  useLayoutEffect(() => { targets.current = { agents, active }; }, [agents, active]);

  const observe = useCallback((rows: CodingSession[], readSerial?: number) => {
    const changed = new Map<string, { session: CodingSession; signal: Attention | null }>();
    for (const session of rows) {
      const before = seen.current.get(session.id);
      if (readSerial !== undefined && (streamSerial.current.get(session.id) ?? 0) > readSerial) continue;
      if (before && (before.updatedAt > session.updatedAt || (before.updatedAt === session.updatedAt && before.state === session.state &&
        before.turn === session.turn && before.title === session.title && before.pendingDialog?.id === session.pendingDialog?.id))) continue;
      seen.current.set(session.id, session);
      changed.set(session.id, { session, signal: sessionAttention(before, session) });
    }
    if (!changed.size) return;
    setSessions(new Map(seen.current));
    const { agents, active } = targets.current;
    if (!agents) return;
    setAttention(previous => {
      const next = new Map(previous);
      for (const { sessionId } of agents) {
        const update = changed.get(sessionId);
        if (!update) continue;
        const { session, signal } = update;
        if (sessionId === active || session.state === 'working' || session.state === 'closed' || (next.get(sessionId) === WAITING && session.state !== 'waiting')) next.delete(sessionId);
        if (signal && sessionId !== active) next.set(sessionId, signal);
      }
      return next;
    });
  }, []);
  // Mounted agents also provide live SSE state; the list covers other spaces in one request.
  const observer = useCallback((session: CodingSession) => {
    streamSerial.current.set(session.id, ++serial.current);
    observe([session]);
  }, [observe]);

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (!agents) return;
    setAttention(previous => {
      const ids = new Set(agents.map(agent => agent.sessionId));
      if (!previous.has(active ?? '') && [...previous.keys()].every(id => ids.has(id))) return previous;
      return new Map([...previous].filter(([id]) => id !== active && ids.has(id)));
    });
  }, [agents, active]);

  const [listError, setListError] = useState('');
  // True once the full session list has been read, so a missing session means it is gone rather than not yet seen.
  const [listed, setListed] = useState(false);
  const [revision, reloadList] = useState(0);
  const hasSessions = Boolean(agents?.length);
  const [showPicker, setShowPicker] = useState(false);
  useEffect(() => {
    if (!hasSessions && !showPicker) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const readSerial = serial.current;
      try {
        const rows = await client.codingSessions(controller.signal);
        if (!controller.signal.aborted) {
          observe(rows, readSerial);
          setListed(true);
          setListError('');
        }
      } catch (reason) {
        if (!controller.signal.aborted) setListError(reason instanceof Error ? reason.message : '세션을 불러오지 못했습니다.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, hasSessions, showPicker, revision, visible, observe]);
  return { sessions, attention, observer, listed, listError, setShowPicker, reloadList: () => reloadList(value => value + 1) };
}
