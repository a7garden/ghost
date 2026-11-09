import { useEffect, useRef, useState } from 'react';
import { FolderPlus, KeyRound, Plus, ShieldCheck, Trash2, Unlock } from 'lucide-react';
import { DEFAULT_BROWSER_PERMISSIONS, DEFAULT_GHOST_PERMISSIONS, browserPermissionsOf, permissionsOf, type Command, type Ghost, type GhostBrowserLogin, type GhostBrowserPermissions, type GhostPermissions } from '@ghost/contract';
import { InlineError, SegmentedControl, SettingsGroup, SettingsRow, Switch } from '../ui';
import { ConfirmDialog } from '../components/ConfirmDialog';

/**
 * 권한: 도구 목록 밖에서 소유자만 넓힐 수 있는 것. 기본은 2026-11-09 이전과 같은 보수적인 값이고,
 * 넓힌 권한도 실행 기록은 그대로 남는다. Ghost 자신(메인 포함)은 바꿀 수 없다.
 */

/**
 * Everything opened at once, for an owner who trusts this Ghost. Mounts stay as they are, and so does the
 * browser: paying or sending without approval and vault logins are each decided on their own (2026-11-09).
 */
export function allGranted(current: GhostPermissions): GhostPermissions {
  return {
    sandbox: { ...current.sandbox, network: true },
    host: { approval: 'never', interpreters: true, privileged: true },
    documents: { autoWrite: true },
    effects: { unknown: 'continue' },
    ...(current.browser ? { browser: current.browser } : {}),
  };
}

/** What 모두 허용 newly opens, in the panel's own words; already-open permissions are left out. Pure; tests pin it. */
export function grantedChanges(current: GhostPermissions): string[] {
  const changes: string[] = [];
  if (!current.sandbox.network) changes.push('맡긴 일에서 인터넷을 씁니다 (내려받기 · 설치 · API 호출).');
  if (current.host.approval !== 'never') changes.push('Mac 명령을 승인 없이 바로 실행합니다.');
  if (!current.host.interpreters) changes.push('sh · bash · python · node 같은 셸 · 인터프리터를 Mac 명령으로 실행합니다.');
  if (!current.host.privileged) changes.push('sudo · ssh · launchctl 같은 관리자 · 원격 명령을 실행합니다.');
  if (!current.documents.autoWrite) changes.push('문서 수정 제안을 검토 없이 바로 저장합니다.');
  if (current.effects.unknown !== 'continue') changes.push('실행 결과를 알 수 없게 되면 멈추지 않고 알리고 계속합니다.');
  return changes;
}

/** A resource field's typed value: a whole number inside its range, or the reason it is not. Pure; tests pin it. */
export function parseResource(raw: string, min: number, max: number): { value: number } | { error: string } {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return { error: `${min}~${max} 사이의 정수를 넣으세요.` };
  const value = Number(text);
  if (value < min || value > max) return { error: `${min}~${max} 사이로 넣으세요.` };
  return { value };
}

/** Back to the defaults, keeping the owner's explicit lists: mounted folders, browser domains and logins. */
export function defaultsKeepingLists(current: GhostPermissions): GhostPermissions {
  const browser = browserPermissionsOf({ permissions: current });
  const lists = browser.domains.length > 0 || browser.logins.length > 0;
  return {
    ...DEFAULT_GHOST_PERMISSIONS,
    sandbox: { ...DEFAULT_GHOST_PERMISSIONS.sandbox, mounts: current.sandbox.mounts },
    ...(lists ? { browser: { ...DEFAULT_BROWSER_PERMISSIONS, domains: browser.domains, logins: browser.logins } } : {}),
  };
}

/** Adds a domain once; a pasted URL or `*.` prefix becomes its hostname. Pure; tests pin it. */
export function addDomain(browser: GhostBrowserPermissions, input: string): GhostBrowserPermissions {
  let host = input.trim().toLowerCase();
  try { if (host.includes('://')) host = new URL(host).hostname; } catch { return browser; }
  host = host.replace(/^\*\./, '').replace(/\.$/, '');
  if (!host || !host.includes('.') || /[^a-z0-9.-]/.test(host) || browser.domains.includes(host)) return browser;
  return { ...browser, domains: [...browser.domains, host] };
}

