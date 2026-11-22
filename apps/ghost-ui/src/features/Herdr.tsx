import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { HerdrOutput, HerdrView } from '@ghost/contract';
import { InlineError } from '../ui';
import { useHost } from '../host/context';
import { HostError } from '../host/client';
import { HerdrState, herdrPanePath } from './codingSessionDisplay';

/** The agents in the owner's herdr sessions, asked again every few seconds while the coding page is open. A Host without herdr answers nothing, and nothing shows. */
export function useHerdr(): HerdrView | null {
  const { client } = useHost();
  const [view, setView] = useState<HerdrView | null>(null);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await client.herdr();
        if (live) setView(next);
      } catch (reason) {
        // Unavailable is a Host that does not offer herdr; any other failure keeps what was last shown.
        if (live && reason instanceof HostError && reason.code === 'unavailable') { setView(null); return; }
      }
      if (live) timer = setTimeout(() => void load(), 4000);
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [client]);
  return view;
}

const cwdName = (cwd: string | null) => cwd?.split('/').filter(Boolean).at(-1) ?? '';

export function HerdrRoster({ view, selected }: { view: HerdrView | null; selected: { session: string; pane: string } | null }) {
  if (!view?.available || (view.panes.length === 0 && !view.note)) return null;
  return <section className="coding-roster-group" aria-label="herdr">
    <h2>herdr</h2>
    {view.panes.length === 0 && <p className="coding-hint">{view.note}</p>}
    <ul>{view.panes.map(pane => {
      const open = selected?.session === pane.session && selected.pane === pane.id;
      return <li key={`${pane.session}/${pane.id}`}><a href={`#${herdrPanePath(pane)}`} aria-current={open ? 'page' : undefined}>
        <strong className="coding-row-title">{pane.title}</strong>
        <HerdrState status={pane.status}/>
        <span className="coding-row-meta"><span>{[pane.agent, pane.workspace].filter(Boolean).join(' · ')}</span>{cwdName(pane.cwd) !== pane.workspace && <code title={pane.cwd ?? undefined}>{cwdName(pane.cwd)}</code>}</span>
      </a></li>;
    })}</ul>
  </section>;
}

function Screen({ text }: { text: string }) {
  const scroller = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [text]);
  return <pre className="herdr-screen" ref={scroller} tabIndex={0} aria-label="터미널 출력" onScroll={event => {
    const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
    pinned.current = scrollHeight - scrollTop - clientHeight <= 24;
  }}>{text}</pre>;
}

export function HerdrPaneBody({ pane, text }: Pick<HerdrOutput, 'pane' | 'text'>) {
  return <section className="coding-detail" aria-label={pane.title}>
    <header className="coding-detail-head">
      <div className="coding-detail-title">
        <h2>{pane.title}</h2>
        <div className="coding-context"><HerdrState status={pane.status}/><span>{pane.agent}</span>{pane.workspace && <span>{pane.workspace}</span>}</div>
      </div>
      {pane.cwd && <code className="coding-directory" aria-label={`작업 디렉터리 ${pane.cwd}`}>{pane.cwd}</code>}
    </header>
    <Screen text={text}/>
  </section>;
}

export function OpenHerdrPane({ session, pane }: { session: string; pane: string }) {
  const { client } = useHost();
  const [output, setOutput] = useState<HerdrOutput | null>(null);
  const [error, setError] = useState<{ message: string; gone: boolean } | null>(null);
  const [attempt, retry] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await client.herdrOutput(session, pane);
        if (!live) return;
        setOutput(next);
        setError(null);
      } catch (reason) {
        if (!live) return;
        const gone = reason instanceof HostError && reason.code === 'not_found';
        setError({ message: gone ? '이 패널은 더 이상 없습니다.' : reason instanceof Error ? reason.message : '터미널을 불러오지 못했습니다.', gone });
        if (gone) return;
      }
      timer = setTimeout(() => void load(), 2000);
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [client, session, pane, attempt]);

  if (output) return <>{error && <InlineError>{error.message}</InlineError>}<HerdrPaneBody pane={output.pane} text={output.text}/></>;
  return <div className="coding-pane-status">{error
    ? <InlineError onRetry={error.gone ? undefined : () => { setError(null); retry(); }} retryLabel="다시 불러오기">{error.message}</InlineError>
    : <p role="status">터미널을 불러오는 중…</p>}</div>;
}
