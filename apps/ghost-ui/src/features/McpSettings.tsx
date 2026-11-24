import { useState, type FormEvent } from 'react';
import type { McpServer } from '@ghost/contract';
import { Button, Checkbox, InlineError, SettingsGroup, SettingsRow } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { uiTerms } from '../uiText';
import { Choice, EditorActions, errorText, StringList, TextField } from './InfrastructureFields';

export function McpSettings() {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [editing, setEditing] = useState<McpServer | 'new' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const remove = async (serverId: string) => {
    setBusy(true); setError('');
    try { await client.send({ type: 'mcp.delete', serverId }); setRemoving(null); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <SettingsGroup title={uiTerms.mcp} actions={<Button onClick={() => { setEditing('new'); setError(''); }}>서버 추가</Button>}
    description="Ghost가 쓸 수 있는 외부 도구를 연결합니다. 개발자가 준 MCP 서버의 실행 명령이나 주소가 있을 때만 필요합니다.">
    {error && <InlineError>{error}</InlineError>}
    {editing && <div className="px-4 py-3"><McpEditor key={typeof editing === 'string' ? editing : editing.id} server={editing === 'new' ? null : editing} onClose={() => setEditing(null)}/></div>}
    {!state?.mcpServers.length && !editing && <p className="m-0 p-4 text-caption text-ink-2">연결해 둔 외부 도구가 없습니다.</p>}
    {state?.mcpServers.map(server => <article className="min-w-0 border-b border-line last:border-b-0" key={server.id}>
      <SettingsRow label={server.name} description={<>
        <span className="block">{server.enabled ? '사용 중' : '중지'} · {server.transport.kind === 'stdio' ? server.transport.command : server.transport.url}</span>
        {server.readTools.length > 0 && <span className="block">읽기 전용 도구: {server.readTools.join(', ')}</span>}
      </>}>
        <span className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(server)}>편집</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(server.id)}>삭제</Button>
        </span>
      </SettingsRow>
      {removing === server.id && <div className="grid gap-3 px-4 pb-4">
        <p className="m-0">{server.name} 서버를 삭제할까요?</p>
        <div className="infra-actions">
          <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>취소</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove(server.id)}>서버 삭제</Button>
        </div>
      </div>}
    </article>)}
  </SettingsGroup>;
}

function McpEditor({ server, onClose }: { server: McpServer | null; onClose(): void }) {
  const { client, store } = useHost();
  const { state } = useHostState(store);
  const transport = server?.transport;
  const [name, setName] = useState(server?.name ?? '');
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [kind, setKind] = useState(transport?.kind ?? 'stdio');
  const [command, setCommand] = useState(transport?.kind === 'stdio' ? transport.command : '');
  const [args, setArgs] = useState(transport?.kind === 'stdio' ? transport.args : [] as string[]);
  const [env, setEnv] = useState(transport?.kind === 'stdio' ? transport.env : [] as string[]);
  const [cwd, setCwd] = useState(transport?.kind === 'stdio' ? transport.cwd ?? '' : '');
  const [url, setUrl] = useState(transport?.kind === 'http' ? transport.url : '');
  const [connectionId, setConnectionId] = useState(transport?.kind === 'http' ? transport.connectionId ?? '' : '');
  const [readTools, setReadTools] = useState(server?.readTools ?? []);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      if (env.some(value => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value))) throw new Error('환경 변수는 값 없이 이름만 입력하세요.');
      const input = { name: name.trim(), enabled, readTools: readTools.filter(Boolean), transport: kind === 'stdio'
        ? { kind: 'stdio' as const, command: command.trim(), args, env, cwd: cwd.trim() || null }
        : { kind: 'http' as const, url: url.trim(), connectionId: connectionId || null } };
      await client.send(server ? { type: 'mcp.update', serverId: server.id, ...input } : { type: 'mcp.create', ...input }); onClose();
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <form className="infra-form" onSubmit={event => void save(event)} aria-label={server ? 'MCP 서버 편집' : 'MCP 서버 추가'}>
    <fieldset disabled={busy} className="infra-form border-0 p-0 m-0 min-w-0">
      <TextField label="서버 이름" value={name} onChange={setName} required maxLength={128}/>
      <label className="flex items-center gap-2"><Checkbox checked={enabled} disabled={busy} onCheckedChange={checked => setEnabled(checked === true)}/>사용</label>
      <Choice label="연결 방식" value={kind} onChange={value => setKind(value as 'stdio' | 'http')} options={[{ value: 'stdio', label: '내 Mac에서 실행 (stdio)' }, { value: 'http', label: '인터넷 주소 (HTTP)' }]}/>
      {kind === 'stdio' ? <>
        <TextField label="실행 파일" value={command} onChange={setCommand} required/>
        <StringList label="실행 옵션" values={args} onChange={setArgs} max={256}/>
        <TextField label="실행 폴더" value={cwd} onChange={setCwd} placeholder="비워 두면 기본 폴더"/>
        <div className="grid gap-1 min-w-0">
          <StringList label="환경 변수 이름" values={env} onChange={setEnv} max={64} placeholder="API_TOKEN"/>
          <p className="m-0 text-caption text-ink-2">값은 입력하지 않습니다. 이름만 적으면 Host가 가진 값을 전달합니다.</p>
        </div>
      </> : <>
        <TextField label="서버 URL" type="url" required value={url} onChange={setUrl}/>
        <Choice label="로그인에 쓸 연결 계정" value={connectionId} onChange={setConnectionId} options={[{ value: '', label: '없음' }, ...(state?.connections ?? []).map(connection => ({ value: connection.id, label: connection.name }))]}/>
      </>}
      <div className="grid gap-1 min-w-0">
        <StringList label="읽기 도구" values={readTools} onChange={setReadTools} max={1024}/>
        <p className="m-0 text-caption text-ink-2">데이터를 바꾸지 않는 도구의 이름. 여기 적은 도구는 묻지 않고 쓸 수 있습니다.</p>
      </div>
    </fieldset>
    {error && <InlineError>{error}</InlineError>}
    <EditorActions busy={busy} onCancel={onClose}/>
  </form>;
}
