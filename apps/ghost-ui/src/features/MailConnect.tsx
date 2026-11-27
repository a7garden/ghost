import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, Mail } from 'lucide-react';
import type { Command, MailDiscovery } from '@ghost/contract';
import { useHost } from '../host/context';
import { Button, FormField, InlineError, Input, SegmentedControl, Switch } from '../ui';
import { ExternalAnchor } from '../components/ExternalAnchor';
import { buildConnectionCommand, draftFromMailDiscovery, mailAddressFromParts, mailAddressReady, sameMailAddress, type ConnectionDraft } from './connection-config';
import { serviceById, type ConnectionService } from './connection-services';
// Deliberate cycle with Connections.tsx: both modules only call each other's exports at render
// time, so the shared ServiceIcon can stay beside the catalog that owns it.
import { ServiceIcon } from './Connections';
import { ConnectionOAuthPanel } from './ConnectionOAuthPanel';
import { ConnectionRequest } from './ConnectionRequest';
import './ConnectionSetup.css';

/**
 * Address-first mail connection. The Host resolves the provider and both servers; the
 * owner types the address and one secret. Servers sit under a closed disclosure that
 * opens by itself only when discovery could not find them.
 */
export function MailConnect({ seed, disabled, mainName, onAssist, onClose, onSave, onConnected, onSetupLockChange }: {
  seed?: ConnectionService; disabled?: boolean; mainName?: string;
  onAssist(service: ConnectionService, detail: string): Promise<void>;
  onClose?(): void; onSave(command: Command, requestId: string): Promise<void>; onConnected(id: string): void;
  onSetupLockChange?(locked: boolean): void;
}) {
  const { client } = useHost();
  const [address, setAddress] = useState('');
  const [discovery, setDiscovery] = useState<MailDiscovery | null>(null);
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [serverOpen, setServerOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [discoveryError, setDiscoveryError] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [method, setMethod] = useState<'direct' | 'ghost'>('direct');
  const [oauthLocked, setOAuthLocked] = useState(false);
  const [sending, setSending] = useState(false);
  const addressField = useRef<HTMLInputElement>(null);
  const secretField = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);
  const checking = useRef('');
  const saveRequest = useRef<string | undefined>(undefined);
  const completed = mailAddressFromParts(address, seed);
  const ready = mailAddressReady(completed);
  const resolved = discovery !== null && draft !== null && sameMailAddress(draft.username, completed);
  const found = resolved ? discovery : null;
  const providerService = found?.provider ? serviceById(found.provider.id) : undefined;
  const oauthService = found?.auth === 'oauth' ? providerService ?? serviceById('outlook')! : undefined;
  const secretLabel = discovery?.auth === 'password' ? '비밀번호' : '앱 비밀번호';
  const mailService = seed ?? serviceById('custom-mail')!;
  const locked = saving || oauthLocked || sending;
  const expanded = Boolean(seed || address);
  const telling = method === 'ghost' && !!mainName;
  useEffect(() => { onSetupLockChange?.(locked); }, [locked, onSetupLockChange]);
  const discover = useCallback((target: string) => {
    if (checking.current === target) return;
    checking.current = target;
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
      setDiscovery(null);
      setDiscoveryError('메일 서버 정보를 찾지 못했습니다. 주소를 확인하고 다시 시도해 주세요.');
    }).finally(() => {
      if (seq === requestSeq.current) { checking.current = ''; setPending(false); }
    });
  }, [client]);

  useEffect(() => {
    if (telling || !ready || resolved) return;
    const timer = setTimeout(() => discover(completed), 400);
    return () => clearTimeout(timer);
  }, [completed, discover, ready, resolved, telling]);

  const changeAddress = (next: string) => {
    if (!sameMailAddress(mailAddressFromParts(next, seed), completed)) {
      requestSeq.current++;
      checking.current = '';
      setPending(false); setDiscoveryError(''); setError('');
      saveRequest.current = undefined;
    }
    setAddress(next);
  };
  const close = () => {
    if (onClose) { onClose(); return; }
    changeAddress(''); setDiscovery(null); setDraft(null); setMethod('direct');
    addressField.current?.focus();
  };

  const set = (patch: Partial<ConnectionDraft>) => {
    saveRequest.current = undefined;
    setDraft(prev => prev ? { ...prev, ...patch } : prev);
  };
  const save = async () => {
    if (saving || !draft || !resolved || pending || telling || oauthService) return;
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
    catch (reason) { setError(reason instanceof Error ? `연결을 저장하지 못했습니다. ${reason.message}` : '연결을 저장하지 못했습니다.'); setSaving(false); }
  };
  const addressKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || telling) return;
    event.preventDefault();
    if (resolved && !pending) secretField.current?.focus();
    else if (ready) discover(completed);
    else setError('이메일 주소를 확인해 주세요.');
  };

  return <section className={seed ? 'setup-route service-setup' : 'mail-entry'} aria-label={seed ? '이메일 연결' : '이메일 주소로 연결'}
    onKeyDown={event => { if (expanded && event.key === 'Escape' && !event.nativeEvent.isComposing && !locked) close(); }}>
    {!seed && <span className="service-icon mail-entry__icon" aria-hidden="true"><Mail size={21}/></span>}
    <div className="mail-entry__content">
      <FormField label={seed ? '이메일 주소' : '이메일 주소로 연결'} required>
        {control => <Input {...control} ref={addressField} autoFocus={Boolean(seed)} type={seed?.domain ? 'text' : 'email'} inputMode="email" autoComplete="username" spellCheck={false}
          placeholder={seed?.domain ? `이름@${seed.domain}` : 'name@example.com'} value={address} maxLength={320}
          disabled={locked || disabled || telling} onChange={event => changeAddress(event.target.value)} onKeyDown={addressKeyDown}/>}
      </FormField>
      {expanded && mainName && <SegmentedControl aria-label="연결 방법" value={method} onValueChange={setMethod} options={[
        { value: 'direct', label: '직접 연결', disabled: locked },
        { value: 'ghost', label: `${mainName}에게 말하기`, disabled: locked },
      ]}/>}
      {telling && mainName ? <ConnectionRequest service={providerService ?? mailService} mainName={mainName} initialDetail={completed}
        onAssist={onAssist} onClose={close} onSendingChange={setSending}/>
      : expanded && <form noValidate className="setup-route__body" aria-busy={saving} onSubmit={event => { event.preventDefault(); void save(); }}>
        {pending && <p className="settings-list__meta" role="status">메일 서버 확인 중…</p>}
        {discoveryError && !pending && <InlineError onRetry={() => discover(completed)} retryLabel="다시 찾기">{discoveryError}</InlineError>}
        {found && !pending && <>
          <div className="mail-provider">
            {!seed && <ServiceIcon service={providerService}/>}
            <div className="mail-provider__identity settings-list__copy">
              <p className="settings-list__title">{found.provider?.name ?? found.domain}</p>
              {address.trim() !== completed && <p className="settings-list__meta">{completed}</p>}
            </div>
            {oauthService && found.setupUrl && <ExternalAnchor href={found.setupUrl} target="_blank" rel="noopener noreferrer" className="setup-route__link">인증 설정 열기<ArrowUpRight size={12} aria-hidden="true"/></ExternalAnchor>}
          </div>
          {oauthService
            ? <ConnectionOAuthPanel key={completed} service={oauthService} ghosts={[]} defaultUsername={completed} onConnected={onConnected} onLockChange={setOAuthLocked}/>
            : <div className="setup-route__credential">
              <FormField label={secretLabel} description={found.note ?? undefined}>
                {control => <Input {...control} ref={secretField} type="password" value={draft?.credential ?? ''} autoComplete="new-password" disabled={saving} onChange={event => set({ credential: event.target.value })}/>}
              </FormField>
              {found.setupUrl && <ExternalAnchor href={found.setupUrl} target="_blank" rel="noopener noreferrer" className="setup-route__link">{found.auth === 'password' ? '인증 설정 열기' : '앱 비밀번호 발급'}<ArrowUpRight size={12} aria-hidden="true"/></ExternalAnchor>}
            </div>}
        </>}
        {found && !oauthService && <button type="button" className="connection-advanced" aria-expanded={serverOpen} disabled={saving} onClick={() => setServerOpen(!serverOpen)}>서버 설정<span aria-hidden="true" className="fold-mark"/></button>}
        {found && !oauthService && serverOpen && draft && <div className="flex flex-col gap-4">
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
        {error && <InlineError>{error}</InlineError>}
        <div className="setup-route__actions">
          <Button variant="ghost" type="button" disabled={locked} onClick={close}>취소</Button>
          {found && !oauthService && <Button type="submit" disabled={saving || pending}>{saving ? '저장 중…' : '연결하고 확인'}</Button>}
        </div>
      </form>}
    </div>
  </section>;
}
