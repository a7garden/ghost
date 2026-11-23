import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ArrowDown, Braces, CircleAlert, FilePenLine, FileSearch, Globe2, SquareTerminal } from 'lucide-react';
import type { HerdrChat as Chat, HerdrChatItem, HerdrPaneView } from '@ghost/contract';
import { MessageBody } from '../components/MessageBody';
import { useHost } from '../host/context';
import { Button, InlineError } from '../ui';
import { HerdrState } from './herdrDisplay';
import { WorkingTime } from './HerdrParts';
import { elapsedLabel, foldChat, mergeChat, stepLines, type ChatRow } from './herdrInboxModel';
import type { OptimisticPrompt } from './HerdrPromptModel';

/** What a slash command printed, kept beside the conversation (it is not in the agent's record), after the first `afterCount` messages. */
export type CommandOutput = { id: string; afterCount: number; command: string; text: string };
type ChatSnapshot = { items: readonly HerdrChatItem[]; source?: Chat['source']; title?: string | null; model?: string | null };
const emptyItems: readonly HerdrChatItem[] = [];
const emptyChat: ChatSnapshot = { items: emptyItems };
export function useHerdrChat(pane: HerdrPaneView, watching: boolean) {
  const { client } = useHost();
  const [chat, setChat] = useState<ChatSnapshot>(emptyChat);
  const [error, setError] = useState('');
  const cursor = useRef('');
  const [revision, refresh] = useReducer((count: number) => count + 1, 0);
  const busy = pane.status === 'working' || pane.status === 'blocked';
  const id = pane.id;
  const agent = Boolean(pane.agent);
  useEffect(() => {
    if (!agent) { cursor.current = ''; setChat(emptyChat); setError(''); return; }
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      if (!document.hidden) try {
        const delta = await client.herdrChat(id, cursor.current, request.signal);
        if (request.signal.aborted) return;
        cursor.current = delta.source ? delta.cursor : '';
        setChat(current => {
          const items = delta.source ? mergeChat(current.source === delta.source ? current.items : emptyItems, delta) : emptyItems;
          return items === current.items && current.source === delta.source && current.title === delta.title && current.model === delta.model ? current
            : { items, source: delta.source, title: delta.title, model: delta.model };
        });
        setError('');
      } catch (reason) {
        if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : '대화를 불러오지 못했습니다.');
      }
      if (!request.signal.aborted) timer = setTimeout(() => void read(), watching && busy ? 1500 : 6000);
    }
    void read();
    return () => { request.abort(); clearTimeout(timer); };
  }, [agent, busy, client, id, watching, revision]);
  return { chat: agent ? chat : emptyChat, error, refresh };
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
  const failed = row.steps.reduce((count, step) => count + (step.kind === 'tool' && step.ok === false ? 1 : 0), 0);
  return <details className="herdr-chat-steps">
    <summary><span>{row.steps.length}단계{duration && ` · ${duration}`}{failed > 0 && <span className="herdr-chat-steps-failed"> · 실패 {failed}</span>}</span></summary>
    <ul>{stepLines(row.steps).map(({ step, count }) => {
      const failed = step.kind === 'tool' && step.ok === false;
      const Icon = step.kind === 'thinking' ? Braces : failed ? CircleAlert : stepIcon(step.name);
      const label = step.kind === 'thinking' ? '생각' : step.summary || step.name;
      return <li key={step.id} data-failed={failed || undefined}>
        <Icon size={15} aria-hidden="true"/>
        <span>{step.kind === 'tool' && step.summary && <small>{step.name} </small>}<span>{label}</span>{count > 1 && <em> {count}번</em>}</span>
      </li>;
    })}</ul>
  </details>;
}

function renderRow(row: ChatRow) {
  if (row.kind === 'steps') return <Steps row={row}/>;
  if (row.kind === 'note') return <div className="herdr-chat-note">{row.text}</div>;
  return row.kind === 'user' ? <div className="herdr-chat-user" aria-label="내 지시">
    {row.text}{Boolean(row.imageCount) && <small className="herdr-chat-attachment-names">이미지 {row.imageCount}개</small>}
  </div> : <article className="herdr-chat-agent" aria-label="에이전트 응답"><ChatMessage text={row.text}/></article>;
}

