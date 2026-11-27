import { toDataURL } from 'qrcode';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Download, KeyRound, QrCode, RefreshCw } from 'lucide-react';
import type { UpdateStatus } from '@ghost/contract';
import { Button, InlineError, Input, SettingsGroup, SettingsRow, Switch } from '../ui';
import { shell as iosShell } from '../host/shell';
import { isDesktopShell, shellVersion } from '../host/desktop';
import { StateGlyph } from '../components/agent/StateGlyph';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { supportsIosInstall, updatePollingPhase, type UpdateMonitor } from './update/useUpdate';
import { relativeTime, useNow } from './time';
import './SettingsPages.css';

const phaseLabel: Record<'checking' | 'downloading' | 'waiting' | 'installing', string> = {
  checking: '확인 중',
  downloading: '받는 중',
  waiting: '설치 대기 중',
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
  const { store } = useHost();
  const { state: host, connection } = useHostState(store);
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
  const previous = status?.lastResult;
  const lastResult = previous ? lastResultLabel(previous) : null;
  const issue = status?.error ?? error;
  const phaseText = phase && phase !== 'idle' && phase !== 'error' ? phaseLabel[phase] : null;
  const canCancel = phase === 'downloading' || phase === 'waiting';
  const canInstall = !!latest && !phaseText && !disabled;
  const showCheckInVerdict = !canInstall && !phaseText;
  const busyConversations = phase === 'waiting' && connection === 'live'
    ? host?.conversations.filter(conversation => conversation.busy).length ?? 0
    : 0;
  const verdict = phaseText
    ? `${phaseText}${latest ? ` · ${latest.version}` : ''}`
    : issue || phase === 'error' ? '업데이트를 완료하지 못했습니다'
      : disabled ? '업데이트할 수 없습니다'
        : latest ? `${latest.version} 설치 가능`
          : status?.checkedAt ? '최신 버전입니다'
            : status ? '새 버전을 확인하지 않았습니다' : '업데이트 상태 확인 중';

  const saveToken = () => {
    const token = tokenDraft.trim();
    if (!token) return;
    void monitor.save({ token }).then(() => { setTokenDraft(''); setTokenEditing(false); });
  };

  const check = <Button variant="outline" disabled={!status?.enabled || phase === 'checking' || pending} onClick={() => void monitor.check()}>
    <RefreshCw size={15} aria-hidden="true"/>지금 확인
  </Button>;
  const tone = phase === 'waiting' || disabled ? 'warning' : !phaseText && issue ? 'danger' : undefined;
  return <div className="settings-ledger update-settings">
    <div className="settings-verdict" data-tone={tone}>
      <span aria-hidden="true"><StateGlyph state={
        tone === 'danger' ? 'failed' : phase === 'waiting' ? 'waiting' : disabled ? 'attention'
          : phaseText ? 'running' : latest || !status?.checkedAt ? 'queued' : 'done'
      } size={20}/></span>
      <div className="settings-verdict__copy" role="status">
        <strong>{verdict}</strong>
        {status && <small>Host {status.current.version}{status.checkedAt && <> · <time dateTime={new Date(status.checkedAt).toISOString()}>{relativeTime(status.checkedAt, now)}</time> 확인</>}</small>}
        {phase === 'waiting' && <small>{busyConversations > 0
          ? `진행 중인 대화 ${busyConversations}개가 끝날 때까지 설치할 수 없습니다.`
          : '진행 중인 작업을 마치면 설치를 시도합니다.'}</small>}
        {disabled && <small>{disabled}</small>}
      </div>
      {canCancel ? <Button variant="outline" disabled={pending} onClick={() => void monitor.cancel()}>취소</Button>
        : canInstall && latest ? <Button disabled={busy} onClick={() => void monitor.install(latest.version)}><Download aria-hidden="true"/>설치</Button>
          : showCheckInVerdict ? check : null}
    </div>
    {issue && <InlineError>{issue}</InlineError>}
    {(!showCheckInVerdict || latest?.notes || lastResult || desktop || status?.ios) &&
    <SettingsGroup title={<span className="sr-only">버전</span>} className="settings-ledger__group settings-ledger__group--unheaded">
      {latest?.notes && <SettingsRow className="settings-ledger__notes-row" label="릴리스 노트" description={latest.notes}>{null}</SettingsRow>}
      {!showCheckInVerdict && <SettingsRow label="새 버전 확인">{check}</SettingsRow>}
      {lastResult && previous && <SettingsRow label="마지막 설치">
        <span className="settings-ledger__value" data-tone={lastResult.variant}>
          {previous.outcome === 'installed' && previous.to === status?.current.version ? '설치됨' : lastResult.text}
          {' · '}<time dateTime={new Date(previous.at).toISOString()}>{relativeTime(previous.at, now)}</time>
        </span>
      </SettingsRow>}
      {desktop && <SettingsRow label="Mac 앱" description={[appVersion && `현재 ${appVersion}`, shell && `새 버전 ${shell.version}`, shell?.notes].filter(Boolean).join(' · ')}>
        {shell && <Button variant="outline" disabled={pending} onClick={() => void monitor.installShell()}>
          <Download aria-hidden="true"/>앱 업데이트
        </Button>}
      </SettingsRow>}
      {status?.ios && iosShell && supportsIosInstall(iosShell) && <SettingsRow label="iPhone 앱"
        description={`현재 빌드 ${iosShell.version} · ${status.ios.version} (${status.ios.build})${status.ios.notes ? ` · ${status.ios.notes}` : ''}`}>
        <Button variant="outline" disabled={pending || status.ios.build <= Number(iosShell.version)} onClick={() => void monitor.installIos()}>
          <Download aria-hidden="true"/>앱 업데이트
        </Button>
      </SettingsRow>}
      {status?.ios && (!iosShell || !supportsIosInstall(iosShell)) && <SettingsRow label="iPhone 앱" description={`${status.ios.version} (${status.ios.build})`}>
        <Button variant="outline" disabled={iosPending} onClick={() => {
          setIosPending(true); setIosError('');
          void monitor.getIosUpdateLink().then(async ({ page }) => setIosQr(await toDataURL(page, { margin: 2, width: 240, errorCorrectionLevel: 'M' })))
            .catch(reason => setIosError(reason instanceof Error ? reason.message : 'QR 코드를 만들지 못했습니다.'))
            .finally(() => setIosPending(false));
        }}><QrCode aria-hidden="true"/>QR 코드</Button>
      </SettingsRow>}
      {iosQr && (!iosShell || !supportsIosInstall(iosShell)) && <SettingsRow className="settings-ledger__wide-value" label="설치 링크" description="QR 코드는 15분 동안 쓸 수 있습니다.">
        <span className="grid justify-items-center">
          <img src={iosQr} alt="iPhone 앱 설치 QR 코드" width={240} height={240} className="rounded-lg bg-canvas p-2"/>
        </span>
      </SettingsRow>}
    </SettingsGroup>}
    {iosError && <InlineError>{iosError}</InlineError>}
    <SettingsGroup title="자동 업데이트" className="settings-ledger__group">
      <SettingsRow label="새 버전 자동 설치" htmlFor="update-auto-check">
        <Switch id="update-auto-check" checked={status?.autoCheck ?? false}
          disabled={!status?.enabled || pending}
          onCheckedChange={autoCheck => void monitor.save({ autoCheck })}/>
      </SettingsRow>
      <SettingsRow className="settings-ledger__wide-value" label="GitHub 토큰" htmlFor={tokenField ? 'update-token' : undefined}
        description={tokenField ? '비공개 저장소의 릴리스를 받을 때 사용합니다.' : undefined}>
        {tokenField
          ? <span className="update-settings__token">
              <Input id="update-token" type="password" value={tokenDraft} maxLength={512} autoComplete="off"
                placeholder="개인 액세스 토큰"
                onChange={event => setTokenDraft(event.target.value)}/>
              <Button variant="outline" disabled={!tokenDraft.trim() || pending} onClick={saveToken}>저장</Button>
            </span>
          : <span className="settings-ledger__actions">
              <span className="settings-ledger__value inline-flex items-center gap-1"><KeyRound size={13} aria-hidden="true"/>저장됨</span>
              <Button variant="outline" size="sm" disabled={pending} onClick={() => setTokenEditing(true)}>바꾸기</Button>
              <Button variant="ghost" size="sm" disabled={pending}
                onClick={() => { setTokenEditing(false); void monitor.save({ token: null }); }}>지우기</Button>
            </span>}
      </SettingsRow>
    </SettingsGroup>
  </div>;
}
