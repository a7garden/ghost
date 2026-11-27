import { useEffect, useRef, useState } from 'react';
import { Check, Download, KeyRound, LogIn, Minus, Plus, RefreshCw, ShieldOff } from 'lucide-react';
import { Button, SettingsGroup, InlineError, SelectField, SegmentedControl, Switch } from '../ui';
import type { LocalAuthResult, LocalAuthSource, Provider, ProviderPreset, Thinking } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Modal } from '../components/Modal';
import { StateGlyph } from '../components/agent/StateGlyph';
import { ChatGptLogin } from './ChatGptLogin';
import { LocalAuthImport } from './LocalAuthImport';
import { NO_MODEL, modelDisplayName, modelFromKey, modelSelectOptions } from './ModelPicker';
import { ProviderEditor, type ProviderSave } from './ProviderEditor';
import { ProviderUsage, useProviderQuotas } from './ProviderQuota';
import { FallbackSteps, editFallbacks, type FallbackAction } from '../features/fallbacks';
import { oauthName, OAUTH_KINDS } from '../uiText';
import '../features/SettingsPages.css';
import './ModelSettings.css';

const roles = [
  { field: 'reviewModel', label: '검토 모델', hint: '맡긴 일의 결과 판정', empty: '선택 안 함' },
  { field: 'memoryModel', label: '기억 모델', hint: 'Ghost의 기억 정리', empty: '기본 모델 따름' },
  { field: 'suggestionModel', label: '제안 모델', hint: '', empty: '기본 모델 따름' },
] as const;

type ModelField = 'defaultModel' | typeof roles[number]['field'];
type Change = ModelField | 'thinking' | 'fallbacks' | 'suggestions' | 'delete';

