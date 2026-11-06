import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, FolderPlus, Plus, Search, Trash2, X } from 'lucide-react';
import { Button, Checkbox, EmptyState, FormField, GPage, GPageHeader, InlineError, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from '@garden/ui';
import { Modal } from '../components/Modal';
import { ConfirmedFailure, documentPreflightMessage } from '../client/errors';
import type { Command, Page, Review, Snapshot } from '../client/types';
import { routeLabels } from '../uiText';
import { GardenMarkdownPreview } from './GardenMarkdownPreview';

type WorkspaceAction = (command: Command) => Promise<Record<string, unknown>>;

export function SpacesView({ snapshot, selectedSpace, query: read, action, onReview, connected, busy, mode, onSelectFolder, theme, createRequested = false, onCreateClosed }: {
  snapshot: Snapshot;
  selectedSpace?: string;
  query: (command: Command) => Promise<unknown>;
  action: WorkspaceAction;
  onReview: (review: Review) => void;
  connected: boolean;
  busy: boolean;
  mode: 'live' | 'demo';
  onSelectFolder: (id: string) => void;
  theme: 'light' | 'dark';
  /** Opens the new project (folder) form once, from the sidebar's 새 프로젝트. */
  createRequested?: boolean;
  /** Clears the request from the route so the same entry can open the form again. */
  onCreateClosed?: () => void;
}) {
  const space = snapshot.spaces.find(item => item.id === selectedSpace);
  const spaceId = space?.id;
  const canConnect = mode === 'live' && snapshot.capabilities.documents === true;
  const canCreate = Boolean(space?.writable) && (canConnect || mode === 'demo');
  const reviews = snapshot.reviews.filter(review => review.profile_id && (review.state === 'pending' || review.state === 'approved'));
  const savedReviews = JSON.stringify(snapshot.reviews.filter(review => review.space_id === spaceId && review.state === 'saved').map(review => review.id));
  const [pages, setPages] = useState<Page[]>([]);
  const [page, setPage] = useState<Page | null>(null);
  const [query, setQuery] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [loading, setLoading] = useState(Boolean(space));
  const [opening, setOpening] = useState(false);
  const [listError, setListError] = useState('');
  const [openError, setOpenError] = useState('');
  const [reload, setReload] = useState(0);
  const [form, setForm] = useState<'document' | 'folder' | undefined>(() => createRequested && canConnect ? 'folder' : undefined);
  const opener = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!spaceId) return;
    let alive = true;
    setLoading(true);
    setListError('');
    read({ type: 'workspace', action: { type: 'list_pages', space_id: spaceId, query: '' } })
      .then(data => {
        if (!Array.isArray(data)) throw new Error('문서 목록을 확인하지 못했습니다.');
        if (alive) setPages(data);
      })
      .catch(error => {
        if (alive) setListError(error instanceof Error ? error.message : '문서 목록을 불러오지 못했습니다.');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [spaceId, read, reload, savedReviews]);

  const openPage = async (item: Page, trigger: HTMLButtonElement) => {
    if (!spaceId || opening) return;
    opener.current = trigger;
    setOpenError('');
    setOpening(true);
    const pageId = item.diagnostic ? null : item.id || null;
    try {
      const result = await read({ type: 'workspace', action: {
        type: 'read_page', space_id: spaceId, page_id: pageId, locator: pageId ? null : item.locator,
      } });
      setPage(result as Page);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : '문서를 열지 못했습니다.');
      requestAnimationFrame(() => opener.current?.focus({ preventScroll: true }));
    } finally {
      setOpening(false);
    }
  };

  const closePage = () => {
    setPage(null);
    requestAnimationFrame(() => opener.current?.focus({ preventScroll: true }));
  };

  const search = query.trim().toLowerCase();
  const visiblePages = pages.filter(item => (showDeleted || !item.deleted) && item.title.toLowerCase().includes(search));
  const hasDeleted = pages.some(item => item.deleted);

  return <GPage width="reading">
    <GPageHeader title={space?.name ?? routeLabels.spaces}
      actions={canCreate && <Button type="button" disabled={!connected || busy} onClick={() => setForm('document')}>
        <Plus size={16} aria-hidden="true"/>새 문서
      </Button>}/>

    {reviews.length > 0 && <section className="mb-8 grid gap-2" aria-label="검토할 초안">
      <h2 className="text-ui font-semibold text-ink">검토할 초안</h2>
      <ul className="m-0 grid list-none gap-1 p-0">
        {reviews.map(review => <li key={review.id}>
          <button type="button" aria-haspopup="dialog" onClick={() => onReview(review)}
            className="flex w-full min-w-0 items-center gap-3 rounded-control px-2 py-2 text-left hover:bg-hover">
            <FileText size={18} className="shrink-0 text-ink-3" aria-hidden="true"/>
            <span className="min-w-0 flex-1 text-ui font-medium text-ink [overflow-wrap:anywhere]">{review.title}</span>
            <span className="shrink-0 text-caption text-ink-2">{snapshot.spaces.find(item => item.id === review.space_id)?.name}</span>
            <ArrowRight size={15} className="shrink-0 text-ink-3" aria-hidden="true"/>
          </button>
        </li>)}
      </ul>
    </section>}

    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-ui font-semibold text-ink">저장된 문서</h2>
        <div className="flex flex-wrap items-center gap-2">
          {space && !space.writable && <span className="text-ui text-ink-2">읽기 전용</span>}
          {!space && canConnect && <Button variant="outline" type="button" disabled={!connected || busy} onClick={() => setForm('folder')}>
            <FolderPlus size={15} aria-hidden="true"/>새 프로젝트
          </Button>}
        </div>
      </div>

      {space && pages.length > 0 && <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true"/>
          <Input ref={searchInput} className="pl-8 pr-8" aria-label="문서 검색" placeholder="문서 검색" value={query}
            onChange={event => setQuery(event.target.value)}/>
          {query && <Button variant="ghost" size="icon" type="button" aria-label="검색 지우기"
            className="absolute right-0.5 top-1/2 -translate-y-1/2"
            onClick={() => { setQuery(''); searchInput.current?.focus(); }}><X size={15} aria-hidden="true"/></Button>}
        </div>
        {hasDeleted && <Button variant={showDeleted ? 'secondary' : 'outline'} type="button" aria-pressed={showDeleted}
          onClick={() => setShowDeleted(value => !value)}>
          <Trash2 size={14} aria-hidden="true"/>삭제된 문서 포함
        </Button>}
      </div>}

      {!space ? <EmptyState title={snapshot.spaces.length ? '프로젝트를 찾을 수 없습니다.' : '프로젝트가 없습니다.'}/>
        : loading ? <p role="status" className="text-ui text-ink-2">문서를 불러오는 중…</p>
        : listError ? <InlineError onRetry={() => setReload(value => value + 1)} retryLabel="다시 불러오기">{listError}</InlineError>
        : <>
          {openError && <InlineError>{openError}</InlineError>}
          {opening && <p className="sr-only" role="status">문서를 여는 중…</p>}
          {visiblePages.length > 0 ? <DocumentList pages={visiblePages} opening={opening}
            onOpen={(item, trigger) => void openPage(item, trigger)}/>
          : <EmptyState title={search ? '검색 결과가 없습니다.' : pages.length ? '표시할 문서를 없습니다.' : '아직 문서가 없습니다.'}
            action={canCreate && <Button type="button" disabled={!connected || busy} onClick={() => setForm('document')}>
              <Plus size={16} aria-hidden="true"/>새 문서
            </Button>}/>}
        </>}
    </section>

    {form && <DocumentForm kind={form} folder={space} demo={mode === 'demo'} disabled={!connected || busy || (form === 'document' ? !canCreate : !canConnect)}
      action={action} onClose={checkList => { setForm(undefined); if (checkList) setReload(value => value + 1); if (form === 'folder' && createRequested) onCreateClosed?.(); }} onSaved={result => {
        setForm(undefined);
        if (form === 'folder' && typeof result.id === 'string') onSelectFolder(result.id);
        else { setQuery(''); setReload(value => value + 1); }
      }}/>}

    {page && <Modal title={page.title} onClose={closePage} drawer focusClose className="sm:max-w-[760px]">
      <div className="grid gap-3">
        {page.diagnostic && <InlineError>{page.diagnostic}</InlineError>}
        {page.legacy && <p className="text-caption text-ink-2">이전 형식 · 읽기 전용</p>}
        {page.preview ? page.profile === 'pdc-markdown/1' ? <GardenMarkdownPreview html={page.preview} title={page.title} theme={theme}/>
          : <iframe title={`${page.title} 미리보기`} sandbox="" referrerPolicy="no-referrer" className="min-h-[65dvh] w-full rounded-control bg-surface"
            srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">${page.preview}`}/>
          : <pre className="max-h-[65dvh] max-w-full overflow-auto rounded-control border border-line bg-inset p-3 font-mono text-caption text-ink-2 [overflow-wrap:anywhere] [white-space:pre-wrap]"><code>{page.body ?? page.source ?? '표시할 본문이 없습니다.'}</code></pre>}
      </div>
    </Modal>}
  </GPage>;
}