function CommandResult({ result, onOpenTerminal }: { result: CommandOutput; onOpenTerminal?(): void }) {
  return <section className="herdr-chat-result" aria-label={`${result.command} 결과`}>
    <header><code>{result.command}</code>{onOpenTerminal && <button type="button" onClick={onOpenTerminal}>터미널에서 보기</button>}</header>
    <pre>{result.text}</pre>
  </section>;
}

const noPrompts: readonly OptimisticPrompt[] = [];

export function isHerdrChatPinned({ scrollHeight, scrollTop, clientHeight }: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>) {
  return scrollHeight - Math.max(0, scrollTop) - clientHeight < 40;
}

function WorkingAfterPause({ items, since }: { items: readonly HerdrChatItem[]; since: number }) {
  const [quiet, setQuiet] = useState<readonly HerdrChatItem[]>();
  useEffect(() => {
    const timer = setTimeout(() => setQuiet(items), 1100);
    return () => clearTimeout(timer);
  }, [items]);
  return quiet === items ? <div className="herdr-chat-working"><HerdrState status="working"/><WorkingTime since={since}/></div> : null;
}

export function HerdrConversation({ items, busy, since, error, results = [], optimistic = noPrompts, pending, onRetry, onTakeBack, onOpenTerminal }: {
  items: readonly HerdrChatItem[]; busy: boolean; since: number; error: string;
  results?: readonly CommandOutput[]; optimistic?: readonly OptimisticPrompt[]; pending?: boolean;
  onRetry?(message: OptimisticPrompt): void; onTakeBack?(message: OptimisticPrompt): void; onOpenTerminal?(): void;
}) {
  const rows = useMemo(() => foldChat(items), [items]);
  // Each result sits where the conversation stood when its command was sent.
  const placed = useMemo(() => results.map(result => ({ result, at: foldChat(items.slice(0, result.afterCount)).length })), [items, results]);
  const scroll = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [following, setFollowing] = useState(true);
  function follow() { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }
  useLayoutEffect(() => { if (pinned.current) follow(); }, [rows, busy, optimistic]);
  useEffect(() => {
    const geometry = new ResizeObserver(() => { if (pinned.current) follow(); });
    if (scroll.current) geometry.observe(scroll.current);
    if (body.current) geometry.observe(body.current);
    return () => geometry.disconnect();
  }, []);
  return <section className="herdr-conversation" aria-label="에이전트 대화">
    <div className="herdr-chat-scroll" ref={scroll} onScroll={event => {
      pinned.current = isHerdrChatPinned(event.currentTarget);
      setFollowing(pinned.current);
    }}>
      <div className="herdr-chat-body" ref={body} onClickCapture={event => {
        if ((event.target as Element).closest('summary')) {
          pinned.current = false;
          requestAnimationFrame(() => {
            const el = scroll.current;
            if (el) setFollowing(pinned.current = isHerdrChatPinned(el));
          });
        }
      }}>
        {rows.map((row, index) => <Fragment key={row.id}>
          {placed.filter(entry => entry.at === index).map(({ result }) => <CommandResult key={result.id} result={result} onOpenTerminal={onOpenTerminal}/>)}
          {renderRow(row)}
        </Fragment>)}
        {placed.filter(entry => entry.at >= rows.length).map(({ result }) => <CommandResult key={result.id} result={result} onOpenTerminal={onOpenTerminal}/>)}
        {optimistic.map(message => <div className="herdr-chat-user" aria-label="내 지시" key={`pending:${message.id}`}
          data-delivery={message.error ? 'failed' : 'pending'}>
          {message.text}
          {message.attachments.map(item => <small key={item.id} className="herdr-chat-attachment-names">{item.file.name}</small>)}
          <div className="herdr-chat-delivery">
            <span role="status">{message.error ? `보내지 못했어요. ${message.error}` : '보내는 중…'}</span>
            {message.error && <>
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => onRetry?.(message)}>다시 보내기</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => onTakeBack?.(message)}>입력창으로</Button>
            </>}
          </div>
        </div>)}
        {busy && <WorkingAfterPause items={items} since={since}/>}
        {error && <InlineError>{error}</InlineError>}
        {!rows.length && !optimistic.length && !busy && !error && <p className="herdr-chat-empty">아직 대화가 없습니다.</p>}
      </div>
    </div>
    {!following && <Button type="button" variant="outline" size="sm" className="herdr-chat-latest" onClick={() => {
      pinned.current = true; setFollowing(true); follow();
    }}><ArrowDown aria-hidden="true"/>최신으로</Button>}
  </section>;
}
