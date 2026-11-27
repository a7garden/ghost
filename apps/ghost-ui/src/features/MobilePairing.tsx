import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { toDataURL } from 'qrcode';
import { Pencil, QrCode, Smartphone, Trash2 } from 'lucide-react';
import { Button, InlineError, Input, SkeletonRows } from '../ui';
import type { Device } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Modal } from '../components/Modal';
import { ThisDevice } from './ThisDevice';
import './SettingsLists.css';

/** The payload the iPhone's camera scans: `ghost://pair?origin=…&code=…`. Pure; exported for tests. */
export function pairingUrl(offer: { code: string; origin: string }): string {
  return `ghost://pair?origin=${encodeURIComponent(offer.origin)}&code=${encodeURIComponent(offer.code)}`;
}

const seen = (ms: number) => new Date(ms).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 기기 페어링과 등록된 기기 관리. device.pairing_start · device.update · device.revoke로 저장한다. */
export function MobilePairing() {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const devices = state?.devices ?? [];
  const [offer, setOffer] = useState<{ code: string; expiresAt: number; origin: string }>();
  const [renameTarget, setRenameTarget] = useState<string>();
  const editingId = renameTarget && devices.some(device => device.id === renameTarget) ? renameTarget : undefined;
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
  // The offer closes itself once the phone it was for appears in the device list.
  const [knownAtOffer, setKnownAtOffer] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!offer) return;
    const joined = devices.find(device => !knownAtOffer.has(device.id));
    if (!joined) return;
    setOffer(undefined);
    setNotice(`${joined.name} 연결됨`);
  }, [offer, devices, knownAtOffer]);
  const run = async (work: () => Promise<unknown>, done: string) => {
    setPending('save'); setError(''); setNotice('');
    try { await work(); setNotice(done); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.'); return false; }
    finally { setPending(''); }
  };
  const startPairing = () => run(async () => {
    setKnownAtOffer(new Set(devices.map(device => device.id)));
    setOffer(await client.send<{ code: string; expiresAt: number; origin: string }>({ type: 'device.pairing_start' }));
  }, '');
  if (state?.principal.kind === 'device') {
    const deviceId = state.principal.deviceId;
    const current = devices.find(device => device.id === deviceId);
    return current ? <ThisDevice key={current.id} device={current} ghosts={state.ghosts}/> : <InlineError>이 기기의 연결 정보를 찾을 수 없습니다.</InlineError>;
  }
  return <section className="settings-list-page" aria-label="기기">
    <div className="settings-list__lead">
      {state && <p className="settings-list__verdict">{devices.length ? `페어링된 기기 ${devices.length}` : '페어링된 기기 없음'}</p>}
      <div className="settings-list__actions">
        <Button type="button" disabled={!state || pending !== ''} onClick={() => void startPairing()}><QrCode size={15}/>기기 연결</Button>
      </div>
    </div>
    {offer && <section className="grid justify-items-center gap-3 border-y border-line px-3 py-4" aria-label="페어링 코드">
      <div className="flex items-center gap-2 text-ui font-semibold text-ink"><Smartphone size={17} aria-hidden="true"/>iPhone에서 QR 코드를 스캔해 주세요</div>
      {qr && !expired ? <img src={qr} alt={`페어링 코드 ${offer.code}`} width={240} height={240} className="rounded-lg bg-canvas p-2"/> : null}
      {expired
        ? <p className="m-0 text-caption text-ink-2" role="status">코드가 만료됐습니다. 페어링을 다시 시작해 주세요.</p>
        : <p className="m-0 text-caption text-ink-2">코드 <strong className="font-mono">{offer.code}</strong> · 만료 {seen(offer.expiresAt)}</p>}
      <div className="flex gap-2">
        {expired && <Button variant="outline" type="button" disabled={pending !== ''} onClick={() => void startPairing()}>다시 시작</Button>}
        <Button variant="ghost" type="button" onClick={() => setOffer(undefined)}>닫기</Button>
      </div>
    </section>}
    {devices.length > 0 && <section aria-label="등록된 기기">
      <ul className="settings-list" role="list">{devices.map(device =>
        <li key={device.id} data-selected={editingId === device.id || undefined}>
          <PairedDeviceRow device={device} editing={editingId === device.id}
            busy={pending !== '' || !!revoking || (!!editingId && editingId !== device.id)}
            onEdit={() => { setNotice(''); setRenameTarget(device.id); }}
            onClose={() => setRenameTarget(undefined)}
            onSave={async name => {
              await client.send({ type: 'device.update', deviceId: device.id, name });
              setNotice('기기를 저장했습니다.');
            }}
            onRevoke={() => { setError(''); setRevoking(device); }}/>
        </li>)}</ul>
    </section>}
    {!state && <SkeletonRows label="기기를 불러오는 중…" rows={2}/>}
    {error && !revoking && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}
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

function PairedDeviceRow({ device, editing, busy, onEdit, onClose, onSave, onRevoke }: {
  device: Device;
  editing: boolean;
  busy: boolean;
  onEdit(): void;
  onClose(): void;
  onSave(name: string): Promise<void>;
  onRevoke(): void;
}) {
  const formId = useId();
  const pencil = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [name, setName] = useState(device.name);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const locked = busy || saving;
  useLayoutEffect(() => {
    if (!editing && restoreFocus.current) {
      pencil.current?.focus();
      restoreFocus.current = false;
    }
  }, [editing]);
  const close = () => {
    restoreFocus.current = true;
    onClose();
  };
  const save = async () => {
    if (locked) return;
    const next = name.trim();
    if (!next) { setError('기기 이름을 입력해 주세요.'); return; }
    if (next === device.name) { close(); return; }
    setSaving(true); setError('');
    try { await onSave(next); close(); }
    catch { setError('기기 이름을 저장하지 못했습니다.'); }
    finally { setSaving(false); }
  };
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && !locked) {
      event.preventDefault(); event.stopPropagation(); close();
    }
  };
  return <div className={`settings-list__row${editing ? ' settings-list__row--actions-wrap' : ''}`}>
    <span className="settings-list__mark"><Smartphone size={17} aria-hidden="true"/></span>
    <div className="settings-list__copy">
      {editing ? <form id={formId} className="grid min-w-0 gap-2" aria-label="기기 이름 변경" aria-busy={saving}
        onSubmit={event => { event.preventDefault(); void save(); }} onKeyDown={keys}>
        <Input aria-label="기기 이름" aria-required aria-describedby={error ? `${formId}-error` : undefined}
          className="min-h-11 text-base sm:min-h-8 sm:text-ui" type="text" value={name} autoFocus
          onChange={event => { setName(event.target.value); if (error) setError(''); }} maxLength={128} readOnly={locked}/>
        {error && <InlineError id={`${formId}-error`}>{error}</InlineError>}
      </form> : <span className="settings-list__title">{device.name}</span>}
      <span className="settings-list__meta">
        페어링됨{device.pushEnabled && ' · 알림 켬'}
        {device.lastSeenAt && <> · 마지막 연결 <time dateTime={new Date(device.lastSeenAt).toISOString()}>{seen(device.lastSeenAt)}</time></>}
      </span>
    </div>
    {editing ? <div className="settings-list__actions" onKeyDown={keys}>
      <Button variant="ghost" type="button" disabled={locked} onClick={close}>취소</Button>
      <Button type="submit" form={formId} disabled={locked}>{saving ? '저장 중…' : '저장'}</Button>
    </div> : <div className="settings-list__actions">
      <Button ref={pencil} variant="ghost" size="icon" type="button" aria-label={`${device.name} 이름 변경`} disabled={busy}
        onClick={() => { setName(device.name); setError(''); onEdit(); }}><Pencil size={15}/></Button>
      <Button variant="ghost" size="icon" type="button" aria-label={`${device.name} 연결 해제`} disabled={busy} onClick={onRevoke}><Trash2 size={15}/></Button>
    </div>}
  </div>;
}
