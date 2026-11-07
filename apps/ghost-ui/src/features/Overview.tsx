import { useState, type ReactNode } from 'react';
import { ArrowRight, Folder } from 'lucide-react';
import { Badge, Button, Composer, Page, InlineError, Popover, PopoverContent, PopoverTrigger } from '../ui'
import type { Ghost, State } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { pendingDecisions, liveWorks, toneFor } from './ghostState';
import { decisionLabel } from './Inbox';
import { workStateLabel } from './WorkViews';
import { ModelPicker, type ModelChoice } from '../pets/ModelPicker';
import { useHost } from '../host/context';

export interface OverviewProps {
  state: State;
  navigate: (path: string) => void;
  /** Opens the Ghost's own conversation screen. */
  onOpenGhost: (ghostId: string) => void;
}

type Tone = 'default' | 'warning' | 'success' | 'outline';

function Row({ title, owner, state, tone, onClick }: { title: string; owner: string; state: ReactNode; tone: Tone; onClick(): void }) {
  return <li><button type="button" onClick={onClick}
    className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-control border border-line bg-surface px-3 py-2 text-left text-ui outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3">
    <span className="min-w-0 flex-1 grid">
      <span className="truncate font-medium text-ink">{title}</span>
      <span className="truncate text-caption text-ink-2">{owner}</span>
    </span>
    <Badge variant={tone}>{state}</Badge>
  </button></li>;
}

