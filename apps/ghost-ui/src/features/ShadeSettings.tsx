import { useCallback, useEffect, useState } from 'react';
import type { ShadeState, ShadeStatus } from '@ghost/contract';
import { Badge, InlineError, SettingsGroup, SettingsRow, Switch } from '../ui';
import { useHost } from '../host/context';

const stateLabel: Record<ShadeState, string> = { unavailable: '없음', locked: '잠김', agent_off: '에이전트 접근 꺼짐', ready: '연결됨' };

/** What the owner can do next about Shade, in one line; null when nothing is needed. Pure; tests pin it. */
export function shadeNextStep(status: ShadeStatus): string | null {
  if (status.state === 'locked') return 'Shade 앱에서 잠금을 풀면 핸드오프에서 저장된 로그인을 쓸 수 있어요.';
  if (status.state === 'agent_off') return 'Shade 앱에서 에이전트 접근을 켜 주세요.';
  if (status.state === 'ready' && !status.writable) return '새 로그인을 Shade에도 저장하려면 Shade 앱에서 에이전트 쓰기를 켜 주세요.';
  return null;
}

/** Shade is the owner's own password app; this row only appears when it is installed. */
export function ShadeSettings() {
  const { client } = useHost();
  const [status, setStatus] = useState<ShadeStatus | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => client.shadeStatus().then(setStatus).catch(() => {}), [client]);
  useEffect(() => {
    void load();
    // Locking or unlocking happens in another app; follow it while this page is open.
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 5000);
    return () => clearInterval(timer);
  }, [load]);
  if (!status || status.state === 'unavailable') return null;
  const next = shadeNextStep(status);
  const toggle = async (saveLogins: boolean) => {
    setSaving(true); setError('');
    try { setStatus(await client.setShadeSaveLogins(saveLogins)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '설정을 바꾸지 못했습니다.'); }
    finally { setSaving(false); }
  };
  return <SettingsGroup title="Shade">
    <SettingsRow label={<span className="flex items-center gap-2">Shade<Badge variant={status.state === 'ready' ? 'success' : 'outline'}>{stateLabel[status.state]}</Badge></span>}
      description={next ?? undefined}>{null}</SettingsRow>
    {status.state === 'ready' && <SettingsRow label="새 로그인을 Shade에도 저장" htmlFor="shade-save-logins">
      <Switch id="shade-save-logins" checked={status.saveLogins && status.writable} disabled={!status.writable || saving} onCheckedChange={checked => void toggle(checked)}/>
    </SettingsRow>}
    {error && <InlineError>{error}</InlineError>}
  </SettingsGroup>;
}
