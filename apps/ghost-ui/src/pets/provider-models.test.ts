import { expect, it } from 'vitest';
import { mergeModels, toggleModel } from './provider-models';

const catalog = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200000, reasoning: true },
  { id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 128000 },
];

it('refreshes catalog metadata without losing saved ordering or manual entries', () => {
  const selected = [{ id: 'glm-5.3', name: '내가 쓰는 GLM', contextWindow: 999 }, { id: 'manual', name: 'Manual' }];
  expect(mergeModels(selected, catalog)).toEqual([catalog[0], selected[1], catalog[1]]);
  expect(toggleModel(selected, catalog[0], true)).toBe(selected);
});

it('toggles on the full selection, not the filtered view', () => {
  const selected = [catalog[0], { id: 'local-custom', name: '' }, catalog[1]];
  // search shows only glm-4.7; unchecking it keeps the off-screen entries
  expect(toggleModel(selected, catalog[1], false)).toEqual([catalog[0], { id: 'local-custom', name: '' }]);
  // checking a visible catalog row appends without disturbing the rest
  const added = toggleModel(selected, { id: 'mini', name: 'Mini' }, true);
  expect(added).toEqual([...selected, { id: 'mini', name: 'Mini' }]);
});

it('matches slash ids exactly instead of splitting on /', () => {
  const selected = [{ id: 'org/mini', name: '' }, { id: 'mini', name: '' }];
  expect(toggleModel(selected, { id: 'org/mini', name: '' }, false)).toEqual([{ id: 'mini', name: '' }]);
  expect(toggleModel(selected, { id: 'org', name: '' }, true)).toEqual([...selected, { id: 'org', name: '' }]);
  expect(mergeModels(selected, [{ id: 'org/mini', name: '카탈로그' }])).toEqual([{ id: 'org/mini', name: '카탈로그' }, selected[1]]);
});
