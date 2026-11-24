import { useEffect, useRef, useState } from 'react';
import { Loader2, Play, Square } from 'lucide-react';
import { InlineError } from '../../ui';
import { errorMessage } from './media';
import './voice.css';

type Voice = { value: string; label: string };
type Heard = { voice: string; state: 'loading' | 'playing' };

/**
 * A voice list you can listen to: choosing a voice and hearing it are separate hands, so trying five voices never
 * changes the one a call will use. One sample plays at a time; tapping the playing one stops it.
 */
export function VoicePicker({ labelledBy, scope, voices, value, disabled, onChange, load }: {
  labelledBy: string;
  /** Samples differ per engine; the cache and any playing sample are dropped when this changes. */
  scope: string;
  voices: Voice[];
  value: string;
  disabled?: boolean;
  onChange(voice: string): void;
  load(voice: string, signal: AbortSignal): Promise<ArrayBuffer>;
}) {
  const [heard, setHeard] = useState<Heard | null>(null);
  const [error, setError] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const urls = useRef(new Map<string, string>());
  const name = `voice-${scope}`;

  const stop = () => {
    request.current?.abort();
    request.current = null;
    audio.current?.pause();
    audio.current = null;
    setHeard(null);
  };

  useEffect(() => {
    const kept = urls.current;
    return () => {
      stop();
      for (const url of kept.values()) URL.revokeObjectURL(url);
      kept.clear();
    };
  }, [scope]);

  async function listen(voice: string) {
    if (heard?.voice === voice) { stop(); return; }
    stop();
    setError('');
    const controller = request.current = new AbortController();
    setHeard({ voice, state: 'loading' });
    try {
      const key = `${scope}:${voice}`;
      let url = urls.current.get(key);
      if (!url) {
        url = URL.createObjectURL(new Blob([await load(voice, controller.signal)], { type: 'audio/wav' }));
        urls.current.set(key, url);
      }
      if (controller.signal.aborted) return;
      const player = audio.current = new Audio(url);
      player.onended = () => { if (audio.current === player) { audio.current = null; setHeard(null); } };
      await player.play();
      if (audio.current === player) setHeard({ voice, state: 'playing' });
    } catch (reason) {
      if (controller.signal.aborted) return;
      stop();
      setError(errorMessage(reason, '목소리를 들려주지 못했습니다.'));
    }
  }

  return <div className="voice-picker">
    <div className="voice-picker__list" role="radiogroup" aria-labelledby={labelledBy}>
      {voices.map(voice => {
        const state = heard?.voice === voice.value ? heard.state : undefined;
        return <div key={voice.value} className="voice-picker__row" data-selected={voice.value === value || undefined}>
          <label className="voice-picker__choose">
            <input type="radio" name={name} value={voice.value} checked={voice.value === value} disabled={disabled}
              onChange={() => onChange(voice.value)}/>
            <span className="voice-picker__mark" aria-hidden="true"/>
            <span className="voice-picker__name">{voice.label}</span>
          </label>
          <button type="button" className="voice-picker__play" data-state={state}
            aria-label={state ? `${voice.label} 멈추기` : `${voice.label} 들어보기`} onClick={() => void listen(voice.value)}>
            {state === 'loading' ? <Loader2 aria-hidden="true"/> : state === 'playing' ? <Square aria-hidden="true"/> : <Play aria-hidden="true"/>}
          </button>
        </div>;
      })}
    </div>
    {error && <InlineError>{error}</InlineError>}
  </div>;
}
