import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, FolderPlus, Plus, Search, Trash2, X } from 'lucide-react';
import { Modal } from '../components/Modal';
import { ConfirmedFailure, documentPreflightMessage } from '../client/errors';
import type { Command, Page, Review, Snapshot } from '../client/types';
import { routeLabels } from '../uiText';
import { GardenMarkdownPreview } from './GardenMarkdownPreview';
import './garden-document-preview.css';
import './spaces.css';

type WorkspaceAction = (command: Command) => Promise<Record<string, unknown>>;

export function SpacesView({ snapshot, selectedSpace, query: read, action, onReview, connected, busy, mode, onSelectFolder, theme }: {
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
  const [form, setForm] = useState<'document' | 'folder'>();
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

  return <div className="page-content space-library">
    <header className="space-heading">
      <div><h1 tabIndex={-1}>{routeLabels.spaces}</h1>
        <p>{mode === 'demo' ? '예시 모드에서는 이 브라우저에 문서를 저장합니다.' : '직접 쓴 문서와 검토를 마친 Ghost 초안을 연결한 폴더에 저장합니다.'}</p>
      </div>
      {canCreate && <button type="button" className="button primary" disabled={!connected || busy} onClick={() => setForm('document')}>
        <Plus size={16}/>새 문서
      </button>}
    </header>

    {reviews.length > 0 && <section className="space-reviews" aria-label="검토할 초안">
      <h2>검토할 초안</h2>
      <ul className="space-document-list">{reviews.map(review => <li key={review.id}>
        <button type="button" className="space-document-row" aria-haspopup="dialog" onClick={() => onReview(review)}>
          <FileText size={18} aria-hidden="true"/>
          <span className="space-document-title">{review.title}</span>
          <small>{snapshot.spaces.find(item => item.id === review.space_id)?.name}</small>
          <ArrowRight size={15} aria-hidden="true"/>
        </button>
      </li>)}</ul>
    </section>}

    <div className="space-list-heading">
      <h2>저장된 문서</h2>
      <div className="space-folder-controls">
        {(snapshot.spaces.length > 1 || (!space && snapshot.spaces.length > 0)) ?
          <select aria-label="문서 폴더" data-document-folder value={spaceId ?? ''} onChange={event => onSelectFolder(event.target.value)}>
            {!space && <option value="" disabled>폴더 선택</option>}
            {snapshot.spaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select> : space && <span className="space-folder-name">{space.name}</span>}
        {space && !space.writable && <span className="space-folder-name">읽기 전용</span>}
        {canConnect && <button type="button" className="button secondary" disabled={!connected || busy} onClick={() => setForm('folder')}>
          <FolderPlus size={15}/>폴더 연결
        </button>}
      </div>
    </div>

    {space && pages.length > 0 && <div className="space-controls">
      <div className="search-field space-search"><Search size={16}/>
        <input ref={searchInput} aria-label="문서 검색" placeholder="문서 검색" value={query} onChange={event => setQuery(event.target.value)}/>
        {query && <button type="button" className="icon-button small" aria-label="검색 지우기"
          onClick={() => { setQuery(''); searchInput.current?.focus(); }}><X size={15}/></button>}
      </div>
      {hasDeleted && <button type="button" className={`filter-button ${showDeleted ? 'selected' : ''}`}
        aria-pressed={showDeleted} onClick={() => setShowDeleted(value => !value)}>
        <Trash2 size={14}/>삭제된 문서 포함
      </button>}
    </div>}

    {!space ? <p className="space-message">{snapshot.spaces.length ? '문서 폴더를 찾을 수 없습니다.' : '연결된 문서 폴더가 없습니다.'}</p>
      : loading ? <p className="space-message" role="status">문서를 불러오는 중…</p>
      : listError ? <div className="space-message"><p className="form-error" role="alert">{listError}</p>
        <button type="button" className="button secondary" onClick={() => setReload(value => value + 1)}>다시 불러오기</button>
      </div> : <>
        {openError && <p className="space-open-error form-error" role="alert">{openError}</p>}
        {opening && <p className="sr-only" role="status">문서를 여는 중…</p>}
        {visiblePages.length > 0 ? <ul className="space-document-list" aria-label="문서 목록" aria-busy={opening}>
          {visiblePages.map(item => {
            const status = item.deleted ? '삭제됨' : item.diagnostic ? '확인 필요' : item.legacy ? '읽기 전용' : '';
            return <li key={item.diagnostic || !item.id ? item.locator : item.id}>
              <button type="button" className="space-document-row" disabled={opening} aria-haspopup="dialog"
                onClick={event => void openPage(item, event.currentTarget)}>
                <FileText size={18} aria-hidden="true"/><span className="space-document-title">{item.title}</span>
                {status && <small>{status}</small>}<ArrowRight size={15} aria-hidden="true"/>
              </button>
            </li>;
          })}
        </ul> : <div className="space-message">
          <p>{search ? '검색 결과가 없습니다.' : pages.length ? '표시할 문서가 없습니다.' : '아직 문서가 없습니다.'}</p>
        </div>}
      </>}

    {form && <DocumentForm kind={form} folder={space} demo={mode === 'demo'} disabled={!connected || busy || (form === 'document' ? !canCreate : !canConnect)}
      action={action} onClose={checkList => { setForm(undefined); if (checkList) setReload(value => value + 1); }} onSaved={result => {
        setForm(undefined);
        if (form === 'folder' && typeof result.id === 'string') onSelectFolder(result.id);
        else { setQuery(''); setReload(value => value + 1); }
      }}/>}

    {page && <Modal title={page.title} className="space-document-reader" onClose={closePage} drawer focusClose>
      <div className="page-reader">
        {page.diagnostic && <p className="inline-error" role="alert">{page.diagnostic}</p>}
        {page.legacy && <p className="space-reader-note">이전 형식 · 읽기 전용</p>}
        {page.preview ? page.profile === 'pdc-markdown/1' ? <GardenMarkdownPreview html={page.preview} title={page.title} theme={theme}/>
          : <iframe title={`${page.title} 미리보기`} sandbox="" referrerPolicy="no-referrer" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">${page.preview}`}/>
          : <pre className="garden-document-source-readonly"><code>{page.body ?? page.source ?? '표시할 본문이 없습니다.'}</code></pre>}
      </div>
    </Modal>}
  </div>;
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
  return <Modal title={editing ? '새 문서' : '문서 폴더 연결'} className={editing ? 'space-document-editor' : undefined}
    onClose={() => { if (!inFlight.current) onClose(Boolean(retry) || checkList); }}>
    <form className="form-stack space-form" onSubmit={async event => {
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
        <p className="space-form-destination">저장 위치 · {folder?.name}</p>
        <label>제목<input name="title" required maxLength={200} readOnly={saving || Boolean(retry) || checkList}/></label>
        <label>본문<textarea name="body" rows={10} readOnly={saving || Boolean(retry) || checkList}/></label>
      </> : <>
        <label>폴더 이름<input name="title" required maxLength={65} readOnly={saving || Boolean(retry) || checkList}/></label>
        <label>호스트의 폴더 경로<input name="path" placeholder="/로 시작하는 절대 경로" required readOnly={saving || Boolean(retry) || checkList}/></label>
        <label className="space-writable"><input type="checkbox" name="writable" checked={writable} onChange={event => setWritable(event.target.checked)}
          disabled={saving || Boolean(retry) || checkList}/>이 폴더에 문서 저장 허용</label>
        {writable && <p className="field-help">해당 경로에 폴더가 없으면 새로 만듭니다.</p>}
      </>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {checkList ? <button type="button" className="button secondary" onClick={() => onClose(true)}>목록 보기</button>
        : <button type="submit" className="button primary" disabled={disabled || saving}>{saving ? '처리 중…' : retry ? '다시 확인' : editing ? '저장' : '연결'}</button>}
    </form>
  </Modal>;
}
