import { expect, it } from 'vitest';
import { hostStatus } from './hostStatus';

it('does not interpret transport configuration as successful attachment', () => {
  expect(hostStatus('live', '', null, false, 1000).state).toBe('connecting');
  expect(hostStatus('demo', '', null, true, 1000).state).toBe('connecting');
  expect(hostStatus('demo', '', 900, false, 1000).state).toBe('demo');
});
it('distinguishes a failed initial connection from cached and aged state', () => {
  expect(hostStatus('live', 'failure', null, false, 1000).state).toBe('offline');
  expect(hostStatus('live', 'failure', 900, false, 1000).state).toBe('stale');
  expect(hostStatus('live', '', 900, false, 1000).state).toBe('connected');
  expect(hostStatus('live', '', 900, false, 62000).state).toBe('stale');
});
