import { useEffect, useId, useState, type ReactNode } from 'react';
import type { CodingSession, PiPackage, PiSettings, PiSettingsOverrides } from '@ghost/contract';
import type { PiGlobalConfig, PiSessionView } from '../host/client';
import { useHost } from '../host/context';
import { Button, InlineError, SettingsGroup, SettingsRow, SkeletonRows } from '../ui';
import { codingBusy, codingError } from './CodingSessionModel';
import { PI_BASE_TOOLS, PiCompactionFields, PiDeliveryField, PiDisclosure, PiImageField, PiRetryFields, PiToolFields } from './PiConfigFields';
import { PiConfigPackages, PiPackageRows } from './PiConfigPackages';
import './PiConfig.css';
import './SettingsLists.css';

export function PiConfigSettings() {
  const { client } = useHost();
  const formId = useId();
  const [config, setConfig] = useState<PiGlobalConfig>();
  const [draft, setDraft] = useState<PiSettings>();
  const [packages, setPackages] = useState<PiPackage[]>([]);
  const [error, setError] = useState('');
  const [loadAttempt, retry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const request = new AbortController();
    void Promise.all([client.piSettings(request.signal), client.piPackages(request.signal)]).then(([received, items]) => {
      if (request.signal.aborted) return;
      setConfig(received); setDraft(received.settings); setPackages(items); setError('');
    }, reason => {
      if (!request.signal.aborted) setError(codingError(reason, '코딩 설정을 불러오지 못했습니다.'));
    });
    return () => request.abort();
  }, [client, loadAttempt]);
  if (!config || !draft) return <SettingsGroup title="내장 코딩">
    {error ? <InlineError onRetry={() => { setError(''); retry(value => value + 1); }} retryLabel="다시 불러오기">{error}</InlineError>
      : <SkeletonRows label="코딩 설정을 불러오는 중…" rows={4} className="px-4 py-3"/>}
  </SettingsGroup>;

  const tools = [...new Set([...PI_BASE_TOOLS, ...packages.flatMap(item => item.tools)])];
  const dirty = JSON.stringify(config.settings) !== JSON.stringify(draft);
  const change = (value: PiSettings) => { setDraft(value); setNotice(''); };
  return <>
    <SettingsGroup title="내장 코딩 기본값" className="pi-settings" actions={<div className="settings-list__actions">
      {(dirty || notice) && <span className="settings-list__meta" role="status">{dirty ? '저장하지 않은 변경' : notice}</span>}
      <Button form={formId} type="submit" size="sm" disabled={!dirty || saving}>{saving ? '저장 중…' : '저장'}</Button>
    </div>}>
      <form id={formId} onSubmit={event => {
        event.preventDefault();
        if (!dirty || saving) return;
        setSaving(true); setError(''); setNotice('');
        void client.savePiSettings(draft).then(settings => {
          setConfig({ ...config, settings }); setDraft(settings); setNotice('저장했습니다.');
        }, reason => setError(codingError(reason, '코딩 설정을 저장하지 못했습니다.'))).finally(() => setSaving(false));
      }}>
        <fieldset disabled={saving}>
          <PiDisclosure label="맥락 압축" value={draft.compaction.enabled ? '켬' : '끔'}>
            <PiCompactionFields value={draft.compaction} change={compaction => change({ ...draft, compaction })}/>
          </PiDisclosure>
          <PiDisclosure label="재시도" value={draft.retry.enabled ? '켬' : '끔'}>
            <PiRetryFields value={draft.retry} change={retry => change({ ...draft, retry })}/>
          </PiDisclosure>
          <PiDisclosure label="메시지와 이미지">
            <PiDeliveryField label="스티어링" value={draft.steeringMode} change={steeringMode => change({ ...draft, steeringMode })}/>
            <PiDeliveryField label="후속 메시지" value={draft.followUpMode} change={followUpMode => change({ ...draft, followUpMode })}/>
            <PiImageField value={draft.imageAutoResize} change={config.imageResizeAvailable ? imageAutoResize => change({ ...draft, imageAutoResize }) : undefined}/>
          </PiDisclosure>
          <PiDisclosure label="도구" value={draft.toolAllowlist === null ? '기본값' : `${draft.toolAllowlist.length}개 허용`}>
            <PiToolFields tools={tools} value={draft.toolAllowlist} change={toolAllowlist => change({ ...draft, toolAllowlist })}/>
          </PiDisclosure>
        </fieldset>
        {error && <InlineError>{error}</InlineError>}
      </form>
    </SettingsGroup>
    <PiConfigPackages items={packages} canManage={config.canManagePackages} setItems={setPackages}/>
  </>;
}

function LocalField<T>({ label, current, fallback, change, render }: {
  label: string; current: T | undefined; fallback: T; change(value: T | undefined): void; render(value: T): ReactNode;
}) {
  return <fieldset className="pi-override">
    <legend>{label}</legend>
    <label className="pi-override__toggle"><input type="checkbox" checked={current !== undefined}
      onChange={event => change(event.target.checked ? fallback : undefined)}/>이 세션에서 변경</label>
    <fieldset disabled={current === undefined}>{render(current === undefined ? fallback : current)}</fieldset>
  </fieldset>;
}

