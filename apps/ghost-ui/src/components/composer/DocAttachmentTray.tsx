import { FileText, X } from 'lucide-react';
import type { DocRef } from '@ghost/contract';
import { messageAttachmentKey } from '../../features/composerRecovery';
import './project-mentions.css';

export function DocAttachmentTray({ refs, scopes = [], onRemove }: {
  refs: readonly DocRef[];
  scopes?: readonly { id: string; name: string }[];
  onRemove?(ref: DocRef): void;
}) {
  if (!refs.length) return null;
  return <div className="project-chips" aria-label="문서 붙임">{refs.map(ref => {
    const label = ref.kind === 'skill' ? `스킬 · ${ref.name}` : `${scopes.find(scope => scope.id === ref.scopeId)?.name ?? ref.scopeId} · ${ref.locator}`;
    return onRemove
      ? <button key={messageAttachmentKey(ref)} type="button" className="project-chip" aria-label={`${label} 붙임 빼기`} onClick={() => onRemove(ref)}><FileText size={14} aria-hidden="true"/><span>{label}</span><X size={13} aria-hidden="true"/></button>
      : <span key={messageAttachmentKey(ref)} className="project-chip"><FileText size={14} aria-hidden="true"/><span>{label}</span></span>;
  })}</div>;
}
