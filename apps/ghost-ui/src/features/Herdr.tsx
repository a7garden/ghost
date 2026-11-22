import { lazy, Suspense, useEffect, useEffectEvent, useReducer, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Keyboard } from 'lucide-react';
import type { HerdrDelivery, HerdrPaneView, HerdrSlashCommand, HerdrUpload, HerdrView, OmpInfo } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { HostError } from '../host/client';
import { haptic } from '../host/shell';
import { Button, Dialog, DialogContent, DialogTitle, InlineError } from '../ui';
import { HerdrInputQueue } from './herdrTerminalProtocol';
import { HerdrComposer, useHerdrDraft } from './HerdrComposer';
import { HerdrChangesView, usePaneChanges } from './HerdrChanges';
import { modifiedTerminalKey, noModifiers, type TerminalModifiers } from './herdrMobileInput';
import { lastReply, useNextSuggestions } from './nextSuggestions';
import { HerdrAskCard, type HerdrAsks } from './HerdrAsk';
import { HerdrConversation, useHerdrChat } from './HerdrChat';
import { CodingSkeleton } from './HerdrParts';
import { readCodingValue, writeCodingValue } from './herdrInboxModel';
import { HerdrPaneHeader, herdrModes, type HerdrMode, type PaneNavigation } from './HerdrPaneHeader';
import { readTerminalSize, TerminalKeyRail } from './HerdrTerminalControls';
import type { HerdrTerminalControls } from './HerdrTerminal';
import type { LeasedTerminalControls } from './HerdrControl';
import { initialTerminalLease, shouldControlTerminal, terminalLeaseConsent, terminalLeaseReducer } from './herdrControlModel';

const WatchTerminal = lazy(() => import('./HerdrTerminal'));
const ControlTerminal = lazy(() => import('./HerdrControl'));

function TerminalTakeover({ open, cancel, confirm }: { open: boolean; cancel(): void; confirm(): void }) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  return <Dialog open={open} onOpenChange={open => { if (!open) cancel(); }}>
    <DialogContent showCloseButton={false} className="herdr-takeover-confirm"
      onOpenAutoFocus={event => { event.preventDefault(); cancelButton.current?.focus(); }}>
      <DialogTitle>다른 곳에서 쓰는 중이에요. 가져올까요?</DialogTitle>
      <div className="herdr-takeover-actions">
        <Button ref={cancelButton} type="button" variant="ghost" onClick={cancel}>취소</Button>
        <Button type="button" onClick={confirm}>가져오기</Button>
      </div>
    </DialogContent>
  </Dialog>;
}

