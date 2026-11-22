import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import type { HerdrPaneView, HerdrUpload, HerdrView } from '@ghost/contract';
import { Button, InlineError, SegmentedControl } from '../ui';
import { useHost } from '../host/context';
import { HostError } from '../host/client';
import { HerdrState } from './herdrDisplay';
import { HerdrInputQueue } from './herdrTerminalProtocol';
import { HerdrComposer, useHerdrDraft } from './HerdrComposer';
import { HerdrChangesView, usePaneChanges } from './HerdrChanges';
import { extendedTerminalKeys, modifiedTerminalKey, noModifiers, shellCommand, type TerminalModifiers } from './herdrMobileInput';

const LiveTerminal = lazy(() => import('./HerdrTerminal'));
const HistoryTerminal = lazy(() => import('./HerdrHistory'));
const terminalModes = [{ value: 'live', label: '터미널' }, { value: 'history', label: '기록' }] as const;
const allModes = [...terminalModes, { value: 'changes', label: '변경' }] as const;
type Mode = typeof allModes[number]['value'];

export function useHerdr(revision: number) {
  const { client } = useHost();
  const [view, setView] = useState<HerdrView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let active: AbortController | undefined;
    const pause = () => { clearTimeout(timer); active?.abort(); active = undefined; };
    async function load() {
      if (document.hidden || active) return;
      const request = new AbortController();
      active = request;
      try {
        const next = await client.herdr(request.signal);
        if (!request.signal.aborted) { setView(next); setError(''); }
      } catch (reason) {
        if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : '세션을 불러오지 못했습니다.');
      }
      if (!request.signal.aborted) {
        active = undefined;
        timer = setTimeout(() => void load(), 3000);
      }
    }
    const visibility = () => { if (document.hidden) pause(); else void load(); };
    document.addEventListener('visibilitychange', visibility);
    void load();
    return () => { pause(); document.removeEventListener('visibilitychange', visibility); };
  }, [client, revision]);
  return { view, error };
}

const toolbarKeys = [
  { key: 'esc', label: 'Esc' }, { key: 'tab', label: 'Tab' },
  { key: 'up', label: '↑', name: '위쪽 화살표' }, { key: 'down', label: '↓', name: '아래쪽 화살표' },
  { key: 'left', label: '←', name: '왼쪽 화살표' }, { key: 'right', label: '→', name: '오른쪽 화살표' },
  { key: 'enter', label: 'Enter' }, { key: 'ctrl+c', label: 'Ctrl+C' },
] as const;

