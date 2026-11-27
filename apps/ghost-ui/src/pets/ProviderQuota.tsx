import { useCallback, useEffect, useState } from 'react';
import type { ProviderQuota, ProviderQuotaWindow } from '@ghost/contract';
import { InlineError } from '../ui';
import { useHost } from '../host/context';
import { absoluteTime, untilTime, useNow } from '../features/time';

const POLL_MS = 60_000;

/** 가득 차 가는 구간만 색을 바꾼다. */
const barTone = (percent: number) => percent >= 95 ? 'bg-destructive' : percent >= 80 ? 'bg-amber' : 'bg-signal';

function Window({ window, now }: { window: ProviderQuotaWindow; now: number }) {
  const percent = Math.round(window.usedPercent);
  return <li className="model-quota__window">
    <span>{window.label}</span>
    <span className="model-quota__meter" role="meter" aria-label={`${window.label} 사용량`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span className={barTone(window.usedPercent)} style={{ width: `${Math.max(percent, window.usedPercent > 0 ? 2 : 0)}%` }}/>
    </span>
    <span className="model-quota__percent">{percent}%</span>
    {window.resetsAt !== null && <time dateTime={new Date(window.resetsAt).toISOString()} title={absoluteTime(window.resetsAt)}>{untilTime(window.resetsAt, now)} 초기화</time>}
  </li>;
}

/** Quota readings are joined to provider rows by the Host's provider id. */
export function useProviderQuotas() {
  const { client } = useHost();
  const now = useNow();
  const [quotas, setQuotas] = useState<ProviderQuota[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try { setQuotas(await client.providerQuotas(refresh)); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '사용량을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  }, [client]);

  useEffect(() => {
    void load(false);
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return { quotas, error, loading, now, refresh: () => void load(true) };
}

export function ProviderUsage({ quota, now }: { quota: ProviderQuota; now: number }) {
  return <div className="model-quota">
    {quota.plan && <span className="model-meta">{quota.plan}</span>}
    {quota.windows.length > 0 && <ul className="model-quota__windows" aria-label={`${quota.name} 사용량`}>
      {quota.windows.map(window => <Window key={window.label} window={window} now={now}/>)}
    </ul>}
    {quota.error && <InlineError>{quota.error}</InlineError>}
  </div>;
}
