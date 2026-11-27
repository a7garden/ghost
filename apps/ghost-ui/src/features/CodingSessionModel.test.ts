import { describe, expect, test } from 'vitest';
import type { CodingDialog, CodingItem } from '@ghost/contract';
import { codingApprovalToolId, codingDialogAnswer, groupCodingItems, mergeCodingItems, upsertCodingItem, type CodingToolItem } from './CodingSessionModel';

const reply: Extract<CodingItem, { kind: 'assistant' }> = { id: 'reply', at: 10, kind: 'assistant', text: '검', streaming: true };
const notice: CodingItem = { id: 'notice', at: 11, kind: 'notice', text: '안내', level: 'info' };
const base = { id: 'dialog', title: '골라 주세요', createdAt: 10, options: [{ id: 'front', label: '앞면' }] };
const tool: CodingToolItem = { kind: 'tool', id: 'tool', at: 10, tool: 'bash', summary: 'bash bun test', status: 'running', output: '', images: [] };

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

  test('reads replies and their reasoning before one trail, retaining call runs and child branches', () => {
    const user: CodingItem = { id: 'user', kind: 'user', at: 10, text: '검토해 주세요.', images: [] };
    const thinking: CodingItem = { id: 'thought', kind: 'thinking', at: 10, text: '범위를 살핀다.', streaming: false };
    const toolThinking = { ...thinking, id: 'tool-thought' };
    const second = { ...tool, id: 'second' };
    const third = { ...tool, id: 'third' };
    const agent: CodingItem = { id: 'agent', kind: 'subagent', at: 10, role: 'scout', task: '검토', status: 'done', summary: '' };
    const child = { ...tool, id: 'child', subagent: agent.id };
    const { rows, subagentTools } = groupCodingItems([user, toolThinking, tool, second, thinking, reply, third, child, agent, notice]);
    expect(rows).toEqual([user, reply, thinking, {
      kind: 'activity', id: toolThinking.id, entries: [
        toolThinking, { kind: 'tools', id: tool.id, tools: [tool, second] },
        { kind: 'tools', id: third.id, tools: [third] }, agent,
      ],
    }, notice]);
    expect(subagentTools.get(agent.id)).toEqual([child]);
  });

  test('marks an approval only when its command identifies one running call', () => {
    const evidence = { name: 'bash', summary: 'bun   test' };
    expect(codingApprovalToolId([tool, { ...tool, id: 'old', status: 'done' }], evidence)).toBe(tool.id);
    expect(codingApprovalToolId([tool, { ...tool, id: 'other' }], evidence)).toBeUndefined();
    expect(codingApprovalToolId([tool], { ...evidence, summary: 'bun run another-task' })).toBeUndefined();
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
