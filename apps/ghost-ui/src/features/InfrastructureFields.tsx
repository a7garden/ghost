import { useId, type ReactNode } from 'react';
import { Button, FormField, Input, Textarea } from '../ui';
import './infrastructure.css';

export function TextField({ label, value, onChange, multiline = false, required = false, ...props }: {
  label: string; value: string; onChange(value: string): void; multiline?: boolean; required?: boolean;
  type?: string; min?: number; max?: number; step?: string; maxLength?: number; pattern?: string; placeholder?: string;
}) {
  return <FormField label={label} required={required}>{control => multiline
    ? <Textarea {...control} value={value} onChange={event => onChange(event.target.value)} rows={3} maxLength={props.maxLength} placeholder={props.placeholder}/>
    : <Input {...control} {...props} value={value} onChange={event => onChange(event.target.value)}/>}</FormField>;
}

export function Choice({ label, value, onChange, options, required = false }: {
  label: string; value: string; onChange(value: string): void; options: { value: string; label: string }[]; required?: boolean;
}) {
  return <FormField label={label} required={required}>{control => <select {...control} className="infra-select" value={value} onChange={event => onChange(event.target.value)}>
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>}</FormField>;
}

export function StringList({ label, values, onChange, max = 32, placeholder }: {
  label: string; values: string[]; onChange(values: string[]): void; max?: number; placeholder?: string;
}) {
  const id = useId();
  return <fieldset className="infra-list"><legend>{label}</legend>{values.map((value, index) => <div className="infra-list__row" key={index}>
    <Input aria-label={`${label} ${index + 1}`} value={value} placeholder={placeholder} onChange={event => onChange(values.map((item, at) => at === index ? event.target.value : item))}/>
    <Button type="button" variant="ghost" aria-label={`${label} ${index + 1} 삭제`} onClick={() => onChange(values.filter((_, at) => at !== index))}>삭제</Button>
  </div>)}<Button type="button" variant="outline" size="sm" aria-controls={id} disabled={values.length >= max} onClick={() => onChange([...values, ''])}>{label} 추가</Button><span id={id} className="sr-only">최대 {max}개</span></fieldset>;
}

export function EditorActions({ busy, onCancel, children }: { busy: boolean; onCancel(): void; children?: ReactNode }) {
  return <div className="infra-actions"><Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>취소</Button><Button type="submit" disabled={busy}>{busy ? '저장 중…' : children ?? '저장'}</Button></div>;
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : '저장하지 못했습니다.';
