import { useEffect, useId, useState } from 'react';
import { ArrowUp, Folder, FolderGit2, Plus, X } from 'lucide-react';
import type { FolderListing } from '@ghost/contract';
import { useHost } from '../host/context';
import { Button, InlineError, Skeleton } from '../ui';
import { Modal } from './Modal';
import './FolderPicker.css';

const message = (reason: unknown) => reason instanceof Error ? reason.message : '폴더를 읽지 못했습니다.';

/** Browse the Mac's folders through the Host, so the same picker works in the app, the browser and on the phone. */
export function FolderPicker({ initial, title = '폴더 선택', onPick, onClose }: { initial?: string | null; title?: string; onPick(path: string): void; onClose(): void }) {
  const { client } = useHost();
  const [at, setAt] = useState<string | null>(initial || null);
  const [hidden, setHidden] = useState(false);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState('');
  const toggle = useId();
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    client.folders(at, hidden, abort.signal).then(setListing).catch(reason => {
      if (abort.signal.aborted) return;
      setError(message(reason));
      // A remembered folder that is gone or unreadable falls back to the home folder instead of a dead end.
      if (at !== null) setAt(null);
    });
    return () => abort.abort();
  }, [client, at, hidden]);
  return <Modal title={title} onClose={onClose} className="folder-picker-sheet">
    <div className="folder-picker">
      {listing && listing.shortcuts.length > 0 && <div className="folder-shortcuts" role="group" aria-label="바로가기">
        {listing.shortcuts.map(shortcut => <button type="button" key={shortcut.path} title={shortcut.path} data-selected={shortcut.path === listing.path || undefined} onClick={() => setAt(shortcut.path)}>{shortcut.label}</button>)}
      </div>}
      <div className="folder-current">
        <Button variant="ghost" size="icon" type="button" aria-label="상위 폴더" disabled={!listing?.parent} onClick={() => listing?.parent && setAt(listing.parent)}><ArrowUp aria-hidden="true"/></Button>
        <span title={listing?.path}><bdi>{listing?.path ?? '…'}</bdi></span>
      </div>
      {error && <InlineError>{error}</InlineError>}
      <ul className="folder-list" aria-label="하위 폴더" aria-busy={!listing}>
        {!listing && !error && [0, 1, 2, 3].map(index => <li key={index} aria-hidden="true" className="flex items-center gap-2 px-3 py-2"><Skeleton className="size-4 flex-none rounded-full"/><Skeleton className={index % 2 ? 'h-3 w-1/3' : 'h-3 w-1/2'}/></li>)}
        {listing?.entries.map(entry => <li key={entry.path}><button type="button" onClick={() => setAt(entry.path)}>
          {entry.git ? <FolderGit2 aria-hidden="true"/> : <Folder aria-hidden="true"/>}<span>{entry.name}</span>
        </button></li>)}
        {listing && listing.entries.length === 0 && <li className="folder-empty">하위 폴더가 없습니다.</li>}
        {listing?.truncated && <li className="folder-empty">항목이 많아 일부만 보입니다.</li>}
      </ul>
      <div className="folder-actions">
        <label htmlFor={toggle}><input id={toggle} type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)}/>숨김 폴더 표시</label>
        <Button type="button" disabled={!listing} onClick={() => listing && onPick(listing.path)}>이 폴더 선택</Button>
      </div>
    </div>
  </Modal>;
}

/** A folder chosen by clicking, never typed; the chosen path stays visible and can be cleared when optional. */
export function FolderField({ label, value, onChange, optional = false, disabled = false, showLabel = true, placeholder = '폴더 선택…' }: {
  label: string; showLabel?: boolean; value: string; onChange(path: string): void; optional?: boolean; disabled?: boolean; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  return <div className="folder-field">
    {showLabel && <span className="folder-field-label">{label}</span>}
    <div className="folder-field-row">
      <button type="button" className="folder-field-button" disabled={disabled} aria-label={`${label}: ${value || '선택 안 함'}`} onClick={() => setOpen(true)}>
        <Folder aria-hidden="true"/><span data-empty={!value || undefined} title={value}>{value || placeholder}</span>
      </button>
      {optional && value && <Button variant="ghost" size="icon" type="button" aria-label={`${label} 지우기`} disabled={disabled} onClick={() => onChange('')}><X aria-hidden="true"/></Button>}
    </div>
    {open && <FolderPicker initial={value} title={label} onPick={path => { setOpen(false); onChange(path); }} onClose={() => setOpen(false)}/>}
  </div>;
}

/** A list of chosen folders: add one with the picker, remove any. */
export function FolderList({ label, values, onChange, disabled = false }: { label: string; values: string[]; onChange(paths: string[]): void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return <div className="folder-field">
    <span className="folder-field-label">{label}</span>
    <ul className="folder-chosen">
      {values.map(path => <li key={path}><Folder aria-hidden="true"/><span title={path}>{path}</span>
        <Button variant="ghost" size="icon" type="button" aria-label={`${path} 제거`} disabled={disabled} onClick={() => onChange(values.filter(entry => entry !== path))}><X aria-hidden="true"/></Button></li>)}
    </ul>
    <Button variant="ghost" type="button" className="justify-self-start" disabled={disabled} onClick={() => setOpen(true)}><Plus aria-hidden="true"/>폴더 추가</Button>
    {open && <FolderPicker title={label} initial={values.at(-1)} onPick={path => { setOpen(false); if (!values.includes(path)) onChange([...values, path]); }} onClose={() => setOpen(false)}/>}
  </div>;
}
