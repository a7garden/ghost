import { uiTerms } from '../uiText';
import { RoutingCompletionInbox } from './RoutingResults';
import { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CheckCheck, CircleAlert, Clock3, FileText, Folder, Inbox, LayoutList, Pause, Play, Plus, Search } from 'lucide-react';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { Status } from '../components/Status';
import { isRunning, phaseLabel, toneFor } from '../client/types';
import type { Snapshot, Command, Review, Page } from '../client/types';
import { inboxItems, taskAttentionMessage } from '../client/inbox';
import { GardenMarkdownPreview } from './GardenMarkdownPreview';
import './garden-document-preview.css';

type Action = (command: Command) => Promise<Record<string, any>>;
export function InboxView({ snapshot, onReview, navigate, connected = true }: { snapshot: Snapshot; connected?:boolean; onReview: (review: Review) => void; navigate: (path: string) => void }) {
  const { reviews, tasks, count } = inboxItems(snapshot, connected);
  return <div className="page-content">
    <div className="page-heading"><div><h1>{uiTerms.inbox}</h1></div><Inbox size={25} className="muted"/></div>
    <div className="inbox-list">
      {reviews.map(r => { const p = snapshot.profiles.find(p => p.id === r.profile_id); return <article className="inbox-item" key={r.id}><DotAvatar profileId={r.profile_id} tone={toneFor(r.profile_id)} size={52}/><div><span className="eyeline">{p?.name} · 저장 전 문서 검토</span><h2>{r.title}</h2><p>{r.body.replace(/^#+\s*/gm, '').slice(0, 90)}…</p><button className="button secondary" onClick={() => onReview(r)}>검토하기<ArrowUpRight size={14}/></button></div></article>; })}
      {tasks.map(({ p, c, t }) => <article className="inbox-item" key={`${p.id}:${c.id}:${t.id}`}>
        <CircleAlert size={24}/><div>
          <span className="eyeline">{p.name} · {phaseLabel(t.phase)}</span><h2>{c.title}</h2>
          <p>{taskAttentionMessage(t)}</p>
          {t.output && <details className="inbox-task-record"><summary>실행 기록</summary><pre>{t.output}</pre></details>}
          <div className="inbox-actions">
            <button className="button secondary" onClick={() => navigate(`/ghosts/${p.id}?conversation=${c.id}`)}>대화와 작업 보기<ArrowRight size={14}/></button>
            {t.phase === 'failed' && <button className="button secondary" onClick={() => navigate(`/settings?tab=models&ghost=${encodeURIComponent(p.id)}`)}>모델 설정</button>}
          </div>
        </div>
      </article>)}
    </div>
    {!count && <div className="empty-state large-empty"><CheckCheck size={34}/><h2>확인이 필요한 항목 없음</h2><button className="button secondary" onClick={() => navigate('/')}>나의 Ghost 보기</button></div>}
    <RoutingCompletionInbox snapshot={snapshot} connected={connected}/>
  </div>;
}

export function WorkView({ snapshot, action, busy, navigate, onAssign }: { snapshot: Snapshot; action: Action; busy: boolean; navigate: (path: string) => void; onAssign: () => void }) {
  const [tab, setTab] = useState('active'), [error, setError] = useState('');
  const tasks = snapshot.profiles.flatMap(p => p.conversations.flatMap(c => c.tasks.map(t => ({ p, c, t }))));
  const visible = tasks.filter(({ t }) => tab === 'active' ? isRunning(t.phase) || t.phase === 'waiting_owner' : ['complete', 'failed', 'uncertain', 'cancelled'].includes(t.phase));
  const run = async (command: Command) => { setError(''); try { await action(command); } catch (e) { setError(e instanceof Error ? e.message : '변경을 저장하지 못했습니다.'); } };
  return <div className="page-content"><div className="page-heading"><div><h1>{uiTerms.work}</h1></div><button className="button primary" onClick={onAssign} disabled={!snapshot.profiles.length}><Plus size={16}/>일 맡기기</button></div>{error && <p className="inline-error" role="alert">{error}</p>}
    {snapshot.goals.length > 0 && <section className="goals-section"><div className="section-heading"><h2>{uiTerms.goals}</h2></div><div className="goals-list">{snapshot.goals.map(g => { const p = snapshot.profiles.find(p => p.id === g.profile_id); const paused = g.state === 'paused'; return <article className="goal-item" key={g.id}><DotAvatar profileId={g.profile_id} tone={toneFor(g.profile_id)} size={46}/><div><div className="eyeline">{p?.name} · {g.state === 'complete' ? '완료' : paused ? '일시정지' : '진행 중'}</div><h3>{g.title}</h3><p>{g.note || g.criteria}</p></div>{g.state !== 'complete' && <button className="icon-button" aria-label={`${g.title} ${paused ? '재개' : '일시정지'}`} disabled={busy} onClick={() => void run({ type: 'workspace', action: { type: 'goal_state', goal_id: g.id, state: paused ? 'ready' : 'paused', evidence: g.evidence } })}>{paused ? <Play size={17}/> : <Pause size={17}/>}</button>}</article>; })}</div></section>}
    <section className="work-section"><div className="section-heading"><h2>대화에서 진행한 일</h2></div><div className="filter-options"><button className={`filter-button ${tab === 'active' ? 'selected' : ''}`} aria-pressed={tab === 'active'} onClick={() => setTab('active')}>진행 중</button><button className={`filter-button ${tab === 'finished' ? 'selected' : ''}`} aria-pressed={tab === 'finished'} onClick={() => setTab('finished')}>종료된 작업</button></div><div className="work-list">{visible.map(({ p, c, t }) => <button className="work-row" key={`${p.id}:${t.id}`} onClick={() => navigate(`/ghosts/${p.id}?conversation=${c.id}`)}><DotAvatar profileId={p.id} tone={toneFor(p.id)} size={38}/><div className="work-copy"><strong>{t.name === '응답 생성' ? c.title : t.name}</strong><span>{p.name}</span></div><span className="work-phase">{phaseLabel(t.phase)}</span><ArrowUpRight size={15}/></button>)}</div>{!visible.length && <div className="quiet-empty"><Check size={18}/>해당하는 작업 없음</div>}</section>
    <section className="work-section"><div className="section-heading"><h2>{uiTerms.schedules}</h2><Clock3 className="muted" size={17}/></div>{snapshot.schedules.map(s => <article className="schedule-row" key={s.id}><Clock3 size={19}/><div><strong>{s.prompt}</strong><span>{snapshot.profiles.find(p => p.id === s.profile_id)?.name} · {s.paused ? '일시정지' : `다음 ${new Date(s.next_run_ms).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}</span></div><button className="button secondary" disabled={busy} onClick={() => void run({ type: 'pause_schedule', schedule_id: s.id, paused: !s.paused })}>{s.paused ? <Play size={14}/> : <Pause size={14}/>}<span>{s.paused ? '재개' : '일시정지'}</span></button></article>)}{!snapshot.schedules.length && <div className="quiet-empty"><Clock3 size={18}/>Ghost와의 대화에서 반복 작업을 예약할 수 있습니다.</div>}</section>
  </div>;
}

export function SpacesView({ snapshot, selectedSpace, action, navigate, theme }: { snapshot: Snapshot; selectedSpace?: string; action: Action; navigate: (path: string) => void; theme: 'light' | 'dark' }) {
  const space = snapshot.spaces.find(s => s.id === selectedSpace), [pages, setPages] = useState<Page[]>([]), [page, setPage] = useState<Page | null>(null), [query, setQuery] = useState(''), [showDeleted, setShowDeleted] = useState(false), [error, setError] = useState(''), [loading, setLoading] = useState(true), [loadingPage, setLoadingPage] = useState(false);
  const visiblePages = pages.filter(p => (showDeleted || !p.deleted) && p.title.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { if (!space) { setLoading(false); return; } let alive = true; setLoading(true); action({ type: 'workspace', action: { type: 'list_pages', space_id: space.id, query: '' } }).then(data => { if (alive) setPages(Array.isArray(data) ? data : []); }).catch(e => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false); }); return () => { alive = false; }; }, [space?.id, action]);
  const openPage = async (p: Page) => { if (!space || loadingPage) return; setError(''); setLoadingPage(true); try { const result = await action({ type: 'workspace', action: { type: 'read_page', space_id: space.id, page_id: p.id && !p.diagnostic ? p.id : null, locator: p.id && !p.diagnostic ? null : p.locator } }); setPage(result as Page); } catch (e) { setError(e instanceof Error ? e.message : '문서를 열지 못했습니다.'); } finally { setLoadingPage(false); } };
  return <div className="page-content"><div className="page-heading"><div><h1>{space?.name ?? '문서 공간'}</h1></div><Folder className="muted" size={25}/></div><div className="space-tabs">{snapshot.spaces.map(s => <button key={s.id} className={`filter-button ${s.id === selectedSpace ? 'selected' : ''}`} onClick={() => navigate(`/spaces/${s.id}`)}><Folder size={14}/>{s.name}</button>)}</div>{space && <label className="search-field page-search"><Search size={17}/><input aria-label="문서 검색" placeholder="문서 제목으로 찾기" value={query} onChange={e => setQuery(e.target.value)}/></label>}{space && <label className="checkbox-row"><input type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)}/>삭제된 문서 포함</label>}{error && <p className="inline-error" role="alert">{error}</p>}{loading ? <div className="document-grid" aria-busy="true">{[0, 1, 2].map(v => <div className="skeleton document-skeleton" key={v}/>)}</div> : <div className="document-grid">{visiblePages.map(p => <button className="document-card" key={p.id ?? p.locator} onClick={() => void openPage(p)} disabled={loadingPage}><div className="document-thumbnail"><FileText size={31}/><div className="document-lines"><i/><i/><i/><i/></div></div><h2>{p.title}</h2><div><span>{p.deleted ? '삭제됨' : p.legacy ? '레거시 · 읽기 전용' : p.diagnostic ? '확인 필요' : '문서'}</span><ArrowUpRight size={15}/></div></button>)}</div>}{!loading && !visiblePages.length && <div className="empty-state large-empty"><FileText size={30}/><h2>{query ? '문서를 찾지 못했습니다' : '문서 없음'}</h2><p>{query ? '다른 제목으로 검색해 주세요.' : space ? 'Ghost에게 문서 초안을 요청하고, 검토 후 저장해 보세요.' : '호스트에서 문서 공간을 연결하면 여기에 표시됩니다.'}</p><button className="button secondary" onClick={() => query ? setQuery('') : navigate('/')}>{query ? '검색 지우기' : '나의 Ghost 보기'}</button></div>}
    {page && <Modal title={page.title} onClose={() => setPage(null)} drawer><div className="page-reader">{page.diagnostic && <p className="inline-error" role="alert">{page.diagnostic}</p>}{page.preview ? page.profile === 'pdc-markdown/1' ? <GardenMarkdownPreview html={page.preview} title={page.title} theme={theme}/> : <iframe title={`${page.title} 미리보기`} sandbox="" referrerPolicy="no-referrer" srcDoc={page.preview}/> : <pre className="garden-document-source-readonly"><code>{page.body ?? page.source ?? '표시할 본문이 없습니다.'}</code></pre>}<p className="field-help">{page.legacy ? '기존 형식은 원문 보기만 지원하며 자동 변환하지 않습니다.' : '문서 원문은 연결된 공간에 보존됩니다.'}</p></div></Modal>}
  </div>;
}
