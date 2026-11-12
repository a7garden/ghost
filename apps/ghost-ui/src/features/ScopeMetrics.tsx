import { useEffect, useState } from 'react';
import type { MetricsView } from '@ghost/contract';
import { Button, InlineError, SettingsGroup } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Choice, errorText } from './InfrastructureFields';

const percent = (value: number | null) => value === null ? '집계 없음' : `${(value * 100).toFixed(1)}%`;
const number = (value: number | null) => value === null ? '집계 없음' : value.toLocaleString('ko-KR', { maximumFractionDigits: 4 });

export function ScopeMetrics({ scopeId }: { scopeId?: string | null }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [metrics, setMetrics] = useState<MetricsView | null>(null);
  const [ghostId, setGhostId] = useState(''), [slot, setSlot] = useState(''), [ruleId, setRuleId] = useState('');
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [reload, setReload] = useState(0);
  const [selectedScope, setSelectedScope] = useState('all');
  const effectiveScopeId = scopeId !== undefined ? scopeId : selectedScope === 'all' ? undefined : selectedScope === 'global' ? null : selectedScope;
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(''); setMetrics(null);
    client.metrics({ scopeId: effectiveScopeId, ...(ghostId ? { ghostId } : {}), ...(slot ? { slot } : {}), ...(ruleId ? { ruleId } : {}) })
      .then(value => { if (alive) setMetrics(value); })
      .catch(reason => { if (alive) setError(errorText(reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [client, effectiveScopeId, ghostId, slot, ruleId, reload]);
  const rows: [string, string][] = metrics ? [
    ['맡긴 일', number(metrics.works)], ['완료', number(metrics.completed)], ['반려', number(metrics.rejected)],
    ['완료율', percent(metrics.completionRate)], ['반려율', percent(metrics.rejectionRate)],
    ['수용된 일 하나의 시간', metrics.elapsedMsPerAcceptedWork === null ? '집계 없음' : `${number(metrics.elapsedMsPerAcceptedWork / 1000)}초`],
    ['수용된 일 하나의 토큰', number(metrics.tokensPerAcceptedWork)], ['수용된 일 하나의 비용 (USD)', number(metrics.costPerAcceptedWork)],
    ['소유자가 뒤집은 판정', number(metrics.ownerOverturnedVerdicts)], ['한도 대기 시간', `${number(metrics.quotaWaitMs / 1000)}초`], ['반복 차단', number(metrics.repeatGuardHits)],
  ] : [];
  return <SettingsGroup title="계측" actions={<Button variant="outline" disabled={loading} onClick={() => setReload(value => value + 1)}>새로고침</Button>}>
    <div className="infra-form">
      {scopeId === undefined && <Choice label="범위" value={selectedScope} onChange={value => { setSelectedScope(value); setRuleId(''); }} options={[{ value: 'all', label: '모든 범위' }, { value: 'global', label: '전체 (프로젝트 없음)' }, ...(state?.scopes ?? []).map(scope => ({ value: scope.id, label: scope.name }))]}/>}
      <div className="infra-columns"><Choice label="Ghost" value={ghostId} onChange={setGhostId} options={[{ value: '', label: '모두' }, ...(state?.ghosts ?? []).map(ghost => ({ value: ghost.id, label: ghost.name }))]}/>
        <Choice label="모델 자리" value={slot} onChange={setSlot} options={[{ value: '', label: '모두' }, ...Object.keys(state?.settings.slots ?? {}).map(name => ({ value: name, label: name }))]}/></div>
      <Choice label="규칙" value={ruleId} onChange={setRuleId} options={[{ value: '', label: '모두' }, ...(state?.policyRules ?? []).filter(rule => effectiveScopeId === undefined || !rule.scopeId || rule.scopeId === effectiveScopeId).map(rule => ({ value: rule.id, label: `${rule.tool} · ${rule.decision}` }))]}/>
      {loading && <p role="status">계측을 불러오는 중…</p>}{error && <InlineError>{error}</InlineError>}
      {metrics && <>
        <dl className="infra-metrics">{rows.map(([label, value]) => <div className="contents" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        {Object.entries(metrics.rules).map(([id, counts]) => <div className="infra-record" key={id}><p className="infra-record__meta">{state?.policyRules.find(rule => rule.id === id)?.tool ?? id}</p><dl className="infra-metrics"><dt>승인</dt><dd>{counts.approved}</dd><dt>거절</dt><dd>{counts.denied}</dd></dl></div>)}
        {(!metrics.usageComplete || !metrics.observationHistoryComplete) && <p className="infra-record__meta">{[!metrics.usageComplete && '사용량 기록 일부 없음', !metrics.observationHistoryComplete && '이전 관측 기록 일부 없음'].filter(Boolean).join(' · ')}</p>}
      </>}
    </div>
  </SettingsGroup>;
}
