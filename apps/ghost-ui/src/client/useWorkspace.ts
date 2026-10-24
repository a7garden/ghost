import { useCallback, useEffect, useRef, useState } from 'react';
import { CommandQueue, connect } from './api';
import { subscribeHostEvents } from './hostEvents';
import { RoutingClient } from './routingClient';
import type { RoutingConnection } from '../features/RoutingConversation';
import type { Client, Command, Snapshot } from './types';

// At most the host's MAX_EVENTS_WAIT_MS (25s); the bridge aborts its upstream
// at 35s and the client deadline is 40s — keep the headroom chain in sync.
const EVENTS_WAIT_MS = 25000;

export function useWorkspace(connectClient: () => Promise<Client> = connect) {
  const client = useRef<Client | null>(null), queue = useRef<CommandQueue | null>(null);
  const queueWorkspace = useRef('');
  const [routing, setRouting] = useState<RoutingConnection>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  const mutation = useRef(false), revision = useRef(0);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    let polling = false, refreshQueued = false, failures = 0, unsubEvents: (() => void) | null = null, eventProfiles = '';
    // Host events only mark freshness: any commit wakes the snapshot poll so
    // the fixed 1.8s cycle becomes event-driven with a slow safety fallback.
    const wake = () => { refreshQueued = true; if (!polling && alive) { clearTimeout(timer); timer = setTimeout(poll, 0); } };
    const syncEvents = (result: Snapshot) => {
      if (client.current?.mode !== 'live' || typeof client.current.events !== 'function') return;
      const ids = result.profiles.map(p => p.id).sort();
      const key = ids.join(',');
      if (key === eventProfiles) return;
      eventProfiles = key;
      unsubEvents?.();
      unsubEvents = subscribeHostEvents(
        // At most the host's MAX_EVENTS_WAIT_MS (25s); the bridge aborts its
        // upstream at 35s and the client deadline is 40s — keep in sync.
        (profileId, after, signal) => client.current!.events!(profileId, after, EVENTS_WAIT_MS, signal),
        ids,
        wake,
      );
    };
    const poll = async () => {
      if (polling) { refreshQueued = true; return; }
      polling = true;
      const captured = revision.current;
      try {
        const result = await client.current!.snapshot(abort.signal);
        if (alive && captured === revision.current && !mutation.current) {
          if (!queue.current || queueWorkspace.current !== result.workspace_id) {
            queue.current = new CommandQueue(localStorage, `ghost-ui:pending:${result.workspace_id}`);
            queueWorkspace.current = result.workspace_id;
          }
          if (client.current?.routing) {
            const routingClient = new RoutingClient(client.current.routing, queue.current);
            const capability = await routingClient.capability();
            if (!alive || captured !== revision.current || mutation.current) return;
            setRouting(capability.admission ? { client: routingClient, capability, inputAvailable: client.current.routing.canPrepareInput === true } : undefined);
          } else setRouting(undefined);
          setSnapshot(result); setError(''); failures = 0;
          syncEvents(result);
        }
      } catch (e) { if (alive) { failures += 1; if (client.current?.routing) setRouting(undefined); setError(e instanceof Error ? e.message : '연결을 확인해 주세요.'); } }
      finally {
        polling = false;
        if (alive) {
          // Priority: a queued event wake beats error retry beats visibility.
          let delay = document.hidden ? 10000 : 30000;
          if (failures > 0) delay = 5000;
          if (refreshQueued) delay = 500;
          refreshQueued = false;
          timer = setTimeout(poll, delay);
        }
      }
    };
    setRouting(undefined);
    connectClient().then(c => { if (alive) { client.current = c; setMode(c.mode); void poll(); } }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; abort.abort(); clearTimeout(timer); unsubEvents?.(); };
  }, [attempt, connectClient]);
  const action = useCallback(async (command: Command) => {
    if (!client.current || !queue.current) throw new Error('호스트 연결을 기다려 주세요.');
    if (mutation.current) throw new Error('이전 요청이 저장되는 중입니다. 잠시만 기다려 주세요.');
    mutation.current = true; revision.current++; setBusy(true);
    try {
      const result = await queue.current.send(client.current, command);
      // A confirmed command stays successful even when the following read fails.
      // Treating that read failure as a command failure could invite a duplicate.
      try { setSnapshot(await client.current.snapshot()); setError(''); }
      catch { setError('요청은 저장됐지만 최신 화면을 불러오지 못했습니다. 다시 연결하고 있어요.'); }
      return result as Record<string, any>;
    } finally { mutation.current = false; revision.current++; setBusy(false); }
  }, []);
  const query = useCallback(async (command: Command) => {
    const operation = command.action as { type?: string } | undefined;
    if (command.type !== 'workspace' || !['list_pages', 'read_page', 'collaboration_messages', 'read_avatar', 'list_connected_planner', 'planner_operation_status', 'planner_sync_status'].includes(operation?.type ?? '')) throw new Error('읽기 전용 요청이 아닙니다.');
    if (!client.current) throw new Error('호스트 연결을 기다려 주세요.');
    return await client.current.action({ request_id: crypto.randomUUID(), command }) as Record<string, any>;
  }, []);
  return { routing, snapshot, mode, error, busy, action, query, reconnect: () => setAttempt(n => n + 1) };
}
