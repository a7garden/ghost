import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, LayoutList, Square, SquarePen, X, CircleAlert } from 'lucide-react';
import { Button, Composer, Conversation, Popover, PopoverContent, PopoverTrigger } from '../ui'
import type { Conversation as ConversationRow, Ghost, Live, Message, State } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { GhostProfile } from '../components/GhostProfile';
import { projectGhostActivity } from '../components/AgentStatus';
import { Transcript, ToolTrail } from '../components/TranscriptMessage';
import { MessageBody } from '../components/MessageBody';
import { GhostCharacter } from '../pets/GhostCharacter';
import { ModelPicker } from '../pets/ModelPicker';
import { GhostDesignEditor } from './GhostDesign';
import { conversationStarters } from './conversationSuggestions';
import { profileSummary } from './profileSummary';
import { ghostPresence, toneFor } from './ghostState';
import { relativeTime, useNow } from './time';
import { uiTerms } from '../uiText';
import { useHost } from '../host/context';

type Page = { messages: Message[]; before: string | null; live: Live | null };

/** The owner's direct conversation with one Ghost: transcript, live generation, composer. */
export function GhostChat({ ghost, state, conversationId, navigate }: {
  ghost: Ghost;
  state: State;
  /** The conversation on screen; null when this Ghost has none yet. */
  conversationId: string | null;
  navigate(path: string): void;
}) {
  const { store, client } = useHost();
  const conversations = state.conversations
    .filter(conversation => conversation.ghostId === ghost.id && conversation.kind === 'direct')
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const [page, setPage] = useState<Page>({ messages: [], before: null, live: null });
  const [loading, setLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const openConversation = useRef(conversationId);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  openConversation.current = conversationId;
  useEffect(() => { if (!sending) inputRef.current?.focus(); }, [sending]);

  const load = useCallback(async (id: string, before?: string | null) => {
    if (before === undefined) { setLoading(true); setPage({ messages: [], before: null, live: null }); }
    else setOlderLoading(true);
    try {
      const next = await client.conversation(id, before ?? undefined);
      if (openConversation.current !== id) return;
      setPage(current => before
        ? { messages: [...next.messages, ...current.messages], before: next.before, live: next.live ?? current.live }
        : { messages: next.messages, before: next.before, live: next.live });
    } catch (e) {
      if (openConversation.current === id) setError(e instanceof Error ? e.message : '대화 기록을 읽지 못했습니다.');
    } finally {
      if (before !== undefined) setOlderLoading(false); else setLoading(false);
    }
  }, [client]);

  useEffect(() => { if (conversationId) void load(conversationId); else setPage({ messages: [], before: null, live: null }); }, [conversationId, load]);

  // Live frames: finished messages append to the transcript, partial text and tool output stream under them.
  useEffect(() => {
    if (!conversationId) return;
    return store.watchConversation(conversationId, event => {
      if (openConversation.current !== conversationId) return;
      if (event.type === 'message') {
        const message = event.message;
        setPage(current => {
          const index = current.messages.findIndex(item => item.id === message.id);
          const messages = index < 0 ? [...current.messages, message]
            : current.messages.map((item, at) => at === index ? message : item);
          return { ...current, messages, live: null };
        });
      } else setPage(current => ({ ...current, live: event.live }));
    });
  }, [store, conversationId]);

  const run = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.'); } };
  const send = (value: string) => {
    if (!conversationId || !value.trim() || sending) return;
    setSending(true);
    void run(async () => {
      await client.send({ type: 'message.send', conversationId, text: value });
      setDraft('');
    }).finally(() => setSending(false));
  };
  const stop = () => { if (conversationId) void run(() => client.send({ type: 'message.cancel', conversationId })); };
  const startConversation = () => void run(async () => {
    const created = await client.send<{ conversationId: string }>({ type: 'conversation.create', ghostId: ghost.id });
    navigate(`/ghosts/${encodeURIComponent(ghost.id)}?conversation=${encodeURIComponent(created.conversationId)}`);
  });
  const openHistory = (id: string) => navigate(`/ghosts/${encodeURIComponent(ghost.id)}?conversation=${encodeURIComponent(id)}`);

  const live = page.live;
  const hasContent = page.messages.length > 0 || Boolean(live?.running);
  const speaker = (message: Message) => message.role === 'user' ? '나' : message.role === 'tool' ? '도구 기록' : message.role === 'note' ? '기록' : ghost.name;
  const currentConversation = conversations.find(conversation => conversation.id === conversationId);
  const busy = Boolean(currentConversation?.busy);
  const running = busy || Boolean(live?.running);
  const title = currentConversation?.title && currentConversation.title !== ghost.name ? currentConversation.title : '대화';

  return <div className="flex h-full min-h-0 w-full min-w-0">
    <Conversation label={`${ghost.name}와 대화`} transcriptLabel={uiTerms.conversationHistory} jumpToLatestLabel="최신 메시지"
      scrollKey={page.messages.length + (live?.partial ? 1 : 0)}
      header={<div className="chat-head">
        <GhostProfile ghostID={ghost.id} name={ghost.name} summary={profileSummary(ghost.persona)} presence={ghostPresence(ghost, state).state}
          activity={{ model: projectGhostActivity(ghost, state), onInspectWork: workId => navigate(`/work/${encodeURIComponent(workId)}`), onCancelTurn: () => stop() }}
          onOpenWork={() => navigate(`/work?ghost=${encodeURIComponent(ghost.id)}`)}
          onManage={() => navigate(`/settings?tab=team&ghost=${encodeURIComponent(ghost.id)}`)}
          design={<GhostDesignEditor ghostId={ghost.id}/>}
          isMain={ghost.isDefault}/>
        <div className="chat-head__copy">
          <h1 className="chat-head__name">{ghost.name}</h1>
          <ConversationSwitcher title={title} conversations={conversations} currentId={conversationId} onOpen={openHistory} onNew={startConversation}/>
        </div>
        <div className="chat-head__actions">
          <button type="button" className="shell-icon-button" aria-label={`${ghost.name}에게 맡긴 일`} title={uiTerms.work} onClick={() => navigate(`/work?ghost=${encodeURIComponent(ghost.id)}`)}><LayoutList aria-hidden="true"/></button>
          <button type="button" className="shell-icon-button" aria-label="새 대화" title="새 대화" onClick={startConversation}><SquarePen aria-hidden="true"/></button>
        </div>
      </div>}
      composer={<Composer inputId="message-input" inputRef={inputRef} value={draft} onValueChange={setDraft} onSubmit={send}
        label={`${ghost.name}에게 메시지`} placeholder={running ? '응답 중에도 덧붙일 수 있습니다' : `${ghost.name}에게 메시지`} submitLabel="메시지 보내기"
        disabled={!conversationId} pending={sending} running={running} describedBy="composer-keyboard-help"
        footer={conversationId && <ModelPicker conversationId={conversationId} value={currentConversation?.model} disabled={sending}/>}
        trailing={running ? <button type="button" className="chat-stop" aria-label="응답 취소" title="응답 취소" onClick={stop}><Square aria-hidden="true"/></button> : undefined}/>}
      footer={<>
        {error && <div className="chat-error" role="alert"><CircleAlert size={15} aria-hidden="true"/><span>{error}</span><Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" aria-label="오류 메시지 닫기" onClick={() => setError('')}><X size={14}/></Button></div>}
        <p id="composer-keyboard-help" className="sr-only m-0">Enter로 보내기 · Shift + Enter로 줄바꿈{busy ? ' · 추가 지시는 진행 중인 응답에 전달됩니다.' : ''}</p>
      </>}>
      {!hasContent && !loading && <div className="chat-empty">
        <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={56}/>
        <h2>{ghost.name}</h2>
        {ghost.persona.trim() && <div className="chat-empty__starters" role="group" aria-label="대화 시작 제안">{conversationStarters(ghost.persona).map(({ label, prompt }) =>
          <button type="button" key={label} title={prompt} onClick={() => { setDraft(prompt); inputRef.current?.focus(); }}>{label}</button>)}</div>}
      </div>}
      {loading && <div className="chat-loading" aria-busy="true"><span/><span/><span/><span className="sr-only">대화 기록을 읽는 중</span></div>}
      {conversationId && page.before && <div className="grid justify-items-center">
        <button type="button" className="link-quiet" disabled={olderLoading} onClick={() => void load(conversationId, page.before)}>{olderLoading ? '불러오는 중…' : '이전 메시지'}</button>
      </div>}
      <Transcript messages={page.messages} speaker={speaker}
        onUiSubmit={message => message.conversationId === conversationId ? async (text, requestId) => {
          await client.send({ type: 'message.send', conversationId: message.conversationId, text }, requestId);
        } : undefined}/>
      {live?.running && live.tools.length > 0 && <ToolTrail results={[]} running={live.tools}/>}
      {live?.running && <article className="ghost-conversation-message chat-live" data-role="assistant" aria-label={`${ghost.name} · 응답 작성 중`} aria-busy="true">
        {live.partial
          ? <div className="ghost-conversation-message__content chat-live__text"><MessageBody text={live.partial}/></div>
          : <div className="chat-thinking" role="status"><GhostCharacter size={20} state="running" color={ghost.look.body}/><span>응답 중</span></div>}
      </article>}
    </Conversation>
  </div>;
}

/** The conversation title opens the Ghost's earlier conversations in place, with a fresh one at hand. */
function ConversationSwitcher({ title, conversations, currentId, onOpen, onNew }: {
  title: string;
  conversations: ConversationRow[];
  currentId: string | null;
  onOpen(id: string): void;
  onNew(): void;
}) {
  const [open, setOpen] = useState(false);
  const now = useNow(60_000);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" className="chat-head__switch" aria-label={`${uiTerms.conversationHistory}: ${title}`}>
        <span className="truncate">{title}</span><ChevronDown size={13} aria-hidden="true"/>
      </button>
    </PopoverTrigger>
    <PopoverContent side="bottom" align="start" aria-label={uiTerms.conversationHistory} className="grid w-72 gap-0.5 p-1.5">
      <div className="max-h-[50dvh] overflow-y-auto">
        {conversations.map(conversation => <button key={conversation.id} type="button" aria-pressed={conversation.id === currentId} className="menu-row w-full"
          onClick={() => { setOpen(false); onOpen(conversation.id); }}>
          <span className="min-w-0 flex-1 truncate">{conversation.title || '대화'}</span>
          {conversation.busy ? <span className="chat-head__busy" aria-label="응답 중"/> : <time className="shrink-0 text-micro text-ink-3 tabular">{relativeTime(conversation.lastActivityAt, now)}</time>}
          {conversation.id === currentId && <Check size={14} className="shrink-0" aria-hidden="true"/>}
        </button>)}
      </div>
      <button type="button" className="menu-row mt-1 border-t border-line pt-1" onClick={() => { setOpen(false); onNew(); }}><SquarePen size={15} aria-hidden="true"/>새 대화</button>
    </PopoverContent>
  </Popover>;
}
