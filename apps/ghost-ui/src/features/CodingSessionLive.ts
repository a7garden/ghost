import { useEffect, useReducer, useState } from 'react';
import type { CodingItem, CodingSession } from '@ghost/contract';
import { HostError, type CodingLastModel, type CodingSessionModel, type HostClient } from '../host/client';
import { useHost } from '../host/context';
import { codingError, mergeCodingItems, upsertCodingItem } from './CodingSessionModel';

const PAGE_SIZE = 100;

async function readHistory(client: HostClient, id: string, signal: AbortSignal) {
  const history: CodingItem[] = [];
  for (let after = ''; ;) {
    const { items } = await client.codingSessionItems(id, { after, limit: PAGE_SIZE }, signal);
    history.push(...items);
    const last = items.at(-1)?.id;
    if (items.length < PAGE_SIZE || !last || last === after) return history;
    after = last;
  }
}

export function useCodingSessionLive(id: string) {
  const { client } = useHost();
  const [session, setSession] = useState<CodingSession | null>(null);
  const [items, setItems] = useState<readonly CodingItem[]>([]);
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [changesRevision, refreshChanges] = useReducer((value: number) => value + 1, 0);
  const [attempt, reconnect] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    let stopped = false;
    let connection: AbortController;
    let timer: ReturnType<typeof setTimeout>;
    let retryDelay = 1000;
    async function connect() {
      const request = new AbortController();
      connection = request;
      let buffered: Map<string, CodingItem> | null = new Map();
      let sync: Promise<void> | undefined;
      let failed: unknown;
      try {
        await client.subscribeCodingSession(id, event => {
          if (request.signal.aborted) return;
          if (event.type === 'session') {
            setSession(event.session);
            sync ??= readHistory(client, id, request.signal).then(history => {
              if (!buffered || request.signal.aborted) return;
              setItems(mergeCodingItems(history, buffered.values()));
              buffered = null;
              setReady(true);
              setConnected(true);
              setError('');
              refreshChanges();
              retryDelay = 1000;
            }).catch(reason => { failed = reason; request.abort(); });
          } else if (buffered) {
            buffered.set(event.item.id, event.item);
          } else {
            setItems(items => upsertCodingItem(items, event.item));
            if (event.item.kind === 'tool' && event.item.status !== 'running') refreshChanges();
          }
        }, request.signal);
      } catch (reason) {
        failed ??= reason;
      }
      await sync;
      request.abort();
      if (stopped) return;
      setConnected(false);
      setError(failed instanceof HostError ? failed.message : '세션 연결이 끊겼습니다.');
      if (failed instanceof HostError && (failed.code === 'not_found' || failed.code === 'forbidden')) return;
      timer = setTimeout(() => void connect(), retryDelay);
      retryDelay = Math.min(retryDelay * 2, 8000);
    }
    const onVisible = () => { if (document.visibilityState === 'visible') reconnect(); };
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', onVisible);
    setConnected(false);
    void connect();
    return () => {
      stopped = true;
      connection.abort();
      clearTimeout(timer);
      window.removeEventListener('online', reconnect);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [client, id, attempt]);

  // A response may arrive after a newer stream update; never roll the session back.
  const applyResponse = (before: CodingSession, next: CodingSession) => {
    setSession(current => current === before ? next : current);
  };
  return { session, items, ready, connected, error, reconnect, changesRevision, refreshChanges, applyResponse };
}

export function useEmbeddedModels(enabled: boolean) {
  const { client } = useHost();
  const [models, setModels] = useState<CodingSessionModel[] | null>(null);
  const [last, setLast] = useState<CodingLastModel | null>(null);
  const [error, setError] = useState('');
  const [attempt, reload] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (!enabled) return;
    const request = new AbortController();
    void client.codingModels(request.signal).then(({ models, last }) => {
      if (request.signal.aborted) return;
      setModels(models);
      setLast(last);
      setError('');
    }, reason => {
      if (!request.signal.aborted) setError(codingError(reason, '모델을 불러오지 못했습니다.'));
    });
    return () => request.abort();
  }, [client, enabled, attempt]);
  return { models, last, error, reload };
}
