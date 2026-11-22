import { useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { Button } from '../ui';
import { useHost } from '../host/context';
import { HostError } from '../host/client';
import { decodeHerdrFrame } from './herdrTerminalProtocol';
import { openHerdrXterm } from './herdrXterm';
import { CodingSkeleton } from './HerdrInbox';
import HerdrHistory, { type HistoryViewport } from './HerdrHistory';
import { followingTerminalTop, isHistoryPageKey, OBSERVED_TERMINAL_ROWS, terminalDragOffset,
  terminalUsedRows, terminalWheelOffset, type TerminalAnchor } from './herdrTerminalScroll';

type LiveViewport = {
  focus(): void;
  tracksMouse(): boolean;
  replay(event: KeyboardEvent): void;
  paste(text: string): void;
  atTop(): boolean;
  anchor(): TerminalAnchor | null;
  scrollPageUp(): void;
  follow(): boolean;
};

export type HerdrTerminalControls = { latest(keepFocus?: boolean): void; pageUp(): boolean };

type TerminalProps = {
  pane: string; onData(data: string): void; onModifiedKey(key: string): boolean; onGone(): void; fontSize: number;
};

export default function HerdrTerminal({ ref, ...props }: TerminalProps & { ref?: Ref<HerdrTerminalControls> }) {
  const stage = useRef<HTMLDivElement>(null);
  const live = useRef<LiveViewport>(null);
  const history = useRef<HistoryViewport>(null);
  const [scrolled, setScrolled] = useState(false);
  const [following, setFollowing] = useState(true);
  const inHistory = useRef(false);
  const afterSwitch = useRef<() => void>(null);
  const drag = useRef<{ id: number; x: number; y: number; captured: boolean; focus: boolean }>(null);

  function latest(keepFocus = false, resume?: (terminal: LiveViewport) => void) {
    history.current?.reset();
    drag.current = null;
    const wasPaused = live.current?.follow();
    if (!inHistory.current) {
      if (wasPaused && !keepFocus) live.current?.focus();
      return;
    }
    inHistory.current = false;
    afterSwitch.current = keepFocus ? null : () => {
      if (!live.current) return;
      live.current.focus();
      resume?.(live.current);
    };
    setScrolled(false);
  }

  function seek(offset: number, focus: boolean) {
    if (live.current?.tracksMouse() && !inHistory.current) return;
    history.current?.scroll(offset, () => {
      if (live.current?.tracksMouse()) { history.current?.reset(); return; }
      inHistory.current = true;
      afterSwitch.current = focus ? () => history.current?.focus() : null;
      setScrolled(true);
    }, () => live.current?.anchor() ?? null);
  }

  function page(direction: number, focus: boolean) {
    if (!inHistory.current && direction < 0 && live.current && !live.current.atTop()) {
      live.current.scrollPageUp();
      return;
    }
    const height = history.current?.page();
    if (height) seek(direction * Math.max(1, height - (history.current?.row() ?? 0)), focus);
  }

  useImperativeHandle(ref, () => ({ latest, pageUp() {
    if (live.current?.tracksMouse() && !inHistory.current) return false;
    page(-1, true);
    return true;
  } }));
  useLayoutEffect(() => {
    const action = afterSwitch.current;
    afterSwitch.current = null;
    action?.();
  }, [scrolled]);

  const onWheel = useEffectEvent((event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    const reading = inHistory.current;
    // A single trackpad gesture can keep dispatching to the original (now hidden) live layer.
    const target = event.target as Element;
    if (reading ? target.closest('.herdr-terminal-history') : live.current?.tracksMouse()) return;
    const offset = terminalWheelOffset(event.deltaX, event.deltaY, event.deltaMode, history.current?.row() ?? 16, history.current?.page() ?? 0);
    if (!offset) return;
    if (!reading && (offset > 0 || !live.current?.atTop())) {
      if (target.closest('.herdr-live-viewport')) event.stopPropagation(); // Let the browser scroll, not xterm.
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    seek(offset, Boolean(stage.current?.contains(document.activeElement)));
  });
  const onTouchStart = useEffectEvent((event: TouchEvent) => {
    const touch = event.touches[0];
    drag.current = !inHistory.current && event.touches.length === 1 && live.current?.atTop() && !live.current.tracksMouse()
      && (event.target as Element).closest('.herdr-live-viewport')
      ? { id: touch.identifier, x: touch.clientX, y: touch.clientY, captured: false, focus: Boolean(stage.current?.contains(document.activeElement)) }
      : null;
  });
  const onTouchMove = useEffectEvent((event: TouchEvent) => {
    const start = drag.current;
    const touch = event.touches[0];
    if (!start || event.touches.length !== 1 || start.id !== touch.identifier) return;
    if (!event.cancelable || (!inHistory.current && live.current?.tracksMouse())) { drag.current = null; return; }
    const dy = touch.clientY - start.y;
    const dx = touch.clientX - start.x;
    if (!start.captured && (dy <= 0 || dy <= Math.abs(dx))) {
      if (Math.abs(dx) >= 8 || dy <= -8) drag.current = null;
      return;
    }
    // Only a live gesture that starts at the top bypasses native scrolling.
    event.preventDefault();
    event.stopPropagation();
    const offset = start.captured ? -dy : terminalDragOffset(dx, dy);
    if (!offset) return;
    start.captured = true;
    start.y = touch.clientY;
    seek(offset, start.focus);
  });
  useEffect(() => {
    const node = stage.current!;
    const wheel = (event: WheelEvent) => onWheel(event);
    node.addEventListener('wheel', wheel, { capture: true, passive: false });
    const start = (event: TouchEvent) => onTouchStart(event);
    const move = (event: TouchEvent) => onTouchMove(event);
    const end = () => { drag.current = null; };
    node.addEventListener('touchstart', start, { capture: true, passive: true });
    node.addEventListener('touchmove', move, { capture: true, passive: false });
    node.addEventListener('touchend', end, true);
    node.addEventListener('touchcancel', end, true);
    return () => {
      node.removeEventListener('wheel', wheel, true);
      node.removeEventListener('touchstart', start, true);
      node.removeEventListener('touchmove', move, true);
      node.removeEventListener('touchend', end, true);
      node.removeEventListener('touchcancel', end, true);
    };
  }, []);

  return <div ref={stage} className="herdr-terminal" data-scrolled={scrolled || undefined}
    onKeyDownCapture={event => {
      if (event.defaultPrevented || (!inHistory.current && live.current?.tracksMouse())) return;
      if (!event.ctrlKey && !event.altKey && !event.metaKey && isHistoryPageKey(event.key, event.shiftKey, inHistory.current)) {
        event.preventDefault();
        event.stopPropagation();
        page(event.key === 'PageUp' ? -1 : 1, true);
      } else if (inHistory.current && !(event.target as HTMLElement).closest('button')) {
        if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;
        if ((event.metaKey || event.ctrlKey) && !event.altKey) {
          if (event.key.toLowerCase() === 'c' && (history.current?.hasSelection() || window.getSelection()?.toString())) return;
          if (event.key.toLowerCase() === 'v') return; // The paste event carries the actual text.
        }
        const original = event.nativeEvent;
        event.preventDefault();
        event.stopPropagation();
        latest(false, terminal => terminal.replay(original));
      }
    }}
    onPasteCapture={event => {
      if (!inHistory.current || event.defaultPrevented) return;
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      latest(false, terminal => terminal.paste(text));
    }}>
    <div className="herdr-terminal-live" inert={scrolled}>
      <ObservedTerminal {...props} controls={live} onFollowing={setFollowing}/>
    </div>
    <div className="herdr-terminal-history" inert={!scrolled}>
      <HerdrHistory pane={props.pane} onGone={props.onGone} onBottom={() => latest()} controls={history} fontSize={props.fontSize}/>
    </div>
    {(scrolled || !following) && <Button className="herdr-terminal-latest" type="button" size="icon" variant="outline"
      aria-label="실시간으로 돌아가기" title="실시간으로 돌아가기" onClick={() => latest()}><ArrowDownToLine aria-hidden="true"/></Button>}
  </div>;
}

function ObservedTerminal({ pane, onData, onModifiedKey, onGone, fontSize, controls, onFollowing }: TerminalProps & {
  controls: RefObject<LiveViewport | null>; onFollowing(following: boolean): void;
}) {
  const { client } = useHost();
  const mount = useRef<HTMLDivElement>(null);
  const scrollport = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const data = useEffectEvent(onData);
  const modifiedKey = useEffectEvent(onModifiedKey);
  const gone = useEffectEvent(onGone);
  const initialSize = useEffectEvent(() => fontSize);
  const followingChanged = useEffectEvent(onFollowing);
  const resizeFont = useRef<(size: number) => void>(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('');
  const [networkNote, setNetworkNote] = useState('');

  useEffect(() => {
    const node = mount.current!;
    const viewport = scrollport.current!;
    const content = clip.current!;
    const { terminal, fit, dispose } = openHerdrXterm(node, { scrollback: 0, rows: OBSERVED_TERMINAL_ROWS, fontSize: initialSize() });
    const screen = node.querySelector<HTMLElement>('.xterm-screen')!;
    let usedRows = 1, rowHeight = 0, projectedTop = 0;
    let following = true;
    const end = () => viewport.scrollHeight - viewport.clientHeight;
    function setFollowing(next: boolean) {
      if (following === next) return;
      following = next;
      followingChanged(next);
    }
    function position(top: number) {
      viewport.scrollTop = top;
      projectedTop = viewport.scrollTop;
    }
    function userScroll() {
      if (viewport.scrollTop === projectedTop) return;
      projectedTop = viewport.scrollTop;
      setFollowing(projectedTop >= end() - 1);
    }
    function follow() {
      if (following) return false;
      setFollowing(true);
      position(end());
      return true;
    }
    function project() {
      const top = viewport.scrollTop;
      rowHeight = screen.getBoundingClientRect().height / terminal.rows;
      if (!rowHeight) return;
      // Render the whole observer grid; only the occupied portion contributes to native scroll.
      node.style.height = `${rowHeight * terminal.rows}px`;
      content.style.height = `${rowHeight * usedRows}px`;
      const bottom = end();
      position(followingTerminalTop(top, bottom, following));
      if (!following && projectedTop >= bottom - 1) setFollowing(true);
    }
    const lineText = (row: number) => terminal.buffer.active.getLine(row)?.translateToString(true);
    function projectFrame() {
      usedRows = terminalUsedRows(terminal.rows, terminal.buffer.active.cursorY, lineText);
      project();
    }
    viewport.addEventListener('scroll', userScroll, { passive: true });
    controls.current = {
      focus: () => terminal.focus(),
      tracksMouse: () => terminal.modes.mouseTrackingMode !== 'none',
      replay(event) {
        const key = event.key;
        if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && [...key].length === 1) {
          if (!modifiedKey(key)) terminal.input(key, true);
        } else terminal.textarea?.dispatchEvent(new KeyboardEvent('keydown', {
          key, code: event.code, keyCode: event.keyCode, location: event.location, repeat: event.repeat,
          ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey, shiftKey: event.shiftKey, bubbles: true, cancelable: true,
        }));
      },
      paste: text => terminal.paste(text),
      atTop: () => viewport.scrollTop <= 1,
      anchor() {
        if (terminal.buffer.active.type !== 'normal') return null;
        for (let row = 0; row + 1 < usedRows; row++) {
          const line = lineText(row)?.trimEnd(), next = lineText(row + 1)?.trimEnd();
          if (line && next) return { row, line, next };
        }
        return null;
      },
      scrollPageUp() {
        viewport.scrollTop -= Math.max(1, viewport.clientHeight - rowHeight);
        userScroll();
      },
      follow,
    };
    // Keep Ghost's global shortcuts out of the terminal. Shift+Esc exits terminal focus without sending input.
    terminal.textarea?.setAttribute('aria-keyshortcuts', 'Shift+Escape');
    terminal.textarea?.setAttribute('title', 'Shift+Esc: 터미널에서 포커스 나가기');
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && modifiedKey(event.key)) {
        event.preventDefault();
        return false;
      }
      if (event.key !== 'Escape' || !event.shiftKey) return true;
      if (event.type === 'keydown') {
        event.preventDefault();
        node.closest('.coding-detail')?.querySelector<HTMLButtonElement>('[data-slot=\"segmented-control-item\"][aria-checked=\"true\"]')?.focus();
      }
      return false;
    });
    const keys = (event: KeyboardEvent) => event.stopPropagation();
    const softKey = (event: InputEvent) => {
      if (event.cancelable && !event.isComposing && event.inputType === 'insertText' && event.data && modifiedKey(event.data)) event.preventDefault();
    };
    node.addEventListener('beforeinput', softKey, true);
    node.addEventListener('keydown', keys);
    const input = terminal.onData(value => { follow(); data(value); });

    let stream: AbortController | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let lost = false;
    let seen = false;
    let cols = 0, backoff = 600;
    let lastError = '';

    function connect() {
      if (closed) return;
      stream?.abort();
      clearTimeout(retryTimer);
      const cursor = new AbortController();
      stream = cursor;
      const width = cols, height = OBSERVED_TERMINAL_ROWS;
      let painted = false, sequence = -Infinity;
      void (async () => {
        try {
          const result = await client.herdrTerminal(pane, width, height, frame => {
            if (cursor.signal.aborted || frame.width !== width || frame.height !== height || frame.seq <= sequence) return;
            if (!painted && !frame.full) return;
            const first = !painted;
            painted = true;
            sequence = frame.seq;
            terminal.write(decodeHerdrFrame(frame.bytes), () => {
              if (cursor.signal.aborted) return;
              projectFrame();
              if (!first) return;
              seen = true;
              setLoaded(true);
              lost = false;
              backoff = 600;
              clearTimeout(quietTimer);
              setNetworkNote('');
              setStatus('');
            });
          }, cursor.signal);
          if (cursor.signal.aborted) return;
          if (result === 'end') { gone(); return; }
          lastError = '';
        } catch (reason) {
          if (cursor.signal.aborted) return;
          if (reason instanceof HostError && reason.code === 'not_found') { gone(); return; }
          lastError = reason instanceof HostError ? reason.message : '';
        }
        if (!lost) {
          lost = true;
          quietTimer = setTimeout(() => {
            if (lastError) setNetworkNote(lastError);
            setStatus(seen ? '터미널에 다시 연결하는 중…' : '터미널에 연결하는 중…');
          }, 1500);
        }
        retryTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 5000);
      })();
    }

    function resize() {
      if (closed || !viewport.clientWidth || !viewport.clientHeight) return;
      const size = fit.proposeDimensions();
      if (!size) return;
      // The observer is top-anchored. A phone-sized row count would crop the remote prompt away.
      const width = Math.min(300, Math.max(20, size.cols));
      if (width === cols) return;
      cols = width;
      terminal.resize(cols, OBSERVED_TERMINAL_ROWS);
      connect();
    }
    resizeFont.current = size => {
      if (terminal.options.fontSize !== size) {
        terminal.options.fontSize = size;
        resize();
      }
    };
    const geometry = new ResizeObserver(() => {
      project();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 250);
    });
    geometry.observe(viewport);
    geometry.observe(screen);
    void document.fonts.ready.then(resize);
    // Clicking anywhere in the terminal focuses its input, including padding and an empty pane.
    const focus = () => { if (!terminal.hasSelection()) terminal.focus(); };
    viewport.addEventListener('click', focus);
    return () => {
      closed = true;
      stream?.abort();
      clearTimeout(resizeTimer);
      clearTimeout(retryTimer);
      clearTimeout(quietTimer);
      geometry.disconnect();
      resizeFont.current = null;
      controls.current = null;
      node.removeEventListener('keydown', keys);
      node.removeEventListener('beforeinput', softKey, true);
      viewport.removeEventListener('click', focus);
      viewport.removeEventListener('scroll', userScroll);
      input.dispose();
      dispose();
    };
  }, [client, pane, controls]);
  useEffect(() => resizeFont.current?.(fontSize), [fontSize]);

  return <div className="herdr-live">
    <div className="herdr-live-viewport" ref={scrollport}>
      <div className="herdr-live-clip" ref={clip}><div className="herdr-xterm" ref={mount}/></div>
    </div>
    {!loaded && !status && <div className="herdr-terminal-skeleton"><CodingSkeleton detail/></div>}
    {status && <div className="herdr-live-status" role="status">{status}{networkNote && <span>{networkNote}</span>}</div>}
  </div>;
}
