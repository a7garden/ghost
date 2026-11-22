import { lazy, Suspense, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUp } from 'lucide-react';
import type { HerdrPaneView, HerdrView } from '@ghost/contract';
import { Button, InlineError, SegmentedControl, Textarea } from '../ui';
import { useHost } from '../host/context';
import { HostError } from '../host/client';
import { HerdrState, submitCodingOnShortcut } from './herdrDisplay';
import { HerdrInputQueue } from './herdrTerminalProtocol';

const LiveTerminal = lazy(() => import('./HerdrTerminal'));
const modes = [{ value: 'live', label: '터미널' }, { value: 'history', label: '기록' }] as const;
type Mode = typeof modes[number]['value'];

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
      if (live) timer = setTimeout(() => void load(), 3000);
    }
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [client, revision]);
  return { view, error };
}

export function HerdrHistoryText({ text }: { text: string }) {
  const scroller = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [text]);
  return <pre className="herdr-screen" ref={scroller} tabIndex={0} aria-label="터미널 기록" onScroll={event => {
    const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
    pinned.current = scrollHeight - scrollTop - clientHeight <= 24;
  }}>{text}</pre>;
}

const toolbarKeys = [
  { key: 'esc', label: 'Esc' }, { key: 'tab', label: 'Tab' },
  { key: 'up', label: '↑', name: '위쪽 화살표' }, { key: 'down', label: '↓', name: '아래쪽 화살표' },
  { key: 'left', label: '←', name: '왼쪽 화살표' }, { key: 'right', label: '→', name: '오른쪽 화살표' },
  { key: 'enter', label: 'Enter' }, { key: 'ctrl+c', label: 'Ctrl+C' },
] as const;

export function HerdrPaneBody({ pane, screen, mode, onMode, compact, pending, error, onPrompt, onKey }: {
  pane: HerdrPaneView; screen: ReactNode; mode: Mode; onMode(mode: Mode): void; compact: boolean;
  pending?: boolean; error?: string; onPrompt(text: string): Promise<boolean>; onKey(key: string): void;
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
          <div className="coding-context">{pane.agent && <HerdrState status={pane.status}/>}<span>{pane.agent ?? '셸'}</span><span>{pane.workspace}</span></div>
        </div>
        <div className="herdr-view-actions">
          <SegmentedControl aria-label="터미널 보기" value={mode} options={modes} onValueChange={onMode}/>
          {pane.agent && !(mode === 'live' && (compact || blocked)) &&
            <Button type="button" variant="outline" size="sm" aria-label="중단 (Esc)" onClick={() => onKey('esc')}>Esc</Button>}
        </div>
      </div>
      {pane.cwd && <code className="coding-directory" aria-label={`작업 디렉터리 ${pane.cwd}`}>{pane.cwd}</code>}
    </header>
    {screen}
    {(error || (mode === 'live' && (compact || blocked)) || pane.agent) && <div className="coding-dock" aria-busy={pending || undefined}>
      {error && <InlineError>{error}</InlineError>}
      {mode === 'live' && (compact || blocked) && <div className="herdr-keys" role="group" aria-label="터미널 키"
        onPointerDown={event => {
          if (document.activeElement?.classList.contains('xterm-helper-textarea')) event.preventDefault();
        }}>
        {toolbarKeys.map(item => <Button key={item.key} type="button" variant="outline" size="sm"
          aria-label={'name' in item ? item.name : item.key === 'esc' ? '중단 (Esc)' : undefined}
          onClick={() => onKey(item.key)}>{item.label}</Button>)}
      </div>}
      {pane.agent && <form className="coding-compose" onSubmit={event => void send(event)}>
        <Textarea aria-label="후속 지시" placeholder={blocked ? '승인에 먼저 답하세요' : working ? '에이전트가 작업 중입니다' : '후속 지시'}
          rows={1} maxLength={24_000} value={draft} disabled={disabled} onChange={event => setDraft(event.currentTarget.value)}
          aria-keyshortcuts="Meta+Enter Control+Enter" onKeyDown={submitCodingOnShortcut}/>
        <Button type="submit" size="icon" aria-label="보내기" disabled={disabled || !draft.trim()}><ArrowUp aria-hidden="true"/></Button>
      </form>}
    </div>}
  </section>;
}

function HerdrHistory({ pane, onGone }: { pane: string; onGone(): void }) {
  const { client } = useHost();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const gone = useEffectEvent(onGone);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const output = await client.herdrOutput(pane);
        if (!live) return;
        setText(output.text);
        setError('');
      } catch (reason) {
        if (!live) return;
        if (reason instanceof HostError && reason.code === 'not_found') { gone(); return; }
        setError(reason instanceof Error ? reason.message : '기록을 불러오지 못했습니다.');
      }
      timer = setTimeout(() => void load(), 2000);
    }
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [client, pane]);
  return <>
    {error && <InlineError className="m-2">{error}</InlineError>}
    {text !== null ? <HerdrHistoryText text={text}/> : !error && <p role="status" className="coding-pane-status">기록을 불러오는 중…</p>}
  </>;
}

export function OpenHerdrPane({ pane, compact, onChanged, onGone }: {
  pane: HerdrPaneView; compact: boolean; onChanged(): void; onGone(): void;
}) {
  const { client } = useHost();
  const [mode, setMode] = useState<Mode>('live');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [reply, setReply] = useState<{ snapshot: HerdrPaneView; pane: HerdrPaneView } | null>(null);
  const queue = useRef<HerdrInputQueue | null>(null);
  const busy = useRef(false);
  const changed = useEffectEvent((input: { text?: string; keys?: string[] }) => {
    if (input.keys || /[\r\x03\x1b]/.test(input.text ?? '') || (pane.status === 'blocked' && /^[yn123]$/i.test(input.text ?? ''))) onChanged();
  });
  const gone = useEffectEvent(onGone);
  const id = pane.id;

  useEffect(() => {
    let live = true;
    const writer = new HerdrInputQueue(async input => {
      await client.inputHerdr({ pane: id, ...input });
      if (live) changed(input);
    }, reason => {
      if (reason instanceof HostError && reason.code === 'not_found') gone();
      else setError(reason instanceof Error ? reason.message : '패널에 입력을 보내지 못했습니다.');
    });
    queue.current = writer;
    return () => { live = false; writer.close(); queue.current = null; };
  }, [client, id]);

  async function prompt(text: string) {
    const writer = queue.current;
    if (!writer || busy.current) return false;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      return await writer.afterInput(async () => {
        try {
          const next = await client.promptHerdr({ pane: id, text });
          if (queue.current === writer) { setReply({ snapshot: pane, pane: next }); onChanged(); }
          return true;
        } catch (reason) {
          if (queue.current === writer) {
            if (reason instanceof HostError && reason.code === 'not_found') onGone();
            else {
              setError(reason instanceof Error ? reason.message : '지시를 보내지 못했습니다.');
              onChanged();
            }
          }
          return false;
        }
      });
    } finally { busy.current = false; setPending(false); }
  }
  const displayed = reply?.snapshot === pane ? reply.pane : pane;
  return <HerdrPaneBody pane={displayed} compact={compact} mode={mode} onMode={setMode} pending={pending} error={error}
    onPrompt={prompt} onKey={key => { setError(''); queue.current?.key(key); }}
    screen={mode === 'history' ? <HerdrHistory pane={id} onGone={onGone}/>
      : <Suspense fallback={<p className="coding-pane-status" role="status">터미널을 불러오는 중…</p>}>
        <LiveTerminal pane={id} onData={data => { setError(''); queue.current?.text(data); }} onGone={onGone}/>
      </Suspense>}/>;
}
