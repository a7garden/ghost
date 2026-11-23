import { expect, it } from 'vitest';
import type { HerdrChatItem } from '@ghost/contract';
import { herdrPromptContent, reconcileHerdrPrompts, type HerdrReadyAttachment, type OptimisticPrompt } from './HerdrPromptModel';

const screenshot = { id: 'img', file: new File(['png'], '화면.png', { type: 'image/png' }),
  saved: { path: '/uploads/42-화면.png', name: '화면.png', size: 3 } } satisfies HerdrReadyAttachment;
const report = { id: 'file', file: new File(['txt'], 'log.txt', { type: 'text/plain' }),
  saved: { path: '/uploads/84-log.txt', name: 'log.txt', size: 3 } } satisfies HerdrReadyAttachment;
const user = (id: string, text: string, imageCount?: number): HerdrChatItem => ({ id, text, imageCount, kind: 'user', at: 123 });
const message: OptimisticPrompt = { id: 1, text: '확인해 주세요', after: '100:0', delivery: 'steer', attachments: [] };

it('leaves saved paths as opaque Host attachment arguments, including attachments-only', () => {
  expect(herdrPromptContent({ text: '  확인해 주세요\n ', attachments: [screenshot, report] }))
    .toEqual({ text: '확인해 주세요', attachments: ['/uploads/42-화면.png', '/uploads/84-log.txt'] });
  expect(herdrPromptContent({ text: '  ', attachments: [screenshot] })).toEqual({ text: '', attachments: ['/uploads/42-화면.png'] });
  expect(herdrPromptContent({ text: ' hello ', attachments: [] })).toEqual({ text: 'hello' });
});

it('only confirms an echo once a newer, matching user record appears', () => {
  const existing = user('100:0', message.text);
  const other = user('200:0', '다른 지시');
  const pending = [message];
  expect(reconcileHerdrPrompts(pending, [existing])).toBe(pending);
  expect(reconcileHerdrPrompts(pending, [existing, other])).toEqual([{ ...message, after: other.id }]);
  expect(reconcileHerdrPrompts(pending, [existing, { id: '200:0', kind: 'agent', text: message.text, at: 124 }])).toHaveLength(1);
  expect(reconcileHerdrPrompts(pending, [existing, other, user('300:0', message.text)])).toEqual([]);
});

it('does not allow one transcript entry to confirm two identical submissions across polls', () => {
  const history = [user('100:0', message.text), user('200:0', message.text)];
  const both = [message, { ...message, id: 2 }];
  const waiting = reconcileHerdrPrompts(both, history);
  expect(waiting).toEqual([{ ...both[1], after: '200:0' }]);
  const unrelated = user('300:0', '다른 메시지');
  expect(reconcileHerdrPrompts(waiting, [...history, unrelated])).toHaveLength(1);
  expect(reconcileHerdrPrompts(waiting, [...history, unrelated, user('400:0', message.text)])).toEqual([]);
});

it('uses stable record offsets when a reset omits the last observed record', () => {
  expect(reconcileHerdrPrompts([message], [user('80:0', message.text), user('150:0', '다른 지시')])).toHaveLength(1);
  expect(reconcileHerdrPrompts([message], [user('150:0', message.text)])).toEqual([]);
});

it('reconciles native images without their path and file references that contain a saved path', () => {
  expect(reconcileHerdrPrompts([{ ...message, text: '', attachments: [screenshot] }], [user('120:0', '', 1)])).toEqual([]);
  expect(reconcileHerdrPrompts([{ ...message, attachments: [screenshot, report] }], [user('120:0', message.text, 1)])).toHaveLength(1);
  expect(reconcileHerdrPrompts([{ ...message, attachments: [screenshot, report] }], [user('120:0', `${message.text}\n\n@${report.saved.path}`, 1)])).toEqual([]);
  expect(reconcileHerdrPrompts([{ ...message, attachments: [screenshot] }], [user('120:0', message.text)])).toHaveLength(1);
  expect(reconcileHerdrPrompts([{ ...message, attachments: [screenshot] }], [user('120:0', message.text, 1)])).toEqual([]);
  expect(reconcileHerdrPrompts([{ ...message, attachments: [report] }], [user('120:0', `${message.text}\n@${report.saved.path}`)])).toEqual([]);
});
