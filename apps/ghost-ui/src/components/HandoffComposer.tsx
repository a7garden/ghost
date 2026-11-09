import { useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Paperclip } from 'lucide-react';
import { Composer, InlineError, Popover, PopoverContent, PopoverTrigger } from '../ui'
import type { Ghost } from '@ghost/contract';
import { DotAvatar } from './DotAvatar';
import { toneFor, visibleGhosts } from '../features/ghostState';
import { ModelPicker } from '../pets/ModelPicker';
import { useHost } from '../host/context';
import { ComposerPlus } from './composer/ComposerPlus';
import { AttachmentTray, useAttachments } from './composer/attachments';

type Mode = 'talk' | 'work';

/**
 * Addressed hand-off: a recipient token and a talk/assign switch sit inside the composer.
 * Assigning unfolds the brief's completion criteria and deadline in place, so a request
 * becomes a 맡긴 일 without a separate form. Nothing is assigned unless the owner chose it.
 */
export function HandoffComposer({ ghosts, navigate }: { ghosts: Ghost[]; navigate(path: string): void }) {
  const { client } = useHost();
  const roster = visibleGhosts(ghosts);
  const [text, setText] = useState('');
  const [criteria, setCriteria] = useState('');
  const [deadline, setDeadline] = useState('');
  const [mode, setMode] = useState<Mode>('talk');
  const [ghostId, setGhostId] = useState<string>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  /** Why the last chosen option could not apply; shown while that reason still holds. */
  const [blocked, setBlocked] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modeButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachments = useAttachments();
  const target = roster.find(ghost => ghost.id === ghostId) ?? roster[0];

  const send = async (value: string) => {
    if (!target || sending) return;
    if (mode === 'talk' && attachments.uploading) { setError('첨부를 올리는 중입니다. 끝나면 보내 주세요.'); return; }
    setSending(true); setError('');
    try {
      if (mode === 'work') {
        const title = value.split(/\n/, 1)[0].slice(0, 256);
        const created = await client.send<{ workId: string }>({
          type: 'work.create', ghostId: target.id, title, brief: value,
          ...(criteria.trim() ? { acceptance: { criteria: criteria.trim(), checks: [], reviewer: null } } : {}),
          ...(deadline ? { deadlineAt: new Date(deadline).getTime() } : {}),
        });
        navigate(`/work/${encodeURIComponent(created.workId)}`);
      } else {
        await client.send({ type: 'message.send', conversationId: target.directConversationId, text: value, ...(attachments.refs.length ? { attachments: attachments.refs } : {}) });
        attachments.clear();
        navigate(`/ghosts/${encodeURIComponent(target.id)}`);
      }
      setText(''); setCriteria(''); setDeadline('');
    } catch (e) { setError(e instanceof Error ? e.message : '보내지 못했습니다.'); }
    finally { setSending(false); }
  };

  if (!target) return null;
  const assigning = mode === 'work';
  // work.create carries text only; files ride on message.send alone.
  const workBlocked = attachments.items.length > 0 ? '파일이 붙은 메시지는 일로 맡길 수 없습니다 · 대화로 보내세요' : null;
  const filesBlocked = '맡기기에는 파일을 붙일 수 없습니다 · 대화로 보내세요';
  const choose = (value: Mode, focusInput: boolean) => {
    if (value === 'work' && workBlocked) { setBlocked(workBlocked); return; }
    setMode(value); setBlocked('');
    if (focusInput) inputRef.current?.focus();
  };
  // WAI-ARIA radio group: arrows move and select, only the checked option sits in the tab order.
  const modes = ['talk', 'work'] as const;
  const modeKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = modes[(modes.indexOf(mode) + step + modes.length) % modes.length];
    choose(next, false);
    if (next !== 'work' || !workBlocked) modeButtons.current[modes.indexOf(next)]?.focus();
  };
  // The first line becomes the Work title; the host keeps 256 characters of it.
  const titleCut = assigning && text.split(/\n/, 1)[0].length > 256;
  const hint = blocked && (assigning || workBlocked) ? blocked : titleCut ? '제목은 앞 256자만 씁니다' : null;
  return <div className="handoff" data-mode={mode}>
    <input ref={fileInput} type="file" multiple hidden onChange={event => { attachments.add(Array.from(event.target.files ?? [])); event.target.value = ''; inputRef.current?.focus(); }}/>
    <Composer inputId="handoff-message" inputRef={inputRef} value={text} onValueChange={setText} onSubmit={value => void send(value)}
      onFiles={assigning ? undefined : attachments.add}
      tray={<AttachmentTray items={attachments.items} onRemove={attachments.remove}/>}
      label={`${target.name}에게 ${assigning ? '일 맡기기' : '메시지'}`}
      placeholder={assigning ? '맡길 일을 적어 주세요. 첫 줄이 제목이 됩니다.' : `${target.name}에게 메시지`}
      submitLabel={assigning ? '일 맡기기' : '보내기'} disabled={sending} pending={sending}
      header={<div className="handoff__head">
        <RecipientToken ghosts={roster} value={target} disabled={sending} onChange={id => { setGhostId(id); inputRef.current?.focus(); }}/>
        <div className="handoff__mode" role="radiogroup" aria-label="보내는 방식" onKeyDown={modeKeys}>
          {modes.map((value, index) => { const reason = value === 'work' ? workBlocked : null; return <button key={value} ref={node => { modeButtons.current[index] = node; }}
            type="button" role="radio" aria-checked={mode === value} tabIndex={mode === value ? 0 : -1}
            aria-disabled={reason ? true : undefined} title={reason ?? undefined}
            onClick={() => choose(value, true)}>{value === 'talk' ? '대화' : '맡기기'}</button>; })}
        </div>
      </div>}
      extension={assigning && <div className="handoff__brief">
        <label className="handoff__field">
          <span>완료 기준</span>
          <input value={criteria} onChange={event => setCriteria(event.target.value)} maxLength={8192} disabled={sending} placeholder="무엇이 되면 끝난 것인지"/>
        </label>
        <label className="handoff__field">
          <span>기한</span>
          <input type="datetime-local" value={deadline} onChange={event => setDeadline(event.target.value)} disabled={sending}/>
        </label>
      </div>}
      leading={<ComposerPlus disabled={sending} onBlocked={setBlocked} actions={[
        { id: 'files', icon: <Paperclip/>, label: '사진·파일 첨부', disabled: assigning, reason: filesBlocked, onSelect: () => fileInput.current?.click() },
      ]}/>}
      footer={hint && <span className="composer-hint" role="status">{hint}</span>}
      trailing={!assigning && <ModelPicker conversationId={target.directConversationId} disabled={sending}/>}/>
    {error && <InlineError className="mt-2">{error}</InlineError>}
  </div>;
}

