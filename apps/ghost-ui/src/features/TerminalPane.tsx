import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ILink, Terminal } from '@xterm/xterm';
import type { TerminalCreate, TerminalSize } from '@ghost/contract';
import { HostError } from '../host/client';
import { useHost } from '../host/context';
import { readTerminalSize, TerminalKeyRail, TerminalTextSize } from './TerminalControls';
import { controlRailKey, isHistoryPageKey, modifiedTerminalKey, noModifiers, type TerminalModifiers } from './terminalKeys';
import { openXterm } from './terminalXterm';
import { sameTerminalSize, terminalInput, TerminalWire } from './TerminalPaneProtocol';
import './TerminalPane.css';

type PaneStatus = 'connecting' | 'live' | 'reconnecting' | 'exited' | 'gone' | 'forbidden';
type KeyboardControls = { key(key: string): void; text(text: string): void; pageUp(text: string): void; dismiss(): void; resizeFont(size: number): void };

export function useCreateTerminal() {
  const { client } = useHost();
  return useCallback((spec: TerminalCreate) => client.createTerminal(spec), [client]);
}

function linkProvider(terminal: Terminal, activate: ILink['activate']) {
  return terminal.registerLinkProvider({ provideLinks(row, callback) {
    const line = terminal.buffer.active.getLine(row - 1);
    if (!line) { callback(undefined); return; }
    const text = line.translateToString(true);
    const links: ILink[] = [];
    let column = 0;
    let position = 0;
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
      const url = match[0].replace(/[.,;:!?\])}]+$/, '');
      if (url.length <= url.indexOf('/') + 2) continue;
      while (position < match.index && column < line.length) {
        const cell = line.getCell(column);
        if (!cell || cell.getWidth() === 0) { column++; continue; }
        position += cell.getChars().length || 1;
        column += cell.getWidth();
      }
      const start = column + 1;
      while (position < match.index + url.length && column < line.length) {
        const cell = line.getCell(column);
        if (!cell || cell.getWidth() === 0) { column++; continue; }
        position += cell.getChars().length || 1;
        column += cell.getWidth();
      }
      links.push({ text: url, range: { start: { x: start, y: row }, end: { x: column, y: row } }, activate });
    }
    callback(links.length ? links : undefined);
  } });
}

