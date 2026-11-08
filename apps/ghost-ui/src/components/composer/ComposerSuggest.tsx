import type { ReactNode } from 'react';

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
  return <div className="composer-suggest" role="listbox" id={id} aria-label={label}>
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
