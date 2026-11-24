import { describe, expect, it, vi } from 'vitest';
import { speechSentences, SpeechQueue } from './speech';

describe('sentence playback', () => {
  it('waits for the streaming tail and flushes it once the message commits', () => {
    const first = speechSentences('첫 문장입니다. 아직 둘째 문장', 0, false);
    expect(first.sentences).toEqual(['첫 문장입니다.']);
    const second = speechSentences('첫 문장입니다. 아직 둘째 문장입니다. 마지막', first.offset, false);
    expect(second.sentences).toEqual(['아직 둘째 문장입니다.']);
    expect(speechSentences('첫 문장입니다. 아직 둘째 문장입니다. 마지막', second.offset).sentences).toEqual(['마지막']);
    expect(speechSentences('정말요?네!\n온도는 21.5도입니다.').sentences).toEqual(['정말요?', '네!', '온도는 21.5도입니다.']);
  });

  it('keeps long fragments within the TTS limit without breaking surrogate pairs', () => {
    const text = `${'가'.repeat(499)}🙂마지막`;
    const { sentences, offset } = speechSentences(text);
    expect(sentences).toEqual(['가'.repeat(499), '🙂마지막']);
    expect(sentences.join('')).toBe(text);
    expect(offset).toBe(text.length);
  });

  it('prefetches one buffer ahead, then stops both and drops queued work on barge-in', async () => {
    const plays = new Map<string, { finish(): void; stop(): void }>();
    const load = vi.fn(async (text: string) => text);
    const queue = new SpeechQueue({ load, failed: vi.fn(), play(text, finish) {
      const stop = vi.fn();
      plays.set(text, { finish, stop });
      return stop;
    } });
    queue.enqueue(['하나', '둘', '셋', '넷']);
    await vi.waitFor(() => expect(plays.size).toBe(2));
    expect(load.mock.calls).toEqual([['하나', expect.any(AbortSignal)], ['둘', expect.any(AbortSignal)]]);
    plays.get('하나')!.finish();
    await vi.waitFor(() => expect(plays.has('셋')).toBe(true));
    queue.interrupt();
    expect(plays.get('하나')!.stop).not.toHaveBeenCalled();
    expect(plays.get('둘')!.stop).toHaveBeenCalledOnce();
    expect(plays.get('셋')!.stop).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(3);
    expect(queue.busy).toBe(false);
  });

  it('discards a late decode after interruption, even as a new turn starts', async () => {
    const late = Promise.withResolvers<string>();
    const load = vi.fn<(text: string, signal: AbortSignal) => Promise<string>>().mockReturnValueOnce(late.promise).mockResolvedValueOnce('새 답');
    const play = vi.fn(() => vi.fn());
    const failed = vi.fn();
    const queue = new SpeechQueue<string>({ load, play, failed });
    queue.enqueue(['이전 답']);
    const oldSignal = load.mock.calls[0]![1];
    queue.interrupt();
    expect(oldSignal.aborted).toBe(true);
    queue.enqueue(['새 답']);
    late.resolve('이전 답');
    await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
    expect(play).toHaveBeenCalledWith('새 답', expect.any(Function));
    expect(failed).not.toHaveBeenCalled();
  });
});

describe('opening sentence', () => {
  it('is spoken as soon as it ends, without waiting for the token after it', () => {
    expect(speechSentences('네, 확인해 볼게요.', 0, false).sentences).toEqual(['네, 확인해 볼게요.']);
    expect(speechSentences('찾아볼게요?', 0, false).sentences).toEqual(['찾아볼게요?']);
  });

  it('keeps waiting when a period may be a decimal point, and skips a late closing quote', () => {
    expect(speechSentences('버전은 2.', 0, false)).toEqual({ sentences: [], offset: 0 });
    const spoken = speechSentences('"좋아요."', 0, false);
    expect(spoken.sentences).toEqual(['"좋아요."']);
    expect(speechSentences('좋아요.”', 5, true).sentences).toEqual([]);
  });
});
