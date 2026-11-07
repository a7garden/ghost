import { useState } from 'react';
import { Check, ChevronRight, KeyRound, ShieldOff, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, GSettingsGroup, GSettingsRow, InlineError, SelectField } from '@garden/ui';
import type { Provider } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Modal } from '../components/Modal';
import { NO_MODEL, modelFromKey, modelSelectOptions } from './ModelPicker';
import { ProviderEditor, providerKindLabel, emptyDraft } from './ProviderEditor';
import type { ProviderDraft, ProviderSave } from './ProviderEditor';

/** 기본·검토 모델 선택과 모델 제공자 등록. 모든 변경은 settings.update · provider.upsert · provider.delete로 저장한다. */
export function ModelSettings() {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const settings = state?.settings;
  const [editor, setEditor] = useState<{ draft: ProviderDraft; existing: boolean; hasCredential: boolean }>();
  const [remove, setRemove] = useState<Provider>();
  const [pending, setPending] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const options = modelSelectOptions(settings);
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
  const saveProvider = async ({ draft, apiKey }: ProviderSave) => {
    await client.send({
      type: 'provider.upsert',
      id: draft.id,
      kind: draft.kind,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl,
      models: draft.models,
      ...(apiKey === undefined ? {} : { apiKey }),
    });
    setEditor(undefined);
    setNotice(`${draft.name.trim()} 제공자를 저장했습니다.`);
  };
  return <section className="flex min-w-0 flex-col gap-6" aria-label="모델 설정">
    <GSettingsGroup title="모델 선택" description="설정하지 않으면 대화가 등록된 제공자의 기본 모델을 따릅니다.">
      <GSettingsRow label="기본 모델" description="새 대화와 Ghost가 따르는 모델">
        <SelectField label="기본 모델" className="w-[240px] max-w-full" value={settings?.defaultModel ? `${settings.defaultModel.provider}/${settings.defaultModel.model}` : NO_MODEL}
          disabled={pending !== '' || !settings} onValueChange={key => roleCommand('defaultModel', key)}
          options={[{ value: NO_MODEL, label: '선택 안 함' }, ...options]}/>
      </GSettingsRow>
      <GSettingsRow label="검토 모델" description="맡긴 일의 결과를 판정할 때 씁니다.">
        <SelectField label="검토 모델" className="w-[240px] max-w-full" value={settings?.reviewModel ? `${settings.reviewModel.provider}/${settings.reviewModel.model}` : NO_MODEL}
          disabled={pending !== '' || !settings} onValueChange={key => roleCommand('reviewModel', key)}
          options={[{ value: NO_MODEL, label: '선택 안 함' }, ...options]}/>
      </GSettingsRow>
    </GSettingsGroup>
    <div className="flex flex-wrap items-center justify-between gap-4">
      <h3 className="m-0 text-ui font-semibold text-ink">제공자</h3>
      <Button variant="outline" type="button" disabled={pending !== '' || !settings} onClick={() => setEditor({ draft: emptyDraft(), existing: false, hasCredential: false })}><Plus size={15}/>제공자 추가</Button>
    </div>
    <div className="flex min-w-0 flex-col">
      {(settings?.providers ?? []).map(provider => <article className="flex min-w-0 flex-col gap-2 border-b border-line py-4 last:border-b-0" key={provider.id}>
        <div className="flex flex-wrap items-center justify-between gap-3.5">
          <span className="flex min-w-0 flex-wrap items-center gap-2.5">
            <span className="text-body font-semibold text-ink [overflow-wrap:anywhere]">{provider.name}</span>
            <Badge variant="outline">{providerKindLabel(provider.kind)}</Badge>
          </span>
          <span className="flex items-center gap-3 text-caption text-ink-3">
            {provider.hasCredential ? <span className="flex items-center gap-1"><KeyRound size={13} aria-hidden="true"/>인증 키 저장됨</span> : <span className="flex items-center gap-1"><ShieldOff size={13} aria-hidden="true"/>인증 키 없음</span>}
            <span>{provider.models.length}개 모델</span>
          </span>
        </div>
        <p className="m-0 text-caption text-ink-3 [overflow-wrap:anywhere]">{provider.baseUrl ?? '기본 서버 주소'}</p>
        <p className="m-0 text-caption text-ink-3 [overflow-wrap:anywhere]">{provider.models.map(model => model.name || model.id).join(', ')}</p>
        <div className="flex flex-wrap items-center gap-4">
          <Button variant="ghost" type="button" disabled={pending !== ''} onClick={() => setEditor({ draft: { id: provider.id, kind: provider.kind, name: provider.name, baseUrl: provider.baseUrl, models: provider.models.map(model => ({ ...model })) }, existing: true, hasCredential: provider.hasCredential })}>편집<ChevronRight size={14}/></Button>
          <Button variant="ghost" size="icon" type="button" className="ml-auto" aria-label={`${provider.name} 제공자 삭제`} disabled={pending !== ''} onClick={() => { setError(''); setRemove(provider); }}><Trash2 size={15}/></Button>
        </div>
      </article>)}
      {settings && !settings.providers.length && <p className="m-0 py-2 text-ui text-ink-3">등록된 제공자 없음</p>}
    </div>
    {error && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 flex items-start gap-1.5 text-caption text-success" role="status"><Check size={14} className="mt-0.5 flex-none"/>{notice}</p>}
    {editor && <ProviderEditor initial={editor.draft} existing={editor.existing} hasCredential={editor.hasCredential} busy={pending !== ''} onClose={() => setEditor(undefined)} onSave={saveProvider}/>}
    {remove && <Modal title="제공자 삭제" onClose={() => pending === '' && setRemove(undefined)}>
      <p className="m-0">{remove.name}의 서버 설정을 삭제합니다. 저장된 인증 키도 함께 지워집니다.</p>
      {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={pending !== ''} onClick={() => setRemove(undefined)}>취소</Button>
        <Button variant="destructive" type="button" disabled={pending !== ''} onClick={() => void run('delete', async () => { await client.send({ type: 'provider.delete', providerId: remove.id }); setRemove(undefined); }, '제공자 설정을 삭제했습니다.')}>삭제</Button>
      </div>
    </Modal>}
  </section>;
}
