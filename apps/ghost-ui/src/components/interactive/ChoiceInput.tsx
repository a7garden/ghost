import type { UiChoices } from '@ghost/contract';
import { Check } from 'lucide-react';

export type ChoiceShape = 'buttons' | 'rows' | 'cards';

/**
 * Same data, three shapes (spec §2.2): two or three unlabeled options answer at a tap like the
 * decision card's numbered buttons; descriptions need a row to read; six or more become a
 * numbered card list. Four or five unlabeled options stay rows — a wide row still reads them
 * better than a horizontal rush.
 */
export function choiceShape(options: readonly { description?: string }[]): ChoiceShape {
  if (options.length <= 3 && options.every(option => !option.description)) return 'buttons';
  if (options.length >= 6) return 'cards';
  return 'rows';
}

export function ChoiceInput({ block, name, selected, disabled, onSelect, onChoose }: {
  block: UiChoices; name: string; selected: string; disabled: boolean;
  onSelect(id: string): void;
  /** Buttons shape answers on press; rows and cards keep the explicit send. */
  onChoose(id: string): void;
}) {
  const shape = choiceShape(block.options);
  return <fieldset className="ghost-ui-choices" data-shape={shape} disabled={disabled}>
    <legend className="sr-only">{block.title}</legend>
    {block.options.map((option, index) => <label key={option.id}
      className={shape === 'buttons' ? 'ghost-ui-choice-btn' : shape === 'cards' ? 'ghost-ui-choice ghost-ui-choice--card' : 'ghost-ui-choice'}
      data-selected={selected === option.id || undefined}
      // Only a real press answers: arrow keys move the radio with a synthetic click (detail 0), and a read-only block never answers.
      onClick={shape === 'buttons' ? event => { if (event.detail > 0 && !disabled) onChoose(option.id); } : undefined}>
      <input type="radio" name={name} value={option.id} required checked={selected === option.id} onChange={() => onSelect(option.id)}
        onKeyDown={shape === 'buttons' ? event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); onChoose(option.id); }
        } : undefined}/>
      {shape !== 'rows' && <kbd aria-hidden="true">{index + 1}</kbd>}
      <span><span className="ghost-ui-choice__label">{option.label}</span>{option.description && <span className="ghost-ui-choice__description">{option.description}</span>}</span>
      {shape === 'buttons' && <Check size={16} strokeWidth={2} className="ghost-ui-choice-btn__check" aria-hidden="true"/>}
    </label>)}
  </fieldset>;
}
