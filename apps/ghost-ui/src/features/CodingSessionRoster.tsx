import { useEffect, useId, useReducer, useRef, useState } from 'react';
import { GitBranch, Plus } from 'lucide-react';
import type { CodingSession, CodingThinking } from '@ghost/contract';
import { Modal } from '../components/Modal';
import { useHost } from '../host/context';
import { Button, InlineError, Input } from '../ui';
import { directoryName } from './CodingModel';
import { useEmbeddedModels } from './CodingSessionLive';
import { codingError, codingThinkingLabels, codingThinkingOptions, embeddedSessionPath, modelKey } from './CodingSessionModel';
import { EmbeddedSessionState } from './CodingSessionTranscript';

const rosterOrder: Record<CodingSession['state'], number> = { waiting: 0, working: 1, failed: 2, idle: 3, closed: 4 };
const OTHER = 'other';

export function StartSession({ directories, allowDirect = false, onCreated, onClose }: {
  directories: string[]; allowDirect?: boolean; onCreated(session: CodingSession): void; onClose(): void;
}) {
  const { client } = useHost();
  const { models, error: modelError, reload } = useEmbeddedModels(true);
  const [directory, selectDirectory] = useState(directories[0] ?? OTHER);
  const [custom, setCustom] = useState('');
  const [worktree, setWorktree] = useState(true);
  const [modelId, selectModel] = useState('');
  const [thinking, selectThinking] = useState<CodingThinking>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const fields = useId();
  const model = models?.find(candidate => modelKey(candidate) === modelId);
  const levels = codingThinkingOptions(model);
  const level = thinking && levels.includes(thinking) ? thinking : undefined;
  const repo = directory === OTHER ? custom.trim() : directory;
  const canStart = Boolean(models?.length && repo.startsWith('/'));

  async function start() {
    if (!canStart || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      onCreated(await client.createCodingSession({
        ...(worktree ? { repo } : { cwd: repo }), ...(model && { model: { provider: model.provider, model: model.model } }), thinking: level,
      }));
    } catch (reason) {
      setError(codingError(reason, '코딩 세션을 열지 못했습니다.'));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return <Modal title="새 코딩 세션" onClose={() => { if (!submitting.current) onClose(); }} className="embedded-start-sheet">
    <form className="embedded-settings" onSubmit={event => { event.preventDefault(); void start(); }}>
      <label htmlFor={`${fields}-repo`}>{allowDirect ? '작업 폴더' : '저장소'}</label>
      {directories.length > 0 && <select id={`${fields}-repo`} value={directory} disabled={pending} onChange={event => selectDirectory(event.target.value)}>
        {directories.map(path => <option key={path} value={path}>{directoryName(path)} · {path}</option>)}
        <option value={OTHER}>경로 직접 입력</option>
      </select>}
      {directory === OTHER && <Input id={directories.length ? `${fields}-path` : `${fields}-repo`} aria-label={directories.length ? (allowDirect ? '작업 폴더 경로' : '저장소 경로') : undefined}
        value={custom} maxLength={4096} placeholder="/Projects/…" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={pending} onChange={event => setCustom(event.target.value)}/>}
      {allowDirect && <label className="flex items-center gap-2">
        <input type="checkbox" checked={worktree} disabled={pending} onChange={event => setWorktree(event.target.checked)}/>
        별도 worktree에서 작업
      </label>}
      <label htmlFor={`${fields}-model`}>모델</label>
      <select id={`${fields}-model`} disabled={pending || !models?.length} value={model ? modelKey(model) : ''} onChange={event => {
        selectModel(event.target.value);
        selectThinking(undefined);
      }}>
        <option value="">{modelError ? '불러오지 못함' : models?.length ? '코딩 기본값' : models ? '사용할 모델 없음' : '불러오는 중…'}</option>
        {models?.map(candidate => <option key={modelKey(candidate)} value={modelKey(candidate)}>{candidate.name} · {candidate.provider}</option>)}
      </select>
      {model && levels.length > 0 && <>
        <label htmlFor={`${fields}-thinking`}>생각 수준</label>
        <select id={`${fields}-thinking`} value={level ?? ''} disabled={pending} onChange={event => selectThinking(levels.find(candidate => candidate === event.target.value))}>
          <option value="">코딩 기본값</option>
          {levels.map(level => <option key={level} value={level}>{codingThinkingLabels[level]}</option>)}
        </select>
      </>}
      {modelError && <InlineError onRetry={reload} retryLabel="다시 불러오기">{modelError}</InlineError>}
      {error && <InlineError>{error}</InlineError>}
      <Button type="submit" className="justify-self-end" disabled={pending || !canStart}>{pending ? '여는 중…' : '세션 열기'}</Button>
    </form>
  </Modal>;
}

export function CodingSessionRoster({ directories, selected, observed, onOpen }: {
  directories: string[]; selected: string | null; observed: CodingSession | null; onOpen(id: string): void;
}) {
  const { client } = useHost();
  const [sessions, setSessions] = useState<CodingSession[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [version, reload] = useReducer((revision: number) => revision + 1, 0);
  useEffect(() => {
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const sessions = await client.codingSessions(request.signal);
        if (request.signal.aborted) return;
        setSessions(sessions);
        setError('');
      } catch (reason) {
        if (!request.signal.aborted) setError(codingError(reason, '내장 세션을 불러오지 못했습니다.'));
      }
      if (!request.signal.aborted) timer = setTimeout(() => void load(), 5000);
    }
    void load();
    return () => { request.abort(); clearTimeout(timer); };
  }, [client, selected, version]);

  const rows = observed ? [observed, ...(sessions ?? []).filter(session => session.id !== observed.id)] : sessions?.slice() ?? [];
  rows.sort((a, b) => rosterOrder[a.state] - rosterOrder[b.state] || b.updatedAt - a.updatedAt);
  return <section className="embedded-roster" aria-labelledby="embedded-roster-heading">
    <header>
      <h2 id="embedded-roster-heading">내장 세션</h2>
      <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(true)}><Plus aria-hidden="true"/>새 세션</Button>
    </header>
    {error ? <InlineError onRetry={reload} retryLabel="다시 불러오기">{error}</InlineError>
      : !sessions && <span className="sr-only" role="status">내장 세션 불러오는 중…</span>}
    {rows.length > 0 && <ul>{rows.map(session => <li key={session.id}>
      <a href={`#${embeddedSessionPath(session.id)}`} aria-current={selected === session.id ? 'page' : undefined}
        onClick={event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onOpen(session.id);
        }}>
        <EmbeddedSessionState state={session.state} label={false}/>
        <strong title={session.title}>{session.title}</strong>
        {session.branch && <span title={session.branch}><GitBranch size={12} aria-hidden="true"/>{session.branch}</span>}
      </a>
    </li>)}</ul>}
    {adding && <StartSession directories={Array.from(new Set([...directories, ...(sessions?.flatMap(session => session.repo ? [session.repo] : []) ?? [])]))}
      onClose={() => setAdding(false)} onCreated={session => {
        setAdding(false);
        setSessions(previous => [session, ...(previous ?? []).filter(item => item.id !== session.id)]);
        reload();
        onOpen(session.id);
      }}/>}
  </section>;
}
