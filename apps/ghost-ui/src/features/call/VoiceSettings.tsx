import { useId, useState } from 'react';
import { DEFAULT_VOICE, type CallEngine, type VoiceSettings as VoicePreference } from '@ghost/contract';
import { useHost } from '../../host/context';
import { useHostState } from '../../host/store';
import { InlineError, SelectField, SettingsGroup, SettingsRow } from '../../ui';
import { useCallActions } from './CallProvider';
import { engineLabel } from './call-state';
import { errorMessage } from './media';

const engines = [
  { value: 'realtime', label: engineLabel.realtime },
  { value: 'local', label: engineLabel.local },
] satisfies { value: CallEngine; label: string }[];

const speakers: Record<CallEngine, { value: string; label: string }[]> = {
  local: [
    ...['F1', 'F2', 'F3', 'F4', 'F5'].map(value => ({ value: value.toLowerCase(), label: `여성 ${value.slice(1)}` })),
    ...['M1', 'M2', 'M3', 'M4', 'M5'].map(value => ({ value: value.toLowerCase(), label: `남성 ${value.slice(1)}` })),
  ],
  realtime: [
    { value: 'noeul', label: '노을' }, { value: 'marin', label: '마린' }, { value: 'cedar', label: '시더' },
    ...['Quartz', 'Ripple', 'Vesper', 'Willow', 'Stone', 'Gleam', 'Meridian', 'Bossa', 'Tempo', 'Beacon', 'Delta', 'Cinder',
      'Nuri', 'Juni', 'Flitz', 'Brise', 'Sillage', 'Nira', 'Harema', 'Shida'].map(label => ({ value: label.toLowerCase(), label })),
  ],
};

export function VoiceSettings() {
  const { client, store } = useHost();
  const { state } = useHostState(store);
  const calls = useCallActions();
  const engineId = useId(), voiceId = useId(), availabilityId = useId();
  const [pending, setPending] = useState<VoicePreference | null>(null);
  const [error, setError] = useState('');
  const { engine, voice } = pending ?? state?.settings.voice ?? DEFAULT_VOICE;
  const reason = calls?.unavailable[engine];
  const voices = [{ value: DEFAULT_VOICE.voice, label: '기본' }, ...speakers[engine]];
  if (!voices.some(option => option.value === voice)) voices.push({ value: voice, label: voice });

  const save = (patch: Partial<VoicePreference>) => {
    if (pending) return;
    setError('');
    setPending({ engine, voice, ...patch });
    void client.setVoice(patch).catch(caught => setError(errorMessage(caught, '음성 설정을 저장하지 못했습니다.')))
      .finally(() => setPending(null));
  };

  return <SettingsGroup title="통화">
    <SettingsRow label="통화 방식" htmlFor={engineId}>
      <SelectField id={engineId} label="통화 방식" options={engines} value={engine} disabled={Boolean(pending)}
        aria-describedby={reason ? availabilityId : undefined} onValueChange={value => {
          const choice = engines.find(option => option.value === value);
          if (choice && choice.value !== engine) save({ engine: choice.value, voice: DEFAULT_VOICE.voice });
        }}/>
    </SettingsRow>
    {reason && <InlineError id={availabilityId}>{reason}</InlineError>}
    <SettingsRow label="목소리" htmlFor={voiceId}>
      <SelectField id={voiceId} label="목소리" options={voices} value={voice} disabled={Boolean(pending)}
        onValueChange={value => { if (value !== voice) save({ voice: value }); }}/>
    </SettingsRow>
    {error && <InlineError>{error}</InlineError>}
  </SettingsGroup>;
}
