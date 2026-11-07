import { expect, it } from 'vitest';
import type { Settings } from '@ghost/contract';
import { modelDisplayName, modelFromKey, modelSelectOptions, usableProviders, NO_MODEL } from './ModelPicker';

const settings: Settings = {
  defaultModel: { provider: 'zai', model: 'glm-5.3' },
  reviewModel: null,
  providers: [
    { id: 'zai', kind: 'zai', name: 'Z.AI', baseUrl: null, models: [{ id: 'glm-5.3', name: 'GLM-5.3' }], hasCredential: true },
    { id: 'local', kind: 'openai_compatible', name: '로컬', baseUrl: 'http://127.0.0.1:11434/v1', models: [], hasCredential: false },
    { id: 'openai', kind: 'openai', name: 'OpenAI', baseUrl: null, models: [{ id: 'gpt-o', name: '' }], hasCredential: true },
  ],
};

it('offers only providers that have models', () => {
  expect(usableProviders(settings).map(provider => provider.id)).toEqual(['zai', 'openai']);
  expect(usableProviders(null)).toEqual([]);
});

it('labels models with the stored provider and model names', () => {
  expect(modelDisplayName(settings, { provider: 'zai', model: 'glm-5.3' })).toBe('Z.AI / GLM-5.3');
  expect(modelDisplayName(settings, { provider: 'openai', model: 'gpt-o' })).toBe('OpenAI / gpt-o');
  expect(modelDisplayName(settings, { provider: 'gone', model: 'x' })).toBe('x');
  expect(modelDisplayName(settings, null)).toBe('기본 모델');
  expect(modelDisplayName(undefined, { provider: 'zai', model: 'glm-5.3' })).toBe('glm-5.3');
});

it('builds and validates select values', () => {
  expect(modelSelectOptions(settings)).toEqual([
    { value: 'zai/glm-5.3', label: 'Z.AI / GLM-5.3' },
    { value: 'openai/gpt-o', label: 'OpenAI / gpt-o' },
  ]);
  expect(modelFromKey(settings, 'zai/glm-5.3')).toEqual({ provider: 'zai', model: 'glm-5.3' });
  expect(modelFromKey(settings, NO_MODEL)).toBeUndefined();
  expect(modelFromKey(settings, null)).toBeNull();
  expect(modelFromKey(settings, 'local/missing')).toBeUndefined();
  expect(modelFromKey(settings, 'zai/removed-after-provider-edit')).toBeUndefined();
});

it('round-trips custom model IDs containing slashes without truncating them', () => {
  const custom: Settings = { ...settings, providers: [{ id: 'gateway', kind: 'openai_compatible', name: 'Gateway', baseUrl: 'https://example.com/v1', models: [{ id: 'vendor/family/model', name: 'Custom' }], hasCredential: true }] };
  const key = modelSelectOptions(custom)[0]!.value;
  expect(modelFromKey(custom, key)).toEqual({ provider: 'gateway', model: 'vendor/family/model' });
  expect(modelFromKey(custom, 'gateway/vendor/family')).toBeUndefined();
});
