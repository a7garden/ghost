import { lazy, Suspense, useEffect, useState } from 'react';
import { FileText, FolderPlus, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Badge, Button, EmptyState, FormField, GPage, GPageHeader, InlineError, Input, SelectField, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@garden/ui';
import type { PageSummary, Space, SpaceGrant } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { routeLabels } from '../uiText';
import { grantsSummary, isEditableProfile } from './spacePages';
import { Modal } from '../components/Modal';

const PageEditorDrawer = lazy(() => import('./PageEditorDrawer'));

const modeLabel: Record<SpaceGrant['mode'], string> = { read: '읽기', propose: '제안' };
const modeChoices: { value: SpaceGrant['mode']; label: string }[] = [{ value: 'read', label: modeLabel.read }, { value: 'propose', label: modeLabel.propose }];

/** 문서 공간(프로젝트) 관리와 문서 브라우저·편집기. 등록·권한·삭제는 space.*, 문서 저장은 document.save로 보낸다. */
export function SpacesView({ selectedSpace, onSelectSpace, createRequested, onCreateClosed }: {
  selectedSpace?: string;
  onSelectSpace?(id: string): void;
  /** Opens the new project form once, from the sidebar's 새 프로젝트. */
  createRequested?: boolean;
  /** Clears the request from the route so the same entry can open the form again. */
  onCreateClosed?(): void;
}) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const spaces = state?.spaces ?? [];
  const ghosts = state?.ghosts ?? [];
  const space = spaces.find(item => item.id === selectedSpace);
  const ghostName = (id: string) => ghosts.find(ghost => ghost.id === id)?.name ?? '알 수 없는 Ghost';
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState<Space>();
  const [pending, setPending] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [pagesLoading, setPagesLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState<{ pageId: string | null }>();
  useEffect(() => { if (createRequested) setCreating(true); }, [createRequested]);
  useEffect(() => {
    if (!space) { setPages([]); return; }
    let alive = true;
    setPagesLoading(true);
    const timer = setTimeout(() => {
      client.pages(space.id, search.trim() || undefined)
        .then(items => { if (alive) { setPages(items); setListError(''); } })
        .catch(reason => { if (alive) setListError(reason instanceof Error ? reason.message : '문서 목록을 불러오지 못했습니다.'); })
        .finally(() => { if (alive) setPagesLoading(false); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [space?.id, search, reload, client]);
  const run = async (work: () => Promise<unknown>, done: string) => {
    setPending('save'); setError(''); setNotice('');
    try { await work(); setNotice(done); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.'); return false; }
    finally { setPending(''); }
  };
  return <GPage width="reading">
    <GPageHeader title={routeLabels.spaces}
      actions={<Button type="button" disabled={!state} onClick={() => setCreating(true)}><FolderPlus size={16} aria-hidden="true"/>새 프로젝트</Button>}/>
    <div className="grid gap-6">
      <div className="flex min-w-0 flex-col">
        {spaces.map(item => <div className="flex min-w-0 items-center gap-3 border-b border-line py-3.5 last:border-b-0" key={item.id}>
          <button type="button" aria-current={item.id === selectedSpace || undefined} onClick={() => onSelectSpace?.(item.id)}
            className="min-w-0 flex-1 rounded-control px-2 py-1.5 text-left outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3 aria-[current]:bg-hover">
            <span className="block text-ui font-medium text-ink [overflow-wrap:anywhere]">{item.name}</span>
            <span className="block text-caption text-ink-3 [overflow-wrap:anywhere]">{item.path}</span>
            <span className="mt-1 block text-caption text-ink-2">{grantsSummary(item.grants, ghostName)}</span>
          </button>
          <Button variant="ghost" size="icon" type="button" aria-label={`${item.name} 권한 편집`} disabled={pending !== ''} onClick={() => { setError(''); setEditing(true); }}><Pencil size={15}/></Button>
          <Button variant="ghost" size="icon" type="button" aria-label={`${item.name} 프로젝트 삭제`} disabled={pending !== ''} onClick={() => { setError(''); setRemoving(item); }}><Trash2 size={15}/></Button>
        </div>)}
        {state && !spaces.length && <EmptyState title="등록된 프로젝트 없음" description="PDC 문서 보관함(폴더)을 프로젝트로 등록하면 Ghost가 읽거나 제안할 수 있습니다."
          action={<Button type="button" variant="outline" onClick={() => setCreating(true)}><Plus size={15}/>새 프로젝트</Button>}/>}
      </div>
      {space && <section className="grid gap-3 border-t border-line pt-5" aria-label={`${space.name} 권한`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0 text-ui font-semibold text-ink">{space.name} 권한</h2>
          <span className="text-caption text-ink-3 [overflow-wrap:anywhere]">{space.path}</span>
        </div>
        <ul className="m-0 grid list-none gap-2 p-0">
          {space.grants.map(grant => <li className="flex items-center gap-3 text-ui text-ink" key={grant.ghostId}>
            <span className="min-w-0 flex-1 truncate">{ghostName(grant.ghostId)}</span>
            <Badge variant="outline">{modeLabel[grant.mode]}</Badge>
          </li>)}
          {!space.grants.length && <li className="text-caption text-ink-3">Ghost 권한 없음</li>}
        </ul>
        <div><Button variant="outline" type="button" disabled={pending !== ''} onClick={() => { setError(''); setEditing(true); }}><Pencil size={15}/>권한 편집</Button></div>
      </section>}
      {space && <section className="grid gap-3 border-t border-line pt-5" aria-label="저장된 문서">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0 text-ui font-semibold text-ink">저장된 문서</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="문서 검색" placeholder="문서 검색" value={search} maxLength={200} className="w-[220px]"
              onChange={event => setSearch(event.target.value)}/>
            {search && <Button variant="ghost" size="icon" type="button" aria-label="검색 지우기" onClick={() => setSearch('')}><X size={15}/></Button>}
            <Button variant="outline" type="button" onClick={() => { setError(''); setOpen({ pageId: null }); }}><Plus size={15}/>새 문서</Button>
          </div>
        </div>
        {pagesLoading && pages.length > 0 && <p className="m-0 text-caption text-ink-3" role="status">문서를 불러오는 중…</p>}
        {listError && <InlineError>{listError}</InlineError>}
        {!listError && pages.length > 0 && <DocumentList pages={pages} onOpen={pageId => setOpen({ pageId })}/>}
        {!listError && !pagesLoading && !pages.length && <p className="m-0 text-ui text-ink-3">{search ? '검색 결과가 없습니다.' : '아직 문서가 없습니다.'}</p>}
      </section>}
      {error && <InlineError>{error}</InlineError>}
      {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}
    </div>
    {creating && <SpaceForm title="새 프로젝트" ghosts={ghosts} busy={pending !== ''} onClose={() => { setCreating(false); onCreateClosed?.(); }} onSave={async input => {
      const saved = await run(async () => { await client.send({ type: 'space.create', name: input.name, path: input.path, grants: input.grants }); }, '프로젝트를 등록했습니다.');
      if (saved) { setCreating(false); onCreateClosed?.(); }
    }}/>}
    {editing && space && <SpaceForm title={`${space.name} 권한 편집`} ghosts={ghosts} busy={pending !== ''} initial={space} onClose={() => setEditing(false)} onSave={async input => {
      const saved = await run(() => client.send({ type: 'space.update', spaceId: space.id, name: input.name, grants: input.grants }), '권한을 저장했습니다.');
      if (saved) setEditing(false);
    }}/>}
    {removing && <Modal title="프로젝트 삭제" onClose={() => pending === '' && setRemoving(undefined)}>
      <p className="m-0">{removing.name} 프로젝트 등록을 삭제할까요? 보관함의 문서는 지워지지 않습니다.</p>
      {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={pending !== ''} onClick={() => setRemoving(undefined)}>취소</Button>
        <Button variant="destructive" type="button" disabled={pending !== ''} onClick={() => void run(async () => { await client.send({ type: 'space.delete', spaceId: removing.id }); setRemoving(undefined); if (onSelectSpace && removing.id === selectedSpace) onSelectSpace(''); }, '프로젝트를 삭제했습니다.')}>삭제</Button>
      </div>
    </Modal>}
    {open && space && <Suspense fallback={<Modal title={open.pageId ? '문서' : '새 문서'} onClose={() => setOpen(undefined)} drawer focusClose><p className="m-0 text-ui text-ink-2" role="status">편집기를 불러오는 중…</p></Modal>}>
      <PageEditorDrawer spaceId={space.id} pageId={open.pageId} onClose={() => setOpen(undefined)} onSaved={() => setReload(value => value + 1)}/>
    </Suspense>}
  </GPage>;
}

/** The project's saved documents, one row per document. */
export function DocumentList({ pages, onOpen }: {
  pages: PageSummary[];
  onOpen(pageId: string): void;
}) {
  return <Table aria-label="문서 목록">
    <TableHeader>
      <TableRow>
        <TableHead>문서</TableHead>
        <TableHead className="w-32">형식</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {pages.map(item => <TableRow key={item.pageId}>
        <TableCell>
          <button type="button" aria-haspopup="dialog" onClick={() => onOpen(item.pageId)}
            className="flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left hover:bg-hover">
            <FileText size={16} className="shrink-0 text-ink-3" aria-hidden="true"/>
            <span className="min-w-0 flex-1 text-ui font-medium text-ink [overflow-wrap:anywhere]">{item.title}</span>
          </button>
        </TableCell>
        <TableCell className="text-caption text-ink-2">{isEditableProfile(item.profile) ? item.profile : `${item.profile} · 읽기 전용`}</TableCell>
      </TableRow>)}
    </TableBody>
  </Table>;
}

function SpaceForm({ title, ghosts, initial, busy, onClose, onSave }: {
  title: string;
  ghosts: { id: string; name: string }[];
  initial?: Space;
  busy: boolean;
  onClose(): void;
  /** `path` is meaningful only for creation; edits keep the registered path. */
  onSave(input: { name: string; path: string; grants: SpaceGrant[] }): Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [path, setPath] = useState(initial?.path ?? '');
  const [grants, setGrants] = useState<SpaceGrant[]>(initial?.grants.map(grant => ({ ...grant })) ?? []);
  const [grantGhost, setGrantGhost] = useState('');
  const [grantMode, setGrantMode] = useState<SpaceGrant['mode']>('read');
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const locked = busy || saving;
  const addGrant = () => {
    if (!grantGhost) return;
    if (grants.some(grant => grant.ghostId === grantGhost)) { setError('이미 권한이 있는 Ghost입니다.'); return; }
    setGrants(current => [...current, { ghostId: grantGhost, mode: grantMode }]);
    setGrantGhost(''); setError('');
  };
  const save = async () => {
    if (locked) return;
    if (!name.trim()) { setError('프로젝트 이름을 입력해 주세요.'); return; }
    if (!initial && !path.trim().startsWith('/')) { setError('보관함 폴더의 절대 경로를 입력해 주세요.'); return; }
    setSaving(true); setError('');
    try { await onSave({ name: name.trim(), path: initial?.path ?? path.trim(), grants }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '저장하지 못했습니다.'); }
    finally { setSaving(false); }
  };
  const remaining = ghosts.filter(ghost => !grants.some(grant => grant.ghostId === ghost.id));
  return <Modal title={title} onClose={() => !locked && onClose()} className="w-[min(600px,calc(100vw-2rem))] sm:max-w-[600px]">
    <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <FormField label="이름">{control => <Input {...control} value={name} onChange={event => setName(event.target.value)} required maxLength={128} disabled={locked}/>}</FormField>
      {!initial && <FormField label="보관함 폴더 경로" description="이 Mac의 절대 경로. 문서는 원래 위치에 그대로 있습니다.">
        {control => <Input {...control} type="text" value={path} onChange={event => setPath(event.target.value)} required placeholder="/Users/me/Documents/프로젝트" maxLength={4096} disabled={locked} spellCheck={false} autoCapitalize="off"/>}
      </FormField>}
      <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-t border-line pt-4">
        <legend className="mb-1 text-caption font-semibold text-ink">Ghost 권한</legend>
        {grants.map(grant => <div className="flex items-center gap-3" key={grant.ghostId}>
          <span className="min-w-0 flex-1 truncate text-caption text-ink">{ghosts.find(ghost => ghost.id === grant.ghostId)?.name ?? grant.ghostId}</span>
          <SelectField label={`${grant.ghostId} 권한`} className="w-[130px]" value={grant.mode} disabled={locked} aria-label="권한"
            onValueChange={mode => setGrants(current => current.map(item => item.ghostId === grant.ghostId ? { ...item, mode: mode as SpaceGrant['mode'] } : item))}
            options={modeChoices}/>
          <Button variant="ghost" size="icon" type="button" aria-label="권한 삭제" disabled={locked} onClick={() => setGrants(current => current.filter(item => item.ghostId !== grant.ghostId))}><X size={14}/></Button>
        </div>)}
        {!grants.length && <p className="m-0 text-caption text-ink-3">권한이 없으면 Ghost가 이 보관함에 접근할 수 없습니다.</p>}
        <div className="flex items-center gap-2">
          <SelectField label="Ghost 선택" className="min-w-0 flex-1" value={grantGhost || '__none__'} disabled={locked || !remaining.length} onValueChange={setGrantGhost}
            options={[{ value: '__none__', label: 'Ghost 선택' }, ...remaining.map(ghost => ({ value: ghost.id, label: ghost.name }))]} />
          <SelectField label="권한 종류" className="w-[110px] flex-none" value={grantMode} disabled={locked} onValueChange={mode => setGrantMode(mode as SpaceGrant['mode'])} options={modeChoices}/>
          <Button variant="outline" type="button" className="flex-none" disabled={locked || !grantGhost} onClick={addGrant}><Plus size={14}/>추가</Button>
        </div>
      </fieldset>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={locked} onClick={onClose}>취소</Button>
        <Button type="submit" disabled={locked || Boolean(!initial && !path.trim())}>{saving ? '저장 중…' : '저장'}</Button>
      </div>
    </form>
  </Modal>;
}
