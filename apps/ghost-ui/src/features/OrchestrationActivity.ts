import { useEffect, useState } from 'react';
import type { CodingItem, CodingSession } from '@ghost/contract';
import type { HostClient } from '../host/client';
import type { Activity } from './OrchestrationGraph';

type Item = Extract<CodingItem, { kind: 'subagent' }>;
type Entry = { session: string; item: Item; finished?: number };
const watching = (session: CodingSession) => session.state === 'working' || session.state === 'waiting';

export function useOrchestrationActivity(client: HostClient) {
  const [sessions, setSessions] = useState<CodingSession[]>([]);
  const [activity, setActivity] = useState<Map<string, Activity>>(() => new Map());
  useEffect(() => {
    const lifecycle = new AbortController();
    const streams = new Map<string, AbortController>();
    const entries = new Map<string, Entry>();
    let polling = false;
    function render() {
      const now = Date.now();
      const byRole = new Map<string, Activity>();
      for (const [id, entry] of entries) {
        if (entry.finished && now - entry.finished > 24_000) { entries.delete(id); continue; }
        const { item } = entry;
        const elapsed = Math.max(0, Math.floor(((entry.finished ?? now) - item.at) / 1000));
        const prior = byRole.get(item.role);
        if (item.status === 'running') byRole.set(item.role, { status: 'running', elapsed: Math.max(elapsed, prior?.status === 'running' ? prior.elapsed : 0), count: 1 + (prior?.status === 'running' ? prior.count : 0) });
        else if (!prior || prior.status !== 'running') byRole.set(item.role, { status: item.status, elapsed, count: 1 });
      }
      setActivity(previous => previous.size || byRole.size ? byRole : previous);
    }
    function clearRunning(session: string) {
      for (const [key, entry] of entries) if (entry.session === session && !entry.finished) entries.delete(key);
    }
    function watch(id: string) {
      const controller = new AbortController();
      streams.set(id, controller);
      const changed = new Set<string>();
      let first = true;
      void client.subscribeCodingSession(id, event => {
        if (controller.signal.aborted) return;
        if (event.type === 'session') {
          if (first && watching(event.session)) {
            void client.codingSessionItems(id, { limit: 100 }, controller.signal).then(({ items }) => {
              if (controller.signal.aborted) return;
              for (const item of items) if (item.kind === 'subagent' && item.status === 'running' && !changed.has(item.id)) entries.set(item.id, { session: id, item });
              render();
            }).catch(() => {});
          }
          first = false;
          if (!watching(event.session)) { clearRunning(id); render(); controller.abort(); }
          return;
        }
        if (event.item.kind !== 'subagent') return;
        const item = event.item;
        changed.add(item.id);
        entries.set(item.id, { session: id, item, ...(item.status === 'running' ? {} : { finished: Date.now() }) });
        render();
      }, controller.signal).catch(() => {}).finally(() => {
        if (streams.get(id) !== controller) return;
        controller.abort();
        streams.delete(id);
        clearRunning(id);
        if (!lifecycle.signal.aborted) render();
      });
    }
    async function discover() {
      if (polling) return;
      polling = true;
      try {
        const next = await client.codingSessions(lifecycle.signal);
        if (lifecycle.signal.aborted) return;
        setSessions(next.filter(session => session.state !== 'closed'));
        const active = new Set(next.filter(watching).map(session => session.id));
        for (const id of active) if (!streams.has(id)) watch(id);
        for (const [id, stream] of streams) if (!active.has(id)) stream.abort();
      } catch { /* Detection retries on the next poll; existing streams can still deliver. */ }
      finally { polling = false; }
    }
    void discover();
    const discovery = setInterval(discover, 2000);
    const clock = setInterval(render, 1000);
    return () => {
      lifecycle.abort();
      clearInterval(discovery); clearInterval(clock);
      for (const stream of streams.values()) stream.abort();
    };
  }, [client]);
  return { sessions, activity };
}