/** The slash commands the pane's agent accepts, read once per pane. */
function useHerdrCommands(pane: string, agent: string | null): readonly HerdrSlashCommand[] {
  const { client } = useHost();
  const [commands, setCommands] = useState<{ pane: string; items: readonly HerdrSlashCommand[] }>({ pane: '', items: [] });
  useEffect(() => {
    if (agent !== 'omp' && agent !== 'claude') return;
    const request = new AbortController();
    client.herdrCommands(pane, request.signal).then(result => { if (!request.signal.aborted) setCommands({ pane, items: result.commands }); }).catch(() => {});
    return () => request.abort();
  }, [client, pane, agent]);
  return commands.pane === pane ? commands.items : [];
}

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
  onPrompt, onKey, onText, modifiers = noModifiers, onModifier, onUpload, fontSize = 13, onFontSize,
  branch, navigation, asks, draftKey, terminal, terminalAction, delivery = 'steer', suggestions = [], commands = [], model = null, loadModels = async () => [],
}: {
  pane: HerdrPaneView; screen: ReactNode; mode: HerdrMode; onMode(mode: HerdrMode): void; compact: boolean;
  changes?: boolean; chat?: boolean; pending?: boolean; error?: string;
  onPrompt(text: string, delivery?: HerdrDelivery): Promise<boolean>; onKey(key: string): void;
  onText?(text: string): void; modifiers?: TerminalModifiers; onModifier?(key: keyof TerminalModifiers): void;
  onUpload?(file: File): Promise<HerdrUpload>;
  fontSize?: number; onFontSize?(size: number): void; branch?: string | null; navigation?: PaneNavigation;
  asks?: HerdrAsks; draftKey?: string;
  terminal?: RefObject<HerdrTerminalControls | null>; terminalAction?: ReactNode;
  delivery?: HerdrDelivery; suggestions?: readonly string[];
  commands?: readonly HerdrSlashCommand[]; model?: string | null;
  loadModels?(cwd: string, signal: AbortSignal): Promise<OmpInfo['models']>;
}) {
  const draft = useHerdrDraft(draftKey, onUpload);
  const field = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLElement>(null);
  const blocked = Boolean(pane.agent && pane.status === 'blocked');
  const working = Boolean(pane.agent && pane.status === 'working');
  // The follow-up field sits under both the conversation and the terminal, so an agent can be answered from either; a blocked one is answered by its approval.
  const keysVisible = mode === 'live' && (compact || blocked);
  const composing = (mode === 'chat' || mode === 'live') && Boolean(pane.agent) && !blocked;
  const approval = blocked ? asks?.entries[pane.id] : undefined;
  const focusComposer = useEffectEvent(() => {
    if (composing && !compact && !field.current?.disabled) field.current?.focus({ preventScroll: true });
  });
  useEffect(() => { focusComposer(); }, [pane.id, pane.agent, mode]);
  return <section ref={root} className="coding-detail" aria-label={pane.title} data-pane-mode={mode}
    onInputCapture={event => { if (event.target === field.current) terminal?.current?.latest(true); }}>
    <HerdrPaneHeader pane={pane} mode={mode} onMode={onMode} chat={chat} changes={changes} compact={compact} branch={branch}
      navigation={navigation} fontSize={fontSize} onFontSize={size => onFontSize?.(size)} terminalAction={terminalAction}/>
    <div className="herdr-pane-content" key={mode}>{screen}</div>
    {(error || composing || keysVisible || (mode === 'chat' && blocked)) && <div className="coding-dock" aria-busy={pending || undefined}>
      {error && <InlineError>{error}</InlineError>}
      {mode === 'chat' && blocked && <div className="herdr-chat-ask">
        {approval ? <HerdrAskCard entry={approval} answer={index => void asks?.answer(pane.id, index)}/>
          : <Button type="button" variant="outline" onClick={() => onMode('live')}>터미널 열기</Button>}
      </div>}
      {keysVisible && <TerminalKeyRail compact={compact} modifiers={modifiers} onKey={onKey}
        onText={text => onText?.(text)} onPageUp={text => { if (!terminal?.current?.pageUp()) onText?.(text); }} onModifier={key => {
        onModifier?.(key);
        if (!document.activeElement?.classList.contains('xterm-helper-textarea')) {
          root.current?.querySelector<HTMLTextAreaElement>('.herdr-terminal-live .xterm-helper-textarea, .herdr-control .xterm-helper-textarea')?.focus({ preventScroll: true });
        }
      }} onDismiss={() => {
        if (document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement)) document.activeElement.blur();
      }}/>}
      {composing && <HerdrComposer agent={pane.agent} working={working} pending={pending} delivery={delivery}
        draft={draft} field={field} suggestions={mode === 'chat' ? suggestions : []} commands={commands} canUpload={Boolean(onUpload)} onStop={() => onKey('esc')}
        model={pane.agent === 'omp' || pane.agent === 'claude' ? { cwd: pane.cwd, current: model, load: loadModels } : undefined}
        // A slash command answers in the terminal, not in the conversation record, so show it there.
        onSubmit={async (text, how) => {
          const sent = await onPrompt(text, how);
          if (sent && mode === 'chat' && text.startsWith('/') && !text.startsWith('/model ')) onMode('live');
          return sent;
        }}/>}
    </div>}
  </section>;
}

