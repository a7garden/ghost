import { Fragment, useState } from 'react';
import { KeyRound, Pencil, PlugZap, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Checkbox, FormField, InlineError, Input, SegmentedControl, SettingsGroup, SettingsRow, Switch } from '../ui';
import { type Command, type Connection, type ConnectionConfig } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Modal } from '../components/Modal';
import { uiTerms } from '../uiText';
import { buildConnectionCommand, type ConnectionDraft, connectionKindLabel, connectionSummary, draftFromConnection, emptyConnectionDraft } from './connection-config';

type TestState = { phase: 'testing' } | { phase: 'ok'; summary: string } | { phase: 'error'; message: string };

/** 설정 → 연결 계정: GitHub·Gitea 토큰과 메일 계정. 자격 증명은 호스트의 비밀 저장소에만 있고 이 화면으로 다시 오지 않습니다. */
export function Connections() {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [pending, setPending] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [removing, setRemoving] = useState<Connection | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const connections = (state?.connections ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);

  const act = async (label: string, work: () => Promise<unknown>, done: string) => {
    setPending(label); setError(''); setNotice('');
    try { await work(); setNotice(done); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.'); }
    finally { setPending(''); }
  };

  const test = async (connection: Connection) => {
    setPending('test'); setError(''); setNotice('');
    setTests(prev => ({ ...prev, [connection.id]: { phase: 'testing' } }));
    try {
      const result = await client.send<{ summary?: unknown }>({ type: 'connection.test', connectionId: connection.id });
      const summary = typeof result?.summary === 'string' && result.summary ? result.summary : '연결에 성공했습니다.';
      setTests(prev => ({ ...prev, [connection.id]: { phase: 'ok', summary } }));
    } catch (reason) {
      setTests(prev => ({ ...prev, [connection.id]: { phase: 'error', message: reason instanceof Error ? reason.message : '연결을 확인하지 못했습니다.' } }));
    } finally { setPending(''); }
  };

  const save = async (command: Command, done: string) => {
    setPending('save'); setError(''); setNotice('');
    try {
      await client.send(command);
      setNotice(done);
      setCreating(false); setEditing(null);
    } finally { setPending(''); }
  };

  return <section className="flex min-w-0 flex-col gap-6" aria-label={uiTerms.connections}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="section-title">{uiTerms.connections}</h2>
      <Button type="button" disabled={!state} onClick={() => { setError(''); setCreating(true); }}><Plus size={15}/>연결 추가</Button>
    </div>
    <p className="m-0 -mt-2 text-caption text-ink-2">활동이 메일과 PR을 살피려면 여기 계정이 필요합니다. 자격 증명은 저장된 뒤에는 표시되지 않습니다.</p>
    {connections.length
      ? <SettingsGroup title={<span className="sr-only">{uiTerms.connections}</span>}>{connections.map(connection => {
        const testState = tests[connection.id];
        return <Fragment key={connection.id}>
          <SettingsRow
            label={<span className="flex min-w-0 flex-col gap-1.5">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge variant="outline">{connectionKindLabel[connection.config.kind]}</Badge>
                {connection.hasCredential
                  ? <Badge variant="success"><KeyRound size={10} aria-hidden="true"/>자격 저장됨</Badge>
                  : <Badge variant="warning">자격 없음</Badge>}
              </span>
              <span className="text-ui font-medium text-ink [overflow-wrap:anywhere]">{connection.name}</span>
              <span className="text-caption font-normal text-ink-3 [overflow-wrap:anywhere]">{connectionSummary(connection)}</span>
            </span>}
            description={`바뀜 · ${updatedLabel(connection.updatedAt)}`}>
            <span className="flex items-center gap-1">
              <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} aria-label={`${connection.name} 연결 테스트`}
                onClick={() => void test(connection)}>
                <PlugZap size={14}/>테스트
              </Button>
              <Button variant="ghost" size="icon" type="button" aria-label={`${connection.name} 편집`} disabled={pending !== ''}
                onClick={() => { setError(''); setEditing(connection); }}><Pencil size={15}/></Button>
              <Button variant="ghost" size="icon" type="button" aria-label={`${connection.name} 삭제`} disabled={pending !== ''}
                onClick={() => { setError(''); setRemoving(connection); }}><Trash2 size={15}/></Button>
            </span>
          </SettingsRow>
          {testState && <div className="connection-test" data-phase={testState.phase} role="status">
            {testState.phase === 'testing' && <p className="m-0">연결을 확인하는 중…</p>}
            {testState.phase === 'ok' && <p className="m-0 text-success">{testState.summary}</p>}
            {testState.phase === 'error' && <p className="m-0">{testState.message}</p>}
          </div>}
        </Fragment>;
      })}</SettingsGroup>
      : state && <div className="calm"><PlugZap size={16} aria-hidden="true"/><p>연결 계정 없음. GitHub·Gitea 토큰이나 메일 계정을 연결하면 활동에서 쓸 수 있습니다.</p></div>}
    {error && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}

    {(creating || editing) && <ConnectionDialog existing={editing} onClose={() => { setCreating(false); setEditing(null); }}
      onSave={save}/>}
    {removing && <Modal title="연결 삭제" onClose={() => pending === '' && setRemoving(null)}>
      <p className="m-0">이 연결을 삭제할까요? 이 연결을 쓰던 활동은 새 항목을 살피지 못하고, 저장된 자격도 함께 지워집니다.</p>
      {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={pending !== ''} onClick={() => setRemoving(null)}>취소</Button>
        <Button variant="destructive" type="button" disabled={pending !== ''}
          onClick={() => void act('delete', async () => { await client.send({ type: 'connection.delete', connectionId: removing.id }); setRemoving(null); }, '연결을 삭제했습니다.')}>삭제</Button>
      </div>
    </Modal>}
  </section>;
}

/** Updated-at line: absolute, since credentials' freshness matters more than a relative guess. */
const updatedLabel = (at: number) =>
  new Date(at).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 연결 만들기/편집. The secret field starts blank every time and never echoes a stored value. */
export function ConnectionDialog({ existing, onClose, onSave }: {
  existing: Connection | null;
  onClose(): void;
  onSave(command: Command, done: string): Promise<void>;
}) {
  const kinds = Object.keys(connectionKindLabel) as ConnectionConfig['kind'][];
  const [draft, setDraft] = useState(() => existing ? draftFromConnection(existing) : emptyConnectionDraft('github'));
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const set = (patch: Partial<ConnectionDraft>) => setDraft(prev => ({ ...prev, ...patch }));
  const mail = draft.kind === 'mail';

  const save = async () => {
    if (saving) return;
    const built = buildConnectionCommand(draft, existing);
    if (!built.ok) { setError(built.error); return; }
    setSaving(true); setError('');
    try { await onSave(built.command, existing ? '연결을 저장했습니다.' : '연결을 만들었습니다.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '연결을 저장하지 못했습니다.'); setSaving(false); }
  };

  return <Modal title={existing ? '연결 편집' : '연결 추가'} onClose={() => { if (!saving) onClose(); }} className="sm:max-w-[560px]">
    <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      {existing && <p className="activity-warn activity-warn--calm">연결 정보나 자격을 바꾸면 이 계정을 쓰는 활동의 진행 중인 실행이 취소됩니다.</p>}
      <SegmentedControl aria-label="연결 종류" value={draft.kind}
        onValueChange={value => set({ kind: value as ConnectionConfig['kind'] })}
        options={kinds.map(kind => ({ value: kind, label: connectionKindLabel[kind], disabled: saving }))}/>
      <FormField label="이름" required>
        {control => <Input {...control} value={draft.name} maxLength={128} required disabled={saving} placeholder="예: 소유자 GitHub"
          onChange={event => set({ name: event.target.value })}/>}
      </FormField>
      {mail
        ? <>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
            <FormField label="IMAP 서버" required>
              {control => <Input {...control} value={draft.host} maxLength={253} required disabled={saving} placeholder="imap.example.com" autoComplete="off"
                onChange={event => set({ host: event.target.value })}/>}
            </FormField>
            <FormField label="포트">
              {control => <Input {...control} type="number" min={1} max={65535} step={1} value={draft.port} disabled={saving}
                onChange={event => set({ port: event.target.value })}/>}
            </FormField>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="사용자 이름" required>
              {control => <Input {...control} value={draft.username} maxLength={320} required disabled={saving} autoComplete="off"
                onChange={event => set({ username: event.target.value })}/>}
            </FormField>
            <FormField label="메일함">
              {control => <Input {...control} value={draft.mailbox} maxLength={256} disabled={saving} autoComplete="off"
                onChange={event => set({ mailbox: event.target.value })}/>}
            </FormField>
          </div>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
            <FormField label="SMTP 서버" description="메일 회신을 보낼 때만 필요합니다. 비워 두면 이 계정으로 회신 쓰기가 불가능합니다.">
              {control => <Input {...control} value={draft.smtpHost} maxLength={253} disabled={saving} placeholder="smtp.example.com" autoComplete="off"
                onChange={event => set({ smtpHost: event.target.value })}/>}
            </FormField>
            <FormField label="SMTP 포트">
              {control => <Input {...control} type="number" min={1} max={65535} step={1} value={draft.smtpPort} disabled={saving}
                onChange={event => set({ smtpPort: event.target.value })}/>}
            </FormField>
          </div>
          <label className="activity-check">
            <span className="activity-check__copy"><span>SMTP 암시적 TLS</span><small>켜면 연결부터 TLS, 끄면 STARTTLS로 전환합니다. 두 방식 모두 인증서를 확인합니다.</small></span>
            <Switch checked={draft.smtpSecure} disabled={saving} onCheckedChange={smtpSecure => set({ smtpSecure })} aria-label="SMTP 암시적 TLS"/>
          </label>
        </>
        : <FormField label="API 주소" required>
          {control => <Input {...control} value={draft.baseUrl} maxLength={2048} required disabled={saving} inputMode="url"
            placeholder={draft.kind === 'github' ? 'https://api.github.com' : 'https://git.example.com'}
            onChange={event => set({ baseUrl: event.target.value })}/>}
        </FormField>}

      <FormField label={mail ? '앱 비밀번호' : '접근 토큰'}
        description={existing?.hasCredential
          ? '저장된 자격이 있습니다. 비워 두면 이름만 바꾼 저장에서 그대로 유지됩니다. 연결 정보를 바꾸면 다시 입력해야 합니다.'
          : `${connectionKindLabel[draft.kind]} 계정의 자격 증명입니다. 저장 후에는 다시 표시되지 않습니다.`}>
        {control => <Input {...control} type="password" value={draft.credential} autoComplete="new-password" disabled={saving}
          placeholder={existing?.hasCredential ? '••••••••' : undefined}
          onChange={event => set({ credential: event.target.value, clearCredential: false })}/>}
      </FormField>
      {existing?.hasCredential && <label className="connection-clear">
        <Checkbox checked={draft.clearCredential} disabled={saving}
          onCheckedChange={clearCredential => set({ clearCredential: clearCredential === true })}/>
        <span>저장된 자격 삭제</span>
      </label>}

      {error && <InlineError>{error}</InlineError>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={saving} onClick={onClose}>취소</Button>
        <Button type="submit" disabled={saving}>{saving ? '저장하는 중…' : existing ? '저장' : '연결 추가'}</Button>
      </div>
    </form>
  </Modal>;
}
