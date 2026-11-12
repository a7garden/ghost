import { useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { BriefcaseBusiness, Clock3, Paperclip, Square, X } from 'lucide-react';
import type { ArtifactRef, Ghost } from '@ghost/contract';
import { Composer } from '../ui';
import { ComposerPlus, type PlusAction } from '../components/composer/ComposerPlus';
import { ComposerSuggest, type Suggestion } from '../components/composer/ComposerSuggest';
import { AttachmentTray, useAttachments, type PendingAttachment } from '../components/composer/attachments';
import { DotAvatar } from '../components/DotAvatar';
import { ModelPicker } from '../pets/ModelPicker';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { toneFor } from './ghostState';
import { useProjectMentions } from '../components/composer/ProjectMentions';
import type { MessageSend } from './outbox';
import { WorkModelFields } from './WorkModelFields';

/** Words each `/` command also answers to, so `/파일` and `/work` find the same action. */
const commandWords: Record<string, string[]> = {
  files: ['첨부', '파일', '사진', 'file', 'attach'],
  work: ['맡기기', '일', 'work', 'assign'],
  later: ['나중', '예약', 'later', 'schedule'],
};

type Mode = 'talk' | 'work' | 'later';

/** Quick send-later moments, each resolved against the current time when chosen. */
const whenPresets: { id: string; label: string; at(now: Date): Date }[] = [
  { id: 'hour', label: '1시간 뒤', at: now => new Date(now.getTime() + 60 * 60_000) },
  { id: 'evening', label: '오늘 저녁 6시', at: now => { const at = new Date(now); at.setHours(18, 0, 0, 0); if (at <= now) at.setDate(at.getDate() + 1); return at; } },
  { id: 'morning', label: '내일 아침 9시', at: now => { const at = new Date(now); at.setDate(at.getDate() + 1); at.setHours(9, 0, 0, 0); return at; } },
];
const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const whenLabel = (at: number) => new Date(at).toLocaleString('ko-KR', { month: 'short', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * The conversation's composer. + on the left adds files, turns the message into a 맡긴 일, or sends it later;
 * the model and send sit on the right. Each mode shows a token above the text and only the fields it needs.
 * Typing `/` at the start offers the same actions by keyboard; `@` hands the message to a Ghost as a 맡긴 일
 * that reports back here.
 */
export function ChatComposer({ ghost, conversationId, running, busy, draft, setDraft, returnedFiles, setReturnedFiles, inputRef, onPost, onStop, onError, initialScopeIds = [], initialMode = 'talk' }: {
  ghost: Ghost;
  conversationId: string | null;
  running: boolean;
  /** The conversation is generating: the model cannot change until it ends. */
  busy: boolean;
  draft: string;
  setDraft(value: string): void;
  /** Files of a message the owner took back from the conversation; already uploaded, so they ride along as they are. */
  returnedFiles: readonly ArtifactRef[];
  setReturnedFiles(files: ArtifactRef[]): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** A message joins the conversation at once; its row carries sending, waiting and failure. */
  onPost(command: MessageSend): void;
  onStop(): void;
  onError(message: string): void;
  initialScopeIds?: string[];
  initialMode?: 'talk' | 'work';
}) {
  const { client, store } = useHost();
  const { state } = useHostState(store);
  const attachments = useAttachments();
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  /** Who a 맡긴 일 goes to; null is this conversation's Ghost. */
  const [assignee, setAssignee] = useState<Ghost | null>(null);
  const [criteria, setCriteria] = useState('');
  const [deadline, setDeadline] = useState('');
  const [slot, setSlot] = useState(''), [retrySlot, setRetrySlot] = useState('');
  const [laterAt, setLaterAt] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  /** Why the last chosen action could not run; shown while that reason still holds. */
  const [blocked, setBlocked] = useState('');
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const suggestId = useId();
  const projects = useProjectMentions(draft, setDraft, inputRef, initialScopeIds, sending || mode === 'later');

  const focus = () => inputRef.current?.focus();
  // Criteria and deadline survive mode switches; only a successful send clears them.
  const switchMode = (next: Mode) => {
    setMode(next); setAssignee(null); setBlocked('');
    setLaterAt(next === 'later' ? whenPresets[0].at(new Date()).getTime() : null);
    focus();
  };
  const send = async (text: string) => {
    if (!conversationId || sending) return;
    if (mode === 'talk' && attachments.uploading) { onError('첨부를 올리는 중입니다. 끝나면 보내 주세요.'); return; }
    if (mode === 'talk' && attachments.items.some(item => item.status === 'failed')) { onError('올리지 못한 첨부가 있습니다. 빼거나 다시 붙여 주세요.'); return; }
    if (mode === 'later' && (!laterAt || laterAt <= Date.now())) { onError('보낼 시각을 지금 이후로 골라 주세요.'); return; }
    onError(''); setConfirmation('');
    if (mode === 'talk') {
      const refs = [...returnedFiles, ...attachments.refs];
      onPost({ type: 'message.send', conversationId, text, scopeId: projects.scopeIds[0] ?? null, ...(refs.length ? { attachments: refs } : {}) });
      attachments.clear(); setReturnedFiles([]);
      setDraft('');
      projects.clear();
      return;
    }
    setSending(true);
    try {
      if (mode === 'work') {
        await client.send({ type: 'work.create', ghostId: assignee?.id ?? ghost.id, title: text.split(/\n/, 1)[0].slice(0, 256), brief: text, scopeId: projects.scopeIds[0] ?? null, originConversationId: conversationId,
          slot: slot || null, retry: retrySlot ? { slot: retrySlot } : null,
          ...(criteria.trim() ? { acceptance: { criteria: criteria.trim(), checks: [], reviewer: null } } : {}),
          ...(deadline ? { deadlineAt: new Date(deadline).getTime() } : {}) });
        switchMode('talk');
      } else if (laterAt) {
        await client.send({ type: 'schedule.create', ghostId: ghost.id, conversationId, prompt: text, spec: { kind: 'at', at: laterAt } });
        setConfirmation(`${whenLabel(laterAt)}에 보냅니다`);
        setTimeout(() => setConfirmation(''), 4000);
        switchMode('talk');
      }
      setDraft('');
      projects.clear();
    } catch (reason) { onError(reason instanceof Error ? reason.message : '보내지 못했습니다.'); }
    finally { setSending(false); }
  };
  const returnedItems: PendingAttachment[] = returnedFiles.map(ref => ({ id: `returned:${ref.digest}`, name: ref.name, size: ref.size, type: ref.mediaType, status: 'ready', ref }));
  const removeFile = (id: string) => {
    if (id.startsWith('returned:')) setReturnedFiles(returnedFiles.filter(ref => `returned:${ref.digest}` !== id));
    else attachments.remove(id);
  };

  const hasFiles = attachments.items.length + returnedFiles.length > 0;
  const handedTo = assignee && assignee.id !== ghost.id ? assignee : null;
  const placeholder = !conversationId ? '열린 대화가 없어 보낼 수 없습니다' : mode === 'work' ? `${handedTo ? `${handedTo.name}에게 ` : ''}맡길 일을 적어 주세요. 첫 줄이 제목이 됩니다.` : mode === 'later' ? '나중에 보낼 메시지' : running ? '응답 중에도 덧붙일 수 있습니다' : `${ghost.name}에게 메시지`;
  // work.create and schedule.create carry text only; files ride on message.send alone.
  const actions: PlusAction[] = [
    { id: 'files', icon: <Paperclip/>, label: '사진·파일 첨부', disabled: mode !== 'talk', reason: '맡기기·예약 메시지에는 파일을 붙일 수 없습니다 · 대화로 보내세요', onSelect: () => fileInput.current?.click() },
    { id: 'work', icon: <BriefcaseBusiness/>, label: '일로 맡기기', disabled: hasFiles || mode === 'work', reason: hasFiles ? '파일이 붙은 메시지는 일로 맡길 수 없습니다 · 대화로 보내세요' : undefined, onSelect: () => switchMode('work') },
    { id: 'later', icon: <Clock3/>, label: '나중에 보내기', disabled: hasFiles || mode === 'later' || projects.scopeIds.length > 0, reason: hasFiles ? '파일이 붙은 메시지는 예약할 수 없습니다 · 바로 보내세요' : projects.scopeIds.length > 0 ? '프로젝트를 연결한 메시지는 예약할 수 없습니다 · 바로 보내세요' : undefined, onSelect: () => switchMode('later') },
  ];
  // The first line becomes the Work title; the host keeps 256 characters of it.
  const titleCut = mode === 'work' && draft.split(/\n/, 1)[0].length > 256;
  const hint = confirmation ? null : blocked && (mode !== 'talk' || hasFiles) ? blocked : titleCut ? '제목은 앞 256자만 씁니다' : null;

  // `/word` or `@name` as the whole draft opens suggestions until it is picked, dismissed or edited away.
  const typed = mode !== 'later' && !sending ? /^([/@])(\S*)$/.exec(draft) : null;
  const query = typed?.[2].toLowerCase() ?? '';
  const pick = (run: () => void) => () => { setDraft(''); setActive(0); run(); focus(); };
  const suggestions: Suggestion[] = !typed || dismissed === draft ? []
    : typed[1] === '/'
      ? actions.filter(action => !action.disabled && (action.label.toLowerCase().includes(query) || commandWords[action.id]?.some(word => word.startsWith(query))))
        .map(action => ({ id: action.id, icon: action.icon, label: action.label, onSelect: pick(action.onSelect) }))
      : (state?.ghosts ?? []).filter(item => item.state === 'active' && item.name.toLowerCase().includes(query))
        .map(item => ({
          id: item.id, icon: <DotAvatar profileId={item.id} tone={toneFor(item.id)} size={22}/>, label: item.name,
          hint: item.id === ghost.id ? '이 대화' : item.persona.trim().split('\n')[0]?.slice(0, 48),
          onSelect: pick(() => { if (mode !== 'work') switchMode('work'); setAssignee(item); }),
        }));
  const open = suggestions.length > 0;
  const current = Math.min(active, suggestions.length - 1);
  const steer = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    projects.onKeyDown(event);
    if (event.defaultPrevented) return;
    if (!open || event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      suggestions[current]?.onSelect();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDismissed(draft);
    }
  };
  return <>
    <input ref={fileInput} type="file" multiple hidden onChange={event => { attachments.add(Array.from(event.target.files ?? [])); event.target.value = ''; focus(); }}/>
    <Composer inputId="message-input" inputRef={inputRef} value={draft} onValueChange={value => { projects.onChange(value); setActive(0); }} onSubmit={value => void send(value)}
      onKeyDown={steer}
      onSelect={projects.onSelect}
      inputAria={projects.open ? projects.inputAria : { role: 'combobox', 'aria-expanded': open, 'aria-controls': open ? suggestId : undefined, 'aria-activedescendant': open ? `${suggestId}-${current}` : undefined, 'aria-autocomplete': 'list' }}
      above={projects.above || (open && <ComposerSuggest id={suggestId} label={typed?.[1] === '@' ? '맡길 Ghost' : '명령'} items={suggestions} active={current} onActive={setActive}/>)}
      label={`${ghost.name}에게 ${mode === 'work' ? '일 맡기기' : '메시지'}`} placeholder={placeholder}
      submitLabel={mode === 'work' ? '일 맡기기' : mode === 'later' ? '예약하기' : '메시지 보내기'}
      disabled={!conversationId} pending={sending} running={running} describedBy="composer-keyboard-help"
      onFiles={mode === 'talk' ? attachments.add : undefined}
      header={mode !== 'talk' && <div className="composer-mode" data-mode={mode}>
        <span className="composer-mode__token">
          {mode === 'work' ? <BriefcaseBusiness aria-hidden="true"/> : <Clock3 aria-hidden="true"/>}
          {mode === 'work' ? '맡기기' : laterAt ? whenLabel(laterAt) : '나중에 보내기'}
          {mode === 'work' && handedTo && <span className="composer-mode__to"><DotAvatar profileId={handedTo.id} tone={toneFor(handedTo.id)} size={15}/>{handedTo.name}</span>}
          <button type="button" className="composer-mode__close" aria-label="일반 메시지로" onClick={() => switchMode('talk')}><X size={11} aria-hidden="true"/></button>
        </span>
      </div>}
      tray={<>{projects.chips}<AttachmentTray items={[...returnedItems, ...attachments.items]} onRemove={removeFile}/></>}
      extension={mode === 'work' ? <div className="composer-fields">
        <label className="composer-field"><span>완료 기준</span>
          <input value={criteria} onChange={event => setCriteria(event.target.value)} maxLength={8192} disabled={sending} placeholder="무엇이 되면 끝난 것인지"/></label>
        <label className="composer-field" style={{ flexGrow: 0 }}><span>기한</span>
          <input type="datetime-local" value={deadline} onChange={event => setDeadline(event.target.value)} disabled={sending}/></label>
        <fieldset disabled={sending} className="border-0 p-0 m-0 min-w-0 basis-full"><WorkModelFields slot={slot} retrySlot={retrySlot} onSlot={setSlot} onRetry={setRetrySlot}/></fieldset>
      </div> : mode === 'later' ? <div className="composer-fields">
        <div className="when-chips" role="group" aria-label="보낼 시각">
          {whenPresets.map(preset => { const at = preset.at(new Date()).getTime(); return <button key={preset.id} type="button" className="when-chip"
            aria-pressed={laterAt !== null && Math.abs(laterAt - at) < 60_000} onClick={() => { setLaterAt(at); focus(); }}>{preset.label}</button>; })}
          <label className="when-chip when-chip--custom"><span className="sr-only">직접 고르기</span>
            <input type="datetime-local" value={laterAt ? localInput(new Date(laterAt)) : ''} min={localInput(new Date())}
              onChange={event => setLaterAt(event.target.value ? new Date(event.target.value).getTime() : null)}/></label>
        </div>
      </div> : undefined}
      leading={<ComposerPlus disabled={!conversationId || sending} actions={actions} onBlocked={setBlocked}/>}
      footer={confirmation ? <span className="composer-confirmation" role="status">{confirmation}</span> : hint && <span className="composer-hint" role="status">{hint}</span>}
      trailing={<>
        {conversationId && mode !== 'work' && <ModelPicker conversationId={conversationId} disabled={sending || busy}/>}
        {running && <button type="button" className="chat-stop" aria-label="응답 취소" title="응답 취소" onClick={onStop}><Square aria-hidden="true"/></button>}
      </>}/>
  </>;
}
