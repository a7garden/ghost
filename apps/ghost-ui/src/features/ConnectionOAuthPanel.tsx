import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import type { ConnectionOAuthView, Ghost } from '@ghost/contract';
import { Button, Checkbox, FormField, InlineError, Input } from '../ui';
import { ExternalAnchor } from '../components/ExternalAnchor';
import { useHost } from '../host/context';
import type { ConnectionService } from './connection-services';

export const supportsConnectionOAuth = (id: string) => ['google', 'outlook', 'x', 'notion', 'slack'].includes(id);

/** Login credentials and authorization codes never pass through the conversation. */
export function ConnectionOAuthPanel({ service, ghosts, onConnected }: {
  service: ConnectionService; ghosts: Ghost[]; onConnected(): void;
}) {
  const { client } = useHost();
  const [view, setView] = useState<ConnectionOAuthView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(service.name);
  const [username, setUsername] = useState('');
  const [googleDrive, setGoogleDrive] = useState(true);
  const [ghostIds, setGhostIds] = useState<string[]>([]);
  const [clientId, setClientId] = useState(''), [clientSecret, setClientSecret] = useState('');
  const [configure, setConfigure] = useState(false);
  const [reload, setReload] = useState(0);
  const awaitingLogin = useRef(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observe = async () => {
      try {
        const next = await client.connectionOAuth(service.id);
        if (disposed) return;
        setView(next); setError('');
        if (next.clientId) setClientId(next.clientId);
        if (next.state === 'pending') {
          awaitingLogin.current = true;
          timer = setTimeout(() => void observe(), 1500);
        }
        if (next.state === 'connected' && awaitingLogin.current) onConnected();
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : '로그인 상태를 확인하지 못했습니다.');
      }
    };
    void observe();
    return () => { disposed = true; clearTimeout(timer); };
  }, [client, service.id, reload]); // callback belongs to this dialog; polling must not restart on every keystroke

  const act = async (run: () => Promise<ConnectionOAuthView>) => {
    setBusy(true); setError('');
    try { const next = await run(); setView(next); setReload(value => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '로그인을 진행하지 못했습니다.'); }
    finally { setBusy(false); }
  };
  const pending = view?.state === 'pending';
  return <section className="flex flex-col gap-4" aria-label={`${service.name} 로그인`}>
    {view && !view.configured && <p className="m-0 text-caption text-ink-2">처음 한 번은 {service.name} OAuth 앱을 등록해야 합니다. 위의 Ghost 연결 도움을 이용하거나 앱 정보를 직접 입력할 수 있습니다.</p>}
    {view && <>
      <button type="button" className="connection-advanced" aria-expanded={configure || !view.configured} disabled={busy || pending} onClick={() => setConfigure(!configure)}>OAuth 앱 설정<ChevronDown size={14}/></button>
      {(configure || !view.configured) && <div className="flex flex-col gap-4">
        <FormField label="리디렉션 주소" description="서비스의 OAuth 앱에 이 주소를 그대로 등록합니다.">{control => <Input {...control} value={view.redirectUri} readOnly/>}</FormField>
        <FormField label="클라이언트 ID">{control => <Input {...control} value={clientId} disabled={busy || pending} maxLength={2048} onChange={event => setClientId(event.target.value)}/>}</FormField>
        <FormField label="클라이언트 시크릿" description={service.id === 'x' ? '공개 PKCE 앱은 비워 둘 수 있습니다. 저장된 값은 다시 표시하지 않습니다.' : '이 서비스의 OAuth 앱 시크릿이 필요합니다. 저장된 값은 다시 표시하지 않습니다.'}>{control => <Input {...control} type="password" value={clientSecret} disabled={busy || pending} autoComplete="new-password" onChange={event => setClientSecret(event.target.value)}/>}</FormField>
        <div><Button type="button" variant="outline" disabled={busy || pending || !clientId.trim()} onClick={() => void act(async () => {
          const next = await client.configureConnectionOAuth(service.id, { clientId: clientId.trim(), ...(clientSecret ? { clientSecret } : {}) });
          setClientSecret(''); setConfigure(false); return next;
        })}>앱 설정 저장</Button></div>
      </div>}
      {view.configured && <>
        <FormField label="연결 이름">{control => <Input {...control} value={name} maxLength={128} disabled={busy || pending} onChange={event => setName(event.target.value)}/>}</FormField>
        {service.id === 'outlook' && <FormField label="메일 주소">{control => <Input {...control} value={username} type="email" disabled={busy || pending} autoComplete="username" onChange={event => setUsername(event.target.value)}/>}</FormField>}
        {service.kind === 'api' && <fieldset className="connection-grants"><legend>사용할 Ghost</legend>
          {ghosts.map(ghost => <label key={ghost.id} className="flex items-center gap-2 text-ui"><Checkbox checked={ghostIds.includes(ghost.id)} disabled={busy || pending} onCheckedChange={checked => setGhostIds(ids => checked ? [...ids, ghost.id] : ids.filter(id => id !== ghost.id))}/>{ghost.name}</label>)}
        </fieldset>}
        {service.id === 'google' && <label className="flex items-center gap-2 text-ui"><Checkbox checked={googleDrive} disabled={busy || pending} onCheckedChange={checked => setGoogleDrive(checked === true)}/>Google Drive 파일 읽기</label>}
        <p className="m-0 text-caption text-ink-2">{service.id === 'google' ? '프로필·이메일과 선택한 Drive 읽기 권한에 동의합니다. 메일은 Gmail 항목에서 별도로 연결합니다.' : service.id === 'outlook' ? '메일 읽기와 SMTP 인증 권한에 동의합니다. 실제 발송은 자동 활동의 별도 정책을 따릅니다.' : service.id === 'x' ? '프로필·게시물 읽기 권한으로 연결합니다.' : '서비스 동의 화면에서 계정과 접근 범위를 확인해 주세요.'}</p>
        {!pending && <div><Button type="button" disabled={busy || !name.trim() || (service.id === 'outlook' && !username.trim())} onClick={() => void act(() => client.startConnectionOAuth(service.id, { name: name.trim(), ghostIds, ...(service.id === 'outlook' ? { username: username.trim() } : {}), ...(service.id === 'google' ? { googleDrive } : {}) }))}>{busy ? '준비 중…' : `${service.name} 로그인`}</Button></div>}
      </>}
      {pending && <div className="flex flex-wrap items-center gap-3">
        {view.authorizationUrl && <ExternalAnchor href={view.authorizationUrl} target="_blank" rel="noopener noreferrer" className="text-ui font-medium underline underline-offset-4">{service.name}에서 로그인<ArrowUpRight size={14} className="ml-1 inline"/></ExternalAnchor>}
        <Button variant="ghost" type="button" disabled={busy} onClick={() => void act(() => client.cancelConnectionOAuth(service.id))}>로그인 취소</Button>
        <p className="m-0 w-full text-caption text-ink-2" role="status">서비스의 로그인·동의 완료를 기다립니다.</p>
      </div>}
      {view.message && <p className="m-0 text-caption text-ink-2" role={view.state === 'error' ? 'alert' : 'status'}>{view.message}</p>}
    </>}
    {!view && !error && <p className="m-0 text-caption text-ink-2" role="status">로그인 설정을 확인하는 중…</p>}
    {error && <><InlineError>{error}</InlineError><div><Button variant="outline" type="button" onClick={() => setReload(value => value + 1)}>다시 확인</Button></div></>}
  </section>;
}
