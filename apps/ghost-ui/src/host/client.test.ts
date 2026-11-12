import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostClient, HostError, ndjsonLines } from './client';

describe('HostClient on the Cloudflare Access origin', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reloads into the Access login when an expired session redirects an API call', async () => {
    const reload = vi.fn();
    const fetch = vi.fn(async () => ({ type: 'opaqueredirect', status: 0, ok: false }) as Response);
    vi.stubGlobal('window', { location: { reload } });
    vi.stubGlobal('fetch', fetch);
    const error = await new HostClient(undefined).state().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostError);
    expect((error as HostError).code).toBe('forbidden');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/state', expect.objectContaining({ redirect: 'manual' }));
  });

  it('keeps an unreachable Host a network error without reloading', async () => {
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const error = await new HostClient(undefined).state().catch((caught: unknown) => caught);
    expect((error as HostError).code).toBe('network');
    expect(reload).not.toHaveBeenCalled();
  });
});

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
