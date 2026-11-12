import { lazy, Suspense, useEffect, useState } from 'react';
import { ChevronRight, Folder, FolderPlus, BriefcaseBusiness } from 'lucide-react';
import { Button, InlineError, Page, PageHeader } from '../ui';
import type { PageSummary } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { routeLabels } from '../uiText';
import { noteScopeEdit, scopeLastEdit } from './scopePages';
import { useNow } from './time';
import { Modal } from '../components/Modal';
import { HandoffComposer } from '../components/HandoffComposer';
import { DocumentIndex } from '../components/projects/DocumentIndex';
import { HoldButton } from '../components/projects/HoldButton';
import { ProjectHeader } from '../components/projects/ProjectHeader';
import { WorkLane } from '../components/agent';
import { ScopeEditor } from './ScopeEditor';
import { GhostChat } from './GhostChat';
import { InboxView } from './Inbox';
import { Activities } from './Activities';
import { PolicySettings } from './PolicySettings';
import { ScopeMetrics } from './ScopeMetrics';
import { ConfigHistory } from './ConfigHistory';
import { decisionScopeId } from './scopeState';
import './scopes.css';

const PageEditorDrawer = lazy(() => import('./PageEditorDrawer'));
const destinations = [{ id: 'conversation', label: '대화' }, { id: 'work', label: '맡긴 일' }, { id: 'decisions', label: '결정' }, { id: 'documents', label: '문서' }, { id: 'triggers', label: '계기' }, { id: 'rules', label: '규칙' }, { id: 'metrics', label: '계측' }, { id: 'history', label: '구성 기록' }];

