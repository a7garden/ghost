import { useState, type ReactNode } from 'react';
import { ArrowRight, ChevronRight, Folder } from 'lucide-react';
import { Badge, Button, GComposer, GPage, InlineError } from '@garden/ui';
import { DotAvatar } from '../components/DotAvatar';
import { toneFor } from '../client/types';
import type { Snapshot, Profile } from '../client/types';
import type { Snapshot as LifetimeSnapshot } from '../lifetime/types';
import { inboxItems } from '../client/inbox';
import { approvalTitle, type ApprovalRef } from '../plugins/approvals';
import { projectDashboardWork, type DashboardTask } from './dashboardState';
import { ghostDisplayName } from './profileSummary';

export interface OverviewProps {
  snapshot: Snapshot; connected?: boolean; navigate: (path: string) => void;
  onOpenApproval: (ref: ApprovalRef) => void;
  /** Sends the first message to `chatTarget`; rejects with a displayable error. */
  onStartChat: (text: string) => Promise<void>; chatTarget?: Profile;
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

/** Home: one composer to the default Ghost, then only what needs the owner or is moving. */
export function Overview({ snapshot, connected = true, navigate, onOpenApproval, onStartChat, chatTarget, workPath, lifetime, workError, workLoading }: OverviewProps) {
  const work = projectDashboardWork(snapshot, lifetime);
  const decisions = inboxItems(snapshot, connected).groups.pending;
  const names = new Map(snapshot.profiles.map(profile => [profile.id, ghostDisplayName(profile.name)]));
  const ongoing = work.tasks.filter(task => task.tone === 'running' || task.tone === 'attention');
  const projects = snapshot.spaces.slice(0, 4);
  const stale = Boolean(workError) || !connected;
  const [text, setText] = useState(''), [sending, setSending] = useState(false), [error, setError] = useState('');
  const target = connected ? chatTarget : undefined;
  const send = async (value: string) => {
    if (!target || sending) return;
    setSending(true); setError('');
    try { await onStartChat(value); setText(''); }
    catch (e) { setError(e instanceof Error ? e.message : '메시지를 보내지 못했습니다.'); }
    finally { setSending(false); }
  };
  const heading = 'flex items-center gap-2 text-ui font-semibold text-ink';
  return <GPage width="reading" className="grid content-start gap-8 pt-[8vh]">
    <div className="grid gap-2">
      <GComposer variant="conversation" inputId="dashboard-message" rows={3} value={text} onValueChange={setText} onSubmit={value => void send(value)}
        label={target ? `${ghostDisplayName(target.name)}에게 메시지` : '메시지'} placeholder="무엇을 맡길까요?" submitLabel="보내기"
        disabled={!target} pending={sending}
        footer={target && <span className="inline-flex items-center gap-1.5 text-caption text-ink-2"><DotAvatar profileId={target.id} tone={toneFor(target.id)} size={18}/>{ghostDisplayName(target.name)}</span>}/>
      {error && <InlineError>{error}</InlineError>}
    </div>
    {decisions.length > 0 && <section className="grid gap-2" aria-labelledby="home-decisions">
      <div className="flex items-center justify-between gap-2">
        <h2 id="home-decisions" className={heading}>확인 필요 <Badge variant="warning">{decisions.length}</Badge></h2>
        {decisions.length > 3 && <Button variant="ghost" onClick={() => navigate('/inbox')}>모두 보기<ArrowRight/></Button>}
      </div>
      <ul className="grid">{decisions.slice(0, 3).map(item => <Row key={`${item.kind}:${item.id}`} title={approvalTitle(item)} owner={names.get(item.ghostId) ?? 'Ghost'}
        state="확인하기" tone="warning" disabled={!connected} onClick={() => onOpenApproval({ kind: item.kind, id: item.id })}/>)}</ul>
    </section>}
    {stale && <InlineError>{ongoing.length ? '마지막으로 확인한 작업 상태입니다.' : '작업 상태를 확인하지 못했습니다.'}</InlineError>}
    {(ongoing.length > 0 || work.source === 'unavailable' && workLoading) && <section className="grid gap-2" aria-labelledby="home-ongoing" aria-busy={workLoading}>
      <h2 id="home-ongoing" className={heading}>진행 중</h2>
      <ul className="grid">{ongoing.slice(0, 6).map(task => <Row key={task.id} title={task.title} owner={names.get(task.ghostId) ?? 'Ghost'}
        state={task.label} tone={tones[task.tone]} onClick={() => navigate(task.path)}/>)}</ul>
    </section>}
    {projects.length > 0 && <section className="grid gap-2" aria-labelledby="home-projects">
      <h2 id="home-projects" className={heading}>프로젝트</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">{projects.map(space =>
        <Button key={space.id} variant="outline" size="lg" className="justify-start" onClick={() => navigate(`/spaces/${space.id}`)}><Folder/><span className="truncate">{space.name}</span></Button>)}</div>
    </section>}
    {work.tasks.length > 0 && <Button variant="ghost" className="justify-self-start" onClick={() => navigate(workPath)}>모든 일<ArrowRight/></Button>}
  </GPage>;
}
