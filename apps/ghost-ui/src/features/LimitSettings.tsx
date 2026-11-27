import { useState, type FormEvent } from 'react';
import { DEFAULT_LIMITS, type Limits } from '@ghost/contract';
import { Button, InlineError, Input, SettingsGroup, SettingsRow } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { uiTerms } from '../uiText';
import { errorText } from './InfrastructureFields';
import './SettingsPages.css';

type LimitField = { key: keyof Limits; label: string; description: string; min: number; max: number };

/** The eleven bounds in three everyday groups; keys, minimums and maximums follow the contract. */
export const limitGroups: { title: string; fields: LimitField[] }[] = [
  { title: '스스로 일하기', fields: [
    { key: 'dailyWakes', label: '하루 스스로 시작 횟수', description: 'Ghost 한 명이 하루에 스스로 일을 시작하는 횟수', min: 0, max: 1000 },
    { key: 'concurrentWakes', label: '동시 자동 실행', description: '', min: 1, max: 64 },
  ]},
  { title: '일 하나의 크기', fields: [
    { key: 'rootNodes', label: '일의 총 개수', description: '맡긴 일 하나에 포함된 일의 수', min: 1, max: 1024 },
    { key: 'activityNodes', label: '자동 활동당 일 개수', description: '', min: 1, max: 1024 },
    { key: 'depth', label: '넘겨 줄 단계 수', description: 'Ghost 사이에서 이어지는 위임의 깊이', min: 1, max: 32 },
    { key: 'liveChildren', label: '동시 하위 일', description: '상위 일 하나 기준', min: 1, max: 256 },
    { key: 'workQuestions', label: '질문 횟수', description: '일 하나에서 소유자에게 묻는 횟수', min: 0, max: 1024 },
    { key: 'revisions', label: '자동 재시도 횟수', description: '반려된 결과를 자동으로 다시 시도하는 횟수', min: 0, max: 32 },
  ]},
  { title: '목표와 Ghost', fields: [
    { key: 'openGoals', label: '동시에 열 목표', description: '', min: 1, max: 64 },
    { key: 'goalProposalCooldownDays', label: '목표 재제안 대기', description: '거절한 목표를 다시 제안하기까지 걸리는 날 수', min: 0, max: 365 },
    { key: 'ghostsPerDay', label: '하루 새 Ghost 수', description: '', min: 0, max: 1000 },
  ]},
];

/** Flat view of `limitGroups` for anything that lists the bounds without the grouping. */
export const limitFields: { key: keyof Limits; label: string; min: number; max: number }[] = limitGroups.flatMap(group => group.fields);

/** The bounds as rows. Empty entries follow `inherited` when one is given, and are required otherwise. */
export function LimitFields({ value, onChange, inherited }: { value: Partial<Limits>; onChange(value: Partial<Limits>): void; inherited?: Limits }) {
  return <>
    {limitGroups.map((group, at) => <SettingsGroup key={group.title} title={group.title} className="settings-ledger__group"
      description={inherited && at === 0 ? '비워 두면 전체 한도를 따릅니다.' : undefined}>
      {group.fields.map(field => <SettingsRow key={field.key} label={field.label} description={field.description}>
        <Input type="number" className="w-24 tabular-nums" min={field.min} max={field.max} required={!inherited} aria-label={field.label}
          value={value[field.key] ?? ''} placeholder={inherited ? String(inherited[field.key]) : undefined}
          onChange={event => { const next = { ...value }; if (event.target.value === '') delete next[field.key]; else next[field.key] = Number(event.target.value); onChange(next); }}/>
      </SettingsRow>)}
    </SettingsGroup>)}
  </>;
}

export function LimitSettings({ scopeId }: { scopeId?: string }) {
  const { store } = useHost();
  const { state } = useHostState(store);
  const scope = state?.scopes.find(item => item.id === scopeId);
  if (!state) return null;
  return <LimitEditor key={`${scopeId ?? 'global'}:${JSON.stringify(scope?.limits ?? state.settings.limits)}`} scopeId={scopeId}
    value={scope?.limits ?? state.settings.limits ?? DEFAULT_LIMITS} inherited={scopeId ? state.settings.limits ?? DEFAULT_LIMITS : undefined}/>;
}

function LimitEditor({ scopeId, value, inherited }: { scopeId?: string; value: Partial<Limits>; inherited?: Limits }) {
  const { client } = useHost();
  const [draft, setDraft] = useState(value), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try { await client.send({ type: 'limits.set', scopeId: scopeId ?? null, limits: draft }); setSaved(true); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <form className="settings-ledger" onSubmit={event => void submit(event)} aria-label={scopeId ? '프로젝트 작업량 한도' : uiTerms.limits}>
    <fieldset disabled={busy} className="settings-ledger min-w-0 border-0 m-0 p-0">
      <LimitFields value={draft} onChange={next => { setDraft(next); setSaved(false); }} inherited={inherited}/>
    </fieldset>
    {error && <InlineError>{error}</InlineError>}
    {saved && <p className="settings-ledger__note" role="status">저장했습니다.</p>}
    <div className="settings-ledger__footer">
      {!inherited && <Button type="button" variant="outline" onClick={() => { setDraft({ ...DEFAULT_LIMITS }); setSaved(false); }}>기본값으로</Button>}
      <Button type="submit" disabled={busy}>{busy ? '저장 중…' : '한도 저장'}</Button>
    </div>
  </form>;
}
