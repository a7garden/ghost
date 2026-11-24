import { useContext, useEffect, useEffectEvent, useId, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch, GitCompare, LogOut, Settings2 } from 'lucide-react';
import type { CodingSession as Session } from '@ghost/contract';
import { CompactTitleSlot } from '../components/AppFrame';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { CodingSessionPatch } from '../host/client';
import { useHost } from '../host/context';
import { Button, Conversation, InlineError, Input, Popover, PopoverContent, PopoverTrigger, SkeletonText } from '../ui';
import { CodingSessionChanges } from './CodingSessionChanges';
import { CodingSessionComposer } from './CodingSessionComposer';
import { CodingSessionDialog } from './CodingSessionDialog';
import { useCodingSessionLive, useEmbeddedModels } from './CodingSessionLive';
import { codingBusy, codingError, codingThinkingLabels, codingThinkingOptions, modelKey } from './CodingSessionModel';
import { CodingSessionTranscript, EmbeddedSessionState } from './CodingSessionTranscript';
import { PiSessionSettings } from './PiConfig';

function SessionSettings({ session, disabled, onPatch }: { session: Session; disabled: boolean; onPatch(input: CodingSessionPatch): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fields = useId();
  const closed = session.state === 'closed';
  const { models, error: modelError, reload } = useEmbeddedModels(!closed || open);
  const currentModel = models?.find(model => modelKey(model) === modelKey(session.model));
  const levels = codingThinkingOptions(currentModel);
  const currentTitle = title ?? session.title;
  const lockModel = disabled;

  async function patch(input: CodingSessionPatch) {
    setError('');
    try {
      await onPatch(input);
      if (input.title !== undefined) setTitle(null);
    } catch (reason) {
      setError(codingError(reason, '세션 설정을 저장하지 못했습니다.'));
    }
  }

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className="embedded-model" title="세션 설정" aria-label="세션 설정">
        <Settings2 aria-hidden="true"/><span>{currentModel?.name ?? session.model.model}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" className="embedded-settings gap-1.5" aria-label="세션 설정">
      {!closed && <form className="embedded-settings" onSubmit={event => {
        event.preventDefault();
        if (!disabled && currentTitle.trim() && currentTitle.trim() !== session.title) void patch({ title: currentTitle.trim() });
      }}>
        <label htmlFor={`${fields}-title`}>세션 제목</label>
        <div className="embedded-settings__title">
          <Input id={`${fields}-title`} value={currentTitle} maxLength={200} onChange={event => setTitle(event.target.value)} disabled={disabled}/>
          <Button type="submit" size="sm" disabled={disabled || !currentTitle.trim() || currentTitle.trim() === session.title}>저장</Button>
        </div>
      </form>}
      <label htmlFor={`${fields}-model`}>모델</label>
      <select id={`${fields}-model`} value={modelKey(session.model)} disabled={closed || lockModel || !models?.length} onChange={event => {
        const model = models?.find(candidate => modelKey(candidate) === event.target.value);
        if (!model) return;
        const supported = codingThinkingOptions(model);
        const thinking = supported.includes(session.thinking) ? session.thinking : supported[0];
        void patch({ model: { provider: model.provider, model: model.model }, thinking });
      }}>
        {!currentModel && <option value={modelKey(session.model)}>{session.model.model} · {session.model.provider}</option>}
        {models?.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.name} · {model.provider}</option>)}
      </select>
      <label htmlFor={`${fields}-thinking`}>생각 수준</label>
      <select id={`${fields}-thinking`} value={session.thinking} disabled={closed || lockModel || !levels.length} onChange={event => {
        const thinking = levels.find(level => level === event.target.value);
        if (thinking) void patch({ thinking });
      }}>
        {!levels.includes(session.thinking) && <option value={session.thinking}>{codingThinkingLabels[session.thinking]}</option>}
        {levels.map(level => <option key={level} value={level}>{codingThinkingLabels[level]}</option>)}
      </select>
      {modelError && <InlineError onRetry={reload} retryLabel="다시 불러오기">{modelError}</InlineError>}
      {error && <InlineError>{error}</InlineError>}
      {open && <PiSessionSettings key={`${session.id}:${session.model.provider}:${session.model.model}:${session.thinking}`} session={session} disabled={disabled}/>}
    </PopoverContent>
  </Popover>;
}

type SessionAction = 'settings' | 'abort' | 'close';

