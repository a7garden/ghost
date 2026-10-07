import { expect, it } from 'vitest';
import type { ModelProvider } from '../client/types';
import { checkedProvider, respondingServers } from './modelResults';
const provider: ModelProvider = { id: 'local', name: 'Local', kind: 'openai_compatible', endpoint: 'http://127.0.0.1:11434/v1', auth: { type: 'none' }, roles: ['llm'], models: [], enabled: true, checked_ms: 123, error: null };
it('does not turn an HTTP-successful command with a failed probe into a successful connection notice', () => {
  expect(() => checkedProvider({ settings: { providers: [{ ...provider, error: '서버에 연결하지 못했습니다.' }] } }, 'local')).toThrow('연결하지');
  expect(() => checkedProvider({ settings: { providers: [{ ...provider, checked_ms: null }] } }, 'local')).toThrow('확인하지');
  expect(checkedProvider({ settings: { providers: [provider] }, inference_verified: false }, 'local')).toEqual(provider);
});
it('separates failed discovery probes from responding local servers', () => {
  expect(respondingServers([provider, { ...provider, id: 'failed', error: 'offline' }, { ...provider, id: 'unverified', checked_ms: null }])).toEqual([provider]);
});
