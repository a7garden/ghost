import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, LoaderCircle } from 'lucide-react';
import { Button, InlineError } from '../ui';
import { Modal } from '../components/Modal';
import { useHost } from '../host/context';
import type { OAuthStatus, Provider } from '@ghost/contract';

const POLL_MS = 1000;

const message = (reason: unknown) => reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.';

/** 인증 페이지 주소는 https일 때만 링크로 연다. */
const verificationLink = (uri: string | null) => {
  try { return uri && new URL(uri).protocol === 'https:' ? uri : null; } catch { return null; }
};

/** ChatGPT 기기 로그인. 코드를 보여 주고 완료·실패까지 1초 간격으로 확인하며, 인증 정보는 이 UI를 거치지 않는다. */
export function ChatGptLoginDialog({ provider, onClose }: { provider: Provider; onClose(): void }) {
  const { client } = useHost();
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const stateRef = useRef<OAuthStatus['state'] | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const teardown = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(false);
  const apply = (next: OAuthStatus) => { stateRef.current = next.state; setStatus(next); };

  useEffect(() => {
    let alive = true;
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (ms: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      timer = setTimeout(resolve, ms);
      return promise;
    };
    let current: OAuthStatus | null = null;
    const start = (async () => {
      await teardown.current;
      if (!alive) return null;
      return client.startOAuth(provider.id);
    })();
    const run = async () => {
      stateRef.current = null;
      setStatus(null); setStarting(true); setError(''); setCopied(false);
      try { current = await start; }
      catch (reason) { if (alive) { setStarting(false); setError(message(reason)); } return; }
      if (!alive || !current) return;
      apply(current); setStarting(false);
      // 직전 요청이 끝난 뒤에만 다음 확인을 예약한다. 느린 응답이 겹치지 않는다.
      while (current.state === 'pending') {
        await wait(POLL_MS);
        if (!alive) return;
        try { current = await client.oauthStatus(provider.id); }
        catch (reason) { if (alive) setError(message(reason)); return; }
        if (!alive) return;
        apply(current);
      }
    };
    void run();
    return () => {
      alive = false;
      mounted.current = false;
      clearTimeout(timer);
      clearTimeout(copyTimer.current);
      // 대기 중 세션은 화면이 닫히면 서버에서도 취소한다. 완료·실패 뒤에는 그대로 둔다.
      teardown.current = (async () => {
        const last = current ?? await start.catch(() => null);
        if (last?.state === 'pending') await client.cancelOAuth(provider.id).catch(() => {});
      })();
    };
  }, [client, provider.id, attempt]);

  const cancel = async () => {
    if (cancelling) return;
    setCancelling(true); setError('');
    try {
      const next = await client.cancelOAuth(provider.id);
      if (!mounted.current) return;
      apply(next); onClose();
    } catch (reason) {
      if (!mounted.current) return;
      setError(message(reason)); setCancelling(false);
    }
  };

  const requestClose = () => {
    if (cancelling) return;
    if (stateRef.current === 'pending') void cancel();
    else onClose();
  };

  const copyCode = async () => {
    if (!status?.userCode) return;
    try {
      await navigator.clipboard.writeText(status.userCode);
      if (!mounted.current) return;
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch { /* 클립보드가 막힌 환경에서는 코드를 직접 선택해 복사한다. */ }
  };

  const uri = status ? verificationLink(status.verificationUri) : null;
  const remainingMinutes = status ? Math.ceil((status.expiresAt - Date.now()) / 60000) : 0;
  const failed = status?.state === 'failed' || status?.state === 'cancelled';
  return <Modal title="ChatGPT 로그인" onClose={requestClose} className="w-[min(480px,calc(100vw-2rem))] sm:max-w-[480px]">
    <div className="flex flex-col gap-4">
      <p className="m-0 text-ui text-ink-2">ChatGPT 구독으로 인증합니다. API 키를 대신 쓰려면 제공자 편집에서 입력할 수 있습니다.</p>
      {starting && <p className="m-0 flex items-center gap-2 text-ui text-ink-2" role="status">
        <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true"/>로그인 세션을 만드는 중…
      </p>}
      {status?.state === 'pending' && <div className="flex flex-col gap-3">
        {status.userCode && <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="min-w-0 font-mono text-xl font-semibold tracking-[0.3em] text-ink [overflow-wrap:anywhere]">{status.userCode}</span>
          <Button className="flex-none" variant="outline" size="sm" type="button" onClick={() => void copyCode()}>
            {copied ? <Check size={13} className="text-success"/> : <Copy size={13}/>}{copied ? '복사됨' : '코드 복사'}
          </Button>
        </div>}
        {uri && <div className="flex flex-wrap items-center gap-3">
          <Button asChild><a href={uri} target="_blank" rel="noopener noreferrer">인증 페이지 열기<ExternalLink size={14}/></a></Button>
          <span className="text-caption text-ink-3">{remainingMinutes > 0 ? `코드는 약 ${remainingMinutes}분 후 만료됩니다.` : undefined}</span>
        </div>}
        <p className="m-0 text-caption text-ink-3" role="status">인증 페이지에서 코드를 입력하면 여기에 결과가 표시됩니다.</p>
      </div>}
      {status?.state === 'done' && <p className="m-0 flex items-start gap-2 text-ui text-success" role="status">
        <Check size={15} className="mt-0.5 flex-none" aria-hidden="true"/>ChatGPT 로그인을 완료했습니다. 인증 정보가 저장되었습니다.
      </p>}
      {(error || failed) && <InlineError pending={starting || cancelling} onRetry={() => setAttempt(value => value + 1)} retryLabel="다시 시도">
        {error || status?.message || (status?.state === 'cancelled' ? '로그인이 취소되었습니다.' : '로그인에 실패했습니다.')}
      </InlineError>}
      <div className="flex justify-end gap-2">
        {status?.state === 'pending'
          ? <Button variant="outline" type="button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '취소 중…' : '로그인 취소'}</Button>
          : <Button variant={status?.state === 'done' ? 'default' : 'outline'} type="button" disabled={cancelling} onClick={onClose}>닫기</Button>}
      </div>
    </div>
  </Modal>;
}
