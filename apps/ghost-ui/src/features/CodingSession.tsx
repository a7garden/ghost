import { useCallback, useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { CodingAgentId, CodingSessionView, CodingStep } from '@ghost/contract';
import { Badge, Button, InlineError, SettingsGroup, SettingsRow } from '../ui';
import { Modal } from '../components/Modal';
import { useHost } from '../host/context';
import { absoluteTime, relativeTime, useNow } from './time';

const agentName: Record<CodingAgentId, string> = { omp: 'omp', claude: 'Claude Code', codex: 'Codex' };
const stateLabel: Record<CodingSessionView['state'], string> = { running: '진행 중', done: '완료', failed: '실패', interrupted: '중단됨' };
const stateBadge: Record<CodingSessionView['state'], 'default' | 'success' | 'danger' | 'warning'> = { running: 'default', done: 'success', failed: 'danger', interrupted: 'warning' };
const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';

/** What a session shows: where it ran, how to carry on by hand, and each step of the agent. */
export function CodingSessionBody({ session, steps }: { session: CodingSessionView; steps: CodingStep[] }) {
  const [copied, setCopied] = useState(false);
  const copy = (value: string) => { void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => {}); };
  return <div className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={stateBadge[session.state]}>{stateLabel[session.state]}</Badge>
      <span className="text-caption text-ink-3">{agentName[session.agent]} · {absoluteTime(session.startedAt)}</span>
    </div>
    <details className="text-caption text-ink-2">
      <summary className="cursor-pointer">{firstLine(session.task)}</summary>
      <p className="mt-2 mb-0 whitespace-pre-wrap break-words">{session.task}</p>
    </details>
    <dl className="m-0 grid gap-1 text-caption text-ink-3">
      {session.branch && <div className="flex gap-2"><dt className="shrink-0">브랜치</dt><dd className="m-0 break-all font-mono">{session.branch}</dd></div>}
      <div className="flex gap-2"><dt className="shrink-0">위치</dt><dd className="m-0 break-all font-mono">{session.cwd}</dd></div>
    </dl>
    {session.resumeCommand && <div className="flex items-start gap-2 rounded-control bg-inset p-2">
      <code className="min-w-0 flex-1 break-all font-mono text-caption text-ink-2" aria-label="이어받기 명령">{session.resumeCommand}</code>
      <Button variant="outline" size="sm" type="button" onClick={() => copy(session.resumeCommand!)}>{copied ? <Check/> : <Copy/>}{copied ? '복사됨' : '복사'}</Button>
    </div>}
    <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label="세션 기록">
      {steps.map((step, index) => <li key={index} data-kind={step.kind}>
        {step.kind === 'say' && <p className="m-0 whitespace-pre-wrap break-words">{step.text}</p>}
        {step.kind === 'tool' && <p className="m-0 break-all font-mono text-caption text-ink-2"><span aria-hidden className="text-ink-3">› </span>{step.text}</p>}
        {step.kind === 'result' && <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-control bg-inset p-2 font-mono text-micro text-ink-3">{step.text}</pre>}
        {step.kind === 'note' && <p className="m-0 whitespace-pre-wrap break-words text-caption text-amber-ink">{step.text}</p>}
      </li>)}
      {steps.length === 0 && <li className="text-caption text-ink-3">{session.state === 'running' ? '아직 한 일이 없습니다.' : '남은 기록이 없습니다.'}</li>}
    </ol>
  </div>;
}

/** One session, opened from where the owner found it. A running one is followed as it goes. */
export function CodingSessionDialog({ id, onClose }: { id: string; onClose(): void }) {
  const { client } = useHost();
  const [view, setView] = useState<{ session: CodingSessionView; steps: CodingStep[] } | null>(null);
  const [error, setError] = useState('');
  const running = view?.session.state === 'running';
  const count = view?.steps.length ?? 0;

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const next = await client.codingSession(id, count);
        if (live) setView(current => ({ session: next.session, steps: current ? [...current.steps, ...next.steps] : next.steps }));
      } catch (reason) {
        if (live) setError(reason instanceof Error ? reason.message : '세션을 불러오지 못했습니다.');
      }
    };
    if (view === null) { void load(); return () => { live = false; }; }
    if (!running) return () => { live = false; };
    const timer = setTimeout(() => void load(), 2000);
    return () => { live = false; clearTimeout(timer); };
  }, [client, id, view, running, count]);

  return <Modal title="코딩 세션" onClose={onClose} className="sm:max-w-3xl">
    {error && <InlineError>{error}</InlineError>}
    {view && <CodingSessionBody session={view.session} steps={view.steps}/>}
  </Modal>;
}

/** 최근 세션: every code_run on this Mac, newest first. */
export function RecentCodingSessions() {
  const { client } = useHost();
  const now = useNow();
  const [sessions, setSessions] = useState<CodingSessionView[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const anyRunning = sessions?.some(session => session.state === 'running') ?? false;
  const load = useCallback(async () => {
    try { setSessions((await client.codingSessions()).sessions); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '세션 목록을 불러오지 못했습니다.'); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [anyRunning, load]);

  return <SettingsGroup title="최근 세션">
    {error && <InlineError>{error}</InlineError>}
    {sessions?.length === 0 && <p className="m-0 text-caption text-ink-3">아직 코딩 에이전트에게 맡긴 일이 없습니다.</p>}
    {sessions?.map(session => <SettingsRow key={session.id}
      label={<span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words">{firstLine(session.task)}</span>
        <Badge variant={stateBadge[session.state]}>{stateLabel[session.state]}</Badge>
      </span>}
      description={`${agentName[session.agent]} · ${relativeTime(session.endedAt ?? session.startedAt, now)}${session.branch ? ` · ${session.branch}` : ''}`}>
      <Button variant="outline" size="sm" type="button" onClick={() => setOpen(session.id)}>열기</Button>
    </SettingsRow>)}
    {open && <CodingSessionDialog id={open} onClose={() => setOpen(null)}/>}
  </SettingsGroup>;
}

/**
 * The link from a code_run in a Work's record to its session. The session is opened before the agent starts, so a
 * run still going has one; the Host is asked every few seconds until it answers, and nothing shows if it never does
 * (a session older than the Host keeps them, or a run from before sessions were kept).
 */
export function CodeRunSessionLink({ workId, callId, running }: { workId: string; callId: string; running: boolean }) {
  const { client } = useHost();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (sessionId !== null) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      let found: string | null = null;
      try { found = (await client.codingSessions(workId)).sessions.find(session => session.callId === callId)?.id ?? null; } catch { /* the next look tries again */ }
      if (!live) return;
      if (found !== null) setSessionId(found);
      else if (running) timer = setTimeout(() => void look(), 3000);
    };
    void look();
    return () => { live = false; clearTimeout(timer); };
  }, [client, workId, callId, running, sessionId]);

  if (sessionId === null) return null;
  return <>
    <button type="button" className="link-quiet" onClick={() => setOpen(true)}>세션 보기</button>
    {open && <CodingSessionDialog id={sessionId} onClose={() => setOpen(false)}/>}
  </>;
}
