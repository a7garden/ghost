import { useCallback, useEffect, useRef, useState } from 'react';
import { CommandQueue, connect } from './api';
import { RoutingClient } from './routingClient';
import type { RoutingConnection } from '../features/RoutingConversation';
import type { Client, Command, Envelope, Snapshot } from './types';

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
    const poll = async () => {
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
            if (!alive || captured !== revision.current || mutation.current) {
              if (alive) timer = setTimeout(poll, document.hidden ? 10000 : 1800);
              return;
            }
            setRouting(capability.admission ? { client: routingClient, capability, inputAvailable: client.current.routing.canPrepareInput === true } : undefined);
          } else setRouting(undefined);
          setSnapshot(result); setError('');
        }
      } catch (e) { if (alive) { if (client.current?.routing) setRouting(undefined); setError(e instanceof Error ? e.message : '연결을 확인해 주세요.'); } }
      if (alive) timer = setTimeout(poll, document.hidden ? 10000 : 1800);
    };
    setRouting(undefined);
    connectClient().then(c => { if (alive) { client.current = c; setMode(c.mode); void poll(); } }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; abort.abort(); clearTimeout(timer); };
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
      catch { setError('요청은 저장됐지만 최신 화면을 불러오지 못했습니다. 다시 연결하고 있습니다.'); }
      return result as Record<string, any>;
    } finally { mutation.current = false; revision.current++; setBusy(false); }
  }, []);
  const query = useCallback(async (command: Command) => {
    const operation = command.action as { type?: string } | undefined;
    if (command.type !== 'workspace' || !['list_pages', 'read_page', 'collaboration_messages', 'read_avatar', 'list_connected_planner', 'planner_operation_status', 'planner_sync_status'].includes(operation?.type ?? '')) throw new Error('읽기 전용 요청이 아닙니다.');
    if (!client.current) throw new Error('호스트 연결을 기다려 주세요.');
    return await client.current.action({ request_id: crypto.randomUUID(), command }) as Record<string, any>;
  }, []);
  const lifetimeAction = useCallback(async (envelope: Envelope) => {
    if (!client.current || client.current.mode !== 'live') throw new Error('Lifetime 접수는 연결된 Ghost 호스트가 필요합니다.');
    const result = await client.current.action(envelope);
    // lifetime 뮤테이션도 문서 검토·인박스를 바꾸므로 성공 후 스냅샷을 동기화한다.
    // 갱신 실패는 주기 폴링이 회복하므로 원 요청의 결과를 그대로 돌려준다.
    try { setSnapshot(await client.current.snapshot()); setError(''); } catch { /* 다음 폴링 */ }
    return result;
  }, []);
  return { routing, snapshot, mode, error, busy, action, query, lifetimeAction, reconnect: () => setAttempt(n => n + 1) };
}
