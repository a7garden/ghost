import { useEffect, useId, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Button, Checkbox, InlineError } from '@garden/ui';
import { QrCode, Smartphone } from 'lucide-react';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const maxTargets = 16;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type TargetPair = { ghost_id: string; conversation_id: string };
type PairingTarget = TargetPair & { kind: 'primary' | 'specialist'; roles: string[]; name?: string };
type Scope = { kind: 'lifetime'; ghost_ids: string[]; conversation_ids: string[]; capabilities: string[]; targets?: TargetPair[] };
type PairingProfile = { id: string; name: string };
const pairKey = (target: TargetPair) => `${target.ghost_id}/${target.conversation_id}`;
const validPair = (item: unknown): item is TargetPair => {
  const pair = item as Partial<TargetPair> | null;
  return Boolean(pair && typeof pair.ghost_id === 'string' && uuid.test(pair.ghost_id)
    && typeof pair.conversation_id === 'string' && uuid.test(pair.conversation_id));
};

function invitationTargets(scope: Scope): TargetPair[] {
  // The preceding protocol issued only a single canonical pair. The two ID
  // lists cannot be joined to reconstruct an exact multi-Ghost grant.
  const targets = scope.targets === undefined && scope.ghost_ids.length === 1 && scope.conversation_ids.length === 1
    ? [{ ghost_id: scope.ghost_ids[0], conversation_id: scope.conversation_ids[0] }]
    : scope.targets;
  if (!Array.isArray(targets) || !targets.length || targets.length > maxTargets || !targets.every(validPair)
    || new Set(targets.map(target => target.ghost_id)).size !== targets.length
    || new Set(targets.map(target => target.conversation_id)).size !== targets.length
    || !sameIDs(scope.ghost_ids, targets.map(target => target.ghost_id))
    || !sameIDs(scope.conversation_ids, targets.map(target => target.conversation_id))) {
    throw new Error('휴대폰이 접근할 Ghost 대화 범위를 확인하지 못했습니다.');
  }
  return targets;
}

function sameIDs(ids: string[], expected: string[]) {
  const unique = new Set(expected);
  return ids.length === unique.size && new Set(ids).size === ids.length && ids.every(id => unique.has(id));
}

function targetCatalog(value: unknown): PairingTarget[] {
  if (!value || typeof value !== 'object' || !('targets' in value) || !Array.isArray(value.targets)) {
    throw new Error('연결할 수 있는 Ghost 목록을 읽지 못했습니다.');
  }
  const targets: PairingTarget[] = value.targets;
  if (!targets.every(item => validPair(item) && (item.kind === 'primary' || item.kind === 'specialist')
    && Array.isArray(item.roles) && item.roles.every(role => typeof role === 'string')
    && (item.name === undefined || typeof item.name === 'string'))
    || new Set(targets.map(pairKey)).size !== targets.length) throw new Error('등록된 Ghost 대화 정보를 확인하지 못했습니다.');
  return targets;
}
type Claim = { claim_id: string; device_name: string; verification_code: string; device_fingerprint: string; status: string };
type Invitation = {
  invitation_id: string; origin: string; expires_at: string; scope: Scope;
  status: 'open' | 'pending' | 'approved' | 'cancelled' | 'expired' | 'revoked'; claim?: Claim;
};
type Attempt = { request_id: string; code: string; ticket: string; code_digest: string; ticket_digest: string; targets: TargetPair[] };
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));

