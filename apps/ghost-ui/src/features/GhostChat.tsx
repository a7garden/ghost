import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CircleAlert, GitBranch, Monitor, X } from 'lucide-react';
import { Button, Conversation, Popover, PopoverContent, PopoverTrigger } from '../ui'
import { TERMINAL_WORK_STATES, type Conversation as ConversationRow, type Ghost, type Message, type State, type Work } from '@ghost/contract';
import { GhostProfile } from '../components/GhostProfile';
import { projectGhostActivity } from '../components/AgentStatus';
import { OpenWorkProvider, StateGlyph, ThreadCard, workGlyph } from '../components/agent';
import { LiveReply, Transcript, type TranscriptExtra } from '../components/TranscriptMessage';
import { quoteForReply } from '../components/MessageMenu';
import { ChatComposer } from './ChatComposer';
import { DecisionDeck, chatDecisions } from './Decision';
import { BrowserLiveView } from './BrowserLiveView';
import { BrowserPaneContext } from './BrowserPaneContext';
import { GhostDesignEditor } from './GhostDesign';
import { ThreadPanel } from './ThreadPanel';
import { useConversationFeed } from './conversationFeed';
import { conversationStarters } from './conversationSuggestions';
import { profileSummary } from './profileSummary';
import { ghostPresence } from './ghostState';
import { relativeTime, useNow } from './time';
import { uiTerms } from '../uiText';
import { useHost } from '../host/context';
import type { BrowserSession } from '../host/client';
import { useTouch } from '../ui/adaptive';

/** How often the conversation re-checks whether the Ghost's browser session is still there. */
const SESSION_POLL_MS = 4000;

/**
 * The browser session the host keeps for the open conversation, polled only while the screen is
 * visible and the Ghost may drive a browser at all; the last answer stays while the host is away.
 */
function useBrowserSession(conversationId: string | null, enabled: boolean): BrowserSession | null {
  const { client } = useHost();
  const [session, setSession] = useState<BrowserSession | null>(null);
  useEffect(() => {
    if (!conversationId || !enabled) { setSession(null); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const { sessions } = await client.browserSessions();
        if (alive) setSession(sessions.find(item => item.conversationId === conversationId) ?? null);
      } catch { /* the host is away; the next tick retries */ }
      if (alive && document.visibilityState === 'visible') timer = setTimeout(() => void poll(), SESSION_POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || !alive) return;
      if (timer !== null) clearTimeout(timer);
      void poll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState === 'visible') void poll();
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [client, conversationId, enabled]);
  return session?.conversationId === conversationId ? session : null;
}

/**
 * The owner's conversation with one Ghost. Each Ghost keeps one durable conversation;
 * the work it takes on branches off as threads (맡긴 일), shown where they started and
 * gathered behind the thread button. Older direct conversations stay readable there.
 */
