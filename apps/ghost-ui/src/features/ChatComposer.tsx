import { useRef, useState, type RefObject } from 'react';
import { BriefcaseBusiness, Clock3, Paperclip, Square, X } from 'lucide-react';
import type { Ghost } from '@ghost/contract';
import { Composer } from '../ui';
import { ComposerPlus } from '../components/composer/ComposerPlus';
import { AttachmentTray, useAttachments } from '../components/composer/attachments';
import { ModelPicker } from '../pets/ModelPicker';
import { useHost } from '../host/context';

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
 */
export function ChatComposer({ ghost, conversationId, running, busy, draft, setDraft, inputRef, onSent, onStop, onError }: {
  ghost: Ghost;
  conversationId: string | null;
  running: boolean;
  /** The conversation is generating: the model cannot change until it ends. */
  busy: boolean;
  draft: string;
  setDraft(value: string): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onSent(): void;
  onStop(): void;
  onError(message: string): void;
}) {
  const { client } = useHost();
  const attachments = useAttachments();
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>('talk');
  const [criteria, setCriteria] = useState('');
  const [deadline, setDeadline] = useState('');
  const [laterAt, setLaterAt] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [confirmation, setConfirmation] = useState('');

  const focus = () => inputRef.current?.focus();
  const switchMode = (next: Mode) => {
    setMode(next); setCriteria(''); setDeadline('');
    setLaterAt(next === 'later' ? whenPresets[0].at(new Date()).getTime() : null);
    focus();
  };
  const send = async (text: string) => {
    if (!conversationId || sending) return;
    if (mode === 'talk' && attachments.uploading) { onError('첨부를 올리는 중입니다. 끝나면 보내 주세요.'); return; }
    if (mode === 'later' && (!laterAt || laterAt <= Date.now())) { onError('보낼 시각을 지금 이후로 골라 주세요.'); return; }
    setSending(true); onError(''); setConfirmation('');
    try {
      if (mode === 'work') {
        await client.send({ type: 'work.create', ghostId: ghost.id, title: text.split(/\n/, 1)[0].slice(0, 256), brief: text, originConversationId: conversationId,
          ...(criteria.trim() ? { acceptance: { criteria: criteria.trim(), checks: [], reviewer: null } } : {}),
          ...(deadline ? { deadlineAt: new Date(deadline).getTime() } : {}) });
        switchMode('talk');
      } else if (mode === 'later' && laterAt) {
        await client.send({ type: 'schedule.create', ghostId: ghost.id, conversationId, prompt: text, spec: { kind: 'at', at: laterAt } });
        setConfirmation(`${whenLabel(laterAt)}에 보냅니다`);
        setTimeout(() => setConfirmation(''), 4000);
        switchMode('talk');
      } else {
        onSent();
        await client.send({ type: 'message.send', conversationId, text, ...(attachments.refs.length ? { attachments: attachments.refs } : {}) });
        attachments.clear();
      }
      setDraft('');
    } catch (reason) { onError(reason instanceof Error ? reason.message : '보내지 못했습니다.'); }
    finally { setSending(false); }
  };

  const hasFiles = attachments.items.length > 0;
  const placeholder = mode === 'work' ? '맡길 일을 적어 주세요. 첫 줄이 제목이 됩니다.' : mode === 'later' ? '나중에 보낼 메시지' : running ? '응답 중에도 덧붙일 수 있습니다' : `${ghost.name}에게 메시지`;
  return <>
    <input ref={fileInput} type="file" multiple hidden onChange={event => { attachments.add(Array.from(event.target.files ?? [])); event.target.value = ''; focus(); }}/>
    <Composer inputId="message-input" inputRef={inputRef} value={draft} onValueChange={setDraft} onSubmit={value => void send(value)}
      label={`${ghost.name}에게 ${mode === 'work' ? '일 맡기기' : '메시지'}`} placeholder={placeholder}
      submitLabel={mode === 'work' ? '일 맡기기' : mode === 'later' ? '예약하기' : '메시지 보내기'}
      disabled={!conversationId} pending={sending} running={running} describedBy="composer-keyboard-help"
      onFiles={mode === 'talk' ? attachments.add : undefined}
      header={mode !== 'talk' && <div className="composer-mode" data-mode={mode}>
        <span className="composer-mode__token">
          {mode === 'work' ? <BriefcaseBusiness aria-hidden="true"/> : <Clock3 aria-hidden="true"/>}
          {mode === 'work' ? '맡기기' : laterAt ? whenLabel(laterAt) : '나중에 보내기'}
          <button type="button" className="composer-mode__close" aria-label="일반 메시지로" onClick={() => switchMode('talk')}><X size={11} aria-hidden="true"/></button>
        </span>
      </div>}
      tray={<AttachmentTray items={attachments.items} onRemove={attachments.remove}/>}
      extension={mode === 'work' ? <div className="composer-fields">
        <label className="composer-field"><span>완료 기준</span>
          <input value={criteria} onChange={event => setCriteria(event.target.value)} maxLength={8192} disabled={sending} placeholder="무엇이 되면 끝난 것인지"/></label>
        <label className="composer-field" style={{ flexGrow: 0 }}><span>기한</span>
          <input type="datetime-local" value={deadline} onChange={event => setDeadline(event.target.value)} disabled={sending}/></label>
      </div> : mode === 'later' ? <div className="composer-fields">
        <div className="when-chips" role="group" aria-label="보낼 시각">
          {whenPresets.map(preset => { const at = preset.at(new Date()).getTime(); return <button key={preset.id} type="button" className="when-chip"
            aria-pressed={laterAt !== null && Math.abs(laterAt - at) < 60_000} onClick={() => { setLaterAt(at); focus(); }}>{preset.label}</button>; })}
          <label className="when-chip when-chip--custom"><span className="sr-only">직접 고르기</span>
            <input type="datetime-local" value={laterAt ? localInput(new Date(laterAt)) : ''} min={localInput(new Date())}
              onChange={event => setLaterAt(event.target.value ? new Date(event.target.value).getTime() : null)}/></label>
        </div>
      </div> : undefined}
      leading={<ComposerPlus disabled={!conversationId || sending} actions={[
        { id: 'files', icon: <Paperclip/>, label: '사진·파일 첨부', disabled: mode !== 'talk', onSelect: () => fileInput.current?.click() },
        { id: 'work', icon: <BriefcaseBusiness/>, label: '일로 맡기기', disabled: hasFiles || mode === 'work', onSelect: () => switchMode('work') },
        { id: 'later', icon: <Clock3/>, label: '나중에 보내기', disabled: hasFiles || mode === 'later', onSelect: () => switchMode('later') },
      ]}/>}
      footer={confirmation && <span className="composer-confirmation" role="status">{confirmation}</span>}
      trailing={<>
        {conversationId && mode !== 'work' && <ModelPicker conversationId={conversationId} disabled={sending || busy}/>}
        {running && <button type="button" className="chat-stop" aria-label="응답 취소" title="응답 취소" onClick={onStop}><Square aria-hidden="true"/></button>}
      </>}/>
  </>;
}
