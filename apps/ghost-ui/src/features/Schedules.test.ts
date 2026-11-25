import { expect, it } from 'vitest';
import { fromLocalInput, intervalLabel, scheduleStateLabel, scheduleTimingSpec, specLabel, toLocalInput } from './Schedules';

it('formats intervals in Korean units', () => {
  expect(intervalLabel(60)).toBe('1분');
  expect(intervalLabel(3600)).toBe('1시간');
  expect(intervalLabel(5400)).toBe('1시간 30분');
  expect(intervalLabel(90)).toBe('1분 30초');
  expect(intervalLabel(30)).toBe('30초');
  expect(intervalLabel(7200)).toBe('2시간');
  expect(intervalLabel(3601)).toBe('1시간 1초');
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

it('requires a future one-time wake for a new rule but preserves the exact stored value on edits', () => {
  const at = Date.UTC(2099, 0, 2, 0, 30, 7, 123);
  const now = at - 120_000;
  const input = { mode: 'at' as const, at: toLocalInput(at), startAt: '', minutes: '30' };
  const original = { kind: 'at' as const, at };
  expect(scheduleTimingSpec(input, original, now)).toBe(original);
  expect(scheduleTimingSpec(input, undefined, now)).toEqual({ kind: 'at', at: at - 7123 });
  expect(scheduleTimingSpec(input, undefined, at)).toBeNull();
});

it('preserves sub-minute cadence and start precision while editing a repeated wake', () => {
  const startAt = Date.UTC(2099, 0, 2, 0, 30, 7, 123);
  const now = startAt - 120_000;
  const original = { kind: 'every' as const, seconds: 91, startAt };
  const input = { mode: 'every' as const, at: '', startAt: toLocalInput(startAt), minutes: String(91 / 60) };
  expect(scheduleTimingSpec(input, original, now)).toBe(original);
  expect(scheduleTimingSpec({ ...input, minutes: '2' }, original, now)).toEqual({ kind: 'every', seconds: 120, startAt });
  expect(scheduleTimingSpec(input, undefined, now)).toBeNull();
  expect(scheduleTimingSpec({ ...input, minutes: '2', startAt: '' }, undefined, now)).toEqual({ kind: 'every', seconds: 120, startAt: now });
});
