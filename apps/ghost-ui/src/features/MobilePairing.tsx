import { useEffect, useState } from 'react';
import { toDataURL } from 'qrcode';
import { Pencil, QrCode, Smartphone, Trash2 } from 'lucide-react';
import { Badge, Button, Checkbox, FormField, InlineError, Input, SettingsGroup, SettingsRow } from '../ui'
import type { Device, DeviceGrant } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Modal } from '../components/Modal';

/** The payload the iPhone's camera scans: `ghost://pair?origin=…&code=…`. Pure; exported for tests. */
export function pairingUrl(offer: { code: string; origin: string }): string {
  return `ghost://pair?origin=${encodeURIComponent(offer.origin)}&code=${encodeURIComponent(offer.code)}`;
}

const grantKey = (grant: DeviceGrant) => `${grant.ghostId}:${grant.conversationId ?? '*'}`;
export function sameGrants(a: DeviceGrant[], b: DeviceGrant[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(grantKey));
  return b.every(grant => keys.has(grantKey(grant)));
}

export function grantsLabel(grants: DeviceGrant[], ghostName: (id: string) => string): string {
  if (!grants.length) return 'Ghost 권한 없음';
  return grants.map(grant => `${ghostName(grant.ghostId)} 대화`).join(', ');
}

const seen = (ms: number) => new Date(ms).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 기기 페어링과 등록된 기기 관리. device.pairing_start · device.update · device.revoke로 저장한다. */
export function MobilePairing() {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const devices = state?.devices ?? [];
  const ghosts = state?.ghosts ?? [];
  const ghostName = (id: string) => ghosts.find(ghost => ghost.id === id)?.name ?? '알 수 없는 Ghost';
  const [offer, setOffer] = useState<{ code: string; expiresAt: number; origin: string }>();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Device>();
  const [revoking, setRevoking] = useState<Device>();
  const [qr, setQr] = useState('');
  const [pending, setPending] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!offer) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [offer]);
  useEffect(() => {
    if (!offer) { setQr(''); return; }
    let alive = true;
    toDataURL(pairingUrl(offer), { margin: 2, width: 240, errorCorrectionLevel: 'M' }).then(url => { if (alive) setQr(url); }).catch(() => { if (alive) setQr(''); });
    return () => { alive = false; };
  }, [offer]);
  const expired = Boolean(offer && offer.expiresAt <= now);
  const run = async (work: () => Promise<unknown>, done: string) => {
    setPending('save'); setError(''); setNotice('');
    try { await work(); setNotice(done); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.'); return false; }
    finally { setPending(''); }
  };
  return <section className="flex min-w-0 flex-col gap-6" aria-label="기기">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="section-title">기기</h2>
      <Button type="button" disabled={!state} onClick={() => { setError(''); setCreating(true); }}><QrCode size={15}/>기기 페어링</Button>
    </div>
    {offer && <section className="grid justify-items-center gap-3 rounded-xl bg-surface p-6 shadow-card" aria-label="페어링 코드">
      <div className="flex items-center gap-2 text-ui font-semibold text-ink"><Smartphone size={17} aria-hidden="true"/>iPhone에서 QR 코드를 스캔해 주세요</div>
      {qr && !expired ? <img src={qr} alt={`페어링 코드 ${offer.code}`} width={240} height={240} className="rounded-lg bg-canvas p-2"/> : null}
      {expired
        ? <p className="m-0 text-caption text-ink-2" role="status">코드가 만료됐습니다. 페어링을 다시 시작해 주세요.</p>
        : <p className="m-0 text-caption text-ink-2">코드 <strong className="font-mono">{offer.code}</strong> · 만료 {seen(offer.expiresAt)}</p>}
      <div className="flex gap-2">
        {expired && <Button variant="outline" type="button" onClick={() => { setOffer(undefined); setCreating(true); }}>다시 시작</Button>}
        <Button variant="ghost" type="button" onClick={() => setOffer(undefined)}>닫기</Button>
      </div>
    </section>}
    {devices.length
      ? <SettingsGroup title={<span className="sr-only">등록된 기기</span>}>{devices.map(device => <SettingsRow key={device.id} label={<span className="flex min-w-0 items-center gap-3">
        <Smartphone size={17} className="shrink-0 text-ink-3" aria-hidden="true"/>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2 text-ui font-medium text-ink [overflow-wrap:anywhere]">{device.name}
            {device.pushEnabled && <Badge variant="outline">알림</Badge>}
            {device.lastSeenAt && <span className="text-caption font-normal text-ink-3">마지막 연결 {seen(device.lastSeenAt)}</span>}
          </span>
          <span className="text-caption font-normal text-ink-2">{grantsLabel(device.grants, ghostName)}</span>
        </span>
      </span>}>
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="icon" type="button" aria-label={`${device.name} 권한 편집`} disabled={pending !== ''} onClick={() => { setError(''); setEditing(device); }}><Pencil size={15}/></Button>
          <Button variant="ghost" size="icon" type="button" aria-label={`${device.name} 연결 해제`} disabled={pending !== ''} onClick={() => { setError(''); setRevoking(device); }}><Trash2 size={15}/></Button>
        </span>
      </SettingsRow>)}</SettingsGroup>
      : state && <div className="calm"><Smartphone size={16} aria-hidden="true"/><p>페어링된 기기 없음</p></div>}
    {error && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}
    {creating && <GrantEditor title="기기 페어링" ghosts={ghosts} nameHint="iPhone 15 Pro" busy={pending !== ''} onClose={() => setCreating(false)} onSave={async input => {
      const result = await client.send<{ code: string; expiresAt: number; origin: string }>({ type: 'device.pairing_start', name: input.name, grants: input.grants });
      setCreating(false);
      setOffer(result);
    }}/>}
    {editing && <GrantEditor title={`${editing.name} 권한 편집`} ghosts={ghosts} initialName={editing.name} initialGrants={editing.grants} busy={pending !== ''} onClose={() => setEditing(undefined)} onSave={async input => {
      const saved = await run(async () => {
        const command: { type: 'device.update'; deviceId: string; name?: string; grants?: DeviceGrant[] } = { type: 'device.update', deviceId: editing.id };
        if (input.name !== editing.name) command.name = input.name;
        if (!sameGrants(input.grants, editing.grants)) command.grants = input.grants;
        await client.send(command);
      }, '기기를 저장했습니다.');
      if (saved) setEditing(undefined);
    }}/>}
    {revoking && <Modal title="기기 연결 해제" onClose={() => pending === '' && setRevoking(undefined)}>
      <p className="m-0">{revoking.name}의 페어링을 해제할까요? 이 기기는 더 이상 Ghost에 접근할 수 없습니다.</p>
      {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={pending !== ''} onClick={() => setRevoking(undefined)}>취소</Button>
        <Button variant="destructive" type="button" disabled={pending !== ''} onClick={() => void run(async () => { await client.send({ type: 'device.revoke', deviceId: revoking.id }); setRevoking(undefined); }, '기기를 해제했습니다.')}>해제</Button>
      </div>
    </Modal>}
  </section>;
}

/** 기기 이름과 Ghost 대화 권한을 고르는 폼. 만들기와 편집이 같은 형태를 쓴다. */
function GrantEditor({ title, ghosts, initialName = '', initialGrants, nameHint, busy, onClose, onSave }: {
  title: string;
  ghosts: { id: string; name: string }[];
  initialName?: string;
  initialGrants?: DeviceGrant[];
  nameHint?: string;
  busy: boolean;
  onClose(): void;
  onSave(input: { name: string; grants: DeviceGrant[] }): Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [grants, setGrants] = useState<DeviceGrant[]>(initialGrants?.map(grant => ({ ...grant })) ?? []);
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const locked = busy || saving;
  const toggle = (id: string, checked: boolean) => setGrants(current => checked
    ? [...current, { ghostId: id, conversationId: null }]
    : current.filter(grant => grant.ghostId !== id));
  const save = async () => {
    if (locked) return;
    if (!name.trim()) { setError('기기 이름을 입력해 주세요.'); return; }
    setSaving(true); setError('');
    try { await onSave({ name: name.trim(), grants }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '저장하지 못했습니다.'); }
    finally { setSaving(false); }
  };
  return <Modal title={title} onClose={() => !locked && onClose()} className="w-[min(560px,calc(100vw-2rem))] sm:max-w-[560px]">
    <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <FormField label="기기 이름">{control => <Input {...control} value={name} onChange={event => setName(event.target.value)} required maxLength={128} placeholder={nameHint} disabled={locked}/>}</FormField>
      <fieldset className="m-0 flex min-w-0 flex-col gap-2.5 border-t border-dashed border-line-strong pt-4">
        <legend className="mb-1 text-caption text-ink-2">이 기기가 대화할 수 있는 Ghost</legend>
        {ghosts.map(ghost => <label key={ghost.id} className="flex items-center gap-2.5 text-caption text-ink">
          <Checkbox aria-label={`${ghost.name} 권한`} checked={grants.some(grant => grant.ghostId === ghost.id)} disabled={locked} onCheckedChange={checked => toggle(ghost.id, checked === true)}/>
          {ghost.name}
        </label>)}
        {!ghosts.length && <p className="m-0 text-caption text-ink-3">아직 Ghost가 없습니다. Ghost를 만든 뒤 권한을 고를 수 있습니다.</p>}
        <p className="m-0 text-caption text-ink-3">선택한 Ghost의 모든 대화에 접근할 수 있습니다.</p>
      </fieldset>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={locked} onClick={onClose}>취소</Button>
        <Button type="submit" disabled={locked || !name.trim()}>{saving ? '저장 중…' : '저장'}</Button>
      </div>
    </form>
  </Modal>;
}
