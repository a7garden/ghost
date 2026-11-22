import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import type { HerdrPaneView, HerdrUpload, HerdrView } from '@ghost/contract';
import { useHost } from '../host/context';
import { HostError } from '../host/client';
import { haptic } from '../host/shell';
import { Button, InlineError } from '../ui';
import { HerdrInputQueue } from './herdrTerminalProtocol';
import { HerdrComposer, useHerdrDraft } from './HerdrComposer';
import { HerdrChangesView, usePaneChanges } from './HerdrChanges';
import { modifiedTerminalKey, noModifiers, shellCommand, type TerminalModifiers } from './herdrMobileInput';
import { HerdrAskCard, type HerdrAsks } from './HerdrAsk';
import { HerdrConversation, useHerdrChat } from './HerdrChat';
import { CodingSkeleton } from './HerdrInbox';
import { readCodingValue, writeCodingValue } from './herdrInboxModel';
import { HerdrPaneHeader, herdrModes, type HerdrMode, type PaneNavigation } from './HerdrPaneHeader';
import { readTerminalSize, TerminalKeyRail } from './HerdrTerminalControls';

const LiveTerminal = lazy(() => import('./HerdrTerminal'));
const HistoryTerminal = lazy(() => import('./HerdrHistory'));

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

export function HerdrPaneBody({ pane, screen, mode, onMode, compact, changes = false, chat = false, pending = false, error,
  onPrompt, onKey, onText, modifiers = noModifiers, onModifier, onModifiedKey = () => false, onUpload, fontSize = 13, onFontSize,
  branch, navigation, asks, draftKey }: {
  pane: HerdrPaneView; screen: ReactNode; mode: HerdrMode; onMode(mode: HerdrMode): void; compact: boolean;
  changes?: boolean; chat?: boolean; pending?: boolean; error?: string;
  onPrompt(text: string): Promise<boolean>; onKey(key: string): void;
  onText?(text: string): void; modifiers?: TerminalModifiers; onModifier?(key: keyof TerminalModifiers): void;
  onModifiedKey?(text: string): boolean; onUpload?(file: File): Promise<HerdrUpload>;
  fontSize?: number; onFontSize?(size: number): void; branch?: string | null; navigation?: PaneNavigation;
  asks?: HerdrAsks; draftKey?: string;
}) {
  const draft = useHerdrDraft(draftKey, onUpload);
  const field = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLElement>(null);
  const blocked = Boolean(pane.agent && pane.status === 'blocked');
  const working = Boolean(pane.agent && pane.status === 'working');
  const keysVisible = mode === 'live' && (compact || blocked);
  const uploadEnabled = mode !== 'changes' && !pending && !blocked && !working;
  const approval = blocked ? asks?.entries[pane.id] : undefined;
  const focusComposer = useEffectEvent(() => {
    if (pane.agent && !compact && mode !== 'changes' && !field.current?.disabled) field.current?.focus({ preventScroll: true });
  });
  useEffect(() => { focusComposer(); }, [pane.id, pane.agent]);
  return <section ref={root} className="coding-detail" aria-label={pane.title} data-pane-mode={mode}
    onPasteCapture={event => draft.paste(event, uploadEnabled)} onDragOver={draft.drag}
    onDrop={event => draft.drop(event, uploadEnabled)}>
    <HerdrPaneHeader pane={pane} mode={mode} onMode={onMode} chat={chat} changes={changes} compact={compact} branch={branch}
      navigation={navigation} fontSize={fontSize} onFontSize={size => onFontSize?.(size)}
      onEsc={pane.agent && !keysVisible && (mode === 'live' || mode === 'history' || (mode === 'chat' && working)) ? () => onKey('esc') : undefined}/>
    <div className="herdr-pane-content" key={mode}>{screen}</div>
    {(error || mode !== 'changes') && <div className="coding-dock" aria-busy={pending || undefined}>
      {error && <InlineError>{error}</InlineError>}
      {mode === 'chat' && blocked && <div className="herdr-chat-ask">
        {approval ? <HerdrAskCard entry={approval} answer={index => void asks?.answer(pane.id, index)}/>
          : <Button type="button" variant="outline" onClick={() => onMode('live')}>터미널 열기</Button>}
      </div>}
      {keysVisible && <TerminalKeyRail compact={compact} modifiers={modifiers} onKey={onKey} onText={text => onText?.(text)} onModifier={key => {
        onModifier?.(key);
        if (!document.activeElement?.classList.contains('xterm-helper-textarea')) {
          const next = field.current && !field.current.disabled ? field.current : root.current?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
          next?.focus({ preventScroll: true });
        }
      }} onDismiss={() => {
        if (document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement)) document.activeElement.blur();
      }}/>}
      {mode !== 'changes' && <HerdrComposer shell={!pane.agent} blocked={blocked} working={working} pending={pending} compact={compact}
        draft={draft} field={field} onSubmit={onPrompt} onModifiedKey={onModifiedKey} canUpload={Boolean(onUpload)}/>}
    </div>}
  </section>;
}

