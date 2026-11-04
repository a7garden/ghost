import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, Folder, Search, Trash2, X } from 'lucide-react';
import { Modal } from '../components/Modal';
import type { Command, Page, Snapshot } from '../client/types';
import { GardenMarkdownPreview } from './GardenMarkdownPreview';
import './garden-document-preview.css';
import './spaces.css';

export function SpacesView({ snapshot, selectedSpace, action, navigate, theme }: {
  snapshot: Snapshot;
  selectedSpace?: string;
  action: (command: Command) => Promise<Record<string, any>>;
  navigate: (path: string) => void;
  theme: 'light' | 'dark';
}) {
  const space = snapshot.spaces.find(item => item.id === selectedSpace);
  const spaceId = space?.id;
  const [pages, setPages] = useState<Page[]>([]);
  const [page, setPage] = useState<Page | null>(null);
  const [query, setQuery] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [loading, setLoading] = useState(Boolean(space));
  const [opening, setOpening] = useState(false);
  const [listError, setListError] = useState('');
  const [openError, setOpenError] = useState('');
  const [reload, setReload] = useState(0);
  const opener = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!spaceId) return;
    let alive = true;
    setLoading(true);
    setListError('');
    action({ type: 'workspace', action: { type: 'list_pages', space_id: spaceId, query: '' } })
      .then(data => {
        if (!Array.isArray(data)) throw new Error('문서 목록을 확인하지 못했습니다.');
        if (alive) setPages(data);
      })
      .catch(error => {
        if (alive) setListError(error instanceof Error ? error.message : '문서 목록을 불러오지 못했습니다.');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [spaceId, action, reload]);

  const openPage = async (item: Page, trigger: HTMLButtonElement) => {
    if (!spaceId || opening) return;
    opener.current = trigger;
    setOpenError('');
    setOpening(true);
    const pageId = item.diagnostic ? null : item.id || null;
    try {
      const result = await action({ type: 'workspace', action: {
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
    <header className="space-heading"><h1>{space?.name ?? '문서 공간'}</h1></header>

    {(snapshot.spaces.length > 1 || (!space && snapshot.spaces.length > 0)) && <nav className="space-switcher" aria-label="공간 선택">
      {snapshot.spaces.map(item => <button type="button" key={item.id} className={`filter-button ${item.id === spaceId ? 'selected' : ''}`}
        aria-current={item.id === spaceId ? 'page' : undefined} onClick={() => navigate(`/spaces/${item.id}`)}>
        <Folder size={14}/><span>{item.name}</span>
      </button>)}
    </nav>}

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

    {!space ? <p className="space-message">{snapshot.spaces.length ? '문서 공간을 찾을 수 없습니다.' : '연결된 문서 공간이 없습니다.'}</p>
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
          {!pages.length && space.writable && space.profiles.length > 0 && <p className="muted">Ghost가 작성한 문서를 검토하고 저장하면 여기에 표시됩니다.</p>}
        </div>}
      </>}

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
