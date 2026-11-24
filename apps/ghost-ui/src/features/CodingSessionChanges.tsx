import { useEffect, useReducer, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { CodingSessionChanges as Changes } from '../host/client';
import { useHost } from '../host/context';
import { Modal } from '../components/Modal';
import { Button, InlineError } from '../ui';
import { DiffText } from './DiffText';
import { changeStatus } from './codingChangesDisplay';
import { codingError } from './CodingSessionModel';

export function CodingSessionChanges({ id, revision, onClose }: { id: string; revision: number; onClose(): void }) {
  const { client } = useHost();
  const [result, setResult] = useState<Changes | null>(null);
  const [error, setError] = useState('');
  const [attempt, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const request = new AbortController();
    void client.codingSessionChanges(id, request.signal).then(next => {
      if (request.signal.aborted) return;
      setResult(next);
      setError('');
    }, reason => {
      if (!request.signal.aborted) setError(codingError(reason, '변경 사항을 불러오지 못했습니다.'));
    });
    return () => request.abort();
  }, [client, id, revision, attempt]);

  return <Modal title="작업 변경" onClose={onClose} drawer className="embedded-changes-sheet">
    {error && <InlineError onRetry={refresh} retryLabel="다시 불러오기">{error}</InlineError>}
    {!result && !error && <p className="embedded-muted" role="status">변경 사항을 불러오는 중…</p>}
    {result && <>
      <div className="embedded-changes__bar">
        <span>{result.files.length ? `${result.files.length}개 파일` : '변경된 파일 없음'}</span>
        <Button type="button" size="icon" variant="ghost" aria-label="변경 새로고침" onClick={refresh}><RefreshCw aria-hidden="true"/></Button>
      </div>
      {result.files.length > 0 && <ul className="embedded-changes__files" aria-label="변경된 파일" tabIndex={0}>
        {result.files.map(file => <li key={file.path}>
          <span data-tone={changeStatus[file.status].tone} title={changeStatus[file.status].label}><span className="sr-only">{changeStatus[file.status].label}</span>{changeStatus[file.status].mark}</span>
          <code>{file.path}</code><span data-tone="positive">+{file.additions}</span><span data-tone="negative">−{file.deletions}</span>
        </li>)}
      </ul>}
      {result.diff && <DiffText value={result.diff}/>}
      {result.truncated && <p className="embedded-muted">변경 사항의 일부만 표시됩니다.</p>}
    </>}
  </Modal>;
}
