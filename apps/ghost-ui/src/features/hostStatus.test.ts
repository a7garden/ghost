import { expect, it } from 'vitest';
import { hostStatus } from './hostStatus';

const since = 1_000_000;

it('treats a live event stream as connected at once, whatever came before', () => {
  expect(hostStatus('live', true, null, since)).toEqual({ state: 'connected', label: '연결됨' });
  expect(hostStatus('live', false, null, since)).toEqual({ state: 'connected', label: '연결됨' });
});

it('keeps the first connection attempt quiet', () => {
  expect(hostStatus('connecting', false, null, since)).toEqual({ state: 'connecting', label: '연결 확인 중', quiet: true });
  expect(hostStatus('connecting', true, null, since)).toMatchObject({ state: 'connecting', quiet: true });
});

it('walks a dropped stream with data on screen through silence, 재연결 중… and 연결 끊김', () => {
  expect(hostStatus('offline', true, since, since + 2_000)).toEqual({ state: 'reconnecting', label: '재연결 중…', quiet: true });
  expect(hostStatus('offline', true, since, since + 6_000)).toEqual({ state: 'reconnecting', label: '재연결 중…' });
  expect(hostStatus('offline', true, since, since + 21_000)).toEqual({ state: 'offline', label: '연결 끊김' });
});

it('says 연결 필요 at once when there is no data to protect', () => {
  expect(hostStatus('offline', false, since, since)).toEqual({ state: 'offline', label: '연결 필요' });
  expect(hostStatus('offline', false, since, since + 60_000)).toEqual({ state: 'offline', label: '연결 필요' });
});
