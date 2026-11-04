import { describe, expect, it } from 'vitest';
import { weekDays } from './Planner';

describe('planner week strip', () => {
  it('returns exactly seven YYYY-MM-DD days starting on Monday', () => {
    expect(weekDays('2026-10-01')).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    expect(weekDays('2026-10-01')).toHaveLength(7);
  });
  it('keeps every day of the same week aligned regardless of the picked day', () => {
    expect(weekDays('2026-10-04')).toEqual(weekDays('2026-09-28'));
    expect(weekDays('2026-10-03')).toEqual(weekDays('2026-09-29'));
  });
  it('crosses month boundaries without drifting', () => {
    expect(weekDays('2026-11-01')).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    expect(weekDays('2026-10-31')).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  });
  it('stays aligned across leap-year February', () => {
    expect(weekDays('2024-02-29')).toEqual(['2024-02-26', '2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02', '2024-03-03']);
    expect(weekDays('2024-03-01')).toEqual(['2024-02-26', '2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02', '2024-03-03']);
  });
});
