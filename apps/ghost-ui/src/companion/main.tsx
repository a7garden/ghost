import '../ui/styles.css';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HostProvider, useHost } from '../host/context';
import { useHostState } from '../host/store';
import { desktopInvoke } from '../host/desktop';
import { ghostPresence } from '../features/ghostState';
import { CompanionAvatar, companionGhost } from './Avatar';
import { readCompanionPreferences, saveCompanionPreferences, useCompanionPreferences } from './preferences';
import { companionActivity, WorkShelf } from './WorkShelf';
import './companion.css';

const systemDark = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', systemDark.matches);
applyTheme();
systemDark.addEventListener('change', applyTheme);

type PaintBounds = { left: number; top: number; right: number; bottom: number };

function svgPaintBounds(element: SVGGraphicsElement, stroke = 0): PaintBounds {
  const box = element.getBBox();
  const matrix = element.getScreenCTM();
  if (!matrix) throw new Error('아바타 표시 영역을 읽지 못했습니다.');
  const points = [
    [box.x - stroke, box.y - stroke],
    [box.x + box.width + stroke, box.y - stroke],
    [box.x - stroke, box.y + box.height + stroke],
    [box.x + box.width + stroke, box.y + box.height + stroke],
  ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
  return {
    left: Math.min(...points.map(point => point.x)),
    top: Math.min(...points.map(point => point.y)),
    right: Math.max(...points.map(point => point.x)),
    bottom: Math.max(...points.map(point => point.y)),
  };
}

function measureAnchor(root: HTMLElement) {
  const svg = root.querySelector<SVGSVGElement>('.companion-body .ghost-character');
  const body = svg?.querySelector<SVGGElement>(':scope > g');
  const matrix = body?.getScreenCTM();
  if (!svg || !matrix) throw new Error('아바타 표시 영역을 읽지 못했습니다.');
  // SVG client bounds include transparent viewBox space. Transform paint bounds instead.
  const bounds = [svgPaintBounds(svg)];
  // WebKit's default getBBox omits strokes, including halo/ring/ear outlines.
  for (const element of svg.querySelectorAll<SVGGraphicsElement>('path, circle, ellipse, rect, line, polyline, polygon')) {
    const style = getComputedStyle(element);
    if (style.stroke !== 'none' && style.strokeOpacity !== '0') {
      bounds.push(svgPaintBounds(element, Number.parseFloat(style.strokeWidth) / 2));
    }
  }
  for (const element of root.querySelectorAll('.companion-summary, .companion-attention')) {
    if (element.getClientRects().length) bounds.push(element.getBoundingClientRect());
  }
  const left = Math.max(0, Math.min(...bounds.map(bound => bound.left)));
  const top = Math.max(0, Math.min(...bounds.map(bound => bound.top)));
  const right = Math.min(window.innerWidth, Math.max(...bounds.map(bound => bound.right)));
  const bottom = Math.min(window.innerHeight, Math.max(...bounds.map(bound => bound.bottom)));
  // Every body is centered in the viewBox; asymmetric marks must not move the tail.
  const view = svg.viewBox.baseVal;
  const center = new DOMPoint(view.x + view.width / 2, view.y + view.height / 2).matrixTransform(matrix);
  return {
    x: left, y: top, width: right - left, height: bottom - top, centerX: center.x,
    windowWidth: window.innerWidth, windowHeight: window.innerHeight,
  };
}

function Companion() {
  const { store } = useHost();
  const { state, error: hostError } = useHostState(store);
  const { preferences, error: storageError } = useCompanionPreferences();
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [sized, setSized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const dragging = useRef(false);
  const resizeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cluster = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const latestReport = useRef<Promise<void>>(Promise.resolve());
  const ghost = companionGhost(state, preferences.ghostId);
  const presence = ghost && state ? ghostPresence(ghost, state) : null;
  const activity = ghost && state ? companionActivity(ghost, state) : null;
  const canExpand = preferences.bubble && Boolean(activity?.summary);
  const open = expanded && canExpand;
  const clearHover = () => clearTimeout(hoverTimer.current);
  const closeShelf = () => {
    clearHover();
    setExpanded(false);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const report = useCallback((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)), []);
  const reportAnchor = useCallback(() => {
    if (!root.current?.querySelector('.ghost-character')) return Promise.resolve();
    const bounds = measureAnchor(root.current);
    const next = latestReport.current.catch(() => {}).then(() => desktopInvoke<void>('companion_anchor', { bounds }));
    latestReport.current = next;
    return next;
  }, []);

  useEffect(() => {
    let disposed = false;
    void desktopInvoke<boolean>('companion_enabled').then(enabled => {
      saveCompanionPreferences({ ...readCompanionPreferences(), enabled });
      if (!disposed) setReady(true);
    }).catch(report);
    const hide = () => {
      try { saveCompanionPreferences({ ...readCompanionPreferences(), enabled: false }); }
      catch (reason) { report(reason); }
    };
    window.addEventListener('ghost-companion-hide', hide);
    return () => { disposed = true; window.removeEventListener('ghost-companion-hide', hide); };
  }, []);

  useLayoutEffect(() => {
    if (!ready || !state || dragActive) return;
    let disposed = false;
    setSized(false);
    resizeQueue.current = resizeQueue.current.catch(() => {}).then(() => desktopInvoke('companion_resize', { size: preferences.size, expanded: open }));
    void resizeQueue.current
      .then(() => {
        const { promise, resolve } = Promise.withResolvers<void>();
        requestAnimationFrame(() => resolve());
        return promise;
      })
      .then(async () => {
        if (disposed) return;
        try { await reportAnchor(); } catch (reason) { report(reason); }
        if (disposed) return;
        await desktopInvoke('companion_set', { visible: preferences.enabled });
        if (!disposed) setSized(true);
      })
      .catch(report);
    return () => { disposed = true; };
  }, [ready, Boolean(state), preferences.size, preferences.enabled, open, dragActive, reportAnchor, report]);

  useLayoutEffect(() => {
    if (!ready || !sized || !ghost || !root.current) return;
    let frame = 0;
    let disposed = false;
    const schedule = () => {
      if (disposed) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void Promise.resolve().then(reportAnchor).catch(report);
      });
    };
    const observer = new ResizeObserver(schedule);
    for (const element of root.current.querySelectorAll('.companion-avatar, .ghost-character, .companion-summary')) {
      observer.observe(element);
    }
    observer.observe(root.current);
    window.addEventListener('resize', schedule);
    void document.fonts.ready.then(schedule);
    schedule();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [ready, sized, ghost?.id, ghost?.look.shape, ghost?.look.face, ghost?.look.mark,
    preferences.size, preferences.bubble, presence?.state, presence?.line, activity?.summary, open, reportAnchor, report]);

  const selectOverlayGhost = () => {
    if (!ghost) return true;
    try {
      localStorage.setItem('ghost-overlay:target', JSON.stringify({ ghostId: ghost.id, conversationId: ghost.directConversationId }));
      return true;
    } catch (reason) { report(reason); return false; }
  };
  const openChat = () => {
    closeShelf();
    resizeQueue.current = resizeQueue.current.catch(() => {}).then(() => desktopInvoke('companion_resize', { size: preferences.size, expanded: false }));
    if (selectOverlayGhost()) void resizeQueue.current
      .then(() => {
        const { promise, resolve } = Promise.withResolvers<void>();
        requestAnimationFrame(() => resolve());
        return promise;
      }).then(reportAnchor).then(() => desktopInvoke('toggle_overlay')).catch(report);
  };
  const status = error || storageError || hostError;
  return <main ref={root} className="companion-window" aria-label="데스크톱 Ghost">
    {ghost && state && <div ref={cluster} className="companion-cluster" data-expanded={open && sized}
      onPointerEnter={event => {
        if (event.pointerType === 'touch' || !canExpand || dragging.current) return;
        clearHover();
        hoverTimer.current = setTimeout(() => setExpanded(true), 180);
      }}
      onPointerLeave={() => {
        clearHover();
        if (dragging.current) return;
        hoverTimer.current = setTimeout(() => {
          if (!cluster.current?.contains(document.activeElement)) setExpanded(false);
        }, 220);
      }}
      onFocus={clearHover}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) closeShelf(); }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeShelf();
          cluster.current?.querySelector<HTMLButtonElement>('.companion-summary')?.focus();
        }
      }}>
      {canExpand && <button type="button" className="companion-summary" data-attention={presence?.state === 'attention'}
        aria-expanded={open && sized} aria-controls="companion-work" aria-label={`${activity?.summary} 펼치기`}
        onClick={() => { clearHover(); setExpanded(value => !value); }}>{activity?.summary}</button>}
      {open && sized && <WorkShelf ghost={ghost} state={state} onOpen={route => {
        closeShelf();
        void desktopInvoke('focus_main', { route }).catch(report);
      }}/>}
      <button type="button" className="companion-hit" aria-label={`${ghost.name} 대화 열기`} title={status || `${ghost.name} · 클릭하여 대화 · 끌어서 이동`}
      onMouseDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        clearHover();
        dragging.current = true;
        setDragActive(true);
        void resizeQueue.current.catch(() => {}).then(() => desktopInvoke<boolean>('companion_drag')).then(moved => {
          if (!moved) openChat();
        }).catch(report).finally(() => { dragging.current = false; setDragActive(false); });
      }}
      onClick={event => { if (event.detail === 0) openChat(); }}
      onContextMenu={event => {
        event.preventDefault();
        if (selectOverlayGhost()) void Promise.resolve().then(reportAnchor).then(() => desktopInvoke('companion_menu')).catch(report);
      }}>
      <CompanionAvatar ghost={ghost} state={state} preferences={preferences} showSummary={false}/>
    </button></div>}
    {status && <span className="companion-error" role="status" title={status}>연결 확인</span>}
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('아바타 화면을 찾지 못했습니다.');
createRoot(root).render(<HostProvider><Companion/></HostProvider>);
