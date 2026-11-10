import { describe, expect, it } from 'vitest';
import { ndjsonLines } from './client';

describe('ndjsonLines', () => {
  it('returns the complete lines of one chunk and keeps nothing when lines end cleanly', () => {
    expect(ndjsonLines('', '{"type":"page","url":"https://a.example","title":"예시"}\n{"type":"end"}\n')).toEqual({
      lines: ['{"type":"page","url":"https://a.example","title":"예시"}', '{"type":"end"}'],
      rest: '',
    });
  });

  it('joins a line split across chunks and leaves the tail for the next chunk', () => {
    const first = ndjsonLines('', '{"type":"frame","data":"ab');
    expect(first).toEqual({ lines: [], rest: '{"type":"frame","data":"ab' });
    const second = ndjsonLines(first.rest, 'c","width":800,"height":600}\n{"type":"end","reason":"완료"}\n{"type":"pag');
    expect(second.lines).toEqual([
      '{"type":"frame","data":"abc","width":800,"height":600}',
      '{"type":"end","reason":"완료"}',
    ]);
    expect(second.rest).toBe('{"type":"pag');
  });

  it('drops blank lines between events', () => {
    expect(ndjsonLines('', '\n\n{"type":"end"}\n\n')).toEqual({ lines: ['{"type":"end"}'], rest: '' });
    expect(ndjsonLines('', '\r\n{"type":"end"}\r\n')).toEqual({ lines: ['{"type":"end"}'], rest: '' });
    expect(ndjsonLines('', '')).toEqual({ lines: [], rest: '' });
  });
});
