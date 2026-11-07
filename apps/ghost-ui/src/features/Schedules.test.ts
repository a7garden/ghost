import { expect, it } from 'vitest';
import { fromLocalInput, intervalLabel, scheduleStateLabel, specLabel, toLocalInput } from './Schedules';

it('formats intervals in Korean units', () => {
  expect(intervalLabel(60)).toBe('1분');
  expect(intervalLabel(3600)).toBe('1시간');
  expect(intervalLabel(5400)).toBe('1시간 30분');
  expect(intervalLabel(90)).toBe('1분 30초');
  expect(intervalLabel(30)).toBe('30초');
  expect(intervalLabel(7200)).toBe('2시간');
});

it('describes one-off and repeating specs', () => {
  expect(specLabel({ kind: 'at', at: Date.UTC(2026, 10, 7, 2, 30) })).toContain('한 번');
  expect(specLabel({ kind: 'every', seconds: 1800, startAt: 0 })).toBe('30분마다');
});

it('labels schedule states for the badge', () => {
  expect(scheduleStateLabel.active).toBe('대기 중');
  expect(scheduleStateLabel.paused).toBe('일시정지');
  expect(scheduleStateLabel.done).toBe('완료');
});

it('round-trips datetime-local values in the local zone', () => {
  const ms = Date.UTC(2026, 10, 7, 5, 5);
  const value = toLocalInput(ms);
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  expect(fromLocalInput(value)).not.toBeNull();
  // The same wall-clock reading, so the picker shows what will run.
  expect(new Date(fromLocalInput(value)!).getTime()).toBe(ms);
  expect(fromLocalInput('')).toBeNull();
  expect(fromLocalInput('not-a-date')).toBeNull();
});
