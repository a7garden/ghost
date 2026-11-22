import { useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { ArrowUp } from 'lucide-react';
import type { HerdrKey, HerdrOutput, HerdrPaneView, HerdrView } from '@ghost/contract';
import { Button, InlineError, Textarea } from '../ui';
import { useHost } from '../host/context';
import { HostError } from '../host/client';
import { HerdrState, herdrPanePath, submitCodingOnShortcut } from './herdrDisplay';

export function useHerdr(revision: number) {
  const { client } = useHost();
  const [view, setView] = useState<HerdrView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const next = await client.herdr();
        if (live) { setView(next); setError(''); }
      } catch (reason) {
        if (live) setError(reason instanceof Error ? reason.message : '세션을 불러오지 못했습니다.');
      }
      if (live) timer = setTimeout(() => void load(), 4000);
    }
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [client, revision]);
  return { view, error };
}

export function groupHerdrPanes(panes: readonly HerdrPaneView[]) {
  const groups = new Map<string, { id: string; workspace: string; panes: HerdrPaneView[] }>();
  for (const pane of panes) {
    // Two workspaces may have the same name; the pane id carries the workspace id.
    const id = pane.id.slice(0, pane.id.indexOf(':'));
    const group = groups.get(id);
    if (group) group.panes.push(pane);
    else groups.set(id, { id, workspace: pane.workspace, panes: [pane] });
  }
  return [...groups.values()];
}

export function HerdrRoster({ panes, selected }: { panes: readonly HerdrPaneView[]; selected: string | null }) {
  return groupHerdrPanes(panes).map(group => <section key={group.id} className="coding-roster-group" aria-label={group.workspace}>
    <h2>{group.workspace}</h2>
    <ul>{group.panes.map(pane => <li key={pane.id}>
      <a href={`#${herdrPanePath(pane.id)}`} aria-current={selected === pane.id ? 'page' : undefined}>
        <strong className="coding-row-title">{pane.title}</strong>
        <HerdrState status={pane.status}/>
        <span className="coding-row-meta">{pane.agent}</span>
      </a>
    </li>)}</ul>
  </section>);
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

const approvalKeys = [
  { key: 'enter', label: 'Enter' }, { key: 'up', label: '↑', name: '위쪽 화살표' }, { key: 'down', label: '↓', name: '아래쪽 화살표' },
  { key: 'y', label: 'Y' }, { key: 'n', label: 'N' }, { key: '1', label: '1' }, { key: '2', label: '2' }, { key: '3', label: '3' },
] as const satisfies readonly { key: HerdrKey; label: string; name?: string }[];

export function HerdrPaneBody({ pane, text, pending, error, onPrompt, onKey }: HerdrOutput & {
  pending?: boolean; error?: string; onPrompt(text: string): Promise<boolean>; onKey(key: HerdrKey): void;
}) {
  const [draft, setDraft] = useState('');
  const blocked = pane.status === 'blocked';
  const working = pane.status === 'working';
  const disabled = pending || blocked || working;
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!disabled && text && await onPrompt(text)) setDraft('');
  }
  return <section className="coding-detail" aria-label={pane.title}>
    <header className="coding-detail-head">
      <div className="coding-detail-top">
        <div className="coding-detail-title">
          <h2>{pane.title}</h2>
          <div className="coding-context"><HerdrState status={pane.status}/><span>{pane.agent}</span><span>{pane.workspace}</span></div>
        </div>
        <Button type="button" variant="outline" size="sm" aria-label="중단 (Esc)" disabled={pending} onClick={() => onKey('esc')}>Esc</Button>
      </div>
      {pane.cwd && <code className="coding-directory" aria-label={`작업 디렉터리 ${pane.cwd}`}>{pane.cwd}</code>}
    </header>
    <Screen text={text}/>
    <div className="coding-dock" aria-busy={pending || undefined}>
      {error && <InlineError>{error}</InlineError>}
      {blocked && <div className="herdr-keys" role="group" aria-label="승인 응답 키">
        {approvalKeys.map(item => <Button key={item.key} type="button" variant="outline" size="sm"
          aria-label={'name' in item ? item.name : undefined} disabled={pending} onClick={() => onKey(item.key)}>{item.label}</Button>)}
      </div>}
      <form className="coding-compose" onSubmit={event => void send(event)}>
        <Textarea aria-label="후속 지시" placeholder={blocked ? '승인에 먼저 답하세요' : working ? '에이전트가 작업 중입니다' : '후속 지시'}
          rows={1} maxLength={24_000} value={draft} disabled={disabled} onChange={event => setDraft(event.currentTarget.value)}
          aria-keyshortcuts="Meta+Enter Control+Enter" onKeyDown={submitCodingOnShortcut}/>
        <Button type="submit" size="icon" aria-label="보내기" disabled={disabled || !draft.trim()}><ArrowUp aria-hidden="true"/></Button>
      </form>
    </div>
  </section>;
}

export function OpenHerdrPane({ pane, onChanged }: { pane: string; onChanged(): void }) {
  const { client } = useHost();
  const [output, setOutput] = useState<HerdrOutput | null>(null);
  const [readError, setReadError] = useState<{ message: string; gone: boolean } | null>(null);
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [attempt, retry] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (pending) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const next = await client.herdrOutput(pane);
        if (!live || busy.current) return;
        setOutput(next);
        setReadError(null);
      } catch (reason) {
        if (!live || busy.current) return;
        const gone = reason instanceof HostError && reason.code === 'not_found';
        setReadError({ message: gone ? '이 패널은 더 이상 없습니다.' : reason instanceof Error ? reason.message : '터미널을 불러오지 못했습니다.', gone });
        if (gone) { setOutput(null); return; }
      }
      timer = setTimeout(() => void load(), 2000);
    }
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [client, pane, attempt, pending]);

  async function act(action: { text: string } | { key: HerdrKey }): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setActionError('');
    try {
      const next = 'key' in action ? await client.herdrKeys({ pane, keys: [action.key] }) : await client.promptHerdr({ pane, text: action.text });
      setOutput(current => current && { ...current, pane: next });
      onChanged();
      return true;
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : '패널에 입력을 보내지 못했습니다.');
      return false;
    } finally { busy.current = false; setPending(false); }
  }

  if (output) return <HerdrPaneBody {...output} pending={pending} error={actionError || readError?.message}
    onPrompt={text => act({ text })} onKey={key => void act({ key })}/>;
  return <div className="coding-pane-status">{readError
    ? readError.gone ? <InlineError>{readError.message}</InlineError>
      : <InlineError onRetry={() => { setReadError(null); retry(); }} retryLabel="다시 불러오기">{readError.message}</InlineError>
    : <p role="status">터미널을 불러오는 중…</p>}</div>;
}
