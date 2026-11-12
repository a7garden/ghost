import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { formatUiSubmission, parseInteractiveUi, type UiChoices, type UiField, type UiForm } from '@ghost/contract';
import { dirty, submissionValues, UiInputBlock, type UiSubmit } from './UiInputBlock';
import { choiceShape } from './ChoiceInput';
import { fieldGroups, usesSegmented } from './FormInput';
import { clampStepValue } from '../../ui/inline-stepper';

const presentation = (block: UiChoices | UiForm, onUiSubmit: UiSubmit = async () => {}) => {
  const ui = parseInteractiveUi({ version: 'ghost-ui/1', title: '도움이 필요해요', blocks: [block] });
  return renderToStaticMarkup(createElement(UiInputBlock, { ui, block, conversationId: 'c', messageId: 'm', onUiSubmit }));
};

const quickBlock: UiChoices = { type: 'choices', id: 'quick', title: '보낼까요?', options: [{ id: 'yes', label: '보내' }, { id: 'no', label: '보류' }] };
const pickBlock: UiChoices = { type: 'choices', id: 'pick', title: '보낼까요?', options: [{ id: 'yes', label: '보내' }, { id: 'no', label: '보류', description: '나중에 다시' }] };
const stayBlock: UiForm = { type: 'form', id: 'stay', title: '머무르기', submitLabel: '보내기', fields: [
  { type: 'text', id: 'city', label: '도시', required: true },
  { type: 'number', id: 'guests', label: '인원', min: 1, max: 12 },
  { type: 'select', id: 'room', label: '객실', options: [{ value: 'standard', label: '스탠다드' }, { value: 'suite', label: '스위트' }] },
  { type: 'checkbox', id: 'breakfast', label: '조식' },
] };

it('choice shapes follow the data: few unlabeled options answer at a tap, described rows stay, long lists become cards', () => {
  const opt = (id: string, description?: string) => ({ id, label: `옵션 ${id}`, ...(description ? { description } : {}) });
  expect(choiceShape([opt('a'), opt('b')])).toBe('buttons');
  expect(choiceShape([opt('a'), opt('b'), opt('c')])).toBe('buttons');
  expect(choiceShape([opt('a', '설명'), opt('b')])).toBe('rows');
  expect(choiceShape([opt('a'), opt('b'), opt('c'), opt('d')])).toBe('rows');
  expect(choiceShape(Array.from({ length: 6 }, (_, i) => opt(`o${i}`)))).toBe('cards');
  expect(choiceShape(Array.from({ length: 7 }, (_, i) => opt(`o${i}`, '설명')))).toBe('cards');

  const buttons = presentation(quickBlock);
  expect(buttons).toContain('data-shape="buttons"');
  expect(buttons).not.toContain('선택 보내기');
  // Real radios inside a labelled fieldset; numbers borrow the decision card's key look.
  expect(buttons).toContain('<fieldset');
  expect(buttons).toContain('<legend class="sr-only">');
  expect(buttons).toContain('type="radio"');
  expect(buttons).toContain('<kbd');
  const rows = presentation(pickBlock);
  expect(rows).toContain('ghost-ui-choice');
  expect(rows).not.toContain('data-shape="buttons"');
  expect(rows).toContain('선택 보내기');
  const cards = presentation({ type: 'choices', id: 'many', title: '고르기', options: Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: `옵션 ${i}` })) });
  expect(cards).toContain('ghost-ui-choice--card');
  expect(cards).toContain('<kbd');
});

it('field controls route by data: segmented for few short options, dropdown beyond, stepper for numbers', () => {
  const select = (labels: string[]): Extract<UiField, { type: 'select' }> => ({ type: 'select', id: 'room', label: '객실', options: labels.map((label, index) => ({ value: `v${index}`, label })) });
  expect(usesSegmented(select(['가볍게', '담백하게']))).toBe(true);
  expect(usesSegmented(select(['가', '나', '다', '라', '마']))).toBe(false);
  expect(usesSegmented(select(['꽤 길게 쓰인 하나뿐인 라벨']))).toBe(false);
  expect(presentation({ ...stayBlock, id: 'seg', fields: [select(['가볍게', '담백하게'])] })).toContain('segmented-control');
  const dropdown = presentation({ ...stayBlock, id: 'drop', fields: [select(['a1', 'a2', 'a3', 'a4', 'a5'])] });
  expect(dropdown).toContain('ghost-ui-select');
  expect(dropdown).not.toContain('segmented-control');
  const stepper = presentation({ ...stayBlock, id: 'count', fields: [{ type: 'number', id: 'count', label: '인원', min: 1, max: 9, step: 2 }] });
  expect(stepper).toContain('ghost-inline-stepper');
  expect(stepper).toContain('aria-label="줄임"');
  expect(stepper).toContain('aria-label="늘림"');
  expect(stepper).toContain('min="1"');
  expect(stepper).toContain('max="9"');
  expect(stepper).toContain('step="2"');
});

