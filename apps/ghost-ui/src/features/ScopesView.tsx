import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { FolderPlus } from 'lucide-react';
import { Button, Page, PageHeader, SkeletonText } from '../ui';
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
import { StateGlyph, workGlyph } from '../components/agent';
import { ScopeEditor } from './ScopeEditor';
import { GhostChat } from './GhostChat';
import { ScopeGoals } from './goals/Goals';
import { ProjectSettings, settingsParts } from './ProjectSettings';
import { projectWork } from './scopeState';
import './scopes.css';
import './Project.css';

const PageEditor = lazy(() => import('./PageEditor'));

/** The editor takes the index's place until both can fit side by side. */
const wideQuery = '(min-width: 56rem)';
const documentSnapshot = () => matchMedia(wideQuery).matches;
const serverDocumentSnapshot = () => false;
const subscribeWide = (notify: () => void) => { const media = matchMedia(wideQuery); media.addEventListener('change', notify); return () => media.removeEventListener('change', notify); };

/** The view ids a project address may carry; the machinery lives under 설정, and 결정 became part of 맡긴 일. */
function tabOf(view: string | undefined, fallback: string): string {
  if (view === 'decisions') return 'work';
  if (view === 'settings' || settingsParts.some(part => part.id === view)) return 'settings';
  return ['conversation', 'work', 'documents', 'goals'].includes(view ?? '') ? view! : fallback;
}

