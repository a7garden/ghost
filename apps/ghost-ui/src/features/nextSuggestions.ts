import { useEffect, useRef, useState } from 'react';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';

const none: readonly string[] = [];
/** Lets a status that flickers between turns settle before one billed request is made. */
const SETTLE_MS = 500;

export type SuggestionSource = { kind: 'pane' | 'conversation'; id: string };

/**
 * The owner's likely next messages after the latest reply. One request per anchor (the reply being answered), made only
 * while `ready`; a failed or empty answer simply offers nothing. The Host decides again, so a stale `ready` costs no more
 * than an empty list.
 */
export function useNextSuggestions(source: SuggestionSource | null, anchor: string | null, ready: boolean): readonly string[] {
  const { client, store } = useHost();
  const { state } = useHostState(store);
  const enabled = state?.settings?.nextMessageSuggestions !== false;
  const key = source && anchor ? `${source.kind}:${source.id}:${anchor}` : '';
  const [found, setFound] = useState<{ key: string; items: readonly string[] }>({ key: '', items: none });
  const asked = useRef('');
  const kind = source?.kind, id = source?.id;
  useEffect(() => {
    if (!enabled || !ready || !key || !kind || !id || asked.current === key) return;
    const request = new AbortController();
    const timer = setTimeout(() => {
      const answer = kind === 'pane' ? client.herdrSuggestions(id, request.signal) : client.conversationSuggestions(id, request.signal);
      answer.then(result => {
        if (request.signal.aborted) return;
        asked.current = key;
        setFound({ key, items: result.suggestions });
      }).catch(() => {});
    }, SETTLE_MS);
    return () => { clearTimeout(timer); request.abort(); };
  }, [client, enabled, ready, key, kind, id]);
  return enabled && ready && found.key === key ? found.items : none;
}

/** The newest reply the owner would answer: the last item `isReply` accepts. */
export function lastReply<T>(items: readonly T[], isReply: (item: T) => boolean): T | undefined {
  for (let at = items.length - 1; at >= 0; at--) if (isReply(items[at]!)) return items[at];
  return undefined;
}