/** The addressed Ghost as a token at the start of the message; opens the team to readdress. */
function RecipientToken({ ghosts, value, onChange, disabled }: { ghosts: Ghost[]; value: Ghost; onChange(id: string): void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const searchable = ghosts.length > 8;
  const needle = query.trim().toLowerCase();
  const shown = ghosts.filter(ghost => !needle || ghost.name.toLowerCase().includes(needle)
    || ghost.persona.split('\n')[0]!.toLowerCase().includes(needle));
  return <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setQuery(''); }}>
    <PopoverTrigger asChild>
      <button type="button" className="recipient" disabled={disabled} aria-label={`받는 Ghost: ${value.name}`}>
        <DotAvatar profileId={value.id} tone={toneFor(value.id)} size={18}/>
        <span className="truncate">{value.name}</span>
        <ChevronDown size={13} aria-hidden="true"/>
      </button>
    </PopoverTrigger>
    <PopoverContent side="bottom" align="start" aria-label="받는 Ghost"
      className="grid w-60 gap-0.5 p-1.5 max-h-[min(320px,var(--radix-popover-content-available-height))]"
      onOpenAutoFocus={event => { if (searchable) { event.preventDefault(); searchRef.current?.focus(); } }}>
      {searchable && <input ref={searchRef} type="search" className="recipient-search" aria-label="Ghost 찾기"
        placeholder="Ghost 찾기" value={query} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setQuery(''); } }}/>}
      {shown.map(ghost => <button key={ghost.id} type="button" aria-pressed={ghost.id === value.id}
        className="menu-row" onClick={() => { onChange(ghost.id); setOpen(false); }}>
        <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={20}/><span className="min-w-0 flex-1 truncate">{ghost.name}</span>
        {ghost.isDefault && <span className="presence-row__main-mark">메인</span>}
      </button>)}
    </PopoverContent>
  </Popover>;
}
