import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, CircleAlert, History, LoaderCircle, MessageCircle, Plus, Square, X } from 'lucide-react';
import { Button, Composer, Conversation, ConversationActivity, ConversationMessage, cn } from '../ui'
import type { Ghost, Live, Message, State } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { GhostProfile } from '../components/GhostProfile';
import { projectGhostActivity } from '../components/AgentStatus';
import { Modal } from '../components/Modal';
import { TranscriptMessage } from '../components/TranscriptMessage';
import { MessageBody } from '../components/MessageBody';
import { ModelPicker } from '../pets/ModelPicker';
import { GhostDesignEditor } from './GhostDesign';
import { conversationStarters } from './conversationSuggestions';
import { profileSummary } from './profileSummary';
import { toneFor } from './ghostState';
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
  const [history, setHistory] = useState(false);
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

  const live = page.live;
  const hasContent = page.messages.length > 0 || Boolean(live?.running);
  const speaker = (message: Message) => message.role === 'user' ? '나' : message.role === 'tool' ? '도구 기록' : message.role === 'note' ? '기록' : ghost.name;
  const busy = Boolean(state.conversations.find(conversation => conversation.id === conversationId)?.busy);
  const currentConversation = conversations.find(conversation => conversation.id === conversationId);
  const running = busy || Boolean(live?.running);

  return <div className="flex h-full min-h-0 w-full min-w-0">
    <Conversation label={`${ghost.name}와 대화`} transcriptLabel={uiTerms.conversationHistory} jumpToLatestLabel="최신 메시지로 이동"
      scrollKey={page.messages.length + (live?.partial ? 1 : 0)}
      header={<div className="flex min-w-0 items-center gap-3 py-1">
        <GhostProfile ghostID={ghost.id} name={ghost.name} summary={profileSummary(ghost.persona)}
          activity={{ model: projectGhostActivity(ghost, state), onInspectWork: workId => navigate(`/work/${encodeURIComponent(workId)}`), onCancelTurn: id => stop() }}
          onOpenWork={() => navigate(`/work?ghost=${encodeURIComponent(ghost.id)}`)}
          historyCount={conversations.length} onOpenHistory={() => setHistory(true)}
          onManage={() => navigate(`/settings?tab=team&ghost=${encodeURIComponent(ghost.id)}`)}
          design={<GhostDesignEditor ghostId={ghost.id}/>}
          isMain={ghost.isDefault}/>
        <div className="min-w-0 flex-1">
          <h1 className="m-0 truncate text-ui font-semibold text-ink">{currentConversation?.title && currentConversation.title !== ghost.name ? currentConversation.title : '대화'}</h1>
          <p className="m-0 truncate text-caption text-ink-2">{running ? '응답 중' : ghost.name}</p>
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label="이전 대화" title="이전 대화" onClick={() => setHistory(true)}><History size={17}/></Button>
        <Button type="button" variant="ghost" size="sm" onClick={startConversation}><Plus size={16}/>새 대화</Button>
      </div>}
      composer={<Composer variant="conversation" inputId="message-input" inputRef={inputRef} rows={1} value={draft} onValueChange={setDraft} onSubmit={send}
        label={`${ghost.name}에게 메시지`} placeholder={running ? '추가 지시를 입력하세요' : `${ghost.name}에게 메시지 보내기`} submitLabel="메시지 보내기"
        disabled={!conversationId} pending={sending}
        footer={conversationId && <ModelPicker conversationId={conversationId} value={currentConversation?.model} disabled={sending}/>}
        trailing={running ? <Button type="button" variant="secondary" size="icon" aria-label="응답 취소" title="응답 취소" onClick={stop}><Square size={14}/></Button> : undefined}/>}
      footer={<div className="grid gap-2">
        {error && <div className="flex items-start gap-2 rounded-card border border-line bg-surface px-3 py-2.5 text-caption text-ink" role="alert"><CircleAlert size={16} className="mt-0.5 shrink-0 text-red"/><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</span><Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" aria-label="오류 메시지 닫기" onClick={() => setError('')}><X size={14}/></Button></div>}
        <p id="composer-keyboard-help" className="sr-only m-0">Enter로 보내기 · Shift + Enter로 줄바꿈{busy ? ' · 추가 지시는 진행 중인 응답에 전달됩니다.' : ''}</p>
      </div>}>
      {!hasContent && !loading && <div className="flex min-h-[min(42dvh,360px)] flex-col items-center justify-center gap-4 py-8 text-center">
        <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={44}/>
        <h2 className="m-0 text-headingLg font-semibold text-ink">무엇을 맡길까요?</h2>
        {ghost.persona.trim() && <div className="mt-2 grid w-full gap-2 sm:grid-cols-2" role="group" aria-label="대화 시작 제안">{conversationStarters(ghost.persona).map(({ label, prompt }) => <button type="button" key={label} title={prompt}
          className="flex min-h-16 cursor-pointer items-start justify-between gap-3 rounded-control border border-line p-4 text-left text-ui leading-relaxed text-ink-2 outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-3"
          onClick={() => { setDraft(prompt); inputRef.current?.focus(); }}>{label}<ArrowUpRight size={14} className="mt-0.5 shrink-0" aria-hidden="true"/></button>)}</div>}
      </div>}
      {loading && <div className="grid justify-items-center py-10 text-caption text-ink-2" aria-busy="true">대화 기록을 읽는 중…</div>}
      {conversationId && page.before && <div className="grid justify-items-center py-2">
        <Button variant="ghost" size="sm" disabled={olderLoading} onClick={() => void load(conversationId, page.before)}>{olderLoading ? '불러오는 중…' : '이전 메시지'}</Button>
      </div>}
      {page.messages.map(message => <TranscriptMessage key={message.id} message={message} speaker={speaker}/>)}
      {live?.running && <ConversationMessage role="assistant" label={`${ghost.name} · 응답 작성 중`}>
        <div className="mb-3 flex items-center gap-2 text-caption text-ink-2" role="status"><LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true"/>응답 중</div>
        {live.partial && <MessageBody text={live.partial}/>}
        {live.tools.length > 0 && <ConversationActivity summary={`도구 활동 ${live.tools.length}개`}>
          {live.tools.map(tool => <div key={tool.callId} className="grid gap-1 py-2 text-caption text-ink-2">
            <span className="font-medium">{tool.name}</span><pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{tool.output}</pre>
          </div>)}
        </ConversationActivity>}
      </ConversationMessage>}
    </Conversation>
    {history && <Modal title={`${ghost.name} · ${uiTerms.conversationHistory}`} onClose={() => setHistory(false)}>
      <div className="grid max-h-[400px] gap-1 overflow-y-auto">
        {conversations.map(conversation => <button key={conversation.id} type="button"
          className={cn('flex min-w-0 cursor-pointer items-center gap-2.5 rounded-control px-2 py-2.5 text-left text-ui text-ink outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3', conversation.id === conversationId && 'bg-hover')}
          onClick={() => { setHistory(false); navigate(`/ghosts/${encodeURIComponent(ghost.id)}?conversation=${encodeURIComponent(conversation.id)}`); }}>
          <MessageCircle size={17} className="shrink-0 text-ink-2"/><span className="min-w-0 flex-1 truncate">{conversation.title || '대화'}</span>
          {conversation.id === conversationId && <Check size={15} className="shrink-0"/>}
        </button>)}
        {!conversations.length && <p className="m-0 text-caption text-ink-2">대화 기록이 없습니다.</p>}
      </div>
      <Button type="button" variant="secondary" className="mt-3 w-full" onClick={() => { setHistory(false); void startConversation(); }}><Plus size={15}/>새 대화</Button>
    </Modal>}
  </div>;
}

