import { lazy, Suspense, useEffect, useState } from 'react';
import { ChevronRight, Folder, FolderPlus, MessageCircle, BriefcaseBusiness } from 'lucide-react';
import { Button, InlineError, Page, PageHeader } from '../ui'
import type { PageSummary, Scope } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { routeLabels } from '../uiText';
import { noteScopeEdit, scopeLastEdit } from './scopePages';
import { useNow } from './time';
import { Modal } from '../components/Modal';
import { HandoffComposer } from '../components/HandoffComposer';
import { DocumentIndex } from '../components/projects/DocumentIndex';
import { HoldButton } from '../components/projects/HoldButton';
import { ProjectCreate } from '../components/projects/ProjectCreate';
import { ProjectHeader } from '../components/projects/ProjectHeader';
import './scopes.css';

const PageEditorDrawer = lazy(() => import('./PageEditorDrawer'));

/** 프로젝트(문서 공간): 목록·만들기·대화·문서. */
export function ScopesView({ selectedScope, onSelectScope, createRequested, onCreateClosed, navigate }: {
  selectedScope?: string;
  onSelectScope?(id: string): void;
  /** Opens the creation canvas once, from the sidebar's 새 프로젝트. */
  createRequested?: boolean;
  /** Clears the request from the route so the same entry can open the canvas again. */
  onCreateClosed?(): void;
  navigate(path: string): void;
}) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const scopes = state?.scopes ?? [];
  const ghosts = (state?.ghosts ?? []).filter(ghost => ghost.state === 'active' && ghost.deletedAt === null);
  const space = scopes.find(item => item.id === selectedScope);
  const [creating, setCreating] = useState(false);
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(''), [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [pagesLoading, setPagesLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState<{ pageId: string | null }>();
  const [handoff, setHandoff] = useState(false);
  const now = useNow();
  useEffect(() => { if (createRequested) setCreating(true); }, [createRequested]);
  useEffect(() => {
    if (!space || creating) { if (!space) { setPages([]); setTotal(0); } return; }
    let alive = true;
    setPagesLoading(true);
    const timer = setTimeout(() => {
      client.pages(space.id, search.trim() || undefined)
        .then(items => {
          if (!alive) return;
          setPages(items);
          if (!search.trim()) setTotal(items.length);
          setListError('');
        })
        .catch(reason => { if (alive) setListError(reason instanceof Error ? reason.message : '문서 목록을 불러오지 못했습니다.'); })
        .finally(() => { if (alive) setPagesLoading(false); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [space?.id, search, reload, client, creating]);
  const run = async (work: () => Promise<unknown>) => {
    setPending('save'); setError('');
    try { await work(); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.'); return false; }
    finally { setPending(''); }
  };
  const closeCreate = () => { setCreating(false); onCreateClosed?.(); };

  if (creating) {
    return <Page width="reading">
      <PageHeader title="새 프로젝트"/>
      <ProjectCreate busy={pending !== ''} onClose={closeCreate}
        onCreate={async input => {
          const saved = await client.send<{ scopeId: string }>({ type: 'scope.create', name: input.name, paths: [input.path], vaultPath: input.path });
          setCreating(false);
          if (onSelectScope) onSelectScope(saved.scopeId); else onCreateClosed?.();
        }}/>
    </Page>;
  }

  if (space) {
    const main = ghosts.find(ghost => ghost.isDefault) ?? ghosts[0];
    const remove = async () => {
      const gone: Scope = space;
      if (await run(() => client.send({ type: 'scope.delete', scopeId: gone.id }))) {
        setArmed(false);
        if (onSelectScope && gone.id === selectedScope) onSelectScope('');
      }
    };
    return <Page width="reading">
      <div className="grid gap-10">
        <ProjectHeader space={space} total={total} lastEditAt={scopeLastEdit(space.id)} now={now} disabled={pending !== ''}
          onRename={async name => { await client.send({ type: 'scope.update', scopeId: space.id, name }); }}/>
        <div className="flex flex-wrap gap-2">
          <Button type="button" className="min-h-11" disabled={!main} onClick={() => navigate(`/ghosts/${encodeURIComponent(main!.id)}?scope=${encodeURIComponent(space.id)}`)}>
            <MessageCircle size={16} aria-hidden="true"/>대화하기
          </Button>
          <Button type="button" variant="outline" className="min-h-11" disabled={!main} onClick={() => setHandoff(true)}>
            <BriefcaseBusiness size={16} aria-hidden="true"/>맡기기
          </Button>
        </div>
        {error && <InlineError>{error}</InlineError>}
        <DocumentIndex pages={pages} total={total} search={search} onSearch={setSearch} loading={pagesLoading} error={listError}
          onOpen={pageId => setOpen({ pageId })} onCreate={() => { setError(''); setOpen({ pageId: null }); }}/>
        <section className="place-end" aria-label="프로젝트 삭제">
          {!armed
            ? <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} onClick={() => { setError(''); setArmed(true); }}>프로젝트 삭제</Button>
            : <div className="place-end__strip">
              <p>{space.name} 프로젝트 등록을 지울까요? 보관함의 문서는 지워지지 않습니다.</p>
              <div className="place-end__row">
                <Button variant="outline" size="sm" type="button" disabled={pending !== ''} onClick={() => setArmed(false)}>취소</Button>
                <HoldButton label="삭제" holdingLabel="누르는 중" disabled={pending !== ''} onComplete={() => void remove()}/>
              </div>
            </div>}
        </section>
      </div>
      {handoff && <Modal title="맡기기" onClose={() => setHandoff(false)}>
        <HandoffComposer ghosts={ghosts} navigate={navigate} initialScopeIds={[space.id]} initialMode="work"/>
      </Modal>}
      {open && <Suspense fallback={<Modal title={open.pageId ? '문서' : '새 문서'} onClose={() => setOpen(undefined)} drawer focusClose><p className="m-0 text-ui text-ink-2" role="status">편집기를 불러오는 중…</p></Modal>}>
        <PageEditorDrawer scopeId={space.id} pageId={open.pageId} onClose={() => setOpen(undefined)}
          onSaved={() => { noteScopeEdit(space.id); setReload(value => value + 1); }}/>
      </Suspense>}
    </Page>;
  }

  return <Page width="reading">
    <PageHeader title={routeLabels.scopes}
      actions={<Button type="button" disabled={!state} onClick={() => setCreating(true)}><FolderPlus size={16} aria-hidden="true"/>새 프로젝트</Button>}/>
    {scopes.length
      ? <div className="projects">{scopes.map(item => <button type="button" className="project-row" key={item.id}
        aria-current={item.id === selectedScope || undefined} onClick={() => onSelectScope?.(item.id)}>
        <span className="project-row__glyph" aria-hidden="true"><Folder size={17}/></span>
        <span className="project-row__copy">
          <span className="project-row__name">{item.name}</span>
          <span className="project-row__path">{item.vaultPath ?? item.paths.join(", ")}</span>
        </span>
        <ChevronRight className="project-row__go" aria-hidden="true"/>
      </button>)}</div>
      : state && <div className="calm"><FolderPlus size={16} aria-hidden="true"/><p>등록된 프로젝트가 없습니다</p></div>}
  </Page>;
}
