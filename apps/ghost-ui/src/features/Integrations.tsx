import { useState } from 'react';
import { ArrowUpRight, Check, CircleAlert, Plug, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import type { Command, Integration, IntegrationTransport, Snapshot } from '../client/types';
import { MobilePairing } from './MobilePairing';

type Action = (command: Command) => Promise<Record<string, any>>;
const google: IntegrationTransport = { kind: 'stdio', command: 'workspace-mcp', args: ['--transport', 'stdio', '--tools', 'calendar', 'tasks'], env_refs: { GOOGLE_OAUTH_CLIENT_ID: 'GOOGLE_OAUTH_CLIENT_ID', GOOGLE_OAUTH_CLIENT_SECRET: 'GOOGLE_OAUTH_CLIENT_SECRET' }, cwd: null };
export function parseLines(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split('\n').filter(s => s.trim())) {
    const parts = line.split('=').map(s => s.trim());
    if (parts.length !== 2 || parts.some(s => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s))) throw new Error('환경 변수는 KEY=HOST_ENV_NAME 형식으로 한 줄씩 입력하세요. 비밀 값은 넣지 않습니다.');
    if (Object.hasOwn(result, parts[0])) throw new Error('같은 환경 변수 이름이 두 번 입력되었습니다.');
    Object.defineProperty(result, parts[0], { value: parts[1], enumerable: true, configurable: true });
  }
  return result;
}
const dataFor = (i: Integration) => ({ name: i.name, transport: i.transport, profiles: i.profiles, enabled: i.enabled });
export function Integrations({ snapshot, action, busy, mode, navigate }: { snapshot: Snapshot; action: Action; busy: boolean; mode: 'demo' | 'live'; navigate: (path: string) => void }) {
  const [editor, setEditor] = useState<{ item?: Integration; preset?: boolean } | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [tools, setTools] = useState<Integration | null>(null);
  const run = async (command: Record<string, unknown>, success = '') => { setError(''); setNotice(''); try { await action({ type: 'workspace', action: command }); setNotice(success); } catch (e) { setError(e instanceof Error ? e.message : '연동 설정을 저장하지 못했습니다.'); } };
  return <div className="page-content integrations-page"><div className="page-heading"><div><h1>연동</h1></div><button className="button primary" onClick={() => setEditor({})}><Plus size={16}/>연동 추가</button></div>
    {mode === 'demo' && <p className="integration-notice">예시 모드에서는 설정 흐름을 체험할 수 있습니다. 실제 연결은 로컬 호스트에서 실행됩니다.</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="integration-notice" role="status">{notice}</p>}
    <MobilePairing mode={mode}/>
    <section><div className="section-heading"><h2>내 연결 <span className="muted">{snapshot.integrations.length}</span></h2></div><div className="integration-list">{snapshot.integrations.map(i => <article className="integration-row" key={i.id}><div className="integration-icon"><Plug size={23}/></div><div className="integration-copy"><h3>{i.name}</h3><p>{!i.enabled ? '사용 안 함' : i.error ? '연결 확인 필요' : i.checked_ms ? `도구 ${i.tools.length}개 확인됨` : '설정 저장됨 · 연결 확인 전'}</p><span className="field-help">{i.profiles.length ? i.profiles.map(id => snapshot.profiles.find(p => p.id === id)?.name).filter(Boolean).join(', ') : '사용할 Ghost를 선택해 주세요'}</span>{i.error && <p className="form-error"><CircleAlert size={13}/>{i.error}</p>}</div><div className="integration-actions"><button className="button secondary" disabled={busy || !i.enabled} onClick={() => void run({ type: 'check_integration', id: i.id }, '서버의 도구 목록을 확인했습니다. 계정 로그인은 서비스의 안내를 따라 진행하세요.')}><RefreshCw size={14}/>연결 확인</button><button className="button secondary" disabled={!i.tools.length} onClick={() => setTools(i)}>도구 보기</button><button className="icon-button" aria-label={`${i.name} 설정`} onClick={() => setEditor({ item: i })}><Settings2 size={17}/></button><label className="integration-switch"><input type="checkbox" checked={i.enabled} disabled={busy} aria-label={`${i.name} 사용`} onChange={e => void run({ type: 'save_integration', id: i.id, version: i.version, integration: { ...dataFor(i), enabled: e.target.checked } })}/><span>{i.enabled ? '켬' : '끔'}</span></label></div></article>)}</div>
      {!snapshot.integrations.length && <div className="integration-empty"><Plug size={30}/><h2>연결된 도구 없음</h2><p>MCP 서버를 추가해 연결할 수 있습니다.</p></div>}
    </section><section className="integration-start"><div><h2>Google 캘린더와 Tasks</h2><p>Workspace MCP를 설치하고 Google 인증을 설정한 뒤 연결하세요.</p><a href="https://github.com/taylorwilsdon/google_workspace_mcp#quick-start" target="_blank" rel="noreferrer">설치·인증 안내<ArrowUpRight size={14}/></a></div><button className="button secondary" onClick={() => setEditor({ preset: true })}><Plus size={15}/>설정 가져오기</button></section>
    <div className="integration-help"><h3>사용 방법</h3><p>“이번 주 Google 일정 확인해 줘”, “이 일을 Tasks에 추가해 줘”처럼 요청할 수 있습니다. 다른 서비스도 MCP 실행 명령이나 서버 주소로 추가하세요.</p><p>인증 정보는 호스트 환경 변수에서 읽습니다. 로컬 프로그램은 이 컴퓨터에서 실행되며, 선택한 Ghost가 연결된 도구를 사용할 수 있습니다.</p></div>
    {editor && <IntegrationEditor key={editor.item?.id ?? (editor.preset ? 'google' : 'new')} initial={editor.item} preset={editor.preset} snapshot={snapshot} action={action} busy={busy} close={() => setEditor(null)}/>}
    {tools && <Modal title={`${tools.name}의 도구`} onClose={() => setTools(null)}><div className="integration-tool-list"><p className="field-help">도구 설명은 연결한 서버에서 제공합니다.</p>{tools.tools.map(t => <details key={t.name}><summary>{t.name}</summary><p>{t.description || '설명 없음'}</p><pre>{JSON.stringify(t.inputSchema, null, 2)}</pre></details>)}</div>{tools.profiles[0] && <button className="button primary full-width" onClick={() => { setTools(null); navigate(`/ghosts/${tools.profiles[0]}`); }}>Ghost와 대화하기<ArrowUpRight size={15}/></button>}</Modal>}
  </div>;
}
function IntegrationEditor({ initial, preset, snapshot, action, busy, close }: { initial?: Integration; preset?: boolean; snapshot: Snapshot; action: Action; busy: boolean; close: () => void }) {
  const transport = initial?.transport ?? (preset ? google : null);
  const [kind, setKind] = useState<'stdio' | 'http'>(transport?.kind ?? 'stdio'), [profiles, setProfiles] = useState(initial?.profiles ?? snapshot.profiles.map(p => p.id)), [error, setError] = useState('');
  const save = async (form: HTMLFormElement) => {
    setError(''); const data = new FormData(form);
    try {
      let config: IntegrationTransport;
      if (kind === 'stdio') {
        const args = JSON.parse(String(data.get('args') || '[]'));
        if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error('실행 인자는 문자열의 JSON 배열로 입력해 주세요.');
        config = { kind, command: String(data.get('command')).trim(), args, cwd: String(data.get('cwd') || '').trim() || null, env_refs: parseLines(String(data.get('env') || '')) };
      } else config = { kind, url: String(data.get('url')).trim(), bearer_env: String(data.get('bearer') || '').trim() || null };
      await action({ type: 'workspace', action: { type: 'save_integration', id: initial?.id ?? null, version: initial?.version ?? null, integration: { name: String(data.get('name')).trim(), transport: config, profiles, enabled: data.get('enabled') === 'on' } } }); close();
    } catch (e) { setError(e instanceof Error ? e.message : '연동 설정을 저장하지 못했습니다.'); }
  };
  const remove = async () => { if (!initial) return; try { await action({ type: 'workspace', action: { type: 'delete_integration', id: initial.id, version: initial.version } }); close(); } catch (e) { setError(e instanceof Error ? e.message : '연동을 제거하지 못했습니다.'); } };
  return <Modal title={initial ? '연동 설정' : '새 연동'} onClose={() => { if (!busy) close(); }}><form className="form-stack" onSubmit={e => { e.preventDefault(); void save(e.currentTarget); }}>
    {preset && <p className="integration-notice">먼저 <code>uv tool install workspace-mcp</code>로 설치하고 Google OAuth를 설정하세요. 아래에는 비밀 값 대신 호스트 환경 변수 이름을 넣습니다.</p>}
    <label>연동 이름<input name="name" defaultValue={initial?.name ?? (preset ? 'Google 캘린더 · Tasks' : '')} required maxLength={200} placeholder="예: 나의 업무 도구" autoFocus/></label>
    <label>연결 방식<select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="stdio">로컬 프로그램 (stdio)</option><option value="http">서버 주소 (Streamable HTTP)</option></select></label>
    {kind === 'stdio' ? <><label>실행 프로그램<input name="command" required defaultValue={transport?.kind === 'stdio' ? transport.command : ''} placeholder="예: workspace-mcp 또는 /절대/경로/프로그램"/></label><label>실행 인자<textarea name="args" rows={2} defaultValue={transport?.kind === 'stdio' ? JSON.stringify(transport.args) : '[]'} spellCheck={false}/><span className="field-help">JSON 배열로 입력합니다. 예: ["--transport", "stdio"]</span></label><label>환경 변수 연결<textarea name="env" rows={2} defaultValue={transport?.kind === 'stdio' ? Object.entries(transport.env_refs).map(([k,v]) => `${k}=${v}`).join('\n') : ''} placeholder="API_TOKEN=MY_SERVICE_TOKEN" spellCheck={false}/></label><label>작업 폴더 <span className="muted">선택</span><input name="cwd" defaultValue={transport?.kind === 'stdio' ? transport.cwd ?? '' : ''} placeholder="절대 경로"/></label></> : <><label>MCP 주소<input name="url" type="url" required defaultValue={transport?.kind === 'http' ? transport.url : ''} placeholder="https://example.com/mcp"/></label><label>Bearer 토큰 환경 변수 <span className="muted">선택</span><input name="bearer" defaultValue={transport?.kind === 'http' ? transport.bearer_env ?? '' : ''} placeholder="MY_MCP_TOKEN" pattern="[A-Za-z_][A-Za-z0-9_]*"/><span className="field-help">OAuth 로그인이 필요한 서버는 먼저 서버 측 인증 또는 로컬 MCP를 설정하세요.</span></label></>}
    <fieldset className="integration-profiles"><legend>이 연동을 사용할 Ghost</legend>{snapshot.profiles.map(p => <label key={p.id}><input type="checkbox" checked={profiles.includes(p.id)} onChange={e => setProfiles(e.target.checked ? [...profiles, p.id] : profiles.filter(id => id !== p.id))}/>{p.name}</label>)}{!snapshot.profiles.length && <p className="field-help">Ghost를 만든 뒤 이 설정에서 선택해 주세요.</p>}</fieldset>
    <label className="inline-checkbox"><input type="checkbox" name="enabled" defaultChecked={initial?.enabled ?? true}/>이 연동 사용</label>
    {error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions">{initial && <button type="button" className="button secondary" disabled={busy} onClick={() => void remove()}><Trash2 size={15}/>연동 제거</button>}<button className="button primary" disabled={busy}>{busy ? '저장 중…' : '설정 저장'}<Check size={15}/></button></div>
  </form></Modal>;
}
