import { Fragment, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, Package, Plug, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import type { Command, Integration, IntegrationTransport, Snapshot } from '../client/types';
import { MobilePairing } from './MobilePairing';
import { ghostPath, viewPath, type PackageMap } from './PackageWorkspace';
import './connections.css';

type Action = (command: Command) => Promise<Record<string, any>>;
const google: IntegrationTransport = { kind: 'stdio', command: 'workspace-mcp', args: ['--transport', 'stdio', '--tools', 'calendar', 'tasks'], env_refs: { GOOGLE_OAUTH_CLIENT_ID: 'GOOGLE_OAUTH_CLIENT_ID', GOOGLE_OAUTH_CLIENT_SECRET: 'GOOGLE_OAUTH_CLIENT_SECRET' }, cwd: null };
const presets = {
  planner: { name: 'Google 캘린더 · Tasks', transport: google },
  gmail: { name: 'Gmail', transport: { ...google, args: ['--transport', 'stdio', '--tools', 'gmail'] } },
};
type Preset = keyof typeof presets;
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
const dataFor = (i: Integration, supportsApprovals: boolean) => ({
  name: i.name, transport: i.transport, profiles: i.profiles, enabled: i.enabled,
  ...(supportsApprovals ? { approved_tools: i.approved_tools } : {}),
});
const checkedTime = new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function integrationCatalogStatus(item: Pick<Integration, 'enabled' | 'error' | 'checked_ms' | 'tools'>) {
  if (!item.enabled) return { tone: 'neutral', label: '사용 안 함' };
  if (item.error) return { tone: 'danger', label: '확인 실패' };
  if (item.checked_ms) return { tone: 'success', label: `도구 목록 확인 · ${item.tools.length}개` };
  return { tone: 'neutral', label: '설정 저장됨' };
}

type IntegrationProps = {
  snapshot: Snapshot;
  action: Action;
  busy: boolean;
  mode: 'demo' | 'live';
  navigate: (path: string) => void;
  connected?: boolean;
  packages?: PackageMap;
  packageError?: string;
  onImport?: () => void;
  onRefreshPackages?: () => void;
};

export function Integrations({ snapshot, action, busy, mode, navigate, connected = true, packages, packageError, onImport, onRefreshPackages }: IntegrationProps) {
  const [editor, setEditor] = useState<{ item?: Integration; preset?: Preset } | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [tools, setTools] = useState<Integration | null>(null);
  const [checking, setChecking] = useState(''), [pairingOpened, setPairingOpened] = useState(false);
  const supportsApprovals = snapshot.capabilities.integration_approvals === true;
  const locked = busy || !connected;
  const installed = Object.entries(packages ?? {}).flatMap(([id, item]) => {
    const profile = snapshot.profiles.find(profile => profile.id === id);
    return profile ? [{ profile, item }] : [];
  });
  const currentTools = tools && snapshot.integrations.find(item => item.id === tools.id);
  const staleTools = Boolean(tools && currentTools?.version !== tools.version);
  const run = async (command: Record<string, unknown>, success = '') => {
    if (locked) return;
    setError(''); setNotice('');
    try { await action({ type: 'workspace', action: command }); setNotice(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '연동 설정을 저장하지 못했습니다.'); }
  };
  const check = async (id: string) => {
    if (checking || locked || mode !== 'live') return;
    setChecking(id);
    try { await run({ type: 'check_integration', id }, 'MCP 도구 목록을 확인했습니다.'); }
    finally { setChecking(''); }
  };

  return <div className="page-content integrations-page connections-stack">
    <div className="page-heading"><h1>확장</h1></div>
    {mode === 'demo' && <p className="connection-message">예시 모드입니다. 실제 연결은 로컬 호스트에서 실행됩니다.</p>}
    {!connected && <p className="connection-message" role="status">호스트에 연결하면 설정을 변경할 수 있습니다.</p>}
    {error && <p className="connection-message connection-message--error" role="alert">{error}</p>}
    {notice && <p className="connection-message" role="status">{notice}</p>}

    <section className="connection-section" aria-labelledby="mcp-heading">
      <div className="connection-heading"><h2 id="mcp-heading">MCP 도구</h2>
        <button className="button primary" disabled={locked} onClick={() => setEditor({})}><Plus size={16}/>MCP 추가</button>
      </div>
      {snapshot.integrations.length ? <ul className="connection-surface connection-list" role="list">
        {snapshot.integrations.map(item => {
          const status = integrationCatalogStatus(item);
          const assigned = item.profiles.map(id => snapshot.profiles.find(profile => profile.id === id)?.name).filter(Boolean).join(', ');
          const permission = !supportsApprovals || item.approved_tools == null
            ? '기존 실행 경로'
            : item.approved_tools.length ? `승인 요청 가능 · ${item.approved_tools.length}개` : '도구 사용 차단';
          return <li className="connection-row connection-mcp" key={item.id}>
            <span className="connection-icon"><Plug size={17} aria-hidden="true"/></span>
            <div className="connection-row-copy">
              <div className="connection-row-title"><h3>{item.name}</h3><span className="connection-status" data-tone={status.tone}>{status.label}</span></div>
              <p>Ghost <span className="connection-value">{assigned || '미지정'}</span><span aria-hidden="true"> · </span>{permission}</p>
              <p>{item.checked_ms
                ? <>최근 확인 <time dateTime={new Date(item.checked_ms).toISOString()}>{checkedTime.format(item.checked_ms)}</time></>
                : '도구 목록 확인 전'}</p>
              {item.error && <p className="connection-row-error">{item.error}</p>}
            </div>
            <div className="connection-actions">
              <button className="button secondary" disabled={locked || Boolean(checking) || !item.enabled || mode !== 'live'} onClick={() => void check(item.id)}>
                <RefreshCw size={14}/>{checking === item.id ? '확인 중…' : '목록 확인'}
              </button>
              <button className="button secondary" disabled={busy || (!supportsApprovals && !item.tools.length)} onClick={() => setTools(item)}>
                {supportsApprovals ? '도구 권한' : '도구 보기'}
              </button>
              <button className="icon-button" disabled={locked} aria-label={`${item.name} 설정`} onClick={() => setEditor({ item })}><Settings2 size={17}/></button>
              <label className="integration-switch">
                <input type="checkbox" checked={item.enabled} disabled={locked} aria-label={`${item.name} 사용`}
                  onChange={event => void run({ type: 'save_integration', id: item.id, version: item.version,
                    integration: { ...dataFor(item, supportsApprovals), enabled: event.target.checked } })}/>
                <span>{item.enabled ? '켬' : '끔'}</span>
              </label>
            </div>
          </li>;
        })}
      </ul> : <div className="connection-surface connection-row connection-empty">
        <span className="connection-icon"><Plug size={17} aria-hidden="true"/></span><p>등록된 MCP 도구가 없습니다.</p>
      </div>}
    </section>

    {(packages || packageError || onImport) && <section className="connection-section" aria-labelledby="installed-packages-heading">
      <div className="connection-heading"><h2 id="installed-packages-heading">.ghost 패키지</h2>
        {onImport && <button className="button secondary" disabled={locked} onClick={onImport}><Plus size={16}/>가져오기</button>}
      </div>
      {packageError && <p className="connection-message connection-message--error" role="alert">{packageError}{onRefreshPackages && <button className="text-button" onClick={onRefreshPackages}>다시 확인</button>}</p>}
      {installed.length ? <ul className="connection-surface connection-list" role="list">
        {installed.map(({ profile, item }) => <li className="connection-row connection-package" key={profile.id}>
          <span className="connection-icon"><Package size={17} aria-hidden="true"/></span>
          <div className="connection-row-copy">
            <div className="connection-row-title"><h3>{item.name}</h3><span className="connection-status">{item.version}</span></div>
            <p>Ghost <span className="connection-value">{profile.name}</span></p>
            {item.ui?.views.length ? <ul className="connection-views" role="list" aria-label={`${item.name} 화면`}>
              {item.ui.views.map(view => <li key={view.id}><a href={`#${viewPath(profile.id, view.id)}`}>{view.label}</a></li>)}
            </ul> : <p>전용 화면 없음</p>}
          </div>
          <button className="button secondary" onClick={() => navigate(ghostPath(profile.id))}>Ghost 열기<ArrowUpRight size={14}/></button>
        </li>)}
      </ul> : !packageError && <div className="connection-surface connection-row connection-empty" role="status">
        <span className="connection-icon"><Package size={17} aria-hidden="true"/></span>
        <p>{packages ? '설치된 .ghost 패키지가 없습니다.' : '설치된 패키지를 불러오는 중…'}</p>
      </div>}
    </section>}

    <div className="connection-secondary">
      <details className="connection-disclosure">
        <summary><span>MCP 설정 예시</span><ChevronDown size={16} aria-hidden="true"/></summary>
        <div className="connection-disclosure-body">
          <p className="field-help">로컬 프로그램은 이 Mac에서 실행합니다. 인증에는 비밀 값 대신 호스트 환경 변수 이름을 사용합니다.</p>
          <div className="connection-preset"><div><h3>Google 캘린더 · Tasks</h3>
            <a href="https://github.com/taylorwilsdon/google_workspace_mcp#quick-start" target="_blank" rel="noreferrer">설치·인증 안내<ArrowUpRight size={13}/></a>
          </div><button className="button secondary" disabled={locked} onClick={() => setEditor({ preset: 'planner' })}>설정 사용</button></div>
          {supportsApprovals && <div className="connection-preset"><div><h3>Gmail</h3>
            <p className="field-help">도구 권한에서 <code>send_gmail_message</code>를 선택하면 Ghost가 발송 승인을 요청할 수 있습니다.</p>
            <a href="https://github.com/taylorwilsdon/google_workspace_mcp#quick-start" target="_blank" rel="noreferrer">설치·인증 안내<ArrowUpRight size={13}/></a>
          </div><button className="button secondary" disabled={locked} onClick={() => setEditor({ preset: 'gmail' })}>설정 사용</button></div>}
        </div>
      </details>
      <details className="connection-disclosure" onToggle={event => { if (event.currentTarget.open) setPairingOpened(true); }}>
        <summary><span>휴대폰 연결</span><ChevronDown size={16} aria-hidden="true"/></summary>
        {pairingOpened && <fieldset className="connection-fieldset connection-disclosure-body connection-pairing" disabled={!connected}>
          <MobilePairing mode={mode} connected={connected} profiles={snapshot.profiles}/>
        </fieldset>}
      </details>
    </div>

    {editor && <IntegrationEditor key={editor.item?.id ?? editor.preset ?? 'new'} initial={editor.item} preset={editor.preset}
      snapshot={snapshot} action={action} busy={busy} connected={connected} close={() => setEditor(null)}/>}
    {tools && <IntegrationTools item={staleTools ? tools : currentTools ?? tools} supportsApprovals={supportsApprovals}
      action={action} busy={busy} connected={connected} stale={staleTools}
      close={() => setTools(null)} openGhost={id => { setTools(null); navigate(ghostPath(id)); }}/>}
  </div>;
}
function IntegrationTools({ item, supportsApprovals, action, busy, connected, stale, close, openGhost }: {
  item: Integration;
  supportsApprovals: boolean;
  action: Action;
  busy: boolean;
  connected: boolean;
  stale: boolean;
  close: () => void;
  openGhost: (id: string) => void;
}) {
  const [selected, setSelected] = useState(item.approved_tools ?? []);
  const [error, setError] = useState('');
  const locked = busy || !connected || stale;
  const legacy = item.approved_tools == null;
  const unavailable = selected.filter(name => !item.tools.some(tool => tool.name === name));
  const changed = legacy || selected.length !== item.approved_tools?.length
    || selected.some(name => !item.approved_tools?.includes(name));

  const save = async () => {
    if (locked || !changed || unavailable.length) return;
    setError('');
    try {
      await action({ type: 'workspace', action: {
        type: 'save_integration', id: item.id, version: item.version,
        integration: { ...dataFor(item, true), approved_tools: selected },
      } });
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : '도구 권한을 저장하지 못했습니다.');
    }
  };
  const toggle = (name: string, checked: boolean) => {
    setSelected(current => checked ? [...current, name] : current.filter(value => value !== name));
  };

  return <Modal title={`${item.name}의 도구`} onClose={() => { if (!busy) close(); }}>
    {supportsApprovals && <p className="field-help">
      {legacy
        ? '이 연결은 기존 실행 경로에서 직접 실행을 허용합니다. 승인 방식으로 전환하면 선택한 도구만 실행을 요청할 수 있습니다.'
        : '선택한 도구는 Ghost가 실행을 요청할 수 있습니다. 요청마다 소유자의 승인이 필요합니다.'}
      {' '}선택을 비워 두면 Ghost의 도구 사용이 차단됩니다.
    </p>}
    {stale && <p className="field-help" role="status">설정이 변경됐습니다. 최신 도구 권한을 다시 열어 주세요.</p>}
    <div className="integration-tool-list">
      {item.tools.length === 0 && <p>목록을 확인한 뒤 도구를 선택할 수 있습니다.</p>}
      {item.tools.map(tool => <div className="integration-tool" key={tool.name}>
        {supportsApprovals && <label className="inline-checkbox">
          <input type="checkbox" checked={selected.includes(tool.name)} disabled={locked}
            onChange={e => toggle(tool.name, e.target.checked)}/><code>{tool.name}</code>
        </label>}
        <details>
          <summary aria-label={supportsApprovals ? `${tool.name} 설명 및 입력 형식` : undefined}>{supportsApprovals ? '설명 및 입력 형식' : tool.name}</summary>
          <p>{tool.description || '설명 없음'}</p>
          <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
        </details>
      </div>)}
      {supportsApprovals && unavailable.map(name => <label className="inline-checkbox" key={name}>
        <input type="checkbox" checked disabled={locked} onChange={() => toggle(name, false)}/>
        <code>{name}</code><span className="muted">현재 도구 목록에 없음</span>
      </label>)}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {supportsApprovals
      ? <button className="button primary full-width" disabled={locked || !changed || unavailable.length > 0} onClick={() => void save()}>
        {legacy ? '승인 방식으로 전환' : '도구 권한 저장'}<Check size={15}/>
      </button>
      : item.profiles[0] && <button className="button primary full-width" onClick={() => openGhost(item.profiles[0])}>
        Ghost와 대화하기<ArrowUpRight size={15}/>
      </button>}
  </Modal>;
}

