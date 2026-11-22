import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useHost } from '../host/context';
import { HostError } from '../host/client';
import { decodeHerdrFrame } from './herdrTerminalProtocol';
import { openHerdrXterm } from './herdrXterm';

export default function HerdrTerminal({ pane, onData, onModifiedKey, onGone }: {
  pane: string; onData(data: string): void; onModifiedKey(key: string): boolean; onGone(): void;
}) {
  const { client } = useHost();
  const mount = useRef<HTMLDivElement>(null);
  const data = useEffectEvent(onData);
  const modifiedKey = useEffectEvent(onModifiedKey);
  const gone = useEffectEvent(onGone);
  const [status, setStatus] = useState('터미널을 불러오는 중…');
  const [networkNote, setNetworkNote] = useState('');

  useEffect(() => {
    const node = mount.current!;
    const { terminal, fit, dispose } = openHerdrXterm(node, { scrollback: 0 });
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
    const input = terminal.onData(value => data(value));

    let stream: AbortController | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let lost = false;
    let seen = false;
    let cols = 0, rows = 0, backoff = 600;
    let lastError = '';

    function connect() {
      if (closed) return;
      stream?.abort();
      clearTimeout(retryTimer);
      const cursor = new AbortController();
      stream = cursor;
      const width = cols, height = rows;
      let painted = false, sequence = -Infinity;
      void (async () => {
        try {
          const result = await client.herdrTerminal(pane, width, height, frame => {
            if (cursor.signal.aborted || frame.width !== width || frame.height !== height || frame.seq <= sequence) return;
            if (!painted && !frame.full) return;
            terminal.write(decodeHerdrFrame(frame.bytes));
            sequence = frame.seq;
            if (!painted) {
              painted = seen = true;
              lost = false;
              backoff = 600;
              clearTimeout(quietTimer);
              setNetworkNote('');
              setStatus('');
            }
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
      if (closed || !node.clientWidth || !node.clientHeight) return;
      const size = fit.proposeDimensions();
      if (!size) return;
      // Match the observer's supported window, including very wide screens and short mobile viewports.
      const width = Math.min(300, Math.max(20, size.cols));
      const height = Math.min(120, Math.max(5, size.rows));
      if (width === cols && height === rows) return;
      cols = width;
      rows = height;
      terminal.resize(cols, rows);
      connect();
    }
    const geometry = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 250);
    });
    geometry.observe(node);
    void document.fonts.ready.then(resize);
    // Clicking anywhere in the terminal focuses its input, including padding and an empty pane.
    const focus = () => { if (!terminal.hasSelection()) terminal.focus(); };
    node.addEventListener('click', focus);
    return () => {
      closed = true;
      stream?.abort();
      clearTimeout(resizeTimer);
      clearTimeout(retryTimer);
      clearTimeout(quietTimer);
      geometry.disconnect();
      node.removeEventListener('keydown', keys);
      node.removeEventListener('beforeinput', softKey, true);
      node.removeEventListener('click', focus);
      input.dispose();
      dispose();
    };
  }, [client, pane]);

  return <div className="herdr-live">
    <div className="herdr-xterm" ref={mount}/>
    {status && <div className="herdr-live-status" role="status">{status}{networkNote && <span>{networkNote}</span>}</div>}
  </div>;
}
