import { useEffect } from 'react';
import { isDesktopShell } from './desktop';

/** The least a soft keyboard takes; below it the viewport is only a toolbar or a zoom. */
const KEYBOARD_MIN = 120;

/**
 * Whether the soft keyboard is up. Safari keeps the layout viewport and shrinks only the visual one.
 * The iPhone shell (and Android) resizes the layout viewport itself, so `innerHeight` falls with
 * the keyboard and the two heights stay equal: there the keyboard is a text field holding focus in
 * a viewport clearly shorter than it was before.
 */
export function keyboardOpen(layout: number, visual: number, resting: number, editing: boolean): boolean {
  return layout - visual > KEYBOARD_MIN || (editing && resting - visual > KEYBOARD_MIN);
}

const NO_TEXT: Record<string, true> = { button: true, checkbox: true, color: true, file: true, image: true, radio: true, range: true, reset: true, submit: true };

/** A control the soft keyboard types into. */
export function takesText(node: unknown): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node instanceof HTMLTextAreaElement) return !node.readOnly;
  if (node instanceof HTMLInputElement) return !node.readOnly && !NO_TEXT[node.type];
  return node.isContentEditable;
}

/** A downward drag this long, mostly vertical, is the owner pulling the keyboard away. */
export function dragClosesKeyboard(dx: number, dy: number): boolean {
  return dy > 24 && dy > 1.5 * Math.abs(dx);
}

/** Where a drag leaves the keyboard alone: it scrolls or selects something of its own. */
const OWN_DRAG = '.ghost-composer, .composer-suggest, .composer-plus__menu, .xterm, .cm-editor, textarea, input, [contenteditable="true"]';

/** WKWebView keeps the layout viewport behind the keyboard; size the shared frame to the visible one. */
export function useVisibleViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    // The layout viewport with no keyboard: it follows the window while nothing is being typed.
    let resting = { width: window.innerWidth, height: window.innerHeight };
    const refresh = (editing: boolean) => {
      const compact = !isDesktopShell() && matchMedia('(max-width: 55.999rem)').matches;
      if (window.innerWidth !== resting.width || !editing) resting = { width: window.innerWidth, height: window.innerHeight };
      else resting.height = Math.max(resting.height, window.innerHeight);
      root.style.setProperty('--ghost-visible-height', compact ? `${viewport.height}px` : '100dvh');
      root.style.setProperty('--ghost-visible-top', compact ? `${viewport.offsetTop}px` : '0px');
      root.dataset.keyboard = compact && keyboardOpen(window.innerHeight, viewport.height, resting.height, editing) ? 'open' : 'closed';
    };
    const update = () => refresh(takesText(document.activeElement));
    // On blur the next control is `relatedTarget`; `activeElement` is still the old one at that moment.
    const focus = (event: FocusEvent) => refresh(takesText(event.type === 'focusout' ? event.relatedTarget : event.target));
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', focus);
    // Pulling the page down while the keyboard is up closes it, as in Messages.
    let drag: { x: number; y: number } | null = null;
    const touchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      const own = event.target instanceof Element && event.target.closest(OWN_DRAG);
      drag = root.dataset.keyboard === 'open' && event.touches.length === 1 && touch && !own ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const touchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!drag || !touch || !dragClosesKeyboard(touch.clientX - drag.x, touch.clientY - drag.y)) return;
      drag = null;
      if (takesText(document.activeElement)) (document.activeElement as HTMLElement).blur();
    };
    document.addEventListener('touchstart', touchStart, { passive: true });
    document.addEventListener('touchmove', touchMove, { passive: true });
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', focus);
      document.removeEventListener('touchstart', touchStart);
      document.removeEventListener('touchmove', touchMove);
      root.style.removeProperty('--ghost-visible-height');
      root.style.removeProperty('--ghost-visible-top');
      delete root.dataset.keyboard;
    };
  }, []);
}
