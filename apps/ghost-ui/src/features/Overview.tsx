import { useState, type ReactNode } from 'react';
import { ArrowRight, Check, ChevronDown, ChevronRight, Folder } from 'lucide-react';
import { Badge, Button, GComposer, GPage, InlineError, Popover, PopoverContent, PopoverTrigger } from '@garden/ui';
import { DotAvatar } from '../components/DotAvatar';
import { toneFor } from '../client/types';
import type { Snapshot, Profile } from '../client/types';
import type { Snapshot as LifetimeSnapshot } from '../lifetime/types';
import { inboxItems } from '../client/inbox';
import { approvalTitle, type ApprovalRef } from '../plugins/approvals';
import { ModelPicker, type ModelChoice } from '../pets/ModelPicker';
import { projectDashboardWork, type DashboardTask } from './dashboardState';
import { ghostDisplayName } from './profileSummary';

export interface OverviewProps {
  snapshot: Snapshot; connected?: boolean; navigate: (path: string) => void;
  onOpenApproval: (ref: ApprovalRef) => void;
  /** Sends the first message to the chosen Ghost; rejects with a displayable error. */
  onStartChat: (text: string, ghostId: string, model?: ModelChoice) => Promise<void>;
  /** Opens the Ghost's own conversation screen. */
  onOpenGhost: (ghostId: string) => void;
  /** Default recipient; the composer can switch to any other Ghost. */
  chatTarget?: Profile;
  /** The Host can save a conversation model for the message. */
  chooseModel?: boolean;
  workPath: string;
  lifetime?: LifetimeSnapshot; workError?: string; workLoading?: boolean;
}

type Tone = 'default' | 'warning' | 'success' | 'outline';
const tones: Record<DashboardTask['tone'], Tone> = { running: 'default', attention: 'warning', success: 'success', neutral: 'outline' };

function Row({ title, owner, state, tone, onClick, disabled }: { title: string; owner: string; state: ReactNode; tone: Tone; onClick(): void; disabled?: boolean }) {
  return <li><button type="button" disabled={disabled} onClick={onClick}
    className="flex w-full min-w-0 items-center gap-3 rounded-control px-2 py-2.5 text-left hover:bg-hover disabled:opacity-50">
    <span className="grid min-w-0 flex-1 gap-0.5"><span className="truncate text-ui font-medium text-ink">{title}</span><span className="truncate text-caption text-ink-2">{owner}</span></span>
    <Badge variant={tone}>{state}</Badge><ChevronRight className="size-4 text-ink-3"/>
  </button></li>;
}