export function OpenHerdrPane({ pane, compact, onChanged, onGone, preferencesKey, since, branch, navigation, asks }: {
  pane: HerdrPaneView; compact: boolean; onChanged(): void; onGone(): void;
  preferencesKey: string; since: number; branch?: string | null; navigation: PaneNavigation; asks: HerdrAsks;
}) {
  const { client } = useHost();
  const [mode, setMode] = useState(() => herdrModes.find(item => item === readCodingValue(`mode:${preferencesKey}`)));
  const [fontSize, setFontSize] = useState<number>(readTerminalSize);
  const select = (value: HerdrMode) => { setMode(value); writeCodingValue(`mode:${preferencesKey}`, value); };
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [reply, setReply] = useState<{ snapshot: HerdrPaneView; pane: HerdrPaneView } | null>(null);
  const queue = useRef<HerdrInputQueue | null>(null);
  const busy = useRef(false);
  const modifierRef = useRef(noModifiers);
  const [modifiers, setModifiers] = useState(noModifiers);
  const displayed = reply?.snapshot === pane ? reply.pane : pane;
  const previous = useRef(displayed.status);
  useEffect(() => {
    if (displayed.status === 'done' && (previous.current === 'working' || previous.current === 'blocked') && !document.hidden) haptic();
    previous.current = displayed.status;
  }, [displayed.status]);
  const { chat, error: chatError } = useHerdrChat(displayed, mode === undefined || mode === 'chat');
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
  const chatVisible = Boolean(chat.source);
  const requested = mode ?? (chatVisible ? 'chat' : 'live');
  const activeMode = (requested === 'changes' && !changesVisible) || (requested === 'chat' && !chatVisible) ? 'live' : requested;
  const checkingChat = Boolean(pane.agent) && (mode === undefined || mode === 'chat') && chat.source === undefined && !chatError;
  return <HerdrPaneBody pane={displayed} compact={compact} mode={activeMode} onMode={select} pending={pending} error={error}
    onPrompt={prompt} onKey={key => { setError(''); queue.current?.key(key); }} onText={sendText}
    onModifiedKey={modifiedKey} modifiers={modifiers} onModifier={key => setSticky({ ...modifierRef.current, [key]: !modifierRef.current[key] })}
    onUpload={file => client.herdrUpload(file)} changes={changesVisible} chat={chatVisible} fontSize={fontSize} onFontSize={setFontSize}
    branch={changes?.branch ?? branch} navigation={navigation} asks={asks} draftKey={`draft:${preferencesKey}`}
    screen={activeMode === 'chat' ? <HerdrConversation items={chat.items} busy={displayed.status === 'working'} since={since} error={chatError}/>
      : activeMode === 'changes' ? <HerdrChangesView pane={displayed} compact={compact} data={changes} error={changesError}
        onRefresh={refreshChanges} revision={changesRevision}/>
      : checkingChat ? <CodingSkeleton detail/> : <Suspense fallback={<CodingSkeleton detail/>}>
        {activeMode === 'history' ? <HistoryTerminal pane={id} onGone={onGone} fontSize={fontSize}/>
          : <LiveTerminal pane={id} onData={sendText} onModifiedKey={modifiedKey} onGone={onGone} fontSize={fontSize}/>}
      </Suspense>}/>;
}
