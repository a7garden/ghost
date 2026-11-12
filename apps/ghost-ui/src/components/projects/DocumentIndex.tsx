import { Search, X } from 'lucide-react';
import { Button, InlineError } from '../../ui';
import { isEditableProfile } from '../../features/scopePages';
import type { PageSummary } from '@ghost/contract';

/**
 * The project's saved documents as a calm index: hairline rows in a quiet
 * card, the format profile as a mono mark on the right, search on top.
 */
export function DocumentIndex({ pages, total, search, onSearch, loading, error, onOpen, onCreate }: {
  pages: PageSummary[];
  /** Document count before filtering. */
  total: number;
  search: string;
  onSearch(value: string): void;
  loading: boolean;
  error?: string;
  onOpen(pageId: string): void;
  onCreate(): void;
}) {
  const query = search.trim();
  return <section className="doc" aria-label="저장된 문서">
    <div className="doc__head">
      <h2 className="section-title">문서 <span className="count tabular">{total}</span></h2>
      <div className="doc__tools">
        <span className="doc__search">
          <Search aria-hidden="true"/>
          <input type="text" aria-label="문서 검색" placeholder="문서 검색" value={search} maxLength={200}
            onChange={event => onSearch(event.target.value)}/>
          {search && <button type="button" className="doc__clear" aria-label="검색 지우기" onClick={() => onSearch('')}>
            <X aria-hidden="true"/>
          </button>}
        </span>
        <Button variant="outline" size="sm" type="button" onClick={onCreate}>새 문서</Button>
      </div>
    </div>
    {loading && pages.length > 0 && <p className="doc__status" role="status">문서를 불러오는 중…</p>}
    {error && <InlineError>{error}</InlineError>}
    {!error && pages.length > 0 && <ol className="doc__index">
      {pages.map(item => {
        const legacy = !isEditableProfile(item.profile);
        return <li key={item.pageId}>
          <button type="button" className="doc__row" aria-haspopup="dialog"
            aria-label={`${item.title}, ${item.profile}${legacy ? ', 읽기 전용' : ''}`}
            onClick={() => onOpen(item.pageId)}>
            <span className="doc__title">{item.title}</span>
            <span className="doc__profile" data-legacy={legacy || undefined}>{item.profile}</span>
          </button>
        </li>;
      })}
    </ol>}
    {!error && pages.length === 0 && !loading && <div className="calm">{query ? <p>"{query}" 검색 결과가 없습니다</p> : <p>아직 문서가 없습니다</p>}</div>}
  </section>;
}