/** Recipient chip: the Ghost that receives the home message. */
function GhostChooser({ profiles, value, onChange, disabled }: { profiles: Profile[]; value: Profile; onChange(id: string): void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" disabled={disabled} aria-label={`받는 Ghost: ${ghostDisplayName(value.name)}`}
        className="inline-flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-full pr-2 pl-1 text-caption text-ink-2 outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-3 disabled:cursor-not-allowed disabled:opacity-50">
        <DotAvatar profileId={value.id} tone={toneFor(value.id)} size={18}/><span className="truncate">{ghostDisplayName(value.name)}</span><ChevronDown size={12} aria-hidden="true"/>
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" aria-label="받는 Ghost" className="grid w-60 gap-0.5 p-1.5">
      {profiles.map(profile => <button key={profile.id} type="button" aria-pressed={profile.id === value.id} onClick={() => { onChange(profile.id); setOpen(false); }}
        className="flex min-h-9 w-full items-center gap-2 rounded-control px-2 text-left text-ui text-ink outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3">
        <DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={20}/><span className="min-w-0 flex-1 truncate">{ghostDisplayName(profile.name)}</span>
        {profile.id === value.id && <Check size={14} className="text-ink-2" aria-hidden="true"/>}
      </button>)}
    </PopoverContent>
  </Popover>;
}

/** Home dashboard: a one-line hand-off composer, every Ghost's state, then what needs the owner or is moving. */
export function Overview({ snapshot, connected = true, navigate, onOpenApproval, onStartChat, onOpenGhost, chatTarget, chooseModel = false, workPath, lifetime, workError, workLoading }: OverviewProps) {
  const work = projectDashboardWork(snapshot, lifetime);
  const decisions = inboxItems(snapshot, connected).groups.pending;
  const names = new Map(snapshot.profiles.map(profile => [profile.id, ghostDisplayName(profile.name)]));
  const ongoing = work.tasks.filter(task => task.tone === 'running' || task.tone === 'attention');
  const projects = snapshot.spaces.slice(0, 4);
  const stale = Boolean(workError) || !connected;
  const [text, setText] = useState(''), [sending, setSending] = useState(false), [error, setError] = useState('');
  const [ghostId, setGhostId] = useState<string>(), [model, setModel] = useState<ModelChoice>();
  const target = connected ? snapshot.profiles.find(profile => profile.id === ghostId) ?? chatTarget : undefined;
  const send = async (value: string) => {
    if (!target || sending) return;
    setSending(true); setError('');
    try { await onStartChat(value, target.id, model); setText(''); }
    catch (e) { setError(e instanceof Error ? e.message : '메시지를 보내지 못했습니다.'); }
    finally { setSending(false); }
  };
  const heading = 'flex items-center gap-2 text-ui font-semibold text-ink';
  const ghosts = [...snapshot.profiles].sort((a, b) => Number(b.id === chatTarget?.id) - Number(a.id === chatTarget?.id));
  return <GPage width="content" className="grid content-start gap-8 pt-8">
    <div className="grid gap-2">
      <GComposer variant="conversation" inputId="dashboard-message" rows={1} value={text} onValueChange={setText} onSubmit={value => void send(value)}
        label={target ? `${ghostDisplayName(target.name)}에게 메시지` : '메시지'} placeholder="무엇을 맡길까요?" submitLabel="보내기"
        disabled={!target} pending={sending}
        footer={target && <div className="flex min-w-0 items-center gap-1">
          <GhostChooser profiles={ghosts} value={target} disabled={sending} onChange={id => { setGhostId(id); setModel(undefined); }}/>
          {chooseModel && <ModelPicker key={target.id} value={model} onChange={setModel} connected={connected} disabled={sending}/>}
        </div>}/>
      {error && <InlineError>{error}</InlineError>}
    </div>
    {ghosts.length > 0 && <section className="grid gap-2" aria-labelledby="home-ghosts">
      <h2 id="home-ghosts" className={heading}>Ghost</h2>
      <ul className="grid list-none gap-2 p-0 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">{ghosts.map(profile => {
        const attention = decisions.filter(item => item.ghostId === profile.id).length + work.tasks.filter(task => task.ghostId === profile.id && task.tone === 'attention').length;
        const running = work.tasks.filter(task => task.ghostId === profile.id && task.tone === 'running');
        const latest = work.tasks.find(task => task.ghostId === profile.id && (task.tone === 'attention' || task.tone === 'running'));
        const name = ghostDisplayName(profile.name);
        return <li key={profile.id}><button type="button" onClick={() => onOpenGhost(profile.id)} aria-label={`${name} 열기`}
          className="flex w-full min-w-0 items-center gap-3 rounded-card border border-line bg-surface px-3 py-3 text-left outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3">
          <DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={40}/>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-ui font-medium text-ink">{name}</span>
            {(attention > 0 || running.length > 0) && <span className={`flex min-w-0 items-center gap-1.5 text-caption ${attention ? 'text-orange' : 'text-ink-2'}`}>
              <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${attention ? 'bg-orange' : 'bg-ink animate-pulse motion-reduce:animate-none'}`}/>
              <span className="truncate">{attention ? `확인 필요 ${attention}` : latest?.title ?? `진행 중 ${running.length}`}</span>
            </span>}
          </span>
        </button></li>;
      })}</ul>
    </section>}
    {stale && <InlineError>{ongoing.length ? '마지막으로 확인한 작업 상태입니다.' : '작업 상태를 확인하지 못했습니다.'}</InlineError>}
    {(decisions.length > 0 || ongoing.length > 0 || work.source === 'unavailable' && workLoading) && <div className="grid items-start gap-8 lg:grid-cols-2">
      {decisions.length > 0 && <section className="grid gap-2" aria-labelledby="home-decisions">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <h2 id="home-decisions" className={heading}>확인 필요 <Badge variant="warning">{decisions.length}</Badge></h2>
          {decisions.length > 4 && <Button variant="ghost" size="sm" onClick={() => navigate('/inbox')}>모두 보기<ArrowRight/></Button>}
        </div>
        <ul className="grid">{decisions.slice(0, 4).map(item => <Row key={`${item.kind}:${item.id}`} title={approvalTitle(item)} owner={names.get(item.ghostId) ?? 'Ghost'}
          state="확인하기" tone="warning" disabled={!connected} onClick={() => onOpenApproval({ kind: item.kind, id: item.id })}/>)}</ul>
      </section>}
      {(ongoing.length > 0 || work.source === 'unavailable' && workLoading) && <section className="grid gap-2" aria-labelledby="home-ongoing" aria-busy={workLoading}>
        <div className="flex min-h-8 items-center justify-between gap-2">
          <h2 id="home-ongoing" className={heading}>진행 중 {ongoing.length > 0 && <Badge variant="outline">{ongoing.length}</Badge>}</h2>
          <Button variant="ghost" size="sm" onClick={() => navigate(workPath)}>모든 일<ArrowRight/></Button>
        </div>
        <ul className="grid">{ongoing.slice(0, 6).map(task => <Row key={task.id} title={task.title} owner={names.get(task.ghostId) ?? 'Ghost'}
          state={task.label} tone={tones[task.tone]} onClick={() => navigate(task.path)}/>)}</ul>
      </section>}
    </div>}
    {projects.length > 0 && <section className="grid gap-2" aria-labelledby="home-projects">
      <h2 id="home-projects" className={heading}>프로젝트</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">{projects.map(space =>
        <Button key={space.id} variant="outline" size="lg" className="justify-start" onClick={() => navigate(`/spaces/${space.id}`)}><Folder/><span className="truncate">{space.name}</span></Button>)}</div>
    </section>}
  </GPage>;
}
