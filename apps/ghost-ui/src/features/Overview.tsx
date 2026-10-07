import { ArrowUpRight, ArrowRight, Plus, Check, FileText, Search, ListFilter } from 'lucide-react';
import { useState } from 'react';
import { DotAvatar } from '../components/DotAvatar';
import { Status } from '../components/Status';
import { dotState, toneFor, isRunning, phaseLabel } from '../client/types';
import type { Snapshot, Review, Profile, DotState } from '../client/types';

export interface OverviewProps { snapshot: Snapshot; mode: string; navigate: (path: string) => void; onReview: (review: Review) => void; onAdd: () => void; onAssign: (profile?: Profile) => void; }
export function Overview({ snapshot, mode, navigate, onReview, onAdd, onAssign }: OverviewProps) {
  const [filter, setFilter] = useState<DotState | 'all'>('all'), [search, setSearch] = useState(''), [showSearch, setShowSearch] = useState(false);
  const reviews = snapshot.reviews.filter(r => ['pending', 'approved'].includes(r.state));
  const working = snapshot.profiles.filter(p => dotState(p, reviews) === 'working');
  const profiles = snapshot.profiles.filter(p => (filter === 'all' || dotState(p, reviews) === filter) && `${p.name} ${p.persona}`.toLowerCase().includes(search.toLowerCase()));
  const tasks = snapshot.profiles.flatMap(p => p.conversations.flatMap(c => c.tasks.filter(t => isRunning(t.phase)).map(t => ({ p, c, t }))));
  return <div className="overview page-content">
    <div className="page-heading"><div><h1>나의 Ghost</h1><div className="overview-status"><span>진행 중 {working.length}</span><span>확인 필요 {reviews.length}</span></div></div><button className="button primary" onClick={() => onAssign()} disabled={!snapshot.profiles.length}><Plus size={16}/>일 맡기기</button></div>
    {reviews.length > 0 && <section className="attention-section" aria-label="내 확인이 필요한 제안"><div className="section-heading"><h2>확인 필요 <span className="count">{reviews.length}</span></h2><button className="text-button" onClick={() => navigate('/inbox')}>모두 보기<ArrowRight size={14}/></button></div>
      {reviews.slice(0, 2).map(r => { const p = snapshot.profiles.find(p => p.id === r.profile_id); return <div className="attention-row" key={r.id}><div className="attention-symbol"><FileText size={19}/></div><div className="attention-copy"><div className="eyeline"><span>{p?.name ?? 'Ghost'}</span><span>저장 전 검토</span></div><h3>{r.title}</h3></div><button className="button secondary" onClick={() => onReview(r)}>검토하기<ArrowUpRight size={14}/></button></div>; })}
    </section>}
    <section className="dots-section"><div className="section-heading"><h2>나의 Ghost <span className="subtle-count">{snapshot.profiles.length}</span></h2><button className="text-button" onClick={onAdd}><Plus size={15}/>Ghost 만들기</button></div>
      <div className="filter-row"><div className="filter-options" aria-label="Ghost 상태 필터">{([['all', '전체'], ['working', '일하는 중'], ['attention', '확인 필요'], ['idle', '대기 중']] as const).map(([key, label]) => <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)} className={`filter-button ${filter === key ? 'selected' : ''}`}>{label}</button>)}</div><button className="icon-button" aria-label="Ghost 검색" aria-expanded={showSearch} onClick={() => setShowSearch(s => !s)}><Search size={17}/></button></div>
      {showSearch && <label className="search-field"><Search size={16}/><input autoFocus aria-label="Ghost 이름 또는 역할 검색" placeholder="이름이나 역할로 찾기" value={search} onChange={e => setSearch(e.target.value)}/></label>}
      <div className="dot-grid">{profiles.map(p => { const state = dotState(p, reviews), latest = p.conversations.find(c => c.tasks.some(t => isRunning(t.phase) || t.phase === 'waiting_owner')) ?? p.conversations[0]; return <button key={p.id} className={`dot-card tone-${toneFor(p.id)}`} onClick={() => navigate(`/ghosts/${p.id}`)} aria-label={`${p.name} 열기`}><div className="dot-card-top"><DotAvatar profileId={p.id} tone={toneFor(p.id)} size={82}/><ArrowUpRight className="card-arrow" size={18}/></div><h3>{p.name}</h3><p className="dot-role">{p.persona || '역할 미설정'}</p><div className="dot-card-bottom"><Status state={state}/><p>{p.error ? '연결 상태를 확인해 주세요' : latest?.title ?? '대화 없음'}</p></div></button>; })}</div>
      {!profiles.length && <div className="empty-state"><ListFilter size={26}/><h3>{snapshot.profiles.length ? '조건에 맞는 Ghost가 없어요' : 'Ghost 없음'}</h3><p>{snapshot.profiles.length ? '다른 상태나 검색어로 찾아보세요.' : '이름과 역할을 입력해 Ghost를 추가하세요.'}</p><button className="button secondary" onClick={() => snapshot.profiles.length ? (setFilter('all'), setSearch('')) : onAdd()}>{snapshot.profiles.length ? '전체 보기' : 'Ghost 만들기'}</button></div>}
    </section>
    <section className="work-section"><div className="section-heading"><h2>진행 중인 일 <span className="subtle-count">{tasks.length}</span></h2><button className="text-button" onClick={() => navigate('/work')}>작업 보기<ArrowRight size={14}/></button></div><div className="work-list">{tasks.slice(0, 4).map(({ p, c, t }) => <button className="work-row" key={`${p.id}:${t.id}`} onClick={() => navigate(`/ghosts/${p.id}?conversation=${c.id}`)}><DotAvatar profileId={p.id} tone={toneFor(p.id)} size={38}/><div className="work-copy"><strong>{t.name === '응답 생성' ? c.title : t.name}</strong><span>{p.name}</span></div><span className="work-phase"><span className="activity-bars" aria-hidden="true"><i/><i/><i/></span>{phaseLabel(t.phase)}</span><ArrowUpRight className="muted" size={16}/></button>)}</div>{!tasks.length && <div className="quiet-empty"><Check size={18}/><span>진행 중인 작업 없음</span></div>}</section>
    <footer className="workspace-foot"><span>{mode === 'demo' ? '예시 데이터' : ''}</span></footer>
  </div>;
}
