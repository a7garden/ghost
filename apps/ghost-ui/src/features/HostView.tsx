import { RefreshCw } from 'lucide-react';
import { Button, SettingsGroup, SettingsRow, InlineError } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { StateGlyph } from '../components/agent/StateGlyph';
import { hostStatus } from './hostStatus';
import './SettingsPages.css';

/** 호스트: where this UI's data comes from and whether conversations can run. */
export function HostView() {
  const { store } = useHost();
  const { state, connection, error, offlineSince } = useHostState(store);
  // The settings page is the honest surface: it shows quiet states too.
  const status = hostStatus(connection, Boolean(state), offlineSince, Date.now());
  const connected = status.state === 'connected';
  const lost = status.state === 'offline';
  const tone = connected ? undefined : lost ? 'danger' : 'warning';
  return <section className="settings-ledger" aria-label="연결 상태">
    <div className="settings-verdict" data-tone={tone}>
      <span aria-hidden="true"><StateGlyph state={connected ? 'done' : lost ? 'failed' : 'waiting'} size={20}/></span>
      <div className="settings-verdict__copy" role="status">
        <strong>{status.label}</strong>
        {!connected && state && <small>마지막으로 받은 상태를 표시합니다.</small>}
      </div>
      <Button variant="outline" type="button" onClick={() => store.refresh()}><RefreshCw size={15} aria-hidden="true"/>다시 연결</Button>
    </div>
    {state && <SettingsGroup title={<span className="sr-only">Host 정보</span>} className="settings-ledger__group settings-ledger__group--unheaded">
      <SettingsRow label="대화 실행" description={!state.runtime.ready ? state.runtime.detail : undefined}>
        <span className="settings-ledger__value" data-tone={!state.runtime.ready ? 'warning' : undefined}>{state.runtime.ready ? '가능' : '불가'} · Ghost {state.runtime.version}</span>
      </SettingsRow>
      {state.principal.kind === 'device' && <SettingsRow label="이 기기">
        <span className="settings-ledger__value">{state.principal.name}</span>
      </SettingsRow>}
    </SettingsGroup>}
    {error && <InlineError>{error}</InlineError>}
  </section>;
}
