import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { InlineError } from '../../ui';
import { goalError } from './goalError';

/**
 * Text that is edited where it is read: plain until touched, then one field in its place.
 * Leaving the field or Enter (⌘/Ctrl+Enter for several lines) saves, Escape abandons.
 * A failed save keeps the draft open beside its error.
 */
export function InlineEdit({ value, label, maxLength, multiline = false, required = false, startEditing = false, onSave, onDone, children }: {
  value: string; label: string; maxLength: number; multiline?: boolean; required?: boolean; startEditing?: boolean;
  onSave(next: string): Promise<void>; onDone?(): void; children: ReactNode;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const settled = useRef(false);
  const close = () => { setEditing(false); setError(''); onDone?.(); };
  const commit = async (field: HTMLElement) => {
    if (settled.current) return;
    const next = draft.trim();
    if (next === value || (required && !next)) { settled.current = true; close(); return; }
    settled.current = true;
    try { await onSave(next); close(); }
    catch (reason) { settled.current = false; setError(goalError(reason)); field.focus(); }
  };
  const abandon = () => { settled.current = true; setDraft(value); close(); };
  const keys = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); abandon(); }
    else if (event.key === 'Enter' && !event.nativeEvent.isComposing && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); void commit(event.currentTarget); }
  };
  if (!editing) return <button type="button" className="inline-edit" title="수정" onClick={() => { settled.current = false; setDraft(value); setEditing(true); }}>{children}</button>;
  const shared = {
    className: 'inline-edit__field', 'aria-label': label, maxLength, value: draft, autoFocus: true, onKeyDown: keys,
    onBlur: (event: { currentTarget: HTMLElement }) => void commit(event.currentTarget),
  };
  return <span className="inline-edit__editing">
    {multiline
      ? <textarea {...shared} rows={1} onChange={event => setDraft(event.target.value)}/>
      : <input {...shared} onChange={event => setDraft(event.target.value)}/>}
    {error && <InlineError>{error}</InlineError>}
  </span>;
}
