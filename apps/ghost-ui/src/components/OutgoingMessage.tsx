import type { DocRef } from '@ghost/contract';
import { Clock3 } from 'lucide-react';
import { ConversationMessage } from '../ui';
import { ArtifactPreview } from './ArtifactPreview';
import { ProjectChips } from './composer/ProjectMentions';
import type { OutboxState } from '../features/outbox';
import type { MessageAttachment } from '../features/composerRecovery';
import { DocAttachmentTray } from './composer/DocAttachmentTray';
import './OutgoingMessage.css';

/**
 * The owner's message before the transcript has it: the same bubble, with its delivery state on one line
 * beneath. A message still in the owner's hands (waiting for the connection, or failed) is drawn hollow;
 * once it is on its way it fills like every sent message, and when the Host's copy arrives the row is
 * replaced by it. Sending shows only when it takes a moment; the waiting note sits once, on the last
 * waiting row.
 */
export function OutgoingMessage({ label, text, scopes, attachments, state, note, onRetry, onDiscard }: {
  label: string;
  text: string;
  scopes: readonly { id: string; name: string }[];
  attachments: readonly MessageAttachment[];
  state: OutboxState;
  /** This row carries the queue's note. */
  note: boolean;
  onRetry(): void;
  onDiscard(): void;
}) {
  const words = state === 'failed' ? '전송 실패' : state === 'queued' && note ? '연결이 돌아오면 보냅니다' : '';
  const status = state === 'accepted' ? null : <>
    <span className="outgoing__status" role="status">{words && <><span className="outgoing__dot" aria-hidden="true"/>{words}</>}</span>
    {state === 'sending' && <span className="outgoing__sending" aria-hidden="true"><Clock3/>보내는 중</span>}
    {state === 'failed' && <button type="button" className="outgoing__action" data-primary onClick={onRetry}>다시 보내기</button>}
    {(state === 'failed' || state === 'queued') && <button type="button" className="outgoing__action" onClick={onDiscard}>버리기</button>}
  </>;
  return <ConversationMessage role="user" label={label} className="outgoing" data-state={state} aria-busy={state === 'sending' || undefined} actions={status}>
    <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</div>
    <ProjectChips scopes={scopes}/>
    <DocAttachmentTray refs={attachments.filter((ref): ref is DocRef => !('digest' in ref))} scopes={scopes}/>
    {attachments.length > 0 && <div className="mt-2 flex flex-wrap gap-2">
      {attachments.filter(ref => 'digest' in ref).map(artifact => <ArtifactPreview key={artifact.digest} artifact={artifact}/>)}
    </div>}
  </ConversationMessage>;
}
