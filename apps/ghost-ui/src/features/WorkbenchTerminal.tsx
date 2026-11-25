import { useEffect, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { useHost } from '../host/context';
import { Button, InlineError } from '../ui';
import { codingError } from './CodingSessionModel';
import { directoryName } from './CodingModel';
import { TerminalPane } from './TerminalPane';

// The Host lists a terminal by its real path; remember which one this folder opened so a symlinked folder finds it again.
const opened = new Map<string, string>();

/**
 * The owner's shell in a folder, opened on demand. Hiding keeps the shell running and showing it again re-attaches to
 * it; 종료 ends it. Nothing here starts a terminal by itself.
 */
export function WorkbenchTerminal({ cwd, onHide }: { cwd: string; onHide(): void }) {
  const { client } = useHost();
  const [id, setId] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setId(null); setExited(false); setError('');
    void (async () => {
      const live = (await client.terminals(controller.signal)).filter(view => view.state !== 'exited' && !view.agent);
      const known = opened.get(cwd);
      const open = live.find(view => view.id === known) ?? live.find(view => view.cwd === cwd);
      const terminal = open ?? await client.createTerminal({ cwd, cols: 80, rows: 24 });
      if (controller.signal.aborted) {
        if (!open) void client.closeTerminal(terminal.id).catch(() => {});
        return;
      }
      opened.set(cwd, terminal.id);
      setId(terminal.id);
    })().catch(reason => {
      if (!controller.signal.aborted) setError(codingError(reason, '터미널을 열지 못했습니다.'));
    });
    return () => controller.abort();
  }, [client, cwd, attempt]);

  async function end() {
    try {
      if (id) await client.closeTerminal(id);
      opened.delete(cwd);
      onHide();
    } catch (reason) {
      setError(codingError(reason, '터미널을 종료하지 못했습니다.'));
    }
  }

  return <section className="workbench-terminal" aria-label="터미널">
    <header>
      <h2 title={cwd}>터미널 <small>{directoryName(cwd)}</small></h2>
      {exited && <Button variant="ghost" size="sm" type="button" onClick={() => setAttempt(value => value + 1)}>다시 열기</Button>}
      <Button variant="ghost" size="icon" type="button" aria-label="터미널 숨기기" title="숨기기" onClick={onHide}><ChevronDown aria-hidden="true"/></Button>
      <Button variant="ghost" size="icon" type="button" aria-label="터미널 종료" title="종료" onClick={() => void end()}><X aria-hidden="true"/></Button>
    </header>
    <div className="workbench-terminal__body">
      {error ? <InlineError onRetry={() => setAttempt(value => value + 1)} retryLabel="다시 열기">{error}</InlineError>
        : id ? <TerminalPane key={id} terminalId={id} onExit={() => setExited(true)}/>
        : <p className="workbench-empty" role="status">터미널 여는 중…</p>}
    </div>
  </section>;
}
