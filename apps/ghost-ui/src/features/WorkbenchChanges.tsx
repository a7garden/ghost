import { useEffect, useReducer, useState } from 'react';
import { ChevronRight, RefreshCw } from 'lucide-react';
import type { WorkbenchChanges as Changes, WorkbenchFileDiff } from '@ghost/contract';
import { Modal } from '../components/Modal';
import { useHost } from '../host/context';
import { Button, InlineError } from '../ui';
import { codingError } from './CodingSessionModel';
import { DiffText } from './DiffText';
import { changeStatus } from './codingChangesDisplay';

export function WorkbenchChanges({ root, onClose }: { root: string; onClose(): void }) {
  const { client } = useHost();
  const [changes, setChanges] = useState<Changes | null>(null);
  const [error, setError] = useState('');
  const [selected, select] = useState<string | null>(null);
  const [file, setFile] = useState<{ path: string; diff?: WorkbenchFileDiff; error?: string }>();
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  const path = changes?.files.find(entry => entry.path === selected)?.path;
  useEffect(() => {
    const request = new AbortController();
    void client.workbenchChanges(root, request.signal).then(next => {
      if (request.signal.aborted) return;
      setChanges(next);
      setError('');
      select(previous => next.files.some(entry => entry.path === previous) ? previous : null);
    }, reason => {
      if (!request.signal.aborted) setError(codingError(reason, 'Git 변경을 불러오지 못했습니다.'));
    });
    return () => request.abort();
  }, [client, root, revision]);
  useEffect(() => {
    if (!path) return;
    const request = new AbortController();
    void client.workbenchFileDiff(root, path, request.signal).then(diff => {
      if (!request.signal.aborted) setFile({ path, diff });
    }, reason => {
      if (!request.signal.aborted) setFile({ path, error: codingError(reason, '파일 차이를 불러오지 못했습니다.') });
    });
    return () => request.abort();
  }, [client, root, path, revision]);

  const detail = file?.path === path ? file : undefined;
  return <Modal title="git 변경" drawer className="embedded-changes-sheet" onClose={onClose}>
    {error && <InlineError onRetry={refresh} retryLabel="다시 불러오기">{error}</InlineError>}
    {!changes && !error && <p className="embedded-muted" role="status">Git 변경을 불러오는 중…</p>}
    {changes && <>
      <div className="embedded-changes__bar">
        <span>{changes.branch && <><code>{changes.branch}</code> · </>}{changes.files.length ? `${changes.files.length}개 파일` : '변경된 파일 없음'}</span>
        <Button type="button" size="icon" variant="ghost" aria-label="변경 새로고침" onClick={refresh}><RefreshCw aria-hidden="true"/></Button>
      </div>
      {changes.files.length > 0 && <ul className="coding-changed-files max-h-[30dvh] overflow-y-auto" aria-label="변경된 파일">
        {changes.files.map(entry => {
          const status = changeStatus[entry.status];
          return <li key={entry.path}><button type="button" aria-current={entry.path === path || undefined}
            onClick={() => { if (selected !== entry.path) { setFile(undefined); select(entry.path); } }}>
            <span className="coding-file-status" data-tone={status.tone} title={status.label} aria-label={status.label}>{status.mark}</span>
            <code>{entry.path}</code>
            <span className="coding-file-counts">{entry.additions !== null && <span data-kind="addition">+{entry.additions}</span>}
              {entry.deletions !== null && <span data-kind="deletion">−{entry.deletions}</span>}</span>
            <ChevronRight size={14} aria-hidden="true"/>
          </button></li>;
        })}
      </ul>}
      {changes.truncated && <p className="embedded-muted">변경 목록의 일부만 표시합니다.</p>}
      {path && <article aria-label={path} className="grid min-w-0 gap-2">
        <h3 className="break-all text-sm"><code>{path}</code></h3>
        {!detail ? <p className="embedded-muted" role="status">파일 차이를 불러오는 중…</p>
          : detail.error ? <InlineError onRetry={refresh} retryLabel="다시 불러오기">{detail.error}</InlineError>
          : detail.diff && <>
            {detail.diff.staged && <section aria-label="스테이징된 변경">
              <h4 className="embedded-muted">스테이징된 변경</h4>
              <DiffText value={detail.diff.staged}/>
            </section>}
            {detail.diff.unstaged && <section aria-label="작업 폴더 변경">
              <h4 className="embedded-muted">작업 폴더 변경</h4>
              <DiffText value={detail.diff.unstaged}/>
            </section>}
            {!detail.diff.staged && !detail.diff.unstaged && !detail.diff.truncated && <p className="embedded-muted">표시할 파일 차이가 없습니다.</p>}
            {detail.diff.truncated && <p className="embedded-muted">파일 차이가 커서 모두 표시할 수 없습니다.</p>}
          </>}
      </article>}
    </>}
  </Modal>;
}