function invitationNonce() {
  const timestamp = Date.now().toString(16).padStart(12, '0');
  const random = crypto.randomUUID().split('-');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random[2].slice(1)}-${random[3]}-${random[4]}`;
}

async function makeAttempt(targets: TargetPair[]): Promise<Attempt> {
  const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => alphabet[byte & 31]).join('');
  const ticket = hex(crypto.getRandomValues(new Uint8Array(32)));
  return { request_id: invitationNonce(), code, ticket, code_digest: await digest(code), ticket_digest: await digest(ticket), targets };
}

function invitationResponse(value: unknown): Invitation {
  if (!value || typeof value !== 'object') throw new Error('연결 요청 상태를 확인하지 못했습니다.');
  const item = value as Invitation;
  if (typeof item.invitation_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(item.invitation_id)
      || typeof item.origin !== 'string' || typeof item.expires_at !== 'string'
      || !Number.isFinite(Date.parse(item.expires_at))
      || !['open', 'pending', 'approved', 'cancelled', 'expired', 'revoked'].includes(item.status)
      || item.scope?.kind !== 'lifetime' || !Array.isArray(item.scope.ghost_ids)
      || !Array.isArray(item.scope.conversation_ids) || !Array.isArray(item.scope.capabilities)
      || !sameIDs(item.scope.capabilities, ['lifetime.read', 'lifetime.write'])) {
    throw new Error('연결 요청의 서버·권한을 확인하지 못했습니다.');
  }
  invitationTargets(item.scope);
  let origin: URL;
  try { origin = new URL(item.origin); } catch { throw new Error('HTTPS 연결 주소를 확인하지 못했습니다.'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('HTTPS 연결 주소를 확인하지 못했습니다.');
  }
  if (item.claim && (typeof item.claim.claim_id !== 'string' || typeof item.claim.device_name !== 'string'
      || !/^\d{6}$/.test(item.claim.verification_code) || typeof item.claim.device_fingerprint !== 'string')) {
    throw new Error('승인할 기기의 확인 정보를 읽지 못했습니다.');
  }
  return item;
}

class OperatorError extends Error {
  constructor(readonly code: string) {
    super({
      invitation_expired: '이 연결 요청은 만료되었습니다. 새 요청을 직접 만들어 주세요.',
      invitation_stale_scope: '등록된 Ghost 대화 범위가 바뀌었습니다. 현재 Ghost를 확인하고 새 연결을 준비하세요.',
      pairing_scope_unavailable: '현재 연결할 수 있는 Ghost 대화를 확인하지 못했습니다.',
      invitation_conflict: '이 연결 요청과 서버 기록이 일치하지 않습니다. 저장된 요청을 먼저 확인하세요.',
    }[code] ?? code);
  }
}

// CSRF 토큰은 브리지 세션당 고정(randomBytes at startup)이므로 마운트당 한 번만
// bootstrap을 읽고 재사용한다. 회전으로 인한 403은 상태 폴링의 오류 배너로 드러난다.
let pairingBootstrap: Promise<{ mode: string; csrf: string }> | undefined;
async function pairingConfig(signal?: AbortSignal): Promise<{ mode: string; csrf: string }> {
  pairingBootstrap ??= fetch('/ghost-api/bootstrap', { cache: 'no-store', redirect: 'error', signal })
    .then(async bootstrap => {
      const config = await bootstrap.json();
      if (!bootstrap.ok || config.mode !== 'live' || typeof config.csrf !== 'string') throw new Error('실행 중인 PC Ghost에 연결해 주세요.');
      return config;
    })
    .catch(error => { pairingBootstrap = undefined; throw error; });
  return pairingBootstrap;
}

async function operatorJSON(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  // Reuse the existing same-origin UI bootstrap/CSRF convention; no Host or
  // device credential crosses this browser boundary.
  const config = await pairingConfig(signal);
  const response = await fetch(`/ghost-api/mobile${path}`, {
    method: body ? 'POST' : 'GET', cache: 'no-store', redirect: 'error', signal,
    headers: { 'X-Ghost-UI-CSRF': config.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (response.status === 403) pairingBootstrap = undefined;
  if (!response.ok) throw new OperatorError(typeof value.error === 'string' ? value.error : '연결 요청 결과가 불명확합니다. 같은 요청으로 상태를 확인해 주세요.');
  return value;
}

async function operatorRequest(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<Invitation> {
  return invitationResponse(await operatorJSON(`/invitations${path}`, body, signal));
}

export function MobilePairing({ mode, connected = true, profiles = [] }: {
  mode: 'demo' | 'live'; connected?: boolean; profiles?: PairingProfile[];
}) {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<PairingTarget[]>();
  const [selectedKeys, setSelectedKeys] = useState<string[]>();
  const [setupReady, setSetupReady] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [creationExpired, setCreationExpired] = useState(false);
  const [scopeMismatch, setScopeMismatch] = useState(false);
  const [now, setNow] = useState(Date.now());
  const canvas = useRef<HTMLCanvasElement>(null);
  const creation = useRef<Attempt | null>(null);
  const mounted = useRef(true);
  const online = useRef(connected);
  online.current = connected;
  const submitting = useRef(false);
  const mutation = useRef<{ invitation: string; action: 'approve' | 'cancel'; request_id: string; claim?: Claim } | null>(null);
  const expires = invitation ? Date.parse(invitation.expires_at) : 0;
  const active = invitation && ['open', 'pending'].includes(invitation.status) && now < expires;
  const locked = busy || !connected;
  const defaultTarget = catalog?.find(item => item.kind === 'primary') ?? catalog?.[0];
  const pickedKeys = selectedKeys ?? (defaultTarget ? [pairKey(defaultTarget)] : []);
  const picked = catalog?.filter(item => pickedKeys.includes(pairKey(item))) ?? [];
  const approvedTargets = invitation ? invitationTargets(invitation.scope) : [];
  const scopeIsCurrent = Boolean(!scopeMismatch && catalog && approvedTargets.every(pair => catalog.some(item => pairKey(item) === pairKey(pair))));
  const canStart = Boolean(mode === 'live' && !locked && !creationExpired
    && (creation.current || (setupReady && picked.length && picked.length <= maxTargets)));
  const targetLabel = (pair: TargetPair, index: number) => {
    const target = catalog?.find(item => pairKey(item) === pairKey(pair));
    return profiles.find(profile => profile.id === pair.ghost_id)?.name.trim()
      || target?.name?.trim()
      || (target?.roles.length ? target.roles.join(' · ') : `Ghost ${index + 1}`);
  };
  const refresh = () => {
    setSetupReady(false); setCatalog(undefined); setSetupError('');
    setReload(value => value + 1);
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; creation.current = null; mutation.current = null; };
  }, []);
  useEffect(() => {
    setSetupReady(false); setCatalog(undefined); setSetupError('');
    if (mode !== 'live' || !connected) return;
    const controller = new AbortController();
    const loadTargets = operatorJSON('/targets', undefined, controller.signal).then(targetCatalog).then(targets => {
      if (!controller.signal.aborted) setCatalog(targets);
    });
    const recoverInvitation = operatorJSON('/invitations', undefined, controller.signal).then(value => {
      if (!value || typeof value !== 'object' || !('invitations' in value)
          || !Array.isArray(value.invitations)) throw new Error('저장된 연결 요청을 확인하지 못했습니다.');
      const saved = value.invitations.map(invitationResponse);
      // A pending claim can be recovered; lost QR secrets cannot be recreated.
      const recover = saved.find(item => item.status === 'pending') ?? saved.find(item => item.status === 'open');
      if (!controller.signal.aborted && recover && !creation.current) setInvitation(current => current ?? recover);
    });
    void Promise.all([loadTargets, recoverInvitation]).then(() => {
      if (!controller.signal.aborted) setSetupReady(true);
    }).catch(reason => {
      if (!controller.signal.aborted) setSetupError(reason instanceof Error ? reason.message : '휴대폰 연결 정보를 읽지 못했습니다.');
    });
    return () => controller.abort();
  }, [mode, connected, reload]);
  useEffect(() => {
    if (!connected || !invitation || !['open', 'pending'].includes(invitation.status)) return;
    setNow(Date.now());
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const observed = await operatorRequest(`/${invitation.invitation_id}`, undefined, controller.signal);
        if (!controller.signal.aborted) { setInvitation(observed); setError(''); }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '연결 요청의 상태를 확인하지 못했습니다.');
      }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 1500);
    };
    timer = window.setTimeout(poll, 1000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { controller.abort(); clearTimeout(timer); clearInterval(clock); };
  }, [connected, invitation?.invitation_id, invitation?.status]);
  useEffect(() => {
    if (!invitation || !active) {
      if (invitation) { creation.current = null; setAttempt(null); }
      return;
    }
    if (!attempt || !canvas.current || invitation.status !== 'open') return;
    const uri = new URL('ghost://connect');
    uri.searchParams.set('v', '1');
    uri.searchParams.set('origin', invitation.origin);
    uri.searchParams.set('invitation', invitation.invitation_id);
    uri.searchParams.set('ticket', attempt.ticket);
    void QRCode.toCanvas(canvas.current, uri.toString(), { errorCorrectionLevel: 'M', width: 256, margin: 4 })
      .catch(() => setError('QR을 그리지 못했습니다. 같은 네트워크의 연결 코드를 사용해 주세요.'));
  }, [invitation?.invitation_id, invitation?.status, invitation?.origin, attempt, active]);

  const create = async () => {
    if (!canStart || submitting.current) return;
    submitting.current = true;
    setBusy(true); setError('');
    try {
      // Keep the same nonce/secrets after an unknown acknowledgement; never
      // mint a second authority merely because the first response was lost.
      const next = creation.current ?? await makeAttempt(picked.map(({ ghost_id, conversation_id }) => ({ ghost_id, conversation_id })));
      if (!mounted.current || !online.current) return;
      creation.current = next;
      const observed = await operatorRequest('', {
        request_id: next.request_id, code_digest: next.code_digest, ticket_digest: next.ticket_digest, targets: next.targets,
      });
      if (!mounted.current) return;
      if (observed.invitation_id !== next.request_id) throw new Error('연결 요청 ID가 일치하지 않습니다.');
      if (!sameIDs(invitationTargets(observed.scope).map(pairKey), next.targets.map(pairKey))) {
        // Do not reveal a QR for a scope other than the one the owner chose.
        setScopeMismatch(true);
        setInvitation(observed);
        setNow(Date.now());
        return;
      }
      setInvitation(observed); setAttempt(next); setNow(Date.now());
    } catch (reason) {
      if (mounted.current) {
        setError(reason instanceof Error ? reason.message : '연결 요청을 만들지 못했습니다.');
        if (reason instanceof OperatorError) {
          if (reason.code === 'invitation_expired') setCreationExpired(true);
          if (reason.code === 'invitation_stale_scope') {
            creation.current = null;
            refresh();
          }
        }
      }
    }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  };
  const change = async (action: 'approve' | 'cancel') => {
    if (!invitation || !active || mode !== 'live' || locked || submitting.current || (action === 'approve' && (!invitation.claim || !scopeIsCurrent))) return;
    submitting.current = true;
    setBusy(true); setError('');
    const previous = mutation.current;
    const request = previous?.invitation === invitation.invitation_id && previous.action === action
      ? previous : { invitation: invitation.invitation_id, action, request_id: crypto.randomUUID(), claim: invitation.claim };
    mutation.current = request;
    try {
      await operatorJSON(`/invitations/${request.invitation}/${action}`, {
        request_id: request.request_id,
        ...(action === 'approve' ? { claim_id: request.claim!.claim_id, verification_code: request.claim!.verification_code } : {}),
      });
      const observed = await operatorRequest(`/${request.invitation}`);
      if (mounted.current) { setInvitation(observed); mutation.current = null; }
    } catch (reason) {
      if (!mounted.current) return;
      setError(reason instanceof Error ? reason.message : '기기의 연결 상태를 확인하지 못했습니다.');
      if (reason instanceof OperatorError && reason.code === 'invitation_stale_scope') refresh();
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const terminal = invitation && (!active || !['open', 'pending'].includes(invitation.status));

  const headingId = useId();

  return <section aria-labelledby={headingId} className="min-w-0">
    <div className="flex min-w-0 flex-col gap-3">
      <h2 id={headingId} className="inline-flex items-center gap-2 text-body font-medium"><Smartphone size={16} aria-hidden="true"/>휴대폰 연결</h2>
      <p className="text-caption text-ink-2">iPhone의 Ghost에서 QR을 스캔하거나 같은 네트워크의 연결 코드를 입력하세요.</p>
      {!invitation && mode === 'live' && <>
        {catalog?.length ? <fieldset className="flex min-w-0 flex-col gap-1 border-0 p-0" disabled={locked || Boolean(creation.current)}>
          <legend className="mb-1 text-caption text-ink-2">휴대폰에서 사용할 Ghost</legend>
          {catalog.map((target, index) => {
            const key = pairKey(target), checked = pickedKeys.includes(key);
            return <label className="inline-flex items-center gap-2 py-0.5 text-ui" key={key}>
              <Checkbox checked={checked} disabled={!checked && picked.length >= maxTargets}
                onCheckedChange={checked => setSelectedKeys(checked === true ? [...picked.map(pairKey), key] : picked.map(pairKey).filter(value => value !== key))}/>
              <span>{targetLabel(target, index)}</span>
            </label>;
          })}
        </fieldset> : setupReady && <p className="text-caption text-ink-2">연결할 수 있는 활성 Ghost가 없습니다.</p>}
        {!setupReady && !setupError && connected && <p role="status" className="text-caption text-ink-2">등록된 Ghost를 확인하는 중…</p>}
        <div><Button type="button" variant="outline" disabled={!canStart} onClick={() => void create()}><QrCode size={16}/>{creation.current ? '같은 연결 요청 확인' : 'QR·연결 코드 만들기'}</Button></div>
      </>}
      {!invitation && creationExpired && <div><Button type="button" variant="outline" disabled={locked} onClick={() => { creation.current = null; setCreationExpired(false); setError(''); }}>만료된 요청 지우고 새 연결 준비</Button></div>}
      {mode !== 'live' && <p className="text-caption text-ink-2">실행 중인 PC Ghost에서만 기기를 연결할 수 있습니다.</p>}
      {invitation && <>
        <p className="font-mono text-ui [overflow-wrap:anywhere]">{invitation.origin}</p>
        <p className="text-caption text-ink-2">대화·맡긴 일 읽기 및 변경 · 만료 {new Date(invitation.expires_at).toLocaleTimeString('ko-KR')}</p>
        <ul role="list" aria-label="휴대폰에 허용할 Ghost" className="flex flex-wrap gap-1.5">
          {approvedTargets.map((target, index) => <li key={pairKey(target)} className="inline-flex items-center rounded-chip bg-inset px-2 py-0.5 text-caption">{targetLabel(target, index)}</li>)}
        </ul>
        {scopeMismatch && <InlineError>선택한 Ghost와 서버 연결 범위가 다릅니다. 연결 요청을 취소하세요.</InlineError>}
        {active && invitation.status === 'open' && attempt && <div className="flex flex-wrap items-center gap-4">
          <canvas ref={canvas} aria-label="Ghost 휴대폰 연결 QR" width={256} height={256} className="h-auto w-64 max-w-full"/>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-caption text-ink-2">같은 네트워크의 연결 코드</span>
            <output className="text-body font-semibold tracking-widest">{attempt.code.slice(0, 4)}-{attempt.code.slice(4)}</output>
            <p className="text-caption text-ink-2">{Math.max(0, Math.ceil((expires - now) / 1000))}초 뒤 만료</p>
          </div>
        </div>}
        {active && invitation.status === 'open' && !attempt && <p role="status" className="text-ui">저장된 연결 요청이 있습니다. QR·코드는 다시 만들지 않습니다. 이 요청을 취소한 뒤 새 요청을 만들어 주세요.</p>}
        {active && invitation.status === 'pending' && invitation.claim && <div className="flex min-w-0 flex-col gap-2 rounded-card bg-inset p-3">
          <strong className="text-ui">{invitation.claim.device_name}</strong>
          <p className="text-caption text-ink-2">휴대폰과 같은 확인 번호인지 확인하세요.</p>
          <output className="text-headingSm font-semibold tracking-widest">{invitation.claim.verification_code}</output>
          <p className="text-caption text-ink-2">기기 확인 {invitation.claim.device_fingerprint}</p>
          {catalog && !scopeIsCurrent && <p role="status" className="text-caption text-ink-2">선택한 Ghost 범위가 바뀌었습니다. 요청을 취소하고 새로 연결하세요.</p>}
          <div><Button type="button" disabled={locked || !scopeIsCurrent} onClick={() => void change('approve')}>숫자가 같아요 · 이 기기 연결 승인</Button></div>
        </div>}
        {active && <div><Button type="button" variant="outline" disabled={locked} onClick={() => void change('cancel')}>이 연결 요청 취소</Button></div>}
        {terminal && <p role="status" className="text-ui">{invitation.status === 'approved' ? '기기 접근을 승인했습니다. 휴대폰에서 연결 상태를 확인하세요.' : invitation.status === 'revoked' ? '이 기기의 연결 권한이 해제되었습니다.' : invitation.status === 'cancelled' ? '연결 요청을 취소했습니다.' : '연결 요청이 만료되었습니다.'}</p>}
        {terminal && <div><Button type="button" variant="outline" disabled={locked} onClick={() => { setInvitation(null); setAttempt(null); setSelectedKeys(undefined); setScopeMismatch(false); setCreationExpired(false); setError(''); creation.current = null; mutation.current = null; refresh(); }}>{invitation.status === 'approved' ? '다른 휴대폰 연결 준비' : '새 연결 요청 준비'}</Button></div>}
      </>}
      {setupError && <InlineError onRetry={refresh} retryLabel="다시 확인">{setupError}</InlineError>}
      {error && <InlineError>{error}</InlineError>}
    </div>
  </section>;
}
