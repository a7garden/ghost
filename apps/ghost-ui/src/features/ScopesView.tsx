import { lazy, Suspense, useEffect, useState } from 'react';
import { ChevronRight, Folder, FolderPlus } from 'lucide-react';
import { Button, Page, PageHeader, Row } from '../ui';
import type { PageSummary, Scope, State } from '@ghost/contract';
import { TERMINAL_WORK_STATES } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { routeLabels } from '../uiText';
import { useNow } from './time';
import { Modal } from '../components/Modal';
import { HandoffComposer } from '../components/HandoffComposer';
import { DocumentIndex } from '../components/projects/DocumentIndex';
import { ProjectBar } from '../components/projects/ProjectBar';
import { ProjectWork } from '../components/projects/ProjectWork';
import { ScopeEditor } from './ScopeEditor';
import { GhostChat } from './GhostChat';
import { ScopeGoals } from './goals/Goals';
import { ProjectSettings, settingsParts } from './ProjectSettings';
import { decisionScopeId } from './scopeState';
import './scopes.css';

const PageEditorDrawer = lazy(() => import('./PageEditorDrawer'));

/** The view ids a project address may carry; the standing machinery lives under 설정, and 결정 became part of 맡긴 일. */
function tabOf(view: string | undefined, fallback: string): string {
  if (view === 'decisions') return 'work';
  if (settingsParts.some(part => part.id === view)) return 'settings';
  return ['conversation', 'work', 'documents', 'goals', 'settings'].includes(view ?? '') ? view! : fallback;
}

/** What a project row says at a glance: who carries it, what runs, what waits on the owner. */
function rowSummary(scope: Scope, state: State | null): string {
  if (!state) return '';
  const carrier = state.ghosts.find(ghost => ghost.id === scope.ghostId) ?? state.ghosts.find(ghost => ghost.isDefault);
  const live = state.works.filter(work => work.scopeId === scope.id && !TERMINAL_WORK_STATES.includes(work.state)).length;
  const waiting = state.decisions.filter(decision => decision.state === 'pending' && decisionScopeId(decision, state) === scope.id).length;
  return [scope.state === 'paused' && '멈춤', carrier?.name ?? '받을 Ghost 없음', live > 0 && `진행 중 ${live}`, waiting > 0 && `확인 필요 ${waiting}`].filter(Boolean).join(' · ');
}

export function ScopesView({ selectedScope, onSelectScope, createRequested, onCreateClosed, navigate, section, onSectionChange }: {
  selectedScope?: string; onSelectScope?(id: string): void; createRequested?: boolean; onCreateClosed?(): void;
  navigate(path: string): void; section?: string; onSectionChange?(section: string): void;
}) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const scopes = state?.scopes ?? [];
  const scope = scopes.find(item => item.id === selectedScope);
  const ghosts = (state?.ghosts ?? []).filter(ghost => ghost.state === 'active' && ghost.deletedAt === null);
  const receiver = scope?.ghostId ? ghosts.find(ghost => ghost.id === scope.ghostId) : ghosts.find(ghost => ghost.isDefault);
  const [creating, setCreating] = useState(Boolean(createRequested));
  const [search, setSearch] = useState(''), [pages, setPages] = useState<PageSummary[]>([]), [total, setTotal] = useState(0);
  const [pagesLoading, setPagesLoading] = useState(false), [listError, setListError] = useState(''), [reload, setReload] = useState(0);
  const [open, setOpen] = useState<{ pageId: string | null }>(), [handoff, setHandoff] = useState(false);
  const [toolsHost, setToolsHost] = useState<HTMLDivElement | null>(null);
  const now = useNow();
  const active = tabOf(section, receiver ? 'conversation' : 'work');
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
    const waiting = state.decisions.filter(decision => decision.state === 'pending' && decisionScopeId(decision, state) === scope.id).length;
    const part = settingsParts.some(item => item.id === section) ? section! : 'settings';
    const tabs = [{ id: 'conversation', label: '대화' }, { id: 'work', label: '맡긴 일', count: waiting }, { id: 'documents', label: '문서' }, { id: 'goals', label: '목표' }, { id: 'settings', label: '설정' }];
    return <div className="project" data-view={active}>
      <ProjectBar scope={scope} receiverName={receiver?.name ?? null} tabs={tabs} active={active} onTab={changeSection} toolsRef={setToolsHost}
        canHandoff={Boolean(receiver) && scope.state !== 'paused'} onHandoff={() => setHandoff(true)} onManage={() => changeSection('settings')}
        onRename={async name => { await client.send({ type: 'scope.update', scopeId: scope.id, name }); }}/>
      <div className="project__body">
        {active === 'conversation' && (receiver
          ? <GhostChat key={`${scope.id}:${receiver.id}`} ghost={receiver} state={state} conversationId={receiver.directConversationId} threadId={null} navigate={navigate} initialScopeIds={[scope.id]} toolsHost={toolsHost}/>
          : <div className="project__page"><div className="calm"><p>받을 Ghost를 정하면 여기서 대화할 수 있습니다.</p><Button variant="outline" size="sm" onClick={() => changeSection('settings')}>설정 열기</Button></div></div>)}
        {active === 'work' && <div className="project__page"><ProjectWork state={state} scope={scope} now={now} navigate={navigate}/></div>}
        {active === 'documents' && <div className="project__page">{scope.vaultPath
          ? <DocumentIndex pages={pages} total={total} search={search} onSearch={setSearch} loading={pagesLoading} error={listError} onOpen={pageId => setOpen({ pageId })} onCreate={() => setOpen({ pageId: null })}/>
          : <div className="calm"><p>문서 금고가 지정되지 않았습니다.</p><Button variant="outline" size="sm" onClick={() => changeSection('settings')}>금고 경로 설정</Button></div>}</div>}
        {active === 'goals' && <div className="project__page"><ScopeGoals state={state} navigate={navigate} scopeId={scope.id}/></div>}
        {active === 'settings' && <div className="project__page"><ProjectSettings scope={scope} part={part} onPart={changeSection} navigate={navigate}
          onLeave={() => changeSection(receiver ? 'conversation' : 'work')} onDeleted={() => select('')}/></div>}
      </div>
      {handoff && receiver && <Modal title="일 맡기기" onClose={() => setHandoff(false)}><HandoffComposer ghosts={ghosts} navigate={navigate} initialScopeIds={[scope.id]} initialMode="work"/></Modal>}
      {open && <Suspense fallback={<Modal title="문서" onClose={() => setOpen(undefined)} drawer focusClose><p role="status">편집기를 불러오는 중…</p></Modal>}><PageEditorDrawer scopeId={scope.id} pageId={open.pageId} onClose={() => setOpen(undefined)} onSaved={() => setReload(value => value + 1)}/></Suspense>}
    </div>;
  }
  return <Page width="reading"><PageHeader title={routeLabels.scopes} actions={<Button disabled={!state} onClick={() => setCreating(true)}><FolderPlus size={16}/>새 프로젝트</Button>}/>
    {scopes.length ? <div className="projects">{scopes.map(item => <Row key={item.id} onClick={() => select(item.id)}>
      <span className="project-row__glyph" aria-hidden="true"><Folder size={17}/></span><span className="project-row__copy"><span className="project-row__name">{item.name}</span><span className="project-row__path">{rowSummary(item, state)}</span></span><ChevronRight className="project-row__go" aria-hidden="true"/>
    </Row>)}</div> : state && <div className="calm"><FolderPlus size={16}/><p>등록된 프로젝트가 없습니다</p></div>}
  </Page>;
}
