import type { KeyboardEvent } from 'react';
import type { UiField, UiForm, UiValues } from '@ghost/contract';
import { Checkbox, FormField, Input, SegmentedControl, SelectField, Textarea } from '../../ui';
import { InlineStepper } from '../../ui/inline-stepper';

/** Segmented replaces the dropdown only while every segment stays a glanceable word. */
export const SEGMENTED_MAX_OPTIONS = 4;
export const SEGMENTED_MAX_LABEL = 8;
/** Past six fields the form folds into bundles — one wall of fields reads as an empty form to fill. */
export const GROUP_MIN_FIELDS = 6;

type SelectFieldShape = Extract<UiField, { type: 'select' }>;

export function usesSegmented(field: SelectFieldShape): boolean {
  return field.options.length <= SEGMENTED_MAX_OPTIONS && field.options.every(option => option.label.length <= SEGMENTED_MAX_LABEL);
}

/** Balanced bundles of at most `max` fields; the contract carries no group titles, so bundles stay structural. */
export function fieldGroups<T>(items: readonly T[], max = 4): T[][] {
  const count = Math.max(1, Math.ceil(items.length / max));
  const base = Math.floor(items.length / count);
  const extra = items.length % count;
  const groups: T[][] = [];
  for (let at = 0, g = 0; g < count; g++) {
    const size = base + (g < extra ? 1 : 0);
    groups.push(items.slice(at, at + size));
    at += size;
  }
  return groups;
}

export function FormInput({ block, values, disabled, onChange, onEnter }: {
  block: UiForm; values: UiValues; disabled: boolean;
  onChange(id: string, value: string | boolean): void;
  /** Inline single-field forms answer on Enter (AnswerField precedent); absent for regular forms. */
  onEnter?(): void;
}) {
  const handleEnter = (event: KeyboardEvent) => {
    if (onEnter && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onEnter();
    }
  };
  const renderField = (field: UiField) => <FormField key={field.id} label={field.label} required={field.required}>
    {props => {
      const value = Object.hasOwn(values, field.id) ? values[field.id] : '';
      if (field.type === 'checkbox') return <Checkbox {...props} disabled={disabled} checked={value === true} onCheckedChange={checked => onChange(field.id, checked === true)}/>;
      if (field.type === 'select') {
        if (usesSegmented(field)) return <SegmentedControl aria-label={field.label} id={props.id} aria-describedby={props['aria-describedby']}
          value={String(value)} onValueChange={next => onChange(field.id, next)}
          options={field.options.map(option => ({ value: option.value, label: option.label, disabled: disabled || undefined }))}/>;
        return <SelectField {...props} label={field.label} disabled={disabled} value={String(value)} onValueChange={next => onChange(field.id, next)} options={field.options} className="ghost-ui-select"/>;
      }
      if (field.type === 'text' && field.multiline) return <Textarea {...props} disabled={disabled} value={String(value)} maxLength={2000} placeholder={field.placeholder} onChange={event => onChange(field.id, event.target.value)} onKeyDown={handleEnter}/>;
      if (field.type === 'text') return <Input {...props} disabled={disabled} value={String(value)} maxLength={2000} placeholder={field.placeholder} onChange={event => onChange(field.id, event.target.value)} onKeyDown={handleEnter}/>;
      return <InlineStepper {...props} label={field.label} value={String(value)} min={field.min} max={field.max} step={field.step} disabled={disabled}
        onValueChange={next => onChange(field.id, next)} onKeyDown={handleEnter}/>;
    }}
  </FormField>;
  if (block.fields.length >= GROUP_MIN_FIELDS) return <div className="ghost-ui-groups">
    {fieldGroups(block.fields).map((group, index) => <div key={index} className="ghost-ui-fields" data-group>{group.map(field => renderField(field))}</div>)}
  </div>;
  return <div className="ghost-ui-fields">{block.fields.map(field => renderField(field))}</div>;
}
