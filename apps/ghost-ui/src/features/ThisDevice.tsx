import { useEffect, useId, useRef, useState } from 'react';
import { Bell, BellOff, CircleAlert, LogOut, Minus, Plus, Smartphone } from 'lucide-react';
import type { Device, Ghost, NotificationKind, QuietHours } from '@ghost/contract';
import { Button, InlineError, Input, SettingsGroup, SettingsRow, Switch } from '../ui';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { useHost } from '../host/context';
import { shell, shellCall, type PermissionStatus } from '../host/shell';
import { toneFor } from './ghostState';
import { AlertWriter } from './deviceAlerts';
import { blurTouchSearchOnEnter } from '../ui/adaptive';
import './SettingsLists.css';

const kinds: { kind: NotificationKind; label: string }[] = [
  { kind: 'decision', label: '확인 요청' },
  { kind: 'message', label: '대화' },
  { kind: 'work_done', label: '완료' },
  { kind: 'work_failed', label: '실패' },
];
export function ThisDevice({ device, ghosts }: { device: Device; ghosts: Ghost[] }) {
  const { client } = useHost();
  const [permission, setPermission] = useState<PermissionStatus>();
  const [alerts, setAlerts] = useState(device.alerts);
  const [error, setError] = useState('');
  const [alertError, setAlertError] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [query, setQuery] = useState('');
  const [pendingMutes, setPendingMutes] = useState(0);
  const ghostAlertsId = useId();
  const muteTrigger = useRef<HTMLButtonElement>(null);
  const [writer] = useState(() => new AlertWriter(device.alerts, next => client.send({ type: 'device.alerts_update', alerts: next }), setAlerts,
    () => setAlertError('알림 설정을 저장하지 못했습니다.')));
  useEffect(() => writer.sync(device.alerts), [writer, device.alerts]);
  useEffect(() => {
    if (!shell) return;
    const status = () => { void shellCall({ type: 'notifications.status' }).then(reply => setPermission(reply.status)).catch(reason => setError(String(reason))); };
    status();
    const resume = (event: Event) => { if ((event as CustomEvent).detail?.type === 'resume') status(); };
    window.addEventListener('ghost-shell', resume);
    return () => window.removeEventListener('ghost-shell', resume);
  }, []);
  const permissionAction = async () => {
    setBusy(true); setError('');
    try {
      if (permission === 'denied') await shellCall({ type: 'notifications.settings' });
      else { const reply = await shellCall({ type: 'notifications.request' }); setPermission(reply.status); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '알림 권한을 확인하지 못했습니다.'); }
    finally { setBusy(false); }
  };
  const muted = ghosts.filter(ghost => alerts.mutedGhostIds.includes(ghost.id));
  const quiet = alerts.quietHours ?? null;
  const filter = query.trim().toLocaleLowerCase();
  const shownGhosts = picking ? ghosts.filter(ghost => ghost.name.toLocaleLowerCase().includes(filter)) : [];
  const setQuiet = (next: QuietHours | null) => { setAlertError(''); void writer.toggle({ quietHours: next }); };
  return <section className="settings-list-page this-device-ledger" aria-label="이 기기">
    <div className="settings-list__lead">
      <p className="settings-list__verdict">이 기기 · 페어링됨</p>
      <div className="settings-list__actions">
        <Button variant="ghost" className="text-danger" onClick={() => setDisconnecting(true)}><LogOut size={17}/>연결 해제</Button>
      </div>
    </div>
    <div className="settings-list__row" data-tone={permission === 'denied' ? 'amber' : undefined}>
      <span className="settings-list__mark"><Smartphone size={17} aria-hidden="true"/></span>
      <div className="settings-list__copy">
        <h2 className="settings-list__title">{device.name}</h2>
        <p className="settings-list__meta settings-list__state">
          {permission === 'denied' && <CircleAlert size={14} aria-hidden="true"/>}
          {!shell ? 'iPhone 앱에서 알림을 설정할 수 있습니다.' : permission === 'allowed' ? 'iPhone 알림 허용됨'
            : permission === 'denied' ? 'iPhone 알림 권한 필요' : 'iPhone 알림'}
        </p>
      </div>
      {shell && <div className="settings-list__actions">
        <Button variant="outline" aria-label={permission === 'allowed' ? '허용됨' : undefined} disabled={busy || !permission} onClick={() => void permissionAction()}>
          {permission === 'allowed' ? <Bell size={16} aria-hidden="true"/> : permission === 'denied' ? '설정 열기' : '알림 허용'}
        </Button>
      </div>}
    </div>
    <SettingsGroup title="알림">
      <div role="group" aria-label="받을 알림">
      <ul className="device-alert-ledger" role="list">
        {kinds.map(item => {
          const enabled = !alerts.mutedKinds.includes(item.kind);
          return <li key={item.kind}><button className="settings-list__row device-alert-ledger__toggle" type="button" aria-pressed={enabled} aria-label={item.label}
            onClick={() => { setAlertError(''); void writer.toggle({ kind: item.kind }); }}>
            <span className="settings-list__mark">{enabled ? <Bell size={16} aria-hidden="true"/> : <BellOff size={16} aria-hidden="true"/>}</span>
            <span className="settings-list__title">{item.label}</span>
            <span className="settings-list__value" aria-hidden="true">{enabled ? '켬' : '끔'}</span>
          </button></li>;
        })}
      </ul>
      </div>
      <div className="device-ghost-control" onKeyDown={event => {
        if (picking && event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.stopPropagation(); setPicking(false); setQuery(''); muteTrigger.current?.focus();
        }
      }}>
        <button ref={muteTrigger} type="button" className="device-ghost-mutes" aria-label="Ghost별 알림"
          aria-expanded={picking} aria-controls={ghostAlertsId} aria-describedby={muted.length ? `${ghostAlertsId}-muted` : undefined}
          onClick={() => { if (picking) setQuery(''); setPicking(!picking); }}>
          <span>Ghost별 알림</span>
          {muted.length > 0 && <span className="device-muted-portraits">
            {muted.slice(0, 4).map(ghost => <DotAvatar key={ghost.id} profileId={ghost.id} tone={toneFor(ghost.id)} size={24}/>)}
            <span id={`${ghostAlertsId}-muted`}>{muted.length} 끔</span>
          </span>}
          {picking ? <Minus size={16} aria-hidden="true"/> : <Plus size={16} aria-hidden="true"/>}
        </button>
        <section id={ghostAlertsId} className="device-ghost-panel" aria-label="Ghost별 알림" hidden={!picking}>
          {picking && <>
            {ghosts.length > 0 && <Input type="text" enterKeyHint="search" aria-label="Ghost 검색" placeholder="Ghost 검색"
              value={query} onChange={event => setQuery(event.target.value)} onKeyDown={blurTouchSearchOnEnter}/>}
            {shownGhosts.length ? <ul className="device-ghost-list" aria-label="Ghost" role="list">
              {shownGhosts.map(ghost => {
                const enabled = !alerts.mutedGhostIds.includes(ghost.id);
                return <li key={ghost.id}><button type="button" aria-pressed={enabled} onClick={() => {
                  setAlertError(''); setPendingMutes(count => count + 1);
                  void writer.toggle({ ghostId: ghost.id }).finally(() => setPendingMutes(count => count - 1));
                }}>
                  <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={26}/>
                  <span className="device-ghost-name settings-list__title">{ghost.name}</span>
                  <span className="settings-list__value" aria-hidden="true">{enabled ? '켬' : '끔'}</span>
                  {enabled ? <Bell size={16} aria-hidden="true"/> : <BellOff size={16} aria-hidden="true"/>}
                </button></li>;
              })}
            </ul> : <p className="device-ghost-feedback">{ghosts.length ? '검색 결과 없음' : 'Ghost 없음'}</p>}
          </>}
        </section>
        {pendingMutes > 0 && <p className="device-ghost-feedback" role="status">저장 중…</p>}
        {alertError && <InlineError className="mb-2">{alertError}</InlineError>}
      </div>
      <SettingsRow label="방해금지" htmlFor="device-quiet-hours">
        <Switch id="device-quiet-hours" checked={quiet !== null} onCheckedChange={on => setQuiet(on ? { start: '22:00', end: '07:00' } : null)}/>
      </SettingsRow>
      {quiet && <SettingsRow label="시간">
        <span className="flex items-center gap-2">
          <Input type="time" aria-label="방해금지 시작" className="w-[120px]" value={quiet.start} onChange={event => event.target.value && setQuiet({ ...quiet, start: event.target.value })}/>
          <span aria-hidden="true">–</span>
          <Input type="time" aria-label="방해금지 끝" className="w-[120px]" value={quiet.end} onChange={event => event.target.value && setQuiet({ ...quiet, end: event.target.value })}/>
        </span>
      </SettingsRow>}
    </SettingsGroup>
    {error && !disconnecting && <InlineError>{error}</InlineError>}
    {disconnecting && <Modal title="연결 해제" onClose={() => !busy && setDisconnecting(false)}>
      <p>{device.name}의 페어링을 해제하면 이 기기는 더 이상 Ghost에 접근할 수 없습니다.</p>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => setDisconnecting(false)}>취소</Button>
        <Button variant="destructive" disabled={busy} onClick={() => {
          setBusy(true); setError('');
          void client.send({ type: 'device.revoke', deviceId: device.id }).then(async () => {
            if (shell) await shellCall({ type: 'disconnected' });
            else location.reload();
          }).catch(reason => setError(reason instanceof Error ? reason.message : '연결을 해제하지 못했습니다.')).finally(() => setBusy(false));
        }}>연결 해제</Button></div>
    </Modal>}
  </section>;
}
