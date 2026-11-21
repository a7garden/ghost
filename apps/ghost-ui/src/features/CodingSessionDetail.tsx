import { memo, useEffect, useId, useLayoutEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, Check, ChevronRight, Copy, GitBranch, Square, Terminal } from 'lucide-react';
import type { CodingSessionDetail, CodingSessionView, CodingStep } from '@ghost/contract';
import { Button, InlineError, Textarea } from '../ui';
import { useHost } from '../host/context';
import { submitCodingOnShortcut } from './CodingSessionStart';
import { codingAgentName, firstTaskLine, SessionState } from './codingSessionDisplay';

/** Plain text and fenced code, never agent-supplied HTML. */
function AgentProse({ text }: { text: string }) {
  const parts = text.split(/^[ \t]*`{3,}[^\r\n`]*\r?$\n?/m);
  return parts.map((part, index) => {
    const content = index % 2 ? part.replace(/\r?\n$/, '') : part.trim();
    if (!content) return null;
    return index % 2 ? <pre key={index} tabIndex={0}><code>{content}</code></pre> : <p key={index}>{content}</p>;
  });
}

const CodingTranscript = memo(function CodingTranscript({ steps, openingTask, running }: { steps: CodingStep[]; openingTask: string | null; running: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [steps]);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    // The app shell follows the visual viewport on phones, including when the keyboard opens.
    const observer = new ResizeObserver(() => { if (pinned.current) node.scrollTop = node.scrollHeight; });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div className="coding-transcript-scroll" ref={scroller} onScroll={event => {
    const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
    pinned.current = scrollHeight - scrollTop - clientHeight <= 24;
  }}>
    <ol className="coding-transcript" aria-label="세션 기록">
      {openingTask !== null && <li className="coding-transcript__task"><span className="sr-only">첫 지시: </span><p>{openingTask}</p></li>}
      {steps.map((step, index) => <li key={index} data-kind={step.kind}>
        {step.kind === 'user' && <><span className="sr-only">내 메시지: </span><p>{step.text}</p></>}
        {step.kind === 'say' && <AgentProse text={step.text}/>}
        {step.kind === 'tool' && <code tabIndex={0}><Terminal aria-hidden="true"/>{step.text.replace(/\s*\r?\n\s*/g, ' ')}</code>}
        {step.kind === 'result' && <details>
          <summary><span><ChevronRight aria-hidden="true"/>도구 결과</span><code aria-hidden="true">{step.text}</code></summary>
          <pre>{step.text}</pre>
        </details>}
        {step.kind === 'note' && <p>{step.text}</p>}
      </li>)}
      {steps.length === 0 && <li className="coding-hint">{running ? '아직 에이전트 기록이 없습니다.' : '남은 기록이 없습니다.'}</li>}
    </ol>
  </div>;
});

function ResumeCommand({ command, reveal }: { command: string; reveal: boolean }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setError(false); setCopied(true); }
    catch { setError(true); }
  };
  return <div className="coding-resume">
    <Button variant="ghost" type="button" onClick={() => void copy()} aria-label={copied ? '이어받기 명령 복사됨' : '이어받기 명령 복사'} title="이어받기 명령 복사">
      {copied ? <Check aria-hidden="true"/> : <Copy aria-hidden="true"/>}<span>{copied ? '복사됨' : '이어받기 명령'}</span>
    </Button>
    {(reveal || error) && <code aria-label="이어받기 명령">{command}</code>}
    {error && <span role="alert">명령을 자동으로 복사하지 못했습니다.</span>}
  </div>;
}

