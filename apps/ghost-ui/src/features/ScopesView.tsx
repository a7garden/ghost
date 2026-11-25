import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { ChevronRight, FolderPlus } from 'lucide-react';
import { Button, Page, PageHeader, Row, SkeletonText } from '../ui';
import type { PageSummary, Scope, State } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { routeLabels } from '../uiText';
import { useNow } from './time';
import { ghostPresence, visibleGhosts } from './ghostState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { WorkDispatch } from './WorkBrief';
import { DocumentIndex } from '../components/projects/DocumentIndex';
import { ProjectBar } from '../components/projects/ProjectBar';
import { ProjectPulse } from '../components/projects/ProjectPulse';
import { ProjectWork } from '../components/projects/ProjectWork';
import { ScopeEditor } from './ScopeEditor';
import { GhostChat } from './GhostChat';
import { ScopeGoals } from './goals/Goals';
import { ProjectSettings, settingsParts } from './ProjectSettings';
import { projectWork } from './scopeState';
import './scopes.css';

const PageEditor = lazy(() => import('./PageEditor'));

/** The editor takes the index's place until both can fit side by side. */
const wideQuery = '(min-width: 72rem)';
const subscribeWide = (notify: () => void) => { const media = matchMedia(wideQuery); media.addEventListener('change', notify); return () => media.removeEventListener('change', notify); };

/** The view ids a project address may carry; the machinery lives under 설정, and 결정 became part of 맡긴 일. */
function tabOf(view: string | undefined, fallback: string): string {
  if (view === 'decisions') return 'work';
  if (view === 'settings' || settingsParts.some(part => part.id === view)) return 'settings';
  return ['conversation', 'work', 'documents', 'goals'].includes(view ?? '') ? view! : fallback;
}

/** What a project row says at a glance: who carries it, what runs, what waits on the owner. */
function rowFacts(scope: Scope, state: State | null) {
  if (!state) return { carrier: '', live: 0, waiting: 0 };
  const carrier = state.ghosts.find(ghost => ghost.id === scope.ghostId) ?? state.ghosts.find(ghost => ghost.isDefault);
  const { live, pending } = projectWork(state, scope.id);
  return { carrier: [scope.state === 'paused' && '멈춤', carrier?.name ?? '받을 Ghost 없음'].filter(Boolean).join(' · '), live: live.length, waiting: pending.length };
}

