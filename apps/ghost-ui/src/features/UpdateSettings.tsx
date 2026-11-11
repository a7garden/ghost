import { toDataURL } from 'qrcode';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Download, KeyRound, QrCode, RefreshCw } from 'lucide-react';
import type { UpdateStatus } from '@ghost/contract';
import { Badge, Button, InlineError, Input, SettingsGroup, SettingsRow, Switch } from '../ui';
import { shell as iosShell } from '../host/shell';
import { isDesktopShell, shellVersion } from '../host/desktop';
import { supportsIosInstall, updatePollingPhase, type UpdateMonitor } from './update/useUpdate';
import { relativeTime, useNow } from './time';

const phaseLabel: Record<'checking' | 'downloading' | 'waiting' | 'installing', string> = {
  checking: '확인 중',
  downloading: '받는 중',
  waiting: '진행 중인 대화가 끝나면 설치합니다',
  installing: '설치하고 다시 시작하는 중',
};

const disabledLabel = {
  development: '개발 빌드는 업데이트하지 않습니다',
  layout: '릴리스 설치 위치에서 실행 중이 아닙니다',
  service: <>Ghost 서비스로 실행 중이 아니어서 업데이트할 수 없습니다. <code>ghost service install</code>로 실행하세요</>,
} as const;

function lastResultLabel(result: NonNullable<UpdateStatus['lastResult']>): { variant: 'success' | 'warning' | 'danger'; text: string } {
  if (result.outcome === 'installed') return { variant: 'success', text: `${result.to} 설치됨` };
  if (result.outcome === 'rolled_back') return { variant: 'warning', text: `${result.to}가 시작되지 않아 ${result.from}으로 되돌렸습니다` };
  return { variant: 'danger', text: `${result.to}가 시작되지 않았습니다. 백업에서 복원해야 합니다` };
}

