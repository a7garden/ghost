import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ProviderQuota, ProviderQuotaWindow } from '@ghost/contract';
import { Badge, Button, InlineError, SettingsGroup, SettingsRow } from '../ui';
import { useHost } from '../host/context';
import { absoluteTime, untilTime, useNow } from '../features/time';

const POLL_MS = 60_000;

/** 가득 차 가는 구간만 색을 바꾼다. */
const barTone = (percent: number) => percent >= 95 ? 'bg-destructive' : percent >= 80 ? 'bg-amber' : 'bg-signal';

function Window({ window, now }: { window: ProviderQuotaWindow; now: number }) {
  const percent = Math.round(window.usedPercent);
  return <li className="flex min-w-0 items-center gap-3 text-caption">
    <span className="w-16 flex-none truncate text-ink-2 sm:w-20" title={window.label}>{window.label}</span>
    <span className="h-1.5 w-20 flex-none overflow-hidden rounded-pill bg-inset sm:w-28" role="meter" aria-label={`${window.label} 사용량`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span className={`block h-full rounded-pill ${barTone(window.usedPercent)}`} style={{ width: `${Math.max(percent, window.usedPercent > 0 ? 2 : 0)}%` }}/>
    </span>
    <span className="w-9 flex-none text-right font-mono tabular-nums text-ink">{percent}%</span>
    <span className="w-20 flex-none truncate text-ink-3 sm:w-24" title={window.resetsAt === null ? undefined : absoluteTime(window.resetsAt)}>{window.resetsAt === null ? '' : `${untilTime(window.resetsAt, now)} 초기화`}</span>
  </li>;
}

/** 구독 사용량. 제공자 계정에서 읽어 온 값이며, 읽을 수 있는 제공자만 나온다. */
export function ProviderQuotaGroup() {
  const { client } = useHost();
  const now = useNow();
  const [quotas, setQuotas] = useState<ProviderQuota[] | null>(null);
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

  if (!error && (quotas === null || quotas.length === 0)) return null;
  return <>
    <SettingsGroup title="사용량" actions={<Button variant="ghost" size="icon" type="button" aria-label="사용량 새로고침" disabled={loading} onClick={() => void load(true)}><RefreshCw size={15} className={loading ? 'animate-spin' : undefined}/></Button>}>
      {(quotas ?? []).map(quota => <SettingsRow key={quota.id}
        label={<span className="flex min-w-0 flex-wrap items-center gap-2 text-ui font-semibold text-ink [overflow-wrap:anywhere]">{quota.name}{quota.plan && <Badge variant="outline">{quota.plan}</Badge>}</span>}
        description={quota.error ? <span className="text-warning">{quota.error}</span> : undefined}>
        {quota.windows.length > 0 && <ul className="m-0 flex min-w-0 list-none flex-col gap-1.5 p-0">{quota.windows.map(window => <Window key={window.label} window={window} now={now}/>)}</ul>}
      </SettingsRow>)}
    </SettingsGroup>
    {error && <InlineError pending={loading} onRetry={() => void load(true)} retryLabel="다시 불러오기">{error}</InlineError>}
  </>;
}
