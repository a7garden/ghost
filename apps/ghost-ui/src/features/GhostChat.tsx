import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CompactTitleSlot } from '../components/AppFrame';
import { ArrowRight, CircleAlert, GitBranch, Monitor, Phone, X } from 'lucide-react';
import { Button, Conversation, Popover, PopoverContent, PopoverTrigger, Row, SkeletonChat } from '../ui'
import { TERMINAL_WORK_STATES, type Conversation as ConversationRow, type Ghost, type GhostTool, type Message, type State, type Work } from '@ghost/contract';
import { GhostProfile } from '../components/GhostProfile';
import { projectGhostActivity } from '../components/AgentStatus';
import { OpenWorkProvider, StateGlyph, ThreadCard, workGlyph } from '../components/agent';
import { Transcript, type TranscriptExtra } from '../components/TranscriptMessage';
import { OutgoingMessage } from '../components/OutgoingMessage';
import { quoteForReply } from '../components/MessageMenu';
import { ChatComposer } from './ChatComposer';
import { lastReply, useNextSuggestions } from './nextSuggestions';
import { chatDecisions } from './Decision';
import { ChatDecisions } from './ChatDecisions';
import { BrowserLiveView } from './BrowserLiveView';
import { BrowserPaneContext } from './BrowserPaneContext';
import { GhostDesignEditor } from './GhostDesign';
import { ThreadPanel } from './ThreadPanel';
import { GhostAgenda } from './GhostAgenda';
import { decisionScopeId } from './scopeState';
import { useConversationFeed } from './conversationFeed';
import { useOutbox } from './outbox';
import { conversationStarters } from './conversationSuggestions';
import { profileSummary } from './profileSummary';
import { ghostLiveWork, type DotState } from './ghostState';
import { relativeTime, useNow } from './time';
import { uiTerms } from '../uiText';
import { useHost } from '../host/context';
import type { BrowserSession } from '../host/client';
import { useCompact, useTouch } from '../ui/adaptive';
import { recoverMessage, type RecoveredMessage } from './composerRecovery';
import { useCallActions } from './call/CallProvider';
import { callStartBlock } from './call/call-state';
import { toolLabels } from './toolLabels';
import './Chat.css';

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
export function GhostChat({ ghost, state, conversationId, threadId, navigate, initialScopeIds = [], toolsHost, projectId }: {
  ghost: Ghost;
  state: State;
  /** The conversation on screen; null when this Ghost has none yet. */
  conversationId: string | null;
  /** A thread opened beside the conversation (`?thread=`). */
  threadId: string | null;
  navigate(path: string): void;
  initialScopeIds?: string[];
  /** Where the tools render when the host screen carries them in its own bar; `null` until that bar mounts. */
  toolsHost?: HTMLElement | null;
  /** Set inside a project: decisions, thread cards, threads and the agenda show only what belongs to it. */
  projectId?: string;
}) {
  const { client } = useHost();
  const calls = useCallActions();
  const touch = useTouch();
  const compact = useCompact();
  const titleSlot = useContext(CompactTitleSlot);
  const toolsSlot = toolsHost !== undefined ? toolsHost : compact ? titleSlot : null;
  const showHead = !compact && toolsHost === undefined;
  const now = useNow();
  const conversations = state.conversations
    .filter(conversation => conversation.ghostId === ghost.id && conversation.kind === 'direct')
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const { feed: page, loading, olderLoading, loadOlder, error, setError } = useConversationFeed(conversationId);
  const [draft, setDraft] = useState('');
  const [recoveredMessage, setRecoveredMessage] = useState<RecoveredMessage | null>(null);
  const [followKey, setFollowKey] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const outbox = useOutbox(conversationId, page.messages);
  // 버리기 takes the message back into the composer, ahead of anything typed since.
  const takeBack = (requestId: string) => {
    const command = outbox.discard(requestId);
    if (!command) return;
    setDraft(current => current.trim() ? `${command.text}\n\n${current}` : command.text);
    setRecoveredMessage(previous => recoverMessage(previous, command, requestId));
    inputRef.current?.focus();
  };
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
  const hasContent = page.messages.length > 0 || outbox.rows.length > 0;
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
  const lastMessage = lastReply(page.messages, message => message.role === 'user' || message.role === 'assistant');
  const nextMessages = useNextSuggestions(conversationId, lastMessage?.id ?? null,
    !running && lastMessage?.role === 'assistant' && outbox.rows.length === 0);
  const names = new Map(state.ghosts.map(item => [item.id, item.name]));
  const waiting = new Set(state.decisions.filter(decision => decision.state === 'pending' && decision.workId).map(decision => decision.workId!));
  // An open thread's own decisions stay in its panel, but still count toward the conversation's state.
  const pending = chatDecisions(state, ghost.id, conversationId)
    .filter(decision => projectId === undefined || decision.workId === null || decisionScopeId(decision, state) === projectId);
  const decisions = threadId ? pending.filter(decision => decision.workId !== threadId) : pending;
  const currentTool = live?.tools.at(-1)?.name;
  const nowDoing = currentTool ? toolLabels[currentTool as GhostTool] ?? currentTool
    : live?.thinking && !live.partial ? '생각 중' : '응답 중';
  const work = pending.length === 0 && !running ? ghostLiveWork(state, ghost.id)
    .find(item => (projectId === undefined || item.scopeId === projectId)
      && (item.state === 'running' || item.state === 'verifying' || item.state === 'blocked' || item.state === 'waiting')) : undefined;
  const presence: DotState = pending.length > 0 || work?.state === 'blocked' ? 'attention'
    : running || work?.state === 'running' || work?.state === 'verifying' ? 'working' : 'idle';
  const status = pending.length > 0 ? `확인 필요 ${pending.length}`
    : running ? `작업 중 · ${nowDoing}`
    : work ? `${work.state === 'blocked' ? '막힘' : work.state === 'waiting' ? '응답 대기' : '작업 중'} · ${work.title}`
    : '대기';
  const openWork = (id: string) => navigate(`/work/${encodeURIComponent(id)}`);
  // A thread enters the activity group for the turn where it began and stays live there.
  const extras: TranscriptExtra[] = conversationId ? state.works
    .filter(work => work.originConversationId === conversationId && !work.parentId && (projectId === undefined || work.scopeId === projectId))
    .map(work => {
      const delegates = state.works.filter(child => child.rootId === work.id && child.id !== work.id)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(child => ({ work: child, ghostName: names.get(child.ghostId) ?? 'Ghost', needsOwner: waiting.has(child.id) }));
      return { key: `thread:${work.id}`, at: work.createdAt, returnsAs: TERMINAL_WORK_STATES.includes(work.state) ? work.id : undefined, node: <ThreadCard work={work} ghostName={names.get(work.ghostId) ?? 'Ghost'}
        needsOwner={waiting.has(work.id)} now={now} delegates={delegates} selected={threadId === work.id}
        onOpen={() => openThread(work.id)} onOpenPage={() => openWork(work.id)}/> };
    }) : [];

  const callBlocked = calls ? callStartBlock(ghost, calls.occupied) : null;
  const callLabel = callBlocked ? `전화 — ${callBlocked}` : '전화';
  const profile = <GhostProfile ghostID={ghost.id} name={ghost.name} summary={profileSummary(ghost.persona)} presence={presence}
      activity={{ model: projectGhostActivity(ghost, state), onInspectWork: openWork, onCancelTurn: stop }}
      onOpenWork={() => navigate(`/work?ghost=${encodeURIComponent(ghost.id)}`)}
      onManage={() => navigate(`/settings?tab=team&ghost=${encodeURIComponent(ghost.id)}`)}
      design={<GhostDesignEditor ghostId={ghost.id}/>}
      isMain={ghost.isDefault}/>
  const tools = <div className="chat-tools" role="group" aria-label="대화 도구">
    {!showHead && profile}
    {calls && <button type="button" className="chat-tool chat-call" aria-disabled={Boolean(callBlocked)} aria-label={callLabel} title={callLabel}
      onClick={event => { if (!callBlocked) calls.start(ghost, event.currentTarget); }}><Phone aria-hidden="true"/></button>}
    <Threads ghost={ghost} state={state} conversations={conversations} currentId={conversationId} waiting={waiting} now={now} projectId={projectId}
      onOpenWork={openThread} onOpenConversation={id => navigate(`/ghosts/${encodeURIComponent(ghost.id)}${id === ghost.directConversationId ? '' : `?conversation=${encodeURIComponent(id)}`}`)}
      onOpenAll={() => navigate(`/work?ghost=${encodeURIComponent(ghost.id)}`)}/>
    <GhostAgenda ghost={ghost} state={state} navigate={navigate} projectId={projectId}/>
    {conversationId && browserCapable && (browserSession || browserOpen) &&
      <button type="button" className="chat-tool chat-browser" aria-pressed={browserOpen} data-live={browserSession ? '' : undefined}
        aria-label="브라우저 화면" title="브라우저 화면" onClick={() => setBrowserOpen(value => !value)}>
        <Monitor aria-hidden="true"/>
      </button>}
  </div>;
  const outgoing = outbox.rows.map(({ entry, note }) => <OutgoingMessage key={entry.requestId} label="나" text={entry.command.text}
    scopes={(entry.command.scopeId ? [entry.command.scopeId] : []).flatMap(id => state.scopes.filter(space => space.id === id))}
    attachments={entry.command.attachments ?? []} state={entry.state} note={note}
    onRetry={() => outbox.retry(entry.requestId)} onDiscard={() => takeBack(entry.requestId)}/>);
  return <OpenWorkProvider value={openThread}><div className="chat-layout" data-thread={threadId ? '' : undefined}>
    {toolsSlot && !threadId && createPortal(tools, toolsSlot)}
    <Conversation label={`${ghost.name}와 대화`} transcriptLabel={uiTerms.conversationHistory} jumpToLatestLabel="최신 메시지"
      scrollKey={`${page.messages.length}:${outbox.rows.length}:${live?.running ? 1 : 0}:${live?.partial ? 1 : 0}`} followKey={followKey}
      header={showHead ? <div className="chat-head" data-presence={presence}>
        {profile}
        <div className="chat-head__identity">
          <h1 className="chat-head__name" title={ghost.name}>{ghost.name}</h1>
          <p className="chat-head__state" title={status}>{status}</p>
        </div>
        {tools}
      </div> : null}
      composer={<>
        <BrowserPaneContext.Provider value={conversationId ? { conversationId, open: () => setBrowserOpen(true) } : null}>
          <ChatDecisions state={state} navigate={navigate} decisions={decisions} onOpenWork={openThread}/>
        </BrowserPaneContext.Provider>
        <ChatComposer ghost={ghost} conversationId={conversationId} running={running} busy={busy} draft={draft} setDraft={setDraft}
          recoveredMessage={recoveredMessage} setRecoveredMessage={setRecoveredMessage} inputRef={inputRef} initialScopeIds={initialScopeIds}
          onPost={command => { setFollowKey(key => key + 1); outbox.post(command); }} onStop={stop} onError={setError} nextMessages={nextMessages}/>
      </>}
      footer={<>
        {error && <div className="chat-error" role="alert"><CircleAlert size={15} aria-hidden="true"/><span>{error}</span><Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" aria-label="오류 메시지 닫기" onClick={() => setError('')}><X size={14}/></Button></div>}
        <p id="composer-keyboard-help" className="sr-only m-0">{touch ? '보내기 버튼으로 전송 · Return으로 줄바꿈' : 'Enter로 보내기 · Shift + Enter로 줄바꿈'}{busy ? ' · 추가 지시는 진행 중인 응답에 전달됩니다.' : ''}</p>
      </>}>
      {!hasContent && !running && !loading && !error && extras.length === 0 && <div className="chat-empty">
        <h2>무엇부터 이야기할까요?</h2>
        {ghost.persona.trim() && <div className="chat-empty__starters" role="group" aria-label="대화 시작 제안">{conversationStarters(ghost.persona).map(({ label, prompt }) =>
          <button type="button" key={label} title={prompt} onClick={() => { setDraft(prompt); inputRef.current?.focus(); }}>{label}</button>)}</div>}
      </div>}
      {loading && <SkeletonChat label="대화 기록을 읽는 중"/>}
      {conversationId && page.before && <div className="grid justify-items-center">
        <button type="button" className="link-quiet" disabled={olderLoading} onClick={loadOlder}>{olderLoading ? '불러오는 중…' : '이전 메시지'}</button>
      </div>}
      <Transcript messages={page.messages} speaker={speaker} extras={extras} delivered={outbox.delivered}
        continuation={{ live, ghostId: ghost.id, ghostName: ghost.name, outgoing }}
        onQuote={text => { setDraft(current => `${current.trim() ? `${current.trimEnd()}\n\n` : ''}${quoteForReply(text)}`); inputRef.current?.focus(); }}
        onReuse={text => { setDraft(text); inputRef.current?.focus(); }}
        onUiSubmit={message => message.conversationId === conversationId ? async (text, requestId) => {
          await client.send({ type: 'message.send', conversationId: message.conversationId, text }, requestId);
        } : undefined}/>
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
function Threads({ ghost, state, conversations, currentId, waiting, now, projectId, onOpenWork, onOpenConversation, onOpenAll }: {
  ghost: Ghost;
  state: State;
  conversations: ConversationRow[];
  currentId: string | null;
  waiting: ReadonlySet<string>;
  now: number;
  projectId?: string;
  onOpenWork(id: string): void;
  onOpenConversation(id: string): void;
  onOpenAll(): void;
}) {
  const [open, setOpen] = useState(false);
  const mine = state.works.filter(work => !work.parentId && (projectId === undefined || work.scopeId === projectId) && (work.ghostId === ghost.id || conversations.some(conversation => conversation.id === work.originConversationId)));
  const live = mine.filter(work => !TERMINAL_WORK_STATES.includes(work.state)).sort((a, b) => b.updatedAt - a.updatedAt);
  const settled = mine.filter(work => TERMINAL_WORK_STATES.includes(work.state)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  const earlier = conversations.filter(conversation => conversation.id !== ghost.directConversationId);
  const go = (fn: () => void) => () => { setOpen(false); fn(); };
  const row = (work: Work) => <Row key={work.id} size="menu" className="w-full" onClick={go(() => onOpenWork(work.id))}>
    <StateGlyph state={workGlyph(work.state, waiting.has(work.id))} size={15}/>
    <span className="min-w-0 flex-1 truncate">{work.title}</span>
    <time className="shrink-0 text-micro text-ink-3 tabular">{relativeTime(work.updatedAt, now)}</time>
  </Row>;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" className="chat-tool" data-live={live.length > 0 || undefined} aria-label={`스레드${live.length ? `, 진행 중 ${live.length}` : ''}`} title="스레드">
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
            <Row key={conversation.id} size="menu" aria-pressed={conversation.id === currentId} className="w-full" onClick={go(() => onOpenConversation(conversation.id))}>
              <span className="min-w-0 flex-1 truncate">{conversationName(conversation, ghost)}</span>
              <time className="shrink-0 text-micro text-ink-3 tabular">{relativeTime(conversation.lastActivityAt, now)}</time>
            </Row>)}
        </>}
      </div>
      <Row size="menu" className="mt-1 border-t border-line pt-1" onClick={go(onOpenAll)}>{uiTerms.work} 전체<ArrowRight size={13} className="ml-auto" aria-hidden="true"/></Row>
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
