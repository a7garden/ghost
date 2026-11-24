import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, Sparkles } from 'lucide-react';
import type { Command, MailDiscovery } from '@ghost/contract';
import { useHost } from '../host/context';
import { Modal } from '../components/Modal';
import { Button, FormField, InlineError, Input, Switch } from '../ui';
import { ExternalAnchor } from '../components/ExternalAnchor';
import { buildConnectionCommand, draftFromMailDiscovery, mailAddressFromParts, mailAddressReady, sameMailAddress, type ConnectionDraft } from './connection-config';
import { serviceById, type ConnectionService } from './connection-services';
// Deliberate cycle with Connections.tsx: both modules only call each other's exports at render
// time, so the shared ServiceIcon can stay beside the catalog that owns it.
import { ServiceIcon } from './Connections';
import { ConnectionOAuthPanel } from './ConnectionOAuthPanel';
import './ConnectionSetup.css';

/**
 * Address-first mail connection. The Host resolves the provider and both servers; the
 * owner types the address and one secret. Servers sit under a closed disclosure that
 * opens by itself only when discovery could not find them.
 */
export function MailConnect({ seed, initialAddress = '', canAssist, onAssist, onClose, onSave }: {
  seed?: ConnectionService; initialAddress?: string; canAssist: boolean;
  onAssist(service: ConnectionService, detail: string): Promise<void>;
  onClose(): void; onSave(command: Command, requestId: string): Promise<void>;
}) {
  const { client } = useHost();
  const [address, setAddress] = useState(initialAddress);
  const [discovery, setDiscovery] = useState<MailDiscovery | null>(null);
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [serverOpen, setServerOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [discoveryError, setDiscoveryError] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const requestSeq = useRef(0);
  const saveRequest = useRef<string | undefined>(undefined);
  const completed = mailAddressFromParts(address, seed);
  const ready = mailAddressReady(completed);
  const resolved = discovery !== null && draft !== null && sameMailAddress(draft.username, completed);
  const providerService = discovery?.provider ? serviceById(discovery.provider.id) : undefined;
  const oauth = discovery?.auth === 'oauth';
  const oauthService = oauth ? providerService ?? serviceById('outlook')! : undefined;
  const secretLabel = discovery?.auth === 'password' ? '비밀번호' : '앱 비밀번호';
  const mailService = seed ?? serviceById('custom-mail')!;
  const discover = useCallback((target: string) => {
    const seq = ++requestSeq.current;
    setPending(true); setDiscoveryError('');
    void client.mailDiscovery(target).then(result => {
      // A newer keystroke won the race, or the Host answered a different address.
      if (seq !== requestSeq.current || !sameMailAddress(result.email, target)) return;
      setDiscovery(result);
      // Fixing a typo in the address must not cost the owner the secret already typed.
      setDraft(prev => ({ ...draftFromMailDiscovery(target, result), credential: prev?.credential ?? '' }));
      setServerOpen(result.imap === null);
    }).catch(() => {
      if (seq !== requestSeq.current) return;
      setDiscovery(null); setDraft(null);
      setDiscoveryError('메일 서버 정보를 찾지 못했습니다. 주소를 확인하고 다시 시도해 주세요.');
    }).finally(() => {
      if (seq === requestSeq.current) setPending(false);
    });
  }, [client]);

  useEffect(() => {
    const target = mailAddressFromParts(address, seed);
    if (!mailAddressReady(target)) {
      requestSeq.current++; // whatever is still in flight belongs to a discarded address
      setDiscovery(null); setDraft(null); setPending(false);
      return;
    }
    const timer = setTimeout(() => discover(target), 400);
    return () => clearTimeout(timer);
  }, [address, seed, discover]);

  const set = (patch: Partial<ConnectionDraft>) => {
    saveRequest.current = undefined;
    setDraft(prev => prev ? { ...prev, ...patch } : prev);
  };
  const save = async () => {
    if (saving || !draft) return;
    const full = mailAddressFromParts(address, seed);
    const built = buildConnectionCommand({ ...draft, username: full }, null);
    if (!built.ok) {
      setError(built.error);
      if (!draft.host.trim()) setServerOpen(true);
      return;
    }
    if (!draft.credential.trim()) { setError(`${secretLabel}를 입력해 주세요.`); return; }
    setSaving(true); setError('');
    try { await onSave(built.command, saveRequest.current ??= crypto.randomUUID()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '연결을 저장하지 못했습니다.'); setSaving(false); }
  };
  const addressKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (resolved && !pending) event.currentTarget.form?.requestSubmit();
    else if (ready) discover(completed);
  };

  return <Modal title="이메일 연결" onClose={() => { if (!saving) onClose(); }} className="sm:max-w-[560px]">
    {/* The address field holds only the local part when a provider tile seeds the domain; save() validates the full address itself. */}
    <form noValidate className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <FormField label="이메일 주소" required>
        {control => <Input {...control} type="email" inputMode="email" autoComplete="username" placeholder={seed?.domain ? `이름@${seed.domain}` : 'name@example.com'}
          value={address} maxLength={320} required disabled={saving}
          onChange={event => { setAddress(event.target.value); saveRequest.current = undefined; }}
          onKeyDown={addressKeyDown}
          onBlur={() => { if (ready && !resolved) discover(completed); }}/>}
      </FormField>
      {pending && <p className="m-0 text-caption text-ink-3" role="status">서버 정보를 찾는 중…</p>}
      {discoveryError && !pending && <>
        <InlineError>{discoveryError}</InlineError>
        <div><Button type="button" variant="outline" disabled={saving || !ready} onClick={() => discover(completed)}>다시 찾기</Button></div>
      </>}
      {discovery && !pending && <>
        <div className="mail-provider">
          <ServiceIcon service={providerService}/>
          <div className="mail-provider__identity">
            <p className="text-ui font-medium">{discovery.provider?.name ?? discovery.domain}</p>
            {address.trim() !== completed && <p>{completed}</p>}
          </div>
          {discovery.setupUrl && <ExternalAnchor href={discovery.setupUrl} target="_blank" rel="noopener noreferrer" className="text-caption text-ink-2 underline underline-offset-4">{discovery.auth === 'password' ? '인증 설정 열기' : '앱 비밀번호 발급'}<ArrowUpRight className="ml-1 inline" size={12}/></ExternalAnchor>}
        </div>
        {discovery.note && <p className="m-0 text-caption text-ink-2">{discovery.note}</p>}
      </>}
      {!canAssist || discovery ? null : <Button type="button" variant="outline" disabled={saving || pending} onClick={async () => {
        setSaving(true); setError('');
        try { await onAssist(mailService, completed); }
        catch (reason) { setError(reason instanceof Error ? reason.message : '연결 요청을 보내지 못했습니다.'); setSaving(false); }
      }}><Sparkles size={15}/>Ghost에게 연결 맡기기</Button>}
      {oauth ? oauthService && <ConnectionOAuthPanel service={oauthService} ghosts={[]} defaultUsername={completed} onConnected={onClose}/> : <>
        <FormField label={secretLabel} description="인증 정보는 Host에만 저장되며 대화에 전달되지 않습니다.">
          {control => <Input {...control} type="password" value={draft?.credential ?? ''} autoComplete="new-password" disabled={saving || !draft} onChange={event => set({ credential: event.target.value })}/>}
        </FormField>
        <button type="button" className="connection-advanced" aria-expanded={serverOpen} disabled={saving || !draft} onClick={() => setServerOpen(!serverOpen)}>서버 설정<span aria-hidden="true" className="fold-mark"/></button>
        {serverOpen && draft && <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_100px]">
            <FormField label="IMAP 서버" required>{control => <Input {...control} value={draft.host} required disabled={saving} onChange={event => set({ host: event.target.value })}/>}</FormField>
            <FormField label="IMAP 포트">{control => <Input {...control} type="number" min={1} max={65535} value={draft.port} disabled={saving} onChange={event => set({ port: event.target.value })}/>}</FormField>
          </div>
          <FormField label="메일함">{control => <Input {...control} value={draft.mailbox} disabled={saving} onChange={event => set({ mailbox: event.target.value })}/>}</FormField>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_100px]">
            <FormField label="SMTP 서버">{control => <Input {...control} value={draft.smtpHost} disabled={saving} onChange={event => set({ smtpHost: event.target.value })}/>}</FormField>
            <FormField label="SMTP 포트">{control => <Input {...control} type="number" min={1} max={65535} value={draft.smtpPort} disabled={saving} onChange={event => set({ smtpPort: event.target.value })}/>}</FormField>
          </div>
          <label className="activity-check"><span className="activity-check__copy"><span>SMTP 암시적 TLS</span><small>끄면 STARTTLS로 연결합니다. 두 방식 모두 인증서를 확인합니다.</small></span><Switch aria-label="SMTP 암시적 TLS" checked={draft.smtpSecure} disabled={saving} onCheckedChange={smtpSecure => set({ smtpSecure })}/></label>
        </div>}
      </>}
      {error && <InlineError>{error}</InlineError>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={saving} onClick={onClose}>취소</Button>
        {!oauth && <Button type="submit" disabled={saving || pending || !resolved}>{saving ? '처리 중…' : '연결'}</Button>}
      </div>
    </form>
  </Modal>;
}
