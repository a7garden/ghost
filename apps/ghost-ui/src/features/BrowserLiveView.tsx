import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, CornerDownLeft, Delete, Monitor, RotateCw, Send } from 'lucide-react';
import { Button, InlineError, Input } from '../ui';
import type { BrowserControl, BrowserFrame } from '../host/client';
import { useHost } from '../host/context';

/** How often the frame refreshes while nothing is happening; an input refreshes it at once. */
const IDLE_REFRESH_MS = 1500;

/** Where a tap lands as fractions of the shown frame, clamped to it. Pure; tests pin it. */
export function tapPoint(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }): { x: number; y: number } {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return { x: clamp((clientX - box.left) / box.width), y: clamp((clientY - box.top) / box.height) };
}

/**
 * The owner's hands on a Ghost's browser during a handoff, from any paired device: the Host sends the
 * page as an image and replays taps, text and keys into the same session. Nothing here reaches a model.
 */
export function BrowserLiveView({ decisionId, disabled }: { decisionId: string; disabled: boolean }) {
  const { client } = useHost();
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [windowOpened, setWindowOpened] = useState(false);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (pending.current || !alive.current) return;
    pending.current = true;
    if (timer.current) clearTimeout(timer.current);
    try {
      const next = await client.browserFrame(decisionId);
      if (alive.current) { setFrame(next); setError(null); }
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : '브라우저 화면을 받지 못했습니다.');
    } finally {
      pending.current = false;
      // A hidden tab stops asking; coming back refreshes at once.
      if (alive.current && document.visibilityState === 'visible') timer.current = setTimeout(() => void refresh(), IDLE_REFRESH_MS);
    }
  }, [client, decisionId]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const send = async (input: BrowserControl) => {
    if (disabled || sending) return;
    setSending(true);
    try {
      await client.browserControl(decisionId, input);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '입력을 보내지 못했습니다.');
    } finally {
      setSending(false);
      await refresh();
    }
  };

  const onTap = (event: MouseEvent<HTMLImageElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    void send({ type: 'tap', ...tapPoint(event.clientX, event.clientY, box) });
  };

  const openWindow = async () => {
    try { await client.browserWindow(decisionId); setWindowOpened(true); setError(null); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Mac에서 창을 열지 못했습니다.'); }
  };

  return <div className="browser-live">
    <div className="browser-live__bar">
      <span className="browser-live__url truncate">{frame?.url || '화면을 불러오는 중…'}</span>
      <button type="button" className="browser-live__icon" aria-label="뒤로" title="뒤로" disabled={disabled || sending} onClick={() => void send({ type: 'navigate', action: 'back' })}><ArrowLeft size={15}/></button>
      <button type="button" className="browser-live__icon" aria-label="새로고침" title="새로고침" disabled={disabled || sending} onClick={() => void send({ type: 'navigate', action: 'reload' })}><RotateCw size={15}/></button>
    </div>
    <div className="browser-live__screen" aria-busy={sending}>
      {frame
        ? <img src={`data:${frame.mediaType};base64,${frame.image}`} alt={frame.title ? `브라우저 화면: ${frame.title}` : '브라우저 화면'}
          width={frame.width} height={frame.height} draggable={false} onClick={disabled ? undefined : onTap}/>
        : <div className="browser-live__placeholder">브라우저 화면을 불러오는 중입니다</div>}
    </div>
    <div className="browser-live__keys" role="group" aria-label="브라우저 조작">
      <button type="button" className="browser-live__icon" aria-label="위로 스크롤" title="위로" disabled={disabled || sending} onClick={() => void send({ type: 'scroll', dy: -400 })}><ChevronUp size={15}/></button>
      <button type="button" className="browser-live__icon" aria-label="아래로 스크롤" title="아래로" disabled={disabled || sending} onClick={() => void send({ type: 'scroll', dy: 400 })}><ChevronDown size={15}/></button>
      <button type="button" className="browser-live__icon" aria-label="지우기" title="지우기" disabled={disabled || sending} onClick={() => void send({ type: 'key', key: 'Backspace' })}><Delete size={15}/></button>
      <button type="button" className="browser-live__icon" aria-label="Enter" title="Enter" disabled={disabled || sending} onClick={() => void send({ type: 'key', key: 'Enter' })}><CornerDownLeft size={15}/></button>
      <button type="button" className="browser-live__key" disabled={disabled || sending} onClick={() => void send({ type: 'key', key: 'Tab' })}>Tab</button>
    </div>
    <form className="browser-live__type" onSubmit={event => { event.preventDefault(); if (text) { void send({ type: 'text', text }); setText(''); } }}>
      <Input aria-label="브라우저에 입력할 글자" placeholder="입력칸을 먼저 탭한 뒤 글자를 보내세요" value={text} maxLength={2000}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} disabled={disabled}
        onChange={event => setText(event.target.value)}/>
      <Button type="submit" size="icon" aria-label="글자 보내기" title="글자 보내기" disabled={disabled || sending || !text} className="rounded-pill"><Send/></Button>
    </form>
    {error && <InlineError>{error}</InlineError>}
    {frame?.windowAvailable !== false && <button type="button" className="browser-live__window" disabled={disabled || windowOpened} onClick={() => void openWindow()}>
      <Monitor size={14} aria-hidden="true"/>{windowOpened ? 'Mac에 Chrome 창을 열었습니다' : 'Mac 앞이라면 Chrome 창으로 열기'}
    </button>}
  </div>;
}
