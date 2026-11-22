import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Braces, ChevronRight, CircleAlert, FilePenLine, FileSearch, Globe2, SquareTerminal } from 'lucide-react';
import type { HerdrChat as Chat, HerdrChatItem, HerdrPaneView } from '@ghost/contract';
import { MessageBody } from '../components/MessageBody';
import { useHost } from '../host/context';
import { Button, InlineError } from '../ui';
import { HerdrState } from './herdrDisplay';
import { WorkingTime } from './HerdrInbox';
import { elapsedLabel, foldChat, mergeChat, type ChatRow } from './herdrInboxModel';

type ChatSnapshot = { items: readonly HerdrChatItem[]; source?: Chat['source']; title?: string | null };
const emptyItems: readonly HerdrChatItem[] = [];
export function useHerdrChat(pane: HerdrPaneView, watching: boolean) {
  const { client } = useHost();
  const [chat, setChat] = useState<ChatSnapshot>({ items: emptyItems });
  const [error, setError] = useState('');
  const cursor = useRef('');
  const busy = pane.status === 'working' || pane.status === 'blocked';
  const id = pane.id;
  const agent = Boolean(pane.agent);
  useEffect(() => {
    if (!agent) return;
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      if (!document.hidden) try {
        const delta = await client.herdrChat(id, cursor.current, request.signal);
        if (request.signal.aborted) return;
        cursor.current = delta.source ? delta.cursor : '';
        setChat(current => {
          const items = delta.source ? mergeChat(current.source === delta.source ? current.items : emptyItems, delta) : emptyItems;
          return items === current.items && current.source === delta.source && current.title === delta.title ? current
            : { items, source: delta.source, title: delta.title };
        });
        setError('');
      } catch (reason) {
        if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : '대화를 불러오지 못했습니다.');
      }
      if (!request.signal.aborted) timer = setTimeout(() => void read(), watching && busy ? 1500 : 6000);
    }
    void read();
    return () => { request.abort(); clearTimeout(timer); };
  }, [agent, busy, client, id, watching]);
  return { chat, error };
}

const ChatMessage = memo(function ChatMessage({ text }: { text: string }) { return <MessageBody text={text}/>; });
function stepIcon(name: string) {
  if (/bash|shell|terminal|command|exec/i.test(name)) return SquareTerminal;
  if (/grep|search|read|glob|find/i.test(name)) return FileSearch;
  if (/edit|write|patch/i.test(name)) return FilePenLine;
  if (/web|url|browser/i.test(name)) return Globe2;
  return Braces;
}

function Steps({ row }: { row: Extract<ChatRow, { kind: 'steps' }> }) {
  const duration = row.from !== null && row.to !== null ? elapsedLabel(row.from, row.to) : '';
  return <details className="herdr-chat-steps">
    <summary><ChevronRight size={15} aria-hidden="true"/>{row.steps.length}단계{duration && ` · ${duration}`}</summary>
    <ul>{row.steps.map(item => {
      const Icon = item.kind === 'thinking' ? Braces : item.ok === false ? CircleAlert : stepIcon(item.name);
      return <li key={item.id} data-failed={item.kind === 'tool' && item.ok === false || undefined}>
        <Icon size={15} aria-hidden="true"/>
        {item.kind === 'thinking' ? <span>생각</span> : <span title={item.summary || item.name}>{item.summary || item.name}</span>}
      </li>;
    })}</ul>
  </details>;
}

export function HerdrConversation({ items, busy, since, error }: {
  items: readonly HerdrChatItem[]; busy: boolean; since: number; error: string;
}) {
  const rows = useMemo(() => foldChat(items), [items]);
  const scroll = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [following, setFollowing] = useState(true);
  function follow() { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }
  useLayoutEffect(() => { if (pinned.current) follow(); }, [rows, busy]);
  useEffect(() => {
    const geometry = new ResizeObserver(() => { if (pinned.current) follow(); });
    if (scroll.current) geometry.observe(scroll.current);
    if (body.current) geometry.observe(body.current);
    return () => geometry.disconnect();
  }, []);
  return <section className="herdr-conversation" aria-label="에이전트 대화">
    <div className="herdr-chat-scroll" ref={scroll} onScroll={event => {
      const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
      pinned.current = scrollHeight - Math.max(0, scrollTop) - clientHeight < 40;
      setFollowing(pinned.current);
    }}>
      <div className="herdr-chat-body" ref={body}>
        {rows.map(row => {
          if (row.kind === 'steps') return <Steps key={row.id} row={row}/>;
          if (row.kind === 'note') return <div key={row.id} className="herdr-chat-note">{row.text}</div>;
          return row.kind === 'user' ? <div key={row.id} className="herdr-chat-user" aria-label="내 지시">{row.text}</div>
            : <article key={row.id} className="herdr-chat-agent" aria-label="에이전트 응답"><ChatMessage text={row.text}/></article>;
        })}
        {busy && <div className="herdr-chat-working"><HerdrState status="working"/><WorkingTime since={since}/></div>}
        {error && <InlineError>{error}</InlineError>}
        {!rows.length && !busy && !error && <p className="herdr-chat-empty">아직 대화가 없습니다.</p>}
      </div>
    </div>
    {!following && <Button type="button" variant="outline" size="sm" className="herdr-chat-latest" onClick={() => {
      pinned.current = true; setFollowing(true); follow();
    }}><ArrowDown aria-hidden="true"/>최신으로</Button>}
  </section>;
}
