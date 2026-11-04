import { uiTerms } from '../uiText';
import { ArrowUpRight, ArrowRight, Plus, X, FileText, Search, ListFilter } from 'lucide-react';
import { useState } from 'react';
import { DotAvatar } from '../components/DotAvatar';
import { Status } from '../components/Status';
import { dotState, toneFor, isRunning, phaseLabel, stateLabel } from '../client/types';
import type { Snapshot, Review, Profile, DotState } from '../client/types';
import { inboxItems } from '../client/inbox';
import { taskDisplayLabel } from '../client/taskLabel';
import { profileSummary } from './profileSummary';

export interface OverviewProps { snapshot: Snapshot; mode: string; connected?: boolean; navigate: (path: string) => void; onReview: (review: Review) => void; onAdd: () => void; onAssign: (profile?: Profile) => void; }
export function Overview({ snapshot, mode, connected = true, navigate, onReview, onAdd, onAssign }: OverviewProps) {
  const [filter, setFilter] = useState<DotState | 'all'>('all'), [search, setSearch] = useState('');
  const { reviews, count: attentionCount } = inboxItems(snapshot, connected);
  const working = snapshot.profiles.filter(p => dotState(p, reviews) === 'working');
  const profiles = snapshot.profiles.filter(p => (filter === 'all' || dotState(p, reviews) === filter) && `${p.name} ${p.persona}`.toLowerCase().includes(search.toLowerCase()));
  const tasks = snapshot.profiles.flatMap(p => p.conversations.flatMap(c => c.tasks.filter(t => isRunning(t.phase)).map(t => ({ p, c, t }))));
  return <div className="overview page-content">
    <div className="page-heading"><div><h1>나의 Ghost</h1><div className="overview-status"><span className={working.length ? 'has-running-work' : undefined}>진행 중 {working.length}</span><button className="text-button" onClick={() => navigate('/inbox')}>확인 필요 {attentionCount}</button></div></div><button className="button primary" onClick={() => onAssign()} disabled={!snapshot.profiles.length}><Plus size={16}/>일 맡기기</button></div>
    <div className={`overview-layout ${tasks.length ? 'has-running-work' : ''}`}>
    {reviews.length > 0 && <section className="attention-section" aria-label="검토가 필요한 문서"><div className="section-heading"><h2>{uiTerms.reviews} <span className="count">{reviews.length}</span></h2><button className="text-button" onClick={() => navigate('/inbox')}>모두 보기<ArrowRight size={14}/></button></div>
      {reviews.slice(0, 2).map(r => { const p = snapshot.profiles.find(p => p.id === r.profile_id); return <div className="attention-row" key={r.id}><div className="attention-symbol"><FileText size={19}/></div><div className="attention-copy"><div className="eyeline"><span>{p?.name ?? 'Ghost'}</span><span>저장 전 문서 검토</span></div><h3>{r.title}</h3></div><button className="button secondary" onClick={() => onReview(r)}>검토하기<ArrowUpRight size={14}/></button></div>; })}
    </section>}
    <section className="dots-section" aria-label="Ghost 목록"><div className="section-heading"><h2>Ghost 목록 <span className="subtle-count">{snapshot.profiles.length}</span></h2><button className="text-button" onClick={onAdd}><Plus size={15}/>Ghost 만들기</button></div>
      <div className="filter-row"><div className="filter-options" aria-label="Ghost 상태 필터">{([['all', '전체'], ['working', stateLabel.working], ['attention', stateLabel.attention], ['idle', stateLabel.idle]] as const).map(([key, label]) => <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)} className={`filter-button ${filter === key ? 'selected' : ''}`}>{label}</button>)}</div><div className="search-field overview-search"><Search size={15} aria-hidden="true"/><input aria-label="Ghost 이름 또는 역할 검색" placeholder="이름이나 역할 검색" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setSearch(''); }}/>{search && <button className="icon-button small" aria-label="검색어 지우기" onClick={() => setSearch('')}><X size={14}/></button>}</div></div>
      <div className="ghost-list">{profiles.map(p => {
        const state = dotState(p, reviews);
        const latest = p.conversations.find(c => c.tasks.some(t => isRunning(t.phase) || t.phase === 'waiting_owner')) ?? p.conversations[0];
        const task = p.error ? '연결 상태를 확인해 주세요' : latest?.title ?? '대화 없음';
        const role = profileSummary(p.persona);
        return <button key={p.id} className="ghost-row" onClick={() => navigate(latest ? `/ghosts/${p.id}?conversation=${latest.id}` : `/ghosts/${p.id}`)} aria-label={`${p.name} 열기`}>
          <DotAvatar profileId={p.id} tone={toneFor(p.id)} size={36}/>
          <div className="ghost-row-copy"><div className="ghost-row-heading"><h3>{p.name}</h3><Status state={state}/></div><p className="ghost-row-task" title={task}>{task}</p><p className="ghost-row-role" title={role}>{role}</p></div>
          <ArrowUpRight className="muted" size={16}/>
        </button>;
      })}</div>
      {!profiles.length && <div className="empty-state"><ListFilter size={26}/><h3>{snapshot.profiles.length ? '조건에 맞는 Ghost 없음' : 'Ghost 없음'}</h3><p>{snapshot.profiles.length ? '다른 상태나 검색어로 검색해 주세요.' : '이름과 역할 지시를 입력해 Ghost를 추가해 주세요.'}</p><button className="button secondary" onClick={() => snapshot.profiles.length ? (setFilter('all'), setSearch('')) : onAdd()}>{snapshot.profiles.length ? '전체 보기' : 'Ghost 만들기'}</button></div>}
    </section>
    {tasks.length > 0 && <section className="work-section"><div className="section-heading"><h2>진행 중인 일 <span className="subtle-count">{tasks.length}</span></h2><button className="text-button" onClick={() => navigate('/work')}>작업 보기<ArrowRight size={14}/></button></div><div className="work-list">{tasks.slice(0, 4).map(({ p, c, t }) => <button className="work-row" key={`${p.id}:${t.id}`} onClick={() => navigate(`/ghosts/${p.id}?conversation=${c.id}`)}><DotAvatar profileId={p.id} tone={toneFor(p.id)} size={38}/><div className="work-copy"><strong>{taskDisplayLabel(t, c)}</strong><span>{p.name}</span></div><span className="work-phase"><span className="activity-bars" aria-hidden="true"><i/><i/><i/></span>{phaseLabel(t.phase)}</span><ArrowUpRight className="muted" size={16}/></button>)}</div></section>}
    </div>
    <footer className="workspace-foot"><span>{mode === 'demo' ? '예시 데이터' : ''}</span></footer>
  </div>;
}