export function OpenHerdrPane({ pane, compact, onChanged, onGone, preferencesKey, since, branch, navigation, asks }: {
  pane: HerdrPaneView; compact: boolean; onChanged(): void; onGone(): void;
  preferencesKey: string; since: number; branch?: string | null; navigation: PaneNavigation; asks: HerdrAsks;
}) {
  const { client, store } = useHost();
  const [mode, setMode] = useState(() => herdrModes.find(item => item === readCodingValue(`mode:${preferencesKey}`)));
  const [fontSize, setFontSize] = useState<number>(readTerminalSize);
  const select = (value: HerdrMode) => { setMode(value); writeCodingValue(`mode:${preferencesKey}`, value); };
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [reply, setReply] = useState<{ snapshot: HerdrPaneView; pane: HerdrPaneView } | null>(null);
  const queue = useRef<HerdrInputQueue | null>(null);
  const terminal = useRef<HerdrTerminalControls>(null);
  const control = useRef<LeasedTerminalControls>(null);
  const [lease, dispatchLease] = useReducer(terminalLeaseReducer, null, initialTerminalLease);
  const busy = useRef(false);
  const modifierRef = useRef(noModifiers);
  const [modifiers, setModifiers] = useState(noModifiers);
  const displayed = reply?.snapshot === pane ? reply.pane : pane;
  // Owned panes drive themselves on a fitted grid; a borrowed pane only ever drives after 직접 조작.
  const controlWanted = shouldControlTerminal(displayed.owned, terminalLeaseConsent(lease));
  const previous = useRef(displayed.status);
  useEffect(() => {
    if (displayed.status === 'done' && (previous.current === 'working' || previous.current === 'blocked') && !document.hidden) haptic();
    previous.current = displayed.status;
  }, [displayed.status]);
  const { chat, error: chatError } = useHerdrChat(displayed, mode === undefined || mode === 'chat');
  const commands = useHerdrCommands(pane.id, pane.agent);
  const { state } = useHostState(store);
  const delivery = state?.settings?.codingDelivery ?? 'steer';
  const latest = lastReply(chat.items, item => item.kind === 'user' || item.kind === 'agent');
  const suggestions = useNextSuggestions({ kind: 'pane', id: pane.id }, latest?.id ?? null,
    latest?.kind === 'agent' && (displayed.status === 'idle' || displayed.status === 'done'));
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

  async function prompt(text: string, delivery?: HerdrDelivery) {
    terminal.current?.latest(true);
    const writer = queue.current;
    if (!writer || busy.current) return false;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      return await writer.afterInput(async () => {
        try {
          const next = await client.promptHerdr({ pane: id, text, ...(delivery ? { delivery } : {}) });
          if (queue.current === writer) {
            setReply({ snapshot: pane, pane: next });
            onChanged();
          }
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
    if (activeMode === 'live' && controlWanted) control.current?.text(text);
    else queue.current?.text(text);
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
  const controlling = activeMode === 'live' && controlWanted;
  const activeTerminal = controlling ? control : terminal;
  // A shared pane is only watched until one intentional press asks to drive it at a fitted size; pressing again, or leaving live, restores it. An app-owned pane drives itself and only offers this after it fell back to watching.
  const terminalAction = displayed.owned && controlling ? undefined : <Button type="button" variant="ghost" size="sm" className="herdr-control-action"
    aria-label="직접 조작" title={controlling ? '직접 조작 끝내기' : '직접 조작'} aria-pressed={controlling}
    onClick={() => dispatchLease({ type: controlling ? 'leave' : 'control' })}>
    <Keyboard aria-hidden="true"/><span className="herdr-tool-label">직접 조작</span></Button>;
  return <HerdrPaneBody pane={displayed} compact={compact}
    mode={activeMode} onMode={next => { if (next !== 'live') dispatchLease({ type: 'leave' }); select(next); }}
    pending={pending || (controlling && !lease.leased)} error={error}
    onPrompt={prompt} onKey={key => {
      setError('');
      if (controlling) control.current?.key(key);
      else { terminal.current?.latest(); queue.current?.key(key); }
    }}
    onText={text => { activeTerminal.current?.latest(); sendText(text); }}
    modifiers={modifiers}
    onModifier={key => { activeTerminal.current?.latest(); setSticky({ ...modifierRef.current, [key]: !modifierRef.current[key] }); }}
    onUpload={file => client.herdrUpload(file)} changes={changesVisible} chat={chatVisible} fontSize={fontSize} onFontSize={setFontSize}
    branch={changes?.branch ?? branch} navigation={navigation} asks={asks} draftKey={`draft:${preferencesKey}`} terminal={activeTerminal}
    terminalAction={terminalAction} delivery={delivery} suggestions={suggestions} commands={commands} model={chat.model ?? null}
    loadModels={(cwd, signal) => client.ompInfo(cwd, signal).then(info => info.models)}
    screen={activeMode === 'chat' ? <HerdrConversation items={chat.items} busy={displayed.status === 'working'} since={since} error={chatError}/>
      : activeMode === 'changes' ? <HerdrChangesView pane={displayed} compact={compact} data={changes} error={changesError}
        onRefresh={refreshChanges} revision={changesRevision}/>
      : checkingChat ? <CodingSkeleton detail/> : <Suspense fallback={<CodingSkeleton detail/>}>
        {controlling ? <ControlTerminal key={id} ref={control} pane={id} fit={!displayed.owned} takeover={lease.takeover} fontSize={fontSize}
          onReady={() => dispatchLease({ type: 'ready' })} onProblem={reason => {
            if (reason === 'gone') onGone();
            else dispatchLease({ type: 'problem', reason });
          }} onInput={text => changed({ text })} onError={setError} onModifiedKey={modifiedKey}/>
          : <WatchTerminal key={id} ref={terminal} pane={id} onData={sendText} onModifiedKey={modifiedKey} onGone={onGone} fontSize={fontSize}/>}
        {lease.note && <div className="herdr-live-status" role="status">{lease.note}</div>}
        <TerminalTakeover open={lease.confirmation === 'held'} cancel={() => dispatchLease({ type: 'cancel' })} confirm={() => dispatchLease({ type: 'confirm' })}/>
      </Suspense>}/>;
}
