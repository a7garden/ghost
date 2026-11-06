import { ArrowRight, ArrowUp, Folder } from 'lucide-react';
import { useRef, useState } from 'react';
import { DotAvatar } from '../components/DotAvatar';
import { toneFor } from '../client/types';
import type { Snapshot, Profile } from '../client/types';
import type { Snapshot as LifetimeSnapshot } from '../lifetime/types';
import { inboxItems } from '../client/inbox';
import { approvalTitle, type ApprovalRef } from '../plugins/approvals';
import { projectDashboardWork } from './dashboardState';
import { ghostDisplayName } from './profileSummary';

export interface OverviewProps {
  snapshot: Snapshot; connected?: boolean; navigate: (path: string) => void;
  onOpenApproval: (ref: ApprovalRef) => void;
  /** Sends the first message to `chatTarget`; rejects with a displayable error. */
  onStartChat: (text: string) => Promise<void>; chatTarget?: Profile;
  workPath: string;
  lifetime?: LifetimeSnapshot; workError?: string; workLoading?: boolean;
}

export function Overview({ snapshot, connected = true, navigate, onOpenApproval, onStartChat, chatTarget, workPath, lifetime, workError, workLoading }: OverviewProps) {
  const work = projectDashboardWork(snapshot, lifetime);
  const decisions = inboxItems(snapshot, connected).groups.pending;
  const names = new Map(snapshot.profiles.map(profile => [profile.id, ghostDisplayName(profile.name)]));
  const ongoing = work.tasks.filter(task => task.tone === 'running' || task.tone === 'attention');
  const projects = snapshot.spaces.slice(0, 4);
  const stale = Boolean(workError) || !connected;
  return <div className="home page-content">
    <DashboardComposer target={connected ? chatTarget : undefined} onStart={onStartChat}/>
    {decisions.length > 0 && <section className="home-section" aria-labelledby="home-decisions">
      <div className="home-section-heading"><h2 id="home-decisions">확인 필요 <span className="count">{decisions.length}</span></h2>
        {decisions.length > 3 && <button className="text-button" onClick={() => navigate('/inbox')}>모두 보기<ArrowRight size={14}/></button>}</div>
      <div className="home-list">{decisions.slice(0, 3).map(item => <button className="work-card" data-tone="attention" key={`${item.kind}:${item.id}`}
        disabled={!connected} onClick={() => onOpenApproval({ kind: item.kind, id: item.id })}>
        <span className="work-card-copy"><strong>{approvalTitle(item)}</strong><small>{names.get(item.ghostId) ?? 'Ghost'}</small></span>
        <span className="work-card-state">확인하기</span>
      </button>)}</div>
    </section>}
    {stale && <p className="home-stale" role="status">{ongoing.length ? '마지막으로 확인한 작업 상태입니다.' : '작업 상태를 확인하지 못했습니다.'}</p>}
    {(ongoing.length > 0 || work.source === 'unavailable' && workLoading) && <section className="home-section" aria-labelledby="home-ongoing" aria-busy={workLoading}>
      <div className="home-section-heading"><h2 id="home-ongoing">진행 중</h2></div>
      <div className="home-list">{ongoing.slice(0, 6).map(task => <button className="work-card" data-tone={task.tone} key={task.id} onClick={() => navigate(task.path)}>
        <span className="work-card-copy"><strong>{task.title}</strong><small>{names.get(task.ghostId) ?? 'Ghost'}</small></span>
        <span className="work-card-state">{task.label}</span>
      </button>)}</div>
    </section>}
    {projects.length > 0 && <section className="home-section" aria-labelledby="home-projects">
      <div className="home-section-heading"><h2 id="home-projects">프로젝트</h2></div>
      <div className="home-projects">{projects.map(space => <button className="home-project" key={space.id} onClick={() => navigate(`/spaces/${space.id}`)}>
        <Folder size={16}/><span>{space.name}</span>
      </button>)}</div>
    </section>}
    {work.tasks.length > 0 && <button className="text-button home-all-work" onClick={() => navigate(workPath)}>모든 일<ArrowRight size={14}/></button>}
  </div>;
}

function DashboardComposer({ target, onStart }: { target?: Profile; onStart: (text: string) => Promise<void> }) {
  const [text, setText] = useState(''), [sending, setSending] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false);
  const blocked = !target || sending || !text.trim();
  const send = async () => {
    if (blocked || inFlight.current) return;
    inFlight.current = true; setSending(true); setError('');
    try { await onStart(text); setText(''); }
    catch (e) { setError(e instanceof Error ? e.message : '메시지를 보내지 못했습니다.'); }
    finally { inFlight.current = false; setSending(false); }
  };
  return <form className="home-composer composer thread-composer" aria-label="Ghost에게 메시지 보내기" onSubmit={event => { event.preventDefault(); void send(); }}>
    <label className="sr-only" htmlFor="dashboard-message">{target ? `${ghostDisplayName(target.name)}에게 메시지` : '메시지'}</label>
    <textarea id="dashboard-message" rows={3} maxLength={8192} placeholder="무엇을 맡길까요?" value={text} disabled={!target || sending}
      onChange={event => setText(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } }}/>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="home-composer-bottom">
      {target && <span className="home-composer-target"><DotAvatar profileId={target.id} tone={toneFor(target.id)} size={20}/>{ghostDisplayName(target.name)}</span>}
      <button type="submit" className="send-button" disabled={blocked} aria-label="보내기">{sending ? <span className="button-loading"/> : <ArrowUp size={18}/>}</button>
    </div>
  </form>;
}
