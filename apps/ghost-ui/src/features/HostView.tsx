import { RefreshCw } from 'lucide-react';
import { Badge, Button, SettingsGroup, SettingsRow, InlineError } from '../ui'
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { uiTerms } from '../uiText';
import { hostStatus } from './hostStatus';

/** 호스트: where this UI's data comes from and whether conversations can run. */
export function HostView() {
  const { store } = useHost();
  const { state, connection, error, offlineSince } = useHostState(store);
  // The settings page is the honest surface: it shows quiet states too.
  const status = hostStatus(connection, Boolean(state), offlineSince, Date.now());
  return <SettingsGroup title={uiTerms.connectionStatus}>
    <SettingsRow label="연결">
      <Badge variant={status.state === 'connected' ? 'success' : status.state === 'offline' ? 'danger' : 'warning'}>{status.label}</Badge>
    </SettingsRow>
    {state && <SettingsRow label="대화 실행" description={`Ghost 버전 ${state.runtime.version}`}>
      <Badge variant={state.runtime.ready ? 'success' : 'warning'}>{state.runtime.ready ? '가능' : '불가'}</Badge>
    </SettingsRow>}
    {state && !state.runtime.ready && <SettingsRow label="실행할 수 없는 이유">
      <p className="m-0 max-w-[28rem] text-caption leading-relaxed text-ink-2">{state.runtime.detail}</p>
    </SettingsRow>}
    {state && state.principal.kind === 'device' && <SettingsRow label="이 기기">
      <span className="text-caption text-ink-2">{state.principal.name}</span>
    </SettingsRow>}
    {error && <SettingsRow label="마지막 오류"><InlineError className="max-w-[24rem]">{error}</InlineError></SettingsRow>}
    <SettingsRow label="다시 연결" description="연결 상태를 다시 확인합니다.">
      <Button variant="outline" onClick={() => store.refresh()}><RefreshCw className="size-4"/>다시 연결</Button>
    </SettingsRow>
  </SettingsGroup>;
}
