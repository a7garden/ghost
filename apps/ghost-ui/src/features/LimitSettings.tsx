import { useState, type FormEvent } from 'react';
import { DEFAULT_LIMITS, type Limits } from '@ghost/contract';
import { Button, InlineError, Input, SettingsGroup } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { errorText } from './InfrastructureFields';

export const limitFields: { key: keyof Limits; label: string; min: number; max: number }[] = [
  { key: 'dailyWakes', label: 'Ghost별 하루 깨움', min: 0, max: 1000 },
  { key: 'concurrentWakes', label: '동시 자동 실행', min: 1, max: 64 },
  { key: 'rootNodes', label: '맡긴 일 트리 크기', min: 1, max: 1024 },
  { key: 'activityNodes', label: '활동 실행별 맡긴 일', min: 1, max: 1024 },
  { key: 'revisions', label: '자동 수정 횟수', min: 0, max: 32 },
  { key: 'depth', label: '위임 깊이', min: 1, max: 32 },
  { key: 'liveChildren', label: '동시 하위 맡긴 일', min: 1, max: 256 },
  { key: 'workQuestions', label: '맡긴 일별 질문', min: 0, max: 1024 },
  { key: 'goalProposalCooldownDays', label: '목표 재제안 대기 (일)', min: 0, max: 365 },
  { key: 'openGoals', label: '열린 목표', min: 1, max: 64 },
  { key: 'ghostsPerDay', label: '하루 Ghost 생성', min: 0, max: 1000 },
];

export function LimitFields({ value, onChange, inherited }: { value: Partial<Limits>; onChange(value: Partial<Limits>): void; inherited?: Limits }) {
  return <div className="infra-limits">{limitFields.map(field => <label className="infra-limit" key={field.key}>
    <span>{field.label}</span><Input type="number" min={field.min} max={field.max} required={!inherited} value={value[field.key] ?? ''} placeholder={inherited ? String(inherited[field.key]) : undefined}
      onChange={event => { const next = { ...value }; if (event.target.value === '') delete next[field.key]; else next[field.key] = Number(event.target.value); onChange(next); }}/>
  </label>)}</div>;
}

export function LimitSettings({ scopeId }: { scopeId?: string }) {
  const { store } = useHost();
  const { state } = useHostState(store);
  const scope = state?.scopes.find(item => item.id === scopeId);
  return <SettingsGroup title={scopeId ? '프로젝트 한도' : '전체 한도'}>
    {state && <LimitEditor key={`${scopeId ?? 'global'}:${JSON.stringify(scope?.limits ?? state.settings.limits)}`} scopeId={scopeId} value={scope?.limits ?? state.settings.limits ?? DEFAULT_LIMITS} inherited={scopeId ? state.settings.limits ?? DEFAULT_LIMITS : undefined}/>}
  </SettingsGroup>;
}

function LimitEditor({ scopeId, value, inherited }: { scopeId?: string; value: Partial<Limits>; inherited?: Limits }) {
  const { client } = useHost();
  const [draft, setDraft] = useState(value), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try { await client.send({ type: 'limits.set', scopeId: scopeId ?? null, limits: draft }); setSaved(true); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <form className="infra-form" onSubmit={event => void submit(event)}>
    {inherited && <p className="infra-record__meta">비운 항목은 전체 한도를 따릅니다.</p>}
    <fieldset disabled={busy} className="border-0 m-0 p-0"><LimitFields value={draft} onChange={value => { setDraft(value); setSaved(false); }} inherited={inherited}/></fieldset>
    {error && <InlineError>{error}</InlineError>}{saved && <p role="status">저장했습니다.</p>}
    <div className="infra-actions"><Button type="submit" disabled={busy}>{busy ? '저장 중…' : '한도 저장'}</Button></div>
  </form>;
}
