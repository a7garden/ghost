import { useEffect, useState } from 'react';
import { Bell, BellOff, ChevronRight, LogOut } from 'lucide-react';
import type { Device, Ghost, NotificationKind } from '@ghost/contract';
import { Button, InlineError, Input, SettingsGroup, SettingsRow } from '../ui';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { useHost } from '../host/context';
import { shell, shellCall, type PermissionStatus } from '../host/shell';
import { toneFor } from './ghostState';
import { AlertWriter } from './deviceAlerts';
import { blurTouchSearchOnEnter } from '../ui/adaptive';

const kinds: { kind: NotificationKind; label: string; tone: string }[] = [
  { kind: 'decision', label: '확인 요청', tone: 'attention' },
  { kind: 'work_done', label: '완료', tone: 'done' },
  { kind: 'work_failed', label: '실패', tone: 'failed' },
];
export function ThisDevice({ device, ghosts }: { device: Device; ghosts: Ghost[] }) {
  const { client } = useHost();
  const [permission, setPermission] = useState<PermissionStatus>();
  const [alerts, setAlerts] = useState(device.alerts);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [query, setQuery] = useState('');
  const [writer] = useState(() => new AlertWriter(device.alerts, next => client.send({ type: 'device.alerts_update', alerts: next }), setAlerts,
    reason => setError(reason instanceof Error ? reason.message : '알림 설정을 저장하지 못했습니다.')));
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
  return <section className="this-device" aria-label="이 기기">
    <header><span className="text-caption text-ink-3">이 기기</span><h2 className="section-title">{device.name}</h2></header>
    <SettingsGroup title="알림">
      <SettingsRow className="device-permission-row" label="iPhone 알림" description={!shell ? 'iPhone 앱에서 알림을 설정할 수 있습니다.' : undefined}>
        {shell && <Button variant="outline" disabled={busy || !permission} onClick={() => void permissionAction()}>
          {permission === 'allowed' ? <><Bell size={16}/>허용됨</> : permission === 'denied' ? '설정 열기' : '알림 허용'}
        </Button>}
      </SettingsRow>
      <div className="device-alert-kinds" role="group" aria-label="받을 알림">
        {kinds.map(item => { const enabled = !alerts.mutedKinds.includes(item.kind); return <button type="button" key={item.kind} data-tone={item.tone} aria-pressed={enabled}
          onClick={() => { setError(''); void writer.toggle({ kind: item.kind }); }}>
          {enabled ? <Bell size={18}/> : <BellOff size={18}/>}<span>{item.label}</span><i aria-hidden="true"/>
        </button>; })}
      </div>
      <button type="button" className="device-ghost-mutes" onClick={() => setPicking(true)}>
        <span>Ghost별 알림</span><span className="device-muted-portraits">{muted.slice(0, 4).map(ghost => <DotAvatar key={ghost.id} profileId={ghost.id} tone={toneFor(ghost.id)} size={24}/>)}{muted.length > 0 && <span>{muted.length} 끔</span>}</span><ChevronRight size={16}/>
      </button>
    </SettingsGroup>
    {error && <InlineError>{error}</InlineError>}
    <Button variant="ghost" className="self-start text-danger" onClick={() => setDisconnecting(true)}><LogOut size={17}/>연결 해제</Button>
    {picking && <Modal title="Ghost별 알림" onClose={() => setPicking(false)}>
      <Input type="text" enterKeyHint="search" aria-label="Ghost 검색" placeholder="Ghost 검색" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={blurTouchSearchOnEnter}/>
      <div className="device-ghost-list">{ghosts.filter(ghost => ghost.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(ghost => {
        const enabled = !alerts.mutedGhostIds.includes(ghost.id);
        return <button type="button" key={ghost.id} aria-pressed={enabled} onClick={() => { setError(''); void writer.toggle({ ghostId: ghost.id }); }}>
          <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={32}/><span className="device-ghost-name">{ghost.name}</span>{enabled ? <Bell size={19}/> : <BellOff size={19}/>}
        </button>;
      })}</div>
    </Modal>}
    {disconnecting && <Modal title="연결 해제" onClose={() => !busy && setDisconnecting(false)}>
      <p>{device.name}에서 Ghost 연결을 해제할까요?</p>
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