/** The project's saved documents, one row per document. */
export function DocumentList({ pages, opening, onOpen }: {
  pages: Page[];
  opening: boolean;
  onOpen: (item: Page, trigger: HTMLButtonElement) => void;
}) {
  return <Table aria-label="문서 목록" aria-busy={opening}>
    <TableHeader>
      <TableRow>
        <TableHead>문서</TableHead>
        <TableHead className="w-32">상태</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {pages.map(item => {
        const status = item.deleted ? '삭제됨' : item.diagnostic ? '확인 필요' : item.legacy ? '읽기 전용' : '';
        return <TableRow key={item.diagnostic || !item.id ? item.locator : item.id}>
          <TableCell>
            <button type="button" disabled={opening} aria-haspopup="dialog"
              onClick={event => onOpen(item, event.currentTarget)}
              className="flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left hover:bg-hover disabled:opacity-50">
              <FileText size={16} className="shrink-0 text-ink-3" aria-hidden="true"/>
              <span className="min-w-0 flex-1 text-ui font-medium text-ink [overflow-wrap:anywhere]">{item.title}</span>
              <ArrowRight size={14} className="shrink-0 text-ink-3" aria-hidden="true"/>
            </button>
          </TableCell>
          <TableCell className="text-caption text-ink-2">{status}</TableCell>
        </TableRow>;
      })}
    </TableBody>
  </Table>;
}