export function HerdrPaneBody({ pane, screen, mode, onMode, compact, changes, pending = false, error, onPrompt, onKey,
  onText, modifiers = noModifiers, onModifier, onModifiedKey = () => false, onUpload }: {
  pane: HerdrPaneView; screen: ReactNode; mode: Mode; onMode(mode: Mode): void; compact: boolean; changes?: boolean;
  pending?: boolean; error?: string; onPrompt(text: string): Promise<boolean>; onKey(key: string): void;
  onText?(text: string): void; modifiers?: TerminalModifiers; onModifier?(key: keyof TerminalModifiers): void;
  onModifiedKey?(text: string): boolean; onUpload?(file: File): Promise<HerdrUpload>;
}) {
  const draft = useHerdrDraft(onUpload);
  const field = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLElement>(null);
  const blocked = Boolean(pane.agent && pane.status === 'blocked');
  const working = Boolean(pane.agent && pane.status === 'working');
  const keysVisible = mode === 'live' && (compact || blocked);
  const uploadEnabled = mode !== 'changes' && !pending && !blocked && !working;
  const focusComposer = useEffectEvent(() => {
    if (pane.agent && !compact && mode !== 'changes' && !field.current?.disabled) field.current?.focus({ preventScroll: true });
  });
  useEffect(() => { focusComposer(); }, [pane.id, pane.agent]);
  return <section ref={root} className="coding-detail" aria-label={pane.title}
    onPasteCapture={event => draft.paste(event, uploadEnabled)} onDragOver={draft.drag}
    onDrop={event => draft.drop(event, uploadEnabled)}>
    <header className="coding-detail-head">
      <div className="coding-detail-top">
        <div className="coding-detail-title">
          <h2>{pane.title}</h2>
          <div className="coding-context">{pane.agent && <HerdrState status={pane.status}/>}<span>{pane.agent ?? '셸'}</span><span>{pane.workspace}</span></div>
        </div>
        <div className="herdr-view-actions">
          <SegmentedControl aria-label="터미널 보기" value={mode} options={changes ? allModes : terminalModes} onValueChange={onMode}/>
          {pane.agent && mode !== 'changes' && !keysVisible &&
            <Button type="button" variant="outline" size="sm" aria-label="중단 (Esc)" onClick={() => onKey('esc')}>Esc</Button>}
        </div>
      </div>
      {pane.cwd && <code className="coding-directory" aria-label={`작업 디렉터리 ${pane.cwd}`}>{pane.cwd}</code>}
    </header>
    {screen}
    {(error || mode !== 'changes') && <div className="coding-dock" aria-busy={pending || undefined}>
      {error && <InlineError>{error}</InlineError>}
      {keysVisible && <div className="herdr-keypad" onPointerDown={event => {
        const active = document.activeElement;
        if (active === field.current || active?.classList.contains('xterm-helper-textarea')) event.preventDefault();
      }}>
        <div className="herdr-keys" role="group" aria-label="터미널 키">
          {toolbarKeys.map(item => <Button key={item.key} type="button" variant="outline" size="sm"
            aria-label={'name' in item ? item.name : item.key === 'esc' ? '중단 (Esc)' : undefined}
            onClick={() => onKey(item.key)}>{item.label}</Button>)}
        </div>
        <div className="herdr-keys-extended" role="group" aria-label="보조 터미널 키">
          {(['ctrl', 'alt'] as const).map(key => <Button key={key} type="button" variant="outline" size="sm" aria-pressed={modifiers[key]}
            onClick={() => {
              onModifier?.(key);
              if (!document.activeElement?.classList.contains('xterm-helper-textarea')) {
                const next = field.current && !field.current.disabled ? field.current : root.current?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
                next?.focus({ preventScroll: true });
              }
            }}>{key === 'ctrl' ? 'Ctrl' : 'Alt'}</Button>)}
          {extendedTerminalKeys.map(key => <Button key={key.name} type="button" variant="outline" size="sm"
            aria-label={key.name} onClick={() => onText?.(key.text)}>{key.label}</Button>)}
        </div>
      </div>}
      {mode !== 'changes' && <HerdrComposer shell={!pane.agent} blocked={blocked} working={working} pending={pending}
        draft={draft} field={field} onSubmit={onPrompt} onModifiedKey={onModifiedKey} canUpload={Boolean(onUpload)}/>}
    </div>}
  </section>;
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
  const modifierRef = useRef(noModifiers);
  const [modifiers, setModifiers] = useState(noModifiers);
  const displayed = reply?.snapshot === pane ? reply.pane : pane;
  const { changes, error: changesError, refresh: refreshChanges, revision: changesRevision } = usePaneChanges(displayed);
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
          if (pane.agent) {
            const next = await client.promptHerdr({ pane: id, text });
            if (queue.current === writer) setReply({ snapshot: pane, pane: next });
          } else await client.inputHerdr({ pane: id, text: shellCommand(text) });
          if (queue.current === writer) onChanged();
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
  function sendText(text: string) {
    setError('');
    queue.current?.text(text);
  }
  function setSticky(next: TerminalModifiers) {
    modifierRef.current = next;
    setModifiers(next);
  }
  function modifiedKey(key: string) {
    const text = modifiedTerminalKey(key, modifierRef.current);
    if (text === null) return false;
    setSticky(noModifiers);
    sendText(text);
    return true;
  }
  const changesVisible = changes?.git === true || Boolean(changesError);
  const activeMode = mode === 'changes' && !changesVisible ? 'live' : mode;
  return <HerdrPaneBody pane={displayed} compact={compact} mode={activeMode} onMode={setMode} pending={pending} error={error}
    onPrompt={prompt} onKey={key => { setError(''); queue.current?.key(key); }} onText={sendText}
    onModifiedKey={modifiedKey} modifiers={modifiers} onModifier={key => setSticky({ ...modifierRef.current, [key]: !modifierRef.current[key] })}
    onUpload={file => client.herdrUpload(file)} changes={changesVisible}
    screen={activeMode === 'changes' ? <HerdrChangesView pane={displayed} compact={compact} data={changes} error={changesError}
      onRefresh={refreshChanges} revision={changesRevision}/>
      : <Suspense fallback={<p className="coding-pane-status" role="status">{activeMode === 'history' ? '기록을 불러오는 중…' : '터미널을 불러오는 중…'}</p>}>
        {activeMode === 'history' ? <HistoryTerminal pane={id} onGone={onGone}/>
          : <LiveTerminal pane={id} onData={sendText} onModifiedKey={modifiedKey} onGone={onGone}/>}
      </Suspense>}/>;
}
