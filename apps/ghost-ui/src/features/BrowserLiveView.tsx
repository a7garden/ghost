import { useCallback, useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CompositionEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, ArrowRight, CornerDownLeft, Monitor, RotateCw, Send } from 'lucide-react';
import { Button, InlineError, Input } from '../ui';
import { HostError, type BrowserInput } from '../host/client';
import { useHost } from '../host/context';
import { useTouch } from '../ui/adaptive';
import { shell } from '../host/shell';

/** Frames per second asked of the host's screencast; enough to follow a Ghost at a fraction of the cost. */
const STREAM_FPS = 8;
/** Pointer moves go out at most 20 times a second; the latest position wins. */
const MOVE_MIN_MS = 50;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 4000;
/** How far a touch may drift before the gesture becomes a drag-scroll instead of a tap. */
const TAP_SLOP_PX = 10;
/** A second press within this time and distance continues the double-click count. */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_SLOP_PX = 8;

/** The keys a page needs whole; a printable character instead flows through the text field (IME and paste included). */
export const SPECIAL_KEYS: Record<string, true> = {
  Enter: true, Tab: true, Backspace: true, Delete: true, Escape: true,
  ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true,
  Home: true, End: true, PageUp: true, PageDown: true,
};

/** The host's modifier bits: alt=1, ctrl=2, meta=4, shift=8. Pure; tests pin it. */
export function modifierBitsOf(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

/**
 * Special keys forward in both phases. Ordinary printables flow through the text field for IME;
 * modified printables use key events so shortcuts reach the page without the field intercepting them.
 * Pure; tests pin it.
 */
export function keyInputOf(key: string, code: string, modifiers: number, event: 'down' | 'up'): BrowserInput | null {
  if (SPECIAL_KEYS[key]) return { type: 'key', event, key, code, modifiers };
  if (key.length !== 1 || modifiers === 0) return null;
  return { type: 'key', event, key, code, ...(event === 'down' && (modifiers & 7) === 0 ? { text: key } : {}), modifiers };
}

/**
 * Where a pointer lands in the page's viewport CSS pixels: the frame letterboxes inside the box,
 * so the point scales from the shown image, not the element. Pure; tests pin it.
 */
export function viewportPoint(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number },
  frame: { width: number; height: number }): { x: number; y: number } {
  const scale = Math.min(box.width / frame.width, box.height / frame.height) || 0;
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  return {
    x: clamp((clientX - (box.left + (box.width - frame.width * scale) / 2)) / scale, frame.width),
    y: clamp((clientY - (box.top + (box.height - frame.height * scale) / 2)) / scale, frame.height),
  };
}

const mouseButton = (button: number): 'left' | 'middle' | 'right' | 'none' => button === 1 ? 'middle' : button === 2 ? 'right' : button === 0 ? 'left' : 'none';

type Status = 'connecting' | 'live' | 'reconnecting' | 'ended';

/**
 * The owner's hands on a Ghost's browser, live, from any paired device: the Host streams the page
 * as JPEG frames and replays pointers, keys, text and IME into the same session. Nothing here
 * reaches a model. The stream pauses while the document is hidden and reconnects with backoff.
 */