function DocumentForm({ kind, folder, demo, disabled, action, onClose, onSaved }: {
  kind: 'document' | 'folder'; folder?: Snapshot['spaces'][number]; demo: boolean; disabled: boolean;
  action: WorkspaceAction; onClose(checkList: boolean): void; onSaved(result: Record<string, unknown>): void;
}) {
  const editing = kind === 'document';
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState<Command>();
  const [checkList, setCheckList] = useState(false);
  const [writable, setWritable] = useState(false);
  const [error, setError] = useState('');
  const locked = saving || Boolean(retry) || checkList;
  return <Modal title={editing ? '새 문서' : '새 프로젝트'}
    onClose={() => { if (!inFlight.current) onClose(Boolean(retry) || checkList); }}>
    <form className="grid gap-4" onSubmit={async event => {
      event.preventDefault();
      if (disabled || checkList || inFlight.current || (editing && !folder?.writable)) return;
      const values = new FormData(event.currentTarget);
      const title = String(values.get('title') ?? '').trim();
      const body = String(values.get('body') ?? '');
      const path = String(values.get('path') ?? '').trim();
      if (!retry && (!title || (!editing && !path.startsWith('/')))) {
        setError(editing ? '문서 제목을 입력해 주세요.' : '폴더 이름과 절대 경로를 입력해 주세요.');
        return;
      }
      const command: Command = retry ?? { type: 'workspace', action: editing && folder
        ? { type: 'save_page', space_id: folder.id, page_id: null, expected_hash: null, title, body, profile: 'pdc-markdown/1' }
        : { type: 'create_space', name: title, path, writable: values.has('writable'), profiles: [] } };
      const encoder = new TextEncoder();
      if (!retry && (encoder.encode(body).byteLength > 524288 || encoder.encode(JSON.stringify(command)).byteLength > 1_047_552)) {
        setError('저장할 내용이 너무 큽니다.');
        return;
      }
      inFlight.current = true;
      setSaving(true);
      setError('');
      try {
        const result = await action(command);
        onSaved(result);
      } catch (error) {
        if (error instanceof ConfirmedFailure) {
          const message = demo ? error.message : documentPreflightMessage(editing ? 'save_page' : 'create_space', error.message);
          setRetry(undefined);
          setCheckList(!message);
          setError(message ?? '처리 결과를 확인할 수 없습니다. 목록에서 결과를 먼저 확인해 주세요.');
        } else {
          setRetry(command);
          setError('처리 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인할 수 있습니다.');
        }
      } finally {
        inFlight.current = false;
        setSaving(false);
      }
    }}>
      {editing ? <>
        <p className="text-ui text-ink-2">저장 위치 · {folder?.name}</p>
        <FormField label="제목" required>
          {control => <Input name="title" required maxLength={200} readOnly={locked} {...control}/>}
        </FormField>
        <FormField label="본문">
          {control => <Textarea name="body" rows={10} readOnly={locked} className="min-h-[220px]" {...control}/>}
        </FormField>
      </> : <>
        <FormField label="이름" required>
          {control => <Input name="title" required maxLength={65} readOnly={locked} {...control}/>}
        </FormField>
        <FormField label="폴더" required>
          {control => <Input name="path" placeholder="/로 시작하는 호스트의 절대 경로" required readOnly={locked} {...control}/>}
        </FormField>
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <Checkbox id="document-writable" name="writable" checked={writable} disabled={locked}
              aria-labelledby="document-writable-label"
              onCheckedChange={value => setWritable(value === true)}/>
            <label id="document-writable-label" htmlFor="document-writable" className="text-ui text-ink">문서 저장 허용</label>
          </div>
          {writable && <p className="text-caption text-ink-2">해당 경로에 폴더가 없으면 새로 만듭니다.</p>}
        </div>
      </>}
      {error && <InlineError>{error}</InlineError>}
      {checkList ? <Button variant="outline" type="button" className="justify-self-end" onClick={() => onClose(true)}>목록 보기</Button>
        : <Button type="submit" className="justify-self-end" disabled={disabled || saving}>{saving ? '처리 중…' : retry ? '다시 확인' : editing ? '저장' : '만들기'}</Button>}
    </form>
  </Modal>;
}
