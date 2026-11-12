import { RefreshCw } from 'lucide-react';
import { Badge, Button, SettingsGroup, SettingsRow, InlineError } from '../ui'
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { hostStatus } from './hostStatus';

/** 호스트: where this UI's data comes from and whether conversations can run. */
export function HostView() {
  const { store } = useHost();
  const { state, connection, error, offlineSince } = useHostState(store);
  // The settings page is the honest surface: it shows quiet states too.
  const status = hostStatus(connection, Boolean(state), offlineSince, Date.now());
  return <SettingsGroup title="연결">
    <SettingsRow label="상태">
      <Badge variant={status.state === 'connected' ? 'success' : status.state === 'offline' ? 'danger' : 'warning'}>{status.label}</Badge>
    </SettingsRow>
    {error && <SettingsRow label="마지막 오류"><InlineError className="max-w-[24rem]">{error}</InlineError></SettingsRow>}
    {state && <SettingsRow label="Ghost 호스트" description={`버전 ${state.runtime.version}`}>
      <Badge variant={state.runtime.ready ? 'success' : 'warning'}>{state.runtime.ready ? '대화 실행 가능' : '대화 실행 불가'}</Badge>
    </SettingsRow>}
    {state && !state.runtime.ready && <SettingsRow label="실행 불가 사유">
      <p className="m-0 max-w-[28rem] text-caption leading-relaxed text-ink-2">{state.runtime.detail}</p>
    </SettingsRow>}
    {state && <SettingsRow label="연결 주체" description="이 화면이 호스트에 알리는 자격입니다.">
      <span className="text-caption text-ink-2">{state.principal.kind === 'owner' ? '소유자' : `기기 · ${state.principal.name}`}</span>
    </SettingsRow>}
    <SettingsRow label="다시 연결" description="상태를 다시 읽고 이벤트 스트림을 새로 엽니다.">
      <Button variant="outline" onClick={() => store.refresh()}><RefreshCw className="size-4"/>다시 연결</Button>
    </SettingsRow>
  </SettingsGroup>;
}