export function CodingSessionBody({ session, steps, pending, error, onSend, onStop }: {
  session: CodingSessionView; steps: CodingStep[]; pending?: boolean; error?: string;
  onSend(text: string): Promise<boolean>; onStop(): void;
}) {
  const [draft, setDraft] = useState('');
  const titleId = useId();
  const running = session.state === 'running';
  const continuable = Boolean(session.nativeId);
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!running && continuable && !pending && text && await onSend(text)) setDraft('');
  };
  return <section className="coding-detail" aria-labelledby={titleId}>
    <header className="coding-detail-head">
      <div className="coding-detail-top">
        <div className="coding-detail-title">
          <h2 id={titleId}>{firstTaskLine(session.task)}</h2>
          <div className="coding-context">
            <SessionState state={session.state}/><span>{codingAgentName[session.agent]}</span>
            {session.branch && <code aria-label={`브랜치 ${session.branch}`}><GitBranch aria-hidden="true"/>{session.branch}</code>}
          </div>
        </div>
        <div className="coding-detail-actions">
          {session.resumeCommand && (continuable || running)
            && <ResumeCommand key={session.resumeCommand} command={session.resumeCommand} reveal={false}/>}
          {running && <Button variant="outline" type="button" onClick={onStop} disabled={pending}><Square aria-hidden="true"/>중지</Button>}
        </div>
      </div>
      <code className="coding-directory" aria-label={`작업 디렉터리 ${session.cwd}`}>{session.cwd}</code>
    </header>
    <CodingTranscript steps={steps} openingTask={session.workId !== null || steps[0]?.kind !== 'user' ? session.task : null} running={running}/>
    <footer className="coding-dock">
      {error && <InlineError>{error}</InlineError>}
      {running || continuable ? <form className="coding-compose" onSubmit={event => void send(event)}>
        <Textarea className="disabled:bg-inset disabled:opacity-100" value={draft} onChange={event => setDraft(event.currentTarget.value)} maxLength={24_000} rows={2}
          onKeyDown={submitCodingOnShortcut} aria-keyshortcuts="Meta+Enter Control+Enter" aria-label="후속 메시지" disabled={running || pending}
          placeholder={running ? '에이전트가 작업 중입니다' : '후속 메시지'}/>
        <Button type="submit" size="icon" disabled={running || pending || !draft.trim()} aria-label="보내기" title="보내기"><ArrowUp aria-hidden="true"/></Button>
      </form> : session.resumeCommand
        ? <ResumeCommand key={session.resumeCommand} command={session.resumeCommand} reveal/>
        : <p className="coding-hint">에이전트 세션 ID가 없어 이어갈 수 없습니다.</p>}
    </footer>
  </section>;
}

export function OpenCodingSession({ id, onChanged }: { id: string; onChanged(): void }) {
  const { client } = useHost();
  const [detail, setDetail] = useState<CodingSessionDetail | null>(null);
  const cursor = useRef(0);
  const mutating = useRef(false);
  const mutationVersion = useRef(0);
  const [pending, setPending] = useState(false);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [attempt, retry] = useReducer((count: number) => count + 1, 0);
  const running = detail?.session.state === 'running';
  const loaded = detail !== null;
  useEffect(() => {
    if (pending || (loaded && !running)) return;
    let live = true, timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (mutating.current) return;
      const version = mutationVersion.current;
      let follow = running;
      try {
        const update = await client.codingSession(id, cursor.current);
        if (!live || version !== mutationVersion.current) return;
        cursor.current = update.next;
        follow = update.session.state === 'running';
        setDetail(previous => ({
          ...update,
          steps: !previous ? update.steps : update.steps.length ? [...previous.steps, ...update.steps] : previous.steps,
        }));
        setReadError('');
      } catch (reason) {
        if (!live || version !== mutationVersion.current) return;
        setReadError(reason instanceof Error ? reason.message : '세션을 불러오지 못했습니다.');
      }
      if (follow) timer = setTimeout(() => void load(), 2000);
    };
    if (loaded) timer = setTimeout(() => void load(), 2000);
    else void load();
    return () => { live = false; clearTimeout(timer); };
  }, [client, id, pending, loaded, running, attempt]);

  const change = async (text?: string) => {
    if (mutating.current) return false;
    mutating.current = true;
    mutationVersion.current++;
    setPending(true);
    setActionError('');
    try {
      // POST returns the whole record, unlike the incremental GET.
      const updated = text === undefined ? await client.stopCodingSession(id) : await client.sendCodingSession(id, text);
      cursor.current = updated.next;
      setDetail(updated);
      setReadError('');
      onChanged();
      return true;
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : text === undefined ? '세션을 중지하지 못했습니다.' : '메시지를 보내지 못했습니다.');
      return false;
    } finally { mutating.current = false; setPending(false); }
  };
  return detail ? <CodingSessionBody session={detail.session} steps={detail.steps} pending={pending}
    error={actionError || readError} onSend={change} onStop={() => void change()}/>
    : <div className="coding-pane-status">{readError
      ? <InlineError onRetry={() => { setReadError(''); retry(); }} retryLabel="다시 불러오기">{readError}</InlineError>
      : <p role="status">세션을 불러오는 중…</p>}</div>;
}
