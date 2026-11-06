import { DetailDialog } from '../components/DetailDialog';
import { Badge, Button, GComposer, GConversation, GConversationMessage, GPanel, Textarea, cn } from '@garden/ui';
import { uiTerms } from '../uiText';
import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Check, FileText, History, MessageCircle, Plus, Settings2, Square, PanelRight, CircleAlert, X, Phone, PanelLeft, Wrench } from 'lucide-react';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { usePanelState } from '../components/usePanelState';
import { isRunning, phaseLabel, toneFor } from '../client/types';
import type { Profile, Snapshot, Review, Command, Conversation } from '../client/types';
import { CollaborationStrip } from './CollaborationView';
import { VoicePanel, useVoiceCall } from '../voice/VoicePanel';
import { useAvatarSpeaking } from '../pets/AvatarProvider';
import { ConversationContext } from './ConversationContext';
import { contextualCards } from './contextProjection';
import { profileSummary } from './profileSummary';
import { conversationStarters } from './conversationSuggestions';
import { ConversationModelPicker } from './ConversationModelPicker';
import { RoutingConversation, RoutingWorkList, RoutingWorkDetail, useRoutingConversation } from './RoutingConversation';
import type { RoutingConnection, ClarificationChoice } from './RoutingConversation';
import { selectedConversationModel } from './modelSelection';
import { routingTimeline } from '../client/routingTimeline';
import {RoutingPending,RoutingTerminal} from '../client/errors';
import {RoutingPendingInputs,usePendingRouting} from './RoutingPending';

