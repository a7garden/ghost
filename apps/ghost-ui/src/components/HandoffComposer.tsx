import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Composer, InlineError, Popover, PopoverContent, PopoverTrigger } from '../ui'
import type { Ghost } from '@ghost/contract';
import { DotAvatar } from './DotAvatar';
import { toneFor } from '../features/ghostState';
import { ModelPicker, type ModelChoice } from '../pets/ModelPicker';
import { useHost } from '../host/context';

type Mode = 'talk' | 'work';

/**
 * Addressed hand-off: a recipient token and a talk/assign switch sit inside the composer.
 * Assigning unfolds the brief's completion criteria and deadline in place, so a request
 * becomes a 맡긴 일 without a separate form. Nothing is assigned unless the owner chose it.
 */
export function HandoffComposer({ ghosts, navigate }: { ghosts: Ghost[]; navigate(path: string): void }) {
  const { client } = useHost();
  const [text, setText] = useState('');
  const [criteria, setCriteria] = useState('');
  const [deadline, setDeadline] = useState('');
  const [mode, setMode] = useState<Mode>('talk');
  const [ghostId, setGhostId] = useState<string>();
  const [model, setModel] = useState<ModelChoice>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const target = ghosts.find(ghost => ghost.id === ghostId) ?? ghosts[0];

  const send = async (value: string) => {
    if (!target || sending) return;
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
      } else if (model) {
        // The first message carries the chosen model: open the conversation, save the model, then send.
        const created = await client.send<{ conversationId: string }>({ type: 'conversation.create', ghostId: target.id });
        await client.send({ type: 'conversation.update', conversationId: created.conversationId, model: { provider: model.provider, model: model.model } });
        await client.send({ type: 'message.send', conversationId: created.conversationId, text: value });
        navigate(`/ghosts/${encodeURIComponent(target.id)}?conversation=${encodeURIComponent(created.conversationId)}`);
      } else {
        await client.send({ type: 'message.send', conversationId: target.directConversationId, text: value });
        navigate(`/ghosts/${encodeURIComponent(target.id)}`);
      }
      setText(''); setCriteria(''); setDeadline(''); setModel(undefined);
    } catch (e) { setError(e instanceof Error ? e.message : '보내지 못했습니다.'); }
    finally { setSending(false); }
  };

  if (!target) return null;
  const assigning = mode === 'work';
  return <div className="handoff" data-mode={mode}>
    <Composer inputId="handoff-message" inputRef={inputRef} value={text} onValueChange={setText} onSubmit={value => void send(value)}
      label={`${target.name}에게 ${assigning ? '일 맡기기' : '메시지'}`}
      placeholder={assigning ? '맡길 일을 적어 주세요. 첫 줄이 제목이 됩니다.' : `${target.name}에게 메시지`}
      submitLabel={assigning ? '일 맡기기' : '보내기'} disabled={sending} pending={sending}
      header={<div className="handoff__head">
        <RecipientToken ghosts={ghosts} value={target} disabled={sending} onChange={id => { setGhostId(id); setModel(undefined); inputRef.current?.focus(); }}/>
        <div className="handoff__mode" role="radiogroup" aria-label="보내는 방식">
          {(['talk', 'work'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={mode === value}
            onClick={() => { setMode(value); inputRef.current?.focus(); }}>{value === 'talk' ? '대화' : '맡기기'}</button>)}
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
      footer={!assigning && <ModelPicker value={model} onChange={setModel} disabled={sending}/>}/>
    {error && <InlineError className="mt-2">{error}</InlineError>}
  </div>;
}

/** The addressed Ghost as a token at the start of the message; opens the team to readdress. */
function RecipientToken({ ghosts, value, onChange, disabled }: { ghosts: Ghost[]; value: Ghost; onChange(id: string): void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" className="recipient" disabled={disabled} aria-label={`받는 Ghost: ${value.name}`}>
        <DotAvatar profileId={value.id} tone={toneFor(value.id)} size={18}/>
        <span className="truncate">{value.name}</span>
        <ChevronDown size={13} aria-hidden="true"/>
      </button>
    </PopoverTrigger>
    <PopoverContent side="bottom" align="start" aria-label="받는 Ghost" className="grid w-60 gap-0.5 p-1.5">
      {ghosts.map(ghost => <button key={ghost.id} type="button" aria-pressed={ghost.id === value.id}
        className="menu-row" onClick={() => { onChange(ghost.id); setOpen(false); }}>
        <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={20}/><span className="min-w-0 flex-1 truncate">{ghost.name}</span>
        {ghost.isDefault && <span className="presence-row__main-mark">메인</span>}
      </button>)}
    </PopoverContent>
  </Popover>;
}
