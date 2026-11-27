import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react';
import type { CodingSession as Session } from '@ghost/contract';
import type { CodingSessionPatch } from '../host/client';
import { useHost } from '../host/context';
import { Conversation, InlineError, SkeletonText } from '../ui';
import { CodingModelChip } from './CodingModelChip';
import { CodingSessionComposer } from './CodingSessionComposer';
import { CodingSessionDialog } from './CodingSessionDialog';
import { useCodingSessionLive } from './CodingSessionLive';
import { codingError } from './CodingSessionModel';
import { CodingSessionTranscript } from './CodingSessionTranscript';
import { PiSessionSettings } from './PiConfig';
import './CodingSession2.css';

/** One agent's transcript and composer. The workbench pane around it carries the name, changes and session actions. */
export function CodingSession({ id, onUpdate, changesRevision: onChangesRevision }: {
  id: string; onUpdate(session: Session): void;
  /** Reports when the agent's changes may have moved, so an open changes view can refresh. */
  changesRevision?(revision: number): void;
}) {
  const { client } = useHost();
  const { session, items, ready, connected, error, reconnect, changesRevision, refreshChanges, applyResponse } = useCodingSessionLive(id);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState('');
  const [follow, followLatest] = useReducer((value: number) => value + 1, 0);
  const active = useRef(false);
  const publish = useEffectEvent(onUpdate);
  const publishChanges = useEffectEvent((revision: number) => onChangesRevision?.(revision));
  useEffect(() => { if (session) publish(session); }, [session]);
  useEffect(() => { publishChanges(changesRevision); }, [changesRevision]);

  async function command(before: Session, act: () => Promise<Session>, failure: string, refresh = true) {
    if (active.current) return;
    active.current = true;
    setPending(true);
    setActionError('');
    try {
      applyResponse(before, await act());
      if (refresh) refreshChanges();
    } catch (reason) {
      setActionError(codingError(reason, failure));
    } finally {
      active.current = false;
      setPending(false);
    }
  }

  const closed = session?.state === 'closed';
  const patch = (input: CodingSessionPatch) => session && command(session, () => client.patchCodingSession(id, input), '세션 설정을 저장하지 못했습니다.', false);
  const notices = (error || actionError) ? <div className="embedded-workspace__head">
    {error && <InlineError onRetry={reconnect} retryLabel="다시 연결">{error}</InlineError>}
    {actionError && <InlineError>{actionError}</InlineError>}
  </div> : undefined;
  const dialog = session?.pendingDialog;
  const empty = ready && !items.length && !dialog;

  return <Conversation className="embedded-workspace" label="내장 코딩 세션" transcriptLabel="코딩 기록" jumpToLatestLabel="최신 기록"
    header={session ? notices : undefined} followKey={follow}
    composer={session && !closed && <>
      {dialog && <CodingSessionDialog key={dialog.id} sessionId={id} dialog={dialog} disabled={!connected}
        onAnswer={answer => client.answerCodingSession(id, dialog.id, answer)}/>}
      {empty && <p className="embedded-muted embedded-start">아직 지시가 없습니다.</p>}
      <CodingSessionComposer state={session.state} disabled={!ready || !connected} stopping={pending}
        model={<CodingModelChip allowDefault={false} value={{ model: session.model, thinking: session.thinking }} disabled={!connected || pending}
          onChange={next => void patch({ ...(next.model && { model: next.model }), ...(next.thinking && { thinking: next.thinking }) })}
          extra={<PiSessionSettings key={`${session.id}:${session.model.provider}:${session.model.model}:${session.thinking}`} session={session} disabled={!connected || pending}/>}/>}
        onAbort={() => void command(session, () => client.abortCodingSession(id), '작업을 중단하지 못했습니다.')}
        onPrompt={async prompt => {
          followLatest();
          return client.promptCodingSession(id, prompt);
        }}/>
    </>}
  >
    {!session && error && <InlineError onRetry={reconnect} retryLabel="다시 연결">{error}</InlineError>}
    {!ready && !error && <SkeletonText label="코딩 기록을 불러오는 중…" lines={4} className="py-2"/>}
    {empty && closed && <p className="embedded-muted">기록 없음</p>}
    <CodingSessionTranscript id={id} items={items} approval={dialog?.kind === 'approval' ? dialog.tool : undefined}/>
  </Conversation>;
}
