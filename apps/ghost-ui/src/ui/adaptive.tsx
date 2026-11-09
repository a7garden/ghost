import { useRef, useSyncExternalStore, type KeyboardEvent } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { isDesktopShell } from '../host/desktop';

const compactQuery = '(max-width: 55.999rem)';
const touchQuery = '(pointer: coarse)';
function subscribeCompact(listener: () => void) {
  const media = matchMedia(compactQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
function subscribeTouch(listener: () => void) {
  const media = matchMedia(touchQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
export function useCompact() { return useSyncExternalStore(subscribeCompact, () => !isDesktopShell() && matchMedia(compactQuery).matches, () => false); }
export function useTouch() { return useSyncExternalStore(subscribeTouch, () => matchMedia(touchQuery).matches, () => false); }

/** Dismiss the phone keyboard on search submission without changing desktop Enter behavior. */
export function blurTouchSearchOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Enter' && matchMedia(touchQuery).matches) event.currentTarget.blur();
}

/** Only the handle owns a dismiss gesture; scrolling/editing inside a sheet never dismisses it. */
export function SheetHandle() {
  const start = useRef<number | null>(null);
  return <DialogPrimitive.Close asChild><div className="ghost-sheet-handle" aria-hidden="true"
    onPointerDown={event => { start.current = event.clientY; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerUp={event => {
      if (start.current !== null && event.clientY - start.current > 48) event.currentTarget.click();
      start.current = null;
    }}><span/></div></DialogPrimitive.Close>;
}