export function ModelSettings() {
  const { store, client } = useHost();
  const { state, connection } = useHostState(store);
  const settings = state?.settings;
  const [catalog, setCatalog] = useState<ProviderPreset[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true), [catalogError, setCatalogError] = useState(''), [catalogAttempt, setCatalogAttempt] = useState(0);
  const [editor, setEditor] = useState<{ initial?: Provider }>();
  const [remove, setRemove] = useState<Provider>();
  const [login, setLogin] = useState<Provider>();
  const [importAuth, setImportAuth] = useState(false);
  const [pending, setPending] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [lastChange, setLastChange] = useState<Change>();
  const [savedProvider, setSavedProvider] = useState<{ id: string; message: string }>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const savedRow = useRef<HTMLDivElement>(null);
  const focusAfterSave = useRef(false);
  const options = modelSelectOptions(settings);
  const providers = settings?.providers ?? [];
  const providerIds = providers.map(provider => provider.id);
  const { quotas, error: quotaError, loading: quotaLoading, now, refresh: refreshQuota } = useProviderQuotas();
  const quotasById = new Map(quotas.map(quota => [quota.id, quota]));
  const standaloneQuotas = quotas.filter(quota => !providerIds.includes(quota.id));
  const primary = settings?.defaultModel ?? null;
  const fallbacks = settings?.defaultFallbacks ?? [];
  const setupLocked = pending !== '' || !!editor || !!login || importAuth;
  const adding = !!editor && !editor.initial;

  useEffect(() => {
    if (!focusAfterSave.current || !savedRow.current || login) return;
    focusAfterSave.current = false;
    savedRow.current.focus();
  }, [savedProvider, settings?.providers, login]);

  const closeSetup = () => {
    setEditor(undefined); setLogin(undefined); setImportAuth(false);
    requestAnimationFrame(() => returnFocus.current?.focus());
  };
  const beginSetup = (trigger: HTMLElement) => {
    returnFocus.current = trigger;
    setError(''); setNotice('');
  };

  useEffect(() => {
    let alive = true;
    setCatalogLoading(true); setCatalogError('');
    void client.providerCatalog().then(presets => { if (alive) setCatalog(presets); }).catch(reason => {
      if (alive) setCatalogError(reason instanceof Error ? reason.message : '제공자 목록을 불러오지 못했습니다.');
    }).finally(() => { if (alive) setCatalogLoading(false); });
    return () => { alive = false; };
  }, [client, catalogAttempt]);

  const run = async (label: Change, work: () => Promise<unknown>, done: string) => {
    setLastChange(label); setPending(label); setError(''); setNotice('');
    try { await work(); setNotice(done); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.'); }
    finally { setPending(''); }
  };
  const roleCommand = (field: ModelField, key: string) => {
    const model = modelFromKey(settings, key) ?? null;
    if (field === 'defaultModel') void run(field, () => client.send({ type: 'settings.update', defaultModel: model }), '모델을 저장했습니다.');
    else if (field === 'reviewModel') void run(field, () => client.send({ type: 'settings.update', reviewModel: model }), '모델을 저장했습니다.');
    else if (field === 'memoryModel') void run(field, () => client.send({ type: 'settings.update', memoryModel: model }), '모델을 저장했습니다.');
    else void run(field, () => client.send({ type: 'settings.update', suggestionModel: model }), '모델을 저장했습니다.');
  };
  // Reasoning depth rides on the default model; models that cannot reason ignore it.
  const thinkingCommand = (thinking: Thinking) => {
    if (!settings?.defaultModel) return;
    void run('thinking', () => client.send({ type: 'settings.update', defaultModel: { ...settings.defaultModel!, thinking } }), '생각 수준을 저장했습니다.');
  };
  // 대체 모델을 따로 두지 않은 Ghost 가 따르는 목록. Ghost 에 자기 목록이 있으면 그쪽이 이긴다.
  const fallbackCommand = (action: FallbackAction) =>
    void run('fallbacks', () => client.send({ type: 'settings.update', defaultFallbacks: editFallbacks(settings?.defaultFallbacks ?? [], action) }), '기본 대체 모델을 저장했습니다.');
  const saveProvider = async ({ draft, apiKey, login: startLogin }: ProviderSave) => {
    setPending('provider');
    try {
      await client.send({ type: 'provider.upsert', id: draft.id, kind: draft.kind, name: draft.name, baseUrl: draft.baseUrl, models: draft.models,
        ...(apiKey === undefined ? {} : { apiKey }),
      });
      setEditor(undefined);
      focusAfterSave.current = true;
      setSavedProvider({ id: draft.id, message: '설정 저장됨' });
      if (startLogin) setLogin({ ...draft, hasCredential: false });
    } finally { setPending(''); }
  };
  const authImported = (result: LocalAuthResult, source: LocalAuthSource) => {
    setImportAuth(false);
    focusAfterSave.current = true;
    setSavedProvider({ id: result.providerId, message: `${source.agentName}에서 인증 정보를 가져왔습니다.` });
  };

  const modelField = (field: ModelField, label: string, empty: string) => {
    const ref = settings?.[field];
    const value = ref ? `${ref.provider}/${ref.model}` : NO_MODEL;
    const choices = field === 'defaultModel'
      ? options.map(option => option.value !== value && fallbacks.some(model => option.value === `${model.provider}/${model.model}`)
        ? { ...option, disabled: true } : option)
      : options;
    return <SelectField label={label} className="model-select" value={value} disabled={pending !== '' || !settings} onValueChange={key => roleCommand(field, key)}
      options={[
        { value: NO_MODEL, label: empty },
        ...(ref && !choices.some(option => option.value === value) ? [{ value, label: `${modelDisplayName(settings, ref)} · 목록에 없음`, disabled: true }] : []),
        ...choices,
      ]}/>;
  };

  const ready = state?.runtime.ready;
  const feedback = !remove && (error ? <InlineError>{error}</InlineError>
    : notice && <p className="m-0 flex items-start gap-1.5 text-caption text-success" role="status"><Check size={14} className="mt-0.5 flex-none"/>{notice}</p>);
  const roleChanged = lastChange === 'suggestions' || roles.some(role => role.field === lastChange);
  const modelRoute = (
    <SettingsGroup className="model-route-group" title="모델 경로">
      <div className="model-route" aria-busy={pending === 'fallbacks' || pending === 'defaultModel'}>
        <ol className="model-route__steps" aria-label="기본 대체 모델 순서">
          <li className="model-route__step" data-primary>
            <span className="model-route__node" aria-hidden="true"><span/></span>
            <span className="model-row-title">기본 모델</span>
            {modelField('defaultModel', '기본 모델', '선택 안 함')}
          </li>
          <FallbackSteps fallbacks={fallbacks} primary={primary} pending={pending !== '' || !settings} onAction={fallbackCommand}/>
        </ol>
        <p className="model-meta model-route-caption">연결 오류나 사용 한도에 걸리면 대체 모델을 순서대로 씁니다. Ghost별 경로가 있으면 그 경로를 우선합니다.</p>
      </div>
      {primary && <div className="model-thinking">
        <span className="model-row-title" title="답하기 전에 추론하는 정도">생각 수준</span>
        <SegmentedControl aria-label="생각 수준" value={primary.thinking ?? 'off'} onValueChange={thinkingCommand}
          options={(['off', 'low', 'medium', 'high'] as const).map(value => ({ value, label: { off: '끔', low: '낮음', medium: '중간', high: '높음' }[value], disabled: pending !== '' }))}/>
      </div>}
      {lastChange !== 'delete' && !roleChanged && feedback}
    </SettingsGroup>
  );
  return <section className="settings-ledger model-settings" aria-label="모델 설정">
    <div className="settings-verdict" data-tone={ready === false ? 'warning' : undefined} role="status">
      <span aria-hidden="true"><StateGlyph state={ready ? 'done' : ready === false ? 'attention' : 'queued'} size={20}/></span>
      <div className="settings-verdict__copy">
        <strong>{state
          ? ready ? 'Ghost가 실행할 수 있습니다' : 'Ghost가 실행할 수 없습니다'
          : '실행 상태를 확인하지 못했습니다'}</strong>
        {state && ready === false && <small>{state.runtime.detail}</small>}
        {state && connection !== 'live' && <small>마지막으로 받은 설정 기준</small>}
      </div>
    </div>

    {options.length > 0 && modelRoute}
    <SettingsGroup className="model-providers" title="제공자" actions={<>
      {quotas.length > 0 && <Button variant="ghost" size="icon" type="button" aria-label="사용량 새로고침" title="사용량 새로고침"
        disabled={quotaLoading} onClick={refreshQuota}><RefreshCw size={15} aria-hidden="true"/></Button>}
      <Button variant="ghost" type="button" aria-expanded={importAuth} disabled={setupLocked || !settings}
        onClick={event => { beginSetup(event.currentTarget); setImportAuth(true); }}><Download size={15} aria-hidden="true"/>다른 에이전트에서 가져오기</Button>
      <Button variant="add" type="button" aria-expanded={adding} disabled={setupLocked || !settings || catalogLoading || !catalog.length}
        onClick={event => { beginSetup(event.currentTarget); setEditor({}); }}>{catalogLoading ? '목록 불러오는 중…' : '제공자 추가'}</Button>
    </>}>
      {catalogError && <InlineError pending={catalogLoading} onRetry={() => setCatalogAttempt(value => value + 1)} retryLabel="다시 불러오기">{catalogError}</InlineError>}
      {importAuth && <LocalAuthImport onClose={closeSetup} onImported={authImported}/>}
      {adding && <ProviderEditor presets={catalog} providerIds={providerIds} busy={pending !== ''} onClose={closeSetup} onSave={saveProvider}/>}
      {(providers.length > 0 || standaloneQuotas.length > 0) && <div className="provider-ledger" role="list" aria-label="제공자 목록">
        {providers.map(provider => {
          const editing = editor?.initial?.id === provider.id;
          const signingIn = login?.id === provider.id;
          const quota = quotasById.get(provider.id);
          return <div key={provider.id} className="provider-record" role="listitem" tabIndex={-1}
            ref={provider.id === savedProvider?.id ? savedRow : undefined}>
            <div className="provider-ledger__row" data-selected={editing || signingIn || undefined} data-attention={!provider.hasCredential || undefined}>
              <span className="provider-ledger__mark" aria-hidden="true">{provider.hasCredential ? <KeyRound size={16}/> : <ShieldOff size={16}/>}</span>
              <div className="provider-ledger__copy">
                <span className="model-row-title">{provider.name}</span>
                <span className="model-meta">
                  {provider.hasCredential ? provider.authType === 'oauth' ? `${oauthName(provider.kind)} 인증 저장됨` : 'API 키 저장됨' : '인증 정보 없음'}
                  {' · '}모델 {provider.models.length}개
                </span>
                {provider.id === savedProvider?.id && !signingIn && <small className="model-meta text-success" role="status">{savedProvider.message}</small>}
              </div>
              {quota && <ProviderUsage quota={quota} now={now}/>}
              <div className="provider-ledger__actions">
                {OAUTH_KINDS.has(provider.kind) && !provider.baseUrl && (!provider.hasCredential || provider.authType === 'oauth') && <Button variant="ghost" size="sm" type="button"
                  disabled={setupLocked} aria-expanded={signingIn} aria-label={`${provider.name} ${oauthName(provider.kind)}로 로그인`}
                  onClick={event => { beginSetup(event.currentTarget); setLogin(provider); }}><LogIn size={14} aria-hidden="true"/>{provider.authType === 'oauth' ? '다시 로그인' : `${oauthName(provider.kind)} 로그인`}</Button>}
                <Button variant="ghost" size="sm" type="button" disabled={pending !== '' || !!login || importAuth || (!!editor && !editing)}
                  aria-expanded={editing} aria-label={`${provider.name} 설정`}
                  onClick={event => { if (editing) closeSetup(); else { beginSetup(event.currentTarget); setEditor({ initial: provider }); } }}>
                  설정{editing ? <Minus size={14} aria-hidden="true"/> : <Plus size={14} aria-hidden="true"/>}
                </Button>
              </div>
            </div>
            {editing && editor?.initial && <ProviderEditor initial={editor.initial} presets={catalog} providerIds={providerIds} busy={pending !== ''}
              onClose={closeSetup} onSave={saveProvider} onDelete={() => { setError(''); setRemove(provider); }}/>}
            {signingIn && login && <ChatGptLogin provider={login} onClose={closeSetup}/>}
          </div>;
        })}
        {standaloneQuotas.map(quota => <div key={quota.id} className="provider-record" role="listitem">
          <div className="provider-ledger__row">
            <span className="provider-ledger__mark" aria-hidden="true"><KeyRound size={16}/></span>
            <div className="provider-ledger__copy"><span className="model-row-title">{quota.name}</span>
              {quota.id === 'claude-code' && <span className="model-meta">Claude Code 로그인</span>}
            </div>
            <ProviderUsage quota={quota} now={now}/>
          </div>
        </div>)}
      </div>}
      {settings && !providers.length && !adding && !importAuth && !catalogLoading && <p className="model-meta">연결된 제공자가 없습니다.</p>}
      {quotaError && <InlineError pending={quotaLoading} onRetry={refreshQuota} retryLabel="다시 불러오기">{quotaError}</InlineError>}
      {lastChange === 'delete' && feedback}
    </SettingsGroup>
    {!options.length && modelRoute}

    <SettingsGroup className="model-role-group" title="역할별 모델">
      <label className="model-thinking model-suggestions" htmlFor="suggestions-switch">
        <span className="model-row-title">다음 메시지 제안
          <small className="model-meta" id="suggestions-extra-request">제안마다 요청이 한 번 더 나갑니다.</small>
        </span>
        <Switch id="suggestions-switch" aria-label="다음 메시지 제안" aria-describedby="suggestions-extra-request" checked={settings?.nextMessageSuggestions !== false} disabled={pending !== '' || !settings}
          onCheckedChange={checked => void run('suggestions', () => client.send({ type: 'settings.update', nextMessageSuggestions: checked }), checked ? '다음 메시지를 제안합니다.' : '다음 메시지를 제안하지 않습니다.')}/>
      </label>
      <table className="model-roles" aria-label="역할별 현재 모델">
        <tbody>{roles.filter(role => role.field !== 'suggestionModel' || settings?.nextMessageSuggestions !== false).map(role =>
          <tr key={role.field}>
            <th scope="row"><span className="model-row-title">{role.label}</span>{role.hint && <small className="model-meta">{role.hint}</small>}</th>
            <td>{modelField(role.field, role.label, role.empty)}</td>
          </tr>)}</tbody>
      </table>
      {roleChanged && feedback}
    </SettingsGroup>
    {remove && <Modal title="제공자 삭제" focusClose onClose={() => { if (!pending) { setRemove(undefined); setError(''); } }}>
      <p className="m-0">{remove.name}의 서버 설정과 저장된 인증 정보를 삭제합니다.</p>
      {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={pending !== ''} onClick={() => { setRemove(undefined); setError(''); }}>취소</Button>
        <Button variant="destructive" type="button" disabled={pending !== ''} onClick={() => void run('delete', async () => {
          await client.send({ type: 'provider.delete', providerId: remove.id }); setRemove(undefined); setEditor(undefined);
        }, '제공자 설정을 삭제했습니다.')}>삭제</Button>
      </div>
    </Modal>}
  </section>;
}
