import { useCallback, useEffect, useRef, useState } from 'react';
import type { Live, Message } from '@ghost/contract';
import { useHost } from '../host/context';

export type ConversationFeed = { messages: Message[]; before: string | null; live: Live | null };

/**
 * One conversation's transcript kept current: the latest page, older pages on demand, and live
 * frames (finished messages append; partial text, reasoning and tool output stream until the
 * Ghost's own message retires them — an owner message never ends a generation).
 */
export function useConversationFeed(conversationId: string | null) {
  const { store, client } = useHost();
  const [feed, setFeed] = useState<ConversationFeed>({ messages: [], before: null, live: null });
  const [loading, setLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [error, setError] = useState('');
  const open = useRef(conversationId);
  open.current = conversationId;

  const load = useCallback(async (id: string, before?: string | null) => {
    if (before === undefined) { setLoading(true); setFeed({ messages: [], before: null, live: null }); }
    else setOlderLoading(true);
    try {
      const next = await client.conversation(id, before ?? undefined);
      if (open.current !== id) return;
      setFeed(current => before
        ? { messages: [...next.messages, ...current.messages], before: next.before, live: next.live ?? current.live }
        : { messages: next.messages, before: next.before, live: next.live });
    } catch (e) {
      if (open.current === id) setError(e instanceof Error ? e.message : '대화 기록을 읽지 못했습니다.');
    } finally {
      if (before !== undefined) setOlderLoading(false); else setLoading(false);
    }
  }, [client]);

  useEffect(() => { setError(''); if (conversationId) void load(conversationId); else setFeed({ messages: [], before: null, live: null }); }, [conversationId, load]);

  useEffect(() => {
    if (!conversationId) return;
    return store.watchConversation(conversationId, event => {
      if (open.current !== conversationId) return;
      if (event.type === 'message') {
        const message = event.message;
        setFeed(current => {
          const index = current.messages.findIndex(item => item.id === message.id);
          const messages = index < 0 ? [...current.messages, message] : current.messages.map((item, at) => at === index ? message : item);
          return { ...current, messages, live: message.role === 'user' ? current.live : null };
        });
      } else setFeed(current => ({ ...current, live: event.live }));
    });
  }, [store, conversationId]);

  const loadOlder = () => { if (conversationId && feed.before) void load(conversationId, feed.before); };
  return { feed, loading, olderLoading, loadOlder, error, setError };
}
