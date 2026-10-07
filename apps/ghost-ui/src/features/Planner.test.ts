import { describe, expect, it } from 'vitest';
import { dayRange, eventsOnDay, localDate, localTime } from './Planner';
import { parseLines } from './Integrations';
import { normalizeSnapshot } from '../client/normalize';

describe('personal planner dates', () => {
  it('includes overnight events but excludes adjacent days at midnight', () => {
    const [start, end] = dayRange('2026-10-03');
    const make = (id: string, start_ms: number, end_ms: number) => ({ id, start_ms, end_ms, title: id, notes: '', version: 1, updated_ms: 0 });
    const events = [make('overnight', start - 1000, start + 1000), make('before', start - 1000, start), make('after', end, end + 1000), make('inside', start + 3000, start + 5000)];
    expect(eventsOnDay(events, '2026-10-03').map(e => e.id)).toEqual(['overnight', 'inside']);
  });
  it('round-trips local input without treating date-only deadlines as UTC', () => {
    const date = new Date(2026, 9, 3, 9, 30);
    expect(localDate(date)).toBe('2026-10-03');
    expect(localTime(date.getTime())).toBe('2026-10-03T09:30');
    expect(new Date(localTime(date.getTime())).getTime()).toBe(date.getTime());
  });
  it('reads snapshots from hosts predating organizer and integrations', () => {
    const snapshot = normalizeSnapshot({ workspace_id: 'old', profiles: [] });
    expect(snapshot.todos).toEqual([]); expect(snapshot.calendar_events).toEqual([]); expect(snapshot.integrations).toEqual([]);
  });
});
describe('integration environment references', () => {
  it('accepts names and rejects literal credential-shaped values and duplicates', () => {
    expect(parseLines(' API_TOKEN = GHOST_TOKEN\n\nCLIENT_ID=CLIENT_ID ')).toEqual({ API_TOKEN: 'GHOST_TOKEN', CLIENT_ID: 'CLIENT_ID' });
    expect(() => parseLines('TOKEN=sk-secret-value')).toThrow();
    expect(() => parseLines('TOKEN=FIRST\nTOKEN=SECOND')).toThrow();
    expect(() => parseLines('TOKEN=a=b')).toThrow();
  });
});
