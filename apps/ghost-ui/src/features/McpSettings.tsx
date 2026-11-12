import { useState, type FormEvent } from 'react';
import type { McpServer } from '@ghost/contract';
import { Button, InlineError, SettingsGroup } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
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
  return <section className="infra-records" aria-label="MCP 서버">
    <SettingsGroup title="MCP 서버" actions={<Button onClick={() => { setEditing('new'); setError(''); }}>서버 추가</Button>}>
      {error && <InlineError>{error}</InlineError>}
      {editing && <McpEditor key={typeof editing === 'string' ? editing : editing.id} server={editing === 'new' ? null : editing} onClose={() => setEditing(null)}/>}
      {!state?.mcpServers.length && !editing && <p className="infra-record__meta">등록된 서버가 없습니다.</p>}
      {state?.mcpServers.map(server => <article className="infra-record" key={server.id}>
        <div className="infra-record__head"><h3>{server.name}</h3><div className="flex gap-2"><Button variant="ghost" size="sm" onClick={() => setEditing(server)}>편집</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(server.id)}>삭제</Button></div></div>
        <p className="infra-record__meta">{server.enabled ? '사용 중' : '중지'} · {server.transport.kind === 'stdio' ? server.transport.command : server.transport.url}</p>
        <p className="infra-record__meta">읽기 도구 {server.readTools.length ? server.readTools.join(', ') : '없음'}</p>
        {removing === server.id && <div className="infra-delete"><p>{server.name} 서버 등록을 삭제할까요?</p><div className="infra-actions"><Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>취소</Button><Button variant="destructive" disabled={busy} onClick={() => void remove(server.id)}>서버 삭제</Button></div></div>}
      </article>)}
    </SettingsGroup>
  </section>;
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
    <fieldset disabled={busy} className="infra-form border-0 p-0 m-0">
      <TextField label="서버 이름" value={name} onChange={setName} required maxLength={128}/>
      <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)}/>사용</label>
      <Choice label="연결 방식" value={kind} onChange={value => setKind(value as 'stdio' | 'http')} options={[{ value: 'stdio', label: '표준 입출력 (stdio)' }, { value: 'http', label: 'HTTP' }]}/>
      {kind === 'stdio' ? <>
        <TextField label="실행 파일" value={command} onChange={setCommand} required/>
        <StringList label="인수" values={args} onChange={setArgs} max={256}/>
        <TextField label="작업 디렉터리" value={cwd} onChange={setCwd} placeholder="Host 기본 디렉터리"/>
        <StringList label="환경 변수 이름" values={env} onChange={setEnv} max={64} placeholder="API_TOKEN"/>
      </> : <>
        <TextField label="서버 URL" type="url" required value={url} onChange={setUrl}/>
        <Choice label="인증 연결" value={connectionId} onChange={setConnectionId} options={[{ value: '', label: '없음' }, ...(state?.connections ?? []).map(connection => ({ value: connection.id, label: connection.name }))]}/>
      </>}
      <StringList label="읽기 도구" values={readTools} onChange={setReadTools} max={1024}/>
    </fieldset>
    {error && <InlineError>{error}</InlineError>}
    <EditorActions busy={busy} onCancel={onClose}/>
  </form>;
}
