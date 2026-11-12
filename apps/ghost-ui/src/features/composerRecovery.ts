import type { MessageSend } from './outbox';

export type MessageAttachment = NonNullable<MessageSend['attachments']>[number];
export type RecoveredMessage = {
  requestId: string;
  scopeId: string | null;
  attachments: MessageAttachment[];
};

export function messageAttachmentKey(ref: MessageAttachment): string {
  if ('digest' in ref) return `artifact:${ref.digest}`;
  return ref.kind === 'skill' ? JSON.stringify(['skill', ref.name]) : JSON.stringify(['page', ref.scopeId, ref.locator]);
}

/** The most recently recovered message supplies the visible scope; every distinct attachment survives. */
export function recoverMessage(previous: RecoveredMessage | null, command: MessageSend, requestId: string): RecoveredMessage {
  const attachments = new Map<string, MessageAttachment>();
  for (const ref of previous?.attachments ?? []) attachments.set(messageAttachmentKey(ref), ref);
  for (const ref of command.attachments ?? []) attachments.set(messageAttachmentKey(ref), ref);
  return { requestId, scopeId: command.scopeId ?? null, attachments: [...attachments.values()] };
}
