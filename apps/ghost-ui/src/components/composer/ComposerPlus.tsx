import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import './composer.css';

export interface PlusAction { id: string; icon: ReactNode; label: string; onSelect(): void; disabled?: boolean }

/**
 * The composer's + : the actions unfold upward one after another and the + turns into ×.
 * Arrow keys move between actions, Escape folds them back to the button.
 */
export function ComposerPlus({ actions, disabled = false }: { actions: PlusAction[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    items.current.find(Boolean)?.focus();
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
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
    {open && <div className="composer-plus__menu" role="menu" aria-label="더하기">
      {actions.map((action, index) => <button key={action.id} ref={node => { items.current[index] = node; }} type="button" role="menuitem"
        className="composer-plus__item" style={{ '--i': index } as CSSProperties} disabled={action.disabled}
        onClick={() => { close(false); action.onSelect(); }}>
        <span className="composer-plus__icon" aria-hidden="true">{action.icon}</span>
        <span>{action.label}</span>
      </button>)}
    </div>}
  </div>;
}