export function TerminalPane({ terminalId, onExit }: { terminalId: string; onExit?: (code: number | null) => void }) {
  const { client } = useHost();
  const mount = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  const keyboard = useRef<KeyboardControls | null>(null);
  const modifierRef = useRef(noModifiers);
  const [modifiers, setModifiers] = useState(noModifiers);
  const [fontSize, setFontSize] = useState(readTerminalSize);
  const currentFontSize = useEffectEvent(() => fontSize);
  const [status, setStatus] = useState<PaneStatus>('connecting');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  const notifyExit = useEffectEvent((code: number | null) => onExit?.(code));

  function updateModifiers(next: TerminalModifiers) {
    modifierRef.current = next;
    setModifiers(next);
  }

  useEffect(() => {
    const node = mount.current;
    if (!node) return;
    setStatus('connecting');
    setExitCode(null);
    setActionError('');
    updateModifiers(noModifiers);
    const activate = (_event: MouseEvent, text: string) => {
      let url: URL;
      try { url = new URL(text); } catch { return; }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
      if (isTauri()) void invoke('open_external_url', { url: url.href }).catch(() => {
        if (!destroyed) setActionError('기본 브라우저에서 링크를 열지 못했습니다.');
      });
      else window.open(url.href, '_blank', 'noopener,noreferrer');
    };
    const { terminal, fit, dispose } = openXterm(node, { scrollback: 20_000, fontSize: currentFontSize(), cursorBlink: true, disableStdin: true }, activate);
    const links = linkProvider(terminal, activate);
    let destroyed = false;
    let ended = false;
    let enabled = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let resizeFrame: number | undefined;
    let hostSize: TerminalSize | undefined;
    let probe: AbortController | undefined;
    const finish = (code: number | null, reason: 'gone' | 'exited') => {
      if (ended || destroyed) return;
      ended = true;
      enabled = false;
      terminal.options.disableStdin = true;
      setExitCode(code);
      setStatus(reason);
      notifyExit(code);
    };
    const wire = new TerminalWire({
      ready(size, reset) {
        hostSize = size;
        if (reset) terminal.write('\x1bc'); // Queue the reset after any previous connection's writes.
        terminal.resize(size.cols, size.rows);
      },
      bytes(bytes) { terminal.write(bytes); },
      live() {
        const current = socket;
        // xterm must not answer device queries that were emitted in the recorded output.
        terminal.write('', () => {
          if (destroyed || ended || socket !== current || current?.readyState !== WebSocket.OPEN) return;
          enabled = true;
          attempt = 0;
          terminal.options.disableStdin = false;
          setStatus('live');
          measure();
        });
      },
      exit(code) { terminal.write('', () => finish(code, 'exited')); },
    });

    function measure() {
      if (destroyed || !node?.clientWidth || !node.clientHeight) return;
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
      const size = { cols: Math.min(500, Math.max(2, dims.cols)), rows: Math.min(300, Math.max(1, dims.rows)) };
      if (!sameTerminalSize(terminal, size)) terminal.resize(size.cols, size.rows);
      if (enabled && socket?.readyState === WebSocket.OPEN && !sameTerminalSize(hostSize, size)) {
        socket.send(JSON.stringify({ type: 'resize', ...size }));
        hostSize = size;
      }
    }
    function scheduleMeasure() {
      if (!enabled || destroyed || resizeFrame !== undefined) return;
      resizeFrame = requestAnimationFrame(() => { resizeFrame = undefined; measure(); });
    }
    function send(text: string, binary = false) {
      if (!enabled || socket?.readyState !== WebSocket.OPEN) return;
      setActionError('');
      for (const frame of terminalInput(text, binary)) socket.send(JSON.stringify(frame));
    }
    function modified(value: string) {
      const transformed = modifiedTerminalKey(value, modifierRef.current);
      if (transformed === null) return false;
      updateModifiers(noModifiers);
      send(transformed);
      return true;
    }
    function connect() {
      if (destroyed || ended) return;
      wire.reconnect();
      const next = client.openTerminalSocket(terminalId, wire.offset);
      socket = next;
      next.binaryType = 'arraybuffer';
      next.onmessage = event => {
        if (destroyed || socket !== next) return;
        if (!wire.receive(event.data)) next.close(4000, 'invalid terminal frame');
      };
      next.onclose = () => {
        if (destroyed || ended || socket !== next) return;
        socket = null;
        enabled = false;
        terminal.options.disableStdin = true;
        setStatus('reconnecting');
        const current = new AbortController();
        probe = current;
        // Browsers do not expose upgrade status. The authenticated list distinguishes
        // a vanished PTY (such as a Host restart) from a dropped transport.
        void client.terminals(current.signal).then(terminals => {
          if (!destroyed && !terminals.some(entry => entry.id === terminalId)) finish(null, 'gone');
        }).catch(error => {
          if (!destroyed && error instanceof HostError && error.code === 'forbidden') {
            ended = true;
            setStatus('forbidden');
          }
        }).finally(() => {
          if (probe === current) probe = undefined;
          if (!ended && !destroyed) retry = setTimeout(connect, Math.min(500 * 2 ** attempt++, 4_000));
        });
      };
    }

    keyboard.current = {
      key(key) {
        const text = controlRailKey(key, terminal.modes.applicationCursorKeysMode);
        if (text) send(text);
      },
      text(text) { if (!modified(text)) send(text); },
      pageUp(text) { if (terminal.buffer.active.type === 'alternate') send(text); else terminal.scrollPages(-1); },
      dismiss() { terminal.blur(); },
      resizeFont(size) {
        terminal.options.fontSize = size;
        scheduleMeasure();
      },
    };
    const input = terminal.onData(data => send(data));
    const binary = terminal.onBinary(data => send(data, true));
    const softKey = (event: InputEvent) => {
      if (event.cancelable && !event.isComposing && event.inputType === 'insertText' && event.data && modified(event.data)) event.preventDefault();
    };
    node.addEventListener('beforeinput', softKey, true);
    const stopKey = (event: KeyboardEvent) => event.stopPropagation();
    node.addEventListener('keydown', stopKey);
    terminal.textarea?.setAttribute('aria-keyshortcuts', 'Shift+Escape Shift+PageUp');
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      if (event.shiftKey && event.key === 'Escape') {
        event.preventDefault();
        pane.current?.focus();
        return false;
      }
      const buffer = terminal.buffer.active;
      if (buffer.type !== 'alternate' && !event.ctrlKey && !event.altKey && !event.metaKey && isHistoryPageKey(event.key, event.shiftKey, buffer.viewportY < buffer.baseY)) {
        event.preventDefault();
        terminal.scrollPages(event.key === 'PageUp' ? -1 : 1);
        return false;
      }
      if (event.ctrlKey && event.shiftKey && !event.metaKey && (event.code === 'KeyC' || event.code === 'KeyV')) {
        event.preventDefault();
        const clipboard = navigator.clipboard;
        if (clipboard) {
          const action = event.code === 'KeyC' ? clipboard.writeText(terminal.getSelection())
            : clipboard.readText().then(text => { if (!destroyed && enabled) terminal.paste(text); });
          void action.catch(() => { if (!destroyed) setActionError('클립보드를 사용할 수 없습니다.'); });
        } else setActionError('클립보드를 사용할 수 없습니다.');
        return false;
      }
      if (!event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && modified(event.key)) {
        event.preventDefault();
        return false;
      }
      return true;
    });
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(node);
    void document.fonts.ready.then(scheduleMeasure);
    connect();
    return () => {
      destroyed = true;
      keyboard.current = null;
      clearTimeout(retry);
      probe?.abort();
      socket?.close();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      node.removeEventListener('beforeinput', softKey, true);
      node.removeEventListener('keydown', stopKey);
      input.dispose();
      binary.dispose();
      links.dispose();
      dispose();
    };
  }, [client, terminalId]);

  const label = status === 'connecting' ? '터미널 연결 중…' : status === 'reconnecting' ? '터미널 다시 연결 중…'
    : status === 'gone' ? '터미널이 종료되었습니다.' : status === 'forbidden' ? '터미널에 접근할 수 없습니다.'
      : status === 'exited' ? `터미널 종료${exitCode === null ? '' : ` (${exitCode})`}` : actionError;
  return <section ref={pane} tabIndex={-1} className="terminal-pane" aria-label="터미널">
    <div ref={mount} className="terminal-pane__screen"/>
    {label && <div className="terminal-pane__status" role="status">{label}</div>}
    {status === 'live' && <div className="terminal-pane__controls">
      <div className="terminal-pane__keys">
        <TerminalKeyRail modifiers={modifiers} onModifier={key => updateModifiers({ ...modifierRef.current, [key]: !modifierRef.current[key] })}
          onKey={key => keyboard.current?.key(key)} onText={text => keyboard.current?.text(text)}
          onPageUp={text => keyboard.current?.pageUp(text)} onDismiss={() => keyboard.current?.dismiss()}/>
      </div>
      <TerminalTextSize size={fontSize} onSize={size => { setFontSize(size); keyboard.current?.resizeFont(size); }}/>
    </div>}
  </section>;
}
