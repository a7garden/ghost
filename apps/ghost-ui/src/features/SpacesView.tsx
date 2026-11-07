import { lazy, Suspense, useEffect, useState } from 'react';
import { ChevronRight, Folder, FolderPlus } from 'lucide-react';
import { Button, InlineError, Page, PageHeader } from '../ui'
import type { PageSummary, Space } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { routeLabels } from '../uiText';
import { toneFor } from './ghostState';
import { DotAvatar } from '../components/DotAvatar';
import { defaultSpaceGrants, noteSpaceEdit, spaceLastEdit } from './spacePages';
import { useNow } from './time';
import { Modal } from '../components/Modal';
import { AccessRow, type AccessGhost } from '../components/projects/AccessRow';
import { DocumentIndex } from '../components/projects/DocumentIndex';
import { HoldButton } from '../components/projects/HoldButton';
import { ProjectCreate } from '../components/projects/ProjectCreate';
import { ProjectHeader } from '../components/projects/ProjectHeader';
import './spaces.css';

const PageEditorDrawer = lazy(() => import('./PageEditorDrawer'));

/** 프로젝트(문서 공간): 목록·만들기·프로젝트 화면. 등록·권한·삭제는 space.*, 문서 저장은 document.save로 보낸다. */
export function SpacesView({ selectedSpace, onSelectSpace, createRequested, onCreateClosed }: {
  selectedSpace?: string;
  onSelectSpace?(id: string): void;
  /** Opens the creation canvas once, from the sidebar's 새 프로젝트. */
  createRequested?: boolean;
  /** Clears the request from the route so the same entry can open the canvas again. */
  onCreateClosed?(): void;
}) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const spaces = state?.spaces ?? [];
  const ghosts = state?.ghosts ?? [];
  const space = spaces.find(item => item.id === selectedSpace);
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
    const roster = [...ghosts].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
      .map(ghost => ({ id: ghost.id, name: ghost.name }));
    return <Page width="reading">
      <PageHeader title="새 프로젝트"/>
      <ProjectCreate ghosts={roster} busy={pending !== ''} defaultGrants={defaultSpaceGrants(ghosts)} onClose={closeCreate}
        onCreate={async input => {
          const saved = await client.send<{ spaceId: string }>({ type: 'space.create', name: input.name, path: input.path, grants: input.grants });
          setCreating(false);
          if (onSelectSpace) onSelectSpace(saved.spaceId); else onCreateClosed?.();
        }}/>
    </Page>;
  }

  if (space) {
    /** Grants may point at Ghosts missing from the roster; keep them toggleable. */
    const accessGhosts: AccessGhost[] = [
      ...ghosts.map(ghost => ({ id: ghost.id, name: ghost.name })),
      ...space.grants.filter(grant => !ghosts.some(ghost => ghost.id === grant.ghostId))
        .map(grant => ({ id: grant.ghostId, name: '알 수 없는 Ghost' })),
    ];
    const remove = async () => {
      const gone: Space = space;
      if (await run(() => client.send({ type: 'space.delete', spaceId: gone.id }))) {
        setArmed(false);
        if (onSelectSpace && gone.id === selectedSpace) onSelectSpace('');
      }
    };
    return <Page width="reading">
      <div className="grid gap-10">
        <ProjectHeader space={space} total={total} lastEditAt={spaceLastEdit(space.id)} now={now} disabled={pending !== ''}
          onRename={async name => { await client.send({ type: 'space.update', spaceId: space.id, name }); }}/>
        <section className="grid gap-3" aria-label="Ghost 접근">
          <h2 className="section-title">Ghost 접근</h2>
          <AccessRow ghosts={accessGhosts} grants={space.grants} disabled={pending !== ''}
            onChange={grants => void run(() => client.send({ type: 'space.update', spaceId: space.id, grants }))}/>
          {error && <InlineError>{error}</InlineError>}
        </section>
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
      {open && <Suspense fallback={<Modal title={open.pageId ? '문서' : '새 문서'} onClose={() => setOpen(undefined)} drawer focusClose><p className="m-0 text-ui text-ink-2" role="status">편집기를 불러오는 중…</p></Modal>}>
        <PageEditorDrawer spaceId={space.id} pageId={open.pageId} onClose={() => setOpen(undefined)}
          onSaved={() => { noteSpaceEdit(space.id); setReload(value => value + 1); }}/>
      </Suspense>}
    </Page>;
  }

  return <Page width="reading">
    <PageHeader title={routeLabels.spaces}
      actions={<Button type="button" disabled={!state} onClick={() => setCreating(true)}><FolderPlus size={16} aria-hidden="true"/>새 프로젝트</Button>}/>
    {spaces.length
      ? <div className="projects">{spaces.map(item => <button type="button" className="project-row" key={item.id}
        aria-current={item.id === selectedSpace || undefined} onClick={() => onSelectSpace?.(item.id)}>
        <span className="project-row__glyph" aria-hidden="true"><Folder size={17}/></span>
        <span className="project-row__copy">
          <span className="project-row__name">{item.name}</span>
          <span className="project-row__path">{item.path}</span>
        </span>
        <span className="project-row__stack">
          {item.grants.map(grant => <DotAvatar key={grant.ghostId} profileId={grant.ghostId} tone={toneFor(grant.ghostId)} size={20}/>)}
        </span>
        <ChevronRight className="project-row__go" aria-hidden="true"/>
      </button>)}</div>
      : state && <div className="calm"><FolderPlus size={16} aria-hidden="true"/><p>등록된 프로젝트가 없습니다</p></div>}
  </Page>;
}