export function BrowserLiveView({ conversationId, compact = false }: { conversationId: string; compact?: boolean }) {
  const { client } = useHost();
  const touch = useTouch();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const touchFieldRef = useRef<HTMLInputElement>(null);
  /** The frame size the pointer math scales into; mirrored from state so native listeners read it. */
  const dimsRef = useRef<{ width: number; height: number } | null>(null);
  const pendingViewportRef = useRef<{ width: number; height: number } | null>(null);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [page, setPage] = useState<{ url: string; title: string } | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [endReason, setEndReason] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [macOpened, setMacOpened] = useState(false);
  const statusRef = useRef<Status>('connecting');
  const abortRef = useRef<AbortController | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failuresRef = useRef(0);
  const connectRef = useRef<() => void>(() => {});
  const imageRef = useRef<HTMLImageElement | null>(null);
  const frameTokenRef = useRef(0);
  const inputQueueRef = useRef<Promise<void> | null>(null);
  const inputGenerationRef = useRef(0);
  const moveGateRef = useRef<{ at: number; timer: ReturnType<typeof setTimeout> | null }>({ at: 0, timer: null });
  const pointerRef = useRef({
    id: null as number | null,
    clientX: 0, clientY: 0,
    downClientX: 0, downClientY: 0,
    lastWheelY: 0,
    wheelPendingY: 0,
    moved: false,
    button: 0,
    clickCount: 1,
  });
  const lastClickRef = useRef({ x: 0, y: 0, at: 0, count: 0 });
  /** Chromium replays a composition's committed text as one more input after compositionend; skip that one. */
  const compositionGuardRef = useRef(false);
  statusRef.current = status;

  const drawFrame = useCallback((data: string, width: number, height: number) => {
    const pending = pendingViewportRef.current;
    if (pending && (pending.width !== width || pending.height !== height)) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const image = imageRef.current ??= new Image();
    const token = ++frameTokenRef.current;
    image.onload = () => {
      if (token !== frameTokenRef.current || canvasRef.current !== canvas) return;
      const pending = pendingViewportRef.current;
      if (pending && (pending.width !== width || pending.height !== height)) return;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      canvas.getContext('2d')?.drawImage(image, 0, 0);
      const dims = dimsRef.current;
      if (!dims || dims.width !== width || dims.height !== height) {
        const next = { width, height };
        dimsRef.current = next;
        setDims(next);
      }
      pendingViewportRef.current = null;
    };
    image.src = `data:image/jpeg;base64,${data}`;
  }, []);

  const scheduleReconnect = useCallback(() => {
    setStatus(current => current === 'ended' ? current : 'reconnecting');
    const attempt = ++failuresRef.current;
    if (reconnectRef.current !== null) clearTimeout(reconnectRef.current);
    reconnectRef.current = setTimeout(() => connectRef.current(), Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)));
  }, []);

  const connect = useCallback(() => {
    if (statusRef.current === 'ended') return; // the session is over; a 404 or end line settled that
    abortRef.current?.abort();
    if (reconnectRef.current !== null) clearTimeout(reconnectRef.current);
    reconnectRef.current = null;
    if (document.visibilityState !== 'visible') return; // hidden: the effect reconnects on return
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('connecting');
    const connectedAt = performance.now();
    void client.browserLive(conversationId, STREAM_FPS, event => {
      if (controller.signal.aborted) return;
      if (performance.now() - connectedAt >= BACKOFF_MAX_MS) failuresRef.current = 0;
      if (statusRef.current === 'connecting' || statusRef.current === 'reconnecting') setStatus('live');
      if (event.type === 'frame') drawFrame(event.data, event.width, event.height);
      else if (event.type === 'page') setPage({ url: event.url, title: event.title });
      else if (event.type === 'end') {
        controller.abort();
        setStatus('ended');
        setEndReason(event.reason);
      }
    }, controller.signal).then(() => {
      // The server closed the stream without an end line: watch again.
      if (!controller.signal.aborted) scheduleReconnect();
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      // The session itself is gone (404): say so instead of hammering a dead id.
      if (caught instanceof HostError && caught.code === 'not_found') { setStatus('ended'); setEndReason(null); return; }
      scheduleReconnect();
    });
  }, [client, conversationId, drawFrame, scheduleReconnect]);
  connectRef.current = connect;

  useEffect(() => {
    statusRef.current = 'connecting';
    setStatus('connecting');
    setEndReason(null);
    setPage(null);
    setInputError(null);
    dimsRef.current = null;
    setDims(null);
    failuresRef.current = 0;
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    connectRef.current();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') connectRef.current();
      else { abortRef.current?.abort(); if (reconnectRef.current !== null) clearTimeout(reconnectRef.current); }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      inputGenerationRef.current++;
      frameTokenRef.current++;
      pendingViewportRef.current = null;
      abortRef.current?.abort();
      if (reconnectRef.current !== null) clearTimeout(reconnectRef.current);
      if (moveGateRef.current.timer !== null) clearTimeout(moveGateRef.current.timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [conversationId]);

  const send = useCallback((input: BrowserInput): Promise<void> => {
    const generation = inputGenerationRef.current;
    const pending = (inputQueueRef.current ?? Promise.resolve()).then(async () => {
      if (generation !== inputGenerationRef.current || statusRef.current === 'ended') {
        if (input.type === 'viewport' && pendingViewportRef.current === input) pendingViewportRef.current = null;
        return;
      }
      try {
        await client.browserInput(conversationId, input);
        if (generation === inputGenerationRef.current) setInputError(null);
      } catch (caught) {
        if (generation !== inputGenerationRef.current) return;
        pendingViewportRef.current = null;
        inputGenerationRef.current++;
        setInputError(caught instanceof Error && caught.message ? caught.message : '입력을 전달하지 못했습니다.');
      }
    });
    inputQueueRef.current = pending;
    return pending;
  }, [client, conversationId]);

  useEffect(() => {
    const screen = screenRef.current;
    if (!screen || status !== 'live') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sentWidth = 0, sentHeight = 0;
    const resize = () => {
      if (!screen.clientWidth || !screen.clientHeight) return;
      const width = Math.max(320, Math.min(2560, screen.clientWidth));
      const height = Math.max(240, Math.min(1600, screen.clientHeight));
      clearTimeout(timer);
      if (width === sentWidth && height === sentHeight) return;
      timer = setTimeout(() => {
        if (document.visibilityState !== 'visible' || statusRef.current !== 'live') return;
        if (pointerRef.current.id !== null) { resize(); return; }
        sentWidth = width; sentHeight = height;
        if (dimsRef.current?.width === width && dimsRef.current.height === height) return;
        const input = { type: 'viewport' as const, width, height };
        pendingViewportRef.current = input;
        dimsRef.current = null;
        setDims(null);
        void send(input);
      }, 150);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(screen);
    resize();
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [send, status, page?.url]);

  const pointAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const frame = dimsRef.current;
    if (!canvas || !frame) return null;
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return viewportPoint(clientX, clientY, box, frame);
  };

  /** Moves and drag-scrolls leave at most MOVE_MIN_MS apart; the queued latest input flushes on a trailing tick. */
  const throttled = useCallback((build: () => BrowserInput | null) => {
    const gate = moveGateRef.current;
    const now = performance.now();
    const flush = () => {
      gate.at = performance.now();
      const input = build();
      if (input) void send(input);
    };
    if (now - gate.at >= MOVE_MIN_MS) {
      if (gate.timer !== null) clearTimeout(gate.timer);
      gate.timer = null;
      flush();
      return;
    }
    if (gate.timer) return;
    gate.timer = setTimeout(() => { gate.timer = null; flush(); }, MOVE_MIN_MS - (now - gate.at));
  }, [send]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = pointAt(event.clientX, event.clientY);
    if (!point || statusRef.current === 'ended') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.pointerType !== 'touch') fieldRef.current?.focus({ preventScroll: true });
    const last = lastClickRef.current;
    const now = performance.now();
    last.count = now - last.at < MULTI_CLICK_MS && Math.hypot(point.x - last.x, point.y - last.y) < MULTI_CLICK_SLOP_PX ? Math.min(3, last.count + 1) : 1;
    last.at = now; last.x = point.x; last.y = point.y;
    pointerRef.current = {
      id: event.pointerId,
      clientX: event.clientX, clientY: event.clientY,
      downClientX: event.clientX, downClientY: event.clientY,
      lastWheelY: event.clientY, wheelPendingY: 0, moved: false,
      button: event.button, clickCount: last.count,
    };
    if (event.pointerType !== 'touch') {
      void send({ type: 'mouse', event: 'down', x: point.x, y: point.y, button: mouseButton(event.button), clickCount: last.count as 1 | 2 | 3, modifiers: modifierBitsOf(event) });
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pointer = pointerRef.current;
    if (pointer.id !== event.pointerId || !dimsRef.current) return;
    pointer.clientX = event.clientX; pointer.clientY = event.clientY;
    const drift = Math.hypot(event.clientX - pointer.downClientX, event.clientY - pointer.downClientY);
    if (event.pointerType === 'touch') {
      if (!pointer.moved && drift < TAP_SLOP_PX) return; // may still become a tap
      pointer.moved = true;
      pointer.wheelPendingY += pointer.lastWheelY - event.clientY; // the content follows the finger
      pointer.lastWheelY = event.clientY;
      throttled(() => {
        const point = pointAt(pointer.clientX, pointer.clientY);
        const deltaY = pointer.wheelPendingY;
        pointer.wheelPendingY = 0;
        if (!point || Math.abs(deltaY) < 1) return null;
        return { type: 'mouse', event: 'wheel', x: point.x, y: point.y, button: 'none', deltaX: 0, deltaY };
      });
    } else if (event.buttons !== 0) { // moves only while a button is held
      pointer.moved = true;
      const modifiers = modifierBitsOf(event);
      throttled(() => {
        const point = pointAt(pointer.clientX, pointer.clientY);
        if (!point) return null;
        return { type: 'mouse', event: 'move', x: point.x, y: point.y, button: mouseButton(pointer.button), modifiers };
      });
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pointer = pointerRef.current;
    if (pointer.id !== event.pointerId) return;
    pointer.id = null;
    const point = pointAt(event.clientX, event.clientY);
    if (!point || statusRef.current === 'ended') return;
    if (event.pointerType === 'touch') {
      if (pointer.moved) return; // a drag already scrolled; it never clicks
      touchFieldRef.current?.focus({ preventScroll: true }); // raises the visible text field's keyboard
      void send({ type: 'mouse', event: 'down', x: point.x, y: point.y, button: 'left', clickCount: 1 })
        .then(() => send({ type: 'mouse', event: 'up', x: point.x, y: point.y, button: 'left', clickCount: 1 }));
    } else {
      void send({ type: 'mouse', event: 'up', x: point.x, y: point.y, button: mouseButton(event.button), clickCount: pointer.clickCount as 1 | 2 | 3, modifiers: modifierBitsOf(event) });
    }
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerRef.current.id === event.pointerId) pointerRef.current.id = null;
  };

  // React registers wheel listeners as passive; preventing page scroll needs our own.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      const frame = dimsRef.current;
      if (!frame || statusRef.current === 'ended') return;
      event.preventDefault();
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const point = viewportPoint(event.clientX, event.clientY, box, frame);
      void send({ type: 'mouse', event: 'wheel', x: point.x, y: point.y, button: 'none', deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifierBitsOf(event) });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [send]);

  // Keys from the text field bubble here: special keys forward, printables fall through to the field.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return; // the composition's text arrives at compositionend
    const input = keyInputOf(event.key, event.code, modifierBitsOf(event.nativeEvent), 'down');
    if (!input) return;
    event.preventDefault();
    event.stopPropagation();
    void send(input);
  };

  const onKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const input = keyInputOf(event.key, event.code, modifierBitsOf(event.nativeEvent), 'up');
    if (!input) return;
    event.preventDefault();
    event.stopPropagation();
    void send(input);
  };

  /** Desktop typing lands here: plain text goes out at once, the IME's committed text at compositionend. */
  const onFieldInput = (event: FormEvent<HTMLTextAreaElement>) => {
    if (touch || (event.nativeEvent as InputEvent).isComposing || compositionGuardRef.current) return;
    const field = event.currentTarget;
    const text = field.value.slice(0, 2000);
    if (!text) return;
    field.value = '';
    void send({ type: 'text', text });
  };

  const onCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    if (touch) return;
    const field = event.currentTarget;
    const text = field.value.slice(0, 2000);
    field.value = '';
    compositionGuardRef.current = true;
    setTimeout(() => { compositionGuardRef.current = false; }, 0);
    if (text) void send({ type: 'text', text });
  };

  const onFieldPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (touch) return; // the visible field holds the paste until 보내기
    const text = event.clipboardData.getData('text/plain').slice(0, 2000);
    if (!text) return;
    event.preventDefault();
    void send({ type: 'text', text });
  };

  const submitTouchText = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const field = touchFieldRef.current;
    const text = field?.value.slice(0, 2000) ?? '';
    if (!field || !text) return;
    field.value = '';
    void send({ type: 'text', text });
  };

  const openWindow = () => {
    void client.browserWindow(conversationId).then(() => { setMacOpened(true); setInputError(null); }, (caught: unknown) => {
      setInputError(caught instanceof Error && caught.message ? caught.message : 'Mac에서 창을 열지 못했습니다.');
    });
  };

  const busy = status === 'connecting' || status === 'reconnecting';
  const label = page?.title || page?.url || (status === 'ended' ? '세션 종료' : '연결 중…');
  const statusText = { connecting: '연결 중', live: '연결됨', reconnecting: '다시 연결', ended: '세션 종료' }[status];

  return <div className="browser-live" data-compact={compact || undefined} data-touch={touch || undefined}>
    <header className="browser-live__bar">
      <span className="browser-live__state" data-state={status} title={statusText} aria-label={statusText} role="img"/>
      <span className="browser-live__url truncate" title={page?.url ?? undefined}>{label}</span>
      <button type="button" className="browser-live__icon" aria-label="뒤로" title="뒤로" disabled={status === 'ended'} onClick={() => void send({ type: 'navigate', action: 'back' })}><ArrowLeft size={15}/></button>
      <button type="button" className="browser-live__icon" aria-label="앞으로" title="앞으로" disabled={status === 'ended'} onClick={() => void send({ type: 'navigate', action: 'forward' })}><ArrowRight size={15}/></button>
      <button type="button" className="browser-live__icon" aria-label="새로고침" title="새로고침" disabled={status === 'ended'} onClick={() => void send({ type: 'navigate', action: 'reload' })}><RotateCw size={15}/></button>
      {!shell && <button type="button" className="browser-live__mac" disabled={status === 'ended' || macOpened} onClick={openWindow}>
        <Monitor size={13} aria-hidden="true"/>{macOpened ? 'Mac에서 열었어요' : 'Mac 창으로 열기'}
      </button>}
    </header>
    <div ref={screenRef} className="browser-live__screen" aria-busy={busy || undefined} onKeyDown={onKeyDown} onKeyUp={onKeyUp}>
      <canvas ref={canvasRef} role="img" aria-label={`${label} — 클릭해 조작할 수 있습니다`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
        onContextMenu={event => event.preventDefault()}/>
      {(!dims || status === 'ended') && <div className="browser-live__placeholder">
        {status === 'ended' ? endReason || '브라우저 세션이 종료되었습니다.' : busy ? '화면을 연결하는 중…' : ''}
      </div>}
      {/* The keyboard lands here: printable text, Korean composition and paste go out as text. */}
      {!touch && <textarea ref={fieldRef} className="browser-live__field" aria-label="브라우저에 입력" rows={1} maxLength={2000}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        onInput={onFieldInput} onCompositionEnd={onCompositionEnd} onPaste={onFieldPaste}/>}
    </div>
    {touch && <form className="browser-live__type" onSubmit={submitTouchText}>
      <Input ref={touchFieldRef} aria-label="브라우저에 입력할 내용" placeholder="선택한 곳에 입력됩니다" maxLength={2000}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}/>
      <button type="button" className="browser-live__icon" aria-label="Enter" title="Enter" disabled={status === 'ended'}
        onClick={() => void send({ type: 'key', event: 'down', key: 'Enter', code: 'Enter' }).then(() => send({ type: 'key', event: 'up', key: 'Enter', code: 'Enter' }))}><CornerDownLeft size={15}/></button>
      <Button type="submit" size="icon" aria-label="글자 보내기" title="글자 보내기" className="rounded-pill"><Send/></Button>
    </form>}
    {inputError && <InlineError>{inputError}</InlineError>}
  </div>;
}
