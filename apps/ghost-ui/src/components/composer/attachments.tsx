import { useEffect, useRef, useState } from 'react';
import { CircleAlert, FileText, X } from 'lucide-react';
import type { ArtifactRef } from '@ghost/contract';
import { useHost } from '../../host/context';

/** The Host rejects larger uploads; checking first spares a long failing upload. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 16;

export interface PendingAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  /** Local preview for images; revoked when the attachment leaves. */
  preview?: string;
  status: 'uploading' | 'ready' | 'failed';
  ref?: ArtifactRef;
  error?: string;
}

/** Files on their way with the next message: each uploads as soon as it is added. */
export function useAttachments() {
  const { client } = useHost();
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const live = useRef(items);
  live.current = items;
  useEffect(() => () => { for (const item of live.current) if (item.preview) URL.revokeObjectURL(item.preview); }, []);
  const patch = (id: string, change: Partial<PendingAttachment>) => setItems(current => current.map(item => item.id === id ? { ...item, ...change } : item));
  const add = (files: File[]) => {
    const room = Math.max(0, MAX_ATTACHMENTS - live.current.length);
    for (const file of files.slice(0, room)) {
      const id = crypto.randomUUID();
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      const tooLarge = file.size > MAX_ATTACHMENT_BYTES;
      setItems(current => [...current, { id, name: file.name, size: file.size, type: file.type, preview,
        status: tooLarge ? 'failed' : 'uploading', error: tooLarge ? '20MB보다 큽니다' : undefined }]);
      if (tooLarge) continue;
      client.uploadArtifact(file).then(
        ref => patch(id, { status: 'ready', ref }),
        reason => patch(id, { status: 'failed', error: reason instanceof Error ? reason.message : '올리지 못했습니다' }),
      );
    }
  };
  const remove = (id: string) => setItems(current => {
    const gone = current.find(item => item.id === id);
    if (gone?.preview) URL.revokeObjectURL(gone.preview);
    return current.filter(item => item.id !== id);
  });
  const clear = () => setItems(current => { for (const item of current) if (item.preview) URL.revokeObjectURL(item.preview); return []; });
  return {
    items, add, remove, clear,
    uploading: items.some(item => item.status === 'uploading'),
    refs: items.flatMap(item => item.ref && item.status === 'ready' ? [item.ref] : []),
  };
}

const sizeLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Attachments as a row of tiles above the text: image thumbnails, file cards, a shimmer while uploading. */
export function AttachmentTray({ items, onRemove }: { items: PendingAttachment[]; onRemove(id: string): void }) {
  if (!items.length) return null;
  return <ul className="attachment-tray" aria-label="첨부">
    {items.map(item => <li key={item.id} className="attachment" data-status={item.status} data-kind={item.preview ? 'image' : 'file'}
      title={item.error ? `${item.name} — ${item.error}` : item.name}>
      {item.preview ? <img src={item.preview} alt=""/> : <span className="attachment__icon" aria-hidden="true">{item.status === 'failed' ? <CircleAlert/> : <FileText/>}</span>}
      {!item.preview && <span className="attachment__copy"><span>{item.name}</span><small>{item.error ?? sizeLabel(item.size)}</small></span>}
      {item.preview && item.status === 'failed' && <span className="attachment__failed" aria-hidden="true"><CircleAlert/></span>}
      <span className="sr-only">{item.name}{item.status === 'uploading' ? ' 올리는 중' : item.error ? ` ${item.error}` : ''}</span>
      <button type="button" className="attachment__remove" aria-label={`${item.name} 빼기`} onClick={() => onRemove(item.id)}><X aria-hidden="true"/></button>
    </li>)}
  </ul>;
}
