import { expect, it } from 'vitest';
import { hostStatus } from './hostStatus';

it('treats a live event stream as connected regardless of read age', () => {
  expect(hostStatus('live', true)).toMatchObject({ state: 'connected', label: '연결됨' });
  expect(hostStatus('live', false)).toMatchObject({ state: 'connected', label: '연결됨' });
  expect(hostStatus('connecting', false)).toMatchObject({ state: 'connecting', label: '연결 확인 중' });
});

it('distinguishes a dropped stream with cached state from a dead one', () => {
  expect(hostStatus('offline', false)).toMatchObject({ state: 'offline', label: '연결 필요' });
  expect(hostStatus('offline', true)).toMatchObject({ state: 'stale', label: '갱신 지연' });
});