export function ScopesView({ selectedScope, onSelectScope, createRequested, onCreateClosed, navigate, section = 'documents', onSectionChange }: {
  selectedScope?: string; onSelectScope?(id: string): void; createRequested?: boolean; onCreateClosed?(): void;
  navigate(path: string): void; section?: string; onSectionChange?(section: string): void;
}) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const scopes = state?.scopes ?? [];
  const scope = scopes.find(item => item.id === selectedScope);
  const ghosts = (state?.ghosts ?? []).filter(ghost => ghost.state === 'active' && ghost.deletedAt === null);
  const receiver = scope?.ghostId ? ghosts.find(ghost => ghost.id === scope.ghostId) : ghosts.find(ghost => ghost.isDefault);
  const [creating, setCreating] = useState(Boolean(createRequested)), [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [search, setSearch] = useState(''), [pages, setPages] = useState<PageSummary[]>([]), [total, setTotal] = useState(0);
  const [pagesLoading, setPagesLoading] = useState(false), [listError, setListError] = useState(''), [reload, setReload] = useState(0);
  const [open, setOpen] = useState<{ pageId: string | null }>(), [handoff, setHandoff] = useState(false);
  const now = useNow();
  const active = destinations.some(item => item.id === section) ? section : 'documents';
  const select = (id: string) => onSelectScope ? onSelectScope(id) : navigate(id ? `/scopes/${encodeURIComponent(id)}` : '/scopes');
  const changeSection = (id: string) => onSectionChange ? onSectionChange(id) : navigate(`/scopes/${encodeURIComponent(scope!.id)}?view=${id}`);
  useEffect(() => { if (createRequested) setCreating(true); }, [createRequested]);
  useEffect(() => {
    setPages([]); setListError('');
    if (!scope?.vaultPath || creating || active !== 'documents') return;
    let alive = true;
    setPagesLoading(true);
    const timer = setTimeout(() => {
      client.pages(scope.id, search.trim() || undefined).then(items => {
        if (!alive) return;
        setPages(items); if (!search.trim()) setTotal(items.length);
      }).catch(reason => { if (alive) setListError(reason instanceof Error ? reason.message : '문서 목록을 불러오지 못했습니다.'); })
        .finally(() => { if (alive) setPagesLoading(false); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [scope?.id, scope?.vaultPath, search, reload, client, creating, active]);
  const closeCreate = () => { setCreating(false); onCreateClosed?.(); };
  if (creating) return <Page width="reading"><PageHeader title="새 프로젝트"/><ScopeEditor onClose={closeCreate} onSaved={id => { setCreating(false); select(id); }}/></Page>;
  if (selectedScope && !scope) return <Page width="reading"><PageHeader title="프로젝트를 찾을 수 없습니다"/><Button variant="outline" onClick={() => select('')}>프로젝트 목록</Button></Page>;
  if (scope && state) {
    const works = state.works.filter(work => work.scopeId === scope.id).sort((a, b) => b.updatedAt - a.updatedAt);
    const decisions = state.decisions.filter(decision => decisionScopeId(decision, state) === scope.id);
    const remove = async () => {
      setPending(true); setError('');
      try { await client.send({ type: 'scope.delete', scopeId: scope.id }); select(''); }
      catch (reason) { setError(reason instanceof Error ? reason.message : '삭제하지 못했습니다.'); } finally { setPending(false); }
    };
    return <Page width={active === 'conversation' ? 'full' : 'reading'}>
      <div className="grid gap-7 min-w-0">
        <ProjectHeader space={scope} total={total} lastEditAt={scopeLastEdit(scope.id)} now={now} disabled={pending}
          onRename={async name => { await client.send({ type: 'scope.update', scopeId: scope.id, name }); }}/>
        <div className="infra-record__head"><p className="infra-record__meta">{scope.state === 'paused' ? '멈춤' : '진행'} · {receiver?.name ?? '받을 Ghost 없음'}</p><div className="flex gap-2">
          <Button variant="outline" onClick={() => setEditing(value => !value)}>프로젝트 편집</Button>
          <Button disabled={!receiver || scope.state === 'paused'} onClick={() => setHandoff(true)}><BriefcaseBusiness size={16} aria-hidden="true"/>일 맡기기</Button>
        </div></div>
        {editing && <ScopeEditor key={scope.updatedAt} scope={scope} onClose={() => setEditing(false)} onSaved={() => setEditing(false)}/>}
        <nav className="infra-nav" aria-label="프로젝트 내용">{destinations.map(item => <button key={item.id} type="button" aria-current={active === item.id ? 'page' : undefined} onClick={() => changeSection(item.id)}>{item.label}</button>)}</nav>
        {error && <InlineError>{error}</InlineError>}
        {active === 'conversation' && (receiver ? <div className="scope-conversation"><GhostChat key={`${scope.id}:${receiver.id}`} ghost={receiver} state={state} conversationId={receiver.directConversationId} threadId={null} navigate={navigate} initialScopeIds={[scope.id]}/></div> : <p>프로젝트 편집에서 받을 Ghost를 선택하세요.</p>)}
        {active === 'documents' && (scope.vaultPath ? <DocumentIndex pages={pages} total={total} search={search} onSearch={setSearch} loading={pagesLoading} error={listError} onOpen={pageId => setOpen({ pageId })} onCreate={() => setOpen({ pageId: null })}/>
          : <div className="infra-form"><p className="infra-record__meta">문서 금고가 지정되지 않았습니다.</p><div><Button variant="outline" onClick={() => setEditing(true)}>금고 경로 설정</Button></div></div>)}
        {active === 'work' && <section aria-label="프로젝트 맡긴 일">{works.length ? works.map(work => <WorkLane key={work.id} work={work} ghostName={state.ghosts.find(ghost => ghost.id === work.ghostId)?.name ?? 'Ghost'} needsOwner={decisions.some(decision => decision.workId === work.id && decision.state === 'pending')} now={now} onOpen={() => navigate(`/work/${encodeURIComponent(work.id)}`)}/>) : <p className="infra-record__meta">맡긴 일이 없습니다.</p>}</section>}
        {active === 'decisions' && <InboxView state={{ ...state, decisions, notifications: state.notifications.filter(item => item.workId ? works.some(work => work.id === item.workId) : item.decisionId ? decisions.some(decision => decision.id === item.decisionId) : false) }} navigate={navigate} focusDecisionId={null}/>}
        {active === 'triggers' && <Activities scopeId={scope.id} navigate={navigate}/>}
        {active === 'rules' && <PolicySettings scopeId={scope.id}/>}
        {active === 'metrics' && <ScopeMetrics scopeId={scope.id}/>}
        {active === 'history' && <ConfigHistory scopeId={scope.id}/>}
        <section className="place-end" aria-label="프로젝트 삭제">
          {!armed ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => setArmed(true)}>프로젝트 삭제</Button>
            : <div className="place-end__strip"><p>{scope.name} 프로젝트 등록을 지울까요? 보관함의 문서는 지워지지 않습니다.</p><div className="place-end__row"><Button variant="outline" size="sm" disabled={pending} onClick={() => setArmed(false)}>취소</Button><HoldButton label="삭제" holdingLabel="누르는 중" disabled={pending} onComplete={() => void remove()}/></div></div>}
        </section>
      </div>
      {handoff && receiver && <Modal title="일 맡기기" onClose={() => setHandoff(false)}><HandoffComposer ghosts={ghosts} navigate={navigate} initialScopeIds={[scope.id]} initialMode="work"/></Modal>}
      {open && <Suspense fallback={<Modal title="문서" onClose={() => setOpen(undefined)} drawer focusClose><p role="status">편집기를 불러오는 중…</p></Modal>}><PageEditorDrawer scopeId={scope.id} pageId={open.pageId} onClose={() => setOpen(undefined)} onSaved={() => { noteScopeEdit(scope.id); setReload(value => value + 1); }}/></Suspense>}
    </Page>;
  }
  return <Page width="reading"><PageHeader title={routeLabels.scopes} actions={<Button disabled={!state} onClick={() => setCreating(true)}><FolderPlus size={16}/>새 프로젝트</Button>}/>
    {scopes.length ? <div className="projects">{scopes.map(item => <button type="button" className="project-row" key={item.id} onClick={() => select(item.id)}>
      <span className="project-row__glyph" aria-hidden="true"><Folder size={17}/></span><span className="project-row__copy"><span className="project-row__name">{item.name}</span><span className="project-row__path">{item.state === 'paused' ? '멈춤' : '진행'} · {(item.ghostId ? state?.ghosts.find(ghost => ghost.id === item.ghostId) : state?.ghosts.find(ghost => ghost.isDefault))?.name ?? '받을 Ghost 없음'}</span></span><ChevronRight className="project-row__go" aria-hidden="true"/>
    </button>)}</div> : state && <div className="calm"><FolderPlus size={16}/><p>등록된 프로젝트가 없습니다</p></div>}
  </Page>;
}
