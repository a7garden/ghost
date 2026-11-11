import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, Globe2, Mail, Pencil, PlugZap, Search, Sparkles, Trash2 } from 'lucide-react';
import { Button, Checkbox, FormField, InlineError, Input, Switch, Textarea } from '../ui';
import type { Command, Connection, Ghost } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Modal } from '../components/Modal';
import { uiTerms } from '../uiText';
import { buildConnectionCommand, type ConnectionDraft, connectionSummary, draftForService, draftFromConnection } from './connection-config';
import { connectionServices, connectionSetupPrompt, serviceById, serviceForConnection, type ConnectionService } from './connection-services';
import { ExternalAnchor } from '../components/ExternalAnchor';
import { ConnectionOAuthPanel, supportsConnectionOAuth } from './ConnectionOAuthPanel';

type TestState = { phase: 'testing' } | { phase: 'ok'; summary: string } | { phase: 'error'; message: string };

function ServiceIcon({ service, iconUrl }: { service?: ConnectionService; iconUrl?: string }) {
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
  const connections = (state?.connections ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
  const setupRequest = useRef<{ text: string; id: string } | null>(null);
  const available = connectionServices.filter(service => `${service.name} ${service.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const main = state?.ghosts.find(ghost => ghost.isDefault && ghost.state === 'active');

  const test = async (id: string) => {
    setTests(prev => ({ ...prev, [id]: { phase: 'testing' } }));
    try {
      const result = await client.send<{ summary: string }>({ type: 'connection.test', connectionId: id });
      setTests(prev => ({ ...prev, [id]: { phase: 'ok', summary: result.summary } }));
    } catch (reason) {
      setTests(prev => ({ ...prev, [id]: { phase: 'error', message: reason instanceof Error ? reason.message : '인증을 확인하지 못했습니다.' } }));
    }
  };
  const save = async (command: Command, requestId: string) => {
    const result = await client.send<{ connectionId: string }>(command, requestId);
    setSelected(null); setEditing(null);
    setNotice('');
    await test(result.connectionId);
  };
  const assist = async (service: ConnectionService, detail: string) => {
    if (!main) throw new Error('먼저 활성 메인 Ghost를 설정해 주세요.');
    // A failed admission retains this request identity so retry cannot send the setup twice.
    const text = connectionSetupPrompt(service, detail);
    if (setupRequest.current?.text !== text) setupRequest.current = { text, id: crypto.randomUUID() };
    await client.send({ type: 'message.send', conversationId: main.directConversationId, text }, setupRequest.current.id);
    navigate(`/ghosts/${main.id}`);
  };

  return <section className="flex min-w-0 flex-col gap-6" aria-label={uiTerms.connections}>
    <div className="settings-section-header flex flex-wrap items-center justify-between gap-3">
      <h2 className="section-title">{uiTerms.connections}</h2>
      <Button variant="outline" type="button" disabled={!main} onClick={() => setSelected(serviceById('custom-api')!)}><Sparkles size={15}/>Ghost에게 연결 맡기기</Button>
    </div>
    {error && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 text-caption text-ink-2" role="status">{notice}</p>}
    {connections.length > 0 && <ul className="connection-grid" aria-label="등록한 계정">
      {connections.map(connection => {
        const service = serviceForConnection(connection);
        const status = tests[connection.id];
        return <li key={connection.id} className="connection-tile">
          <ServiceIcon service={service} iconUrl={connection.iconUrl}/>
          <div className="connection-tile__identity"><h3>{connection.name}</h3><p>{connectionSummary(connection)}</p></div>
          <p className="connection-tile__status" data-phase={status?.phase} role="status">
            {status?.phase === 'testing' ? '인증 확인 중…' : status?.phase === 'ok' ? '인증 확인됨' : status?.phase === 'error' ? status.message : connection.hasCredential ? '인증 정보 저장됨' : '인증 정보 필요'}
          </p>
          <div className="connection-tile__actions">
            <Button variant="ghost" size="sm" type="button" disabled={status?.phase === 'testing'} aria-label={`${connection.name} 연결 테스트`} onClick={() => void test(connection.id)}><PlugZap size={14}/>확인</Button>
            <Button variant="ghost" size="icon" type="button" aria-label={`${connection.name} 편집`} onClick={() => { setError(''); setEditing(connection); }}><Pencil size={15}/></Button>
            <Button variant="ghost" size="icon" type="button" aria-label={`${connection.name} 삭제`} onClick={() => { setError(''); setRemoving(connection); }}><Trash2 size={15}/></Button>
          </div>
        </li>;
      })}
    </ul>}
    <section className="connection-catalog" aria-label="서비스 연결">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="m-0 text-ui font-medium">서비스 연결</h3>
        <label className="connection-search"><Search size={15} aria-hidden="true"/><Input aria-label="서비스 검색" placeholder="서비스 검색" value={query} onChange={event => setQuery(event.target.value)}/></label>
      </div>
      {(['서비스', '메일', '직접 연결'] as const).map(group => {
        const services = available.filter(service => service.group === group);
        return services.length > 0 && <div key={group} className="connection-catalog__group">
          {group !== '서비스' && <h4>{group}</h4>}
          <ul>{services.map(service => <li key={service.id}>
            <button type="button" disabled={!state} onClick={() => setSelected(service)} className="service-choice">
              <ServiceIcon service={service}/><span>{service.name}</span><ArrowUpRight size={14} className="service-choice__arrow" aria-hidden="true"/>
            </button>
          </li>)}</ul>
        </div>;
      })}
      {available.length === 0 && <div className="flex flex-col items-start gap-3"><p className="m-0 text-ink-2">일치하는 서비스가 없습니다.</p><Button variant="outline" onClick={() => setSelected(serviceById('custom-api')!)}>다른 서비스 연결</Button></div>}
    </section>
    {(selected || editing) && <ConnectionDialog key={editing?.id ?? selected?.id} existing={editing} service={selected ?? serviceForConnection(editing!) ?? serviceById(editing!.config.kind === 'mail' ? 'custom-mail' : 'custom-api')!}
      ghosts={state?.ghosts.filter(ghost => ghost.state === 'active') ?? []} canAssist={Boolean(main)} onAssist={assist}
      onClose={() => { setSelected(null); setEditing(null); }} onSave={save}/>}
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

function ConnectionDialog({ existing, service, ghosts, canAssist, onAssist, onClose, onSave }: {
  existing: Connection | null; service: ConnectionService; ghosts: Ghost[]; canAssist: boolean;
  onAssist(service: ConnectionService, detail: string): Promise<void>; onClose(): void; onSave(command: Command, requestId: string): Promise<void>;
}) {
  const [draft, setDraft] = useState(() => existing ? draftFromConnection(existing) : draftForService(service));
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(service.group === '직접 연결');
  const saveRequest = useRef<string | undefined>(undefined);
  const [manual, setManual] = useState(Boolean(existing) || !supportsConnectionOAuth(service.id));
  const set = (patch: Partial<ConnectionDraft>) => { saveRequest.current = undefined; setDraft(prev => ({ ...prev, ...patch })); };
  const mail = draft.kind === 'mail';
  const api = draft.kind === 'api';
  const oauthOnly = service.id === 'outlook';
  const save = async () => {
    if (saving) return;
    const built = buildConnectionCommand(draft, existing);
    if (!built.ok) { setError(built.error); return; }
    if (!existing && !draft.credential.trim()) { setError(`${service.credentialLabel}를 입력하거나 Ghost에게 연결을 맡겨 주세요.`); return; }
    setSaving(true); setError('');
    try { await onSave(built.command, saveRequest.current ??= crypto.randomUUID()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '연결을 저장하지 못했습니다.'); setSaving(false); }
  };
  return <Modal title={existing ? `${existing.name} 편집` : `${service.name} 연결`} onClose={() => { if (!saving) onClose(); }} className="sm:max-w-[560px]">
    <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); if (manual) void save(); }}>
      <div className="flex items-start gap-3"><ServiceIcon service={service}/><p className="m-0 text-ui text-ink-2">{service.requirement}</p></div>
      {!existing && <>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant={draft.credential ? 'outline' : 'default'} disabled={saving || !canAssist} onClick={async () => {
            setSaving(true); setError('');
            try { await onAssist(service, draft.username || draft.baseUrl || draft.name); }
            catch (reason) { setError(reason instanceof Error ? reason.message : '연결 요청을 보내지 못했습니다.'); setSaving(false); }
          }}><Sparkles size={15}/>Ghost에게 연결 맡기기</Button>
          {service.setupUrl && <ExternalAnchor href={service.setupUrl} target="_blank" rel="noopener noreferrer" className="text-caption text-ink-2 underline underline-offset-4">{mail && service.id !== 'outlook' ? '앱 비밀번호 발급' : '인증 설정 열기'}<ArrowUpRight className="ml-1 inline" size={12}/></ExternalAnchor>}
        </div>
      </>}
      {existing && <p className="activity-warn activity-warn--calm">서버·계정·접근 권한을 바꾸면 기존 인증을 다시 입력해야 하며, 관련 활동의 진행 중인 실행이 중단됩니다.</p>}
      {!existing && supportsConnectionOAuth(service.id) && <>
        <div className="flex gap-2" role="group" aria-label="인증 방법">
          <Button type="button" size="sm" variant={!manual ? 'default' : 'outline'} onClick={() => setManual(false)} aria-pressed={!manual}>로그인</Button>
          {!oauthOnly && <Button type="button" size="sm" variant={manual ? 'default' : 'outline'} onClick={() => setManual(true)} aria-pressed={manual}>키로 직접 연결</Button>}
        </div>
        {!manual && <ConnectionOAuthPanel service={service} ghosts={ghosts} onConnected={onClose}/>}
      </>}
      {manual && <>
        <FormField label="이름" required>{control => <Input {...control} value={draft.name} maxLength={128} required disabled={saving} onChange={event => set({ name: event.target.value })}/>}</FormField>
        {mail ? <FormField label="메일 주소" required>{control => <Input {...control} type="email" value={draft.username} maxLength={320} required disabled={saving} autoComplete="username" placeholder="name@example.com" onChange={event => set({ username: event.target.value, ...(existing ? {} : { name: `${service.name} · ${event.target.value}` }) })}/>}</FormField>
          : (service.id === 'gitea' || service.id === 'custom-api' || advanced) && <FormField label={service.id === 'gitea' ? '서버 주소' : 'API 주소'} required>{control => <Input {...control} value={draft.baseUrl} maxLength={2048} required disabled={saving} inputMode="url" placeholder="https://example.com" onChange={event => set({ baseUrl: event.target.value })}/>}</FormField>}
        <FormField label={draft.mailAuthType === 'oauth2' ? 'OAuth 액세스 토큰' : service.credentialLabel} description={existing?.hasCredential ? '비워 두면 기존 인증을 유지합니다. 서버·계정을 바꾸면 다시 입력해 주세요.' : '인증 정보는 Host에만 저장되며 대화에 전달되지 않습니다.'}>
          {control => <Input {...control} type="password" value={draft.credential} autoComplete="new-password" disabled={saving} onChange={event => set({ credential: event.target.value, clearCredential: false })}/>}</FormField>
        {api && <fieldset className="connection-grants"><legend>사용할 Ghost</legend>
          <p className="m-0 text-caption text-ink-2">선택한 Ghost만 이 계정의 API를 사용합니다. 외부 쓰기는 별도 확인을 받습니다.</p>
          {ghosts.map(ghost => <label key={ghost.id} className="flex items-center gap-2 text-ui"><Checkbox checked={draft.ghostIds.includes(ghost.id)} disabled={saving} onCheckedChange={checked => set({ ghostIds: checked ? [...draft.ghostIds, ghost.id] : draft.ghostIds.filter(id => id !== ghost.id) })}/>{ghost.name}</label>)}
        </fieldset>}
        <button type="button" className="connection-advanced" aria-expanded={advanced} disabled={saving} onClick={() => setAdvanced(!advanced)}>고급 설정<ChevronDown size={14} className={advanced ? 'rotate-180' : ''}/></button>
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
      </>}
      {error && <InlineError>{error}</InlineError>}
      <div className="flex justify-end gap-2"><Button variant="outline" type="button" disabled={saving} onClick={onClose}>취소</Button>
        {manual && <Button type="submit" disabled={saving}>{saving ? '처리 중…' : existing ? '저장' : '연결'}</Button>}
      </div>
    </form>
  </Modal>;
}
