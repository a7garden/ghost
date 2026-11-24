import { describe, expect, it } from 'vitest';
import type { CallLine } from './call-state';
import { callPhase } from './call-state';
import { Hysteresis, LevelMeter, shapeLevel } from './levels';
import { LineBook } from './lines';
import { phrases } from './realtime-engine';

describe('call phase', () => {
  const quiet = { hearing: false, transcribing: false, speaking: false };
  it('lets audio outrank the Ghost\'s work, and work show only in silence', () => {
    expect(callPhase({ ...quiet, hearing: true, speaking: true }, { running: true })).toEqual({ phase: 'hearing' });
    expect(callPhase({ ...quiet, transcribing: true }, { running: true })).toEqual({ phase: 'transcribing' });
    expect(callPhase({ ...quiet, speaking: true }, { running: true, tool: 'web_search' })).toEqual({ phase: 'speaking' });
    expect(callPhase(quiet, { running: true })).toEqual({ phase: 'thinking' });
    expect(callPhase(quiet, { running: true, tool: 'web_search' })).toEqual({ phase: 'working', detail: 'web_search' });
    expect(callPhase(quiet, { running: false })).toEqual({ phase: 'listening' });
  });
});

describe('call transcript', () => {
  it('keeps a recognized line in place when the Ghost accepts it and when its reply settles', () => {
    const seen: CallLine[][] = [];
    const book = new LineBook(lines => seen.push(lines));
    book.upsert('owner:r1', 'owner', '날씨 알려줘', false);
    book.upsert('ghost:live', 'ghost', '확인해', true);
    book.upsert('ghost:live', 'ghost', '확인해 볼게요.', true);
    book.settle('owner:r1', 'm1', 'owner', '날씨 알려줘');
    book.settle('ghost:live', 'm2', 'ghost', '확인해 볼게요.');
    expect(seen.at(-1)).toEqual([
      { id: 'm1', speaker: 'owner', text: '날씨 알려줘', live: false },
      { id: 'm2', speaker: 'ghost', text: '확인해 볼게요.', live: false },
    ]);
  });

  it('publishes nothing for an unchanged line and caps the length', () => {
    let published = 0;
    const book = new LineBook(() => { published++; });
    book.upsert('a', 'owner', '안녕', false);
    book.upsert('a', 'owner', '안녕', false);
    expect(published).toBe(1);
    for (let index = 0; index < 20; index++) book.upsert(`l${index}`, 'ghost', `${index}`, false);
    let last: CallLine[] = [];
    new LineBook(lines => { last = lines; }).replace(Array.from({ length: 20 }, (_, index) => ({ id: `${index}`, speaker: 'ghost', text: `${index}`, live: false })));
    expect(last).toHaveLength(12);
    expect(last[0]!.id).toBe('8');
  });

  it('turns timed live fragments into phrases ordered across both speakers', () => {
    const fragments = [
      { speaker: 'owner', start: 0, end: 300, delta: '내일 ' },
      { speaker: 'owner', start: 300, end: 700, delta: '날씨는?' },
      { speaker: 'ghost', start: 1_500, end: 1_900, delta: '잠깐만 ' },
      { speaker: 'ghost', start: 1_900, end: 2_300, delta: '볼게요.' },
      { speaker: 'ghost', start: 6_000, end: 6_400, delta: '맑아요.' },
      { speaker: 'owner', start: 300, end: 700, delta: '날씨는?' },
    ] as const;
    const lines = phrases(fragments.slice(0, 5), new Set(['ghost']));
    expect(lines.map(line => [line.speaker, line.text, line.live])).toEqual([
      ['owner', '내일 날씨는?', false],
      ['ghost', '잠깐만 볼게요.', false],
      ['ghost', '맑아요.', true],
    ]);
  });
});

describe('audio levels', () => {
  it('rises at once, settles between syllables, and ignores a hum', () => {
    const meter = new LevelMeter();
    meter.push(.08, 1_000);
    const peak = meter.read(1_000);
    expect(peak).toBeGreaterThan(.6);
    expect(meter.read(1_160)).toBeCloseTo(peak / Math.E, 2);
    expect(meter.read(3_000)).toBeLessThan(.001);
    expect(shapeLevel(0)).toBe(0);
    expect(shapeLevel(1)).toBe(1);
    expect(shapeLevel(.003)).toBeLessThan(.2);
  });

  it('holds a voice open across the gap between words', () => {
    const gate = new Hysteresis(.3, 300);
    expect(gate.update(.5, 0)).toBe(true);
    expect(gate.update(0, 250)).toBe(true);
    expect(gate.update(0, 400)).toBe(false);
  });
});
