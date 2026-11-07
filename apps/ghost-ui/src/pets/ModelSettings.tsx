import { useEffect, useState } from 'react';
import { Check, ChevronRight, KeyRound, LogIn, ShieldOff, Plus, Trash2 } from 'lucide-react';
import { Button, SettingsGroup, SettingsRow, InlineError, SelectField } from '../ui';
import type { Provider, ProviderPreset } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Modal } from '../components/Modal';
import { ChatGptLoginDialog } from './ChatGptLogin';
import { NO_MODEL, modelFromKey, modelSelectOptions } from './ModelPicker';
import { ProviderEditor } from './ProviderEditor';
import type { ProviderSave } from './ProviderEditor';

export function ModelSettings() {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const settings = state?.settings;
  const [catalog, setCatalog] = useState<ProviderPreset[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true), [catalogError, setCatalogError] = useState(''), [catalogAttempt, setCatalogAttempt] = useState(0);
  const [editor, setEditor] = useState<{ initial?: Provider }>();
  const [remove, setRemove] = useState<Provider>();
  const [login, setLogin] = useState<Provider>();
  const [pending, setPending] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const options = modelSelectOptions(settings);

  useEffect(() => {
    let alive = true;
    setCatalogLoading(true); setCatalogError('');
    void client.providerCatalog().then(presets => { if (alive) setCatalog(presets); }).catch(reason => {
      if (alive) setCatalogError(reason instanceof Error ? reason.message : '제공자 목록을 불러오지 못했습니다.');
    }).finally(() => { if (alive) setCatalogLoading(false); });
    return () => { alive = false; };
  }, [client, catalogAttempt]);

  const run = async (label: string, work: () => Promise<unknown>, done: string) => {
    setPending(label); setError(''); setNotice('');
    try { await work(); setNotice(done); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.'); }
    finally { setPending(''); }
  };
  const roleCommand = (field: 'defaultModel' | 'reviewModel', key: string) => {
    const model = modelFromKey(settings, key) ?? null;
    void run(field, () => client.send(field === 'defaultModel' ? { type: 'settings.update', defaultModel: model } : { type: 'settings.update', reviewModel: model }), '모델을 저장했습니다.');
  };
  const saveProvider = async ({ draft, apiKey, login: startLogin }: ProviderSave) => {
    await client.send({ type: 'provider.upsert', id: draft.id, kind: draft.kind, name: draft.name, baseUrl: draft.baseUrl, models: draft.models,
      ...(apiKey === undefined ? {} : { apiKey }),
    });
    setEditor(undefined);
    setNotice(`${draft.name} 설정을 저장했습니다.${settings?.defaultModel ? '' : ' 아래에서 기본 모델을 선택해 주세요.'}`);
    if (startLogin) setLogin({ ...draft, hasCredential: false });
  };

  return <section className="flex min-w-0 flex-col gap-6" aria-label="모델 설정">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <h3 className="m-0 text-ui font-semibold text-ink">제공자</h3>
      <Button variant="outline" type="button" disabled={pending !== '' || !settings || catalogLoading || !catalog.length} onClick={() => { setError(''); setEditor({}); }}><Plus size={15}/>{catalogLoading ? '목록 불러오는 중…' : '제공자 추가'}</Button>
    </div>
    {catalogError && <InlineError pending={catalogLoading} onRetry={() => setCatalogAttempt(value => value + 1)} retryLabel="다시 불러오기">{catalogError}</InlineError>}
    <div className="flex min-w-0 flex-col">
      {(settings?.providers ?? []).map(provider => <article className="flex min-w-0 flex-col gap-3 border-b border-line py-4 first:pt-0 last:border-b-0" key={provider.id}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex min-w-0 flex-wrap items-center gap-2.5">
            <span className="text-body font-semibold text-ink [overflow-wrap:anywhere]">{provider.name}</span>
          </span>
          <span className="flex items-center gap-1 text-caption text-ink-3">
            {provider.hasCredential ? <><KeyRound size={13} aria-hidden="true"/>{provider.authType === 'oauth' ? 'ChatGPT 인증 저장됨' : 'API 키 저장됨'}</> : <><ShieldOff size={13} aria-hidden="true"/>인증 정보 없음</>}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="min-w-0 text-caption text-ink-3 [overflow-wrap:anywhere]">{provider.models.length ? `${provider.models.slice(0, 2).map(model => model.name || model.id).join(', ')}${provider.models.length > 2 ? ` 외 ${provider.models.length - 2}개` : ''}` : '선택한 모델 없음'}</span>
          <div className="flex flex-wrap items-center gap-2">
            {provider.kind === 'openai' && !provider.baseUrl && (!provider.hasCredential || provider.authType === 'oauth') && <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} aria-label={`${provider.name} ChatGPT로 로그인`} onClick={() => { setError(''); setLogin(provider); }}><LogIn size={14}/>{provider.authType === 'oauth' ? '다시 로그인' : 'ChatGPT 로그인'}</Button>}
            <Button variant="ghost" size="sm" type="button" disabled={pending !== ''} aria-label={`${provider.name} 설정`} onClick={() => { setError(''); setEditor({ initial: provider }); }}>설정<ChevronRight size={14}/></Button>
            <Button variant="ghost" size="icon" type="button" aria-label={`${provider.name} 제공자 삭제`} disabled={pending !== ''} onClick={() => { setError(''); setRemove(provider); }}><Trash2 size={15}/></Button>
          </div>
        </div>
        {provider.baseUrl && <p className="m-0 text-caption text-ink-3 [overflow-wrap:anywhere]">{provider.baseUrl}</p>}
      </article>)}
      {settings && !settings.providers.length && <p className="m-0 py-4 text-ui text-ink-3">사용할 제공자를 추가해 주세요.</p>}
    </div>
    {error && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 flex items-start gap-1.5 text-caption text-success" role="status"><Check size={14} className="mt-0.5 flex-none"/>{notice}</p>}
    <SettingsGroup title="모델 선택">
      <SettingsRow label="기본 모델" description="별도로 모델을 지정하지 않은 Ghost가 사용합니다.">
        <SelectField label="기본 모델" className="w-[240px] max-w-full" value={settings?.defaultModel ? `${settings.defaultModel.provider}/${settings.defaultModel.model}` : NO_MODEL}
          disabled={pending !== '' || !settings} onValueChange={key => roleCommand('defaultModel', key)} options={[{ value: NO_MODEL, label: '선택 안 함' }, ...options]}/>
      </SettingsRow>
      <SettingsRow label="검토 모델" description="맡긴 일의 결과를 판정할 때 씁니다.">
        <SelectField label="검토 모델" className="w-[240px] max-w-full" value={settings?.reviewModel ? `${settings.reviewModel.provider}/${settings.reviewModel.model}` : NO_MODEL}
          disabled={pending !== '' || !settings} onValueChange={key => roleCommand('reviewModel', key)} options={[{ value: NO_MODEL, label: '선택 안 함' }, ...options]}/>
      </SettingsRow>
    </SettingsGroup>
    {editor && <ProviderEditor initial={editor.initial} presets={catalog} providerIds={settings?.providers.map(provider => provider.id) ?? []} busy={pending !== ''} onClose={() => setEditor(undefined)} onSave={saveProvider}/>}
    {login && <ChatGptLoginDialog provider={login} onClose={() => setLogin(undefined)}/>}
    {remove && <Modal title="제공자 삭제" onClose={() => pending === '' && setRemove(undefined)}>
      <p className="m-0">{remove.name}의 서버 설정과 저장된 인증 정보를 삭제합니다.</p>
      {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={pending !== ''} onClick={() => setRemove(undefined)}>취소</Button>
        <Button variant="destructive" type="button" disabled={pending !== ''} onClick={() => void run('delete', async () => { await client.send({ type: 'provider.delete', providerId: remove.id }); setRemove(undefined); }, '제공자 설정을 삭제했습니다.')}>삭제</Button>
      </div>
    </Modal>}
  </section>;
}
