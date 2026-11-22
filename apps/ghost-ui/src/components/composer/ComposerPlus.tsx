import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import './composer.css';

export interface PlusAction {
  id: string; icon: ReactNode; label: string; onSelect(): void; disabled?: boolean;
  /** Why a disabled action is unavailable: it stays focusable, shows this as its title and reports it when chosen. */
  reason?: string;
}

/**
 * The composer's + : the actions unfold upward one after another and the + turns into ×.
 * Arrow keys move between actions, Escape folds them back to the button.
 */
export function ComposerPlus({ actions, disabled = false, onBlocked }: { actions: PlusAction[]; disabled?: boolean; onBlocked?(reason: string): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = menu.current;
    const anchor = node?.offsetParent;
    const button = trigger.current;
    if (!node || !(anchor instanceof HTMLElement) || !button) return;
    const frame = anchor.closest('.ghost-conversation');
    const viewport = window.visualViewport;
    const place = () => {
      const bounds = anchor.getBoundingClientRect();
      const top = Math.max(frame?.getBoundingClientRect().top ?? 0, viewport?.offsetTop ?? 0) + 10;
      const space = bounds.top - top - 10;
      // A long draft with the keyboard open can use the whole dock. Open from the trigger instead of clipping the menu.
      const triggerTop = button.getBoundingClientRect().top;
      node.style.bottom = space < 156 ? `${bounds.bottom - triggerTop + 8}px` : '';
      node.style.maxHeight = `${Math.max(44, space < 156 ? triggerTop - top - 8 : space)}px`;
      node.toggleAttribute('data-scroll', node.scrollHeight > node.clientHeight);
    };
    place();
    items.current.find(item => item && !item.disabled)?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    if (frame) observer.observe(frame);
    viewport?.addEventListener('resize', place);
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', away);
    return () => {
      observer.disconnect();
      viewport?.removeEventListener('resize', place);
      window.removeEventListener('pointerdown', away);
    };
  }, [open]);
  const close = (refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  return <div ref={root} className="composer-plus" data-open={open || undefined}
    onKeyDown={event => {
      if (!open) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        const list = items.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled);
        const at = list.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'ArrowUp' ? Math.min(list.length - 1, at + 1) : Math.max(0, at - 1);
        list[next]?.focus();
      }
    }}>
    <button ref={trigger} type="button" className="composer-plus__trigger" aria-label={open ? '닫기' : '더하기'} aria-expanded={open} aria-haspopup="menu"
      disabled={disabled} onClick={() => setOpen(value => !value)}>
      <Plus aria-hidden="true"/>
    </button>
    {open && <div ref={menu} className="composer-plus__menu" role="menu" aria-label="더하기">
      {actions.map((action, index) => { const blocked = action.disabled && action.reason ? action.reason : null; return <button key={action.id} ref={node => { items.current[index] = node; }} type="button" role="menuitem"
        className="composer-plus__item" style={{ '--i': index } as CSSProperties} disabled={action.disabled && !blocked}
        aria-disabled={blocked ? true : undefined} title={blocked ?? undefined}
        onClick={() => { if (blocked) { close(); onBlocked?.(blocked); } else { close(false); action.onSelect(); } }}>
        <span className="composer-plus__icon" aria-hidden="true">{action.icon}</span>
        <span>{action.label}</span>
      </button>; })}
    </div>}
  </div>;
}
