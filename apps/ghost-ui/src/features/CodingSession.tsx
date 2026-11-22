import { useEffect, useReducer, useState } from 'react';
import { Plus } from 'lucide-react';
import type { CodingSessionView, Scope } from '@ghost/contract';
import { Button, InlineError, SettingsGroup, SettingsRow } from '../ui';
import { useHost } from '../host/context';
import { NewCodingSession } from './CodingSessionStart';
import { OpenCodingSession } from './CodingSessionDetail';
import { codingAgentName, firstTaskLine, parseHerdrPane, SessionState } from './codingSessionDisplay';
import { HerdrRoster, OpenHerdrPane, useHerdr } from './Herdr';
import { absoluteTime, relativeTime, useNow } from './time';
import './coding-session.css';

export function codingSessionPath(id: string) {
  return `/coding?session=${encodeURIComponent(id)}`;
}

export function CodingPage({ scopes, sessionId, herdrPane, creating, onStarted, onCancel, compact }: {
  scopes: Scope[]; sessionId: string | null; herdrPane: string | null; creating: boolean; compact: boolean;
  onStarted(id: string): void; onCancel(): void;
}) {
  const { client } = useHost();
  const [sessions, setSessions] = useState<CodingSessionView[] | null>(null);
  const [error, setError] = useState('');
  const [revision, refresh] = useReducer((count: number) => count + 1, 0);
  const now = useNow();
  const herdr = useHerdr();
  const openHerdr = herdrPane === null ? null : parseHerdrPane(herdrPane);
  useEffect(() => {
    let live = true, running = false, timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await client.codingSessions();
        if (!live) return;
        setSessions(result.sessions);
        setError('');
        running = result.sessions.some(session => session.state === 'running');
      } catch (reason) {
        if (!live) return;
        setError(reason instanceof Error ? reason.message : '세션 목록을 불러오지 못했습니다.');
      }
      if (running) timer = setTimeout(() => void load(), 5000);
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [client, revision]);

  const groups = [
    { label: '진행 중', rows: sessions?.filter(session => session.state === 'running') },
    { label: '최근 세션', rows: sessions?.filter(session => session.state !== 'running') },
  ];
  const showDetail = creating || sessionId !== null || herdrPane !== null;
  return <div className="coding-page" data-compact={compact || undefined} data-detail={showDetail || undefined}>
    <section className="coding-roster" aria-label="코딩 세션">
      <header className="coding-roster-head">
        <h1>코딩</h1><Button asChild variant={creating ? 'secondary' : 'default'}><a href="#/coding?new=1" aria-current={creating ? 'page' : undefined}><Plus aria-hidden="true"/>새 코딩 세션</a></Button>
      </header>
      <div className="coding-roster-scroll">
        {error && <InlineError onRetry={refresh} retryLabel="다시 불러오기">{error}</InlineError>}
        {!sessions && !error && <p role="status" className="coding-hint">세션을 불러오는 중…</p>}
        {sessions?.length === 0 && !error && <p className="coding-hint">아직 코딩 세션이 없습니다.</p>}
        {groups.map(({ label, rows }) => rows?.length ? <section key={label} className="coding-roster-group">
          <h2>{label}</h2>
          <ul>{rows.map(item => {
            const place = item.branch ?? item.cwd.split('/').filter(Boolean).at(-1) ?? item.cwd;
            const time = item.endedAt ?? item.startedAt;
            return <li key={item.id}><a href={`#${codingSessionPath(item.id)}`} aria-current={!creating && sessionId === item.id ? 'page' : undefined}>
              <strong className="coding-row-title">{firstTaskLine(item.task)}</strong>
              <SessionState state={item.state}/>
              <span className="coding-row-meta"><span>{codingAgentName[item.agent]}</span><code title={place}>{place}</code></span>
              <time dateTime={new Date(time).toISOString()} title={absoluteTime(time)}>{relativeTime(time, now)}</time>
            </a></li>;
          })}</ul>
        </section> : null)}
        <HerdrRoster view={herdr} selected={openHerdr}/>
      </div>
    </section>
    {showDetail ? <div className="coding-pane">
      {creating ? <NewCodingSession scopes={scopes} sessions={sessions ?? []} onCancel={onCancel}
        onStarted={started => { refresh(); onStarted(started.session.id); }}/>
        : openHerdr ? <OpenHerdrPane key={herdrPane} session={openHerdr.session} pane={openHerdr.pane}/>
        : herdrPane !== null ? <div className="coding-pane-status"><p role="alert">herdr 패널 주소가 올바르지 않습니다.</p></div>
        : <OpenCodingSession key={sessionId} id={sessionId!} onChanged={refresh}/>}
    </div> : <div className="coding-pane coding-unselected"><p className="coding-hint">세션을 선택하세요.</p></div>}
  </div>;
}

export function RecentCodingSessions() {
  return <SettingsGroup title="최근 세션">
    <SettingsRow label="코딩 세션"><Button asChild variant="outline" size="sm"><a href="#/coding">세션 목록 보기</a></Button></SettingsRow>
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
  return <a className="link-quiet" href={`#${codingSessionPath(sessionId)}`}>세션 보기</a>;
}
