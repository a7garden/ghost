import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { QrCode, Smartphone } from 'lucide-react';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
type Scope = { kind: 'lifetime'; ghost_ids: string[]; conversation_ids: string[]; capabilities: string[] };
type Claim = { claim_id: string; device_name: string; verification_code: string; device_fingerprint: string; status: string };
type Invitation = {
  invitation_id: string; origin: string; expires_at: string; scope: Scope;
  status: 'open' | 'pending' | 'approved' | 'cancelled' | 'expired' | 'revoked'; claim?: Claim;
};
type Attempt = { request_id: string; code: string; ticket: string; code_digest: string; ticket_digest: string };
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));

function invitationNonce() {
  const timestamp = Date.now().toString(16).padStart(12, '0');
  const random = crypto.randomUUID().split('-');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random[2].slice(1)}-${random[3]}-${random[4]}`;
}

async function makeAttempt(): Promise<Attempt> {
  const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => alphabet[byte & 31]).join('');
  const ticket = hex(crypto.getRandomValues(new Uint8Array(32)));
  return { request_id: invitationNonce(), code, ticket, code_digest: await digest(code), ticket_digest: await digest(ticket) };
}

function invitationResponse(value: unknown): Invitation {
  if (!value || typeof value !== 'object') throw new Error('연결 요청 상태를 확인하지 못했습니다.');
  const item = value as Invitation;
  if (typeof item.invitation_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(item.invitation_id)
      || typeof item.origin !== 'string' || typeof item.expires_at !== 'string'
      || !Number.isFinite(Date.parse(item.expires_at))
      || !['open', 'pending', 'approved', 'cancelled', 'expired', 'revoked'].includes(item.status)
      || item.scope?.kind !== 'lifetime' || !Array.isArray(item.scope.ghost_ids)
      || !Array.isArray(item.scope.conversation_ids) || !Array.isArray(item.scope.capabilities)) {
    throw new Error('연결 요청의 서버·권한을 확인하지 못했습니다.');
  }
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
    super(code === 'invitation_expired' ? '이 연결 요청은 만료되었습니다. 새 요청을 직접 만들어 주세요.' : code);
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
  const response = await fetch(`/ghost-api/mobile/invitations${path}`, {
    method: body ? 'POST' : 'GET', cache: 'no-store', redirect: 'error', signal,
    headers: { 'X-Ghost-UI-CSRF': config.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new OperatorError(typeof value.error === 'string' ? value.error : '연결 요청 결과가 불명확합니다. 같은 요청으로 상태를 확인해 주세요.');
  return value;
}

async function operatorRequest(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<Invitation> {
  return invitationResponse(await operatorJSON(path, body, signal));
}

export function MobilePairing({ mode }: { mode: 'demo' | 'live' }) {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creationExpired, setCreationExpired] = useState(false);
  const [now, setNow] = useState(Date.now());
  const canvas = useRef<HTMLCanvasElement>(null);
  const creation = useRef<Attempt | null>(null);
  const mounted = useRef(true);
  const mutation = useRef<{ invitation: string; action: 'approve' | 'cancel'; request_id: string; claim?: Claim } | null>(null);
  const expires = invitation ? Date.parse(invitation.expires_at) : 0;
  const active = invitation && ['open', 'pending'].includes(invitation.status) && now < expires;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; creation.current = null; mutation.current = null; };
  }, []);
  useEffect(() => {
    if (mode !== 'live') return;
    const controller = new AbortController();
    void operatorJSON('', undefined, controller.signal).then(value => {
      if (!value || typeof value !== 'object' || !('invitations' in value)
          || !Array.isArray(value.invitations)) throw new Error('저장된 연결 요청을 확인하지 못했습니다.');
      const saved = value.invitations.map(invitationResponse);
      // Recovery never manufactures a code or key. Pending claims remain
      // approvable; an open invitation whose secrets were lost must be
      // explicitly cancelled before replacing it.
      const recover = saved.find(item => item.status === 'pending')
        ?? saved.find(item => item.status === 'open');
      if (!controller.signal.aborted && recover && !creation.current) setInvitation(recover);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '연결 요청 상태를 확인하지 못했습니다.');
    });
    return () => controller.abort();
  }, [mode]);
  useEffect(() => {
    if (!invitation || !['open', 'pending'].includes(invitation.status)) return;
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
  }, [invitation?.invitation_id, invitation?.status]);
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
    setBusy(true); setError('');
    try {
      // Keep the same nonce/secrets after an unknown acknowledgement; never
      // mint a second authority merely because the first response was lost.
      const next = creation.current ?? await makeAttempt();
      creation.current = next;
      const observed = await operatorRequest('', {
        request_id: next.request_id, code_digest: next.code_digest, ticket_digest: next.ticket_digest,
      });
      if (!mounted.current) return;
      if (observed.invitation_id !== next.request_id) throw new Error('연결 요청 ID가 일치하지 않습니다.');
      setInvitation(observed); setAttempt(next); setNow(Date.now());
    } catch (reason) {
      if (mounted.current) {
        setError(reason instanceof Error ? reason.message : '연결 요청을 만들지 못했습니다.');
        if (reason instanceof OperatorError && reason.code === 'invitation_expired') setCreationExpired(true);
      }
    }
    finally { if (mounted.current) setBusy(false); }
  };
  const change = async (action: 'approve' | 'cancel') => {
    if (!invitation || (action === 'approve' && !invitation.claim)) return;
    setBusy(true); setError('');
    const previous = mutation.current;
    const request = previous?.invitation === invitation.invitation_id && previous.action === action
      ? previous : { invitation: invitation.invitation_id, action, request_id: crypto.randomUUID(), claim: invitation.claim };
    mutation.current = request;
    try {
      await operatorJSON(`/${request.invitation}/${action}`, {
        request_id: request.request_id,
        ...(action === 'approve' ? { claim_id: request.claim!.claim_id, verification_code: request.claim!.verification_code } : {}),
      });
      const observed = await operatorRequest(`/${request.invitation}`);
      if (mounted.current) { setInvitation(observed); mutation.current = null; }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '기기의 연결 상태를 확인하지 못했습니다.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const terminal = invitation && (!active || !['open', 'pending'].includes(invitation.status));

  return <section className="mobile-pairing integration-start" aria-labelledby="mobile-pairing-heading">
    <div className="mobile-pairing-copy">
      <h2 id="mobile-pairing-heading"><Smartphone size={19}/>휴대폰 연결</h2>
      <p>iPhone의 Ghost에서 QR을 스캔하세요. 같은 네트워크에서는 짧은 코드로도 연결할 수 있습니다.</p>
      <p className="field-help">기기 키는 QR에 들어가지 않습니다. 휴대폰에 표시된 확인 번호가 같을 때만 이 PC에서 연결을 승인하세요.</p>
      {!invitation && <button className="button secondary" disabled={busy || mode !== 'live' || creationExpired} onClick={() => void create()}><QrCode size={16}/>{creation.current ? '같은 연결 요청 확인' : 'QR·연결 코드 만들기'}</button>}
      {!invitation && creationExpired && <button className="button secondary" disabled={busy} onClick={() => { creation.current = null; setCreationExpired(false); setError(''); }}>만료된 요청 지우고 새 연결 준비</button>}
      {mode !== 'live' && <p className="field-help">실행 중인 PC Ghost에서만 기기를 연결할 수 있습니다.</p>}
      {invitation && <>
        <p className="mobile-pairing-origin">{invitation.origin}</p>
        <p className="field-help">주 Ghost 1개 · 대화 읽기·쓰기 · 만료 {new Date(invitation.expires_at).toLocaleTimeString('ko-KR')}</p>
        {active && invitation.status === 'open' && attempt && <div className="mobile-pairing-invite">
          <canvas ref={canvas} aria-label="Ghost 휴대폰 연결 QR" width={256} height={256}/>
          <div><span className="field-help">같은 네트워크의 연결 코드</span><output className="mobile-pairing-code">{attempt.code.slice(0, 4)}-{attempt.code.slice(4)}</output><p>{Math.max(0, Math.ceil((expires - now) / 1000))}초 뒤 만료</p></div>
        </div>}
        {active && invitation.status === 'open' && !attempt && <p role="status">저장된 연결 요청이 있습니다. QR·코드는 다시 만들지 않습니다. 이 요청을 취소한 뒤 새 요청을 만들어 주세요.</p>}
        {active && invitation.status === 'pending' && invitation.claim && <div className="mobile-pairing-claim">
          <strong>{invitation.claim.device_name}</strong>
          <p>휴대폰과 같은 확인 번호인지 확인하세요.</p>
          <output className="mobile-pairing-code">{invitation.claim.verification_code}</output>
          <p className="field-help">기기 확인 {invitation.claim.device_fingerprint}</p>
          <button className="button primary" disabled={busy} onClick={() => void change('approve')}>숫자가 같아요 · 이 기기 연결 승인</button>
        </div>}
        {active && <button className="button secondary" disabled={busy} onClick={() => void change('cancel')}>이 연결 요청 취소</button>}
        {terminal && <p role="status">{invitation.status === 'approved' ? '기기 접근을 승인했습니다. 휴대폰에서 연결 상태를 확인하세요.' : invitation.status === 'revoked' ? '이 기기의 연결 권한이 해제되었습니다.' : invitation.status === 'cancelled' ? '연결 요청을 취소했습니다.' : '연결 요청이 만료되었습니다.'}</p>}
        {terminal && <button className="button secondary" disabled={busy} onClick={() => { setInvitation(null); setAttempt(null); creation.current = null; mutation.current = null; }}>{invitation.status === 'approved' ? '다른 휴대폰 연결 준비' : '새 연결 요청 준비'}</button>}
      </>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
  </section>;
}
