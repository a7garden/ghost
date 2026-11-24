import { useEffect, useState } from 'react';
import type { MetricsView } from '@ghost/contract';
import { Button, InlineError, SettingsGroup, SettingsRow, SkeletonText } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Choice, errorText } from './InfrastructureFields';
import { uiTerms } from '../uiText';
import { describeRule } from './policyText';

const percent = (value: number | null) => value === null ? '아직 없음' : `${(value * 100).toFixed(1)}%`;
const number = (value: number | null) => value === null ? '아직 없음' : value.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
const cost = (value: number | null) => value === null ? '아직 없음' : `$${value.toLocaleString('ko-KR', { maximumFractionDigits: 4 })}`;
const duration = (ms: number | null) => {
  if (ms === null) return '아직 없음';
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds.toLocaleString('ko-KR')}초`;
  const minutes = Math.floor(seconds / 60), rest = Math.round(seconds % 60);
  if (minutes < 60) return rest ? `${minutes}분 ${rest}초` : `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}시간 ${minutes % 60}분` : `${hours}시간`;
};
const value = (text: string) => <span className="text-ui font-medium text-ink">{text}</span>;

/** 「성과와 비용」: Ghost들이 맡은 일의 결과와, 일 하나당 든 시간·토큰·비용을 한눈에 보여 준다. */
export function ScopeMetrics({ scopeId }: { scopeId?: string | null }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [metrics, setMetrics] = useState<MetricsView | null>(null);
  const [ghostId, setGhostId] = useState('');
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [reload, setReload] = useState(0);
  const [selectedScope, setSelectedScope] = useState('all');
  const effectiveScopeId = scopeId !== undefined ? scopeId : selectedScope === 'all' ? undefined : selectedScope === 'global' ? null : selectedScope;
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(''); setMetrics(null);
    client.metrics({ scopeId: effectiveScopeId, ...(ghostId ? { ghostId } : {}) })
      .then(view => { if (alive) setMetrics(view); })
      .catch(reason => { if (alive) setError(errorText(reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [client, effectiveScopeId, ghostId, reload]);
  const ruleRows = metrics ? Object.entries(metrics.rules)
    .filter(([, counts]) => counts.approved !== 0 || counts.denied !== 0)
    .map(([id, counts]) => {
      const rule = state?.policyRules.find(item => item.id === id);
      if (!rule) return { key: id, subject: '삭제된 규칙', description: '', counts };
      const text = describeRule(rule, state ?? null);
      return { key: id, subject: text.subject, description: text.conditions.length ? text.conditions.join(' · ') : text.reach, counts };
    }) : [];
  const note = metrics
    ? [!metrics.usageComplete && '사용량 기록이 일부 없어 비용·토큰이 적게 보일 수 있습니다.', !metrics.observationHistoryComplete && '이전 관측 기록이 일부 없습니다.'].filter(Boolean).join(' ')
    : '';
  const ghostOptions = [{ value: '', label: '모두' }, ...(state?.ghosts ?? []).map(ghost => ({ value: ghost.id, label: ghost.name }))];
  return <section className="grid gap-6">
    <SettingsGroup title={uiTerms.metrics} actions={<Button variant="outline" disabled={loading} onClick={() => setReload(value => value + 1)}>새로고침</Button>}>
      <div className="infra-editor">
        {scopeId === undefined && <Choice label="범위" value={selectedScope} onChange={setSelectedScope}
          options={[{ value: 'all', label: '모든 범위' }, { value: 'global', label: '전체 (프로젝트 없음)' }, ...(state?.scopes ?? []).map(scope => ({ value: scope.id, label: scope.name }))]} />}
        {scopeId === undefined
          ? <Choice label="Ghost" value={ghostId} onChange={setGhostId} options={ghostOptions}/>
          : <details className="infra-fold"><summary>Ghost별로 보기{ghostId ? ' · 고름' : ''}</summary><Choice label="Ghost" value={ghostId} onChange={setGhostId} options={ghostOptions}/></details>}
        {loading && <SkeletonText label="불러오는 중…" lines={2} />}
        {error && <InlineError>{error}</InlineError>}
      </div>
    </SettingsGroup>
    {metrics && <>
      {metrics.works === 0 && <p className="m-0 text-caption text-ink-2">아직 집계할 일이 없습니다.</p>}
      {metrics.works > 0 && <OutcomeBand works={metrics.works} completed={metrics.completed} rejected={metrics.rejected}/>}
      {metrics.works > 0 && (metrics.elapsedMsPerAcceptedWork !== null || metrics.tokensPerAcceptedWork !== null || metrics.costPerAcceptedWork !== null) && <SettingsGroup title="일 하나당" description="수용된 일 기준">
        {metrics.elapsedMsPerAcceptedWork !== null && <SettingsRow label="평균 걸린 시간">{value(duration(metrics.elapsedMsPerAcceptedWork))}</SettingsRow>}
        {metrics.tokensPerAcceptedWork !== null && <SettingsRow label="평균 토큰">{value(number(metrics.tokensPerAcceptedWork))}</SettingsRow>}
        {metrics.costPerAcceptedWork !== null && <SettingsRow label="평균 비용(USD)">{value(cost(metrics.costPerAcceptedWork))}</SettingsRow>}
      </SettingsGroup>}
      {(metrics.ownerOverturnedVerdicts > 0 || metrics.quotaWaitMs > 0 || metrics.repeatGuardHits > 0) && <SettingsGroup title="그 밖">
        {metrics.ownerOverturnedVerdicts > 0 && <SettingsRow label="내가 뒤집은 검토 결과">{value(`${metrics.ownerOverturnedVerdicts.toLocaleString('ko-KR')}번`)}</SettingsRow>}
        {metrics.quotaWaitMs > 0 && <SettingsRow label="사용량 한도 때문에 기다린 시간">{value(duration(metrics.quotaWaitMs))}</SettingsRow>}
        {metrics.repeatGuardHits > 0 && <SettingsRow label="같은 시도를 되풀이해 막은 횟수">{value(`${metrics.repeatGuardHits.toLocaleString('ko-KR')}번`)}</SettingsRow>}
      </SettingsGroup>}
      {ruleRows.length > 0 && <SettingsGroup title="승인 요청 처리" description="규칙이 승인·거절한 요청의 누적 횟수입니다.">
        {ruleRows.map(row => <SettingsRow key={row.key} label={row.subject} description={row.description}>{value(`승인 ${row.counts.approved.toLocaleString('ko-KR')} · 거절 ${row.counts.denied.toLocaleString('ko-KR')}`)}</SettingsRow>)}
      </SettingsGroup>}
      {note && <p className="m-0 text-caption text-ink-3">{note}</p>}
    </>}
  </section>;
}

/**
 * Finished Work as one band: solid for accepted, red for sent back, hatched for what is still open or
 * ended otherwise. The counts under it say the same in words.
 */
function OutcomeBand({ works, completed, rejected }: { works: number; completed: number; rejected: number }) {
  const rest = Math.max(0, works - completed - rejected);
  const share = (count: number) => `${((count / works) * 100).toFixed(1)}%`;
  const parts = [{ kind: 'done', label: '완료', count: completed }, { kind: 'rejected', label: '반려', count: rejected }, { kind: 'rest', label: '진행 중·기타', count: rest }];
  return <section className="outcome" aria-label="결과">
    <div className="outcome__band" role="img" aria-label={`맡긴 일 ${works}건 중 ${parts.map(part => `${part.label} ${part.count}건`).join(', ')}`}>
      {parts.filter(part => part.count > 0).map(part => <span key={part.kind} data-kind={part.kind} style={{ flexGrow: part.count }}/>)}
    </div>
    <dl className="outcome__legend">
      <div><dt>맡긴 일</dt><dd className="tabular">{works.toLocaleString('ko-KR')}</dd></div>
      {parts.map(part => <div key={part.kind} data-kind={part.kind}><dt>{part.label}</dt><dd className="tabular">{part.count.toLocaleString('ko-KR')} · {share(part.count)}</dd></div>)}
    </dl>
  </section>;
}