export function PiSessionSettings({ session, disabled }: { session: CodingSession; disabled: boolean }) {
  const { client } = useHost();
  const [config, setConfig] = useState<PiSessionView>();
  const [draft, setDraft] = useState<PiSettingsOverrides>({});
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [attempt, retry] = useState(0);
  const closed = session.state === 'closed';
  const locked = disabled || pending || closed;
  const busy = codingBusy(session.state);
  const lastUsage = session.usage.input + session.usage.output;

  useEffect(() => {
    const request = new AbortController();
    void client.piSession(session.id, request.signal).then(value => {
      if (request.signal.aborted) return;
      setConfig(value); setDraft(value.overrides); setError('');
    }, reason => {
      if (!request.signal.aborted) setError(codingError(reason, '세션 설정을 불러오지 못했습니다.'));
    });
    return () => request.abort();
  }, [client, session.id, attempt]);

  // Refresh context after a response without replacing unsaved per-session overrides.
  useEffect(() => {
    if (pending) return;
    const request = new AbortController();
    void client.piSession(session.id, request.signal).then(value => {
      if (!request.signal.aborted) setConfig(current => current && { ...current, context: value.context, packages: value.packages });
    }, () => {});
    return () => request.abort();
  }, [client, session.id, busy, lastUsage, pending]);

  async function apply(action: () => Promise<void>, message: string) {
    setPending(true); setError('');
    try { await action(); }
    catch (reason) { setError(codingError(reason, message)); }
    finally { setPending(false); }
  }

  if (!config) return error ? <InlineError onRetry={() => { setError(''); retry(value => value + 1); }} retryLabel="다시 불러오기">{error}</InlineError>
    : <SkeletonRows label="Pi 설정을 불러오는 중…" rows={4}/>;
  const { defaults, context, packages, packageOverrides } = config;
  const dirty = JSON.stringify(config.overrides) !== JSON.stringify(draft);
  return <section className="pi-session pi-settings" aria-label="Pi 세션 설정">
    <div className="pi-session__context">
      <div><strong>맥락 사용량</strong><span className="pi-meta">{context?.tokens == null ? (context ? `— / ${context.contextWindow.toLocaleString()}` : '—')
        : `${context.tokens.toLocaleString()} / ${context.contextWindow.toLocaleString()} 토큰`}</span></div>
      <Button size="sm" variant="outline" type="button" disabled={locked || busy || !session.turn} onClick={() => void apply(async () => {
        setConfig(await client.compactPiSession(session.id));
      }, '맥락을 압축하지 못했습니다.')}>지금 압축</Button>
      {context?.percent != null && <progress aria-label="맥락 사용량" value={Math.min(100, context.percent)} max={100}/>}
    </div>
    <PiDisclosure label="Pi 설정">
      <form onSubmit={event => {
        event.preventDefault();
        if (!dirty || locked) return;
        void apply(async () => {
          const saved = await client.savePiSession(session.id, draft);
          setConfig(saved); setDraft(saved.overrides);
        }, '세션 설정을 저장하지 못했습니다.');
      }}>
        <fieldset disabled={locked}>
          <LocalField label="맥락 압축" current={draft.compaction} fallback={defaults.compaction}
            change={compaction => setDraft({ ...draft, compaction })}
            render={value => <PiCompactionFields value={{ ...defaults.compaction, ...value }} change={compaction => setDraft({ ...draft, compaction })}/>}/>
          <LocalField label="재시도" current={draft.retry} fallback={defaults.retry} change={retry => setDraft({ ...draft, retry })}
            render={value => <PiRetryFields value={{ ...defaults.retry, ...value }} change={retry => setDraft({ ...draft, retry })}/>}/>
          <LocalField label="스티어링" current={draft.steeringMode} fallback={defaults.steeringMode} change={steeringMode => setDraft({ ...draft, steeringMode })}
            render={value => <PiDeliveryField label="전달 방식" value={value} change={steeringMode => setDraft({ ...draft, steeringMode })}/>}/>
          <LocalField label="후속 메시지" current={draft.followUpMode} fallback={defaults.followUpMode} change={followUpMode => setDraft({ ...draft, followUpMode })}
            render={value => <PiDeliveryField label="전달 방식" value={value} change={followUpMode => setDraft({ ...draft, followUpMode })}/>}/>
          {config.imageResizeAvailable ? <LocalField label="이미지" current={draft.imageAutoResize} fallback={defaults.imageAutoResize} change={imageAutoResize => setDraft({ ...draft, imageAutoResize })}
            render={value => <PiImageField value={value} change={imageAutoResize => setDraft({ ...draft, imageAutoResize })}/>}/> : <PiImageField/>}
          <LocalField label="도구" current={draft.toolAllowlist} fallback={defaults.toolAllowlist} change={toolAllowlist => setDraft({ ...draft, toolAllowlist })}
            render={value => <PiToolFields tools={config.tools} value={value} change={toolAllowlist => setDraft({ ...draft, toolAllowlist })}/>}/>
        </fieldset>
        <div className="pi-apply"><Button type="submit" size="sm" disabled={locked || !dirty}>Pi 설정 저장</Button></div>
      </form>
    </PiDisclosure>
    {config.resourcesAllowed && packages.length > 0 && <PiDisclosure label="Pi 패키지">
      <PiPackageRows items={packages} session={packageOverrides} disabled={locked} change={config.canManagePackages ? (item, key, value) => {
        const flags = { ...packageOverrides[item.id] };
        if (value === undefined) delete flags[key];
        else flags[key] = value;
        void apply(async () => {
          const overrides = await client.savePiSessionPackage(session.id, item.id, flags);
          setConfig({ ...config, packageOverrides: overrides });
        }, '패키지 설정을 저장하지 못했습니다.');
      } : undefined}/>
      <p className="pi-meta">패키지 변경은 현재 작업이 끝난 뒤 적용됩니다.</p>
    </PiDisclosure>}
    {error && <InlineError>{error}</InlineError>}
  </section>;
}
