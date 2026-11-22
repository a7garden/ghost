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
    const frame = anchor.closest('.ghost-conversation');
    const viewport = window.visualViewport;
    const place = () => {
      const bounds = anchor.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const above = Math.max(0, bounds.top - Math.max(frame?.getBoundingClientRect().top ?? top + 56, top) - 8);
      const below = Math.max(0, Math.min(frame?.getBoundingClientRect().bottom ?? bottom, bottom) - bounds.bottom - 8);
      const preferBelow = above < Math.min(node.scrollHeight, 280) && below > above;
      const maxHeight = Math.min(280, preferBelow ? below : above);
      setPlacement(previous => previous.below === preferBelow && previous.maxHeight === maxHeight ? previous : { below: preferBelow, maxHeight });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    if (frame) observer.observe(frame);
    viewport?.addEventListener('resize', place);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      viewport?.removeEventListener('resize', place);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [items.length]);
  useLayoutEffect(() => {
    const list = ref.current;
    const option = list?.children[active];
    if (!list || !option) return;
    const bounds = list.getBoundingClientRect();
    const row = option.getBoundingClientRect();
    if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
    else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
  }, [active, placement]);
  return <div ref={ref} className="composer-suggest" data-below={placement.below || undefined} style={{ maxHeight: placement.maxHeight }} role="listbox" id={id} aria-label={label}>
    {items.map((item, index) => <div key={item.id} id={`${id}-${index}`} role="option" aria-selected={index === active} className="composer-suggest__item"
      onPointerMove={event => { if (event.pointerType !== 'touch' && index !== active) onActive(index); }}
      // The field keeps focus so typing continues after a pick.
      onPointerDown={event => event.preventDefault()}
      onClick={item.onSelect}>
      <span className="composer-suggest__icon" aria-hidden="true">{item.icon}</span>
      <span className="composer-suggest__label">{item.label}</span>
      {item.hint && <span className="composer-suggest__hint">{item.hint}</span>}
    </div>)}
  </div>;
}
