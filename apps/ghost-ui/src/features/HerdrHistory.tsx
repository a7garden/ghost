import { useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react';
import { useHost } from '../host/context';
import { HostError } from '../host/client';
import { InlineError } from '../ui';
import { openHerdrXterm } from './herdrXterm';
import { terminalHistoryBoundary, type TerminalAnchor } from './herdrTerminalScroll';

export type HistoryViewport = {
  scroll(offset: number, open: () => void, liveAnchor: () => TerminalAnchor | null): void;
  reset(): void;
  page(): number;
  row(): number;
  focus(): void;
  hasSelection(): boolean;
};

export default function HerdrHistory({ pane, onGone, onBottom, controls, fontSize }: {
  pane: string; onGone(): void; onBottom(): void; controls: RefObject<HistoryViewport | null>; fontSize: number;
}) {
  const { client } = useHost();
  const mount = useRef<HTMLDivElement>(null);
  const scrollport = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const gone = useEffectEvent(onGone);
  const bottom = useEffectEvent(onBottom);
  const initialSize = useEffectEvent(() => fontSize);
  const resizeFont = useRef<(size: number) => void>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const node = mount.current!;
    const viewport = scrollport.current!;
    const space = spacer.current!;
    const { terminal, fit, dispose } = openHerdrXterm(node, { disableStdin: true, convertEol: true, scrollback: 10_000, cursorInactiveStyle: 'none', fontSize: initialSize() });
    terminal.textarea?.setAttribute('aria-label', '터미널 기록 (읽기 전용)');
    const screen = node.querySelector<HTMLElement>('.xterm-screen')!;
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let previous: string | undefined;
    let writing = false;
    let pinned = true;
    let projecting = false;
    let reachedHistory = false;
    let pendingOffset = 0;
    let loading = false;
    let scrolled = false;
    let top = 0;
    let open: (() => void) | undefined;
    let liveBoundary: TerminalAnchor | null = null;
    let lastRow = 0;
    const textAt = (row: number) => terminal.buffer.active.getLine(row)?.translateToString(true).trimEnd();
    let rowHeight = 0;
    // Use the browser's scrollport for wheel and touch momentum; xterm renders its corresponding rows.
    function projectScroll(user = false) {
      if (!rowHeight || writing) return;
      const last = lastRow;
      const end = viewport.scrollHeight - viewport.clientHeight;
      pinned = viewport.scrollTop >= end - 1;
      const firstRow = pinned ? last : Math.min(last, Math.max(0, Math.round(viewport.scrollTop / rowHeight)));
      projecting = true;
      terminal.scrollToLine(firstRow);
      projecting = false;
      const moved = viewport.scrollTop !== top;
      top = viewport.scrollTop;
      if (scrolled && user && moved && pinned && reachedHistory) bottom();
      else if (scrolled && !pinned) reachedHistory = true;
    }
    function sizeScrollRange() {
      const { baseY } = terminal.buffer.active;
      lastRow = scrolled ? terminalHistoryBoundary(baseY, terminal.rows, liveBoundary, textAt) : baseY;
      space.style.height = `${lastRow * rowHeight}px`;
    }
    function setScrollPosition(line: number) {
      sizeScrollRange();
      viewport.scrollTop = Math.min(line, lastRow) * rowHeight;
      projectScroll();
    }
    function scrollBy(offset: number) {
      viewport.scrollTop += offset;
      projectScroll(true);
    }
    function applyEntry() {
      if (!open || !rowHeight || !terminal.buffer.active.baseY) return;
      const enter = open;
      const offset = pendingOffset;
      open = undefined;
      pendingOffset = 0;
      if (offset >= 0) return;
      // Where possible, align the cut to the top of the observed screen, not the tail of the capture.
      scrolled = true;
      setScrollPosition(terminal.buffer.active.baseY);
      if (!lastRow) { scrolled = false; setScrollPosition(terminal.buffer.active.baseY); return; }
      scrollBy(offset);
      enter();
    }
    const wheel = (event: WheelEvent) => event.stopPropagation();
    const nativeScroll = () => projectScroll(true);
    viewport.addEventListener('wheel', wheel, { capture: true, passive: true });
    viewport.addEventListener('scroll', nativeScroll, { passive: true });
    const scroll = terminal.onScroll(() => {
      if (!writing && !projecting && rowHeight) setScrollPosition(terminal.buffer.active.viewportY);
    });
    controls.current = {
      scroll(offset, enter, liveAnchor) {
        if (scrolled) { scrollBy(offset); return; }
        if (!open) {
          if (offset >= 0) return;
          open = enter;
          liveBoundary = liveAnchor();
          pendingOffset = offset;
          applyEntry();
          void load();
        } else {
          pendingOffset += offset;
          if (pendingOffset >= 0) { open = undefined; pendingOffset = 0; }
        }
      },
      reset() {
        if (!open && !scrolled) return;
        open = undefined;
        pendingOffset = 0;
        scrolled = false;
        reachedHistory = false;
        liveBoundary = null;
        setScrollPosition(terminal.buffer.active.baseY);
      },
      page: () => viewport.clientHeight,
      row: () => rowHeight || 16,
      focus: () => viewport.focus({ preventScroll: true }),
      hasSelection: () => terminal.hasSelection(),
    };
    const resize = () => {
      if (request.signal.aborted || !node.clientHeight) return;
      const follow = pinned;
      fit.fit();
      rowHeight = screen.getBoundingClientRect().height / terminal.rows;
      setScrollPosition(follow ? terminal.buffer.active.baseY : terminal.buffer.active.viewportY);
      applyEntry();
    };
    resizeFont.current = size => {
      if (terminal.options.fontSize !== size) {
        terminal.options.fontSize = size;
        resize();
      }
    };
    const geometry = new ResizeObserver(resize);
    geometry.observe(node);
    void document.fonts.ready.then(resize);

    async function repaint(text: string) {
      if (text === previous) return;
      const buffer = terminal.buffer.active;
      const follow = pinned;
      const position = buffer.viewportY;
      const append = previous !== undefined && text.startsWith(previous);
      // Preserve selection through both scrolling and snapshot replacement while the owner is copying.
      if (!append && terminal.hasSelection()) return;
      const anchor = !follow && !append ? buffer.getLine(position)?.translateToString(true) : undefined;
      const anchorNext = anchor ? buffer.getLine(position + 1)?.translateToString(true) : undefined;
      writing = true;
      if (!append) terminal.reset();
      const chunk = append ? text.slice(previous!.length) : `\x1b[?25l${text}`;
      previous = text;
      await new Promise<void>(resolve => terminal.write(chunk, resolve));
      if (request.signal.aborted) return;
      const after = terminal.buffer.active;
      let target = follow ? after.baseY : Math.min(after.baseY, position);
      if (!follow && !append) {
        // A rolling history window drops older rows. Re-anchor to the visible line pair when it survives.
        if (anchor) {
          let distance = Infinity;
          for (let line = 0; line <= after.baseY; line++) {
            const delta = Math.abs(line - position);
            if (delta < distance && after.getLine(line)?.translateToString(true) === anchor
                && (!anchorNext || after.getLine(line + 1)?.translateToString(true) === anchorNext)) {
              target = line;
              distance = delta;
              if (!delta) break;
            }
          }
        }
      }
      writing = false;
      if (append && !follow) {
        sizeScrollRange();
        projectScroll();
      } else setScrollPosition(target);
    }
    async function load() {
      if (request.signal.aborted || loading) return;
      clearTimeout(timer);
      loading = true;
      try {
        const output = await client.herdrOutput(pane, request.signal);
        if (request.signal.aborted) return;
        await repaint(output.text);
        if (request.signal.aborted) return;
        applyEntry();
        setError('');
      } catch (reason) {
        if (request.signal.aborted) return;
        if (reason instanceof HostError && reason.code === 'not_found') { gone(); return; }
        setError(reason instanceof Error ? reason.message : '기록을 불러오지 못했습니다.');
      } finally {
        open = undefined;
        pendingOffset = 0;
        loading = false;
        if (!request.signal.aborted) timer = setTimeout(() => void load(), 3000);
      }
    }
    void load();
    return () => {
      request.abort();
      clearTimeout(timer);
      viewport.removeEventListener('wheel', wheel, true);
      viewport.removeEventListener('scroll', nativeScroll);
      geometry.disconnect();
      scroll.dispose();
      dispose();
      controls.current = null;
      resizeFont.current = null;
    };
  }, [client, pane, controls]);
  useEffect(() => resizeFont.current?.(fontSize), [fontSize]);

  return <section className="herdr-live herdr-history" aria-label="터미널 기록">
    <div className="herdr-history-scroll" ref={scrollport} tabIndex={-1} aria-label="기록 스크롤">
      <div className="herdr-xterm" ref={mount}/>
      <div aria-hidden="true" ref={spacer}/>
    </div>
    {error && <InlineError className="herdr-history-error">{error}</InlineError>}
  </section>;
}
