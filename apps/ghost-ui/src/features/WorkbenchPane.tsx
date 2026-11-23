import { useEffect, useEffectEvent, useState } from 'react';
import type { CodingSession as Session, Pane } from '@ghost/contract';
import { useHost } from '../host/context';
import { Button, InlineError } from '../ui';
import { CodingSession } from './CodingSession';
import { TerminalPane } from './TerminalPane';
import type { Attention } from './WorkbenchAttention';

export type PaneView = { title: string; state: Session['state'] | 'terminal' | 'exited'; stateLabel: string; attention?: Attention };

const stateLabels: Record<PaneView['state'], string> = {
  idle: '대기 중', working: '작업 중', waiting: '입력 대기', closed: '닫힘', failed: '실패', terminal: '터미널', exited: '종료됨',
};

export function paneView(pane: Pane, sessions: ReadonlyMap<string, Session>, exited: ReadonlySet<string>, attention: ReadonlyMap<string, Attention>): PaneView {
  const session = pane.kind === 'session' ? sessions.get(pane.sessionId) : undefined;
  const state = pane.kind === 'session' ? session?.state ?? 'idle' : exited.has(pane.id) ? 'exited' : 'terminal';
  const title = pane.kind === 'session' ? session?.title || '코딩 세션' : pane.terminalSpec.command?.split('/').at(-1) || '터미널';
  return { title, state, stateLabel: stateLabels[state], attention: attention.get(pane.id) };
}

export function WorkbenchPaneBody({ pane, visible, onExited, observe }: {
  pane: Pane; visible: boolean;
  onExited(id: string, exited: boolean): void;
  observe(session: Session): void;
}) {
  return <div className="workbench-pane-body">
    {pane.kind === 'session' ? <CodingSession id={pane.sessionId} onUpdate={observe}/>
      : <TerminalBody paneId={pane.id} visible={visible} onExited={onExited}/>}
  </div>;
}

function TerminalBody({ paneId, visible, onExited }: {
  paneId: string; visible: boolean; onExited(id: string, exited: boolean): void;
}) {
  const { client } = useHost();
  const [terminalId, setId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<{ restart?: string }>({});
  const [exited, setExited] = useState(false);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(visible);
  const publish = useEffectEvent((exited: boolean) => onExited(paneId, exited));
  useEffect(() => { if (visible) setStarted(true); }, [visible]);

  useEffect(() => {
    if (!started) return;
    let stopped = false;
    setError('');
    void client.openWorkbenchTerminal(paneId, attempt.restart).then(({ id }) => {
      if (stopped) return;
      setId(id);
      setExited(false);
      publish(false);
    }).catch(reason => {
      if (!stopped) setError(reason instanceof Error ? reason.message : '터미널을 열지 못했습니다.');
    });
    // The Host owns the binding; unmounting (tab switch or reload) must not kill the PTY.
    return () => { stopped = true; };
  }, [client, paneId, attempt, started]);

  return <div className="workbench-terminal">
    {terminalId ? <TerminalPane key={terminalId} terminalId={terminalId} onExit={() => { setExited(true); onExited(paneId, true); }}/>
      : !error && <p className="workbench-pane-message" role="status">터미널 여는 중…</p>}
    {error ? <InlineError onRetry={() => setAttempt({ ...attempt })} retryLabel="다시 열기">{error}</InlineError>
      : exited && terminalId && <div className="workbench-terminal-exit"><Button size="sm" variant="outline" type="button" disabled={attempt.restart === terminalId}
        onClick={() => setAttempt({ restart: terminalId })}>터미널 다시 열기</Button></div>}
  </div>;
}
