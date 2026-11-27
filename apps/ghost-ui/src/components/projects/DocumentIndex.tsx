import { FileText, Search, X } from 'lucide-react';
import { Button, InlineError, SkeletonRows } from '../../ui';
import { isEditableProfile } from '../../features/scopePages';
import type { PageSummary } from '@ghost/contract';

/** Saved document titles; format belongs to the reading pane, not the index. */
export function DocumentIndex({ pages, search, onSearch, loading, error, onOpen, onCreate, activeId }: {
  pages: PageSummary[];
  search: string;
  onSearch(value: string): void;
  loading: boolean;
  error?: string;
  onOpen(pageId: string, trigger: HTMLButtonElement): void;
  onCreate(trigger: HTMLButtonElement): void;
  /** The open document, when a saved page is selected. */
  activeId: string | null;
}) {
  const query = search.trim();
  const empty = !loading && !error && pages.length === 0 && !query;
  return <section className="doc" aria-label="저장된 문서">
    <div className="doc__head">
      {empty && <p className="project-empty" role="status">아직 문서가 없습니다.</p>}
      <div className="doc__tools">
        {!empty && <span className="doc__search">
          <Search aria-hidden="true"/>
          <input type="text" aria-label="문서 검색" placeholder="문서 검색" value={search} maxLength={200}
            onChange={event => onSearch(event.target.value)}/>
          {search && <button type="button" className="doc__clear" aria-label="검색 지우기" onClick={() => onSearch('')}>
            <X aria-hidden="true"/>
          </button>}
        </span>}
        <Button variant="add" size="sm" type="button" onClick={event => onCreate(event.currentTarget)}>새 문서</Button>
      </div>
    </div>
    {loading && pages.length === 0 && !error && <SkeletonRows label="문서를 불러오는 중…" rows={3} className="p-3"/>}
    {error && <InlineError>{error}</InlineError>}
    {!error && pages.length > 0 && <ol className="project-list doc__index" aria-busy={loading || undefined}>
      {pages.map(item => {
        const legacy = !isEditableProfile(item.profile);
        return <li key={item.pageId}>
          <button type="button" className="project-item doc__row" aria-current={item.pageId === activeId ? 'true' : undefined}
            aria-label={legacy ? `${item.title}, 읽기 전용` : item.title}
            onClick={event => onOpen(item.pageId, event.currentTarget)}>
            <FileText size={15} className="project-item__mark" aria-hidden="true"/>
            <span className="project-item__title">{item.title}</span>
          </button>
        </li>;
      })}
    </ol>}
    {!error && pages.length === 0 && !loading && query && <p className="project-empty" role="status">검색 결과가 없습니다.</p>}
  </section>;
}
