import { ArrowUpRight, ArrowRight, Plus, Search, X, Activity, Inbox, Cpu, Puzzle, Server, Check, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { DotAvatar } from '../components/DotAvatar';
import { toneFor } from '../client/types';
import type { Snapshot, Review, Profile } from '../client/types';
import type { Snapshot as LifetimeSnapshot } from '../lifetime/types';
import { inboxItems } from '../client/inbox';
import { profileSummary } from './profileSummary';
import { projectDashboardWork } from './dashboardState';
import { ghostPath } from './PackageWorkspace';
import type { HostStatus } from './hostStatus';

export interface OverviewProps {
  snapshot: Snapshot; mode: string; connected?: boolean; navigate: (path: string) => void;
  onReview: (review: Review) => void; onAdd: () => void; onAssign: (profile?: Profile) => void;
  lifetime?: LifetimeSnapshot; workError?: string; workLoading?: boolean; status?: HostStatus;
}
export function Overview({ snapshot, mode, connected = true, navigate, onReview, onAdd, onAssign, lifetime, workError, workLoading, status }: OverviewProps) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const work = projectDashboardWork(snapshot, lifetime);
  const inbox = inboxItems(snapshot, connected);
  const approvals = inbox.groups.pending;
  const known = work.source !== 'unavailable';
  const active = work.tasks.filter(task => task.tone === 'running');
  const attention = work.tasks.filter(task => task.tone === 'attention');
  const tasks = filter === 'running' ? active : filter === 'attention' ? attention : work.tasks;
  const profiles = snapshot.profiles.filter(profile => `${profile.name} ${profile.persona}`.toLowerCase().includes(search.toLowerCase()));
  const workPath = snapshot.lifetime_authority ? '/lifetime?panel=work&scope=all' : '/work';
  const host = status ?? { state: mode === 'demo' ? 'demo' : connected ? 'connected' : 'stale', label: mode === 'demo' ? '예시 모드' : connected ? '연결됨' : '갱신 지연' };
  return <div className="dashboard page-content">
    <div className="page-heading"><h1>대시보드</h1><button className="button primary" onClick={() => onAssign()} disabled={!connected || !snapshot.profiles.length}><Plus size={16}/>일 맡기기</button></div>
    <button className="dashboard-host-strip" onClick={() => navigate('/host')}>
      <span className="dashboard-host-symbol"><Server size={18}/></span>
      <strong>Ghost Host</strong><span className="dashboard-status" data-state={host.state}><i/>{host.label}</span>
      <span className="dashboard-host-dispatch">{snapshot.lifetime_authority ? snapshot.lifetime_authority.dispatch_enabled ? '작업 접수 허용' : '작업 접수 중지' : '작업실'}</span>
      <ArrowUpRight size={16}/>
    </button>
    <div className="dashboard-metrics" aria-label="작업 요약">
      <button onClick={() => navigate(workPath)}><Activity size={17}/><span>진행 중인 작업</span><strong>{known ? work.running : '—'}</strong></button>
      <button onClick={() => navigate('/inbox')}><Inbox size={17}/><span>승인 대기</span><strong>{approvals.length}</strong></button>
      <button onClick={() => document.getElementById('dashboard-ghosts')?.scrollIntoView({ behavior: 'instant', block: 'start' })}><MessageCircle size={17}/><span>나의 Ghost</span><strong>{snapshot.profiles.length}</strong></button>
    </div>
    <div className="dashboard-columns">
      <div className="dashboard-main-column">
        {approvals.length > 0 && <section className="dashboard-attention" aria-label="승인 대기"><div className="section-heading"><h2>확인이 필요해요 <span className="count">{approvals.length}</span></h2><button className="text-button" onClick={() => navigate('/inbox')}>모두 보기<ArrowRight size={14}/></button></div>
          {approvals.slice(0, 2).map(item => <div className="dashboard-approval" key={`${item.kind}:${item.id}`}><Inbox size={18}/><span><strong>{item.kind === 'document' ? item.review.title : item.kind === 'integration' ? item.review.integration_name : '실행 승인'}</strong><small>{snapshot.profiles.find(p => p.id === item.ghostId)?.name ?? 'Ghost'}</small></span><button className="button secondary" disabled={!connected} onClick={() => item.kind === 'document' ? onReview(item.review) : navigate('/inbox')}>확인하기</button></div>)}
        </section>}
        <section className="dashboard-work" aria-label="작업 현황">
          <div className="section-heading"><h2>작업 현황</h2><button className="text-button" onClick={() => navigate(workPath)}>작업실 열기<ArrowUpRight size={14}/></button></div>
          <div className="dashboard-tabs" aria-label="작업 필터">{[['all','전체'],['running','진행 중'],['attention','확인 필요']].map(([value,label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}{value === 'attention' && attention.length > 0 && <span>{attention.length}</span>}</button>)}</div>
          {(workError || !connected) && <p className="dashboard-read-warning" role="status">최신 작업 상태를 확인하지 못했습니다. {known ? '마지막으로 확인한 기록입니다.' : '다시 연결해 주세요.'}</p>}
          {!known ? <div className="dashboard-empty" aria-busy={workLoading}><Activity size={24}/><h3>{workLoading ? '작업을 불러오는 중' : '작업 상태 확인 필요'}</h3><p>Host의 현재 작업 기록을 확인하고 있습니다.</p></div>
            : tasks.length ? <div className="dashboard-task-list">{tasks.slice(0, 6).map(task => <button className="dashboard-task" key={task.id} onClick={() => navigate(task.path)}><span className="dashboard-task-indicator" data-tone={task.tone}><Activity size={16}/></span><span className="dashboard-task-copy"><strong>{task.title}</strong><small>{snapshot.profiles.find(p => p.id === task.ghostId)?.name ?? task.ghostId}</small></span><span className="dashboard-task-state" data-tone={task.tone}>{task.label}</span><ArrowUpRight size={14}/></button>)}</div>
            : <div className="dashboard-empty"><Check size={24}/><h3>{filter === 'attention' ? '확인이 필요한 작업이 없어요' : '진행 중인 작업이 없어요'}</h3><p>Ghost에게 새 일을 맡기면 여기에 표시됩니다.</p><button className="text-button" disabled={!connected || !snapshot.profiles.length} onClick={() => onAssign()}>Ghost와 대화하기<ArrowRight size={14}/></button></div>}
        </section>
        <section id="dashboard-ghosts" className="dashboard-roster" aria-label="나의 Ghost">
          <div className="section-heading"><h2>나의 Ghost <span className="subtle-count">{snapshot.profiles.length}</span></h2><button className="text-button" disabled={!connected} onClick={onAdd}><Plus size={15}/>Ghost 만들기</button></div>
          <div className="search-field dashboard-search"><Search size={15}/><input aria-label="Ghost 이름 또는 역할 검색" placeholder="이름이나 역할 검색" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setSearch(''); }}/>{search && <button className="icon-button small" aria-label="검색어 지우기" onClick={() => setSearch('')}><X size={14}/></button>}</div>
          <div className="dashboard-ghost-list">{profiles.map(profile => {
            const owned = work.tasks.filter(task => task.ghostId === profile.id);
            return <button className="dashboard-ghost" key={profile.id} onClick={() => navigate(ghostPath(profile.id))}><DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={40}/><span><strong>{profile.name}</strong><small>{profileSummary(profile.persona) || '대화 열기'}</small></span>{owned.length > 0 && <span className="dashboard-ghost-count">작업 {owned.length}</span>}<ArrowUpRight size={14}/></button>;
          })}</div>
          {!profiles.length && <p className="quiet-empty">{snapshot.profiles.length ? '검색 결과가 없습니다.' : '첫 Ghost를 만들어 대화를 시작하세요.'}</p>}
        </section>
      </div>
      <aside className="dashboard-side-column" aria-label="호스트 관리">
        <section className="dashboard-manage"><div className="section-heading"><h2>연결과 확장</h2></div>
          <button onClick={() => navigate('/providers')}><Cpu size={19}/><span><strong>프로바이더</strong><small>대화 · 이미지 · 음성</small></span><ArrowUpRight size={15}/></button>
          <button onClick={() => navigate('/integrations')}><Puzzle size={19}/><span><strong>확장</strong><small>Ghost 패키지 · 외부 도구</small></span><ArrowUpRight size={15}/></button>
          <button onClick={() => navigate('/host')}><Server size={19}/><span><strong>호스트</strong><small>연결 · 실행 권한 · 기능</small></span><ArrowUpRight size={15}/></button>
        </section>
      </aside>
    </div>
    {mode === 'demo' && <p className="dashboard-demo-note">예시 데이터 · 실제 작업을 실행하지 않습니다.</p>}
  </div>;
}