it('a single text or number field answers inline with an icon send; select and checkbox keep the labelled button', () => {
  const solo = presentation({ ...stayBlock, id: 'solo', submitLabel: '지어 주기', fields: [{ type: 'text', id: 'name', label: '이름', required: true }] });
  expect(solo).toContain('data-inline="true"');
  // The send stays reachable without Return (iOS decimal pads have none) but carries its label only for assistive tech.
  expect(solo).toMatch(/type="submit"[^>]*aria-label="지어 주기"/);
  expect(solo).not.toContain('>지어 주기<');
  expect(solo).toContain('이름');
  expect(presentation({ ...stayBlock, id: 'ok', fields: [{ type: 'checkbox', id: 'agree', label: '동의' }] })).toContain('type="submit"');
});

it('fields from six on fold into bundles', () => {
  expect(fieldGroups([1, 2, 3, 4, 5, 6]).map(group => group.length)).toEqual([3, 3]);
  expect(fieldGroups([1, 2, 3, 4, 5, 6, 7]).map(group => group.length)).toEqual([4, 3]);
  expect(fieldGroups([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]).map(group => group.length)).toEqual([4, 4, 3]);
  const bundled = presentation({ ...stayBlock, id: 'big', fields: Array.from({ length: 8 }, (_, i) => ({ type: 'text' as const, id: `f${i}`, label: `항 ${i}` })) });
  expect(bundled).toContain('ghost-ui-groups');
});

it('the stepper clamps to min, max and the step lattice anchored at min', () => {
  expect(clampStepValue(4, { min: 0, max: 10, step: 3 })).toBe('3');
  expect(clampStepValue(8, { min: 0, max: 10, step: 3 })).toBe('9');
  expect(clampStepValue(11, { min: 0, max: 10, step: 3 })).toBe('9');
  expect(clampStepValue(-1, { min: 1, max: 9, step: 2 })).toBe('1');
  expect(clampStepValue(9, { min: 1, max: 9, step: 2 })).toBe('9');
  expect(clampStepValue(0.30000000000000004, { step: 0.1 })).toBe('0.3');
  expect(clampStepValue(2, { min: 5 })).toBe('5');
  expect(clampStepValue(99, { max: 5 })).toBe('5');
  expect(clampStepValue(7, {})).toBe('7');
});

it('초기화 means something only once a value moved from its default', () => {
  expect(dirty(pickBlock, { choice: '' })).toBe(false);
  expect(dirty(pickBlock, { choice: 'yes' })).toBe(true);
  expect(dirty(stayBlock, { city: '', guests: '', room: '', breakfast: false })).toBe(false);
  expect(dirty(stayBlock, { city: '', guests: '2', room: '', breakfast: false })).toBe(true);
});

it('the wire stays byte-identical: same input, same formatUiSubmission text as before the reshape', () => {
  const stayUi = parseInteractiveUi({ version: 'ghost-ui/1', title: '도움이 필요해요', blocks: [stayBlock] });
  const submitted = submissionValues(stayBlock, { city: '세종', guests: '2', room: 'suite', breakfast: true, stray: 'dropped' });
  expect(submitted).toEqual({ city: '세종', guests: 2, room: 'suite', breakfast: true });
  expect(formatUiSubmission(stayUi, 'stay', submitted))
    .toBe('UI 응답 · 도움이 필요해요\n머무르기\n- 도시: "세종"\n- 인원: 2\n- 객실: "스위트"\n- 조식: true');
  const partial = submissionValues(stayBlock, { city: '부산', guests: '', room: '', breakfast: false });
  expect(formatUiSubmission(stayUi, 'stay', partial))
    .toBe('UI 응답 · 도움이 필요해요\n머무르기\n- 도시: "부산"\n- 조식: false');
  const picked = submissionValues(pickBlock, { choice: 'no' });
  expect(formatUiSubmission(parseInteractiveUi({ version: 'ghost-ui/1', title: '도움이 필요해요', blocks: [pickBlock] }), 'pick', picked))
    .toBe('UI 응답 · 도움이 필요해요\n보낼까요?\n보류\n나중에 다시');
});