export function GhostChat({ ghost, state, conversationId, threadId, navigate, initialSpaceIds = [] }: {
  ghost: Ghost;
  state: State;
  /** The conversation on screen; null when this Ghost has none yet. */
  conversationId: string | null;
  /** A thread opened beside the conversation (`?thread=`). */
  threadId: string | null;
  navigate(path: string): void;
  initialSpaceIds?: string[];
}) {
  const { client } = useHost();
  const touch = useTouch();
  const now = useNow();
  const conversations = state.conversations
    .filter(conversation => conversation.ghostId === ghost.id && conversation.kind === 'direct')
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const { feed: page, loading, olderLoading, loadOlder, error, setError } = useConversationFeed(conversationId);
  const [draft, setDraft] = useState('');
  const [followKey, setFollowKey] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!touch) inputRef.current?.focus(); }, [conversationId, touch]);

  const run = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.'); } };
  const stop = () => { if (conversationId) void run(() => client.send({ type: 'message.cancel', conversationId })); };
  // The thread lives in the URL so it survives reloads and can be linked; the conversation stays put.
  const chatPath = `/ghosts/${encodeURIComponent(ghost.id)}${conversationId && conversationId !== ghost.directConversationId ? `?conversation=${encodeURIComponent(conversationId)}` : ''}`;
  const openThread = (id: string) => navigate(`${chatPath}${chatPath.includes('?') ? '&' : '?'}thread=${encodeURIComponent(id)}`);
  const closeThread = () => navigate(chatPath);
  // The panel stays mounted while it slides out after the thread closes; a new thread replaces it at once.
  const [panelId, setPanelId] = useState(threadId);
  if (threadId && threadId !== panelId) setPanelId(threadId);
  const panelClosing = !threadId && panelId !== null;

  const live = page.live;
  const hasContent = page.messages.length > 0 || Boolean(live?.running);
  const speaker = (message: Message) => message.role === 'user' ? '나' : message.role === 'tool' ? '도구 기록' : message.role === 'note' ? '기록' : ghost.name;
  // The in-app browser shows only when the Ghost may drive one at all; the toggle follows the session.
  const browserCapable = ghost.tools.some(tool => tool.startsWith('browser_'));
  const browserSession = useBrowserSession(conversationId, browserCapable);
  const [browserOpen, setBrowserOpen] = useState(false);
  // A handoff waiting on the owner opens the live view by itself, once per question.
  const handoffSeen = useRef<string | null>(null);
  useEffect(() => {
    setBrowserOpen(false);
    handoffSeen.current = null;
  }, [conversationId]);
  useEffect(() => {
    const handoffId = browserSession?.handoffDecisionId ?? null;
    if (handoffId && handoffSeen.current !== handoffId) { handoffSeen.current = handoffId; setBrowserOpen(true); }
    if (!handoffId) handoffSeen.current = null;
  }, [browserSession?.handoffDecisionId]);
  const currentConversation = conversations.find(conversation => conversation.id === conversationId);
  const busy = Boolean(currentConversation?.busy);
  const running = busy || Boolean(live?.running);
  const names = new Map(state.ghosts.map(item => [item.id, item.name]));
  const waiting = new Set(state.decisions.filter(decision => decision.state === 'pending' && decision.workId).map(decision => decision.workId!));
  // What this screen needs from the owner, answered above the composer; an open thread's own decisions sit in its panel.
  const decisions = chatDecisions(state, ghost.id, conversationId).filter(decision => !threadId || decision.workId !== threadId);
  const openWork = (id: string) => navigate(`/work/${encodeURIComponent(id)}`);
  // Threads begun here appear where they started, kept live, with the Ghosts they delegated to beneath.
  const extras: TranscriptExtra[] = conversationId ? state.works
    .filter(work => work.originConversationId === conversationId && !work.parentId)
    .map(work => {
      const delegates = state.works.filter(child => child.rootId === work.id && child.id !== work.id)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(child => ({ work: child, ghostName: names.get(child.ghostId) ?? 'Ghost', needsOwner: waiting.has(child.id) }));
      return { key: `thread:${work.id}`, at: work.createdAt, returnsAs: TERMINAL_WORK_STATES.includes(work.state) ? work.id : undefined, node: <ThreadCard work={work} ghostName={names.get(work.ghostId) ?? 'Ghost'}
        needsOwner={waiting.has(work.id)} now={now} delegates={delegates}
        onOpen={() => openThread(work.id)} onOpenPage={() => openWork(work.id)}/> };
    }) : [];

  return <OpenWorkProvider value={openThread}><div className="chat-layout" data-thread={threadId ? '' : undefined}>
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
        <div className="chat-corner">
          {conversationId && browserCapable && (browserSession || browserOpen) &&
            <button type="button" className="chat-threads chat-browser" aria-pressed={browserOpen} data-live={browserSession ? '' : undefined}
              aria-label="브라우저 화면" title="브라우저 화면" onClick={() => setBrowserOpen(value => !value)}>
              <Monitor aria-hidden="true"/>
            </button>}
          <Threads ghost={ghost} state={state} conversations={conversations} currentId={conversationId} waiting={waiting} now={now}
            onOpenWork={openThread} onOpenConversation={id => navigate(`/ghosts/${encodeURIComponent(ghost.id)}${id === ghost.directConversationId ? '' : `?conversation=${encodeURIComponent(id)}`}`)}
            onOpenAll={() => navigate(`/work?ghost=${encodeURIComponent(ghost.id)}`)}/>
        </div>
      </>}
      composer={<>
        <BrowserPaneContext.Provider value={conversationId ? { conversationId, open: () => setBrowserOpen(true) } : null}>
          <DecisionDeck state={state} navigate={navigate} decisions={decisions} onOpenWork={openThread} docked/>
        </BrowserPaneContext.Provider>
        <ChatComposer ghost={ghost} conversationId={conversationId} running={running} busy={busy} draft={draft} setDraft={setDraft} inputRef={inputRef} initialSpaceIds={initialSpaceIds}
          onSent={() => setFollowKey(key => key + 1)} onStop={stop} onError={setError}/>
      </>}
      footer={<>
        {error && <div className="chat-error" role="alert"><CircleAlert size={15} aria-hidden="true"/><span>{error}</span><Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" aria-label="오류 메시지 닫기" onClick={() => setError('')}><X size={14}/></Button></div>}
        <p id="composer-keyboard-help" className="sr-only m-0">{touch ? '보내기 버튼으로 전송 · Return으로 줄바꿈' : 'Enter로 보내기 · Shift + Enter로 줄바꿈'}{busy ? ' · 추가 지시는 진행 중인 응답에 전달됩니다.' : ''}</p>
      </>}>
      {!hasContent && !loading && <div className="chat-empty">
        <h2>{ghost.name}</h2>
        {ghost.persona.trim() && <div className="chat-empty__starters" role="group" aria-label="대화 시작 제안">{conversationStarters(ghost.persona).map(({ label, prompt }) =>
          <button type="button" key={label} title={prompt} onClick={() => { setDraft(prompt); inputRef.current?.focus(); }}>{label}</button>)}</div>}
      </div>}
      {loading && <div className="chat-loading" aria-busy="true"><span/><span/><span/><span className="sr-only">대화 기록을 읽는 중</span></div>}
      {conversationId && page.before && <div className="grid justify-items-center">
        <button type="button" className="link-quiet" disabled={olderLoading} onClick={loadOlder}>{olderLoading ? '불러오는 중…' : '이전 메시지'}</button>
      </div>}
      <Transcript messages={page.messages} speaker={speaker} extras={extras}
        onQuote={text => { setDraft(current => `${current.trim() ? `${current.trimEnd()}\n\n` : ''}${quoteForReply(text)}`); inputRef.current?.focus(); }}
        onReuse={text => { setDraft(text); inputRef.current?.focus(); }}
        onUiSubmit={message => message.conversationId === conversationId ? async (text, requestId) => {
          await client.send({ type: 'message.send', conversationId: message.conversationId, text }, requestId);
        } : undefined}/>
      {live && <LiveReply live={live} ghostId={ghost.id} ghostName={ghost.name}/>}
    </Conversation>
    {browserOpen && conversationId && <aside className="browser-pane" aria-label="브라우저 화면">
      <header className="browser-pane__head">
        <Monitor size={16} aria-hidden="true"/>
        <h2>브라우저</h2>
        {browserSession && <span className="browser-pane__engine">{browserSession.engine === 'obscura' ? 'Obscura' : 'Chrome'}</span>}
        <button type="button" className="shell-icon-button" aria-label="브라우저 화면 닫기" title="닫기" onClick={() => setBrowserOpen(false)}><X aria-hidden="true"/></button>
      </header>
      <div className="browser-pane__body">
        {browserSession
          ? <BrowserLiveView key={conversationId} conversationId={conversationId}/>
          : <p className="browser-pane__empty">브라우저 세션 없음</p>}
      </div>
    </aside>}
    {panelId && <ThreadPanel key={panelId} workId={panelId} state={state} closing={panelClosing} onClosed={() => setPanelId(null)}
      onClose={closeThread} onOpenThread={openThread} onOpenPage={openWork}/>}
  </div></OpenWorkProvider>;
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
