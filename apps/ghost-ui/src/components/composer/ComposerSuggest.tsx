import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** One thing the owner can pick while typing `/` or `@`. */
export interface Suggestion { id: string; icon: ReactNode; label: string; hint?: string; onSelect(): void }

/**
 * What the text being typed can become, floating just above the composer: `/` lists the
 * composer's own actions, `@` the Ghosts a message can be handed to. The text field keeps focus
 * and drives it (arrows, Enter or Tab, Escape); pointing works too.
 */
export function ComposerSuggest({ id, label, items, active, onActive }: {
  id: string;
  label: string;
  items: Suggestion[];
  active: number;
  onActive(index: number): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ below: false, maxHeight: 280 });
  useLayoutEffect(() => {
    const node = ref.current;
    const anchor = node?.offsetParent;
    if (!node || !(anchor instanceof HTMLElement)) return;
    const place = () => {
      const bounds = anchor.getBoundingClientRect();
      const above = Math.max(0, bounds.top - 64);
      const below = Math.max(0, window.innerHeight - bounds.bottom - 64);
      const preferBelow = above < Math.min(node.scrollHeight, 280) && below > above;
      const maxHeight = Math.min(280, preferBelow ? below : above);
      setPlacement(previous => previous.below === preferBelow && previous.maxHeight === maxHeight ? previous : { below: preferBelow, maxHeight });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [items.length]);
  return <div ref={ref} className="composer-suggest" data-below={placement.below || undefined} style={{ maxHeight: placement.maxHeight }} role="listbox" id={id} aria-label={label}>
    {items.map((item, index) => <div key={item.id} id={`${id}-${index}`} role="option" aria-selected={index === active} className="composer-suggest__item"
      onPointerMove={() => { if (index !== active) onActive(index); }}
      // The field keeps focus so typing continues after a pick.
      onPointerDown={event => event.preventDefault()}
      onClick={item.onSelect}>
      <span className="composer-suggest__icon" aria-hidden="true">{item.icon}</span>
      <span className="composer-suggest__label">{item.label}</span>
      {item.hint && <span className="composer-suggest__hint">{item.hint}</span>}
    </div>)}
  </div>;
}
