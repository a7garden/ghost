import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CircleAlert, GitBranch, Square, X } from 'lucide-react';
import { Button, Composer, Conversation, Popover, PopoverContent, PopoverTrigger } from '../ui'
import { TERMINAL_WORK_STATES, type Conversation as ConversationRow, type Ghost, type Live, type Message, type State, type Work } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { GhostProfile } from '../components/GhostProfile';
import { projectGhostActivity } from '../components/AgentStatus';
import { StateGlyph, ThreadCard, workGlyph } from '../components/agent';
import { Reasoning, Transcript, ToolTrail, type TranscriptExtra } from '../components/TranscriptMessage';
import { MessageBody } from '../components/MessageBody';
import { ModelPicker } from '../pets/ModelPicker';
import { GhostDesignEditor } from './GhostDesign';
import { conversationStarters } from './conversationSuggestions';
import { profileSummary } from './profileSummary';
import { ghostPresence, toneFor } from './ghostState';
import { relativeTime, useNow } from './time';
import { uiTerms } from '../uiText';
import { useHost } from '../host/context';

type Page = { messages: Message[]; before: string | null; live: Live | null };

/**
 * The owner's conversation with one Ghost. Each Ghost keeps one durable conversation;
 * the work it takes on branches off as threads (맡긴 일), shown where they started and
 * gathered behind the thread button. Older direct conversations stay readable there.
 */
export function GhostChat({ ghost, state, conversationId, navigate }: {
  ghost: Ghost;
  state: State;
  /** The conversation on screen; null when this Ghost has none yet. */
  conversationId: string | null;
  navigate(path: string): void;
}) {
  const { store, client } = useHost();
  const now = useNow();
  const conversations = state.conversations
    .filter(conversation => conversation.ghostId === ghost.id && conversation.kind === 'direct')
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const [page, setPage] = useState<Page>({ messages: [], before: null, live: null });
  const [loading, setLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [followKey, setFollowKey] = useState(0);
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

  // Live frames: finished messages append to the transcript; partial text, reasoning and tool output stream under them.
  // An owner message does not end the generation, so only the Ghost's own messages retire the live view.
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
          return { ...current, messages, live: message.role === 'user' ? current.live : null };
        });
      } else setPage(current => ({ ...current, live: event.live }));
    });
  }, [store, conversationId]);

  const run = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.'); } };
  const send = (value: string) => {
    if (!conversationId || !value.trim() || sending) return;
    setSending(true);
    setFollowKey(key => key + 1);
    void run(async () => {
      await client.send({ type: 'message.send', conversationId, text: value });
      setDraft('');
    }).finally(() => setSending(false));
  };
  const stop = () => { if (conversationId) void run(() => client.send({ type: 'message.cancel', conversationId })); };

  const live = page.live;
  const hasContent = page.messages.length > 0 || Boolean(live?.running);
  const speaker = (message: Message) => message.role === 'user' ? '나' : message.role === 'tool' ? '도구 기록' : message.role === 'note' ? '기록' : ghost.name;
  const currentConversation = conversations.find(conversation => conversation.id === conversationId);
  const busy = Boolean(currentConversation?.busy);
  const running = busy || Boolean(live?.running);
  const names = new Map(state.ghosts.map(item => [item.id, item.name]));
  const waiting = new Set(state.decisions.filter(decision => decision.state === 'pending' && decision.workId).map(decision => decision.workId!));
  const openWork = (id: string) => navigate(`/work/${encodeURIComponent(id)}`);
  // Threads begun here appear where they started, kept live.
  const extras: TranscriptExtra[] = conversationId ? state.works
    .filter(work => work.originConversationId === conversationId && !work.parentId)
    .map(work => ({ key: `thread:${work.id}`, at: work.createdAt, node: <ThreadCard work={work} ghostName={names.get(work.ghostId) ?? 'Ghost'}
      needsOwner={waiting.has(work.id)} now={now} onOpen={() => openWork(work.id)}/> })) : [];

  return <div className="flex h-full min-h-0 w-full min-w-0">
    <Conversation label={`${ghost.name}와 대화`} transcriptLabel={uiTerms.conversationHistory} jumpToLatestLabel="최신 메시지"
      scrollKey={`${page.messages.length}:${live?.running ? 1 : 0}:${live?.partial ? 1 : 0}`} followKey={followKey}
      overlay={<>
        <div className="chat-float">
          <GhostProfile ghostID={ghost.id} name={ghost.name} summary={profileSummary(ghost.persona)} presence={ghostPresence(ghost, state).state}
            activity={{ model: projectGhostActivity(ghost, state), onInspectWork: openWork, onCancelTurn: () => stop() }}
            onOpenWork={() => navigate(`/work?ghost=${encodeURIComponent(ghost.id)}`)}
            onManage={() => navigate(`/settings?tab=team&ghost=${encodeURIComponent(ghost.id)}`)}
            design={<GhostDesignEditor ghostId={ghost.id}/>}
            isMain={ghost.isDefault}/>
        </div>
        <Threads ghost={ghost} state={state} conversations={conversations} currentId={conversationId} waiting={waiting} now={now}
          onOpenWork={openWork} onOpenConversation={id => navigate(`/ghosts/${encodeURIComponent(ghost.id)}${id === ghost.directConversationId ? '' : `?conversation=${encodeURIComponent(id)}`}`)}
          onOpenAll={() => navigate(`/work?ghost=${encodeURIComponent(ghost.id)}`)}/>
      </>}
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
      <Transcript messages={page.messages} speaker={speaker} extras={extras}
        onUiSubmit={message => message.conversationId === conversationId ? async (text, requestId) => {
          await client.send({ type: 'message.send', conversationId: message.conversationId, text }, requestId);
        } : undefined}/>
      {live?.running && live.tools.length > 0 && <ToolTrail results={[]} running={live.tools}/>}
      {live?.running && <article className="ghost-conversation-message chat-live" data-role="assistant" aria-label={`${ghost.name} · 응답 작성 중`} aria-busy="true">
        <div className="ghost-conversation-message__content">
          {live.thinking && <Reasoning text={live.thinking} live={!live.partial}/>}
          {live.partial
            ? <div className="chat-live__text"><MessageBody text={live.partial}/></div>
            : !live.thinking && <div className="chat-thinking" role="status"><DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={20}/><span>응답 중</span></div>}
        </div>
      </article>}
    </Conversation>
  </div>;
}