type Props = { routing?: RoutingConnection; profile: Profile; snapshot: Snapshot; mode: string; action: (command: Command) => Promise<Record<string, any>>; busy: boolean; connected: boolean; navigate: (route: string) => void; route: string; onReview: (review: Review) => void; onOpenNavigation?: () => void; navigationOpen?: boolean };
export function DotDetail({ routing, profile, snapshot, mode, action, busy, connected, navigate, route, onReview, onOpenNavigation, navigationOpen = false }: Props) {
  const fromRoute = new URLSearchParams(route.split('?')[1] || '').get('conversation');
  const [conversationId, setConversationId] = useState(fromRoute ?? profile.conversations[0]?.id ?? '');
  // A creation snapshot can arrive before its action resolves. Keep the chosen
  // identity stable until the completion callback migrates the draft and route.
  const conversation = profile.conversations.find(c => c.id === conversationId);
  const routingState = useRoutingConversation(routing, { entry_profile_id: profile.id, conversation_id: conversation?.id ?? '' }, snapshot);
  const conversationRows=routingTimeline(conversation?.messages??[],conversation?.tasks??[],routingState.view,{entry_profile_id:profile.id,conversation_id:conversation?.id??''});
  const [selectedWorkId, setSelectedWorkId] = useState(''), [answering, setAnswering] = useState('');
  const answeringRef = useRef('');
  const [clarificationError, setClarificationError] = useState<{ source: string; message: string }>();
  const selectedWork = routingState.view?.works.find(w => w.id === selectedWorkId);
  const openWork = (id: string) => { setShowContext(false); setSelectedWorkId(id); };
  const [draft, setDraft] = useState(''), [error, setError] = useState(''), [settings, setSettings] = useState(false), [history, setHistory] = useState(false), [schedule, setSchedule] = useState(false), [showVoice, setShowVoice] = useState(false);
  const [showContext, setShowContext] = usePanelState(`ghost-ui:context-open:${snapshot.workspace_id}`);
  const contextPanelId = useId();
  const contextToggle = useRef<HTMLButtonElement>(null);
  const closeContext = () => { setShowContext(false); requestAnimationFrame(() => contextToggle.current?.focus()); };
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 76rem)').matches);
  const [modelSaving, setModelSaving] = useState(false);
  const projectedContext = contextualCards(snapshot, profile.id, conversation?.id);
  const contextCount = projectedContext.count + Number(showVoice) + Number(Boolean(routingState.view?.works.length));
  const hasContent = Boolean(conversation?.messages.length || projectedContext.currentTasks.length || routingState.view?.admissions.length);
  const modelBlocked = conversation?.model_available === false && !runningTasksIn(conversation);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 76rem)');
    const change = () => setWide(media.matches); media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const createdModelDraft = useRef<{ id: string; text: string } | null>(null);
  const createdConversation = useRef<string | null>(null), sending = useRef(false), draftRef = useRef('');
  const draftKey = `ghost-ui:draft:${snapshot.workspace_id}:${profile.id}:${conversation?.id ?? 'new'}`;
  const reviews = snapshot.reviews.filter(r => r.profile_id === profile.id && ['pending', 'approved'].includes(r.state));
  const running = conversation?.tasks.filter(t => isRunning(t.phase)) ?? [];
  const pending=usePendingRouting(routing?.client,{entry_profile_id:profile.id,conversation_id:conversation?.id??conversationId},connected,(request,observation)=>{
    routingState.refresh();
    if(observation.state==='admitted'){
      setError('');setClarificationError(undefined);
      if(!request.turn.resolves.length&&draftRef.current===request.turn.text){
        try{localStorage.removeItem(draftKey);draftRef.current='';setDraft('');}
        catch{setError('요청은 접수됐지만 초안 표시를 정리하지 못했습니다. 접수 기록을 확인해 주세요.');}
      }
    }
  });
  // Snapshot changes follow host commits (event-driven refresh); re-scan the
  // pending journal then instead of waiting for the next fallback tick.
  const pendingSnapshot = useRef(snapshot);
  useEffect(() => {
    if (pendingSnapshot.current === snapshot) return;
    pendingSnapshot.current = snapshot;
    if (connected) void pending.refresh();
  }, [snapshot, connected, pending.refresh]);
  const onSpeakingChange = useAvatarSpeaking(profile.id);
  const replyMessage = conversation?.messages.map((message, index) => ({ message, index })).reverse().find(({ message }) => message.role === 'assistant' && message.text.trim() && conversation.tasks.some(task => task.id === message.task_id && task.phase === 'complete'));
  const latestVoiceReply = replyMessage && conversation ? { id: `${conversation.id}:${replyMessage.message.task_id}:${replyMessage.index}`, taskId: replyMessage.message.task_id!, text: replyMessage.message.text } : undefined;
  const voiceEnabled = connected && mode !== 'demo' && profile.policy.voice === true && Boolean(conversation);
  const voiceReason = profile.policy.voice !== true ? 'Ghost 설정에서 음성 사용을 허용해 주세요.' : 'Ghost 호스트에 연결해 주세요.';
  const call = useVoiceCall({ profileId: profile.id, conversationId: conversation?.id ?? '', profileName: profile.name, enabled: voiceEnabled, runningTasks: running.length, latestReply: latestVoiceReply, onSpeakingChange,
    submitTranscript: async text => {
      if (!connected || mode === 'demo') throw new Error('Ghost 호스트에 다시 연결해 주세요.');
      if (!conversation || modelBlocked || modelSaving || pending.blocking) throw new Error(pending.blocking?(pending.waiting?'이전 입력의 접수 상태를 확인하고 있습니다. 확인이나 취소가 끝난 뒤 다시 말씀해 주세요.':'입력 접수 기록을 확인하고 입력 다시 준비를 눌러 주세요.'):'사용할 모델을 확인하고 진행 중인 응답이 끝난 뒤 다시 말씀해 주세요.');
      if (routing?.inputAvailable) { try{await routing.client.submit({entry:{entry_profile_id:profile.id,conversation_id:conversation.id},text,kind:conversation.messages.length?'follow_up':'prompt',resolves:[]});routingState.refresh();}catch(e){if(e instanceof RoutingPending){void pending.refresh();routingState.refresh();return;}throw e;} }
      else await action({ type: 'submit', profile_id: profile.id, conversation_id: conversation.id, prompt: text, kind: running.length ? 'steer' : 'prompt' });
    },
    cancelWork: async () => { for (const task of running) await action({ type: 'cancel', profile_id: profile.id, task_id: task.id }); },
  });
  const phoneCard = <VoicePanel profileId={profile.id} call={call} profileName={profile.name} enabled={voiceEnabled} disabledReason={voiceReason} runningTasks={running.length} onDismiss={() => setShowVoice(false)}/>;
  const openVoice = () => run(async () => {
    if (!conversation) {
      const result = await action({ type: 'create_conversation', profile_id: profile.id, model: selectedConversationModel(snapshot), tools: true });
      setConversationId(result.conversation_id); navigate(`/ghosts/${profile.id}?conversation=${result.conversation_id}`);
    }
    setShowVoice(true); if (wide) setShowContext(true);
  });

  useEffect(() => { if (!sending.current) { const created = createdModelDraft.current; if (created && created.id === conversation?.id) { const text = created.text; createdModelDraft.current = null; draftRef.current = text; setDraft(text); try { localStorage.setItem(draftKey, text); } catch { setError('초안을 저장하지 못했습니다. 보내기 전 내용을 복사해 두세요.'); } return; } try { const saved = localStorage.getItem(draftKey) || ''; draftRef.current = saved; setDraft(saved); } catch { setError('저장된 초안을 읽지 못했습니다.'); } } }, [draftKey]);
  useEffect(() => { if (fromRoute) setConversationId(fromRoute); }, [fromRoute]);
  const updateDraft = (text: string) => { draftRef.current = text; setDraft(text); try { localStorage.setItem(draftKey, text); } catch { setError('초안을 이 브라우저에 보관하지 못했습니다. 전송 전 내용을 복사해 두세요.'); } };
  const run = async (fn: () => Promise<void>) => { setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.'); } };
  const send = async (submitted: string) => {
    if (!submitted.trim() || busy || !connected || sending.current || modelBlocked || modelSaving || pending.blocking) return;
    const text = submitted, key = draftKey;
    sending.current = true; setError('');
    try {
      let cid = conversation?.id ?? createdConversation.current;
      if (!cid) { const created = await action({ type: 'create_conversation', profile_id: profile.id, model: selectedConversationModel(snapshot), tools: true }); cid = created.conversation_id; createdConversation.current = cid; }
      const conversationKey = `ghost-ui:draft:${snapshot.workspace_id}:${profile.id}:${cid}`;
      localStorage.setItem(conversationKey, text);
      if (routing?.inputAvailable) {
        await routing.client.submit({ entry: { entry_profile_id: profile.id, conversation_id: cid! }, text, kind:conversation?.messages.length?'follow_up':'prompt', resolves: [] });
        routingState.refresh();
      } else await action({ type: 'submit', profile_id: profile.id, conversation_id: cid, prompt: text, kind: running.length ? 'steer' : 'prompt' });
      if (draftRef.current.trim() === text) { localStorage.removeItem(key); localStorage.removeItem(conversationKey); draftRef.current = ''; setDraft(''); }
      else { localStorage.setItem(conversationKey, draftRef.current); if (key !== conversationKey) localStorage.removeItem(key); }
      setConversationId(cid!); createdConversation.current = null;
    } catch (e) {
      if(e instanceof RoutingPending||e instanceof RoutingTerminal){setError('');setConversationId(e.entry.conversation_id);createdConversation.current=null;navigate(`/ghosts/${profile.id}?conversation=${e.entry.conversation_id}`);void pending.refresh();routingState.refresh();}
      else setError(e instanceof Error ? e.message : '메시지를 보내지 못했습니다. 초안을 유지했습니다.');
    }
    finally { sending.current = false; }
  };
  const startConversation = () => run(async () => { const result = await action({ type: 'create_conversation', profile_id: profile.id, model: selectedConversationModel(snapshot), tools: true }); setConversationId(result.conversation_id); setHistory(false); navigate(`/ghosts/${profile.id}?conversation=${result.conversation_id}`); });
  const clarify = async (choice: ClarificationChoice) => {
    if (!connected || !routing || !conversation || !routing.capability.clarification_resolution || routing.inputAvailable === false || answeringRef.current || pending.blocking) return;
    const source = `${choice.source_admission_id}:${choice.source_segment_id}`;
    answeringRef.current = source; setAnswering(source); setClarificationError(undefined);
    try {
      await routing.client.submit({ entry: { entry_profile_id: profile.id, conversation_id: conversation.id }, text: choice.text, kind:'follow_up',
        resolves: [{ source_admission_id: choice.source_admission_id, source_segment_id: choice.source_segment_id, expected_input_hash: choice.expected_input_hash }],
        clarification_target: choice.target });
      routingState.refresh();
    } catch (e) { if(e instanceof RoutingPending||e instanceof RoutingTerminal){setClarificationError(undefined);void pending.refresh();routingState.refresh();}else setClarificationError({ source, message: e instanceof Error ? e.message : '답변 접수 결과를 확인하지 못했습니다. 같은 선택으로 다시 확인할 수 있습니다.' }); }
    finally { answeringRef.current = ''; setAnswering(''); }
  };
  const renderContext = (management = false) => <ConversationContext workContent={routingState.view?.works.length ? <RoutingWorkList view={routingState.view} profileId={profile.id} profiles={snapshot.profiles} onOpenWork={openWork}/> : undefined} workCount={routingState.view?.works.length} profile={profile} conversation={conversation} snapshot={snapshot} busy={busy} connected={connected} navigate={navigate} management={management} onVoice={() => void openVoice()} voiceAvailable={!busy && connected && mode !== 'demo'} onSettings={() => { setShowContext(false); setSettings(true); setError(''); }} onReview={review => { setShowContext(false); onReview(review); }} onCancel={task => void run(async () => { const request=pending.requests.find(request=>request.task_id===task.id);if(request)await pending.cancel(request);else await action({ type: 'cancel', profile_id: profile.id, task_id: task.id }); })} onSchedule={() => { setShowContext(false); setSchedule(true); setError(''); }}/>
  return <div className="flex h-full min-h-0 w-full min-w-0">
    <GConversation className={cn(!hasContent && 'conversation-is-empty')} label={`${profile.name}와 대화`} transcriptLabel={uiTerms.conversationHistory} jumpToLatestLabel="최신 메시지로 이동"
      scrollKey={conversationRows.length + reviews.length + running.length + (routingState.view?.admissions.length ?? 0)}
      header={<div className="grid gap-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">{onOpenNavigation && <Button type="button" variant="ghost" size="icon" aria-label={navigationOpen ? '탐색 사이드바 숨기기' : '탐색 사이드바 보기'} aria-expanded={navigationOpen} onClick={onOpenNavigation}><PanelLeft size={17}/></Button>}
            <h1 className="min-w-0"><button type="button" className="flex min-w-0 max-w-full items-center gap-1 rounded-chip px-1.5 py-0.5 text-ui font-medium text-ink-2 hover:bg-hover hover:text-ink" aria-label={`${conversation?.title ?? '새 대화'} · ${profile.name} ${uiTerms.conversationHistory}`} title={uiTerms.conversationHistory} onClick={() => setHistory(true)}><span className="truncate">{conversation?.title ?? '새 대화'}</span><History size={13} aria-hidden="true"/></button></h1>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button type="button" variant="ghost" size="icon" title="음성 통화" aria-label={call.state.active ? '전화 중 카드 보기' : '음성 통화 열기'} aria-pressed={showVoice} disabled={busy || !connected || mode === 'demo'} onClick={() => void openVoice()}><Phone size={17}/></Button>
            <Button type="button" variant="ghost" size="icon" aria-label="새 대화" title="새 대화" disabled={busy} onClick={() => void startConversation()}><Plus size={18}/></Button>
            <Button type="button" variant="ghost" size="icon" title={`${profile.name} 설정`} aria-label={`${profile.name} 설정`} onClick={() => { setSettings(true); setError(''); }}><Settings2 size={17}/></Button>
            <Button type="button" ref={contextToggle} variant="ghost" size="icon" className="relative" title={showContext ? '작업과 자료 숨기기' : '작업과 자료 보기'} aria-label={`${showContext ? '작업과 자료 숨기기' : '작업과 자료 보기'}${contextCount ? ` · ${contextCount}개 항목` : ''}`} aria-controls={showContext ? contextPanelId : undefined} aria-expanded={showContext} onClick={() => setShowContext(!showContext)}><PanelRight size={17}/>{contextCount > 0 && <Badge className="absolute -top-1 -right-1 h-4 min-w-4 px-1">{contextCount}</Badge>}</Button>
          </div>
        </div>
        {!wide && showVoice && <div id="live-phone-card">{phoneCard}</div>}
      </div>}
      composer={<GComposer variant="conversation" inputId="message-input" rows={1} value={draft} onValueChange={value => updateDraft(value.slice(0, 8192))} onSubmit={submitted => void send(submitted)}
        label={`${profile.name}에게 메시지`} placeholder="메시지 쓰기" submitLabel="메시지 보내기"
        inputRef={composerInput} disabled={pending.waiting} pending={pending.waiting}
        footer={mode === 'demo' ? <span className="text-caption text-ink-2">예시 모드</span> : <ConversationModelPicker snapshot={snapshot} profileId={profile.id} conversation={conversation} busy={busy} connected={connected} mode={mode} action={action} onCreated={id => { createdModelDraft.current = { id, text: draftRef.current }; setConversationId(id); navigate(`/ghosts/${profile.id}?conversation=${id}`); }} onSaving={setModelSaving} navigate={navigate} running={running.length > 0}/>}
        trailing={running.length > 0 && !pending.waiting ? <Button type="button" variant="ghost" size="icon" aria-label="진행 중 작업 취소" title="진행 중 작업 취소" disabled={busy || !connected} onClick={() => void run(async () => { for (const t of running) await action({ type: 'cancel', profile_id: profile.id, task_id: t.id }); })}><Square size={15}/></Button> : undefined}/>}
      footer={<div className="grid gap-2">
        <RoutingPendingInputs pending={pending} connected={connected}/>
        {modelBlocked && <p className="m-0 text-caption leading-relaxed text-ink-2" role="status">{conversation?.model_available === false ? conversation.model_error || '사용할 모델을 선택해 주세요. 작성한 메시지는 유지됩니다.' : '선택한 모델은 진행 중인 응답이 끝난 뒤 적용됩니다. 작성한 메시지는 유지됩니다.'}</p>}
        {error && <div className="flex items-start gap-2 rounded-card border border-line bg-surface px-3 py-2.5 text-caption text-ink" role="alert"><CircleAlert size={16} className="mt-0.5 shrink-0 text-red"/><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</span><Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" aria-label="오류 메시지 닫기" onClick={() => setError('')}><X size={14}/></Button></div>}
        <p id="composer-keyboard-help" className="sr-only m-0">Enter로 보내기 · Shift + Enter로 줄바꿈{running.length > 0 ? ' · 추가 지시는 진행 중인 응답에 전달됩니다.' : ''}</p>
      </div>}>
      {!hasContent && <div className="conversation-start grid justify-items-center gap-3 px-2 py-10 text-center">
        <DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={44}/>
        <h2 className="text-headingSm font-semibold text-ink">{profile.name}</h2>
        <p className="m-0 max-w-[46ch] text-ui leading-relaxed text-ink-2" title={profileSummary(profile.persona)}>{profileSummary(profile.persona)}</p>
        {profile.persona.trim() && <button type="button" className="flex items-center gap-1 rounded-chip px-1.5 py-0.5 text-caption text-ink-2 hover:bg-hover hover:text-ink" onClick={() => { setSettings(true); setError(''); }}>{uiTerms.roleInstructions}<ArrowUpRight size={12}/></button>}
        <div className="prompt-suggestions mx-auto mt-3 grid w-full max-w-[380px] gap-2" role="group" aria-label="대화 시작 제안">{conversationStarters(profile.persona).map(({ label, prompt }) => <button type="button" key={label} title={prompt} className="flex min-h-11 items-center justify-between gap-3 rounded-control border border-line px-3.5 py-3 text-left text-caption leading-relaxed hover:bg-hover" onClick={() => { updateDraft(prompt); composerInput.current?.focus(); }}>{label}<ArrowUpRight size={12} className="shrink-0 text-ink-3"/></button>)}</div>
      </div>}
      {profile.error && <div className="flex items-start gap-2 rounded-card border border-line bg-surface px-3 py-2.5 text-caption text-ink" role="alert"><CircleAlert size={16} className="mt-0.5 shrink-0 text-red"/><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{profile.error}</span></div>}
      {conversationRows.map(row => {
        if(row.kind==='admission')return <RoutingConversation key={row.receipt.admission.id} view={routingState.view?{...routingState.view,admissions:[row.receipt]}:null} error="" onRetry={routingState.refresh} onOpenWork={openWork} onClarify={connected && !pending.blocking && routing?.capability.clarification_resolution && routing.inputAvailable !== false ? choice => void clarify(choice) : undefined} answering={answering} clarificationError={clarificationError}/>;
        if(!conversation)return null;
        const {message:m,index}=row;
        const speaker = m.role === 'user' ? '나' : m.role === 'queued' ? '나 · 대기 중'
          : m.role === 'interrupted' ? `${profile.name} · 중단된 응답` : m.role === 'tool' ? '도구 기록' : profile.name;
        const toolTitle = m.tool?.output?.summary ?? m.tool?.name ?? '작업 결과';
        return <GConversationMessage key={`${conversation.id}:${index}`} role={m.role === 'user' || m.role === 'queued' ? 'user' : 'assistant'} label={speaker}>
          {m.role === 'tool' ? <DetailDialog title={toolTitle} label={<><Wrench size={14} aria-hidden="true"/>{toolTitle}</>}>
            <pre className="text-caption [overflow-wrap:anywhere]">{m.tool?.output?.content ? JSON.stringify(m.tool.output.content, null, 2) : m.text}</pre>
          </DetailDialog> : <>
            {(m.role === 'queued' || m.role === 'interrupted') && <strong className="text-caption font-semibold text-ink-2">{speaker}</strong>}
            <div className="text-body leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{m.role === 'interrupted' && !m.text
              ? (conversation.tasks.some(t => t.id === m.task_id && t.phase === 'cancelled') ? '요청을 취소했습니다.' : '응답이 중단되었습니다. 작업 상태를 확인한 뒤 다시 요청해 주세요.')
              : m.role === 'user' ? m.text : displayMessage(m.text, conversation)}</div>
          </>}
        </GConversationMessage>;
      })}
      {running.filter(t => t.phase === 'model_running').map(t => <GConversationMessage key={t.id} role="assistant" label={`${profile.name} · ${t.name} · ${phaseLabel(t.phase)}`}><div className="flex flex-wrap items-baseline gap-2 text-ui leading-relaxed"><strong className="font-medium [overflow-wrap:anywhere]">{t.name}</strong><span className="text-caption text-ink-2">{phaseLabel(t.phase)}</span>{!t.partial && <span className="thinking-dots self-center" aria-hidden="true"><i/><i/><i/></span>}</div>{t.partial && <div className="text-body leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{t.partial}</div>}</GConversationMessage>)}
      {reviews.filter(r => !conversation || r.conversation_id === conversation.id).map(r => <div className="rounded-card border border-line p-5" key={r.id}><div className="mb-3 flex items-center gap-2 text-caption"><FileText size={19} className="text-warning"/><span className="text-ink-2">저장 전 {uiTerms.reviews}</span></div><h3 className="mb-2 text-body font-semibold text-ink">{r.title}</h3><p className="mb-4 text-caption leading-relaxed text-ink-2">{r.body.replace(/^#+\s*/gm, '').slice(0, 110)}…</p><Button type="button" variant="secondary" onClick={() => onReview(r)}>검토하기<ArrowUpRight size={14}/></Button></div>)}
      {routingState.error&&<RoutingConversation view={null} error={routingState.error} onRetry={routingState.refresh} onOpenWork={openWork}/>}
      <CollaborationStrip snapshot={snapshot} profileId={profile.id} conversationId={conversation?.id} navigate={navigate}/>
      {running.filter(t => t.phase !== 'model_running').map(t => <div className="task-response-heading task-work-state" key={t.id} role="status" aria-label={`${profile.name} · ${t.name} · ${phaseLabel(t.phase)}`}><span className="activity-bars self-center" aria-hidden="true"><i/><i/><i/></span><strong>{t.name}</strong><span>{phaseLabel(t.phase)}</span></div>)}
    </GConversation>
    {showContext && (wide ? <aside id={contextPanelId} className="flex h-full min-h-0 w-[300px] shrink-0 flex-col border-l border-line" aria-label="작업과 자료" onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeContext(); } }}>
      <GPanel title="작업과 자료" onClose={closeContext} closeLabel="작업과 자료 숨기기" className="min-h-0 flex-1">
        {showVoice && <div id="live-phone-card" className="mb-3">{phoneCard}</div>}{renderContext(true)}
      </GPanel>
    </aside> : <Modal title="작업과 자료" onClose={closeContext} drawer><div id={contextPanelId} className="grid min-w-0 gap-3">{showVoice && <Button type="button" variant="ghost" size="sm" className="-ml-2 justify-self-start text-ink-2 hover:text-ink" onClick={() => { setShowContext(false); requestAnimationFrame(() => document.getElementById('live-phone-card')?.scrollIntoView({ block: 'nearest' })); }}><Phone size={16}/>음성 통화 카드 보기<ArrowUpRight size={14}/></Button>}{renderContext(true)}</div></Modal>)}
    {history && <Modal title={`${profile.name} · ${uiTerms.conversationHistory}`} onClose={() => setHistory(false)}><div className="grid max-h-[400px] gap-1 overflow-y-auto">{profile.conversations.map(c => <button key={c.id} type="button" className={cn('flex min-w-0 items-center gap-2.5 rounded-control px-2 py-2.5 text-left text-ui text-ink hover:bg-hover', c.id === conversation?.id && 'bg-hover')} onClick={() => { setConversationId(c.id); setHistory(false); navigate(`/ghosts/${profile.id}?conversation=${c.id}`); }}><MessageCircle size={17} className="shrink-0 text-ink-2"/><span className="min-w-0 flex-1 truncate">{c.title}</span>{c.id === conversation?.id && <Check size={15} className="shrink-0"/>}</button>)}</div><Button type="button" variant="secondary" className="mt-3 w-full" disabled={busy} onClick={() => void startConversation()}><Plus size={16}/>새 대화</Button>{error && <p className="m-0 mt-2 text-caption whitespace-pre-wrap text-red" role="alert">{error}</p>}</Modal>}
    {selectedWork && routingState.view && routing && <RoutingWorkDetail key={selectedWork.id} work={selectedWork} view={routingState.view} capability={routing.capability} results={snapshot.routing_results?.results} bindings={snapshot.routing_results?.bindings} observations={snapshot.routing_results?.evidence} effectObservations={snapshot.routing_results?.effect_evidence} onClose={() => setSelectedWorkId('')}/>}
    {settings && <Modal title={`${profile.name} 설정`} onClose={() => !busy && setSettings(false)}>
      <form className="grid gap-5" onSubmit={e => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        void run(async () => {
          await action({ type: 'workspace', action: { type: 'persona', profile_id: profile.id, persona: String(form.get('persona')) } });
          const voice = form.get('voice') === 'on';
          const web = form.get('web') === 'on';
          const memory = form.get('memory') === 'on';
          const worker = form.get('worker') === 'on';
          const codeWorker = form.get('code_worker') === 'on';
          if (voice !== (profile.policy.voice === true) || web !== (profile.policy.web === true) || memory !== (profile.policy.memory === true) || worker !== (profile.policy.external_worker === true) || codeWorker !== (profile.policy.code_worker === true)) {
            await action({ type: 'workspace', action: { type: 'policy', profile_id: profile.id, policy: { ...profile.policy, voice, web, memory, external_worker: worker, code_worker: codeWorker } } });
          }
          setSettings(false);
        });
      }}>
        <div className="grid justify-items-center gap-2"><DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={84}/><h3 className="text-body font-semibold text-ink">{profile.name}</h3><Button type="button" variant="secondary" onClick={() => { setSettings(false); navigate(`/settings?tab=pets&ghost=${encodeURIComponent(profile.id)}`); }}>아바타 변경</Button></div>
        <label className="grid gap-2 text-caption font-medium">{uiTerms.roleInstructions}<Textarea name="persona" defaultValue={profile.persona} rows={4} maxLength={4096} required/></label>
        <div className="grid gap-1.5"><label className="flex items-center gap-2 text-caption"><input type="checkbox" name="voice" defaultChecked={profile.policy.voice === true} data-slot="native-checkbox"/>이 Ghost와 음성으로 대화</label>
        <p className="m-0 text-caption leading-relaxed text-ink-2">선택한 로컬 STT·TTS 모델을 사용합니다. 마이크 권한은 통화를 시작할 때 요청합니다.</p></div>
        <div className="grid gap-1.5"><label className="flex items-center gap-2 text-caption"><input type="checkbox" name="web" defaultChecked={profile.policy.web === true} data-slot="native-checkbox"/>공개 웹 검색과 페이지 읽기 허용</label>
        <p className="m-0 text-caption leading-relaxed text-ink-2">설정된 OxiBrowser CLI만 사용합니다. 검색어는 DuckDuckGo에 전달됩니다.</p></div>
        <div className="grid gap-1.5"><label className="flex items-center gap-2 text-caption"><input type="checkbox" name="memory" defaultChecked={profile.policy.memory === true} data-slot="native-checkbox"/>이 Ghost의 기억 읽기와 저장 허용</label>
        <p className="m-0 text-caption leading-relaxed text-ink-2">호스트에 연결한 기억 공간만 사용합니다. 주 Ghost의 개인 기억은 허용된 로컬 추론에서만 읽고 저장하며, 모델 요약은 검수된 사실이 아닙니다.</p></div>
        <div className="grid gap-1.5"><label className="flex items-center gap-2 text-caption"><input type="checkbox" name="worker" defaultChecked={profile.policy.external_worker === true} data-slot="native-checkbox"/>OMP 구독 분석 작업자 허용</label>
        <p className="m-0 text-caption leading-relaxed text-ink-2">일반 개발·조사만 보내고 금융 원장·자격 증명·민감 기록은 제외하세요. 호스트에 등록한 MiniMax Code 모델로 요청문을 전송합니다. 운영체제 수준의 파일 격리는 아닙니다. Codex 작업자와 합산해 UTC 기준 하루 Ghost당 4회, 이 호스트 전체 12회로 제한합니다.</p></div>
        <div className="grid gap-1.5"><label className="flex items-center gap-2 text-caption"><input type="checkbox" name="code_worker" defaultChecked={profile.policy.code_worker === true} data-slot="native-checkbox"/>Codex 구독 코드 작업자 허용</label>
        <p className="m-0 text-caption leading-relaxed text-ink-2">허용 목록의 저장소에서 커밋된 HEAD만 임시 복제해 편집합니다. 원본 checkout에는 반영하지 않고, macOS workspace-write 샌드박스와 명령 네트워크·웹 검색·MCP·사용자 환경 상속 비활성 상태로 실행합니다. 결과 패치를 검토한 뒤 별도로 적용하세요. 코드와 요청은 Codex 구독으로 OpenAI에 전송되므로 금융 자료·자격 증명·민감 기록은 보내지 마세요.</p></div>
        <div className="grid gap-1"><span className="text-caption font-medium">현재 허용된 도구</span><p className="m-0 text-caption leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{Object.entries(profile.policy).filter(([k,v]) => ['browser','shell','memory','delegation','voice','web','external_worker','code_worker'].includes(k) && v === true).map(([k]) => ({ browser: '브라우저', shell: '셸', memory: '기억', delegation: '위임', voice: '음성', web: '웹 검색·읽기', external_worker: 'OMP 분석 작업자', code_worker: 'Codex 코드 작업자' }[k])).join(' · ') || '설정된 도구가 없습니다'}</p></div>
        {error && <p className="m-0 text-caption whitespace-pre-wrap text-red" role="alert">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? '저장 중…' : '설정 저장'}</Button>
      </form>
    </Modal>}
    {schedule && conversation && <Modal title={`${uiTerms.schedules} 예약`} onClose={() => !busy && setSchedule(false)}><form className="grid gap-5" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void run(async () => { await action({ type: 'add_schedule', profile_id: profile.id, conversation_id: conversation.id, prompt: String(f.get('prompt')), interval_seconds: Number(f.get('interval')) }); setSchedule(false); }); }}><label className="grid gap-2 text-caption font-medium">반복할 일<Textarea name="prompt" placeholder="새로운 소식이 있으면 요약해줘." rows={3} maxLength={8192} required/></label><label className="grid gap-2 text-caption font-medium">반복 간격<select name="interval" defaultValue="86400" data-slot="native-select" className="w-full"><option value="3600">1시간마다</option><option value="86400">하루마다</option><option value="604800">일주일마다</option></select></label><p className="m-0 text-caption leading-relaxed text-ink-2">첫 실행은 선택한 간격 이후입니다.</p>{error && <p className="m-0 text-caption whitespace-pre-wrap text-red" role="alert">{error}</p>}<Button type="submit" disabled={busy}>{busy ? '저장 중…' : '반복 작업 예약'}</Button></form></Modal>}
  </div>;
}

function displayMessage(text: string, conversation: Conversation) {
  if (conversation.offline) { try { const data = JSON.parse(text); if (data.provider === 'mock' && typeof data.last_input === 'string') return `오프라인 모델이 입력을 확인했습니다.\n\n${data.last_input}`; } catch { /* ordinary text */ } }
  return text;
}

function runningTasksIn(conversation?: Conversation) { return conversation?.tasks.some(task => isRunning(task.phase)) ?? false; }
