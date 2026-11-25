import { useId, useRef, useState } from 'react';
import type { CodingSession, CodingThinking } from '@ghost/contract';
import { Modal } from '../components/Modal';
import { useHost } from '../host/context';
import { FolderField } from '../components/FolderPicker';
import { Button, InlineError, Skeleton, SkeletonRows } from '../ui';
import { directoryName } from './CodingModel';
import { useEmbeddedModels } from './CodingSessionLive';
import { codingError, codingThinkingLabels, codingThinkingOptions, modelKey } from './CodingSessionModel';
const OTHER = 'other';

export function StartSession({ directories, onCreated, onClose }: {
  directories: string[]; onCreated(session: CodingSession): void; onClose(): void;
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
      setError(codingError(reason, '에이전트를 시작하지 못했습니다.'));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return <Modal title="새 에이전트" onClose={() => { if (!submitting.current) onClose(); }} className="embedded-start-sheet">
    <form className="embedded-settings" onSubmit={event => { event.preventDefault(); void start(); }}>
      <label htmlFor={`${fields}-repo`}>작업 폴더</label>
      {directories.length > 0 && <select id={`${fields}-repo`} value={directory} disabled={pending} onChange={event => selectDirectory(event.target.value)}>
        {directories.map(path => <option key={path} value={path}>{directoryName(path)} · {path}</option>)}
        <option value={OTHER}>다른 폴더 선택…</option>
      </select>}
      {directory === OTHER && <FolderField label="작업 폴더" showLabel={false} value={custom} disabled={pending} onChange={setCustom}/>}
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={worktree} disabled={pending} onChange={event => setWorktree(event.target.checked)}/>
        별도 worktree에서 작업
      </label>
      <label htmlFor={`${fields}-model`}>모델</label>
      {!models && !modelError ? <Skeleton className="h-8 w-full" role="status" aria-label="모델 불러오는 중…"/>
        : <select id={`${fields}-model`} disabled={pending || !models?.length} value={model ? modelKey(model) : ''} onChange={event => {
          selectModel(event.target.value);
          selectThinking(undefined);
        }}>
          <option value="">{modelError ? '불러오지 못함' : models?.length ? '코딩 기본값' : '사용할 모델 없음'}</option>
          {models?.map(candidate => <option key={modelKey(candidate)} value={modelKey(candidate)}>{candidate.name} · {candidate.provider}</option>)}
        </select>}
      {model && levels.length > 0 && <>
        <label htmlFor={`${fields}-thinking`}>생각 수준</label>
        <select id={`${fields}-thinking`} value={level ?? ''} disabled={pending} onChange={event => selectThinking(levels.find(candidate => candidate === event.target.value))}>
          <option value="">코딩 기본값</option>
          {levels.map(level => <option key={level} value={level}>{codingThinkingLabels[level]}</option>)}
        </select>
      </>}
      {modelError && <InlineError onRetry={reload} retryLabel="다시 불러오기">{modelError}</InlineError>}
      {error && <InlineError>{error}</InlineError>}
      <Button type="submit" className="justify-self-end" disabled={pending || !canStart}>{pending ? '시작 중…' : '시작'}</Button>
    </form>
  </Modal>;
}
