import { useCallback, useEffect, useRef, useState } from 'react';
import type { HerdrView } from '@ghost/contract';
import { useHost } from '../host/context';
import { HostError } from '../host/client';

export function blockedAgentCount(view: HerdrView | null) {
  let count = 0;
  if (view?.available && !view.note) for (const workspace of view.workspaces) for (const tab of workspace.tabs) for (const pane of tab.panes) {
    if (pane.agent && pane.status === 'blocked') count++;
  }
  return count;
}

export function useHerdrAttention(connected: boolean, codingOpen: boolean) {
  const { client } = useHost();
  const available = useRef<boolean | undefined>(undefined);
  const [attention, setAttention] = useState<{ count: number; session: string | null }>({ count: 0, session: null });
  const reportRoster = useCallback((view: HerdrView) => {
    available.current = view.available;
    const count = blockedAgentCount(view);
    const session = view.available ? view.session : null;
    setAttention(previous => previous.count === count && previous.session === session ? previous : { count, session });
  }, []);

  useEffect(() => {
    if (!connected) { available.current = undefined; return; }
    // The Coding page already polls more frequently and feeds its roster into this hook.
    if (codingOpen) return;
    let timer: ReturnType<typeof setTimeout>;
    let pending: AbortController | undefined;
    function pause() { clearTimeout(timer); pending?.abort(); pending = undefined; }
    async function read() {
      if (document.hidden || pending || available.current === false) return;
      const request = new AbortController();
      pending = request;
      let keepPolling = Boolean(available.current);
      try {
        const view = await client.herdr(request.signal);
        if (!request.signal.aborted) {
          keepPolling = view.available;
          reportRoster(view);
        }
      } catch (reason) {
        if (!request.signal.aborted && reason instanceof HostError && reason.code === 'unavailable') {
          keepPolling = available.current = false;
          setAttention({ count: 0, session: null });
        }
      } finally {
        if (!request.signal.aborted) {
          pending = undefined;
          if (keepPolling && !document.hidden) timer = setTimeout(() => void read(), 10_000);
        }
      }
    }
    const visibility = () => { if (document.hidden) pause(); else void read(); };
    document.addEventListener('visibilitychange', visibility);
    void read();
    return () => { pause(); document.removeEventListener('visibilitychange', visibility); };
  }, [client, codingOpen, connected, reportRoster]);

  return { count: connected ? attention.count : 0, session: connected ? attention.session : null, reportRoster };
}
