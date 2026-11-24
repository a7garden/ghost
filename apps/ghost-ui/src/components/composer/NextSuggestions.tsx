import { useState, type KeyboardEvent } from 'react';
import { ArrowRightToLine } from 'lucide-react';

/**
 * Which prediction is lit, and the keys that act on it: Tab or → takes it, ↑ ↓ show another. `onKeyDown` returns true when
 * it used the key.
 */
export function useNextPick(items: readonly string[], onPick: (text: string) => void) {
  const key = items.join('\n');
  const [state, setState] = useState({ key, at: 0 });
  const active = state.key === key ? Math.min(state.at, items.length - 1) : 0;
  const cycle = (step: number) => setState({ key, at: (active + step + items.length) % items.length });
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!items.length || event.nativeEvent.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
    if (event.key === 'Tab' || event.key === 'ArrowRight') {
      event.preventDefault();
      onPick(items[active]!);
      return true;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length > 1) {
      event.preventDefault();
      cycle(event.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    return false;
  };
  return { active, cycle, onKeyDown };
}

/**
 * The owner's likely next message, written into the empty field as one unsent ghost line in the field's own type. Other
 * predictions wait behind the counter, stacked in the same place so the field never changes height while they swap.
 */
export function NextSuggestions({ items, active, onCycle, onPick }: {
  items: readonly string[]; active: number; onCycle(): void; onPick(text: string): void;
}) {
  return <div className="next-ghost">
    <ul aria-label="다음 메시지 제안">
      {items.map((text, index) => <li key={text} data-active={index === active || undefined}><span>{text}</span></li>)}
    </ul>
    <div className="next-ghost__keys">
      {items.length > 1 && <button type="button" className="next-ghost__more" aria-label="다른 제안" title="다른 제안 (↑ ↓)" onClick={onCycle}>
        <span aria-hidden="true">{active + 1}/{items.length}</span>
      </button>}
      <button type="button" className="next-ghost__take" aria-label={`제안 넣기: ${items[active]}`} title="입력창에 넣기" onClick={() => onPick(items[active]!)}>
        <kbd aria-hidden="true">Tab</kbd>
        <ArrowRightToLine aria-hidden="true"/>
      </button>
    </div>
  </div>;
}