export function CodingSession({ id, onUpdate }: { id: string; onUpdate(session: Session): void }) {
  const { client } = useHost();
  const { session, items, ready, connected, error, reconnect, changesRevision, refreshChanges, applyResponse } = useCodingSessionLive(id);
  const titleSlot = useContext(CompactTitleSlot);
  const [changes, setChanges] = useState(false);
  const [closing, setClosing] = useState(false);
  const [pending, setPending] = useState<SessionAction | null>(null);
  const [actionError, setActionError] = useState('');
  const [follow, followLatest] = useReducer((value: number) => value + 1, 0);
  const active = useRef<SessionAction | null>(null);
  const publish = useEffectEvent(onUpdate);
  useEffect(() => { if (session) publish(session); }, [session]);

  async function command(before: Session, action: SessionAction, act: () => Promise<Session>) {
    if (active.current) return;
    active.current = action;
    setPending(action);
    setActionError('');
    try {
      applyResponse(before, await act());
      if (action !== 'settings') refreshChanges();
    } finally {
      active.current = null;
      setPending(null);
    }
  }

  const closed = session?.state === 'closed';
  const identity = session && <div className="embedded-identity">
    <h2 title={session.title}>{session.title}</h2><EmbeddedSessionState state={session.state}/>
  </div>;
  const header = session ? <div className="embedded-workspace__head">
    {!titleSlot && identity}
    <div className="embedded-workspace__actions">
      {session.branch && <span className="embedded-branch" title={session.branch}><GitBranch size={13} aria-hidden="true"/><code>{session.branch}</code></span>}
      <SessionSettings session={session} disabled={!connected || Boolean(pending)} onPatch={patch => command(session, 'settings', () => client.patchCodingSession(id, patch))}/>
      <Button variant="ghost" size="sm" type="button" onClick={() => setChanges(true)}><GitCompare aria-hidden="true"/>변경</Button>
      {!closed && <Button variant="ghost" size="icon" type="button" aria-label="세션 닫기" title="세션 닫기" disabled={!connected || Boolean(pending)} onClick={() => setClosing(true)}><LogOut aria-hidden="true"/></Button>}
    </div>
    {error && <InlineError onRetry={reconnect} retryLabel="다시 연결">{error}</InlineError>}
    {actionError && <InlineError>{actionError}</InlineError>}
  </div> : undefined;
  const dialog = session?.pendingDialog;

  return <>
    {titleSlot && identity && createPortal(identity, titleSlot)}
    <Conversation className="embedded-workspace" label="내장 코딩 세션" transcriptLabel="코딩 기록" jumpToLatestLabel="최신 기록"
      header={header} followKey={follow}
      composer={session && !closed && <CodingSessionComposer state={session.state} disabled={!ready || !connected || pending === 'close'} stopping={Boolean(pending)}
        onAbort={() => void command(session, 'abort', () => client.abortCodingSession(id)).catch(reason => setActionError(codingError(reason, '작업을 중단하지 못했습니다.')))}
        onPrompt={async prompt => {
          followLatest();
          return client.promptCodingSession(id, prompt);
        }}/>}
    >
      {!session && error && <InlineError onRetry={reconnect} retryLabel="다시 연결">{error}</InlineError>}
      {!ready && !error && <SkeletonText label="코딩 기록을 불러오는 중…" lines={4} className="py-2"/>}
      {ready && !items.length && !dialog && <p className="embedded-muted">{closed ? '기록 없음' : '아직 지시가 없습니다.'}</p>}
      <CodingSessionTranscript id={id} items={items}/>
      {dialog && !closed && <CodingSessionDialog key={dialog.id} sessionId={id} dialog={dialog} disabled={!connected}
        onAnswer={answer => client.answerCodingSession(id, dialog.id, answer)}/>}
    </Conversation>
    {changes && <CodingSessionChanges id={id} revision={changesRevision} onClose={() => setChanges(false)}/>}
    {closing && session && !closed && <ConfirmDialog title="코딩 세션 닫기" confirmLabel="세션 닫기" onClose={() => setClosing(false)}
      onConfirm={() => command(session, 'close', () => client.closeCodingSession(id))}>
      <p>새 지시를 보낼 수 없게 됩니다. 작업 트리와 브랜치는 그대로 남습니다.</p>
    </ConfirmDialog>}
  </>;
}