/** A Shade item id is a UUID (8-4-4-4-12 hex). Pure; tests pin it. */
export function isShadeItemId(input: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.trim().toLowerCase());
}

/** Adds a Shade login once: the item id and the https site it belongs to. Null when the input is not usable. */
export function addLogin(browser: GhostBrowserPermissions, itemId: string, site: string, title: string): GhostBrowserPermissions | null {
  const id = itemId.trim().toLowerCase();
  if (!isShadeItemId(id)) return null;
  const raw = site.trim();
  let origin: string;
  try { origin = new URL(raw.includes('://') ? raw : `https://${raw}`).origin; } catch { return null; }
  if (!origin.startsWith('https://')) return null;
  if (browser.logins.some(login => login.itemId === id)) return browser;
  const login: GhostBrowserLogin = { itemId: id, origin, title: title.trim() || new URL(origin).hostname };
  return { ...browser, logins: [...browser.logins, login] };
}

/**
 * Shade's agent access covers the whole vault for any program the owner's account runs. A Ghost that may run
 * shells on the Mac without approval could read every secret, so the panel warns when both are on.
 */
export function vaultExposed(permissions: GhostPermissions): boolean {
  return browserPermissionsOf({ permissions }).logins.length > 0 && permissions.host.approval === 'never' && permissions.host.interpreters;
}

/** The exact command a permission edit saves. Pure, so tests pin what goes on the wire. */
export function permissionsCommand(ghostId: string, permissions: GhostPermissions): Extract<Command, { type: 'ghost.permissions_update' }> {
  return { type: 'ghost.permissions_update', ghostId, permissions };
}

/** Adds a folder once; a trailing slash is not a different folder. Pure; tests pin it. */
export function addMount(permissions: GhostPermissions, path: string, writable: boolean): GhostPermissions {
  const clean = path.trim().replace(/\/+$/, '') || path.trim();
  if (!clean || permissions.sandbox.mounts.some(mount => mount.path === clean)) return permissions;
  return { ...permissions, sandbox: { ...permissions.sandbox, mounts: [...permissions.sandbox.mounts, { path: clean, writable }] } };
}

/** Whether anything is wider than the defaults; the panel heading says so. */
export function widened(permissions: GhostPermissions): boolean {
  const { browser, ...rest } = permissions;
  return JSON.stringify(rest) !== JSON.stringify(DEFAULT_GHOST_PERMISSIONS) || JSON.stringify(browser ?? DEFAULT_BROWSER_PERMISSIONS) !== JSON.stringify(DEFAULT_BROWSER_PERMISSIONS);
}

