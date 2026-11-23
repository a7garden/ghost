import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CodingSession, Pane } from '@ghost/contract';
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

export function useWorkbenchAttention(panes: readonly Pane[] | null, focused: string | null) {
  const { client } = useHost();
  const [sessions, setSessions] = useState<ReadonlyMap<string, CodingSession>>(() => feeds.get(client)?.sessions ?? new Map());
  const seen = useRef(new Map(sessions));
  const serial = useRef(0);
  const streamSerial = useRef(new Map<string, number>());
  const [attention, setAttention] = useState<ReadonlyMap<string, Attention>>(() => feeds.get(client)?.attention ?? new Map());
  const [visible, setVisible] = useState(() => !document.hidden);
  const active = visible ? focused : null;
  useEffect(() => { feeds.set(client, { sessions, attention }); }, [client, sessions, attention]);

  const targets = useRef({ panes, active });
  useLayoutEffect(() => { targets.current = { panes, active }; }, [panes, active]);

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
    const { panes, active } = targets.current;
    if (!panes) return;
    setAttention(previous => {
      const next = new Map(previous);
      for (const pane of panes) {
        if (pane.kind !== 'session') continue;
        const update = changed.get(pane.sessionId);
        if (!update) continue;
        const { session, signal } = update;
        if (pane.id === active || session.state === 'working' || session.state === 'closed' || (next.get(pane.id) === WAITING && session.state !== 'waiting')) next.delete(pane.id);
        if (signal && pane.id !== active) next.set(pane.id, signal);
      }
      return next;
    });
  }, []);
  // Mounted panes also provide live SSE state; the list covers other tabs and spaces in one request.
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
    if (!panes) return;
    setAttention(previous => {
      const ids = new Set(panes.map(pane => pane.id));
      if (!previous.has(active ?? '') && [...previous.keys()].every(id => ids.has(id))) return previous;
      return new Map([...previous].filter(([id]) => id !== active && ids.has(id)));
    });
  }, [panes, active]);

  const [listError, setListError] = useState('');
  const [revision, reloadList] = useState(0);
  const hasSessions = panes?.some(pane => pane.kind === 'session') ?? false;
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
  return { sessions, attention, observer, listError, setShowPicker, reloadList: () => reloadList(value => value + 1) };
}
