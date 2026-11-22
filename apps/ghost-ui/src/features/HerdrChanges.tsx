import { useEffect, useMemo, useReducer, useState } from 'react';
import { ArrowLeft, ChevronRight, GitBranch, RefreshCw, WrapText } from 'lucide-react';
import type { HerdrChanges, HerdrDiff, HerdrPaneView } from '@ghost/contract';
import { useHost } from '../host/context';
import { Button, InlineError } from '../ui';
import { changeStatus, diffLines } from './herdrChangesDisplay';

export function usePaneChanges(pane: HerdrPaneView) {
  const { client } = useHost();
  const { id, cwd, status } = pane;
  const [revision, refresh] = useReducer((count: number) => count + 1, 0);
  const [result, setResult] = useState<{ cwd: string; data: HerdrChanges | null; error: string }>();
  useEffect(() => {
    if (!cwd) return;
    const request = new AbortController();
    void client.herdrChanges(id, request.signal).then(data => {
      if (!request.signal.aborted) setResult({ cwd, data, error: '' });
    }, reason => {
      if (!request.signal.aborted) setResult(old => ({ cwd, data: old?.cwd === cwd ? old.data : null,
        error: reason instanceof Error ? reason.message : '변경을 불러오지 못했습니다.' }));
    });
    return () => request.abort();
  }, [client, id, cwd, status, revision]);
  const current = cwd && result?.cwd === cwd ? result : null;
  return { changes: current?.data ?? null, error: current?.error ?? '', refresh, revision };
}

export function HerdrDiffText({ value, wrap }: { value: string; wrap: boolean }) {
  const lines = useMemo(() => diffLines(value), [value]);
  return <pre className="herdr-diff" data-wrap={wrap || undefined} tabIndex={0} aria-label="파일 차이">
    {lines.map(({ text, kind }, i) => <span key={i} data-kind={kind}>{text}{i < lines.length - 1 ? '\n' : ''}</span>)}
  </pre>;
}

export function HerdrChangesView({ pane, compact, data, error, onRefresh, revision }: {
  pane: HerdrPaneView; compact: boolean; data: HerdrChanges | null; error: string; onRefresh(): void; revision: number;
}) {
  const { client } = useHost();
  const [selected, select] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [result, setResult] = useState<{ path: string; diff?: HerdrDiff; error?: string }>();
  const path = data?.files.find(file => file.path === selected)?.path;
  const { id, cwd, status } = pane;
  useEffect(() => {
    if (!path) return;
    const request = new AbortController();
    void client.herdrDiff(id, path, request.signal).then(diff => {
      if (!request.signal.aborted) setResult({ path, diff });
    }, reason => {
      if (!request.signal.aborted) setResult({ path, error: reason instanceof Error ? reason.message : '파일 차이를 불러오지 못했습니다.' });
    });
    return () => request.abort();
  }, [client, id, cwd, status, revision, path]);
  const diff = result?.path === path ? result?.diff : undefined;
  const diffError = result?.path === path ? result?.error : undefined;
  return <section className="herdr-changes" aria-label="작업 변경">
    {(!compact || !path) && <header className="herdr-changes-head">
      <div className="herdr-branch">
        {data?.branch && <strong><GitBranch size={15} aria-hidden="true"/>{data.branch}</strong>}
        {data?.base && <span>기준 <code title={data.base}>{data.base.slice(0, 12)}</code></span>}
      </div>
      <Button type="button" variant="ghost" size="icon" aria-label="변경 새로고침" title="변경 새로고침" onClick={onRefresh}><RefreshCw aria-hidden="true"/></Button>
    </header>}
    {error && <InlineError onRetry={onRefresh} retryLabel="다시 불러오기">{error}</InlineError>}
    {!data && !error && <p role="status" className="coding-pane-status">변경을 불러오는 중…</p>}
    {data && <div className="herdr-change-work" data-file={Boolean(path) || undefined}>
      {(!compact || !path) && <div className="herdr-change-index">
        {data.commits.length > 0 && <details className="herdr-commits">
          <summary>커밋 <span>{data.commits.length}</span></summary>
          <ol>{data.commits.map(commit => <li key={commit.sha}><code title={commit.sha}>{commit.sha.slice(0, 8)}</code><span>{commit.subject}</span></li>)}</ol>
        </details>}
        {data.files.length ? <ul className="herdr-changed-files" aria-label="변경한 파일">
          {data.files.map(file => {
            const status = changeStatus[file.status];
            return <li key={file.path}><button type="button" aria-current={file.path === path || undefined}
              onClick={() => { setResult(undefined); select(file.path); }} disabled={file.path === path}>
              <span className="herdr-file-status" data-tone={status.tone} title={status.label} aria-label={status.label}>{status.mark}</span>
              <code>{file.path}</code>
              <span className="herdr-file-counts">{file.additions != null && <span data-kind="addition">+{file.additions}</span>}
                {file.deletions != null && <span data-kind="deletion">−{file.deletions}</span>}</span>
              <ChevronRight size={14} aria-hidden="true"/>
            </button></li>;
          })}
        </ul> : <p className="coding-hint">변경한 파일이 없습니다.</p>}
        {data.truncated && <p className="coding-hint">일부 파일만 표시합니다.</p>}
      </div>}
      {path && <article className="herdr-file-diff" aria-label={path}>
        <header>
          {compact && <Button type="button" variant="ghost" size="icon" aria-label="파일 목록" onClick={() => select(null)}><ArrowLeft aria-hidden="true"/></Button>}
          <code className="min-w-0 truncate">{path}</code>
          <Button type="button" variant="ghost" size="icon" aria-label="줄 바꿈" title="줄 바꿈" aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText aria-hidden="true"/></Button>
          {compact && <Button type="button" variant="ghost" size="icon" aria-label="변경 새로고침" title="변경 새로고침" onClick={onRefresh}><RefreshCw aria-hidden="true"/></Button>}
        </header>
        {diffError ? <InlineError onRetry={onRefresh} retryLabel="다시 불러오기">{diffError}</InlineError>
          : !diff ? <p role="status" className="coding-pane-status">파일 차이를 불러오는 중…</p>
          : <>
            {diff.diff ? <HerdrDiffText value={diff.diff} wrap={wrap}/> : <p className="coding-pane-status">표시할 파일 차이가 없습니다.</p>}
            {diff.truncated && <p className="coding-hint">파일 차이의 일부만 표시합니다.</p>}
          </>}
      </article>}
    </div>}
  </section>;
}
