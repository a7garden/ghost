import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import type { HerdrControlCommand, HerdrControlLease } from '@ghost/contract';
import { HostError } from '../host/client';
import { useHost } from '../host/context';
import { Button } from '../ui';
import { CodingSkeleton } from './HerdrParts';
import type { HerdrTerminalControls } from './HerdrTerminal';
import { controlRailKey, TerminalResize, TerminalScrollLines, terminalProblem, type TerminalProblem, type TerminalSize } from './herdrControlModel';
import { decodeHerdrFrame, HerdrInputQueue } from './herdrTerminalProtocol';
import { terminalWheelOffset } from './herdrTerminalScroll';
import { openHerdrXterm } from './herdrXterm';

export type LeasedTerminalControls = HerdrTerminalControls & {
  text(text: string): void;
  key(key: string): void;
};

type Command = HerdrControlCommand extends infer C ? C extends HerdrControlCommand ? Omit<C, 'pane' | 'leaseId'> : never : never;
type Cell = { column: number; row: number };

export default function HerdrControl({ ref, pane, fit, takeover, fontSize, onReady, onProblem, onModifiedKey, onInput, onError }: {
  ref?: Ref<LeasedTerminalControls>; pane: string; fit: boolean; takeover: boolean; fontSize: number;
  onReady(lease: HerdrControlLease): void; onProblem(reason: Exclude<TerminalProblem, 'retry'> | 'taken' | 'released'): void;
  onModifiedKey(key: string): boolean; onInput(text: string): void; onError(message: string): void;
}) {
  const { client } = useHost();
  const mount = useRef<HTMLDivElement>(null);
  const controls = useRef<LeasedTerminalControls>(null);
  const changeFont = useRef<(size: number) => void>(null);
  const ready = useEffectEvent(onReady);
  const problem = useEffectEvent(onProblem);
  const modifiedKey = useEffectEvent(onModifiedKey);
  const inputSent = useEffectEvent(onInput);
  const error = useEffectEvent(onError);
  const initialFont = useEffectEvent(() => fontSize);
  const [loaded, setLoaded] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useImperativeHandle(ref, () => ({
    latest: keepFocus => controls.current?.latest(keepFocus),
    pageUp: () => { controls.current?.pageUp(); return true; },
    text: text => controls.current?.text(text),
    key: key => controls.current?.key(key),
  }), []);

  useEffect(() => {
    const node = mount.current!;
    const { terminal, fit: measure, dispose } = openHerdrXterm(node, { scrollback: 0, fontSize: initialFont() });
    const screen = node.querySelector<HTMLElement>('.xterm-screen')!;
    const lines = new TerminalScrollLines();
    let position = 0;
    let frameRequest = 0;
    let wheelTimeout: ReturnType<typeof setTimeout> | undefined;
    let wheelCell: Cell | undefined;
    let gesture: { id: number; x: number; y: number; dragged: boolean } | undefined;
    let mounted = true;
    let hiddenPage = false;
    let stream: AbortController | undefined;
    let lease: HerdrControlLease | undefined;
    let writer: HerdrInputQueue | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let backoff = 400;
    let lost = false;
    let allowTakeover = takeover;
    const reportsMouse = () => terminal.modes.mouseTrackingMode !== 'none';

    function report(reason: unknown) {
      if (reason instanceof HostError && reason.code === 'not_found') problem('gone');
      else error(reason instanceof Error ? reason.message : '터미널에 입력을 보내지 못했습니다.');
    }
    function send(current: HerdrControlLease, command: Command) {
      return client.sendHerdrControl({ ...command, pane, leaseId: current.leaseId });
    }
    const resize = new TerminalResize(async size => {
      if (!lease || !writer) return;
      await send(lease, { type: 'resize', ...size });
    }, report);
    function geometry(): TerminalSize | undefined {
      const size = measure.proposeDimensions();
      if (size && node.clientWidth && node.clientHeight) {
        return { cols: Math.min(300, Math.max(20, size.cols)), rows: Math.min(120, Math.max(5, size.rows)) };
      }
    }
    function dimensions() {
      const size = geometry();
      if (!size) return;
      resize.request(size);
      if (!stream && !retry && !hiddenPage) connect(size);
    }

    function resetPosition() {
      lines.clear();
      if (frameRequest) cancelAnimationFrame(frameRequest);
      frameRequest = 0;
      position = 0;
      setScrolled(false);
    }
    function enqueue(commands: Command[]) {
      const current = lease, queue = writer;
      if (!current || !queue) return;
      void queue.afterInput(async () => {
        for (const command of commands) {
          if (queue !== writer) return false;
          await send(current, command);
        }
        return true;
      });
    }
    function scroll(signed: number, source: 'wheel' | 'page_key', target?: Cell) {
      if (!signed || !writer) return;
      if (!reportsMouse()) {
        position = Math.max(0, position - signed);
        setScrolled(position > 0);
      }
      enqueue([{ type: 'scroll', direction: signed < 0 ? 'up' : 'down', lines: Math.abs(signed), source, ...target }]);
    }
    function flushScroll() {
      frameRequest = 0;
      scroll(lines.take(), 'wheel', wheelCell);
      if (lines.ready) frameRequest = requestAnimationFrame(flushScroll);
    }
    function latest(keepFocus = false) {
      const distance = position;
      resetPosition();
      if (distance) {
        const commands: Command[] = [];
        for (let more = Math.max(500, distance); more > 0; more -= 500) {
          commands.push({ type: 'scroll', direction: 'down', lines: Math.min(more, 500), source: 'wheel' });
        }
        enqueue(commands);
      }
      if (!keepFocus) terminal.focus();
    }
    function text(value: string) {
      if (!writer) return;
      latest(true);
      writer.text(value);
    }
    controls.current = {
      latest,
      pageUp() { scroll(-Math.max(1, terminal.rows - 1), 'page_key'); return true; },
      text,
      key(key) {
        const value = controlRailKey(key, terminal.modes.applicationCursorKeysMode);
        if (value !== undefined) text(value);
      },
    };

    function stopInput() {
      writer?.close();
      writer = undefined;
      resize.stop();
      resetPosition();
    }
    function disconnect() {
      const current = lease;
      lease = undefined;
      clearTimeout(retry);
      clearTimeout(quiet);
      retry = undefined;
      lost = false;
      // Send the release before aborting the stream, including during pagehide.
      if (current) void client.releaseHerdrControl({ pane, leaseId: current.leaseId });
      stream?.abort();
      stream = undefined;
      stopInput();
    }
    function connect(size: TerminalSize) {
      const connection = new AbortController();
      stream = connection;
      let firstFrame = true;
      let sequence = -Infinity;
      void (async () => {
        let acceptedFrame = false;
        try {
          const ended = await client.herdrControl({ pane, ...size, fit, takeover: allowTakeover }, next => {
            if (connection.signal.aborted) return;
            lease = next;
            allowTakeover = false;
            ready(next);
            writer = new HerdrInputQueue(async ({ text }) => {
              if (lease !== next || !text) return;
              await send(next, { type: 'input', text });
              if (lease === next) inputSent(text);
            }, report);
            resize.start(size);
          }, frame => {
            if (connection.signal.aborted || !lease || (!acceptedFrame && !frame.full) || frame.seq <= sequence) return;
            acceptedFrame = true;
            sequence = frame.seq;
            if (terminal.cols !== frame.width || terminal.rows !== frame.height) terminal.resize(frame.width, frame.height);
            terminal.write(decodeHerdrFrame(frame.bytes), () => {
              if (!firstFrame || connection.signal.aborted) return;
              firstFrame = false;
              clearTimeout(quiet);
              lost = false;
              backoff = 400;
              setLoaded(true);
              setReconnecting(false);
            });
          }, connection.signal);
          if (connection.signal.aborted) return;
          stopInput();
          if (ended === 'closed' || ended === 'taken' || ended === 'released') {
            lease = undefined; // No longer ours; the server is already restoring it or handed it off.
            problem(ended === 'closed' ? 'gone' : ended);
            return;
          }
        } catch (reason) {
          if (connection.signal.aborted) return;
          stopInput();
          const cause = terminalProblem(reason);
          if (cause !== 'retry') { problem(cause); return; }
        }
        if (!lost) {
          lost = true;
          quiet = setTimeout(() => setReconnecting(true), 1400);
        }
        retry = setTimeout(() => {
          retry = undefined;
          if (mounted && !hiddenPage && !connection.signal.aborted) connect(geometry() ?? size);
        }, backoff);
        backoff = Math.min(backoff * 2, 4000);
      })();
    }

    function cellAt(x: number, y: number): Cell {
      const bounds = screen.getBoundingClientRect();
      return {
        column: Math.max(0, Math.min(terminal.cols - 1, Math.floor((x - bounds.left) * terminal.cols / (bounds.width || 1)))),
        row: Math.max(0, Math.min(terminal.rows - 1, Math.floor((y - bounds.top) * terminal.rows / (bounds.height || 1)))),
      };
    }
    function addScroll(pixels: number, cellHeight: number, cell: Cell) {
      wheelCell = cell;
      lines.add(pixels, cellHeight);
      if (lines.ready && !frameRequest) frameRequest = requestAnimationFrame(flushScroll);
    }
    function wheel(event: WheelEvent) {
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      const height = screen.clientHeight / terminal.rows;
      const delta = terminalWheelOffset(event.deltaX, event.deltaY, event.deltaMode, height, screen.clientHeight);
      if (!delta) return;
      event.preventDefault();
      event.stopPropagation();
      resize.pause(true);
      clearTimeout(wheelTimeout);
      wheelTimeout = setTimeout(() => { if (!gesture) resize.pause(false); }, 120);
      addScroll(delta, height, cellAt(event.clientX, event.clientY));
    }
    function touchStart(event: PointerEvent) {
      if (event.pointerType !== 'touch' || !event.isPrimary) return;
      event.preventDefault(); // The touch tap below supplies mouse events; don't duplicate it via compatibility events.
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
      resize.pause(true);
      node.setPointerCapture(event.pointerId);
    }
    function touchMove(event: PointerEvent) {
      if (!gesture || event.pointerId !== gesture.id) return;
      const delta = gesture.y - event.clientY;
      if (!gesture.dragged && Math.abs(delta) < 7) return;
      gesture.dragged = true;
      gesture.y = event.clientY;
      addScroll(delta, screen.clientHeight / terminal.rows, cellAt(event.clientX, event.clientY));
    }
    function touchEnd(event: PointerEvent) {
      if (!gesture || event.pointerId !== gesture.id) return;
      const tap = event.type === 'pointerup' && !gesture.dragged && Math.abs(event.clientX - gesture.x) < 10;
      gesture = undefined;
      resize.pause(false);
      if (!tap) return;
      if (reportsMouse()) {
        const cell = cellAt(event.clientX, event.clientY);
        enqueue([
          { type: 'mouse', action: 'down', button: 'left', ...cell },
          { type: 'mouse', action: 'up', button: 'left', ...cell },
        ]);
      } else terminal.focus();
    }
    function mouseClick(event: MouseEvent) {
      if (!reportsMouse() && !terminal.hasSelection() && !(event as PointerEvent).pointerType?.includes('touch')) terminal.focus();
    }
    function stopKey(event: KeyboardEvent) { event.stopPropagation(); }
    function softKey(event: InputEvent) {
      if (event.cancelable && !event.isComposing && event.inputType === 'insertText' && event.data && modifiedKey(event.data)) event.preventDefault();
    }
    terminal.textarea?.setAttribute('aria-keyshortcuts', 'Shift+Escape Shift+PageUp');
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && event.shiftKey && event.key === 'PageUp' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        controls.current?.pageUp();
        return false;
      }
      if (event.shiftKey && event.key === 'Escape') {
        if (event.type === 'keydown') {
          event.preventDefault();
          node.closest('.coding-detail')?.querySelector<HTMLButtonElement>('[data-slot="segmented-control-item"][aria-checked="true"]')?.focus();
        }
        return false;
      }
      if (event.type === 'keydown' && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && modifiedKey(event.key)) {
        event.preventDefault();
        return false;
      }
      return true;
    });
    const input = terminal.onData(text);
    const observer = new ResizeObserver(dimensions);
    observer.observe(node);
    void document.fonts.ready.then(() => { if (mounted) dimensions(); });
    changeFont.current = size => {
      terminal.options.fontSize = size;
      dimensions();
    };
    const hide = () => { hiddenPage = true; disconnect(); };
    const show = (event: PageTransitionEvent) => { if (event.persisted) { hiddenPage = false; dimensions(); } };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    node.addEventListener('wheel', wheel, { capture: true, passive: false });
    node.addEventListener('pointerdown', touchStart, true);
    node.addEventListener('pointermove', touchMove, true);
    node.addEventListener('pointerup', touchEnd, true);
    node.addEventListener('pointercancel', touchEnd, true);
    node.addEventListener('lostpointercapture', touchEnd, true);
    node.addEventListener('beforeinput', softKey, true);
    node.addEventListener('keydown', stopKey);
    node.addEventListener('click', mouseClick);
    dimensions();
    return () => {
      mounted = false;
      disconnect();
      clearTimeout(wheelTimeout);
      observer.disconnect();
      input.dispose();
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      node.removeEventListener('wheel', wheel, true);
      node.removeEventListener('pointerdown', touchStart, true);
      node.removeEventListener('pointermove', touchMove, true);
      node.removeEventListener('pointerup', touchEnd, true);
      node.removeEventListener('pointercancel', touchEnd, true);
      node.removeEventListener('lostpointercapture', touchEnd, true);
      node.removeEventListener('beforeinput', softKey, true);
      node.removeEventListener('keydown', stopKey);
      node.removeEventListener('click', mouseClick);
      controls.current = null;
      changeFont.current = null;
      dispose();
    };
  }, [client, pane, fit, takeover]);
  useEffect(() => changeFont.current?.(fontSize), [fontSize]);

  return <div className="herdr-live herdr-control" data-scrolled={scrolled || undefined}>
    <div className="herdr-xterm" ref={mount}/>
    {!loaded && !reconnecting && <div className="herdr-terminal-skeleton"><CodingSkeleton detail/></div>}
    {reconnecting && <div className="herdr-live-status" role="status">{loaded ? '터미널에 다시 연결하는 중…' : '터미널에 연결하는 중…'}</div>}
    {scrolled && <Button className="herdr-terminal-latest" type="button" size="icon" variant="outline" aria-label="실시간으로 돌아가기"
      title="실시간으로 돌아가기" onClick={() => controls.current?.latest()}><ArrowDownToLine aria-hidden="true"/></Button>}
  </div>;
}