/** Recipient chip: the Ghost that receives the home message. */
function GhostChooser({ ghosts, value, onChange, disabled }: { ghosts: Ghost[]; value: Ghost; onChange(id: string): void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" disabled={disabled} className="flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-chip px-1.5 py-1 text-caption text-ink-2 outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-3">
        <DotAvatar profileId={value.id} tone={toneFor(value.id)} size={16}/>
        <span className="truncate">{value.name}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" aria-label="받는 Ghost" className="grid w-60 gap-0.5 p-1.5">
      {ghosts.map(ghost => <button key={ghost.id} type="button"
        className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-control px-2 py-2 text-left text-caption outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3 ${ghost.id === value.id ? 'bg-hover text-ink' : 'text-ink-2'}`}
        onClick={() => { onChange(ghost.id); setOpen(false); }}>
        <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={18}/><span className="min-w-0 flex-1 truncate">{ghost.name}</span>
        {ghost.isDefault && <Badge variant="outline">메인</Badge>}
      </button>)}
    </PopoverContent>
  </Popover>;
}

/** Home dashboard: a one-line hand-off composer, every Ghost's state, then what needs the owner or is moving. */
export function Overview({ state, navigate, onOpenGhost }: OverviewProps) {
  const { client } = useHost();
  const decisions = pendingDecisions(state);
  const ongoing = liveWorks(state);
  const names = new Map(state.ghosts.map(ghost => [ghost.id, ghost.name]));
  const ghosts = [...state.ghosts].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const [text, setText] = useState(''), [sending, setSending] = useState(false), [error, setError] = useState('');
  const [ghostId, setGhostId] = useState<string>(), [model, setModel] = useState<ModelChoice>(), [asWork, setAsWork] = useState(false);
  const target = ghosts.find(ghost => ghost.id === ghostId) ?? ghosts[0];
  const send = async (value: string) => {
    if (!target || sending) return;
    setSending(true); setError('');
    try {
      if (asWork) {
        const title = value.trim().split(/\n/, 1)[0].slice(0, 256);
        await client.send({ type: 'work.create', ghostId: target.id, title, brief: value });
        navigate('/work');
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
      setText(''); setModel(undefined);
    } catch (e) { setError(e instanceof Error ? e.message : '메시지를 보내지 못했습니다.'); }
    finally { setSending(false); }
  };
  const heading = 'flex items-center gap-2 text-ui font-semibold text-ink';
  return <Page width="content" className="grid content-start gap-8 pt-8">
    <div className="grid gap-2">
      <Composer variant="conversation" inputId="dashboard-message" rows={1} value={text} onValueChange={setText} onSubmit={value => void send(value)}
        label={target ? `${target.name}에게 ${asWork ? '일 맡기기' : '메시지'}` : '메시지'} placeholder={asWork ? '무엇을 어떻게 완료할지 적어 주세요.' : '무엇을 맡길까요?'} submitLabel={asWork ? '일 맡기기' : '보내기'}
        disabled={!target} pending={sending}
        footer={target && <div className="flex min-w-0 items-center gap-1">
          <GhostChooser ghosts={ghosts} value={target} disabled={sending} onChange={id => { setGhostId(id); setModel(undefined); }}/>
          <button type="button" aria-pressed={asWork} onClick={() => setAsWork(value => !value)}
            className={`cursor-pointer rounded-chip px-1.5 py-1 text-caption outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3 ${asWork ? 'bg-hover text-ink' : 'text-ink-2'}`}>
            {asWork ? '일로 맡기기' : '메시지로'}
          </button>
          {!asWork && <ModelPicker value={model} onChange={setModel} disabled={sending}/>}
        </div>}/>
      {error && <InlineError>{error}</InlineError>}
    </div>
    {ghosts.length > 0 && <section className="grid gap-2" aria-labelledby="home-ghosts">
      <h2 id="home-ghosts" className={heading}>Ghost</h2>
      <ul className="grid list-none gap-2 p-0 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">{ghosts.map(ghost => {
        const attention = decisions.filter(decision => decision.ghostId === ghost.id).length
          + ongoing.filter(work => work.ghostId === ghost.id && work.state === 'blocked').length;
        const running = ongoing.filter(work => work.ghostId === ghost.id && work.state !== 'blocked');
        const latest = ongoing.find(work => work.ghostId === ghost.id);
        return <li key={ghost.id}><button type="button" onClick={() => onOpenGhost(ghost.id)} aria-label={`${ghost.name} 열기`}
          className="flex w-full min-w-0 items-center gap-3 rounded-card border border-line bg-surface px-3 py-3 text-left outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3">
          <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={40}/>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-ui font-medium text-ink">{ghost.name}</span>
            {(attention > 0 || running.length > 0) && <span className={`flex min-w-0 items-center gap-1.5 text-caption ${attention ? 'text-orange' : 'text-ink-2'}`}>
              <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${attention ? 'bg-orange' : 'bg-ink animate-pulse motion-reduce:animate-none'}`}/>
              <span className="truncate">{attention ? `확인 필요 ${attention}` : latest?.title ?? `진행 중 ${running.length}`}</span>
            </span>}
          </span>
        </button></li>;
      })}</ul>
    </section>}
    {(decisions.length > 0 || ongoing.length > 0) && <div className="grid items-start gap-8 lg:grid-cols-2">
      {decisions.length > 0 && <section className="grid gap-2" aria-labelledby="home-decisions">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <h2 id="home-decisions" className={heading}>확인 필요 <Badge variant="warning">{decisions.length}</Badge></h2>
          {decisions.length > 4 && <Button variant="ghost" size="sm" onClick={() => navigate('/inbox')}>모두 보기<ArrowRight/></Button>}
        </div>
        <ul className="grid">{decisions.slice(0, 4).map(decision => <Row key={decision.id} title={decision.title}
          owner={names.get(decision.ghostId) ?? 'Ghost'} state={decisionLabel[decision.kind]} tone="warning"
          onClick={() => navigate(`/inbox?decision=${encodeURIComponent(decision.id)}`)}/>)}</ul>
      </section>}
      {ongoing.length > 0 && <section className="grid gap-2" aria-labelledby="home-ongoing">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <h2 id="home-ongoing" className={heading}>진행 중 {ongoing.length > 0 && <Badge variant="outline">{ongoing.length}</Badge>}</h2>
          <Button variant="ghost" size="sm" onClick={() => navigate('/work')}>모든 일<ArrowRight/></Button>
        </div>
        <ul className="grid">{ongoing.slice(0, 6).map(work => <Row key={work.id} title={work.title}
          owner={names.get(work.ghostId) ?? 'Ghost'} state={workStateLabel[work.state] ?? work.state}
          tone={work.state === 'blocked' ? 'warning' : 'default'} onClick={() => navigate(`/work/${encodeURIComponent(work.id)}`)}/>)}</ul>
      </section>}
    </div>}
    {state.spaces.length > 0 && <section className="grid gap-2" aria-labelledby="home-projects">
      <h2 id="home-projects" className={heading}>프로젝트</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">{state.spaces.slice(0, 4).map(space =>
        <Button key={space.id} variant="outline" size="lg" className="justify-start" onClick={() => navigate(`/spaces/${space.id}`)}><Folder/><span className="truncate">{space.name}</span></Button>)}</div>
    </section>}
  </Page>;
}
