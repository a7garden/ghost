import { afterEach, expect, it, vi } from 'vitest';
import { encodeWav } from './audio';
import { createLocalVoiceTransport } from './transport';
afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
it('keeps audio on same-origin routes, adds CSRF, and synthesizes only a committed task ID', async () => {
  const requests: { url: string; init?: RequestInit; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ url, init, body });
    if (url.endsWith('bootstrap')) return json({ mode: 'live', csrf: 'fixture-csrf' });
    if (url.endsWith('config')) return json({ ok: true, result: { available: true, settings_version: 9, stt_model: 'local/stt', tts_model: 'local/tts' } });
    if (url.endsWith('transcribe')) return json({ ok: true, result: { text: '안녕하세요', settings_version: 9 } });
    return json({ ok: true, result: { mime: 'audio/wav', audio_base64: btoa('RIFFfixture') } });
  }));
  const transport = createLocalVoiceTransport('profile', 'conversation'), signal = new AbortController().signal;
  await transport.configure(signal);
  const wav = encodeWav(new Float32Array([0.25, 0.5])); expect(await transport.transcribe(wav, signal)).toEqual({ text: '안녕하세요' });
  const audio = await transport.synthesize({ id: 'message', taskId: 'committed-task', text: 'renderer text must not leave UI' }, signal);
  expect(audio.type).toBe('audio/wav'); expect(await audio.text()).toBe('RIFFfixture');
  expect(requests.every(request => request.url.startsWith('/ghost-api/'))).toBe(true);
  expect(requests.slice(1).every(request => (request.init?.headers as Record<string, string>)['X-Ghost-UI-CSRF'] === 'fixture-csrf')).toBe(true);
  expect(requests[2].body?.settings_version).toBe(9);
  const encoded = requests[2].body?.audio_base64 as string;
  expect(atob(encoded).slice(0, 4)).toBe('RIFF');
  expect(requests[3].body).toEqual({ profile_id: 'profile', conversation_id: 'conversation', settings_version: 9, task_id: 'committed-task' });
});
it('rejects demo bootstrap and changed settings before returning transcribed text', async () => {
  let live = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('bootstrap')) return json({ mode: live ? 'live' : 'demo', csrf: 'fixture' });
    if (url.endsWith('config')) return json({ available: true, settings_version: 9 });
    return json({ text: '이전 설정 결과', settings_version: 10 });
  }));
  const transport = createLocalVoiceTransport('p', 'c'), signal = new AbortController().signal;
  await expect(transport.configure(signal)).rejects.toThrow('로컬 호스트');
  live = true; await transport.configure(signal);
  await expect(transport.transcribe(encodeWav(new Float32Array(10)), signal)).rejects.toThrow('모델 설정');
});
it('rejects oversized input before transmitting it and handles server denial without fallback', async () => {
  const fetch = vi.fn(async (url: string) => url.endsWith('bootstrap') ? json({ mode: 'live', csrf: 'fixture' }) : url.endsWith('config') ? json({ available: true, settings_version: 9 }) : json({ error: '외부 음성 서버는 허용되지 않습니다.' }, 403));
  vi.stubGlobal('fetch', fetch);
  const transport = createLocalVoiceTransport('p', 'c'), signal = new AbortController().signal;
  await transport.configure(signal); const count = fetch.mock.calls.length;
  await expect(transport.transcribe(new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]), signal)).rejects.toThrow('발화가 너무 깁니다');
  expect(fetch).toHaveBeenCalledTimes(count);
  await expect(transport.synthesize({ id: 'm', taskId: 't', text: 'fixture' }, signal)).rejects.toThrow('외부 음성 서버');
  expect(fetch).toHaveBeenCalledTimes(count + 1);
});
it('works without AbortSignal.any/timeout and keeps cold speech requests alive for 130 seconds', async () => {
  vi.useFakeTimers();
  const any = vi.spyOn(AbortSignal, 'any').mockImplementation(() => { throw new Error('unsupported'); });
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => { throw new Error('unsupported'); });
  let bounded: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('bootstrap')) return json({ mode: 'live', csrf: 'fixture' });
    if (url.endsWith('config')) return json({ available: true, settings_version: 9 });
    bounded = init?.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => { bounded!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }); });
  }));
  try {
    const transport = createLocalVoiceTransport('p', 'c'), signal = new AbortController().signal;
    await transport.configure(signal);
    const pending = transport.synthesize({ id: 'm', taskId: 't', text: 'fixture' }, signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(120000); expect(bounded?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10000); await rejection; expect(bounded?.aborted).toBe(true);
    expect(any).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled();
  } finally { any.mockRestore(); timeout.mockRestore(); vi.useRealTimers(); }
});
it('propagates barge-in cancellation while response JSON is still streaming', async () => {
  let bodySignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('bootstrap')) return json({ mode: 'live', csrf: 'fixture' });
    if (url.endsWith('config')) return json({ available: true, settings_version: 9 });
    bodySignal = init?.signal as AbortSignal;
    return { ok: true, json: () => new Promise((_resolve, reject) => { bodySignal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }); }) } as Response;
  }));
  const transport = createLocalVoiceTransport('p', 'c'), controller = new AbortController();
  await transport.configure(controller.signal);
  const pending = transport.synthesize({ id: 'm', taskId: 't', text: 'fixture' }, controller.signal);
  const rejection = expect(pending).rejects.toThrow();
  await Promise.resolve(); await Promise.resolve(); controller.abort(); await rejection;
  expect(bodySignal?.aborted).toBe(true);
});