/** What a project row says at a glance: who carries it, what runs, what waits on the owner. */
function rowFacts(scope: Scope, state: State | null) {
  const carrier = state?.ghosts.find(ghost => ghost.id === scope.ghostId) ?? state?.ghosts.find(ghost => ghost.isDefault);
  const { live, pending } = state ? projectWork(state, scope.id) : { live: [], pending: [] };
  const glyph = pending.length ? 'attention' : scope.state === 'paused' ? 'waiting' : workGlyph(live[0]?.state ?? 'queued', false);
  return { carrier: [carrier?.name ?? '받을 Ghost 없음', scope.state === 'paused' && '멈춤'].filter(Boolean).join(' · '), live: live.length, waiting: pending.length, glyph } as const;
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
  const [search, setSearch] = useState(''), [pages, setPages] = useState<PageSummary[]>([]);
  const [pagesLoading, setPagesLoading] = useState(true), [listError, setListError] = useState(''), [reload, setReload] = useState(0);
  type DocumentOpening = { scopeId: string; pageId: string | null; trigger: HTMLButtonElement; key: number };
  const [open, setOpen] = useState<DocumentOpening>();
  const [defaultPage, setDefaultPage] = useState<{ vaultPath: string; id?: string }>();
  const [savedPageId, setSavedPageId] = useState<string>();
  const [autoDirty, setAutoDirty] = useState(false);
  const [indexOnly, setIndexOnly] = useState(false);
  const [handoff, setHandoff] = useState<HTMLButtonElement | null>(null);
  const [discard, setDiscard] = useState<DocumentOpening>();
  const index = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const restoreIndex = useRef<{ trigger?: HTMLButtonElement; scrollTop?: number } | undefined>(undefined);
  const indexScroll = useRef(0);
  const documentKey = useRef(0);
  const dispatch = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const [toolsHost, setToolsHost] = useState<HTMLDivElement | null>(null);
  const wide = useSyncExternalStore(subscribeWide, documentSnapshot, serverDocumentSnapshot);
  const now = useNow();
  const active = tabOf(section, receiver ? 'conversation' : 'work');
  const opened = open && open.scopeId === scope?.id ? open : undefined;
  const automaticId = (wide && !indexOnly || autoDirty) && !opened && defaultPage?.vaultPath === scope?.vaultPath ? defaultPage?.id : undefined;
  const editorPageId = opened ? opened.pageId : automaticId;
  const activePageId = editorPageId ?? savedPageId ?? null;
  const documentDetail = active === 'documents' && !wide && editorPageId !== undefined;
  const select = (id: string) => onSelectScope ? onSelectScope(id) : navigate(id ? `/scopes/${encodeURIComponent(id)}` : '/scopes');
  const changeSection = (id: string) => onSectionChange ? onSectionChange(id) : navigate(`/scopes/${encodeURIComponent(scope!.id)}?view=${id}`);
  const applyOpening = (next: DocumentOpening) => {
    if (next.pageId !== null && scope?.vaultPath) setDefaultPage({ vaultPath: scope.vaultPath, id: next.pageId });
    dirty.current = false;
    setAutoDirty(false);
    setSavedPageId(undefined);
    setOpen(next);
  };
  const openPage = (pageId: string | null, trigger: HTMLButtonElement) => {
    if (!scope) return;
    if (editorPageId !== undefined && activePageId === pageId) {
      body.current?.querySelector<HTMLElement>('.doc-pane[tabindex]')?.focus({ preventScroll: true });
      return;
    }
    if (editorPageId === undefined) indexScroll.current = body.current?.scrollTop ?? 0;
    const next = { scopeId: scope.id, pageId, trigger, key: ++documentKey.current };
    if (editorPageId !== undefined && dirty.current) setDiscard(next);
    else applyOpening(next);
  };
  const closeEditor = () => {
    dirty.current = false;
    restoreIndex.current = { trigger: opened?.trigger, scrollTop: wide ? undefined : indexScroll.current };
    if (wide) setIndexOnly(true);
    setAutoDirty(false);
    setSavedPageId(undefined);
    setOpen(undefined);
  };
  useLayoutEffect(() => {
    if (documentDetail && body.current) body.current.scrollTop = 0;
    const restore = restoreIndex.current;
    if (!documentDetail && restore) {
      restoreIndex.current = undefined;
      if (body.current && restore.scrollTop !== undefined) body.current.scrollTop = restore.scrollTop;
      const { trigger } = restore;
      const target = trigger?.isConnected ? trigger : index.current?.querySelector<HTMLElement>('input, button');
      target?.focus({ preventScroll: true });
    }
  }, [documentDetail, editorPageId]);
  useEffect(() => {
    if (active === 'documents' && scope?.vaultPath) return;
    dirty.current = false;
    setAutoDirty(false);
    setSavedPageId(undefined);
    setOpen(undefined);
    setDiscard(undefined);
    setIndexOnly(false);
  }, [active, scope?.vaultPath]);
  useEffect(() => { if (createRequested) setCreating(true); }, [createRequested]);
  useEffect(() => {
    setListError('');
    const vaultPath = scope?.vaultPath;
    if (!scope || !vaultPath || creating || active !== 'documents') {
      setPages([]); setPagesLoading(true);
      return;
    }
    let alive = true;
    setPagesLoading(true);
    const query = search.trim();
    const timer = setTimeout(() => {
      client.pages(scope.id, query || undefined).then(items => {
        if (!alive) return;
        setPages(items);
        if (!query) setDefaultPage(previous => {
          const last = previous?.vaultPath === vaultPath ? previous.id : undefined;
          return { vaultPath, id: items.find(item => item.pageId === last)?.pageId ?? items[0]?.pageId };
        });
      }).catch(reason => { if (alive) setListError(reason instanceof Error ? reason.message : '문서 목록을 불러오지 못했습니다.'); })
        .finally(() => { if (alive) setPagesLoading(false); });
    }, query ? 250 : 0);
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
    const tabs = [{ id: 'conversation', label: '대화' }, { id: 'work', label: '맡긴 일', count: projectWork(state, scope.id).pending.length }, { id: 'documents', label: '문서' }, { id: 'goals', label: '목표' }];
    const editor = editorPageId !== undefined && <Suspense fallback={<section className="doc-pane" aria-label="문서">
      <div className="doc-pane__bar"><Button variant="ghost" size="sm" onClick={closeEditor}>문서 목록</Button></div>
      <SkeletonText label="편집기를 불러오는 중…" lines={6}/>
    </section>}>
      <PageEditor key={`${scope.id}:${editorPageId ?? 'new'}:${opened?.key ?? 0}`} scopeId={scope.id} pageId={editorPageId} onClose={closeEditor}
        autoFocus={Boolean(opened)}
        onSaved={id => {
          if (scope.vaultPath) setDefaultPage({ vaultPath: scope.vaultPath, id });
          if (editorPageId === null) setSavedPageId(id);
          setReload(value => value + 1);
        }}
        onDirtyChange={value => { dirty.current = value; if (!opened) setAutoDirty(value); }}/>
    </Suspense>;
    return <div className="project" data-view={active} data-handoff={Boolean(handoff) || undefined} data-doc-detail={documentDetail || undefined}>
      <ProjectBar scope={scope} receiver={receiver ? { id: receiver.id, name: receiver.name, presence: ghostPresence(receiver, state).state } : null}
        folder={scope.paths[0] ?? scope.vaultPath ?? undefined} tabs={tabs} active={active} onTab={changeSection} toolsRef={setToolsHost}
        canHandoff={canHandoff} onHandoff={openHandoff} onManage={() => changeSection('settings')} onOpenGhost={id => navigate(`/ghosts/${encodeURIComponent(id)}`)}
        onRename={async name => { await client.send({ type: 'scope.update', scopeId: scope.id, name }); }}/>
      <div className="project__body" ref={body}>
        {handoff && <div ref={dispatch} className="project__page project__dispatch">
          <WorkDispatch ghosts={ghosts} defaultGhostId={receiver?.id ?? ''} hasProjects initialScopeId={scope.id}
            onClose={closeHandoff} onCreated={id => { setHandoff(null); navigate(`/work/${encodeURIComponent(id)}`); }}/>
        </div>}
        {active === 'conversation' && (receiver
          ? <>
            <ProjectPulse state={state} scope={scope} now={now} navigate={navigate}/>
            <GhostChat key={`${scope.id}:${receiver.id}`} ghost={receiver} state={state} conversationId={receiver.directConversationId} threadId={null} navigate={navigate}
              initialScopeIds={[scope.id]} projectId={scope.id} toolsHost={toolsHost}/>
          </>
          : <div className="project__page"><p className="project-empty">받을 Ghost가 정해지지 않았습니다.</p></div>)}
        {active === 'work' && <div className="project__page"><ProjectWork state={state} scope={scope} now={now} navigate={navigate}/></div>}
        {active === 'documents' && (scope.vaultPath
          ? <div className="project__page project__page--docs" data-split={wide && editorPageId !== undefined || undefined}>
            <div ref={index} hidden={documentDetail}>
              <DocumentIndex pages={pages} search={search} onSearch={setSearch} loading={pagesLoading} error={listError}
                activeId={activePageId} onOpen={openPage} onCreate={trigger => openPage(null, trigger)}/>
            </div>
            {editor}
          </div>
          : <div className="project__page"><div className="project-empty project-empty--action"><p>문서 금고가 지정되지 않았습니다.</p><Button variant="outline" size="sm" onClick={() => changeSection('settings')}>금고 경로 설정</Button></div></div>)}
        {active === 'goals' && <div className="project__page"><ScopeGoals state={state} navigate={navigate} scopeId={scope.id}/></div>}
        {active === 'settings' && <div className="project__page"><ProjectSettings scope={scope} part={section ?? 'settings'} onPart={changeSection} navigate={navigate} onDeleted={() => select('')}/></div>}
      </div>
      {discard && <ConfirmDialog title="저장하지 않은 변경" confirmLabel="버리고 열기" onConfirm={() => applyOpening(discard)} onClose={() => setDiscard(undefined)}>
        열려 있는 문서에 저장하지 않은 변경이 있습니다. 버리고 다른 문서를 열까요?
      </ConfirmDialog>}
    </div>;
  }
  const ranked = scopes.map(item => ({ item, ...rowFacts(item, state) })).sort((a, b) => b.waiting - a.waiting || b.live - a.live || b.item.updatedAt - a.item.updatedAt);
  return <Page width="reading"><PageHeader title={routeLabels.scopes} actions={<Button disabled={!state} onClick={() => setCreating(true)}><FolderPlus size={16}/>새 프로젝트</Button>}/>
    {scopes.length ? <ul className="project-list">{ranked.map(({ item, carrier, live, waiting, glyph }) => <li key={item.id}>
      <button type="button" className="project-item" onClick={() => select(item.id)}>
        <span className="project-item__mark" aria-hidden="true"><StateGlyph state={glyph}/></span>
        <span className="project-item__copy"><span className="project-item__title">{item.name}</span><span className="project-item__meta">{carrier}</span></span>
        <span className="project-item__value">{[waiting > 0 && `확인 필요 ${waiting}`, live > 0 && `진행 ${live}`].filter(Boolean).join(' · ')}</span>
      </button>
    </li>)}</ul> : state && <p className="project-empty">등록된 프로젝트가 없습니다.</p>}
  </Page>;
}
