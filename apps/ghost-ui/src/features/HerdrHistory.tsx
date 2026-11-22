import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { useHost } from '../host/context';
import { HostError } from '../host/client';
import { Button, InlineError } from '../ui';
import { openHerdrXterm } from './herdrXterm';
import { CodingSkeleton } from './HerdrInbox';

export default function HerdrHistory({ pane, onGone, fontSize }: { pane: string; onGone(): void; fontSize: number }) {
  const { client } = useHost();
  const mount = useRef<HTMLDivElement>(null);
  const scrollport = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const jumpToBottom = useRef<() => void>(null);
  const gone = useEffectEvent(onGone);
  const initialSize = useEffectEvent(() => fontSize);
  const resizeFont = useRef<(size: number) => void>(null);
  const [loading, setLoading] = useState(true);
  const [scrolled, setScrolled] = useState(false);
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
    let jumpRequested = false;
    let rowHeight = 0;
    // Use the browser's scrollport for wheel and touch momentum; xterm renders its corresponding rows.
    function projectScroll() {
      if (!rowHeight || writing) return;
      const { baseY } = terminal.buffer.active;
      const end = viewport.scrollHeight - viewport.clientHeight;
      if (jumpRequested && viewport.scrollTop < end - 1) viewport.scrollTop = end;
      const firstRow = jumpRequested || viewport.scrollTop >= end - 1 ? baseY
        : Math.min(baseY, Math.max(0, Math.round(viewport.scrollTop / rowHeight)));
      projecting = true;
      terminal.scrollToLine(firstRow);
      projecting = false;
      pinned = firstRow === baseY;
      setScrolled(!pinned);
    }
    function sizeScrollRange() {
      space.style.height = `${terminal.buffer.active.baseY * rowHeight}px`;
    }
    function setScrollPosition(line: number) {
      sizeScrollRange();
      viewport.scrollTop = line === terminal.buffer.active.baseY ? viewport.scrollHeight : line * rowHeight;
      projectScroll();
    }
    const userScroll = () => { jumpRequested = false; };
    const wheel = (event: WheelEvent) => { userScroll(); event.stopPropagation(); };
    viewport.addEventListener('pointerdown', userScroll);
    viewport.addEventListener('keydown', userScroll);
    viewport.addEventListener('wheel', wheel, { capture: true, passive: true });
    viewport.addEventListener('scroll', projectScroll, { passive: true });
    const scroll = terminal.onScroll(() => {
      if (!writing && !projecting && rowHeight) setScrollPosition(terminal.buffer.active.viewportY);
    });
    jumpToBottom.current = () => {
      // A phone can still deliver scroll events from the preceding swipe after the tap.
      jumpRequested = true;
      setScrollPosition(terminal.buffer.active.baseY);
    };
    const resize = () => {
      if (request.signal.aborted || !node.clientHeight) return;
      const follow = pinned;
      fit.fit();
      rowHeight = screen.getBoundingClientRect().height / terminal.rows;
      setScrollPosition(follow ? terminal.buffer.active.baseY : terminal.buffer.active.viewportY);
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
      try {
        const output = await client.herdrOutput(pane, request.signal);
        if (request.signal.aborted) return;
        await repaint(output.text);
        if (request.signal.aborted) return;
        setError('');
      } catch (reason) {
        if (request.signal.aborted) return;
        if (reason instanceof HostError && reason.code === 'not_found') { gone(); return; }
        setError(reason instanceof Error ? reason.message : '기록을 불러오지 못했습니다.');
      }
      setLoading(false);
      timer = setTimeout(() => void load(), 3000);
    }
    void load();
    return () => {
      request.abort();
      clearTimeout(timer);
      viewport.removeEventListener('wheel', wheel, true);
      viewport.removeEventListener('pointerdown', userScroll);
      viewport.removeEventListener('keydown', userScroll);
      viewport.removeEventListener('scroll', projectScroll);
      geometry.disconnect();
      scroll.dispose();
      dispose();
      jumpToBottom.current = null;
      resizeFont.current = null;
    };
  }, [client, pane]);
  useEffect(() => resizeFont.current?.(fontSize), [fontSize]);

  return <section className="herdr-live herdr-history" aria-label="터미널 기록">
    <div className="herdr-history-scroll" ref={scrollport} tabIndex={0} aria-label="기록 스크롤">
      <div className="herdr-xterm" ref={mount}/>
      <div aria-hidden="true" ref={spacer}/>
    </div>
    {loading && <div className="herdr-terminal-skeleton"><CodingSkeleton detail/></div>}
    {error && <InlineError className="herdr-history-error">{error}</InlineError>}
    {scrolled && <Button className="herdr-history-bottom" type="button" size="sm" variant="outline" onClick={() => jumpToBottom.current?.()}>
      <ArrowDown aria-hidden="true"/>맨 아래로
    </Button>}
  </section>;
}
