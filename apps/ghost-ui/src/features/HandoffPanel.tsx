import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { CircleCheck, KeyRound, Lock, Monitor } from 'lucide-react';
import type { BrowserHandoff, BrowserLoginShelf, Decision, LoginChoice, ShadeLogin } from '@ghost/contract';
import { Button, InlineError } from '../ui';
import { useHost } from '../host/context';
import { BrowserLiveView } from './BrowserLiveView';
import { BrowserPaneContext } from './BrowserPaneContext';
import './HandoffPanel.css';

const SHELF_POLL_MS = 2000;
const FILLED_MS = 2500;

type Field = 'username' | 'password' | 'totp';
const fieldLabel: Record<Field, string> = { username: '아이디', password: '비밀번호', totp: '인증 코드' };

/** Where the handoff page lives, without the scheme; falls back to the text when the URL does not parse. */
export function handoffHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** The line under the login shelf, or null: what happened to the login the owner just completed. */
export function savedLine(saved: NonNullable<BrowserLoginShelf['saved']>): string {
  return `${saved.created ? '로그인 정보를 금고에 저장했어요' : '저장된 로그인으로 로그인했어요'} · ${saved.username || handoffHost(saved.origin)}${saved.shade ? ' · Shade에도 저장' : ''}`;
}

/** Why Shade offers nothing, in the owner's terms; null when Shade is ready or absent. */
export function shadeHint(shelf: BrowserLoginShelf): string | null {
  if (shelf.items.length > 0 || shelf.shade.items.length > 0) return null;
  const { state } = shelf.shade.status;
  return state === 'locked' ? 'Shade 잠금을 풀면 저장된 로그인을 쓸 수 있어요' : state === 'agent_off' ? 'Shade에서 에이전트 접근을 켜 주세요' : null;
}

/**
 * The page the owner is on while a Ghost waits: the saved logins for this very site, one tap per field into the
 * focused page field, Shade logins to bring along, and a line when the Host has saved the login the owner completed.
 * The shelf is metadata; typing a value goes Host → page and never through this component.
 */
function useLoginShelf(conversationId: string, enabled: boolean) {
  const { client } = useHost();
  const [shelf, setShelf] = useState<BrowserLoginShelf | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        // The card works without the shelf: a Host without Shade, or a stream that has not started, is not an error here.
        try { const next = await client.browserLogin(conversationId); if (!disposed) setShelf(next); } catch { /* keep the last shelf */ }
      }
      if (!disposed) timer = setTimeout(() => void tick(), SHELF_POLL_MS);
    };
    void tick();
    return () => { disposed = true; clearTimeout(timer); };
  }, [client, conversationId, enabled, refreshTick]);
  const refresh = useCallback(() => setRefreshTick(value => value + 1), []);
  return { shelf, refresh };
}

export function HandoffPanel({ decision, handoff, busy }: { decision: Decision; handoff: BrowserHandoff; busy: boolean }) {
  const { client } = useHost();
  const browserPane = useContext(BrowserPaneContext);
  const pending = decision.state === 'pending';
  const { shelf, refresh } = useLoginShelf(decision.conversationId, pending);
  const [filled, setFilled] = useState<Record<string, true>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState('');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer); }, []);

  const fill = async (item: LoginChoice, field: Field) => {
    const key = `${item.id}:${field}`;
    setWorking(key); setError('');
    try {
      await client.browserFill(decision.conversationId, { itemId: item.id, field });
      setFilled(prev => ({ ...prev, [key]: true }));
      timers.current.push(setTimeout(() => setFilled(prev => { const { [key]: _done, ...rest } = prev; return rest; }), FILLED_MS));
    } catch (reason) { setError(reason instanceof Error ? reason.message : '입력하지 못했어요.'); }
    finally { setWorking(null); }
  };
  const bringIn = async (item: ShadeLogin) => {
    setWorking(`shade:${item.id}`); setError('');
    try { await client.importShadeLogin(decision.conversationId, item.id); refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Shade에서 가져오지 못했어요.'); }
    finally { setWorking(null); }
  };

  const host = handoffHost(shelf?.origin ?? handoff.url ?? '');
  const hint = shelf ? shadeHint(shelf) : null;
  const logins = pending && handoff.live && shelf ? shelf : null;
  return <div className="handoff">
    {/* The live view's own bar names the page; only the Mac window needs the site said. */}
    {!handoff.live && <p className="handoff__site">
      <Monitor size={14} aria-hidden="true"/>
      <span className="handoff__host">{host || 'Mac의 Chrome 창'}</span>
      <span className="handoff__where">Mac의 Chrome 창에서 마무리해 주세요</span>
    </p>}
    {handoff.reason.trim() && handoff.reason.trim() !== decision.detail.trim() && <p className="decision__request-reason">{handoff.reason}</p>}

    {logins && (logins.items.length > 0 || logins.shade.items.length > 0) && <ul className="handoff__logins" aria-label="이 사이트의 저장된 로그인">
      {logins.items.map(item => <li key={item.id} className="handoff__login">
        <KeyRound size={14} aria-hidden="true"/>
        <span className="handoff__who">{item.username || item.title}</span>
        <span className="handoff__fields" role="group" aria-label={`${item.username || item.title} 입력`}>
          {([['username', Boolean(item.username)], ['password', item.hasPassword], ['totp', item.hasTotp]] as const).filter(([, has]) => has).map(([field]) => {
            const key = `${item.id}:${field}`;
            return <button key={field} type="button" className="handoff__chip" data-done={filled[key] || undefined}
              disabled={busy || working !== null} aria-label={`${item.username || item.title} ${fieldLabel[field]} 입력`}
              onClick={() => void fill(item, field)}>{filled[key] ? '입력함' : fieldLabel[field]}</button>;
          })}
        </span>
      </li>)}
      {logins.shade.items.map(item => <li key={item.id} className="handoff__login" data-source="shade">
        <KeyRound size={14} aria-hidden="true"/>
        <span className="handoff__who">{item.username || item.title}<span className="handoff__source">Shade</span></span>
        <span className="handoff__fields">
          <button type="button" className="handoff__chip" disabled={busy || working !== null} aria-label={`${item.username || item.title} Shade에서 가져오기`}
            onClick={() => void bringIn(item)}>{working === `shade:${item.id}` ? '가져오는 중…' : '가져오기'}</button>
        </span>
      </li>)}
    </ul>}
    {pending && handoff.live && hint && <p className="handoff__hint"><Lock size={13} aria-hidden="true"/>{hint}</p>}
    {error && <InlineError>{error}</InlineError>}
    {pending && shelf?.saved && <p className="handoff__saved" role="status"><CircleCheck size={15} aria-hidden="true"/>{savedLine(shelf.saved)}</p>}

    {pending && handoff.live && (browserPane?.conversationId === decision.conversationId
      ? <Button type="button" variant="outline" className="h-[34px] justify-self-start rounded-pill px-4" disabled={busy} onClick={browserPane.open}>브라우저 화면 열기</Button>
      : <BrowserLiveView conversationId={decision.conversationId} compact/>)}
  </div>;
}