export function PermissionsPanel({ ghost, save, saving, error }: { ghost: Ghost; save(command: Command): Promise<boolean>; saving: boolean; error?: string }) {
  const stored = permissionsOf(ghost);
  // Optimistic like the tool board: controls move at once, the stored value catches up through the snapshot.
  const [shown, setShown] = useState(stored);
  const storedKey = JSON.stringify(stored);
  useEffect(() => setShown(JSON.parse(storedKey) as GhostPermissions), [storedKey]);
  const [folder, setFolder] = useState('');
  const [domain, setDomain] = useState('');
  const [login, setLogin] = useState({ itemId: '', site: '', title: '' });
  const [granting, setGranting] = useState<string[] | null>(null);
  const browser = browserPermissionsOf({ permissions: shown });
  const setBrowser = (patch: Partial<GhostBrowserPermissions>) => commit({ ...shown, browser: { ...browser, ...patch } });
  const nextLogin = addLogin(browser, login.itemId, login.site, login.title);
  const loginIdError = login.itemId.trim() && !isShadeItemId(login.itemId) ? '항목 ID는 0193a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b처럼 36자입니다.' : '';
  // One save at a time: each carries the whole permission set, so an overlapping save would carry a failed
  // widening with it. A failure rolls back to the newest stored value, not the one captured at click time.
  const latest = useRef(stored);
  latest.current = stored;
  const inFlight = useRef(false);
  const commit = (next: GhostPermissions) => {
    if (inFlight.current) return Promise.resolve(false);
    inFlight.current = true;
    setShown(next);
    return save(permissionsCommand(ghost.id, next))
      .then(ok => { if (!ok) setShown(latest.current); return ok; })
      .finally(() => { inFlight.current = false; });
  };
  const set = <K extends keyof GhostPermissions>(key: K, patch: Partial<GhostPermissions[K]>) => commit({ ...shown, [key]: { ...shown[key], ...patch } });
  const mounts = shown.sandbox.mounts;
  const opening = grantedChanges(shown);

  return <SettingsGroup title={widened(shown) ? '권한 · 넓힘' : '권한'} className="ghost-panel">
    {error && <div className="permissions__error"><InlineError>{error}</InlineError></div>}
    <SettingsRow label="한 번에 정하기" description="믿는 Ghost라면 모두 허용하세요. 실행 기록은 그대로 남습니다. 연결한 폴더는 바뀌지 않습니다.">
      <span className="permissions__quick">
        <button type="button" className="sandbox-strip__action" disabled={saving || !opening.length} onClick={() => setGranting(opening)}><Unlock aria-hidden="true"/>모두 허용</button>
        <button type="button" className="sandbox-strip__action" disabled={saving || !widened(shown)} onClick={() => commit(defaultsKeepingLists(shown))}><ShieldCheck aria-hidden="true"/>기본으로</button>
      </span>
    </SettingsRow>

    <SettingsRow label="인터넷" htmlFor={`net-${ghost.id}`} description="맡긴 일에서 내려받기 · 설치 · API 호출을 합니다. 진행 중인 일에는 다음 명령부터 적용됩니다.">
      <Switch id={`net-${ghost.id}`} checked={shown.sandbox.network} disabled={saving} onCheckedChange={network => set('sandbox', { network })}/>
    </SettingsRow>

    <SettingsRow label="연결한 폴더" description="맡긴 일에서 같은 경로로 보입니다. 쓰기를 끄면 읽기만 합니다.">
      <div className="permissions__mounts">
        {mounts.map((mount, index) => <div key={mount.path} className="permissions__mount">
          <code className="truncate" title={mount.path}>{mount.path}</code>
          <label className="permissions__write"><Switch checked={mount.writable} disabled={saving} aria-label={`${mount.path} 쓰기`}
            onCheckedChange={writable => set('sandbox', { mounts: mounts.map((item, at) => at === index ? { ...item, writable } : item) })}/>쓰기</label>
          <button type="button" className="sandbox-strip__action" aria-label={`${mount.path} 연결 해제`} disabled={saving}
            onClick={() => set('sandbox', { mounts: mounts.filter((_, at) => at !== index) })}><Trash2 aria-hidden="true"/></button>
        </div>)}
        {mounts.length < 8 && <form className="permissions__add" onSubmit={event => { event.preventDefault(); const next = addMount(shown, folder, true); if (next !== shown) { commit(next); setFolder(''); } }}>
          <input aria-label="연결할 폴더 경로" placeholder="/Users/나/Workspace/Projects/앱" value={folder} onChange={event => setFolder(event.target.value)}/>
          <button type="submit" className="sandbox-strip__action" disabled={saving || !folder.trim()}><FolderPlus aria-hidden="true"/>추가</button>
        </form>}
      </div>
    </SettingsRow>

    <SettingsRow label="샌드박스 자원" description="CPU 개수 · 메모리(GiB)">
      <span className="permissions__resources">
        <ResourceInput label="CPU 개수" min={1} max={16} value={shown.sandbox.cpus} onCommit={cpus => set('sandbox', { cpus })}/>
        <ResourceInput label="메모리 GiB" min={1} max={64} value={shown.sandbox.memoryGiB} onCommit={memoryGiB => set('sandbox', { memoryGiB })}/>
      </span>
    </SettingsRow>

    <SettingsRow label="Mac 명령" description="바로 실행하면 묻지 않고 실행하고 결과를 기록합니다. 「Mac 명령 제안」 도구가 켜져 있어야 합니다.">
      <SegmentedControl aria-label="Mac 명령 승인" value={shown.host.approval} onValueChange={approval => set('host', { approval })}
        options={[{ value: 'always', label: '매번 승인' }, { value: 'never', label: '바로 실행' }]}/>
    </SettingsRow>
    <SettingsRow label="셸 · 인터프리터" htmlFor={`interp-${ghost.id}`} description="sh · bash · python · node · bun 같은 프로그램을 Mac 명령으로 실행합니다.">
      <Switch id={`interp-${ghost.id}`} checked={shown.host.interpreters} disabled={saving} onCheckedChange={interpreters => set('host', { interpreters })}/>
    </SettingsRow>
    <SettingsRow label="관리자 · 원격 명령" htmlFor={`priv-${ghost.id}`} description="sudo · ssh · launchctl 같은 프로그램입니다.">
      <Switch id={`priv-${ghost.id}`} checked={shown.host.privileged} disabled={saving} onCheckedChange={privileged => set('host', { privileged })}/>
    </SettingsRow>

    <SettingsRow label="문서 저장" htmlFor={`docs-${ghost.id}`} description="제안을 검토 없이 바로 저장합니다. 문서 공간에서 제안 권한이 있어야 합니다.">
      <Switch id={`docs-${ghost.id}`} checked={shown.documents.autoWrite} disabled={saving} onCheckedChange={autoWrite => set('documents', { autoWrite })}/>
    </SettingsRow>

    <SettingsRow label="결과를 모를 때" description="재시작 등으로 실행 결과를 알 수 없게 된 경우입니다. 어느 쪽이든 다시 실행하지 않습니다.">
      <SegmentedControl aria-label="결과를 모를 때" value={shown.effects.unknown} onValueChange={unknown => set('effects', { unknown })}
        options={[{ value: 'block', label: '멈추고 확인' }, { value: 'continue', label: '알리고 계속' }]}/>
    </SettingsRow>

    <SettingsRow label="결제 · 전송 클릭" description="결제 · 보내기 · 예약 · 게시 · 계정 변경처럼 바깥에 영향이 가는 클릭입니다. 바로 실행해도 기록은 남습니다. 「브라우저」 도구가 켜져 있어야 합니다.">
      <SegmentedControl aria-label="결제 · 전송 클릭 승인" value={browser.commit} onValueChange={value => setBrowser({ commit: value })}
        options={[{ value: 'always', label: '매번 승인' }, { value: 'never', label: '바로 실행' }]}/>
    </SettingsRow>

    <SettingsRow label="브라우저 사이트" description="비워 두면 공개된 사이트 어디서나 누르고 입력합니다. 넣으면 그 사이트와 하위 주소에서만 합니다. 페이지가 몰래 부르는 다른 주소까지 막지는 못합니다.">
      <div className="permissions__mounts">
        {browser.domains.map(host => <div key={host} className="permissions__mount">
          <code className="truncate" title={host}>{host}</code>
          <button type="button" className="sandbox-strip__action" aria-label={`${host} 빼기`} disabled={saving}
            onClick={() => setBrowser({ domains: browser.domains.filter(item => item !== host) })}><Trash2 aria-hidden="true"/></button>
        </div>)}
        {browser.domains.length < 32 && <form className="permissions__add" onSubmit={event => { event.preventDefault(); const next = addDomain(browser, domain); if (next !== browser) { setBrowser({ domains: next.domains }); setDomain(''); } }}>
          <input aria-label="허용할 사이트" placeholder="shop.example.com" value={domain} onChange={event => setDomain(event.target.value)}/>
          <button type="submit" className="sandbox-strip__action" disabled={saving || !domain.trim()}><Plus aria-hidden="true"/>추가</button>
        </form>}
      </div>
    </SettingsRow>

    <SettingsRow label="금고 로그인" description="Shade에 저장한 계정 중 이 Ghost가 쓸 것을 고릅니다. Ghost는 비밀번호를 보지 못하고 그 사이트에서만 로그인합니다. 항목 ID는 Shade 앱의 계정 정보에 있습니다.">
      <div className="permissions__mounts">
        {browser.logins.map(item => <div key={item.itemId} className="permissions__mount">
          <KeyRound aria-hidden="true" size={13}/>
          <span className="truncate" title={`${item.origin} · ${item.itemId}`}>{item.title} <code>{item.origin}</code></span>
          <button type="button" className="sandbox-strip__action" aria-label={`${item.title} 로그인 빼기`} disabled={saving}
            onClick={() => setBrowser({ logins: browser.logins.filter(entry => entry.itemId !== item.itemId) })}><Trash2 aria-hidden="true"/></button>
        </div>)}
        {browser.logins.length < 32 && <form className="permissions__add permissions__add--login" onSubmit={event => { event.preventDefault(); if (nextLogin && nextLogin !== browser) { setBrowser({ logins: nextLogin.logins }); setLogin({ itemId: '', site: '', title: '' }); } }}>
          <input aria-label="Shade 항목 ID" placeholder="항목 ID" value={login.itemId} aria-invalid={!!loginIdError || undefined} aria-describedby={`shade-id-${ghost.id}`}
            spellCheck={false} onChange={event => setLogin({ ...login, itemId: event.target.value })}/>
          <input aria-label="로그인할 사이트" placeholder="https://shop.example.com" value={login.site} onChange={event => setLogin({ ...login, site: event.target.value })}/>
          <input aria-label="이름" placeholder="이름 (선택)" value={login.title} onChange={event => setLogin({ ...login, title: event.target.value })}/>
          <button type="submit" className="sandbox-strip__action" disabled={saving || !nextLogin || nextLogin === browser}><Plus aria-hidden="true"/>추가</button>
          <p id={`shade-id-${ghost.id}`} className="permissions__hint" data-invalid={loginIdError ? true : undefined}>
            {loginIdError || '항목 ID는 Shade 앱의 계정 정보에 있는 36자 고유 번호입니다. 비밀번호가 아니라 그 계정을 가리킵니다.'}
          </p>
        </form>}
        {vaultExposed(shown) && <p className="permissions__warning" role="alert">이 Ghost는 Mac에서 셸을 승인 없이 실행할 수 있어 Shade 금고 전체를 읽을 수 있습니다. 금고 로그인을 주려면 「Mac 명령」을 「매번 승인」으로 두거나 「셸 · 인터프리터」를 끄세요.</p>}
      </div>
    </SettingsRow>
    {granting && <ConfirmDialog title={`${ghost.name} 권한 모두 허용`} confirmLabel="모두 허용" onClose={() => setGranting(null)}
      onConfirm={async () => { if (!await commit(allGranted(shown))) throw new Error('권한을 바꾸지 못했습니다. 다시 시도해 주세요.'); }}>
      <p>이렇게 바뀝니다.</p>
      <ul className="permissions__changes">{granting.map(line => <li key={line}>{line}</li>)}</ul>
      <p>각 권한은 해당 도구가 켜져 있을 때만 쓰입니다. 연결한 폴더와 브라우저 설정은 그대로이고, 실행 기록은 그대로 남습니다.</p>
    </ConfirmDialog>}
  </SettingsGroup>;
}

/**
 * A number field that saves when the owner is done: on leaving it or Enter, never per keystroke, and never
 * disabled under the cursor. Escape puts back the stored value; an out-of-range value says why and is not saved.
 */
function ResourceInput({ label, min, max, value, onCommit }: { label: string; min: number; max: number; value: number; onCommit(value: number): void }) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  // A new stored value (or a rollback) shows unless the owner is mid-edit; an invalid draft stays with its reason.
  useEffect(() => { if (!focused.current) setDraft(String(value)); }, [value]);
  const parsed = parseResource(draft, min, max);
  const reason = 'error' in parsed ? parsed.error : '';
  const commit = () => { if ('value' in parsed && parsed.value !== value) onCommit(parsed.value); };
  return <span className="permissions__resource">
    <input type="number" inputMode="numeric" aria-label={label} min={min} max={max} value={draft} aria-invalid={!!reason || undefined}
      onFocus={() => { focused.current = true; }} onChange={event => setDraft(event.target.value)}
      onBlur={() => { focused.current = false; commit(); }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') { event.preventDefault(); setDraft(String(value)); }
      }}/>
    {reason && <small className="permissions__invalid" role="alert">{label}: {reason}</small>}
  </span>;
}
