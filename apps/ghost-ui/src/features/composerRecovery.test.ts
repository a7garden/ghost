import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocRef } from '@ghost/contract';
import { discard, submit, type MessageSend } from './outbox';
import { recoverMessage } from './composerRecovery';
import { DocAttachmentTray } from '../components/composer/DocAttachmentTray';

it('recovers files, pages and skills from a discarded message without conflating their identities', () => {
  const attachments: NonNullable<MessageSend['attachments']> = [
    { digest: 'a'.repeat(64), name: 'notes.txt', mediaType: 'text/plain', size: 9 },
    { kind: 'page', scopeId: 'scope-a', locator: 'rules.md' },
    { kind: 'page', scopeId: 'scope-b', locator: 'rules.md' },
    { kind: 'skill', name: 'ghost-guide' },
  ];
  const command: MessageSend = { type: 'message.send', conversationId: 'conversation', text: '회수할 메시지', scopeId: 'scope-a', attachments };
  const queued = submit([], { command, requestId: crypto.randomUUID(), now: 1, live: false, transcript: [] });
  const original = queued[0]!;
  const taken = discard(queued, original.requestId);
  expect(taken.box).toEqual([]);
  if (!taken.command) throw new Error('queued message was not recoverable');
  const recovered = recoverMessage(null, taken.command, original.requestId);
  expect(recovered.scopeId).toBe('scope-a');
  expect(recovered.attachments).toEqual(attachments);
  expect(recoverMessage(recovered, command, crypto.randomUUID()).attachments).toEqual(attachments);
});

it('retains explicit global attribution rather than inheriting the conversation page scope', () => {
  const command: MessageSend = { type: 'message.send', conversationId: 'conversation', text: '전체 범위 메시지', scopeId: null, attachments: [{ kind: 'skill', name: 'ghost-guide' }] };
  const earlier = recoverMessage(null, { ...command, scopeId: 'scope-a' }, 'old-message');
  const recovered = recoverMessage(earlier, command, 'global-message');
  expect(recovered.scopeId).toBeNull();
  expect(recovered.requestId).toBe('global-message');
  expect(recovered.attachments).toEqual(command.attachments);
});

it('shows each recovered document reference as its own removable attachment', () => {
  const refs: DocRef[] = [{ kind: 'page', scopeId: 'scope-a', locator: 'rules.md' }, { kind: 'skill', name: 'ghost-guide' }];
  const markup = renderToStaticMarkup(createElement(DocAttachmentTray, { refs, scopes: [{ id: 'scope-a', name: '원래 프로젝트' }], onRemove() {} }));
  expect(markup).toContain('원래 프로젝트 · rules.md 붙임 빼기');
  expect(markup).toContain('스킬 · ghost-guide 붙임 빼기');
});
