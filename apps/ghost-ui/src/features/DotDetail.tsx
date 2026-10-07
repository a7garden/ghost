import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, Check, ChevronDown, FileText, MessageCircle, Plus, Settings2, Square, PanelRight, CircleAlert, X, Phone, Menu } from 'lucide-react';
import { DotAvatar } from '../components/DotAvatar';
import { Status } from '../components/Status';
import { Modal } from '../components/Modal';
import { dotState, isRunning, phaseLabel, toneFor } from '../client/types';
import type { Profile, Snapshot, Review, Command, Conversation } from '../client/types';
import { CollaborationStrip } from './CollaborationView';
import { VoicePanel, useVoiceCall } from '../voice/VoicePanel';
import { useAvatarSpeaking } from '../pets/AvatarProvider';
import { ConversationContext } from './ConversationContext';
import { contextualCards } from './contextProjection';
import { ConversationModelPicker } from './ConversationModelPicker';
import { RoutingConversation, RoutingWorkList, RoutingWorkDetail, useRoutingConversation } from './RoutingConversation';
import type { RoutingConnection, ClarificationChoice } from './RoutingConversation';
import { selectedConversationModel } from './modelSelection';
import { routingTimeline } from '../client/routingTimeline';
import {RoutingPending,RoutingTerminal} from '../client/errors';
import {RoutingPendingInputs,usePendingRouting} from './RoutingPending';