export function ScopesView({ selectedScope, onSelectScope, createRequested, onCreateClosed, navigate, section, onSectionChange }: {
  selectedScope?: string; onSelectScope?(id: string): void; createRequested?: boolean; onCreateClosed?(): void;
  navigate(path: string): void; section?: string; onSectionChange?(section: string): void;
}) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const scopes = state?.scopes ?? [];
  const scope = scopes.find(item => item.id === selectedScope);
  const ghosts = visibleGhosts(state?.ghosts ?? []).filter(ghost => ghost.state === 'active');
  const receiver = scope?.ghostId ? ghosts.find(ghost => ghost.id === scope.ghostId) : ghosts.find(ghost => ghost.isDefault);
  const [creating, setCreating] = useState(Boolean(createRequested));
  const [search, setSearch] = useState(''), [pages, setPages] = useState<PageSummary[]>([]), [total, setTotal] = useState(0);
  const [pagesLoading, setPagesLoading] = useState(false), [listError, setListError] = useState(''), [reload, setReload] = useState(0);
  type DocumentOpening = { scopeId: string; pageId: string | null; trigger: HTMLButtonElement };
  const [open, setOpen] = useState<DocumentOpening>();
  const [handoff, setHandoff] = useState<HTMLButtonElement | null>(null);
  const [discard, setDiscard] = useState<DocumentOpening>();
  const index = useRef<HTMLDivElement>(null);
  const dispatch = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const [toolsHost, setToolsHost] = useState<HTMLDivElement | null>(null);
  const wide = useSyncExternalStore(subscribeWide, () => matchMedia(wideQuery).matches, () => false);
  const now = useNow();
  const active = tabOf(section, receiver ? 'conversation' : 'work');
  const opened = open && open.scopeId === scope?.id ? open : undefined;
  const select = (id: string) => onSelectScope ? onSelectScope(id) : navigate(id ? `/scopes/${encodeURIComponent(id)}` : '/scopes');
  const changeSection = (id: string) => onSectionChange ? onSectionChange(id) : navigate(`/scopes/${encodeURIComponent(scope!.id)}?view=${id}`);
  /** Opening another document over unsaved edits asks first. */
  const openPage = (pageId: string | null, trigger: HTMLButtonElement) => {
    if (!scope || (opened && opened.pageId === pageId)) return;
    const next = { scopeId: scope.id, pageId, trigger };
    if (opened && dirty.current) setDiscard(next);
    else setOpen(next);
  };
  const closeEditor = () => {
    dirty.current = false;
    setOpen(undefined);
    requestAnimationFrame(() => {
      if (opened?.trigger.isConnected) opened.trigger.focus();
      else index.current?.querySelector('input')?.focus();
    });
  };
  useEffect(() => {
    if (active === 'documents' && opened) return;
    dirty.current = false;
    setOpen(undefined);
    setDiscard(undefined);
  }, [active, opened]);
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
    const canHandoff = Boolean(receiver) && scope.state !== 'paused';
    const openHandoff = (event: MouseEvent<HTMLButtonElement>) => {
      if (handoff) dispatch.current?.querySelector('select')?.focus();
      else setHandoff(event.currentTarget);
    };
    const closeHandoff = () => {
      setHandoff(null);
      requestAnimationFrame(() => { if (handoff?.isConnected) handoff.focus(); });
    };
    const tabs = [{ id: 'conversation', label: '대화' }, { id: 'work', label: '맡긴 일', count: projectWork(state, scope.id).pending.length }, { id: 'documents', label: '문서' }, { id: 'goals', label: '목표' }, { id: 'settings', label: '설정' }];
    const editor = opened && <Suspense fallback={<section className="doc-pane" aria-label="문서">
      <div className="doc-pane__bar"><Button variant="ghost" size="sm" onClick={closeEditor}>문서 목록</Button></div>
      <SkeletonText label="편집기를 불러오는 중…" lines={6}/>
    </section>}>
      <PageEditor key={`${scope.id}:${opened.pageId ?? 'new'}`} scopeId={scope.id} pageId={opened.pageId} onClose={closeEditor}
        onSaved={() => setReload(value => value + 1)} onDirtyChange={value => { dirty.current = value; }}/>
    </Suspense>;
    return <div className="project" data-view={active} data-handoff={Boolean(handoff) || undefined}>
      <ProjectBar scope={scope} receiver={receiver ? { id: receiver.id, name: receiver.name, presence: ghostPresence(receiver, state).state } : null}
        folder={scope.paths[0] ?? scope.vaultPath ?? undefined} tabs={tabs} active={active} onTab={changeSection} toolsRef={setToolsHost}
        canHandoff={canHandoff} onHandoff={openHandoff} onManage={() => changeSection('settings')}
        onRename={async name => { await client.send({ type: 'scope.update', scopeId: scope.id, name }); }}/>
      <div className="project__body">
        {handoff && <div ref={dispatch} className="project__page project__dispatch">
          <WorkDispatch ghosts={ghosts} defaultGhostId={receiver?.id ?? ''} hasProjects initialScopeId={scope.id}
            onClose={closeHandoff} onCreated={id => { setHandoff(null); navigate(`/work/${encodeURIComponent(id)}`); }}/>
        </div>}
        {active === 'conversation' && (receiver
          ? <>
            <ProjectPulse state={state} scope={scope} now={now} navigate={navigate} onAll={() => changeSection('work')}/>
            <GhostChat key={`${scope.id}:${receiver.id}`} ghost={receiver} state={state} conversationId={receiver.directConversationId} threadId={null} navigate={navigate}
              initialScopeIds={[scope.id]} projectId={scope.id} toolsHost={toolsHost}/>
          </>
          : <div className="project__page"><div className="calm"><p>받을 Ghost를 정하면 여기서 대화할 수 있습니다.</p><Button variant="outline" size="sm" className="ml-auto" onClick={() => changeSection('settings')}>받을 Ghost 정하기</Button></div></div>)}
        {active === 'work' && <div className="project__page"><ProjectWork state={state} scope={scope} now={now} navigate={navigate} onHandoff={canHandoff ? openHandoff : undefined}/></div>}
        {active === 'documents' && (scope.vaultPath
          ? <div className="project__page project__page--docs" data-split={wide || undefined}>
            <div ref={index} hidden={!wide && Boolean(opened)}>
              <DocumentIndex pages={pages} total={total} search={search} onSearch={setSearch} loading={pagesLoading} error={listError}
                activeId={opened?.pageId ?? null} onOpen={openPage} onCreate={trigger => openPage(null, trigger)}/>
            </div>
            {opened ? editor : wide && <div className="calm doc-pane__empty"><p>문서를 고르면 여기서 읽고 고칩니다</p></div>}
          </div>
          : <div className="project__page"><div className="calm"><p>문서 금고가 지정되지 않았습니다.</p><Button variant="outline" size="sm" className="ml-auto" onClick={() => changeSection('settings')}>금고 경로 설정</Button></div></div>)}
        {active === 'goals' && <div className="project__page"><ScopeGoals state={state} navigate={navigate} scopeId={scope.id}/></div>}
        {active === 'settings' && <div className="project__page"><ProjectSettings scope={scope} part={section ?? 'settings'} onPart={changeSection} navigate={navigate} onDeleted={() => select('')}/></div>}
      </div>
      {discard && <ConfirmDialog title="저장하지 않은 변경" confirmLabel="버리고 열기" onConfirm={() => { dirty.current = false; setOpen(discard); }} onClose={() => setDiscard(undefined)}>
        열려 있는 문서에 저장하지 않은 변경이 있습니다. 버리고 다른 문서를 열까요?
      </ConfirmDialog>}
    </div>;
  }
  const ranked = scopes.map(item => ({ item, ...rowFacts(item, state) })).sort((a, b) => b.waiting - a.waiting || b.live - a.live || b.item.updatedAt - a.item.updatedAt);
  return <Page width="reading"><PageHeader title={routeLabels.scopes} actions={<Button disabled={!state} onClick={() => setCreating(true)}><FolderPlus size={16}/>새 프로젝트</Button>}/>
    {scopes.length ? <div className="projects">{ranked.map(({ item, carrier, live, waiting }) => <Row key={item.id} onClick={() => select(item.id)}>
      <span className="project-row__copy"><span className="project-row__name">{item.name}</span><span className="project-row__path">{carrier}</span></span>
      {live > 0 && <span className="project-row__live tabular">진행 {live}</span>}
      {waiting > 0 && <span className="project-row__owner tabular" aria-label={`확인 필요 ${waiting}건`}>{waiting}</span>}
      <ChevronRight className="project-row__go" aria-hidden="true"/>
    </Row>)}</div> : state && <div className="calm"><FolderPlus size={16}/><p>등록된 프로젝트가 없습니다</p></div>}
  </Page>;
}
