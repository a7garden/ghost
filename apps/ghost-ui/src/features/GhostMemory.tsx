import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, FileText, History, Pencil, Plus, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import type { Ghost, MemoryFile, MemoryRevision, MemoryView } from '@ghost/contract';
import { InlineError, Input, SettingsRow } from '../ui';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useHost } from '../host/context';
import { HostError } from '../host/client';
import { relativeTime, useNow } from './time';

const runLabel: Record<MemoryView['runs'][number]['state'], string> = { running: '정리 중', done: '완료', failed: '실패' };
const authorLabel: Record<string, string> = { owner: '소유자', host: 'Host 정리', ghost: 'Ghost' };

/** One draft the owner edits against the stored version's hash; the content is the owner's until an explicit save. */
type Draft = { path: string; content: string; original: string; hash: string | null; isNew: boolean };

/** 서버가 받는 가상 경로와 같은 모양: .md로 끝나고, 빈·.·.. 구간과 공백·제어문자가 없으며 NFC 그대로다. */
export function validMemoryPath(path: string): boolean {
  if (path === '/owner.md') return true;
  if (!path.startsWith('/me/') && !path.startsWith('/team/')) return false;
  if (!path.endsWith('.md') || path !== path.normalize('NFC') || /[\\%\x00-\x20\x7f]/u.test(path)) return false;
  const segments = path.slice(1).split('/');
  // /team/<ghostId>/<이름>.md — team은 Ghost id 구간을 하나 더 요구한다.
  if (segments[0] === 'team' && segments.length < 3) return false;
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

const draftIsDirty = (draft: Draft) => (draft.isNew ? draft.content !== '' : draft.content !== draft.original);

/**
 * Ghost의 호스트 기억 패널: 기억 파일을 보고 고치고 지우고, 버전 기록과 정리 실행 내역을 본다.
 * 편집 중인 내용은 저장에 성공할 때까지 어떤 새로고침에도 닫히지 않고, 충돌하면 서버 내용과
 * 나란히 비교해 불러오거나 덮어쓸지 고른다.
 */
export function GhostMemory({ ghost }: { ghost: Ghost }) {
  const { client } = useHost();
  const now = useNow();
  const [view, setView] = useState<MemoryView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState<MemoryFile | null>(null);
  const [pendingOpen, setPendingOpen] = useState<Draft | null>(null);
  const [pendingClose, setPendingClose] = useState(false);
  const [revisionsFor, setRevisionsFor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<MemoryFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [awaiting, setAwaiting] = useState<number | null>(null);

  /** 새로고침은 화면의 읽기 값만 갱신한다. 편집 중인 draft는 절대 닫지 않는다. */
  const reload = useCallback(async (): Promise<MemoryView | null> => {
    try {
      const fresh = await client.memory(ghost.id);
      setView(fresh);
      setLoadError('');
      return fresh;
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : '기억을 불러오지 못했습니다.');
      return null;
    } finally {
      setLoading(false);
    }
  }, [client, ghost.id]);

  useEffect(() => {
    setView(null); setDraft(null); setConflict(null); setActionError(''); setNotice(''); setAwaiting(null); setLoading(true);
    void reload();
  }, [reload]);

  const editable = ghost.state === 'active';
  const files = view?.files ?? [];
  const runs = view?.runs ?? [];
  const running = runs.some(row => row.state === 'running');

  /** 정리가 돼 있거나 방금 요청했으면 3초마다 다시 읽는다. 요청 뒤 1분이 지나면 조용히 포기한다. */
  const latestRunAt = runs[0]?.startedAt ?? 0;
  useEffect(() => {
    if (!running && awaiting === null) return;
    const timer = setInterval(() => {
      if (awaiting !== null && Date.now() - awaiting > 60_000) setAwaiting(null);
      else void reload();
    }, 3000);
    return () => clearInterval(timer);
  }, [running, awaiting, reload]);
  useEffect(() => {
    if (awaiting !== null && latestRunAt >= awaiting) setAwaiting(null);
  }, [awaiting, latestRunAt]);

  const updateDraft = (next: Draft) => { setConflict(null); setDraft(next); };
  const closeDraft = () => { setDraft(null); setConflict(null); };
  /** 다른 파일을 열 때 저장하지 않은 내용이 있으면 먼저 물어본다. */
  const openDraft = (next: Draft) => (draft !== null && draftIsDirty(draft) ? setPendingOpen(next) : updateDraft(next));

  const fail = (reason: unknown, reloadAfter = true) => {
    const message = reason instanceof Error && reason.message ? `요청을 처리하지 못했습니다 · ${reason.message}` : '요청을 처리하지 못했습니다.';
    setActionError(message);
    if (reloadAfter) void reload();
  };

  /** 저장은 항상 명시적이다: 성공하면 draft의 기준 해시를 저장 결과로 옮기고, 실패하면 내용을 그대로 둔다. */
  const saveDraft = async (expectedHash: string | null) => {
    if (!draft) return;
    setBusy(true); setActionError(''); setNotice('');
    try {
      const saved = await client.memoryWrite(ghost.id, { path: draft.path, content: draft.content, expectedHash });
      if (saved === null) {
        setActionError('요청을 처리하지 못했습니다 · 파일이 저장되지 않았습니다.');
        await reload();
        return;
      }
      setDraft({ path: saved.path, content: draft.content, original: draft.content, hash: saved.hash, isNew: false });
      setNotice(draft.isNew ? '기억 파일을 만들었습니다.' : '기억 파일을 저장했습니다.');
      await reload();
    } catch (reason) {
      if (reason instanceof HostError && reason.code === 'conflict') {
        const fresh = await reload();
        const server = fresh?.files.find(file => file.path === draft.path) ?? null;
        setConflict(server);
        setActionError(server
          ? '다른 변경이 먼저 반영되어 저장하지 못했습니다. 내용은 그대로 남겼습니다 — 서버 내용과 비교해 아래에서 고르세요.'
          : '다른 변경이 먼저 반영되어 저장하지 못했습니다. 파일이 서버에 더 이상 없는 것 같습니다.');
      } else {
        fail(reason);
      }
    } finally {
      setBusy(false);
    }
  };

  const requestDream = async () => {
    setBusy(true); setActionError(''); setNotice('');
    try {
      await client.memoryDream(ghost.id);
      setAwaiting(Date.now());
      setNotice('정리를 요청했습니다. 할 일이 없을 때 진행됩니다.');
      await reload();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  const removeFile = async (file: MemoryFile) => {
    setBusy(true); setActionError(''); setNotice('');
    try {
      await client.memoryDelete(ghost.id, file.path, file.hash);
      if (draft?.path === file.path) closeDraft();
      setNotice('기억 파일을 삭제했습니다. 버전 기록은 남습니다.');
      await reload();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  return <div className="memory" aria-busy={busy}>
    {loadError && <InlineError pending={loading} onRetry={() => { setLoading(true); void reload(); }} retryLabel="다시 불러오기">{loadError}</InlineError>}
    {actionError && <InlineError>{actionError}</InlineError>}
    {notice && <p className="m-0 flex items-start gap-1.5 text-caption text-success" role="status"><Check size={14} className="mt-0.5 flex-none"/>{notice}</p>}

    {draft && <MemoryDraft draft={draft} busy={busy} editable={editable} conflict={conflict} now={now}
      onChange={updateDraft}
      onSave={() => void saveDraft(draft.hash)}
      onOverwrite={() => void saveDraft(conflict?.hash ?? draft.hash)}
      onLoadServer={() => conflict && updateDraft({ ...draft, content: conflict.content, original: conflict.content, hash: conflict.hash })}
      onCloseRequest={() => (draftIsDirty(draft) ? setPendingClose(true) : closeDraft())}/>}

    {!draft && editable && <div className="memory-new">
      <button type="button" className="sandbox-strip__action" onClick={() => openDraft({ path: '/me/', content: '', original: '', hash: null, isNew: true })}>
        <Plus aria-hidden="true"/>새 기억 파일
      </button>
    </div>}

    {!loading && !loadError && files.length === 0 && <div className="calm"><FileText size={16} aria-hidden="true"/><p>아직 기억 파일이 없습니다. Ghost가 일하면서 기록을 쌓습니다.</p></div>}

    {files.map(file => <SettingsRow key={file.path}
      label={<span className="memory-file__path">{file.path}</span>}
      description={<>{file.path === '/owner.md' ? '소유자 프로필 · ' : ''}v{file.revision} · {relativeTime(file.updatedAt, now)} 수정</>}>
      <span className="memory-file__actions">
        <button type="button" aria-label={`${file.path} 버전 기록`} title="버전 기록" onClick={() => setRevisionsFor(file.path)}><History aria-hidden="true"/></button>
        {editable && <button type="button" aria-label={`${file.path} 편집`} title="편집"
          onClick={() => openDraft({ path: file.path, content: file.content, original: file.content, hash: file.hash, isNew: false })}><Pencil aria-hidden="true"/></button>}
        {editable && <button type="button" aria-label={`${file.path} 삭제`} title="삭제" data-danger onClick={() => setConfirming(file)}><Trash2 aria-hidden="true"/></button>}
      </span>
    </SettingsRow>)}

    {!editable && <p className="memory-locked">활성 상태의 Ghost만 기억을 고칠 수 있습니다. 지금은 읽기만 할 수 있어요.</p>}

    <div className="memory-runs">
      <div className="memory-runs__head">
        <p className="memory-runs__title">기억 정리{awaiting !== null ? ' · 요청됨, 시작을 기다리는 중' : ''}</p>
        {editable && <button type="button" className="sandbox-strip__action" disabled={busy || awaiting !== null}
          onClick={() => void requestDream()}>
          <Sparkles aria-hidden="true"/>지금 정리하기
        </button>}
      </div>
      {runs.length === 0 && <p className="memory-runs__empty">아직 정리 기록이 없습니다. 대화가 쌓이면 Host가 찾을 때마다 정리합니다.</p>}
      {runs.map(runRow => <div key={runRow.id} className="memory-run" data-state={runRow.state}>
        <p className="memory-run__line">
          <span className="memory-run__state">{runLabel[runRow.state]}</span>
          <span className="memory-run__at">{relativeTime(runRow.startedAt, now)}</span>
        </p>
        {(runRow.report || runRow.error) && <pre className="memory-run__report">{runRow.error ?? runRow.report}</pre>}
      </div>)}
    </div>

    {revisionsFor !== null && <RevisionHistory ghostId={ghost.id} path={revisionsFor} now={now} onClose={() => setRevisionsFor(null)}/>}
    {confirming && <ConfirmDelete file={confirming} busy={busy} onConfirm={() => removeFile(confirming)} onClose={() => setConfirming(null)}/>}
    {pendingOpen && <ConfirmDialog title="편집 버리기" confirmLabel="버리고 열기" tone="destructive"
      onConfirm={() => { updateDraft(pendingOpen); setPendingOpen(null); }}
      onClose={() => setPendingOpen(null)}>저장하지 않은 편집 내용은 남지 않습니다.</ConfirmDialog>}
    {pendingClose && <ConfirmDialog title="편집 버리기" confirmLabel="버리고 닫기" tone="destructive"
      onConfirm={() => { closeDraft(); setPendingClose(false); }}
      onClose={() => setPendingClose(false)}>저장하지 않은 편집 내용은 남지 않습니다.</ConfirmDialog>}
  </div>;
}

/** 열린 편집기: 저장은 그 해시로만 통하고, 충돌하면 서버 내용을 나란히 보여 명시적으로 고른다. */
function MemoryDraft({ draft, busy, editable, conflict, now, onChange, onSave, onOverwrite, onLoadServer, onCloseRequest }: {
  draft: Draft;
  busy: boolean;
  editable: boolean;
  conflict: MemoryFile | null;
  now: number;
  onChange(next: Draft): void;
  onSave(): void;
  onOverwrite(): void;
  onLoadServer(): void;
  onCloseRequest(): void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const node = area.current; if (!node) return; node.style.height = 'auto'; node.style.height = `${node.scrollHeight}px`; }, [draft.content]);
  const pathOk = !draft.isNew || validMemoryPath(draft.path);
  return <div className="memory-editor">
    {draft.isNew
      ? <label className="memory-editor__field"><span className="sr-only">기억 파일 경로</span>
        <Input value={draft.path} placeholder="/me/주제.md" spellCheck={false} disabled={!editable || busy}
          onChange={event => onChange({ ...draft, path: event.target.value })}/>
        {!pathOk && <InlineError>/me/나 /team/ 아래 .md 경로로 지어 주세요. 빈 칸이나 <code>..</code>는 쓸 수 없습니다.</InlineError>}
      </label>
      : <p className="memory-editor__path">{draft.path}</p>}
    <div className="persona-note">
      <textarea ref={area} aria-label={`${draft.path} 내용`} value={draft.content} rows={5} maxLength={32768}
        disabled={!editable || busy} onChange={event => onChange({ ...draft, content: event.target.value })}/>
      <div className="persona-note__actions">
        <button type="button" className="persona-note__revert" aria-label="닫기" disabled={busy} onClick={onCloseRequest}><X aria-hidden="true"/></button>
        <button type="button" className="persona-note__revert" aria-label="되돌리기" disabled={busy} onClick={() => onChange({ ...draft, content: draft.original })}><RotateCcw aria-hidden="true"/></button>
        <button type="button" className="persona-note__save" disabled={busy || !editable || !draft.path || !pathOk} onClick={onSave}>저장</button>
      </div>
    </div>
    {conflict && <div className="memory-conflict">
      <p className="memory-conflict__title">서버의 최신 내용 (v{conflict.revision} · {relativeTime(conflict.updatedAt, now)})</p>
      <pre>{conflict.content}</pre>
      <div className="memory-conflict__actions">
        <button type="button" className="sandbox-strip__action" disabled={busy} onClick={onOverwrite}>이 화면의 내용으로 저장</button>
        <button type="button" className="sandbox-strip__action" disabled={busy} onClick={onLoadServer}>서버 내용 불러오기</button>
      </div>
    </div>}
  </div>;
}

/** 버전 기록: 지워진 버전까지 전부 남는다. */
function RevisionHistory({ ghostId, path, now, onClose }: { ghostId: string; path: string; now: number; onClose(): void }) {
  const { client } = useHost();
  const [revisions, setRevisions] = useState<MemoryRevision[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    client.memoryRevisions(ghostId, path)
      .then(found => { if (alive) setRevisions(found); })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : '버전 기록을 불러오지 못했습니다.'); });
    return () => { alive = false; };
  }, [client, ghostId, path]);
  return <Modal title={`${path} 버전 기록`} onClose={onClose} className="sm:max-w-[560px]">
    {error && <InlineError>{error}</InlineError>}
    {!revisions && !error && <p className="m-0 text-caption text-ink-2">읽는 중…</p>}
    {revisions?.length === 0 && <p className="m-0 text-caption text-ink-2">기록이 없습니다.</p>}
    {revisions?.map(revision => <div key={revision.revision} className="memory-revision">
      <p className="memory-revision__line">
        <span>v{revision.revision}</span>
        <span>{relativeTime(revision.at, now)}</span>
        <span>{authorLabel[revision.author.split(':')[0]] ?? revision.author}</span>
        <span>{revision.reason}</span>
      </p>
      <pre>{revision.content ?? '삭제됨'}</pre>
    </div>)}
  </Modal>;
}

/** 삭제 확인: 모든 버전이 남는다는 사실을 함께 말한다. */
function ConfirmDelete({ file, busy, onConfirm, onClose }: {
  file: MemoryFile;
  busy: boolean;
  onConfirm(): Promise<unknown>;
  onClose(): void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    setPending(true); setError('');
    try { await onConfirm(); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '삭제하지 못했습니다.'); setPending(false); }
  };
  return <Modal title={`${file.path} 삭제`} onClose={onClose} className="sm:max-w-[440px]">
    <div className="grid gap-2 text-ink-2">
      <p className="m-0">이 기억 파일을 삭제합니다. 이후 Ghost가 이 내용을 쓰지 않으며, 모든 버전 기록은 남습니다.</p>
    </div>
    {error && <InlineError>{error}</InlineError>}
    <div className="mt-4 flex justify-end gap-2">
      <button type="button" className="sandbox-strip__action" disabled={pending || busy} onClick={onClose}>취소</button>
      <button type="button" className="sandbox-strip__action" data-danger disabled={pending || busy} onClick={() => void remove()}>삭제</button>
    </div>
  </Modal>;
}
