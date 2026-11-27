import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Check, CircleAlert, Globe2, Mail, Pencil, PlugZap, Search, Trash2, X } from 'lucide-react';
import { Button, Checkbox, FormField, InlineError, Input, SegmentedControl, Switch, Textarea } from '../ui';
import type { Command, Connection, Ghost, LocalAccount } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Modal } from '../components/Modal';
import { uiTerms } from '../uiText';
import { buildConnectionCommand, type ConnectionDraft, connectionSummary, draftForService, draftFromConnection } from './connection-config';
import { cleanSecret, connectionServices, connectionSetupPrompt, localScopeSummary, secretHint, serviceById, serviceForConnection, type ConnectionService } from './connection-services';
import { ExternalAnchor } from '../components/ExternalAnchor';
import { ConnectionOAuthPanel, supportsConnectionOAuth } from './ConnectionOAuthPanel';
import { ConnectionRequest } from './ConnectionRequest';
import { ReadPaths } from './ReadPaths';
import { MailConnect } from './MailConnect';
import './ConnectionSetup.css';
import './SettingsLists.css';

type TestState = { phase: 'testing'; wasError: boolean } | { phase: 'ok' } | { phase: 'error'; message: string };

export function ServiceIcon({ service, iconUrl }: { service?: ConnectionService; iconUrl?: string }) {
  const { client } = useHost();
  const [localIcon, setLocalIcon] = useState<{ path: string; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    const digest = /^\/api\/artifacts\/([a-f0-9]{64})$/.exec(iconUrl ?? '')?.[1];
    if (!digest) return;
    let disposed = false;
    let objectUrl: string | undefined;
    void client.artifactUrl(digest).then(url => {
      objectUrl = url;
      if (disposed) URL.revokeObjectURL(url);
      else setLocalIcon({ path: iconUrl!, url });
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, iconUrl]);
  const source = iconUrl?.startsWith('/api/artifacts/')
    ? localIcon?.path === iconUrl ? localIcon.url : undefined
    : iconUrl || (service?.icon ? `/service-icons/${service.icon}.svg` : undefined);
  return <span className="service-icon" aria-hidden="true">
    {source && !failed ? <img src={source} alt="" data-catalog={!iconUrl || undefined} referrerPolicy="no-referrer" onError={() => setFailed(true)}/>
      : service?.kind === 'mail' ? <Mail size={24}/> : <Globe2 size={24}/>}
  </span>;
}

export function Connections({ navigate }: { navigate(path: string): void }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [pending, setPending] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<ConnectionService | null>(null);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [removing, setRemoving] = useState<Connection | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [query, setQuery] = useState('');
  const [catalogOpen, setCatalogOpen] = useState(false);
  const catalogId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const [localAccounts, setLocalAccounts] = useState<LocalAccount[] | null>(null);
  const [linked, setLinked] = useState<Record<string, string>>({});
  const connections = state?.connections ?? [];
  const accounts = connections.map(connection => {
    const status = tests[connection.id];
    const rank = status?.phase === 'error' || (status?.phase === 'testing' && status.wasError) ? 0 : connection.hasCredential ? 2 : 1;
    const service = serviceForConnection(connection) ?? serviceById(connection.config.kind === 'mail' ? 'custom-mail' : 'custom-api')!;
    return { connection, status, rank, service };
  }).sort((a, b) => a.rank - b.rank || a.connection.createdAt - b.connection.createdAt);
  const attention = accounts.filter(account => account.rank < 2).length;
  const setupRequest = useRef<{ text: string; id: string } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [tileLocked, setTileLocked] = useState(false);
  const accountRows = useRef(new Map<string, HTMLLIElement>());
  const [revealedAccount, setRevealedAccount] = useState('');
  const [addressDraft, resetAddressDraft] = useState(0);
  const search = query.trim().toLowerCase();
  const available = connectionServices.filter(service => `${service.name} ${service.id}`.toLowerCase().includes(search) || selected?.id === service.id);
  const localOffers = localAccounts?.filter(account => {
    const id = account.connectionId ?? linked[account.login];
    return !id || !connections.some(connection => connection.id === id);
  }) ?? [];
  const main = state?.ghosts.find(ghost => ghost.isDefault && ghost.state === 'active');

  // Local sign-ins are an extra: a Host without the route or a Mac without them stays silent.
  useEffect(() => {
    let disposed = false;
    void client.localAccounts().then(({ accounts }) => { if (!disposed) setLocalAccounts(accounts); }).catch(() => {});
    return () => { disposed = true; };
  }, [client]);

  useEffect(() => {
    const row = accountRows.current.get(revealedAccount);
    if (!row) return;
    row.focus();
    setRevealedAccount('');
  }, [revealedAccount, state?.connections]);

  const close = () => {
    setSelected(null); setEditing(null);
    requestAnimationFrame(() => returnFocus.current?.focus());
  };
  const open = (trigger: HTMLElement, service: ConnectionService | null, account: Connection | null = null) => {
    returnFocus.current = trigger;
    setError(''); setSelected(service); setEditing(account);
    if (account) { setCatalogOpen(false); setQuery(''); }
  };

  const test = async (id: string) => {
    setTests(prev => ({ ...prev, [id]: { phase: 'testing', wasError: prev[id]?.phase === 'error' } }));
    try {
      await client.send({ type: 'connection.test', connectionId: id });
      setTests(prev => ({ ...prev, [id]: { phase: 'ok' } }));
    } catch (reason) {
      setTests(prev => ({ ...prev, [id]: { phase: 'error', message: reason instanceof Error ? `인증을 확인하지 못했습니다. ${reason.message}` : '인증을 확인하지 못했습니다.' } }));
    }
  };
  const connected = (id: string, fromAddress = false) => {
    if (fromAddress) resetAddressDraft(value => value + 1);
    else { setSelected(null); setEditing(null); setTileLocked(false); }
    setNotice('');
    setQuery('');
    setCatalogOpen(false);
    setRevealedAccount(id);
    void test(id);
  };
  const save = async (command: Command, requestId: string, fromAddress = false) => {
    const result = await client.send<{ connectionId: string }>(command, requestId);
    connected(result.connectionId, fromAddress);
  };
  const assist = async (service: ConnectionService, detail: string) => {
    if (!main) throw new Error('먼저 활성 메인 Ghost를 설정해 주세요.');
    // A failed admission retains this request identity so retry cannot send the setup twice.
    const text = connectionSetupPrompt(service, detail);
    if (setupRequest.current?.text !== text) setupRequest.current = { text, id: crypto.randomUUID() };
    await client.send({ type: 'message.send', conversationId: main.directConversationId, text }, setupRequest.current.id);
    navigate(`/ghosts/${main.id}`);
  };
  const connectLocal = async (account: LocalAccount) => {
    setPending(`local:${account.login}`); setError('');
    try {
      const { connectionId } = await client.connectLocalAccount({ source: account.source, login: account.login });
      setLinked(prev => ({ ...prev, [account.login]: connectionId }));
      await test(connectionId);
      setRevealedAccount(connectionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '이 Mac의 계정을 연결하지 못했습니다.');
    } finally { setPending(''); }
  };

  return <section className="settings-list-page" aria-label={uiTerms.connections}>
    <div className="settings-list__lead">
      {state && <p className="settings-list__verdict">
        {accounts.length ? <>연결 계정 {accounts.length}{attention > 0 && <span className="settings-list__state" data-tone="amber"> · 확인 필요 {attention}</span>}</> : '등록된 연결 계정 없음'}
      </p>}
      <div className="connection-search settings-list__actions">
        <Search size={15} aria-hidden="true"/>
        <Input ref={searchInput} aria-label="서비스 추가" placeholder="서비스 추가" aria-controls={catalogId}
          value={query} onFocus={() => { if (!catalogOpen) setCatalogOpen(true); }} onClick={() => setCatalogOpen(true)}
          onChange={event => { setQuery(event.target.value); setCatalogOpen(true); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter' || event.key === 'ArrowDown') setCatalogOpen(true);
            if (event.key === 'Escape' && !tileLocked && !selected) { setCatalogOpen(false); setQuery(''); }
          }}/>
        {catalogOpen && <Button variant="ghost" size="icon" type="button" aria-label="서비스 추가 닫기" disabled={tileLocked} onClick={() => {
          setSelected(null); setCatalogOpen(false); setQuery(''); searchInput.current?.focus();
        }}><X size={16}/></Button>}
      </div>
    </div>
    {error && !removing && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 text-caption text-ink-2" role="status">{notice}</p>}
    <section id={catalogId} className="connection-catalog" aria-label="서비스 연결" hidden={!catalogOpen}>
      {(['서비스', '메일', '직접 연결'] as const).map(group => {
        const services = available.filter(service => service.group === group);
        return services.length > 0 && <div key={group} className="connection-catalog__group">
          {group !== '서비스' && <h3 className="settings-list__label">{group}</h3>}
          <ul className="settings-list" role="list">
            {services.map(service => {
              const adding = selected?.id === service.id;
              const addLabel = accounts.some(account => account.service.id === service.id) ? '계정 추가' : '연결';
              return <li key={service.id} data-selected={adding || undefined}>
                <div className="settings-list__row">
                  <span className="settings-list__mark"><ServiceIcon service={service}/></span>
                  <span className="settings-list__title">{service.name}</span>
                  <div className="settings-list__actions">
                    <Button variant="add" size="sm" type="button" disabled={!state || tileLocked}
                      aria-label={`${service.name} ${addLabel}`} aria-expanded={adding}
                      onClick={event => adding ? close() : open(event.currentTarget, service)}>{addLabel}</Button>
                  </div>
                </div>
                {adding && (service.kind === 'mail'
                  ? <MailConnect seed={service} mainName={main?.name} onAssist={assist} onClose={close} onSave={save} onConnected={connected} onSetupLockChange={setTileLocked}/>
                  : <ConnectionSetup service={service} ghosts={state?.ghosts.filter(ghost => ghost.state === 'active') ?? []}
                      mainName={main?.name} onAssist={assist} onClose={close} onSave={save} onConnected={connected} onSetupLockChange={setTileLocked}/>)}
              </li>;
            })}
          </ul>
        </div>;
      })}
      {available.length === 0 && <div className="settings-list__empty">
        <p>일치하는 서비스가 없습니다.</p>
        <Button variant="outline" disabled={!state} onClick={() => {
          setQuery(''); open(searchInput.current!, serviceById('custom-api')!);
        }}>다른 서비스 연결</Button>
      </div>}
    </section>
    {accounts.length > 0 && <ul className="settings-list settings-list--sections" aria-label="연결 계정" role="list">
      {accounts.map(({ connection, status, service }, index) => {
        const needsAttention = index < attention;
        const tone = status?.phase === 'error' ? 'danger' : needsAttention ? 'amber' : status?.phase === 'ok' ? 'success' : undefined;
        const isEditing = editing?.id === connection.id;
        const summary = connectionSummary(connection);
        return <Fragment key={connection.id}>
          {(index === 0 || index === attention) && <li className="settings-list__label" role="presentation"><h3>
            {needsAttention ? '확인 필요' : '연결됨'}
          </h3></li>}
          <li className="connection-account" tabIndex={-1} data-tone={tone} data-selected={isEditing || undefined} ref={row => {
            if (row) accountRows.current.set(connection.id, row);
            else accountRows.current.delete(connection.id);
          }}>
            <div className="settings-list__row">
              <span className="settings-list__mark"><ServiceIcon service={service} iconUrl={connection.iconUrl}/></span>
              <div className="settings-list__copy">
                <h3 className="settings-list__title">{connection.name}</h3>
                <div className="settings-list__meta">
                  <span className="connection-tile__status settings-list__state" data-phase={status?.phase} role="status">
                    {needsAttention && <CircleAlert size={14} aria-hidden="true"/>}
                    {status?.phase === 'ok' && <Check size={14} aria-hidden="true"/>}
                    {status?.phase === 'testing' ? '인증 확인 중…' : status?.phase === 'ok' ? '인증 확인됨'
                      : status?.phase === 'error' ? status.message : connection.hasCredential ? '인증 정보 저장됨' : '인증 필요'}
                  </span>
                  {!connection.name.includes(summary) && <> · {summary}</>}
                </div>
              </div>
              <div className="settings-list__actions">
                <Button variant="ghost" size="sm" type="button" disabled={status?.phase === 'testing'} aria-label={`${connection.name} 연결 테스트`} onClick={() => void test(connection.id)}><PlugZap size={14}/>확인</Button>
                <Button variant="ghost" size="icon" type="button" aria-label={`${connection.name} 편집`} aria-expanded={isEditing}
                  disabled={tileLocked} onClick={event => isEditing ? close() : open(event.currentTarget, null, connection)}><Pencil size={15}/></Button>
                <Button variant="ghost" size="icon" type="button" aria-label={`${connection.name} 삭제`} disabled={tileLocked}
                  onClick={() => { setError(''); setRemoving(connection); }}><Trash2 size={15}/></Button>
              </div>
            </div>
            {isEditing && <ConnectionSetup existing={editing} service={service} ghosts={state?.ghosts.filter(ghost => ghost.state === 'active') ?? []}
              onAssist={assist} onClose={close} onSave={save} onConnected={connected} onSetupLockChange={setTileLocked}/>}
          </li>
        </Fragment>;
      })}
    </ul>}
    <MailConnect key={addressDraft} disabled={!state} mainName={main?.name} onAssist={assist}
      onSave={(command, requestId) => save(command, requestId, true)} onConnected={id => connected(id, true)}/>
    {localOffers.length > 0 && <section className="settings-list-page" aria-label="이 Mac의 계정">
      <h3 className="settings-list__label">이 Mac의 계정</h3>
      <ul className="settings-list" role="list">
        {localOffers.map(account => {
          const connectionId = account.connectionId ?? linked[account.login];
          const status = connectionId ? tests[connectionId] : undefined;
          const scopes = localScopeSummary(account.scopes);
          return <li key={`${account.source}:${account.login}`} className="settings-list__row local-account"
            data-tone={status?.phase === 'error' ? 'danger' : status?.phase === 'ok' ? 'success' : undefined}>
            <span className="settings-list__mark"><ServiceIcon service={serviceById(account.serviceId)}/></span>
            <div className="settings-list__copy">
              <h4 className="settings-list__title">{account.login}</h4>
              <div className="settings-list__meta">
                <span className="connection-tile__status settings-list__state" data-phase={status?.phase} role="status">
                  {pending === `local:${account.login}` && !status ? '연결하는 중…' : status?.phase === 'testing' ? '인증 확인 중…'
                    : status?.phase === 'ok' ? '인증 확인됨' : status?.phase === 'error' ? status.message : connectionId ? '등록됨' : 'CLI 로그인됨'}
                </span>
                {scopes && <> · <span>{scopes}</span></>}
              </div>
            </div>
            {!connectionId && <div className="settings-list__actions"><Button variant="outline" size="sm" type="button" disabled={!state || pending !== ''}
              onClick={() => void connectLocal(account)}>이 Mac의 계정 사용</Button></div>}
          </li>;
        })}
      </ul>
      {localOffers.some(account => !(account.connectionId ?? linked[account.login])) &&
        <p className="settings-list__meta">GitHub CLI에서 로그아웃하면 연결이 끊깁니다.</p>}
    </section>}
    {removing && <Modal title="연결 삭제" onClose={() => pending === '' && setRemoving(null)}>
      <p className="m-0">{removing.name} 연결과 저장된 인증 정보를 삭제할까요? 이 연결을 쓰는 자동 활동과 API 접근도 중단됩니다.</p>
      {error && <InlineError>{error}</InlineError>}
      <div className="mt-4 flex justify-end gap-2"><Button variant="outline" disabled={pending !== ''} onClick={() => setRemoving(null)}>취소</Button>
        <Button variant="destructive" disabled={pending !== ''} onClick={async () => {
          setPending('delete'); setError('');
          try { await client.send({ type: 'connection.delete', connectionId: removing.id }); setRemoving(null); setNotice('연결을 삭제했습니다.'); }
          catch (reason) { setError(reason instanceof Error ? reason.message : '연결을 삭제하지 못했습니다.'); }
          finally { setPending(''); }
        }}>삭제</Button></div>
    </Modal>}
  </section>;
}

function ConnectionSetup({ existing = null, service, ghosts, mainName, onAssist, onClose, onSave, onConnected, onSetupLockChange }: {
  existing?: Connection | null; service: ConnectionService; ghosts: Ghost[]; mainName?: string;
  onAssist(service: ConnectionService, detail: string): Promise<void>; onClose(): void;
  onSave(command: Command, requestId: string): Promise<void>; onConnected(id: string): void; onSetupLockChange(locked: boolean): void;
}) {
  const [draft, setDraft] = useState(() => existing ? draftFromConnection(existing) : draftForService(service));
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(service.group === '직접 연결');
  const saveRequest = useRef<string | undefined>(undefined);
  const oauth = !existing && supportsConnectionOAuth(service.id);
  const [method, setMethod] = useState<'manual' | 'oauth' | 'ghost'>(oauth ? 'oauth' : 'manual');
  const [sending, setSending] = useState(false);
  const [oauthLocked, setOAuthLocked] = useState(false);
  const surface = useRef<HTMLElement>(null);
  const locked = oauthLocked || saving || sending;
  useEffect(() => { surface.current?.focus(); }, []);
  useEffect(() => { onSetupLockChange(locked); }, [locked, onSetupLockChange]);
  const set = (patch: Partial<ConnectionDraft>) => { saveRequest.current = undefined; setDraft(prev => ({ ...prev, ...patch })); };
  const mail = draft.kind === 'mail';
  const api = draft.kind === 'api';
  const name = existing ? `${existing.name} 편집` : `${service.name} 연결`;
  const save = async () => {
    if (saving) return;
    const built = buildConnectionCommand({ ...draft, credential: cleanSecret(service, draft.credential) }, existing);
    if (!built.ok) { setError(built.error); return; }
    if (!existing && !draft.credential.trim()) { setError(`${service.credentialLabel}를 입력해 주세요.`); return; }
    setSaving(true); setError('');
    try { await onSave(built.command, saveRequest.current ??= crypto.randomUUID()); }
    catch (reason) { setError(reason instanceof Error ? `연결을 저장하지 못했습니다. ${reason.message}` : '연결을 저장하지 못했습니다.'); setSaving(false); }
  };
  return <section className="setup-route service-setup" aria-label={name} ref={surface} tabIndex={-1}
    onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && !locked) onClose(); }}>
    {!existing && (oauth || mainName) && <SegmentedControl aria-label="연결 방법" value={method} onValueChange={setMethod}
      options={[
        ...(oauth ? [{ value: 'oauth' as const, label: '로그인', disabled: locked }] : []),
        { value: 'manual', label: '키로 직접 연결', disabled: locked },
        ...(mainName ? [{ value: 'ghost' as const, label: `${mainName}에게 말하기`, disabled: locked }] : []),
      ]}/>}
    {method === 'ghost' && mainName
      ? <ConnectionRequest service={service} mainName={mainName} onAssist={onAssist} onClose={onClose} onSendingChange={setSending}/>
      : method === 'oauth'
        ? <div className="setup-route__body"><ConnectionOAuthPanel service={service} ghosts={ghosts} onConnected={onConnected} onLockChange={setOAuthLocked}/>
          <div className="setup-route__actions"><Button variant="ghost" type="button" disabled={oauthLocked} onClick={onClose}>취소</Button></div>
        </div>
        : <form className="setup-route__body" aria-busy={saving} onSubmit={event => { event.preventDefault(); void save(); }}>
        {existing && <p className="activity-warn activity-warn--calm">서버·계정·접근 권한을 바꾸면 인증을 다시 입력해야 하며, 관련 활동의 진행 중인 실행이 중단됩니다.</p>}
        <div className="setup-route__pair">
          <FormField label="이름" required>{control => <Input {...control} value={draft.name} maxLength={128} required disabled={saving} onChange={event => set({ name: event.target.value })}/>}</FormField>
          {mail ? <FormField label="메일 주소" required>{control => <Input {...control} type="email" value={draft.username} maxLength={320} required disabled={saving} autoComplete="username" onChange={event => set({ username: event.target.value })}/>}</FormField>
            : (service.id === 'gitea' || service.id === 'custom-api' || advanced) && <FormField label={service.id === 'gitea' ? '서버 주소' : 'API 주소'} required>{control => <Input {...control} value={draft.baseUrl} maxLength={2048} required disabled={saving} inputMode="url" placeholder="https://example.com" onChange={event => set({ baseUrl: event.target.value })}/>}</FormField>}
        </div>
        <div className="setup-route__credential">
          <FormField label={draft.mailAuthType === 'oauth2' ? 'OAuth 액세스 토큰' : service.credentialLabel}
            description={existing?.hasCredential ? '비워 두면 기존 인증을 유지합니다.' : secretHint(service, draft.credential) || service.requirement}>
            {control => <Input {...control} type="password" value={draft.credential} autoComplete="new-password" disabled={saving || draft.clearCredential} onChange={event => set({ credential: event.target.value })}/>}
          </FormField>
          {!existing && service.setupUrl && <ExternalAnchor href={service.setupUrl} target="_blank" rel="noopener noreferrer" className="setup-route__link">인증 설정 열기<ArrowUpRight size={12} aria-hidden="true"/></ExternalAnchor>}
        </div>
        {api && <fieldset className="connection-grants"><legend>사용할 Ghost</legend>
          <p className="m-0 text-caption text-ink-2">선택한 Ghost만 이 계정의 API를 사용합니다. 외부 쓰기는 별도 확인을 받습니다.</p>
          {ghosts.map(ghost => <label key={ghost.id} className="flex items-center gap-2 text-ui"><Checkbox checked={draft.ghostIds.includes(ghost.id)} disabled={saving} onCheckedChange={checked => set({ ghostIds: checked ? [...draft.ghostIds, ghost.id] : draft.ghostIds.filter(id => id !== ghost.id) })}/>{ghost.name}</label>)}
        </fieldset>}
        {api && <fieldset disabled={saving} className="border-0 m-0 p-0"><ReadPaths value={draft.readPaths ?? []} onChange={readPaths => set({ readPaths })}/></fieldset>}
        <button type="button" className="connection-advanced" aria-expanded={advanced} disabled={saving} onClick={() => setAdvanced(!advanced)}>고급 설정<span aria-hidden="true" className="fold-mark"/></button>
        {advanced && <div className="flex flex-col gap-4">
          {mail && <>
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
          </>}
          {api && <>
            <FormField label="계정 확인 API 경로" required>{control => <Input {...control} value={draft.testPath} placeholder="users/me" disabled={saving} onChange={event => set({ testPath: event.target.value })}/>}</FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="인증 헤더">{control => <Input {...control} value={draft.authHeader} disabled={saving} onChange={event => set({ authHeader: event.target.value })}/>}</FormField>
              <FormField label="인증 접두어">{control => <Input {...control} value={draft.authPrefix} disabled={saving} onChange={event => set({ authPrefix: event.target.value })}/>}</FormField>
            </div>
            <FormField label="추가 헤더 (JSON)" description="비밀 값은 위 인증 정보에만 입력해 주세요.">{control => <Textarea {...control} value={draft.headers} disabled={saving} onChange={event => set({ headers: event.target.value })}/>}</FormField>
          </>}
          <FormField label="서비스 아이콘 주소" description="HTTPS 이미지 주소. 비워 두면 기본 서비스 아이콘을 사용합니다.">{control => <Input {...control} value={draft.iconUrl} inputMode="url" disabled={saving} onChange={event => set({ iconUrl: event.target.value })}/>}</FormField>
        </div>}
        {existing?.hasCredential && <label className="connection-clear"><Checkbox checked={draft.clearCredential} disabled={saving} onCheckedChange={checked => set({ clearCredential: checked === true })}/><span>저장된 인증 정보 삭제</span></label>}
        {error && <InlineError>{error}</InlineError>}
        <div className="setup-route__actions"><Button variant="ghost" type="button" disabled={saving} onClick={onClose}>취소</Button>
          <Button type="submit" disabled={saving}>{saving ? '저장 중…' : existing ? '저장하고 확인' : '연결하고 확인'}</Button>
        </div>
      </form>}
  </section>;
}