/** 설정 → 업데이트: the host's own release, the desktop shell's app, and the GitHub credential. */
export function UpdateSettings({ monitor }: { monitor: UpdateMonitor }) {
  const { status, shell, error, pending } = useSyncExternalStore(monitor.subscribe, monitor.get, monitor.get);
  const now = useNow();
  const desktop = isDesktopShell();
  const [appVersion, setAppVersion] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenEditing, setTokenEditing] = useState(false);
  const [iosQr, setIosQr] = useState('');
  const [iosError, setIosError] = useState('');
  const [iosPending, setIosPending] = useState(false);
  useEffect(() => {
    if (isDesktopShell()) void shellVersion().then(setAppVersion).catch(() => {});
  }, []);

  const phase = status?.phase;
  const active = updatePollingPhase(phase);
  const busy = pending || active;
  const latest = status?.latest ?? null;
  const disabled = status && !status.enabled && status.disabledReason ? disabledLabel[status.disabledReason] : null;
  const hasCredential = status?.hasCredential ?? false;
  const tokenField = !hasCredential || tokenEditing;
  const lastResult = status?.lastResult ? lastResultLabel(status.lastResult) : null;

  const saveToken = () => {
    const token = tokenDraft.trim();
    if (!token) return;
    void monitor.save({ token }).then(() => { setTokenDraft(''); setTokenEditing(false); });
  };

  return <div className="grid gap-6">
    <SettingsGroup title="버전">
      <SettingsRow label="현재 버전" description={appVersion ? `앱 ${appVersion}` : undefined}>
        <span className="text-ui text-ink">{status ? status.current.version : '—'}</span>
      </SettingsRow>
      {status && <SettingsRow label="최신 버전" description={latest?.notes}>
        {latest
          ? <span className="flex min-w-0 items-center gap-2">
              <span className="text-ui text-ink">{latest.version}</span>
              <Button variant="outline" disabled={busy} onClick={() => void monitor.install(latest.version)}>
                <Download aria-hidden="true"/>설치
              </Button>
            </span>
          : disabled
            ? <span className="text-caption text-ink-2">{disabled}</span>
            : status.checkedAt
              ? <span className="text-caption text-ink-2">최신 버전입니다</span>
              : <span className="text-caption text-ink-2">—</span>}
      </SettingsRow>}
      {status && phase && phase !== 'idle' && phase !== 'error' && <SettingsRow label="상태">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-caption text-ink-2">{phaseLabel[phase]}</span>
          {(phase === 'downloading' || phase === 'waiting') &&
            <Button variant="outline" size="sm" disabled={pending} onClick={() => void monitor.cancel()}>취소</Button>}
        </span>
      </SettingsRow>}
      <SettingsRow label="지금 확인"
        description={status?.checkedAt
          ? <><time dateTime={new Date(status.checkedAt).toISOString()}>{relativeTime(status.checkedAt, now)}</time> 확인</>
          : undefined}>
        <Button variant="outline" disabled={!status?.enabled || phase === 'checking' || pending} onClick={() => void monitor.check()}>
          <RefreshCw aria-hidden="true"/>지금 확인
        </Button>
      </SettingsRow>
      {(status?.error || error) && <SettingsRow label="오류">
        <InlineError className="max-w-[28rem]">{status?.error ?? error}</InlineError>
      </SettingsRow>}
      {lastResult && <SettingsRow label="마지막 결과">
        <Badge variant={lastResult.variant}>{lastResult.text}</Badge>
      </SettingsRow>}
      {desktop && <SettingsRow label="앱 업데이트" description={shell?.notes}>
        {shell
          ? <span className="flex min-w-0 items-center gap-2">
              <span className="text-ui text-ink">{shell.version}</span>
              <Button variant="outline" disabled={pending} onClick={() => void monitor.installShell()}>
                <Download aria-hidden="true"/>앱 업데이트
              </Button>
            </span>
          : appVersion ? <span className="text-caption text-ink-2">최신 버전입니다</span> : null}
      </SettingsRow>}
      {status?.ios && iosShell && supportsIosInstall(iosShell) && <SettingsRow label="앱 업데이트" description={`현재 ${iosShell.version} · ${status.ios.notes}`}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-ui text-ink">{status.ios.version} ({status.ios.build})</span>
          <Button variant="outline" disabled={pending || status.ios.build <= Number(iosShell.version)} onClick={() => void monitor.installIos()}>
            <Download aria-hidden="true"/>앱 업데이트
          </Button>
        </span>
      </SettingsRow>}
      {status?.ios && (!iosShell || !supportsIosInstall(iosShell)) && <SettingsRow label="iPhone 앱" description={`${status.ios.version} (${status.ios.build})`}>
        <Button variant="outline" disabled={iosPending} onClick={() => {
          setIosPending(true); setIosError('');
          void monitor.getIosUpdateLink().then(async ({ page }) => setIosQr(await toDataURL(page, { margin: 2, width: 240, errorCorrectionLevel: 'M' })))
            .catch(reason => setIosError(reason instanceof Error ? reason.message : 'QR 코드를 만들지 못했습니다.'))
            .finally(() => setIosPending(false));
        }}><QrCode aria-hidden="true"/>QR 코드</Button>
      </SettingsRow>}
      {iosQr && (!iosShell || !supportsIosInstall(iosShell)) && <SettingsRow label="QR 코드">
        <span className="grid justify-items-center gap-2">
          <img src={iosQr} alt="iPhone 앱 설치 QR 코드" width={240} height={240} className="rounded-lg bg-canvas p-2"/>
          <span className="text-caption text-ink-2">15분 동안 쓸 수 있습니다</span>
        </span>
      </SettingsRow>}
      {iosError && <SettingsRow label="오류"><InlineError>{iosError}</InlineError></SettingsRow>}
    </SettingsGroup>
    <SettingsGroup title="자동 확인">
      <SettingsRow label="자동 확인" htmlFor="update-auto-check">
        <Switch id="update-auto-check" checked={status?.autoCheck ?? false}
          disabled={!status?.enabled || pending}
          onCheckedChange={autoCheck => void monitor.save({ autoCheck })}/>
      </SettingsRow>
      <SettingsRow label="GitHub 토큰" htmlFor={tokenField ? 'update-token' : undefined}
        description={hasCredential ? '비공개 저장소 릴리스를 내려받을 때 씁니다.' : undefined}>
        {tokenField
          ? <span className="flex min-w-0 items-center gap-2">
              <Input id="update-token" type="password" value={tokenDraft} maxLength={512} autoComplete="off"
                className="w-56" placeholder="GitHub 개인 액세스 토큰"
                onChange={event => setTokenDraft(event.target.value)}/>
              <Button variant="outline" disabled={!tokenDraft.trim() || pending} onClick={saveToken}>저장</Button>
            </span>
          : <span className="flex min-w-0 items-center gap-2">
              <Badge variant="success"><KeyRound size={10} aria-hidden="true"/>저장됨</Badge>
              <Button variant="outline" size="sm" disabled={pending} onClick={() => setTokenEditing(true)}>바꾸기</Button>
              <Button variant="ghost" size="sm" disabled={pending}
                onClick={() => { setTokenEditing(false); void monitor.save({ token: null }); }}>지우기</Button>
            </span>}
      </SettingsRow>
    </SettingsGroup>
  </div>;
}