function IntegrationEditor({ initial, preset, snapshot, action, busy, connected, close }: { initial?: Integration; preset?: Preset; snapshot: Snapshot; action: Action; busy: boolean; connected: boolean; close: () => void }) {
  const presetConfig = preset ? presets[preset] : undefined;
  const transport = initial?.transport ?? presetConfig?.transport;
  const approvalConfig = snapshot.capabilities.integration_approvals === true
    ? { approved_tools: initial ? initial.approved_tools : [] }
    : {};
  const [kind, setKind] = useState<'stdio' | 'http'>(transport?.kind ?? 'stdio'), [profiles, setProfiles] = useState(initial?.profiles ?? snapshot.profiles.map(p => p.id)), [error, setError] = useState('');
  const stale = Boolean(initial && snapshot.integrations.find(item => item.id === initial.id)?.version !== initial.version);
  const locked = busy || !connected || stale;
  const save = async (form: HTMLFormElement) => {
    if (locked) return;
    setError(''); const data = new FormData(form);
    try {
      let config: IntegrationTransport;
      if (kind === 'stdio') {
        const args = JSON.parse(String(data.get('args') || '[]'));
        if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error('실행 인자는 문자열의 JSON 배열로 입력해 주세요.');
        config = { kind, command: String(data.get('command')).trim(), args, cwd: String(data.get('cwd') || '').trim() || null, env_refs: parseLines(String(data.get('env') || '')) };
      } else config = { kind, url: String(data.get('url')).trim(), bearer_env: String(data.get('bearer') || '').trim() || null };
      await action({ type: 'workspace', action: { type: 'save_integration', id: initial?.id ?? null, version: initial?.version ?? null, integration: { ...approvalConfig, name: String(data.get('name')).trim(), transport: config, profiles, enabled: data.get('enabled') === 'on' } } }); close();
    } catch (e) { setError(e instanceof Error ? e.message : '연동 설정을 저장하지 못했습니다.'); }
  };
  const remove = async () => { if (!initial || locked) return; try { await action({ type: 'workspace', action: { type: 'delete_integration', id: initial.id, version: initial.version } }); close(); } catch (e) { setError(e instanceof Error ? e.message : '연동을 제거하지 못했습니다.'); } };
  return <Modal title={initial ? '연동 설정' : '새 연동'} onClose={() => { if (!busy) close(); }}><form className="form-stack" onSubmit={e => { e.preventDefault(); void save(e.currentTarget); }}>
    {stale && <p className="field-help" role="status">설정이 변경됐습니다. 최신 설정을 다시 열어 주세요.</p>}
    <fieldset className="connection-fieldset form-stack" disabled={locked}>
    {preset && <p className="integration-notice">먼저 <code>uv tool install workspace-mcp</code>로 설치하고 Google OAuth를 설정하세요. 아래에는 비밀 값 대신 호스트 환경 변수 이름을 넣습니다.</p>}
    <label>연동 이름<input name="name" defaultValue={initial?.name ?? presetConfig?.name ?? ''} required maxLength={200} placeholder="예: 나의 업무 도구" autoFocus/></label>
    <label>연결 방식<select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="stdio">로컬 프로그램 (stdio)</option><option value="http">서버 주소 (Streamable HTTP)</option></select></label>
    {kind === 'stdio' ? <Fragment key="stdio"><label>실행 프로그램<input name="command" required defaultValue={transport?.kind === 'stdio' ? transport.command : ''} placeholder="예: workspace-mcp 또는 /절대/경로/프로그램"/></label><label>실행 인자<textarea name="args" rows={2} defaultValue={transport?.kind === 'stdio' ? JSON.stringify(transport.args) : '[]'} spellCheck={false}/><span className="field-help">JSON 배열로 입력합니다. 예: ["--transport", "stdio"]</span></label><label>환경 변수 연결<textarea name="env" rows={2} defaultValue={transport?.kind === 'stdio' ? Object.entries(transport.env_refs).map(([k,v]) => `${k}=${v}`).join('\n') : ''} placeholder="API_TOKEN=MY_SERVICE_TOKEN" spellCheck={false}/></label><label>작업 폴더 <span className="muted">선택</span><input name="cwd" defaultValue={transport?.kind === 'stdio' ? transport.cwd ?? '' : ''} placeholder="절대 경로"/></label></Fragment> : <Fragment key="http"><label>MCP 주소<input name="url" type="url" required defaultValue={transport?.kind === 'http' ? transport.url : ''} placeholder="https://example.com/mcp"/></label><label>Bearer 토큰 환경 변수 <span className="muted">선택</span><input name="bearer" defaultValue={transport?.kind === 'http' ? transport.bearer_env ?? '' : ''} placeholder="MY_MCP_TOKEN" pattern="[A-Za-z_][A-Za-z0-9_]*"/><span className="field-help">OAuth 로그인이 필요한 서버는 먼저 서버 측 인증 또는 로컬 MCP를 설정하세요.</span></label></Fragment>}
    <fieldset className="integration-profiles"><legend>이 연동을 사용할 Ghost</legend>{snapshot.profiles.map(p => <label key={p.id}><input type="checkbox" checked={profiles.includes(p.id)} onChange={e => setProfiles(e.target.checked ? [...profiles, p.id] : profiles.filter(id => id !== p.id))}/>{p.name}</label>)}{!snapshot.profiles.length && <p className="field-help">Ghost를 만든 뒤 이 설정에서 선택해 주세요.</p>}</fieldset>
    <label className="inline-checkbox"><input type="checkbox" name="enabled" defaultChecked={initial?.enabled ?? true}/>이 연동 사용</label>
    {error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions">{initial && <button type="button" className="button secondary" disabled={busy} onClick={() => void remove()}><Trash2 size={15}/>연동 제거</button>}<button className="button primary" disabled={busy}>{busy ? '저장 중…' : '설정 저장'}<Check size={15}/></button></div>
    </fieldset>
  </form></Modal>;
}
