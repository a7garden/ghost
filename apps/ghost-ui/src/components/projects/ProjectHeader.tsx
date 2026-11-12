import { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { pathCrumb } from '../../features/spacePages';
import { relativeTime } from '../../features/time';
import type { Scope } from '@ghost/contract';

/**
 * The project header as a place: the name renames inline, the folder sits
 * beneath it as a breadcrumb chip, and the meta line carries the document
 * count and this session's last edit.
 */
export function ProjectHeader({ space, total, lastEditAt, now, disabled, onRename }: {
  space: Scope;
  /** Document count when the unfiltered list is loaded. */
  total: number;
  /** Timestamp noted when a page was saved from this session, if any. */
  lastEditAt: number | null;
  now: number;
  disabled?: boolean;
  onRename(name: string): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const start = () => { setDraft(space.name); setError(''); cancelled.current = false; setEditing(true); };
  const close = () => { setEditing(false); setError(''); };
  const commit = async () => {
    if (cancelled.current) { close(); return; }
    const name = draft.trim();
    if (!name || name === space.name) { close(); return; }
    try {
      await onRename(name);
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '이름을 바꾸지 못했습니다.');
    }
  };
  const crumb = pathCrumb((space.vaultPath ?? space.paths[0] ?? ""));

  return <header className="place">
    <div className="place__title">
      <h1 className="place__heading">
        {editing
          ? <input ref={input} className="place__name-input" aria-label="프로젝트 이름" value={draft} maxLength={128}
            autoComplete="off" aria-invalid={Boolean(error) || undefined}
            onChange={event => setDraft(event.target.value)}
            onBlur={() => void commit()}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); void commit(); }
              if (event.key === 'Escape') { cancelled.current = true; close(); }
            }}/>
          : <button type="button" className="place__name" title="이름 바꾸기" disabled={disabled} onClick={start}>{space.name}</button>}
      </h1>
      {!editing && <button type="button" className="place__rename" aria-label={`${space.name} 이름 바꾸기`} disabled={disabled} onClick={start}>
        <Pencil size={14} aria-hidden="true"/>
      </button>}
    </div>
    {error && <p className="place__error" role="alert">{error}</p>}
    <span className="place__crumb" title={(space.vaultPath ?? space.paths[0] ?? "")} aria-label={`폴더 ${(space.vaultPath ?? space.paths[0] ?? "")}`}>
      {crumb.leading && <span className="place__crumb-seg">{crumb.leading}</span>}
      {crumb.leading && <span className="place__crumb-gap" aria-hidden="true">…</span>}
      {crumb.trailing.map(segment => <span className="place__crumb-seg" key={segment}>{segment}</span>)}
    </span>
    <p className="place__meta">
      <span>문서 <span className="tabular">{total}</span></span>
      {lastEditAt !== null && <span aria-label="마지막 편집">마지막 편집 <time dateTime={new Date(lastEditAt).toISOString()}>{relativeTime(lastEditAt, now)}</time></span>}
    </p>
  </header>;
}