type Props = { routing?: RoutingConnection; profile: Profile; snapshot: Snapshot; mode: string; action: (command: Command) => Promise<Record<string, any>>; busy: boolean; connected: boolean; navigate: (route: string) => void; route: string; onReview: (review: Review) => void; onOpenNavigation?: () => void };
export function DotDetail({ routing, profile, snapshot, mode, action, busy, connected, navigate, route, onReview, onOpenNavigation }: Props) {
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
  const [draft, setDraft] = useState(''), [error, setError] = useState(''), [settings, setSettings] = useState(false), [history, setHistory] = useState(false), [schedule, setSchedule] = useState(false), [showContext, setShowContext] = useState(false), [showVoice, setShowVoice] = useState(false);
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 76rem)').matches);
  const [voiceCollapsed, setVoiceCollapsed] = useState(false), [modelSaving, setModelSaving] = useState(false);
  const [disclosures, setDisclosures] = useState<Record<string, Record<string, boolean>>>({});
  const contextKey = `${snapshot.workspace_id}:${profile.id}:${conversation?.id ?? 'new'}`;
  const disclosure = disclosures[contextKey] ?? {};
  const onDisclosure = (category: string, open: boolean) => setDisclosures(previous => ({ ...previous, [contextKey]: { ...previous[contextKey], [category]: open } }));
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
  const messagesEnd = useRef<HTMLDivElement>(null), scrollArea = useRef<HTMLDivElement>(null), stayAtBottom = useRef(true);
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
        catch{setError('요청은 접수됐지만 초안 표시를 정리하지 못했습니다. 접수 이력을 확인해 주세요.');}
      }
    }
  });
  const onSpeakingChange = useAvatarSpeaking(profile.id);
  const replyMessage = conversation?.messages.map((message, index) => ({ message, index })).reverse().find(({ message }) => message.role === 'assistant' && message.text.trim() && conversation.tasks.some(task => task.id === message.task_id && task.phase === 'complete'));
  const latestVoiceReply = replyMessage && conversation ? { id: `${conversation.id}:${replyMessage.message.task_id}:${replyMessage.index}`, taskId: replyMessage.message.task_id!, text: replyMessage.message.text } : undefined;
  const voiceEnabled = connected && mode !== 'demo' && profile.policy.voice === true && Boolean(conversation);
  const voiceReason = profile.policy.voice !== true ? 'Ghost 설정에서 음성 사용을 허용해 주세요.' : 'Ghost 호스트에 연결해 주세요.';
  const call = useVoiceCall({ profileId: profile.id, conversationId: conversation?.id ?? '', profileName: profile.name, enabled: voiceEnabled, runningTasks: running.length, latestReply: latestVoiceReply, onSpeakingChange,
    submitTranscript: async text => {
      if (!connected || mode === 'demo') throw new Error('Ghost 호스트에 다시 연결해 주세요.');
      if (!conversation || modelBlocked || modelSaving || pending.blocking) throw new Error(pending.blocking?(pending.waiting?'이전 입력의 접수 상태를 확인하고 있어요. 확인이나 취소가 끝난 뒤 다시 말씀해 주세요.':'입력 접수 기록을 확인하고 입력 다시 준비를 눌러 주세요.'):'사용할 모델을 확인하고 진행 중인 응답이 끝난 뒤 다시 말씀해 주세요.');
      if (routing?.inputAvailable) { try{await routing.client.submit({entry:{entry_profile_id:profile.id,conversation_id:conversation.id},text,kind:conversation.messages.length?'follow_up':'prompt',resolves:[]});routingState.refresh();}catch(e){if(e instanceof RoutingPending){void pending.refresh();routingState.refresh();return;}throw e;} }
      else await action({ type: 'submit', profile_id: profile.id, conversation_id: conversation.id, prompt: text, kind: running.length ? 'steer' : 'prompt' }); stayAtBottom.current = true;
    },
    cancelWork: async () => { for (const task of running) await action({ type: 'cancel', profile_id: profile.id, task_id: task.id }); },
  });
  const phoneCard = <VoicePanel profileId={profile.id} call={call} profileName={profile.name} enabled={voiceEnabled} disabledReason={voiceReason} runningTasks={running.length} collapsed={voiceCollapsed} onCollapse={() => setVoiceCollapsed(value => !value)} onDismiss={() => setShowVoice(false)}/>;
  const openVoice = () => run(async () => {
    if (!conversation) {
      const result = await action({ type: 'create_conversation', profile_id: profile.id, model: selectedConversationModel(snapshot), tools: true });
      setConversationId(result.conversation_id); navigate(`/ghosts/${profile.id}?conversation=${result.conversation_id}`);
    }
    setShowVoice(true); setVoiceCollapsed(false);
  });

  useEffect(() => { if (!sending.current) { if (createdModelDraft.current?.id === conversation?.id) { const text = createdModelDraft.current!.text; createdModelDraft.current = null; draftRef.current = text; setDraft(text); try { localStorage.setItem(draftKey, text); } catch { setError('초안을 저장하지 못했습니다. 보내기 전 내용을 복사해 두세요.'); } return; } try { const saved = localStorage.getItem(draftKey) || ''; draftRef.current = saved; setDraft(saved); } catch { setError('저장된 초안을 읽지 못했습니다.'); } } }, [draftKey]);
  useEffect(() => { if (fromRoute) setConversationId(fromRoute); }, [fromRoute]);
  useEffect(() => { if (stayAtBottom.current) messagesEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [conversation?.messages.length, conversation?.tasks.map(t => t.partial).join(''), reviews.length, routingState.view?.admissions.length]);
  useEffect(() => { const input = composerInput.current; if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; } }, [draft, wide]);
  const updateDraft = (text: string) => { draftRef.current = text; setDraft(text); try { localStorage.setItem(draftKey, text); } catch { setError('초안을 이 브라우저에 보관하지 못했습니다. 전송 전 내용을 복사해 두세요.'); } };
  const run = async (fn: () => Promise<void>) => { setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.'); } };
  const send = async () => {
    if (!draft.trim() || busy || !connected || sending.current || modelBlocked || modelSaving || pending.blocking) return;
    const text = draft, key = draftKey;
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
      if (draftRef.current === text) { localStorage.removeItem(key); localStorage.removeItem(conversationKey); draftRef.current = ''; setDraft(''); }
      else { localStorage.setItem(conversationKey, draftRef.current); if (key !== conversationKey) localStorage.removeItem(key); }
      setConversationId(cid!); createdConversation.current = null; stayAtBottom.current = true;
    } catch (e) {
      if(e instanceof RoutingPending||e instanceof RoutingTerminal){setError('');setConversationId(e.entry.conversation_id);createdConversation.current=null;navigate(`/ghosts/${profile.id}?conversation=${e.entry.conversation_id}`);void pending.refresh();routingState.refresh();}
      else setError(e instanceof Error ? e.message : '메시지를 보내지 못했습니다. 초안을 유지했어요.');
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
      routingState.refresh(); stayAtBottom.current = true;
    } catch (e) { if(e instanceof RoutingPending||e instanceof RoutingTerminal){setClarificationError(undefined);void pending.refresh();routingState.refresh();}else setClarificationError({ source, message: e instanceof Error ? e.message : '답변 접수 결과를 확인하지 못했습니다. 같은 선택으로 다시 확인할 수 있습니다.' }); }
    finally { answeringRef.current = ''; setAnswering(''); }
  };
  const renderContext = (management = false) => <ConversationContext workContent={routingState.view?.works.length ? <RoutingWorkList view={routingState.view} profileId={profile.id} profiles={snapshot.profiles} onOpenWork={openWork}/> : undefined} workCount={routingState.view?.works.length} profile={profile} conversation={conversation} snapshot={snapshot} busy={busy} connected={connected} navigate={navigate} disclosure={disclosure} onDisclosure={onDisclosure} management={management} onVoice={() => void openVoice()} voiceAvailable={!busy && connected && mode !== 'demo'} onSettings={() => { setShowContext(false); setSettings(true); setError(''); }} onReview={review => { setShowContext(false); onReview(review); }} onCancel={task => void run(async () => { const request=pending.requests.find(request=>request.task_id===task.id);if(request)await pending.cancel(request);else await action({ type: 'cancel', profile_id: profile.id, task_id: task.id }); })} onSchedule={() => { setShowContext(false); setSchedule(true); setError(''); }}/>
  return <div className={`dot-detail ${contextCount > 0 ? 'has-context-cards' : ''}`}>
    <section className="conversation-column" aria-label={`${profile.name}와 대화`}>
      <header className="conversation-toolbar"><div className="conversation-identity">{onOpenNavigation && <button type="button" className="icon-button mobile-toggle" aria-label="탐색 메뉴 열기" onClick={onOpenNavigation}><Menu size={19}/></button>}<button className="avatar-edit-button" aria-label={`${profile.name} 아바타 변경`} onClick={() => navigate(`/settings?tab=pets&ghost=${encodeURIComponent(profile.id)}`)}><DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={28}/></button><h1 className="conversation-heading"><span className="conversation-profile-name">{profile.name}</span><button className="text-button conversation-title" aria-label={`${conversation?.title ?? '새 대화'} · ${profile.name} 대화 이력`} title="대화 이력" onClick={() => setHistory(true)}><span>{conversation?.title ?? '새 대화'}</span><ChevronDown size={13}/></button></h1></div><div className="conversation-toolbar-actions"><button className="icon-button conversation-toolbar-voice" title="음성 통화" aria-label={call.state.active ? '전화 중 카드 보기' : '음성 통화 열기'} aria-pressed={showVoice} disabled={busy || !connected || mode === 'demo'} onClick={() => void openVoice()}><Phone size={17}/></button><button className="icon-button" aria-label="새 대화" title="새 대화" disabled={busy} onClick={() => void startConversation()}><Plus size={18}/></button><button className="icon-button conversation-toolbar-settings" title={`${profile.name} 설정`} aria-label={`${profile.name} 설정`} onClick={() => { setSettings(true); setError(''); }}><Settings2 size={17}/></button><button className="icon-button context-toggle" title="작업과 자료" aria-label={`작업과 자료 보기${contextCount ? ` · ${contextCount}개 항목` : ''}`} aria-expanded={showContext} onClick={() => setShowContext(true)}><PanelRight size={17}/>{contextCount > 0 && <span className="context-toggle-count">{contextCount}</span>}</button></div></header>
      {!wide && showVoice && <div className="inline-phone-card" id="live-phone-card">{phoneCard}</div>}
      <div className="conversation-scroll" ref={scrollArea} onScroll={() => { const el = scrollArea.current!; stayAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
        <div className="chat-inner">
          {!hasContent && <div className="dot-introduction"><button className="avatar-edit-button" aria-label={`${profile.name} 아바타 변경`} onClick={() => navigate(`/settings?tab=pets&ghost=${encodeURIComponent(profile.id)}`)}><DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={72}/></button><h1>{profile.name}</h1>{profile.persona.trim() && <p>{profile.persona}</p>}<Status state={dotState(profile, reviews)}/></div>}
          {profile.error && <div className="inline-error" role="alert"><CircleAlert size={17}/>{profile.error}</div>}
          <div className="messages" role="log" aria-label="대화 이력" aria-live="polite" aria-relevant="additions text">
            {conversationRows.map(row => {
              if(row.kind==='admission')return <RoutingConversation key={row.receipt.admission.id} view={routingState.view?{...routingState.view,admissions:[row.receipt]}:null} error="" onRetry={routingState.refresh} onOpenWork={openWork} onClarify={connected && !pending.blocking && routing?.capability.clarification_resolution && routing.inputAvailable !== false ? choice => void clarify(choice) : undefined} answering={answering} clarificationError={clarificationError}/>;
              if(!conversation)return null;
              const {message:m,index}=row;
              return <article key={`${conversation?.id}:${index}`} className={`message message-${m.role}`}>
              {m.role === 'tool' ? <details className="tool-result"><summary><Check size={15}/><span>{m.tool?.output?.summary ?? m.tool?.name ?? '작업 결과'}</span><ChevronDown size={13}/></summary><pre>{m.tool?.output?.content ? JSON.stringify(m.tool.output.content, null, 2) : m.text}</pre></details> : m.role === 'user' ? <div className="user-bubble">{m.text}</div> : <><div className="message-speaker"><DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={25}/><strong>{m.role === 'interrupted' ? `${profile.name} · 중단된 응답` : m.role === 'queued' ? '나 · 대기 중' : profile.name}</strong></div><div className="message-body">{m.role === 'interrupted' && !m.text ? (conversation.tasks.some(t => t.id === m.task_id && t.phase === 'cancelled') ? '요청을 취소했습니다.' : '응답이 중단되었습니다. 작업 상태를 확인한 뒤 다시 요청해 주세요.') : displayMessage(m.text, conversation)}</div></>}
            </article>;})}
            {!hasContent && <div className="conversation-empty"><div className="prompt-suggestions">{['함께할 수 있는 일을 알려줘', '새로운 아이디어를 정리하고 싶어', '자료를 찾아서 비교해줘'].map(text => <button key={text} onClick={() => updateDraft(text)}>{text}<ArrowUpRight size={14}/></button>)}</div></div>}
            {running.filter(t => t.phase === 'model_running').map(t => <article key={t.id} className="message message-stream" aria-label={`${profile.name} · ${t.name} · ${phaseLabel(t.phase)}`}><div className="task-response-heading"><strong>{t.name}</strong><span>{phaseLabel(t.phase)}</span>{!t.partial && <span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span>}</div>{t.partial && <div className="message-body">{t.partial}</div>}</article>)}
            {reviews.filter(r => !conversation || r.conversation_id === conversation.id).map(r => <div className="inline-review" key={r.id}><div className="inline-review-header"><FileText size={19}/><span>저장 전 확인</span></div><h3>{r.title}</h3><p>{r.body.replace(/^#+\s*/gm, '').slice(0, 110)}…</p><button className="button secondary" onClick={() => onReview(r)}>초안 검토<ArrowUpRight size={14}/></button></div>)}
            {routingState.error&&<RoutingConversation view={null} error={routingState.error} onRetry={routingState.refresh} onOpenWork={openWork}/>}
            <CollaborationStrip snapshot={snapshot} profileId={profile.id} conversationId={conversation?.id} navigate={navigate}/>
            {running.filter(t => t.phase !== 'model_running').map(t => <div className="task-response-heading task-work-state" key={t.id} role="status" aria-label={`${profile.name} · ${t.name} · ${phaseLabel(t.phase)}`}><span className="activity-bars" aria-hidden="true"><i/><i/><i/></span><strong>{t.name}</strong><span>{phaseLabel(t.phase)}</span></div>)}
            <div ref={messagesEnd}/>
          </div>
        </div>
      </div>
      <div className="composer-area"><div className="composer-inner"><RoutingPendingInputs pending={pending} connected={connected}/>{modelBlocked && <p className="composer-model-block" role="status">{conversation?.model_available === false ? conversation.model_error || '사용할 모델을 선택해 주세요. 작성한 메시지는 유지됩니다.' : '선택한 모델은 진행 중인 응답이 끝난 뒤 적용됩니다. 작성한 메시지는 유지됩니다.'}</p>}{error && <div className="inline-error" role="alert"><CircleAlert size={16}/><span>{error}</span><button className="icon-button" aria-label="오류 메시지 닫기" onClick={() => setError('')}><X size={14}/></button></div>}<form className="composer" onSubmit={e => { e.preventDefault(); void send(); }}><label className="sr-only" htmlFor="message-input">{profile.name}에게 메시지</label><textarea ref={composerInput} id="message-input" disabled={pending.waiting} aria-describedby="composer-keyboard-help" placeholder={`${profile.name}에게 이야기하세요…`} value={draft} maxLength={8192} rows={1} onChange={e => updateDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/><div className="composer-bottom"><div className="composer-context"><ConversationModelPicker snapshot={snapshot} profileId={profile.id} conversation={conversation} busy={busy} connected={connected} mode={mode} action={action} onCreated={id => { createdModelDraft.current = { id, text: draftRef.current }; setConversationId(id); navigate(`/ghosts/${profile.id}?conversation=${id}`); }} onSaving={setModelSaving} navigate={navigate} running={running.length > 0}/></div><div className="composer-actions">{running.length > 0 && !pending.waiting && <button type="button" className="icon-button" aria-label="진행 중 작업 취소" title="진행 중 작업 취소" disabled={busy || !connected} onClick={() => void run(async () => { for (const t of running) await action({ type: 'cancel', profile_id: profile.id, task_id: t.id }); })}><Square size={15}/></button>}<button className="send-button" type="submit" disabled={!draft.trim() || busy || !connected || modelBlocked || modelSaving || pending.blocking} aria-label="메시지 보내기">{busy ? <span className="button-loading"/> : <ArrowUp size={20}/>}</button></div></div></form><p id="composer-keyboard-help" className="sr-only">Enter로 보내기 · Shift + Enter로 줄바꿈{running.length > 0 ? ' · 추가 지시는 진행 중인 응답에 전달됩니다.' : ''}</p>{mode === 'demo' && <p className="composer-caption">예시 모드</p>}</div></div>
    </section>
    {wide && contextCount > 0 && <aside className="context-deck" aria-label="이 대화의 카드">{showVoice && <div id="live-phone-card">{phoneCard}</div>}{renderContext()}</aside>}
    {showContext && <Modal title="작업과 자료" onClose={() => setShowContext(false)} drawer><div className="mobile-context context-stack-shell">{showVoice && <button className="context-phone-link" onClick={() => { setShowContext(false); setVoiceCollapsed(false); requestAnimationFrame(() => document.getElementById('live-phone-card')?.scrollIntoView({ block: 'nearest' })); }}><Phone size={16}/>음성 통화 카드 보기<ArrowUpRight size={14}/></button>}{renderContext(true)}</div></Modal>}
    {history && <Modal title={`${profile.name}와 나눈 대화`} onClose={() => setHistory(false)}><div className="history-list">{profile.conversations.map(c => <button key={c.id} className={c.id === conversation?.id ? 'selected' : ''} onClick={() => { setConversationId(c.id); setHistory(false); stayAtBottom.current = true; navigate(`/ghosts/${profile.id}?conversation=${c.id}`); }}><MessageCircle size={17}/><span>{c.title}</span>{c.id === conversation?.id && <Check size={15}/>}</button>)}</div><button className="button secondary full-width" disabled={busy} onClick={() => void startConversation()}><Plus size={16}/>새 대화</button>{error && <p className="form-error" role="alert">{error}</p>}</Modal>}
    {selectedWork && routingState.view && routing && <RoutingWorkDetail key={selectedWork.id} work={selectedWork} view={routingState.view} capability={routing.capability} results={snapshot.routing_results?.results} bindings={snapshot.routing_results?.bindings} observations={snapshot.routing_results?.evidence} effectObservations={snapshot.routing_results?.effect_evidence} onClose={() => setSelectedWorkId('')}/>}
    {settings && <Modal title={`${profile.name} 설정`} onClose={() => !busy && setSettings(false)}><form className="form-stack" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); void run(async () => { await action({ type: 'workspace', action: { type: 'persona', profile_id: profile.id, persona: String(form.get('persona')) } }); const voice = form.get('voice') === 'on'; if (voice !== (profile.policy.voice === true)) await action({ type: 'workspace', action: { type: 'policy', profile_id: profile.id, policy: { ...profile.policy, voice } } }); setSettings(false); }); }}><div className="settings-avatar"><DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={84}/><h3>{profile.name}</h3><button type="button" className="button secondary" onClick={() => { setSettings(false); navigate(`/settings?tab=pets&ghost=${encodeURIComponent(profile.id)}`); }}>아바타 변경</button></div><label>역할과 성격<textarea name="persona" defaultValue={profile.persona} rows={4} maxLength={4096} required/></label><label className="checkbox-row"><input type="checkbox" name="voice" defaultChecked={profile.policy.voice === true}/>이 Ghost와 음성으로 대화</label><p className="field-help">선택한 로컬 STT·TTS 모델을 사용합니다. 마이크 권한은 통화를 시작할 때 요청합니다.</p><div className="permission-summary"><span>현재 허용된 도구</span><p>{Object.entries(profile.policy).filter(([k,v]) => ['browser','shell','memory','delegation','voice'].includes(k) && v === true).map(([k]) => ({ browser: '브라우저', shell: '셸', memory: '기억', delegation: '위임', voice: '음성' }[k])).join(' · ') || '설정된 도구가 없습니다'}</p></div>{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full-width" disabled={busy}>{busy ? '저장 중…' : '설정 저장'}</button></form></Modal>}
    {schedule && conversation && <Modal title="반복 작업 예약" onClose={() => !busy && setSchedule(false)}><form className="form-stack" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void run(async () => { await action({ type: 'add_schedule', profile_id: profile.id, conversation_id: conversation.id, prompt: String(f.get('prompt')), interval_seconds: Number(f.get('interval')) }); setSchedule(false); }); }}><label>반복할 일<textarea name="prompt" placeholder="새로운 소식이 있으면 요약해줘." rows={3} maxLength={8192} required/></label><label>반복 간격<select name="interval" defaultValue="86400"><option value="3600">1시간마다</option><option value="86400">하루마다</option><option value="604800">일주일마다</option></select></label><p className="field-help">첫 실행은 선택한 간격 이후입니다.</p>{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary" disabled={busy}>{busy ? '저장 중…' : '예약 저장'}</button></form></Modal>}
  </div>;
}

function displayMessage(text: string, conversation: Conversation) {
  if (conversation.offline) { try { const data = JSON.parse(text); if (data.provider === 'mock' && typeof data.last_input === 'string') return `오프라인 모델이 입력을 확인했습니다.\n\n${data.last_input}`; } catch { /* ordinary text */ } }
  return text;
}

function runningTasksIn(conversation?: Conversation) { return conversation?.tasks.some(task => isRunning(task.phase)) ?? false; }
