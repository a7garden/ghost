import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { InlineError } from '../../ui';
import { goalError } from './goalError';

/**
 * Text that is edited where it is read: plain until touched, then one field in its place, after the same `prefix`.
 * Enter (⌘/Ctrl+Enter for several lines) or leaving saves, Escape abandons. A failed save keeps the draft open beside its error.
 */
export function InlineEdit({ value, label, name, prefix, maxLength, multiline = false, required = false, onSave, children }: {
  value: string; label: string; name?: string; prefix?: ReactNode; maxLength: number; multiline?: boolean; required?: boolean;
  onSave(next: string): Promise<void>; children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const settled = useRef(false);
  const close = () => { setEditing(false); setError(''); };
  const commit = async (field: HTMLElement) => {
    if (settled.current) return;
    const next = draft.trim();
    settled.current = true;
    if (next === value || (required && !next)) { close(); return; }
    try { await onSave(next); close(); }
    catch (reason) { settled.current = false; setError(goalError(reason)); field.focus(); }
  };
  const keys = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); settled.current = true; close(); }
    else if (event.key === 'Enter' && !event.nativeEvent.isComposing && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); void commit(event.currentTarget); }
  };
  if (!editing) return <button type="button" className="inline-edit" aria-label={name} onClick={() => { settled.current = false; setDraft(value); setEditing(true); }}>
    {prefix}{children}
  </button>;
  const shared = {
    className: 'inline-edit__field', 'aria-label': label, maxLength, value: draft, autoFocus: true, onKeyDown: keys,
    onBlur: (event: { currentTarget: HTMLElement }) => void commit(event.currentTarget),
  };
  return <span className="inline-edit__editing">
    <span className="inline-edit__row">{prefix}
      {multiline
        ? <textarea {...shared} rows={1} onChange={event => setDraft(event.target.value)}/>
        : <input {...shared} onChange={event => setDraft(event.target.value)}/>}
    </span>
    {error && <InlineError>{error}</InlineError>}
  </span>;
}