/**
 * The threads this Ghost carries: its live 맡긴 일 first, then the latest settled ones, then
 * any older direct conversation kept from before conversations became one durable thread.
 */
function Threads({ ghost, state, conversations, currentId, waiting, now, onOpenWork, onOpenConversation, onOpenAll }: {
  ghost: Ghost;
  state: State;
  conversations: ConversationRow[];
  currentId: string | null;
  waiting: ReadonlySet<string>;
  now: number;
  onOpenWork(id: string): void;
  onOpenConversation(id: string): void;
  onOpenAll(): void;
}) {
  const [open, setOpen] = useState(false);
  const mine = state.works.filter(work => !work.parentId && (work.ghostId === ghost.id || conversations.some(conversation => conversation.id === work.originConversationId)));
  const live = mine.filter(work => !TERMINAL_WORK_STATES.includes(work.state)).sort((a, b) => b.updatedAt - a.updatedAt);
  const settled = mine.filter(work => TERMINAL_WORK_STATES.includes(work.state)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  const earlier = conversations.filter(conversation => conversation.id !== ghost.directConversationId);
  const go = (fn: () => void) => () => { setOpen(false); fn(); };
  const row = (work: Work) => <button key={work.id} type="button" className="menu-row w-full" onClick={go(() => onOpenWork(work.id))}>
    <StateGlyph state={workGlyph(work.state, waiting.has(work.id))} size={15}/>
    <span className="min-w-0 flex-1 truncate">{work.title}</span>
    <time className="shrink-0 text-micro text-ink-3 tabular">{relativeTime(work.updatedAt, now)}</time>
  </button>;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" className="chat-threads" data-live={live.length > 0 || undefined} aria-label={`스레드${live.length ? `, 진행 중 ${live.length}` : ''}`} title="스레드">
        <GitBranch aria-hidden="true"/>{live.length > 0 && <span className="tabular" aria-hidden="true">{live.length}</span>}
      </button>
    </PopoverTrigger>
    <PopoverContent side="bottom" align="end" aria-label="스레드" className="grid w-80 gap-0.5 p-1.5">
      <div className="max-h-[60dvh] overflow-y-auto">
        {live.length > 0 && <p className="menu-heading">진행 중</p>}
        {live.map(row)}
        {settled.length > 0 && <p className="menu-heading">끝난 일</p>}
        {settled.map(row)}
        {!live.length && !settled.length && <p className="m-0 px-2 py-3 text-caption text-ink-3">아직 스레드 없음</p>}
        {earlier.length > 0 && <>
          <p className="menu-heading">이전 대화</p>
          {[conversations.find(conversation => conversation.id === ghost.directConversationId), ...earlier].filter((item): item is ConversationRow => Boolean(item)).map(conversation =>
            <button key={conversation.id} type="button" aria-pressed={conversation.id === currentId} className="menu-row w-full" onClick={go(() => onOpenConversation(conversation.id))}>
              <span className="min-w-0 flex-1 truncate">{conversationName(conversation, ghost)}</span>
              <time className="shrink-0 text-micro text-ink-3 tabular">{relativeTime(conversation.lastActivityAt, now)}</time>
            </button>)}
        </>}
      </div>
      <button type="button" className="menu-row mt-1 border-t border-line pt-1" onClick={go(onOpenAll)}>{uiTerms.work} 전체<ArrowRight size={13} className="ml-auto" aria-hidden="true"/></button>
    </PopoverContent>
  </Popover>;
}

/** The main conversation is the Ghost's own; a titled older one keeps its title, an untitled one is named by when it started. */
function conversationName(conversation: ConversationRow, ghost: Ghost): string {
  if (conversation.id === ghost.directConversationId) return '기본 대화';
  const title = conversation.title.trim();
  if (title && title !== ghost.name) return title;
  return new Date(conversation.createdAt).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
