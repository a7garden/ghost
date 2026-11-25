import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Button, InlineError, SettingsGroup, SettingsRow } from '../ui';
import { useHost } from '../host/context';
import type { LocalAuthResult, LocalAuthSource } from '@ghost/contract';

const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

/** 이 Mac 의 다른 에이전트가 이미 가진 인증 정보를 Ghost 제공자로 복사한다. 비밀 값은 Host 안에서만 오가고 이 UI 에는 목록 정보만 온다. */
export function LocalAuthImport({ onClose, onImported }: { onClose(): void; onImported(result: LocalAuthResult, source: LocalAuthSource): void }) {
  const { client } = useHost();
  const [sources, setSources] = useState<LocalAuthSource[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState('');
  const [importing, setImporting] = useState('');
  const surface = useRef<HTMLElement>(null);
  useEffect(() => { surface.current?.focus(); }, []);

  useEffect(() => {
    let alive = true;
    setSources(null); setError('');
    void client.localAuthSources().then(list => { if (alive) setSources(list); })
      .catch(reason => { if (alive) { setSources([]); setError(message(reason, '인증 정보를 찾지 못했습니다.')); } });
    return () => { alive = false; };
  }, [client, attempt]);

  const importSource = async (source: LocalAuthSource) => {
    if (source.target.hasCredential && confirming !== source.id) { setConfirming(source.id); return; }
    setImporting(source.id); setError('');
    try { onImported(await client.importLocalAuth({ sourceId: source.id, ...(source.target.hasCredential ? { replace: true } : {}) }), source); }
    catch (reason) { setError(message(reason, '인증 정보를 가져오지 못했습니다.')); setImporting(''); }
  };

  return <section className="setup-route provider-setup" aria-label="다른 에이전트에서 가져오기" tabIndex={-1} ref={surface}
    onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && importing === '') onClose(); }}>
      {sources === null && <p className="m-0 flex items-center gap-2 text-ui text-ink-2" role="status">
        <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true"/>찾는 중…
      </p>}
      {sources !== null && sources.length === 0 && !error && <p className="m-0 text-ui text-ink-2">가져올 수 있는 인증 정보가 없습니다.</p>}
      {sources !== null && sources.length > 0 && <SettingsGroup title={<span className="sr-only">가져올 인증 정보</span>}>{sources.map(source => <SettingsRow key={source.id}
        label={`${source.target.name} · ${source.authType === 'oauth' ? 'ChatGPT 로그인' : 'API 키'}`}
        description={<>
          {source.agentName}{source.account ? ` · ${source.account}` : ''}
          {source.authType === 'oauth' && <span className="mt-0.5 block">가져온 뒤 원본 에이전트는 다시 로그인해야 할 수 있습니다.</span>}
          {confirming === source.id && <span className="mt-0.5 block text-warning">{source.target.name}의 기존 인증 정보를 바꿉니다.</span>}
        </>}>
        <Button variant={confirming === source.id ? 'default' : 'outline'} size="sm" type="button" disabled={importing !== ''}
          aria-label={`${source.agentName}에서 ${source.target.name} 인증 정보 ${confirming === source.id ? '바꾸기' : '가져오기'}`}
          onClick={() => void importSource(source)}>
          {importing === source.id ? '가져오는 중…' : confirming === source.id ? '바꾸기' : '가져오기'}
        </Button>
      </SettingsRow>)}</SettingsGroup>}
      {error && <InlineError pending={sources === null} onRetry={() => setAttempt(value => value + 1)} retryLabel="다시 찾기">{error}</InlineError>}
      <div className="flex justify-end">
        <Button variant="outline" type="button" disabled={importing !== ''} onClick={onClose}>닫기</Button>
      </div>
  </section>;
}
