import { describe, expect, test } from 'vitest';
import type { CodingDialog, CodingItem } from '@ghost/contract';
import { codingDialogAnswer, mergeCodingItems, upsertCodingItem } from './CodingSessionModel';

const reply: Extract<CodingItem, { kind: 'assistant' }> = { id: 'reply', at: 10, kind: 'assistant', text: '검', streaming: true };
const notice: CodingItem = { id: 'notice', at: 11, kind: 'notice', text: '안내', level: 'info' };
const base = { id: 'dialog', title: '골라 주세요', createdAt: 10, options: [{ id: 'front', label: '앞면' }] };

describe('coding transcript updates', () => {
  test('replaces a streaming item in its original position, without mutating the previous render', () => {
    const previous = [reply, notice];
    const delta = { ...reply, text: '검토 중' };
    const updated = upsertCodingItem(previous, delta);
    expect(updated).toEqual([delta, notice]);
    expect(previous[0]).toBe(reply);
    expect(updated[1]).toBe(notice);
    const final = { ...delta, text: '검토했습니다.', streaming: false };
    expect(upsertCodingItem(updated, final)).toEqual([final, notice]);
  });

  test('appends new ids, then replays updates over a freshly fetched history in order', () => {
    const delta = { ...reply, text: '검토했습니다.', streaming: false };
    expect(upsertCodingItem([reply], notice)).toEqual([reply, notice]);
    expect(mergeCodingItems([reply], [delta, notice])).toEqual([delta, notice]);
    expect(mergeCodingItems([reply, notice], [delta])).toEqual([delta, notice]);
  });
});

describe('coding dialog wire answers', () => {
  test('uses choices ids, but Pi select returns the exact displayed option string', () => {
    expect(codingDialogAnswer({ ...base, kind: 'choices' }, { type: 'option', id: 'front' })).toEqual({ optionId: 'front' });
    expect(codingDialogAnswer({ ...base, kind: 'select' }, { type: 'option', id: 'front' })).toEqual({ value: '앞면' });
    expect(codingDialogAnswer({ ...base, kind: 'select' }, { type: 'option', id: 'unknown' })).toBeNull();
  });

  test('distinguishes allow once, deny, no choice and free text', () => {
    const approval: CodingDialog = { ...base, kind: 'approval' };
    const choices: CodingDialog = { ...base, kind: 'choices', allowText: true };
    expect(codingDialogAnswer(approval, { type: 'confirm', yes: true })).toEqual({ value: 'yes' });
    expect(codingDialogAnswer(approval, { type: 'confirm', yes: false })).toEqual({ value: 'no' });
    expect(codingDialogAnswer({ ...base, kind: 'confirm' }, { type: 'confirm', yes: false })).toEqual({ value: 'no' });
    expect(codingDialogAnswer(choices, { type: 'cancel' })).toEqual({ cancel: true });
    expect(codingDialogAnswer(choices, { type: 'text', value: '  다음 버전  ' })).toEqual({ text: '다음 버전' });
    expect(codingDialogAnswer(choices, { type: 'text', value: '  ' })).toBeNull();
    expect(codingDialogAnswer({ ...choices, allowText: false }, { type: 'text', value: '다음 버전' })).toBeNull();
    expect(codingDialogAnswer({ ...base, kind: 'input' }, { type: 'text', value: '  유지  ' })).toEqual({ value: '  유지  ' });
  });
});
